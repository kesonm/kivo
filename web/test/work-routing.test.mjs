import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createStore } from '../server/store.mjs';
import { createWorkStore } from '../server/work-store.mjs';
import { parseWorkIntent, resolveWorkRoute, requireExecutableRoute, validateWorkRequest } from '../server/work-routing.mjs';

function fixture(t) {
  const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
  t.after(() => store.close());
  const user = store.createUser({ username: 'alice', displayName: 'Alice', passwordHash: 'fixture' });
  const other = store.createUser({ username: 'bobby', displayName: 'Bob', passwordHash: 'fixture' });
  const workStore = createWorkStore({ store });
  const conversation = store.createThread(null, user.id, '连续工作');
  workStore.ensureConversation(user.id, conversation.id);
  const object = (name, kind = 'collection') => workStore.createObject(user.id, { name, kind });
  const task = (target, goal = '修复登录问题', references = []) => workStore.createTask(user.id, {
    goal, objects: [{ id: target.id, role: 'target' }, ...references.map(item => ({ id: item.id, role: 'reference' }))],
  });
  const focus = (target, current, conversationId = conversation.id) => workStore.setFocus(user.id, conversationId, {
    objectId: target.id, taskId: current?.id ?? null, expectedRevision: workStore.getFocus(user.id, conversationId).revision,
  });
  const route = (text, work, conversationId = conversation.id, overrides = {}) => resolveWorkRoute({ workStore, userId: user.id, conversationId, text, work, ...overrides });
  return { store, workStore, user, other, conversation, object, task, focus, route };
}

test('work intent distinguishes continued work from a similar new variant', () => {
  assert.equal(parseWorkIntent('继续上次的项目'), 'continue');
  assert.equal(parseWorkIntent('做一个类似上次的全新版本'), 'fork');
  assert.equal(parseWorkIntent('参考 Alpha 的方案给 Beta 实现'), 'reference');
  assert.equal(parseWorkIntent('比较这两个研究报告'), 'compare');
  assert.equal(parseWorkIntent('暂停当前任务'), 'pause');
  assert.equal(parseWorkIntent('取消这个任务'), 'cancel');
  assert.equal(parseWorkIntent('你好，什么是闭包？'), 'question');
  assert.equal(parseWorkIntent('继续', 'new'), 'new');
});

test('similar projects with identical issue titles require disambiguation even when one has focus', t => {
  const { store, workStore, user, task, focus, route } = fixture(t);
  const a = workStore.ensureProject(user.id, store.createProject(user.id, 'React 项目甲').id);
  const b = workStore.ensureProject(user.id, store.createProject(user.id, 'React 项目乙').id);
  const first = task(a), second = task(b); focus(b, second);
  const result = route('继续之前那个登录问题');
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(new Set(result.candidates.map(item => item.id)), new Set([first.id, second.id]));
  assert.equal(result.taskId, null);
  assert.throws(() => requireExecutableRoute(result), error => error.code === 'work_route_ambiguous' && error.details.route === result);
});

test('explicit object A takes precedence over focus B, and conflicting explicit references block', t => {
  const { object, task, focus, route } = fixture(t);
  const a = object('Alpha'), b = object('Beta'); const first = task(a), second = task(b); focus(b, second);
  const result = route('继续修改这个结果', { intent: 'continue', objectId: a.id });
  assert.equal(result.status, 'matched'); assert.equal(result.taskId, first.id); assert.equal(result.objectId, a.id);
  assert.equal(route('继续', { taskId: second.id, objectId: a.id }).status, 'blocked');
});

test('an unambiguous named object cannot be overwritten by an unrelated conversation focus', t => {
  const { object, task, focus, route } = fixture(t);
  const a = object('Alpha'), b = object('Beta'); const first = task(a), second = task(b); focus(b, second);
  const result = route('继续 Alpha 的工作');
  assert.equal(result.status, 'matched'); assert.equal(result.objectId, a.id); assert.equal(result.taskId, first.id);
});

