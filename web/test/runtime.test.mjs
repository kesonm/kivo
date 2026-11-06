import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRunnerArgs, measureWorkspace, createRuntime } from '../server/runtime.mjs';

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
  const runtime = createRuntime({ store: { getUser: () => ({ id: 'u', disabled: false }), getUserApiKey: () => null, getApiKeyMetadata: () => ({ configured: false }) }, config: { apiKey: 'GLOBAL_MUST_NOT_USE' }, spawnImpl: () => { launched = true; throw new Error('should not launch'); } });
  assert.equal(runtime.providerConfigured('u'), false);
  assert.equal(runtime.providerConfigured(), false);
  await assert.rejects(runtime.start({ user: { id: 'u' } }), /个人设置/);
  assert.equal(launched, false);
  await runtime.close();
});

test('pending asynchronous startup occupies the global slot and releases on failure', async () => {
  const runtime = createRuntime({
    store: { getUser: () => ({ id: 'user', disabled: false }), getUserApiKey: () => 'not-a-real-personal-key' },
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
