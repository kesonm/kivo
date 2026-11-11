import { AppError } from './store.mjs';
import { CHAT_UPLOAD_LIMIT, imageType } from './chat-files.mjs';

const MAX_IMAGES_AND_FILES = 4;
const RECENT_MESSAGES = 12;
const RECENT_IMAGE_MS = 60 * 60 * 1000;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const IMAGE_MIME = /^image\/(?:png|jpeg|webp)$/;

export function validateImageReferenceIds(ids = []) {
  if (!Array.isArray(ids) || ids.length > MAX_IMAGES_AND_FILES || ids.some(id => typeof id !== 'string' || !ID.test(id))
    || new Set(ids).size !== ids.length) throw new AppError('图片引用无效，一条消息最多引用 4 张图片');
  return ids;
}

/** Reference bytes share the original upload budget, rather than adding a second allowance. */
export function validateChatImageInputs(files = [], referenceImages = []) {
  if (!Array.isArray(files) || !Array.isArray(referenceImages) || files.length + referenceImages.length > MAX_IMAGES_AND_FILES) {
    throw new AppError('附件与引用图片合计不能超过 4 个');
  }
  let bytes = 0;
  for (const file of [...files, ...referenceImages]) {
    if (!Buffer.isBuffer(file?.data)) throw new AppError('附件内容无效');
    bytes += file.data.length;
    if (bytes > CHAT_UPLOAD_LIMIT) throw new AppError('附件与引用图片合计不能超过 8 MiB，请压缩图片后重新上传', 413);
    if (file.kind === 'image' && (!IMAGE_MIME.test(file.mimeType) || imageType(file.data) !== file.mimeType)) {
      throw new AppError('图片内容无效，仅支持 PNG、JPEG 和 WebP 图片');
    }
  }
  if (referenceImages.some(file => file.kind !== 'image')) throw new AppError('只能引用图片附件');
}

function wantsRecentImage(text, tool) {
  if (tool !== undefined && !['auto', 'image'].includes(tool)) return false;
  const value = String(text ?? '');
  // Explicitly starting a new picture must not silently attach a previous one.
  if (/(?:新画|另画|另外画|全新(?:的)?(?:图片|图像|画)|(?:重新|另外|再).{0,6}(?:生成|画).{0,6}(?:另一张|一张新的)|(?:画|生成).{0,6}(?:新的|新的一张))|\b(?:new (?:image|picture|illustration)|start (?:over|fresh))\b/i.test(value)) return false;
  const imageSubject = /(?:图片|图像|照片|插画|这张|那张|上张|上一张|手臂|胳膊|腿|背景|构图|眼睛|画面|人物|角色)|\b(?:image|picture|photo|illustration|arms?|legs?|background)\b/i.test(value);
  const edit = /(?:改|调整|编辑|加长|拉长|缩短|放大|缩小|去掉|去除|删除|换|变成|变为|加上|添加)|\b(?:edit|change|adjust|lengthen|shorten|remove|replace|resize|make)\b/i.test(value);
  if (imageSubject && edit) return true;
  if (/(?:代码|项目|函数|网页|程序|文档|文章|表格|配置|账号|部署)|\b(?:code|function|website|document|project)\b/i.test(value)) return false;
  return /(?:再|继续|进一步|把它|将它).{0,8}(?:改|调整|加长|拉长|缩短|放大|缩小|换|变成)|\b(?:edit|adjust|change) (?:it|that|this)\b/i.test(value);
}

