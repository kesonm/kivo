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

test('ordinary chat, images, web citations and multipart analysis work through HTTP and stay private', { timeout: 25000 }, async t => {
  const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
  const config = { dataDir: '/nonexistent-direct-chat-test', distDir: '/nonexistent', publicOrigin: 'https://chat.example', cookieSecure: false, model: 'test-model', gatewayHost: '127.0.0.1', gatewayPort: 0, maxConcurrentRuns: 2, maxOutputTokens: 512, runTimeoutMs: 10000 };
  const calls = [], uploadedFiles = [], removedFiles = [];
  let projectOperations = 0;
  const forbiddenProjectOperation = () => { projectOperations++; throw new Error('ordinary chat must not invoke project storage'); };
  const projects = Object.fromEntries(['initialize', 'remove', 'withLock', 'tree', 'readFile'].map(key => [key, forbiddenProjectOperation]));
  const runtime = createRuntime({ store, config, spawnImpl: forbiddenProjectOperation, execFileImpl: forbiddenProjectOperation,
    gatewayFactory: options => createGateway({ ...options, fetchImpl: async (url, request) => {
      if (url === 'https://api.openai.com/v1/files') {
        const file = request.body.get('file');
        uploadedFiles.push({ name: file.name, text: await file.text(), authorization: request.headers.authorization });
        return Response.json({ id: 'file-csvfixture' });
      }
      if (url === 'https://api.openai.com/v1/files/file-csvfixture' && request.method === 'DELETE') {
        removedFiles.push(request.headers.authorization);
        return Response.json({ deleted: true });
      }
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
      const multipart = body instanceof FormData;
      const result = await fetch(base + url, { method, headers: { cookie, ...(!multipart ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf, origin: config.publicOrigin }, ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
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

  async function toolTurn(body, output, beforeTerminal = []) {
    const callNumber = calls.length;
    const started = await restored.request('POST', `/api/threads/${a.id}/turns`, body);
    assert.equal(started.status, 202, JSON.stringify(started.data));
    const stream = await restored.request('GET', `/api/runs/${started.data.run.id}/events`, undefined, true);
    const deadline = Date.now() + 5000;
    while (!calls[callNumber]?.controller && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    const call = calls[callNumber]; assert.ok(call?.controller);
    for (const event of beforeTerminal) call.controller.enqueue(frame(event));
    call.controller.enqueue(frame({ type: 'response.completed', response: { output, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } }));
    call.controller.close();
    assert.match(await stream.text(), /"status":"completed"/);
    return { call, ...(await restored.request('GET', `/api/threads/${a.id}`)).data };
  }
  const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZpQAAAAASUVORK5CYII=', 'base64');
  const imageItem = { id: 'img_result', type: 'image_generation_call', status: 'completed', result: picture.toString('base64') };
  const generated = await toolTurn({ text: '画一只小狗', tool: 'image' }, [imageItem], [{ type: 'response.output_item.done', output_index: 0, item: imageItem }]);
  assert.deepEqual(generated.call.payload.tool_choice, { type: 'image_generation' });
  const artifacts = generated.messages.at(-1).artifacts;
  assert.equal(artifacts.length, 1);
  const download = await restored.request('GET', artifacts[0].url, undefined, true);
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), picture);
  assert.equal((await bob.request('GET', artifacts[0].url)).status, 404);

  const modelList = (await restored.request('GET', '/api/session')).data.chatModels.map(option => option.id);
  assert.ok(modelList.includes('gpt-6-astra'));
  const invalidModel = await restored.request('POST', `/api/threads/${a.id}/turns`, { text: 'test', model: 'arbitrary-model' });
  assert.equal(invalidModel.status, 400);
  assert.equal(invalidModel.data.code, 'chat_model_invalid');
  const search = await toolTurn({ text: '联网查资料', tool: 'search', model: 'gpt-6-astra' }, [{ type: 'message', id: 'web-answer', role: 'assistant',
    content: [{ type: 'output_text', text: '这是引用', annotations: [
      { type: 'url_citation', start_index: 0, end_index: 4, url: 'https://example.org/source', title: '资料' },
      { type: 'url_citation', start_index: 0, end_index: 4, url: 'javascript:alert(1)', title: 'Invalid' },
    ] }] }]);
  assert.deepEqual(search.call.payload.tools, [{ type: 'web_search' }]);
  assert.equal(search.call.payload.model, 'gpt-6-astra');
  const usageForSearch = (await restored.request('GET', '/api/account/usage')).data.usage.find(record => record.runId === search.run.id);
  assert.equal(usageForSearch.model, 'gpt-6-astra');
  assert.deepEqual(search.messages.at(-1).citations, [{ url: 'https://example.org/source', title: '资料', startIndex: 0, endIndex: 4 }]);

  const form = new FormData();
  form.set('tool', 'analyze');
  form.set('text', '计算合计');
  form.set('model', 'gpt-6-luna');
  form.append('files', new Blob(['value\n3\n5\n'], { type: 'text/csv' }), 'sales.csv');
  form.append('files', new Blob(['%PDF-1.4 fixture'], { type: 'application/pdf' }), 'notes.pdf');
  const analysis = await toolTurn(form, [{ type: 'message', id: 'file-answer', role: 'assistant', content: [{ type: 'output_text', text: '合计 8' }] }]);
  assert.deepEqual(analysis.call.payload.tool_choice, { type: 'code_interpreter' });
  assert.equal(analysis.call.payload.model, 'gpt-6-luna');
  assert.deepEqual(analysis.call.payload.tools[0].container.file_ids, ['file-csvfixture']);
  assert.equal(analysis.call.payload.input.at(-1).content.at(-1).type, 'input_file');
  assert.deepEqual(analysis.messages.at(-2).attachments.map(file => file.name), ['sales.csv', 'notes.pdf']);
  assert.deepEqual(uploadedFiles, [{ name: 'sales.csv', text: 'value\n3\n5\n', authorization: `Bearer ${keyA}` }]);
  assert.deepEqual(removedFiles, [`Bearer ${keyA}`]);

  const before = calls.length;
  const archive = new FormData();
  const bytes = new Uint8Array([80, 75, 3, 4, 0, 255, 1]);
  archive.set('files', new Blob([bytes], { type: 'application/zip' }), '样例.zip');
  const archived = await restored.request('POST', `/api/threads/${a.id}/turns`, archive);
  assert.equal(archived.status, 202);
  assert.equal(archived.data.run.status, 'completed');
  assert.equal(calls.length, before);
  const record = (await restored.request('GET', `/api/threads/${a.id}`)).data.messages.at(-2);
  const attachment = record.attachments[0];
  assert.equal(attachment.name, '样例.zip');
  assert.equal(attachment.analyzable, false);
  const original = await restored.request('GET', attachment.url, undefined, true);
  assert.equal(original.headers.get('content-type'), 'application/octet-stream');
  assert.match(original.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''%E6%A0%B7%E4%BE%8B.zip/);
  assert.deepEqual(new Uint8Array(await original.arrayBuffer()), bytes);
  assert.equal((await bob.request('GET', attachment.url)).status, 404);
});
