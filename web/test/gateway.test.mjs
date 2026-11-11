import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, prepareResponseRequest, makeSseParser, parseUsage } from '../server/gateway.mjs';
import { defaultChatModelCatalog } from '../server/chat-models.mjs';

// A deliberately configured legacy key must never be used as a fallback.
const config = { model: 'test-model', apiKey: 'GLOBAL_MUST_NOT_USE', gatewayHost: '127.0.0.1', gatewayPort: 0, maxOutputTokens: 512 };
const sse = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const completed = (input = 100, output = 20) => ({ type: 'response.completed', response: { usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } } });
const stream = events => new Response(sse(events), { headers: { 'content-type': 'text/event-stream' } });

function fakeStore() {
  const keys = new Map([['u', 'sk-test-user-u-0001'], ['v', 'sk-test-user-v-0002']]);
  const users = new Map([['u', { id: 'u', disabled: false }], ['v', { id: 'v', disabled: false }]]);
  const pending = new Map(), usage = []; let sequence = 0;
  return {
    getUser: id => users.get(id),
    getUserApiKey: id => keys.get(id) || null,
    getApiKeyMetadata: id => ({ configured: keys.has(id) }),
    getChatModelCatalog: defaultChatModelCatalog,
    beginUsage(userId, runId, metadata) { const id = `usage-${++sequence}`; pending.set(id, { userId, runId, ...metadata }); return id; },
    settleUsage(id, record) { const previous = pending.get(id); if (!previous) return; pending.delete(id); usage.push({ id, ...previous, ...record }); },
    keys, users, usage, pending,
  };
}

