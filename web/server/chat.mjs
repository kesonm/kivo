import http from 'node:http';
import { GatewayError, makeSseParser } from './gateway.mjs';

export const CHAT_MAX_MESSAGES = 200;
export const CHAT_MAX_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;

/** Replay only this thread's user/assistant text. Never inject application
 * diagnostics as system instructions or silently drop older conversation. */
export function prepareChatRequest(messages, text, config) {
  if (!Array.isArray(messages) || messages.length > CHAT_MAX_MESSAGES) throw new GatewayError('对话历史过长，请新建聊天后继续。', 409);
  const history = messages.filter(message => ['user', 'assistant'].includes(message.role));
  if (!history.length || history.at(-1).role !== 'user' || history.at(-1).content !== text) throw new GatewayError('会话内容已发生变化，请刷新后重试。', 409);
  let bytes = 0;
  const input = history.map(message => {
    if (typeof message.content !== 'string') throw new GatewayError('会话内容无效。', 409);
    bytes += Buffer.byteLength(message.content);
    // EasyInputMessage explicitly supports plain text for both user and
    // assistant history, without replaying provider output-item metadata.
    return { role: message.role, content: message.content };
  });
  if (bytes > CHAT_MAX_BYTES) throw new GatewayError('对话上下文过大，请新建聊天后继续。', 409);
  const payload = {
    model: config.model,
    instructions: 'You are a helpful assistant. Answer the user clearly and honestly. This is a text conversation with no project files, terminal, browsing, or other tools available.',
    input, tools: [], stream: true, store: false,
    max_output_tokens: config.maxOutputTokens || 4096,
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_REQUEST_BYTES) throw new GatewayError('对话上下文过大，请新建聊天后继续。', 409);
  return payload;
}

function requestLoopback({ port, token, payload, signal }) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    // A raw loopback request intentionally bypasses HTTP(S)_PROXY. Only the
    // gateway's official OpenAI fetch uses the deployment's outbound proxy.
    const request = http.request({ hostname: '127.0.0.1', port, path: '/v1/responses', method: 'POST', signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, resolve);
    request.on('error', reject);
    request.end(body);
  });
}

/** Consume the existing authenticated gateway; it owns key selection and usage.
 * No provider key, provider session ID, Docker or filesystem is used here. */
export async function streamChat({ port, token, payload, signal, onText }) {
  const response = await requestLoopback({ port, token, payload, signal });
  if (response.statusCode !== 200) {
    let body = '';
    for await (const chunk of response) {
      body += chunk.toString('utf8');
      if (body.length > 16_384) { response.destroy(); break; }
    }
    let message = '暂时无法连接模型，请稍后重试。';
    try { const decoded = JSON.parse(body); if (typeof decoded.error?.message === 'string') message = decoded.error.message.slice(0, 500); } catch {}
    throw new GatewayError(message, response.statusCode >= 400 && response.statusCode <= 599 ? response.statusCode : 502);
  }
  if (!String(response.headers['content-type'] || '').includes('text/event-stream')) { response.destroy(); throw new GatewayError('模型未返回预期的流式回复。', 502); }
  const seenParts = new Set(), outputIds = new Map();
  let terminal = null, providerError = null;
  const itemKey = event => {
    const index = event.output_index ?? 0;
    const id = event.item_id ?? event.item?.id;
    if (id != null) outputIds.set(index, String(id));
    return String(id ?? outputIds.get(index) ?? `output-${index}`);
  };
  const emitItem = (item, fallbackIndex = 0) => {
    if (item?.type !== 'message' || item.role !== 'assistant') return;
    const key = itemKey({ item, output_index: fallbackIndex });
    for (const [index, part] of (item.content || []).entries()) {
      const partKey = `${key}:${index}`;
      const text = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '';
      if (!seenParts.has(partKey) && typeof text === 'string' && text) { seenParts.add(partKey); onText(text, key); }
    }
  };
  const parser = makeSseParser(event => {
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      if (typeof event.delta === 'string') { const key = itemKey(event); seenParts.add(`${key}:${event.content_index ?? 0}`); onText(event.delta, key); }
    } else if (event.type === 'response.output_item.added') {
      itemKey(event);
    } else if (event.type === 'response.output_item.done') emitItem(event.item, event.output_index);
    else if (event.type === 'response.output_text.done' || event.type === 'response.refusal.done') {
      const key = itemKey(event), text = event.text ?? event.refusal;
      const partKey = `${key}:${event.content_index ?? 0}`;
      if (!seenParts.has(partKey) && typeof text === 'string') { seenParts.add(partKey); onText(text, key); }
    } else if (event.type === 'response.completed') {
      for (const [index, item] of (event.response?.output || []).entries()) emitItem(item, index);
      terminal = 'completed';
    } else if (event.type === 'response.incomplete') {
      for (const [index, item] of (event.response?.output || []).entries()) emitItem(item, index);
      terminal = 'incomplete';
      providerError = '本次回复达到模型输出限制或未完整生成，已保留收到的内容。';
    } else if (event.type === 'response.failed' || event.type === 'error') {
      for (const [index, item] of (event.response?.output || []).entries()) emitItem(item, index);
      terminal = 'failed';
      providerError = '模型请求未能完成，请检查个人 API 设置或稍后重试。';
    }
  });
  for await (const chunk of response) parser.feed(chunk);
  if (providerError) throw new GatewayError(providerError, 502);
  if (terminal !== 'completed') throw new GatewayError('模型连接已中断，未收到完整回复；未返回的用量会标记为未知。', 502);
}
