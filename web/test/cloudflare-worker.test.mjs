import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { handleRequest, SECURITY_HEADERS } from '../cloudflare/worker.mjs';

const publicOrigin = 'https://kivo.iptnet.xyz';
const origin = 'https://origin-kivo.iptnet.xyz';
const fakeToken = 'unit-test-origin-token-not-a-real-secret-123456';
const environment = overrides => ({ ORIGIN_URL: origin, ORIGIN_TOKEN: fakeToken, ...overrides });
const request = (pathname, options = {}) => new Request(publicOrigin + pathname, {
  ...options, headers: { 'cf-connecting-ip': '198.51.100.7', ...options.headers },
});

test('Cloudflare entry rejects alternate hosts, protocols and cross-origin requests without fetching', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ ok: true }); };
  for (const url of ['https://kivo.workers.dev/api/session', 'https://other.example/api/session', 'http://kivo.iptnet.xyz/api/session', 'https://kivo.iptnet.xyz:8443/healthz']) {
    assert.equal((await handleRequest(new Request(url), environment(), fetcher)).status, 421);
  }
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: publicOrigin, 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await handleRequest(request('/api/auth/login', { method: 'POST', body: '{}', headers }), environment(), fetcher)).status, 403);
  }
  assert.equal(calls, 0);
  // Workers supplies an ExecutionContext as the third argument; it is not a fetch implementation.
  assert.equal((await worker.fetch(new Request('https://preview.workers.dev/api/session'), environment(), {})).status, 421);
});

test('origin validation fails closed for self-reference, credentials, paths, ports and missing secret', async () => {
  let calls = 0;const fetcher = async () => { calls++; return Response.json({ ok: true }); };
  for (const ORIGIN_URL of ['http://origin-kivo.iptnet.xyz', publicOrigin, 'https://evil.example', origin + ':8443', origin + '/api', origin + '?target=evil', origin + '#fragment', 'https://user:password@origin-kivo.iptnet.xyz', 'not-a-url']) {
    assert.equal((await handleRequest(request('/api/session'), environment({ ORIGIN_URL }), fetcher)).status, 503);
  }
  for (const ORIGIN_TOKEN of [undefined, '', 'too-short', 'x'.repeat(300), ' '.repeat(32)]) {
    assert.equal((await handleRequest(request('/api/session'), environment({ ORIGIN_TOKEN }), fetcher)).status, 503);
  }
  assert.equal(calls, 0);
});

test('API forwarding keeps cookies, CSRF, body, query and original Origin while replacing proxy identities', async () => {
  const controller = new AbortController();
  const input = request('/api/threads?limit=2&query=a%2Fb', { method: 'POST', body: '{"text":"private prompt"}', signal: controller.signal, headers: {
    origin: publicOrigin, cookie: 'cw_session=private-session', 'x-csrf-token': 'csrf-value', 'content-type': 'application/json',
    'x-forwarded-for': '1.2.3.4', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', forwarded: 'for=1.2.3.4',
    'x-real-ip': '1.2.3.4', 'x-kivo-origin-token': 'attacker-token', 'x-kivo-client-ip': '1.2.3.4', 'x-kivo-other': 'attacker-data',
    authorization: 'Bearer should-not-forward', 'last-event-id': 'event-12',
  } });
  let calls = 0;
  const result = await handleRequest(input, environment(), async (url, options) => {
    calls++;assert.equal(url, origin + '/api/threads?limit=2&query=a%2Fb');assert.equal(options.method, 'POST');
    assert.equal(options.headers.get('cookie'), 'cw_session=private-session');assert.equal(options.headers.get('x-csrf-token'), 'csrf-value');
    assert.equal(options.headers.get('origin'), publicOrigin);assert.equal(options.headers.get('last-event-id'), 'event-12');
    assert.equal(options.headers.get('x-kivo-origin-token'), fakeToken);assert.equal(options.headers.get('x-kivo-client-ip'), '198.51.100.7');
    assert.equal(options.headers.get('cf-connecting-ip'), '198.51.100.7');
    for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'x-kivo-other', 'authorization']) assert.equal(options.headers.get(name), null, name);
    assert.equal(options.body, input.body);assert.equal(await new Response(options.body).text(), '{"text":"private prompt"}');
    assert.equal(options.signal, input.signal);assert.equal(options.redirect, 'manual');assert.equal(options.cache, 'no-store');
    // workerd rejects cache: 'no-store' combined with cf.cacheTtl: 0.
    assert.equal(options.cf, undefined);
    return Response.json({ ok: true }, { status: 202 });
  });
  assert.equal(calls, 1);assert.equal(result.status, 202);
  assert.match(result.headers.get('cache-control'), /no-store/);assert.equal(result.headers.get('cloudflare-cdn-cache-control'), 'no-store');
});

