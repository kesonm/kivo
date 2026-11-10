import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createStore} from '../server/store.mjs';

const keyA='sk-project-test-only-aaaaaaaaaaaaaaaaaaaaaaaaAAAA';
const keyB='sk-project-test-only-bbbbbbbbbbbbbbbbbbbbbbbbBBBB';
function setup(t){const store=createStore(':memory:',{credentialsKey:randomBytes(32)});t.after(()=>store.close());const admin=store.createUser({username:'admin',displayName:'Admin',passwordHash:'test',role:'admin'});const user=store.createUser({username:'alice',displayName:'Alice',passwordHash:'test'});store.setUserApiKey(user.id,keyA);const project=store.createProject(user.id,'Test'),thread=store.createThread(project.id,user.id);return {store,admin,user,project,thread};}

test('usage records actual totals, preserves key snapshot, and settles idempotently',t=>{
  const {store,user,thread}=setup(t),run=store.createRun(thread.id,user.id);
  const request=store.beginUsage(user.id,run.id,{model:'model',keyLast4:'AAAA'});
  assert.equal(store.getUsage({userId:user.id}).usage[0].totalTokens,null);
  store.settleUsage(request,{status:'completed',inputTokens:100,outputTokens:20,totalTokens:120});
  assert.equal(store.getUser(user.id).usedTokens,120);
  assert.equal(store.settleUsage(request,{status:'completed',inputTokens:999,outputTokens:0,totalTokens:999}).settled,false);
  store.updateRun(run.id,{status:'completed'});const oldCredential=store.getApiKeyMetadata(user.id).credentialId;
  store.setUserApiKey(user.id,keyB);assert.notEqual(store.getApiKeyMetadata(user.id).credentialId,oldCredential);
  const history=store.getUsage({userId:user.id});assert.equal(history.usage[0].keyLast4,'AAAA');assert.equal(history.usage[0].credentialId,oldCredential);assert.equal(history.totals.totalTokens,120);
  const next=store.createRun(thread.id,user.id),nextUsage=store.beginUsage(user.id,next.id,{model:'model',keyLast4:'BBBB'});
  store.settleUsage(nextUsage,{status:'completed',inputTokens:2,outputTokens:3,totalTokens:5});
  assert.deepEqual(new Set(store.getUsage({userId:user.id}).usage.map(r=>r.keyLast4)),new Set(['AAAA','BBBB']));
});

test('unknown and failed requests remain null and never enter actual usage totals',t=>{
  const {store,user,thread}=setup(t),run=store.createRun(thread.id,user.id);
  for(const status of ['unknown','failed']){const request=store.beginUsage(user.id,run.id,{model:'model'});store.settleUsage(request,{status,inputTokens:null,outputTokens:null,totalTokens:null});}
  const result=store.getUsage({userId:user.id});assert.equal(result.totals.totalTokens,0);assert.equal(result.totals.unknownRequests,1);
  assert.ok(result.usage.every(r=>r.totalTokens===null&&r.inputTokens===null&&r.outputTokens===null));assert.equal(store.getUser(user.id).usedTokens,0);
});

test('key changes are rejected during active runs, with no cross-user reads',t=>{
  const {store,user,thread,admin}=setup(t),run=store.createRun(thread.id,user.id);
  assert.throws(()=>store.setUserApiKey(user.id,keyB),e=>e.status===409);assert.throws(()=>store.deleteUserApiKey(user.id),e=>e.status===409);
  assert.throws(()=>store.beginUsage(admin.id,run.id,{model:'model'}),e=>e.status===409);
  assert.equal(store.getUserApiKey(admin.id),null);assert.equal(store.getUserApiKey(user.id),keyA);
  store.updateRun(run.id,{status:'completed'});store.deleteUserApiKey(user.id);assert.equal(store.getUserApiKey(user.id),null);
});

test('encrypted credentials are authenticated to their user and never written in plaintext',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'cw-key-db-'));const filename=path.join(dir,'db.sqlite');const master=randomBytes(32);const store=createStore(filename,{credentialsKey:master});
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const a=store.createUser({username:'alice',displayName:'Alice',passwordHash:'test'}),b=store.createUser({username:'bobby',displayName:'Bob',passwordHash:'test'});store.setUserApiKey(a.id,keyA);store.setUserApiKey(b.id,keyB);
  const encrypted=store.db.prepare('SELECT encrypted_key FROM user_credentials WHERE user_id=?').get(a.id).encrypted_key;
  assert.ok(!encrypted.includes(keyA));store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');assert.equal((await readFile(filename)).includes(Buffer.from(keyA)),false);
  store.db.prepare('UPDATE user_credentials SET encrypted_key=? WHERE user_id=?').run(encrypted,b.id);assert.throws(()=>store.getUserApiKey(b.id),/无法解密/);
  assert.equal(store.getUserApiKey(a.id),keyA);
});

