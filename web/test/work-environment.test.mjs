import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProjects } from '../server/projects.mjs';
import { captureExecutionEnvironment, assertEnvironmentCompatible } from '../server/engine-adapter.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'kivo-work-environment-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, hostDataDir: dataDir, testGitMode: 'host' };
  const projects = createProjects(config), id = randomUUID();
  await projects.initialize(id, 'Same name');
  const project = { id, userId: 'owner', location: 'cloud' };
  const capture = () => captureExecutionEnvironment({ project, projects, config });
  const git = args => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: projects.projectPath(id), timeout: 10000,
    env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
  return { dataDir, projects, project, id, capture, git };
}

test('workspace probe fingerprints tracked edits even when git status paths do not change', async t => {
  const { projects, id, capture } = await fixture(t);
  const clean = await capture();
  assert.deepEqual(clean.dirtyPaths, []);
  await projects.writeFile(id, 'README.md', '# first edit\n');
  const first = await capture();
  await projects.writeFile(id, 'README.md', '# other edit\n');
  const second = await capture();
  assert.equal(first.workspace, second.workspace);
  assert.equal(first.branch, second.branch);
  assert.equal(first.baseRevision, second.baseRevision);
  assert.deepEqual(first.dirtyPaths, second.dirtyPaths);
  assert.notEqual(first.dirtyFingerprint, second.dirtyFingerprint);
  assert.throws(() => assertEnvironmentCompatible(first, second), { code: 'execution_environment_changed' });
  assert.equal((await projects.readFile(id, 'README.md')).content, '# other edit\n');
});

test('workspace probe includes untracked binary contents without treating a dirty checkout as invalid', async t => {
  const { projects, id, capture } = await fixture(t);
  const filename = path.join(projects.projectPath(id), 'asset.bin');
  await writeFile(filename, Buffer.from([0, 1, 2, 3]));
  const first = await capture();
  await writeFile(filename, Buffer.from([0, 3, 2, 1]));
  const second = await capture();
  assert.ok(first.dirtyPaths.includes('asset.bin'));
  assert.deepEqual(first.dirtyPaths, second.dirtyPaths);
  assert.notEqual(first.dirtyFingerprint, second.dirtyFingerprint);
  assert.equal(second.verified, true);
  assert.equal(second.reusable, true);
});

test('branch changes at the same commit invalidate old execution bindings', async t => {
  const { capture, git } = await fixture(t);
  const before = await capture();
  await git(['checkout', '-b', 'other-plan']);
  const after = await capture();
  assert.equal(before.baseRevision, after.baseRevision);
  assert.notEqual(before.branch, after.branch);
  assert.equal(before.workspace, after.workspace);
  assert.throws(() => assertEnvironmentCompatible(before, after), { code: 'execution_environment_changed' });
});

test('replacing the directory at the same project path changes the physical execution identity', async t => {
  const { dataDir, projects, id, capture } = await fixture(t);
  const before = await capture();
  await rename(projects.projectPath(id), path.join(dataDir, 'old-checkout'));
  await projects.initialize(id, 'Same name');
  const after = await capture();
  assert.notEqual(before.workspace, after.workspace);
  assert.notEqual(before.identityFingerprint, after.identityFingerprint);
  assert.throws(() => assertEnvironmentCompatible(before, after), { code: 'execution_environment_changed' });
});

test('a project root replaced with a symlink cannot be probed as the authorized workspace', async t => {
  const { dataDir, projects, id, capture } = await fixture(t);
  const original = path.join(dataDir, 'old-checkout');
  await rename(projects.projectPath(id), original);
  await symlink(original, projects.projectPath(id));
  await assert.rejects(capture());
});
