import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { api, dateTime, enc, messageOf } from './api';
import { Icon, Logo } from './icons';
import { getDirtyFile } from './navigation';
import { Files } from './Files';
import { ErrorBox, Loading, StatusBadge, useDialog, useNotice } from './ui';
import type { Message, Project, Run, Thread, User } from './types';

function Markdown({ content }: { content: string }) {
  return <div className="markdown"><ReactMarkdown components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}>{content}</ReactMarkdown></div>;
}
const starters = [
  { icon: 'code', title: '从零构建', text: '帮我创建一个简洁的项目起始结构，并说明如何运行。' },
  { icon: 'search', title: '了解项目', text: '阅读这个项目，梳理目录结构、主要功能和可以改进的地方。' },
  { icon: 'diff', title: '检查代码', text: '检查当前项目代码，找出潜在问题并提出具体的修复方案。' },
];
const chatStarters = [
  { icon: 'info', title: '解释一个概念', text: '我想学习一个新概念。请先问我感兴趣的主题，再用容易理解的方式解释。' },
  { icon: 'chat', title: '整理思路', text: '帮我梳理一个想法。请先问我想解决的问题和目前的思路。' },
  { icon: 'edit', title: '润色文字', text: '我想润色一段文字。请先问我文字的用途和希望的语气。' },
];

