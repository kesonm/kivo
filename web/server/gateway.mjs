import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';

const OPENAI_ORIGIN = 'https://api.openai.com/v1';
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const REQUEST_FIELDS = ['model', 'input', 'instructions', 'parallel_tool_calls', 'reasoning', 'text', 'tool_choice', 'tools', 'truncation'];
const INPUT_TYPES = new Set(['message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'reasoning', 'additional_tools', 'configuration_update']);
const safeTool = tool => tool && (['function', 'custom'].includes(tool.type)
  || (tool.type === 'namespace' && Array.isArray(tool.tools) && tool.tools.length <= 100 && tool.tools.every(t => ['function', 'custom'].includes(t?.type))));
const schemaSummary = item => {
  const type = typeof item?.type === 'string' && /^[a-z_]{1,48}$/.test(item.type) ? item.type : (item?.type === undefined ? '(missing)' : '(invalid)');
  const keys = item && typeof item === 'object' ? Object.keys(item).filter(k => /^[A-Za-z_]{1,48}$/.test(k)).slice(0,16).join(',') : '(not object)';
  return `type=${type}; fields=${keys}`;
};
const isTextOutput = output => typeof output === 'string' || (Array.isArray(output) && output.every(part => ['input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string'));

export class GatewayError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function sendError(res, status, message) {
  if (res.destroyed) return;
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { message, type: 'codex_workspace_error', code: `workspace_${status}` } }));
}

async function readJson(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) throw new GatewayError('请求上下文过大，请新建会话。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new GatewayError('无效 JSON 请求。'); }
}

/** Only text and locally executed function/custom tools are supported in this release.
 * Provider-side sessions, hosted tools and remote file IDs must not cross user boundaries. */
export function prepareResponseRequest(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GatewayError('无效模型请求。');
  if (body.previous_response_id || body.conversation || body.background) throw new GatewayError('不支持跨请求的供应商会话引用。');
  if (body.input == null || (typeof body.input !== 'string' && !Array.isArray(body.input))) throw new GatewayError('缺少模型输入。');
  if (Array.isArray(body.input)) for (const item of body.input) {
    if (!item || typeof item !== 'object' || !INPUT_TYPES.has(item.type || (item.role ? 'message' : ''))) throw new GatewayError(`此版本只支持文本和项目内工具（${schemaSummary(item)}）。`);
    // Codex 0.167 can put tool declarations in its input history instead of the
    // top-level tools array. Validate both locations with the same allowlist.
    if (item.type === 'additional_tools' && (!Array.isArray(item.tools) || item.tools.some(t => !safeTool(t)))) throw new GatewayError(`历史工具声明只能包含本地 function/custom 工具（${Array.isArray(item.tools) ? item.tools.filter(t => !safeTool(t)).map(schemaSummary).join(' | ').slice(0,400) : 'tools 不是数组'}）。`);
    if (item.type === 'configuration_update' && (!item.reasoning || typeof item.reasoning !== 'object' || Object.keys(item.reasoning).some(k => k !== 'effort') || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(item.reasoning.effort))) throw new GatewayError('不支持的模型推理配置更新。');
    const contentTypes = item.type === 'reasoning' ? ['reasoning_text', 'summary_text', 'text'] : ['input_text', 'output_text', 'refusal'];
    if (Array.isArray(item.content) && item.content.some(c => !contentTypes.includes(c?.type))) throw new GatewayError(`此版本暂不支持图片、音频或远程文件输入（${item.content.map(schemaSummary).join(' | ').slice(0,400)}）。`);
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type) && !isTextOutput(item.output)) throw new GatewayError('工具输出必须是文本。');
  }
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.some(t => !safeTool(t)))) throw new GatewayError(`此部署仅允许隔离工作区内的工具（${Array.isArray(body.tools) ? body.tools.filter(t => !safeTool(t)).map(schemaSummary).join(' | ').slice(0,400) : 'tools 不是数组'}）。`);
  const payload = {};
  for (const key of REQUEST_FIELDS) if (body[key] !== undefined) payload[key] = body[key];
  payload.model = config.model;
  payload.store = false;
  payload.stream = true;
  payload.truncation = 'disabled';
  // Encrypted reasoning is returned by the provider and replayed with the isolated thread.
  payload.include = ['reasoning.encrypted_content'];
  const configuredMax = Math.max(256, Math.min(32768, Number(config.maxOutputTokens) || 4096));
  payload.max_output_tokens = Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0
    ? Math.min(body.max_output_tokens, configuredMax) : configuredMax;
  if (body.prompt_cache_key) payload.prompt_cache_key = undefined; // never share user-selected cache identifiers
  return payload;
}

