import { AppError } from './store.mjs';

// Store source identifiers, never copies of private message text. Resolve access
// again when displaying an execution so deleted sources cannot reappear.
export function createRunContext(store) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS run_context_snapshots (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    sources TEXT NOT NULL, execution TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS run_reply_links (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE
  );`);
  const owned = (userId, runId) => {
    const run = store.getRun(runId);
    if (!run || run.userId !== userId || store.getUser(userId)?.disabled) throw new AppError('执行记录不存在', 404);
    return run;
  };
  return {
    record(runId, sources, execution) {
      db.prepare('INSERT OR IGNORE INTO run_context_snapshots VALUES(?,?,?)').run(runId, JSON.stringify(sources), JSON.stringify(execution));
    },
    engine(runId, threadId) {
      const row = db.prepare('SELECT execution FROM run_context_snapshots WHERE run_id=?').get(runId);
      if (row) db.prepare('UPDATE run_context_snapshots SET execution=? WHERE run_id=?').run(JSON.stringify({ ...JSON.parse(row.execution), threadId }), runId);
    },
    replies(runId, messageIds) {
      const run = store.getRun(runId);
      for (const id of messageIds) if (db.prepare("SELECT 1 FROM messages WHERE id=? AND thread_id=? AND role='assistant'").get(id, run.threadId)) {
        db.prepare('INSERT OR IGNORE INTO run_reply_links VALUES(?,?)').run(id, runId);
      }
    },
    links(userId, threadId) {
      if (store.getThread(threadId)?.userId !== userId) throw new AppError('对话不存在', 404);
      return db.prepare('SELECT l.message_id messageId,l.run_id runId FROM run_reply_links l JOIN messages m ON m.id=l.message_id WHERE m.thread_id=?').all(threadId).map(row => ({ ...row }));
    },
    read(userId, runId) {
      owned(userId, runId);
      const row = db.prepare('SELECT * FROM run_context_snapshots WHERE run_id=?').get(runId);
      if (!row) return { recorded: false, sources: [], execution: null };
      const sources = JSON.parse(row.sources).map(source => {
        try {
          if (source.kind === 'message') {
            const message = db.prepare(`SELECT m.*,t.title FROM messages m JOIN threads t ON t.id=m.thread_id
              WHERE m.id=? AND t.user_id=?`).get(source.id, userId);
            if (!message) return { kind: 'unavailable' };
            const previous = db.prepare('SELECT run_id FROM run_reply_links WHERE message_id=?').get(source.id);
            const snapshot = previous && db.prepare('SELECT execution FROM run_context_snapshots WHERE run_id=?').get(previous.run_id);
            return { ...source, conversationId: message.thread_id, title: message.title, createdAt: message.created_at,
              excerpt: message.content.slice(0, 1200), truncated: message.content.length > 1200,
              sourceRunId: previous?.run_id, sessionId: snapshot ? JSON.parse(snapshot.execution).sessionId : null };
          }
          if (source.kind === 'artifact') {
            const context = store.work.getTaskContext(userId, source.sourceTaskId);
            const artifact = context.artifacts.find(item => item.id === source.id);
            if (!artifact || artifact.status !== 'current') return { kind: 'unavailable' };
            return { ...source, title: artifact.name, taskTitle: context.task.goal };
          }
          if (source.kind === 'task') return { ...source, title: store.work.getTask(userId, source.id).goal };
          if (source.kind === 'object') return { ...source, title: store.work.getObject(userId, source.id).name };
          return { kind: 'unavailable' };
        } catch (error) { if (error instanceof AppError) return { kind: 'unavailable' }; throw error; }
      });
      return { recorded: true, sources, execution: JSON.parse(row.execution) };
    },
  };
}
