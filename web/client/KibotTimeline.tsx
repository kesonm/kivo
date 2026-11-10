import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api, enc, messageOf } from './api';
import { AttachmentChips, ChatImages, Markdown } from './ChatContent';
import { Icon, Logo } from './icons';
import { ErrorBox, Loading } from './ui';
import type { Message, User } from './types';

export interface KibotSummary {
  id: string;
  kind: 'day' | 'segment';
  date: string;
  startAt: string;
  endAt: string;
  title: string;
  bullets: string[];
  messageCount: number;
  segmentCount: number;
  source: 'extractive';
}

interface KibotTimelinePage {
  threadId: string;
  summaries: KibotSummary[];
  activeMessageIds: string[];
  nextBefore: string | null;
  serverNow: string;
}

interface KibotHistoryPage {
  messages: Message[];
  nextCursor: string | null;
  total: number;
}

export function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function dateInZone(value: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map(name => parts.find(part => part.type === name)?.value).join('-');
}

function timeLabel(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

function dateLabel(date: string, now: string, timeZone: string) {
  const today = dateInZone(now, timeZone);
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const [, month, day] = date.split('-');
  const prefix = date === today ? '今天 · ' : date === yesterday ? '昨天 · ' : '';
  return `${prefix}${date.slice(0, 4) !== today.slice(0, 4) ? `${date.slice(0, 4)}年` : ''}${Number(month)}月${Number(day)}日`;
}

export function useKibotTimeline(threadId: string | null, userId: string, enabled: boolean, revision: string) {
  const [timeZone] = useState(browserTimeZone);
  const [data, setData] = useState<KibotTimelinePage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const request = useRef(0);
  const dataRef = useRef(data); dataRef.current = data;
  const loadingMoreRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || !threadId) return;
    const identity = generation.current;
    const sequence = ++request.current;
    if (!dataRef.current) setLoading(true);
    try {
      const page = await api<KibotTimelinePage>(`/api/kibot/timeline?timeZone=${enc(timeZone)}&limit=20`);
      if (generation.current !== identity || sequence !== request.current || page.threadId !== threadId) return;
      setData(previous => {
        // Keep explicitly loaded older days while refreshing the current page.
        // Replaced same-day segments disappear when a day is rolled up.
        const oldest = page.summaries.at(-1);
        const older = page.nextBefore && oldest ? previous?.summaries.filter(item => item.kind === 'day' && item.date < oldest.date) ?? [] : [];
        const ids = new Set(page.summaries.map(item => item.id));
        return { ...page, summaries: [...page.summaries, ...older.filter(item => !ids.has(item.id))], nextBefore: older.length ? previous!.nextBefore : page.nextBefore };
      });
      setError('');
    } catch (cause) {
      if (generation.current === identity && sequence === request.current) setError(messageOf(cause));
    } finally {
      if (generation.current === identity && sequence === request.current) setLoading(false);
    }
  }, [enabled, threadId, timeZone]);

  useEffect(() => {
    ++generation.current; ++request.current;
    setData(null); dataRef.current = null; setError(''); setLoading(false); setLoadingMore(false); loadingMoreRef.current = false;
    return () => { ++generation.current; ++request.current; };
  }, [threadId, userId, enabled]);

  useEffect(() => {
    if (!enabled || !threadId) return;
    void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(onVisible, 30_000);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled, threadId, refresh, revision]);

  const loadMore = useCallback(async () => {
    const before = dataRef.current?.nextBefore;
    if (!before || loadingMoreRef.current || !enabled || !threadId) return;
    const identity = generation.current;
    loadingMoreRef.current = true; setLoadingMore(true);
    try {
      const page = await api<KibotTimelinePage>(`/api/kibot/timeline?timeZone=${enc(timeZone)}&limit=20&before=${enc(before)}`);
      if (generation.current !== identity || page.threadId !== threadId) return;
      setData(previous => {
        if (!previous || previous.nextBefore !== before) return previous;
        const ids = new Set(previous.summaries.map(item => item.id));
        return { ...previous, summaries: [...previous.summaries, ...page.summaries.filter(item => !ids.has(item.id))], nextBefore: page.nextBefore };
      });
      setError('');
    } catch (cause) { if (generation.current === identity) setError(messageOf(cause)); }
    finally { if (generation.current === identity) { setLoadingMore(false); loadingMoreRef.current = false; } }
  }, [enabled, threadId, timeZone]);

  return { data, error, loading, loadingMore, refresh, loadMore, timeZone };
}

