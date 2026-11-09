import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const sourceDirectory = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
const source = await readFile(path.join(sourceDirectory, 'cloudflare/worker.mjs'), 'utf8');
const config = JSON.parse(await readFile(path.join(sourceDirectory, 'wrangler.jsonc'), 'utf8'));
const fakeToken = 'isolated-native-smoke-token-not-a-production-secret-123456';
const base = 'https://kivo.iptnet.xyz';
const encoder = new TextEncoder();
const calls = [];
const outboundService = async request => {
  calls.push({ url: request.url, method: request.method });
  assert.equal(new URL(request.url).origin, 'https://origin-kivo.iptnet.xyz');
  assert.equal(request.headers.get('x-kivo-origin-token'), fakeToken);
  assert.ok(request.headers.get('x-kivo-client-ip'));
  const pathname = new URL(request.url).pathname;
  if (pathname === '/healthz') return Response.json({ ok: true });
  if (pathname === '/api/echo') {
    assert.equal(request.headers.get('cookie'), 'cw_session=fake-session');
    assert.equal(request.headers.get('x-csrf-token'), 'fake-csrf');
    assert.equal(request.headers.get('origin'), base);
    return Response.json(await request.json(), { headers: { 'set-cookie': 'cw_session=fake-new-session; Path=/; Secure; HttpOnly; SameSite=Strict' } });
  }
  if (pathname === '/api/runs/fake/events') return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('event: snapshot\ndata: {"status":"running"}\n\n'));
      setTimeout(() => controller.enqueue(encoder.encode(': heartbeat\n\n')), 60);
      setTimeout(() => { controller.enqueue(encoder.encode('event: done\ndata: {"status":"completed"}\n\n')); controller.close(); }, 150);
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  if (pathname === '/api/redirect') return new Response(null, { status: 302, headers: { location: 'https://unexpected.example/' } });
  return new Response(null, { status: 404 });
};

function runtime(script) {
  return new Miniflare(convertV4MiniflareOptions({
    modules: true, script, rootPath: '/tmp', port: 0, host: '127.0.0.1', cf: false,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags || [],
    bindings: { ORIGIN_URL: 'https://origin-kivo.iptnet.xyz', ORIGIN_TOKEN: fakeToken },
    outboundService, log: new Log(LogLevel.ERROR),
  }));
}
const headers = { 'cf-connecting-ip': '198.51.100.7' };
const fixed = runtime(source);
try {
  const health = await fixed.dispatchFetch(base + '/healthz', { headers });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.match(health.headers.get('cache-control'), /no-store/);
  const posted = await fixed.dispatchFetch(base + '/api/echo', { method: 'POST', headers: {
    ...headers, origin: base, 'content-type': 'application/json', cookie: 'cw_session=fake-session', 'x-csrf-token': 'fake-csrf',
  }, body: JSON.stringify({ text: 'native-runtime-fake-body' }) });
  assert.equal(posted.status, 200);
  assert.deepEqual(await posted.json(), { text: 'native-runtime-fake-body' });
  assert.match(posted.headers.get('set-cookie'), /cw_session=fake-new-session/);
  const stream = await fixed.dispatchFetch(base + '/api/runs/fake/events', { headers });
  assert.equal(stream.status, 200); assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  const first = await reader.read(); const firstText = new TextDecoder().decode(first.value);
  assert.match(firstText, /event: snapshot/); assert.ok(!firstText.includes('event: done'));
  let rest = '';
  for (;;) { const item = await reader.read(); if (item.done) break; rest += new TextDecoder().decode(item.value); }
  assert.match(rest, /heartbeat/); assert.match(rest, /event: done/);
  const beforeRedirect = calls.length;
  const redirected = await fixed.dispatchFetch(base + '/api/redirect', { headers });
  assert.equal(redirected.status, 502); assert.equal(redirected.headers.get('location'), null);
  assert.equal(calls.length, beforeRedirect + 1);
  const beforeRejected = calls.length;
  const rejected = await fixed.dispatchFetch(base + '/api/echo', { method: 'POST', headers: { ...headers, origin: 'https://other.example' }, body: '{}' });
  assert.equal(rejected.status, 403); assert.equal(calls.length, beforeRejected);
  console.log('PASS native workerd: health, POST/body/cookie/CSRF, streamed SSE, redirect rejection, cross-origin rejection');
} finally { await fixed.dispose(); }

// A deliberately regressed copy must fail before outboundService. This proves
// the smoke traverses native fetch validation, unlike the Node mock unit tests.
const brokenSource = source.replace(/cache: ['"]no-store['"]/, "cache: 'no-store', cf: { cacheTtl: 0 }");
assert.notEqual(brokenSource, source);
const broken = runtime(brokenSource);
try {
  const before = calls.length;
  const result = await broken.dispatchFetch(base + '/healthz', { headers });
  assert.equal(result.status, 502); assert.equal(calls.length, before);
  console.log('PASS negative control: no-store plus cacheTtl:0 is rejected by workerd before any origin request');
} finally { await broken.dispose(); }