test('reference roles require an explicit target and never grant writes to the source', t => {
  const { object, route } = fixture(t); const a = object('Alpha'), b = object('Beta');
  const unclear = route('参考 Alpha 的方案给 Beta 实现');
  assert.equal(unclear.status, 'ambiguous'); assert.equal(unclear.objectId, null);
  const result = route('参考 Alpha 的方案给 Beta 实现', { intent: 'reference', objectId: b.id, referenceIds: [a.id] });
  assert.equal(result.status, 'new'); assert.equal(result.objectId, b.id); assert.deepEqual(result.referenceIds, [a.id]);
  assert.equal(route('参考这个方案', { intent: 'reference', objectId: b.id }).status, 'unresolved');
});

test('a similar new variant forks into independent work without a writable source object', t => {
  const { object, task, focus, route, workStore, user } = fixture(t);
  const source = object('原方案'), original = task(source, '设计原始海报'); focus(source, original);
  const result = route('做一个类似上次的全新版本');
  assert.equal(result.status, 'new'); assert.equal(result.createObject, true); assert.equal(result.objectId, null);
  assert.equal(result.parentTaskId, original.id); assert.ok(result.referenceIds.includes(source.id));
  assert.deepEqual(result.allowed, ['chat']);
  assert.equal(workStore.getTask(user.id, original.id).version, original.version, 'routing is read-only for original task contents');
});

test('same names across independent document objects remain ambiguous', t => {
  const { object, task, route } = fixture(t);
  const first = object('年度报告', 'document'), second = object('年度报告', 'document'); task(first); task(second);
  const result = route('继续年度报告');
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(new Set(result.objectCandidates.map(item => item.id)), new Set([first.id, second.id]));
});

test('old unassigned history and genuinely missing work are unresolved rather than synthetic continuations', t => {
  const { store, workStore, user, conversation, route } = fixture(t);
  store.appendMessage(conversation.id, 'user', '以前在别处修改过登录表单');
  const result = route('继续之前的任务');
  assert.equal(result.status, 'unresolved'); assert.equal(result.historyStatus, 'unassigned');
  assert.deepEqual(workStore.listTasks(user.id), []);
  assert.throws(() => requireExecutableRoute(result), error => error.code === 'work_route_unresolved');
});

test('retrieval failure does not become an empty candidate set or a new task', t => {
  const { workStore, route } = fixture(t);
  const failedSearch = { ...workStore, listTasks() { throw new Error('retrieval unavailable'); } };
  assert.throws(() => route('继续之前的工作', undefined, undefined, { workStore: failedSearch }), /retrieval unavailable/);
});

test('two conversations retain independent focus and stale focus revisions cannot route writes', t => {
  const { store, workStore, user, conversation, object, task, focus, route } = fixture(t);
  const otherConversation = store.createThread(null, user.id, '另一个窗口'); workStore.ensureConversation(user.id, otherConversation.id);
  const a = object('设计稿'), b = object('研究笔记'); const first = task(a), second = task(b);
  focus(a, first); focus(b, second, otherConversation.id);
  assert.equal(route('继续这个任务').taskId, first.id);
  assert.equal(route('继续这个任务', undefined, otherConversation.id).taskId, second.id);
  const before = workStore.getFocus(user.id, conversation.id).revision;
  focus(b, second);
  assert.throws(() => route('继续这个任务', { focusRevision: before }), error => error.code === 'work_focus_conflict');
  assert.equal(workStore.getFocus(user.id, otherConversation.id).taskId, second.id);
});

test('caller-supplied IDs and references cannot cross ownership boundaries', t => {
  const { workStore, other, object, route } = fixture(t);
  const owned = object('本人对象'); const foreign = workStore.createObject(other.id, { kind: 'research', name: '私密研究' });
  const foreignTask = workStore.createTask(other.id, { goal: '私密任务', objects: [{ id: foreign.id, role: 'target' }] });
  assert.throws(() => route('继续', { taskId: foreignTask.id }), error => error.status === 404);
  assert.throws(() => route('继续', { objectId: foreign.id }), error => error.status === 404);
  assert.throws(() => route('参考实现', { intent: 'reference', objectId: owned.id, referenceIds: [foreign.id] }), error => error.status === 404);
  const result = route('继续之前的工作');
  assert.ok(!JSON.stringify(result).includes('私密'));
});

