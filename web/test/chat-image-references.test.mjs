import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore } from '../server/store.mjs';
import { createWorkStore } from '../server/work-store.mjs';
import { CHAT_UPLOAD_LIMIT } from '../server/chat-files.mjs';
import { resolveChatImageReferences, validateChatImageInputs } from '../server/chat-image-references.mjs';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const image = (name = 'source.png', data = png) => ({ name, kind: 'image', mimeType: 'image/png', data });

function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const user = store.createUser({ username: 'image-owner', displayName: 'owner', passwordHash: 'unused' });
  const other = store.createUser({ username: 'image-other', displayName: 'other', passwordHash: 'unused' });
  const thread = store.createThread(null, user.id), otherThread = store.createThread(null, other.id);
  const resolve = options => resolveChatImageReferences({ store, userId: user.id, threadId: thread.id, tool: 'auto', ...options });
  const upload = (target = thread.id, file = image()) => store.appendMessage(target, 'user', '把手和腿改长一些', { uploads: [file] }).attachments[0].id;
  const generated = (file = image('edited.png')) => store.appendMessage(thread.id, 'assistant', '', { artifacts: [file] }).artifacts[0].id;
  return { store, user, other, thread, otherThread, resolve, upload, generated };
}

test('image references read uploaded image magic and preserve owner/thread boundaries', t => {
  const f = fixture(t), id = f.upload();
  assert.equal(f.store.getChatArtifact(id, f.user.id).mimeType, 'application/octet-stream');
  const result = f.resolve({ imageReferenceIds: [id] });
  assert.deepEqual(result.imageReferenceIds, [id]);
  assert.equal(result.referenceImages[0].mimeType, 'image/png');
  assert.deepEqual(result.referenceImages[0].data, png);
  const ownOtherThread = f.store.createThread(null, f.user.id);
  for (const foreignId of [f.upload(f.otherThread.id), f.upload(ownOtherThread.id), randomUUID()]) {
    assert.throws(() => f.resolve({ imageReferenceIds: [foreignId] }), error => error.status === 404);
  }
  for (const ids of [null, id, ['file-Remote'], ['https://example.invalid/image.png'], [id, id], Array.from({ length: 5 }, () => randomUUID())]) {
    assert.throws(() => f.resolve({ imageReferenceIds: ids }), /图片引用/);
  }
});

test('image continuation uses the latest generated image, supports persisted references, and yields to new uploads', t => {
  const f = fixture(t), original = f.upload();
  assert.deepEqual(f.resolve({ text: '再把腿加长一点' }).imageReferenceIds, [original]);
  const latest = f.generated(image('latest.png', Buffer.concat([png, Buffer.from('latest')])));
  assert.deepEqual(f.resolve({ text: '继续调整手臂' }).imageReferenceIds, [latest]);
  assert.deepEqual(f.resolve({ text: 'edit this image', tool: 'image' }).imageReferenceIds, [latest]);
  assert.deepEqual(f.resolve({ text: '把这张图的手臂加长', files: [image('new.png')] }).imageReferenceIds, []);
  assert.deepEqual(f.resolve({ imageReferenceIds: [original], files: [image('new.png')] }).imageReferenceIds, [original]);

  // Explicitly selecting an older image establishes a new active chain without copying bytes.
  const reference = f.store.appendMessage(f.thread.id, 'user', '修改原始版本');
  f.store.db.prepare('INSERT INTO chat_message_metadata VALUES(?,?)').run(reference.id, JSON.stringify({ imageReferenceIds: [original] }));
  f.store.appendMessage(f.thread.id, 'assistant', '可以，保留原来的风格');
  assert.deepEqual(f.resolve({ text: '再改一下' }).imageReferenceIds, [original]);
});

test('automatic references are bounded and do not load old pictures for unrelated, new-picture, or non-image turns', t => {
  const f = fixture(t), id = f.upload();
  for (const text of ['你好', '再改一下代码', '怎么配置服务器', '新画一只小猫', '重新生成另一张', '画一张新的图片', 'Create a new image']) {
    assert.deepEqual(f.resolve({ text }).imageReferenceIds, [], text);
  }
  assert.deepEqual(f.resolve({ text: '重新生成另一张', tool: 'image' }).imageReferenceIds, []);
  assert.deepEqual(f.resolve({ text: '画一只猫', tool: 'image' }).imageReferenceIds, []);
  for (const tool of ['search', 'analyze']) assert.deepEqual(f.resolve({ text: '修改这张图片', tool }).imageReferenceIds, []);
  assert.deepEqual(f.resolve({ text: '再改一下', allowAutomatic: false }).imageReferenceIds, []);
  assert.deepEqual(f.resolve({ text: '再改一下', now: Date.now() + 61 * 60_000 }).imageReferenceIds, []);
  assert.deepEqual(f.resolve({ imageReferenceIds: [id], now: Date.now() + 61 * 60_000 }).imageReferenceIds, [id]);
  for (let i = 0; i < 12; i++) f.store.appendMessage(f.thread.id, i % 2 ? 'assistant' : 'user', 'unrelated conversation');
  assert.deepEqual(f.resolve({ text: '再改一下' }).imageReferenceIds, []);
});

