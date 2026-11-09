import path from 'node:path';
import { AppError } from './store.mjs';

export const CHAT_UPLOAD_LIMIT = 8 * 1024 * 1024;
export const CHAT_UPLOAD_BODY_LIMIT = CHAT_UPLOAD_LIMIT + 64 * 1024;
const MAX_FILES = 4;
const TYPES = new Map([
  ['.png', ['image/png', 'image']],
  ['.jpg', ['image/jpeg', 'image']],
  ['.jpeg', ['image/jpeg', 'image']],
  ['.webp', ['image/webp', 'image']],
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

function matchesType(data, mimeType, kind) {
  if (kind === 'image') return imageType(data) === mimeType;
  if (mimeType === 'application/pdf') return data.subarray(0, 1024).includes('%PDF-');
  if (mimeType.startsWith('application/vnd.openxmlformats-')) return data.length >= 4 && data.readUInt32LE(0) === 0x04034b50;
  if (data.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(data); return true; } catch { return false; }
}

export async function readChatMultipart(body, contentType) {
  let form;
  try { form = await new Response(body, { headers: { 'content-type': contentType } }).formData(); }
  catch { throw new AppError('附件上传格式无效', 400); }
  const files = [], names = new Set(), fields = {};
  let total = 0;
  for (const [key, value] of form) {
    if ((key === 'text' || key === 'tool') && typeof value === 'string' && !Object.hasOwn(fields, key)) {
      fields[key] = value;
      continue;
    }
    if (key !== 'files' || typeof value === 'string') throw new AppError('附件上传字段无效', 400);
    if (files.length >= MAX_FILES) throw new AppError('一条消息最多可以添加 4 个附件', 400);
    const name = value.name.normalize('NFC').trim();
    if (!name || name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(name)) throw new AppError('附件名称无效', 400);
    if (names.has(name.toLowerCase())) throw new AppError('请为同一条消息中的附件使用不同的文件名', 400);
    names.add(name.toLowerCase());
    const type = TYPES.get(path.extname(name).toLowerCase());
    if (!type) throw new AppError('不支持此附件格式', 415);
    total += value.size;
    if (!value.size) throw new AppError('附件不能为空', 400);
    if (total > CHAT_UPLOAD_LIMIT) throw new AppError('附件合计不能超过 8 MiB', 413);
    const [mimeType, kind] = type;
    const data = Buffer.from(await value.arrayBuffer());
    if (!matchesType(data, mimeType, kind)) throw new AppError('附件内容与扩展名不符，文本附件需使用 UTF-8', 415);
    files.push({ name, mimeType, kind, size: data.length, data });
  }
  return { ...fields, files };
}