test('cancelled tasks cannot be continued and stale task revisions cannot override corrections', t => {
  const { workStore, user, object, task, route } = fixture(t); const target = object('原工作'), original = task(target);
  const corrected = workStore.updateTask(user.id, original.id, { expectedVersion: original.version, constraints: ['只读核查'] });
  assert.throws(() => route('继续', { taskId: original.id, taskVersion: original.version }), error => error.code === 'work_task_conflict');
  workStore.cancelTask(user.id, original.id, { expectedVersion: corrected.version });
  assert.equal(route('继续', { taskId: original.id }).status, 'blocked');
});

test('project rename preserves identity while clones remain separate writable objects', t => {
  const { store, workStore, user, task, route } = fixture(t);
  const project = store.createProject(user.id, '仓库旧名称'), clone = store.createProject(user.id, '另一个克隆');
  const before = workStore.ensureProject(user.id, project.id), second = workStore.ensureProject(user.id, clone.id);
  const work = task(before); task(second);
  store.updateProject(project.id, '仓库新名称');
  const after = workStore.ensureProject(user.id, project.id);
  assert.equal(after.id, before.id); assert.notEqual(second.id, after.id);
  assert.equal(route('继续仓库新名称', { taskId: work.id }).objectId, before.id);
});

test('ordinary questions do not create tasks and explicit question clears the proposed focus only', t => {
  const { object, task, focus, route, workStore, user, conversation } = fixture(t);
  const initialCount = workStore.listTasks(user.id).length;
  assert.equal(route('你好，什么是闭包？').status, 'matched'); assert.equal(workStore.listTasks(user.id).length, initialCount);
  const target = object('文档', 'document'), previous = task(target); focus(target, previous);
  const result = route('介绍一下日落', { intent: 'question' });
  assert.equal(result.clearFocus, true); assert.equal(result.taskId, null); assert.deepEqual(result.allowed, ['chat']);
  assert.equal(workStore.getFocus(user.id, conversation.id).taskId, previous.id, 'preview cannot mutate focus');
});

test('document, image assets and research comparisons do not require repositories', t => {
  const { object, task, route } = fixture(t);
  for (const [name, kind] of [['文章', 'document'], ['插画', 'asset'], ['研究', 'research']]) {
    const target = object(name, kind), work = task(target, '继续完善' + name);
    const result = route('继续', { taskId: work.id });
    assert.equal(result.status, 'matched'); assert.equal(result.objectId, target.id); assert.deepEqual(result.allowed, ['chat']);
  }
  const a = object('研究甲', 'research'), b = object('研究乙', 'research');
  const result = route('比较两个结论', { intent: 'compare', referenceIds: [a.id, b.id] });
  assert.equal(result.status, 'new'); assert.equal(result.objectId, null); assert.equal(result.createObject, true);
  assert.deepEqual(new Set(result.referenceIds), new Set([a.id, b.id]));
});

test('deleted targets disappear from search and cannot be routed through a stale explicit ID', t => {
  const { object, task, route, workStore, user } = fixture(t);
  const target = object('已删除内容'), previous = task(target);
  workStore.deleteObject(user.id, target.id, { expectedVersion: target.version });
  assert.throws(() => route('继续', { taskId: previous.id }), error => error.status === 404);
  assert.equal(workStore.listObjects(user.id).some(item => item.id === target.id), false);
  assert.equal(route('继续之前的任务').status, 'unresolved');
});

test('request metadata accepts only bounded declared routing fields', () => {
  assert.deepEqual(validateWorkRequest(undefined), {});
  assert.deepEqual(validateWorkRequest({ referenceIds: ['a', 'a', 'b'] }).referenceIds, ['a', 'b']);
  for (const input of [{ threadId: 'invented' }, { taskId: '../../private' }, { focusRevision: -1 }, { intent: 'deploy-anywhere' }, { referenceIds: Array(7).fill('a') }]) {
    assert.throws(() => validateWorkRequest(input), error => error.status === 400);
  }
});
