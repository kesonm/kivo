import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCredentialCipher, validateApiKey } from './credentials.mjs';
import { defaultChatModelCatalog, validateChatModelCatalog } from './chat-models.mjs';

export class AppError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message); this.status = status; this.code = code;
  }
}
const now = () => new Date().toISOString();
const id = () => randomUUID();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const integer = (value, name, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > 1_000_000_000_000) throw new AppError(`${name}无效`);
  return value;
};
const RUN_MODES = new Set(['cloud', 'local', 'chat']);
const RUN_INTERRUPT_REASONS = new Set(['restart', 'user', 'other']);
const VERIFICATION_STATUSES = new Set(['not_run', 'running', 'passed', 'failed', 'unknown']);
const RUN_EVENT_KINDS = new Set(['task', 'command', 'file', 'tool', 'approval', 'verification']);
const RUN_EVENT_SOURCES = new Set(['cloud', 'local', 'hosted']);
const RUN_EVENT_STATUSES = new Set(['started', 'succeeded', 'failed', 'denied', 'interrupted', 'unknown', 'awaiting_approval']);
const RUN_EVENT_RETENTION = 512;
const RUN_EVENT_PAGE_LIMIT = 300;
const RESTART_ERROR = '服务重启，任务已中断；未返回的模型用量记为未知。';
const isExitCode = value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;

function verificationCommand(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new AppError('验收命令必须为一行且不超过 1000 个字符');
  }
  return value.trim();
}

function eventText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.slice(0, 4096)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/gu, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=\-]{16,}/giu, 'Bearer [redacted]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ')
    .trim().slice(0, maxLength);
}

function runEventMetadata(event) {
  if (!event || !RUN_EVENT_KINDS.has(event.kind) || !RUN_EVENT_SOURCES.has(event.source) || !RUN_EVENT_STATUSES.has(event.status)) {
    throw new AppError('任务事件格式无效');
  }
  const { kind, source, status } = event;
  const metadata = { kind, source, status };
  const tool = eventText(event.tool, 100), summary = eventText(event.summary, 500), itemId = eventText(event.itemId, 200);
  if (tool) metadata.tool = tool;
  if (summary) metadata.summary = summary;
  if (itemId) metadata.itemId = itemId;
  if (isExitCode(event.exitCode)) metadata.exitCode = event.exitCode;
  if (Array.isArray(event.paths)) {
    const paths = new Set();
    let pathBytes = 0;
    for (const raw of event.paths.slice(0, 40)) {
      if (typeof raw !== 'string' || raw.length > 400 || /[\\\u0000-\u001f\u007f-\u009f]/u.test(raw)) continue;
      const relative = eventText(raw, 400).replace(/^(?:\/workspace\/|\.\/)/u, '');
      if (/^[A-Za-z]:/u.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) continue;
      if (paths.has(relative)) continue;
      pathBytes += Buffer.byteLength(relative);
      if (pathBytes > 2048) break;
      paths.add(relative);
      if (paths.size === 20) break;
    }
    if (paths.size) metadata.paths = [...paths];
  }
  return metadata;
}

function migrateStandaloneThreads(db) {
  if (!db.prepare('PRAGMA table_info(threads)').all().find(column=>column.name==='project_id')?.notnull) return;
  // Do not rename the old table: SQLite would rewrite messages/runs references
  // to that temporary name. Disable FK actions before the transaction instead.
  db.exec('PRAGMA foreign_keys=OFF');
  let transactionOpen=false;
  try {
    db.exec('BEGIN IMMEDIATE');transactionOpen=true;
    const schemaObjects=db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='threads' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
    db.exec(`CREATE TABLE threads_standalone_migration (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, codex_thread_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO threads_standalone_migration(rowid,id,project_id,user_id,title,codex_thread_id,created_at,updated_at)
      SELECT rowid,id,project_id,user_id,title,codex_thread_id,created_at,updated_at FROM threads;
    DROP TABLE threads;
    ALTER TABLE threads_standalone_migration RENAME TO threads;`);
    for(const {sql}of schemaObjects)db.exec(sql);
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Conversation migration failed foreign-key validation');
    db.exec('COMMIT');transactionOpen=false;
  } catch(error) {
    if(transactionOpen)db.exec('ROLLBACK');
    throw error;
  } finally { db.exec('PRAGMA foreign_keys=ON'); }
}