export function KibotSummaryList({ timeline, selectedId, onOpen, onBeforeLoadMore }: {
  timeline: ReturnType<typeof useKibotTimeline>;
  selectedId?: string;
  onOpen: (summary: KibotSummary, trigger: HTMLButtonElement) => void;
  onBeforeLoadMore?: () => void;
}) {
  const { data, error, loading, loadingMore, refresh, loadMore, timeZone } = timeline;
  if (!data) return error ? <ErrorBox error={error} onRetry={() => void refresh()} /> : <Loading label="正在整理主会话…" />;
  const summaries = [...data.summaries].reverse();
  return <div className="kibot-timeline" aria-label="kibot 历史摘要" aria-busy={loading}>
    <p className="kibot-timeline-note"><Icon name="clock" size={14} />空闲 1 小时后整理为摘要，跨日按天归档</p>
    {data.nextBefore && <button className="kibot-load-more" disabled={loadingMore} onClick={() => { onBeforeLoadMore?.(); void loadMore(); }}>{loadingMore ? '正在加载…' : '查看更早的摘要'}<Icon name="up" size={14} /></button>}
    {error && <ErrorBox error={error} onRetry={() => void refresh()} />}
    {summaries.map((summary, index) => <div className="kibot-summary-group" key={summary.id}>
      {(index === 0 || summaries[index - 1].date !== summary.date) && <h2 className="kibot-date-heading">{dateLabel(summary.date, data.serverNow, timeZone)}</h2>}
      <button type="button" data-kibot-summary-id={summary.id} className={'kibot-summary-card' + (selectedId === summary.id ? ' selected' : '')} aria-expanded={selectedId === summary.id} aria-controls={selectedId === summary.id ? 'kibot-history-panel' : undefined} onClick={event => onOpen(summary, event.currentTarget)}>
        <span className="kibot-summary-meta"><Icon name={summary.kind === 'day' ? 'file' : 'clock'} size={16} /><span>{summary.kind === 'day' ? '全天摘要' : `${timeLabel(summary.startAt, timeZone)}–${timeLabel(summary.endAt, timeZone)}`}</span><small className="kibot-summary-extract">原文摘录</small></span>
        <strong>{summary.title}</strong>
        <span className="kibot-summary-bullets">{summary.bullets.map((bullet, bulletIndex) => <span key={bulletIndex}>{bullet}</span>)}</span>
        <span className="kibot-summary-footer"><span><Icon name="chat" size={14} />{summary.kind === 'day' ? `${summary.segmentCount} 段对话 · ` : ''}{summary.messageCount} 条消息</span><span>{summary.kind === 'day' ? '查看全天记录' : '查看详情'}<Icon name="arrow" size={15} /></span></span>
      </button>
    </div>)}
  </div>;
}

