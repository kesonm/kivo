import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createStore } from '../server/store.mjs';
import { createKibot } from '../server/kibot.mjs';
import { createThreadTitles } from '../server/thread-titles.mjs';

const model = 'test-title-model';
const usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };
const answer = (title, extra = {}) => Response.json({ status: 'completed', usage,
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: title }] }], ...extra });
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Title test timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function fixture(t) {
  const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
  const users = ['alpha', 'beta', 'gamma'].map(name => {
    const user = store.createUser({ username: 'titles_' + name, displayName: name, passwordHash: 'unused' });
    store.setUserApiKey(user.id, 'sk-title-test-' + name + '-0123456789'); return user;
  });
  const calls = [], reports = [];
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    calls.push({ url, payload: JSON.parse(options.body), authorization: options.headers.authorization, resolve, reject });
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const service = createThreadTitles({ store, config: {}, fetchImpl, report: item => reports.push(item) });
  t.after(async () => { await service.close(); store.close(); });
  function complete(thread = store.createThread(null, users[0].id, '首条消息'), text = 'USER_PRIVATE_ALPHA 帮我部署网站', reply = '我们检查了网站的部署配置。') {
    const message = store.appendMessage(thread.id, 'user', text);
    const run = store.createRun(thread.id, thread.userId);
    store.updateRun(run.id, { requestMessageId: message.id });
    store.appendMessage(thread.id, 'assistant', reply);
    store.updateRun(run.id, { status: 'completed', output: reply });
    return { run, thread };
  }
  const enqueue = run => service.enqueue({ runId: run.id, model });
  return { store, users, calls, reports, service, fetchImpl, complete, enqueue };
}

test('each completed turn refreshes a semantic title with context and records separate actual usage', async t => {
  const f = fixture(t), first = f.complete();
  assert.equal(f.enqueue(first.run), true); assert.equal(f.store.getThread(first.thread.id).titlePending, true);
  assert.equal(f.enqueue(first.run), false);
  await until(() => f.calls.length === 1);
  const call = f.calls[0];
  assert.equal(call.url, 'https://api.openai.com/v1/responses'); assert.equal(call.payload.model, model);
  assert.equal(call.payload.store, false); assert.equal(call.payload.stream, false);
  assert.equal(Object.hasOwn(call.payload, 'max_output_tokens'), false); assert.equal(Object.hasOwn(call.payload, 'tools'), false);
  call.resolve(answer('网站部署配置梳理'));
  await until(() => f.store.getTitleJob(first.run.id).status === 'completed');
  assert.equal(f.store.getThread(first.thread.id).title, '网站部署配置梳理');
  assert.equal(f.store.getThread(first.thread.id).titlePending, undefined);
  assert.equal(f.store.getThread(first.thread.id).titleUpdatedAt, f.store.getTitleJob(first.run.id).updatedAt);
  const second = f.complete(first.thread, '继续，完善会话标题', '每轮对话后更新主题标题。');
  f.enqueue(second.run); await until(() => f.calls.length === 2);
  const context = JSON.parse(f.calls[1].payload.input[0].content);
  assert.equal(context.previous_title, '网站部署配置梳理');
  assert.ok(context.recent_conversation.some(item => item.content.includes('部署配置')));
  assert.ok(context.recent_conversation.some(item => item.content.includes('完善会话标题')));
  f.calls[1].resolve(answer('会话标题自动总结优化'));
  await until(() => f.store.getTitleJob(second.run.id).status === 'completed');
  assert.equal(f.store.getThread(first.thread.id).title, '会话标题自动总结优化');
  assert.equal(f.store.getRun(first.run.id).status, 'completed'); assert.equal(f.store.getRun(second.run.id).status, 'completed');
  const records = f.store.getUsage({ userId: first.thread.userId }).usage;
  assert.equal(records.length, 2); assert.ok(records.every(row => row.source === 'thread_title' && row.totalTokens === 120));
  assert.equal(f.enqueue(first.run), false); assert.equal(f.enqueue(second.run), false);
  assert.throws(() => f.store.beginUsage(first.thread.userId, second.run.id, { model }), /任务已结束/);
});

test('title requests use only the conversation owner key and never rename kibot', async t => {
  const f = fixture(t), a = f.complete(), b = f.complete(f.store.createThread(null, f.users[1].id, 'Beta'), 'USER_PRIVATE_BETA 数据整理', '整理数据格式');
  const primary = createKibot({ store: f.store }).ensure(f.users[0].id).thread;
  const p = f.complete(primary);
  assert.equal(f.enqueue(p.run), false); assert.equal(f.store.getThread(primary.id).title, 'kibot');
  f.enqueue(a.run); f.enqueue(b.run); await until(() => f.calls.length === 2);
  assert.equal(f.calls[0].authorization, 'Bearer sk-title-test-alpha-0123456789');
  assert.equal(f.calls[1].authorization, 'Bearer sk-title-test-beta-0123456789');
  assert.ok(!JSON.stringify(f.calls[0].payload).includes('USER_PRIVATE_BETA'));
  assert.ok(!JSON.stringify(f.calls[1].payload).includes('USER_PRIVATE_ALPHA'));
  f.calls[0].resolve(answer('网站部署')); f.calls[1].resolve(answer('数据整理'));
  await until(() => f.store.getTitleJob(b.run.id).status === 'completed');
  assert.equal(f.store.getThread(a.thread.id).title, '网站部署');
  assert.equal(f.store.getThread(b.thread.id).title, '数据整理');
});

