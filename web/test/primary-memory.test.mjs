import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.mjs';
import { createWorkStore } from '../server/work-store.mjs';
import { createKibot } from '../server/kibot.mjs';
import { createPrimaryMemory } from '../server/primary-memory.mjs';

function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  store.work = createWorkStore({ store });
  const user = store.createUser({ username: 'memory-user', displayName: 'Memory', passwordHash: 'test' });
  const other = store.createUser({ username: 'memory-other', displayName: 'Other', passwordHash: 'test' });
  const kibot = createKibot({ store });
  const thread = kibot.ensure(user.id).thread, otherThread = kibot.ensure(other.id).thread;
  const memory = createPrimaryMemory({ store });
  function request(text) {
    const message = store.appendMessage(thread.id, 'user', text);
    const run = store.createRun(thread.id, user.id);
    store.updateRun(run.id, { requestMessageId: message.id });
    return { userId: user.id, threadId: thread.id, runId: run.id, messageId: message.id };
  }
  return { store, user, other, thread, otherThread, memory, request };
}

test('primary context stays bounded after 200 messages and retains originals for source lookup', t => {
  const { store, thread, memory, request } = fixture(t);
  for (let i = 0; i < 240; i++) store.appendMessage(thread.id, i % 2 ? 'assistant' : 'user', `archive message ${i}`);
  const ctx = request('现在继续');
  const messages = memory.context({ ...ctx });
  assert.equal(messages.length, 41);
  assert.equal(messages.at(-1).content, '现在继续');
  assert.ok(messages[0].content.includes('"archivedMessages":201'));
  const found = memory.execute({ ...ctx, name: 'kivo_search_history', args: { query: 'archive message 0', before_message_id: null } });
  assert.equal(found.messages[0].content, 'archive message 0');
  assert.equal(store.db.prepare('SELECT count(*) n FROM messages WHERE thread_id=?').get(thread.id).n, 241);
});

test('notes require an owned user source, survive recreation, replace and can be forgotten', t => {
  const { store, thread, memory, request } = fixture(t);
  const ctx = request('页面采用纯白色');
  const note = memory.execute({ ...ctx, name: 'kivo_remember', args: { kind: 'constraint', text: '页面采用纯白色', source_message_id: null, replaces_id: null } }).note;
  const restored = createPrimaryMemory({ store });
  assert.equal(restored.snapshot(ctx.userId).notes[0].sourceMessageId, ctx.messageId);
  const reply = store.appendMessage(thread.id, 'assistant', 'I guessed this');
  assert.throws(() => memory.execute({ ...ctx, name: 'kivo_remember', args: { kind: 'decision', text: 'guess', source_message_id: reply.id, replaces_id: null } }), /用户原话/);
  store.updateRun(ctx.runId, { status: 'completed' });
  const next = request('改成浅灰色');
  memory.execute({ ...next, name: 'kivo_remember', args: { kind: 'constraint', text: '页面采用浅灰色', source_message_id: null, replaces_id: note.id } });
  assert.equal(memory.snapshot(ctx.userId).notes.length, 1);
  assert.equal(memory.snapshot(ctx.userId).notes[0].sourceMessageId, next.messageId);
  memory.forget(ctx.userId, note.id);
  assert.equal(memory.snapshot(ctx.userId).notes.length, 0);
});

test('memory and retrieval cannot cross accounts or accept cancelled run callbacks', t => {
  const { store, memory, request, other, otherThread } = fixture(t);
  const foreign = store.appendMessage(otherThread.id, 'user', 'private foreign decision');
  const ctx = request('Remember my decision');
  assert.throws(() => memory.execute({ ...ctx, name: 'kivo_read_message', args: { message_id: foreign.id, offset: 0 } }), /不存在/);
  assert.throws(() => memory.execute({ ...ctx, name: 'kivo_remember', args: { kind: 'decision', text: 'secret', source_message_id: foreign.id, replaces_id: null } }), /不存在/);
  assert.equal(memory.execute({ ...ctx, name: 'kivo_search_history', args: { query: 'private foreign', before_message_id: null } }).messages.length, 0);
  const note = memory.execute({ ...ctx, name: 'kivo_remember', args: { kind: 'decision', text: 'my decision', source_message_id: null, replaces_id: null } }).note;
  assert.throws(() => memory.forget(other.id, note.id), /不存在/);
  store.updateRun(ctx.runId, { status: 'interrupted' });
  assert.throws(() => memory.execute({ ...ctx, name: 'kivo_search_history', args: { query: '', before_message_id: null } }), /失效/);
});

test('explicit task reference stays associated with its source message and validates ownership', t => {
  const { store, user, other, memory, request } = fixture(t);
  const object = store.work.createObject(user.id, { kind: 'collection', name: 'My work' });
  const task = store.work.createTask(user.id, { goal: 'My goal', objects: [{ id: object.id, role: 'target' }] });
  const foreignObject = store.work.createObject(other.id, { kind: 'collection', name: 'Other work' });
  const foreignTask = store.work.createTask(other.id, { goal: 'Private goal', objects: [{ id: foreignObject.id, role: 'target' }] });
  const ctx = request('继续这个任务');
  assert.throws(() => memory.reference(user.id, ctx.messageId, foreignTask.id));
  memory.reference(user.id, ctx.messageId, task.id);
  assert.equal(memory.referenceFor(user.id, ctx.messageId).id, task.id);
  assert.ok(memory.context(ctx)[0].content.includes(task.id));
});

test('saved constraints are retained in full; oversized new memory is rejected without evicting old notes', t => {
  const { memory, request } = fixture(t);
  const ctx = request('保留这些项目约束，过时的要求由我另行更正');
  let first;
  for(let i=0;i<80;i++){
    try {
      const note=memory.execute({...ctx,name:'kivo_remember',args:{kind:i?'preference':'constraint',text:`要求${i}：`+'保留'.repeat(500),source_message_id:null,replaces_id:null}}).note;
      first??=note;
    }catch(error){assert.equal(error.code,'primary_memory_budget');break;}
  }
  const notes=memory.snapshot(ctx.userId).notes;
  assert.ok(notes.length<80);
  assert.ok(notes.some(note=>note.id===first.id));
  assert.ok(memory.context(ctx)[0].content.includes(first.text));
  memory.execute({...ctx,name:'kivo_forget_memory',args:{note_id:first.id}});
  assert.ok(!memory.snapshot(ctx.userId).notes.some(note=>note.id===first.id));
});

test('history search pages long UTF-8 excerpts within the tool budget without skipping matches', t=>{
  const {store,thread,memory,request}=fixture(t);
  for(let i=0;i<16;i++)store.appendMessage(thread.id,'user',`检索词${i}：`+'汉'.repeat(5000));
  const ctx=request('查找旧记录');
  const ids=new Set();let before=null;
  do {
    const result=memory.execute({...ctx,name:'kivo_search_history',args:{query:'检索词',before_message_id:before}});
    assert.ok(Buffer.byteLength(JSON.stringify(result))<48*1024);
    for(const message of result.messages){assert.ok(!ids.has(message.id));ids.add(message.id);assert.equal(message.incomplete,true);}
    before=result.nextBeforeMessageId;
  }while(before);
  assert.equal(ids.size,16);
});