export function useHistoryOverlay() {
  const [overlay, setOverlay] = useState(() => window.matchMedia('(max-width: 1100px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const change = () => setOverlay(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return overlay;
}

export function KibotHistoryPanel({ summary, timeZone, user, overlay, onClose, returnFocus }: {
  summary: KibotSummary;
  timeZone: string;
  user: User;
  overlay: boolean;
  onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [total, setTotal] = useState(summary.messageCount);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const loadingRef = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;

  const load = useCallback(async (cursor?: string) => {
    if (loadingRef.current) return;
    const current = ++sequence.current;
    loadingRef.current = true; setLoading(true); setError('');
    try {
      const page = await api<KibotHistoryPage>(`/api/kibot/history?summaryId=${enc(summary.id)}&timeZone=${enc(timeZone)}&limit=50${cursor ? `&cursor=${enc(cursor)}` : ''}`);
      if (sequence.current !== current) return;
      setMessages(previous => {
        if (!cursor) return page.messages;
        const ids = new Set(previous.map(message => message.id));
        return [...previous, ...page.messages.filter(message => !ids.has(message.id))];
      });
      setTotal(page.total); setNextCursor(page.nextCursor);
    } catch (cause) { if (sequence.current === current) setError(messageOf(cause)); }
    finally { if (sequence.current === current) { loadingRef.current = false; setLoading(false); } }
  }, [summary.id, timeZone]);

  useEffect(() => {
    void load();
    return () => { ++sequence.current; loadingRef.current = false; };
  }, [load]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => close.current?.focus({ preventScroll: true }));
    return () => { window.cancelAnimationFrame(frame); const trigger = returnFocus.current; if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, [returnFocus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (panel.current?.closest('[inert]') || document.querySelector('[role="dialog"][aria-modal="true"]:not(#kibot-history-panel)')) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !overlay || !panel.current) return;
      const elements = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]')).filter(element => element.getClientRects().length > 0);
      const first = elements[0], last = elements.at(-1);
      if (!first || !last) { event.preventDefault(); panel.current.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [overlay]);

  const title = `${Number(summary.date.slice(5, 7))}月${Number(summary.date.slice(8, 10))}日 · ${summary.kind === 'day' ? '全天记录' : '对话记录'}`;
  return <>
    {overlay && <button type="button" className="kibot-history-backdrop" tabIndex={-1} aria-label="关闭历史详情" onClick={onClose} />}
    <aside ref={panel} className="kibot-history-panel" id="kibot-history-panel" role="dialog" aria-modal={overlay || undefined} aria-labelledby="kibot-history-title" tabIndex={-1}>
      <header className="kibot-history-header"><div><h2 id="kibot-history-title">{title}</h2><p className="kibot-history-subtitle">kibot · {summary.segmentCount} 段对话 · {total} 条消息</p></div><button ref={close} type="button" className="icon-button" aria-label="关闭历史详情" onClick={onClose}><Icon name="close" size={20} /></button></header>
      <p className="kibot-history-note">完整原始记录 · 只读</p>
      <div className="kibot-history-scroll">
        {messages.map(message => <article className={'kibot-history-message chat-message message-' + message.role} key={message.id}>
          <time className="kibot-history-time" dateTime={message.createdAt}>{timeLabel(message.createdAt, timeZone)}</time>
          <div className={'message-avatar' + (message.role === 'assistant' ? ' assistant-avatar logo-container' : '')}>{message.role === 'assistant' ? <Logo /> : message.role === 'user' ? (user.displayName || user.username).slice(0, 1).toUpperCase() : <Icon name="info" size={16} />}</div>
          <div className="message-main"><span className="sr-only">{message.role === 'assistant' ? 'kibot' : message.role === 'user' ? user.displayName || user.username : '系统'}</span>
            {!!message.attachments?.length && <AttachmentChips files={message.attachments} />}
            {message.role === 'user' ? message.content && <div className="user-message-content">{message.content}</div> : <Markdown content={message.content} citations={message.citations} />}
            {!!message.artifacts?.length && <ChatImages artifacts={message.artifacts} onLoad={() => undefined} />}
          </div>
        </article>)}
        {loading && <Loading label="正在读取原始记录…" />}
        {error && <ErrorBox error={error} onRetry={() => void load(messages.length && nextCursor ? nextCursor : undefined)} />}
        {!loading && !error && !messages.length && <p className="kibot-history-empty">这个时间段暂无消息。</p>}
        {nextCursor && <button className="kibot-load-more" disabled={loading} onClick={() => void load(nextCursor)}>继续查看记录<Icon name="down" size={14} /></button>}
        {!loading && !nextCursor && messages.length > 0 && <p className="kibot-history-end">已显示全部 {total} 条消息</p>}
      </div>
    </aside>
  </>;
}
