import { useCallback, useEffect, useRef, useState } from 'react';
import { api, dateTime, enc, messageOf } from './api';
import { Icon } from './icons';
import type { Run, RunEvent } from './types';

type ActivityPage = { run: Run; events: RunEvent[]; nextAfter: number | null };
type ActivityRead = { runId: string; controller: AbortController; after: number; reading: boolean; pending: boolean };
type ActivityState = { runId: string; events: RunEvent[]; run?: Run; error?: string };

function mergeEvents(events: RunEvent[], additions: RunEvent[]) {
  if (!additions.length) return events;
  const bySequence = new Map(events.map(event => [event.seq, event]));
  for (const event of additions) bySequence.set(event.seq, event);
  return [...bySequence.values()].sort((a, b) => a.seq - b.seq);
}

export function useRunActivity(runId?: string) {
  const [state, setState] = useState<ActivityState>();
  const reader = useRef<ActivityRead | null>(null);

  const refresh = useCallback(async () => {
    const request = reader.current;
    if (!request || request.runId !== runId || request.controller.signal.aborted) return;
    request.pending = true;
    if (request.reading) return;
    request.reading = true;
    try {
      do {
        request.pending = false;
        let cursor = request.after;
        while (true) {
          const page = await api<ActivityPage>(`/api/runs/${enc(request.runId)}/activity?after=${cursor}`, {
            signal: request.controller.signal,
          });
          if (request.controller.signal.aborted) return;
          setState(current => current?.runId === request.runId ? {
            runId: request.runId,
            events: mergeEvents(current.events, page.events),
            run: page.run,
          } : current);
          request.after = page.events.at(-1)?.seq ?? cursor;
          if (page.nextAfter == null || page.nextAfter <= cursor) break;
          cursor = page.nextAfter;
        }
      } while (request.pending);
    } catch (error) {
      if (!request.controller.signal.aborted) {
        setState(current => current?.runId === request.runId ? { ...current, error: messageOf(error) } : current);
      }
    } finally {
      request.reading = false;
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    reader.current = { runId, controller, after: 0, reading: false, pending: false };
    setState({ runId, events: [] });
    void refresh();
    return () => {
      controller.abort();
      reader.current = null;
    };
  }, [runId, refresh]);

  const add = useCallback((event: RunEvent) => {
    if (!runId || !Number.isSafeInteger(event.seq) || event.seq < 1) return;
    setState(current => current?.runId === runId ? { ...current, events: mergeEvents(current.events, [event]) } : current);
  }, [runId]);

  const activity = state?.runId === runId ? state : undefined;
  return { events: activity?.events ?? [], run: activity?.run, error: activity?.error, refresh, add };
}

const activityStatus: Record<RunEvent['status'], string> = {
  started: '已开始', succeeded: '已完成', failed: '失败', denied: '已拒绝',
  interrupted: '已中断', unknown: '结果未知', awaiting_approval: '等待授权',
};
const activitySource: Record<RunEvent['source'], string> = { cloud: '云端容器', local: '本机', hosted: 'OpenAI' };
const activityKind: Record<RunEvent['kind'], string> = {
  task: '任务', command: '终端命令', file: '文件操作', tool: '工具', approval: '授权', verification: '验收命令',
};
const toolNames: Record<string, string> = { search: '联网搜索', image: '生成图片', analyze: '分析文件', ultra: 'Ultra 多代理' };
const eventTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function activityTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : eventTime.format(date);
}

function activityKey(event: RunEvent) {
  if (!event.itemId && event.kind !== 'task') return undefined;
  return `${event.source}:${event.kind}:${event.tool ?? ''}:${event.itemId ?? ''}`;
}

