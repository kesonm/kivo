import { AppError } from './store.mjs';

const intents = new Set(['question', 'new', 'continue', 'fork', 'revise', 'reference', 'compare', 'cancel', 'pause']);
const fields = new Set(['intent', 'taskId', 'objectId', 'referenceIds', 'focusRevision', 'taskVersion']);
const terminal = new Set(['cancelled', 'deleted']);

// This resolver deliberately uses verifiable identifiers and scoped relations.
// Keywords can recall candidates; neither similarity nor recency authorizes a write.
export function validateWorkRequest(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key))) throw new AppError('工作引用无效');
  if (value.intent !== undefined && !intents.has(value.intent)) throw new AppError('工作操作无效');
  for (const key of ['taskId', 'objectId']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value[key]))) throw new AppError('工作标识无效');
  for (const key of ['focusRevision', 'taskVersion']) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) throw new AppError('工作版本无效');
  if (value.referenceIds !== undefined && (!Array.isArray(value.referenceIds) || value.referenceIds.length > 6 || value.referenceIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)))) throw new AppError('参考对象无效');
  return { ...value, ...(value.referenceIds ? { referenceIds: [...new Set(value.referenceIds)] } : {}) };
}

export function parseWorkIntent(text, explicit) {
  if (explicit) return explicit;
  if (/取消.{0,8}(任务|工作)|停止执行|cancel (this |the )?task/i.test(text)) return 'cancel';
  if (/暂停.{0,8}(任务|工作)|pause (this |the )?task/i.test(text)) return 'pause';
  if (/全新(版本|项目|任务)|另(一个|一种)(方案|版本)|新做.{0,5}类似|类似.{0,6}(新项目|新版本)|new (version|project).*similar/i.test(text)) return 'fork';
  if (/参考.{1,100}(给|为|应用|实现)|apply .{1,80} to /i.test(text)) return 'reference';
  if (/比较|对比|compare /i.test(text)) return 'compare';
  if (/继续|接着|恢复.{0,4}(任务|工作)|resume |continue /i.test(text)) return 'continue';
  if (/修订|修改.{0,6}(结果|成果|报告)|revise /i.test(text)) return 'revise';
  if (/^(请|帮我|请帮我)?(新建|创建|开发|实现|修复|设计|制作)|^(create|build|fix|implement)\b/i.test(text)) return 'new';
  return 'question';
}

function mentions(text, object) {
  return [object.name, ...(object.aliases || [])].some(name => {
    if (typeof name !== 'string' || name.length < 2) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(/[a-z0-9]/i.test(name[0]) ? `(?<![a-z0-9_])${escaped}(?![a-z0-9_])` : escaped, 'i').test(text);
  });
}
const targetOf = task => task.objects?.find(object => object.role === 'target');
const targetId = task => { const target = targetOf(task); return target?.objectId ?? target?.id; };
const candidate = task => ({ id: task.id, goal: task.goal, state: task.state, version: task.version,
  objectId: targetId(task), objectName: targetOf(task)?.name, projectId: targetOf(task)?.projectId, updatedAt: task.updatedAt });

