// Server-only browser acceptance. Run in a disposable container with --network none.
// Credentials, messages and Responses below are fixtures; no paid calls or real projects.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { createApp, hashPassword } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createGateway } from '../server/gateway.mjs';
import { createKibot } from '../server/kibot.mjs';

const NativeDate = Date;
const fixtureOffset = NativeDate.parse('2026-11-11T15:00:00+08:00') - NativeDate.now();
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [NativeDate.now() + fixtureOffset])); }
  static now() { return NativeDate.now() + fixtureOffset; }
};
const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || '/qa/node_modules/playwright-core/index.mjs');
const output = process.env.QA_OUTPUT_DIR || '/out';
await mkdir(output, { recursive: true });
const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
const password = 'Supervisor-fixture-password-2026';
const user = store.createUser({ username: 'qasupervisor', displayName: '主助手验收', passwordHash: await hashPassword(password) });
const otherUser = store.createUser({ username: 'qasupervisorother', displayName: '隔离验收', passwordHash: await hashPassword(password) });
store.setUserApiKey(user.id, 'sk-project-fixture-aaaaaaaaaaaaaaaaaaaaaaaaAAAA');
const primary = createKibot({ store }).ensure(user.id).thread;
const config = { dataDir: '/tmp/supervisor-qa', hostDataDir: '/tmp/supervisor-qa', distDir: '/app/dist', cookieSecure: false,
  model: 'gpt-6.1-sol', gatewayHost: '127.0.0.1', gatewayPort: 0, maxConcurrentRuns: 1, maxOutputTokens: 1000,
  workContextBytes: 393216, runTimeoutMs: 180000, workRoutingMode: 'enforce' };
