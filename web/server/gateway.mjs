import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { resolveChatSelection } from './chat-models.mjs';

const OPENAI_ORIGIN = 'https://api.openai.com/v1';
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
export const CHAT_GATEWAY_MAX_REQUEST_BYTES = 20 * 1024 * 1024;
export const CHAT_GATEWAY_MAX_EVENT_BYTES = 20 * 1024 * 1024;
const CHAT_MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const CHAT_MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const CHAT_MAX_FILES = 8;
const CHAT_TOOLS = new Set(['web_search', 'image_generation', 'code_interpreter']);
const FILE_ID = /^file-[A-Za-z0-9_-]{1,128}$/;
const MIME = /^(?:application|text|image)\/[a-z0-9.+-]{1,100}$/;
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
  constructor(message, status = 400, diagnostic) { super(message); this.status = status; this.diagnostic = diagnostic; }
}

function sendError(res, status, message) {
  if (res.destroyed) return;
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { message, type: 'codex_workspace_error', code: `workspace_${status}` } }));
}

async function readJson(req, maxBytes) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new GatewayError('请求上下文或附件过大，请减少附件或新建会话。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new GatewayError('无效 JSON 请求。'); }
}

function validFilename(name) {
  return typeof name === 'string' && name !== '.' && name !== '..' && name.length > 0
    && name.length <= 200 && !/[\x00-\x1f\x7f/\\]/.test(name);
}

function validDataUrl(value, acceptsMime) {
  if (typeof value !== 'string' || value.length > CHAT_GATEWAY_MAX_REQUEST_BYTES) return false;
  const separator = value.indexOf(';base64,');
  if (!value.startsWith('data:') || separator < 6 || !acceptsMime(value.slice(5, separator))) return false;
  const data = value.slice(separator + 8);
  return data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data);
}

function prepareChatInput(input, applicationTools = new Map()) {
  if (typeof input === 'string') return input;
  return input.map(item => {
    if (applicationTools.size && item && !item.role) {
      if (item.type === 'function_call' && applicationTools.has(item.name)
        && typeof item.call_id === 'string' && item.call_id.length <= 200
        && typeof item.arguments === 'string' && item.arguments.length <= 24000) return item;
      if (item.type === 'function_call_output' && typeof item.call_id === 'string' && item.call_id.length <= 200
        && typeof item.output === 'string' && Buffer.byteLength(item.output) <= 65536) return item;
      if (item.type === 'reasoning' && (item.encrypted_content === undefined || typeof item.encrypted_content === 'string')) return item;
      if (['web_search_call', 'image_generation_call'].includes(item.type)) return item;
      throw new GatewayError('不支持的主助手工具记录。');
    }
    if (!item || !['user', 'assistant'].includes(item.role) || (item.type && item.type !== 'message')) throw new GatewayError('不支持的聊天消息。');
    const { role, content } = item;
    if (typeof content === 'string') return { role, content };
    if (applicationTools.size && role === 'assistant' && Array.isArray(content)
      && content.every(part => ['output_text', 'refusal'].includes(part?.type))) return item;
    if (!Array.isArray(content) || role !== 'user') throw new GatewayError('不支持的聊天内容。');
    return { role, content: content.map(part => {
      if (part?.type === 'input_text' && typeof part.text === 'string') return { type: part.type, text: part.text };
      if (part?.type === 'input_image' && validDataUrl(part.image_url, mime => /^image\/(png|jpeg|webp|gif)$/.test(mime))) {
        return { type: part.type, image_url: part.image_url, detail: 'auto' };
      }
      if (part?.type === 'input_file' && validFilename(part.filename) && validDataUrl(part.file_data, mime => MIME.test(mime))) {
        return { type: part.type, filename: part.filename, file_data: part.file_data };
      }
      throw new GatewayError('聊天附件必须是受支持的内联文件。');
    }) };
  });
}