export function resolveWorkRoute({ workStore, userId, conversationId, text, work: rawWork }) {
  const work = validateWorkRequest(rawWork);
  const conversation = workStore.ensureConversation(userId, conversationId);
  const focus = workStore.getFocus(userId, conversationId);
  if (work.focusRevision !== undefined && work.focusRevision !== focus.revision) throw new AppError('当前对话的工作目标已变更，请刷新后重新选择', 409, 'work_focus_conflict');
  const explicitTask = work.taskId ? workStore.getTask(userId, work.taskId) : null;
  const explicitObject = work.objectId ? workStore.getObject(userId, work.objectId) : null;
  const referenceIds = work.referenceIds || [];
  for (const id of referenceIds) workStore.getObject(userId, id);
  if (explicitTask && work.taskVersion !== undefined && explicitTask.version !== work.taskVersion) throw new AppError('任务版本已变更，请刷新后重试', 409, 'work_task_conflict');
  const intent = parseWorkIntent(text, work.intent);
  const base = { intent, status: 'unresolved', taskId: null, objectId: null, referenceIds,
    focusRevision: focus.revision, evidence: [], candidates: [], allowed: [], reason: '', historyStatus: conversation.historyStatus };
  const decided = (status, values) => ({ ...base, status, ...values });
  if (intent === 'question' && !explicitTask && !explicitObject && work.intent === 'question') {
    return decided('matched', { reason: '明确选择普通问答', allowed: ['chat'], clearFocus: true });
  }
  let task = explicitTask;
  let object = explicitObject;
  if (task) {
    const id = targetId(task);
    if (object && object.id !== id) return decided('blocked', { reason: '任务与明确指定的操作对象冲突，需选择该对象的任务', evidence: [{ source: 'explicit_task', id: task.id }, { source: 'explicit_object', id: object.id }] });
    object ??= id ? workStore.getObject(userId, id) : null;
    base.evidence.push({ source: 'explicit_task', id: task.id, version: task.version });
  }
  if (explicitObject) base.evidence.push({ source: 'explicit_object', id: object.id, version: object.version });
  // Named objects are recall evidence, not a guessed globally unique identity.
  const objects = workStore.listObjects(userId, { limit: 200 });
  const named = objects.filter(item => mentions(text, item));
  if (!object && named.length === 1) { object = named[0]; base.evidence.push({ source: 'exact_name', id: object.id, version: object.version }); }
  if (!object && named.length > 1 && !['compare', 'reference'].includes(intent)) {
    return decided('ambiguous', { reason: '消息中有多个同名或相关对象，请明确操作目标', objectCandidates: named.slice(0, 6).map(({ id, name, projectId }) => ({ id, name, projectId })) });
  }
  if (intent === 'reference' && !explicitObject && named.length > 1) {
    // Require an explicit target rather than turn a natural-language ordering into write authority.
    return decided('ambiguous', { reason: '请指定要修改的对象，其他对象仅作参考', objectCandidates: named.slice(0, 6).map(({ id, name, projectId }) => ({ id, name, projectId })) });
  }
  if (intent === 'compare') {
    const refs = [...new Set([...referenceIds, ...named.map(item => item.id), ...(object ? [object.id] : [])])];
    if (refs.length < 2) return decided('unresolved', { reason: '请选择至少两个有权访问的参考对象' });
    return decided('new', { referenceIds: refs, reason: '比较创建独立任务，关联对象只读', allowed: ['chat'], createObject: true });
  }
  if (intent === 'fork') {
    // A fresh variant never inherits a writable source workspace.
    const refs = [...new Set([...referenceIds, ...(object ? [object.id] : []), ...(!object && focus.objectId ? [focus.objectId] : [])])];
    for (const id of refs) workStore.getObject(userId, id);
    return decided('new', { parentTaskId: task?.id ?? focus.taskId ?? null, referenceIds: refs,
      reason: '新方案使用独立工作对象与干净会话，原对象仅作参考', allowed: ['chat'], createObject: true });
  }
  if (intent === 'new' || intent === 'reference') {
    if (intent === 'reference' && (!object || !referenceIds.length)) return decided('unresolved', { reason: '请选择操作对象和参考对象，两个角色不能混淆' });
    if (intent === 'new' && work.intent === 'new' && !explicitObject) return decided('new', { createObject: true, referenceIds, reason: '新工作使用独立身份', allowed: ['chat'] });
    if (!object && focus.source === 'explicit_question') return decided('new', { createObject: true, referenceIds, reason: '普通问答中的新工作使用独立身份', allowed: ['chat'] });
    object ??= focus.objectId ? workStore.getObject(userId, focus.objectId) : conversation.object;
    return decided('new', { objectId: object.id, referenceIds: referenceIds.filter(id => id !== object.id),
      reason: '明确的新目标建立独立任务', allowed: [object.projectId ? 'project' : 'chat'] });
  }
  // "之前那个" is deliberately broader than the conversational "这个".
  const historical = /之前|上次|以前|previous|last time/i.test(text);
  if (!task && !explicitObject && !object && !historical && focus.taskId) {
    task = workStore.getTask(userId, focus.taskId);
    object = workStore.getObject(userId, targetId(task));
    base.evidence.push({ source: 'conversation_focus', id: task.id, revision: focus.revision });
  }
  if (!task && intent === 'question' && !explicitObject && named.length === 0 && (!conversation.object.projectId || focus.source === 'explicit_question')) {
    return decided('matched', { reason: '普通问答直接处理', allowed: ['chat'] });
  }
  if (!task) {
    if (!object && conversation.object.projectId && !historical && focus.source !== 'explicit_question') {
      object = conversation.object;
      base.evidence.push({ source: 'selected_workspace', id: object.id, version: object.version });
    }
    const tasks = workStore.listTasks(userId, { objectId: object?.id, limit: 200 }).filter(item => !terminal.has(item.state));
    base.candidates = tasks.slice(0, 6).map(candidate);
    if (tasks.length === 1 && (object || base.evidence.length)) task = tasks[0];
    else if (tasks.length) return decided('ambiguous', { reason: '有多个可能的历史工作，不能按最近使用时间决定', candidates: base.candidates });
    else if (intent === 'question' && object) return decided('new', { objectId: object.id, reason: '在明确工作对象上开始独立任务', allowed: [object.projectId ? 'project' : 'chat'] });
    else return decided('unresolved', { reason: conversation.historyStatus === 'unassigned' ? '历史尚未关联到任务，请选择历史片段或明确工作对象' : '未找到可确认的历史任务，请提供对象或产物引用' });
  }
  if (terminal.has(task.state)) return decided('blocked', { reason: '此任务已取消或删除，请建立独立后续工作' });
  if (['cancel', 'pause'].includes(intent)) return decided('matched', { taskId: task.id, taskVersion: task.version, objectId: targetId(task), reason: '明确任务后才能停止执行', allowed: [intent] });
  object ??= workStore.getObject(userId, targetId(task));
  if (['running', 'waiting_approval'].includes(task.state)) return decided('blocked', { taskId: task.id, objectId: object.id, reason: '任务正在执行，先停止并核对结果，再修改目标' });
  return decided('matched', { taskId: task.id, taskVersion: task.version, objectId: object.id,
    referenceIds: task.objects.filter(item => item.role === 'reference').map(item => item.objectId ?? item.id),
    reason: base.evidence.length ? '已通过明确引用或对话关系定位任务' : '已确认任务', allowed: [object.projectId ? 'project' : 'chat'] });
}

export function requireExecutableRoute(route) {
  if (['matched', 'new'].includes(route.status)) return route;
  const error = new AppError(route.reason, 409, 'work_route_' + route.status);
  error.details = { route };
  throw error;
}
