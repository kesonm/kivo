// Run only on the server, in a disposable container with --network none.
// The database, passwords, API key and provider responses below are test fixtures.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { createApp, hashPassword } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createKibot } from '../server/kibot.mjs';
import { createWorkStore } from '../server/work-store.mjs';
import { verifyNavigationAndPointer } from './ui-interaction-checks.mjs';

// Keep the fixture's day/idle boundaries deterministic, even when QA runs at midnight.
const NativeDate = Date;
const fixtureOffset = NativeDate.parse('2026-11-10T15:00:00+08:00') - NativeDate.now();
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [NativeDate.now() + fixtureOffset])); }
  static now() { return NativeDate.now() + fixtureOffset; }
};

const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || '/qa/node_modules/playwright-core/index.mjs');
const output = process.env.QA_OUTPUT_DIR || '/out';
await mkdir(output, { recursive: true });
const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
const password = 'Kibot-fixture-password-2026';
const user = store.createUser({ username: 'qauser', displayName: '界面验收', passwordHash: await hashPassword(password) });
const otherUser = store.createUser({ username: 'qaother', displayName: '隔离验收', passwordHash: await hashPassword(password) });
store.setUserApiKey(user.id, 'sk-project-test-only-aaaaaaaaaaaaaaaaaaaaaaaaAAAA');
const primary = createKibot({ store }).ensure(user.id).thread;
const midnight = Date.parse(new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) + 'T00:00:00+08:00');
function message(role, text, time) {
  const record = store.appendMessage(primary.id, role, text);
  store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(new Date(time).toISOString(), record.id);
  return record;
}
message('user', '帮我梳理一下首页布局的问题。', midnight - 86400000 + 9 * 3600000);
message('assistant', '可以先优化三个地方：\n\n- 导航层级：固定主对话入口。\n- 内容间距：让聊天成为视觉中心。\n- 输入区域：保持清晰、稳定的位置。', midnight - 86400000 + 9 * 3600000 + 10000);
message('user', '灵猫插画想保留原来的构图。', midnight - 86400000 + 14 * 3600000);
message('assistant', '保留构图，重点调整角色轮廓与眼神。这个方向还需要你确认。', midnight - 86400000 + 14 * 3600000 + 10000);
message('user', '明天继续看主会话和任务入口。', midnight - 86400000 + 20 * 3600000);
message('assistant', '下一步先明确 kibot 与独立任务的入口。以上为模拟验收记录。', midnight - 86400000 + 20 * 3600000 + 10000);
message('user', '梳理部署方式，再看看界面怎么调整。', Date.now() - 3 * 3600000);
message('assistant', '已讨论服务器部署方式，决定保留网页形态，再优化 kibot 的导航和时间摘要。此记录仅用于界面验收。', Date.now() - 3 * 3600000 + 10000);
const graph = store.work = createWorkStore({ store });
for (const goal of ['灵猫插画调整', '首页布局优化', '部署配置检查']) {
  const object = graph.createObject(user.id, { kind: 'document', name: goal });
  graph.createTask(user.id, { goal, objects: [{ id: object.id, role: 'target' }] });
}
const legacy = store.createThread(null, user.id, '独立研究对话');
store.appendMessage(legacy.id, 'user', '这是独立对话的内容，不应出现在 kibot。');
const config = { dataDir: '/tmp/kibot-qa', hostDataDir: '/tmp/kibot-qa', distDir: '/app/dist', cookieSecure: false,
  model: 'gpt-6.1-sol', gatewayHost: '127.0.0.1', gatewayPort: 0, maxConcurrentRuns: 2,
  maxOutputTokens: 512, runTimeoutMs: 60000, workRoutingMode: 'enforce' };
