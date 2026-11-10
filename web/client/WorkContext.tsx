import { useEffect, useRef, useState } from 'react';
import { api, dateTime, enc, messageOf } from './api';
import { Icon } from './icons';
import { useDialog } from './ui';
import type { WorkCandidate, WorkObject, WorkRoute, WorkSelection, WorkSnapshot, WorkTask } from './types';
import './work-context.css';

const statusLabels: Record<string, string> = {
  ready: '待执行', running: '执行中', waiting_input: '等待确认', waiting_approval: '等待审批',
  paused: '已暂停', succeeded: '验收通过', failed: '执行失败', cancelled: '已取消', needs_reconciliation: '需核对结果',
};
const kindLabels: Record<string, string> = { project: '项目', repository: '代码项目', document: '文档', research: '研究', image: '图像', asset: '资产', collection: '工作集合', temporary: '临时工作', conversation: '对话' };
const artifactStatusLabels: Record<string, string> = { current: '当前版本', superseded: '已被更新', stale: '需重新验证' };
const intentLabels = { question: '普通问答', new: '新任务', continue: '继续任务', fork: '分叉方案', revise: '修订成果', reference: '参考实现', compare: '比较对象' };

export function taskTarget(task?: WorkTask | null) { return task?.objects.find(object => object.role === 'target'); }
export function objectDetail(object?: WorkObject | null) {
  if (!object) return '';
  const anchors = object.anchors ?? {};
  const location = [anchors.location, anchors.path, anchors.workspace, anchors.branch].filter(value => typeof value === 'string').join(' · ');
  return location || kindLabels[object.kind] || object.kind;
}

