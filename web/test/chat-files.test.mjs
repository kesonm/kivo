import test from 'node:test';
import assert from 'node:assert/strict';
import { attachmentDisposition, CHAT_UPLOAD_LIMIT, readChatMultipart } from '../server/chat-files.mjs';
import { createStore } from '../server/store.mjs';

async function parse(form) {
  const response = new Response(form);
  return readChatMultipart(Buffer.from(await response.arrayBuffer()), response.headers.get('content-type'));
}

test('multipart chat accepts arbitrary filenames and keeps binary bytes out of analysis', async t => {
  const binary = Uint8Array.of(0, 255, 7, 1);
  const form = new FormData();
  form.set('model', 'model-fixture');
  form.append('files', new Blob([binary], { type: 'text/html' }), '备份.custom');
  form.append('files', new Blob(['const total = 8;\n']), 'example.ts');
  form.append('files', new Blob(['amount\n3\n']), 'sheet.csv');
  form.append('files', new Blob(['amount\n5\n']), 'sheet.csv');

  const upload = await parse(form);
  assert.equal(upload.model, 'model-fixture');
  assert.deepEqual(upload.files.map(file => [file.name, file.kind]), [
    ['备份.custom', 'opaque'], ['example.ts', 'text'], ['sheet.csv', 'table'], ['sheet.csv', 'table'],
  ]);
  assert.equal(upload.files[3].analysisName, 'sheet (2).csv');

  const store = createStore(':memory:');
  t.after(() => store.close());
  const owner = store.createUser({ username: 'owner', displayName: 'Owner', passwordHash: 'fixture' });
  const other = store.createUser({ username: 'other', displayName: 'Other', passwordHash: 'fixture' });
  const thread = store.createThread(null, owner.id);
  const message = store.appendMessage(thread.id, 'user', 'Files', { uploads: upload.files });
  const [saved] = store.getMessages(thread.id);
  assert.deepEqual(saved.attachments, message.attachments);
  assert.equal(saved.artifacts, undefined);
  assert.deepEqual(saved.attachments.map(file => file.analyzable), [false, true, true, true]);
  assert.notEqual(saved.attachments[2].id, saved.attachments[3].id);
  const first = saved.attachments[0];
  const file = store.getChatArtifact(first.id, owner.id);
  assert.equal(file.role, 'user');
  assert.equal(file.mimeType, 'application/octet-stream');
  assert.deepEqual(Buffer.from(file.data), Buffer.from(binary));
  assert.equal(store.getChatArtifact(first.id, other.id), undefined);
  assert.match(attachmentDisposition(file.name), /^attachment; filename="[ -~]+"; filename\*=UTF-8''%E5%A4%87%E4%BB%BD\.custom$/);
  store.deleteMessage(message.id);
  assert.equal(store.getChatArtifact(first.id, owner.id), undefined);
});

test('arbitrary attachment types still obey the file-count and byte limits', async () => {
  const tooMany = new FormData();
  for (let index = 0; index < 5; index++) tooMany.append('files', new Blob(), `empty-${index}.custom`);
  await assert.rejects(parse(tooMany), error => error.status === 400 && /4 个/.test(error.message));
  const tooLarge = new FormData();
  tooLarge.append('files', new Blob([new Uint8Array(CHAT_UPLOAD_LIMIT + 1)]), 'large.custom');
  await assert.rejects(parse(tooLarge), error => error.status === 413);
});