test('title failure preserves the conversation and partial or malformed titles are not applied', async t => {
  const f = fixture(t), first = f.complete();
  f.enqueue(first.run); await until(() => f.calls.length === 1);
  f.calls[0].reject(new Error('PRIVATE_PROVIDER_BODY sk-sensitive-key'));
  await until(() => f.store.getTitleJob(first.run.id).status === 'failed');
  assert.equal(f.store.getThread(first.thread.id).title, '首条消息');
  assert.equal(f.store.getRun(first.run.id).status, 'completed'); assert.equal(f.store.getRun(first.run.id).error, null);
  assert.equal(f.store.getUsage({ userId: first.thread.userId }).usage[0].status, 'unknown');
  assert.ok(!JSON.stringify(f.reports).includes('PRIVATE_PROVIDER_BODY')); assert.ok(!JSON.stringify(f.reports).includes('sensitive'));
  for (const [title, extra] of [['未完成标题', { status: 'incomplete' }], ['多行\n解释', {}], ['长'.repeat(61), {}]]) {
    const next = f.complete(first.thread), index = f.calls.length; f.enqueue(next.run);
    await until(() => f.calls.length > index); f.calls[index].resolve(answer(title, extra));
    await until(() => f.store.getTitleJob(next.run.id).status === 'failed');
    assert.equal(f.store.getThread(first.thread.id).title, '首条消息');
    assert.equal(f.store.getThread(first.thread.id).titlePending, undefined);
  }
});

test('new turns and newly appended messages prevent stale titles from replacing current context', async t => {
  const f = fixture(t), first = f.complete(); f.enqueue(first.run); await until(() => f.calls.length === 1);
  const second = f.complete(first.thread, '现在改为优化登录界面', '检查登录表单'); f.enqueue(second.run);
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve(answer('过时的网站部署标题'));
  await until(() => f.calls.length === 2);
  assert.equal(f.store.getTitleJob(first.run.id).status, 'skipped'); assert.equal(f.store.getThread(first.thread.id).title, '首条消息');
  f.store.appendMessage(first.thread.id, 'user', '还有一个新问题');
  assert.equal(f.store.getThread(first.thread.id).titlePending, undefined);
  f.calls[1].resolve(answer('过时的登录界面标题'));
  await until(() => f.store.getTitleJob(second.run.id).status === 'skipped');
  assert.equal(f.store.getThread(first.thread.id).title, '首条消息');
});

test('account revocation and manual title changes prevent applying in-flight results', async t => {
  const f = fixture(t), first = f.complete(); f.enqueue(first.run); await until(() => f.calls.length === 1);
  f.store.updateThread(first.thread.id, { title: '手动指定的标题' });
  f.calls[0].resolve(answer('不应覆盖的自动标题')); await until(() => f.store.getTitleJob(first.run.id).status === 'skipped');
  const next = f.complete(first.thread); f.enqueue(next.run); await until(() => f.calls.length === 2);
  f.store.updateUser(first.thread.userId, { disabled: true }, f.users[1].id);
  f.calls[1].resolve(answer('停用后不应更新')); await until(() => f.store.getTitleJob(next.run.id).status === 'skipped');
  assert.equal(f.store.getThread(first.thread.id).title, '手动指定的标题');
  assert.equal(f.enqueue(f.complete(first.thread).run), false);
});

test('credential rotation retains the original usage attribution', async t => {
  const f = fixture(t), first = f.complete(); f.enqueue(first.run); await until(() => f.calls.length === 1);
  const old = f.store.getUsage({ userId: first.thread.userId }).usage[0];
  f.store.setUserApiKey(first.thread.userId, 'sk-rotated-title-key-9876543210');
  f.calls[0].resolve(answer('网站部署与配置')); await until(() => f.store.getTitleJob(first.run.id).status === 'completed');
  const saved = f.store.getUsage({ userId: first.thread.userId }).usage[0];
  assert.equal(saved.credentialId, old.credentialId); assert.equal(saved.keyLast4, '6789'); assert.equal(saved.totalTokens, 120);
});

test('concurrency is bounded and shutdown abandons pending jobs without replaying requests', async t => {
  const f = fixture(t);
  const jobs = f.users.map(user => f.complete(f.store.createThread(null, user.id, '并发测试')));
  jobs.forEach(item => f.enqueue(item.run)); await until(() => f.calls.length === 2);
  assert.equal(f.store.getTitleJob(jobs[2].run.id).status, 'queued');
  await f.service.close();
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.getTitleJob(jobs[0].run.id).status, 'unknown');
  assert.equal(f.store.getTitleJob(jobs[1].run.id).status, 'unknown');
  assert.equal(f.store.getTitleJob(jobs[2].run.id).status, 'skipped');
  assert.ok(jobs.every(item => f.store.getThread(item.thread.id).titlePending === undefined));
  assert.equal(f.enqueue(jobs[2].run), false);
});

test('restart marks interrupted title usage unknown and never retries previously dispatched jobs', async t => {
  const f = fixture(t), first = f.complete(); await f.service.close();
  f.store.enqueueTitleJob({ runId: first.run.id, model });
  const usageId = f.store.beginTitleUsage(first.run.id, { keyLast4: '6789' }); assert.ok(usageId);
  const restarted = createThreadTitles({ store: f.store, config: {}, fetchImpl: f.fetchImpl });
  assert.equal(f.store.getTitleJob(first.run.id).status, 'unknown');
  assert.equal(f.store.getUsage({ userId: first.thread.userId }).usage[0].status, 'unknown');
  assert.equal(restarted.enqueue({ runId: first.run.id, model }), false); assert.equal(f.calls.length, 0);
  await restarted.close();
});
