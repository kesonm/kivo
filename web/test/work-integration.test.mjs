import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { createStore, AppError } from '../server/store.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createGateway } from '../server/gateway.mjs';

const testKey = 'sk-project-work-integration-aaaaaaaaaaaaaaaaAAAA';
const frame = event => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), label);
}

async function fixture(t, { mode = 'enforce', mockedRuntime = false, localFailure = false, maxConcurrentRuns = 2 } = {}) {
  const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
  const config = { dataDir: '/nonexistent-work-integration-test', distDir: '/nonexistent', publicOrigin: 'https://work.example',
    cookieSecure: false, model: 'test-model', gatewayHost: '127.0.0.1', gatewayPort: 0, maxConcurrentRuns,
    maxOutputTokens: 512, runTimeoutMs: 10000, workRoutingMode: mode, workContextBytes: 393216, workModelBudgets: {} };
  const calls = [], starts = [], locks = [], projectCalls = [], localCalls = [];
  const forbiddenProjectOperation = () => { projectCalls.push('unexpected'); throw new Error('chat work cannot access a project filesystem'); };
  const projects = mockedRuntime || localFailure ? {
    withLock: async (id, fn) => { locks.push(id); return fn(); },
    executionEnvironment: async id => ({ workspace: `cloud:/srv/projects/${id}:dev=1:ino=${id}`,
      branch: 'refs/heads/main', baseRevision: 'a'.repeat(40), dirtyFingerprint: 'b'.repeat(64), dirtyPaths: ['user-changes.txt'] }),
  } : Object.fromEntries(['initialize', 'remove', 'withLock', 'tree', 'readFile', 'executionEnvironment'].map(key => [key, forbiddenProjectOperation]));
  const local = localFailure ? {
    setHandlers() {},
    owned(userId, deviceId) {
      const device = store.db.prepare('SELECT * FROM local_devices WHERE id=? AND user_id=? AND revoked=0').get(deviceId, userId);
      if (!device) throw new AppError('Local fixture device is unavailable', 404);
      return device;
    },
    async projectCall(project, method) {
      localCalls.push({ method, projectId: project.id, deviceId: project.deviceId });
      throw new AppError('Local start acknowledgement was lost', 504, 'local_start_timeout');
    },
    async call(userId, deviceId, method, params) {
      localCalls.push({ method, userId, deviceId, runId: params.runId });
      throw new AppError('Local stop acknowledgement was lost', 504, 'local_stop_timeout');
    },
    close() {},
  } : null;
  const runtime = mockedRuntime ? {
    providerConfigured: userId => store.getApiKeyMetadata(userId).configured,
    start: async value => { starts.push(value); },
    interrupt: async runId => { store.updateRun(runId, { status: 'interrupted' }); },
    subscribe: () => () => {}, close: async () => {},
  } : createRuntime({ store, config, local, spawnImpl: forbiddenProjectOperation, execFileImpl: forbiddenProjectOperation,
    gatewayFactory: options => createGateway({ ...options, report: () => {}, fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const call = { url, payload: JSON.parse(request.body), authorization: request.headers.authorization, aborted: false };
      calls.push(call);
      return new Response(new ReadableStream({ start(controller) {
        call.controller = controller;
        request.signal.addEventListener('abort', () => {
          call.aborted = true;
          try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {}
        }, { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
    } }),
  });
  let server = createApp({ store, runtime, config, projects, local }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  let base = `http://127.0.0.1:${server.address().port}`;
  async function switchMode(nextMode) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    config.workRoutingMode = nextMode;
    server = createApp({ store, runtime, config, projects, local }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function client(username, { key = true } = {}) {
    let cookie = '', csrf = '';
    async function request(method, endpoint, body, stream = false) {
      const response = await fetch(base + endpoint, { method,
        headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, origin: config.publicOrigin },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      if (stream) return response;
      const data = await response.json();
      if (data.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data };
    }
    await request('GET', '/api/session');
    const registered = await request('POST', '/api/auth/register', { username, displayName: username, password: 'Work-integration-password-2026' });
    assert.equal(registered.status, 201, JSON.stringify(registered.data));
    if (key) assert.equal((await request('PUT', '/api/account/api-key', { apiKey: testKey })).status, 200);
    return { request, user: registered.data.user };
  }
  async function conversation(c) {
    const created = await c.request('POST', '/api/threads', {});
    assert.equal(created.status, 201);
    return created.data.thread;
  }
  async function begin(c, thread, body) {
    const index = calls.length;
    const requestBody = { requestId: randomUUID(), ...body };
    const accepted = await c.request('POST', `/api/threads/${thread.id}/turns`, requestBody);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.data));
    if (!mockedRuntime) await until(() => calls[index]?.controller, 'provider request arrived');
    return { run: accepted.data.run, call: calls[index], requestBody };
  }
  async function complete(c, pending, answer) {
    const stream = await c.request('GET', `/api/runs/${pending.run.id}/events`, undefined, true);
    assert.equal(stream.status, 200);
    pending.call.controller.enqueue(frame({ type: 'response.output_text.delta', item_id: 'answer', delta: answer }));
    pending.call.controller.enqueue(frame({ type: 'response.completed', response: { status: 'completed',
      output: [{ id: 'answer', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } }));
    pending.call.controller.close();
    const events = await stream.text();
    assert.match(events, /event: done/);
    assert.match(events, /"status":"completed"/);
    assert.equal(store.getRun(pending.run.id).status, 'completed');
  }
  return { store, runtime, config, calls, starts, locks, projectCalls, localCalls, client, conversation, begin, complete, switchMode };
}

test('HTTP work turns continue one task across conversations using only its mapped messages', { timeout: 25000 }, async t => {
  const f = await fixture(t), { store, calls } = f;
  const alice = await f.client('work_alice');
  const firstChat = await f.conversation(alice), otherChat = await f.conversation(alice);
  const research = store.work.createObject(alice.user.id, { name: 'Research dossier', kind: 'research' });
  const alpha = await f.begin(alice, firstChat, { text: 'Keep ALPHA_PRIVATE in this research report', work: { intent: 'new', objectId: research.id } });
  const alphaBinding = store.work.getRunBinding(alice.user.id, alpha.run.id);
  assert.ok(alphaBinding.taskId);
  assert.equal(alpha.run.projectId, null);
  assert.equal(alpha.call.authorization, `Bearer ${testKey}`);
  await f.complete(alice, alpha, 'ALPHA_RESULT with a cited research observation');
  const taskA = store.work.getTask(alice.user.id, alphaBinding.taskId);
  assert.equal(taskA.objects.find(object => object.role === 'target').kind, 'research');

  const beta = await f.begin(alice, firstChat, { text: 'Keep BETA_PRIVATE in an independent design task', work: { intent: 'new' } });
  const betaBinding = store.work.getRunBinding(alice.user.id, beta.run.id);
  assert.notEqual(betaBinding.taskId, alphaBinding.taskId);
  assert.doesNotMatch(JSON.stringify(beta.call.payload), /ALPHA_PRIVATE|ALPHA_RESULT/);
  await f.complete(alice, beta, 'BETA_RESULT is independent');
  const beforeOther = (await alice.request('GET', `/api/threads/${otherChat.id}/work`)).data.focus;
  assert.equal(beforeOther.taskId, null);

  const continuation = await f.begin(alice, otherChat, { text: '继续整理这个研究报告', work: { intent: 'continue', taskId: taskA.id, taskVersion: taskA.version } });
  const provenance = await alice.request('GET', `/api/runs/${continuation.run.id}/context`);
  assert.equal(provenance.status,200);
  assert.equal(provenance.data.execution.sessionId,store.work.getRunBinding(alice.user.id,continuation.run.id).sessionId);
  assert.ok(provenance.data.sources.some(source=>source.kind==='message' && source.excerpt.includes('ALPHA_RESULT')));
  assert.ok(!JSON.stringify(provenance.data).includes('BETA_PRIVATE'));
  const packet = JSON.stringify(continuation.call.payload);
  assert.match(packet, /ALPHA_PRIVATE/);
  assert.match(packet, /ALPHA_RESULT/);
  assert.doesNotMatch(packet, /BETA_PRIVATE|BETA_RESULT/);
  assert.equal(store.work.getRunBinding(alice.user.id, continuation.run.id).taskId, taskA.id);
  await f.complete(alice, continuation, 'ALPHA_CONTINUED');
  const context = (await alice.request('GET', `/api/work/tasks/${taskA.id}`)).data;
  assert.equal(context.task.id, taskA.id);
  assert.equal(context.sessions.length, 2);
  assert.deepEqual(new Set(context.messages.map(message => message.conversationId)), new Set([firstChat.id, otherChat.id]));
  assert.ok(context.messages.every(message => !message.content.includes('BETA_')));
  assert.equal(store.work.listTasks(alice.user.id).length, 2);
  assert.equal(calls.length, 3);
  assert.deepEqual(f.projectCalls, []);

  const restored = (await alice.request('GET', `/api/threads/${firstChat.id}`)).data;
  assert.equal(restored.replyLinks.length,2);
  assert.deepEqual(new Set(restored.replyLinks.map(link=>link.runId)),new Set([alpha.run.id,beta.run.id]));
  const bob = await f.client('work_bob');
  assert.equal((await bob.request('GET', `/api/runs/${alpha.run.id}/context`)).status,404);
  assert.equal((await bob.request('GET', '/api/history?q=')).data.threads.length,0);
  assert.equal((await bob.request('GET', `/api/work/tasks/${taskA.id}`)).status, 404);
  const bobChat = await f.conversation(bob);
  const denied = await bob.request('POST', `/api/threads/${bobChat.id}/turns`, { text: 'continue', requestId: randomUUID(), work: { intent: 'continue', taskId: taskA.id } });
  assert.equal(denied.status, 404);
  assert.equal(calls.length, 3);
  assert.equal(store.getMessages(bobChat.id).length, 0);
});

test('explicit ordinary questions do not inherit task history or create tasks', { timeout: 25000 }, async t => {
  const f = await fixture(t), alice = await f.client('plain_alice'), thread = await f.conversation(alice);
  const work = await f.begin(alice, thread, { text: 'SCOPE_ONLY_SECRET for my design task', work: { intent: 'new' } });
  await f.complete(alice, work, 'SCOPE_ONLY_RESULT');
  const question = await f.begin(alice, thread, { text: 'What is the sum of two and three?', work: { intent: 'question' } });
  assert.equal(f.store.work.getRunBinding(alice.user.id, question.run.id), null);
  assert.doesNotMatch(JSON.stringify(question.call.payload), /SCOPE_ONLY_SECRET|SCOPE_ONLY_RESULT/);
  await f.complete(alice, question, 'PLAIN_ANSWER is five');
  const nextQuestion = await f.begin(alice, thread, { text: 'Explain the previous arithmetic answer', work: { intent: 'question' } });
  assert.match(JSON.stringify(nextQuestion.call.payload), /PLAIN_ANSWER/);
  assert.doesNotMatch(JSON.stringify(nextQuestion.call.payload), /SCOPE_ONLY_SECRET|SCOPE_ONLY_RESULT/);
  await f.complete(alice, nextQuestion, 'Five follows from addition');
  assert.equal(f.store.work.listTasks(alice.user.id).length, 1);
  assert.equal((await alice.request('GET', `/api/threads/${thread.id}/work`)).data.focus.taskId, null);
  assert.equal(f.calls.length, 3);
});

test('idempotent HTTP requests return the same run and reject changed target or prompt', { timeout: 25000 }, async t => {
  const f = await fixture(t), alice = await f.client('once_alice'), thread = await f.conversation(alice);
  const pending = await f.begin(alice, thread, { text: 'Make a new report', work: { intent: 'new' } });
  const endpoint = `/api/threads/${thread.id}/turns`;
  const duplicate = await alice.request('POST', endpoint, pending.requestBody);
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.data.run.id, pending.run.id);
  assert.equal(duplicate.data.replayed, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.getMessages(thread.id).filter(message => message.role === 'user').length, 1);
  assert.equal(f.store.work.listTasks(alice.user.id).length, 1);
  const changed = await alice.request('POST', endpoint, { ...pending.requestBody, text: 'Different request' });
  assert.equal(changed.status, 409);
  assert.equal(changed.data.code, 'work_request_conflict');
  await f.complete(alice, pending, 'One response');
  const afterCompletion = await alice.request('POST', endpoint, pending.requestBody);
  assert.equal(afterCompletion.status, 202);
  assert.equal(afterCompletion.data.run.id, pending.run.id);
  assert.equal(afterCompletion.data.run.status, 'completed');
  assert.equal(f.calls.length, 1);
});

test('ambiguous continuation stops before runtime or credentials and missing request IDs cannot create work', { timeout: 25000 }, async t => {
  const f = await fixture(t), alice = await f.client('ambiguous_alice', { key: false }), thread = await f.conversation(alice);
  const objects = ['A', 'B'].map(name => f.store.work.createObject(alice.user.id, { name: `Report ${name}`, kind: 'document' }));
  for (const object of objects) f.store.work.createTask(alice.user.id, { goal: '修复登录问题', objects: [{ id: object.id, role: 'target' }] });
  const ambiguous = await alice.request('POST', `/api/threads/${thread.id}/turns`, { text: '继续之前那个', requestId: randomUUID(), work: { intent: 'continue' } });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.data.code, 'work_route_ambiguous');
  assert.equal(ambiguous.data.details?.route?.candidates?.length ?? ambiguous.data.route?.candidates?.length, 2);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.getMessages(thread.id).length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM runs').get().n, 0);
  assert.equal(f.store.work.listTasks(alice.user.id).length, 2);
  assert.equal(f.store.getApiKeyMetadata(alice.user.id).configured, false);
  const missing = await alice.request('POST', `/api/threads/${thread.id}/turns`, { text: 'Create another task', work: { intent: 'new' } });
  assert.equal(missing.status, 409);
  assert.equal(missing.data.code, 'work_request_id_required');
  assert.equal(f.store.work.listTasks(alice.user.id).length, 2);
});

test('an explicit target project owns the run while the conversation retains its original project', { timeout: 25000 }, async t => {
  const f = await fixture(t, { mockedRuntime: true }), alice = await f.client('target_alice');
  const first = f.store.createProject(alice.user.id, 'Original project'), target = f.store.createProject(alice.user.id, 'Selected project');
  const thread = f.store.createThread(first.id, alice.user.id, 'Conversation remains here');
  const targetObject = f.store.work.ensureProject(alice.user.id, target.id);
  const selected = await f.begin(alice, thread, { text: 'Apply the specified change to this selected workspace', work: { intent: 'new', objectId: targetObject.id } });
  assert.equal(selected.run.threadId, thread.id);
  assert.equal(selected.run.projectId, target.id);
  assert.equal(f.store.getThread(thread.id).projectId, first.id);
  assert.deepEqual(f.locks, [target.id]);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].project.id, target.id);
  assert.equal(f.starts[0].workContext.environment.projectId, target.id);
  assert.equal(f.starts[0].workContext.binding.taskId, f.store.work.getRunBinding(alice.user.id, selected.run.id).taskId);
  assert.ok(f.starts[0].workContext.packet.executionText.includes('user-changes.txt'));
});

test('cancelling task execution aborts the provider and late completion cannot change task state', { timeout: 25000 }, async t => {
  const f = await fixture(t), alice = await f.client('cancel_alice'), thread = await f.conversation(alice);
  const pending = await f.begin(alice, thread, { text: 'Write a report that may be cancelled', work: { intent: 'new' } });
  const binding = f.store.work.getRunBinding(alice.user.id, pending.run.id);
  pending.call.controller.enqueue(frame({ type: 'response.output_text.delta', item_id: 'answer', delta: 'PARTIAL_BEFORE_STOP' }));
  await until(() => f.store.getRun(pending.run.id).output.includes('PARTIAL_BEFORE_STOP'), 'partial output persisted');
  const current = f.store.work.getTask(alice.user.id, binding.taskId);
  const stopped = await alice.request('POST', `/api/work/tasks/${current.id}/cancel`, { expectedVersion: current.version });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  assert.equal(stopped.data.task.state, 'cancelled');
  assert.equal(f.store.getRun(pending.run.id).status, 'interrupted');
  assert.equal(pending.call.aborted, true);
  const beforeLate = f.store.work.getTaskContext(alice.user.id, current.id);
  assert.throws(() => pending.call.controller.enqueue(frame({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 } } })));
  const duplicateSettlement = f.store.work.finishRun(alice.user.id, pending.run.id, { status: 'interrupted', confirmedStopped: true });
  assert.equal(duplicateSettlement.applied, false);
  const afterLate = f.store.work.getTaskContext(alice.user.id, current.id);
  assert.equal(afterLate.task.state, 'cancelled');
  assert.equal(afterLate.task.version, beforeLate.task.version);
  assert.deepEqual(afterLate.artifacts, beforeLate.artifacts);
  assert.deepEqual(afterLate.messages, beforeLate.messages);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM work_leases WHERE run_id=?').get(pending.run.id).n, 0);
});

test('shadow routing records decisions while preserving the legacy ordinary chat flow', { timeout: 25000 }, async t => {
  const f = await fixture(t, { mode: 'shadow' }), alice = await f.client('shadow_alice'), thread = await f.conversation(alice);
  // Deliberately omit requestId and work to exercise an old client unchanged.
  const accepted = await alice.request('POST', `/api/threads/${thread.id}/turns`, { text: '继续之前那个' });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.data));
  await until(() => f.calls[0]?.controller, 'legacy provider call arrived');
  assert.equal(f.store.work.getRunBinding(alice.user.id, accepted.data.run.id), null);
  assert.deepEqual(f.calls[0].payload.input, [{ role: 'user', content: '继续之前那个' }]);
  await f.complete(alice, { run: accepted.data.run, call: f.calls[0] }, 'LEGACY_RESPONSE');
  assert.equal(f.store.work.listTasks(alice.user.id).length, 0);
  const state = (await alice.request('GET', `/api/threads/${thread.id}/work`)).data;
  assert.equal(state.mode, 'shadow');
  assert.equal(state.focus.taskId, null);
  assert.ok(state.decisions.length > 0);
  const explicit = await alice.request('POST', `/api/threads/${thread.id}/turns`, { text: 'Create new work', requestId: randomUUID(), work: { intent: 'new' } });
  assert.equal(explicit.status, 409);
  assert.equal(explicit.data.code, 'work_observation_only');
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.work.listTasks(alice.user.id).length, 0);
});

