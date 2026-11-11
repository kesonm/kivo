import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, AppError } from '../server/store.mjs';
import { createWorkService } from '../server/work.mjs';
import { createKibot } from '../server/kibot.mjs';
import { createSupervisor } from '../server/supervisor.mjs';

function fixture(t, options = {}) {
  const store = createStore(':memory:');
  const user = store.createUser({ username: 'alice', displayName: 'Alice', passwordHash: 'test' });
  const other = store.createUser({ username: 'bobby', displayName: 'Bob', passwordHash: 'test' });
  const config = { workRoutingMode: options.mode ?? 'enforce', model: 'test-model' };
  const workService = createWorkService({ store, config, projects: {} });
  const kibot = createKibot({ store }), primary = kibot.ensure(user.id).thread;
  const message = store.appendMessage(primary.id, 'user', '请分别分析首页布局和菜单文案，保留当前白色风格。');
  const parentRun = store.createRun(primary.id, user.id, { mode: 'chat' });
  store.updateRun(parentRun.id, { requestMessageId: message.id });
  const starts = [], stops = [], pendingApprovals = new Map();
  let startError = null;
  const args = { store, workService, kibot, getApprovals: runId => pendingApprovals.get(runId) ?? [],
    startTask: async input => {
      if (startError) throw startError;
      const { thread, task, userId, text, onRunCreated } = input;
      const target = task.objects.find(item => item.role === 'target');
      const run = store.createRun(thread.id, userId, { mode: 'chat', executionProjectId: target.projectId ?? null });
      onRunCreated(run);
      const msg = store.appendMessage(thread.id, 'user', text);
      store.updateRun(run.id, { requestMessageId: msg.id });
      workService.graph.prepareRun(userId, { conversationId: thread.id, taskId: task.id, runId: run.id,
        expectedVersion: task.version, requestMessageId: msg.id, lifecycle: 'new', environment: { engine: 'chat' } });
      starts.push({ ...input, run });
      return run;
    },
    stopRun: async runId => {
      stops.push(runId);
      if (options.stopError) throw new AppError('stop acknowledgement lost', 504);
      const run = store.getRun(runId);
      store.updateRun(runId, { status: 'interrupted' });
      workService.graph.finishRun(run.userId, runId, { status: 'interrupted', confirmedStopped: true });
    },
  };
  let service = createSupervisor(args);
  t.after(async () => { await service.close(); store.close(); });
  const call = (name, parameters, id = 'call-1') => service.execute({ userId: user.id, threadId: primary.id,
    runId: parentRun.id, messageId: message.id, callId: id, name, args: parameters, model: 'test-model' });
  const delegate = (goal, id = 'call-1', projectId = null) => call('kivo_delegate_task', { goal, projectId, constraints: ['保留白色风格'], acceptance: [] }, id);
  const complete = (index = 0, status = 'completed') => {
    const { run } = starts[index];
    const reply = store.appendMessage(run.threadId, 'assistant', '检查了布局，并给出建议。');
    store.updateRun(run.id, { status, output: reply.content });
    workService.graph.finishRun(user.id, run.id, { status, messageIds: [reply.id], confirmedStopped: true });
  };
  return { store, user, other, workService, kibot, primary, message, parentRun, starts, stops, call, delegate, complete, pendingApprovals,
    get service() { return service; }, error: value => { startError = value; },
    recreate: async () => { await service.close(); service = createSupervisor(args); return service; } };
}

