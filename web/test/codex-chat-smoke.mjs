/** Isolated Ubuntu smoke with real Codex, a deterministic provider and no Docker socket.
 * Run inside a network-isolated container with the packaged Codex CLI and an empty /workspace.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createApp, loadConfig } from '../server/app.mjs';
import { createGateway } from '../server/gateway.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createStore } from '../server/store.mjs';

const codex = process.env.CODEX_CHAT_BINARY;
assert.ok(path.isAbsolute(codex ?? ''), 'Set CODEX_CHAT_BINARY to the packaged Codex executable');
const dataDir = await mkdtemp('/tmp/kivo-native-chat-smoke-');
const config = loadConfig({ DATA_DIR: dataDir, GATEWAY_HOST: '127.0.0.1', RUNNER_UID: String(process.getuid()), RUNNER_GID: String(process.getgid()),
  WORK_ROUTING_MODE: 'enforce',
  AUTO_THREAD_TITLES: 'false', COOKIE_SECURE: 'false', PUBLIC_ORIGIN: 'https://codex-chat-smoke.test',
  RUN_TIMEOUT_MS: '45000', MAX_OUTPUT_TOKENS: '512' });
assert.equal(config.chatEngine, 'codex');
const processes = new Map();
const compactThreads = new Set();
const processHome = path.join(dataDir, 'home');
await mkdir(processHome, { mode: 0o700 });
function startRunner(command, args, options) {
  assert.equal(command, 'docker');
  assert.ok(args.includes('--read-only') && args.includes('no-new-privileges:true') && args.includes('ALL'));
  assert.ok(args.includes('sandbox_mode="read-only"') && args.includes('features.shell_tool=false'));
  const name = args[args.indexOf('--name') + 1];
  const mounts = args.filter((_, i) => args[i - 1] === '--mount');
  assert.equal(mounts.length, 1);
  const home = /^type=bind,source=(.+),target=\/codex-home$/.exec(mounts[0])?.[1];
  assert.ok(home?.startsWith(path.join(dataDir, 'chat-homes') + '/'));
  const codexArgs = args.slice(args.indexOf('codex') + 1).map(arg =>
    arg.replace(`http://gateway:${config.gatewayPort}/v1`, `http://127.0.0.1:${config.gatewayPort}/v1`));
  if (compactThreads.has(path.basename(home))) codexArgs.unshift('-c', 'model_auto_compact_token_limit=1500');
  const child = spawn(codex, codexArgs, { stdio: options.stdio, cwd: '/workspace',
    env: { PATH: process.env.PATH, HOME: processHome, CODEX_HOME: home, CODEX_GATEWAY_TOKEN: options.env.CODEX_GATEWAY_TOKEN } });
  processes.set(name, child);
  child.on('exit', () => processes.delete(name));
  return child;
}
async function runnerCommand(command, args) {
  assert.equal(command, 'docker');
  if (args[0] === 'network') {
    if (args[1] === 'create') assert.ok(args.includes('--internal'));
    return { stdout: '' };
  }
  assert.deepEqual(args.slice(0, 2), ['rm', '-f']);
  const child = processes.get(args[2]);
  if (child && child.exitCode == null && child.signalCode == null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  return { stdout: '' };
}
const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
const fakeKey = 'sk-MOCK-CODEX-CHAT-PROTOCOL-ONLY-0100';
const modelCalls = [];
const checks = [];
const testImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZpQAAAAASUVORK5CYII=';
const readText = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text).join('');
const toolResult = (input, call) => {
  const result = input.find(item => item.type === 'function_call_output' && item.call_id === call);
  return result ? JSON.parse(readText(result.output)) : null;
};

async function mockProvider(url, request) {
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(request.headers.authorization, 'Bearer ' + fakeKey);
  const body = JSON.parse(request.body);
  assert.equal(body.store, false);
  const input = body.input;
  const latest = readText(input.findLast(item => item.role === 'user')?.content);
  const native = input.some(item => item.role === 'developer') || body.tools?.some(tool => tool.name?.startsWith('kivo_'));
  const requestId = 'mock-' + modelCalls.length;
  modelCalls.push({ body, latest });
  let output;
  const reply = (text, annotations = []) => [{ type: 'message', id: requestId + '-msg', role: 'assistant', content: [{ type: 'output_text', text, annotations }] }];
  const tool = (name, call, args) => [{ type: 'function_call', id: call + '-item', name, call_id: call, arguments: JSON.stringify(args) }];
  if (native) {
    const specs = [...(body.tools ?? []), ...input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools)];
    assert.ok(specs.every(spec => spec.type === 'function' && spec.name.startsWith('kivo_')));
  }
  if (/CONTEXT CHECKPOINT COMPACTION|handoff summary/i.test(latest)) {
    output = reply('Internal compacted summary for the next sampling request.');
  } else if (body.tool_choice?.type === 'web_search') {
    const citation = { type: 'url_citation', url: 'https://example.com/source', title: 'Synthetic source', start_index: 0, end_index: 6 };
    output = [{ type: 'web_search_call', id: requestId + '-search', status: 'completed' }, ...reply('Search verified', [citation])];
  } else if (body.tool_choice?.type === 'image_generation') {
    output = [{ type: 'image_generation_call', id: requestId + '-image', status: 'completed', result: testImage }];
  } else if (latest === 'NATIVE SEARCH') {
    const result = toolResult(input, 'qa-search');
    if (result) assert.match(result.result, /Search verified/);
    output = result ? reply('Native search reply') : tool('kivo_web_search', 'qa-search', { query: 'Test hosted lookup' });
  } else if (latest === 'NATIVE IMAGE') {
    const result = toolResult(input, 'qa-image');
    if (result) assert.equal(result.generated, 1);
    output = result ? reply('Native image reply') : tool('kivo_generate_image', 'qa-image', { prompt: 'Test hosted image' });
  } else if (latest === 'Remember I prefer blue and delegate a test task.') {
    const note = toolResult(input, 'qa-memory');
    const task = toolResult(input, 'qa-delegate');
    if (!note) output = tool('kivo_remember', 'qa-memory', { kind: 'preference', text: 'Prefer blue', source_message_id: null, replaces_id: null });
    else if (!task) {
      assert.equal(note.note.text, 'Prefer blue');
      output = tool('kivo_delegate_task', 'qa-delegate', { goal: 'Background test', projectId: null, constraints: [], acceptance: [] });
    } else {
      assert.equal(task.task.queueStatus, 'queued');
      output = reply('Saved a note and queued a separate task.');
    }
  } else if (latest === 'DISALLOWED TOOL') {
    output = tool('exec_command', 'qa-unauthorized', {});
  } else if (latest === 'INTERRUPT THIS TURN') {
    return new Promise((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
  } else output = reply('Mock reply for ' + latest);
  const inputTokens = latest === 'COMPACTION BEFORE NEXT TURN' ? 3000 : 100;
  const response = { id: requestId, status: 'completed', output, usage: { input_tokens: inputTokens, output_tokens: 20, total_tokens: inputTokens + 20,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const events = [{ type: 'response.created', response: { id: requestId } },
    ...output.map((item, output_index) => ({ type: 'response.output_item.done', item, output_index })),
    { type: 'response.completed', response }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

const runtime = createRuntime({ store, config, spawnImpl: startRunner, execFileImpl: runnerCommand, fetchImpl: mockProvider });
const app = createApp({ store, runtime, config });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
let cookie = '', csrf = '';
const base = `http://127.0.0.1:${server.address().port}`;
async function request(method, route, body, expected = 200) {
  const response = await fetch(base + route, { method, headers: { cookie, origin: config.publicOrigin,
    'content-type': 'application/json', 'x-csrf-token': csrf }, body: body === undefined ? undefined : JSON.stringify(body),
  signal: AbortSignal.timeout(10000) });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const data = await response.json();
  if (data.csrfToken) csrf = data.csrfToken;
  assert.equal(response.status, expected, JSON.stringify(data));
  return data;
}
async function until(predicate) {
  const deadline = Date.now() + 50000;
  while (!predicate() && Date.now() < deadline) await wait(50);
  assert.ok(predicate(), 'expected asynchronous state');
}
let user;
async function send(thread, text, extras = {}) {
  const { run } = await request('POST', `/api/threads/${thread.id}/turns`, { text, tool: 'auto', requestId: randomUUID(),
    work: { intent: 'question', focusRevision: store.work.getFocus(user.id, thread.id).revision }, ...extras }, 202);
  return run.id;
}
async function finished(runId, status = 'completed') {
  await until(() => store.getRun(runId).status !== 'running');
  const run = store.getRun(runId);
  assert.equal(run.status, status, JSON.stringify({ status: run.status, error: run.error, logs: run.logs }));
  const context = await request('GET', `/api/runs/${runId}/context`);
  return { run, context };
}

try {
  await request('GET', '/api/session');
  ({ user } = await request('POST', '/api/auth/register', { username: 'native-chat', displayName: 'Native Chat', password: 'Smoke-test-fixture-2026' }, 201));
  await request('PUT', '/api/account/api-key', { apiKey: fakeKey });
  const { thread } = await request('POST', '/api/threads', { title: 'Existing conversation' }, 201);
  store.appendMessage(thread.id, 'user', 'ORIGINAL USER MESSAGE');
  const prior = store.appendMessage(thread.id, 'assistant', 'ORIGINAL ASSISTANT MESSAGE');
  const first = await finished(await send(thread, 'FIRST NATIVE TURN', { reasoningEffort: 'high' }));
  assert.equal(first.context.execution.engine, 'codex');
  assert.ok(first.context.sources.some(source => source.id === prior.id));
  assert.equal(modelCalls.at(-1).body.reasoning.effort, 'high');
  assert.match(JSON.stringify(modelCalls.at(-1).body.input), /ORIGINAL ASSISTANT MESSAGE/);
  const second = await finished(await send(thread, 'SECOND NATIVE TURN', { model: 'gpt-6-luna', reasoningEffort: 'none' }));
  assert.equal(second.context.execution.threadId, first.context.execution.threadId);
  assert.equal(second.context.execution.lifecycle, 'continue');
  assert.equal(modelCalls.at(-1).body.model, 'gpt-6-luna');
  assert.equal(modelCalls.at(-1).body.reasoning.effort, 'none');
  assert.equal(modelCalls.at(-1).body.input.filter(item => readText(item.content) === 'Mock reply for FIRST NATIVE TURN').length, 1);
  checks.push('historical import, native resume, model effort, no duplicate answers');

  const compatibility = await finished(await send(thread, 'EXPLICIT SEARCH', { tool: 'search' }));
  assert.equal(compatibility.context.execution.lifecycle, 'request');
  const search = await finished(await send(thread, 'NATIVE SEARCH'));
  assert.equal(search.context.execution.threadId, first.context.execution.threadId);
  assert.match(JSON.stringify(modelCalls.find(call => call.latest === 'NATIVE SEARCH').body.input), /Search verified/);
  const image = await finished(await send(thread, 'NATIVE IMAGE'));
  const visible = (await request('GET', `/api/threads/${thread.id}`)).messages;
  assert.ok(visible.find(message => message.content.startsWith('Native search reply')).citations.some(citation => citation.url === 'https://example.com/source'));
  assert.ok(visible.find(message => message.content.startsWith('Native image reply')).artifacts.some(artifact => artifact.mimeType === 'image/png'));
  assert.equal(image.context.execution.engine, 'codex');
  checks.push('explicit tool compatibility, native search citations and image artifacts');

  const { thread: kibot } = await request('POST', '/api/kibot', {});
  const primary = await finished(await send(kibot, 'Remember I prefer blue and delegate a test task.'));
  assert.equal(primary.context.execution.engine, 'codex');
  const [note] = app.locals.primaryMemory.snapshot(user.id).notes;
  assert.equal(note.text, 'Prefer blue');
  const [task] = app.locals.supervisor.snapshot(user.id).tasks;
  assert.equal(task.queueStatus, 'queued');
  assert.notEqual(task.conversationId, kibot.id);
  await app.locals.supervisor.pump();
  await until(() => {
    const runId = app.locals.supervisor.snapshot(user.id).tasks[0].latestRunId;
    return runId && store.getRun(runId).status === 'completed';
  });
  await app.locals.supervisor.pump();
  assert.equal(store.getMessages(kibot.id).filter(message => message.supervisorTaskId === task.id).length, 1);
  const recalled = await finished(await send(kibot, 'RECALL MEMORY'));
  assert.match(JSON.stringify(modelCalls.at(-1).body.input), /Prefer blue/);
  await request('DELETE', `/api/kibot/memory/${note.id}`, {});
  const forgotten = await finished(await send(kibot, 'AFTER FORGET'));
  assert.notEqual(forgotten.context.execution.threadId, recalled.context.execution.threadId);
  const contextText = modelCalls.at(-1).body.input.map(item => readText(item.content))
    .findLast(value => value.startsWith('Kivo retrieved working context'));
  assert.deepEqual(JSON.parse(contextText.slice(contextText.indexOf('\n') + 1)).notes, []);
  checks.push('kibot note, recall, forgetting, separate delegation and completion message');

  await finished(await send(thread, 'DISALLOWED TOOL'), 'failed');
  const stop = await send(thread, 'INTERRUPT THIS TURN');
  await until(() => modelCalls.some(call => call.latest === 'INTERRUPT THIS TURN'));
  await runtime.interrupt(stop);
  await finished(stop, 'interrupted');
  const rebuilt = await finished(await send(thread, 'REBUILD AFTER INTERRUPTION'));
  assert.notEqual(rebuilt.context.execution.threadId, first.context.execution.threadId);
  assert.match(JSON.stringify(modelCalls.at(-1).body.input), /ORIGINAL USER MESSAGE/);
  assert.ok(store.getUsage({ userId: user.id }).totals.totalTokens > 0);
  checks.push('gateway rejects unregistered tools, interruption recovery, billed usage ledger');

  const { thread: longThread } = await request('POST', '/api/threads', { title: 'Compaction trial' }, 201);
  compactThreads.add(longThread.id);
  const beforeCompact = await finished(await send(longThread, 'COMPACTION BEFORE NEXT TURN'));
  const compacted = await finished(await send(longThread, 'CONTINUE AFTER COMPACTION'));
  assert.equal(compacted.context.execution.threadId, beforeCompact.context.execution.threadId);
  assert.ok(modelCalls.some(call => /CONTEXT CHECKPOINT COMPACTION|handoff summary/i.test(call.latest)),
    'Codex must request a summary after crossing the reduced test threshold');
  assert.equal(compacted.run.output, 'Mock reply for CONTINUE AFTER COMPACTION');
  assert.ok(store.getMessages(longThread.id).some(message => message.content === 'COMPACTION BEFORE NEXT TURN'));
  checks.push('native automatic compaction with unchanged website archive');
  console.log(JSON.stringify({ checks, modelRequests: modelCalls.length }));
} finally {
  await app.locals.supervisor.close();
  await runtime.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  store.close();
  await rm(dataDir, { recursive: true, force: true });
}