test('references reject non-images and retain shared count, size and type budgets without silently omitting the source', t => {
  const f = fixture(t);
  const fake = f.upload(f.thread.id, { name: 'fake.png', kind: 'opaque', mimeType: 'application/octet-stream', data: Buffer.from('not an image') });
  assert.throws(() => f.resolve({ imageReferenceIds: [fake] }), /不是支持的图片/);
  const large = Buffer.alloc(CHAT_UPLOAD_LIMIT); png.copy(large);
  const id = f.generated(image('large.png', large));
  assert.equal(f.resolve({ imageReferenceIds: [id] }).referenceImages[0].data.length, CHAT_UPLOAD_LIMIT);
  assert.throws(() => f.resolve({ imageReferenceIds: [id], files: [image()] }), error => error.status === 413);
  assert.throws(() => f.resolve({ imageReferenceIds: [id], files: Array.from({ length: 4 }, () => image()) }), /4 个|8 MiB/);
  const oversized = Buffer.concat([large, Buffer.from('x')]);
  f.generated(image('too-large.png', oversized));
  assert.throws(() => f.resolve({ text: '再把腿加长一点' }), error => error.status === 413);
  assert.throws(() => validateChatImageInputs([{ ...image(), data: Buffer.from('fake') }]), /图片内容无效/);
  assert.throws(() => validateChatImageInputs([{ ...image(), mimeType: 'image/jpeg' }]), /图片内容无效/);
});

test('automatic image continuation follows question scope and never adopts task or unassigned images', t => {
  const f = fixture(t), graph = createWorkStore({ store: f.store });
  const ordinary = f.upload();
  // Legacy standalone conversation images remain available before it becomes managed.
  assert.deepEqual(f.resolve({ text: '再改一下' }).imageReferenceIds, [ordinary]);
  const ordinaryMessage = f.store.getMessages(f.thread.id).at(-1);
  graph.recordQuestionMessage(f.user.id, f.thread.id, ordinaryMessage.id);
  const object = graph.ensureConversation(f.user.id, f.thread.id).object;
  const task = graph.createTask(f.user.id, { goal: 'Independent illustration task', objects: [{ id: object.id, role: 'target' }] });
  const taskImage = f.generated(image('task-only.png'));
  const taskMessage = f.store.getMessages(f.thread.id).at(-1);
  graph.recordQuestionMessage(f.user.id, f.thread.id, taskMessage.id);
  graph.linkMessages(f.user.id, task.id, { conversationId: f.thread.id, startMessageId: taskMessage.id });
  assert.deepEqual(f.resolve({ text: '再把腿加长一点' }).imageReferenceIds, [ordinary], 'task linkage wins even over a previous question tag');
  const unassigned = f.generated(image('unassigned.png'));
  assert.deepEqual(f.resolve({ text: '继续调整手臂' }).imageReferenceIds, [ordinary], 'managed history requires a question tag');
  assert.deepEqual(f.resolve({ imageReferenceIds: [taskImage] }).imageReferenceIds, [taskImage], 'explicit owned same-thread references stay available');
  assert.deepEqual(f.resolve({ imageReferenceIds: [unassigned] }).imageReferenceIds, [unassigned]);
  // Explicitly bringing a task image into a question establishes a deliberate image chain.
  const reference = f.store.appendMessage(f.thread.id, 'user', '编辑我选择的图片', { imageReferenceIds: [taskImage] });
  graph.recordQuestionMessage(f.user.id, f.thread.id, reference.id);
  assert.deepEqual(f.resolve({ text: '再改一下' }).imageReferenceIds, [taskImage]);
});

test('automatic reference scope recognizes historical task focus without writing managed markers', t => {
  const f = fixture(t), graph = createWorkStore({ store: f.store });
  const imageId = f.upload();
  const object = graph.ensureConversation(f.user.id, f.thread.id).object;
  const task = graph.createTask(f.user.id, { goal: 'Past work', objects: [{ id: object.id, role: 'target' }] });
  const focus = graph.setFocus(f.user.id, f.thread.id, { taskId: task.id, objectId: object.id, expectedRevision: 0 });
  graph.setFocus(f.user.id, f.thread.id, { expectedRevision: focus.revision, source: 'explicit_question' });
  f.store.db.prepare('DELETE FROM work_managed_conversations WHERE conversation_id=?').run(f.thread.id);
  assert.deepEqual(f.resolve({ text: '再改一下' }).imageReferenceIds, [], 'unassigned images do not reappear after a historical task focus');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM work_managed_conversations').get().n, 0, 'reference preflight must not mutate work state');
  const messageId = f.store.getMessages(f.thread.id)[0].id;
  graph.recordQuestionMessage(f.user.id, f.thread.id, messageId);
  assert.deepEqual(f.resolve({ text: '再改一下' }).imageReferenceIds, [imageId]);
});