test('delegation is owner-scoped, atomic and idempotent, with separate execution identity', async t => {
  const f = fixture(t);
  const first = await f.delegate('分析首页布局');
  assert.equal(first.task.queueStatus, 'queued');
  assert.notEqual(first.task.conversationId, f.primary.id);
  assert.equal(f.store.getThread(first.task.conversationId).projectId, null);
  assert.equal(f.store.getThread(f.primary.id).isPrimary, true);
  assert.deepEqual(await f.delegate('分析首页布局'), first);
  assert.equal((await f.delegate('分析首页布局', 'same-intent-new-call')).task.id, first.task.id);
  assert.equal(f.service.snapshot(f.user.id).tasks.length, 1);
  await assert.rejects(f.delegate('其他任务'), error => error.code === 'supervisor_call_conflict');
  assert.throws(() => f.service.detail(f.other.id, first.task.id), error => error.status === 404);
  const project = f.store.createProject(f.other.id, '别人的项目');
  await assert.rejects(f.delegate('修改项目', 'wrong-owner', project.id), error => error.status === 404);
  assert.equal(f.store.listStandaloneThreads(f.user.id).length, 1);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('one background worker runs alongside primary, queued tasks proceed and completion notifies once', async t => {
  const f = fixture(t);
  const a = await f.delegate('分析首页布局', 'a');
  await f.delegate('优化菜单文案', 'b');
  await f.service.pump();
  assert.equal(f.starts.length, 1);
  assert.equal(f.store.getActiveRunsForUser(f.user.id).length, 2, 'primary and worker both remain active');
  await f.service.pump();
  assert.equal(f.starts.length, 1);
  f.complete();
  const before = f.service.snapshot(f.user.id).revision;
  await f.service.pump();
  assert.equal(f.starts.length, 2);
  const notifications = () => f.store.getMessages(f.primary.id).filter(item => item.supervisorTaskId === a.task.id);
  assert.equal(notifications().length, 1);
  assert.match(notifications()[0].content, /本次执行已结束/);
  assert.doesNotMatch(notifications()[0].content, /结果已通过验收/);
  assert.notEqual(f.service.snapshot(f.user.id).revision, before);
  await f.service.pump();
  assert.equal(notifications().length, 1);
  assert.equal(f.service.detail(f.user.id, a.task.id).task.status, 'waiting_input');
});

test('follow-up requests wait for the active task and retain source/version boundaries', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('分析首页布局');
  await f.service.pump();
  const follow = await f.call('kivo_continue_task', { taskId: task.id, instruction: '补充手机屏幕建议', expectedVersion: task.version }, 'follow');
  assert.equal(follow.task.pendingFollowUp, true);
  await f.service.pump();
  assert.equal(f.starts.length, 1);
  f.complete();
  await f.service.pump();
  assert.equal(f.starts.length, 2);
  assert.equal(f.starts[1].text, '补充手机屏幕建议');
  assert.equal(f.starts[1].task.id, task.id);
});

test('explicitly referenced older tasks can be read and adopted without mixing the primary thread', async t => {
  const f = fixture(t);
  const thread = f.store.createThread(null, f.user.id, 'Existing');
  const object = f.workService.graph.ensureConversation(f.user.id, thread.id).object;
  const task = f.workService.graph.createTask(f.user.id, { goal: '已有文案任务', objects: [{ id: object.id, role: 'target' }] });
  const detail = await f.call('kivo_get_task', { taskId: task.id });
  assert.equal(detail.task.queueStatus, 'unmanaged');
  const adopted = await f.call('kivo_continue_task', { taskId: task.id, instruction: '继续完善文案', expectedVersion: task.version }, 'adopt');
  assert.notEqual(adopted.task.conversationId, f.primary.id);
  assert.equal(adopted.task.queueStatus, 'queued');
});

test('capacity errors stay queued, unknown startup is not replayed after service recreation', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('排队任务');
  f.error(new AppError('capacity', 429));
  await f.service.pump();
  assert.equal(f.service.detail(f.user.id, task.id).task.queueStatus, 'queued');
  f.store.db.prepare("UPDATE kibot_jobs SET status='dispatching',dispatched_at=? WHERE task_id=?").run(new Date().toISOString(), task.id);
  f.error(null);
  await f.recreate();
  await f.service.pump();
  assert.equal(f.starts.length, 0);
  assert.equal(f.service.detail(f.user.id, task.id).task.queueStatus, 'needs_reconciliation');
  await f.service.pump();
  assert.equal(f.starts.length, 0);
});

