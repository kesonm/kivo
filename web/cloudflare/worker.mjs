const PUBLIC_ORIGIN = 'https://kivo.iptnet.xyz';
const BACKEND_ORIGIN = 'https://origin-kivo.iptnet.xyz';
const CHAT_UPLOAD_BYTES = 8 * 1024 * 1024 + 64 * 1024;

// Asset-first requests receive the same policy from public/_headers.
export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
};
const PASSTHROUGH_HEADERS = [
  'accept', 'accept-language', 'content-type', 'cookie', 'origin', 'user-agent',
  'x-csrf-token', 'last-event-id', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
];
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function secureHeaders(headers = undefined, privateResponse = false) {
  const result = new Headers(headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) result.set(name, value);
  for (const name of [...result.keys()]) if (name.startsWith('x-kivo-') || HOP_HEADERS.includes(name)) result.delete(name);
  if (privateResponse) {
    result.set('Cache-Control', 'no-store, no-transform');
    result.set('CDN-Cache-Control', 'no-store');
    result.set('Cloudflare-CDN-Cache-Control', 'no-store');
    result.set('Pragma', 'no-cache');
    result.set('Expires', '0');
  }
  return result;
}

function failure(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: secureHeaders({ 'Content-Type': 'application/json; charset=utf-8' }, true),
  });
}

function backendUrl(value) {
  const url = new URL(value ?? BACKEND_ORIGIN);
  if (url.protocol !== 'https:' || url.origin !== BACKEND_ORIGIN || url.origin === PUBLIC_ORIGIN
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid backend configuration');
  return url;
}

function clientIp(request) {
  // Cloudflare supplies this header at ingress. Never trust client-provided
  // Forwarded, X-Forwarded-*, X-Real-IP or X-Kivo-* values.
  const value = request.headers.get('cf-connecting-ip') ?? '';
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(part => Number(part) <= 255)) return value;
  if (/^[0-9a-f:.]+$/i.test(value) && value.includes(':')) {
    try { new URL(`http://[${value}]/`); return value; } catch {}
  }
  return null;
}

async function readChatUpload(request) {
  const length = Number(request.headers.get('content-length'));
  if (length > CHAT_UPLOAD_BYTES) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CHAT_UPLOAD_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // A fixed-length upload keeps the Worker-to-Tunnel hop from stalling on
  // chunked multipart requests. All other API bodies continue to stream.
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.origin !== PUBLIC_ORIGIN) return failure(421, '此入口仅支持 kivo.iptnet.xyz。');
  const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/healthz';
  if (!isApi) {
    if (!['GET', 'HEAD'].includes(request.method)) return failure(405, '静态页面仅支持 GET 和 HEAD。');
    try {
      const asset = await env.ASSETS.fetch(request);
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers: secureHeaders(asset.headers) });
    } catch { return failure(503, '页面暂时不可用，请稍后重试。'); }
  }

  const origin = request.headers.get('origin');
  if ((origin !== null && origin !== PUBLIC_ORIGIN) || request.headers.get('sec-fetch-site') === 'cross-site') {
    return failure(403, '请求来源不被允许。');
  }
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) return failure(405, '不支持的请求方法。');
  let target;
  try {
    target = backendUrl(env.ORIGIN_URL);
    if (typeof env.ORIGIN_TOKEN !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(env.ORIGIN_TOKEN)) throw new Error('Missing backend credential');
  } catch { return failure(503, '服务入口尚未配置完成。'); }
  const ip = clientIp(request);
  if (!ip) return failure(503, '无法验证请求来源，请稍后重试。');

  // Set only path/query on an already validated URL: neither request URLs nor
  // headers can select a different origin, even with a // or encoded path.
  target.pathname = url.pathname;
  target.search = url.search;
  const headers = new Headers();
  for (const name of PASSTHROUGH_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // Only the local-assistant protocol uses bearer capabilities. Browser APIs
  // continue to use the original session + CSRF authentication.
  if (url.pathname.startsWith('/api/local-agent/')) {
    const authorization = request.headers.get('authorization');
    if (authorization) headers.set('authorization', authorization);
  }
  headers.set('X-Kivo-Origin-Token', env.ORIGIN_TOKEN);
  headers.set('X-Kivo-Client-IP', ip);
  headers.set('CF-Connecting-IP', ip);
  headers.set('Cache-Control', 'no-store');
  try {
    let body = request.body;
    if (body && request.method === 'POST' && /^\/api\/threads\/[a-f0-9-]{36}\/turns$/.test(url.pathname)
      && /^multipart\/form-data(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
      body = await readChatUpload(request);
      if (body === null) return failure(413, '附件合计不能超过 8 MiB。');
    }
    const upstream = await fetchImpl(target.href, {
      method: request.method, headers,
      ...(body === null ? {} : { body, duplex: 'half' }),
      signal: request.signal,
      redirect: 'manual', cache: 'no-store',
    });
    // Never forward the origin credential across a redirect or leak a private
    // backend URL in Location. Backend APIs are not redirect endpoints.
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return failure(502, '后端返回了非预期的跳转。');
    }
    // Passing the stream through preserves SSE, backpressure and cancellation.
    // Headers cloning also preserves individual Set-Cookie values.
    return new Response(upstream.body, {
      status: upstream.status, statusText: upstream.statusText,
      headers: secureHeaders(upstream.headers, true),
    });
  } catch { return failure(502, '暂时无法连接后端，请稍后重试。'); }
}

export default { fetch(request, env) { return handleRequest(request, env); } };