export function Workspace({ project, threadId, onThreadCreated, onThreadsChanged, user, providerConfigured, model, refreshSession, onRenameProject, onDeleteProject, onOpenAccount }: {
  project: Project | null; threadId: string | null; onThreadCreated: (thread: Thread) => void; onThreadsChanged: () => void;
  user: User; providerConfigured: boolean; model?: string; refreshSession: () => Promise<void>;
  onRenameProject: () => void; onDeleteProject: () => void; onOpenAccount: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [title, setTitle] = useState('新的对话');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [connectionLost, setConnectionLost] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [projectMenu, setProjectMenu] = useState(false);
  const [revision, setRevision] = useState(0);
  const [scrolledUp, setScrolledUp] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pinBottom = useRef(true);
  const threadRef = useRef(threadId); threadRef.current = threadId;
  const newlyCreatedThread = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const mounted = useRef(true);
  const sendingRef = useRef(false);
  const notify = useNotice(); const ask = useDialog();
  const running = run?.status === 'running';
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++loadSequence.current; };
  }, []);
  const loadThread = useCallback(async (id: string, initial = false) => {
    const sequence = ++loadSequence.current;
    if (initial) setLoading(true);
    try {
      const result = await api<{ thread: Thread; messages: Message[]; run: Run | null }>(`/api/threads/${enc(id)}`);
      if (!mounted.current || sequence !== loadSequence.current || threadRef.current !== id) return;
      setMessages(result.messages); setRun(result.run); setTitle(result.thread.title); setError('');
    } catch (e) { if (mounted.current && sequence === loadSequence.current) setError(messageOf(e)); }
    finally { if (mounted.current && sequence === loadSequence.current) setLoading(false); }
  }, []);
  useEffect(() => {
    pinBottom.current = true; setError(''); setConnectionLost(false);
    if (threadId !== newlyCreatedThread.current) setInput('');
    newlyCreatedThread.current = null; setRun(null); setMessages([]); setTitle('新的对话');
    if (threadId) void loadThread(threadId, true);
    else { ++loadSequence.current; setLoading(false); }
  }, [threadId, loadThread]);
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const runId = run.id; const currentThreadId = run.threadId;
    const source = new EventSource(`/api/runs/${enc(runId)}/events`, { withCredentials: true });
    let finished = false;
    const safely = (handler: (data: any) => void) => (event: MessageEvent) => { if (finished || !mounted.current || threadRef.current !== currentThreadId) return; try { handler(JSON.parse(event.data)); } catch { /* Reconnect will restore the persisted snapshot. */ } };
    source.addEventListener('snapshot', safely((snapshot: Run) => {
      setConnectionLost(false); setRun(old => old?.id === runId ? { ...old, ...snapshot, logs: snapshot.logs || [] } : old);
      if (snapshot.status !== 'running' && !finished) {
        finished = true; source.close(); setStopping(false); void loadThread(currentThreadId); void refreshSession().catch(() => undefined); onThreadsChanged(); setRevision(old => old + 1);
      }
    }));
    source.addEventListener('message', safely(data => {
      setConnectionLost(false);
      if (data.type === 'delta') setRun(old => old?.id === runId ? { ...old, output: (old.output || '') + (data.text || '') } : old);
      else if (data.type === 'tool') setRun(old => old?.id === runId ? { ...old, logs: [...(old.logs || []), String(data.text || '')].slice(-150) } : old);
      else if (data.type === 'status' && data.message) setRun(old => old?.id === runId ? { ...old, logs: [...(old.logs || []), String(data.message)].slice(-150) } : old);
    }));
    source.addEventListener('usage', () => { if (!finished) void refreshSession().catch(() => undefined); });
    source.addEventListener('done', safely(data => {
      if (finished) return; finished = true; source.close(); setConnectionLost(false); setStopping(false);
      setRun(old => old?.id === runId ? { ...old, status: data.status, error: data.message || old.error } : old);
      if (data.status === 'failed' && data.message) notify(data.message, 'error');
      void loadThread(currentThreadId); void refreshSession().catch(() => undefined); onThreadsChanged(); setRevision(old => old + 1);
    }));
    source.onopen = () => { if (!finished && mounted.current) setConnectionLost(false); };
    source.onerror = () => {
      if (finished) return;
      setConnectionLost(true);
      void api<{ thread: Thread; messages: Message[]; run: Run | null }>(`/api/threads/${enc(currentThreadId)}`).then(result => {
        if (finished || !mounted.current || threadRef.current !== currentThreadId || result.run?.status === 'running') return;
        finished = true; source.close(); setMessages(result.messages); setRun(result.run); setConnectionLost(false); setStopping(false); setRevision(old => old + 1); void refreshSession().catch(() => undefined); onThreadsChanged();
      }).catch(() => undefined);
    };
    return () => { finished = true; source.close(); };
  }, [run?.id, run?.status, loadThread, onThreadsChanged, refreshSession, notify]);
  useEffect(() => {
    if (pinBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, run?.output, run?.logs?.length, loading]);
  useEffect(() => { if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${Math.min(160, textarea.current.scrollHeight)}px`; } }, [input]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || sendingRef.current || loading || running || !providerConfigured) return;
    sendingRef.current = true; setSending(true);
    try {
      if (project && getDirtyFile() && !await ask({ title: '使用已保存的文件开始任务？', description: `${getDirtyFile()} 尚有未保存的编辑。kivo 将使用服务器上已保存的文件版本。你也可以取消并先保存文件。`, confirm: '使用已保存的版本' })) return;
      if (!mounted.current) return;
      setError(''); pinBottom.current = true;
      let id = threadId;
      if (!id) {
        const created = await api<{ thread: Thread }>(project ? `/api/projects/${enc(project.id)}/threads` : '/api/threads', { method: 'POST', body: { title: text.slice(0, 60) } });
        id = created.thread.id;
        if (mounted.current) { threadRef.current = id; newlyCreatedThread.current = id; }
        onThreadCreated(created.thread);
      }
      const result = await api<{ run: Run }>(`/api/threads/${enc(id)}/turns`, { method: 'POST', body: { text } });
      onThreadsChanged();
      if (!mounted.current || threadRef.current !== id) return;
      setInput(''); setRun(result.run); await loadThread(id); void refreshSession().catch(() => undefined);
    } catch (e) { if (mounted.current) setError(messageOf(e)); else onThreadsChanged(); }
    finally { sendingRef.current = false; if (mounted.current) { setSending(false); textarea.current?.focus(); } }
  }
  async function interrupt() {
    if (!run || stopping) return;
    setStopping(true);
    try { await api(`/api/runs/${enc(run.id)}/interrupt`, { method: 'POST' }); notify('已发送停止请求', 'info'); }
    catch (e) { notify(messageOf(e), 'error'); if (mounted.current) setStopping(false); }
  }
  async function copy(content: string) {
    try { await navigator.clipboard.writeText(content); notify('已复制'); }
    catch { notify('无法访问剪贴板，请手动选择文本复制。', 'error'); }
  }
  async function closePanel() { setPanelOpen(false); }
  async function changePanel(nextOpen: boolean) {
    if (!project) return;
    if (!nextOpen && panelOpen && getDirtyFile() && !await ask({ title: '关闭未保存的文件？', description: `${getDirtyFile()} 的编辑尚未保存，关闭面板后将丢失。`, confirm: '放弃修改并关闭', danger: true })) return;
    setPanelOpen(nextOpen);
  }
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const showRunOutput = run && (running || (!!run.output && lastAssistant?.content !== run.output));
  const emptyConversation = !loading && messages.length === 0 && !running;
  const composer = <div className="composer-area">
    {scrolledUp && !emptyConversation && <button className="scroll-bottom" onClick={() => { pinBottom.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }}><Icon name="down" size={16} />回到最新消息</button>}
    {connectionLost && <div className="connection-note"><span className="spinner" />连接已断开，正在自动恢复任务状态…</div>}
    {error && <ErrorBox error={error} onRetry={threadId ? () => void loadThread(threadId, true) : undefined} />}
    <form className={'composer' + (project ? '' : ' composer-chat') + (running ? ' composer-running' : '')} onSubmit={send}>
      <div className="composer-input-row">
        {project && <button type="button" className="icon-button composer-attach" title="项目文件、上传与代码差异" aria-label="打开项目文件" onClick={() => void changePanel(true)}><Icon name="plus" size={23} /></button>}
        <textarea ref={textarea} value={input} onChange={event => setInput(event.target.value)} placeholder={running ? 'kivo 正在执行任务…' : '有问题，尽管问'} aria-label="发送给 kivo 的消息" disabled={loading || sending || running} maxLength={24000} rows={1} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <span className="composer-model" title="当前模型">{model || '默认模型'}</span>
        {running ? <button type="button" className="send-button stop-button" title="停止任务" aria-label="停止任务" disabled={stopping} onClick={() => void interrupt()}>{stopping ? <span className="spinner" /> : <Icon name="stop" size={17} />}</button> : <button type="submit" className="send-button" title="发送消息" aria-label="发送消息" disabled={!input.trim() || sending || loading || !providerConfigured}>{sending ? <span className="spinner" /> : <Icon name="send" size={21} />}</button>}
      </div>
    </form>
    <div className="composer-footer">{project && <button type="button" className="composer-project" onClick={() => void changePanel(true)} title="查看项目文件"><Icon name="folder" size={13} /><span>{project.name}</span></button>}<span>管理员可查看会话与执行记录</span><span className="composer-shortcut">Shift + Enter 换行</span></div>
  </div>;
  return <div className={'workspace-body' + (panelOpen ? ' with-panel' : '')}>
    <section className={'chat-panel' + (emptyConversation ? ' chat-panel-empty' : '')}>
      <header className={'workspace-header' + (project ? '' : ' workspace-header-chat')}>
        <div className="breadcrumb"><span>{project?.name || 'kivo'}</span><Icon name="chevron" size={14} /><strong>{title || '新的对话'}</strong></div>
        {project && <><div className="workspace-mode-switch" role="group" aria-label="界面模式"><button className={!panelOpen ? 'selected' : ''} aria-pressed={!panelOpen} onClick={() => void changePanel(false)}><Icon name="chat" size={15} />聊天</button><button className={panelOpen ? 'selected' : ''} aria-pressed={panelOpen} onClick={() => void changePanel(true)}><Icon name="code" size={16} />工作</button></div>
        <div className="workspace-header-actions">
          <button className={'button small-button file-panel-toggle' + (panelOpen ? ' subtle active' : ' secondary')} onClick={() => void changePanel(!panelOpen)} title="项目文件与代码差异" aria-expanded={panelOpen}><Icon name="panel" size={16} /><span>文件与差异</span></button>
          <div className="menu-anchor"><button className="icon-button" aria-label="项目操作" aria-expanded={projectMenu} onClick={() => setProjectMenu(!projectMenu)}><Icon name="more" /></button>{projectMenu && <><button className="menu-dismiss" aria-label="关闭项目菜单" onClick={() => setProjectMenu(false)} /><div className="dropdown-menu"><button onClick={() => { setProjectMenu(false); onRenameProject(); }}><Icon name="edit" size={16} />重命名项目</button><button className="danger-text" disabled={running} onClick={() => { setProjectMenu(false); onDeleteProject(); }}><Icon name="trash" size={16} />删除项目</button></div></>}</div>
        </div></>}
      </header>
      {!providerConfigured && <div className="provider-banner"><Icon name="key" size={16} /><span>填写你自己的 OpenAI API Key，即可开始对话。</span><button type="button" className="text-button" onClick={onOpenAccount}>前往账户设置</button></div>}
      <div className={'chat-stage' + (emptyConversation ? ' chat-stage-empty' : '')}>
        {emptyConversation ? <div className="chat-welcome"><h1>今天想做些什么？</h1></div> : <div className="messages-scroll" ref={scroll} onScroll={() => { if (scroll.current) { const near = scroll.current.scrollHeight - scroll.current.scrollTop - scroll.current.clientHeight < 160; pinBottom.current = near; setScrolledUp(!near); } }}>
          {loading ? <Loading label="正在加载对话…" /> : <div className="messages-list">
            {messages.map(message => <article key={message.id} className={'chat-message message-' + message.role}><div className={'message-avatar' + (message.role === 'assistant' ? ' assistant-avatar logo-container' : '')}>{message.role === 'assistant' ? <Logo /> : message.role === 'user' ? (user.displayName || user.username).slice(0, 1).toUpperCase() : <Icon name="info" size={17} />}</div><div className="message-main"><div className="message-heading"><strong>{message.role === 'assistant' ? 'kivo' : message.role === 'user' ? user.displayName || user.username : '系统'}</strong><time>{dateTime(message.createdAt)}</time>{message.role === 'assistant' && <button className="icon-button message-copy" title="复制回答" aria-label="复制回答" onClick={() => void copy(message.content)}><Icon name="copy" size={14} /></button>}</div>{message.role === 'user' ? <div className="user-message-content">{message.content}</div> : <Markdown content={message.content} />}</div></article>)}
            {showRunOutput && <article className="chat-message message-assistant"><div className="message-avatar assistant-avatar logo-container"><Logo /></div><div className="message-main"><div className="message-heading"><strong>kivo</strong><StatusBadge status={run.status} /></div>{run.output ? <Markdown content={run.output} /> : <div className="thinking"><span /><span /><span /><small>正在处理你的任务</small></div>}</div></article>}
            {run && run.logs?.length > 0 && <details className="tool-activity" open={running}><summary><Icon name="terminal" size={15} /><span>执行活动</span><small>{run.logs.length} 条</small><Icon name="down" size={14} /></summary><div className="tool-log">{run.logs.map((log, index) => <div key={index}><span className="tool-log-dot" /><pre>{log}</pre></div>)}</div></details>}
            {run?.status === 'failed' && <div className="run-outcome"><Icon name="alert" size={16} /><span>{run.error || '任务未能完成，请查看执行活动后重试。'}</span></div>}
            {run?.status === 'interrupted' && <div className="run-outcome neutral"><Icon name="stop" size={15} /><span>任务已停止。你可以继续发送消息。</span></div>}
          </div>}
        </div>}
        {composer}
        {emptyConversation && <div className="starter-chips">{(project ? starters : chatStarters).map(starter => <button className="starter-chip" key={starter.title} onClick={() => { setInput(starter.text); textarea.current?.focus(); }}><Icon name={starter.icon} size={16} /><span>{starter.title}</span></button>)}</div>}
      </div>
    </section>
    {project && panelOpen && <Files project={project} revision={revision} locked={!!running} onClose={() => void closePanel()} />}
  </div>;
}
