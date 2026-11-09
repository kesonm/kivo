import express from 'express';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore, AppError } from './store.mjs';
import { createProjects } from './projects.mjs';
import { loadCredentialsKey } from './credentials.mjs';
import { createLocalBridge, localPath } from './local.mjs';
import { createQrLogin } from './qr-login.mjs';

const scrypt=promisify(scryptCallback);
const cookieName='cw_session';
const safeEqual=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const requiredText=(value,label,max=200)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new AppError(`${label}不能为空且不能超过 ${max} 个字符`);return value.trim();};
function validPassword(password){if(typeof password!=='string'||password.length<12||password.length>128)throw new AppError('密码长度必须为 12–128 个字符');return password;}
function validUsername(username){if(typeof username!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/.test(username))throw new AppError('账号需为 3–32 位字母、数字、点、横线或下划线');return username.toLowerCase();}
export async function hashPassword(password){validPassword(password);const salt=randomBytes(16).toString('hex');const key=await scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024});return `scrypt$16384$8$1$${salt}$${key.toString('hex')}`;}
export async function verifyPassword(password,encoded){
  if(typeof password!=='string'||password.length>128)return false;
  const parts=(encoded??'').split('$');if(parts.length!==6||parts[0]!=='scrypt')return false;
  const key=await scrypt(password,parts[4],64,{N:16384,r:8,p:1,maxmem:32*1024*1024});
  const expected=Buffer.from(parts[5],'hex');return key.length===expected.length&&timingSafeEqual(key,expected);
}
const publicUser=u=>u; // Store already excludes password hashes and credentials.
const parseCookies=req=>Object.fromEntries((req.headers.cookie??'').split(';').map(v=>v.trim().split('=')).filter(v=>v.length===2));

export function loadConfig(env=process.env){
  const int=(name,fallback,min=1,max=1e9)=>{const n=Number(env[name]??fallback);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`${name} must be an integer between ${min} and ${max}`);return n;};
  const dataDir=path.resolve(env.DATA_DIR??'./data');
  const trustedProxyIps=[...new Set((env.TRUST_PROXY_IPS??'').split(',').map(value=>value.trim()).filter(Boolean))];
  if(trustedProxyIps.length>32||trustedProxyIps.some(value=>!isIP(value)))throw new Error('TRUST_PROXY_IPS must contain only explicit IPv4 or IPv6 addresses separated by commas');
  return {
    port:int('PORT',3000,1,65535),host:env.HOST??'0.0.0.0',dataDir,
    hostDataDir:env.HOST_DATA_DIR??dataDir,dockerNetwork:env.DOCKER_NETWORK??'codex-workspace-runners',
    runnerImage:env.RUNNER_IMAGE??'codex-workspace-runner:0.167.0',runnerUid:int('RUNNER_UID',1000,0),runnerGid:int('RUNNER_GID',1000,0),
    model:env.CODEX_MODEL??'gpt-6.1-sol',credentialsKeyFile:env.CREDENTIALS_KEY_FILE??'/run/secrets/credentials-key',
    openaiBaseUrl:'https://api.openai.com/v1',gatewayPort:int('GATEWAY_PORT',3001,1,65535),gatewayHost:env.GATEWAY_HOST??'0.0.0.0',
    maxOutputTokens:int('MAX_OUTPUT_TOKENS',8192,256,65536),maxConcurrentRuns:int('MAX_CONCURRENT_RUNS',2,1,16),
    runTimeoutMs:int('RUN_TIMEOUT_MS',600000,1000,3600000),
    publicOrigin:env.PUBLIC_ORIGIN??'',cookieSecure:env.COOKIE_SECURE!=='false',trustProxy:trustedProxyIps.length?trustedProxyIps:false,
    adminUsername:env.ADMIN_USERNAME??'admin',adminPassword:env.ADMIN_PASSWORD??'',adminPasswordFile:env.ADMIN_PASSWORD_FILE??'',
    distDir:path.resolve(fileURLToPath(new URL('../dist',import.meta.url))),
  };
}