test('rolling back to shadow or off cannot resume a managed conversation against its old project', { timeout: 25000 }, async t => {
  const f = await fixture(t, { mockedRuntime: true }), alice = await f.client('rollback_alice');
  const original = f.store.createProject(alice.user.id, 'Original workspace');
  const selected = f.store.createProject(alice.user.id, 'Explicit target workspace');
  const thread = f.store.createThread(original.id, alice.user.id, 'Mixed project conversation');
  const target = f.store.work.ensureProject(alice.user.id, selected.id);
  const pending = await f.begin(alice, thread, { text: 'Only change the selected workspace', work: { intent: 'new', objectId: target.id } });
  assert.equal(pending.run.projectId, selected.id);
  f.store.updateRun(pending.run.id, { status: 'completed' });
  f.store.work.finishRun(alice.user.id, pending.run.id, { status: 'completed', confirmedStopped: true });
  const messages = f.store.getMessages(thread.id);
  const runsBefore = f.store.db.prepare('SELECT count(*) n FROM runs').get().n;

  for (const mode of ['shadow', 'off']) {
    // Recreate the HTTP app with the same database, session, and runtime. A
    // deployment rollback must not reinterpret the stored conversation target.
    await f.switchMode(mode);
    const response = await alice.request('POST', `/api/threads/${thread.id}/turns`, { text: 'Continue the selected change' });
    assert.equal(response.status, 409, JSON.stringify(response.data));
    assert.equal(response.data.code, 'work_routing_disabled');
    assert.equal(f.store.getThread(thread.id).projectId, original.id);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM runs').get().n, runsBefore);
    assert.deepEqual(f.store.getMessages(thread.id), messages);
    assert.equal(f.starts.length, 1);
    assert.deepEqual(f.locks, [selected.id]);
  }
});