function prepareChatPayload(body, chatTools, applicationTools = new Map()) {
  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.some(tool => tool?.type === 'function'
    ? !applicationTools.has(tool.name) || JSON.stringify(tool) !== JSON.stringify(applicationTools.get(tool.name))
    : !CHAT_TOOLS.has(tool?.type) || !chatTools.has(tool.type))
    || new Set(tools.map(tool => tool.type === 'function' ? tool.name : tool.type)).size !== tools.length) {
    throw new GatewayError('聊天请求包含未授权的工具。');
  }
  const toolChoice = body.tool_choice ?? 'auto';
  const chosenType = toolChoice?.type;
  if (!['auto', 'none'].includes(toolChoice) && !tools.some(tool => tool.type === chosenType)) {
    throw new GatewayError('聊天请求选择了未启用的工具。');
  }
  return {
    input: prepareChatInput(body.input, applicationTools),
    instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
    tools: tools.map(tool => tool.type === 'function' ? applicationTools.get(tool.name)
      : tool.type === 'code_interpreter' ? { type: tool.type, container: { type: 'auto' } } : { type: tool.type }),
    ...(applicationTools.size ? { parallel_tool_calls: false } : {}),
    tool_choice: tools.length ? (chosenType ? { type: chosenType } : toolChoice) : undefined,
  };
}

/** Runner capabilities only accept text and tools executed in their isolated workspace. */
function prepareRunnerPayload(body) {
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
  return payload;
}

export function prepareResponseRequest(body, config, chatTools, applicationTools = new Map()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GatewayError('无效模型请求。');
  if (body.previous_response_id || body.conversation || body.background) throw new GatewayError('不支持跨请求的供应商会话引用。');
  if (body.input == null || (typeof body.input !== 'string' && !Array.isArray(body.input))) throw new GatewayError('缺少模型输入。');
  const payload = chatTools ? prepareChatPayload(body, chatTools, applicationTools) : prepareRunnerPayload(body);
  payload.model = config.model;
  payload.store = false;
  payload.stream = true;
  payload.truncation = 'disabled';
  // Encrypted reasoning is returned by the provider and replayed with the isolated thread.
  if (!chatTools || applicationTools.size) payload.include = ['reasoning.encrypted_content'];
  const configuredMax = Number.isSafeInteger(config.maxOutputTokens) && config.maxOutputTokens > 0 ? config.maxOutputTokens : undefined;
  const requestedMax = Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0 ? body.max_output_tokens : undefined;
  const maxOutputTokens = configuredMax === undefined ? requestedMax
    : requestedMax === undefined ? configuredMax : Math.min(requestedMax, configuredMax);
  if (maxOutputTokens !== undefined) payload.max_output_tokens = maxOutputTokens;
  if (body.prompt_cache_key) payload.prompt_cache_key = undefined; // never share user-selected cache identifiers
  return payload;
}

export function makeSseParser(onEvent, { maxEventBytes = 4 * 1024 * 1024 } = {}) {
  const decoder = new TextDecoder(); let buffer = '';
  const boundary = /\r?\n\r?\n/g;
  return {
    feed(chunk) {
      boundary.lastIndex = Math.max(0, buffer.length - 3);
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let match;
      while ((match = boundary.exec(buffer))) {
        if (match.index > maxEventBytes) throw new GatewayError('模型事件超出大小限制。', 502);
        const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        boundary.lastIndex = 0;
        const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        let event; try { event = JSON.parse(data); } catch { throw new GatewayError('供应商返回无效流式事件。', 502); }
        onEvent(event);
      }
      if (buffer.length > maxEventBytes + 3) throw new GatewayError('模型事件超出大小限制。', 502);
    },
  };
}

export function parseUsage(usage) {
  if (!usage || !['input_tokens', 'output_tokens', 'total_tokens'].every(k => Number.isSafeInteger(usage[k]) && usage[k] >= 0)) return null;
  if (usage.total_tokens !== usage.input_tokens + usage.output_tokens) return null;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens };
}

