import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.mjs';
import { createKibot } from '../server/kibot.mjs';
import { createWorkService } from '../server/work.mjs';

function fixture(t, instant = '2026-11-10T08:00:00.000Z') {
  const store = createStore(':memory:');
  t.after(() => store.close());
  let time = Date.parse(instant);
  const service = createKibot({ store, clock: () => time });
  const alice = store.createUser({ username: 'alice', displayName: 'Alice', passwordHash: 'test', role: 'user' });
  const bob = store.createUser({ username: 'bobby', displayName: 'Bob', passwordHash: 'test', role: 'user' });
  const primary = service.ensure(alice.id).thread;
  function message(role, content, at, metadata = {}, thread = primary) {
    const row = store.appendMessage(thread.id, role, content, metadata);
    store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(at, row.id);
    return { ...row, createdAt: at };
  }
  return { store, service, alice, bob, primary, message, time: value => { time = Date.parse(value); } };
}

test('primary identity is per-user, idempotent and survives service recreation without merging existing chats', t => {
  const { store, service, alice, bob, primary } = fixture(t);
  const old = store.createThread(null, alice.id, 'kibot');
  const original = store.appendMessage(old.id, 'user', 'Preserve this separate conversation');
  assert.equal(service.ensure(alice.id).thread.id, primary.id);
  assert.equal(createKibot({ store }).ensure(alice.id).thread.id, primary.id);
  assert.notEqual(service.ensure(bob.id).thread.id, primary.id);
  assert.equal(primary.isPrimary, true);
  assert.equal(store.getThread(old.id).isPrimary, undefined);
  assert.deepEqual(store.listStandaloneThreads(alice.id).map(row => row.id), [old.id]);
  assert.equal(store.getMessages(old.id)[0].id, original.id);
  assert.equal(store.updateThread(primary.id, { title: 'Changed' }).title, 'kibot');
  assert.equal(service.timeline(alice.id).summaries.length, 0);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('hour threshold is idle-based, and resuming creates a new visible segment without losing the earlier one', t => {
  const { service, alice, message, time } = fixture(t);
  const first = message('user', '检查部署方案，尚未部署', '2026-11-10T06:00:00.000Z');
  const reply = message('assistant', '可以先检查现有配置。', '2026-11-10T06:05:00.000Z');
  time('2026-11-10T07:04:59.999Z');
  assert.deepEqual(service.timeline(alice.id).activeMessageIds, [first.id, reply.id]);
  time('2026-11-10T07:05:00.000Z');
  const folded = service.timeline(alice.id);
  assert.deepEqual(folded.activeMessageIds, []);
  assert.equal(folded.summaries[0].kind, 'segment');
  assert.equal(folded.summaries[0].source, 'extractive');
  assert.equal(folded.summaries[0].title, '检查部署方案，尚未部署');
  assert.ok(!folded.summaries[0].bullets.some(text => text.includes('部署已完成')));
  const next = message('user', '接着讨论导航', '2026-11-10T07:06:00.000Z');
  time('2026-11-10T07:06:01.000Z');
  const resumed = service.timeline(alice.id);
  assert.deepEqual(resumed.activeMessageIds, [next.id]);
  assert.equal(resumed.summaries[0].id, folded.summaries[0].id);
  assert.deepEqual(service.history(alice.id, { summaryId: folded.summaries[0].id }).messages.map(row => row.id), [first.id, reply.id]);
});

test('midnight combines a whole local day; daily details contain every segment and no adjacent-day message', t => {
  const { service, alice, message, time } = fixture(t);
  const a = message('user', '早间记录', '2026-11-09T01:00:00.000Z');
  const b = message('assistant', '早间答复', '2026-11-09T01:02:00.000Z');
  const c = message('user', '晚间记录', '2026-11-09T15:59:59.000Z');
  time('2026-11-09T16:00:00.000Z');
  const page = service.timeline(alice.id, { timeZone: 'Asia/Shanghai' });
  assert.equal(page.summaries.length, 1);
  assert.equal(page.summaries[0].kind, 'day');
  assert.equal(page.summaries[0].date, '2026-11-09');
  assert.equal(page.summaries[0].segmentCount, 2);
  const next = message('user', '新的一天', '2026-11-09T16:00:01.000Z');
  time('2026-11-09T16:00:02.000Z');
  const current = service.timeline(alice.id, { timeZone: 'Asia/Shanghai' });
  assert.deepEqual(current.activeMessageIds, [next.id]);
  assert.equal(current.summaries[0].id, page.summaries[0].id);
  assert.deepEqual(service.history(alice.id, { summaryId: page.summaries[0].id, timeZone: 'Asia/Shanghai' }).messages.map(row => row.id), [a.id, b.id, c.id]);
  const utc = service.timeline(alice.id, { timeZone: 'UTC' });
  assert.ok(utc.summaries.every(item => item.kind === 'segment'));
});

test('IANA DST boundaries use local dates, including the repeated fall-back hour', t => {
  const { service, alice, message, time } = fixture(t);
  message('user', 'Before midnight', '2026-11-01T03:59:00.000Z');
  message('user', 'First 1:30', '2026-11-01T05:30:00.000Z');
  message('user', 'Second 1:30', '2026-11-01T06:30:00.000Z');
  time('2026-11-02T05:00:00.000Z');
  const { summaries } = service.timeline(alice.id, { timeZone: 'America/New_York' });
  assert.deepEqual(summaries.map(item => [item.date, item.messageCount, item.segmentCount]), [['2026-11-01', 2, 2], ['2026-10-31', 1, 1]]);
});

test('in-flight work keeps its entire active segment visible across midnight and long idle until it ends', t => {
  const { store, service, alice, primary, message, time } = fixture(t);
  message('user', 'Earlier completed conversation', '2026-11-09T10:00:00.000Z');
  const request = message('user', 'Long running response', '2026-11-09T15:55:00.000Z');
  const run = store.createRun(primary.id, alice.id, { mode: 'chat' });
  store.updateRun(run.id, { requestMessageId: request.id });
  const response = message('assistant', 'A response across midnight', '2026-11-09T16:10:00.000Z');
  time('2026-11-09T17:30:00.000Z');
  const active = service.timeline(alice.id);
  assert.deepEqual(active.activeMessageIds, [request.id, response.id]);
  assert.equal(active.summaries[0].messageCount, 1);
  store.updateRun(run.id, { status: 'completed' });
  const ended = service.timeline(alice.id);
  assert.deepEqual(ended.activeMessageIds, []);
  assert.equal(ended.summaries.find(item => item.kind === 'day').messageCount, 2);
  assert.equal(ended.summaries.find(item => item.kind === 'segment').messageCount, 1);
});

test('timeline and history cursors are scoped to the owner, group and timezone and page without omission', t => {
  const { service, alice, bob, message, time } = fixture(t);
  for (let day = 1; day <= 4; day++) {
    for (let i = 0; i < 3; i++) message(i % 2 ? 'assistant' : 'user', `Day ${day} message ${i}`, `2026-11-0${day}T01:0${i}:00.000Z`);
  }
  time('2026-11-10T00:00:00.000Z');
  const first = service.timeline(alice.id, { limit: '2' });
  const second = service.timeline(alice.id, { limit: '2', before: first.nextBefore });
  assert.deepEqual([...first.summaries, ...second.summaries].map(item => item.date), ['2026-11-04', '2026-11-03', '2026-11-02', '2026-11-01']);
  assert.equal(second.nextBefore, null);
  const id = first.summaries[0].id;
  const one = service.history(alice.id, { summaryId: id, limit: '1' });
  const rest = service.history(alice.id, { summaryId: id, cursor: one.nextCursor, limit: '2' });
  assert.equal(new Set([...one.messages, ...rest.messages].map(row => row.id)).size, 3);
  assert.equal(rest.nextCursor, null);
  assert.equal(one.total, 3);
  assert.throws(() => service.history(alice.id, { summaryId: first.summaries[1].id, cursor: one.nextCursor }), { code: 'kibot_invalid_query' });
  assert.throws(() => service.history(alice.id, { summaryId: id, timeZone: 'UTC' }), { code: 'kibot_summary_not_found' });
  service.ensure(bob.id);
  assert.throws(() => service.history(bob.id, { summaryId: id }), { code: 'kibot_summary_not_found' });
  for (const query of [{ timeZone: '../etc/passwd' }, { timeZone: ['UTC'] }, { limit: '500' }, { limit: '-1' }, { limit: ['2'] }]) {
    assert.throws(() => service.timeline(alice.id, query), { code: 'kibot_invalid_query' });
  }
  assert.throws(() => service.history(alice.id, { summaryId: 'arbitrary' }), { code: 'kibot_invalid_query' });
});

test('history retains attachment, image artifact, citation and long original message content', t => {
  const { service, alice, message } = fixture(t);
  const input = message('user', '请查看附件', '2026-11-09T06:00:00.000Z', { attachments: [{ name: 'notes.txt', mimeType: 'text/plain', size: 42 }] });
  const answer = message('assistant', '说明'.repeat(300_000), '2026-11-09T06:01:00.000Z', {
    citations: [{ url: 'https://example.com', title: 'Reference', startIndex: 0, endIndex: 2 }],
    artifacts: [{ name: 'image.png', mimeType: 'image/png', data: Buffer.from('image fixture') }],
  });
  const summary = service.timeline(alice.id).summaries[0];
  assert.ok(summary.bullets.join('').length < 600);
  const { messages } = service.history(alice.id, { summaryId: summary.id });
  assert.equal(messages[0].id, input.id);
  assert.equal(messages[0].attachments[0].name, 'notes.txt');
  assert.equal(messages[1].content, answer.content);
  assert.equal(messages[1].artifacts[0].name, 'image.png');
  assert.equal(messages[1].citations[0].title, 'Reference');
});

test('primary conversation cannot be routed into tasks even when its words resemble an imperative', t => {
  const { store, alice, primary } = fixture(t);
  const work = createWorkService({ store, config: { workRoutingMode: 'enforce' }, projects: {} });
  const decision = work.route(alice.id, primary.id, '创建一个网站');
  assert.equal(decision.intent, 'question');
  assert.equal(decision.taskId, null);
  assert.deepEqual(decision.allowed, ['chat']);
  assert.throws(() => work.route(alice.id, primary.id, '执行', { intent: 'new' }), { code: 'kibot_task_separate' });
  assert.equal(work.graph.listTasks(alice.id).length, 0);
});

test('active reads skip thousands of archived bodies and retain same-millisecond message identity', t => {
  const { store, service, alice, primary, message, time } = fixture(t);
  const insert = store.db.prepare('INSERT INTO messages(id,thread_id,role,content,created_at) VALUES(?,?,?,?,?)');
  store.db.exec('BEGIN');
  for (let i = 0; i < 2100; i++) insert.run(`archive-${i}`, primary.id, i % 2 ? 'assistant' : 'user', `Old message ${i}`, '2026-11-01T00:00:00.000Z');
  store.db.exec('COMMIT');
  const a = message('user', 'Current question', '2026-11-10T07:59:00.000Z');
  const b = message('assistant', 'Current answer', '2026-11-10T07:59:00.000Z');
  assert.deepEqual(service.activeMessages(alice.id).map(row => row.id), [a.id, b.id]);
  const today = service.timeline(alice.id);
  const oldId = today.summaries[0].id;
  const first = service.history(alice.id, { summaryId: oldId, limit: '100' });
  const next = service.history(alice.id, { summaryId: oldId, limit: '100', cursor: first.nextCursor });
  assert.equal(first.total, 2100);
  assert.equal(first.messages[0].id, 'archive-0');
  assert.equal(next.messages[0].id, 'archive-100');
  time('2026-11-10T08:59:00.000Z');
  assert.deepEqual(service.activeMessages(alice.id), []);
  const folded = service.timeline(alice.id).summaries[0];
  assert.deepEqual(service.history(alice.id, { summaryId: folded.id }).messages.map(row => row.id), [a.id, b.id]);
});