test('legacy schema migration preserves users/projects/history and separates estimated usage',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'cw-migration-'));const filename=path.join(dir,'db.sqlite');const master=randomBytes(32);let store=createStore(filename,{credentialsKey:master});
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const user=store.createUser({username:'alice',displayName:'Alice',passwordHash:'legacy-hash'}),project=store.createProject(user.id,'Existing project'),thread=store.createThread(project.id,user.id),run=store.createRun(thread.id,user.id);
  store.appendMessage(thread.id,'user','Keep this history');const at=new Date().toISOString();
  store.db.prepare('UPDATE users SET balance_tokens=777,used_tokens=999,reserved_tokens=50 WHERE id=?').run(user.id);
  for(const [rid,status,total]of [['r-actual','completed',30],['r-estimate','estimated',969]]){
    store.db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?)').run(rid,user.id,run.id,total,status,at);
    store.db.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?,?)').run('u-'+rid,user.id,run.id,rid,'old-model',total,0,total,status,at);
  }
  store.db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?)').run('r-pending',user.id,run.id,50,'pending',at);
  // Remove only the new tables to recreate a deployed v1 schema; old rows remain.
  store.db.exec('DROP TABLE run_events; DROP TABLE run_details; DROP TABLE request_usage; DROP TABLE user_credentials;');store.close();
  store=createStore(filename,{credentialsKey:master});store.reconcileInterruptedRuns();
  assert.equal(store.getUser(user.id).username,'alice');assert.equal(store.getPasswordHash(user.id),'legacy-hash');assert.equal(store.getProject(project.id).name,'Existing project');assert.equal(store.getMessages(thread.id)[0].content,'Keep this history');
  assert.equal(store.getUsage({userId:user.id}).total,3);assert.equal(store.getUser(user.id).usedTokens,30);assert.equal(store.overview().totalUsedTokens,30);
  assert.equal(store.db.prepare('SELECT balance_tokens FROM users WHERE id=?').get(user.id).balance_tokens,777,'legacy balance is retained but never charged');
  assert.equal(store.getRun(run.id).status,'interrupted');assert.equal(store.getApiKeyMetadata(user.id).configured,false);
  assert.equal(store.getRun(run.id).mode,undefined);assert.deepEqual(store.getRunEvents(run.id),[]);
  assert.equal(store.getUsage({userId:user.id}).totals.unknownRequests,2);store.reconcileInterruptedRuns();assert.equal(store.getUsage({userId:user.id}).total,3);
});

test('restart marks pending usage unknown without charging anything',t=>{
  const {store,user,thread}=setup(t),run=store.createRun(thread.id,user.id);store.beginUsage(user.id,run.id,{model:'model'});
  store.reconcileInterruptedRuns();assert.equal(store.getRun(run.id).status,'interrupted');assert.equal(store.getUsage({userId:user.id}).usage[0].status,'unknown');assert.equal(store.getUsage({userId:user.id}).usage[0].totalTokens,null);
});

test('restart preserves pending checks and records checks in flight as unknown exactly once',t=>{
  const {store,user,thread,project}=setup(t);
  const active=store.createRun(thread.id,user.id,{mode:'cloud',verificationCommand:'npm test'});
  const otherProject=store.createProject(user.id,'Another project');
  const pending=store.createRun(store.createThread(otherProject.id,user.id).id,user.id,{mode:'cloud',verificationCommand:'npm test'});
  const done=store.createRun(store.createThread(null,user.id).id,user.id,{mode:'chat'});
  store.updateRun(done.id,{status:'completed'});
  store.appendRunEvent(active.id,{kind:'verification',source:'cloud',status:'started'},'verification:start',{verification:{status:'running'}});
  store.reconcileInterruptedRuns();
  store.reconcileInterruptedRuns();
  assert.deepEqual(store.getRun(active.id).verification,{command:'npm test',status:'unknown'});
  assert.equal(store.getRun(active.id).interruptReason,'restart');
  assert.equal(store.getRun(active.id).status,'interrupted');
  assert.deepEqual(store.getRun(pending.id).verification,{command:'npm test',status:'not_run'});
  assert.equal(store.getActiveRunForProject(project.id),null);
  assert.deepEqual(store.getRunEvents(active.id).map(({seq,kind,status})=>[seq,kind,status]),[
    [1,'verification','started'],[2,'verification','unknown'],[3,'task','interrupted'],
  ]);
  assert.equal(store.getRun(done.id).status,'completed');
  assert.deepEqual(store.getRunEvents(done.id),[]);
});

