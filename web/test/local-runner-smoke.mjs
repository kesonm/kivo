/** Server-only, real pinned Codex + local assistant + HTTP + in-memory DB.
 * The OpenAI provider is mocked. Run inside a disposable container with no
 * production data, tokens, Docker socket or external network. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.mjs';
import { createApp, hashPassword } from '../server/app.mjs';
import { createLocalBridge } from '../server/local.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { startAssistant } from '../public/local-assistant/kivo-local.mjs';

const fixture = await mkdtemp(path.join(os.tmpdir(), 'kivo-local-real-'));
const root = path.join(fixture, 'projects'); await mkdir(root);
const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
const password = 'Fake-smoke-password-12345', fakeKey = 'sk-fake-local-provider-never-leaves-container';
const user = store.createUser({ username: 'local_smoke', displayName: 'Smoke', passwordHash: await hashPassword(password) });
store.setUserApiKey(user.id, fakeKey);
const local = createLocalBridge({ store });
let calls = 0;
const mock = async (url, request) => {
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(request.headers.authorization, 'Bearer ' + fakeKey);
  const body = JSON.parse(request.body), n = ++calls;
  if (process.env.KIVO_SMOKE_DEBUG) for (const item of Array.isArray(body.input) ? body.input : []) if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) console.error('MOCK_ONLY tool result', String(typeof item.output === 'string' ? item.output : JSON.stringify(item.output)).slice(0, 4000));
  const events = [{ type: 'response.created', response: { id: 'fake-' + n } }];
  if ([1, 2, 4].includes(n)) {
    const declarations = [...(body.tools || []), ...(Array.isArray(body.input) ? body.input.filter(i => i.type === 'additional_tools').flatMap(i => i.tools || []) : [])];
    const flat = declarations.flatMap(tool => tool.type === 'namespace' ? tool.tools.map(child => ({ ...child, namespace: tool.name })) : [tool]);
    const tool = flat.find(t => t.name === 'exec_command') || flat.find(t => t.name === 'shell_command') || flat.find(t => t.name === 'shell') || flat.find(t => t.name === 'exec' && t.type === 'custom');
    assert.ok(tool, 'Codex must advertise a local command tool: ' + JSON.stringify(flat.map(t => ({ name: t.name, type: t.type }))));
    const command = n === 1 ? "printf 'LOCAL_FILE_WRITE_OK' > local-smoke.txt" : n === 2 ? "printf 'APPROVED_LOCAL_COMMAND' > approved.txt" : "printf 'MUST_NOT_EXIST' > declined.txt";
    const args = tool.name === 'shell' ? { command: ['/bin/sh', '-c', command], timeout_ms: 10000 } : tool.name === 'shell_command' ? { command, timeout_ms: 10000 } : { cmd: command, yield_time_ms: 1000 };
    if (n !== 1) Object.assign(args, { sandbox_permissions: 'require_escalated', justification: 'One-time approval test in an isolated, disposable mock project.' });
    const item = tool.type === 'custom' ? { type: 'custom_tool_call', call_id: 'test-command-' + n, name: tool.name, input: `const result = await tools.exec_command(${JSON.stringify(args)}); text(result);` } : { type: 'function_call', call_id: 'test-command-' + n, name: tool.name, arguments: JSON.stringify(args) };
    if (tool.namespace) item.namespace = tool.namespace;
    events.push({ type: 'response.output_item.done', item });
  } else events.push({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'answer-' + n, content: [{ type: 'output_text', text: 'MOCK_LOCAL_TASK_DONE' }] } });
  events.push({ type: 'response.completed', response: { id: 'fake-' + n, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
};
const config = { dataDir: fixture, distDir: '/no-static-files', cookieSecure: false, model: 'gpt-6.1-sol', publicOrigin: 'https://local-test.example', runTimeoutMs: 120_000, maxOutputTokens: 1024 };
const runtime = createRuntime({ store, config, local, fetchImpl: async (...args) => { try { return await mock(...args); } catch (e) { console.error('MOCK_ONLY provider failure:', e.message); throw e; } }, spawnImpl() { throw new Error('Cloud Docker path must not execute'); } });
const app = createApp({ store, config, local, runtime, projects: { withLock: (_id, fn) => fn() } });
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
let cookie = '', csrf = '', assistant;
async function browser(method, endpoint, body) {
  const response = await fetch(origin + endpoint, { method, headers: { Cookie: cookie, Origin: config.publicOrigin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const data = await response.json(); if (data.csrfToken) csrf = data.csrfToken;
  assert.ok(response.ok, endpoint + ' ' + response.status + ' ' + JSON.stringify(data)); return data;
}
async function agent(endpoint, body) {
  const response = await fetch(origin + '/api/local-agent/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.ok(response.ok); return response.json();
}
try {
  await browser('GET', '/api/session'); await browser('POST', '/api/auth/login', { username: user.username, password });
  const pairing = await agent('pair', { name: 'Isolated test computer', platform: 'linux', rootName: 'projects' });
  const { device } = await browser('POST', '/api/local-devices/pair', { code: pairing.code });
  const claim = await agent('claim', { token: pairing.token });
  assistant = await startAssistant({ root, stateDir: path.join(fixture, 'state'), origin, token: claim.token, deviceId: claim.deviceId, codex: process.env.KIVO_SMOKE_CODEX || '/usr/local/lib/node_modules/@openai/codex/bin/codex.js' });
  await new Promise(resolve => setTimeout(resolve, 100));
  const { project } = await browser('POST', '/api/local-projects', { deviceId: device.id, path: '', name: 'new-project', create: true });
  const disk = path.join(root, 'new-project');
  assert.ok(await stat(path.join(disk, 'README.md')));
  await browser('PUT', `/api/projects/${project.id}/file`, { path: 'manual.txt', content: 'local editor works' });
  assert.equal(await readFile(path.join(disk, 'manual.txt'), 'utf8'), 'local editor works');
  const { thread } = await browser('POST', `/api/projects/${project.id}/threads`, { title: 'Mock local coding' });
  for (const decision of ['accept', 'decline']) {
    const { run } = await browser('POST', `/api/threads/${thread.id}/turns`, { text: 'Run the mock local task with an approval.' });
    let handled = false;
    const deadline = Date.now() + 120_000;
    while (store.getRun(run.id).status === 'running' && Date.now() < deadline) {
      const { approvals } = await browser('GET', `/api/runs/${run.id}/approvals`);
      if (approvals.length) { await browser('POST', `/api/runs/${run.id}/approvals/${approvals[0].id}`, { decision }); handled = true; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const result = store.getRun(run.id);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(handled, true, 'Real Codex approval must reach browser and be answered');
    assert.match(result.output, /MOCK_LOCAL_TASK_DONE/);
  }
  if (!(await stat(path.join(disk, 'local-smoke.txt')).catch(() => null))) console.error('MOCK_ONLY command diagnostics', store.db.prepare('SELECT logs FROM runs').all());
  assert.equal(await readFile(path.join(disk, 'local-smoke.txt'), 'utf8'), 'LOCAL_FILE_WRITE_OK');
  assert.equal(await readFile(path.join(disk, 'approved.txt'), 'utf8'), 'APPROVED_LOCAL_COMMAND');
  await assert.rejects(readFile(path.join(disk, 'declined.txt')), { code: 'ENOENT' });
  const diff = await browser('GET', `/api/projects/${project.id}/diff`); assert.match(diff.diff, /LOCAL_FILE_WRITE_OK/);
  await browser('POST', `/api/projects/${project.id}/commit`, { message: 'Local checkpoint' });
  assert.deepEqual((await browser('GET', `/api/projects/${project.id}/diff`)).files, []);
  assert.equal(store.getUsage({ userId: user.id }).totals.totalTokens, 600);
  await browser('DELETE', `/api/projects/${project.id}`, {});
  assert.equal(await readFile(path.join(disk, 'local-smoke.txt'), 'utf8'), 'LOCAL_FILE_WRITE_OK');
  await browser('DELETE', '/api/local-devices/' + device.id, {});
  console.log('PASS real Codex local assistant: HTTP pairing, local create/write/diff/checkpoint, sandbox command, accept/decline approval, resume, model usage, unlink preserves local files, device revoke; MOCK provider only.');
} finally {
  await assistant?.stop(); await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); await rm(fixture, { recursive: true, force: true });
}