const NETWORK_CODES = new Map([
  ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'],
  ['ECONNRESET', 'connection'], ['ECONNREFUSED', 'connection'], ['EPIPE', 'connection'],
  ['ENETUNREACH', 'connection'], ['EHOSTUNREACH', 'connection'], ['UND_ERR_SOCKET', 'connection'],
  ['ETIMEDOUT', 'timeout'], ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
  ['UND_ERR_HEADERS_TIMEOUT', 'timeout'], ['UND_ERR_BODY_TIMEOUT', 'timeout'],
  ['UND_ERR_PRX_TLS', 'tls'], ['ERR_SSL_WRONG_VERSION_NUMBER', 'tls'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'], ['CERT_HAS_EXPIRED', 'tls'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'], ['SELF_SIGNED_CERT_IN_CHAIN', 'tls'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
]);
const PROVIDER_MESSAGES = new Map([
  ['invalid_api_key', '你的 OpenAI API 密钥无效或已失效，请在个人设置中更新。'],
  ['insufficient_quota', '你的 OpenAI API 账户额度不足，请检查账户余额和项目预算。'],
  ['billing_hard_limit_reached', '你的 OpenAI API 账户已达到预算上限，请检查账单设置。'],
  ['rate_limit_exceeded', 'OpenAI 调用频率已达上限，请稍后重试。'],
  ['model_not_found', '当前 OpenAI API 密钥无法访问所选模型，请检查项目的模型权限。'],
  ['unsupported_country_region_territory', 'OpenAI 拒绝了当前服务出口所在地区，请联系 kivo 管理员。'],
  ['organization_verification_required', '请先在 OpenAI 平台完成组织验证，再使用此工具。'],
  ['content_policy_violation', 'OpenAI 的内容规则拦截了本次请求，请调整内容后重试。'],
]);

async function smallJson(response) {
  try {
    const chunks = []; let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 16 * 1024) return null;
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
}

function providerRequestId(response) {
  const id = response.headers.get('x-request-id');
  return /^req_[a-f0-9]{16,64}$/i.test(id ?? '') ? id : undefined;
}

function providerFailure(details, status, requestId, stage, chatMode) {
  const code = [details?.code, details?.type].find(value => PROVIDER_MESSAGES.has(value));
  const diagnostic = { category: 'provider', providerStatus: status, providerCode: code, providerRequestId: requestId };
  const message = PROVIDER_MESSAGES.get(code)
    ?? (status === 401 ? PROVIDER_MESSAGES.get('invalid_api_key')
      : chatMode === 'ultra' && (status === undefined || [400, 403, 422].includes(status))
        ? 'OpenAI 未接受本次 Ultra 请求，请检查 API 项目的多代理权限，或切换到 Max 重试。'
      : status === 403 ? 'OpenAI 拒绝了本次请求，请检查 API 项目权限或组织验证状态。'
      : status === 429 ? 'OpenAI API 额度或调用频率受限，请检查账单或稍后重试。'
      : status >= 500 ? 'OpenAI 服务暂时异常，请稍后重试。'
      : stage === 'upload' ? `OpenAI 未能接收分析附件（HTTP ${status}）。`
      : status ? `OpenAI 拒绝了模型请求（HTTP ${status}）。`
      : 'OpenAI 未能完成本次工具或模型调用。');
  return new GatewayError(message, 502, diagnostic);
}

function transportFailure(error, controller, stage) {
  const reason = controller?.signal.reason?.name;
  if (reason === 'TimeoutError') return new GatewayError('等待 OpenAI 响应超时，请稍后重试。', 504, { category: 'timeout' });
  if (reason === 'AbortError' || error?.name === 'AbortError') return new GatewayError('模型调用已取消。', 502, { category: 'cancelled' });
  const networkCode = [error?.cause?.code, error?.code].find(code => NETWORK_CODES.has(code));
  const category = NETWORK_CODES.get(networkCode);
  const message = category === 'dns' ? '服务器暂时无法解析 OpenAI 地址，请稍后重试。'
    : category === 'tls' ? '服务器无法与 OpenAI 建立加密连接，请联系 kivo 管理员。'
    : category === 'timeout' ? '连接 OpenAI 超时，请稍后重试。'
    : stage === 'stream' ? '与 OpenAI 的连接在回复过程中中断，请稍后重试。'
    : category === 'connection' || stage === 'request' || stage === 'upload' ? '服务器暂时无法连接 OpenAI，请稍后重试。'
    : '模型网关处理请求时发生错误，请稍后重试。';
  return new GatewayError(message, 502, { category: category ?? 'unexpected', networkCode });
}

function validateChatFiles(chatFiles) {
  if (!Array.isArray(chatFiles) || chatFiles.length > CHAT_MAX_FILES) throw new GatewayError('附件数量超出限制。');
  let total = 0;
  return chatFiles.map(file => {
    if (!validFilename(file?.name) || typeof file.mimeType !== 'string' || !MIME.test(file.mimeType)
      || !Buffer.isBuffer(file.data) || !file.data.length) throw new GatewayError('分析附件无效。');
    total += file.data.length;
    if (total > CHAT_MAX_UPLOAD_BYTES) throw new GatewayError('分析附件超出大小限制。', 413);
    return { name: file.name, mimeType: file.mimeType, data: file.data };
  });
}

export function createGateway({ store, config, onStatus = () => {}, fetchImpl = globalThis.fetch, report = entry => console.error(JSON.stringify(entry)) }) {
  const capabilities = new Map();
  const activeRequests = new Set();
  let server, listening;

  function authorizeRun({ id, userId, chatTools, chatFiles = [], chatModel, reasoningEffort, chatMode, applicationTools = [] }) {
    if (chatTools !== undefined && (!Array.isArray(chatTools) || chatTools.some(type => !CHAT_TOOLS.has(type)))) {
      throw new GatewayError('无效的聊天工具权限。');
    }
    const files = validateChatFiles(chatFiles);
    if (!Array.isArray(applicationTools) || applicationTools.length > 12 || applicationTools.some(tool => tool?.type !== 'function'
      || !/^kivo_[a-z_]{1,60}$/.test(tool.name) || !tool.parameters || tool.parameters.type !== 'object')
      || new Set(applicationTools.map(tool => tool.name)).size !== applicationTools.length
      || Buffer.byteLength(JSON.stringify(applicationTools)) > 65536) throw new GatewayError('无效的主助手工具权限。');
    if (applicationTools.length && (!chatTools || files.length || chatMode === 'ultra')) throw new GatewayError('此模式不支持主助手任务工具。');
    if (files.length && !chatTools?.includes('code_interpreter')) throw new GatewayError('未启用文件分析工具。');
    if (!chatTools && (chatModel !== undefined || reasoningEffort !== undefined || chatMode !== undefined)) throw new GatewayError('该聊天配置不可用于项目任务。');
    if (chatMode === 'ultra' && chatTools.length) throw new GatewayError('Ultra 当前仅支持普通文字聊天。');
    const selection = chatTools
      ? resolveChatSelection(store.getChatModelCatalog(config.model), chatModel, reasoningEffort, chatMode)
      : { model: config.model };
    const token = randomBytes(32).toString('base64url');
    capabilities.set(token, { runId: id, userId, ...selection, applicationTools: new Map(applicationTools.map(tool => [tool.name, structuredClone(tool)])), chatTools: chatTools && new Set(chatTools), chatFiles: files, expires: Date.now() + (config.runTimeoutMs || 20 * 60_000) + 60_000, inFlight: false, requestCount: 0, controllers: new Set(), tasks: new Set() });
    return token;
  }

  async function uploadChatFile(file, authorization, signal) {
    const body = new FormData();
    body.set('purpose', 'user_data');
    // Bound retention even if the upload succeeds but its response is lost.
    body.set('expires_after[anchor]', 'created_at');
    body.set('expires_after[seconds]', '3600');
    body.set('file', new Blob([file.data], { type: file.mimeType }), file.name);
    const response = await fetchImpl(`${OPENAI_ORIGIN}/files`, { method: 'POST', headers: { authorization }, body, signal, redirect: 'error' });
    const result = await smallJson(response);
    const requestId = providerRequestId(response);
    if (!response.ok) throw providerFailure(result?.error, response.status, requestId, 'upload');
    if (typeof result?.id !== 'string' || !FILE_ID.test(result.id)) throw new GatewayError('OpenAI 未返回有效的附件标识。', 502, { category: 'protocol', providerRequestId: requestId });
    return result.id;
  }

  async function removeChatFiles(ids, authorization, runId) {
    if (!ids.length) return;
    const signal = AbortSignal.timeout(5_000);
    await Promise.all(ids.map(async id => {
      try {
        const response = await fetchImpl(`${OPENAI_ORIGIN}/files/${id}`, { method: 'DELETE', headers: { authorization }, signal, redirect: 'error' });
        await response.body?.cancel().catch(() => {});
        if (!response.ok && response.status !== 404) report({ event: 'model_gateway_file_cleanup_failed', runId, providerStatus: response.status, providerRequestId: providerRequestId(response) });
      } catch {
        report({ event: 'model_gateway_file_cleanup_failed', runId });
      }
    }));
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

  async function handle(req, res, external = false) {
    let cap, usageId, upstreamStarted = false, settled = false, controller, ownsLock = false;
    let stage = 'validation', requestId, authorization;
    const uploadedFileIds = [];
    const settle = (usage, status) => {
      if (!usageId || settled) return;
      store.settleUsage(usageId, { ...usage, model: cap.model, status });
      settled = true;
    };
    const markUnknownUsage = () => {
      settle({ inputTokens: null, outputTokens: null, totalTokens: null }, 'unknown');
      onStatus(cap.runId, '供应商未返回完整用量，已标记为未知；请以你的 OpenAI 账单为准。');
    };
    const reportFailure = (diagnostic) => {
      if (diagnostic.category !== 'cancelled') report({ event: 'model_gateway_failure', runId: cap?.runId, stage, providerRequestId: requestId, ...diagnostic });
    };
    try {
      const rawToken = /^Bearer ([A-Za-z0-9_-]{40,60})$/.exec(req.headers.authorization || '')?.[1];
      cap = rawToken && capabilities.get(rawToken);
      if (!cap || cap.expires < Date.now()) throw new GatewayError('工作任务凭据已失效。', 401);
      if (cap.chatTools && (external || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress))) {
        throw new GatewayError('此凭据仅供站内聊天使用。', 403);
      }
      const user = store.getUser(cap.userId);
      if (!user || user.disabled) throw new GatewayError('账号已停用。', 403);
      if (store.work?.getRunBinding(cap.userId, cap.runId)) store.work.assertRunCurrent(cap.userId, cap.runId);
      if (req.method !== 'POST' || req.url !== '/v1/responses') throw new GatewayError('不支持的模型接口。', 404);
      if (req.headers.origin) throw new GatewayError('模型网关不接受浏览器请求。', 403);
      if (cap.inFlight) throw new GatewayError('同一任务已有模型请求在运行。', 429);
      if (++cap.requestCount > (cap.applicationTools.size ? 8 : cap.chatTools ? 1 : 80)) throw new GatewayError('单任务模型调用次数已达限制，请继续新的任务。', 429);
      cap.inFlight = true; ownsLock = true;
      const body = await readJson(req, cap.chatTools ? CHAT_GATEWAY_MAX_REQUEST_BYTES : MAX_REQUEST_BYTES);
      const payload = prepareResponseRequest(body, config, cap.chatTools, cap.applicationTools);
      payload.model = cap.model;
      if (cap.chatTools) {
        if (cap.reasoningEffort !== undefined) payload.reasoning = { effort: cap.reasoningEffort };
        payload.safety_identifier = createHash('sha256').update(`kivo-user:${cap.userId}`).digest('hex');
      }
      if (cap.chatMode === 'ultra') {
        if (Array.isArray(payload.input) && payload.input.some(item => typeof item.content !== 'string')) {
          throw new GatewayError('Ultra 当前仅支持普通文字聊天。');
        }
        payload.multi_agent = { enabled: true, max_concurrent_subagents: 3 };
        payload.instructions = [payload.instructions, 'Delegate independent subtasks when it improves quality. The root agent verifies and synthesizes the final answer.'].filter(Boolean).join('\n\n');
      }
      // Resolve credentials only from the capability-bound user. The runner
      // receives this capability, never a real key or a global fallback key.
      const currentUser = store.getUser(cap.userId);
      if (!currentUser || currentUser.disabled) throw new GatewayError('账号已停用。', 403);
      const apiKey = store.getUserApiKey(cap.userId);
      if (!apiKey) throw new GatewayError('请先在个人设置中填写你的 OpenAI API 密钥。', 409);
      if (!capabilities.has(rawToken)) throw new GatewayError('任务已取消。', 409);
      if (store.work?.getRunBinding(cap.userId, cap.runId)) store.work.assertRunCurrent(cap.userId, cap.runId);
      controller = new AbortController(); cap.controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(new DOMException('OpenAI request timed out', 'TimeoutError')), config.upstreamTimeoutMs || 180_000); timeout.unref();
      controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
      try {
        authorization = `Bearer ${apiKey}`;
        const headers = { authorization, 'content-type': 'application/json' };
        if (cap.chatMode === 'ultra') headers['OpenAI-Beta'] = 'responses_multi_agent=v1';
        if (cap.chatFiles.length) {
          const interpreter = payload.tools.find(tool => tool.type === 'code_interpreter');
          if (!interpreter) throw new GatewayError('分析附件需要启用文件分析工具。');
          stage = 'upload';
          onStatus(cap.runId, '正在准备文件分析附件…');
          for (const file of cap.chatFiles) uploadedFileIds.push(await uploadChatFile(file, authorization, controller.signal));
          controller.signal.throwIfAborted();
          const account = store.getUser(cap.userId);
          if (!account || account.disabled) throw new GatewayError('账号已停用。', 403);
          if (store.getUserApiKey(cap.userId) !== apiKey) throw new GatewayError('API 密钥已更新，请重新发送。', 409);
          interpreter.container.file_ids = uploadedFileIds;
        }
        stage = 'request';
        usageId = store.beginUsage(cap.userId, cap.runId, { model: cap.model, keyLast4: apiKey.slice(-4) });
        onStatus(cap.runId, '正在使用你保存的 OpenAI API 密钥调用模型…');
        upstreamStarted = true;
        const upstream = await fetchImpl(`${OPENAI_ORIGIN}/responses`, {
          method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal, redirect: 'error',
        });
        requestId = providerRequestId(upstream);
        if (!upstream.ok) {
          if (upstream.status >= 400 && upstream.status < 500) settle({ inputTokens: null, outputTokens: null, totalTokens: null }, 'failed');
          const details = await smallJson(upstream);
          throw providerFailure(details?.error, upstream.status, requestId, stage, cap.chatMode);
        }
        if (!upstream.headers.get('content-type')?.includes('text/event-stream') || !upstream.body) {
          await upstream.body?.cancel().catch(() => {});
          throw new GatewayError('OpenAI 未返回预期的流式响应。', 502, { category: 'protocol' });
        }
        stage = 'stream';
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
          if (event.type === 'error' || event.type === 'response.failed' || event.error || event.response?.error) {
            const error = providerFailure(event.response?.error ?? event.error ?? event, undefined, requestId, stage, cap.chatMode);
            const safeError = { code: 'workspace_upstream_error', message: error.message };
            reportFailure(error.diagnostic);
            if (event.type === 'error') {
              terminal = true;
              event = { type: 'error', ...safeError };
            }
            if (event.error) event = { ...event, error: safeError };
            if (event.type === 'response.failed' || event.response?.error) event = { ...event, response: { ...event.response, error: safeError } };
          }
          frames.push(`data: ${JSON.stringify(event)}\n\n`);
        }, cap.chatTools ? { maxEventBytes: CHAT_GATEWAY_MAX_EVENT_BYTES } : undefined);
        // Drain even after the browser/runner disconnects, so a normal completed
        // response can still have its actual usage recorded. Cancellation aborts it.
        for await (const chunk of upstream.body) {
          bytes += chunk.length;
          if (bytes > (cap.chatTools ? CHAT_MAX_RESPONSE_BYTES : MAX_RESPONSE_BYTES)) throw new GatewayError('模型输出超出大小限制。', 502);
          parser.feed(chunk);
          const output = frames.splice(0).join('');
          if (output && !res.destroyed && !res.writableEnded && !res.write(output)) {
            const waiting = new AbortController();
            const options = { signal: AbortSignal.any([waiting.signal, controller.signal]) };
            try { await Promise.race([once(res, 'drain', options), once(res, 'close', options)]); }
            finally { waiting.abort(); }
          }
        }
        if (!terminal) throw new GatewayError('与 OpenAI 的连接提前结束，未收到完整回复。', 502, { category: 'incomplete_stream' });
        if (!settled) markUnknownUsage();
        res.end();
      } finally { clearTimeout(timeout); }
    } catch (error) {
      if (usageId && !settled) {
        if (upstreamStarted) markUnknownUsage();
        else settle({ inputTokens: null, outputTokens: null, totalTokens: null }, 'failed');
      }
      const failure = error instanceof GatewayError ? error : transportFailure(error, controller, stage);
      if (failure.diagnostic) reportFailure(failure.diagnostic);
      else if (stage === 'stream') reportFailure({ category: 'protocol' });
      if (cap) onStatus(cap.runId, failure.message);
      if (cap?.chatTools && res.headersSent && !res.destroyed && !res.writableEnded) {
        res.end(`data: ${JSON.stringify({ type: 'error', code: 'workspace_upstream_error', message: failure.message })}\n\n`);
      } else sendError(res, failure.status, failure.message);
    } finally {
      await removeChatFiles(uploadedFileIds, authorization, cap?.runId);
      if (cap) { if (ownsLock) cap.inFlight = false; if (controller) cap.controllers.delete(controller); }
    }
  }

  return {
    authorizeRun, revokeRun,
    handleExternal(req, res) {
      const token = /^Bearer ([A-Za-z0-9_-]{40,60})$/.exec(req.headers.authorization || '')?.[1];
      const cap = token && capabilities.get(token);
      req.url = '/v1/responses';
      const task = handle(req, res, true).catch(() => sendError(res, 500, '模型网关内部错误。'));
      activeRequests.add(task); cap?.tasks.add(task);
      task.finally(() => { activeRequests.delete(task); cap?.tasks.delete(task); });
      return task;
    },
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