test('resume links only one successor and uses an owned user message for the objective',t=>{
  const {store,user,admin,thread,project}=setup(t);
  const old=store.createRun(thread.id,user.id,{mode:'cloud',verificationCommand:'npm test'});
  const input=store.appendMessage(thread.id,'user','Repair the parser');
  const wrongRole=store.appendMessage(thread.id,'assistant','not an objective');
  assert.throws(()=>store.updateRun(old.id,{requestMessageId:wrongRole.id}),e=>e.status===404);
  assert.equal(store.getRunInput(old.id),null);
  store.updateRun(old.id,{requestMessageId:input.id});
  assert.equal(store.getRunInput(old.id),'Repair the parser');
  store.updateRun(old.id,{status:'interrupted',interruptReason:'restart'});
  const otherThread=store.createThread(project.id,user.id);
  const otherOwnerThread=store.createThread(null,admin.id);
  for (const [attemptThread,owner] of [[otherThread,user],[otherOwnerThread,admin]]) {
    assert.throws(()=>store.createRun(attemptThread.id,owner.id,{mode:'cloud',resumedFromRunId:old.id}),e=>e.status===404);
  }
  const successor=store.createRun(thread.id,user.id,{mode:'cloud',resumedFromRunId:old.id});
  assert.equal(store.getResumedRun(old.id).id,successor.id);
  assert.equal(store.getLatestRun(thread.id).resumedFromRunId,old.id);
  store.updateRun(successor.id,{status:'interrupted',interruptReason:'restart',requestMessageId:input.id});
  assert.throws(()=>store.createRun(thread.id,user.id,{mode:'cloud',resumedFromRunId:old.id}),e=>e.code==='run_already_resumed');
  const later=store.createRun(thread.id,user.id,{mode:'cloud',resumedFromRunId:successor.id});
  assert.equal(store.getResumedRun(successor.id).id,later.id);
  store.deleteMessage(input.id);
  assert.equal(store.getRunInput(successor.id),null);
  assert.equal(store.getRun(successor.id).requestMessageId,undefined);
});

test('task timeline is sanitized and advances only when a verification update commits',t=>{
  const {store,user,thread}=setup(t);
  const run=store.createRun(thread.id,user.id,{mode:'cloud',verificationCommand:'npm test'});
  const first=store.appendRunEvent(run.id,{
    kind:'file',source:'cloud',status:'succeeded',summary:`Wrote files with ${keyA}`,
    paths:['/workspace/src/index.js','./README.md','../../root/secret',' /home/user/private','C:\\secret'],
    rawOutput:'private provider response',
  },'file:done');
  assert.deepEqual(first.paths,['src/index.js','README.md']);
  assert.equal(first.summary,'Wrote files with [redacted]');
  assert.equal(first.rawOutput,undefined);
  const verification={kind:'verification',source:'cloud',status:'failed',exitCode:1};
  assert.throws(()=>store.appendRunEvent(run.id,verification,'verify:done',{verification:{status:'invalid'}}),/验收状态无效/);
  assert.deepEqual(store.getRunEvents(run.id),[first]);
  const second=store.appendRunEvent(run.id,verification,'verify:done',{verification:{status:'failed',exitCode:1}});
  assert.equal(second.seq,2);
  assert.deepEqual(store.getRun(run.id).verification,{command:'npm test',status:'failed',exitCode:1});
  assert.equal(store.appendRunEvent(run.id,verification,'verify:done',{verification:{status:'passed',exitCode:0}}),null);
  assert.deepEqual(store.getRun(run.id).verification,{command:'npm test',status:'failed',exitCode:1});
  store.updateRun(run.id,{verification:{status:'unknown',exitCode:null}});
  assert.deepEqual(store.getRun(run.id).verification,{command:'npm test',status:'unknown'});
  assert.deepEqual(store.getRunEvents(run.id,{after:first.seq}),[second]);
});

