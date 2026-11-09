import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.mjs';
import { createLocalBridge } from '../server/local.mjs';
import { createLocalFiles, relativePath, codexArgs } from '../public/local-assistant/kivo-local.mjs';
import { createRuntime } from '../server/runtime.mjs';

function fixture(t) {
  const store = createStore(':memory:', { credentialsKey: randomBytes(32) }), bridge = createLocalBridge({ store });
  const alice = store.createUser({ username: 'local_alice', displayName: 'A', passwordHash: 'unused' });
  const bob = store.createUser({ username: 'local_bob', displayName: 'B', passwordHash: 'unused', role: 'admin' });
  t.after(() => { bridge.close(); store.close(); });
  function pair(user = alice) {
    const pending = bridge.beginPair({ name: 'Test computer', platform: 'linux', rootName: 'Projects' });
    assert.equal(bridge.claimPair(pending.token).pending, true);
    const device = bridge.approvePair(user, pending.code);
    const claim = bridge.claimPair(pending.token);
    const auth = bridge.authenticate({ get: name => name === 'authorization' ? 'Bearer ' + claim.token : undefined });
    assert.throws(() => bridge.claimPair(pending.token), /领取/);
    return { pending, device, claim, auth };
  }
  return { store, bridge, alice, bob, pair };
}

test('device pairing, token hashing, owner isolation, job scoping and revocation', async t => {
  const { store, bridge, alice, bob, pair } = fixture(t), a = pair(), b = pair(bob);
  assert.equal(bridge.list(alice.id).length, 1);
  assert.ok(!JSON.stringify(bridge.list(alice.id)).includes(a.claim.token));
  assert.notEqual(store.db.prepare('SELECT token_hash FROM local_devices WHERE id=?').get(a.device.id).token_hash, a.claim.token);
  assert.throws(() => bridge.owned(bob.id, a.device.id), /不存在/);
  assert.throws(() => bridge.authenticate({ get: key => ({ authorization: 'Bearer ' + a.claim.token, origin: 'https://evil.example' })[key] }), /浏览器/);
  const polling = bridge.poll(a.auth);
  const request = bridge.call(alice.id, a.device.id, 'browse', { path: '' });
  const { job } = await polling;
  assert.equal(job.method, 'browse');
  assert.throws(() => bridge.result(b.auth, { id: job.id, result: { folders: ['stolen'] } }), /无权/);
  bridge.result(a.auth, { id: job.id, result: { folders: ['mine'] } });
  assert.deepEqual(await request, { folders: ['mine'] });
  assert.throws(() => bridge.call(bob.id, a.device.id, 'browse', {}), /不存在/);
  bridge.setHandlers({ onEvent() {}, onRevoke: async () => {} });
  await bridge.revoke(alice.id, a.device.id);
  assert.throws(() => bridge.authenticate({ get: name => name === 'authorization' ? 'Bearer ' + a.claim.token : undefined }), /失效/);
});

test('creating a child project under a connected parent does not reopen the parent', async t => {
  const { bridge, alice, pair } = fixture(t), a = pair();
  const polling = bridge.poll(a.auth), opening = bridge.addProject(alice.id, a.device.id, 'parent', 'parent');
  const { job } = await polling;
  bridge.result(a.auth, { id: job.id, result: { path: 'parent', name: 'parent' } });
  const parent = await opening;
  const childPoll = bridge.poll(a.auth), creating = bridge.addProject(alice.id, a.device.id, 'parent', 'child', true);
  const { job: childJob } = await childPoll;
  assert.deepEqual(childJob.params, { path: 'parent', name: 'child', create: true });
  bridge.result(a.auth, { id: childJob.id, result: { path: 'parent/child', name: 'child' } });
  const child = await creating;
  assert.notEqual(child.id, parent.id);
  assert.equal(child.localPath, 'parent/child');
  assert.equal((await bridge.addProject(alice.id, a.device.id, 'parent', 'child', true)).id, child.id);
});