const runtime = createRuntime({ store, config,
  spawnImpl() { throw new Error('Browser QA cannot launch executors'); },
  execFileImpl() { throw new Error('Browser QA cannot invoke Docker'); },
  fetchImpl: async () => {
    const answer = '这是模拟回复，未调用真实模型。主会话与独立任务保持分开。';
    const events = [{ type: 'response.output_text.delta', item_id: 'qa', delta: answer },
      { type: 'response.completed', response: { status: 'completed', output: [{ id: 'qa', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }], usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50 } } }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  },
});
const app = createApp({ store, runtime, config });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.QA_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto(base);
  await page.locator('input[name="username"]').fill('qauser');
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.locator('.kibot-summary-card').first().waitFor();
  assert.equal(await page.locator('.kibot-primary-link[aria-current="page"]').count(), 1);
  assert.equal(await page.getByText('工作对象', { exact: true }).count(), 0);
  assert.equal(await page.locator('.kibot-summary-card').count(), 2);
  assert.equal(await page.locator('.messages-list .user-message-content').count(), 0, 'Old primary messages should be folded');
  assert.equal(await page.locator('.kibot-history-panel').count(), 0);
  await verifyNavigationAndPointer(page, context, output);
  await page.screenshot({ path: `${output}/kibot-desktop.png`, fullPage: true });
  await page.locator('.kibot-summary-card').filter({ hasText: '查看全天记录' }).click();
  await page.locator('.kibot-history-message').first().waitFor();
  assert.equal(await page.locator('.kibot-history-message').count(), 6);
  await page.screenshot({ path: `${output}/kibot-history-desktop.png`, fullPage: true });
  await page.getByRole('button', { name: '个人设置', exact: true }).click();
  await page.getByRole('dialog', { name: '个人设置', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.kibot-history-panel').count(), 1, 'Closing settings must preserve the underlying history panel');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.kibot-history-panel').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('kibot-summary-card')), true);
  await page.locator('textarea').fill('这是一条界面验收消息');
  await page.locator('button[type="submit"]').click();
  await page.getByText('这是模拟回复，未调用真实模型。主会话与独立任务保持分开。', { exact: true }).waitFor();
  assert.equal(store.getThread(primary.id).title, 'kibot');
  await page.locator('.nav-task-row').filter({ hasText: '独立研究对话' }).click();
  await page.getByText('这是独立对话的内容，不应出现在 kibot。', { exact: true }).waitFor();
  assert.equal(await page.locator('.kibot-summary-card').count(), 0);
  await page.locator('.kibot-primary-link').click();
  await page.locator('.kibot-summary-card').first().waitFor();
  assert.equal(await page.getByText('这是独立对话的内容，不应出现在 kibot。', { exact: true }).count(), 0);
  await page.locator('.nav-task-row').filter({ hasText: '灵猫插画调整' }).click();
  await page.locator('.work-context-toggle').filter({ hasText: '下次发送 · 继续任务' }).waitFor();
  assert.equal(await page.locator('.kibot-summary-card').count(), 0, 'Task workspace must not display primary summaries');
  await page.locator('.kibot-primary-link').click();
  await page.locator('.kibot-summary-card').first().waitFor();
  await page.reload();
  await page.locator('.kibot-summary-card').first().waitFor();
  assert.equal(store.db.prepare('SELECT count(*) n FROM kibot_threads WHERE user_id=?').get(user.id).n, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.kibot-sidebar')?.inert);
  const compactAvatar = await page.getByRole('button', { name: '个人设置', exact: true }).boundingBox();
  const compactComposer = await page.locator('form.composer').boundingBox();
  assert.ok(compactAvatar && compactComposer && compactAvatar.y >= compactComposer.y + compactComposer.height, 'Mobile avatar must not cover the composer');
  await page.screenshot({ path: `${output}/kibot-mobile.png`, fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal overflow');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.locator('.kibot-sidebar-open').waitFor();
  await page.screenshot({ path: `${output}/kibot-mobile-navigation.png`, fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.kibot-sidebar-open').count(), 0);
  await page.locator('.kibot-summary-card').filter({ hasText: '查看全天记录' }).click();
  await page.locator('.kibot-history-message').first().waitFor();
  assert.equal(await page.locator('.kibot-history-panel').getAttribute('aria-modal'), 'true');
  await page.screenshot({ path: `${output}/kibot-history-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 520 });
  assert.equal(await page.locator('textarea').isVisible(), true);
  // A second browser tab changes the shared session cookie without reloading this tab.
  // Hold the new primary response to verify old content disappears immediately.
  let releasePrimary;
  const primaryGate = new Promise(resolve => { releasePrimary = resolve; });
  await page.route('**/api/kibot', async route => { await primaryGate; await route.continue(); });
  const session = await (await context.request.get(`${base}/api/session`)).json();
  const login = await context.request.post(`${base}/api/auth/login`, { headers: { Origin: base, 'X-CSRF-Token': session.csrfToken }, data: { username: otherUser.username, password } });
  assert.equal(login.status(), 200);
  await page.getByRole('button', { name: '个人设置', exact: true }).click();
  await page.getByRole('button', { name: /账户与 API Key/ }).click();
  await page.locator('.nav-profile strong').filter({ hasText: otherUser.displayName }).waitFor();
  assert.equal(await page.locator('.kibot-summary-card, .chat-message, .kibot-history-panel, .nav-task-row').count(), 0, 'Old account data must be cleared before new primary loads');
  releasePrimary();
  await page.locator('.kibot-current-empty').waitFor();
  assert.equal(store.db.prepare('SELECT count(*) n FROM kibot_threads WHERE user_id=?').get(otherUser.id).n, 1);
  assert.equal(await page.locator('.kibot-summary-card').count(), 0, 'The new account starts with its own empty primary');
  assert.deepEqual(errors, [], 'Browser errors');
  console.log(JSON.stringify({ ok: true, screenshots: 8, checks: ['login', 'primary identity', 'idle summaries', 'daily details', 'stacked dialogs', 'focus return', 'simulated stream', 'independent conversation isolation', 'explicit task selection', 'reload', 'mobile layout and avatar clearance', 'mobile navigation', 'mobile history', 'short viewport', 'cross-tab account isolation'], paidCalls: 0 }));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await runtime.close();
  store.close();
}
