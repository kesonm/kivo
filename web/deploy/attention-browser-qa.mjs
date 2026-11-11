// Server-only acceptance against the built frontend with simulated API state.
// No production accounts, inference credentials or model calls are used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || '/qa/node_modules/playwright-core/index.mjs');
const dist = path.resolve(process.env.QA_DIST_DIR || '/app/dist'), output = process.env.QA_OUTPUT_DIR || '/out';
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const requested = decodeURIComponent(new URL(req.url, 'http://qa').pathname);
    const file = requested.startsWith('/assets/') || requested === '/logo.png' ? path.resolve(dist, '.' + requested) : path.join(dist, 'index.html');
    if (!file.startsWith(dist + path.sep)) throw new Error('Invalid asset');
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage(), errors = [], checks = [], actions = [];
page.on('pageerror', error => errors.push(error.message));
const at = new Date().toISOString();
const user = { id: 'qa-attention', username: 'qaattention', displayName: '提醒验收', role: 'user', disabled: false, usedTokens: 0, apiKeyConfigured: true, createdAt: at };
const primary = { id: 'qa-primary', projectId: null, title: 'kibot', createdAt: at, updatedAt: at };
const makeTask = (id, title, kind, acknowledged = false) => ({
  id, goal: '保留的真实任务目标：' + title, conversationTitle: title, conversationId: 'thread-' + id,
  originMessageId: 'qa-origin', messageIds: ['qa-origin'], status: kind === 'failed' ? 'failed' : kind === 'approval' ? 'waiting_approval' : kind === 'reconciliation' ? 'needs_reconciliation' : 'waiting_input',
  queueStatus: kind === 'failed' ? 'failed' : kind === 'approval' ? 'running' : kind === 'reconciliation' ? 'needs_reconciliation' : 'completed',
  version: 1, updatedAt: at, needsAttention: !acknowledged,
  attention: { key: id + '-event-1', kind, requiresAction: !['failed', 'result'].includes(kind), canDismiss: ['failed', 'result'].includes(kind), acknowledged, canRetry: kind === 'failed', canAbandon: kind === 'failed' },
});
const tasks = [makeTask('failed', '失败待处理', 'failed'), makeTask('known', '已知晓的旧失败', 'failed', true), makeTask('approval', '待授权任务', 'approval'),
  makeTask('unknown', '执行结果未知', 'reconciliation'), makeTask('result', '完成结果待查看', 'result'), makeTask('input', '需要补充信息', 'input')];
