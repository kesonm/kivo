/** Server-only protocol smoke. Real Docker + Codex app-server 0.167.0,
 * ephemeral SQLite/workspace and a deterministic in-process MOCK provider.
 * No real OpenAI request or personal credential is used.
 * Run in a disposable API container with DATA_DIR and docker.sock mounted.
 * Its initial network must be a dedicated --internal bridge, not --network
 * none: Docker must later attach it to each isolated task's internal network.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createStore } from '../server/store.mjs';
import { createProjects } from '../server/projects.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createGateway } from '../server/gateway.mjs';
import { createWorkService } from '../server/work.mjs';

const dataDir = process.env.DATA_DIR || '/data';
const hostDataDir = process.env.HOST_DATA_DIR;
if (!hostDataDir || !hostDataDir.startsWith('/tmp/kivo-work-runner-smoke-')) throw new Error('HOST_DATA_DIR must be an isolated /tmp/kivo-work-runner-smoke-* directory');
const config = { dataDir, hostDataDir, runnerImage: process.env.RUNNER_IMAGE || 'codex-workspace-runner:0.167.0',
  runnerUid: 1000, runnerGid: 1000, model: 'gpt-6.1-sol', gatewayHost: '0.0.0.0', gatewayPort: 3001,
  workRoutingMode: 'enforce', maxOutputTokens: 512, runTimeoutMs: 120_000 };
const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
const user = store.createUser({ username: 'work-smoke', displayName: 'Work smoke', passwordHash: 'unused' });
const fakeKey = 'sk-MOCK_WORK_GRAPH_PROTOCOL_ONLY_0001';
store.setUserApiKey(user.id, fakeKey);
const project = store.createProject(user.id, 'Ephemeral work graph protocol test');
const conversation = store.createThread(null, user.id, 'A unified conversation');
const projects = createProjects(config);
const service = createWorkService({ store, config, projects });
const object = service.graph.ensureProject(user.id, project.id);
const packetMarker = 'KIVO_WORK_GRAPH_MOCK_ONLY';
const forbiddenHistory = 'UNRELATED_CONVERSATION_MUST_NOT_ENTER_TASK';
store.appendMessage(conversation.id, 'user', forbiddenHistory);
let calls = 0, toolIssued = false, holdNext = false, heldObserved;
let observeHeld = () => {};
const frames = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const mockFetch = async (url, options) => {
  assert.equal(url, 'https://api.openai.com/v1/responses', 'the gateway must use only the intercepted endpoint');
  assert.equal(options.headers.authorization, 'Bearer ' + fakeKey);
  const body = JSON.parse(options.body);
  assert.equal(body.model, config.model);
  assert.ok(JSON.stringify(body.input).includes('kivo work package'));
  assert.ok(!JSON.stringify(body.input).includes(forbiddenHistory), 'unlinked conversation history must stay outside the task');
  calls++;
  if (holdNext) {
    holdNext = false; observeHeld();
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('Mock request cancelled', 'AbortError'));
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
    });
  }
  const events = [{ type: 'response.created', response: { id: `mock-work-${calls}` } }];
  if (!toolIssued) {
    const declarations = [...(body.tools || []), ...(Array.isArray(body.input) ? body.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools || []) : [])];
    const flat = declarations.flatMap(tool => tool.type === 'namespace' ? tool.tools.map(child => ({ ...child, namespace: tool.name })) : [tool]);
    const tool = flat.find(item => item.name === 'exec_command') || flat.find(item => item.name === 'shell_command') || flat.find(item => item.name === 'shell') || flat.find(item => item.type === 'custom' && item.name === 'exec');
    assert.ok(tool, 'real Codex must advertise its terminal tool');
    const command = `test -z "$OPENAI_API_KEY" && test -z "$CODEX_API_KEY" && printf '%s' '${packetMarker}' > /workspace/work-smoke.txt`;
    const args = tool.name === 'shell' ? { command: ['/bin/sh', '-c', command], timeout_ms: 10000 }
      : tool.name === 'shell_command' ? { command, timeout_ms: 10000 } : { cmd: command, yield_time_ms: 1000 };
    const item = tool.name === 'exec' && tool.type === 'custom'
      ? { type: 'custom_tool_call', call_id: 'mock-work-command', name: tool.name, input: `const result = await tools.exec_command(${JSON.stringify(args)}); text(result);` }
      : { type: 'function_call', call_id: 'mock-work-command', name: tool.name, arguments: JSON.stringify(args) };
    if (tool.namespace) item.namespace = tool.namespace;
    events.push({ type: 'response.output_item.done', item }); toolIssued = true;
  } else events.push({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `mock-work-message-${calls}`,
    content: [{ type: 'output_text', text: `MOCK WORK RESULT ${calls}` }] } });
  events.push({ type: 'response.completed', response: { id: `mock-work-${calls}`, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  return new Response(frames(events), { headers: { 'content-type': 'text/event-stream' } });
};
const runtime = createRuntime({ store, config, gatewayFactory: args => createGateway({ ...args, fetchImpl: mockFetch }) });
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function finished(runId, expected = 'completed') {
  const deadline = Date.now() + 125_000;
  // Binding settlement runs after the legacy run terminal row is committed.
  while (Date.now() < deadline) {
    const run = store.getRun(runId), binding = service.graph.getRunBinding(user.id, runId);
    if (run.status !== 'running' && binding.status !== 'running' && !runtime.activeRunIds?.().includes(runId)) {
      assert.equal(run.status, expected, JSON.stringify({ status: run.status, error: run.error }));
      return { run, binding };
    }
    await wait(100);
  }
  throw new Error('Smoke run timed out');
}
async function turn(thread, text, selection, { waitForFinish = true } = {}) {
  const work = { ...selection, focusRevision: service.graph.getFocus(user.id, thread.id).revision };
  const plan = await service.prepare({ userId: user.id, thread, text, work });
  assert.equal(plan.project.id, project.id);
  return projects.withLock(project.id, async () => {
    const run = store.createRun(thread.id, user.id, { mode: 'cloud', executionProjectId: project.id });
    const message = store.appendMessage(thread.id, 'user', text);
    store.updateRun(run.id, { requestMessageId: message.id });
    const context = await service.bind({ userId: user.id, thread, task: plan.task, project, run, text, message, decision: plan.decision, model: config.model });
    await runtime.start({ run, thread, project, user, text, workContext: context });
    if (!waitForFinish) return { run, context, taskId: plan.task.id };
    return { ...await finished(run.id), context, taskId: plan.task.id };
  });
}

try {
  await projects.initialize(project.id, project.name);
  const first = await turn(conversation, 'Create the isolated smoke artifact.', { intent: 'new', objectId: object.id });
  assert.equal(await readFile(path.join(dataDir, 'projects', project.id, 'work-smoke.txt'), 'utf8'), packetMarker);
  assert.ok(first.binding.engineThreadId); assert.equal(first.context.lifecycle.action, 'new');
  assert.equal(store.getThread(conversation.id).codexThreadId, null, 'UI conversation must not become the engine identity');
  assert.equal(service.graph.getTask(user.id, first.taskId).status, 'waiting_input', 'model completion is not independent acceptance');
  const second = await turn(conversation, 'Continue without changing any files.', { intent: 'continue', taskId: first.taskId });
  assert.equal(second.taskId, first.taskId); assert.equal(second.context.lifecycle.action, 'rebuild');
  assert.notEqual(second.binding.sessionId, first.binding.sessionId, 'changed workspace gets a clean application session');
  assert.notEqual(second.binding.engineThreadId, first.binding.engineThreadId);
  const nextConversation = store.createThread(null, user.id, 'A second conversation with the same task');
  service.graph.ensureConversation(user.id, nextConversation.id);
  const third = await turn(nextConversation, 'Continue the same verified task with no new file changes.', { intent: 'continue', taskId: first.taskId });
  assert.equal(third.taskId, first.taskId); assert.equal(third.context.lifecycle.action, 'continue');
  assert.equal(third.binding.sessionId, second.binding.sessionId); assert.equal(third.binding.engineThreadId, second.binding.engineThreadId);
  assert.equal(store.getThread(nextConversation.id).codexThreadId, null);
  assert.ok(service.graph.getTaskContext(user.id, first.taskId).messages.some(message => message.conversationId === nextConversation.id));
  const callsBeforeCancel = calls;
  holdNext = true; heldObserved = new Promise(resolve => { observeHeld = resolve; });
  const pending = await turn(nextConversation, 'Wait for a mock response that will be cancelled.', { intent: 'continue', taskId: first.taskId }, { waitForFinish: false });
  await Promise.race([heldObserved, wait(10_000).then(() => { throw new Error('Mock provider did not receive cancellation case'); })]);
  const beforeCancel = service.graph.getTask(user.id, first.taskId);
  service.graph.cancelTask(user.id, first.taskId, { expectedVersion: beforeCancel.version, reason: 'smoke cancellation' });
  await runtime.interrupt(pending.run.id);
  await finished(pending.run.id, 'interrupted');
  assert.equal(service.graph.getTask(user.id, first.taskId).status, 'cancelled');
  assert.equal(calls, callsBeforeCancel + 1);
  assert.equal(await readFile(path.join(dataDir, 'projects', project.id, 'work-smoke.txt'), 'utf8'), packetMarker);
  assert.equal(store.getUsage({ userId: user.id }).totals.totalTokens, 480);
  assert.equal(store.db.prepare('SELECT count(*) n FROM work_leases').get().n, 0);
  console.log(JSON.stringify({ result: 'PASS', provider: 'MOCK_ONLY', realApiCalled: false, codex: '0.167.0', modelCalls: calls,
    checks: ['real app-server work packet + terminal tool', 'unlinked history excluded', 'task identity survives clean rebuild',
      'workspace mutation triggers new execution session', 'unchanged environment resumes native thread across conversations',
      'UI conversation never stores managed engine ID', 'completion awaits user acceptance', 'cancel aborts provider and stops real container', 'leases released only after stop'] }));
} finally {
  await runtime.close(); store.close();
  await rm(path.join(dataDir, 'projects', project.id), { recursive: true, force: true });
  await rm(path.join(dataDir, 'homes', project.id), { recursive: true, force: true });
}