function recentImageIds(store, threadId, now) {
  // The work graph is initialized by createApp/createWorkService; isolated legacy
  // stores may not have it. Match getQuestionMessages without changing focus or
  // repairing managed-conversation markers during a read-only preflight.
  const hasWorkScope = !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_message_links'").get();
  const managed = hasWorkScope && !!store.db.prepare(`SELECT 1 FROM work_managed_conversations WHERE conversation_id=?
    UNION ALL SELECT 1 FROM work_run_bindings WHERE conversation_id=?
    UNION ALL SELECT 1 FROM work_message_links WHERE conversation_id=?
    UNION ALL SELECT 1 FROM work_focus_history WHERE conversation_id=? AND task_id IS NOT NULL
    UNION ALL SELECT 1 FROM work_focus WHERE conversation_id=? AND task_id IS NOT NULL LIMIT 1`).get(threadId, threadId, threadId, threadId, threadId);
  const scope = hasWorkScope ? `AND NOT EXISTS(SELECT 1 FROM work_message_links l WHERE l.message_id=m.id)
    ${managed ? 'AND EXISTS(SELECT 1 FROM work_question_messages q WHERE q.message_id=m.id AND q.conversation_id=m.thread_id)' : ''}` : '';
  const rows = store.db.prepare(`SELECT m.id,m.role,m.created_at,x.metadata FROM messages m
    LEFT JOIN chat_message_metadata x ON x.message_id=m.id
    WHERE m.thread_id=? AND m.role IN ('user','assistant') ${scope} ORDER BY m.rowid DESC LIMIT ?`).all(threadId, RECENT_MESSAGES);
  for (const row of rows) {
    const age = now - Date.parse(row.created_at);
    if (!Number.isFinite(age) || age > RECENT_IMAGE_MS) break;
    if (row.role === 'assistant') {
      const artifact = store.db.prepare(`SELECT id FROM chat_artifacts WHERE message_id=?
        AND mime_type IN ('image/png','image/jpeg','image/webp') ORDER BY rowid DESC LIMIT 1`).get(row.id);
      if (artifact) return [artifact.id];
    }
    let metadata;
    try { metadata = JSON.parse(row.metadata || '{}'); } catch { continue; }
    // The latest upload supersedes a reference to the image it was derived from.
    const image = Array.isArray(metadata?.attachments) ? metadata.attachments.filter(file => IMAGE_MIME.test(file?.mimeType)).at(-1) : null;
    if (image?.id) return [image.id];
    if (Array.isArray(metadata?.imageReferenceIds) && metadata.imageReferenceIds.length) return [metadata.imageReferenceIds.at(-1)];
  }
  return [];
}

/** Resolve only local, owner- and thread-bound artifacts. Never accept URLs or provider file IDs. */
export function resolveChatImageReferences({ store, userId, threadId, imageReferenceIds = [], files = [], text, tool, allowAutomatic = true, now = Date.now() }) {
  validateImageReferenceIds(imageReferenceIds);
  validateChatImageInputs(files);
  const thread = store.getThread(threadId);
  if (!thread || thread.userId !== userId || thread.projectId !== null) throw new AppError('对话不存在', 404);
  let ids = imageReferenceIds;
  if (allowAutomatic && !ids.length && !files.some(file => file.kind === 'image') && wantsRecentImage(text, tool)) {
    ids = recentImageIds(store, threadId, now);
  }
  validateImageReferenceIds(ids);
  const referenceImages = [];
  let bytes = files.reduce((total, file) => total + file.data.length, 0);
  for (const id of ids) {
    // Check size before loading the blob. Uploaded blobs intentionally have a generic MIME;
    // their actual image type is established from bytes, never their filename or supplied MIME.
    const artifact = store.db.prepare(`SELECT a.id,a.name,a.size FROM chat_artifacts a
      JOIN messages m ON m.id=a.message_id JOIN threads t ON t.id=m.thread_id
      WHERE a.id=? AND t.id=? AND t.user_id=? AND t.project_id IS NULL AND m.role IN ('user','assistant')`).get(id, threadId, userId);
    if (!artifact) throw new AppError('引用图片不存在或不属于当前对话', 404);
    bytes += artifact.size;
    if (bytes > CHAT_UPLOAD_LIMIT) throw new AppError('附件与引用图片合计不能超过 8 MiB，请压缩图片后重新上传', 413);
    const data = Buffer.from(store.db.prepare('SELECT data FROM chat_artifacts WHERE id=?').get(id).data);
    const mimeType = imageType(data);
    if (!mimeType) throw new AppError('引用的附件不是支持的图片，仅支持 PNG、JPEG 和 WebP');
    referenceImages.push({ id, name: artifact.name, size: data.length, mimeType, kind: 'image', data });
  }
  validateChatImageInputs(files, referenceImages);
  return { referenceImages, imageReferenceIds: [...ids] };
}