test('local files: create/open, write/read, independent checkpoints, deletion and directory containment', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kivo-local-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root'); await mkdir(root);
  const files = createLocalFiles(root, path.join(dir, 'state'));
  assert.deepEqual(await files.operate('project.open', { path: '', name: 'demo', create: true }), { path: 'demo', name: 'demo' });
  await mkdir(path.join(root, 'demo', '.git')); await writeFile(path.join(root, 'demo', '.git', 'sentinel'), 'unchanged');
  await writeFile(path.join(root, 'demo', '.env'), 'private secret');
  await symlink(dir, path.join(root, 'escape'));
  for (const value of ['../outside', '/etc/passwd', 'x/../../y', '.env', 'x/.git/config', 'C:\\Windows', 'a\0b']) assert.throws(() => relativePath(value));
  await assert.rejects(files.operate('read', { projectPath: 'escape', path: 'outside.txt' }), /符号链接/);
  await files.operate('write', { projectPath: 'demo', path: 'src/hello.txt', content: 'first\n' });
  assert.equal((await files.operate('read', { projectPath: 'demo', path: 'src/hello.txt' })).content, 'first\n');
  let diff = await files.operate('diff', { projectPath: 'demo' }); assert.match(diff.diff, /\+first/);
  assert.ok(!JSON.stringify(await files.tree('demo')).includes('.env'));
  await files.operate('commit', { projectPath: 'demo' });
  assert.deepEqual((await files.operate('diff', { projectPath: 'demo' })).files, []);
  await files.operate('write', { projectPath: 'demo', path: 'src/hello.txt', content: 'second\n' });
  diff = await files.operate('diff', { projectPath: 'demo' }); assert.match(diff.diff, /-first/); assert.match(diff.diff, /\+second/);
  await files.operate('delete', { projectPath: 'demo', path: 'src/hello.txt' });
  assert.equal((await files.operate('diff', { projectPath: 'demo' })).files[0].status, 'D');
  await assert.rejects(files.operate('write', { projectPath: 'demo', path: '.env', content: 'no' }));
  assert.equal(await readFile(path.join(root, 'demo', '.git', 'sentinel'), 'utf8'), 'unchanged');
  assert.equal(await readFile(path.join(root, 'demo', '.env'), 'utf8'), 'private secret');
});

test('Codex local arguments keep workspace sandbox and per-operation approvals, not full access', () => {
  const args = codexArgs({ model: 'model', origin: 'https://kivo.iptnet.xyz' }).join(' ');
  assert.match(args, /workspace-write/); assert.match(args, /on-request/); assert.match(args, /network_access=false/);
  assert.ok(!args.includes('danger-full-access')); assert.ok(!args.includes('OPENAI_API_KEY'));
  assert.match(args, /local-agent/);
});

test('local runtime routes tasks to owner device, streams once, preserves approval and thread identity without Docker', async t => {
  const { store, bridge, alice, pair } = fixture(t), a = pair();
  store.setUserApiKey(alice.id, 'sk-local-test-not-a-real-key-000000000');
  const polling = bridge.poll(a.auth), creating = bridge.addProject(alice.id, a.device.id, 'demo', 'demo');
  const { job: open } = await polling; bridge.result(a.auth, { id: open.id, result: { path: 'demo', name: 'demo' } });
  const project = await creating, thread = store.createThread(project.id, alice.id, 'Local test'), run = store.createRun(thread.id, alice.id);
  const runtime = createRuntime({ store, config: { model: 'test-model', runTimeoutMs: 10000 }, local: bridge, spawnImpl() { throw new Error('Docker must not run'); } });
  const modelToken = randomBytes(32).toString('base64url');
  const pollingStart = bridge.poll(a.auth), start = runtime.start({ user: alice, project, thread, run, text: 'Change local file' });
  const { job } = await pollingStart;
  assert.equal(job.method, 'run.start'); assert.equal(job.params.projectPath, 'demo'); assert.ok(!JSON.stringify(job).includes('sk-local-test'));
  bridge.result(a.auth, { id: job.id, result: { started: true } }); await start;
  bridge.events(a.auth, { events: [{ runId: run.id, sequence: 1, type: 'thread', threadId: 'local-thread-1' }, { runId: run.id, sequence: 2, type: 'delta', text: 'Hello', itemId: 'a' }, { runId: run.id, sequence: 2, type: 'delta', text: 'DUPLICATE', itemId: 'a' }] });
  assert.equal(store.getRun(run.id).output, 'Hello'); assert.equal(store.getThread(thread.id).codexThreadId, 'local-thread-1');
  const approvalId = 'a'.repeat(24);
  bridge.events(a.auth, { events: [{ runId: run.id, sequence: 3, type: 'approval', approval: { id: approvalId, kind: 'command', command: 'npm install' } }] });
  assert.equal(runtime.approvals(run.id).length, 1);
  const pollingApproval = bridge.poll(a.auth), approval = runtime.approve(run.id, approvalId, 'decline');
  const { job: approvalJob } = await pollingApproval; assert.equal(approvalJob.params.decision, 'decline');
  bridge.result(a.auth, { id: approvalJob.id, result: { ok: true } }); await approval;
  assert.equal(runtime.approvals(run.id).length, 0);
  const pollingStop = bridge.poll(a.auth), ending = runtime.interrupt(run.id);
  const { job: stop } = await pollingStop; assert.equal(stop.method, 'run.stop'); bridge.result(a.auth, { id: stop.id, result: { stopped: true } }); await ending;
  assert.equal(store.getRun(run.id).status, 'interrupted');
  assert.equal(store.getMessages(thread.id).filter(m => m.role === 'assistant').length, 1);
  await runtime.close();
});
