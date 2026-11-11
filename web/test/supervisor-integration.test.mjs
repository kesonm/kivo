import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createGateway } from '../server/gateway.mjs';

const frame = event => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'expected asynchronous state');
}

async function fixture(t) {
  const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
  const config = { publicOrigin: 'https://supervisor.test', cookieSecure: false, distDir: null,
    model: 'gpt-6.1-sol', workRoutingMode: 'enforce', workContextBytes: 393216,
    gatewayHost: '127.0.0.1', gatewayPort: 0, maxConcurrentRuns: 1, maxOutputTokens: 1000, runTimeoutMs: 10000 };
  const calls = [];
  const forbidden = () => { throw new Error('Text task must not access a project'); };
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
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await app.locals.supervisor.close(); await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function client(username) {
    let cookie = '', csrf = '';
    const request = async (method, endpoint, body) => {
      const response = await fetch(base + endpoint, { method, headers: { cookie, origin: config.publicOrigin, 'content-type': 'application/json', 'x-csrf-token': csrf },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      const data = await response.json(); if (data.csrfToken) csrf = data.csrfToken;
      return { status: response.status, data };
    };
    await request('GET', '/api/session');
    const registered = await request('POST', '/api/auth/register', { username, displayName: username, password: 'Supervisor-fixture-password-2026' });
    assert.equal(registered.status, 201);
    await request('PUT', '/api/account/api-key', { apiKey: 'sk-project-fixture-aaaaaaaaaaaaaaaaaaaaaaaaAAAA' });
    const opened = await request('POST', '/api/kibot', {});
    return { request, user: registered.data.user, thread: opened.data.thread };
  }
  function complete(index, content) {
    const output = typeof content === 'string' ? [{ type: 'message', id: `answer-${index}`, role: 'assistant', content: [{ type: 'output_text', text: content }] }] : content;
    calls[index].controller.enqueue(frame({ type: 'response.completed', response: { id: `response-${index}`, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }));
    calls[index].controller.close();
  }
  return { store, config, runtime, app, calls, client, complete };
}

test('real HTTP/controller/queue flow delegates an isolated task, stays conversational and returns completion once', async t => {
  const { store, app, calls, client, complete } = await fixture(t);
  const alice = await client('supervisor-alice'), bob = await client('supervisor-bob');
  const send = (client, text, extra = {}) => client.request('POST', `/api/threads/${client.thread.id}/turns`, {
    text, tool: 'auto', work: { intent: 'question', focusRevision: store.work.getFocus(client.user.id,client.thread.id).revision }, requestId: randomUUID(), ...extra,
  });
  const first = await send(alice, '请建立一个独立任务，整理首页优化建议。');
  assert.equal(first.status, 202, JSON.stringify(first.data));
  await until(() => calls.length === 1);
  assert.ok(calls[0].payload.tools.some(tool => tool.name === 'kivo_delegate_task'));
  complete(0, [{ type: 'function_call', id: 'item-delegate', call_id: 'delegate-once', name: 'kivo_delegate_task', arguments: JSON.stringify({ goal: '整理首页优化建议', projectId: null, constraints: ['仅分析'], acceptance: ['给出建议'] }) }]);
  await until(() => calls.length === 2);
  const toolResult = JSON.parse(calls[1].payload.input.find(item => item.type === 'function_call_output').output);
  assert.ok(toolResult.task?.id, JSON.stringify(toolResult));
  complete(1, '已建立任务，将在独立任务中整理建议。');
  await until(() => store.getRun(first.data.run.id).status === 'completed');
  const queued = (await alice.request('GET', '/api/kibot/tasks')).data;
  assert.equal(queued.tasks.length, 1);
  assert.equal(queued.tasks[0].queueStatus, 'queued');
  const task = queued.tasks[0];
  assert.notEqual(task.conversationId, alice.thread.id);
  assert.equal((await bob.request('GET', `/api/kibot/tasks/${task.id}`)).status, 404);
  assert.equal((await send(bob, '继续', { taskReferenceId: task.id })).status, 404);
  const manual = await alice.request('POST', `/api/threads/${task.conversationId}/turns`, { text: '不要重复执行', requestId: randomUUID() });
  assert.equal(manual.status, 409);
  await app.locals.supervisor.pump();
  await until(() => calls.length === 3);
  assert.equal((await alice.request('GET', '/api/kibot/tasks')).data.counts.running, 1);
  const second = await send(alice, '先聊一下配色，任务继续。', { taskReferenceId: task.id });
  assert.equal(second.status, 202, JSON.stringify(second.data));
  await until(() => calls.length === 4);
  assert.ok(calls[3].payload.input[0].content.includes(task.id));
  complete(3, '可以，任务继续运行，我们来讨论配色。');
  await until(() => store.getRun(second.data.run.id).status === 'completed');
  complete(2, '建议：收紧侧栏、统一间距，并保留纯白背景。');
  const jobRunId = app.locals.supervisor.snapshot(alice.user.id).tasks[0].latestRunId;
  await until(() => store.getRun(jobRunId).status === 'completed');
  await app.locals.supervisor.pump();
  await app.locals.supervisor.pump();
  const done = (await alice.request('GET', '/api/kibot/tasks')).data.tasks[0];
  assert.equal(done.queueStatus, 'completed');
  assert.equal(done.status, 'waiting_input');
  const notifications = store.getMessages(alice.thread.id).filter(message => message.supervisorTaskId === task.id);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].content, /收紧侧栏/);
  assert.equal(store.getMessages(task.conversationId).filter(message => message.role === 'assistant').length, 1);
});
