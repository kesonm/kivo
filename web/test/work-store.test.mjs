import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createStore } from '../server/store.mjs';
import { createWorkStore } from '../server/work-store.mjs';

function setup(t) {
  const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
  t.after(() => store.close());
  const alice = store.createUser({ username: 'alice', displayName: 'Alice', passwordHash: 'test' });
  const bob = store.createUser({ username: 'bobby', displayName: 'Bob', passwordHash: 'test' });
  const graph = createWorkStore({ store });
  const chat = store.createThread(null, alice.id);
  const object = graph.ensureConversation(alice.id, chat.id).object;
  return { store, graph, alice, bob, chat, object };
}
const errorCode = code => error => error.code === code;
const task = (graph, user, object, goal = '修复登录问题') => graph.createTask(user.id, {
  goal, objects: [{ id: object.id, role: 'target' }], constraints: ['保留用户现有修改'], acceptance: ['完成独立检查'],
});
function start({ store, graph, alice, chat }, work, overrides = {}) {
  const target = work.objects.find(object => object.role === 'target');
  const run = store.createRun(chat.id, alice.id, { mode: 'chat', ...(target?.projectId ? { executionProjectId: target.projectId } : {}) });
  const message = store.appendMessage(chat.id, 'user', '继续明确指定的工作');
  store.updateRun(run.id, { requestMessageId: message.id });
  const binding = graph.prepareRun(alice.id, { conversationId: chat.id, taskId: work.id, runId: run.id,
    expectedVersion: work.version, requestMessageId: message.id, lifecycle: 'continue',
    environment: { engine: 'chat' }, ...overrides });
  return { run, message, binding };
}
function finish(fixture, run, status = 'completed', extra = {}) {
  fixture.store.updateRun(run.id, { status });
  return fixture.graph.finishRun(fixture.alice.id, run.id, { status, ...extra });
}

