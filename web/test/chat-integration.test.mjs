import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createRuntime } from '../server/runtime.mjs';
import { createGateway } from '../server/gateway.mjs';

const keyA = 'sk-project-integration-chat-aaaaaaaaaaaaaaaaAAAA';
const keyB = 'sk-project-integration-chat-bbbbbbbbbbbbbbbbBBBB';
const frame = event => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);

test('ordinary chat completes through HTTP, runtime and gateway without creating projects, and survives a new login', { timeout: 20000 }, async t => {
  const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
  const config = { dataDir: '/nonexistent-direct-chat-test', distDir: '/nonexistent', publicOrigin: 'https://chat.example', cookieSecure: false, model: 'test-model', gatewayHost: '127.0.0.1', gatewayPort: 0, maxConcurrentRuns: 2, maxOutputTokens: 512, runTimeoutMs: 10000 };
  const calls = [];
  let projectOperations = 0;
  const forbiddenProjectOperation = () => { projectOperations++; throw new Error('ordinary chat must not invoke project storage'); };
  const projects = Object.fromEntries(['initialize', 'remove', 'withLock', 'tree', 'readFile'].map(key => [key, forbiddenProjectOperation]));
  const runtime = createRuntime({ store, config, spawnImpl: forbiddenProjectOperation, execFileImpl: forbiddenProjectOperation,
    gatewayFactory: options => createGateway({ ...options, fetchImpl: async (url, request) => {
      const call = { url, authorization: request.headers.authorization, payload: JSON.parse(request.body), controller: null };
      calls.push(call);
      return new Response(new ReadableStream({ start(controller) { call.controller = controller; request.signal.addEventListener('abort', () => { try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {} }, { once: true }); } }), { headers: { 'content-type': 'text/event-stream' } });
    } }),
  });
  const app = createApp({ store, runtime, config, projects });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function client() {
    let cookie = '', csrf = '';
    const request = async (method, url, body, stream = false) => {
      const result = await fetch(base + url, { method, headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, origin: config.publicOrigin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      if (result.headers.get('set-cookie')) cookie = result.headers.get('set-cookie').split(';')[0];
      if (stream) return result;
      const data = await result.json(); if (data.csrfToken) csrf = data.csrfToken;
      return { status: result.status, data };
    };
    await request('GET', '/api/session'); return { request };
  }
  async function register(username, apiKey) {
    const c = await client();
    const result = await c.request('POST', '/api/auth/register', { username, displayName: username, password: 'Integration-password-2026' });
    assert.equal(result.status, 201);
    assert.equal((await c.request('PUT', '/api/account/api-key', { apiKey })).status, 200);
    return { ...c, user: result.data.user };
  }
  async function turn(c, thread, prompt, answer) {
    const callNumber = calls.length;
    const started = await c.request('POST', `/api/threads/${thread.id}/turns`, { text: prompt });
    assert.equal(started.status, 202, JSON.stringify(started.data));
    assert.equal(started.data.run.projectId, null);
    const stream = await c.request('GET', `/api/runs/${started.data.run.id}/events`, undefined, true);
    assert.equal(stream.status, 200);
    // A gateway response can be scheduled after the HTTP 202; await its explicit arrival.
    const deadline = Date.now() + 5000;
    while (!calls[callNumber]?.controller && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    const call = calls[callNumber]; assert.ok(call?.controller);
    call.controller.enqueue(frame({ type: 'response.output_text.delta', item_id: 'answer', delta: answer }));
    call.controller.enqueue(frame({ type: 'response.completed', response: { status: 'completed', output: [{ id: 'answer', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } }));
    call.controller.close();
    const events = await stream.text();
    assert.match(events, /event: done/); assert.match(events, /"status":"completed"/); assert.ok(events.includes(answer));
    const saved = await c.request('GET', `/api/threads/${thread.id}`);
    assert.equal(saved.data.run.status, 'completed');
    assert.equal(saved.data.messages.at(-1).content, answer);
    assert.equal(saved.data.messages.filter(message => message.content === answer).length, 1);
    return call;
  }
  const alice = await register('chat_alice', keyA), bob = await register('chat_bob', keyB);
  const a = (await alice.request('POST', '/api/threads', {})).data.thread;
  const b = (await bob.request('POST', '/api/threads', {})).data.thread;
  assert.equal(a.projectId, null); assert.equal(b.projectId, null);
  const first = await turn(alice, a, 'Remember ALICE_PRIVATE', 'Alice first answer');
  assert.equal(first.authorization, `Bearer ${keyA}`);
  assert.equal(first.url, 'https://api.openai.com/v1/responses');
  assert.equal(first.payload.store, false); assert.equal(first.payload.tools?.length || 0, 0);
  const second = await turn(alice, a, 'What did I ask?', 'Alice second answer');
  const history = JSON.stringify(second.payload.input);
  assert.ok(history.includes('ALICE_PRIVATE')); assert.ok(history.includes('Alice first answer')); assert.ok(history.includes('What did I ask?'));
  const third = await turn(bob, b, 'BOB_PRIVATE', 'Bob answer');
  assert.equal(third.authorization, `Bearer ${keyB}`); assert.ok(!JSON.stringify(third.payload).includes('ALICE_PRIVATE'));
  assert.equal((await bob.request('GET', `/api/threads/${a.id}`)).status, 404);
  assert.equal((await alice.request('GET', '/api/threads')).data.threads.length, 1);
  assert.equal((await alice.request('GET', '/api/projects')).data.projects.length, 0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM projects').get().n, 0);
  assert.equal(projectOperations, 0);
  const usage = (await alice.request('GET', '/api/account/usage')).data;
  assert.equal(usage.totals.totalTokens, 60); assert.equal(usage.usage.length, 2);
  assert.ok(usage.usage.every(row => row.projectId === null && row.threadId === a.id && row.keyLast4 === 'AAAA'));
  assert.equal((await bob.request('GET', '/api/account/usage')).data.totals.totalTokens, 30);
  const restored = await client();
  assert.equal((await restored.request('POST', '/api/auth/login', { username: 'chat_alice', password: 'Integration-password-2026' })).status, 200);
  const saved = (await restored.request('GET', `/api/threads/${a.id}`)).data;
  assert.equal(saved.messages.length, 4); assert.equal(saved.thread.projectId, null);
});
