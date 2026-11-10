import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { buildRunnerArgs, measureWorkspace, createRuntime } from '../server/runtime.mjs';
import { createStore } from '../server/store.mjs';

test('runner arguments enforce isolated, bounded, unprivileged execution', () => {
  const args = buildRunnerArgs({ config: { hostDataDir: '/srv/data', model: 'test-model' }, projectId: 'project-1', containerName: 'run-1' });
  const value = name => args[args.indexOf(name) + 1];
  assert.equal(value('--user'), '1000:1000');
  assert.equal(value('--cap-drop'), 'ALL');
  assert.equal(value('--security-opt'), 'no-new-privileges:true');
  assert.equal(value('--network'), 'codex-workspace-runners');
  assert.equal(value('--memory'), '768m');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('fsize=16777216:16777216'));
  assert.ok(args.includes('type=bind,source=/srv/data/projects/project-1,target=/workspace'));
  assert.ok(!args.some(a => a.includes('docker.sock')));
  assert.ok(!args.some(a => a.startsWith('CODEX_GATEWAY_TOKEN=')));
  assert.throws(() => buildRunnerArgs({ config: { hostDataDir: '/srv/data' }, projectId: '../escape', containerName: 'run' }));
});

test('workspace accounting does not follow symlinks and bounds bytes and entry count', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'runtime-measure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'a'), 'ok');
  await symlink('/etc', path.join(dir, 'outside'));
  const result = await measureWorkspace([dir]);
  assert.equal(result.entries, 3);
  await assert.rejects(measureWorkspace([dir], { maxBytes: 1 }), /存储超过/);
  await assert.rejects(measureWorkspace([dir], { maxEntries: 1 }), /数量超过/);
});

test('missing provider key fails before docker startup', async () => {
  let launched = false;
  const runtime = createRuntime({ store: { runContext: { record() {}, engine() {}, replies() {} }, getUser: () => ({ id: 'u', disabled: false }), getUserApiKey: () => null, getApiKeyMetadata: () => ({ configured: false }) }, config: { apiKey: 'GLOBAL_MUST_NOT_USE' }, spawnImpl: () => { launched = true; throw new Error('should not launch'); } });
  assert.equal(runtime.providerConfigured('u'), false);
  assert.equal(runtime.providerConfigured(), false);
  await assert.rejects(runtime.start({ user: { id: 'u' } }), /个人设置/);
  assert.equal(launched, false);
  await runtime.close();
});

test('pending asynchronous startup occupies the global slot and releases on failure', async () => {
  const runtime = createRuntime({
    store: { runContext: { record() {}, engine() {}, replies() {} }, getUser: () => ({ id: 'user', disabled: false }), getUserApiKey: () => 'not-a-real-personal-key' },
    config: { dataDir: `/nonexistent-workspace-${Date.now()}`, maxConcurrentRuns: 1 },
  });
  const input = id => ({ run: { id, userId: 'user', threadId: `thread-${id}`, projectId: `project-${id}` }, thread: { id: `thread-${id}`, userId: 'user', projectId: `project-${id}` }, project: { id: `project-${id}`, userId: 'user' }, user: { id: 'user' }, text: 'hello' });
  const first = runtime.start(input('first'));
  await Promise.all([
    assert.rejects(first, { code: 'ENOENT' }),
    assert.rejects(runtime.start(input('second')), error => error.status === 429),
  ]);
  await assert.rejects(runtime.start(input('third')), { code: 'ENOENT' });
  await runtime.close();
});

test('cloud verification uses its own exit code and runs once before the container is removed', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'kivo-verification-'));
  const store = createStore(':memory:', { credentialsKey: randomBytes(32) });
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }); });
  const user = store.createUser({ username: 'runner', displayName: 'Runner', passwordHash: 'test' });
  store.setUserApiKey(user.id, 'sk-test-only-verification-0123456789');
  const project = store.createProject(user.id, 'Verification');
  const thread = store.createThread(project.id, user.id, 'Test');
  const run = store.createRun(thread.id, user.id, { mode: 'cloud', verificationCommand: 'npm test' });
  await mkdir(path.join(dataDir, 'projects', project.id), { recursive: true });
  const calls = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const publish = payload => child.stdout.write(JSON.stringify(payload) + '\n');
  child.stdin = new Writable({ write(chunk, encoding, done) {
    const message = JSON.parse(chunk);
    const result = { 'thread/start': { thread: { id: 'thread-1' } }, 'turn/start': { turn: { id: 'turn-1' } } }[message.method] ?? {};
    if (message.id != null) queueMicrotask(() => publish({ id: message.id, result }));
    done();
  } });
  const runtime = createRuntime({
    store,
    config: { dataDir, hostDataDir: dataDir, gatewayContainer: 'test-gateway', runnerUid: process.getuid(), runnerGid: process.getgid() },
    gatewayFactory: () => ({ start: async () => ({}), authorizeRun: () => 'test-task-token', revokeRun: async () => {}, close: async () => {} }),
    spawnImpl: () => child,
    execFileImpl: async (bin, args) => {
      calls.push(args);
      return { stdout: args[0] === 'exec' ? '1\n' : '' };
    },
  });
  await runtime.start({ run, thread, project, user, text: 'Fix the bug' });
  const done = new Promise(resolve => runtime.subscribe(run.id, message => { if (message.event === 'done') resolve(message.data); }));
  publish({ method: 'item/completed', params: { item: { type: 'fileChange', id: 'file-1', status: 'completed', changes: [{ path: '/workspace/src.js' }] } } });
  publish({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'shell-1', status: 'completed', exitCode: 0 } } });
  for (let i = 0; i < 2; i++) publish({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  assert.equal((await done).status, 'completed');
  assert.deepEqual(store.getRun(run.id).verification, { command: 'npm test', status: 'failed', exitCode: 1 });
  const checks = calls.filter(args => args[0] === 'exec');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].at(-1), 'npm test');
  assert.ok(checks[0].includes('CODEX_GATEWAY_TOKEN='));
  assert.ok(calls.indexOf(checks[0]) < calls.findIndex(args => args[0] === 'rm'));
  const events = store.getRunEvents(run.id);
  assert.deepEqual(events.map(event => [event.kind, event.status]), [['file','succeeded'],['command','succeeded'],['verification','started'],['verification','failed'],['task','succeeded']]);
  assert.deepEqual(events[0].paths, ['src.js']);
  await runtime.close();
});
