import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.mjs';
import { createRunContext } from '../server/run-context.mjs';

test('execution context preserves exact sources and reply bindings across later turns', t=>{
  const store=createStore(':memory:');t.after(()=>store.close());
  const context=createRunContext(store);
  const user=store.createUser({username:'source_user',displayName:'Source user',passwordHash:'unused'});
  const thread=store.createThread(null,user.id,'Earlier discussion');
  const run=store.createRun(thread.id,user.id,{mode:'chat'});
  const reply=store.appendMessage(thread.id,'assistant','Exact earlier answer');
  context.record(run.id,[],{mode:'chat',lifecycle:'request',sessionId:'session-one'});
  context.replies(run.id,[reply.id]);store.updateRun(run.id,{status:'completed'});
  const next=store.createRun(thread.id,user.id,{mode:'chat'});
  context.record(next.id,[{kind:'message',id:reply.id}],{mode:'chat',lifecycle:'request'});
  context.record(next.id,[],{mode:'chat',lifecycle:'replacement'});
  assert.equal(context.read(user.id,next.id).sources[0].excerpt,'Exact earlier answer');
  assert.equal(context.read(user.id,next.id).sources[0].sessionId,'session-one');
  assert.equal(context.read(user.id,next.id).sources[0].sourceRunId,run.id);
  assert.deepEqual(context.links(user.id,thread.id),[{messageId:reply.id,runId:run.id}]);
  store.deleteMessage(reply.id);
  assert.deepEqual(context.read(user.id,next.id).sources,[{kind:'unavailable'}]);
  assert.equal(context.links(user.id,thread.id).length,0);
});

test('source display checks ownership, revocation and unknown legacy provenance', t=>{
  const store=createStore(':memory:');t.after(()=>store.close());const context=createRunContext(store);
  const a=store.createUser({username:'owner_a',displayName:'A',passwordHash:'unused'});
  const b=store.createUser({username:'owner_b',displayName:'B',passwordHash:'unused'});
  const ta=store.createThread(null,a.id,'A'),tb=store.createThread(null,b.id,'B');
  const run=store.createRun(ta.id,a.id,{mode:'chat'});
  assert.equal(context.read(a.id,run.id).recorded,false);
  assert.throws(()=>context.read(b.id,run.id),{status:404});
  assert.throws(()=>context.links(b.id,ta.id),{status:404});
  const hidden=store.appendMessage(tb.id,'assistant','PRIVATE');
  context.record(run.id,[{kind:'message',id:hidden.id}],{mode:'cloud',lifecycle:'new'});
  context.replies(run.id,[hidden.id]);assert.equal(context.links(a.id,ta.id).length,0);
  context.engine(run.id,'native-thread');
  assert.equal(context.read(a.id,run.id).execution.threadId,'native-thread');
  assert.deepEqual(context.read(a.id,run.id).sources,[{kind:'unavailable'}]);
  store.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(a.id);
  assert.throws(()=>context.read(a.id,run.id),{status:404});
});
