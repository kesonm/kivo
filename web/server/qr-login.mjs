import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { AppError } from './store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const ttl = 120_000;

// QR tokens authorize inspection/confirmation only. Only the anonymous browser
// session that created a challenge can exchange it for a new login session.
export function createQrLogin(store, origin) {
  const { db } = store;
  db.exec(`CREATE TABLE IF NOT EXISTS qr_logins (
    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
    browser_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    approver_hash TEXT REFERENCES sessions(token_hash) ON DELETE SET NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','scanned','approved','denied')),
    verification_code TEXT NOT NULL, browser_label TEXT NOT NULL, expires_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS qr_logins_expiry ON qr_logins(expires_at);`);
  const view = row => ({ id: row.id, status: row.expires_at <= Date.now() ? 'expired' : row.state,
    verificationCode: row.verification_code, browser: row.browser_label, origin, expiresAt: row.expires_at });
  function browserChallenge(id, token) {
    if (typeof id !== 'string' || typeof token !== 'string') throw new AppError('二维码不存在，请刷新', 404);
    const row = db.prepare('SELECT * FROM qr_logins WHERE id=? AND browser_hash=?').get(id, hash(token));
    if (!row) throw new AppError('二维码不存在，请刷新', 404);
    return row;
  }
  function phoneChallenge(token) {
    if (typeof token !== 'string' || !tokenPattern.test(token)) throw new AppError('这不是有效的 kivo 登录二维码');
    const row = db.prepare('SELECT * FROM qr_logins WHERE token_hash=?').get(hash(token));
    if (!row || row.expires_at <= Date.now()) throw new AppError('二维码已失效，请在网页刷新后重试', 410);
    const browser = db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>? AND user_id IS NULL').get(row.browser_hash, Date.now());
    if (!browser) throw new AppError('网页会话已失效，请重新扫码', 410);
    return row;
  }
  function approver(row, userId, sessionToken) {
    if (row.user_id !== userId || row.approver_hash !== hash(sessionToken)) throw new AppError('此二维码已被其他登录会话扫描，请刷新二维码', 409);
  }
  function label(userAgent = '') {
    const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : '浏览器';
    const device = /iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows' : /Macintosh/.test(userAgent) ? 'Mac' : /Linux/.test(userAgent) ? 'Linux' : '网页';
    return `${device} · ${browser}`;
  }
  return {
    async create(sessionToken, userAgent) {
      const session = store.getSession(sessionToken);
      if (!session || session.userId) throw new AppError('请先退出网页账号，再扫码登录', 409);
      const id = randomUUID(), token = randomBytes(32).toString('base64url');
      const qrUri = `kivo://web-login?v=1&token=${token}`;
      // Generate before writing: a cancelled request cannot leave a half-built QR.
      const svg = await QRCode.toString(qrUri, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 240 });
      if (!store.getSession(sessionToken)) throw new AppError('网页会话已过期，请刷新', 410);
      db.prepare('DELETE FROM qr_logins WHERE expires_at<=? OR browser_hash=?').run(Date.now(), hash(sessionToken));
      const expiresAt = Date.now() + ttl;
      db.prepare("INSERT INTO qr_logins VALUES(?,?,?,NULL,NULL,'pending',?,?,?)").run(id, hash(token), hash(sessionToken), String(randomInt(100000, 1000000)), label(userAgent), expiresAt);
      return { ...view(browserChallenge(id, sessionToken)), qrImage: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` };
    },
    status(id, sessionToken) { return view(browserChallenge(id, sessionToken)); },
    cancel(id, sessionToken) {
      browserChallenge(id, sessionToken);
      db.prepare('DELETE FROM qr_logins WHERE id=? AND browser_hash=?').run(id, hash(sessionToken));
    },
    scan(token, userId, sessionToken) {
      let row = phoneChallenge(token);
      if (row.state === 'denied' || row.state === 'approved') throw new AppError('二维码已处理，请刷新二维码', 409);
      if (row.state === 'pending') {
        db.prepare("UPDATE qr_logins SET state='scanned',user_id=?,approver_hash=? WHERE id=? AND state='pending'").run(userId, hash(sessionToken), row.id);
        row = phoneChallenge(token);
      }
      approver(row, userId, sessionToken);
      return view(row);
    },
    decide(token, decision, userId, sessionToken) {
      if (!['approve', 'deny'].includes(decision)) throw new AppError('授权决定无效');
      const row = phoneChallenge(token); approver(row, userId, sessionToken);
      if (row.state !== 'scanned') throw new AppError('请重新扫码，或此二维码已经处理', 409);
      db.prepare('UPDATE qr_logins SET state=? WHERE id=?').run(decision === 'approve' ? 'approved' : 'denied', row.id);
      store.audit(userId, `account.qr_${decision}`, row.id, row.browser_label);
      return { ok: true };
    },
    redeem(id, sessionToken) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = browserChallenge(id, sessionToken);
        if (row.expires_at <= Date.now()) throw new AppError('二维码已过期，请刷新', 410);
        if (row.state !== 'approved') throw new AppError('请先在 kivo App 中确认登录', 409);
        const phone = db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').get(row.approver_hash, Date.now());
        const user = store.getUser(row.user_id);
        if (!phone || phone.user_id !== row.user_id || !user || user.disabled) throw new AppError('手机授权已失效，请重新登录后扫码', 410);
        const session = store.createSession(user.id);
        store.deleteSession(sessionToken); // Cascades the one-use challenge.
        store.audit(user.id, 'account.login_qr', user.id, row.browser_label);
        db.exec('COMMIT');
        return { session, user };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}
