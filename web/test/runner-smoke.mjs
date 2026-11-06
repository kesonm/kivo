/** Server-only integration smoke: real Docker + Codex app-server with a
 * deterministic MOCK OpenAI provider. Never sends a real API request.
 * Runtime attaches this API container to separate per-task internal networks.
 * Mount DATA_DIR and docker.sock and set HOST_DATA_DIR to the host data path.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, chown, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createStore } from '../server/store.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createGateway } from '../server/gateway.mjs';

const dataDir = process.env.DATA_DIR || '/data';
const hostDataDir = process.env.HOST_DATA_DIR;
if (!hostDataDir) throw new Error('HOST_DATA_DIR is required for bind mounts');
const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
const users = [
  store.createUser({ username: 'smoke-user-u', displayName: 'Smoke U', passwordHash: 'unused', role: 'admin' }),
  store.createUser({ username: 'smoke-user-v', displayName: 'Smoke V', passwordHash: 'unused' }),
  store.createUser({ username: 'smoke-no-key', displayName: 'No key', passwordHash: 'unused' }),
];
const fakeKeys = ['sk-SMOKE_PERSONAL_USER_U_0001', 'sk-SMOKE_PERSONAL_USER_V_0002'];
store.setUserApiKey(users[0].id, fakeKeys[0]);
store.setUserApiKey(users[1].id, fakeKeys[1]);
const contexts = users.map(user => {
  const project = store.createProject(user.id, 'Mock integration test');
  const thread = store.createThread(project.id, user.id, 'Mock tool execution');
  return { user, project, thread, projectPath: path.join(dataDir, 'projects', project.id) };
});
for (const context of contexts.slice(0, 2)) {
  await mkdir(context.projectPath, { recursive: true }); await chown(context.projectPath, 1000, 1000);
}
let modelCalls = 0, unknownMode = false;
const callsByKey = new Map(), toolIssued = new Set();
const fixtureText = 'MOCK_PROVIDER_TOOL_VERIFIED';
const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const mockFetchImpl = async (url, options) => {
  assert.equal(url, 'https://api.openai.com/v1/responses', 'no pre-count or alternate provider request is allowed');
  const auth = options.headers.authorization;
  const keyIndex = fakeKeys.findIndex(key => auth === `Bearer ${key}`);
  assert.ok(keyIndex >= 0, 'only a capability-bound personal fake key may reach mock provider');
  const body = JSON.parse(options.body);
  assert.equal(body.model, process.env.CODEX_MODEL || 'gpt-6.1-sol');
  modelCalls++;
  callsByKey.set(keyIndex, (callsByKey.get(keyIndex) || 0) + 1);
  const events = [{ type: 'response.created', response: { id: `mock-response-${modelCalls}` } }];
  if (unknownMode) return new Response(events.map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } });
  if (!toolIssued.has(keyIndex)) {
    const declarations = [...(body.tools || []), ...(Array.isArray(body.input) ? body.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools || []) : [])];
    const flat = declarations.flatMap(tool => tool.type === 'namespace' ? tool.tools.map(child => ({ ...child, namespace: tool.name })) : [tool]);
    const tool = flat.find(t => t.name === 'exec_command') || flat.find(t => t.name === 'shell_command') || flat.find(t => t.name === 'shell') || flat.find(t => t.type === 'custom' && t.name === 'exec');
    if (!tool) throw new Error(`No executable local tool advertised. Tool names: ${flat.map(t => t.name).join(', ')}`);
    const isolationCheck = keyIndex === 1 ? 'test ! -e /workspace/smoke.txt && ' : '';
    const filename = keyIndex === 0 ? 'smoke.txt' : 'second.txt';
    const cmd = `${isolationCheck}test -z "$OPENAI_API_KEY" && test -z "$CODEX_API_KEY" && printf '%s' '${fixtureText}' > /workspace/${filename}`;
    const args = tool.name === 'shell' ? { command: ['/bin/sh', '-c', cmd], timeout_ms: 10000 } : tool.name === 'shell_command' ? { command: cmd, timeout_ms: 10000 } : { cmd, yield_time_ms: 1000 };
    const item = tool.name === 'exec' && tool.type === 'custom'
      ? { type: 'custom_tool_call', call_id: `smoke-command-${keyIndex}`, name: tool.name, input: `const result = await tools.exec_command(${JSON.stringify(args)}); text(result);` }
      : { type: 'function_call', call_id: `smoke-command-${keyIndex}`, name: tool.name, arguments: JSON.stringify(args) };
    if (tool.namespace) item.namespace = tool.namespace;
    events.push({ type: 'response.output_item.done', item });
    toolIssued.add(keyIndex);
  } else {
    const text = keyIndex === 1 ? '模拟服务已验证第二用户独立工作区。' : callsByKey.get(keyIndex) === 2 ? '模拟服务已验证文件写入链路。' : '模拟服务已验证会话恢复。';
    events.push({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `mock-message-${modelCalls}`, content: [{ type: 'output_text', text }] } });
  }
  events.push({ type: 'response.completed', response: { id: `mock-response-${modelCalls}`, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  return new Response(events.map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } });
};
const mockFetch = async (url, options) => {
  try { return await mockFetchImpl(url, options); }
  catch (error) {
    // Mock-only diagnostics never print prompts, tool arguments or keys.
    let body = {}; try { body = JSON.parse(options.body); } catch {}
    const declarations = [...(body.tools || []), ...(Array.isArray(body.input) ? body.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools || []) : [])];
    const shape = tool => ({ type: tool?.type, name: tool?.name, ...(Array.isArray(tool?.tools) ? { tools: tool.tools.map(t => ({ type: t.type, name: t.name })) } : {}) });
    console.error(JSON.stringify({ event: 'MOCK_PROVIDER_DIAGNOSTIC', error: error.message, toolShapes: declarations.map(shape), inputTypes: Array.isArray(body.input) ? body.input.map(item => item.type) : typeof body.input }));
    throw error;
  }
};
const config = { dataDir, hostDataDir, dockerNetwork: process.env.DOCKER_NETWORK || 'codex-workspace-runners', runnerImage: process.env.RUNNER_IMAGE || 'codex-workspace-runner:0.167.0', model: process.env.CODEX_MODEL || 'gpt-6.1-sol', apiKey: 'GLOBAL_MUST_NEVER_BE_USED', gatewayHost: '0.0.0.0', gatewayPort: Number(process.env.GATEWAY_PORT || 3001), maxOutputTokens: 512, runTimeoutMs: 120_000 };
const runtime = createRuntime({ store, config, gatewayFactory: args => createGateway({ ...args, fetchImpl: mockFetch }) });
async function turn(context, text, expectedStatus = 'completed') {
  const { user, project, thread } = context;
  const run = store.createRun(thread.id, user.id);
  store.appendMessage(thread.id, 'user', text);
  await runtime.start({ run, thread: store.getThread(thread.id), project, user: store.getUser(user.id), text });
  const deadline = Date.now() + 125_000;
  while (store.getRun(run.id).status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  const result = store.getRun(run.id);
  assert.equal(result.status, expectedStatus, JSON.stringify(result));
  return result;
}
try {
  assert.equal(runtime.providerConfigured(users[0].id), true);
  assert.equal(runtime.providerConfigured(users[1].id), true);
  assert.equal(runtime.providerConfigured(users[2].id), false);
  const noKey = contexts[2], refused = store.createRun(noKey.thread.id, noKey.user.id);
  await assert.rejects(runtime.start({ run: refused, thread: noKey.thread, project: noKey.project, user: noKey.user, text: 'must refuse without personal key' }), /个人设置/);
  store.updateRun(refused.id, { status: 'failed', error: 'Expected smoke rejection: personal key absent' });
  assert.equal(modelCalls, 0);
  const first = await turn(contexts[0], 'Create smoke.txt containing the requested verification string.');
  assert.equal((await readFile(path.join(contexts[0].projectPath, 'smoke.txt'), 'utf8')).trim(), fixtureText);
  assert.match(first.output, /文件写入链路/);
  assert.ok(store.getThread(contexts[0].thread.id).codexThreadId);
  const second = await turn(contexts[0], 'Continue this conversation and confirm the previous file exists.');
  assert.match(second.output, /会话恢复/);
  const third = await turn(contexts[1], 'Verify this independent workspace does not have another user file, then write second.txt.');
  assert.match(third.output, /第二用户独立工作区/);
  assert.equal((await readFile(path.join(contexts[1].projectPath, 'second.txt'), 'utf8')).trim(), fixtureText);
  await assert.rejects(readFile(path.join(contexts[1].projectPath, 'smoke.txt'), 'utf8'), { code: 'ENOENT' });
  assert.equal(modelCalls, 5);
  assert.equal(store.getUsage({ userId: users[0].id }).totals.totalTokens, 360);
  assert.equal(store.getUsage({ userId: users[1].id }).totals.totalTokens, 240);
  assert.ok(store.getUsage({ userId: users[0].id }).usage.every(row => row.keyLast4 === '0001'));
  assert.ok(store.getUsage({ userId: users[1].id }).usage.every(row => row.keyLast4 === '0002'));
  unknownMode = true;
  await turn(contexts[0], 'Exercise an intentionally incomplete mock stream.', 'failed');
  const allUsage = store.getUsage({ userId: users[0].id });
  assert.equal(allUsage.totals.totalTokens, 360);
  const unknown = allUsage.usage.filter(row => row.status === 'unknown');
  assert.ok(unknown.length >= 1);
  assert.ok(unknown.every(row => row.totalTokens === null && row.inputTokens === null && row.outputTokens === null));
  console.log(JSON.stringify({ result: 'PASS', provider: 'MOCK_ONLY', realApiCalled: false, codex: '0.167.0', modelCalls, checks: ['real app-server initialize/thread/turn', 'personal keys selected per user', 'no-key run rejected without fallback', 'isolated shell writes project file', 'persisted thread resumes', 'second user workspace isolated', 'known mock usage recorded per key suffix', 'incomplete stream usage remains unknown'] }));
} finally {
  await runtime.close(); store.close();
  for (const context of contexts) {
    await rm(context.projectPath, { recursive: true, force: true });
    await rm(path.join(dataDir, 'homes', context.project.id), { recursive: true, force: true });
  }
}