test('work graph adds tables without rewriting legacy history or guessing task ownership', t => {
  const { store, graph, alice, chat } = setup(t);
  const userMessage = store.appendMessage(chat.id, 'user', 'Project A and B share a login issue');
  const reply = store.appendMessage(chat.id, 'assistant', 'We discussed two different projects');
  const before = store.db.prepare('SELECT * FROM messages ORDER BY rowid').all();
  const secondGraph = createWorkStore({ store });
  const imported = secondGraph.ensureConversation(alice.id, chat.id);
  assert.equal(imported.historyStatus, 'unassigned');
  assert.equal(imported.unassignedMessages, 2);
  assert.deepEqual(graph.listTasks(alice.id), []);
  assert.deepEqual(store.db.prepare('SELECT * FROM messages ORDER BY rowid').all(), before);
  assert.deepEqual(store.getMessages(chat.id).map(message => message.id), [userMessage.id, reply.id]);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('same-named project clones remain distinct and project rename preserves stable identity', t => {
  const { store, graph, alice } = setup(t);
  const first = store.createProject(alice.id, 'Same repository');
  const second = store.createProject(alice.id, 'Same repository');
  const objects = graph.listObjects(alice.id).filter(object => object.projectId);
  assert.equal(objects.length, 2);
  assert.notEqual(objects[0].id, objects[1].id);
  const firstObject = objects.find(object => object.projectId === first.id);
  store.updateProject(first.id, 'Renamed repository');
  assert.equal(graph.getObject(alice.id, firstObject.id).name, 'Renamed repository');
  assert.equal(graph.ensureProject(alice.id, first.id).id, firstObject.id);
  assert.equal(graph.listObjects(alice.id, { query: 'Renamed' })[0].id, firstObject.id);
  assert.equal(graph.ensureProject(alice.id, second.id).anchors.workspaceId, second.id);
});

test('document, image and research objects need no repository fields and references confer no write target', t => {
  const { graph, alice, bob, object } = setup(t);
  const document = graph.createObject(alice.id, { name: '登录方案', kind: 'document' });
  const image = graph.createObject(alice.id, { name: '登录方案', kind: 'asset' });
  const research = graph.createObject(alice.id, { name: '登录方案', kind: 'research' });
  const work = graph.createTask(alice.id, { goal: '参考 A 的方案给 B 实现', objects: [
    { id: document.id, role: 'reference' }, { id: image.id, role: 'reference' }, { id: research.id, role: 'target' },
  ] });
  assert.deepEqual(work.objects.map(item => [item.id, item.role]), [[document.id, 'reference'], [image.id, 'reference'], [research.id, 'target']]);
  assert.ok(work.objects.every(item => item.projectId === null));
  assert.throws(() => graph.createTask(bob.id, { goal: 'read Alice', objects: [{ id: object.id, role: 'reference' }] }), errorCode('work_not_found'));
  assert.throws(() => graph.getTask(bob.id, work.id), errorCode('work_not_found'));
  assert.equal(graph.listTasks(bob.id).length, 0);
  assert.equal(graph.listObjects(bob.id).length, 0);
});

test('per-conversation focus uses compare-and-swap and completion cannot steal another window focus', t => {
  const f = setup(t), { graph, store, alice, chat, object } = f;
  const otherChat = store.createThread(null, alice.id);
  const otherObject = graph.ensureConversation(alice.id, otherChat.id).object;
  const first = task(graph, alice, object), second = task(graph, alice, otherObject, '另一个报告');
  graph.setFocus(alice.id, chat.id, { taskId: first.id, expectedRevision: 0 });
  graph.setFocus(alice.id, otherChat.id, { taskId: second.id, expectedRevision: 0 });
  assert.throws(() => graph.setFocus(alice.id, chat.id, { taskId: second.id, expectedRevision: 0 }), errorCode('work_focus_conflict'));
  const { run } = start(f, first);
  const current = graph.getFocus(alice.id, chat.id);
  graph.setFocus(alice.id, chat.id, { taskId: second.id, expectedRevision: current.revision, source: 'correction' });
  finish(f, run);
  assert.equal(graph.getFocus(alice.id, chat.id).taskId, second.id);
  assert.equal(graph.getFocus(alice.id, otherChat.id).taskId, second.id);
  assert.equal(graph.getFocus(alice.id, otherChat.id).revision, 1);
  assert.equal(graph.getFocus(alice.id, chat.id).history[1].taskId, first.id);
});

test('a mixed conversation is linked by exact message range rather than importing its unrelated topics', t => {
  const { graph, store, alice, chat, object, bob } = setup(t);
  const a = store.appendMessage(chat.id, 'user', 'A 的文档要求');
  store.appendMessage(chat.id, 'assistant', 'A 文档的方案');
  const b = store.appendMessage(chat.id, 'user', 'B 图片的新需求');
  const workA = task(graph, alice, object, 'A 文档');
  const workB = task(graph, alice, object, 'B 图片');
  graph.linkMessages(alice.id, workA.id, { conversationId: chat.id, startMessageId: a.id, endMessageId: store.getMessages(chat.id)[1].id });
  graph.linkMessages(alice.id, workB.id, { conversationId: chat.id, startMessageId: b.id });
  assert.deepEqual(graph.getTaskContext(alice.id, workA.id).messages.map(message => message.content), ['A 的文档要求', 'A 文档的方案']);
  assert.deepEqual(graph.getTaskContext(alice.id, workB.id).messages.map(message => message.id), [b.id]);
  const other = store.createThread(null, bob.id), secret = store.appendMessage(other.id, 'user', 'private');
  assert.throws(() => graph.linkMessages(alice.id, workA.id, { conversationId: chat.id, startMessageId: secret.id }), errorCode('work_invalid'));
  store.deleteMessage(a.id);
  assert.equal(graph.getTaskContext(alice.id, workA.id).messages.length, 1);
});

test('one task spans conversations and clean sessions without changing its stable task identity', t => {
  const f = setup(t), { graph, store, alice, chat, object } = f;
  const work = task(graph, alice, object);
  const first = start(f, work);
  graph.updateEngineSession(alice.id, first.run.id, 'engine-session-A');
  const answer = store.appendMessage(chat.id, 'assistant', 'A persisted result');
  finish(f, first.run, 'completed', { messageIds: [answer.id] });
  const otherChat = store.createThread(null, alice.id);
  graph.ensureConversation(alice.id, otherChat.id);
  const second = start({ ...f, chat: otherChat }, graph.getTask(alice.id, work.id), { lifecycle: 'rebuild' });
  assert.notEqual(second.binding.sessionId, first.binding.sessionId);
  assert.equal(second.binding.engineThreadId, null);
  finish(f, second.run);
  const context = graph.getTaskContext(alice.id, work.id);
  assert.equal(context.sessions.length, 2);
  assert.deepEqual(new Set(context.messages.map(message => message.conversationId)), new Set([chat.id, otherChat.id]));
  assert.ok(context.messages.some(message => message.content === 'A persisted result'));
  assert.equal(graph.listTasks(alice.id).length, 1);
});

test('continue reuses only the exact environment, while explicit rebuild and new tasks use new sessions', t => {
  const f = setup(t), { graph, alice, object } = f;
  const work = task(graph, alice, object);
  const first = start(f, work, { environment: { engine: 'chat', model: 'm1' } });
  graph.updateEngineSession(alice.id, first.run.id, 'session-one');
  finish(f, first.run);
  const second = start(f, graph.getTask(alice.id, work.id), { environment: { engine: 'chat', model: 'm1' } });
  assert.equal(second.binding.sessionId, first.binding.sessionId);
  assert.equal(second.binding.engineThreadId, 'session-one');
  assert.throws(() => graph.updateEngineSession(alice.id, second.run.id, 'different-thread'), errorCode('work_session_conflict'));
  finish(f, second.run);
  const third = start(f, graph.getTask(alice.id, work.id), { environment: { engine: 'chat', model: 'm2' } });
  assert.notEqual(third.binding.sessionId, first.binding.sessionId);
  assert.equal(third.binding.lifecycle, 'rebuild');
  finish(f, third.run);
  const fork = graph.createTask(alice.id, { goal: '一个类似的全新版本', parentTaskId: work.id, relation: 'fork', objects: [{ id: object.id, role: 'target' }] });
  const fourth = start(f, fork, { lifecycle: 'fork' });
  assert.notEqual(fourth.binding.taskId, first.binding.taskId);
  assert.notEqual(fourth.binding.sessionId, third.binding.sessionId);
  assert.equal(graph.getTask(alice.id, work.id).goal, work.goal);
});

test('leases prevent simultaneous writers to one target even from different conversations and tasks', t => {
  const f = setup(t), { graph, store, alice, object } = f;
  const firstWork = task(graph, alice, object), secondWork = task(graph, alice, object);
  const first = start(f, firstWork);
  const otherChat = store.createThread(null, alice.id), run = store.createRun(otherChat.id, alice.id, { mode: 'chat' });
  assert.throws(() => graph.prepareRun(alice.id, { conversationId: otherChat.id, taskId: secondWork.id, runId: run.id,
    expectedVersion: 1, environment: { engine: 'chat' } }), errorCode('work_resource_busy'));
  assert.equal(graph.getRunBinding(alice.id, run.id), null);
  assert.equal(graph.getTask(alice.id, secondWork.id).generation, 0);
  assert.throws(() => graph.finishRun(alice.id, first.run.id, { status: 'completed' }), errorCode('work_run_active'));
  finish(f, first.run);
  const next = graph.prepareRun(alice.id, { conversationId: otherChat.id, taskId: secondWork.id, runId: run.id,
    expectedVersion: 1, environment: { engine: 'chat' } });
  assert.equal(next.taskId, secondWork.id);
});

test('reference objects stay read-only and do not claim target write leases', t => {
  const f = setup(t), { graph, store, alice, object } = f;
  const reference = graph.createObject(alice.id, { kind: 'document', name: 'Reference A' });
  const work = graph.createTask(alice.id, { goal: 'Apply A to B', objects: [{ id: reference.id, role: 'reference' }, { id: object.id, role: 'target' }] });
  const first = start(f, work);
  const resources = store.db.prepare('SELECT resource_key FROM work_leases WHERE run_id=?').all(first.run.id).map(row => row.resource_key);
  assert.ok(resources.includes('object:' + object.id));
  assert.ok(!resources.includes('object:' + reference.id));
  assert.throws(() => graph.assertRunCurrent(alice.id, first.run.id, { environment: { engine: 'cloud', projectId: 'different' } }), errorCode('work_environment_changed'));
});

test('late results and events cannot resurrect a cancelled task or overwrite a newer user decision', t => {
  const f = setup(t), { graph, store, alice, object, chat } = f;
  const work = task(graph, alice, object), { run, binding } = start(f, work);
  const first = graph.appendEvent(alice.id, run.id, { key: 'tool-1-end', generation: binding.generation, type: 'tool', status: 'done' });
  assert.equal(graph.appendEvent(alice.id, run.id, { key: 'tool-1-end', generation: binding.generation, type: 'tool', status: 'done' }), null);
  assert.equal(first.seq, 2);
  const cancelled = graph.cancelTask(alice.id, work.id, { expectedVersion: work.version, reason: 'User changed mind' });
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(() => graph.assertRunCurrent(alice.id, run.id), errorCode('work_run_stale'));
  assert.throws(() => graph.appendEvent(alice.id, run.id, { key: 'late', generation: binding.generation, type: 'tool' }), errorCode('work_run_stale'));
  const late = store.appendMessage(chat.id, 'assistant', 'Late worker completion');
  const result = finish(f, run, 'completed', { messageIds: [late.id] });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'stale');
  assert.equal(graph.getTask(alice.id, work.id).status, 'cancelled');
  assert.ok(!graph.getTaskContext(alice.id, work.id).messages.some(message => message.id === late.id));
  assert.equal(graph.finishRun(alice.id, run.id, { status: 'completed' }).reason, 'duplicate');
  assert.equal(graph.getEvents(alice.id, run.id).at(-1).type, 'late_result_ignored');
});

test('restart preserves uncertain side effects and cannot automatically release or steal the execution lease', t => {
  const f = setup(t), { graph, store, alice, object } = f;
  const work = task(graph, alice, object), { run } = start(f, work);
  assert.deepEqual(graph.reconcile(), { interrupted: 1 });
  assert.deepEqual(graph.reconcile(), { interrupted: 0 });
  assert.equal(graph.getTask(alice.id, work.id).status, 'needs_reconciliation');
  assert.throws(() => graph.assertRunCurrent(alice.id, run.id), errorCode('work_run_stale'));
  assert.throws(() => graph.confirmRunStopped(alice.id, run.id, { confirmedStopped: true }), errorCode('work_run_active'));
  store.reconcileInterruptedRuns();
  assert.throws(() => graph.confirmRunStopped(alice.id, run.id), errorCode('work_run_active'));
  graph.confirmRunStopped(alice.id, run.id, { confirmedStopped: true });
  const next = start(f, graph.getTask(alice.id, work.id));
  assert.notEqual(next.binding.sessionId, graph.getRunBinding(alice.id, run.id).sessionId);
  assert.equal(next.binding.generation, 2);
});

test('verified completion requires an independently persisted successful check, not a worker claim', t => {
  const f = setup(t), { graph, store, alice, object } = f;
  const work = task(graph, alice, object), first = start(f, work);
  const unchecked = finish(f, first.run, 'completed', { verification: { status: 'passed', exitCode: 0 } });
  assert.equal(unchecked.task.status, 'waiting_input');
  const second = start(f, graph.getTask(alice.id, work.id));
  store.updateRun(second.run.id, { verification: { command: 'independent-check', status: 'passed', exitCode: 0 } });
  const checked = finish(f, second.run);
  assert.equal(checked.task.status, 'succeeded');
  assert.throws(() => graph.updateTask(alice.id, work.id, { expectedVersion: 1, status: 'succeeded' }), errorCode('work_invalid'));
});

test('upstream artifact versions invalidate all downstream dependants and cannot be overwritten by stale workers', t => {
  const f = setup(t), { graph, store, alice, object, chat } = f;
  const work = task(graph, alice, object), { run } = start(f, work);
  const answer = store.appendMessage(chat.id, 'assistant', 'Original report');
  finish(f, run, 'completed', { messageIds: [answer.id] });
  const source = { type: 'message', id: answer.id };
  const base = graph.createArtifact(alice.id, { taskId: work.id, runId: run.id, expectedVersion: 1, kind: 'report', name: 'Plan', source });
  const dependent = graph.createArtifact(alice.id, { taskId: work.id, expectedVersion: 1, kind: 'image', name: 'Diagram', source, dependencies: [base.id] });
  const indirect = graph.createArtifact(alice.id, { taskId: work.id, expectedVersion: 1, kind: 'report', name: 'Final report', source, dependencies: [dependent.id] });
  const revised = graph.createArtifact(alice.id, { taskId: work.id, expectedVersion: 1, kind: 'report', name: 'Plan v2', source, supersedesId: base.id });
  assert.equal(revised.familyId, base.familyId);
  assert.equal(revised.version, 2);
  assert.equal(graph.getArtifact(alice.id, base.id).status, 'superseded');
  assert.equal(graph.getArtifact(alice.id, dependent.id).status, 'stale');
  assert.equal(graph.getArtifact(alice.id, indirect.id).status, 'stale');
  assert.throws(() => graph.createArtifact(alice.id, { taskId: work.id, expectedVersion: 1, kind: 'report', name: 'bad', source, dependencies: [base.id] }), errorCode('work_artifact_stale'));
  assert.throws(() => graph.createArtifact(alice.id, { taskId: work.id, expectedVersion: 1, kind: 'report', name: 'v3 from old', source, supersedesId: base.id }), errorCode('work_artifact_conflict'));
  graph.updateTask(alice.id, work.id, { expectedVersion: 1, constraints: ['Revised requirement'] });
  assert.throws(() => graph.createArtifact(alice.id, { taskId: work.id, runId: run.id, expectedVersion: 2, kind: 'report', name: 'late', source }), errorCode('work_run_stale'));
});

test('evidence keeps provenance, redacts secrets and disappears from recall when its original source is deleted', t => {
  const f = setup(t), { graph, store, alice, object, chat } = f;
  const work = task(graph, alice, object), { run, message } = start(f, work);
  const evidence = graph.addEvidence(alice.id, { taskId: work.id, runId: run.id, expectedVersion: 1,
    kind: 'observation', status: 'unverified', summary: 'A sk-proj-abcdefghijklmnopqrstuvwxy secret', source: { type: 'message', id: message.id } });
  assert.ok(!evidence.summary.includes('sk-proj-'));
  assert.equal(evidence.status, 'unverified');
  const artifact = graph.createArtifact(alice.id, { taskId: work.id, expectedVersion: 1, kind: 'report', name: 'quoted result', source: { type: 'message', id: message.id } });
  const key = graph.recordDecision(alice.id, chat.id, { status: 'matched', taskId: work.id, reason: 'Bearer abcdefghijklmnopqrstuvwxyz',
    context: { taskId: work.id, taskVersion: 1, bytes: 50, budget: { maxBytes: 1024, outputTokens: 4096, model: 'test', basis: 'bytes' }, sources: [{ kind: 'message', id: message.id }] } });
  assert.ok(!key.reason.includes('abcdefghijklmnopqrstuvwxyz'));
  store.deleteMessage(message.id);
  const context = graph.getTaskContext(alice.id, work.id);
  assert.deepEqual(context.evidence, []);
  assert.deepEqual(context.artifacts, []);
  assert.throws(() => graph.getArtifact(alice.id, artifact.id), errorCode('work_not_found'));
  assert.deepEqual(graph.getDecisions(alice.id, chat.id)[0].context, { unavailable: true });
});

test('changed object versions and deleted project permissions block reuse and remove inaccessible search results', t => {
  const { store, graph, alice, object, bob } = setup(t);
  const work = task(graph, alice, object);
  const updated = graph.updateObject(alice.id, object.id, { expectedVersion: 1, aliases: ['Updated collection'] });
  assert.equal(updated.version, 2);
  assert.equal(graph.getTask(alice.id, work.id).status, 'needs_reconciliation');
  const rebound = graph.updateTask(alice.id, work.id, { expectedVersion: 1, objects: [{ id: object.id, role: 'target' }] });
  assert.equal(rebound.objects[0].boundVersion, 2);
  assert.throws(() => graph.updateTask(alice.id, work.id, { expectedVersion: 1, goal: 'stale' }), errorCode('work_version_conflict'));
  const project = store.createProject(alice.id, 'Removed project'), projectObject = graph.ensureProject(alice.id, project.id);
  const removedTask = task(graph, alice, projectObject);
  store.deleteProject(project.id);
  assert.throws(() => graph.getObject(alice.id, projectObject.id), errorCode('work_not_found'));
  assert.throws(() => graph.getTask(alice.id, removedTask.id), errorCode('work_not_found'));
  assert.ok(!graph.listTasks(alice.id).some(item => item.id === removedTask.id));
  assert.ok(!graph.listObjects(alice.id).some(item => item.id === projectObject.id));
  store.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(alice.id);
  assert.throws(() => graph.getTask(alice.id, work.id), errorCode('work_forbidden'));
  assert.equal(graph.listTasks(bob.id).length, 0);
});

test('invalid run binding rolls back identity, lease, session and message links atomically', t => {
  const f = setup(t), { graph, store, alice, object, chat } = f;
  const work = task(graph, alice, object);
  const run = store.createRun(chat.id, alice.id, { mode: 'chat' });
  const assistant = store.appendMessage(chat.id, 'assistant', 'Not a user request');
  assert.throws(() => graph.prepareRun(alice.id, { conversationId: chat.id, taskId: work.id, runId: run.id, expectedVersion: 1,
    environment: { engine: 'chat' }, requestMessageId: assistant.id }), errorCode('work_run_invalid'));
  assert.equal(graph.getRunBinding(alice.id, run.id), null);
  assert.equal(graph.getTaskContext(alice.id, work.id).sessions.length, 0);
  assert.equal(graph.getTaskContext(alice.id, work.id).messages.length, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM work_leases').get().n, 0);
  assert.equal(graph.getTask(alice.id, work.id).generation, 0);
});

test('local stop without an acknowledgement keeps its target locked until the engine is checked', t => {
  const f = setup(t), { store, graph, alice } = f;
  const project = store.createProject(alice.id, 'Local checkout'), at = new Date().toISOString();
  store.db.prepare(`INSERT INTO local_devices(id,user_id,name,platform,root_name,token_hash,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run('test-device', alice.id, 'Computer', 'darwin', 'projects', 'test-device-token-hash', at);
  store.db.prepare('INSERT INTO local_projects(project_id,device_id,path) VALUES(?,?,?)').run(project.id, 'test-device', 'checkout');
  const object = graph.ensureProject(alice.id, project.id), work = task(graph, alice, object);
  const chat = store.createThread(project.id, alice.id), run = store.createRun(chat.id, alice.id, { mode: 'local' });
  graph.prepareRun(alice.id, { conversationId: chat.id, taskId: work.id, runId: run.id, expectedVersion: 1,
    environment: { engine: 'codex-app-server', mode: 'local', projectId: project.id, workspace: 'test-device:checkout' } });
  store.updateRun(run.id, { status: 'interrupted' });
  graph.finishRun(alice.id, run.id, { status: 'interrupted', confirmedStopped: false });
  assert.equal(graph.getRunBinding(alice.id, run.id).status, 'needs_reconciliation');
  assert.equal(store.db.prepare('SELECT count(*) n FROM work_leases WHERE run_id=?').get(run.id).n, 3);
  assert.equal(graph.getTask(alice.id, work.id).status, 'needs_reconciliation');
  graph.confirmRunStopped(alice.id, run.id, { confirmedStopped: true });
  assert.equal(store.db.prepare('SELECT count(*) n FROM work_leases WHERE run_id=?').get(run.id).n, 0);
});

test('runtime can settle a stopped revoked account without accepting its output or reopening its task', t => {
  const f = setup(t), { graph, store, alice, object, chat } = f;
  const work = task(graph, alice, object), { run } = start(f, work);
  const late = store.appendMessage(chat.id, 'assistant', 'Untrusted late result');
  store.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(alice.id);
  assert.throws(() => graph.assertRunCurrent(alice.id, run.id), errorCode('work_forbidden'));
  assert.throws(() => graph.settleStoppedRun(run.id, { status: 'completed', confirmedStopped: true }), errorCode('work_run_active'));
  store.updateRun(run.id, { status: 'completed' });
  const result = graph.settleStoppedRun(run.id, { status: 'completed', confirmedStopped: true, messageIds: [late.id] });
  assert.equal(result.reason, 'revoked_owner');
  assert.equal(store.db.prepare('SELECT count(*) n FROM work_leases WHERE run_id=?').get(run.id).n, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM work_message_links WHERE task_id=? AND message_id=?').get(work.id, late.id).n, 0);
  assert.equal(store.db.prepare('SELECT status FROM work_tasks WHERE id=?').get(work.id).status, 'needs_reconciliation');
});

test('confirmation after an ordinary completed run preserves a reusable session and reports context overflow explicitly', t => {
  const f = setup(t), { graph, store, alice, object, chat } = f;
  const work = task(graph, alice, object), { run } = start(f, work);
  const answer = store.appendMessage(chat.id, 'assistant', 'A result');
  finish(f, run, 'completed', { messageIds: [answer.id] });
  graph.confirmRunStopped(alice.id, run.id, { confirmedStopped: true });
  const context = graph.getTaskContext(alice.id, work.id, { maxMessages: 1 });
  assert.equal(context.sessions[0].status, 'ready');
  assert.equal(context.sessions[0].taskVersion, 1);
  assert.equal(context.overflow, true);
  assert.equal(context.messageCountAtLeast, 2);
  assert.equal(context.runs[0].status, 'completed');
  assert.ok(context.artifacts.some(artifact => artifact.source.id === answer.id));
  assert.ok(context.evidence.some(evidence => evidence.summary.includes('未执行独立验收')));
});

test('deleting an old project does not fail foreign keys or leave its text in searchable task context', t => {
  const { store, graph, alice } = setup(t);
  const project = store.createProject(alice.id, 'Deletable'), chat = store.createThread(project.id, alice.id);
  const object = graph.ensureConversation(alice.id, chat.id).object, work = task(graph, alice, object);
  graph.setFocus(alice.id, chat.id, { taskId: work.id, expectedRevision: 0 });
  const run = store.createRun(chat.id, alice.id, { mode: 'cloud' });
  const message = store.appendMessage(chat.id, 'user', 'private project request');
  graph.prepareRun(alice.id, { conversationId: chat.id, taskId: work.id, runId: run.id, expectedVersion: 1,
    environment: { engine: 'cloud', projectId: project.id }, requestMessageId: message.id });
  const answer = store.appendMessage(chat.id, 'assistant', 'private project result');
  store.updateRun(run.id, { status: 'completed' });
  graph.finishRun(alice.id, run.id, { status: 'completed', confirmedStopped: true, messageIds: [answer.id] });
  store.deleteProject(project.id);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(graph.getRunBinding(alice.id, run.id).conversationId, null);
  assert.ok(!graph.listTasks(alice.id).some(item => item.id === work.id));
  assert.throws(() => graph.getTaskContext(alice.id, work.id), errorCode('work_not_found'));
  assert.equal(store.db.prepare('SELECT count(*) n FROM work_message_links WHERE task_id=?').get(work.id).n, 0);
});

test('ordinary question history excludes bound task messages after focus switches back to chat', t => {
  const f = setup(t), { graph, store, alice, object, chat } = f;
  const ordinary = store.appendMessage(chat.id, 'user', '普通问题');
  graph.recordQuestionMessage(alice.id, chat.id, ordinary.id);
  const ordinaryReply = store.appendMessage(chat.id, 'assistant', '普通回答');
  graph.recordQuestionMessage(alice.id, chat.id, ordinaryReply.id);
  const work = task(graph, alice, object), { run, message } = start(f, work);
  const secret = store.appendMessage(chat.id, 'assistant', 'Task-specific content');
  finish(f, run, 'completed', { messageIds: [secret.id] });
  assert.throws(() => graph.recordQuestionMessage(alice.id, chat.id, message.id), errorCode('work_message_scope'));
  const question = store.appendMessage(chat.id, 'user', '回到普通聊天');
  graph.recordQuestionMessage(alice.id, chat.id, question.id);
  assert.deepEqual(graph.getQuestionMessages(alice.id, chat.id).map(item => item.id), [ordinary.id, ordinaryReply.id, question.id]);
  assert.throws(() => graph.getQuestionMessages(alice.id, chat.id, { maxMessages: 2 }), errorCode('context_too_large'));
  assert.throws(() => graph.getQuestionMessages(alice.id, chat.id, { maxBytes: 1 }), errorCode('context_too_large'));
});

test('legacy standalone questions remain compatible but unassigned project history cannot enter ordinary chat', t => {
  const { graph, store, alice, chat } = setup(t);
  const first = store.appendMessage(chat.id, 'user', 'Legacy ordinary question');
  assert.equal(graph.getQuestionMessages(alice.id, chat.id)[0].id, first.id);
  const project = store.createProject(alice.id, 'Legacy project'), projectChat = store.createThread(project.id, alice.id);
  store.appendMessage(projectChat.id, 'user', 'Old project instructions');
  const question = store.appendMessage(projectChat.id, 'user', 'An explicitly scoped ordinary question');
  graph.recordQuestionMessage(alice.id, projectChat.id, question.id);
  assert.deepEqual(graph.getQuestionMessages(alice.id, projectChat.id).map(item => item.id), [question.id]);
});

test('project leases block legacy writes and fresh runs until a stopped engine is independently confirmed', t => {
  const { graph, store, alice, bob } = setup(t);
  const project = store.createProject(alice.id, 'Protected checkout'), chat = store.createThread(project.id, alice.id);
  assert.deepEqual(graph.assertProjectIdle(alice.id, project.id), { idle: true });
  assert.throws(() => graph.assertProjectIdle(bob.id, project.id), errorCode('work_not_found'));
  const object = graph.ensureProject(alice.id, project.id), work = task(graph, alice, object);
  const run = store.createRun(chat.id, alice.id, { mode: 'cloud' });
  graph.prepareRun(alice.id, { conversationId: chat.id, taskId: work.id, runId: run.id, expectedVersion: 1,
    environment: { engine: 'cloud', projectId: project.id } });
  assert.throws(() => graph.assertProjectIdle(alice.id, project.id), errorCode('work_resource_busy'));
  store.updateRun(run.id, { status: 'interrupted' });
  graph.finishRun(alice.id, run.id, { status: 'interrupted', confirmedStopped: false });
  assert.throws(() => graph.assertProjectIdle(alice.id, project.id), errorCode('work_resource_busy'));
  graph.confirmRunStopped(alice.id, run.id, { confirmedStopped: true });
  assert.deepEqual(graph.assertProjectIdle(alice.id, project.id), { idle: true });
});

test('managed conversation markers survive cleared and trimmed focus history and never reenable legacy replay', t => {
  const { graph, store, alice, chat, object, bob } = setup(t);
  const legacy = store.appendMessage(chat.id, 'user', 'Old mixed text');
  assert.equal(graph.isManagedConversation(alice.id, chat.id), false);
  const work = task(graph, alice, object);
  graph.setFocus(alice.id, chat.id, { taskId: work.id, expectedRevision: 0 });
  for (let revision = 1; revision < 16; revision++) graph.setFocus(alice.id, chat.id, { taskId: null, objectId: null, expectedRevision: revision });
  assert.ok(graph.getFocus(alice.id, chat.id).history.every(item => item.taskId === null));
  assert.equal(graph.isManagedConversation(alice.id, chat.id), true);
  assert.deepEqual(graph.getQuestionMessages(alice.id, chat.id), []);
  assert.equal(store.getMessages(chat.id)[0].id, legacy.id);
  const clean = store.createThread(null, alice.id);
  assert.equal(graph.isManagedConversation(alice.id, clean.id), false);
  assert.throws(() => graph.isManagedConversation(bob.id, chat.id), errorCode('work_not_found'));
});

function referenceFixture(t) {
  const f = setup(t), { graph, store, alice, object, chat } = f;
  const sourceTask = task(graph, alice, object, 'Source A');
  const sourceRun = start(f, sourceTask);
  const answer = store.appendMessage(chat.id, 'assistant', 'A source artifact excerpt');
  finish(f, sourceRun.run, 'completed', { messageIds: [answer.id] });
  const artifact = graph.getTaskContext(alice.id, sourceTask.id).artifacts.find(item => item.source.id === answer.id);
  const target = graph.createObject(alice.id, { kind: 'document', name: 'Target B' });
  const destinationTask = graph.createTask(alice.id, { goal: 'Apply A to B', objects: [{ id: target.id, role: 'target' }, { id: object.id, role: 'reference' }] });
  return { ...f, sourceTask, sourceRun, answer, artifact, target, destinationTask };
}

test('run inputs pin scoped source artifacts and reject same-owner unrelated artifacts before leasing', t => {
  const f = referenceFixture(t), { graph, store, alice, chat, artifact, sourceTask, target, destinationTask } = f;
  const unrelatedTask = task(graph, alice, target, 'No reference authorization');
  const unrelatedRun = store.createRun(chat.id, alice.id, { mode: 'chat' });
  assert.throws(() => graph.prepareRun(alice.id, { conversationId: chat.id, taskId: unrelatedTask.id, runId: unrelatedRun.id,
    expectedVersion: 1, environment: { engine: 'chat' }, inputArtifactIds: [artifact.id] }), errorCode('work_reference_scope'));
  assert.equal(graph.getRunBinding(alice.id, unrelatedRun.id), null);
  store.updateRun(unrelatedRun.id, { status: 'failed' });
  const { run, binding } = start(f, destinationTask, { inputArtifactIds: [artifact.id] });
  assert.deepEqual(binding.inputArtifacts, [{ id: artifact.id, version: artifact.version, sourceTaskId: sourceTask.id, sourceTaskVersion: sourceTask.version }]);
  assert.equal(graph.assertRunCurrent(alice.id, run.id).inputArtifacts[0].id, artifact.id);
  const recorded = graph.recordDecision(alice.id, chat.id, { status: 'bound', taskId: destinationTask.id, runId: run.id,
    context: { taskId: destinationTask.id, taskVersion: 1, bytes: 100, lifecycle: 'new', budget: { maxBytes: 1000, outputTokens: 100, model: 'test', basis: 'bytes' },
      sources: [{ kind: 'artifact', id: artifact.id, version: artifact.version, sourceTaskId: sourceTask.id }] } });
  assert.equal(recorded.context.sources[0].sourceTaskId, sourceTask.id);
  assert.throws(() => graph.recordDecision(alice.id, chat.id, { status: 'bound', taskId: unrelatedTask.id,
    context: { taskId: unrelatedTask.id, taskVersion: 1, bytes: 100, budget: { maxBytes: 1000, outputTokens: 100 },
      sources: [{ kind: 'artifact', id: artifact.id, version: artifact.version, sourceTaskId: sourceTask.id }] } }), errorCode('work_reference_scope'));
});

test('a changed input artifact stops current execution and discards completion built from the stale source', t => {
  const f = referenceFixture(t), { graph, store, alice, chat, artifact, sourceTask, answer, destinationTask } = f;
  const { run } = start(f, destinationTask, { inputArtifactIds: [artifact.id] });
  graph.createArtifact(alice.id, { taskId: sourceTask.id, expectedVersion: 1, kind: 'report', name: 'Updated A',
    source: { type: 'message', id: answer.id }, supersedesId: artifact.id });
  assert.throws(() => graph.assertRunCurrent(alice.id, run.id), errorCode('work_artifact_stale'));
  const late = store.appendMessage(chat.id, 'assistant', 'Completion using obsolete A');
  const completion = finish(f, run, 'completed', { messageIds: [late.id] });
  assert.equal(completion.reason, 'stale');
  assert.equal(graph.getTask(alice.id, destinationTask.id).status, 'needs_reconciliation');
  assert.ok(!graph.getTaskContext(alice.id, destinationTask.id).messages.some(message => message.id === late.id));
  assert.deepEqual(graph.getTaskContext(alice.id, destinationTask.id).artifacts, []);
});

test('completed output artifacts record consumed versions and become stale when their upstream source changes', t => {
  const f = referenceFixture(t), { graph, store, alice, chat, artifact, sourceTask, answer, destinationTask } = f;
  const { run } = start(f, destinationTask, { inputArtifactIds: [artifact.id] });
  const result = store.appendMessage(chat.id, 'assistant', 'B based on A version 1');
  finish(f, run, 'completed', { messageIds: [result.id] });
  const output = graph.getTaskContext(alice.id, destinationTask.id).artifacts.find(item => item.source.id === result.id);
  assert.deepEqual(output.dependencies, [artifact.id]);
  graph.createArtifact(alice.id, { taskId: sourceTask.id, expectedVersion: 1, kind: 'report', name: 'A revision',
    source: { type: 'message', id: answer.id }, supersedesId: artifact.id });
  assert.equal(graph.getArtifact(alice.id, output.id).status, 'stale');
});

test('deleting a source message revokes already-bound input access before the next worker request', t => {
  const f = referenceFixture(t), { graph, store, alice, answer, destinationTask } = f;
  const { run } = start(f, destinationTask, { inputArtifactIds: [f.artifact.id] });
  store.deleteMessage(answer.id);
  assert.throws(() => graph.assertRunCurrent(alice.id, run.id), errorCode('work_not_found'));
  assert.equal(finish(f, run).reason, 'stale');
});

test('explicit human acceptance names a concrete version and cannot invent an automated successful test', t => {
  const f = referenceFixture(t), { graph, store, alice, artifact, sourceTask, destinationTask, bob } = f;
  assert.throws(() => graph.acceptTask(bob.id, sourceTask.id, { expectedVersion: 1, artifactId: artifact.id }), errorCode('work_not_found'));
  assert.throws(() => graph.acceptTask(alice.id, destinationTask.id, { expectedVersion: 1, artifactId: artifact.id }), errorCode('work_artifact_stale'));
  const accepted = graph.acceptTask(alice.id, sourceTask.id, { expectedVersion: 1, artifactId: artifact.id });
  assert.equal(accepted.status, 'succeeded');
  assert.equal(accepted.version, 2);
  const context = graph.getTaskContext(alice.id, sourceTask.id);
  const evidence = context.evidence.find(item => item.source.authority === 'user_acceptance');
  assert.equal(evidence.source.id, artifact.id);
  assert.equal(evidence.source.version, artifact.version);
  assert.equal(evidence.source.actorId, alice.id);
  assert.ok(evidence.summary.includes('不代表系统运行过测试'));
  assert.equal(context.runs[0].verification, null);
  assert.equal(context.sessions[0].status, 'stale');
  assert.ok(store.getAudit().some(item => item.action === 'work.task.accepted'));
  assert.throws(() => graph.acceptTask(alice.id, sourceTask.id, { expectedVersion: 1, artifactId: artifact.id }), errorCode('work_version_conflict'));
});

test('a running or cancelled task cannot accept output and source removal invalidates an accepted downstream version', t => {
  const f = referenceFixture(t), { graph, store, alice, chat, artifact, answer, destinationTask } = f;
  const { run } = start(f, destinationTask, { inputArtifactIds: [artifact.id] });
  assert.throws(() => graph.acceptTask(alice.id, destinationTask.id, { expectedVersion: 1, artifactId: artifact.id }), errorCode('work_resource_busy'));
  const result = store.appendMessage(chat.id, 'assistant', 'B using A');
  finish(f, run, 'completed', { messageIds: [result.id] });
  const output = graph.getTaskContext(alice.id, destinationTask.id).artifacts.find(item => item.source.id === result.id);
  graph.acceptTask(alice.id, destinationTask.id, { expectedVersion: 1, artifactId: output.id });
  store.deleteMessage(answer.id);
  const context = graph.getTaskContext(alice.id, destinationTask.id);
  assert.equal(context.artifacts.find(item => item.id === output.id).status, 'stale');
  assert.equal(context.task.status, 'needs_reconciliation');
  assert.throws(() => graph.acceptTask(alice.id, destinationTask.id, { expectedVersion: 2, artifactId: output.id }), errorCode('work_artifact_stale'));
  const cancelled = graph.cancelTask(alice.id, destinationTask.id, { expectedVersion: 2 });
  assert.throws(() => graph.acceptTask(alice.id, destinationTask.id, { expectedVersion: cancelled.version, artifactId: output.id }), errorCode('work_cancelled'));
});
