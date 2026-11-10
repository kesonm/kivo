import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './store.mjs';

const now = () => new Date().toISOString();
const id = () => randomUUID();
const digest = value => createHash('sha256').update(value).digest('hex');
const kinds = new Set(['repository', 'document', 'research', 'asset', 'collection']);
const states = new Set(['ready', 'running', 'waiting_input', 'waiting_approval', 'paused', 'succeeded', 'failed', 'cancelled', 'needs_reconciliation']);
const lifecycleKinds = new Set(['new', 'continue', 'rebuild', 'fork', 'revise']);
const engines = new Set(['chat', 'cloud', 'local']);
const failed = (message, code = 'work_conflict', status = 409) => new AppError(message, status, code);
const parse = (value, fallback) => value ? JSON.parse(value) : fallback;
const boundedText = (value, field, max = 1000, empty = false) => {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) throw failed(`${field}无效`, 'work_invalid', 400);
  return value.trim();
};
const referenceId = value => boundedText(value, '标识', 200);
const version = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw failed('版本无效', 'work_invalid', 400);
  return value;
};
const texts = (value = [], field = '约束', maxCount = 24, maxLength = 2000) => {
  if (!Array.isArray(value) || value.length > maxCount) throw failed(`${field}过多`, 'work_invalid', 400);
  return value.map(item => boundedText(item, field, maxLength));
};
const redacted = (value, max = 500) => String(value ?? '')
  .replace(/\bsk-[A-Za-z0-9_-]{16,}/gu, '[redacted]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+/=\-]{16,}/giu, 'Bearer [redacted]')
  .replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, max);

function environment(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failed('执行环境无效', 'work_invalid', 400);
  const mode = value.mode ?? (engines.has(value.engine) ? value.engine : value.engine === 'responses' ? 'chat' : null);
  if (!engines.has(mode) || !['chat', 'cloud', 'local', 'responses', 'codex-app-server'].includes(value.engine)) throw failed('执行引擎无效', 'work_invalid', 400);
  const result = { schemaVersion: 1, engine: mode === 'chat' ? 'responses' : 'codex-app-server', mode };
  // No provider credentials, full logs, prompts or arbitrary nested metadata enter
  // identity records. A URL alone is deliberately not an execution identity.
  for (const key of ['projectId', 'userId', 'workspace', 'workspaceId', 'repositoryId', 'branch', 'worktree', 'baseRevision', 'deviceId', 'model', 'runner', 'dirtyFingerprint', 'identityFingerprint', 'stateFingerprint']) {
    result[key] = value[key] == null ? null : boundedText(value[key], key, 4096);
  }
  for (const key of ['verified', 'reusable', 'requiresLocalValidation']) result[key] = value[key] === true;
  result.dirtyPaths = texts(value.dirtyPaths ?? [], '工作区变更路径', 25_000, 4096);
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw failed('执行环境快照过大', 'work_environment_large');
  return result;
}

function anchors(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failed('身份锚点无效', 'work_invalid', 400);
  const result = {};
  for (const key of ['repositoryId', 'workspaceId', 'branch', 'worktree', 'baseRevision', 'deviceId', 'path', 'location', 'sourceId']) {
    if (value[key] != null) result[key] = boundedText(value[key], key, 1000);
  }
  return result;
}

/** Application identities are independent of Codex/Responses thread identifiers.
 * All methods are synchronous and use the existing SQLite connection. Search is
 * against authoritative rows, not an eventually consistent semantic index. */