async function fixture(t, fetchImpl, { chatTools, chatFiles, applicationTools, configOverrides = {}, report = () => {} } = {}) {
  const store = fakeStore();
  const gateway = createGateway({ store, config: { ...config, ...configOverrides }, fetchImpl, report });
  const address = await gateway.start();
  const token = gateway.authorizeRun({ id: 'run', userId: 'u', chatTools, chatFiles, applicationTools });
  t.after(() => gateway.close());
  const request = (body = { input: 'Hello' }, extra = {}) => fetch(`http://127.0.0.1:${address.port}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  return { store, gateway, request, address, token };
}

const primaryTool = { type: 'function', name: 'kivo_list_work', description: 'Read owned tasks', strict: true,
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } };

test('application tool authority is capability-bound and cannot be supplied or changed in a request', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => { calls.push(JSON.parse(options.body)); return stream([completed()]); },
    { chatTools: [], applicationTools: [primaryTool] });
  const ordinary = f.gateway.authorizeRun({ id: 'ordinary', userId: 'u', chatTools: [] });
  let response = await f.request({ input: [{ role: 'user', content: 'work' }], tools: [primaryTool] }, { authorization: `Bearer ${ordinary}` });
  assert.equal(response.status, 400); await response.text();
  response = await f.request({ input: [{ role: 'user', content: 'work' }], tools: [{ ...primaryTool, description: 'altered instructions' }] });
  assert.equal(response.status, 400); await response.text();
  assert.equal(calls.length, 0);
  response = await f.request({ input: [{ role: 'user', content: 'work' }], tools: [primaryTool] });
  assert.equal(response.status, 200); await response.text();
  assert.deepEqual(calls[0].tools, [primaryTool]);
  assert.deepEqual(calls[0].include, ['reasoning.encrypted_content']);
  assert.equal(calls[0].parallel_tool_calls, false);
});

test('primary gateway bounds repeated calls and allows owned function history with encrypted reasoning', async t => {
  const f = await fixture(t, async () => stream([completed()]), { chatTools: [], applicationTools: [primaryTool] });
  const input = [{ role: 'user', content: 'work' },
    { type: 'reasoning', id: 'rs1', summary: [], encrypted_content: 'opaque' },
    { type: 'function_call', call_id: 'c1', name: primaryTool.name, arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: '{"tasks":[]}' }];
  for (let i = 0; i < 8; i++) {
    const response = await f.request({ input, tools: [primaryTool] });
    assert.equal(response.status, 200); await response.text();
  }
  const exhausted = await f.request({ input, tools: [primaryTool] });
  assert.equal(exhausted.status, 429); await exhausted.text();
  assert.equal(f.store.usage.length, 8);
});

test('usage uses actual provider total with a single direct inference request', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return stream([{ ...completed(), response: { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 120 } } }]);
  });
  const response = await f.request({ input: 'Hello', model: 'forbidden-model' });
  assert.equal(response.status, 200); await response.text();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].body.model, 'test-model');
  assert.equal(calls[0].body.max_output_tokens, 512);
  assert.equal(calls[0].options.headers.authorization, 'Bearer sk-test-user-u-0001');
  assert.equal(f.store.usage[0].totalTokens, 120);
  assert.equal(f.store.usage[0].keyLast4, '0001');
  assert.equal(f.store.usage[0].status, 'completed');
});

test('chat and runner requests omit an unconfigured output limit from the upstream payload', async t => {
  for (const chatTools of [undefined, []]) {
    const calls = [];
    const f = await fixture(t, async (url, options) => {
      calls.push(JSON.parse(options.body));
      return stream([completed()]);
    }, { chatTools, configOverrides: { maxOutputTokens: undefined } });
    const response = await f.request({ input: 'Hello' });
    assert.equal(response.status, 200); await response.text();
    assert.equal(calls.length, 1);
    assert.equal(Object.hasOwn(calls[0], 'max_output_tokens'), false);
    assert.equal(f.store.usage[0].totalTokens, 120);
  }
});

test('explicit output limits preserve values above the old gateway ceiling and use the tighter limit', () => {
  const unconfigured = { model: 'test-model' };
  for (const chatTools of [undefined, new Set()]) {
    for (const limit of [16, 65536, 131072]) {
      assert.equal(prepareResponseRequest({ input: 'Hi' }, { ...unconfigured, maxOutputTokens: limit }, chatTools).max_output_tokens, limit);
      assert.equal(prepareResponseRequest({ input: 'Hi', max_output_tokens: limit }, unconfigured, chatTools).max_output_tokens, limit);
    }
    assert.equal(prepareResponseRequest({ input: 'Hi', max_output_tokens: 131072 }, { ...unconfigured, maxOutputTokens: 65536 }, chatTools).max_output_tokens, 65536);
    assert.equal(prepareResponseRequest({ input: 'Hi', max_output_tokens: 65536 }, { ...unconfigured, maxOutputTokens: 131072 }, chatTools).max_output_tokens, 65536);
  }
});

test('invalid output limits are not forwarded and cannot replace a valid explicit limit', () => {
  const invalid = [undefined, null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4096', true, {}, []];
  for (const chatTools of [undefined, new Set()]) {
    for (const value of invalid) {
      const request = { input: 'Hi', max_output_tokens: value };
      const unconfigured = { model: 'test-model', maxOutputTokens: value };
      assert.equal(Object.hasOwn(prepareResponseRequest(request, unconfigured, chatTools), 'max_output_tokens'), false);
      assert.equal(prepareResponseRequest(request, config, chatTools).max_output_tokens, 512);
      assert.equal(prepareResponseRequest({ input: 'Hi', max_output_tokens: 65536 }, unconfigured, chatTools).max_output_tokens, 65536);
    }
  }
});

test('capabilities select only their own user key and preserve key suffix snapshots', async t => {
  const authorizations = [];
  const f = await fixture(t, async (url, options) => { authorizations.push(options.headers.authorization); return stream([completed()]); });
  const secondToken = f.gateway.authorizeRun({ id: 'run-v', userId: 'v' });
  await (await f.request({ input: 'Hello', userId: 'v', apiKey: 'EVIL_BODY_KEY' })).text();
  await (await f.request({ input: 'Hello', userId: 'u' }, { authorization: `Bearer ${secondToken}` })).text();
  f.store.keys.set('u', 'sk-rotated-user-u-0003');
  await (await f.request()).text();
  assert.deepEqual(authorizations, ['Bearer sk-test-user-u-0001', 'Bearer sk-test-user-v-0002', 'Bearer sk-rotated-user-u-0003']);
  assert.deepEqual(f.store.usage.map(row => [row.userId, row.keyLast4]), [['u', '0001'], ['v', '0002'], ['u', '0003']]);
});

test('missing personal key refuses inference with no global or other-user fallback', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('must not call provider'); });
  f.store.keys.delete('u');
  const response = await f.request();
  assert.equal(response.status, 409);
  assert.match(await response.text(), /个人设置/);
  assert.equal(calls, 0); assert.deepEqual(f.store.usage, []);
});

test('disabled users cannot use a previously issued capability', async t => {
  const f = await fixture(t, async () => { throw new Error('must not call provider'); });
  f.store.users.set('u', { id: 'u', disabled: true });
  assert.equal((await f.request()).status, 403);
  assert.deepEqual(f.store.usage, []);
});

test('401 asks user to replace their key without exposing provider error body', async t => {
  const f = await fixture(t, async () => Response.json({ error: { message: 'Incorrect API key sk-test-user-u-0001 SECRET_PROVIDER_BODY' } }, { status: 401 }));
  const response = await f.request();
  const body = await response.text();
  assert.equal(response.status, 502); assert.match(body, /个人设置中更新/);
  assert.ok(!body.includes('sk-test-user-u-0001')); assert.ok(!body.includes('SECRET_PROVIDER_BODY'));
  assert.equal(f.store.usage[0].status, 'failed');
  assert.equal(f.store.usage[0].totalTokens, null);
});

test('connection failures identify the upstream stage without leaking exception text', async t => {
  const diagnostics = [];
  const f = await fixture(t, async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('PRIVATE_TRANSPORT_DETAILS'), { code: 'ECONNRESET' }) });
  }, { report: entry => diagnostics.push(entry) });
  const response = await f.request();
  assert.equal(response.status, 502);
  assert.match(await response.text(), /无法连接 OpenAI/);
  assert.equal(f.store.usage[0].status, 'unknown');
  assert.equal(diagnostics[0].stage, 'request');
  assert.equal(diagnostics[0].networkCode, 'ECONNRESET');
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_TRANSPORT_DETAILS/);
});

test('an incomplete upstream stream records unknown usage, never an estimated charge or actual zero', async t => {
  const f = await fixture(t, async () => stream([{ type: 'response.created', response: { id: 'x' } }]));
  const response = await f.request(); await response.text();
  assert.equal(f.store.usage.length, 1);
  assert.equal(f.store.usage[0].status, 'unknown');
  assert.equal(f.store.usage[0].inputTokens, null);
  assert.equal(f.store.usage[0].outputTokens, null);
  assert.equal(f.store.usage[0].totalTokens, null);
});

test('streamed provider errors are sanitized before reaching the runner', async t => {
  const f = await fixture(t, async () => stream([{ type: 'error', code: 'invalid_api_key', message: 'SECRET_PROVIDER_BODY sk-test-user-u-0001' }]));
  const body = await (await f.request()).text();
  assert.ok(body.includes('workspace_upstream_error'));
  assert.ok(!body.includes('SECRET_PROVIDER_BODY')); assert.ok(!body.includes('sk-test-user-u-0001'));
  assert.equal(f.store.usage[0].status, 'unknown');
});

test('a rejected concurrent request cannot release another request slot', async t => {
  let unlock, signal;
  const held = new Promise(resolve => { unlock = resolve; });
  const entered = new Promise(resolve => { signal = resolve; });
  let inferenceCalls = 0;
  const f = await fixture(t, async () => {
    inferenceCalls++; signal(); await held;
    return stream([completed()]);
  });
  const first = f.request(); await entered;
  assert.equal((await f.request()).status, 429);
  assert.equal((await f.request()).status, 429);
  unlock(); await (await first).text();
  assert.equal(inferenceCalls, 1);
});

test('invalid capability and browser Origin cannot access provider', async t => {
  const f = await fixture(t, async () => { throw new Error('must not call provider'); });
  assert.equal((await f.request({}, { authorization: 'Bearer bad' })).status, 401);
  assert.equal((await f.request({}, { origin: 'https://malicious.example' })).status, 403);
});

test('revoking a run waits for aborted upstream usage to be marked unknown', async t => {
  let inferenceEntered;
  const entered = new Promise(resolve => { inferenceEntered = resolve; });
  const f = await fixture(t, async (url, options) => {
    inferenceEntered();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  const responsePromise = f.request(); await entered;
  await f.gateway.revokeRun('run');
  assert.equal(f.store.usage.length, 1);
  assert.equal(f.store.usage[0].status, 'unknown');
  assert.equal(f.store.usage[0].totalTokens, null);
  await (await responsePromise).text();
  assert.equal((await f.request()).status, 401);
});

test('provider session references and paid hosted tools cannot bypass isolation', () => {
  assert.throws(() => prepareResponseRequest({ input: 'Hi', previous_response_id: 'other-user-response' }, config));
  assert.throws(() => prepareResponseRequest({ input: 'Hi', tools: [{ type: 'web_search' }] }, config));
  assert.throws(() => prepareResponseRequest({ input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'other-user-file' }] }] }, config));
  assert.throws(() => prepareResponseRequest({ input: [{ type: 'item_reference', id: 'other-user-item' }] }, config));
  assert.throws(() => prepareResponseRequest({ input: [{ type: 'additional_tools', role: 'system', tools: [{ type: 'web_search' }] }] }, config));
  assert.throws(() => prepareResponseRequest({ input: [{ type: 'additional_tools', role: 'system', tools: [{ type: 'namespace', name: 'bad', tools: [{ type: 'file_search' }] }] }] }, config));
});

test('chat tools are loopback-only and the gateway owns the lifecycle of analysis files', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push([url, options.method]);
    assert.equal(options.headers.authorization, 'Bearer sk-test-user-u-0001');
    if (url.endsWith('/files')) {
      assert.equal(options.body.get('purpose'), 'user_data');
      assert.equal(options.body.get('expires_after[seconds]'), '3600');
      assert.equal(options.body.get('file').name, 'report.csv');
      assert.equal(await options.body.get('file').text(), 'x\n1\n');
      return Response.json({ id: 'file-KivoTest' });
    }
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.tools, [{ type: 'code_interpreter', container: { type: 'auto', file_ids: ['file-KivoTest'] } }]);
    assert.match(payload.safety_identifier, /^[a-f0-9]{64}$/);
    return stream([completed()]);
  }, { chatTools: ['code_interpreter'], chatFiles: [{ name: 'report.csv', mimeType: 'text/csv', data: Buffer.from('x\n1\n') }] });
  let status;
  await f.gateway.handleExternal({ headers: { authorization: `Bearer ${f.token}` }, method: 'POST', socket: { remoteAddress: '127.0.0.1' } }, {
    writeHead(value) { status = value; }, end() {},
  });
  assert.equal(status, 403);
  assert.deepEqual(calls, []);
  const response = await f.request({ input: 'Analyze report.csv', tools: [{ type: 'code_interpreter', container: { type: 'auto', file_ids: ['file-Forged'] } }] });
  assert.equal(response.status, 200);
  await response.text();
  await f.gateway.revokeRun('run');
  assert.deepEqual(calls, [
    ['https://api.openai.com/v1/files', 'POST'],
    ['https://api.openai.com/v1/responses', 'POST'],
    ['https://api.openai.com/v1/files/file-KivoTest', 'DELETE'],
  ]);
  assert.equal(f.store.usage[0].totalTokens, 120);
});

test('chat accepts inline multimodal inputs but cannot select remote files or undeclared tools', () => {
  const allowed = new Set(['image_generation']);
  const input = [{ role: 'user', content: [
    { type: 'input_text', text: 'What does this image contain?' },
    { type: 'input_image', image_url: 'data:image/png;base64,dGVzdA==' },
  ] }];
  const request = prepareResponseRequest({ input, tools: [{ type: 'image_generation' }] }, config, allowed);
  assert.equal(request.input[0].content[1].image_url, input[0].content[1].image_url);
  assert.throws(() => prepareResponseRequest({ input, tools: [{ type: 'web_search' }] }, config, allowed), /未授权/);
  for (const part of [{ type: 'input_image', image_url: 'https://example.invalid/image' }, { type: 'input_file', file_id: 'file-OtherUser' }]) {
    assert.throws(() => prepareResponseRequest({ input: [{ role: 'user', content: [part] }] }, config, allowed), /内联/);
  }
});

test('image tool actions survive the gateway and edits require an inline source image', () => {
  const allowed = new Set(['image_generation']);
  const input = [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,dGVzdA==' }] }];
  for (const action of ['auto', 'generate', 'edit']) {
    const payload = prepareResponseRequest({ input, tools: [{ type: 'image_generation', action }] }, config, allowed);
    assert.deepEqual(payload.tools, [{ type: 'image_generation', action }]);
  }
  assert.throws(() => prepareResponseRequest({ input, tools: [{ type: 'image_generation', action: 'arbitrary' }] }, config, allowed), /操作无效/);
  assert.throws(() => prepareResponseRequest({ input: 'edit it', tools: [{ type: 'image_generation', action: 'edit' }] }, config, allowed), /需要提供原图/);
});

test('Codex input-carried tools and reasoning updates retain the local-only tool boundary', () => {
  const body = { input: [
    { type: 'additional_tools', role: 'system', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'exec_command', parameters: {} }] }] },
    { type: 'configuration_update', reasoning: { effort: 'medium' } },
    { type: 'function_call_output', call_id: 'own-call', output: [{ type: 'input_text', text: 'ok' }] },
  ] };
  assert.deepEqual(prepareResponseRequest(body, config).input, body.input);
  const diagnosticBody = { type: 'unsupported_item', secret: 'DO_NOT_LOG_BODY' };
  assert.throws(() => prepareResponseRequest({ input: [diagnosticBody] }, config), error => error.message.includes('type=unsupported_item') && error.message.includes('fields=type,secret') && !error.message.includes('DO_NOT_LOG_BODY'));
});

test('SSE parser handles fragmented unicode and CRLF; usage consistency is checked', () => {
  const events = [];
  const parser = makeSseParser(event => events.push(event));
  const bytes = Buffer.from(`data: ${JSON.stringify({ text: '中文' })}\r\n\r\n`);
  for (const byte of bytes) parser.feed(Buffer.from([byte]));
  assert.deepEqual(events, [{ text: '中文' }]);
  assert.equal(parseUsage({ input_tokens: 2, output_tokens: 3, total_tokens: 4 }), null);
  assert.deepEqual(parseUsage({ input_tokens: 2, output_tokens: 3, total_tokens: 5 }), { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
});