const snapshot = () => ({ tasks, revision: JSON.stringify(tasks), counts: {
  attention: tasks.filter(task => task.needsAttention).length,
  actionRequired: tasks.filter(task => task.needsAttention && task.attention?.requiresAction).length,
  updates: tasks.filter(task => task.needsAttention && !task.attention?.requiresAction).length,
  queued: tasks.filter(task => task.queueStatus === 'queued').length, running: tasks.filter(task => task.queueStatus === 'running').length,
} });
await context.route('**/api/**', async route => {
  const url = new URL(route.request().url()), endpoint = url.pathname;
  const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  if (endpoint === '/api/session') return json({ user, csrfToken: 'qa-only', providerConfigured: true, model: 'qa-model', chatModels: [{ id: 'qa-model', label: 'QA' }] });
  if (endpoint === '/api/kibot') return json({ thread: primary });
  if (endpoint === '/api/projects') return json({ projects: [] });
  if (endpoint === '/api/history') return json({ threads: [] });
  if (endpoint === '/api/work' || /\/threads\/[^/]+\/work$/.test(endpoint)) return json({ mode: 'off', objects: [], tasks: [] });
  if (endpoint === '/api/kibot/timeline') return json({ threadId: primary.id, timeZone: 'Asia/Shanghai', summaries: [], activeMessageIds: ['qa-origin'], nextBefore: null, serverNow: at });
  if (endpoint === '/api/threads/' + primary.id) return json({ thread: primary, messages: [{ id: 'qa-origin', role: 'user', content: '查看我的任务', createdAt: at }], run: null, replyLinks: [] });
  if (endpoint === '/api/kibot/tasks') return json(snapshot());
  const match = endpoint.match(/^\/api\/kibot\/tasks\/([^/]+)(?:\/(ack|retry|stop))?$/);
  if (match) {
    const task = tasks.find(value => value.id === match[1]);
    if (!task) return json({ error: 'Unknown fixture task' }, 404);
    if (!match[2]) return json({ task, events: [], artifacts: [] });
    const body = route.request().postDataJSON(), action = match[2];
    actions.push({ taskId: task.id, action, body });
    assert.equal(body.expectedVersion, task.version);
    if (action !== 'stop') assert.equal(body.eventKey, task.attention.key);
    if (action === 'ack') {
      assert.ok(task.attention.canDismiss); task.attention.acknowledged = true; task.needsAttention = false;
    } else if (action === 'retry') {
      assert.ok(task.attention.canRetry); task.status = 'ready'; task.queueStatus = 'queued'; task.needsAttention = false; task.attention = null;
    } else {
      assert.ok(task.attention.canAbandon); task.status = 'cancelled'; task.queueStatus = 'cancelled'; task.needsAttention = false; task.attention = null;
    }
    return json({ task, ...(action === 'retry' ? { queued: true } : {}) });
  }
  return json({ error: 'Unknown fixture route' }, 404);
});
const panel = page.locator('.supervisor-panel');
const waitCount = count => page.waitForFunction(count => document.querySelector('.supervisor-attention')?.textContent.trim() === `任务提醒 ${count}`, count);
const openPending = async title => {
  await page.locator('.supervisor-task-strip .supervisor-attention').click();
  const dialog = page.getByRole('dialog', { name: '需要你处理', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '查看任务：' + title, exact: true }).click();
  await panel.waitFor();
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await waitCount(5);
  await page.locator('.supervisor-task-strip .supervisor-attention').click();
  const dialog = page.getByRole('dialog', { name: '需要你处理', exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.locator('.supervisor-task-card').count(), 5);
  assert.equal(await dialog.getByRole('button', { name: '查看任务：已知晓的旧失败', exact: true }).count(), 0);
  assert.equal(actions.length, 0, 'Opening pending items never acknowledges them');
  await dialog.getByRole('button', { name: '查看任务：失败待处理', exact: true }).click();
  await panel.getByRole('button', { name: '知道了', exact: true }).waitFor();
  assert.ok(await panel.getByRole('button', { name: '重试任务', exact: true }).isVisible());
  assert.ok(await panel.getByRole('button', { name: '放弃任务', exact: true }).isVisible());
  assert.equal(actions.length, 0, 'Opening details never acknowledges them');
  checks.push('pending entry lists only authoritative needsAttention tasks');
  await panel.getByRole('button', { name: '知道了', exact: true }).click();
  await waitCount(4);
  assert.equal(tasks[0].status, 'failed'); assert.equal(tasks[0].queueStatus, 'failed');
  assert.ok((await panel.locator('.kibot-history-subtitle').innerText()).includes('执行失败'));
  assert.equal(await panel.getByRole('button', { name: '知道了', exact: true }).count(), 0);
  assert.ok(await panel.getByRole('button', { name: '重试任务', exact: true }).isVisible());
  checks.push('acknowledging a failure clears its reminder without marking success');
  await panel.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await page.reload(); await waitCount(4);
  assert.equal(tasks[0].attention.acknowledged, true);
  checks.push('acknowledged failure remains cleared after reload');

  for (const title of ['待授权任务', '执行结果未知', '需要补充信息']) {
    await openPending(title);
    assert.equal(await panel.getByRole('button', { name: '知道了', exact: true }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: '重试任务', exact: true }).count(), 0);
    assert.equal(await panel.getByRole('button', { name: '放弃任务', exact: true }).count(), 0);
    await panel.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  }
  checks.push('approval, unknown execution and missing input cannot be dismissed or blindly retried');

  await openPending('完成结果待查看');
  await panel.getByRole('button', { name: '知道了', exact: true }).click(); await waitCount(3);
  assert.equal(tasks[4].status, 'waiting_input');
  await panel.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  checks.push('reading a completed result does not accept the task');

  tasks[0].attention = { ...tasks[0].attention, key: 'failed-event-2', acknowledged: false }; tasks[0].needsAttention = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await waitCount(4);
  await openPending('失败待处理');
  await panel.getByRole('button', { name: '重试任务', exact: true }).click(); await waitCount(3);
  assert.equal(tasks[0].queueStatus, 'queued');
  assert.equal(actions.filter(action => action.action === 'retry').length, 1);
  assert.equal(actions.find(action => action.action === 'retry').body.eventKey, 'failed-event-2');
  await panel.getByRole('button', { name: '关闭任务详情', exact: true }).click();
  checks.push('a new failure gets a new reminder and retries only its current event');

  tasks[1].attention = { ...tasks[1].attention, key: 'known-event-2', acknowledged: false }; tasks[1].needsAttention = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await waitCount(4);
  await openPending('已知晓的旧失败');
  await panel.getByRole('button', { name: '放弃任务', exact: true }).click(); await waitCount(3);
  assert.equal(tasks[1].status, 'cancelled'); assert.equal(tasks[1].queueStatus, 'cancelled');
  assert.ok((await panel.locator('.kibot-history-subtitle').innerText()).includes('已取消'));
  checks.push('abandoning a failed task preserves an honest cancelled status');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, 'attention-actions.png'), fullPage: true });
  console.log(JSON.stringify({ passed: checks.length, checks, actions, pageErrors: errors, paidCalls: 0 }));
} finally {
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve));
}