test('bounded task timelines keep stable cursors when older entries expire',t=>{
  const {store,user,thread}=setup(t);
  const run=store.createRun(thread.id,user.id,{mode:'cloud'});
  for (let i=0;i<513;i++) store.appendRunEvent(run.id,{kind:'tool',source:'cloud',status:'succeeded'});
  const page=store.getRunEvents(run.id,{limit:1000});
  assert.equal(page.length,300);
  assert.equal(page[0].seq,2);
  assert.equal(store.getRunEvents(run.id,{after:512})[0].seq,513);
  assert.deepEqual(store.getRunEvents(run.id,{after:513}),[]);
});

test('admin conversation pagination exposes all history and owner metadata',t=>{
  const {store,user,thread,project}=setup(t);for(let i=0;i<7;i++)store.appendMessage(thread.id,i%2?'assistant':'user',`Message ${i}`);
  const first=store.getAdminThread(thread.id,{messageLimit:3,messageOffset:0,runLimit:2,runOffset:0});assert.equal(first.messages.length,3);assert.equal(first.messagesTotal,7);assert.equal(first.nextMessageOffset,3);assert.equal(first.owner.id,user.id);assert.equal(first.project.id,project.id);
  const last=store.getAdminThread(thread.id,{messageLimit:3,messageOffset:6,runLimit:2,runOffset:0});assert.equal(last.messages[0].content,'Message 6');assert.equal(last.nextMessageOffset,null);
  assert.equal(store.getAdminThreads({userId:user.id,query:'Test'}).total,1);assert.equal(store.getAdminThreads({query:"%' OR 1=1 --"}).total,0);
});

