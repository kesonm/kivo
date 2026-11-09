import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { createApp, hashPassword } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';

// Observe only the input to the actual SVG encoder. Production never returns
// the token outside the QR image or writes it to the database in plaintext.
const encode = QRCode.toString.bind(QRCode);
let encodedPayload;
QRCode.toString = (payload, options) => { encodedPayload = payload; return encode(payload, options); };
const password = 'QR-test-only-password-2026';
const origin = 'https://kivo.iptnet.xyz';

async function fixture(t) {
  const store = createStore(':memory:');
  const user = store.createUser({ username: 'alice', displayName: 'Alice', passwordHash: await hashPassword(password) });
  const other = store.createUser({ username: 'bobby', displayName: 'Bob', passwordHash: await hashPassword(password) });
  const app = createApp({ store, runtime: { providerConfigured: () => false, interrupt: async () => {} },
    config: { dataDir: '/tmp/qr-test', publicOrigin: origin, cookieSecure: false, model: 'test' } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function client(username) {
    let cookie = '', csrf = '';
    const request = async (method, path, body, headers = {}) => {
      const response = await fetch(base + path, { method, headers: { cookie, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/130.0', ...headers },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const data = await response.json(); if (data.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data, headers: response.headers };
    };
    await request('GET', '/api/session');
    if (username) assert.equal((await request('POST', '/api/auth/login', { username, password })).status, 200);
    return { request, cookie: () => cookie };
  }
  async function challenge(browser) {
    const response = await browser.request('POST', '/api/auth/qr'); assert.equal(response.status, 201);
    const token = new URL(encodedPayload).searchParams.get('token');
    assert.equal(response.data.qrImage.startsWith('data:image/svg+xml;base64,'), true);
    assert.equal(JSON.stringify(response.data).includes(token), false);
    return { ...response.data, token };
  }
  return { store, user, other, client, challenge };
}

test('QR login requires scan + explicit approval and rotates only the originating browser session once', async t => {
  const { store, user, client, challenge } = await fixture(t);
  const browser = await client(), phone = await client('alice'), stranger = await client();
  const oldCookie = browser.cookie(), code = await challenge(browser);
  assert.equal((await stranger.request('GET', `/api/auth/qr/${code.id}`)).status, 404);
  assert.equal((await stranger.request('POST', `/api/auth/qr/${code.id}/redeem`)).status, 404);
  assert.equal((await browser.request('POST', '/api/auth/qr/scan', { token: code.token })).status, 401);
  assert.equal((await phone.request('POST', '/api/auth/qr/confirm', { token: code.token, decision: 'approve' })).status, 409);
  const scan = await phone.request('POST', '/api/auth/qr/scan', { token: code.token });
  assert.equal(scan.data.verificationCode, code.verificationCode); assert.equal(scan.data.origin, origin); assert.equal(scan.data.username, 'alice');
  assert.equal((await browser.request('POST', `/api/auth/qr/${code.id}/redeem`)).status, 409);
  assert.equal((await browser.request('GET', '/api/session')).data.user, null);
  assert.equal((await phone.request('POST', '/api/auth/qr/confirm', { token: code.token, decision: 'approve' })).status, 200);
  const redeemed = await browser.request('POST', `/api/auth/qr/${code.id}/redeem`);
  assert.equal(redeemed.status, 200); assert.equal(redeemed.data.user.id, user.id);
  assert.notEqual(browser.cookie(), oldCookie); assert.equal(store.getSession(oldCookie.split('=')[1]), null);
  assert.match(redeemed.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await phone.request('GET', '/api/session')).data.user.id, user.id);
  assert.equal((await browser.request('POST', `/api/auth/qr/${code.id}/redeem`)).status, 409);
  const audit = store.getAudit(); assert.ok(audit.some(row => row.action === 'account.login_qr'));
  assert.equal(JSON.stringify(audit).includes(code.token), false);
});

test('cancel, refresh and expiration never yield a browser login', async t => {
  const { store, client, challenge } = await fixture(t);
  const browser = await client(), phone = await client('alice');
  const first = await challenge(browser), refreshed = await challenge(browser);
  assert.equal((await phone.request('POST', '/api/auth/qr/scan', { token: first.token })).status, 410);
  await phone.request('POST', '/api/auth/qr/scan', { token: refreshed.token });
  await phone.request('POST', '/api/auth/qr/confirm', { token: refreshed.token, decision: 'deny' });
  assert.equal((await browser.request('GET', `/api/auth/qr/${refreshed.id}`)).data.status, 'denied');
  assert.equal((await browser.request('POST', `/api/auth/qr/${refreshed.id}/redeem`)).status, 409);
  const expired = await challenge(browser);
  store.db.prepare('UPDATE qr_logins SET expires_at=? WHERE id=?').run(Date.now() - 1, expired.id);
  assert.equal((await browser.request('GET', `/api/auth/qr/${expired.id}`)).data.status, 'expired');
  assert.equal((await phone.request('POST', '/api/auth/qr/scan', { token: expired.token })).status, 410);
  assert.equal((await browser.request('POST', `/api/auth/qr/${expired.id}/redeem`)).status, 410);
  const canceled = await challenge(browser);
  await browser.request('DELETE', `/api/auth/qr/${canceled.id}`);
  assert.equal((await phone.request('POST', '/api/auth/qr/scan', { token: canceled.token })).status, 410);
  assert.equal((await browser.request('GET', '/api/session')).data.user, null);
});

test('approval is bound to the scanning phone session, not just a user ID or captured QR', async t => {
  const { client, challenge } = await fixture(t);
  const browser = await client(), alice = await client('alice'), sameUserOtherPhone = await client('alice'), bob = await client('bobby');
  const code = await challenge(browser);
  await alice.request('POST', '/api/auth/qr/scan', { token: code.token });
  for (const other of [sameUserOtherPhone, bob]) {
    assert.equal((await other.request('POST', '/api/auth/qr/scan', { token: code.token })).status, 409);
    assert.equal((await other.request('POST', '/api/auth/qr/confirm', { token: code.token, decision: 'approve' })).status, 409);
  }
  assert.equal((await browser.request('GET', '/api/session')).data.user, null);
});

test('phone logout, password change and disabling invalidate outstanding approvals', async t => {
  const { store, user, other, client, challenge } = await fixture(t);
  for (const operation of ['logout', 'password', 'disable']) {
    const browser = await client(), phone = await client('alice'), code = await challenge(browser);
    await phone.request('POST', '/api/auth/qr/scan', { token: code.token });
    await phone.request('POST', '/api/auth/qr/confirm', { token: code.token, decision: 'approve' });
    if (operation === 'logout') await phone.request('POST', '/api/auth/logout');
    if (operation === 'password') store.setPassword(user.id, await hashPassword(password), user.id);
    if (operation === 'disable') store.updateUser(user.id, { disabled: true }, other.id);
    assert.equal((await browser.request('POST', `/api/auth/qr/${code.id}/redeem`)).status, 410);
    assert.equal((await browser.request('GET', '/api/session')).data.user, null);
  }
});

test('QR mutations retain CSRF/origin protection, database tokens are hashed and malformed input fails closed', async t => {
  const { store, client, challenge } = await fixture(t);
  const browser = await client(), phone = await client('alice');
  assert.equal((await browser.request('POST', '/api/auth/qr', {}, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await browser.request('POST', '/api/auth/qr', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await phone.request('POST', '/api/auth/qr')).status, 409);
  const code = await challenge(browser);
  const row = store.db.prepare('SELECT * FROM qr_logins WHERE id=?').get(code.id);
  assert.equal(row.token_hash, createHash('sha256').update(code.token).digest('hex'));
  assert.equal(JSON.stringify(row).includes(code.token), false);
  assert.equal((await phone.request('POST', '/api/auth/qr/scan', { token: code.token }, { 'X-CSRF-Token': '' })).status, 403);
  for (const token of [null, {}, 'short', 'x'.repeat(201)]) assert.equal((await phone.request('POST', '/api/auth/qr/scan', { token })).status, 400);
  await phone.request('POST', '/api/auth/qr/scan', { token: code.token });
  assert.equal((await phone.request('POST', '/api/auth/qr/confirm', { token: code.token, decision: 'approve' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await browser.request('GET', `/api/auth/qr/${code.id}`)).headers.get('cache-control'), 'no-store');
});

test('parallel browser redemption creates exactly one successful login', async t => {
  const { client, challenge } = await fixture(t);
  const browser = await client(), phone = await client('alice'), code = await challenge(browser);
  await phone.request('POST', '/api/auth/qr/scan', { token: code.token });
  await phone.request('POST', '/api/auth/qr/confirm', { token: code.token, decision: 'approve' });
  const results = await Promise.all([browser.request('POST', `/api/auth/qr/${code.id}/redeem`), browser.request('POST', `/api/auth/qr/${code.id}/redeem`)]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.ok(results.some(result => [403, 404, 409].includes(result.status)));
});
