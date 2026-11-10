import test from 'node:test';
import assert from 'node:assert/strict';
import { captureExecutionEnvironment, engineCapabilities, chooseLifecycle, assertEnvironmentCompatible } from '../server/engine-adapter.mjs';

const project = { id: 'project-a', userId: 'owner-a', location: 'cloud', name: 'Same project name' };
const snapshot = { workspace: 'cloud:/srv/projects/project-a:dev=1:ino=12', branch: 'refs/heads/main', baseRevision: 'a'.repeat(40), dirtyFingerprint: 'b'.repeat(64), dirtyPaths: ['notes.md'] };
const capture = (value = snapshot, target = project) => captureExecutionEnvironment({ project: target, projects: { executionEnvironment: async () => ({ ...value }) } });

test('engine adapters disclose only exercised engine capabilities', () => {
  assert.equal(engineCapabilities('chat').engine, 'responses');
  assert.equal(engineCapabilities('chat').continue, false);
  assert.equal(engineCapabilities('cloud').version, '0.167.0');
  assert.equal(engineCapabilities('cloud').interruptMethod, 'stop-container');
  assert.equal(engineCapabilities('local').interruptMethod, 'stop-process-group');
  for (const mode of ['chat', 'cloud', 'local']) {
    assert.equal(engineCapabilities(mode).nativeFork, false);
    assert.equal(engineCapabilities(mode).automaticCompaction, false);
    assert.equal(engineCapabilities(mode).nativeStateRead, false);
    assert.equal(engineCapabilities(mode).nativePause, false);
  }
  assert.throws(() => engineCapabilities('unknown'), { code: 'execution_mode_invalid' });
});

test('cloud identity is independent of project display name and existing changes are preserved', async () => {
  const before = await capture();
  const renamed = await capture(snapshot, { ...project, name: 'Renamed project' });
  assert.equal(before.identityFingerprint, renamed.identityFingerprint);
  assert.deepEqual(before.dirtyPaths, ['notes.md']);
  assert.equal(before.reusable, true);
  assert.deepEqual(assertEnvironmentCompatible(before, renamed), { compatible: true, verified: true, requiresLocalValidation: false });
  const lifecycle = chooseLifecycle({ task: { id: 'task-a', version: 1 }, previousSession: { taskId: 'task-a', taskVersion: 1, engineThreadId: 'native-thread-a', environment: before, status: 'ready' }, environment: renamed });
  assert.equal(lifecycle.action, 'continue');
  assert.equal(lifecycle.engineThreadId, 'native-thread-a');
  assert.equal(lifecycle.reusesThread, true);
});

test('clone, branch, baseline, dirty content and project changes invalidate reuse and block a stale write', async () => {
  const before = await capture();
  const cases = [
    { ...snapshot, workspace: 'cloud:/srv/other/project-a:dev=1:ino=13' },
    { ...snapshot, branch: 'refs/heads/other' },
    { ...snapshot, baseRevision: 'c'.repeat(40) },
    { ...snapshot, dirtyFingerprint: 'd'.repeat(64) },
  ];
  for (const changed of cases) {
    const after = await capture(changed);
    // Forged cached digests cannot override actual environment field comparisons.
    after.identityFingerprint = before.identityFingerprint;
    after.stateFingerprint = before.stateFingerprint;
    assert.throws(() => assertEnvironmentCompatible(before, after), { code: 'execution_environment_changed' });
    const lifecycle = chooseLifecycle({ task: { id: 'task-a', version: 1 }, previousSession: { taskId: 'task-a', taskVersion: 1, engineThreadId: 'native-thread-a', environment: before }, environment: after });
    assert.equal(lifecycle.action, 'rebuild');
    assert.equal(lifecycle.engineThreadId, null);
  }
  const otherProject = await capture(snapshot, { ...project, id: 'project-b' });
  assert.throws(() => assertEnvironmentCompatible(before, otherProject), { code: 'execution_environment_changed' });
});

