import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { streamChat } from '../server/chat.mjs';
import { startAssistant } from '../public/local-assistant/kivo-local.mjs';

test('hosted activity reflects each tool call and requires the actual image result', async t => {
  const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZpQAAAAASUVORK5CYII=', 'base64');
  const failed = { id: 'ci_fail', type: 'code_interpreter_call', status: 'failed', code: 'private script' };
  const image = { id: 'ig_ok', type: 'image_generation_call', status: 'completed', result: picture.toString('base64') };
  const events = [
    { type: 'response.web_search_call.in_progress', item_id: 'ws_ok', output_index: 0 },
    { type: 'response.web_search_call.completed', item_id: 'ws_ok', output_index: 0 },
    { type: 'response.output_item.done', output_index: 1, item: failed },
    { type: 'response.image_generation_call.completed', item_id: 'ig_missing', output_index: 2 },
    { type: 'response.output_item.done', output_index: 3, item: image },
    { type: 'response.completed', response: { output: [
      { id: 'ws_ok', type: 'web_search_call', status: 'completed' },
      failed,
      { id: 'ig_missing', type: 'image_generation_call', status: 'completed' },
      image,
    ] } },
  ];
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const activity = [], images = [], legacy = [];
  await streamChat({ port: server.address().port, token: 'fake', payload: {}, onText() {},
    onImage: (artifact, itemId) => images.push({ artifact, itemId }),
    onTool: text => legacy.push(text), onActivity: event => activity.push(event) });
  assert.deepEqual(activity.map(({ tool, status }) => [tool, status]), [
    ['search', 'started'], ['search', 'succeeded'], ['analyze', 'failed'],
    ['image', 'started'], ['image', 'started'], ['image', 'succeeded'], ['image', 'unknown'],
  ]);
  assert.equal(activity[0].itemId, activity[1].itemId);
  assert.equal(activity[3].itemId, activity.at(-1).itemId);
  assert.equal(images.length, 1);
  assert.equal(images[0].itemId, activity.find(event => event.tool === 'image' && event.status === 'succeeded').itemId);
  assert.deepEqual(images[0].artifact.data, picture);
  assert.equal(legacy.length, 1);
  assert.ok(!JSON.stringify(activity).includes('private script'));
});

test('local assistant reports observed exit codes and safe relative paths', { timeout: 5000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kivo-local-activity-'));
  const runId = randomUUID(), token = randomBytes(32).toString('base64url');
  const events = [];
  let releasePoll, finish, sent = false;
  const finished = new Promise(resolve => { finish = resolve; });
  const assistant = await startAssistant({ root: dir, stateDir: path.join(dir, 'state'),
    deviceId: 'fixture', token: 'device-fixture',
    async requestImpl(_method, endpoint, body) {
      if (endpoint === 'poll') {
        if (!sent) {
          sent = true;
          return { epoch: 'test', job: { id: 'job', method: 'run.start', params: { runId, token, projectPath: '', text: 'Fixture', model: 'fake' } } };
        }
        return new Promise(resolve => { releasePoll = resolve; });
      }
      if (endpoint === 'events') {
        events.push(...body.events);
        if (body.events.some(event => event.type === 'done')) finish();
      }
      return { ok: true };
    },
    spawnImpl(_executable, _args, { cwd }) {
      const child = new EventEmitter();
      child.exitCode = 0;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const send = message => child.stdout.write(JSON.stringify(message) + '\n');
      const notify = (method, item) => send({ method, params: { item } });
      child.stdin = new Writable({ write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk);
        if (request.id != null) queueMicrotask(() => {
          send({ id: request.id, result: request.method === 'thread/start' ? { thread: { id: 'thread' } } : {} });
          if (request.method !== 'turn/start') return;
          notify('item/started', { id: 'cmd', type: 'commandExecution', command: 'echo mock-only' });
          notify('item/completed', { id: 'cmd', type: 'commandExecution', status: 'failed', exitCode: 7, aggregatedOutput: 'private output' });
          notify('item/completed', { id: 'unknown', type: 'commandExecution', status: 'completed', exitCode: null });
          notify('item/completed', { id: 'patch', type: 'fileChange', status: 'completed', changes: [
            { path: path.join(cwd, 'src', 'index.js') }, { path: '../outside' }, { path: '/unrelated/private' },
            { path: '.env' }, { path: 'src/' + token },
          ] });
          send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
        });
        callback();
      } });
      return child;
    },
  });
  t.after(async () => { await assistant.stop(); releasePoll?.({}); await assistant.loop; await rm(dir, { recursive: true, force: true }); });
  await finished;
  const activity = events.filter(event => event.type === 'activity').map(event => event.activity);
  assert.deepEqual(activity.map(({ itemId, status, exitCode }) => [itemId, status, exitCode]), [
    ['cmd', 'started', undefined], ['cmd', 'failed', 7], ['unknown', 'unknown', undefined], ['patch', 'succeeded', undefined],
  ]);
  assert.deepEqual(activity.at(-1).paths, ['src/index.js']);
  assert.doesNotMatch(JSON.stringify(activity), /mock-only|private output/);
  assert.ok(events.some(event => event.type === 'log' && event.text.includes('mock-only')));
});
