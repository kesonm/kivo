import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './store.mjs';

const HOUR = 60 * 60 * 1000;
const opaque = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = () => new AppError('摘要查询参数无效', 400, 'kibot_invalid_query');
const missing = () => new AppError('摘要不存在或时间分组已更新，请刷新后重试', 404, 'kibot_summary_not_found');

function zone(value = 'Asia/Shanghai') {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) throw invalid();
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw invalid(); }
}
function limitOf(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw invalid();
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) throw invalid();
  return limit;
}
function token(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw invalid();
  return value;
}
function excerpt(value, size) {
  const plain = value.replace(/```[^]*?```/g, ' [代码] ').replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*#>`_]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > size ? plain.slice(0, size - 1) + '…' : plain;
}

/** Presentation-only summaries. Originals and model-context policy are untouched. */
export function createKibot({ store, clock = () => Date.now() }) {
  const db = store.db;
  const owned = userId => {
    const user = store.getUser(userId);
    if (!user || user.disabled) throw new AppError('请先登录', 401);
    return user;
  };
  function getThread(userId) {
    owned(userId);
    const row = db.prepare('SELECT thread_id FROM kibot_threads WHERE user_id=?').get(userId);
    const thread = row && store.getThread(row.thread_id);
    if (!thread || thread.userId !== userId || thread.projectId !== null) throw new AppError('请先打开 kibot 主会话', 404, 'kibot_not_initialized');
    return thread;
  }
  function ensure(userId) {
    owned(userId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT thread_id FROM kibot_threads WHERE user_id=?').get(userId);
      if (!existing) {
        // The dedicated primary conversation does not consume the ordinary-chat quota.
        const id = randomUUID(), at = new Date(clock()).toISOString();
        db.prepare('INSERT INTO threads(id,project_id,user_id,title,codex_thread_id,created_at,updated_at) VALUES(?,NULL,?,?,NULL,?,?)')
          .run(id, userId, 'kibot', at, at);
        db.prepare('INSERT INTO kibot_threads(user_id,thread_id) VALUES(?,?)').run(userId, id);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { thread: getThread(userId) };
  }

  function groups(userId, timeZone) {
    const thread = getThread(userId), at = clock();
    const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const dateOf = value => {
      const parts = Object.fromEntries(format.formatToParts(new Date(value)).map(p => [p.type, p.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const today = dateOf(at);
    // Read only identity/time metadata over the archive, never all message bodies.
    const rows = db.prepare('SELECT rowid seq,id,role,created_at FROM messages WHERE thread_id=? ORDER BY rowid').all(thread.id);
    const segments = [];
    for (const row of rows) {
      row.date = dateOf(row.created_at);
      let segment = segments.at(-1), previous = segment?.at(-1);
      if (!previous || row.date !== previous.date || (row.role === 'user' && Date.parse(row.created_at) - Date.parse(previous.created_at) >= HOUR)) {
        segment = []; segments.push(segment);
      }
      segment.push(row);
    }
    const running = store.getActiveRunsForUser(userId).find(run => run.threadId === thread.id);
    let active = [];
    if (running && segments.length) {
      const request = running.requestMessageId && rows.find(row => row.id === running.requestMessageId);
      const requestTime = request?.created_at ?? running.createdAt;
      // Retain the request's segment even if its response crosses midnight.
      let activeIndex = segments.findIndex(segment => segment.some(row => row.id === request?.id));
      if (activeIndex < 0) {
        activeIndex = segments.findLastIndex(segment => Date.parse(segment[0].created_at) <= Date.parse(requestTime));
        if (activeIndex < 0) activeIndex = segments.length - 1;
      }
      active = segments.splice(activeIndex).flat();
    } else {
      const recent = segments.at(-1);
      if (recent && recent.at(-1).date === today && at - Date.parse(recent.at(-1).created_at) < HOUR) active = segments.pop();
    }
    const archives = [], days = new Map();
    for (const segment of segments) {
      const date = segment[0].date;
      if (date < today) {
        if (!days.has(date)) { const item = { kind: 'day', date, rows: [], segmentCount: 0 }; days.set(date, item); archives.push(item); }
        days.get(date).rows.push(...segment); days.get(date).segmentCount++;
      } else archives.push({ kind: 'segment', date, rows: segment, segmentCount: 1 });
    }
    for (const item of archives) {
      item.first = item.rows[0]; item.last = item.rows.at(-1);
      item.id = opaque([thread.id, timeZone, item.kind, item.date, ...(item.kind === 'segment' ? [item.first.id, item.last.id] : [])]);
    }
    archives.sort((a, b) => b.last.seq - a.last.seq);
    return { thread, at, archives, active };
  }

  function summarize(threadId, group) {
    const samples = db.prepare(`SELECT role,substr(content,1,500) content FROM messages
      WHERE thread_id=? AND rowid BETWEEN ? AND ? AND role='user' ORDER BY rowid LIMIT 3`)
      .all(threadId, group.first.seq, group.last.seq);
    const answer = db.prepare(`SELECT substr(content,1,500) content FROM messages
      WHERE thread_id=? AND rowid BETWEEN ? AND ? AND role='assistant' ORDER BY rowid DESC LIMIT 1`)
      .get(threadId, group.first.seq, group.last.seq);
    const topics = [...new Set(samples.map(row => excerpt(row.content, 110)).filter(Boolean))];
    return {
      id: group.id, kind: group.kind, date: group.date, startAt: group.first.created_at, endAt: group.last.created_at,
      title: topics.length ? excerpt(topics[0], 54) : '这段对话的记录',
      bullets: [...topics.map(text => `你：${text}`), ...(answer?.content ? [`kibot：${excerpt(answer.content, 150)}`] : [])],
      messageCount: group.rows.length, segmentCount: group.segmentCount, source: 'extractive',
    };
  }
  function timeline(userId, query = {}) {
    const timeZone = zone(query.timeZone), limit = limitOf(query.limit, 20, 50);
    const { thread, at, archives, active } = groups(userId, timeZone);
    let offset = 0;
    if (query.before !== undefined) {
      const before = token(query.before);
      const index = archives.findIndex(group => group.id === before);
      if (index < 0) throw missing();
      offset = index + 1;
    }
    const selected = archives.slice(offset, offset + limit);
    return { threadId: thread.id, timeZone, summaries: selected.map(group => summarize(thread.id, group)),
      activeMessageIds: active.map(row => row.id), nextBefore: offset + selected.length < archives.length ? selected.at(-1).id : null,
      serverNow: new Date(at).toISOString() };
  }
  function activeMessages(userId, query = {}) {
    const { active } = groups(userId, zone(query.timeZone));
    // Avoid the legacy first-2000-message query and never load archived bodies.
    // These are display bounds, not permission to silently trim model context.
    if (active.length > 2000) throw new AppError('当前对话记录较多，整理为摘要后可分页查看历史', 409, 'kibot_current_large');
    const messages = [];
    let bytes = 0;
    for (const row of active) {
      const message = store.getMessage(row.id);
      if (!message) continue;
      bytes += Buffer.byteLength(JSON.stringify(message));
      if (bytes > 16 * 1024 * 1024) throw new AppError('当前对话内容较大，整理为摘要后可分页查看历史', 409, 'kibot_current_large');
      messages.push(message);
    }
    return messages;
  }
  function history(userId, query = {}) {
    const timeZone = zone(query.timeZone), summaryId = token(query.summaryId), limit = limitOf(query.limit, 50, 100);
    const { thread, archives } = groups(userId, timeZone);
    const group = archives.find(item => item.id === summaryId);
    if (!group) throw missing();
    let after = 0;
    if (query.cursor !== undefined) {
      const value = token(query.cursor);
      const row = group.rows.find(item => opaque([summaryId, item.id]) === value);
      if (!row) throw invalid();
      after = row.seq;
    }
    const remaining = group.rows.filter(row => row.seq > after);
    const messages = [];
    let bytes = 0;
    for (const row of remaining.slice(0, limit)) {
      const message = store.getMessage(row.id);
      if (!message) continue;
      const size = Buffer.byteLength(JSON.stringify(message));
      // A single stored message is at most 4M characters; never truncate it.
      if (messages.length && bytes + size > 2 * 1024 * 1024) break;
      messages.push(message); bytes += size;
    }
    const last = messages.at(-1);
    return { messages, nextCursor: last && remaining.some(row => row.seq > group.rows.find(r => r.id === last.id).seq)
      ? opaque([summaryId, last.id]) : null, total: group.rows.length };
  }
  return { ensure, getThread, timeline, history, activeMessages };
}