test('cloud probe errors and incomplete snapshots fail closed', async () => {
  await assert.rejects(captureExecutionEnvironment({ project, projects: {} }), { code: 'execution_environment_unverified' });
  await assert.rejects(capture({ ...snapshot, dirtyFingerprint: undefined }), { code: 'execution_environment_unverified' });
  await assert.rejects(capture({ ...snapshot, workspace: '' }), { code: 'execution_environment_unverified' });
  await assert.rejects(captureExecutionEnvironment({ project, projects: { executionEnvironment: async () => { throw new Error('Probe unavailable'); } } }), /Probe unavailable/);
  assert.throws(() => assertEnvironmentCompatible(null, {}), { code: 'execution_environment_unverified' });
});

test('fresh, forked and unavailable sessions do not inherit another task history', async () => {
  const environment = await capture();
  const previousSession = { taskId: 'task-a', taskVersion: 1, engineThreadId: 'native-thread-a', environment };
  const task = { id: 'task-a', version: 1 };
  assert.equal(chooseLifecycle({ task, previousSession, environment, intent: 'new' }).action, 'new');
  const fork = chooseLifecycle({ task, previousSession, environment, intent: 'fork' });
  assert.equal(fork.action, 'fork');
  assert.equal(fork.engineThreadId, null);
  assert.equal(fork.reusesThread, false);
  assert.equal(chooseLifecycle({ task: { id: 'task-b' }, previousSession, environment }).action, 'rebuild');
  assert.equal(chooseLifecycle({ task, previousSession: { ...previousSession, status: 'unavailable' }, environment }).action, 'rebuild');
  assert.equal(chooseLifecycle({ task, environment }).action, 'rebuild');
  assert.equal(chooseLifecycle({ task, previousSession: { ...previousSession, status: 'running' }, environment }).action, 'blocked');
  const revision = chooseLifecycle({ task, previousSession, environment, intent: 'revise' });
  assert.equal(revision.action, 'revise');
  assert.equal(revision.reusesThread, false);
  assert.equal(revision.engineThreadId, null);
  assert.equal(chooseLifecycle({ task: { ...task, version: 2 }, previousSession, environment }).action, 'rebuild');
  assert.equal(chooseLifecycle({ task, previousSession: { ...previousSession, taskVersion: undefined }, environment }).action, 'rebuild');
});

test('local device binding is reauthorized and never mistaken for a verified checkout', async () => {
  const target = { ...project, location: 'local', deviceId: 'device-a', localPath: 'research' };
  const checked = [];
  const local = { owned(userId, deviceId) { checked.push({ userId, deviceId }); return { id: deviceId }; } };
  const environment = await captureExecutionEnvironment({ project: target, local });
  assert.deepEqual(checked, [{ userId: 'owner-a', deviceId: 'device-a' }]);
  assert.equal(environment.verified, false);
  assert.equal(environment.reusable, false);
  assert.equal(environment.requiresLocalValidation, true);
  assert.equal(environment.branch, null);
  const lifecycle = chooseLifecycle({ task: { id: 'task-a', version: 1 }, previousSession: { taskId: 'task-a', taskVersion: 1, engineThreadId: 'native-local-thread', environment }, environment });
  assert.equal(lifecycle.action, 'rebuild');
  assert.equal(lifecycle.reusesThread, false);
  assert.deepEqual(assertEnvironmentCompatible(environment, environment), { compatible: true, verified: false, requiresLocalValidation: true });
  const moved = await captureExecutionEnvironment({ project: { ...target, localPath: 'research-clone' }, local });
  assert.throws(() => assertEnvironmentCompatible(environment, moved), { code: 'execution_environment_changed' });
  await assert.rejects(captureExecutionEnvironment({ project: target, local: { owned() { throw Object.assign(new Error('Revoked'), { status: 404 }); } } }), { status: 404 });
  await assert.rejects(captureExecutionEnvironment({ project: { ...target, localPath: '../other' }, local }), { code: 'execution_environment_invalid' });
});

test('generic non-project work requires no repository and no fake provider session', async () => {
  const environment = await captureExecutionEnvironment();
  assert.equal(environment.engine, 'responses');
  assert.equal(environment.projectId, null);
  assert.equal(environment.workspace, null);
  for (const title of ['比较研究资料', '修改设计图', '修订报告']) {
    const lifecycle = chooseLifecycle({ task: { id: title, version: 1 }, previousSession: { taskId: title, taskVersion: 1, engineThreadId: 'should-not-reuse', environment }, environment });
    assert.equal(lifecycle.action, 'rebuild');
    assert.equal(lifecycle.engineThreadId, null);
  }
});