test('project-less threads keep owner/history/usage attribution without changing project counts',t=>{
  const {store,user,admin,thread:projectThread,project}=setup(t);
  const thread=store.createThread(null,user.id,'Ordinary private chat');
  assert.equal(thread.projectId,null);assert.equal(store.overview().projects,1);
  assert.deepEqual(store.listStandaloneThreads(user.id).map(t=>t.id),[thread.id]);
  assert.deepEqual(store.listStandaloneThreads(admin.id),[]);
  assert.deepEqual(store.listThreads(project.id).map(t=>t.id),[projectThread.id]);
  store.appendMessage(thread.id,'user','Hello without a project');
  const run=store.createRun(thread.id,user.id);assert.equal(run.projectId,null);
  assert.throws(()=>store.createRun(thread.id,user.id),e=>e.status===409);
  const usage=store.beginUsage(user.id,run.id,{model:'model',keyLast4:'AAAA'});
  store.settleUsage(usage,{status:'completed',inputTokens:10,outputTokens:5,totalTokens:15});
  store.updateRun(run.id,{status:'completed'});
  const record=store.getUsage({userId:user.id}).usage[0];
  assert.equal(record.projectId,null);assert.equal(record.projectName,null);assert.equal(record.threadId,thread.id);assert.equal(record.threadTitle,thread.title);
  const result=store.getAdminThreads({userId:user.id,query:'Ordinary'});
  assert.equal(result.total,1);assert.equal(result.threads[0].project,null);assert.equal(result.threads[0].owner.id,user.id);
  const history=store.getAdminThread(thread.id);assert.equal(history.project,null);assert.equal(history.messages[0].content,'Hello without a project');assert.equal(history.runs[0].id,run.id);
  store.deleteProject(project.id);assert.equal(store.getThread(projectThread.id),null);assert.equal(store.getThread(thread.id).id,thread.id);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('ordinary chat creation has a per-owner cap independent of project threads',t=>{
  const {store,user,admin}=setup(t);
  for(let i=0;i<500;i++)store.createThread(null,user.id,`Chat ${i}`);
  assert.throws(()=>store.createThread(null,user.id),e=>e.status===409);
  assert.equal(store.listStandaloneThreads(user.id).length,500);
  assert.equal(store.createThread(null,admin.id).projectId,null);
  assert.equal(store.overview().projects,1);
});

test('context history is complete and rejects count or byte overflow instead of truncating',t=>{
  const {store,user}=setup(t),thread=store.createThread(null,user.id);
  store.appendMessage(thread.id,'user','你好');store.appendMessage(thread.id,'assistant','Hello');
  assert.deepEqual(store.getMessagesForContext(thread.id,{maxMessages:2,maxBytes:11}).map(m=>m.content),['你好','Hello']);
  assert.throws(()=>store.getMessagesForContext(thread.id,{maxMessages:1}),e=>e.status===409&&e.code==='context_too_large');
  assert.throws(()=>store.getMessagesForContext(thread.id,{maxBytes:10}),e=>e.status===409&&e.code==='context_too_large');
  assert.equal(store.getMessages(thread.id).length,2);
});

test('nullable-project migration preserves old rows and inbound foreign keys across repeated starts',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'cw-standalone-migration-')),filename=path.join(dir,'db.sqlite'),master=randomBytes(32);
  let store=createStore(filename,{credentialsKey:master});
  t.after(async()=>{store?.close();await rm(dir,{recursive:true,force:true});});
  const user=store.createUser({username:'oldowner',displayName:'Existing owner',passwordHash:'keep-password-hash'});
  store.setUserApiKey(user.id,keyA);const session=store.createSession(user.id);
  const project=store.createProject(user.id,'Existing project'),thread=store.createThread(project.id,user.id,'Existing thread');
  store.updateThread(thread.id,{codexThreadId:'existing-codex-thread'});
  const message=store.appendMessage(thread.id,'user','Existing message'),run=store.createRun(thread.id,user.id);
  const usageId=store.beginUsage(user.id,run.id,{model:'model'});store.settleUsage(usageId,{status:'completed',inputTokens:9,outputTokens:3,totalTokens:12});
  store.updateRun(run.id,{status:'completed',output:'Existing answer',logs:[{text:'Existing tool log'}]});
  // Rebuild only this test fixture into the actually deployed NOT NULL schema.
  store.db.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
    CREATE TABLE threads_previous (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, codex_thread_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO threads_previous(rowid,id,project_id,user_id,title,codex_thread_id,created_at,updated_at)
      SELECT rowid,id,project_id,user_id,title,codex_thread_id,created_at,updated_at FROM threads;
    DROP TABLE threads; ALTER TABLE threads_previous RENAME TO threads;
    CREATE INDEX legacy_threads_title ON threads(title);
    COMMIT; PRAGMA foreign_keys=ON;`);
  assert.equal(store.db.prepare('PRAGMA table_info(threads)').all().find(c=>c.name==='project_id').notnull,1);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  store.close();store=null;store=createStore(filename,{credentialsKey:master});
  assert.equal(store.db.prepare('PRAGMA table_info(threads)').all().find(c=>c.name==='project_id').notnull,0);
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  assert.ok(store.db.prepare("SELECT name FROM sqlite_schema WHERE name='legacy_threads_title'").get());
  for(const table of ['messages','runs'])assert.ok(store.db.prepare(`PRAGMA foreign_key_list(${table})`).all().some(f=>f.from==='thread_id'&&f.table==='threads'));
  assert.equal(store.getUser(user.id).username,'oldowner');assert.equal(store.getPasswordHash(user.id),'keep-password-hash');
  assert.equal(store.getUserApiKey(user.id),keyA);assert.equal(store.getSession(session.token).userId,user.id);
  assert.equal(store.getThread(thread.id).codexThreadId,'existing-codex-thread');assert.equal(store.getMessages(thread.id)[0].id,message.id);
  assert.equal(store.getRun(run.id).output,'Existing answer');assert.deepEqual(store.getRun(run.id).logs,[{text:'Existing tool log'}]);
  assert.equal(store.getUsage({userId:user.id}).usage[0].id,usageId);
  const ordinary=store.createThread(null,user.id,'New ordinary chat');store.appendMessage(ordinary.id,'user','New message');
  store.close();store=null;store=createStore(filename,{credentialsKey:master});
  assert.equal(store.getThread(ordinary.id).projectId,null);assert.equal(store.getMessages(thread.id)[0].id,message.id);
  assert.throws(()=>store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run('bad-fk','missing-thread','user','Bad',new Date().toISOString()),/FOREIGN KEY/);
  store.deleteProject(project.id);assert.equal(store.getThread(thread.id),null);assert.deepEqual(store.getMessages(thread.id),[]);
  assert.equal(store.getRun(run.id).threadId,null);assert.equal(store.getRun(run.id).projectId,null);
  assert.equal(store.getThread(ordinary.id).projectId,null);assert.equal(store.getUsage({userId:user.id}).total,1);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