export async function bootstrapAdmin(store,config){
  if(store.countAdmins()>0)return;
  let password=config.adminPassword;
  if(!password&&config.adminPasswordFile)password=(await readFile(config.adminPasswordFile,'utf8')).trim();
  if(!password)throw new Error('Initial administrator password missing. Configure ADMIN_PASSWORD_FILE.');
  store.createUser({username:validUsername(config.adminUsername??'admin'),displayName:'管理员',passwordHash:await hashPassword(password),role:'admin'});
}

export function createApp({store,runtime,config,local=null,projects:createProjectsOverride}){
  const app=express();const projects=createProjectsOverride??createProjects(config);const limits=new Map();const loginFailures=new Map();
  const qrLogin=createQrLogin(store,config.publicOrigin||'https://kivo.iptnet.xyz');
  const dummyHash='scrypt$16384$8$1$00000000000000000000000000000000$'+'00'.repeat(64);
  app.disable('x-powered-by');app.set('trust proxy',config.trustProxy??false);
  app.use((req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin',
      'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'"});
    if(config.cookieSecure)res.set('Strict-Transport-Security','max-age=31536000');
    if(req.path.startsWith('/api/'))res.set('Cache-Control','no-store');next();
  });
  if(local)app.post('/api/local-agent/responses',(req,res)=>runtime.localResponses(req,res));
  app.use(express.json({limit:'1100kb',strict:true}));
  if(local){
    app.use('/api/local-agent',(req,res,next)=>{if(req.get('origin')||req.get('cookie'))throw new AppError('本地助手接口不接受浏览器会话',403);next();});
    app.post('/api/local-agent/pair',(req,res)=>{rate(req,'local-pair',10,600_000);res.json(local.beginPair(req.body));});
    app.post('/api/local-agent/claim',(req,res)=>{rate(req,'local-claim',240,600_000);res.json(local.claimPair(req.body.token));});
    app.get('/api/local-agent/poll',async(req,res)=>{const device=local.authenticate(req),controller=new AbortController();res.on('close',()=>controller.abort());res.json(await local.poll(device,controller.signal));});
    app.post('/api/local-agent/result',(req,res)=>{local.result(local.authenticate(req),req.body);res.json({ok:true});});
    app.post('/api/local-agent/events',(req,res)=>{local.events(local.authenticate(req),req.body);res.json({ok:true});});
    app.use('/api/local-agent',(req,res)=>res.status(404).json({error:'接口不存在'}));
  }
  app.use('/api',(req,res,next)=>{
    const token=parseCookies(req)[cookieName],session=store.getSession(token);req.sessionToken=token;req.session=session;
    req.user=session?.userId?store.getUser(session.userId):null;
    if(req.user?.disabled){store.deleteSession(token);req.session=null;req.user=null;}
    next();
  });
  function rate(req,name,count,windowMs){
    const key=`${name}:${req.ip}`;let value=limits.get(key);const now=Date.now();
    if(!value||value.until<=now){value={hits:0,until:now+windowMs};limits.set(key,value);}
    if(++value.hits>count)throw new AppError('操作过于频繁，请稍后重试',429);
    if(limits.size>10000)for(const [k,v]of limits){if(v.until<=now)limits.delete(k);}
    if(limits.size>20000)limits.delete(limits.keys().next().value);
  }
  function accountLoginLimit(username){
    const now=Date.now();let entry=loginFailures.get(username);
    if(!entry||entry.until<=now){entry={hits:0,until:now+15*60_000};loginFailures.set(username,entry);}
    if(entry.hits>=8)throw new AppError('此账号登录失败次数过多，请 15 分钟后重试',429,'account_login_limited');
    if(loginFailures.size>10000)for(const [key,value]of loginFailures){if(value.until<=now)loginFailures.delete(key);}
    if(loginFailures.size>20000)loginFailures.delete(loginFailures.keys().next().value);
    return entry;
  }
  function setSession(res,userId=null){
    const session=store.createSession(userId);
    sessionCookie(res,session);
    return session;
  }
  function sessionCookie(res,session){
    res.setHeader('Set-Cookie',`${cookieName}=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${config.cookieSecure?'; Secure':''}`);
  }
  function auth(req,res,next){if(!req.user)throw new AppError('请先登录',401);next();}
  function admin(req,res,next){if(!req.user)throw new AppError('请先登录',401);if(req.user.role!=='admin')throw new AppError('仅管理员可访问',403);next();}
  function ownedProject(req){const project=store.getProject(req.params.id);if(!project||project.userId!==req.user.id)throw new AppError('项目不存在',404);return project;}
  function ownedThread(req){const thread=store.getThread(req.params.id);if(!thread||thread.userId!==req.user.id)throw new AppError('对话不存在',404);return thread;}
  function ownedRun(req){const run=store.getRun(req.params.id);if(!run||run.userId!==req.user.id)throw new AppError('任务不存在',404);return run;}
  function idle(projectId){if(store.getActiveRunForProject(projectId))throw new AppError('项目任务正在执行，请等待完成或停止任务后操作文件',409);}
  const fileAction=fn=>async(req,res)=>{const p=ownedProject(req);await projects.withLock(p.id,async()=>{idle(p.id);res.json(await fn(p,req));});};

  app.get('/healthz',(req,res)=>res.json({ok:true}));
  app.get('/api/session',(req,res)=>{
    rate(req,'session',120,60_000);
    const session=req.session??setSession(res);
    res.json({user:publicUser(req.user),csrfToken:session.csrfToken,providerConfigured:req.user?runtime.providerConfigured(req.user.id):false,model:config.model});
  });
  app.get('/api/config',(req,res)=>res.json({registrationEnabled:true,providerConfigured:req.user?runtime.providerConfigured(req.user.id):false,model:config.model}));
  app.use('/api',(req,res,next)=>{
    if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return next();
    if(!req.is('application/json'))throw new AppError('请求必须使用 JSON 格式',415);
    req.body??={};
    const expected=config.publicOrigin||`${req.protocol}://${req.get('host')}`;
    if((req.get('origin')&&req.get('origin')!==expected)||req.get('sec-fetch-site')==='cross-site')throw new AppError('请求来源不被允许',403);
    if(!req.session||!safeEqual(req.get('x-csrf-token'),req.session.csrfToken))throw new AppError('页面会话已过期，请刷新后重试',403,'csrf_invalid');
    next();
  });
  app.post('/api/auth/qr',async(req,res)=>{
    rate(req,'qr-create',20,600_000);
    res.status(201).json(await qrLogin.create(req.sessionToken,req.get('user-agent')));
  });
  app.get('/api/auth/qr/:id',(req,res)=>{rate(req,'qr-status',120,60_000);res.json(qrLogin.status(req.params.id,req.sessionToken));});
  app.delete('/api/auth/qr/:id',(req,res)=>{qrLogin.cancel(req.params.id,req.sessionToken);res.json({ok:true});});
  app.post('/api/auth/qr/scan',auth,(req,res)=>{rate(req,'qr-scan',30,600_000);res.json({...qrLogin.scan(req.body.token,req.user.id,req.sessionToken),username:req.user.username});});
  app.post('/api/auth/qr/confirm',auth,(req,res)=>{rate(req,'qr-confirm',30,600_000);res.json(qrLogin.decide(req.body.token,req.body.decision,req.user.id,req.sessionToken));});
  app.post('/api/auth/qr/:id/redeem',(req,res)=>{
    rate(req,'qr-redeem',30,600_000);
    if(req.user)throw new AppError('网页已经登录，请刷新',409);
    const {session,user}=qrLogin.redeem(req.params.id,req.sessionToken);sessionCookie(res,session);
    res.json({user:publicUser(user),csrfToken:session.csrfToken});
  });
  app.post('/api/auth/register',async(req,res)=>{
    rate(req,'register',10,86_400_000);if(req.user)throw new AppError('请先退出当前账号',409);
    const username=validUsername(req.body.username),password=validPassword(req.body.password),displayName=requiredText(req.body.displayName??username,'显示名称',64);
    const user=store.createUser({username,displayName,passwordHash:await hashPassword(password)});
    store.deleteSession(req.sessionToken);const session=setSession(res,user.id);
    res.status(201).json({user:publicUser(user),csrfToken:session.csrfToken});
  });
  app.post('/api/auth/login',async(req,res)=>{
    rate(req,'login',12,15*60_000);
    const submittedUsername=typeof req.body.username==='string'?req.body.username.toLowerCase():'';
    const username=/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(submittedUsername)?submittedUsername:'<invalid>';
    const accountLimit=accountLoginLimit(username);
    const user=store.getUserByUsername(username);
    const valid=await verifyPassword(req.body.password,user?store.getPasswordHash(user.id):dummyHash);
    if(!valid||!user||user.disabled){accountLimit.hits++;throw new AppError('账号或密码错误，或账号已停用',401);}
    loginFailures.delete(username);
    store.deleteSession(req.sessionToken);const session=setSession(res,user.id);store.audit(user.id,'account.login',user.id);
    res.json({user:publicUser(user),csrfToken:session.csrfToken});
  });
  app.post('/api/auth/logout',(req,res)=>{store.deleteSession(req.sessionToken);const session=setSession(res);res.json({ok:true,csrfToken:session.csrfToken});});
  app.post('/api/auth/password',auth,async(req,res)=>{
    rate(req,'password',5,15*60_000);validPassword(req.body.newPassword);
    if(!await verifyPassword(req.body.currentPassword,store.getPasswordHash(req.user.id)))throw new AppError('当前密码不正确',400);
    store.setPassword(req.user.id,await hashPassword(req.body.newPassword),req.user.id);loginFailures.delete(req.user.username);
    await Promise.allSettled(store.getActiveRunsForUser(req.user.id).map(run=>runtime.interrupt(run.id)));
    const session=setSession(res,req.user.id);res.json({ok:true,csrfToken:session.csrfToken});
  });
  const keyView=metadata=>({configured:metadata.configured,last4:metadata.last4,updatedAt:metadata.updatedAt});
  function queryNumber(value,name,fallback,min,max){
    if(value===undefined)return fallback;
    if(typeof value!=='string'||!/^\d+$/.test(value))throw new AppError(`${name} 必须为整数`);
    const number=Number(value);if(!Number.isSafeInteger(number)||number<min||number>max)throw new AppError(`${name} 超出允许范围`);return number;
  }
  function checkedQuery(req,allowed){if(Object.keys(req.query).some(key=>!allowed.includes(key)))throw new AppError('查询参数无效');}
  function page(req,defaultLimit=100,maxLimit=200){return {limit:queryNumber(req.query.limit,'limit',defaultLimit,1,maxLimit),offset:queryNumber(req.query.offset,'offset',0,0,1_000_000_000)};}
  function filterUser(req){
    if(req.query.userId===undefined||req.query.userId==='')return null;
    if(typeof req.query.userId!=='string'||!/^[a-f0-9-]{36}$/.test(req.query.userId))throw new AppError('用户标识无效');
    if(!store.getUser(req.query.userId))throw new AppError('用户不存在',404);return req.query.userId;
  }
  app.get('/api/account/api-key',auth,(req,res)=>res.json(keyView(store.getApiKeyMetadata(req.user.id))));
  app.put('/api/account/api-key',auth,(req,res)=>{
    rate(req,'api-key-change',20,60*60_000);
    if(Object.keys(req.body).some(key=>key!=='apiKey'))throw new AppError('不能修改其他用户的密钥');
    res.json(keyView(store.setUserApiKey(req.user.id,req.body.apiKey)));
  });
  app.delete('/api/account/api-key',auth,(req,res)=>{
    if(Object.keys(req.body).length)throw new AppError('删除个人密钥无需指定用户或密钥');
    res.json(keyView(store.deleteUserApiKey(req.user.id)));
  });
  app.get('/api/account/usage',auth,(req,res)=>{checkedQuery(req,['limit','offset']);res.json(store.getUsage({userId:req.user.id,...page(req)}));});
  app.get('/api/projects',auth,(req,res)=>res.json({projects:store.listProjects(req.user.id)}));
  if(local){
    app.get('/api/local-devices',auth,(req,res)=>res.json({devices:local.list(req.user.id)}));
    app.post('/api/local-devices/pair',auth,(req,res)=>{rate(req,'local-pair-approve',10,600_000);res.json({device:local.approvePair(req.user,req.body.code)});});
    app.delete('/api/local-devices/:id',auth,async(req,res)=>{await local.revoke(req.user.id,req.params.id);res.json({ok:true});});
    app.get('/api/local-devices/:id/folders',auth,async(req,res)=>res.json(await local.call(req.user.id,req.params.id,'browse',{path:localPath(req.query.path??'')})));
    app.post('/api/local-projects',auth,async(req,res)=>{rate(req,'local-project',20,60_000);res.status(201).json({project:await local.addProject(req.user.id,req.body.deviceId,req.body.path,req.body.name,req.body.create===true)});});
  }
  app.post('/api/projects',auth,async(req,res)=>{
    rate(req,'create-project',20,60*60_000);const name=requiredText(req.body.name,'项目名称',80);
    const project=store.createProject(req.user.id,name);
    await projects.withLock(project.id,async()=>{
      try{await projects.initialize(project.id,name);}catch(e){await projects.remove(project.id).catch(()=>{});store.deleteProject(project.id);throw e;}
    });
    store.audit(req.user.id,'project.created',project.id,name);res.status(201).json({project});
  });
  app.patch('/api/projects/:id',auth,(req,res)=>{const p=ownedProject(req);res.json({project:store.updateProject(p.id,requiredText(req.body.name,'项目名称',80))});});
  app.delete('/api/projects/:id',auth,async(req,res)=>{const p=ownedProject(req);await projects.withLock(p.id,async()=>{idle(p.id);if(p.location!=='local')await projects.remove(p.id);store.deleteProject(p.id);store.audit(req.user.id,'project.deleted',p.id,p.name);res.json({ok:true});});});
  app.get('/api/projects/:id/tree',auth,fileAction(p=>p.location==='local'?local.projectCall(p,'tree'):projects.tree(p.id)));
  app.get('/api/projects/:id/file',auth,fileAction((p,req)=>p.location==='local'?local.projectCall(p,'read',{path:req.query.path}):projects.readFile(p.id,req.query.path)));
  app.put('/api/projects/:id/file',auth,fileAction((p,req)=>p.location==='local'?local.projectCall(p,'write',{path:req.body.path,content:req.body.content}):projects.writeFile(p.id,req.body.path,req.body.content)));
  app.delete('/api/projects/:id/file',auth,fileAction((p,req)=>p.location==='local'?local.projectCall(p,'delete',{path:req.body.path}):projects.deleteFile(p.id,req.body.path)));
  app.get('/api/projects/:id/diff',auth,fileAction(p=>p.location==='local'?local.projectCall(p,'diff'):projects.diff(p.id)));
  app.post('/api/projects/:id/commit',auth,fileAction((p,req)=>p.location==='local'?local.projectCall(p,'commit'):projects.commit(p.id,requiredText(req.body.message??'Save workspace changes','提交说明',200))));
  app.get('/api/projects/:id/threads',auth,(req,res)=>{const p=ownedProject(req);res.json({threads:store.listThreads(p.id)});});
  app.post('/api/projects/:id/threads',auth,(req,res)=>{const p=ownedProject(req);res.status(201).json({thread:store.createThread(p.id,req.user.id,requiredText(req.body.title??'新对话','对话标题',100))});});
  app.get('/api/threads',auth,(req,res)=>{checkedQuery(req,[]);res.json({threads:store.listStandaloneThreads(req.user.id)});});
  app.post('/api/threads',auth,(req,res)=>{
    rate(req,'create-chat',30,60_000);
    if(Object.keys(req.body).some(key=>key!=='title'))throw new AppError('普通对话仅接受标题');
    res.status(201).json({thread:store.createThread(null,req.user.id,requiredText(req.body.title??'新对话','对话标题',100))});
  });
  app.get('/api/threads/:id',auth,(req,res)=>{const thread=ownedThread(req);res.json({thread,messages:store.getMessages(thread.id),run:store.getLatestRun(thread.id)});});
  app.post('/api/threads/:id/turns',auth,async(req,res)=>{
    const thread=ownedThread(req),project=thread.projectId===null?null:store.getProject(thread.projectId),text=requiredText(req.body.text,'消息',24000);
    if(thread.projectId!==null&&(!project||project.userId!==req.user.id))throw new AppError('项目不存在',404);
    rate(req,'turn',30,60_000);
    const start=async()=>{
      if(project)idle(project.id);
      if(!runtime.providerConfigured(req.user.id))throw new AppError('请先在个人设置中填写你的 OpenAI API 密钥',409,'api_key_required');
      const user=store.getUser(req.user.id);if(!user||user.disabled)throw new AppError('账号已停用',403);
      if(store.getActiveRunsForUser(user.id).length>=1)throw new AppError('你已有一个任务在运行，请等待完成',409);
      const run=store.createRun(thread.id,user.id),message=store.appendMessage(thread.id,'user',text);
      try{await runtime.start({run,thread,project,user,text});}
      catch(error){store.deleteMessage(message.id);store.updateRun(run.id,{status:'failed',error:error.message});throw error;}
      if(thread.title==='新对话')store.updateThread(thread.id,{title:text.slice(0,50)});
      res.status(202).json({run:store.getRun(run.id)});
    };
    if(project)await projects.withLock(project.id,start);else await start();
  });
  app.post('/api/runs/:id/interrupt',auth,async(req,res)=>{const run=ownedRun(req);await runtime.interrupt(run.id);res.json({ok:true});});
  app.get('/api/runs/:id/approvals',auth,(req,res)=>{const run=ownedRun(req);res.json({approvals:runtime.approvals?.(run.id)??[]});});
  app.post('/api/runs/:id/approvals/:approvalId',auth,async(req,res)=>{const run=ownedRun(req);await runtime.approve(run.id,req.params.approvalId,req.body.decision);res.json({ok:true});});
  app.get('/api/runs/:id/events',auth,(req,res)=>{
    const run=ownedRun(req);res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    const send=(event,data)=>{if(!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
    send('snapshot',run);
    if(run.status!=='running'){send('done',{status:run.status,message:run.error});return res.end();}
    const unsubscribe=runtime.subscribe(run.id,({event,data})=>{send(event,data);if(event==='done')res.end();});
    const heartbeat=setInterval(()=>{
      const currentUser=store.getUser(req.user.id);
      if(!store.getSession(req.sessionToken)||!currentUser||currentUser.disabled){send('done',{status:'failed',message:'登录已失效，请重新登录'});res.end();return;}
      if(!res.destroyed)res.write(': heartbeat\n\n');
    },15000);
    res.on('close',()=>{clearInterval(heartbeat);if(typeof unsubscribe==='function')unsubscribe();});
  });
  // Administration is deliberately read-only. No quota, user-mutation, password
  // reset, key retrieval, or key replacement endpoint exists for administrators.
  app.get('/api/admin/users',admin,(req,res)=>{store.audit(req.user.id,'admin.users.viewed','all');res.json({users:store.listUsers()});});
  app.get('/api/admin/usage',admin,(req,res)=>{
    checkedQuery(req,['userId','limit','offset']);const options={userId:filterUser(req),...page(req)};
    store.audit(req.user.id,'admin.usage.viewed',options.userId??'all',JSON.stringify({limit:options.limit,offset:options.offset}));res.json(store.getUsage(options));
  });
  app.get('/api/admin/threads',admin,(req,res)=>{
    checkedQuery(req,['userId','query','limit','offset']);
    if(req.query.query!==undefined&&(typeof req.query.query!=='string'||req.query.query.length>200))throw new AppError('搜索关键词最多 200 个字符');
    const options={userId:filterUser(req),query:(req.query.query??'').trim(),...page(req,50,100)};
    store.audit(req.user.id,'admin.threads.viewed',options.userId??'all',JSON.stringify({limit:options.limit,offset:options.offset,queryLength:options.query.length}));res.json(store.getAdminThreads(options));
  });
  app.get('/api/admin/threads/:id',admin,(req,res)=>{
    checkedQuery(req,['messageLimit','messageOffset','runLimit','runOffset']);
    const options={messageLimit:queryNumber(req.query.messageLimit,'messageLimit',50,1,100),messageOffset:queryNumber(req.query.messageOffset,'messageOffset',0,0,1_000_000_000),
      runLimit:queryNumber(req.query.runLimit,'runLimit',20,1,50),runOffset:queryNumber(req.query.runOffset,'runOffset',0,0,1_000_000_000)};
    const result=store.getAdminThread(req.params.id,options);store.audit(req.user.id,'admin.thread.viewed',req.params.id,JSON.stringify(options));res.json(result);
  });
  app.get('/api/admin/overview',admin,(req,res)=>{store.audit(req.user.id,'admin.overview.viewed','all');res.json({...store.overview(),model:config.model});});
  app.get('/api/admin/audit',admin,(req,res)=>{store.audit(req.user.id,'admin.audit.viewed','all');res.json({entries:store.getAudit()});});
  app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在'}));
  if(config.distDir){app.use(express.static(config.distDir,{index:false,maxAge:'1h',dotfiles:'deny'}));app.get('/{*path}',(req,res)=>res.sendFile(path.join(config.distDir,'index.html')));}
  app.use((error,req,res,next)=>{
    if(res.headersSent)return next(error);
    const status=error.status??(error.type==='entity.too.large'?413:500);
    if(status>=500)console.error(JSON.stringify({event:'request_error',path:req.path,message:String(error.message).slice(0,500)}));
    res.status(status>=400&&status<=599?status:500).json({error:status>=500&&!(error instanceof AppError)?'服务器暂时无法完成请求，请稍后重试':error.message,code:error.code??'request_failed'});
  });
  return app;
}

export async function startServer(config=loadConfig()){
  await mkdir(config.dataDir,{recursive:true,mode:0o700});
  const credentialsKey=await loadCredentialsKey(config.credentialsKeyFile);
  const store=createStore(path.join(config.dataDir,'workspace.sqlite'),{credentialsKey});
  credentialsKey.fill(0);
  await bootstrapAdmin(store,config);store.reconcileInterruptedRuns();
  const {createRuntime}=await import('./runtime.mjs');
  const local=createLocalBridge({store,config}),runtime=await createRuntime({store,config,local}),app=createApp({store,runtime,config,local});
  const server=app.listen(config.port,config.host,()=>console.log(JSON.stringify({event:'listening',port:config.port,model:config.model,userProvidedKeys:true})));
  server.requestTimeout=120000;server.headersTimeout=15000;
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;server.close();await runtime.close();store.close();};
  process.once('SIGTERM',()=>close().finally(()=>process.exit(0)));process.once('SIGINT',()=>close().finally(()=>process.exit(0)));
  return {app,server,store,runtime,close};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){startServer().catch(error=>{console.error(error.message);process.exitCode=1;});}
