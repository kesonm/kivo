import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createApp,hashPassword,verifyPassword,loadConfig} from '../server/app.mjs';
import {createStore} from '../server/store.mjs';
import {once} from 'node:events';

const password='Test-user-password-2026';
const keyA='sk-project-test-only-aaaaaaaaaaaaaaaaaaaaaaaaAAAA';
const keyB='sk-project-test-only-bbbbbbbbbbbbbbbbbbbbbbbbBBBB';
async function fixture(t,{startError=false,trustProxy=false,forbidProjectCalls=false,startImplementation}={}) {
  const store=createStore(':memory:',{credentialsKey:randomBytes(32)});
  const admin=store.createUser({username:'admin',displayName:'Admin',passwordHash:await hashPassword(password),role:'admin'});
  const startCalls=[],projectCalls=[];
  const runtime={providerConfigured:userId=>Boolean(userId&&store.getApiKeyMetadata(userId).configured),async start(args){startCalls.push(args);if(startError)throw Object.assign(new Error('Runner unavailable'),{status:503});if(startImplementation)await startImplementation(args);},async interrupt(id){store.updateRun(id,{status:'interrupted'});},subscribe:()=>()=>{},close(){}};
  const projectCall=name=>{projectCalls.push(name);if(forbidProjectCalls)throw new Error('Ordinary chat must not use project files');};
  const projects={async initialize(){projectCall('initialize');},async remove(){projectCall('remove');},async withLock(id,fn){projectCall('withLock');return fn();},async tree(){projectCall('tree');return {files:[]};},async readFile(id,p){projectCall('readFile');return {path:p,content:'test'};}};
  const app=createApp({store,runtime,projects,config:{dataDir:'/tmp/cw-test',publicOrigin:'https://workspace.example',cookieSecure:false,model:'model',trustProxy}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function client(){
    let cookie='',csrf='';
    const request=async(method,url,body,headers={})=>{
      const response=await fetch(base+url,{method,headers:{cookie,'Content-Type':'application/json','X-CSRF-Token':csrf,Origin:'https://workspace.example',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const updated=response.headers.get('set-cookie');if(updated)cookie=updated.split(';')[0];
      const data=await response.json();if(data.csrfToken)csrf=data.csrfToken;return {status:response.status,data,headers:response.headers};
    };
    await request('GET','/api/session');return {request,getCookie:()=>cookie,getCsrf:()=>csrf};
  }
  return {store,admin,client,startCalls,projectCalls};
}
async function register(client,username){const r=await client.request('POST','/api/auth/register',{username,password,displayName:username});assert.equal(r.status,201);return r.data.user;}
async function loginAdmin(client){const r=await client.request('POST','/api/auth/login',{username:'admin',password});assert.equal(r.status,200);}
async function projectThread(client){const project=(await client.request('POST','/api/projects',{name:'Private project'})).data.project;const thread=(await client.request('POST',`/api/projects/${project.id}/threads`,{})).data.thread;return {project,thread};}

test('password hashing is salted and verifies without retaining plaintext',async()=>{
  const a=await hashPassword(password),b=await hashPassword(password);assert.notEqual(a,b);assert.ok(!a.includes(password));assert.equal(await verifyPassword(password,a),true);assert.equal(await verifyPassword('incorrect password',a),false);
});

test('registration has no quota fields, secure session cookies, and no role injection',async t=>{
  const {client}=await fixture(t);const c=await client();
  const r=await c.request('POST','/api/auth/register',{username:'alice',password,displayName:'Alice',role:'admin',balanceTokens:999999});
  assert.equal(r.status,201);assert.equal(r.data.user.role,'user');assert.equal('balanceTokens'in r.data.user,false);assert.equal(r.data.user.apiKeyConfigured,false);assert.equal('passwordHash'in r.data.user,false);
  assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.match(r.headers.get('set-cookie'),/SameSite=Strict/);
  assert.equal((await c.request('GET','/api/admin/users')).status,403);assert.equal((await c.request('POST','/api/recharge',{amount:1000})).status,404);
});

test('CSRF and cross-origin mutations are rejected, including personal key changes',async t=>{
  const {client}=await fixture(t);const a=await client(),b=await client();
  assert.equal((await a.request('POST','/api/auth/login',{username:'admin',password},{'X-CSRF-Token':b.getCsrf()})).status,403);
  assert.equal((await a.request('POST','/api/auth/login',{username:'admin',password},{Origin:'https://attacker.example'})).status,403);
  await loginAdmin(a);assert.equal((await a.request('PUT','/api/account/api-key',{apiKey:keyA},{'X-CSRF-Token':''})).status,403);
});

test('personal keys are isolated and every public/admin response excludes plaintext',async t=>{
  const {client,store}=await fixture(t);const alice=await client(),bob=await client(),admin=await client();const a=await register(alice,'alice'),b=await register(bob,'bobby');await loginAdmin(admin);
  assert.equal((await alice.request('PUT','/api/account/api-key',{apiKey:keyA})).status,200);
  const metadata=await alice.request('GET','/api/account/api-key');assert.deepEqual(Object.keys(metadata.data).sort(),['configured','last4','updatedAt']);assert.equal(metadata.data.last4,'AAAA');
  assert.equal((await bob.request('GET','/api/account/api-key')).data.configured,false);
  assert.equal((await bob.request('PUT','/api/account/api-key',{apiKey:keyB,userId:a.id})).status,400);
  assert.equal((await admin.request('GET',`/api/admin/users/${a.id}/api-key`)).status,404);
  const session=await alice.request('GET','/api/session');assert.equal(session.data.providerConfigured,true);assert.equal(session.data.user.keyLast4,'AAAA');
  for(const [c,url]of [[alice,'/api/session'],[alice,'/api/account/api-key'],[admin,'/api/admin/users'],[admin,'/api/admin/audit'],[admin,'/api/admin/overview']]){
    const result=await c.request('GET',url);assert.ok(!JSON.stringify(result.data).includes(keyA));assert.ok(!JSON.stringify(result.data).includes('encrypted_key'));
  }
  assert.equal(store.getUserApiKey(a.id),keyA);assert.equal(store.getUserApiKey(b.id),null);
  assert.equal((await alice.request('DELETE','/api/account/api-key',{})).data.configured,false);assert.equal((await alice.request('GET','/api/session')).data.providerConfigured,false);
});

test('active runs block personal key replacement and deletion',async t=>{
  const {client,store}=await fixture(t);const c=await client();const user=await register(c,'alice');await c.request('PUT','/api/account/api-key',{apiKey:keyA});const {thread}=await projectThread(c),run=store.createRun(thread.id,user.id);
  assert.equal((await c.request('PUT','/api/account/api-key',{apiKey:keyB})).status,409);assert.equal((await c.request('DELETE','/api/account/api-key',{})).status,409);assert.equal(store.getUserApiKey(user.id),keyA);
  store.updateRun(run.id,{status:'completed'});assert.equal((await c.request('PUT','/api/account/api-key',{apiKey:keyB})).data.last4,'BBBB');
});

test('every project, thread and run read/write stays scoped to its owner',async t=>{
  const {client,store}=await fixture(t);const alice=await client(),bob=await client();const user=await register(alice,'alice');await register(bob,'bob');const {project,thread}=await projectThread(alice),run=store.createRun(thread.id,user.id);
  for(const [method,url,body]of [
    ['GET',`/api/projects/${project.id}/tree`],['GET',`/api/projects/${project.id}/file?path=README.md`],
    ['PATCH',`/api/projects/${project.id}`,{name:'Stolen'}],['DELETE',`/api/projects/${project.id}`,{}],
    ['PUT',`/api/projects/${project.id}/file`,{path:'README.md',content:'Stolen'}],
    ['GET',`/api/projects/${project.id}/threads`],['GET',`/api/threads/${thread.id}`],
    ['POST',`/api/threads/${thread.id}/turns`,{text:'Steal'}],['GET',`/api/runs/${run.id}/events`],
    ['POST',`/api/runs/${run.id}/interrupt`,{}]
  ])assert.equal((await bob.request(method,url,body)).status,404,url);
});

test('administration is read-only and old mutation endpoints do not exist',async t=>{
  const {client,store}=await fixture(t);const c=await client(),admin=await client();const user=await register(c,'alice');await loginAdmin(admin);
  for(const [method,url,body]of [
    ['POST',`/api/admin/users/${user.id}/quota`,{deltaTokens:10000,note:'old API'}],
    ['PATCH',`/api/admin/users/${user.id}`,{disabled:true}],
    ['POST',`/api/admin/users/${user.id}/password`,{password:'Reset-password-2026'}],
  ])assert.equal((await admin.request(method,url,body)).status,404);
  assert.equal(store.getUser(user.id).disabled,false);
  for(const url of ['/api/admin/users','/api/admin/usage','/api/admin/threads','/api/admin/overview','/api/admin/audit'])assert.equal((await c.request('GET',url)).status,403);
});

test('a personal key allows zero-legacy-balance tasks, while old quota never substitutes for a key',async t=>{
  const {client,store}=await fixture(t);const c=await client();const user=await register(c,'alice'),{thread}=await projectThread(c);
  store.db.prepare('UPDATE users SET balance_tokens=999999 WHERE id=?').run(user.id);
  const missing=await c.request('POST',`/api/threads/${thread.id}/turns`,{text:'Hello'});assert.equal(missing.status,409);assert.equal(missing.data.code,'api_key_required');assert.equal(store.getMessages(thread.id).length,0);
  await c.request('PUT','/api/account/api-key',{apiKey:keyA});store.db.prepare('UPDATE users SET balance_tokens=0 WHERE id=?').run(user.id);
  const accepted=await c.request('POST',`/api/threads/${thread.id}/turns`,{text:'Hello'});assert.equal(accepted.status,202);assert.equal(store.getMessages(thread.id)[0].content,'Hello');
});

test('runner startup failures roll back the user message',async t=>{
  const {client,store}=await fixture(t,{startError:true});const c=await client();await register(c,'alice');await c.request('PUT','/api/account/api-key',{apiKey:keyA});const {thread}=await projectThread(c);
  assert.equal((await c.request('POST',`/api/threads/${thread.id}/turns`,{text:'Hello'})).status,503);assert.equal(store.getMessages(thread.id).length,0);assert.equal(store.getLatestRun(thread.id).status,'failed');
});

test('user usage stays private; admin usage/history is paginated and audited',async t=>{
  const {client,store}=await fixture(t);const alice=await client(),bob=await client(),admin=await client();const a=await register(alice,'alice');await register(bob,'bobby');await loginAdmin(admin);await alice.request('PUT','/api/account/api-key',{apiKey:keyA});const {thread}=await projectThread(alice);
  for(let i=0;i<5;i++)store.appendMessage(thread.id,i%2?'assistant':'user',`Private message ${i}`);
  const run=store.createRun(thread.id,a.id),usage=store.beginUsage(a.id,run.id,{model:'model',keyLast4:'AAAA'});store.settleUsage(usage,{status:'completed',inputTokens:12,outputTokens:8,totalTokens:20});store.updateRun(run.id,{status:'completed'});
  assert.equal((await bob.request('GET','/api/account/usage')).data.total,0);assert.equal((await alice.request('GET','/api/account/usage')).data.totals.totalTokens,20);
  const list=await admin.request('GET',`/api/admin/threads?userId=${a.id}&query=Private&limit=1&offset=0`);assert.equal(list.data.total,1);assert.equal(list.data.threads[0].owner.username,'alice');
  const detail=await admin.request('GET',`/api/admin/threads/${thread.id}?messageLimit=2&messageOffset=2&runLimit=1`);assert.equal(detail.data.messages[0].content,'Private message 2');assert.equal(detail.data.messagesTotal,5);assert.equal(detail.data.nextMessageOffset,4);
  const records=await admin.request('GET',`/api/admin/usage?userId=${a.id}&limit=1`);assert.equal(records.data.usage[0].keyLast4,'AAAA');assert.ok(!JSON.stringify(records.data).includes(keyA));
  assert.ok(store.getAudit().some(e=>e.action==='admin.thread.viewed'&&e.target===thread.id));
  for(const url of ['/api/admin/usage?limit=-1','/api/admin/usage?limit=1&limit=2','/api/admin/threads?offset=NaN',`/api/admin/threads/${thread.id}?messageLimit=999`])assert.equal((await admin.request('GET',url)).status,400);
  assert.equal((await bob.request('GET',`/api/admin/threads/${thread.id}`)).status,403);
});

test('a user can change their own password while all prior sessions are revoked',async t=>{
  const {client}=await fixture(t);const a=await client(),other=await client();await register(a,'alice');await other.request('POST','/api/auth/login',{username:'alice',password});
  assert.equal((await a.request('POST','/api/auth/password',{currentPassword:password,newPassword:'Changed-password-2026'})).status,200);
  assert.equal((await a.request('GET','/api/session')).data.user.username,'alice');assert.equal((await other.request('GET','/api/projects')).status,401);
});

test('proxy trust defaults off and accepts only explicitly listed proxy IPs',()=>{
  assert.equal(loadConfig({}).trustProxy,false);assert.equal('apiKey'in loadConfig({OPENAI_API_KEY:keyA}),false);
  assert.deepEqual(loadConfig({TRUST_PROXY_IPS:'172.18.0.1, 172.19.0.1,172.18.0.1,::1'}).trustProxy,['172.18.0.1','172.19.0.1','::1']);
  for(const value of ['true','loopback','0.0.0.0/0','172.18.0.1,attacker.example'])assert.throws(()=>loadConfig({TRUST_PROXY_IPS:value}),/TRUST_PROXY_IPS/);
});

test('untrusted clients cannot evade IP limits by forging forwarded addresses',async t=>{
  const {client}=await fixture(t,{trustProxy:['172.18.0.1']});const c=await client();
  for(let i=0;i<12;i++)assert.equal((await c.request('POST','/api/auth/login',{username:`unknown${i}`,password:'wrong-password-2026'},{'X-Forwarded-For':`198.51.100.${i+1}`})).status,401);
  assert.equal((await c.request('POST','/api/auth/login',{username:'anotheruser',password},{'X-Forwarded-For':'203.0.113.99'})).status,429);
});

test('username failure limit is independent of trusted-proxy client addresses',async t=>{
  const {client}=await fixture(t,{trustProxy:['127.0.0.1']});const c=await client();
  for(let i=0;i<8;i++)assert.equal((await c.request('POST','/api/auth/login',{username:i%2?'ADMIN':'admin',password:'wrong-password-2026'},{'X-Forwarded-For':`198.51.100.${i+1}`})).status,401);
  const limited=await c.request('POST','/api/auth/login',{username:'admin',password},{'X-Forwarded-For':'203.0.113.99'});assert.equal(limited.status,429);assert.equal(limited.data.code,'account_login_limited');
});

test('ordinary chats create, run and reload without any project filesystem operation',async t=>{
  const {client,store,startCalls,projectCalls}=await fixture(t,{forbidProjectCalls:true});
  const alice=await client(),bob=await client(),admin=await client();const user=await register(alice,'alice');await register(bob,'bobby');await loginAdmin(admin);
  const created=await alice.request('POST','/api/threads',{});assert.equal(created.status,201);
  const thread=created.data.thread;assert.equal(thread.projectId,null);assert.equal(thread.userId,user.id);
  assert.deepEqual((await alice.request('GET','/api/threads')).data.threads.map(t=>t.id),[thread.id]);
  assert.deepEqual((await bob.request('GET','/api/threads')).data.threads,[]);
  assert.equal((await bob.request('GET',`/api/threads/${thread.id}`)).status,404);
  assert.equal((await bob.request('POST',`/api/threads/${thread.id}/turns`,{text:'Steal'})).status,404);
  assert.equal((await alice.request('GET','/api/projects')).data.projects.length,0);
  const noKey=await alice.request('POST',`/api/threads/${thread.id}/turns`,{text:'Hello'});
  assert.equal(noKey.status,409);assert.equal(noKey.data.code,'api_key_required');assert.equal(store.getMessages(thread.id).length,0);assert.equal(store.getLatestRun(thread.id),null);
  await alice.request('PUT','/api/account/api-key',{apiKey:keyA});
  const accepted=await alice.request('POST',`/api/threads/${thread.id}/turns`,{text:'Hello ordinary chat'});
  assert.equal(accepted.status,202);assert.equal(accepted.data.run.projectId,null);
  assert.equal(startCalls.length,1);assert.equal(startCalls[0].project,null);assert.equal(startCalls[0].thread.id,thread.id);
  assert.equal((await bob.request('GET',`/api/runs/${accepted.data.run.id}/events`)).status,404);
  assert.equal((await bob.request('POST',`/api/runs/${accepted.data.run.id}/interrupt`,{})).status,404);
  const usageId=store.beginUsage(user.id,accepted.data.run.id,{model:'model',keyLast4:'AAAA'});
  store.settleUsage(usageId,{status:'completed',inputTokens:10,outputTokens:5,totalTokens:15});
  store.appendMessage(thread.id,'assistant','Hello back');store.updateRun(accepted.data.run.id,{status:'completed',output:'Hello back'});
  const history=await alice.request('GET',`/api/threads/${thread.id}`);
  assert.equal(history.data.thread.title,'Hello ordinary chat');assert.deepEqual(history.data.messages.map(m=>m.content),['Hello ordinary chat','Hello back']);assert.equal(history.data.run.status,'completed');
  const adminList=await admin.request('GET',`/api/admin/threads?userId=${user.id}&query=ordinary`);
  assert.equal(adminList.data.total,1);assert.equal(adminList.data.threads[0].project,null);
  const detail=await admin.request('GET',`/api/admin/threads/${thread.id}`);assert.equal(detail.data.project,null);assert.equal(detail.data.messagesTotal,2);assert.equal(detail.data.runs[0].projectId,null);
  const usage=(await alice.request('GET','/api/account/usage')).data;
  assert.equal(usage.totals.totalTokens,15);assert.equal(usage.usage[0].threadId,thread.id);assert.equal(usage.usage[0].projectId,null);assert.equal(usage.usage[0].keyLast4,'AAAA');
  assert.equal((await bob.request('GET','/api/account/usage')).data.total,0);
  assert.ok(store.getAudit().some(e=>e.action==='admin.thread.viewed'&&e.target===thread.id));
  assert.equal(store.overview().projects,0);assert.deepEqual(projectCalls,[]);
});

test('ordinary chat routes validate identity-free input, authentication and creation rate',async t=>{
  const {client,projectCalls}=await fixture(t,{forbidProjectCalls:true});const c=await client();
  assert.equal((await c.request('GET','/api/threads')).status,401);assert.equal((await c.request('POST','/api/threads',{})).status,401);
  await register(c,'alice');
  for(const body of [{projectId:'other-project'},{userId:'other-user'},{title:''},{title:'x'.repeat(101)}])assert.equal((await c.request('POST','/api/threads',body)).status,400);
  assert.equal((await c.request('GET','/api/threads?userId=other-user')).status,400);
  assert.equal((await c.request('POST','/api/threads',{}, {'X-CSRF-Token':''})).status,403);
  for(let i=0;i<26;i++)assert.equal((await c.request('POST','/api/threads',{title:`Chat ${i}`})).status,201);
  assert.equal((await c.request('POST','/api/threads',{})).status,429);assert.deepEqual(projectCalls,[]);
});

test('ordinary chat startup failures roll back the pending message without creating projects',async t=>{
  const {client,store,projectCalls}=await fixture(t,{startError:true,forbidProjectCalls:true});const c=await client();await register(c,'alice');await c.request('PUT','/api/account/api-key',{apiKey:keyA});
  const thread=(await c.request('POST','/api/threads',{})).data.thread;
  assert.equal((await c.request('POST',`/api/threads/${thread.id}/turns`,{text:'Hello'})).status,503);
  assert.deepEqual(store.getMessages(thread.id),[]);assert.equal(store.getLatestRun(thread.id).status,'failed');assert.equal(store.overview().projects,0);assert.deepEqual(projectCalls,[]);
});

test('disabled accounts cannot start ordinary chat or read its history',async t=>{
  const {client,store,admin,startCalls}=await fixture(t,{forbidProjectCalls:true});const c=await client();const user=await register(c,'alice');await c.request('PUT','/api/account/api-key',{apiKey:keyA});
  const thread=(await c.request('POST','/api/threads',{})).data.thread;store.updateUser(user.id,{disabled:true},admin.id);
  assert.equal((await c.request('POST',`/api/threads/${thread.id}/turns`,{text:'Hello'})).status,403);
  assert.equal((await c.request('GET',`/api/threads/${thread.id}`)).status,401);assert.equal(startCalls.length,0);assert.equal(store.getLatestRun(thread.id),null);
});

test('one user cannot overlap ordinary and project tasks, even while runtime start is pending',async t=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});let entered;const started=new Promise(resolve=>{entered=resolve;});
  const {client,store,startCalls}=await fixture(t,{startImplementation:async()=>{entered();await pending;}});const c=await client();await register(c,'alice');await c.request('PUT','/api/account/api-key',{apiKey:keyA});
  const {thread:projectChat}=await projectThread(c),ordinary=(await c.request('POST','/api/threads',{})).data.thread;
  const first=c.request('POST',`/api/threads/${ordinary.id}/turns`,{text:'Hello'});
  await started;
  try {
    assert.equal((await c.request('POST',`/api/threads/${projectChat.id}/turns`,{text:'Project work'})).status,409);
    assert.equal((await c.request('POST',`/api/threads/${ordinary.id}/turns`,{text:'Duplicate'})).status,409);
    assert.equal((await c.request('PUT','/api/account/api-key',{apiKey:keyB})).status,409);
    assert.equal((await c.request('DELETE','/api/account/api-key',{})).status,409);
    assert.equal(startCalls.length,1);assert.deepEqual(store.getMessages(projectChat.id),[]);
  } finally { release();await first; }
  store.updateRun(store.getLatestRun(ordinary.id).id,{status:'completed'});
  assert.equal((await c.request('POST',`/api/threads/${projectChat.id}/turns`,{text:'Project work'})).status,202);
  assert.equal((await c.request('POST',`/api/threads/${ordinary.id}/turns`,{text:'Wait for project'})).status,409);
  assert.equal((await c.request('GET','/api/threads')).data.threads.length,1);
  assert.equal((await c.request('GET',`/api/projects/${projectChat.projectId}/threads`)).data.threads[0].id,projectChat.id);
});