export function createWorkStore({ store }) {
  const db = store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_objects (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
      name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', anchors TEXT NOT NULL DEFAULT '{}',
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      origin_kind TEXT NOT NULL, origin_id TEXT, version INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS work_objects_origin ON work_objects(user_id,origin_kind,origin_id) WHERE origin_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS work_objects_owner ON work_objects(user_id,deleted_at);
    CREATE TABLE IF NOT EXISTS work_conversations (
      conversation_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      object_id TEXT NOT NULL REFERENCES work_objects(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_managed_conversations (
      conversation_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_tasks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), goal TEXT NOT NULL,
      constraints_json TEXT NOT NULL DEFAULT '[]', acceptance_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'ready', version INTEGER NOT NULL DEFAULT 1,
      generation INTEGER NOT NULL DEFAULT 0, parent_task_id TEXT REFERENCES work_tasks(id), relation TEXT,
      deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS work_tasks_owner ON work_tasks(user_id,deleted_at,updated_at);
    CREATE TABLE IF NOT EXISTS work_task_objects (
      task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
      object_id TEXT NOT NULL REFERENCES work_objects(id), role TEXT NOT NULL CHECK(role IN ('target','reference')),
      object_version INTEGER NOT NULL, PRIMARY KEY(task_id,object_id)
    );
    CREATE TABLE IF NOT EXISTS work_focus (
      conversation_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      object_id TEXT REFERENCES work_objects(id), task_id TEXT REFERENCES work_tasks(id),
      revision INTEGER NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_focus_history (
      conversation_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, object_id TEXT, task_id TEXT, source TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(conversation_id,revision)
    );
    CREATE TABLE IF NOT EXISTS work_sessions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES work_tasks(id), engine TEXT NOT NULL,
      engine_thread_id TEXT, environment TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS work_sessions_task ON work_sessions(task_id,created_at);
    CREATE TABLE IF NOT EXISTS work_run_bindings (
      run_id TEXT PRIMARY KEY REFERENCES runs(id), task_id TEXT NOT NULL REFERENCES work_tasks(id),
      conversation_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
      session_id TEXT NOT NULL REFERENCES work_sessions(id), task_version INTEGER NOT NULL,
      generation INTEGER NOT NULL, lifecycle TEXT NOT NULL, environment TEXT NOT NULL,
      object_versions TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', lease_token TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(task_id,generation)
    );
    CREATE TABLE IF NOT EXISTS work_leases (
      resource_key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES work_run_bindings(run_id),
      lease_token TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_message_links (
      task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id), source TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(task_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS work_question_messages (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_decisions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), decision TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS work_decisions_conversation ON work_decisions(conversation_id,created_at);
    CREATE TABLE IF NOT EXISTS work_events (
      run_id TEXT NOT NULL REFERENCES work_run_bindings(run_id), seq INTEGER NOT NULL,
      generation INTEGER NOT NULL, event_key TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(run_id,seq), UNIQUE(run_id,event_key)
    );
    CREATE TABLE IF NOT EXISTS work_evidence (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES work_tasks(id), run_id TEXT REFERENCES runs(id),
      kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, source TEXT NOT NULL,
      task_version INTEGER NOT NULL, supersedes_id TEXT REFERENCES work_evidence(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_artifacts (
      id TEXT PRIMARY KEY, family_id TEXT NOT NULL, version INTEGER NOT NULL,
      task_id TEXT NOT NULL REFERENCES work_tasks(id), run_id TEXT REFERENCES runs(id),
      kind TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
      supersedes_id TEXT REFERENCES work_artifacts(id), created_at TEXT NOT NULL,
      UNIQUE(family_id,version)
    );
    CREATE TABLE IF NOT EXISTS work_artifact_dependencies (
      artifact_id TEXT NOT NULL REFERENCES work_artifacts(id), input_artifact_id TEXT NOT NULL REFERENCES work_artifacts(id),
      PRIMARY KEY(artifact_id,input_artifact_id)
    );
    CREATE TABLE IF NOT EXISTS work_run_inputs (
      run_id TEXT NOT NULL REFERENCES work_run_bindings(run_id), artifact_id TEXT NOT NULL REFERENCES work_artifacts(id),
      artifact_version INTEGER NOT NULL, source_task_id TEXT NOT NULL REFERENCES work_tasks(id),
      source_task_version INTEGER NOT NULL, PRIMARY KEY(run_id,artifact_id)
    );
  `);

  let savepoint = 0;
  const tx = fn => {
    const name = `work_tx_${++savepoint}`;
    db.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); db.exec(`RELEASE ${name}`); return result; }
    catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
  };
  function account(userId) {
    const user = db.prepare('SELECT id,disabled FROM users WHERE id=?').get(referenceId(userId));
    if (!user || user.disabled) throw failed('账号不可用', 'work_forbidden', 403);
    return user;
  }
  function conversation(userId, conversationId) {
    account(userId);
    const row = db.prepare('SELECT * FROM threads WHERE id=? AND user_id=?').get(referenceId(conversationId), userId);
    if (!row) throw failed('对话不存在或不可访问', 'work_not_found', 404);
    return row;
  }
  function objectRow(userId, objectId) {
    account(userId);
    const row = db.prepare('SELECT * FROM work_objects WHERE id=? AND user_id=? AND deleted_at IS NULL').get(referenceId(objectId), userId);
    if (!row) throw failed('工作对象不存在或不可访问', 'work_not_found', 404);
    if (row.origin_kind === 'project') {
      const project = store.getProject(row.origin_id);
      if (!project || project.userId !== userId || row.project_id !== project.id) throw failed('工作对象已删除或权限已改变', 'work_not_found', 404);
      if (project.location === 'local' && !db.prepare('SELECT 1 FROM local_devices WHERE id=? AND user_id=? AND revoked=0').get(project.deviceId, userId)) throw failed('本地工作对象的授权已撤销', 'work_not_found', 404);
    }
    if (row.origin_kind === 'conversation' && !db.prepare('SELECT 1 FROM threads WHERE id=? AND user_id=?').get(row.origin_id, userId)) throw failed('工作对象的来源已删除', 'work_not_found', 404);
    return row;
  }
  function objectView(row) {
    const project = row.project_id ? store.getProject(row.project_id) : null;
    return { id: row.id, userId: row.user_id, kind: row.kind, name: project?.name ?? row.name,
      aliases: parse(row.aliases, []), anchors: parse(row.anchors, {}), projectId: row.project_id,
      sourceConversationId: row.origin_kind === 'conversation' ? row.origin_id : null,
      version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function taskRow(userId, taskId) {
    account(userId);
    const row = db.prepare('SELECT * FROM work_tasks WHERE id=? AND user_id=? AND deleted_at IS NULL').get(referenceId(taskId), userId);
    if (!row) throw failed('任务不存在或不可访问', 'work_not_found', 404);
    for (const link of db.prepare('SELECT object_id FROM work_task_objects WHERE task_id=?').all(row.id)) objectRow(userId, link.object_id);
    return row;
  }
  function taskObjects(userId, taskId) {
    return db.prepare('SELECT * FROM work_task_objects WHERE task_id=? ORDER BY rowid').all(taskId)
      .map(link => ({ ...objectView(objectRow(userId, link.object_id)), role: link.role, boundVersion: link.object_version }));
  }
  function taskView(row) {
    return { id: row.id, userId: row.user_id, goal: row.goal, constraints: parse(row.constraints_json, []),
      acceptance: parse(row.acceptance_json, []), status: row.status, state: row.status, version: row.version, generation: row.generation,
      parentTaskId: row.parent_task_id, relation: row.relation, objects: taskObjects(row.user_id, row.id),
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function ownedRun(userId, runId) {
    account(userId);
    const run = store.getRun(referenceId(runId));
    if (!run || run.userId !== userId) throw failed('执行记录不存在或不可访问', 'work_not_found', 404);
    return run;
  }
  function bindingRow(userId, runId) {
    ownedRun(userId, runId);
    return db.prepare('SELECT * FROM work_run_bindings WHERE run_id=?').get(runId) ?? null;
  }
  function bindingView(row) {
    if (!row) return null;
    const session = db.prepare('SELECT engine_thread_id FROM work_sessions WHERE id=?').get(row.session_id);
    return { runId: row.run_id, taskId: row.task_id, conversationId: row.conversation_id, taskVersion: row.task_version,
      generation: row.generation, sessionId: row.session_id, engineThreadId: session?.engine_thread_id ?? null,
      lifecycle: row.lifecycle, environment: parse(row.environment, {}), objectVersions: parse(row.object_versions, []),
      inputArtifacts: db.prepare('SELECT artifact_id,artifact_version,source_task_id,source_task_version FROM work_run_inputs WHERE run_id=? ORDER BY rowid').all(row.run_id)
        .map(input => ({ id: input.artifact_id, version: input.artifact_version, sourceTaskId: input.source_task_id, sourceTaskVersion: input.source_task_version })),
      leaseToken: row.lease_token, status: row.status, heartbeatAt: row.heartbeat_at, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function ensureProject(userId, projectId) {
    const project = store.getProject(projectId);
    if (!project || project.userId !== userId) throw failed('项目不存在或不可访问', 'work_not_found', 404);
    let row = db.prepare("SELECT * FROM work_objects WHERE user_id=? AND origin_kind='project' AND origin_id=?").get(userId, projectId);
    if (!row) {
      const at = now(), objectId = id();
      const identity = { workspaceId: projectId, location: project.location, ...(project.deviceId ? { deviceId: project.deviceId, path: project.localPath } : {}) };
      db.prepare(`INSERT INTO work_objects(id,user_id,kind,name,anchors,project_id,origin_kind,origin_id,created_at,updated_at)
        VALUES(?,?,'repository',?,?,?,'project',?,?,?)`).run(objectId, userId, project.name, JSON.stringify(identity), projectId, projectId, at, at);
      row = objectRow(userId, objectId);
    }
    return objectView(objectRow(userId, row.id));
  }
  function syncProjects(userId) {
    account(userId);
    for (const project of store.listProjects(userId)) {
      try { ensureProject(userId, project.id); } catch (error) { if (error.code !== 'work_not_found') throw error; }
    }
  }
  function checkVersion(row, expected) {
    if (row.version !== version(expected)) throw failed('工作状态已更新，请刷新后重试', 'work_version_conflict');
  }
  function checkedObjects(userId, values) {
    if (!Array.isArray(values) || values.length < 1 || values.length > 8) throw failed('请选择 1 至 8 个工作对象', 'work_invalid', 400);
    const seen = new Set();
    return values.map(link => {
      if (!link || !['target', 'reference'].includes(link.role) || seen.has(link.id)) throw failed('对象角色无效或重复', 'work_invalid', 400);
      seen.add(link.id);
      return { row: objectRow(userId, link.id), role: link.role };
    });
  }
  function writeObjects(taskId, links) {
    db.prepare('DELETE FROM work_task_objects WHERE task_id=?').run(taskId);
    for (const link of links) db.prepare('INSERT INTO work_task_objects(task_id,object_id,role,object_version) VALUES(?,?,?,?)').run(taskId, link.row.id, link.role, link.row.version);
  }
  function linkMessage(userId, taskId, messageId, conversationId, runId, source) {
    const row = db.prepare('SELECT m.id,m.thread_id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=? AND t.user_id=?').get(referenceId(messageId), userId);
    if (!row || (conversationId && row.thread_id !== conversationId)) throw failed('消息来源不存在或不可访问', 'work_not_found', 404);
    db.prepare('INSERT OR IGNORE INTO work_managed_conversations VALUES(?,?)').run(row.thread_id, now());
    return Number(db.prepare(`INSERT OR IGNORE INTO work_message_links(task_id,message_id,conversation_id,run_id,source,created_at) VALUES(?,?,?,?,?,?)`)
      .run(taskId, messageId, row.thread_id, runId ?? null, source, now()).changes);
  }
  function sourceExists(userId, taskId, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failed('证据来源无效', 'work_invalid', 400);
    const source = { type: value.type, id: referenceId(value.id) };
    if (source.type === 'message') {
      if (!db.prepare(`SELECT 1 FROM work_message_links l JOIN messages m ON m.id=l.message_id JOIN threads t ON t.id=m.thread_id
        WHERE l.task_id=? AND m.id=? AND t.user_id=?`).get(taskId, source.id, userId)) throw failed('消息未关联到此任务', 'work_not_found', 404);
    } else if (source.type === 'run') {
      const binding = bindingRow(userId, source.id);
      if (!binding || binding.task_id !== taskId) throw failed('执行记录未关联到此任务', 'work_not_found', 404);
      if (value.seq != null) {
        source.seq = version(value.seq);
        if (!db.prepare('SELECT 1 FROM run_events WHERE run_id=? AND seq=?').get(source.id, source.seq)) throw failed('执行证据不存在', 'work_not_found', 404);
      }
    } else if (source.type === 'chat_artifact') {
      if (!db.prepare(`SELECT 1 FROM chat_artifacts a JOIN work_message_links l ON l.message_id=a.message_id
        JOIN threads t ON t.id=l.conversation_id WHERE a.id=? AND l.task_id=? AND t.user_id=?`).get(source.id, taskId, userId)) throw failed('附件未关联到此任务', 'work_not_found', 404);
    } else if (source.type === 'artifact') {
      const artifact = artifactRow(userId, source.id);
      if (artifact.task_id !== taskId || value.version !== artifact.version) throw failed('产物版本未关联到此任务', 'work_not_found', 404);
      source.version = artifact.version;
    } else if (source.type === 'project_file') {
      const links = taskObjects(userId, taskId);
      if (!links.some(link => link.projectId === source.id)) throw failed('文件不属于此任务的工作范围', 'work_not_found', 404);
      source.path = boundedText(value.path, '文件路径', 500);
      if (source.path.startsWith('/') || source.path.includes('\\') || source.path.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/u.test(source.path)) throw failed('文件路径必须是工作区内的相对路径', 'work_invalid', 400);
      source.revision = boundedText(value.revision, '文件版本', 200);
    } else throw failed('不支持的来源类型', 'work_invalid', 400);
    return source;
  }
  function evidenceView(row) {
    return { id: row.id, taskId: row.task_id, runId: row.run_id, kind: row.kind, status: row.status, summary: row.summary,
      source: parse(row.source, {}), taskVersion: row.task_version, supersedesId: row.supersedes_id, createdAt: row.created_at };
  }
  function artifactView(row) {
    return { id: row.id, familyId: row.family_id, version: row.version, taskId: row.task_id, runId: row.run_id,
      kind: row.kind, name: row.name, source: parse(row.source, {}), status: row.status, supersedesId: row.supersedes_id, createdAt: row.created_at,
      dependencies: db.prepare('SELECT input_artifact_id FROM work_artifact_dependencies WHERE artifact_id=?').all(row.id).map(item => item.input_artifact_id) };
  }
  function artifactRow(userId, artifactId, ancestors = new Set()) {
    account(userId);
    const row = db.prepare('SELECT * FROM work_artifacts WHERE id=?').get(referenceId(artifactId));
    if (!row) throw failed('产物不存在或不可访问', 'work_not_found', 404);
    if (ancestors.has(row.id) || ancestors.size > 64) throw failed('产物依赖过深或存在循环，不能用于执行', 'work_artifact_stale');
    taskRow(userId, row.task_id);
    try { sourceExists(userId, row.task_id, parse(row.source, {})); }
    catch (error) {
      if (error.code === 'work_not_found' && row.status === 'current') invalidateArtifactTree(row.id, true);
      throw error;
    }
    const nextAncestors = new Set([...ancestors, row.id]);
    let invalidInput = false;
    for (const dependency of db.prepare('SELECT input_artifact_id FROM work_artifact_dependencies WHERE artifact_id=?').all(row.id)) {
      const input = canRead(() => artifactRow(userId, dependency.input_artifact_id, nextAncestors));
      if (!input || input.status !== 'current') invalidInput = true;
    }
    if (invalidInput && row.status === 'current') {
      invalidateArtifactTree(row.id, true);
      row.status = 'stale';
    }
    return row;
  }
  function scopedInputArtifact(userId, taskId, artifactId) {
    const task = taskRow(userId, taskId), artifact = artifactRow(userId, artifactId);
    if (artifact.status !== 'current') throw failed('参考产物已更新或失效，请重新组装上下文', 'work_artifact_stale');
    const sourceTask = taskRow(userId, artifact.task_id);
    if (task.id !== sourceTask.id) {
      const referenceObjects = new Set(taskObjects(userId, taskId).filter(link => link.role === 'reference').map(link => link.id));
      if (!taskObjects(userId, sourceTask.id).some(link => link.role === 'target' && referenceObjects.has(link.id))) {
        throw failed('参考产物不属于此任务明确授权的参考对象', 'work_reference_scope', 403);
      }
    }
    return { artifact, sourceTask };
  }
  function assertRunInputs(userId, row) {
    const inputs = db.prepare('SELECT * FROM work_run_inputs WHERE run_id=?').all(row.run_id);
    for (const input of inputs) {
      const { artifact, sourceTask } = scopedInputArtifact(userId, row.task_id, input.artifact_id);
      if (artifact.version !== input.artifact_version || sourceTask.id !== input.source_task_id || sourceTask.version !== input.source_task_version) {
        throw failed('参考产物或源任务版本已变化', 'work_artifact_stale');
      }
    }
    return inputs;
  }
  function invalidateTaskArtifacts(taskId) {
    const affectedTasks = db.prepare(`WITH RECURSIVE affected(id) AS (
      SELECT id FROM work_artifacts WHERE task_id=?
      UNION SELECT d.artifact_id FROM work_artifact_dependencies d JOIN affected a ON d.input_artifact_id=a.id
    ) SELECT DISTINCT task_id FROM work_artifacts WHERE id IN (SELECT id FROM affected) AND status='current'`).all(taskId);
    db.prepare(`WITH RECURSIVE affected(id) AS (
      SELECT id FROM work_artifacts WHERE task_id=?
      UNION SELECT d.artifact_id FROM work_artifact_dependencies d JOIN affected a ON d.input_artifact_id=a.id
    ) UPDATE work_artifacts SET status='stale' WHERE id IN (SELECT id FROM affected) AND status='current'`).run(taskId);
    db.prepare("UPDATE work_evidence SET status='superseded' WHERE task_id=? AND kind IN ('decision','constraint','verification')").run(taskId);
    invalidateAcceptedTasks(affectedTasks);
  }
  function invalidateAcceptedTasks(rows) {
    for (const row of rows) {
      const acceptance = db.prepare("SELECT source FROM work_evidence WHERE task_id=? AND kind='decision' AND status='verified' ORDER BY rowid DESC")
        .all(row.task_id).map(item => parse(item.source, {})).find(source => source.authority === 'user_acceptance');
      if (acceptance && db.prepare("SELECT 1 FROM work_artifacts WHERE id=? AND status='current'").get(acceptance.id)) continue;
      db.prepare("UPDATE work_tasks SET status='needs_reconciliation',updated_at=? WHERE id=? AND status='succeeded'").run(now(), row.task_id);
      db.prepare("UPDATE work_evidence SET status='superseded' WHERE task_id=? AND kind IN ('decision','verification')").run(row.task_id);
    }
  }
  function invalidateArtifactTree(artifactId, includeSource = false) {
    const affectedTasks = db.prepare(`WITH RECURSIVE affected(id) AS (
      SELECT artifact_id FROM work_artifact_dependencies WHERE input_artifact_id=?
      UNION SELECT d.artifact_id FROM work_artifact_dependencies d JOIN affected a ON d.input_artifact_id=a.id
    ) SELECT DISTINCT task_id FROM work_artifacts WHERE (id IN (SELECT id FROM affected) OR (?=1 AND id=?)) AND status='current'`)
      .all(artifactId, Number(includeSource), artifactId);
    db.prepare(`WITH RECURSIVE affected(id) AS (
      SELECT artifact_id FROM work_artifact_dependencies WHERE input_artifact_id=?
      UNION SELECT d.artifact_id FROM work_artifact_dependencies d JOIN affected a ON d.input_artifact_id=a.id
    ) UPDATE work_artifacts SET status='stale' WHERE (id IN (SELECT id FROM affected) OR (?=1 AND id=?)) AND status='current'`)
      .run(artifactId, Number(includeSource), artifactId);
    invalidateAcceptedTasks(affectedTasks);
  }
  function recentRunEvents(runId) {
    const maximum = db.prepare('SELECT coalesce(max(seq),0) seq FROM run_events WHERE run_id=?').get(runId).seq;
    const events = store.getRunEvents(runId, { after: Math.max(0, maximum - 300), limit: 300 });
    return { events, truncated: maximum > events.length };
  }
  function event(row, key, metadata) {
    const eventKey = digest(boundedText(key, '事件标识', 300));
    if (db.prepare('SELECT 1 FROM work_events WHERE run_id=? AND event_key=?').get(row.run_id, eventKey)) return null;
    const seq = db.prepare('SELECT coalesce(max(seq),0)+1 seq FROM work_events WHERE run_id=?').get(row.run_id).seq;
    const at = now();
    db.prepare('INSERT INTO work_events(run_id,seq,generation,event_key,metadata,created_at) VALUES(?,?,?,?,?,?)')
      .run(row.run_id, seq, row.generation, eventKey, JSON.stringify(metadata), at);
    return { runId: row.run_id, seq, generation: row.generation, ...metadata, createdAt: at };
  }
  function boundedLimit(value = 100) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw failed('分页无效', 'work_invalid', 400);
    return value;
  }
  function searchValue(value = '') { return boundedText(value, '检索词', 200, true).replace(/[\\%_]/gu, character => '\\' + character); }
  function canRead(fn) { try { return fn(); } catch (error) { if (error.code === 'work_not_found') return null; throw error; } }

  const api = {
    ensureProject(userId, projectId) { account(userId); return ensureProject(userId, projectId); },
    assertProjectIdle(userId, projectId) {
      account(userId);
      const object = ensureProject(userId, referenceId(projectId));
      if (db.prepare('SELECT 1 FROM work_leases WHERE resource_key IN (?,?) LIMIT 1').get('project:' + projectId, 'object:' + object.id)) {
        throw failed('项目仍有执行占用或停止状态待核对，暂不能修改文件或开始其他任务', 'work_resource_busy');
      }
      return { idle: true };
    },
    isManagedConversation(userId, conversationId) {
      conversation(userId, conversationId);
      if (db.prepare('SELECT 1 FROM work_managed_conversations WHERE conversation_id=?').get(conversationId)) return true;
      const managed = db.prepare(`SELECT 1 FROM work_run_bindings WHERE conversation_id=?
        UNION ALL SELECT 1 FROM work_message_links WHERE conversation_id=?
        UNION ALL SELECT 1 FROM work_focus_history WHERE conversation_id=? AND task_id IS NOT NULL
        UNION ALL SELECT 1 FROM work_focus WHERE conversation_id=? AND task_id IS NOT NULL LIMIT 1`).get(conversationId, conversationId, conversationId, conversationId);
      if (managed) db.prepare('INSERT OR IGNORE INTO work_managed_conversations VALUES(?,?)').run(conversationId, now());
      return Boolean(managed);
    },
    ensureConversation(userId, conversationId) {
      return tx(() => {
        const thread = conversation(userId, conversationId);
        let row = db.prepare('SELECT * FROM work_conversations WHERE conversation_id=?').get(conversationId);
        if (!row) {
          let object;
          if (thread.project_id) object = ensureProject(userId, thread.project_id);
          else {
            const objectId = id(), at = now();
            db.prepare(`INSERT INTO work_objects(id,user_id,kind,name,origin_kind,origin_id,created_at,updated_at)
              VALUES(?,?,'collection',?,'conversation',?,?,?)`).run(objectId, userId, thread.title, conversationId, at, at);
            object = objectView(objectRow(userId, objectId));
          }
          db.prepare('INSERT INTO work_conversations(conversation_id,object_id,created_at) VALUES(?,?,?)').run(conversationId, object.id, now());
          row = { conversation_id: conversationId, object_id: object.id };
        }
        const total = db.prepare('SELECT count(*) n FROM messages WHERE thread_id=?').get(conversationId).n;
        const linked = db.prepare('SELECT count(DISTINCT message_id) n FROM work_message_links WHERE conversation_id=?').get(conversationId).n;
        return { conversationId, object: objectView(objectRow(userId, row.object_id)), focus: api.getFocus(userId, conversationId),
          historyStatus: total === 0 ? 'empty' : linked === 0 ? 'unassigned' : linked < total ? 'partial' : 'linked', unassignedMessages: total - linked };
      });
    },
    createObject(userId, data) {
      account(userId);
      if (!data || !kinds.has(data.kind)) throw failed('工作对象类型无效', 'work_invalid', 400);
      if (data.projectId != null) return ensureProject(userId, referenceId(data.projectId));
      const name = boundedText(data.name, '对象名称', 200), aliases = texts(data.aliases, '别名', 16, 200), identity = anchors(data.anchors);
      const objectId = id(), at = now();
      db.prepare(`INSERT INTO work_objects(id,user_id,kind,name,aliases,anchors,origin_kind,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'custom',?,?)`).run(objectId, userId, data.kind, name, JSON.stringify(aliases), JSON.stringify(identity), at, at);
      return objectView(objectRow(userId, objectId));
    },
    getObject(userId, objectId) { return objectView(objectRow(userId, objectId)); },
    listObjects(userId, { query = '', limit = 100, offset = 0 } = {}) {
      syncProjects(userId); boundedLimit(limit); version(offset);
      const term = '%' + searchValue(query) + '%';
      return db.prepare(`SELECT * FROM work_objects WHERE user_id=? AND deleted_at IS NULL
        AND (id=? OR name LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\'
          OR project_id IN (SELECT id FROM projects WHERE user_id=? AND name LIKE ? ESCAPE '\\'))
        ORDER BY updated_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(userId, query, term, term, userId, term, limit, offset)
        .map(row => canRead(() => objectView(objectRow(userId, row.id)))).filter(Boolean);
    },
    updateObject(userId, objectId, data) {
      return tx(() => {
        const row = objectRow(userId, objectId); checkVersion(row, data.expectedVersion);
        if (db.prepare('SELECT 1 FROM work_leases WHERE resource_key=?').get('object:' + objectId)) throw failed('对象仍有执行占用，请先停止并核对执行结果', 'work_resource_busy');
        if (row.origin_kind === 'project' && data.anchors !== undefined) throw failed('项目位置由执行器管理，不能用对象元数据重定向工作区', 'work_invalid', 400);
        const at = now();
        db.prepare('UPDATE work_objects SET name=?,aliases=?,anchors=?,version=version+1,updated_at=? WHERE id=?').run(
          data.name === undefined ? row.name : boundedText(data.name, '对象名称', 200),
          data.aliases === undefined ? row.aliases : JSON.stringify(texts(data.aliases, '别名', 16, 200)),
          data.anchors === undefined ? row.anchors : JSON.stringify(anchors(data.anchors)), at, objectId);
        // Bound versions remain historical. The next execution must explicitly
        // acknowledge a task rebind rather than silently inherit new constraints.
        db.prepare(`UPDATE work_tasks SET status='needs_reconciliation',updated_at=? WHERE id IN
          (SELECT task_id FROM work_task_objects WHERE object_id=?)`).run(at, objectId);
        for (const linked of db.prepare('SELECT task_id FROM work_task_objects WHERE object_id=?').all(objectId)) invalidateTaskArtifacts(linked.task_id);
        return objectView(objectRow(userId, objectId));
      });
    },
    deleteObject(userId, objectId, { expectedVersion } = {}) {
      return tx(() => {
        const row = objectRow(userId, objectId); checkVersion(row, expectedVersion);
        if (db.prepare('SELECT 1 FROM work_leases WHERE resource_key=?').get('object:' + objectId)) throw failed('对象仍有执行占用，请先停止任务', 'work_resource_busy');
        const at = now();
        db.prepare('UPDATE work_objects SET deleted_at=?,version=version+1,updated_at=? WHERE id=?').run(at, at, objectId);
        db.prepare(`UPDATE work_tasks SET status='needs_reconciliation',version=version+1,generation=generation+1,updated_at=?
          WHERE id IN (SELECT task_id FROM work_task_objects WHERE object_id=?)`).run(at, objectId);
        return { deleted: true };
      });
    },
    createTask(userId, data) {
      return tx(() => {
        account(userId);
        const goal = boundedText(data.goal, '任务目标', 24000), links = checkedObjects(userId, data.objects);
        const constraints = texts(data.constraints), acceptance = texts(data.acceptance, '完成条件');
        if (data.parentTaskId != null) {
          taskRow(userId, data.parentTaskId);
          if (!['fork', 'revision'].includes(data.relation)) throw failed('后续任务关系无效', 'work_invalid', 400);
        } else if (data.relation != null) throw failed('后续任务缺少来源任务', 'work_invalid', 400);
        if (data.conversationId) conversation(userId, data.conversationId);
        const taskId = id(), at = now();
        db.prepare(`INSERT INTO work_tasks(id,user_id,goal,constraints_json,acceptance_json,parent_task_id,relation,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(taskId, userId, goal, JSON.stringify(constraints), JSON.stringify(acceptance), data.parentTaskId ?? null, data.relation ?? null, at, at);
        writeObjects(taskId, links);
        return taskView(taskRow(userId, taskId));
      });
    },
    getTask(userId, taskId) { return taskView(taskRow(userId, taskId)); },
    listTasks(userId, { query = '', objectId, conversationId, limit = 100, offset = 0 } = {}) {
      account(userId); boundedLimit(limit); version(offset);
      if (objectId) objectRow(userId, objectId);
      if (conversationId) conversation(userId, conversationId);
      const term = '%' + searchValue(query) + '%';
      return db.prepare(`SELECT t.* FROM work_tasks t WHERE t.user_id=? AND t.deleted_at IS NULL
        AND (t.id=? OR t.goal LIKE ? ESCAPE '\\')
        AND (? IS NULL OR EXISTS(SELECT 1 FROM work_task_objects x WHERE x.task_id=t.id AND x.object_id=?))
        AND (? IS NULL OR EXISTS(SELECT 1 FROM work_message_links l WHERE l.task_id=t.id AND l.conversation_id=?)
          OR EXISTS(SELECT 1 FROM work_focus f WHERE f.task_id=t.id AND f.conversation_id=?))
        ORDER BY t.updated_at DESC,t.rowid DESC LIMIT ? OFFSET ?`).all(userId, query, term, objectId ?? null, objectId ?? null,
        conversationId ?? null, conversationId ?? null, conversationId ?? null, limit, offset)
        .map(row => canRead(() => taskView(taskRow(userId, row.id)))).filter(Boolean);
    },
    updateTask(userId, taskId, data) {
      return tx(() => {
        const row = taskRow(userId, taskId); checkVersion(row, data.expectedVersion);
        const links = data.objects === undefined ? null : checkedObjects(userId, data.objects);
        if (links && db.prepare('SELECT 1 FROM work_leases WHERE resource_key=?').get('task:' + taskId)) throw failed('更换目标前请停止并核对现有执行', 'work_resource_busy');
        const status = data.status ?? (row.status === 'running' ? 'needs_reconciliation' : 'ready');
        if (!states.has(status) || ['running', 'succeeded'].includes(status)) throw failed('不能手动声明执行中或验收成功', 'work_invalid', 400);
        db.prepare(`UPDATE work_tasks SET goal=?,constraints_json=?,acceptance_json=?,status=?,version=version+1,
          generation=generation+1,updated_at=? WHERE id=?`).run(data.goal === undefined ? row.goal : boundedText(data.goal, '任务目标', 24000),
          data.constraints === undefined ? row.constraints_json : JSON.stringify(texts(data.constraints)),
          data.acceptance === undefined ? row.acceptance_json : JSON.stringify(texts(data.acceptance, '完成条件')), status, now(), taskId);
        if (links) writeObjects(taskId, links);
        db.prepare("UPDATE work_run_bindings SET status='revoked',updated_at=? WHERE task_id=? AND status='running'").run(now(), taskId);
        db.prepare("UPDATE work_sessions SET status='stale',updated_at=? WHERE task_id=?").run(now(), taskId);
        invalidateTaskArtifacts(taskId);
        return taskView(taskRow(userId, taskId));
      });
    },
    cancelTask(userId, taskId, { expectedVersion, reason = '' } = {}) {
      return tx(() => {
        const task = api.updateTask(userId, taskId, { expectedVersion, status: 'cancelled' });
        store.audit(userId, 'work.task.cancelled', taskId, redacted(reason));
        return task;
      });
    },
    acceptTask(userId, taskId, { expectedVersion, artifactId } = {}) {
      return tx(() => {
        const task = taskRow(userId, taskId); checkVersion(task, expectedVersion);
        if (task.status === 'cancelled') throw failed('任务已取消，请先明确修订目标', 'work_cancelled');
        if (db.prepare('SELECT 1 FROM work_leases WHERE resource_key=?').get('task:' + taskId)) throw failed('仍有执行或未知停止状态，暂不能验收', 'work_resource_busy');
        const artifact = artifactRow(userId, artifactId);
        if (artifact.task_id !== taskId || artifact.status !== 'current') throw failed('只能确认此任务当前有效的具体产物版本', 'work_artifact_stale');
        const at = now(), nextVersion = task.version + 1;
        db.prepare("UPDATE work_tasks SET status='succeeded',version=?,generation=generation+1,updated_at=? WHERE id=?").run(nextVersion, at, taskId);
        db.prepare("UPDATE work_sessions SET status='stale',updated_at=? WHERE task_id=?").run(at, taskId);
        db.prepare('INSERT INTO work_evidence VALUES(?,?,?,?,?,?,?,?,?,?)').run(id(), taskId, null, 'decision', 'verified',
          `用户明确验收了产物第 ${artifact.version} 版；人工验收不代表系统运行过测试。`,
          JSON.stringify({ type: 'artifact', id: artifact.id, version: artifact.version, authority: 'user_acceptance', actorId: userId }), nextVersion, null, at);
        store.audit(userId, 'work.task.accepted', taskId, JSON.stringify({ artifactId: artifact.id, artifactVersion: artifact.version, taskVersion: nextVersion }));
        return taskView(taskRow(userId, taskId));
      });
    },
    getFocus(userId, conversationId) {
      conversation(userId, conversationId);
      const row = db.prepare('SELECT * FROM work_focus WHERE conversation_id=?').get(conversationId);
      const view = r => ({ objectId: r.object_id, taskId: r.task_id, revision: r.revision, source: r.source, updatedAt: r.updated_at });
      const valid = r => (!r.object_id || canRead(() => objectRow(userId, r.object_id))) && (!r.task_id || canRead(() => taskRow(userId, r.task_id)));
      const history = db.prepare('SELECT * FROM work_focus_history WHERE conversation_id=? ORDER BY revision DESC LIMIT 12').all(conversationId).filter(valid).map(view);
      if (!row) return { objectId: null, taskId: null, revision: 0, source: 'none', updatedAt: null, history };
      return { ...view(row), ...(!valid(row) ? { objectId: null, taskId: null, source: 'unavailable' } : {}), history };
    },
    setFocus(userId, conversationId, { objectId = null, taskId = null, expectedRevision, source = 'explicit' }) {
      return tx(() => {
        conversation(userId, conversationId);
        if (!['explicit', 'route', 'correction', 'history', 'explicit_question', 'user_request'].includes(source)) throw failed('焦点来源无效', 'work_invalid', 400);
        const current = db.prepare('SELECT revision FROM work_focus WHERE conversation_id=?').get(conversationId)?.revision ?? 0;
        if (current !== version(expectedRevision)) throw failed('此对话的工作焦点已更新，请刷新后选择', 'work_focus_conflict');
        if (taskId) {
          const task = taskView(taskRow(userId, taskId));
          objectId ??= task.objects.find(link => link.role === 'target')?.id ?? task.objects[0]?.id ?? null;
          if (objectId && !task.objects.some(link => link.id === objectId)) throw failed('焦点对象不属于所选任务', 'work_invalid', 400);
        }
        if (objectId) objectRow(userId, objectId);
        const revision = current + 1, at = now();
        db.prepare(`INSERT INTO work_focus(conversation_id,object_id,task_id,revision,source,updated_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(conversation_id) DO UPDATE SET object_id=excluded.object_id,task_id=excluded.task_id,
          revision=excluded.revision,source=excluded.source,updated_at=excluded.updated_at`).run(conversationId, objectId, taskId, revision, source, at);
        db.prepare('INSERT INTO work_focus_history VALUES(?,?,?,?,?,?)').run(conversationId, revision, objectId, taskId, source, at);
        if (taskId) db.prepare('INSERT OR IGNORE INTO work_managed_conversations VALUES(?,?)').run(conversationId, at);
        db.prepare('DELETE FROM work_focus_history WHERE conversation_id=? AND revision<=?').run(conversationId, revision - 12);
        return api.getFocus(userId, conversationId);
      });
    },
    recordDecision(userId, conversationId, decision) {
      conversation(userId, conversationId);
      if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw failed('路由决策无效', 'work_invalid', 400);
      const metadata = {};
      for (const key of ['status', 'intent', 'operation', 'lifecycle', 'mode', 'reason']) if (decision[key] != null) metadata[key] = redacted(decision[key]);
      if (decision.taskId) { taskRow(userId, decision.taskId); metadata.taskId = decision.taskId; }
      if (decision.objectId) { objectRow(userId, decision.objectId); metadata.objectId = decision.objectId; }
      for (const key of ['excluded', 'unresolved', 'allowedPaths', 'allowed']) {
        if (decision[key] !== undefined) {
          if (!Array.isArray(decision[key]) || decision[key].length > 32) throw failed('路由决策过大', 'work_invalid', 400);
          metadata[key] = decision[key].map(item => typeof item === 'string' ? redacted(item) : redacted(JSON.stringify(item)));
        }
      }
      if (decision.evidence !== undefined) {
        if (!Array.isArray(decision.evidence) || decision.evidence.length > 32) throw failed('路由证据过多', 'work_invalid', 400);
        metadata.evidence = decision.evidence.map(item => {
          if (typeof item === 'string') return redacted(item);
          if (!item || !['explicit_task', 'conversation_focus', 'explicit_object', 'exact_name', 'selected_workspace'].includes(item.source)) throw failed('路由证据来源无效', 'work_invalid', 400);
          if (['explicit_task', 'conversation_focus'].includes(item.source)) taskRow(userId, item.id);
          else objectRow(userId, item.id);
          return { source: item.source, id: item.id, ...(item.version === undefined ? {} : { version: version(item.version) }),
            ...(item.revision === undefined ? {} : { revision: version(item.revision) }) };
        });
      }
      if (Array.isArray(decision.candidates)) metadata.candidates = decision.candidates.slice(0, 8).map(candidate => {
        const taskId = typeof candidate === 'string' ? candidate : candidate.taskId ?? candidate.id;
        taskRow(userId, taskId);
        return { taskId };
      });
      if (Array.isArray(decision.referenceIds)) metadata.referenceIds = decision.referenceIds.slice(0, 8).map(objectId => { objectRow(userId, objectId); return objectId; });
      if (Array.isArray(decision.objectCandidates)) metadata.objectCandidates = decision.objectCandidates.slice(0, 8).map(candidate => {
        const object = objectView(objectRow(userId, candidate.id));
        return { id: object.id, name: object.name, projectId: object.projectId };
      });
      if (decision.runId) {
        const run = ownedRun(userId, decision.runId), binding = bindingRow(userId, run.id);
        if (!binding || binding.conversation_id !== conversationId || (decision.taskId && binding.task_id !== decision.taskId)) throw failed('路由执行记录不匹配', 'work_run_invalid');
        metadata.runId = run.id;
        if (decision.sessionId) {
          if (decision.sessionId !== binding.session_id) throw failed('路由会话记录不匹配', 'work_run_invalid');
          metadata.sessionId = decision.sessionId;
        }
      }
      if (decision.context) {
        const context = decision.context;
        taskRow(userId, context.taskId);
        if (decision.taskId && decision.taskId !== context.taskId) throw failed('上下文与任务不一致', 'work_invalid', 400);
        if (!Array.isArray(context.sources) || context.sources.length > 400) throw failed('上下文清单过大', 'work_invalid', 400);
        const sources = context.sources.map(source => {
          if (source.kind === 'task') { const task = taskRow(userId, source.id); if (task.id !== context.taskId) throw failed('上下文任务不一致', 'work_invalid', 400); }
          else if (source.kind === 'object') objectRow(userId, source.id);
          else if (source.kind === 'message') sourceExists(userId, context.taskId, { type: 'message', id: source.id });
          else if (source.kind === 'artifact') {
            const { artifact, sourceTask } = scopedInputArtifact(userId, context.taskId, source.id);
            if (source.version !== artifact.version || source.sourceTaskId !== sourceTask.id) throw failed('引用产物版本或来源任务不一致', 'work_artifact_stale');
          }
          else throw failed('上下文来源类型无效', 'work_invalid', 400);
          return { kind: source.kind, id: source.id, ...(source.version == null ? {} : { version: version(source.version) }),
            ...(source.sourceTaskId ? { sourceTaskId: source.sourceTaskId } : {}), ...(source.role ? { role: redacted(source.role, 20) } : {}) };
        });
        metadata.context = { taskId: context.taskId, taskVersion: version(context.taskVersion), bytes: version(context.bytes), sources,
          lifecycle: redacted(context.lifecycle, 40), budget: { maxBytes: version(context.budget.maxBytes), outputTokens: version(context.budget.outputTokens),
            model: redacted(context.budget.model, 100), basis: redacted(context.budget.basis, 100) } };
      }
      const decisionId = id(), at = now();
      db.prepare('INSERT INTO work_decisions VALUES(?,?,?,?,?)').run(decisionId, conversationId, userId, JSON.stringify(metadata), at);
      return { id: decisionId, conversationId, ...metadata, createdAt: at };
    },
    getDecisions(userId, conversationId, { limit = 20 } = {}) {
      conversation(userId, conversationId); boundedLimit(limit);
      // Decisions retain identifiers and short explanations, never full prompts or
      // model reasoning. Read-time validation also hides revoked/deleted targets.
      return db.prepare('SELECT * FROM work_decisions WHERE conversation_id=? AND user_id=? ORDER BY rowid DESC LIMIT ?')
        .all(conversationId, userId, limit).map(row => {
          const decision = parse(row.decision, {});
          if (decision.taskId && !canRead(() => taskRow(userId, decision.taskId))) return null;
          if (decision.objectId && !canRead(() => objectRow(userId, decision.objectId))) return null;
          if (decision.candidates) decision.candidates = decision.candidates.filter(candidate => canRead(() => taskRow(userId, candidate.taskId)));
          if (decision.referenceIds) decision.referenceIds = decision.referenceIds.filter(objectId => canRead(() => objectRow(userId, objectId)));
          if (decision.objectCandidates) decision.objectCandidates = decision.objectCandidates.filter(candidate => canRead(() => objectRow(userId, candidate.id)));
          if (decision.evidence) decision.evidence = decision.evidence.filter(item => typeof item === 'string' || canRead(() =>
            ['explicit_task', 'conversation_focus'].includes(item.source) ? taskRow(userId, item.id) : objectRow(userId, item.id)));
          if (decision.context) {
            const stillReadable = decision.context.sources.every(source => canRead(() => source.kind === 'message'
              ? sourceExists(userId, decision.context.taskId, { type: 'message', id: source.id })
              : source.kind === 'object' ? objectRow(userId, source.id) : source.kind === 'artifact' ? artifactRow(userId, source.id) : taskRow(userId, source.id)));
            if (!stillReadable) decision.context = { unavailable: true };
          }
          return { id: row.id, conversationId, ...decision, createdAt: row.created_at };
        }).filter(Boolean);
    },
    linkMessages(userId, taskId, { conversationId, startMessageId, endMessageId = startMessageId, runId, source = 'explicit' }) {
      return tx(() => {
        taskRow(userId, taskId); conversation(userId, conversationId);
        if (!['explicit', 'run'].includes(source)) throw failed('消息关联来源无效', 'work_invalid', 400);
        if (source === 'explicit' && db.prepare('SELECT 1 FROM work_leases WHERE resource_key=?').get('task:' + taskId)) throw failed('导入历史前请停止并核对当前执行', 'work_resource_busy');
        if (runId && bindingRow(userId, runId)?.task_id !== taskId) throw failed('执行记录与任务不一致', 'work_not_found', 404);
        const start = db.prepare('SELECT rowid FROM messages WHERE id=? AND thread_id=?').get(startMessageId, conversationId);
        const end = db.prepare('SELECT rowid FROM messages WHERE id=? AND thread_id=?').get(endMessageId, conversationId);
        if (!start || !end || end.rowid < start.rowid) throw failed('消息范围无效', 'work_invalid', 400);
        const rows = db.prepare('SELECT id FROM messages WHERE thread_id=? AND rowid BETWEEN ? AND ? ORDER BY rowid LIMIT 501').all(conversationId, start.rowid, end.rowid);
        if (rows.length > 500) throw failed('单次最多关联 500 条消息', 'work_invalid', 400);
        let linked = 0;
        for (const row of rows) linked += linkMessage(userId, taskId, row.id, conversationId, runId, source);
        if (source === 'explicit' && linked) {
          db.prepare('UPDATE work_tasks SET version=version+1,generation=generation+1,updated_at=? WHERE id=?').run(now(), taskId);
          db.prepare("UPDATE work_sessions SET status='stale',updated_at=? WHERE task_id=?").run(now(), taskId);
          invalidateTaskArtifacts(taskId);
        }
        return { linked };
      });
    },
    recordQuestionMessage(userId, conversationId, messageId) {
      conversation(userId, conversationId);
      const message = db.prepare("SELECT 1 FROM messages WHERE id=? AND thread_id=? AND role IN ('user','assistant')").get(referenceId(messageId), conversationId);
      if (!message) throw failed('普通问答消息不存在', 'work_not_found', 404);
      if (db.prepare('SELECT 1 FROM work_message_links WHERE message_id=?').get(messageId)) throw failed('任务消息不能作为普通问答历史', 'work_message_scope');
      const result = db.prepare('INSERT OR IGNORE INTO work_question_messages VALUES(?,?,?)').run(messageId, conversationId, now());
      return { recorded: Number(result.changes) > 0 };
    },
    getQuestionMessages(userId, conversationId, { maxMessages = 200, maxBytes = 512 * 1024 } = {}) {
      const thread = conversation(userId, conversationId);
      if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 2000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) throw failed('普通问答上下文预算无效', 'work_invalid', 400);
      const legacyOrdinary = thread.project_id === null && !api.isManagedConversation(userId, conversationId);
      const messages = [], rows = db.prepare(`SELECT m.* FROM messages m
        WHERE m.thread_id=? AND m.role IN ('user','assistant')
        AND (?=1 OR EXISTS(SELECT 1 FROM work_question_messages q WHERE q.message_id=m.id AND q.conversation_id=?))
        AND NOT EXISTS(SELECT 1 FROM work_message_links l WHERE l.message_id=m.id) ORDER BY m.rowid`).iterate(conversationId, Number(legacyOrdinary), conversationId);
      let bytes = 0;
      for (const row of rows) {
        bytes += Buffer.byteLength(row.content);
        if (messages.length >= maxMessages || bytes > maxBytes) throw failed('普通问答历史超过预算，请新建对话或明确关联需要继续的任务', 'context_too_large');
        messages.push({ id: row.id, role: row.role, content: row.content, conversationId, createdAt: row.created_at });
      }
      return messages;
    },
    prepareRun(userId, { conversationId, taskId, runId, expectedVersion, lifecycle = 'continue', environment: rawEnvironment, requestMessageId, inputArtifactIds = [] }) {
      return tx(() => {
        const run = ownedRun(userId, runId), task = taskRow(userId, taskId);
        conversation(userId, conversationId); checkVersion(task, expectedVersion);
        if (run.threadId !== conversationId || run.status !== 'running') throw failed('执行记录与当前对话不一致', 'work_run_invalid');
        if (!lifecycleKinds.has(lifecycle)) throw failed('会话策略无效', 'work_invalid', 400);
        const env = environment(rawEnvironment), encoded = JSON.stringify(env);
        if (!Array.isArray(inputArtifactIds) || inputArtifactIds.length > 128 || new Set(inputArtifactIds).size !== inputArtifactIds.length) throw failed('参考产物清单无效或过多', 'work_invalid', 400);
        const inputs = inputArtifactIds.map(artifactId => scopedInputArtifact(userId, taskId, artifactId));
        const existing = bindingRow(userId, runId);
        if (existing) {
          if (existing.task_id !== taskId || existing.environment !== encoded) throw failed('执行记录已经绑定其他目标', 'work_run_invalid');
          const savedInputs = db.prepare('SELECT artifact_id FROM work_run_inputs WHERE run_id=? ORDER BY artifact_id').all(runId).map(input => input.artifact_id);
          if (JSON.stringify(savedInputs) !== JSON.stringify([...inputArtifactIds].sort())) throw failed('执行的参考产物清单已经绑定', 'work_run_invalid');
          return api.assertRunCurrent(userId, runId);
        }
        const objects = taskObjects(userId, taskId), targets = objects.filter(link => link.role === 'target');
        // The graph can represent comparisons. The current executor can mutate
        // only one target; references never add mounted directories/permissions.
        if (targets.length > 1) throw failed('一次执行只能写入一个目标，请拆分独立任务', 'work_multiple_targets');
        const targetProject = targets[0]?.projectId ?? null;
        if ((run.projectId ?? null) !== targetProject || (env.projectId ?? null) !== targetProject) throw failed('执行工作区与任务目标不一致', 'work_target_mismatch');
        if ((targetProject === null && env.mode !== 'chat') || (targetProject !== null && store.getProject(targetProject)?.location !== env.mode)) throw failed('执行引擎与目标位置不一致', 'work_target_mismatch');
        if (objects.some(link => link.version !== link.boundVersion)) throw failed('对象版本已更新，请重新核对并绑定任务对象', 'work_object_changed');
        if (task.status === 'cancelled') throw failed('任务已取消，请明确修订或创建新任务', 'work_cancelled');
        if (db.prepare('SELECT 1 FROM work_leases WHERE resource_key=?').get('task:' + taskId)) throw failed('任务已有执行或尚未核对停止状态', 'work_resource_busy');
        const resources = ['task:' + taskId, ...targets.map(link => 'object:' + link.id), ...(targetProject ? ['project:' + targetProject] : [])];
        for (const key of resources) if (db.prepare('SELECT 1 FROM work_leases WHERE resource_key=?').get(key)) throw failed('目标正在被其他执行占用，请等待完成或核对中断结果', 'work_resource_busy');
        let session = lifecycle === 'continue' ? db.prepare("SELECT * FROM work_sessions WHERE task_id=? AND environment=? AND status='ready' ORDER BY rowid DESC LIMIT 1").get(taskId, encoded) : null;
        if (!session) {
          const sessionId = id(), at = now();
          db.prepare('INSERT INTO work_sessions(id,task_id,engine,environment,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(sessionId, taskId, env.engine, encoded, at, at);
          session = db.prepare('SELECT * FROM work_sessions WHERE id=?').get(sessionId);
          if (lifecycle === 'continue') lifecycle = 'rebuild';
        }
        const at = now(), generation = task.generation + 1, leaseToken = id();
        db.prepare(`INSERT INTO work_run_bindings(run_id,task_id,conversation_id,session_id,task_version,generation,lifecycle,
          environment,object_versions,lease_token,heartbeat_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(runId, taskId, conversationId, session.id, task.version, generation, lifecycle, encoded,
            JSON.stringify(objects.map(link => ({ id: link.id, version: link.version, role: link.role }))), leaseToken, at, at, at);
        for (const { artifact, sourceTask } of inputs) db.prepare('INSERT INTO work_run_inputs VALUES(?,?,?,?,?)').run(runId, artifact.id, artifact.version, sourceTask.id, sourceTask.version);
        db.prepare('INSERT OR IGNORE INTO work_managed_conversations VALUES(?,?)').run(conversationId, at);
        for (const key of resources) db.prepare('INSERT INTO work_leases VALUES(?,?,?,?)').run(key, runId, leaseToken, at);
        db.prepare("UPDATE work_tasks SET status='running',generation=?,updated_at=? WHERE id=?").run(generation, at, taskId);
        db.prepare("UPDATE work_sessions SET status='running',updated_at=? WHERE id=?").run(at, session.id);
        if (requestMessageId) {
          if (!db.prepare("SELECT 1 FROM messages WHERE id=? AND thread_id=? AND role='user'").get(requestMessageId, conversationId)) throw failed('执行请求必须来自当前对话的用户消息', 'work_run_invalid');
          linkMessage(userId, taskId, requestMessageId, conversationId, runId, 'run');
        }
        event(bindingRow(userId, runId), 'prepared', { type: 'prepared', lifecycle, taskVersion: task.version, sessionId: session.id });
        return bindingView(bindingRow(userId, runId));
      });
    },
    getRunBinding(userId, runId) { return bindingView(bindingRow(userId, runId)); },
    assertRunCurrent(userId, runId, expected = {}) {
      const row = bindingRow(userId, runId);
      if (!row) throw failed('执行尚未绑定任务', 'work_run_invalid');
      const task = taskRow(userId, row.task_id), run = ownedRun(userId, runId);
      if (run.status !== 'running' || row.status !== 'running' || task.status !== 'running' || row.task_version !== task.version || row.generation !== task.generation) throw failed('此执行已取消、过期或需要核对', 'work_run_stale');
      for (const [key, stored] of [['generation', row.generation], ['taskVersion', row.task_version], ['leaseToken', row.lease_token]]) {
        if (expected[key] !== undefined && expected[key] !== stored) throw failed('执行代次或租约已过期', 'work_run_stale');
      }
      if (expected.environment !== undefined && JSON.stringify(environment(expected.environment)) !== row.environment) throw failed('实际执行环境已变化', 'work_environment_changed');
      for (const link of parse(row.object_versions, [])) if (objectRow(userId, link.id).version !== link.version) throw failed('目标对象已变化', 'work_object_changed');
      assertRunInputs(userId, row);
      if (!db.prepare('SELECT 1 FROM work_leases WHERE resource_key=? AND run_id=? AND lease_token=?').get('task:' + task.id, runId, row.lease_token)) throw failed('执行租约已失效', 'work_run_stale');
      const target = taskObjects(userId, task.id).find(link => link.role === 'target');
      if ((target?.projectId ?? null) !== (run.projectId ?? null)) throw failed('实际工作区与绑定不一致', 'work_target_mismatch');
      db.prepare('UPDATE work_run_bindings SET heartbeat_at=? WHERE run_id=?').run(now(), runId);
      return bindingView(row);
    },
    updateEngineSession(userId, runId, engineThreadId) {
      return tx(() => {
        const binding = api.assertRunCurrent(userId, runId);
        const value = referenceId(engineThreadId);
        if (binding.engineThreadId && binding.engineThreadId !== value) throw failed('当前执行线程不能替换为其他线程，请重建会话', 'work_session_conflict');
        db.prepare('UPDATE work_sessions SET engine_thread_id=?,updated_at=? WHERE id=?').run(value, now(), binding.sessionId);
        return bindingView(bindingRow(userId, runId));
      });
    },
    appendEvent(userId, runId, { key, generation, type, status, summary = '', source }) {
      return tx(() => {
        api.assertRunCurrent(userId, runId, { generation });
        const row = bindingRow(userId, runId);
        const metadata = { type: boundedText(type, '事件类型', 100), ...(status ? { status: boundedText(status, '事件状态', 60) } : {}), summary: redacted(summary) };
        if (source) metadata.source = sourceExists(userId, row.task_id, source);
        return event(row, key, metadata);
      });
    },
    getEvents(userId, runId, { after = 0, limit = 100 } = {}) {
      const row = bindingRow(userId, runId); if (!row) return [];
      taskRow(userId, row.task_id); version(after); boundedLimit(limit);
      return db.prepare('SELECT * FROM work_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, after, limit)
        .map(item => ({ runId, seq: item.seq, generation: item.generation, ...parse(item.metadata, {}), createdAt: item.created_at }));
    },
    finishRun(userId, runId, { status, verification, messageIds = [], confirmedStopped = false } = {}) {
      return tx(() => {
        const row = bindingRow(userId, runId); if (!row) return { applied: false, reason: 'unbound' };
        const run = ownedRun(userId, runId);
        if (run.status === 'running') throw failed('执行尚未停止，不能释放目标租约', 'work_run_active');
        if (!['completed', 'failed', 'interrupted'].includes(status) || status !== run.status) throw failed('执行终态与持久记录不一致', 'work_run_invalid');
        if (['completed', 'failed', 'interrupted', 'stopped'].includes(row.status)) return { applied: false, reason: 'duplicate' };
        const task = canRead(() => taskRow(userId, row.task_id));
        let inputs = [], inputsCurrent = true;
        try { inputs = assertRunInputs(userId, row); }
        catch (error) {
          if (!['work_not_found', 'work_reference_scope', 'work_artifact_stale'].includes(error.code)) throw error;
          inputsCurrent = false;
        }
        const current = task && row.status === 'running' && task.status === 'running' && inputsCurrent
          && task.generation === row.generation && task.version === row.task_version;
        const at = now();
        const stopped = confirmedStopped || parse(row.environment, {}).mode === 'chat';
        db.prepare('UPDATE work_run_bindings SET status=?,updated_at=? WHERE run_id=?').run(stopped ? status : 'needs_reconciliation', at, runId);
        if (stopped) db.prepare('DELETE FROM work_leases WHERE run_id=?').run(runId);
        db.prepare('UPDATE work_sessions SET status=?,updated_at=? WHERE id=?').run(stopped && status === 'completed' && current ? 'ready' : 'stale', at, row.session_id);
        if (!current) {
          db.prepare("UPDATE work_tasks SET status='needs_reconciliation',updated_at=? WHERE id=? AND status='running' AND generation=? AND version=?")
            .run(at, row.task_id, row.generation, row.task_version);
          event(row, 'finished', { type: 'late_result_ignored', status });
          return { applied: false, reason: 'stale' };
        }
        if (!Array.isArray(messageIds) || messageIds.length > 100) throw failed('结果消息过多', 'work_invalid', 400);
        for (const messageId of messageIds) linkMessage(userId, row.task_id, messageId, row.conversation_id, runId, 'run');
        const checked = verification ?? run.verification;
        // A caller cannot promote a prose claim to an accepted result. Only the
        // persisted independent verification exit code establishes success.
        const verified = checked?.status === 'passed' && run.verification?.status === 'passed' && run.verification?.exitCode === 0;
        const taskStatus = !stopped ? 'needs_reconciliation' : status === 'completed' ? (verified ? 'succeeded' : 'waiting_input')
          : status === 'interrupted' ? 'needs_reconciliation' : 'failed';
        db.prepare('UPDATE work_tasks SET status=?,updated_at=? WHERE id=? AND generation=? AND version=?').run(taskStatus, at, row.task_id, row.generation, row.task_version);
        for (const messageId of messageIds) {
          const message = db.prepare('SELECT role FROM messages WHERE id=?').get(messageId);
          if (message?.role !== 'assistant') continue;
          const artifactId = id();
          db.prepare('INSERT INTO work_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(artifactId, artifactId, 1, row.task_id, runId,
            'response', '执行结果', JSON.stringify({ type: 'message', id: messageId }), status === 'completed' ? 'current' : 'partial', null, at);
          for (const input of inputs) db.prepare('INSERT INTO work_artifact_dependencies VALUES(?,?)').run(artifactId, input.artifact_id);
          for (const file of db.prepare('SELECT id,name,mime_type FROM chat_artifacts WHERE message_id=?').all(messageId)) {
            const fileId = id();
            db.prepare('INSERT INTO work_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(fileId, fileId, 1, row.task_id, runId,
              file.mime_type.startsWith('image/') ? 'image' : 'file', file.name, JSON.stringify({ type: 'chat_artifact', id: file.id }), 'current', null, at);
            for (const input of inputs) db.prepare('INSERT INTO work_artifact_dependencies VALUES(?,?)').run(fileId, input.artifact_id);
          }
        }
        const recent = recentRunEvents(runId);
        const verificationEvents = recent.events.filter(item => item.kind === 'verification');
        const verificationSource = { type: 'run', id: runId, ...(verificationEvents.length ? { seq: verificationEvents.at(-1).seq } : {}) };
        db.prepare('INSERT INTO work_evidence VALUES(?,?,?,?,?,?,?,?,?,?)').run(id(), row.task_id, runId,
          run.verification ? 'verification' : 'observation', run.verification?.status === 'unknown' ? 'unknown' : 'verified',
          run.verification ? `独立验收状态 ${run.verification.status}，退出码 ${run.verification.exitCode ?? '未知'}` : `执行尝试状态 ${status}，未执行独立验收`,
          JSON.stringify(verificationSource), row.task_version, null, at);
        const effects = recent.events.filter(item => ['command', 'file'].includes(item.kind));
        const uncertainEffect = effects.some((item, index) => ['unknown', 'interrupted'].includes(item.status)
          || item.status === 'started' && !effects.slice(index + 1).some(later => later.itemId && later.itemId === item.itemId && later.status !== 'started'));
        if (status === 'interrupted' || !stopped || uncertainEffect) db.prepare('INSERT INTO work_evidence VALUES(?,?,?,?,?,?,?,?,?,?)').run(id(), row.task_id, runId,
          'side_effect', 'unknown', '执行中断或停止尚未确认，外部操作结果需核实；不会自动重放。', JSON.stringify({ type: 'run', id: runId }), row.task_version, null, at);
        event(row, 'finished', { type: 'finished', status, taskStatus, verification: run.verification?.status ?? 'not_run' });
        return { applied: true, task: taskView(taskRow(userId, row.task_id)) };
      });
    },
    // Runtime-only cleanup. Do not expose as an HTTP mutation. Revoking an
    // account must stop new work without preventing termination bookkeeping.
    settleStoppedRun(runId, details = {}) {
      const run = store.getRun(referenceId(runId));
      if (!run) return { applied: false, reason: 'missing' };
      const user = db.prepare('SELECT disabled FROM users WHERE id=?').get(run.userId);
      if (user && !user.disabled) return api.finishRun(run.userId, runId, details);
      return tx(() => {
        const row = db.prepare('SELECT * FROM work_run_bindings WHERE run_id=?').get(runId);
        if (!row) return { applied: false, reason: 'unbound' };
        if (run.status === 'running' || !['completed', 'failed', 'interrupted'].includes(details.status) || details.status !== run.status) throw failed('执行尚未停止或终态不一致', 'work_run_active');
        const stopped = details.confirmedStopped || parse(row.environment, {}).mode === 'chat';
        if (stopped) db.prepare('DELETE FROM work_leases WHERE run_id=?').run(runId);
        db.prepare('UPDATE work_run_bindings SET status=?,updated_at=? WHERE run_id=?').run(stopped ? 'stopped' : 'needs_reconciliation', now(), runId);
        db.prepare("UPDATE work_sessions SET status='stale',updated_at=? WHERE id=?").run(now(), row.session_id);
        db.prepare("UPDATE work_tasks SET status='needs_reconciliation',updated_at=? WHERE id=? AND status='running' AND generation=? AND version=?")
          .run(now(), row.task_id, row.generation, row.task_version);
        event(row, 'revoked-owner-stopped', { type: 'late_result_ignored', status: details.status, summary: '账号已停用，仅记录停止状态，不接纳执行结果。' });
        return { applied: false, reason: 'revoked_owner' };
      });
    },
    confirmRunStopped(userId, runId, { confirmedStopped = false } = {}) {
      return tx(() => {
        const run = ownedRun(userId, runId), row = bindingRow(userId, runId);
        if (!row) return { released: false };
        if (!confirmedStopped || run.status === 'running') throw failed('必须先核实底层执行已经停止', 'work_run_active');
        db.prepare('DELETE FROM work_leases WHERE run_id=?').run(runId);
        db.prepare("UPDATE work_run_bindings SET status='stopped',updated_at=? WHERE run_id=? AND status NOT IN ('completed','failed','interrupted')").run(now(), runId);
        if (row.status !== 'completed') db.prepare("UPDATE work_sessions SET status='stale',updated_at=? WHERE id=?").run(now(), row.session_id);
        event(row, 'confirmed-stopped', { type: 'confirmed_stopped', status: run.status });
        return { released: true };
      });
    },
    reconcile() {
      return tx(() => {
        const rows = db.prepare("SELECT * FROM work_run_bindings WHERE status='running'").all();
        for (const row of rows) {
          db.prepare("UPDATE work_run_bindings SET status='needs_reconciliation',updated_at=? WHERE run_id=?").run(now(), row.run_id);
          db.prepare("UPDATE work_tasks SET status='needs_reconciliation',updated_at=? WHERE id=? AND generation=? AND version=?").run(now(), row.task_id, row.generation, row.task_version);
          db.prepare("UPDATE work_sessions SET status='stale',updated_at=? WHERE id=?").run(now(), row.session_id);
          event(row, 'restart', { type: 'restart', status: 'needs_reconciliation', summary: '执行停止情况和外部操作结果尚需核实；不会自动重放。' });
        }
        return { interrupted: rows.length };
      });
    },
    addEvidence(userId, { taskId, runId, kind = 'observation', status = 'unverified', summary = '', source, expectedVersion, supersedesId }) {
      return tx(() => {
        const task = taskRow(userId, taskId); checkVersion(task, expectedVersion);
        if (runId) {
          const binding = bindingRow(userId, runId);
          if (!binding || binding.task_id !== taskId || binding.task_version !== task.version || binding.generation !== task.generation || binding.status === 'revoked') throw failed('旧执行不能更新任务证据', 'work_run_stale');
        }
        if (!['observation', 'decision', 'constraint', 'verification', 'side_effect'].includes(kind) || !['unverified', 'verified', 'superseded', 'unknown'].includes(status)) throw failed('证据类别或状态无效', 'work_invalid', 400);
        if (supersedesId && !db.prepare('SELECT 1 FROM work_evidence WHERE id=? AND task_id=?').get(supersedesId, taskId)) throw failed('被替代证据不存在', 'work_not_found', 404);
        const checkedSource = sourceExists(userId, taskId, source);
        const evidenceId = id();
        db.prepare('INSERT INTO work_evidence VALUES(?,?,?,?,?,?,?,?,?,?)').run(evidenceId, taskId, runId ?? null, kind, status, redacted(summary, 2000), JSON.stringify(checkedSource), task.version, supersedesId ?? null, now());
        if (supersedesId) db.prepare("UPDATE work_evidence SET status='superseded' WHERE id=?").run(supersedesId);
        return evidenceView(db.prepare('SELECT * FROM work_evidence WHERE id=?').get(evidenceId));
      });
    },
    createArtifact(userId, { taskId, runId, kind, name, source, expectedVersion, supersedesId, dependencies = [] }) {
      return tx(() => {
        const task = taskRow(userId, taskId); checkVersion(task, expectedVersion);
        if (runId) {
          const binding = bindingRow(userId, runId);
          if (!binding || binding.task_id !== taskId || binding.task_version !== task.version || binding.generation !== task.generation || !['running', 'completed'].includes(binding.status)) throw failed('旧执行不能发布新产物', 'work_run_stale');
        }
        const checkedSource = sourceExists(userId, taskId, source);
        if (checkedSource.type === 'artifact') throw failed('产物来源须指向原始消息、文件或执行记录', 'work_invalid', 400);
        if (!Array.isArray(dependencies) || dependencies.length > 16 || new Set(dependencies).size !== dependencies.length) throw failed('产物依赖无效', 'work_invalid', 400);
        for (const dependency of dependencies) {
          scopedInputArtifact(userId, taskId, dependency);
        }
        const previous = supersedesId ? artifactRow(userId, supersedesId) : null;
        if (previous && previous.task_id !== taskId) throw failed('不能覆盖其他任务的产物', 'work_artifact_conflict');
        if (previous && previous.status !== 'current') throw failed('产物已有新版本，请刷新后重试', 'work_artifact_conflict');
        const artifactId = id(), familyId = previous?.family_id ?? artifactId, nextVersion = (previous?.version ?? 0) + 1;
        db.prepare('INSERT INTO work_artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(artifactId, familyId, nextVersion, taskId, runId ?? null,
          boundedText(kind, '产物类型', 40), boundedText(name, '产物名称', 200), JSON.stringify(checkedSource), 'current', supersedesId ?? null, now());
        for (const input of dependencies) db.prepare('INSERT INTO work_artifact_dependencies VALUES(?,?)').run(artifactId, input);
        if (previous) {
          db.prepare("UPDATE work_artifacts SET status='superseded' WHERE id=?").run(previous.id);
          invalidateArtifactTree(previous.id);
        }
        return artifactView(artifactRow(userId, artifactId));
      });
    },
    getArtifact(userId, artifactId) { return artifactView(artifactRow(userId, artifactId)); },
    getTaskContext(userId, taskId, { maxMessages = 1000 } = {}) {
      const task = taskView(taskRow(userId, taskId));
      if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 2000) throw failed('上下文条数无效', 'work_invalid', 400);
      const rows = db.prepare(`SELECT m.*,l.source,l.run_id FROM work_message_links l JOIN messages m ON m.id=l.message_id
        JOIN threads t ON t.id=m.thread_id WHERE l.task_id=? AND t.user_id=? ORDER BY m.rowid LIMIT ?`).all(taskId, userId, maxMessages + 1);
      const artifacts = db.prepare('SELECT * FROM work_artifacts WHERE task_id=? ORDER BY family_id,version').all(taskId)
        .map(row => canRead(() => artifactView(artifactRow(userId, row.id)))).filter(Boolean);
      const evidence = db.prepare('SELECT * FROM work_evidence WHERE task_id=? ORDER BY rowid').all(taskId)
        .filter(row => canRead(() => sourceExists(userId, taskId, parse(row.source, {})))).map(evidenceView);
      const runRows = db.prepare('SELECT * FROM work_run_bindings WHERE task_id=? ORDER BY rowid DESC LIMIT 21').all(taskId);
      const runs = runRows.slice(0, 20).map(binding => {
        const run = store.getRun(binding.run_id);
        const recent = recentRunEvents(run.id);
        return { id: run.id, status: run.status, taskVersion: binding.task_version, generation: binding.generation,
          verification: run.verification ? { status: run.verification.status, exitCode: run.verification.exitCode ?? null } : null,
          interruptReason: run.interruptReason ?? null, bindingStatus: binding.status, eventsTruncated: recent.truncated,
          events: recent.events.map(item => ({ seq: item.seq, itemId: item.itemId, kind: item.kind, tool: item.tool,
            status: item.status, paths: item.paths, exitCode: item.exitCode })) };
      });
      return { task: taskView(taskRow(userId, taskId)), objects: task.objects, runs, runsOverflow: runRows.length > 20, overflow: rows.length > maxMessages, messageCountAtLeast: rows.length,
        messages: rows.slice(0, maxMessages).map(row => ({ id: row.id, conversationId: row.thread_id, role: row.role, content: row.content, createdAt: row.created_at,
          source: row.source, runId: row.run_id })), evidence, artifacts,
        sessions: db.prepare('SELECT * FROM work_sessions WHERE task_id=? ORDER BY rowid').all(taskId).map(row => ({
          id: row.id, taskId, taskVersion: db.prepare('SELECT task_version FROM work_run_bindings WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(row.id)?.task_version ?? null,
          engine: row.engine, engineThreadId: row.engine_thread_id, environment: parse(row.environment, {}), status: row.status,
          createdAt: row.created_at, updatedAt: row.updated_at,
        })) };
    },
  };
  return api;
}
