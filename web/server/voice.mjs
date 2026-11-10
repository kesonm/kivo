import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './store.mjs';

const OPENAI = 'https://api.openai.com';
const TRANSCRIPTION_MODEL = 'gpt-transcribe';
const REALTIME_MODEL = 'gpt-realtime-2.1';
const MAX_AUDIO_BYTES = 768 * 1024;
const MAX_SDP_BYTES = 64 * 1024;
const MAX_CALLS = 32;
const MAX_TRANSCRIPTIONS = 12;
const CALL_DURATION_MS = 10 * 60_000;
const SESSION_ID = /^[a-f0-9-]{36}$/;
const audioFormats = new Map([
  ['audio/webm', { ext: 'webm', matches: audio => audio.readUInt32BE(0) === 0x1a45dfa3 }],
  ['audio/mp4', { ext: 'mp4', matches: audio => audio.toString('ascii', 4, 8) === 'ftyp' }],
  ['audio/ogg', { ext: 'ogg', matches: audio => audio.toString('ascii', 0, 4) === 'OggS' }],
  ['audio/wav', { ext: 'wav', matches: audio => audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE' }],
]);

function recording(body) {
  const format = audioFormats.get(body?.mimeType);
  const audio = body?.audio;
  if (!format || typeof audio !== 'string' || !audio.length) throw new AppError('录音为空或格式不受支持');
  if (audio.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4) throw new AppError('录音太大，请缩短后重试', 413);
  if (audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) throw new AppError('录音编码无效');
  const data = Buffer.from(audio, 'base64');
  if (data.length > MAX_AUDIO_BYTES) throw new AppError('录音太大，请缩短后重试', 413);
  if (data.length < 12 || !format.matches(data)) throw new AppError('录音文件与格式不匹配');
  return { data, mimeType: body.mimeType, extension: format.ext };
}

function offerSdp(body) {
  const sdp = body?.sdp;
  if (typeof sdp !== 'string' || !sdp.trim()) throw new AppError('语音连接缺少协商信息');
  if (Buffer.byteLength(sdp) > MAX_SDP_BYTES) throw new AppError('语音连接协商信息过大', 413);
  const media = [...sdp.matchAll(/^m=([^\s]+)/gm)].map(match => match[1]);
  if (!/^v=0\r?\n/.test(sdp) || /[^\x09\x0a\x0d\x20-\x7e]/.test(sdp) ||
      media.length < 1 || media.length > 2 || !media.includes('audio') ||
      new Set(media).size !== media.length || media.some(type => type !== 'audio' && type !== 'application')) {
    throw new AppError('语音连接协商信息无效');
  }
  return sdp;
}

function callIdFromLocation(value) {
  try {
    const url = new URL(value, OPENAI);
    if (url.origin !== OPENAI || url.username || url.password || url.search || url.hash) return null;
    return /^\/(?:v1\/)?realtime\/calls\/(rtc_[A-Za-z0-9_-]{1,128})$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readProviderText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('语音服务返回空响应', 502, 'voice_upstream_response');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new AppError('语音服务响应过大', 502, 'voice_upstream_response');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

function providerError(status) {
  if (status === 401) return new AppError('OpenAI API Key 无效，请检查账户设置', 502, 'voice_key_invalid');
  if (status === 403 || status === 404) return new AppError('当前 OpenAI 项目无法使用此语音模型，请检查 API Key 权限', 502, 'voice_model_unavailable');
  if (status === 429) return new AppError('OpenAI 语音调用受到额度或频率限制', 429, 'voice_rate_limit');
  if (status === 400 || status === 422) return new AppError('OpenAI 未接受录音或语音连接，请重试', 502, 'voice_upstream_input');
  return new AppError('OpenAI 语音服务暂不可用', 502, 'voice_upstream_error');
}

export function createVoiceService({ store, fetchImpl = globalThis.fetch, report = entry => console.error(JSON.stringify(entry)) }) {
  const calls = new Map();
  const starts = new Map();
  const transcriptions = new Map();
  let closed = false;

  function requireKey(userId) {
    const key = store.getUserApiKey(userId);
    if (!key) throw new AppError('请先在账户设置中填写 OpenAI API Key', 409, 'api_key_required');
    return key;
  }

  function exclusive(operations, userId, signal, capacity, work) {
    if (closed) throw new AppError('语音服务正在重启，请稍后重试', 503, 'voice_unavailable');
    if (operations.has(userId)) throw new AppError('当前语音请求仍在处理，请稍后重试', 409, 'voice_busy');
    if (operations.size >= capacity) throw new AppError('语音服务繁忙，请稍后重试', 503, 'voice_busy');
    const controller = new AbortController();
    const operation = { controller, promise: null };
    operations.set(userId, operation);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    operation.promise = Promise.resolve().then(() => work(combined)).finally(() => operations.delete(userId));
    return operation.promise;
  }

  async function providerRequest(path, key, { body, signal, timeout, stage, userId }) {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await fetchImpl(OPENAI + path, {
        method: 'POST', body, signal: requestSignal, redirect: 'error',
        headers: {
          Authorization: 'Bearer ' + key,
          'OpenAI-Safety-Identifier': createHash('sha256').update('kivo-user:' + userId).digest('hex'),
        },
      });
    } catch {
      if (signal?.aborted) throw new AppError('语音请求已取消', 409, 'voice_cancelled');
      if (timeoutSignal.aborted) throw new AppError('等待 OpenAI 语音服务超时，请重试', 504, 'voice_timeout');
      report({ event: 'voice_upstream_failure', stage, kind: 'connection' });
      throw new AppError('服务器暂时无法连接 OpenAI 语音服务', 502, 'voice_network');
    }
    if (!response.ok && !(stage === 'hangup' && response.status === 404)) {
      void response.body?.cancel().catch(() => {});
      const requestId = response.headers.get('x-request-id');
      report({
        event: 'voice_upstream_failure', stage, status: response.status,
        requestId: /^req_[a-f0-9]{16,64}$/i.test(requestId ?? '') ? requestId : undefined,
      });
      throw providerError(response.status);
    }
    return response;
  }

  async function hangUp(userId, callId, key) {
    if (!callId || !key) return;
    try {
      const response = await providerRequest('/v1/realtime/calls/' + callId + '/hangup', key, { stage: 'hangup', timeout: 6_000, userId });
      await response.body?.cancel();
    } catch {
      // The browser also closes its peer connection. This endpoint may report
      // a closed call if the peer already disconnected.
    }
  }

  async function endCall(userId, sessionId) {
    const call = calls.get(userId);
    if (!call || (sessionId && call.sessionId !== sessionId)) return;
    calls.delete(userId);
    clearTimeout(call.timer);
    await hangUp(userId, call.callId, call.key);
  }

  async function stopForUser(userId) {
    const pending = [starts.get(userId), transcriptions.get(userId)].filter(Boolean);
    for (const operation of pending) operation.controller.abort();
    await Promise.allSettled([endCall(userId), ...pending.map(operation => operation.promise)]);
  }

  return {
    async transcribe(userId, body, signal) {
      const { data, mimeType, extension } = recording(body);
      return exclusive(transcriptions, userId, signal, MAX_TRANSCRIPTIONS, async operationSignal => {
        const key = requireKey(userId);
        const form = new FormData();
        form.set('model', TRANSCRIPTION_MODEL);
        form.set('file', new Blob([data], { type: mimeType }), 'dictation.' + extension);
        const response = await providerRequest('/v1/audio/transcriptions', key, {
          body: form, signal: operationSignal, timeout: 45_000, stage: 'transcription', userId,
        });
        try {
          const result = JSON.parse(await readProviderText(response, 128 * 1024));
          if (typeof result?.text !== 'string') throw new Error('missing transcript');
          if (operationSignal.aborted) throw new Error('cancelled transcript');
          return { text: result.text.trim().slice(0, 24_000) };
        } catch {
          if (operationSignal.aborted) throw new AppError('语音请求已取消', 409, 'voice_cancelled');
          throw new AppError('未能读取 OpenAI 转写结果，请重试', 502, 'voice_upstream_response');
        }
      });
    },

    async startRealtime(userId, body, signal) {
      const sdp = offerSdp(body);
      if (!calls.has(userId) && calls.size + starts.size >= MAX_CALLS) throw new AppError('语音服务繁忙，请稍后重试', 503, 'voice_busy');
      return exclusive(starts, userId, signal, MAX_CALLS, async operationSignal => {
        const key = requireKey(userId);
        await endCall(userId);
        const form = new FormData();
        form.set('sdp', sdp);
        form.set('session', JSON.stringify({
          type: 'realtime',
          model: REALTIME_MODEL,
          instructions: 'You are Kivo, a helpful voice assistant. Reply naturally, concisely, and in the language the user speaks.',
          audio: { output: { voice: 'marin' } },
        }));
        let callId;
        try {
          const response = await providerRequest('/v1/realtime/calls', key, {
            body: form, signal: operationSignal, timeout: 30_000, stage: 'realtime', userId,
          });
          callId = callIdFromLocation(response.headers.get('location'));
          const answer = await readProviderText(response, MAX_SDP_BYTES);
          if (operationSignal.aborted) throw new AppError('语音连接已取消', 409, 'voice_cancelled');
          if (!callId || !/^v=0\r?\n/.test(answer)) throw new AppError('OpenAI 未返回有效的语音连接', 502, 'voice_upstream_response');
          const sessionId = randomUUID();
          const expiresAt = Date.now() + CALL_DURATION_MS;
          const timer = setTimeout(() => { void endCall(userId, sessionId); }, CALL_DURATION_MS);
          timer.unref();
          // Keep the original key in memory only for this bounded active call,
          // so logout or a key replacement can still hang it up.
          calls.set(userId, { callId, sessionId, timer, key });
          return { sdp: answer, sessionId, expiresAt };
        } catch (error) {
          await hangUp(userId, callId, key);
          if (error instanceof AppError) throw error;
          throw new AppError('语音连接未能完成，请重试', 502, 'voice_upstream_response');
        }
      });
    },

    async stopRealtime(userId, body) {
      if (typeof body?.sessionId !== 'string' || !SESSION_ID.test(body.sessionId)) throw new AppError('语音会话标识无效');
      await endCall(userId, body.sessionId);
      return { ok: true };
    },

    stopForUser,

    async close() {
      closed = true;
      const users = new Set([...calls.keys(), ...starts.keys(), ...transcriptions.keys()]);
      await Promise.allSettled([...users].map(stopForUser));
    },
  };
}