test('cancellation stops an active worker and removes queued follow-ups', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('可停止任务');
  await f.service.pump();
  await f.call('kivo_continue_task', { taskId: task.id, instruction: '下一步', expectedVersion: task.version }, 'next');
  await f.service.stop(f.user.id, task.id, { expectedVersion: task.version });
  assert.equal(f.stops.length, 1);
  await f.service.pump();
  assert.equal(f.starts.length, 1);
  assert.equal(f.service.detail(f.user.id, task.id).task.status, 'cancelled');
  assert.equal(f.service.snapshot(f.user.id).counts.running, 0);
});

test('lost stop acknowledgements remain visible as reconciliation, never dispatch follow-up', async t => {
  const f = fixture(t, { stopError: true });
  const { task } = await f.delegate('需要核对任务');
  await f.service.pump();
  const result = await f.service.stop(f.user.id, task.id);
  assert.equal(result.task.queueStatus, 'needs_reconciliation');
  assert.match(result.warning, /仍需核对/);
  await f.service.pump();
  assert.equal(f.starts.length, 1);
});

test('tool dispatch is blocked after primary cancellation and in observation mode', async t => {
  const f = fixture(t);
  f.store.updateRun(f.parentRun.id, { status: 'interrupted' });
  await assert.rejects(f.delegate('不能派发'), error => error.status === 403);
  const off = fixture(t, { mode: 'shadow' });
  await assert.rejects(off.delegate('不能派发'), error => error.code === 'work_observation_only');
  await off.service.pump();
  assert.equal(off.starts.length, 0);
});

test('task changes invalidate queued execution rather than using stale requirements', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('旧要求');
  f.workService.graph.updateTask(f.user.id, task.id, { expectedVersion: task.version, goal: '新的不同要求' });
  await f.service.pump();
  assert.equal(f.starts.length, 0);
  assert.equal(f.service.detail(f.user.id, task.id).task.queueStatus, 'failed');
});

test('manual sends cannot race queued work and manual continuations are observed exactly once', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('有手动继续的工作');
  assert.throws(() => f.service.assertManualTurn(f.user.id, task.conversationId), error => error.code === 'supervisor_already_queued');
  await f.service.pump();
  f.complete();
  await f.service.pump();
  f.service.assertManualTurn(f.user.id, task.conversationId);
  const run = f.store.createRun(task.conversationId, f.user.id, { mode: 'chat' });
  const message = f.store.appendMessage(task.conversationId, 'user', '从任务页面继续完善');
  f.store.updateRun(run.id, { requestMessageId: message.id });
  const freshTask = f.workService.graph.getTask(f.user.id, task.id);
  f.workService.graph.prepareRun(f.user.id, { conversationId: task.conversationId, taskId: task.id, runId: run.id,
    expectedVersion: freshTask.version, requestMessageId: message.id, lifecycle: 'new', environment: { engine: 'chat' } });
  f.service.observeRun(run);
  f.service.observeRun(run);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM kibot_jobs WHERE run_id=?').get(run.id).n, 1);
  assert.equal(f.service.detail(f.user.id, task.id).task.latestRunId, run.id);
  assert.equal(f.service.detail(f.user.id, task.id).task.queueStatus, 'running');
});

test('unknown startup blocks model and direct continuation, cancellation preserves truthful uncertainty', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('结果未知的工作');
  f.store.db.prepare("UPDATE kibot_jobs SET status='dispatching',dispatched_at=? WHERE task_id=?").run(new Date().toISOString(), task.id);
  await f.recreate();
  await f.service.pump();
  assert.throws(() => f.service.assertManualTurn(f.user.id, task.conversationId), error => error.code === 'supervisor_reconciliation_required');
  await assert.rejects(f.call('kivo_continue_task', { taskId: task.id, instruction: '继续', expectedVersion: task.version }, 'blocked'),
    error => error.code === 'supervisor_reconciliation_required');
  const cancelled = await f.service.stop(f.user.id, task.id);
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(cancelled.task.queueStatus, 'needs_reconciliation');
  assert.match(cancelled.warning, /先前执行是否停止/);
  assert.equal(f.stops.length, 0, 'does not claim to stop a process whose identity is unknown');
});