export function TaskActivity({ run, events, error, refresh }: {
  run: Run; events: RunEvent[]; error?: string; refresh: () => void;
}) {
  const logs = run.logs ?? [];
  if (!run.mode && !events.length && !logs.length) return null;
  const recordedOutcomes = new Map<string, number>();
  if (run.status !== 'running') {
    for (const event of events) {
      const key = activityKey(event);
      if (key && event.status !== 'started' && event.status !== 'awaiting_approval') recordedOutcomes.set(key, event.seq);
    }
  }
  return <details className="tool-activity" open={run.status === 'running'}>
    <summary><Icon name="terminal" size={15} /><span>执行活动</span><small>{events.length || logs.length} 条</small><Icon name="down" size={14} /></summary>
    {error && <div className="run-activity-note" role="alert"><span>{error}</span><button type="button" className="text-button" onClick={refresh}>重试</button></div>}
    {events.length > 0 && <ol className="run-event-list" aria-label="执行活动，最新在前">
      {[...events].reverse().map(event => {
        const key = activityKey(event);
        const hasOutcome = key && (recordedOutcomes.get(key) ?? 0) > event.seq;
        const unresolved = run.status !== 'running' && !hasOutcome && (event.status === 'started' || event.status === 'awaiting_approval');
        const status = unresolved ? 'unknown' : event.status;
        return <li key={event.seq}>
          <div className="run-event-heading">
            <strong>{event.tool && Object.hasOwn(toolNames, event.tool) ? toolNames[event.tool] : activityKind[event.kind]}</strong>
            <span className="run-event-source">{activitySource[event.source]}</span>
            <span className={`status-badge run-event-${status}`}>{unresolved && event.status === 'awaiting_approval' ? '授权已失效' : activityStatus[status]}</span>
            <time dateTime={event.createdAt} title={dateTime(event.createdAt)}>{activityTime(event.createdAt)}</time>
          </div>
          {event.summary && <div className="run-event-summary">{event.summary}</div>}
          {!!event.paths?.length && <ul className="run-event-paths" aria-label="本次工具事件报告的文件">
            {event.paths.map(path => <li key={path}><code>{path}</code></li>)}
          </ul>}
          {event.exitCode != null && <div className="run-event-summary">退出码 <code>{event.exitCode}</code></div>}
        </li>;
      })}
    </ol>}
    {events.length === 0 && logs.length === 0 && !error && <p className="run-activity-note">{run.status === 'running' ? '正在等待执行事件…' : '暂无执行活动。'}</p>}
    {logs.length > 0 && (events.length > 0 ? <details className="run-extra-logs">
      <summary>详细日志 <Icon name="down" size={14} /></summary><ActivityLogs logs={logs} />
    </details> : <ActivityLogs logs={logs} />)}
  </details>;
}

function ActivityLogs({ logs }: { logs: string[] }) {
  return <div className="tool-log">{logs.map((log, index) => <div key={index}><span className="tool-log-dot" /><pre>{log}</pre></div>)}</div>;
}

const executionStatus: Record<Run['status'], string> = { running: '执行中', completed: '执行完成', failed: '执行失败', interrupted: '执行中断' };
const verificationStatus = { not_run: '未运行', running: '验收中', passed: '验收通过', failed: '验收失败', unknown: '结果未知' };

export function VerificationCard({ run, onOpenDiff }: { run: Run; onOpenDiff?: () => void }) {
  if (run.mode !== 'cloud') return null;
  const check = run.verification;
  return <section className="run-verification" aria-label="任务验收">
    <div className="run-verification-heading">
      <Icon name="check" size={16} /><strong>验收结果</strong>
      <span className="status-badge">{executionStatus[run.status]}</span>
      <span className={`status-badge run-verification-${check?.status ?? 'unconfigured'}`}>{check ? verificationStatus[check.status] : '未配置'}</span>
    </div>
    {check && <div className="run-verification-evidence"><code>{check.command}</code>
      {check.exitCode != null && <span>退出码 <b>{check.exitCode}</b></span>}</div>}
    {onOpenDiff && <button type="button" className="text-button run-diff-link" onClick={onOpenDiff}><Icon name="diff" size={14} />工作区当前差异</button>}
  </section>;
}

export function PreviousTask({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const activity = useRunActivity(open ? runId : undefined);
  return <details className="previous-task" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Icon name="clock" size={15} />续跑前的任务记录<Icon name="down" size={14} /></summary>
    {open && (activity.run ? <>
      <VerificationCard run={activity.run} />
      <TaskActivity run={activity.run} events={activity.events} error={activity.error} refresh={activity.refresh} />
    </> : activity.error ? <div className="run-activity-note" role="alert">{activity.error}<button type="button" className="text-button" onClick={activity.refresh}>重试</button></div>
      : <p className="run-activity-note">正在加载任务记录…</p>)}
  </details>;
}