test('lost local start and stop acknowledgements retain the lease through the HTTP error handler', { timeout: 25000 }, async t => {
  const f = await fixture(t, { localFailure: true }), alice = await f.client('local_timeout_alice');
  const project = f.store.createProject(alice.user.id, 'Local checkout');
  const deviceId = randomUUID();
  f.store.db.prepare('INSERT INTO local_devices(id,user_id,name,platform,root_name,token_hash,last_seen,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(deviceId, alice.user.id, 'Test computer', 'darwin', 'projects', randomUUID(), Date.now(), new Date().toISOString());
  f.store.db.prepare('INSERT INTO local_projects(project_id,device_id,path) VALUES(?,?,?)').run(project.id, deviceId, 'checkout');
  const thread = f.store.createThread(project.id, alice.user.id, 'Local execution');
  const target = f.store.work.ensureProject(alice.user.id, project.id);
  const failed = await alice.request('POST', `/api/threads/${thread.id}/turns`, {
    requestId: randomUUID(), text: 'Update the local project', work: { intent: 'new', objectId: target.id },
  });
  assert.equal(failed.status, 504, JSON.stringify(failed.data));
  assert.equal(failed.data.code, 'local_start_timeout');
  assert.deepEqual(f.localCalls.map(call => call.method), ['run.start', 'run.stop']);
  const run = f.store.getLatestRun(thread.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.mode, 'local');
  assert.equal(f.localCalls[1].runId, run.id);
  const binding = f.store.work.getRunBinding(alice.user.id, run.id);
  assert.equal(binding.status, 'needs_reconciliation');
  assert.equal(f.store.work.getTask(alice.user.id, binding.taskId).state, 'needs_reconciliation');
  const leases = f.store.db.prepare('SELECT resource_key FROM work_leases WHERE run_id=? ORDER BY resource_key').all(run.id).map(row => row.resource_key);
  assert.deepEqual(leases, [`object:${target.id}`, `project:${project.id}`, `task:${binding.taskId}`].sort());
  assert.equal(f.calls.length, 0);

  // The run is no longer active, but the unresolved process can still write to
  // the device. File mutations must honor the durable lease, not only runs.status.
  const write = await alice.request('PUT', `/api/projects/${project.id}/file`, { path: 'README.md', content: 'must not be written' });
  assert.equal(write.status, 409, JSON.stringify(write.data));
  assert.equal(write.data.code, 'work_resource_busy');
  assert.deepEqual(f.localCalls.map(call => call.method), ['run.start', 'run.stop']);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM work_leases WHERE run_id=?').get(run.id).n, 3);
});

test('real referenced outputs become dependency artifacts and invalidate when their source task changes', { timeout: 25000 }, async t => {
  const f = await fixture(t), alice = await f.client('reference_alice');
  const sourceCreated = await alice.request('POST', '/api/work/objects', { name: 'Source research', kind: 'research' });
  const targetCreated = await alice.request('POST', '/api/work/objects', { name: 'Derived document', kind: 'document' });
  assert.equal(sourceCreated.status, 201, JSON.stringify(sourceCreated.data));
  assert.equal(targetCreated.status, 201, JSON.stringify(targetCreated.data));
  const sourceObject = sourceCreated.data.object, targetObject = targetCreated.data.object;
  const sourceChat = await f.conversation(alice), targetChat = await f.conversation(alice);
  const source = await f.begin(alice, sourceChat, { text: 'Create the initial research', work: { intent: 'new', objectId: sourceObject.id } });
  await f.complete(alice, source, 'REFERENCE_PLAN_V1: the source recommends a phased rollout.');
  const sourceTaskId = f.store.work.getRunBinding(alice.user.id, source.run.id).taskId;
  const sourceContext = (await alice.request('GET', `/api/work/tasks/${sourceTaskId}`)).data;
  const sourceArtifact = sourceContext.artifacts.find(artifact => artifact.runId === source.run.id && artifact.kind === 'response');
  assert.ok(sourceArtifact, 'the actual completed source reply has an artifact');
  assert.equal(sourceArtifact.status, 'current');

  const derived = await f.begin(alice, targetChat, { text: 'Use the source result to write the target document',
    work: { intent: 'reference', objectId: targetObject.id, referenceIds: [sourceObject.id] } });
  const packet = JSON.stringify(derived.call.payload);
  assert.match(packet, /REFERENCE_PLAN_V1/);
  assert.ok(!packet.includes(sourceContext.messages.find(message => message.role === 'user').id), 'reference retrieval does not link the source conversation history');
  assert.ok(packet.includes(sourceArtifact.id));
  await f.complete(alice, derived, 'DERIVED_DOCUMENT_V1 follows the source rollout plan.');
  const targetTaskId = f.store.work.getRunBinding(alice.user.id, derived.run.id).taskId;
  const targetContext = (await alice.request('GET', `/api/work/tasks/${targetTaskId}`)).data;
  const derivedArtifact = targetContext.artifacts.find(artifact => artifact.runId === derived.run.id && artifact.kind === 'response');
  assert.ok(derivedArtifact, 'the actual derived reply has an artifact');
  assert.equal(derivedArtifact.status, 'current');
  assert.deepEqual(derivedArtifact.dependencies, [sourceArtifact.id]);

  const revision = await alice.request('PATCH', `/api/work/tasks/${sourceTaskId}`, {
    expectedVersion: sourceContext.task.version, constraints: ['The rollout must now complete in one coordinated release'],
  });
  assert.equal(revision.status, 200, JSON.stringify(revision.data));
  assert.equal(revision.data.task.version, sourceContext.task.version + 1);
  const sourceAfter = (await alice.request('GET', `/api/work/tasks/${sourceTaskId}`)).data;
  const targetAfter = (await alice.request('GET', `/api/work/tasks/${targetTaskId}`)).data;
  assert.equal(sourceAfter.artifacts.find(artifact => artifact.id === sourceArtifact.id)?.status, 'stale');
  assert.equal(targetAfter.artifacts.find(artifact => artifact.id === derivedArtifact.id)?.status, 'stale');
  assert.equal(targetAfter.task.version, targetContext.task.version);
  assert.equal(f.calls.length, 2, 'dependency invalidation does not start a model or replay either task');
});

test('capacity rejection before engine dispatch releases both cloud and local task leases', { timeout: 25000 }, async t => {
  const f = await fixture(t, { localFailure: true, maxConcurrentRuns: 1 });
  const alice = await f.client('capacity_alice'), bob = await f.client('capacity_bob');
  const chat = await f.conversation(alice);
  const active = await f.begin(alice, chat, { text: 'Keep this ordinary answer open', work: { intent: 'question' } });
  assert.equal(f.store.getRun(active.run.id).status, 'running');

  for (const location of ['cloud', 'local']) {
    const project = f.store.createProject(bob.user.id, `${location} capacity target`);
    if (location === 'local') {
      const deviceId = randomUUID();
      f.store.db.prepare('INSERT INTO local_devices(id,user_id,name,platform,root_name,token_hash,last_seen,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(deviceId, bob.user.id, 'Capacity test computer', 'darwin', 'projects', randomUUID(), Date.now(), new Date().toISOString());
      f.store.db.prepare('INSERT INTO local_projects(project_id,device_id,path) VALUES(?,?,?)').run(project.id, deviceId, 'checkout');
    }
    const thread = f.store.createThread(project.id, bob.user.id, `${location} capacity test`);
    const target = f.store.work.ensureProject(bob.user.id, project.id);
    const rejected = await bob.request('POST', `/api/threads/${thread.id}/turns`, {
      requestId: randomUUID(), text: 'Start a new task in this target', work: { intent: 'new', objectId: target.id },
    });
    assert.equal(rejected.status, 429, JSON.stringify(rejected.data));
    const run = f.store.getLatestRun(thread.id);
    assert.ok(run, 'the HTTP path reached run creation and binding before runtime capacity validation');
    assert.equal(run.mode, location);
    assert.equal(run.status, 'failed');
    const binding = f.store.work.getRunBinding(bob.user.id, run.id);
    assert.ok(binding, 'the regression exercises cleanup of a previously acquired lease');
    assert.equal(binding.status, 'failed');
    assert.equal(f.store.work.getTask(bob.user.id, binding.taskId).state, 'failed');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM work_leases WHERE run_id=?').get(run.id).n, 0);
    assert.equal(f.store.getActiveRunsForUser(bob.user.id).length, 0);
    assert.equal(f.store.getMessages(thread.id).length, 0);
    assert.deepEqual(f.localCalls, [], 'neither a local start nor a stop is sent for a rejected dispatch');
    assert.deepEqual(f.projectCalls, [], 'no container command is dispatched for a capacity rejection');
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.getRun(active.run.id).status, 'running');
  }
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM work_leases').get().n, 0);
  await f.complete(alice, active, 'The first user answer is unaffected');
});

test('legacy unbound cloud runs cannot resume after their conversation becomes managed in shadow or off', { timeout: 25000 }, async t => {
  const f = await fixture(t, { localFailure: true }), alice = await f.client('legacy_resume_alice');
  const original = f.store.createProject(alice.user.id, 'Legacy project');
  const selected = f.store.createProject(alice.user.id, 'New managed target');
  const thread = f.store.createThread(original.id, alice.user.id, 'Legacy conversation now shared with new work');
  const request = f.store.appendMessage(thread.id, 'user', 'Legacy project request');
  const legacy = f.store.createRun(thread.id, alice.user.id, { mode: 'cloud' });
  f.store.updateRun(legacy.id, { status: 'interrupted', requestMessageId: request.id });
  assert.equal(f.store.work.getRunBinding(alice.user.id, legacy.id), null);

  const target = f.store.work.ensureProject(alice.user.id, selected.id);
  const task = f.store.work.createTask(alice.user.id, { goal: 'Work on the newly selected target', objects: [{ id: target.id, role: 'target' }] });
  const focus = f.store.work.setFocus(alice.user.id, thread.id, { objectId: target.id, taskId: task.id, expectedRevision: 0 });
  f.store.work.setFocus(alice.user.id, thread.id, { expectedRevision: focus.revision, source: 'explicit_question' });
  assert.equal(f.store.work.isManagedConversation(alice.user.id, thread.id), true);
  const messages = f.store.getMessages(thread.id);
  const runsBefore = f.store.db.prepare('SELECT count(*) n FROM runs').get().n;

  for (const mode of ['shadow', 'off']) {
    await f.switchMode(mode);
    const blocked = await alice.request('POST', `/api/runs/${legacy.id}/resume`, { text: 'Continue the old request' });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
    assert.equal(blocked.data.code, 'work_routing_disabled');
    assert.equal(f.store.getRun(legacy.id).status, 'interrupted');
    assert.equal(f.store.getResumedRun(legacy.id), null);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM runs').get().n, runsBefore);
    assert.deepEqual(f.store.getMessages(thread.id), messages);
    assert.deepEqual(f.locks, [], 'managed guard must run before taking the legacy project lock');
    assert.deepEqual(f.projectCalls, [], 'no container inspection or execution before rejecting a managed conversation');
    assert.deepEqual(f.localCalls, []);
    assert.equal(f.calls.length, 0);
  }
});
