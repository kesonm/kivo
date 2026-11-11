// Server-only UI acceptance with mocked API responses. No credentials or model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || '/qa/node_modules/playwright-core/index.mjs');
const dist = path.resolve(process.env.QA_DIST_DIR || '/app/dist');
const output = process.env.QA_OUTPUT_DIR || '/out';
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const requested = decodeURIComponent(new URL(req.url, 'http://qa').pathname);
    const file = requested.startsWith('/assets/') || requested === '/logo.png' ? path.resolve(dist, '.' + requested) : path.join(dist, 'index.html');
    if (!file.startsWith(dist + path.sep)) throw new Error('Invalid asset');
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'text/html');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage(), errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const at = '2026-11-11T09:00:00.000Z';
const user = { id: 'qa-user', username: 'qauser', displayName: '标题验收', role: 'user', disabled: false, usedTokens: 0, apiKeyConfigured: true, createdAt: at };
const makeThread = (id, title) => ({ id, projectId: null, title, titlePending: false, createdAt: at, updatedAt: at });
const primary = makeThread('qa-primary', 'kibot');
const threads = [makeThread('qa-a', '首条消息作为旧标题'), makeThread('qa-b', '另一个对话'), makeThread('qa-task', '餐饮系统选型')];
const originalGoal = '检索具备完整代码与清晰许可证的餐饮点餐项目，并核对小程序和支付能力。';
const task = { id: 'qa-task-id', goal: originalGoal, conversationTitle: threads[2].title, status: 'waiting_input', queueStatus: 'completed', conversationId: threads[2].id,
  originMessageId: 'qa-origin', updatedAt: at, summary: '已整理候选项目。', version: 1, messageIds: ['qa-origin'] };
