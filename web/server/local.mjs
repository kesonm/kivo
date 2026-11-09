import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { AppError } from './store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const text = (value, max = 100) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError('参数无效');
  return value.trim();
};
export function localPath(value = '') {
  if (typeof value !== 'string' || value.length > 1000 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.split('/').some(s => s === '..' || s === '.' || s === '.git') || (value && value.split('/').some(s => !s))) throw new AppError('本地路径无效');
  return value;
}

/** A device only receives work belonging to its paired user. No inbound port is
 * required on the computer. Jobs and one-time credentials stay in memory. */
export function createLocalBridge({ store }) {
  const db = store.db;
  const pairs = new Map(), jobs = new Map(), polls = new Map();
  const epoch = randomUUID();
  let onEvent = () => {}, onRevoke = async () => {};
  const deviceView = r => ({ id: r.id, name: r.name, platform: r.platform, rootName: r.root_name, online: r.last_seen > Date.now() - 50_000, createdAt: r.created_at });
  function owned(userId, id) {
    const row = db.prepare('SELECT * FROM local_devices WHERE id=? AND user_id=? AND revoked=0').get(id, userId);
    if (!row) throw new AppError('本地设备不存在或已断开配对', 404);
    return row;
  }
  function take(id) {
    const job = [...jobs.values()].find(j => j.deviceId === id && !j.delivered);
    if (!job) return null;
    job.delivered = true;
    return { id: job.id, method: job.method, params: job.params };
  }
  function pairFor(token) {
    const entry = pairs.get(hash(text(token, 100)));
    if (!entry || entry.expires < Date.now()) throw new AppError('配对已过期，请重新启动本地助手', 410);
    return entry;
  }
  function finishJob(job, error, result) {
    clearTimeout(job.timer); jobs.delete(job.id);
    if (error) job.reject(new AppError(String(error).slice(0, 500), 409)); else job.resolve(result);
  }
  return {
    setHandlers(handlers) { onEvent = handlers.onEvent; onRevoke = handlers.onRevoke; },
    owned,
    list(userId) { return db.prepare('SELECT * FROM local_devices WHERE user_id=? AND revoked=0 ORDER BY created_at DESC').all(userId).map(deviceView); },
    beginPair(body) {
      for (const [key, p] of pairs) if (p.expires < Date.now()) pairs.delete(key);
      if (pairs.size >= 100) throw new AppError('配对请求过多，请稍后重试', 429);
      const token = secret(), code = randomBytes(5).toString('hex').toUpperCase();
      pairs.set(hash(token), { code, expires: Date.now() + 600_000, name: text(body.name, 80), platform: text(body.platform, 20), rootName: text(body.rootName, 100) });
      return { token, code, expiresIn: 600 };
    },
    approvePair(user, code) {
      code = text(code, 16).replaceAll('-', '').toUpperCase();
      const p = [...pairs.values()].find(p => p.code === code && p.expires > Date.now());
      if (!p || p.deviceId) throw new AppError('配对码无效、已使用或已过期', 400);
      if (this.list(user.id).length >= 10) throw new AppError('每个账号最多连接 10 台电脑');
      p.deviceId = randomUUID(); p.deviceToken = secret(); p.user = { username: user.username };
      db.prepare('INSERT INTO local_devices(id,user_id,name,platform,root_name,token_hash,last_seen,created_at) VALUES(?,?,?,?,?,?,0,?)').run(p.deviceId, user.id, p.name, p.platform, p.rootName, hash(p.deviceToken), new Date().toISOString());
      store.audit(user.id, 'local.device.paired', p.deviceId, p.name);
      return deviceView(owned(user.id, p.deviceId));
    },
    claimPair(token) {
      const p = pairFor(token);
      if (!p.deviceId) return { pending: true };
      if (p.claimed) throw new AppError('配对凭据已领取，请重新配对', 410);
      p.claimed = true;
      const result = { deviceId: p.deviceId, token: p.deviceToken, user: p.user };
      p.deviceToken = null;
      return result;
    },
    authenticate(req) {
      if (req.get('origin') || req.get('cookie')) throw new AppError('本地助手接口不接受浏览器会话', 403);
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '')?.[1];
      const row = token && db.prepare('SELECT * FROM local_devices WHERE token_hash=? AND revoked=0').get(hash(token));
      if (!row || !store.getUser(row.user_id) || store.getUser(row.user_id).disabled) throw new AppError('本地助手配对已失效', 401);
      return { id: row.id, userId: row.user_id };
    },
    async poll(device, signal) {
      db.prepare('UPDATE local_devices SET last_seen=? WHERE id=?').run(Date.now(), device.id);
      if (polls.has(device.id)) throw new AppError('设备已有连接，请关闭重复运行的助手', 409);
      const job = take(device.id); if (job) return { job, epoch };
      return new Promise(resolve => {
        let timer;
        const done = () => { clearTimeout(timer); polls.delete(device.id); signal?.removeEventListener('abort', done); resolve({ job: signal?.aborted ? null : take(device.id), epoch }); };
        polls.set(device.id, done); timer = setTimeout(done, 20_000); signal?.addEventListener('abort', done, { once: true });
        if (signal?.aborted) done();
      });
    },
    call(userId, deviceId, method, params, timeout = 45_000) {
      const device = owned(userId, deviceId);
      if (device.last_seen < Date.now() - 50_000) throw new AppError('这台电脑离线了，请启动本地助手', 409);
      if ([...jobs.values()].filter(j => j.deviceId === deviceId).length >= 20) throw new AppError('本地助手繁忙，请稍后重试', 429);
      return new Promise((resolve, reject) => {
        const id = randomUUID(), job = { id, deviceId, method, params, resolve, reject, delivered: false };
        job.timer = setTimeout(() => finishJob(job, '本地助手响应超时。操作结果未知，请刷新后检查，勿重复提交。'), timeout);
        jobs.set(id, job); polls.get(deviceId)?.();
      });
    },
    result(device, body) {
      const job = jobs.get(body.id);
      if (!job) return; // A late response never resurrects an expired mutation.
      if (job.deviceId !== device.id || !job.delivered) throw new AppError('无权回复此操作', 403);
      finishJob(job, body.error, body.result);
    },
    events(device, body) {
      if (!Array.isArray(body.events) || body.events.length > 100) throw new AppError('事件格式无效');
      for (const event of body.events) onEvent(device, event);
    },
    async revoke(userId, id) {
      owned(userId, id);
      await onRevoke(id);
      db.prepare('UPDATE local_devices SET revoked=1 WHERE id=?').run(id);
      polls.get(id)?.();
      for (const job of jobs.values()) if (job.deviceId === id) finishJob(job, '设备配对已撤销');
      store.audit(userId, 'local.device.revoked', id);
    },
    async addProject(userId, deviceId, relative, name, create = false) {
      owned(userId, deviceId); relative = localPath(relative);
      name = text(name, 80);
      if (create && name.includes('/')) throw new AppError('项目名称不能包含路径分隔符。');
      const target = create ? localPath([relative, name].filter(Boolean).join('/')) : relative;
      const existing = db.prepare('SELECT project_id FROM local_projects WHERE device_id=? AND path=?').get(deviceId, target);
      if (existing) return store.getProject(existing.project_id);
      if (db.prepare('SELECT count(*) n FROM projects WHERE user_id=?').get(userId).n >= 20) throw new AppError('每个账号最多创建 20 个项目', 409);
      const result = await this.call(userId, deviceId, 'project.open', { path: relative, name, create: !!create });
      const normalized = localPath(result.path);
      const again = db.prepare('SELECT project_id FROM local_projects WHERE device_id=? AND path=?').get(deviceId, normalized);
      if (again) return store.getProject(again.project_id);
      const p = store.createProject(userId, text(result.name, 80));
      try { db.prepare('INSERT INTO local_projects(project_id,device_id,path) VALUES(?,?,?)').run(p.id, deviceId, normalized); }
      catch (error) { store.deleteProject(p.id); throw error; }
      store.audit(userId, 'local.project.connected', p.id, deviceId);
      return store.getProject(p.id);
    },
    projectCall(project, method, params = {}) { return this.call(project.userId, project.deviceId, method, { ...params, projectPath: project.localPath }); },
    close() { for (const done of polls.values()) done(); for (const job of jobs.values()) finishJob(job, '服务已重启'); pairs.clear(); },
  };
}
