import { createHash } from 'node:crypto';
import { AppError } from './store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export function createWorkRequests(store) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS work_requests (
    user_id TEXT NOT NULL REFERENCES users(id), conversation_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, run_id TEXT REFERENCES runs(id),
    status TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,conversation_id,request_id)
  )`);
  function owned(userId, conversationId) {
    if (!store.getUser(userId) || store.getUser(userId).disabled || store.getThread(conversationId)?.userId !== userId) throw new AppError('对话不存在或不可访问', 404);
  }
  return {
    begin(userId, conversationId, requestId, body, files = []) {
      owned(userId, conversationId);
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw new AppError('请刷新网页后重试，当前客户端缺少执行去重标识', 409, 'work_request_id_required');
      const fingerprint = hash(JSON.stringify({ text: body.text, tool: body.tool, model: body.model, reasoningEffort: body.reasoningEffort,
        mode: body.mode, work: body.work, verificationCommand: body.verificationCommand,
        files: files.map(file => ({ name: file.name, content: hash(file.data) })) }));
      const row = db.prepare('SELECT * FROM work_requests WHERE user_id=? AND conversation_id=? AND request_id=?').get(userId, conversationId, requestId);
      if (row) {
        if (row.fingerprint !== fingerprint) throw new AppError('同一执行请求不能替换内容或目标，请重新发送', 409, 'work_request_conflict');
        if (row.run_id) return { run: store.getRun(row.run_id), replay: true };
        throw new AppError(row.status === 'pending' ? '此请求正在处理或需要核对，未重复启动执行' : '此请求之前未启动，请刷新工作状态并重新发送', 409, 'work_request_' + row.status);
      }
      db.prepare('INSERT INTO work_requests VALUES(?,?,?,?,NULL,?,?)').run(userId, conversationId, requestId, fingerprint, 'pending', new Date().toISOString());
      return { replay: false };
    },
    attach(userId, conversationId, requestId, runId) {
      owned(userId, conversationId);
      const run = store.getRun(runId);
      if (run?.userId !== userId || run.threadId !== conversationId) throw new AppError('执行请求绑定无效', 409);
      const changed = db.prepare("UPDATE work_requests SET run_id=?,status='attached' WHERE user_id=? AND conversation_id=? AND request_id=? AND status='pending' AND run_id IS NULL")
        .run(runId, userId, conversationId, requestId);
      if (changed.changes !== 1) throw new AppError('执行请求已经处理', 409, 'work_request_conflict');
    },
    fail(userId, conversationId, requestId) {
      db.prepare("UPDATE work_requests SET status='failed' WHERE user_id=? AND conversation_id=? AND request_id=? AND run_id IS NULL").run(userId, conversationId, requestId);
    },
  };
}