test('real pending approvals notify primary once and disappear from attention when resolved', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('需要操作授权的任务');
  await f.service.pump();
  const run = f.starts[0].run;
  const before = f.service.snapshot(f.user.id).revision;
  f.pendingApprovals.set(run.id, [{ id: 'approval-1', kind: 'command' }]);
  await f.service.pump();
  assert.equal(f.service.detail(f.user.id, task.id).task.status, 'waiting_approval');
  assert.equal(f.service.snapshot(f.user.id).counts.attention, 1);
  assert.notEqual(f.service.snapshot(f.user.id).revision, before);
  const notifications = () => f.store.getMessages(f.primary.id).filter(item => item.supervisorTaskId === task.id);
  assert.equal(notifications().length, 1);
  await f.service.pump();
  assert.equal(notifications().length, 1);
  f.pendingApprovals.set(run.id, []);
  await f.service.pump();
  assert.equal(f.service.snapshot(f.user.id).counts.attention, 0);
  assert.equal(f.service.detail(f.user.id, task.id).task.status, 'running');
});

test('stopping the primary reply does not cancel already accepted independent work', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('已经委派的工作');
  f.store.updateRun(f.parentRun.id, { status: 'interrupted' });
  await f.service.pump();
  assert.equal(f.starts.length, 1);
  assert.equal(f.service.detail(f.user.id, task.id).task.queueStatus, 'running');
});

test('tool responses fit UTF-8 budgets while HTTP detail preserves the full goal', async t => {
  const f = fixture(t);
  const goal = '需求'.repeat(12000);
  const response = await f.delegate(goal);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 48 * 1024);
  assert.ok(response.task.goal.length < goal.length);
  assert.equal(f.service.detail(f.user.id, response.task.id).task.goal, goal);
  const detail = await f.call('kivo_get_task', { taskId: response.task.id }, 'read-long');
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) < 48 * 1024);
});

test('confirmed stopped runs allow an explicit continuation without automatically replaying work', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('中断后需检查的任务');
  await f.service.pump();
  f.complete(0, 'interrupted');
  await f.service.pump();
  assert.equal(f.starts.length, 1, 'no automatic replay after interruption');
  assert.equal(f.service.detail(f.user.id, task.id).task.status, 'needs_reconciliation');
  f.service.assertManualTurn(f.user.id, task.conversationId);
  const resumed = await f.call('kivo_continue_task', { taskId: task.id, instruction: '先核对现有结果，再继续未完成部分', expectedVersion: task.version }, 'explicit-resume');
  assert.equal(resumed.task.queueStatus, 'queued');
  assert.ok(resumed.task.version > task.version);
  await f.service.pump();
  assert.equal(f.starts.length, 2);
});

const attentionAction = task => ({ eventKey: task.attention.key, expectedVersion: task.version });

test('acknowledging a failed event persists without changing execution history or accepting the task', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('失败提醒可以单独确认');
  await f.service.pump();
  f.complete(0, 'failed');
  await f.service.pump();
  const failed = f.service.detail(f.user.id, task.id).task;
  assert.equal(failed.attention.kind, 'failed');
  assert.equal(failed.attention.requiresAction, false);
  assert.equal(failed.attention.canDismiss, true);
  assert.equal(failed.attention.canRetry, true);
  assert.equal(failed.attention.canAbandon, true);
  assert.equal(f.service.snapshot(f.user.id).counts.attention, 1, 'reading details is not an acknowledgment');
  assert.equal(f.service.snapshot(f.user.id).counts.actionRequired, 0);
  assert.equal(f.service.snapshot(f.user.id).counts.updates, 1);
  const action = attentionAction(failed), before = f.service.snapshot(f.user.id).revision;
  const acknowledged = f.service.acknowledge(f.user.id, task.id, action).task;
  assert.equal(acknowledged.status, 'failed');
  assert.equal(acknowledged.queueStatus, 'failed');
  assert.equal(acknowledged.version, failed.version);
  assert.equal(acknowledged.attention.acknowledged, true);
  assert.equal(acknowledged.attention.canRetry, true);
  assert.equal(acknowledged.needsAttention, false);
  assert.equal(f.store.getRun(failed.latestRunId).status, 'failed');
  assert.deepEqual(f.service.acknowledge(f.user.id, task.id, action).task, acknowledged);
  assert.notEqual(f.service.snapshot(f.user.id).revision, before);
  await f.recreate();
  await f.service.pump();
  assert.equal(f.service.snapshot(f.user.id).counts.attention, 0);
  assert.equal(f.service.detail(f.user.id, task.id).task.attention.key, action.eventKey);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM kibot_task_acknowledgments').get().n, 1);
});

