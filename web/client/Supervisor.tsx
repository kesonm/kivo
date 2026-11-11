import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api, dateTime, enc, messageOf } from './api';
import { Markdown } from './ChatContent';
import { Icon } from './icons';
import { ErrorBox, Loading, Modal } from './ui';
import type { SupervisorDetail, SupervisorSnapshot, SupervisorTask } from './types';
import './supervisor.css';

const eventLabels: Record<string, string> = { task: '任务状态更新', command: '命令执行', file: '文件操作', tool: '工具调用', approval: '操作授权' };
const phaseLabels: Record<string, string> = { started: '已开始', succeeded: '已完成', failed: '失败', interrupted: '已停止', unknown: '待核对', awaiting_approval: '等待授权', denied: '已拒绝' };

export function useSupervisor(userId: string | undefined, revision: number) {
  const [value, setValue] = useState<{ userId: string; data: SupervisorSnapshot } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry(value => value + 1), []);
  useEffect(() => {
    setError('');
    if (!userId) { setValue(null); return; }
    const controller = new AbortController();
    let pending = false;
    const load = async () => {
      if (pending || document.hidden || controller.signal.aborted) return;
      pending = true;
      try {
        const data = await api<SupervisorSnapshot>('/api/kibot/tasks', { signal: controller.signal });
        if (!controller.signal.aborted) {
          setValue(old => old?.userId === userId && old.data.revision === data.revision ? old : { userId, data });
          setError('');
        }
      } catch (error) { if (!controller.signal.aborted) setError(messageOf(error)); }
      finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    const wake = () => void load();
    window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  }, [userId, revision, retry]);
  return { data: value && value.userId === userId ? value.data : null, error, refresh };
}

export function taskStatus(task: Pick<SupervisorTask, 'status' | 'queueStatus'>) {
  if (task.queueStatus === 'queued') return '排队中';
  if (task.queueStatus === 'dispatching') return '正在启动';
  const labels: Record<string, string> = { ready: '待执行', running: '执行中', waiting_input: '待查看结果', waiting_approval: '需要授权',
    paused: '已暂停', succeeded: '验收通过', failed: '执行失败', cancelled: '已取消', needs_reconciliation: '需核对结果', completed: '执行结束' };
  if (['failed', 'cancelled', 'needs_reconciliation'].includes(task.queueStatus)) return labels[task.queueStatus];
  return labels[task.status] ?? labels[task.queueStatus] ?? '待核对状态';
}
export function taskPriority(task: Pick<SupervisorTask, 'status' | 'queueStatus' | 'needsAttention'>) {
  if (task.needsAttention) return 0;
  if (task.queueStatus === 'queued') return 2;
  if (['running', 'dispatching'].includes(task.queueStatus) || task.status === 'running') return 1;
  if (task.queueStatus === 'queued' || task.status === 'ready') return 2;
  return 3;
}

const attentionLabels = { failed: '执行失败', result: '结果待查看', approval: '需要授权', reconciliation: '执行结果待核对', input: '需要补充信息' };
const attentionHints = {
  failed: '可以重试这项任务、放弃继续执行，或先确认这次提醒。',
  result: '打开任务会话查看完整结果；确认已读后可收起本次提醒。',
  approval: '请打开任务会话，确认或拒绝具体的执行请求。',
  reconciliation: '执行是否停止以及已有操作结果尚需核对，请打开任务会话处理。',
  input: '请打开任务会话补充信息，或和 kibot 讨论下一步。',
};

export function AttentionDialog({ tasks, onClose, onSelect }: {
  tasks: SupervisorTask[]; onClose: () => void; onSelect: (task: SupervisorTask) => void;
}) {
  const pending = tasks.filter(task => task.needsAttention === true);
  return <Modal title="需要你处理" description="查看待处理事项，并选择下一步。" onClose={onClose}>
    <div className="nav-dialog-body supervisor-attention-list">
      {pending.map(task => <TaskCard key={task.id} task={task} onOpen={value => onSelect(value)} />)}
      {!pending.length && <p className="nav-empty" role="status">当前没有待处理事项。</p>}
    </div>
  </Modal>;
}