test('trusted client IP is mandatory and accepts IPv4 and IPv6 without trusting forwarded headers', async () => {
  const captured = [];
  const fetcher = async (url, options) => { captured.push(options.headers.get('x-kivo-client-ip'));return Response.json({ ok: true }); };
  for (const ip of ['', '1.2.3.999', '1.2.3.4, 5.6.7.8', 'localhost', '2001:db8:::1']) {
    assert.equal((await handleRequest(request('/healthz', { headers: { 'cf-connecting-ip': ip, 'x-forwarded-for': '198.51.100.8' } }), environment(), fetcher)).status, 503);
  }
  for (const ip of ['203.0.113.9', '2001:db8::9', '::ffff:192.0.2.1']) {
    assert.equal((await handleRequest(request('/healthz', { headers: { 'cf-connecting-ip': ip } }), environment(), fetcher)).status, 200);
  }
  assert.deepEqual(captured, ['203.0.113.9', '2001:db8::9', '::ffff:192.0.2.1']);
});

test('SSE response stays streaming, uncached and cancellable, with separate session cookies intact', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: {}\n\n')); }, cancel() { cancelled = true; } });
  const headers = new Headers({ 'content-type': 'text/event-stream', 'cache-control': 'public, max-age=3600', 'x-kivo-origin-token': fakeToken });
  headers.append('set-cookie', 'cw_session=first; Path=/; HttpOnly; Secure; SameSite=Strict');
  headers.append('set-cookie', 'second=other; Path=/; HttpOnly; Secure; SameSite=Strict');
  const upstream = new Response(stream, { headers });
  const result = await handleRequest(request('/api/runs/run-123/events'), environment(), async () => upstream);
  assert.equal(result.body, upstream.body);assert.equal(result.headers.get('content-type'), 'text/event-stream');
  assert.deepEqual(result.headers.getSetCookie(), headers.getSetCookie());assert.equal(result.headers.get('x-kivo-origin-token'), null);
  assert.equal(result.headers.get('cache-control'), 'no-store, no-transform');
  const reader = result.body.getReader();const chunk = await reader.read();
  assert.equal(new TextDecoder().decode(chunk.value), 'event: snapshot\ndata: {}\n\n');assert.equal(chunk.done, false);
  await reader.cancel();assert.equal(cancelled, true);
});

test('redirects and connection errors never leak credentials or forward to another backend', async () => {
  let calls = 0, cancelled = false;
  const redirect = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 307, headers: { location: 'https://evil.example/receive' } });
  const result = await handleRequest(request('/api/session'), environment(), async () => { calls++;return redirect; });
  assert.equal(result.status, 502);assert.equal(calls, 1);assert.equal(cancelled, true);assert.equal(result.headers.get('location'), null);
  const failed = await handleRequest(request('/api/session'), environment(), async () => { throw new Error('private details: ' + fakeToken); });
  assert.equal(failed.status, 502);assert.ok(!(await failed.text()).includes(fakeToken));
});

test('assets fallback is separate from backend and includes security headers without requiring origin secrets', async () => {
  let assets = 0, backend = 0;
  const env = { ASSETS: { fetch: async input => { assets++;assert.equal(new URL(input.url).pathname, '/account');return new Response('<html>App</html>', { headers: { 'content-type': 'text/html' } }); } } };
  const result = await handleRequest(request('/account'), env, async () => { backend++;return Response.json({}); });
  assert.equal(await result.text(), '<html>App</html>');assert.equal(assets, 1);assert.equal(backend, 0);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(result.headers.get(name), value);
  assert.equal((await handleRequest(request('/account', { method: 'POST', body: '{}' }), env)).status, 405);
  assert.equal((await handleRequest(request('/api/session'), env)).status, 503);assert.equal(assets, 1);
});

test('deployment keeps API routes ahead of SPA assets, disables alternate entry and logs, and has matching static headers', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.workers_dev, false);assert.equal(config.preview_urls, false);assert.equal(config.observability.enabled, false);
  assert.deepEqual(config.routes, [{ pattern: 'kivo.iptnet.xyz', custom_domain: true }]);
  assert.equal(config.assets.binding, 'ASSETS');assert.equal(config.assets.not_found_handling, 'single-page-application');
  assert.deepEqual(config.assets.run_worker_first, ['/api', '/api/*', '/healthz']);assert.equal(config.vars.ORIGIN_URL, origin);assert.equal(config.vars.ORIGIN_TOKEN, undefined);
  const staticHeaders = await readFile(new URL('../public/_headers', import.meta.url), 'utf8');
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.ok(staticHeaders.includes(`  ${name}: ${value}`), name);
});