test('result acknowledgment only clears the update and does not mark the task as accepted', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('待查看结果');
  await f.service.pump();
  f.complete();
  await f.service.pump();
  const result = f.service.detail(f.user.id, task.id).task;
  assert.equal(result.status, 'waiting_input');
  assert.equal(result.attention.kind, 'result');
  assert.equal(result.attention.canRetry, false);
  assert.equal(f.service.snapshot(f.user.id).counts.updates, 1);
  const evidence = f.service.detail(f.user.id, task.id).evidence;
  const acknowledged = f.service.acknowledge(f.user.id, task.id, attentionAction(result)).task;
  assert.equal(acknowledged.status, 'waiting_input');
  assert.equal(acknowledged.needsAttention, false);
  assert.deepEqual(f.service.detail(f.user.id, task.id).evidence, evidence);
  assert.equal(f.service.snapshot(f.user.id).counts.attention, 0);
});

test('retry is explicit, atomic and idempotent, and a new failure creates a fresh reminder', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('重试保留原授权');
  await f.service.pump();
  f.complete(0, 'failed');
  await f.service.pump();
  const failed = f.service.detail(f.user.id, task.id).task, action = attentionAction(failed);
  f.service.acknowledge(f.user.id, task.id, action);
  const oldRunCount = f.store.db.prepare('SELECT count(*) n FROM runs').get().n;
  const oldAssistantCount = f.store.getMessages(f.primary.id).filter(message => message.role === 'assistant').length;
  const [first, second] = await Promise.all([
    Promise.resolve().then(() => f.service.retry(f.user.id, task.id, action)),
    Promise.resolve().then(() => f.service.retry(f.user.id, task.id, action)),
  ]);
  assert.equal(first.task.queueStatus, 'queued');
  assert.equal(first.task.needsAttention, false);
  assert.equal(second.replayed, true);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM kibot_jobs WHERE task_id=? AND status='queued'").get(task.id).n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM runs').get().n, oldRunCount, 'the click does not invent a Run');
  assert.equal(f.store.getMessages(f.primary.id).filter(message => message.role === 'assistant').length, oldAssistantCount);
  const source = f.store.getMessage(first.task.originMessageId);
  assert.equal(source.role, 'user');
  assert.equal(f.store.db.prepare('SELECT thread_id FROM messages WHERE id=?').get(source.id).thread_id, f.primary.id);
  assert.equal(source.supervisorAction, 'retry');
  assert.equal(source.supervisorTaskId, task.id);
  assert.match(source.content, /重试任务/);
  const queued = f.store.db.prepare('SELECT * FROM kibot_jobs WHERE origin_message_id=?').get(source.id);
  assert.equal(queued.source_run_id, null);
  assert.equal(queued.model, 'test-model');
  await f.recreate();
  assert.equal(f.service.retry(f.user.id, task.id, action).replayed, true);
  await f.service.pump();
  assert.equal(f.starts.length, 2);
  assert.equal(f.service.retry(f.user.id, task.id, action).replayed, true);
  f.complete(1, 'failed');
  await f.service.pump();
  const again = f.service.detail(f.user.id, task.id).task;
  assert.equal(again.attention.kind, 'failed');
  assert.notEqual(again.attention.key, failed.attention.key);
  assert.equal(again.attention.acknowledged, false);
  assert.equal(again.needsAttention, true);
  assert.equal(f.service.snapshot(f.user.id).counts.attention, 1);
  assert.throws(() => f.service.retry(f.user.id, task.id, action), error => error.status === 409);
  assert.throws(() => f.service.acknowledge(f.user.id, task.id, action), error => error.status === 409);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('repeated retries retain full long instructions without accumulating previous retry prompts', async t => {
  const f = fixture(t);
  const goal = '需求'.repeat(12000);
  const { task } = await f.delegate(goal);
  const original = f.store.db.prepare('SELECT prompt FROM kibot_jobs WHERE task_id=?').get(task.id).prompt;
  f.error(new AppError('temporary failure', 502));
  await f.service.pump();
  const firstFailure = f.service.detail(f.user.id, task.id).task;
  f.service.retry(f.user.id, task.id, attentionAction(firstFailure));
  const firstPrompt = f.store.db.prepare('SELECT prompt FROM kibot_jobs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(task.id).prompt;
  assert.ok(firstPrompt.endsWith(original), 'the original request is not truncated by the follow-up input limit');
  assert.ok(firstPrompt.length > 24000);
  await f.service.pump();
  const secondFailure = f.service.detail(f.user.id, task.id).task;
  f.service.retry(f.user.id, task.id, attentionAction(secondFailure));
  const secondPrompt = f.store.db.prepare('SELECT prompt FROM kibot_jobs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(task.id).prompt;
  assert.equal(secondPrompt, firstPrompt);
});

test('ack and retry enforce ownership, event freshness, version and operation capabilities', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('提醒权限');
  f.error(new AppError('failed', 502));
  await f.service.pump();
  const failed = f.service.detail(f.user.id, task.id).task, action = attentionAction(failed);
  for (const operation of ['acknowledge', 'retry']) {
    assert.throws(() => f.service[operation](f.other.id, task.id, action), error => error.status === 404);
    assert.throws(() => f.service[operation](f.user.id, task.id, { ...action, eventKey: 'old-event' }), error => error.status === 409);
    assert.throws(() => f.service[operation](f.user.id, task.id, { ...action, expectedVersion: task.version + 1 }), error => error.status === 409);
    assert.throws(() => f.service[operation](f.user.id, task.id, null), error => error.status === 400);
    assert.throws(() => f.service[operation](f.user.id, task.id, { eventKey: action.eventKey }), error => error.status === 400);
  }
  f.workService.graph.updateTask(f.user.id, task.id, { expectedVersion: task.version, goal: '全新任务要求' });
  const changed = f.service.detail(f.user.id, task.id).task;
  assert.equal(changed.attention.canRetry, false, 'cannot replay superseded requirements');
  assert.throws(() => f.service.retry(f.user.id, task.id, attentionAction(changed)), error => error.status === 409);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM kibot_task_retries').get().n, 0);
});

test('cancelling a failed task clears attention without erasing its failed execution', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('放弃失败任务');
  await f.service.pump();
  f.complete(0, 'failed');
  await f.service.pump();
  const failed = f.service.detail(f.user.id, task.id).task;
  const stopped = await f.service.stop(f.user.id, task.id, { expectedVersion: failed.version });
  assert.equal(stopped.task.status, 'cancelled');
  assert.equal(stopped.task.queueStatus, 'cancelled');
  assert.equal(stopped.task.attention, null);
  assert.equal(stopped.task.needsAttention, false);
  assert.equal(f.service.snapshot(f.user.id).counts.attention, 0);
  assert.equal(f.store.db.prepare('SELECT status FROM kibot_jobs WHERE task_id=?').get(task.id).status, 'failed');
  assert.equal(f.store.getRun(failed.latestRunId).status, 'failed');
  await f.recreate();
  await f.service.pump();
  assert.equal(f.service.snapshot(f.user.id).counts.attention, 0);
});

test('approval and unknown-execution reminders cannot be dismissed or retried', async t => {
  const f = fixture(t, { stopError: true });
  const { task } = await f.delegate('仍需实际处理');
  await f.service.pump();
  f.pendingApprovals.set(f.starts[0].run.id, [{ id: 'approval-action', kind: 'command' }]);
  const approval = f.service.detail(f.user.id, task.id).task;
  assert.equal(approval.attention.kind, 'approval');
  assert.equal(approval.attention.requiresAction, true);
  assert.equal(f.service.snapshot(f.user.id).counts.actionRequired, 1);
  assert.equal(f.service.snapshot(f.user.id).counts.updates, 0);
  assert.throws(() => f.service.acknowledge(f.user.id, task.id, attentionAction(approval)), error => error.code === 'supervisor_attention_required');
  assert.throws(() => f.service.retry(f.user.id, task.id, attentionAction(approval)), error => error.code === 'supervisor_task_unavailable');
  const cancelled = await f.service.stop(f.user.id, task.id, { expectedVersion: approval.version });
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(cancelled.task.attention.kind, 'reconciliation');
  assert.equal(cancelled.task.needsAttention, true);
  for (const blocked of [approval, cancelled.task]) {
    assert.equal(blocked.attention.canDismiss, false);
    assert.equal(blocked.attention.canRetry, false);
    assert.equal(blocked.attention.canAbandon, false);
    for (const operation of ['acknowledge', 'retry']) {
      assert.throws(() => f.service[operation](f.user.id, task.id, attentionAction(blocked)), error => error.status === 409);
    }
  }
  assert.equal(f.service.snapshot(f.user.id).counts.attention, 1);
});

test('explicit acceptance supersedes an older failed queue record but never hides unknown execution', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('验收现有结果');
  await f.service.pump();
  f.complete();
  await f.service.pump();
  const artifact = f.service.detail(f.user.id, task.id).artifacts[0];
  await f.call('kivo_continue_task', { taskId: task.id, instruction: '补充检查', expectedVersion: task.version }, 'follow-up');
  f.error(new AppError('后续执行启动失败', 502));
  await f.service.pump();
  assert.equal(f.service.detail(f.user.id, task.id).task.queueStatus, 'failed');
  f.workService.graph.acceptTask(f.user.id, task.id, { expectedVersion: task.version, artifactId: artifact.id });
  const accepted = f.service.detail(f.user.id, task.id).task;
  assert.equal(accepted.status, 'succeeded');
  assert.equal(accepted.queueStatus, 'completed');
  assert.equal(accepted.summary, '结果已通过验收');
  assert.equal(accepted.needsAttention, false);
  assert.equal(f.service.snapshot(f.user.id).counts.attention, 0);
  f.store.db.prepare("UPDATE kibot_jobs SET status='needs_reconciliation' WHERE task_id=? AND run_id IS NULL").run(task.id);
  const uncertain = f.service.detail(f.user.id, task.id).task;
  assert.equal(uncertain.queueStatus, 'needs_reconciliation');
  assert.equal(uncertain.attention.kind, 'reconciliation');
  assert.equal(uncertain.needsAttention, true);
});

test('cancellation does not warn about stale uncertainty after execution has been confirmed stopped', async t => {
  const f = fixture(t);
  const { task } = await f.delegate('已确认停止的旧执行');
  await f.service.pump();
  f.complete(0, 'interrupted');
  f.store.db.prepare("UPDATE kibot_jobs SET status='needs_reconciliation' WHERE task_id=?").run(task.id);
  const stopped = await f.service.stop(f.user.id, task.id);
  assert.equal(stopped.task.status, 'cancelled');
  assert.equal(stopped.task.queueStatus, 'cancelled');
  assert.equal(stopped.task.needsAttention, false);
  assert.equal(stopped.warning, undefined);
});
