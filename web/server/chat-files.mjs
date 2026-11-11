import path from 'node:path';
import { AppError } from './store.mjs';

export const CHAT_UPLOAD_LIMIT = 8 * 1024 * 1024;
export const CHAT_UPLOAD_BODY_LIMIT = CHAT_UPLOAD_LIMIT + 64 * 1024;
const MAX_FILES = 4;
const TYPES = new Map([
  ['.pdf', ['application/pdf', 'document']],
  ['.docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document']],
  ['.pptx', ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'document']],
  ['.txt', ['text/plain', 'document']],
  ['.md', ['text/markdown', 'document']],
  ['.csv', ['text/csv', 'table']],
  ['.tsv', ['text/tsv', 'document']],
  ['.xlsx', ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'table']],
  ['.json', ['application/json', 'table']],
]);

export function imageType(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function isPlainText(data) {
  if (!data.length || data.includes(0)) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return !/[\x01-\x08\x0b-\x0c\x0e-\x1f\x7f]/.test(text);
  } catch { return false; }
}

function classifyFile(name, data) {
  const image = imageType(data);
  if (image) return [image, 'image'];
  const known = TYPES.get(path.extname(name).toLowerCase());
  const mimeType = known?.[0] ?? '';
  const pdf = mimeType === 'application/pdf';
  const office = mimeType.startsWith('application/vnd.openxmlformats-');
  if (pdf && data.subarray(0, 1024).includes('%PDF-')) return known;
  if (office && data.length >= 4 && data.readUInt32LE(0) === 0x04034b50) return known;
  if (!isPlainText(data)) return ['application/octet-stream', 'opaque'];
  return known && !pdf && !office ? known : ['text/plain', 'text'];
}

function tableFilename(name, used) {
  const extension = path.extname(name);
  const stem = name.slice(0, -extension.length);
  let result = name;
  for (let number = 2; used.has(result.toLowerCase()); number++) {
    const suffix = ' (' + number + ')' + extension;
    result = stem.slice(0, 200 - suffix.length).toWellFormed() + suffix;
  }
  used.add(result.toLowerCase());
  return result;
}

export function attachmentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\/%]/g, '_');
  const encoded = encodeURIComponent(name.toWellFormed())
    .replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return 'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encoded;
}

export async function readChatMultipart(body, contentType) {
  let form;
  try { form = await new Response(body, { headers: { 'content-type': contentType } }).formData(); }
  catch { throw new AppError('附件上传格式无效', 400); }
  const files = [], tableNames = new Set(), fields = {};
  let total = 0;
  for (const [key, value] of form) {
    if (key === 'imageReferenceIds' && typeof value === 'string' && !Object.hasOwn(fields, key)) {
      try { fields.imageReferenceIds = JSON.parse(value); } catch { throw new AppError('图片引用格式无效', 400); }
      if (!Array.isArray(fields.imageReferenceIds) || fields.imageReferenceIds.length > MAX_FILES
        || fields.imageReferenceIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id))) throw new AppError('图片引用格式无效', 400);
      continue;
    }
    if (key === 'work' && typeof value === 'string' && !Object.hasOwn(fields, key)) {
      let selection;
      try { selection = JSON.parse(value); } catch { throw new AppError('普通问答选择无效'); }
      if (!selection || selection.intent !== 'question' || Object.keys(selection).some(key => !['intent', 'focusRevision'].includes(key))
        || !Number.isSafeInteger(selection.focusRevision) || selection.focusRevision < 0) throw new AppError('附件只允许切换到普通问答');
      fields.work = selection;
      continue;
    }
    if (['text', 'tool', 'model', 'reasoningEffort', 'requestId', 'taskReferenceId'].includes(key) && typeof value === 'string' && !Object.hasOwn(fields, key)) {
      fields[key] = value;
      continue;
    }
    if (key !== 'files' || typeof value === 'string') throw new AppError('附件上传字段无效', 400);
    if (files.length >= MAX_FILES) throw new AppError('一条消息最多可以添加 4 个附件', 400);
    const name = value.name.normalize('NFC').trim();
    if (!name || name === '.' || name === '..' || name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(name)) throw new AppError('附件名称无效', 400);
    total += value.size;
    if (total > CHAT_UPLOAD_LIMIT) throw new AppError('附件合计不能超过 8 MiB', 413);
    const data = Buffer.from(await value.arrayBuffer());
    const [mimeType, kind] = classifyFile(name, data);
    const analysisName = kind === 'table' ? tableFilename(name, tableNames) : name;
    files.push({ name, mimeType, kind, size: data.length, data, ...(analysisName !== name ? { analysisName } : {}) });
  }
  return { ...fields, files };
}