const messages = new Map([[primary.id, [{ id: 'qa-origin', role: 'user', content: '帮我比较餐饮项目', createdAt: at }]], ...threads.map(thread => [thread.id, []])]);
const runs = new Map(), bodyReads = new Map(), titleReads = new Map();
let turn = 0, delayedTitle, releaseTitle, delayedBody, releaseBody, keepNextRunRunning = false, historyReads = 0;
const threadFor = id => id === primary.id ? primary : threads.find(thread => thread.id === id);
const work = { mode: 'off', objects: [], tasks: [], focus: { revision: 0, taskId: null, objectId: null } };
await context.route('**/api/**', async route => {
  const url = new URL(route.request().url()), pathname = url.pathname;
  const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  if (pathname === '/api/session') return json({ user, csrfToken: 'qa-only', providerConfigured: true, model: 'qa-model', defaultChatModel: 'qa-model', chatModels: [{ id: 'qa-model', label: 'QA', efforts: ['medium'], defaultEffort: 'medium' }] });
  if (pathname === '/api/kibot') return json({ thread: primary });
  if (pathname === '/api/projects') return json({ projects: [] });
  if (pathname === '/api/work' || /\/threads\/[^/]+\/work$/.test(pathname)) return json(work);
  if (pathname === '/api/history') {
    ++historyReads;
    return json({ threads: threads.filter(thread => thread.title.includes(url.searchParams.get('q') || '')) });
  }
  if (pathname === '/api/kibot/tasks') return json({ tasks: [task], counts: { queued: 0, running: 0, attention: 1 }, revision: JSON.stringify(task) });
  if (pathname === '/api/kibot/tasks/' + task.id) return json({ task, events: [], artifacts: [] });
  if (pathname === '/api/kibot/timeline') return json({ threadId: primary.id, timeZone: 'Asia/Shanghai', summaries: [], activeMessageIds: ['qa-origin'], nextBefore: null, serverNow: at });
  const title = pathname.match(/^\/api\/threads\/([^/]+)\/title$/);
  if (title) {
    titleReads.set(title[1], (titleReads.get(title[1]) || 0) + 1);
    if (delayedTitle === title[1]) {
      delayedTitle = null;
      await new Promise(resolve => { releaseTitle = resolve; });
      return json({ thread: { ...threadFor(title[1]), title: '迟到标题不可覆盖新会话', updatedAt: '2026-11-11T23:00:00.000Z' } }).catch(() => undefined);
    }
    return json({ thread: threadFor(title[1]) });
  }
  const send = pathname.match(/^\/api\/threads\/([^/]+)\/turns$/);
  if (send) {
    const thread = threadFor(send[1]), body = route.request().postDataJSON();
    ++turn; thread.titlePending = true; thread.updatedAt = `2026-11-11T09:00:${String(turn).padStart(2, '0')}.000Z`;
    const run = { id: 'qa-run-' + turn, threadId: thread.id, projectId: null, status: 'running', output: '', logs: [], createdAt: thread.updatedAt, updatedAt: thread.updatedAt };
    messages.get(thread.id).push({ id: 'qa-user-' + turn, role: 'user', content: body.text, createdAt: thread.updatedAt });
    if (keepNextRunRunning) {
      keepNextRunRunning = false; thread.titlePending = false; thread.hasActiveRun = true;
      runs.set(thread.id, run); return json({ run });
    }
    messages.get(thread.id).push({ id: 'qa-answer-' + turn, role: 'assistant', content: '这轮对话已经完成。', createdAt: thread.updatedAt });
    runs.set(thread.id, { ...run, status: 'completed', output: '这轮对话已经完成。' });
    return json({ run });
  }
  const stream = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (stream) {
    const run = [...runs.values()].find(value => value.id === stream[1]);
    return route.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(run)}\n\n`
      + (run.status === 'running' ? '' : 'event: done\ndata: {"status":"completed"}\n\n') });
  }
  if (/\/runs\/[^/]+\/context$/.test(pathname)) return json({ recorded: false, sources: [], execution: null });
  const detail = pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (detail) {
    bodyReads.set(detail[1], (bodyReads.get(detail[1]) || 0) + 1);
    const value = JSON.parse(JSON.stringify({ thread: threadFor(detail[1]), messages: messages.get(detail[1]), run: runs.get(detail[1]) || null, replyLinks: [] }));
    if (delayedBody === detail[1]) {
      delayedBody = null; await new Promise(resolve => { releaseBody = resolve; });
    }
    return json(value);
  }
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Unknown QA route"}' });
});
const waitText = async (selector, text) => page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
const sidebar = title => page.locator('.nav-task-row').filter({ has: page.locator('strong', { hasText: title }) });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('.brand-logo')?.naturalWidth > 0);
  await page.getByRole('button', { name: '查看任务：餐饮系统选型', exact: true }).click();
  await waitText('#supervisor-panel-title', '餐饮系统选型');
  assert.ok(await page.locator('.supervisor-detail-scroll').getByText(originalGoal, { exact: true }).isVisible());
  await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  checks.push('task card and detail use conversation title while retaining the original goal');

  await sidebar(threads[0].title).click();
  await waitText('.breadcrumb', threads[0].title);
  for (const next of ['部署逻辑与输出预算', '实时会话标题与历史检索']) {
    const expectedAnswers = turn + 1;
    await page.getByRole('textbox', { name: '发送给 kivo 的消息' }).fill(next);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll('.message-assistant').length === count, expectedAnswers);
    await page.waitForTimeout(100);
    const reads = bodyReads.get(threads[0].id);
    threads[0].title = next; threads[0].titlePending = false;
    threads[0].titleUpdatedAt = `2026-11-11T09:01:${String(turn).padStart(2, '0')}.000Z`;
    await waitText('.breadcrumb', next); await sidebar(next).waitFor();
    assert.equal(bodyReads.get(threads[0].id), reads, 'Title polling does not reload the transcript');
    checks.push('completed turn updates breadcrumb and sidebar: ' + next);
  }
  const settledReads = titleReads.get(threads[0].id);
  await page.waitForTimeout(3400);
  assert.equal(titleReads.get(threads[0].id), settledReads, 'Polling stops after titlePending clears');
  checks.push('title polling stops once the title job has settled');

  threads[1].titlePending = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(300);
  threads[1].title = '后台会话的新摘要'; threads[1].titlePending = false; threads[1].titleUpdatedAt = '2026-11-11T09:02:00.000Z';
  await sidebar(threads[1].title).waitFor();
  assert.ok((await page.locator('.breadcrumb').innerText()).includes(threads[0].title));
  checks.push('another conversation updates in the sidebar without changing the active conversation');

  delayedTitle = threads[0].id;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => true);
  const waitUntil = Date.now() + 5000;
  while (!releaseTitle && Date.now() < waitUntil) await page.waitForTimeout(20);
  assert.ok(releaseTitle, 'The old conversation title request was held');
  await sidebar(threads[1].title).click(); await waitText('.breadcrumb', threads[1].title);
  releaseTitle(); await page.waitForTimeout(150);
  assert.ok((await page.locator('.breadcrumb').innerText()).includes(threads[1].title));
  checks.push('a late response cannot replace another conversation title');

  const oldTitle = threads[0].title;
  threads[0].titlePending = true; delayedBody = threads[0].id;
  await sidebar(oldTitle).click();
  const bodyDeadline = Date.now() + 5000;
  while (!releaseBody && Date.now() < bodyDeadline) await page.waitForTimeout(20);
  assert.ok(releaseBody, 'A transcript snapshot with the old title was held');
  threads[0].title = '标题更新与旧请求竞争'; threads[0].titlePending = false;
  // Deliberately retain both timestamps: request ordering must also protect a
  // newer title when metadata timestamps have the same millisecond value.
  await waitText('.breadcrumb', threads[0].title);
  await page.evaluate(oldTitle => {
    window.qaStaleTitleSeen = false;
    window.qaTitleObserver = new MutationObserver(() => {
      if (document.querySelector('.breadcrumb')?.textContent.includes(oldTitle)) window.qaStaleTitleSeen = true;
    });
    window.qaTitleObserver.observe(document.querySelector('.breadcrumb'), { subtree: true, characterData: true, childList: true });
  }, oldTitle);
  releaseBody(); await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => { window.qaTitleObserver.disconnect(); return window.qaStaleTitleSeen; }), false);
  assert.ok((await page.locator('.breadcrumb').innerText()).includes(threads[0].title));
  checks.push('a delayed transcript cannot overwrite newer title metadata even with equal timestamps');

  keepNextRunRunning = true;
  await page.getByRole('textbox', { name: '发送给 kivo 的消息' }).fill('这个回复需要超过九十秒完成');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '停止任务', exact: true }).waitFor();
  await sidebar(threads[1].title).click(); await waitText('.breadcrumb', threads[1].title);
  await page.evaluate(() => { window.qaOriginalNow = Date.now; Date.now = () => window.qaOriginalNow() + 120_000; });
  const previousHistoryReads = historyReads, runningDeadline = Date.now() + 5000;
  while (historyReads <= previousHistoryReads && Date.now() < runningDeadline) await page.waitForTimeout(20);
  assert.ok(historyReads > previousHistoryReads, 'History polling survives the title window while another conversation is running');
  const completed = runs.get(threads[0].id);
  completed.status = 'completed'; completed.output = '后台回复已完成。';
  threads[0].hasActiveRun = false; threads[0].titlePending = true;
  messages.get(threads[0].id).push({ id: 'qa-background-answer', role: 'assistant', content: completed.output, createdAt: at });
  const beforePendingRead = historyReads, pendingDeadline = Date.now() + 5000;
  while (historyReads <= beforePendingRead && Date.now() < pendingDeadline) await page.waitForTimeout(20);
  assert.ok(historyReads > beforePendingRead, 'Completion continues into title-job polling');
  threads[0].title = '后台长任务完成后的会话摘要'; threads[0].titlePending = false; threads[0].titleUpdatedAt = '2026-11-11T10:00:00.000Z';
  await sidebar(threads[0].title).waitFor();
  assert.ok((await page.locator('.breadcrumb').innerText()).includes(threads[1].title));
  await page.evaluate(() => { Date.now = window.qaOriginalNow; });
  checks.push('a long-running conversation updates after switching away without a focus event');

  await page.getByRole('button', { name: /kibot 你的主对话/ }).click();
  await page.locator('.kibot-current-empty, .supervisor-task-card').first().waitFor();
  assert.equal(titleReads.get(primary.id) || 0, 0);
  assert.equal(await page.locator('.kibot-primary-link strong').innerText(), 'kibot');
  checks.push('kibot remains a fixed entry and never polls for a generated title');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'titles-desktop.png'), fullPage: true });
  console.log(JSON.stringify({ passed: checks.length, checks, bodyReads: Object.fromEntries(bodyReads), titleReads: Object.fromEntries(titleReads), pageErrors: errors }));
} finally {
  if (releaseTitle) releaseTitle();
  if (releaseBody) releaseBody();
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
}
