// Server-only browser + HTTP acceptance. Isolated database, fake provider, no live keys.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createApp, hashPassword } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createGateway } from '../server/gateway.mjs';
import { createKibot } from '../server/kibot.mjs';

const { chromium } = await import(process.env.QA_PLAYWRIGHT_MODULE || '/qa/node_modules/playwright-core/index.mjs');
const outputDir = process.env.QA_OUTPUT_DIR || '/out';
await mkdir(outputDir, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
const password = 'Image-edit-fixture-password-2026';
const user = store.createUser({ username: 'qaimageedit', displayName: '图片编辑验收', passwordHash: await hashPassword(password) });
store.setUserApiKey(user.id, 'sk-project-image-fixture-aaaaaaaaaaaaaaaaAAAA');
const primary = createKibot({ store }).ensure(user.id).thread;
const config = { dataDir: '/tmp/image-edit-qa', distDir: '/app/dist', cookieSecure: false, model: 'gpt-6.1-sol',
  gatewayHost: '127.0.0.1', gatewayPort: 0, maxConcurrentRuns: 2, runTimeoutMs: 15000, workRoutingMode: 'enforce' };
const calls = [], errors = [], checks = [];
const forbidden = () => { throw new Error('Image QA cannot access project execution'); };
const runtime = createRuntime({ store, config, spawnImpl: forbidden, execFileImpl: forbidden,
  gatewayFactory: options => createGateway({ ...options, report: () => {}, fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const payload = JSON.parse(request.body), index = calls.push(payload);
    const output = [{ id: `text-${index}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `模拟编辑结果 ${index}` }] }];
    if (payload.tools.some(tool => tool.type === 'image_generation')) output.push({ id: `image-${index}`, type: 'image_generation_call', status: 'completed', result: png.toString('base64') });
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `response-${index}`, status: 'completed', output,
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } }),
});
const app = createApp({ store, runtime, config, projects: { withLock: forbidden, executionEnvironment: forbidden } });
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.locator('input[name="username"]').fill(user.username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('textarea') && !document.querySelector('textarea').disabled);
  const send = async text => {
    const number = calls.length + 1;
    await page.locator('textarea').fill(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByText(`模拟编辑结果 ${number}`, { exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('textarea').disabled);
    return calls[number - 1];
  };
  const imageInputs = payload => payload.input.flatMap(item => Array.isArray(item.content) ? item.content.filter(part => part.type === 'input_image') : []);
  await page.locator('input[type="file"]').setInputFiles({ name: 'original.png', mimeType: 'image/png', buffer: png });
  const first = await send('把这张图片里的手和腿都改长一些。');
  assert.equal(imageInputs(first).length, 1);
  assert.ok(first.tools.some(tool => tool.type === 'image_generation'));
  assert.ok(!first.tools.some(tool => tool.name === 'kivo_delegate_task'));
  await page.locator('.chat-images img').waitFor();
  const original = store.getMessages(primary.id).find(message => message.role === 'user').attachments[0];
  const generated = store.getMessages(primary.id).at(-1).artifacts[0];
  checks.push('PNG upload preserves automatic image tool and returns a saved image');

  const second = await send('再把腿加长一点。');
  assert.equal(imageInputs(second).length, 1);
  assert.deepEqual(store.getMessages(primary.id).filter(message => message.role === 'user').at(-1).imageReferenceIds, [generated.id]);
  checks.push('Natural follow-up uses latest generated image');

  await page.getByRole('button', { name: '编辑图片 original.png' }).click();
  await page.locator('.composer-image-reference').waitFor();
  const third = await send('修改原图的背景。');
  assert.deepEqual(third.tool_choice, { type: 'image_generation' });
  assert.equal(third.tools.find(tool => tool.type === 'image_generation').action, 'edit');
  assert.deepEqual(store.getMessages(primary.id).filter(message => message.role === 'user').at(-1).imageReferenceIds, [original.id]);
  checks.push('Explicit original-image edit sends owner-scoped reference and action edit');

  await page.locator('input[type="file"]').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: '添加文件与工具', exact: true }).click();
  const imageOption = page.getByRole('menuitem', { name: /生成 \/ 编辑图片/ });
  assert.equal(await imageOption.isEnabled(), true);
  await imageOption.click();
  const fourth = await send('调整这张新上传图片的比例。');
  assert.equal(imageInputs(fourth).length, 1);
  assert.equal(fourth.tools.find(tool => tool.type === 'image_generation').action, 'edit');
  checks.push('Image tool remains selectable with an upload; new upload supersedes old image');

  // Exercise the real protected API as the logged-in user, including deduplication.
  const ordinary = store.createThread(null, user.id, '图片独立对话');
  const http = async (threadId, body, upload) => page.evaluate(async ({ threadId, body, upload }) => {
    const session = await (await fetch('/api/session')).json();
    const work = await (await fetch(`/api/threads/${threadId}/work`)).json();
    const sentWork = window.__imageQaSentWork ??= {};
    body.work = sentWork[body.requestId] ??= { intent: 'question', focusRevision: work.focus?.revision ?? 0 };
    let payload = JSON.stringify(body), headers = { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken };
    if (upload) {
      payload = new FormData();
      for (const [key, value] of Object.entries(body)) payload.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      payload.append('files', new Blob([Uint8Array.from(atob(upload), char => char.charCodeAt(0))], { type: 'image/png' }), 'api.png');
      delete headers['content-type'];
    }
    const response = await fetch(`/api/threads/${threadId}/turns`, { method: 'POST', headers, body: payload });
    return { status: response.status, body: await response.json() };
  }, { threadId, body, upload });
  const before = calls.length;
  const focusBefore = store.work.getFocus(user.id, ordinary.id).revision;
  const denied = await http(ordinary.id, { text: '改这张图片', tool: 'image', imageReferenceIds: [original.id], requestId: randomBytes(16).toString('hex') });
  assert.equal(denied.status, 404); assert.equal(calls.length, before);
  assert.equal(store.work.getFocus(user.id, ordinary.id).revision, focusBefore, 'Rejected reference leaves the question focus unchanged');
  const requestId = randomBytes(16).toString('hex');
  const accepted = await http(ordinary.id, { text: '修改图片', requestId }, png.toString('base64'));
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  const deadline = Date.now() + 10000;
  while (store.getRun(accepted.body.run.id).status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(store.getRun(accepted.body.run.id).status, 'completed');
  assert.ok(calls.at(-1).tools.some(tool => tool.type === 'image_generation'));
  const replay = await http(ordinary.id, { text: '修改图片', requestId }, png.toString('base64'));
  assert.equal(replay.status, 202, JSON.stringify(replay.body)); assert.equal(replay.body.run.id, accepted.body.run.id);
  const conflict = await http(ordinary.id, { text: '修改图片', requestId, imageReferenceIds: [original.id] }, png.toString('base64'));
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'work_request_conflict');
  assert.equal(calls.length, before + 1);
  checks.push('Ordinary multipart defaults to image-capable auto', 'Cross-thread references rejected before inference', 'Retries are idempotent and reference changes conflict');
  await page.screenshot({ path: `${outputDir}/image-edit-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${outputDir}/image-edit-mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, provider: 'simulated', requests: calls.length, errors }, null, 2));
} finally {
  await browser.close(); await app.locals.supervisor.close(); await runtime.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
}