export function TaskCard({ task, onOpen }: { task: SupervisorTask; onOpen: (task: SupervisorTask, trigger: HTMLButtonElement) => void }) {
  const title = task.conversationTitle || task.goal;
  return <button type="button" className="supervisor-task-card" data-needs-attention={task.needsAttention || undefined} onClick={event => onOpen(task, event.currentTarget)} aria-label={`查看任务：${title}`}>
    <span className="supervisor-card-heading"><Icon name={task.projectId ? 'code' : 'chat'} size={16} /><strong>{title}</strong><span className="supervisor-status">{taskStatus(task)}</span></span>
    <span className="supervisor-card-project">{task.projectName || '独立文字任务'}</span>
    {task.summary && <span className="supervisor-card-summary">{task.summary}</span>}
    {task.pendingFollowUp && <span className="supervisor-card-project">已收到补充要求，等待当前执行结束</span>}
    {task.attention?.acknowledged && <span className="supervisor-card-project">{task.attention.kind === 'failed' ? '已知晓这次失败' : '已查看本次结果'}</span>}
    <span className="supervisor-card-link">查看任务<Icon name="arrow" size={14} /></span>
  </button>;
}

export function TaskPanel({ task, revision, overlay, returnFocus, onClose, onReference, onOpenConversation, onRefresh }: {
  task: SupervisorTask; revision?: string | number; overlay: boolean; returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void; onReference: (task: SupervisorTask) => void; onOpenConversation: (task: SupervisorTask) => void; onRefresh: () => void;
}) {
  const [detail, setDetail] = useState<SupervisorDetail | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [busyAction, setBusyAction] = useState<'stop' | 'retry' | 'ack' | null>(null);
  const busy = busyAction !== null;
  const actionPending = useRef(false);
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');
  const panel = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(true);
  const alive = useRef(true), closeAction = useRef(onClose); closeAction.current = onClose;
  useEffect(() => {
    alive.current = true;
    close.current?.focus();
    const trigger = returnFocus.current;
    return () => { alive.current = false; requestAnimationFrame(() => { if (restoreFocus.current && trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus(); }); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<SupervisorDetail>(`/api/kibot/tasks/${enc(task.id)}`, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) { setDetail(data); setError(''); }
    }).catch(error => { if (!controller.signal.aborted) setError(messageOf(error)); });
    return () => controller.abort();
  }, [task.id, revision, retry]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); closeAction.current(); }
      if (!overlay || event.key !== 'Tab' || !panel.current) return;
      const controls = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,textarea,[tabindex="0"]')).filter(el => el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); panel.current.focus(); return; }
      const inside = controls.includes(document.activeElement as HTMLElement);
      if (event.shiftKey && (!inside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (!inside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [overlay]);
  const current = detail?.task ?? task;
  const artifacts = detail?.artifacts ?? current.artifacts ?? [];
  const attention = current.attention;
  const canRetry = attention?.canRetry === true;
  const canAbandon = attention?.canAbandon === true;
  const canDismiss = attention?.canDismiss === true && !attention.acknowledged;
  const stoppable = ['queued', 'dispatching', 'running'].includes(current.queueStatus) || ['running', 'waiting_approval'].includes(current.status);
  async function act(action: 'stop' | 'retry' | 'ack') {
    if (actionPending.current || action === 'retry' && !canRetry || action === 'ack' && !canDismiss) return;
    actionPending.current = true; setBusyAction(action); setActionError(''); setActionNotice('');
    try {
      const result = await api<{ task: SupervisorTask; warning?: string }>(`/api/kibot/tasks/${enc(task.id)}/${action}`, {
        method: 'POST', body: { expectedVersion: current.version, ...(action === 'stop' ? {} : { eventKey: attention?.key }) },
      });
      if (alive.current) {
        setDetail(previous => ({ ...previous, task: result.task }));
        setActionNotice(result.warning || (action === 'ack' ? attention?.kind === 'failed' ? '已知晓这次失败。任务仍保留失败状态，可稍后重试。' : '已确认查看本次结果。' : action === 'retry' ? '任务已加入重试队列。' : '任务已停止继续执行。'));
        onRefresh(); setRetry(value => value + 1);
      }
    } catch (error) {
      if (alive.current) { setActionError(messageOf(error)); onRefresh(); setRetry(value => value + 1); }
    } finally { actionPending.current = false; if (alive.current) setBusyAction(null); }
  }
  return <>
    {overlay && <button className="kibot-history-backdrop" tabIndex={-1} aria-label="关闭任务详情" onClick={onClose} />}
    <aside ref={panel} className={'kibot-history-panel supervisor-panel' + (overlay ? ' kibot-history-overlay' : '')} role="dialog" aria-modal={overlay || undefined} aria-labelledby="supervisor-panel-title" tabIndex={-1}>
      <header className="kibot-history-header"><div><p className="supervisor-eyebrow">kibot 安排的任务</p><h2 id="supervisor-panel-title">{current.conversationTitle || current.goal}</h2><p className="kibot-history-subtitle">{current.projectName || '独立文字任务'} · {taskStatus(current)}</p></div><button ref={close} className="icon-button" aria-label="关闭任务详情" onClick={onClose}><Icon name="close" /></button></header>
      <div className="kibot-history-scroll supervisor-detail-scroll">
        {error && <ErrorBox error={error} onRetry={() => setRetry(value => value + 1)} />}
        {!detail && !error && <Loading label="读取任务进展…" />}
        {attention && <section className={'supervisor-attention-detail' + (attention.acknowledged ? ' acknowledged' : '')}>
          <h3>{attention.acknowledged ? attention.kind === 'failed' ? '已知晓失败' : '已查看结果' : attentionLabels[attention.kind]}</h3>
          <p>{attention.acknowledged ? attention.kind === 'failed' ? '失败记录已保留，可以稍后重试或放弃任务。' : '原始结果与验收状态保留在任务会话中。' : attentionHints[attention.kind]}</p>
        </section>}
        <section className="supervisor-detail-section"><h3>任务目标</h3><p>{current.goal}</p></section>
        {current.summary && <section className="supervisor-detail-section"><h3>最新进展</h3><Markdown content={current.summary} /></section>}
        {current.result && <section className="supervisor-detail-section"><h3>结果摘录</h3><Markdown content={current.result} /></section>}
        {artifacts.length > 0 && <section className="supervisor-detail-section"><h3>工作产物</h3>{artifacts.map(artifact => <div className="supervisor-artifact" key={artifact.id}><Icon name="file" size={16} /><span>{artifact.name || artifact.title || '工作结果'}{artifact.version != null && <small>v{artifact.version}{artifact.status === 'stale' ? ' · 已有后续变化' : ''}</small>}</span></div>)}<p className="supervisor-detail-hint">打开任务会话，查看完整产物与验收记录。</p></section>}
        {!!detail?.events?.length && <section className="supervisor-detail-section"><h3>执行记录</h3><ol className="supervisor-events">{detail.events.map((event, index) => <li key={event.id ?? index}>{event.createdAt && <time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time>}<span>{event.summary || eventLabels[event.kind ?? ''] || '执行状态更新'}{!event.summary && event.status ? ` · ${phaseLabels[event.status] ?? event.status}` : ''}</span></li>)}</ol></section>}
        <p className="supervisor-detail-hint">最后更新 {dateTime(current.updatedAt)}。执行结束后，可在任务会话查看检查结果。</p>
      </div>
      <div className="supervisor-panel-actions">
        {actionError && <ErrorBox error={actionError} />}
        {actionNotice && <p className="supervisor-action-notice" role="status">{actionNotice}</p>}
        {(canRetry || canAbandon || canDismiss) && <div className="supervisor-resolution-actions" aria-label="处理任务提醒">
          {canRetry && <button className="button primary" disabled={busy} onClick={() => void act('retry')}><Icon name="refresh" size={15} />{busyAction === 'retry' ? '正在重试…' : '重试任务'}</button>}
          {canAbandon && <button className="button secondary supervisor-abandon" disabled={busy} onClick={() => void act('stop')}>{busyAction === 'stop' ? '正在放弃…' : '放弃任务'}</button>}
          {canDismiss && <button className="button secondary" disabled={busy} onClick={() => void act('ack')}>{busyAction === 'ack' ? '正在确认…' : '知道了'}</button>}
        </div>}
        <button className={'button ' + (canRetry ? 'secondary' : 'primary')} disabled={busy} onClick={() => { restoreFocus.current = false; onReference(current); }}><Icon name="chat" size={15} />和 kibot 讨论这项任务</button>
        <button className="button secondary" onClick={() => onOpenConversation(current)}>打开任务会话<Icon name="arrow" size={15} /></button>
        {stoppable && <button className="text-button supervisor-stop" disabled={busy} onClick={() => void act('stop')}>{busyAction === 'stop' ? '正在停止…' : current.queueStatus === 'queued' ? '取消排队' : '停止执行'}</button>}
      </div>
    </aside>
  </>;
}

export function MemoryDialog({ onClose }: { onClose: () => void }) {
  type Note = { id: string; kind: 'decision' | 'constraint' | 'preference' | 'todo'; text: string; sourceMessageId: string; sourceExcerpt?: string; createdAt: string; updatedAt: string };
  const [data, setData] = useState<{ notes: Note[]; history: { messages: number; archivedMessages: number } } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<NonNullable<typeof data>>('/api/kibot/memory', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setData(value); setError(''); }
    }).catch(error => { if (!controller.signal.aborted) setError(messageOf(error)); });
    return () => controller.abort();
  }, [retry]);
  async function forget(note: Note) {
    if (removing) return;
    setRemoving(note.id); setError('');
    try {
      await api(`/api/kibot/memory/${enc(note.id)}`, { method: 'DELETE' });
      if (alive.current) setRetry(value => value + 1);
    } catch (error) { if (alive.current) setError(messageOf(error)); }
    finally { if (alive.current) setRemoving(null); }
  }
  const labels = { decision: '决定', constraint: '工作约束', preference: '偏好', todo: '待办' };
  return <Modal title="工作记忆" description="kibot 根据你的对话记录的工作要点。你可以要求记住、更正或忘记某件事。" onClose={onClose}>
    <div className="nav-dialog-body supervisor-memory">
      {error && <ErrorBox error={error} onRetry={() => setRetry(value => value + 1)} />}
      {!data && !error && <Loading label="读取工作记忆…" />}
      {data?.notes.map(note => <article key={note.id} className="supervisor-memory-note"><div><span>{labels[note.kind] || '工作要点'}</span><time dateTime={note.updatedAt}>{dateTime(note.updatedAt)}</time></div><p>{note.text}</p>{note.sourceExcerpt&&<details><summary>查看原话摘录</summary><p>{note.sourceExcerpt}</p></details>}<button className="text-button" disabled={!!removing} onClick={() => void forget(note)}>{removing === note.id ? '正在移除…' : '从工作记忆移除'}</button></article>)}
      {data && !data.notes.length && <p className="nav-empty">还没有保存的工作要点。可以告诉 kibot：“记住这项要求……”</p>}
      <p className="supervisor-detail-hint">工作记忆与原始历史分别保存。移除要点后，原始对话仍可从时间摘要中查看。</p>
      {data?.history && <p className="supervisor-detail-hint">主会话保留 {data.history.messages} 条原始记录。</p>}
    </div>
  </Modal>;
}