const calls = [];
const forbidden = () => { throw new Error('Supervisor browser QA cannot access projects or Docker'); };
const runtime = createRuntime({ store, config, spawnImpl: forbidden, execFileImpl: forbidden,
  gatewayFactory: options => createGateway({ ...options, report: () => {}, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const call = { payload: JSON.parse(request.body) };
    calls.push(call);
    return new Response(new ReadableStream({ start(controller) {
      call.controller = controller;
      request.signal.addEventListener('abort', () => { try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {} }, { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } }),
});
const app = createApp({ store, runtime, config, projects: { withLock: forbidden, executionEnvironment: forbidden } });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.QA_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [], checks = [];
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(predicate(), label);
}
function complete(index, content) {
  const output = typeof content === 'string' ? [{ type: 'message', id: `answer-${index}`, role: 'assistant', content: [{ type: 'output_text', text: content }] }] : content;
  calls[index].controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.completed', response: {
    id: `response-${index}`, status: 'completed', output, usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50 },
  } })}\n\n`));
  calls[index].controller.close();
}
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: 'Asia/Shanghai', locale: 'zh-CN' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(base);
  await page.locator('input[name="username"]').fill(user.username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.locator('.kibot-current-empty').waitFor();
  await page.waitForFunction(() => document.querySelector('textarea') && !document.querySelector('textarea').disabled);
  checks.push('login');

  await page.locator('textarea').fill('请建立独立任务，整理首页优化建议。记住：页面保持纯白背景。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await until(() => calls.length === 1, 'Primary request reached the simulated provider');
  assert.ok(calls[0].payload.tools.some(tool => tool.name === 'kivo_delegate_task'));
  assert.ok(calls[0].payload.tools.some(tool => tool.name === 'kivo_remember'));
  complete(0, [
    { type: 'function_call', id: 'delegate-item', call_id: 'delegate-once', name: 'kivo_delegate_task', arguments: JSON.stringify({
      goal: '整理首页优化建议', projectId: null, constraints: ['仅分析，保持纯白背景'], acceptance: ['给出具体建议'],
    }) },
    { type: 'function_call', id: 'memory-item', call_id: 'remember-once', name: 'kivo_remember', arguments: JSON.stringify({
      kind: 'constraint', text: '页面保持纯白背景', source_message_id: null, replaces_id: null,
    }) },
  ]);
  await until(() => calls.length === 2, 'Actual application tools return to the primary');
  const toolOutputs = calls[1].payload.input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output));
  const task = toolOutputs.find(item => item.task?.id)?.task;
  assert.ok(task?.id, 'Delegation produced a real task');
  assert.equal(app.locals.primaryMemory.snapshot(user.id).notes.length, 1, 'Memory function persisted a source-linked note');
  complete(1, '已安排独立任务整理首页建议，并记住页面保持纯白背景。');
  await page.getByText('已安排独立任务整理首页建议，并记住页面保持纯白背景。', { exact: true }).waitFor();
  await page.locator('.supervisor-task-card').waitFor();
  assert.equal(await page.locator('.supervisor-task-card').count(), 1);
  assert.notEqual(task.conversationId, primary.id);
  assert.equal(store.getThread(primary.id).projectId, null);
  checks.push('function tool delegation', 'single linked task card', 'separate execution thread', 'source-linked memory');

  await app.locals.supervisor.pump();
  await until(() => calls.length === 3, 'Queued worker started');
  const worker = app.locals.supervisor.snapshot(user.id).tasks.find(item => item.id === task.id);
  assert.equal(worker.queueStatus, 'running');
  await page.locator('.supervisor-task-strip').getByRole('button', { name: /进行中 1/ }).waitFor();
  assert.equal(await page.locator('textarea').isEnabled(), true, 'Background worker does not disable primary input');
  await page.screenshot({ path: `${output}/supervisor-desktop.png`, fullPage: true, animations: 'disabled' });
  checks.push('worker queue dispatch', 'primary remains usable during worker');
  await page.waitForFunction(() => [...document.querySelectorAll('.nav-task-row')].filter(row=>row.getAttribute('title')==='整理首页优化建议').length===1);
  checks.push('task navigation is not duplicated as an independent chat');

  const draft = '任务继续，先聊一下配色。';
  await page.locator('textarea').fill(draft);
  await page.locator('.supervisor-task-card').click();
  await page.locator('.supervisor-panel').waitFor();
  await page.locator('.supervisor-panel').getByRole('button', { name: '打开任务会话', exact: true }).waitFor();
  await page.screenshot({ path: `${output}/supervisor-task-desktop.png`, fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  assert.equal(await page.locator('textarea').inputValue(), draft, 'Task details preserve the main draft');
  await page.waitForFunction(() => document.activeElement?.classList.contains('supervisor-task-card'));
  await page.locator('.supervisor-task-card').click();
  await page.getByRole('button', { name: '和 kibot 讨论这项任务', exact: true }).click();
  await page.locator('.supervisor-reference').waitFor();
  assert.equal(await page.locator('textarea').inputValue(), draft);
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await until(() => calls.length === 4, 'Primary starts a second request while worker remains active');
  assert.equal(store.getActiveRunsForUser(user.id).length, 2);
  assert.ok(calls[3].payload.input[0].content.includes(task.id), 'Task chip is delivered as an owned task reference');
  complete(3, '可以，任务继续运行，我们来讨论配色。');
  await page.getByText('可以，任务继续运行，我们来讨论配色。', { exact: true }).waitFor();
  assert.equal(await page.locator('.supervisor-reference').count(), 0);
  assert.equal(store.getRun(worker.latestRunId).status, 'running');
  checks.push('desktop details', 'draft and focus restoration', 'task reference chip', 'concurrent primary reply');

  complete(2, '建议：收紧侧栏、统一间距，并保留纯白背景。');
  await until(() => store.getRun(worker.latestRunId).status === 'completed', 'Worker finished');
  await app.locals.supervisor.pump();
  await app.locals.supervisor.pump();
  await page.locator('.messages-list .markdown').filter({ hasText: '收紧侧栏、统一间距' }).waitFor();
  assert.equal(store.getMessages(primary.id).filter(message => message.supervisorTaskId === task.id).length, 1, 'One durable completion notification');
  assert.equal(await page.locator('.supervisor-task-card').count(), 1, 'Card moves to the latest related notification without duplication');
  assert.equal(await page.locator('.supervisor-task-card .supervisor-status').textContent(), '待查看结果');
  checks.push('worker result returns to primary', 'notification deduplication', 'completion versus acceptance');

  await page.getByRole('button', { name: '工作记忆', exact: true }).click();
  await page.getByRole('dialog', { name: '工作记忆', exact: true }).waitFor();
  await page.locator('.supervisor-memory-note').waitFor();
  assert.equal(await page.locator('.supervisor-memory-note > p').textContent(), '页面保持纯白背景');
  await page.getByRole('button', { name: '从工作记忆移除', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.supervisor-memory-note').length === 0);
  assert.equal(app.locals.primaryMemory.snapshot(user.id).notes.length, 0);
  assert.ok(store.getMessages(primary.id).some(message => message.content.includes('记住：页面保持纯白背景')), 'Forgetting a note preserves original history');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '工作记忆', exact: true }).waitFor({ state: 'detached' });
  checks.push('memory view and removal', 'raw history preserved');

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileDraft = '这份草稿在关闭任务详情后继续保留。';
  await page.locator('textarea').fill(mobileDraft);
  await page.locator('.supervisor-task-card').click();
  await page.waitForFunction(() => document.querySelector('.supervisor-panel')?.getAttribute('aria-modal') === 'true');
  await page.waitForFunction(() => document.querySelector('.chat-panel')?.inert === true);
  await page.screenshot({ path: `${output}/supervisor-task-mobile.png`, fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.supervisor-panel')), true, 'Mobile task drawer traps focus');
  }
  await page.keyboard.press('Escape');
  await page.locator('.supervisor-panel').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.supervisor-panel').count(), 0);
  assert.equal(await page.locator('textarea').inputValue(), mobileDraft);
  assert.equal(await page.locator('textarea').isEnabled(), true);
  checks.push('mobile task drawer', 'mobile focus trap', 'no horizontal overflow', 'mobile draft preservation');

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator('.supervisor-task-strip').getByRole('button', { name: '全部任务', exact: true }).click();
  await page.getByRole('dialog', { name: '全部任务', exact: true }).waitFor();
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('首页');
  assert.equal(await page.locator('.supervisor-all-list .nav-result-row').count(), 1);
  await page.keyboard.press('Escape');
  checks.push('all task list and search');

  // Change the shared cookie as a second tab would. The old view must clear as
  // soon as the frontend observes the new identity, before the new primary loads.
  let releasePrimary;
  const primaryGate = new Promise(resolve => { releasePrimary = resolve; });
  await page.route('**/api/kibot', async route => { await primaryGate; await route.continue(); });
  const session = await (await context.request.get(`${base}/api/session`)).json();
  const login = await context.request.post(`${base}/api/auth/login`, { headers: { Origin: base, 'X-CSRF-Token': session.csrfToken }, data: { username: otherUser.username, password } });
  assert.equal(login.status(), 200);
  await page.getByRole('button', { name: '个人设置', exact: true }).click();
  await page.getByRole('button', { name: /账户与 API Key/ }).click();
  await page.waitForFunction(name => document.querySelector('.nav-profile strong')?.textContent === name, otherUser.displayName);
  assert.equal(await page.locator('.supervisor-task-card,.supervisor-panel,.supervisor-reference,.supervisor-task-strip,.chat-message,.nav-task-row').count(), 0, 'Old account tasks, messages, references and panels are removed');
  releasePrimary();
  await page.locator('.kibot-current-empty').waitFor();
  assert.equal(await page.locator('.supervisor-task-card,.supervisor-task-strip').count(), 0);
  assert.equal(app.locals.supervisor.snapshot(otherUser.id).tasks.length, 0);
  checks.push('cross-tab account isolation');
  assert.deepEqual(errors, [], 'Browser errors');
  console.log(JSON.stringify({ ok: true, checks, screenshots: 3, paidCalls: 0, providerRequests: calls.length }));
} finally {
  await browser.close();
  await app.locals.supervisor.close();
  await runtime.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  store.close();
}