export function WorkContext({ snapshot, selection, onChange, route, onRoute, threadId, draft, busy, loadError, onRefresh }: {
  snapshot: WorkSnapshot | null; selection?: WorkSelection; onChange: (selection?: WorkSelection) => void;
  route: WorkRoute | null; onRoute: (route: WorkRoute | null) => void; threadId: string | null;
  draft: string; busy: boolean; loadError?: string; onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WorkTask[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [pickedTask, setPickedTask] = useState<WorkTask | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [acceptingArtifact, setAcceptingArtifact] = useState<string | null>(null);
  const ask = useDialog();
  const search = useRef<HTMLInputElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const conversationRef = useRef(threadId); conversationRef.current = threadId;
  const mode = snapshot?.mode ?? 'off';
  const active = snapshot?.task;
  const selectedTask = selection?.taskId ? (snapshot?.tasks ?? []).find(task => task.id === selection.taskId)
    ?? results?.find(task => task.id === selection.taskId) ?? (pickedTask?.id === selection.taskId ? pickedTask : undefined)
    ?? (active?.id === selection.taskId ? active : undefined) : undefined;
  const task = selection ? selectedTask : active;
  const target = selection?.objectId ? snapshot?.objects.find(object => object.id === selection.objectId)
    : selection && !['continue', 'revise'].includes(selection.intent) ? null : taskTarget(task);
  const writable = mode === 'enforce' && !busy;
  const referenceIds = selection?.referenceIds ?? [];
  const candidates: WorkCandidate[] = route?.status === 'ambiguous' || route?.status === 'unresolved'
    ? [...(route.candidates ?? []), ...(route.objectCandidates ?? []).map(item => ({ ...item, kind: 'object' }))] : [];
  const scopedSelection = (next: WorkSelection) => ({ ...next, focusRevision: snapshot?.focus?.revision ?? 0 });
  const objects = snapshot?.objects ?? [];
  const listedTasks = query ? results ?? [] : snapshot?.tasks ?? [];

  useEffect(() => {
    setOpen(false); setQuery(''); setResults(null); setSearchError(''); ++sequence.current;
  }, [threadId]);
  useEffect(() => { if (route && ['ambiguous', 'unresolved', 'blocked'].includes(route.status)) setOpen(true); }, [route]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); container.current?.querySelector<HTMLButtonElement>('.work-context-toggle')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => {
    if (!open || !query.trim()) { setResults(null); setSearching(false); return; }
    const controller = new AbortController();
    const current = ++sequence.current;
    setSearching(true); setSearchError('');
    const timer = window.setTimeout(() => {
      void api<{ tasks: WorkTask[] }>(`/api/work/tasks?q=${enc(query.trim())}`, { signal: controller.signal }).then(data => {
        if (current === sequence.current) setResults(data.tasks);
      }).catch(error => { if (!controller.signal.aborted && current === sequence.current) setSearchError(messageOf(error)); })
        .finally(() => { if (current === sequence.current) setSearching(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); ++sequence.current; };
  }, [open, query]);

  function chooseTask(next: WorkTask) {
    setPickedTask(next);
    onChange(scopedSelection({ intent: 'continue', taskId: next.id, taskVersion: next.version, objectId: taskTarget(next)?.id }));
    onRoute(null); setQuery('');
  }
  function chooseCandidate(candidate: WorkCandidate) {
    const found = [...(snapshot?.tasks ?? []), ...(results ?? [])].find(item => item.id === (candidate.taskId ?? candidate.id));
    if (found) chooseTask(found);
    else if (candidate.kind === 'object') {
      onChange(scopedSelection({ intent: route?.intent ?? 'continue', objectId: candidate.objectId ?? candidate.id }));
      onRoute(null);
    } else {
      onChange(scopedSelection({ intent: route?.intent ?? 'continue', taskId: candidate.taskId ?? candidate.id, ...(candidate.objectId ? { objectId: candidate.objectId } : {}), ...(candidate.version ? { taskVersion: candidate.version } : {}) }));
      onRoute(null);
    }
  }
  async function preview() {
    if (!threadId || !draft.trim() || previewing) return;
    setPreviewing(true); setSearchError('');
    const currentThread = threadId;
    const current = ++sequence.current;
    try {
      const data = await api<{ route: WorkRoute }>(`/api/threads/${enc(currentThread)}/route`, { method: 'POST', body: { text: draft.trim(), ...(selection ? { work: selection } : {}) } });
      if (current === sequence.current) onRoute(data.route);
    } catch (error) { if (current === sequence.current) setSearchError(messageOf(error)); }
    finally { setPreviewing(false); }
  }
  async function cancelTask() {
    if (!task || cancelling || acceptingArtifact || mode !== 'enforce') return;
    const currentTask = task;
    const currentConversation = threadId;
    if (!await ask({ title: '取消这项工作？', description: `将取消“${currentTask.goal.slice(0, 100)}”并停止后续执行。已经完成的文件修改或外部操作会保留，需要按实际结果核对。`, confirm: '取消工作', danger: true })) return;
    if (conversationRef.current !== currentConversation) return;
    setCancelling(true); setSearchError('');
    try {
      await api(`/api/work/tasks/${enc(currentTask.id)}/cancel`, { method: 'POST', body: { expectedVersion: currentTask.version } });
      if (conversationRef.current === currentConversation) { onChange(undefined); onRoute(null); onRefresh(); }
    } catch (error) { if (conversationRef.current === currentConversation) { setSearchError(messageOf(error)); onRefresh(); } }
    finally { setCancelling(false); }
  }
  async function acceptArtifact(artifact: NonNullable<WorkSnapshot['artifacts']>[number]) {
    if (mode !== 'enforce' || busy || cancelling || acceptingArtifact || selection || !active
      || active.id !== snapshot?.focus?.taskId || active.status !== 'waiting_input' || artifact.status !== 'current') return;
    const currentTask = active;
    const currentConversation = threadId;
    if (!await ask({ title: '确认这个版本的结果？',
      description: `你将确认“${artifact.name ?? artifact.title ?? '工作产物'}”的 v${artifact.version} 版本。这是人工验收记录，不代表系统已完成独立测试；已有验证记录会继续保留。`,
      confirm: '确认此版本结果' })) return;
    if (conversationRef.current !== currentConversation) return;
    setAcceptingArtifact(artifact.id); setSearchError('');
    try {
      await api(`/api/work/tasks/${enc(currentTask.id)}/accept`, { method: 'POST', body: { expectedVersion: currentTask.version, artifactId: artifact.id } });
      if (conversationRef.current === currentConversation) onRefresh();
    } catch (error) { if (conversationRef.current === currentConversation) { setSearchError(messageOf(error)); onRefresh(); } }
    finally { setAcceptingArtifact(null); }
  }

  if (!snapshot && !loadError) return null;
  if (mode === 'off' && !loadError) return null;
  return <div ref={container} className={'work-context' + (open ? ' work-context-open' : '')}>
    <div className="work-context-summary">
      <button type="button" className="work-context-toggle" aria-expanded={open} aria-controls="work-context-details"
        onClick={() => { setOpen(value => !value); if (!open) onRefresh(); }}>
        <Icon name="folder" size={15} />
        <span className="work-context-target">{selection ? `下次发送 · ${intentLabels[selection.intent]}` : task ? task.goal : '工作上下文'}</span>
        {target && <span className="work-context-object">{target.name}</span>}
        {task && <span className="work-status">{statusLabels[task.status] ?? task.status} · v{task.version}</span>}
        <Icon name={open ? 'up' : 'down'} size={14} />
      </button>
      {mode === 'shadow' && <span className="work-observation-label">观察模式</span>}
      {selection && <button type="button" className="icon-button" disabled={busy} aria-label="清除下次发送的工作选择" title="清除下次发送的工作选择" onClick={() => { onChange(undefined); onRoute(null); }}><Icon name="close" size={14} /></button>}
    </div>
    {open && <section className="work-context-details" id="work-context-details" aria-label="工作上下文与任务选择">
      {loadError && <div className="work-feedback error" role="alert">{loadError}<button type="button" className="text-button" onClick={onRefresh}>重新加载</button></div>}
      {mode === 'shadow' && <p className="work-explanation">正在观察目标识别结果，消息仍使用原有对话路径。此模式下不能切换执行目标。</p>}
      {mode === 'enforce' && <p className="work-explanation">选定目标后，用下方消息说明要做的事。参考对象只提供上下文，写入仅限操作目标。</p>}
      {task && <div className="work-task-current">
        {selection && ['fork', 'revise'].includes(selection.intent) && <p className="work-explanation">{selection.intent === 'fork' ? '分叉来源' : '修订对象'}</p>}
        <div><strong>{task.goal}</strong><span>{statusLabels[task.status] ?? task.status} · 任务 v{task.version}</span></div>
        {task.objects.map(object => <div className="work-object-line" key={object.id + object.role}><span className={'work-object-role ' + object.role}>{object.role === 'target' ? '操作目标' : '参考'}</span><b>{object.name}</b><small>{objectDetail(object)} · v{object.version}</small></div>)}
        {!!task.constraints?.length && <details><summary>已记录约束</summary><ul>{task.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></details>}
        {mode === 'enforce' && !['cancelled', 'succeeded'].includes(task.status) && <button type="button" className="work-cancel-button" disabled={cancelling || !!acceptingArtifact} onClick={() => void cancelTask()}><Icon name="stop" size={13} />{cancelling ? '正在取消…' : '取消这项工作'}</button>}
      </div>}
      {route && <div className={'work-feedback' + (['ambiguous', 'unresolved', 'blocked'].includes(route.status) ? ' warning' : '')} role="status">
        <strong>{{ matched: '已定位目标', new: '将建立独立工作', ambiguous: '需要选择工作目标', unresolved: '尚未定位到历史工作', blocked: '当前无法开始工作' }[route.status]}</strong>
        {route.reason && <p>{route.reason}</p>}
        {!!candidates.length && <div className="work-candidates">{candidates.slice(0, 5).map(candidate => <button type="button" key={candidate.id} disabled={!writable} onClick={() => chooseCandidate(candidate)}>
          <span>{candidate.goal ?? candidate.name ?? candidate.objectName ?? '历史工作'}</span>
          <small>{[candidate.objectName, candidate.updatedAt && dateTime(candidate.updatedAt), candidate.version && `v${candidate.version}`].filter(Boolean).join(' · ')}</small>
          <span className="work-candidate-confirm">使用此目标<Icon name="arrow" size={14} /></span>
        </button>)}</div>}
        {route.status === 'unresolved' && !candidates.length && <p>可以搜索历史任务，或在消息中补充文件、产物或工作目标的信息。</p>}
      </div>}
      {mode === 'enforce' && <>
        <div className="work-actions" role="group" aria-label="下次消息的工作方式">
          <button type="button" disabled={busy} aria-pressed={selection?.intent === 'question'} onClick={() => { onChange(scopedSelection({ intent: 'question' })); onRoute(null); }}>普通问答</button>
          <button type="button" disabled={busy} aria-pressed={selection?.intent === 'new'} onClick={() => { onChange(scopedSelection({ intent: 'new' })); onRoute(null); }}><Icon name="plus" size={14} />新任务</button>
          <button type="button" disabled={!task || busy} aria-pressed={selection?.intent === 'fork'} onClick={() => { if (task) onChange(scopedSelection({ intent: 'fork', taskId: task.id, taskVersion: task.version })); onRoute(null); }}><Icon name="diff" size={14} />分叉方案</button>
          <button type="button" disabled={!task || busy} aria-pressed={selection?.intent === 'revise'} onClick={() => { if (task) onChange(scopedSelection({ intent: 'revise', taskId: task.id, taskVersion: task.version, objectId: taskTarget(task)?.id })); onRoute(null); }}><Icon name="edit" size={14} />修订成果</button>
          <button type="button" disabled={busy} aria-pressed={selection?.intent === 'reference'} onClick={() => { onChange(scopedSelection({ intent: 'reference', referenceIds: target ? [target.id] : [] })); onRoute(null); }}>参考实现</button>
          <button type="button" disabled={busy} aria-pressed={selection?.intent === 'compare'} onClick={() => { onChange(scopedSelection({ intent: 'compare', referenceIds: target ? [target.id] : [] })); onRoute(null); }}>比较对象</button>
        </div>
        {selection && selection.intent !== 'question' && <div className="work-selection-fields">
          <label>{selection.intent === 'compare' ? '结果归属' : '操作目标'}<select value={selection.objectId ?? ''} disabled={busy || ['revise', 'fork', 'compare'].includes(selection.intent)} onChange={event => onChange(scopedSelection({ ...selection, objectId: event.target.value || undefined,
            referenceIds: referenceIds.filter(id => id !== event.target.value),
            ...(['continue', 'new', 'reference', 'compare'].includes(selection.intent) ? { taskId: undefined, taskVersion: undefined } : {}),
            intent: selection.intent === 'continue' ? 'new' : selection.intent }))}>
            <option value="">{['new', 'fork', 'compare'].includes(selection.intent) ? '独立工作对象' : selection.intent === 'reference' ? '请选择操作目标' : '沿用所选任务'}</option>
            {objects.map(object => <option key={object.id} value={object.id}>{object.name} · {objectDetail(object)}</option>)}
          </select></label>
          <details className="work-reference-picker"><summary>参考对象{referenceIds.length ? `（${referenceIds.length}）` : '（选填）'}</summary>
            <p>勾选对象仅作参考，不授予其文件写入权限。</p>
            {objects.filter(object => object.id !== selection.objectId).map(object => <label key={object.id}><input type="checkbox" checked={referenceIds.includes(object.id)} disabled={busy || !referenceIds.includes(object.id) && referenceIds.length >= 3}
              onChange={event => onChange(scopedSelection({ ...selection, referenceIds: event.target.checked ? [...referenceIds, object.id] : referenceIds.filter(id => id !== object.id) }))} /><span>{object.name}<small>{objectDetail(object)}</small></span></label>)}
          </details>
          {selection.intent === 'fork' && <p>保留原任务，在独立工作对象中探索方案。这一步不会创建或修改代码工作区。</p>}
          <p>这次选择会在下一条消息发送时核对权限与版本。</p>
        </div>}
        <div className="work-task-search"><Icon name="search" size={15} /><input ref={search} value={query} onChange={event => setQuery(event.target.value)} placeholder="查找已有任务、文件或工作目标" aria-label="查找历史工作任务" maxLength={200} /></div>
        {searching && <p className="work-explanation" role="status">正在查找…</p>}
        {searchError && <p className="work-feedback error" role="alert">{searchError}</p>}
        {!searching && <div className="work-task-list" aria-label="历史工作任务">{listedTasks.slice(0, 20).map(item => <button type="button" key={item.id} disabled={busy} aria-pressed={selection?.taskId === item.id} onClick={() => chooseTask(item)}>
          <span>{item.goal}</span><small>{[taskTarget(item)?.name, statusLabels[item.status] ?? item.status, `v${item.version}`, item.updatedAt && dateTime(item.updatedAt)].filter(Boolean).join(' · ')}</small>
          <Icon name={selection?.taskId === item.id ? 'check' : 'arrow'} size={15} />
        </button>)}{!listedTasks.length && !searchError && <p className="work-explanation">{query ? '没有匹配的已登记任务。可补充更具体的目标或查看其他关键词。' : '尚无已登记任务。普通问答可以直接发送，需要持续处理时再开始新任务。'}</p>}</div>}
        {threadId && <button type="button" className="button secondary small-button" disabled={busy || previewing || !draft.trim()} onClick={() => void preview()}><Icon name="eye" size={14} />{previewing ? '正在核对…' : '核对当前消息的目标'}</button>}
      </>}
      {!!snapshot?.artifacts?.length && <details className="work-history-details"><summary>工作产物（{snapshot.artifacts.length}）</summary><ul>{snapshot.artifacts.slice(0, 12).map(artifact => <li key={artifact.id}>
        <span>{artifact.name ?? artifact.title ?? '工作产物'} · v{artifact.version} · {artifact.verificationStatus ?? artifactStatusLabels[artifact.status ?? ''] ?? artifact.status ?? '待核验'}</span>
        {mode === 'enforce' && !selection && active?.id === snapshot.focus?.taskId && active?.status === 'waiting_input' && artifact.status === 'current'
          && <button type="button" className="button secondary small-button work-accept-button" disabled={busy || cancelling || !!acceptingArtifact} onClick={() => void acceptArtifact(artifact)}>
            <Icon name="check" size={13} />{acceptingArtifact === artifact.id ? '正在确认…' : '确认此版本结果'}</button>}
      </li>)}</ul></details>}
      {!!snapshot?.decisions?.length && <details className="work-history-details"><summary>最近的目标识别记录</summary><ul>{snapshot.decisions.slice(0, 5).map((decision, index) => <li key={decision.id ?? index}>{decision.reason ?? decision.status ?? '已记录目标识别'}{decision.createdAt && <time>{dateTime(decision.createdAt)}</time>}</li>)}</ul></details>}
    </section>}
  </div>;
}