export function createStore(dbPath,{credentialsKey}={}) {
  const credentialCipher=credentialsKey?createCredentialCipher(credentialsKey):null;
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','admin')),
      disabled INTEGER NOT NULL DEFAULT 0, balance_tokens INTEGER NOT NULL DEFAULT 0,
      used_tokens INTEGER NOT NULL DEFAULT 0, reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_tokens >= 0),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id);
    CREATE TABLE IF NOT EXISTS local_devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      platform TEXT NOT NULL, root_name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
      last_seen INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_projects (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES local_devices(id), path TEXT NOT NULL,
      UNIQUE(device_id,path)
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, codex_thread_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
    CREATE TABLE IF NOT EXISTS chat_message_metadata (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      metadata TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_artifacts (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_artifacts_message ON chat_artifacts(message_id);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, user_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
      output TEXT NOT NULL DEFAULT '', logs TEXT NOT NULL DEFAULT '[]', error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_project ON runs(project_id) WHERE status='running';
    CREATE INDEX IF NOT EXISTS runs_thread ON runs(thread_id);
    CREATE TABLE IF NOT EXISTS run_details (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      mode TEXT CHECK(mode IN ('cloud','local','chat')),
      resumed_from_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      request_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      verification_command TEXT, verification_status TEXT CHECK(verification_status IN ('not_run','running','passed','failed','unknown')),
      verification_exit_code INTEGER,
      interrupt_reason TEXT CHECK(interrupt_reason IN ('restart','user','other'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS run_successor ON run_details(resumed_from_run_id) WHERE resumed_from_run_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS run_events (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, created_at TEXT NOT NULL, metadata TEXT NOT NULL, dedupe_key TEXT,
      PRIMARY KEY(run_id,seq)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS run_event_dedupe ON run_events(run_id,dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), run_id TEXT REFERENCES runs(id),
      amount INTEGER NOT NULL CHECK(amount>0), status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), run_id TEXT REFERENCES runs(id),
      reservation_id TEXT UNIQUE NOT NULL REFERENCES reservations(id), model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), actor_id TEXT REFERENCES users(id),
      delta_tokens INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_credentials (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      credential_id TEXT UNIQUE NOT NULL, encrypted_key TEXT NOT NULL, last4 TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS request_usage (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), run_id TEXT REFERENCES runs(id),
      credential_id TEXT, key_last4 TEXT, model TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
      status TEXT NOT NULL CHECK(status IN ('pending','completed','unknown','failed')),
      source TEXT NOT NULL DEFAULT 'current', created_at TEXT NOT NULL, settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS request_usage_user ON request_usage(user_id,created_at);
    CREATE INDEX IF NOT EXISTS request_usage_run ON request_usage(run_id);
    CREATE TABLE IF NOT EXISTS thread_title_jobs (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), model TEXT NOT NULL,
      message_rowid INTEGER NOT NULL, previous_title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','skipped','unknown')),
      usage_id TEXT REFERENCES request_usage(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS thread_title_jobs_thread ON thread_title_jobs(thread_id,status);
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL,
      target TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_model_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, catalog TEXT NOT NULL
    );
  `);
  try {
    migrateStandaloneThreads(db);
    db.exec(`CREATE INDEX IF NOT EXISTS threads_owner_scope ON threads(user_id,project_id,updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_thread ON runs(thread_id) WHERE status='running';
      CREATE TABLE IF NOT EXISTS kibot_threads (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        thread_id TEXT UNIQUE NOT NULL REFERENCES threads(id) ON DELETE CASCADE
      );`);
  } catch(error) { db.close(); throw error; }
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const artifactView = row => ({
    id: row.id, name: row.name, mimeType: row.mime_type, size: row.size, url: '/api/chat-artifacts/' + row.id,
  });
  // Historical quota/ledger tables remain untouched for migration and audit. New
  // requests record provider usage without balances, reservations or deductions.
  const usageUnion=`SELECT id,user_id,run_id,NULL credential_id,NULL key_last4,model,input_tokens,output_tokens,total_tokens,status,'legacy' source,created_at FROM usage
    UNION ALL SELECT id,user_id,run_id,credential_id,key_last4,model,input_tokens,output_tokens,total_tokens,status,source,created_at FROM request_usage`;
  const keyMetadata=(userId)=>{
    const row=db.prepare('SELECT credential_id,last4,updated_at FROM user_credentials WHERE user_id=?').get(userId);
    return row?{configured:true,last4:row.last4,updatedAt:row.updated_at,credentialId:row.credential_id}:{configured:false,last4:null,updatedAt:null,credentialId:null};
  };
  const userView = (r) => {
    if(!r)return null;const key=keyMetadata(r.id);
    const used=db.prepare(`SELECT coalesce(sum(total_tokens),0) n FROM (${usageUnion}) WHERE user_id=? AND status='completed'`).get(r.id).n;
    return {id:r.id,username:r.username,displayName:r.display_name,role:r.role,disabled:Boolean(r.disabled),usedTokens:used,
      apiKeyConfigured:key.configured,keyLast4:key.last4,createdAt:r.created_at};
  };
  const projectView = (r) => { if(!r)return null;const local=db.prepare('SELECT device_id,path FROM local_projects WHERE project_id=?').get(r.id);return {id:r.id,userId:r.user_id,name:r.name,createdAt:r.created_at,updatedAt:r.updated_at,...(local?{location:'local',deviceId:local.device_id,localPath:local.path}:{location:'cloud'})}; };
  const titleJobCurrent = row => {
    if (!row) return false;
    const thread = db.prepare('SELECT * FROM threads WHERE id=? AND user_id=?').get(row.thread_id,row.user_id);
    const user = db.prepare('SELECT disabled FROM users WHERE id=?').get(row.user_id);
    const run = db.prepare('SELECT * FROM runs WHERE id=? AND user_id=? AND thread_id=?').get(row.run_id,row.user_id,row.thread_id);
    return !!thread && !!user && !user.disabled && thread.title===row.previous_title && run?.status==='completed'
      && !db.prepare('SELECT 1 FROM kibot_threads WHERE thread_id=?').get(row.thread_id)
      && db.prepare('SELECT id FROM runs WHERE thread_id=? ORDER BY rowid DESC LIMIT 1').get(row.thread_id)?.id===row.run_id
      && db.prepare('SELECT coalesce(max(rowid),0) n FROM messages WHERE thread_id=?').get(row.thread_id).n===row.message_rowid;
  };
  const titleJobView = row => row ? ({runId:row.run_id,threadId:row.thread_id,userId:row.user_id,model:row.model,
    previousTitle:row.previous_title,status:row.status,usageId:row.usage_id,createdAt:row.created_at,updatedAt:row.updated_at}) : null;
  const titleVersion = threadId => {
    const row=db.prepare("SELECT updated_at FROM thread_title_jobs WHERE thread_id=? AND status='completed' ORDER BY rowid DESC LIMIT 1").get(threadId);
    return row?{titleUpdatedAt:row.updated_at}:{};
  };
  const threadView = (r) => r ? ({id:r.id,projectId:r.project_id,userId:r.user_id,title:r.title,codexThreadId:r.codex_thread_id,createdAt:r.created_at,updatedAt:r.updated_at,
    ...titleVersion(r.id),
    ...(db.prepare("SELECT * FROM thread_title_jobs WHERE thread_id=? AND status IN ('queued','running')").all(r.id).some(titleJobCurrent)?{titlePending:true}:{}),
    ...(db.prepare('SELECT 1 FROM kibot_threads WHERE thread_id=? AND user_id=?').get(r.id,r.user_id)?{isPrimary:true}:{})}) : null;
  const runRows = `SELECT r.*,d.mode,d.resumed_from_run_id,d.request_message_id,d.verification_command,
    d.verification_status,d.verification_exit_code,d.interrupt_reason FROM runs r LEFT JOIN run_details d ON d.run_id=r.id`;
  const runView = (r) => r ? ({id:r.id,threadId:r.thread_id,projectId:r.project_id,userId:r.user_id,status:r.status,
    output:r.output,logs:JSON.parse(r.logs),error:r.error,createdAt:r.created_at,updatedAt:r.updated_at,
    ...(r.mode ? {mode:r.mode} : {}),
    ...(r.resumed_from_run_id ? {resumedFromRunId:r.resumed_from_run_id} : {}),
    ...(r.request_message_id ? {requestMessageId:r.request_message_id} : {}),
    ...(r.verification_command ? {verification:{command:r.verification_command,status:r.verification_status,
      ...(r.verification_exit_code == null ? {} : {exitCode:r.verification_exit_code})}} : {}),
    ...(r.interrupt_reason ? {interruptReason:r.interrupt_reason} : {}),
  }) : null;
  const runEventView = row => ({seq:row.seq,createdAt:row.created_at,...JSON.parse(row.metadata)});

  function insertRunEvent(runId, event, dedupeKey, createdAt = now()) {
    const metadata = runEventMetadata(event);
    const key = typeof dedupeKey === 'string' && dedupeKey ? hash(dedupeKey) : null;
    if (key && db.prepare('SELECT 1 FROM run_events WHERE run_id=? AND dedupe_key=?').get(runId,key)) return null;
    const seq = db.prepare('SELECT coalesce(max(seq),0)+1 seq FROM run_events WHERE run_id=?').get(runId).seq;
    db.prepare('INSERT INTO run_events(run_id,seq,created_at,metadata,dedupe_key) VALUES(?,?,?,?,?)').run(runId,seq,createdAt,JSON.stringify(metadata),key);
    if (seq > RUN_EVENT_RETENTION) db.prepare('DELETE FROM run_events WHERE run_id=? AND seq<=?').run(runId,seq-RUN_EVENT_RETENTION);
    return {seq,createdAt,...metadata};
  }

  function updateRunDetails(run, patch) {
    let requestMessageId = run.requestMessageId ?? null;
    let interruptReason = run.interruptReason ?? null;
    let command = run.verification?.command ?? null;
    let verificationStatus = run.verification?.status ?? null;
    let exitCode = run.verification?.exitCode ?? null;
    if (patch.requestMessageId !== undefined) {
      requestMessageId = patch.requestMessageId;
      if (requestMessageId !== null && (typeof requestMessageId !== 'string' || !run.threadId || !db.prepare("SELECT 1 FROM messages WHERE id=? AND thread_id=? AND role='user'").get(requestMessageId,run.threadId))) {
        throw new AppError('任务的原始请求不存在',404);
      }
    }
    if (patch.interruptReason !== undefined) {
      if (patch.interruptReason !== null && !RUN_INTERRUPT_REASONS.has(patch.interruptReason)) throw new AppError('任务中断原因无效');
      interruptReason = patch.interruptReason;
    }
    if (patch.verification !== undefined) {
      const verification = patch.verification;
      if (!verification || typeof verification !== 'object' || Array.isArray(verification)) throw new AppError('验收记录无效');
      if (verification.command !== undefined) command = verificationCommand(verification.command);
      if (!command) throw new AppError('任务尚未配置验收命令');
      if (verification.status !== undefined && !VERIFICATION_STATUSES.has(verification.status)) throw new AppError('验收状态无效');
      verificationStatus = verification.status ?? verificationStatus ?? 'not_run';
      if (verification.exitCode !== undefined) {
        if (verification.exitCode !== null && !isExitCode(verification.exitCode)) throw new AppError('验收退出码无效');
        exitCode = verification.exitCode;
      }
    }
    db.prepare(`INSERT INTO run_details(run_id,request_message_id,verification_command,verification_status,verification_exit_code,interrupt_reason)
      VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET request_message_id=excluded.request_message_id,
      verification_command=excluded.verification_command,verification_status=excluded.verification_status,
      verification_exit_code=excluded.verification_exit_code,interrupt_reason=excluded.interrupt_reason`)
      .run(run.id,requestMessageId,command,verificationStatus,exitCode,interruptReason);
  }
  function hasRunDetails(patch) {
    return patch.verification !== undefined || patch.interruptReason !== undefined || patch.requestMessageId !== undefined;
  }
  function saveRun(run, patch) {
    // Terminal runs are immutable. A delayed event cannot resurrect a cancelled
    // execution or overwrite the output of a later attempt.
    if (run.status !== 'running') {
      if (patch.status !== undefined && patch.status !== run.status || patch.output !== undefined && patch.output !== run.output
        || patch.logs !== undefined || hasRunDetails(patch)) throw new AppError('执行已经结束，旧结果不能覆盖当前状态',409,'run_terminal');
      return;
    }
    if (hasRunDetails(patch)) updateRunDetails(run,patch);
    db.prepare('UPDATE runs SET status=?,output=?,logs=?,error=?,updated_at=? WHERE id=?').run(
      patch.status??run.status,String(patch.output??run.output).slice(0,4_000_000),
      JSON.stringify((patch.logs??run.logs).slice(-300)),
      patch.error===undefined?run.error:String(patch.error??'').slice(0,4000),now(),run.id);
  }
  const audit = (actorId, action, target, detail = '') => db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').run(id(),actorId ?? null,action,target,String(detail).slice(0,2000),now());
  const api = {
    db, close:()=>db.close(),
    getChatModelCatalog(defaultModel) {
      const saved = db.prepare('SELECT revision,catalog FROM chat_model_settings WHERE id=1').get();
      return saved ? { ...JSON.parse(saved.catalog), revision: saved.revision }
        : { ...defaultChatModelCatalog(defaultModel), revision: 0 };
    },
    setChatModelCatalog(input, actorId) {
      const catalog = validateChatModelCatalog(input);
      if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new AppError('配置版本无效');
      return tx(() => {
        const current = db.prepare('SELECT revision FROM chat_model_settings WHERE id=1').get()?.revision ?? 0;
        if (current !== input.revision) throw new AppError('模型列表已更新，请重新加载后再保存', 409, 'chat_catalog_conflict');
        const revision = current + 1;
        db.prepare(`INSERT INTO chat_model_settings (id,revision,catalog) VALUES (1,?,?)
          ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,catalog=excluded.catalog`).run(revision, JSON.stringify(catalog));
        audit(actorId, 'admin.chat_models.updated', catalog.defaultModel, JSON.stringify({
          models: catalog.models.length, enabled: catalog.models.filter(option => option.enabled).length,
        }));
        return { ...catalog, revision };
      });
    },
    getUser: (userId) => userView(db.prepare('SELECT * FROM users WHERE id=?').get(userId)),
    getUserByUsername: (username) => userView(db.prepare('SELECT * FROM users WHERE username=?').get(username.toLowerCase())),
    getPasswordHash: (userId) => db.prepare('SELECT password_hash FROM users WHERE id=?').get(userId)?.password_hash,
    listUsers: () => db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 1000').all().map(userView),
    countAdmins: () => db.prepare("SELECT count(*) n FROM users WHERE role='admin'").get().n,
    createUser({username,displayName,passwordHash,role='user'}) {
      const userId=id();
      try { db.prepare('INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(userId,username.toLowerCase(),displayName,passwordHash,role,now()); }
      catch(e) { if (e.message.includes('UNIQUE')) throw new AppError('此账号已被注册',409); throw e; }
      audit(userId,'account.created',userId,role);
      return api.getUser(userId);
    },
    updateUser(userId,patch,actorId) {
      const current=api.getUser(userId); if(!current) throw new AppError('用户不存在',404);
      if(patch.disabled && userId===actorId) throw new AppError('不能停用自己的管理员账号');
      if(patch.disabled && current.role==='admin' && db.prepare("SELECT count(*) n FROM users WHERE role='admin' AND disabled=0").get().n<=1) throw new AppError('必须保留至少一个启用的管理员');
      db.prepare('UPDATE users SET disabled=?,display_name=? WHERE id=?').run(patch.disabled===undefined?Number(current.disabled):Number(patch.disabled),patch.displayName??current.displayName,userId);
      if(patch.disabled) db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
      audit(actorId,'account.updated',userId,JSON.stringify(patch)); return api.getUser(userId);
    },
    setPassword(userId,passwordHash,actorId) {
      tx(()=>{ db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash,userId); db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId); audit(actorId,'account.password_changed',userId); });
    },
    createSession(userId=null,ttlMs=86_400_000) {
      db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
      const token=randomBytes(32).toString('base64url'), csrfToken=randomBytes(24).toString('base64url');
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token),userId,csrfToken,Date.now()+ttlMs);
      return {token,csrfToken,userId};
    },
    getSession(token) {
      if(typeof token!=='string'||token.length>200)return null;
      const r=db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token),Date.now());
      if(!r)return null;
      return {userId:r.user_id,csrfToken:r.csrf_token};
    },
    deleteSession(token) {if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));},
    getApiKeyMetadata: keyMetadata,
    getUserApiKey(userId) {
      const row=db.prepare('SELECT encrypted_key FROM user_credentials WHERE user_id=?').get(userId);
      if(!row)return null;
      if(!credentialCipher)throw new AppError('服务器尚未配置个人密钥加密存储',503);
      return credentialCipher.decrypt(userId,row.encrypted_key);
    },
    setUserApiKey(userId,value) {
      const secret=validateApiKey(value);
      if(!credentialCipher)throw new AppError('服务器尚未配置个人密钥加密存储',503);
      return tx(()=>{
        if(!api.getUser(userId))throw new AppError('用户不存在',404);
        if(api.getActiveRunsForUser(userId).length)throw new AppError('请先停止正在运行的任务，再修改 API 密钥',409);
        const encrypted=credentialCipher.encrypt(userId,secret);
        db.prepare('INSERT INTO user_credentials(user_id,credential_id,encrypted_key,last4,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET credential_id=excluded.credential_id,encrypted_key=excluded.encrypted_key,last4=excluded.last4,updated_at=excluded.updated_at').run(userId,id(),encrypted,secret.slice(-4),now());
        audit(userId,'credential.updated',userId,'OpenAI API key updated');return keyMetadata(userId);
      });
    },
    deleteUserApiKey(userId) {
      return tx(()=>{
        if(api.getActiveRunsForUser(userId).length)throw new AppError('请先停止正在运行的任务，再删除 API 密钥',409);
        db.prepare('DELETE FROM user_credentials WHERE user_id=?').run(userId);
        audit(userId,'credential.deleted',userId,'OpenAI API key deleted');return keyMetadata(userId);
      });
    },
    beginUsage(userId,runId,options={}) {
      const model=typeof options==='string'?options:options.model;
      if(typeof model!=='string'||!model||model.length>200)throw new AppError('模型标识无效');
      return tx(()=>{
        const user=api.getUser(userId),run=api.getRun(runId),metadata=keyMetadata(userId);
        if(!user||user.disabled)throw new AppError('账号已停用',403);
        if(!run||run.userId!==userId||run.status!=='running')throw new AppError('任务已结束',409);
        if(!metadata.configured)throw new AppError('请先填写个人 OpenAI API 密钥',409,'api_key_required');
        if(options.keyLast4&&options.keyLast4!==metadata.last4)throw new AppError('个人 API 密钥已变更，请重新开始任务',409);
        const usageId=id();
        db.prepare('INSERT INTO request_usage(id,user_id,run_id,credential_id,key_last4,model,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(usageId,userId,runId,metadata.credentialId,metadata.last4,model,'pending',now());
        return usageId;
      });
    },
    enqueueTitleJob({runId,model}) {
      if(typeof model!=='string'||!model||model.length>200)throw new AppError('模型标识无效');
      return tx(()=>{
        if(db.prepare('SELECT 1 FROM thread_title_jobs WHERE run_id=?').get(runId))return null;
        const run=api.getRun(runId),thread=run&&api.getThread(run.threadId);
        if(!run||!thread)return null;
        const row={run_id:runId,thread_id:thread.id,user_id:run.userId,model,
          message_rowid:db.prepare('SELECT coalesce(max(rowid),0) n FROM messages WHERE thread_id=?').get(thread.id).n,
          previous_title:thread.title};
        if(!titleJobCurrent(row))return null;
        const at=now();
        db.prepare(`INSERT INTO thread_title_jobs(run_id,thread_id,user_id,model,message_rowid,previous_title,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'queued',?,?)`).run(runId,thread.id,run.userId,model,row.message_rowid,thread.title,at,at);
        return titleJobView(db.prepare('SELECT * FROM thread_title_jobs WHERE run_id=?').get(runId));
      });
    },
    getTitleJob: runId=>titleJobView(db.prepare('SELECT * FROM thread_title_jobs WHERE run_id=?').get(runId)),
    getTitleContext(runId) {
      const row=db.prepare('SELECT * FROM thread_title_jobs WHERE run_id=?').get(runId);
      if(!row||!['queued','running'].includes(row.status)||!titleJobCurrent(row))return null;
      const messages=db.prepare(`SELECT role,substr(content,1,2000) content FROM messages
        WHERE thread_id=? AND rowid<=? AND role IN ('user','assistant') ORDER BY rowid DESC LIMIT 12`).all(row.thread_id,row.message_rowid).reverse();
      return {...titleJobView(row),messages};
    },
    beginTitleUsage(runId,{keyLast4}={}) {
      return tx(()=>{
        const row=db.prepare('SELECT * FROM thread_title_jobs WHERE run_id=?').get(runId);
        if(row?.status!=='queued'||!titleJobCurrent(row))return null;
        const metadata=keyMetadata(row.user_id);
        if(!metadata.configured||keyLast4!==metadata.last4)return null;
        const usageId=id(),at=now();
        db.prepare(`INSERT INTO request_usage(id,user_id,run_id,credential_id,key_last4,model,status,source,created_at)
          VALUES(?,?,?,?,?,?,'pending','thread_title',?)`).run(usageId,row.user_id,runId,metadata.credentialId,metadata.last4,row.model,at);
        db.prepare("UPDATE thread_title_jobs SET status='running',usage_id=?,updated_at=? WHERE run_id=?").run(usageId,at,runId);
        return usageId;
      });
    },
    settleTitleJob(runId,{status='failed',title}={}) {
      if(!['completed','failed','skipped','unknown'].includes(status))throw new AppError('标题任务状态无效');
      return tx(()=>{
        const row=db.prepare('SELECT * FROM thread_title_jobs WHERE run_id=?').get(runId);
        if(!row||!['queued','running'].includes(row.status))return false;
        let applied=false;
        if(status==='completed'){
          if(typeof title!=='string'||!title.trim()||[...title].length>60||/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(title))status='failed';
          else if(!titleJobCurrent(row))status='skipped';
          else {db.prepare('UPDATE threads SET title=? WHERE id=? AND user_id=? AND title=?').run(title.trim(),row.thread_id,row.user_id,row.previous_title);applied=true;}
        }
        db.prepare('UPDATE thread_title_jobs SET status=?,updated_at=? WHERE run_id=?').run(status,now(),runId);
        return applied;
      });
    },
    recoverTitleJobs() {
      return tx(()=>{
        const at=now();
        db.prepare(`UPDATE request_usage SET status='unknown',settled_at=? WHERE status='pending'
          AND id IN (SELECT usage_id FROM thread_title_jobs WHERE status='running')`).run(at);
        db.prepare("UPDATE thread_title_jobs SET status=CASE status WHEN 'running' THEN 'unknown' ELSE 'skipped' END,updated_at=? WHERE status IN ('queued','running')").run(at);
      });
    },
    settleUsage(usageId,value={}) {
      return tx(()=>{
        const row=db.prepare('SELECT * FROM request_usage WHERE id=?').get(usageId);if(!row)throw new AppError('用量记录不存在',404);
        if(row.status!=='pending')return {settled:false,status:row.status,totalTokens:row.total_tokens};
        const status=value.status??'unknown';
        if(!['completed','unknown','failed'].includes(status))throw new AppError('用量状态无效');
        let input=null,output=null,total=null;
        if(status==='completed'){
          input=integer(value.inputTokens,'输入用量');output=integer(value.outputTokens,'输出用量');total=integer(value.totalTokens,'总用量');
          if(total!==input+output)throw new AppError('模型返回的用量不一致');
        }
        db.prepare('UPDATE request_usage SET input_tokens=?,output_tokens=?,total_tokens=?,status=?,settled_at=? WHERE id=?').run(input,output,total,status,now(),usageId);
        return {settled:true,status,inputTokens:input,outputTokens:output,totalTokens:total};
      });
    },
    getUsage({userId=null,limit=100,offset=0}={}) {
      const filter=userId?' WHERE u.user_id=?':'';const params=userId?[userId]:[];
      const total=db.prepare(`SELECT count(*) n FROM (${usageUnion}) u${filter}`).get(...params).n;
      const summary=db.prepare(`SELECT coalesce(sum(CASE WHEN status='completed' THEN input_tokens ELSE 0 END),0) inputTokens,
        coalesce(sum(CASE WHEN status='completed' THEN output_tokens ELSE 0 END),0) outputTokens,
        coalesce(sum(CASE WHEN status='completed' THEN total_tokens ELSE 0 END),0) totalTokens,
        sum(CASE WHEN status IN ('unknown','estimated') THEN 1 ELSE 0 END) unknownRequests,
        count(*) totalRequests FROM (${usageUnion}) u${filter}`).get(...params);
      const rows=db.prepare(`SELECT u.*,a.username,a.display_name,r.thread_id,r.project_id,t.title thread_title,p.name project_name FROM (${usageUnion}) u
        JOIN users a ON a.id=u.user_id LEFT JOIN runs r ON r.id=u.run_id LEFT JOIN threads t ON t.id=r.thread_id LEFT JOIN projects p ON p.id=r.project_id
        ${filter} ORDER BY u.created_at DESC,u.id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset);
      return {usage:rows.map(r=>({id:r.id,userId:r.user_id,username:r.username,displayName:r.display_name,runId:r.run_id,
        threadId:r.thread_id,threadTitle:r.thread_title,projectId:r.project_id,projectName:r.project_name,
        credentialId:r.credential_id,keyLast4:r.key_last4,model:r.model,inputTokens:r.input_tokens,outputTokens:r.output_tokens,totalTokens:r.total_tokens,
        status:r.status,source:r.source,createdAt:r.created_at})),total,limit,offset,totals:{...summary,unknownRequests:summary.unknownRequests??0}};
    },
    getAdminThreads({userId=null,query='',limit=50,offset=0}={}) {
      const filters=[],params=[];
      if(userId){filters.push('t.user_id=?');params.push(userId);}
      if(query){filters.push("(instr(lower(t.title),lower(?))>0 OR instr(lower(p.name),lower(?))>0 OR instr(lower(a.username),lower(?))>0)");params.push(query,query,query);}
      const where=filters.length?' WHERE '+filters.join(' AND '):'';
      const join=' FROM threads t JOIN users a ON a.id=t.user_id LEFT JOIN projects p ON p.id=t.project_id';
      const total=db.prepare('SELECT count(*) n'+join+where).get(...params).n;
      const rows=db.prepare(`SELECT t.*,a.username,a.display_name,p.name project_name,
        (SELECT count(*) FROM messages m WHERE m.thread_id=t.id) message_count,
        (SELECT count(*) FROM runs r WHERE r.thread_id=t.id) run_count${join}${where} ORDER BY t.updated_at DESC,t.id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset);
      return {threads:rows.map(r=>({...threadView(r),owner:{id:r.user_id,username:r.username,displayName:r.display_name},project:r.project_id?{id:r.project_id,name:r.project_name}:null,messageCount:r.message_count,runCount:r.run_count})),total,limit,offset};
    },
    getAdminThread(threadId,{messageLimit=50,messageOffset=0,runLimit=20,runOffset=0}={}) {
      const thread=api.getThread(threadId);if(!thread)throw new AppError('对话不存在',404);
      const user=api.getUser(thread.userId),p=api.getProject(thread.projectId);
      const messagesTotal=db.prepare('SELECT count(*) n FROM messages WHERE thread_id=?').get(threadId).n;
      const runsTotal=db.prepare('SELECT count(*) n FROM runs WHERE thread_id=?').get(threadId).n;
      const readPage=(statement,params,view)=>{
        const result=[];let bytes=0;
        for(const row of statement.iterate(...params)){const item=view(row),size=Buffer.byteLength(JSON.stringify(item));if(result.length&&bytes+size>8*1024*1024)break;result.push(item);bytes+=size;}
        return result;
      };
      const messages=readPage(db.prepare('SELECT * FROM messages WHERE thread_id=? ORDER BY rowid ASC LIMIT ? OFFSET ?'),[threadId,messageLimit,messageOffset],r=>({id:r.id,role:r.role,content:r.content,createdAt:r.created_at}));
      const runs=readPage(db.prepare(`${runRows} WHERE r.thread_id=? ORDER BY r.rowid ASC LIMIT ? OFFSET ?`),[threadId,runLimit,runOffset],runView);
      return {thread,owner:{id:user.id,username:user.username,displayName:user.displayName},project:p?{id:p.id,name:p.name}:null,messages,runs,messagesTotal,runsTotal,messageOffset,runOffset,
        nextMessageOffset:messageOffset+messages.length<messagesTotal?messageOffset+messages.length:null,nextRunOffset:runOffset+runs.length<runsTotal?runOffset+runs.length:null};
    },
    createProject(userId,name) {
      const projectId=id(),at=now();
      if(db.prepare('SELECT count(*) n FROM projects WHERE user_id=?').get(userId).n>=20)throw new AppError('每个账号最多创建 20 个项目',409);
      db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(projectId,userId,name,at,at); return api.getProject(projectId);
    },
    getProject: projectId=>projectView(db.prepare('SELECT * FROM projects WHERE id=?').get(projectId)),
    listProjects: userId=>db.prepare('SELECT * FROM projects WHERE user_id=? ORDER BY updated_at DESC').all(userId).map(projectView),
    updateProject(projectId,name) {db.prepare('UPDATE projects SET name=?,updated_at=? WHERE id=?').run(name,now(),projectId);return api.getProject(projectId);},
    deleteProject(projectId) {
      if(api.getActiveRunForProject(projectId))throw new AppError('项目有正在运行的任务，请先停止任务',409);
      db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
    },
    createThread(projectId,userId,title='新对话') {
      const threadId=id(),at=now();
      if(projectId===null){
        if(!api.getUser(userId))throw new AppError('用户不存在',404);
        if(db.prepare('SELECT count(*) n FROM threads WHERE user_id=? AND project_id IS NULL AND id NOT IN (SELECT thread_id FROM kibot_threads)').get(userId).n>=500)throw new AppError('每个账号最多 500 个普通对话',409);
      }else{
        const p=api.getProject(projectId);if(!p||p.userId!==userId)throw new AppError('项目不存在',404);
        if(db.prepare('SELECT count(*) n FROM threads WHERE project_id=?').get(projectId).n>=500)throw new AppError('每个项目最多 500 个对话',409);
      }
      db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(threadId,projectId,userId,title,null,at,at);return api.getThread(threadId);
    },
    getThread: threadId=>threadView(db.prepare('SELECT * FROM threads WHERE id=?').get(threadId)),
    listThreads: projectId=>db.prepare('SELECT * FROM threads WHERE project_id=? ORDER BY updated_at DESC').all(projectId).map(threadView),
    listStandaloneThreads: userId=>db.prepare('SELECT * FROM threads WHERE user_id=? AND project_id IS NULL AND id NOT IN (SELECT thread_id FROM kibot_threads) ORDER BY updated_at DESC,rowid DESC').all(userId).map(threadView),
    updateThread(threadId,patch) {
      const t=api.getThread(threadId);if(!t)throw new AppError('对话不存在',404);
      db.prepare('UPDATE threads SET title=?,codex_thread_id=?,updated_at=? WHERE id=?').run(t.isPrimary?'kibot':patch.title??t.title,patch.codexThreadId??t.codexThreadId,now(),threadId);return api.getThread(threadId);
    },
    appendMessage(threadId,role,content,{attachments=[],citations=[],artifacts=[],uploads=[]}={}) {
      if(uploads.length&&(role!=='user'||artifacts.length||attachments.length))throw new AppError('附件只能保存到对应的用户消息');
      const messageId=id(),at=now(),metadata={};
      if(attachments.length)metadata.attachments=attachments;
      if(citations.length)metadata.citations=citations;
      return tx(()=>{
        const blobs=uploads.length?uploads:artifacts;
        if(blobs.length){
          const bytes=blobs.reduce((sum,artifact)=>sum+artifact.data.length,0);
          const total=db.prepare('SELECT coalesce(sum(size),0) n FROM chat_artifacts').get().n;
          const owner=db.prepare('SELECT user_id FROM threads WHERE id=?').get(threadId).user_id;
          const personal=db.prepare(`SELECT coalesce(sum(a.size),0) n FROM chat_artifacts a
            JOIN messages m ON m.id=a.message_id JOIN threads t ON t.id=m.thread_id WHERE t.user_id=?`).get(owner).n;
          if(total+bytes>2*1024**3||personal+bytes>256*1024**2)throw new AppError(
            uploads.length?'附件存储空间已满，本次附件无法保存':'图片存储空间已满，本次图片无法保存',
            507,uploads.length?'chat_attachment_storage_full':'chat_artifact_storage_full');
        }
        db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(messageId,threadId,role,String(content).slice(0,4_000_000),at);
        const saved=blobs.map(artifact=>{
          const row={id:id(),name:artifact.name,mime_type:uploads.length?'application/octet-stream':artifact.mimeType,size:artifact.data.length};
          db.prepare('INSERT INTO chat_artifacts VALUES(?,?,?,?,?,?)').run(row.id,messageId,row.name,row.mime_type,row.size,artifact.data);
          return artifactView(row);
        });
        if(uploads.length)metadata.attachments=saved.map((file,index)=>({...file,mimeType:uploads[index].mimeType,analyzable:uploads[index].kind!=='opaque'}));
        if(Object.keys(metadata).length)db.prepare('INSERT INTO chat_message_metadata VALUES(?,?)').run(messageId,JSON.stringify(metadata));
        db.prepare('UPDATE threads SET updated_at=? WHERE id=?').run(at,threadId);
        db.prepare('UPDATE projects SET updated_at=? WHERE id=(SELECT project_id FROM threads WHERE id=?)').run(at,threadId);
        return {id:messageId,threadId,role,content,createdAt:at,...metadata,...(artifacts.length?{artifacts:saved}:{})};
      });
    },
    getMessage(messageId) {
      const r=db.prepare(`SELECT m.*,x.metadata FROM messages m LEFT JOIN chat_message_metadata x ON x.message_id=m.id WHERE m.id=?`).get(messageId);
      if(!r)return null;
      const artifacts=r.role==='assistant'?db.prepare('SELECT id,name,mime_type,size FROM chat_artifacts WHERE message_id=? ORDER BY rowid').all(messageId).map(artifactView):[];
      return {id:r.id,role:r.role,content:r.content,createdAt:r.created_at,
        ...(r.metadata?JSON.parse(r.metadata):{}),...(artifacts.length?{artifacts}:{})};
    },
    getMessages(threadId) {
      const artifacts=new Map();
      for(const row of db.prepare(`SELECT a.id,a.name,a.mime_type,a.size,a.message_id FROM messages m
        JOIN chat_artifacts a ON a.message_id=m.id WHERE m.thread_id=? AND m.role='assistant' ORDER BY a.rowid`).all(threadId)){
        if(!artifacts.has(row.message_id))artifacts.set(row.message_id,[]);
        artifacts.get(row.message_id).push(artifactView(row));
      }
      return db.prepare(`SELECT m.*, x.metadata FROM messages m LEFT JOIN chat_message_metadata x ON x.message_id=m.id
        WHERE m.thread_id=? ORDER BY m.rowid ASC LIMIT 2000`).all(threadId).map(r=>({
        id:r.id,role:r.role,content:r.content,createdAt:r.created_at,
        ...(r.metadata?JSON.parse(r.metadata):{}),...(artifacts.has(r.id)?{artifacts:artifacts.get(r.id)}:{}),
      }));
    },
    getChatArtifact(artifactId,userId) {
      return db.prepare(`SELECT a.name,a.mime_type mimeType,a.data,m.role FROM chat_artifacts a
        JOIN messages m ON m.id=a.message_id JOIN threads t ON t.id=m.thread_id
        WHERE a.id=? AND t.user_id=? AND t.project_id IS NULL`).get(artifactId,userId);
    },
    getMessagesForContext(threadId,{maxMessages=200,maxBytes=4*1024*1024}={}) {
      integer(maxMessages,'历史消息数量',1);integer(maxBytes,'历史消息大小',1);
      const messages=[];let bytes=0;
      for(const r of db.prepare('SELECT * FROM messages WHERE thread_id=? ORDER BY rowid ASC').iterate(threadId)){
        bytes+=Buffer.byteLength(r.content);
        if(messages.length>=maxMessages||bytes>maxBytes)throw new AppError('此对话历史过长，请新建普通对话后继续',409,'context_too_large');
        messages.push({id:r.id,role:r.role,content:r.content,createdAt:r.created_at});
      }
      return messages;
    },
    deleteMessage: messageId=>db.prepare('DELETE FROM messages WHERE id=?').run(messageId),
    createRun(threadId,userId,{mode,verificationCommand:rawCommand,resumedFromRunId,executionProjectId}={}) {
      if (mode !== undefined && !RUN_MODES.has(mode)) throw new AppError('任务运行环境无效');
      const command = rawCommand === undefined ? null : verificationCommand(rawCommand);
      return tx(()=>{
        const thread = api.getThread(threadId);
        if (!thread || thread.userId !== userId) throw new AppError('对话不存在',404);
        const projectId = executionProjectId === undefined ? thread.projectId : executionProjectId;
        if (projectId !== null && api.getProject(projectId)?.userId !== userId) throw new AppError('执行项目不存在',404);
        if (resumedFromRunId !== undefined) {
          const previous = typeof resumedFromRunId === 'string' ? api.getRun(resumedFromRunId) : null;
          if (!previous || previous.userId !== userId || previous.threadId !== threadId) throw new AppError('原任务不存在',404);
          if (previous.status !== 'interrupted') throw new AppError('只能继续已中断的任务',409);
          if (api.getResumedRun(resumedFromRunId)) throw new AppError('此任务已继续执行',409,'run_already_resumed');
        }
        const runId=id(),at=now();
        try { db.prepare('INSERT INTO runs(id,thread_id,project_id,user_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(runId,threadId,projectId,userId,'running',at,at); }
        catch (error) { if (error.message.includes('UNIQUE')) throw new AppError('此对话或项目已有任务正在执行',409); throw error; }
        if (mode || command || resumedFromRunId) {
          db.prepare('INSERT INTO run_details(run_id,mode,resumed_from_run_id,verification_command,verification_status) VALUES(?,?,?,?,?)')
            .run(runId,mode??null,resumedFromRunId??null,command,command ? 'not_run' : null);
        }
        return api.getRun(runId);
      });
    },
    getRun: runId=>runView(db.prepare(`${runRows} WHERE r.id=?`).get(runId)),
    getLatestRun: threadId=>runView(db.prepare(`${runRows} WHERE r.thread_id=? ORDER BY r.rowid DESC LIMIT 1`).get(threadId)),
    getActiveRunForProject: projectId=>runView(db.prepare(`${runRows} WHERE r.project_id=? AND r.status='running'`).get(projectId)),
    getActiveRunsForUser: userId=>db.prepare(`${runRows} WHERE r.user_id=? AND r.status='running'`).all(userId).map(runView),
    getResumedRun: runId=>runView(db.prepare(`${runRows} WHERE d.resumed_from_run_id=?`).get(runId)),
    getRunInput: runId=>db.prepare(`SELECT m.content FROM run_details d JOIN runs r ON r.id=d.run_id
      JOIN messages m ON m.id=d.request_message_id AND m.thread_id=r.thread_id AND m.role='user' WHERE d.run_id=?`).get(runId)?.content??null,
    updateRun(runId,patch) {
      const update = () => {
        const run=api.getRun(runId);if(!run)throw new AppError('任务不存在',404);
        saveRun(run,patch);
        return api.getRun(runId);
      };
      return hasRunDetails(patch) ? tx(update) : update();
    },
    appendRunEvent(runId,event,dedupeKey,{verification,runPatch}={}) {
      return tx(()=>{
        const run = api.getRun(runId);
        if (!run) throw new AppError('任务不存在',404);
        if (run.status !== 'running') return null;
        const recorded = insertRunEvent(runId,event,dedupeKey);
        if (recorded && runPatch) saveRun(api.getRun(runId),runPatch);
        else if (recorded && verification !== undefined) {
          updateRunDetails(api.getRun(runId),{verification});
          db.prepare('UPDATE runs SET updated_at=? WHERE id=?').run(recorded.createdAt,runId);
        }
        return recorded;
      });
    },
    getRunEvents(runId,{after=0,limit=100}={}) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new AppError('任务事件分页无效');
      return db.prepare('SELECT seq,created_at,metadata FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?')
        .all(runId,after,Math.min(limit,RUN_EVENT_PAGE_LIMIT)).map(runEventView);
    },
    reconcileInterruptedRuns() {
      tx(()=>{
        const pending=db.prepare("SELECT * FROM reservations WHERE status='pending'").all();
        for(const r of pending){
          db.prepare('INSERT INTO request_usage(id,user_id,run_id,model,status,source,created_at,settled_at) VALUES(?,?,?,?,?,?,?,?)').run(id(),r.user_id,r.run_id,'unknown','unknown','legacy',r.created_at,now());
          db.prepare("UPDATE reservations SET status='retired' WHERE id=?").run(r.id);
        }
        db.prepare('UPDATE users SET reserved_tokens=0 WHERE reserved_tokens<>0').run();
        db.prepare("UPDATE request_usage SET status='unknown',input_tokens=NULL,output_tokens=NULL,total_tokens=NULL,settled_at=? WHERE status='pending'").run(now());
        const at = now();
        const interrupted = db.prepare("SELECT r.id,d.mode,d.verification_status FROM runs r JOIN run_details d ON d.run_id=r.id WHERE r.status='running'").all();
        for (const run of interrupted) {
          db.prepare(`UPDATE run_details SET interrupt_reason='restart',
            verification_status=CASE WHEN verification_status='running' THEN 'unknown' ELSE verification_status END,
            verification_exit_code=CASE WHEN verification_status='running' THEN NULL ELSE verification_exit_code END WHERE run_id=?`).run(run.id);
          const source = run.mode === 'chat' ? 'hosted' : run.mode ?? 'cloud';
          if (run.verification_status === 'running') insertRunEvent(run.id,{kind:'verification',source,status:'unknown',summary:'服务重启时验收尚无结果。'},'restart-verification',at);
          insertRunEvent(run.id,{kind:'task',source,status:'interrupted',summary:RESTART_ERROR},'restart-interrupted',at);
        }
        db.prepare("UPDATE runs SET status='interrupted',error=?,updated_at=? WHERE status='running'").run(RESTART_ERROR,at);
      });
    },
    audit,
    getAudit:()=>db.prepare('SELECT audit.*,users.username actor FROM audit LEFT JOIN users ON audit.actor_id=users.id ORDER BY audit.rowid DESC LIMIT 300').all().map(r=>({id:r.id,actor:r.actor??'system',action:r.action,target:r.target,detail:r.detail,createdAt:r.created_at})),
    overview:()=>({users:db.prepare('SELECT count(*) n FROM users').get().n,projects:db.prepare('SELECT count(*) n FROM projects').get().n,runs:db.prepare('SELECT count(*) n FROM runs').get().n,totalUsedTokens:api.getUsage({limit:0}).totals.totalTokens,unknownUsageRequests:api.getUsage({limit:0}).totals.unknownRequests,configuredUsers:db.prepare('SELECT count(*) n FROM user_credentials').get().n}),
  };
  return api;
}