export function makeSseParser(onEvent) {
  const decoder = new TextDecoder(); let buffer = '';
  return {
    feed(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      if (buffer.length > 4 * 1024 * 1024) throw new GatewayError('模型事件超出大小限制。', 502);
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        let event; try { event = JSON.parse(data); } catch { throw new GatewayError('供应商返回无效流式事件。', 502); }
        onEvent(event);
      }
    },
  };
}

export function parseUsage(usage) {
  if (!usage || !['input_tokens', 'output_tokens', 'total_tokens'].every(k => Number.isSafeInteger(usage[k]) && usage[k] >= 0)) return null;
  if (usage.total_tokens !== usage.input_tokens + usage.output_tokens) return null;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens };
}

export function createGateway({ store, config, onStatus = () => {}, fetchImpl = globalThis.fetch }) {
  const capabilities = new Map();
  const activeRequests = new Set();
  let server, listening;

  function authorizeRun({ id, userId }) {
    const token = randomBytes(32).toString('base64url');
    capabilities.set(token, { runId: id, userId, expires: Date.now() + (config.runTimeoutMs || 20 * 60_000) + 60_000, inFlight: false, requestCount: 0, controllers: new Set(), tasks: new Set() });
    return token;
  }

  function revokeRun(runId) {
    const draining = [];
    for (const [token, cap] of capabilities) if (cap.runId === runId) {
      capabilities.delete(token);
      for (const controller of cap.controllers) controller.abort();
      draining.push(...cap.tasks);
    }
    return Promise.allSettled(draining);
  }

  async function handle(req, res) {
    let cap, usageId, upstreamStarted = false, settled = false, controller, ownsLock = false;
    const settle = (usage, status) => {
      if (!usageId || settled) return;
      store.settleUsage(usageId, { ...usage, model: config.model, status });
      settled = true;
    };
    try {
      const rawToken = /^Bearer ([A-Za-z0-9_-]{40,60})$/.exec(req.headers.authorization || '')?.[1];
      cap = rawToken && capabilities.get(rawToken);
      if (!cap || cap.expires < Date.now()) throw new GatewayError('工作任务凭据已失效。', 401);
      const user = store.getUser(cap.userId);
      if (!user || user.disabled) throw new GatewayError('账号已停用。', 403);
      if (req.method !== 'POST' || req.url !== '/v1/responses') throw new GatewayError('不支持的模型接口。', 404);
      if (req.headers.origin) throw new GatewayError('模型网关不接受浏览器请求。', 403);
      if (cap.inFlight) throw new GatewayError('同一任务已有模型请求在运行。', 429);
      if (++cap.requestCount > 80) throw new GatewayError('单任务模型调用次数已达限制，请继续新的任务。', 429);
      cap.inFlight = true; ownsLock = true;
      const payload = prepareResponseRequest(await readJson(req), config);
      // Resolve credentials only from the capability-bound user. The runner
      // receives this capability, never a real key or a global fallback key.
      const currentUser = store.getUser(cap.userId);
      if (!currentUser || currentUser.disabled) throw new GatewayError('账号已停用。', 403);
      const apiKey = store.getUserApiKey(cap.userId);
      if (!apiKey) throw new GatewayError('请先在个人设置中填写你的 OpenAI API 密钥。', 409);
      if (!capabilities.has(rawToken)) throw new GatewayError('任务已取消。', 409);
      controller = new AbortController(); cap.controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs || 180_000); timeout.unref();
      controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
      try {
        const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
        usageId = store.beginUsage(cap.userId, cap.runId, { model: config.model, keyLast4: apiKey.slice(-4) });
        onStatus(cap.runId, '正在使用你保存的 OpenAI API 密钥调用模型…');
        upstreamStarted = true;
        const upstream = await fetchImpl(`${OPENAI_ORIGIN}/responses`, {
          method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error',
        });
        if (!upstream.ok) {
          await upstream.body?.cancel();
          if (upstream.status >= 400 && upstream.status < 500) settle({ inputTokens: null, outputTokens: null, totalTokens: null }, 'failed');
          const message = upstream.status === 401 ? '你的 OpenAI API 密钥无效或已失效，请在个人设置中更新。'
            : upstream.status === 429 ? '你的 OpenAI 账户额度或调用速率受限，请检查 OpenAI 账户后重试。'
            : `OpenAI 请求失败（HTTP ${upstream.status}）。`;
          throw new GatewayError(message, 502);
        }
        if (!upstream.headers.get('content-type')?.includes('text/event-stream') || !upstream.body) throw new GatewayError('OpenAI 未返回预期的流式响应。', 502);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-store', 'x-accel-buffering': 'no' });
        let bytes = 0, terminal = false;
        const frames = [];
        const parser = makeSseParser(event => {
          if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) {
            terminal = true;
            const usage = parseUsage(event.response?.usage);
            if (usage) {
              settle(usage, 'completed');
              onStatus(cap.runId, `本次模型调用使用 ${usage.totalTokens.toLocaleString('en-US')} token。`);
            }
          }
          // Provider error bodies can contain credential fragments or internal
          // details. Preserve protocol shape while forwarding only safe text.
          const safeError = { code: 'workspace_upstream_error', message: 'OpenAI 模型请求未能完成，请检查个人 API 设置或稍后重试。' };
          if (event.type === 'error') event = { type: 'error', ...safeError };
          else {
            if (event.error) event = { ...event, error: safeError };
            if (event.response?.error) event = { ...event, response: { ...event.response, error: safeError } };
          }
          frames.push(`data: ${JSON.stringify(event)}\n\n`);
        });
        // Drain even after the browser/runner disconnects, so a normal completed
        // response can still have its actual usage recorded. Cancellation aborts it.
        for await (const chunk of upstream.body) {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) throw new GatewayError('模型输出超出大小限制。', 502);
          parser.feed(chunk);
          const output = frames.splice(0).join('');
          if (output && !res.destroyed && !res.writableEnded && !res.write(output)) {
            await Promise.race([once(res, 'drain'), once(res, 'close')]);
          }
        }
        if (!terminal || !settled) throw new GatewayError('模型连接结束，但未收到实际用量；已标记为未知，请以你的 OpenAI 账单为准。', 502);
        res.end();
      } finally { clearTimeout(timeout); }
    } catch (error) {
      if (usageId && !settled) {
        if (upstreamStarted) {
          settle({ inputTokens: null, outputTokens: null, totalTokens: null }, 'unknown');
          onStatus(cap.runId, '供应商未返回完整用量，已标记为未知；请以你的 OpenAI 账单为准。');
        } else settle({ inputTokens: null, outputTokens: null, totalTokens: null }, 'failed');
      }
      const message = error.name === 'AbortError' ? '模型调用已取消或超时。' : error instanceof GatewayError ? error.message : '模型网关暂不可用，请稍后重试。';
      if (cap) onStatus(cap.runId, message);
      sendError(res, error instanceof GatewayError ? error.status : 502, message);
    } finally {
      if (cap) { if (ownsLock) cap.inFlight = false; if (controller) cap.controllers.delete(controller); }
    }
  }

  return {
    authorizeRun, revokeRun,
    start() {
      if (listening) return listening;
      server = http.createServer((req, res) => {
        const token = /^Bearer ([A-Za-z0-9_-]{40,60})$/.exec(req.headers.authorization || '')?.[1];
        const cap = token && capabilities.get(token);
        const task = handle(req, res).catch(() => sendError(res, 500, '模型网关内部错误。'));
        activeRequests.add(task); cap?.tasks.add(task);
        task.finally(() => { activeRequests.delete(task); cap?.tasks.delete(task); });
      });
      server.requestTimeout = 30_000;
      server.headersTimeout = 15_000;
      server.maxHeadersCount = 32;
      listening = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.gatewayPort ?? 3001, config.gatewayHost || '0.0.0.0', () => resolve(server.address()));
      });
      return listening;
    },
    async close() {
      for (const cap of capabilities.values()) for (const c of cap.controllers) c.abort();
      capabilities.clear();
      await Promise.allSettled([...activeRequests]);
      if (server?.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}
