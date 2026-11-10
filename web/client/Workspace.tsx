import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, dateTime, enc, messageOf } from './api';
import { ChatComposer } from './ChatComposer';
import { AttachmentChips, ChatImages, Markdown } from './ChatContent';
import { Icon, Logo } from './icons';
import { getDirtyFile } from './navigation';
import { Files } from './Files';
import { LocalApprovals } from './Local';
import { PreviousTask, TaskActivity, VerificationCard, useRunActivity } from './RunActivity';
import { ErrorBox, Loading, StatusBadge, useDialog, useNotice } from './ui';
import type { ChatModelOption, ChatTool, Message, Project, ReasoningEffort, Run, RunEvent, RunVerification, Thread, User } from './types';

const chatFileCount = 4;
const chatFileBytes = 8 * 1024 * 1024;
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

export function Workspace({ project, threadId, onThreadCreated, onThreadsChanged, user, providerConfigured, model, defaultChatModel, chatModels, refreshSession, onRenameProject, onDeleteProject, onOpenAccount, onOpenLocal }: {
  project: Project | null; threadId: string | null; onThreadCreated: (thread: Thread) => void; onThreadsChanged: () => void;
  user: User; providerConfigured: boolean; model?: string; defaultChatModel?: string; chatModels?: ChatModelOption[]; refreshSession: () => Promise<void>;
  onRenameProject: () => void; onDeleteProject: () => void; onOpenAccount: () => void; onOpenLocal: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [title, setTitle] = useState('新的对话');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [input, setInput] = useState('');
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [verificationCommand, setVerificationCommand] = useState('');
  const [selectedTool, setSelectedTool] = useState<Exclude<ChatTool, 'analyze'>>('auto');
  const [selectedModel, setSelectedModel] = useState<string>();
  const [ultraSelected, setUltraSelected] = useState(false);
  const [modelEfforts, setModelEfforts] = useState<Partial<Record<string, ReasoningEffort>>>({});
  const [attachments, setAttachments] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [connectionLost, setConnectionLost] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<'files' | 'diff'>('files');
  const [projectMenu, setProjectMenu] = useState(false);
  const [revision, setRevision] = useState(0);
  const [scrolledUp, setScrolledUp] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const verificationInput = useRef<HTMLInputElement>(null);
  const pinBottom = useRef(true);
  const threadRef = useRef(threadId); threadRef.current = threadId;
  const newlyCreatedThread = useRef<string | null>(null);
  const loadSequence = useRef(0);
  const mounted = useRef(true);
  const sendingRef = useRef(false);
  const notify = useNotice(); const ask = useDialog();
  const running = run?.status === 'running';
  const composerBusy = loading || sending || running;
  const cloudProject = !!project && project.location !== 'local';
  const resumable = cloudProject && run?.mode === 'cloud' && run.status === 'interrupted';
  const { events: activity, error: activityError, add: addActivity, refresh: refreshActivity } = useRunActivity(run?.mode ? run.id : undefined);
  const chatTool = attachments.length ? 'analyze' : selectedTool;
  const modelOptions: ChatModelOption[] = chatModels ?? (model ? [{ id: model, label: model, description: '' }] : []);
  const chatModel = modelOptions.find(option => option.id === selectedModel)
    ?? modelOptions.find(option => option.id === (defaultChatModel ?? model)) ?? modelOptions[0];
  const savedEffort = chatModel && modelEfforts[chatModel.id];
  const reasoningEffort = savedEffort && chatModel?.efforts?.includes(savedEffort) ? savedEffort : chatModel?.defaultEffort ?? undefined;
  const ultraAvailable = !!chatModel?.supportsUltra && chatTool === 'auto';
  const ultra = ultraSelected && ultraAvailable;
  useEffect(() => { if (!ultraAvailable) setUltraSelected(false); }, [ultraAvailable]);
  function selectEffort(effort?: ReasoningEffort) {
    setUltraSelected(false);
    if (chatModel) setModelEfforts(previous => ({ ...previous, [chatModel.id]: effort }));
  }
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
    if (threadId !== newlyCreatedThread.current) {
      setInput('');
      setVerificationOpen(false);
      setVerificationCommand('');
      setAttachments([]);
      setSelectedTool('auto');
      setUltraSelected(false);
    }
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
      void refreshActivity();
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
    source.addEventListener('activity', safely((event: RunEvent) => addActivity(event)));
    source.addEventListener('verification', safely((verification: RunVerification) => {
      setRun(old => old?.id === runId ? { ...old, verification } : old);
    }));
    source.addEventListener('usage', () => { if (!finished) void refreshSession().catch(() => undefined); });
    source.addEventListener('done', safely(data => {
      if (finished) return; finished = true; source.close(); setConnectionLost(false); setStopping(false);
      setRun(old => old?.id === runId ? { ...old, status: data.status, error: data.message || old.error } : old);
      if (data.status === 'failed' && data.message) notify(data.message, 'error');
      void refreshActivity();
      void loadThread(currentThreadId); void refreshSession().catch(() => undefined); onThreadsChanged(); setRevision(old => old + 1);
    }));
    source.onopen = () => { if (!finished && mounted.current) setConnectionLost(false); };
    source.onerror = () => {
      if (finished) return;
      setConnectionLost(true);
      void api<{ thread: Thread; messages: Message[]; run: Run | null }>(`/api/threads/${enc(currentThreadId)}`).then(result => {
        if (finished || !mounted.current || threadRef.current !== currentThreadId || result.run?.status === 'running') return;
        finished = true; source.close(); setMessages(result.messages); setRun(result.run); setConnectionLost(false); setStopping(false); setRevision(old => old + 1); void refreshSession().catch(() => undefined); onThreadsChanged();
        void refreshActivity();
      }).catch(() => undefined);
    };
    return () => { finished = true; source.close(); };
  }, [run?.id, run?.status, loadThread, onThreadsChanged, refreshSession, notify, addActivity, refreshActivity]);
  const followOutput = useCallback(() => {
    if (pinBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, []);
  useEffect(followOutput, [followOutput, messages, run?.output, run?.logs?.length, activity.length, loading]);
  useEffect(() => { if (textarea.current) { textarea.current.style.height = 'auto'; textarea.current.style.height = `${Math.min(160, textarea.current.scrollHeight)}px`; } }, [input]);
  useEffect(() => { if (verificationOpen) verificationInput.current?.focus(); }, [verificationOpen]);

  function attachFiles(files: File[]) {
    if (!files.length || composerBusy) return;
    const empty = files.find(file => !file.size);
    if (empty) { notify(`附件「${empty.name}」是空文件。`, 'error'); return; }
    const next = [...attachments, ...files];
    if (next.length > chatFileCount || next.reduce((sum, file) => sum + file.size, 0) > chatFileBytes) {
      notify('每条消息最多添加 4 个附件，总大小不超过 8 MiB。', 'error');
      return;
    }
    setAttachments(next);
    setSelectedTool('auto');
    setUltraSelected(false);
    textarea.current?.focus();
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    const hasFiles = !project && attachments.length > 0;
    if ((!text && !hasFiles) || sendingRef.current || loading || running || !providerConfigured) return;
    sendingRef.current = true; setSending(true);
    try {
      if (project && getDirtyFile() && !await ask({ title: '使用已保存的文件开始任务？', description: `${getDirtyFile()} 尚有未保存的编辑。kivo 将使用${project.location === 'local' ? '电脑' : '服务器'}上已保存的文件版本。你也可以取消并先保存文件。`, confirm: '使用已保存的版本' })) return;
      if (!mounted.current) return;
      setError(''); pinBottom.current = true;
      let id = threadId;
      if (!id) {
        const created = await api<{ thread: Thread }>(project ? `/api/projects/${enc(project.id)}/threads` : '/api/threads', { method: 'POST', body: { title: text.slice(0, 60) || '分析附件' } });
        id = created.thread.id;
        if (mounted.current) { threadRef.current = id; newlyCreatedThread.current = id; }
        onThreadCreated(created.thread);
      }
      const check = cloudProject ? verificationCommand.trim() : '';
      let body: { text: string; tool?: ChatTool; model?: string; mode?: 'ultra'; reasoningEffort?: ReasoningEffort; verificationCommand?: string } | FormData = project
        ? { text, ...(check ? { verificationCommand: check } : {}) }
        : { text, tool: chatTool, model: chatModel?.id, ...(ultra ? { mode: 'ultra' } : { reasoningEffort }) };
      if (hasFiles) {
        const form = new FormData();
        form.set('text', text);
        form.set('tool', 'analyze');
        if (chatModel) form.set('model', chatModel.id);
        if (reasoningEffort) form.set('reasoningEffort', reasoningEffort);
        for (const file of attachments) form.append('files', file);
        body = form;
      }
      const result = await api<{ run: Run }>(`/api/threads/${enc(id)}/turns`, { method: 'POST', body });
      onThreadsChanged();
      if (!mounted.current || threadRef.current !== id) return;
      setInput(''); setVerificationOpen(false); setVerificationCommand('');
      setAttachments([]); setSelectedTool('auto'); setRun(result.run);
      setUltraSelected(false);
      await loadThread(id); void refreshSession().catch(() => undefined);
    } catch (e) {
      if (mounted.current) {
        setError(messageOf(e));
        if (!project && e instanceof ApiError && (e.code === 'chat_model_invalid' || e.code === 'chat_reasoning_invalid' || e.code === 'chat_mode_invalid')) {
          setUltraSelected(false);
          void refreshSession().catch(() => undefined);
        }
      } else onThreadsChanged();
    }
    finally { sendingRef.current = false; if (mounted.current) { setSending(false); textarea.current?.focus(); } }
  }
  async function interrupt() {
    if (!run || stopping) return;
    setStopping(true);
    try { await api(`/api/runs/${enc(run.id)}/interrupt`, { method: 'POST' }); notify('已发送停止请求', 'info'); }
    catch (e) { notify(messageOf(e), 'error'); if (mounted.current) setStopping(false); }
  }
  async function resume() {
    if (!run || !resumable || !providerConfigured || sendingRef.current) return;
    const previous = run;
    sendingRef.current = true;
    try {
      const dirty = getDirtyFile();
      const result = await ask({
        title: '从当前工作区继续？',
        description: 'kivo 会创建一条关联任务，以当前已保存的工作区和已记录的进度为起点。结果未知的操作请先核对。'
          + (previous.verification?.status === 'not_run' ? ' 已配置且尚未运行的验收命令会带入新任务。' : '')
          + (dirty ? ` ${dirty} 尚未保存。` : ''),
        fields: [{ name: 'text', label: '补充说明（选填）', multiline: true, maxLength: 4000, required: false }],
        confirm: '继续任务',
      });
      if (!result || !mounted.current || threadRef.current !== previous.threadId) return;
      setSending(true);
      setError('');
      pinBottom.current = true;
      const text = result.text?.trim();
      const next = await api<{ run: Run }>(`/api/runs/${enc(previous.id)}/resume`, { method: 'POST', body: text ? { text } : {} });
      onThreadsChanged();
      if (!mounted.current || threadRef.current !== previous.threadId) return;
      setRun(next.run);
      await loadThread(previous.threadId);
      void refreshSession().catch(() => undefined);
    } catch (error) {
      if (mounted.current && threadRef.current === previous.threadId) setError(messageOf(error));
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  }
  async function copy(content: string) {
    try { await navigator.clipboard.writeText(content); notify('已复制'); }
    catch { notify('无法访问剪贴板，请手动选择文本复制。', 'error'); }
  }
  function closePanel() { setPanelOpen(false); setPanelTab('files'); }
  function openCurrentDiff() { setPanelTab('diff'); setPanelOpen(true); }
  async function changePanel(nextOpen: boolean) {
    if (!project) return;
    if (!nextOpen && panelOpen && getDirtyFile() && !await ask({ title: '关闭未保存的文件？', description: `${getDirtyFile()} 的编辑尚未保存，关闭面板后将丢失。`, confirm: '放弃修改并关闭', danger: true })) return;
    if (nextOpen) setPanelOpen(true);
    else closePanel();
  }
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const showRunOutput = run && (running || (!!run.output && lastAssistant?.content !== run.output));
  const emptyConversation = !loading && messages.length === 0 && !run;
  const composer = <div className="composer-area">
    {scrolledUp && !emptyConversation && <button className="scroll-bottom" onClick={() => { pinBottom.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }}><Icon name="down" size={16} />回到最新消息</button>}
    {connectionLost && <div className="connection-note"><span className="spinner" />连接已断开，正在自动恢复任务状态…</div>}
    {error && <ErrorBox error={error} onRetry={threadId ? () => void loadThread(threadId, true) : undefined} />}
    {project ? <form className={'composer' + (running ? ' composer-running' : '')} onSubmit={send}>
      {cloudProject && verificationOpen && <div className="composer-verification" id="project-verification-command">
        <label htmlFor="verification-command">验收命令（选填）</label>
        <input ref={verificationInput} id="verification-command" aria-describedby="verification-command-help" value={verificationCommand} onChange={event => setVerificationCommand(event.target.value)}
          placeholder="例如 npm test" autoComplete="off" spellCheck={false} disabled={composerBusy} maxLength={1000}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              textarea.current?.focus();
            }
          }} />
        <small id="verification-command-help">模型结束任务后，kivo 在项目中执行此命令并记录退出码。</small>
      </div>}
      <div className="composer-input-row">
        <button type="button" className="icon-button composer-attach" title="项目文件、上传与代码差异" aria-label="打开项目文件" onClick={() => void changePanel(true)}><Icon name="plus" size={23} /></button>
        <textarea ref={textarea} value={input} onChange={event => setInput(event.target.value)} placeholder={running ? 'kivo 正在执行任务…' : '有问题，尽管问'} aria-label="发送给 kivo 的消息" disabled={composerBusy} maxLength={24000} rows={1} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
        <span className="composer-model" title="当前模型">{model || '默认模型'}</span>
        {running ? <button type="button" className="send-button stop-button" title="停止任务" aria-label="停止任务" disabled={stopping} onClick={() => void interrupt()}>{stopping ? <span className="spinner" /> : <Icon name="stop" size={17} />}</button> : <button type="submit" className="send-button" title="发送消息" aria-label="发送消息" disabled={!input.trim() || composerBusy || !providerConfigured}>{sending ? <span className="spinner" /> : <Icon name="send" size={21} />}</button>}
      </div>
    </form> : <ChatComposer draft={input} setDraft={setInput} textarea={textarea} attachments={attachments} onAttach={attachFiles}
      onRemove={index => setAttachments(files => files.filter((_, i) => i !== index))} tool={chatTool} onTool={setSelectedTool}
      model={chatModel} models={modelOptions} onModel={id => { setSelectedModel(id); setUltraSelected(false); }}
      effort={ultra ? 'max' : reasoningEffort} onEffort={selectEffort} ultra={ultra} ultraAvailable={ultraAvailable} onUltra={setUltraSelected}
      onOpenReasoning={() => void refreshSession().catch(() => undefined)} threadId={threadId} providerConfigured={providerConfigured}
      busy={composerBusy} running={running} sending={sending} stopping={stopping} onSend={send} onStop={() => void interrupt()} onOpenLocal={onOpenLocal} />}
    <div className="composer-footer">{project && <button type="button" className="composer-project" onClick={() => void changePanel(true)} title="查看项目文件"><Icon name="folder" size={13} /><span>{project.name}{project.location === 'local' ? ' · 本地电脑' : ' · 云端'}</span></button>}
      {cloudProject && <button type="button" className="composer-verification-toggle" aria-expanded={verificationOpen} aria-controls={verificationOpen ? 'project-verification-command' : undefined}
        onClick={() => setVerificationOpen(open => !open)} disabled={composerBusy}><Icon name="check" size={13} />{verificationCommand.trim() ? '已填写验收命令' : '验收命令'}</button>}
      <span>管理员可查看会话与执行记录</span><span className="composer-shortcut">Shift + Enter 换行</span></div>
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
            {messages.map(message => <article key={message.id} className={'chat-message message-' + message.role}>
              <div className={'message-avatar' + (message.role === 'assistant' ? ' assistant-avatar logo-container' : '')}>
                {message.role === 'assistant' ? <Logo /> : message.role === 'user' ? (user.displayName || user.username).slice(0, 1).toUpperCase() : <Icon name="info" size={17} />}
              </div>
              <div className="message-main">
                <div className="message-heading">
                  <strong>{message.role === 'assistant' ? 'kivo' : message.role === 'user' ? user.displayName || user.username : '系统'}</strong>
                  <time>{dateTime(message.createdAt)}</time>
                  {message.role === 'assistant' && message.content && <button className="icon-button message-copy" title="复制回答" aria-label="复制回答" onClick={() => void copy(message.content)}><Icon name="copy" size={14} /></button>}
                </div>
                {message.role === 'user' ? <>
                  {!!message.attachments?.length && <AttachmentChips files={message.attachments} />}
                  {message.content && <div className="user-message-content">{message.content}</div>}
                </> : <>
                  {(message.content || !!message.citations?.length) && <Markdown content={message.content} citations={message.citations} />}
                  {!!message.artifacts?.length && <ChatImages artifacts={message.artifacts} onLoad={followOutput} />}
                </>}
              </div>
            </article>)}
            {showRunOutput && <article className="chat-message message-assistant"><div className="message-avatar assistant-avatar logo-container"><Logo /></div><div className="message-main"><div className="message-heading"><strong>kivo</strong><StatusBadge status={run.status} /></div>{run.output ? <Markdown content={run.output} /> : <div className="thinking"><span /><span /><span /><small>正在处理你的任务</small></div>}</div></article>}
            {run && <>
              <VerificationCard run={run} onOpenDiff={project && !running ? openCurrentDiff : undefined} />
              <TaskActivity key={run.id} run={run} events={activity} error={activityError} refresh={refreshActivity} />
              {run.resumedFromRunId && <PreviousTask key={run.resumedFromRunId} runId={run.resumedFromRunId} />}
            </>}
            {running && run && project?.location === 'local' && <LocalApprovals runId={run.id} />}
            {run?.status === 'failed' && <div className="run-outcome"><Icon name="alert" size={16} /><span>{run.error || '任务未能完成，请查看执行活动后重试。'}</span></div>}
            {run?.status === 'interrupted' && <div className="run-outcome neutral"><Icon name="stop" size={15} />
              <div><span>{run.interruptReason === 'restart' ? '服务重启，任务已中断。' : run.interruptReason === 'user' ? '你已停止任务。' : '任务已中断。'}</span>
                {resumable ? <div className="run-resume-actions">
                  <button type="button" className="button secondary small-button" onClick={() => void resume()} disabled={composerBusy || !providerConfigured}><Icon name="refresh" size={14} />继续任务</button>
                </div> : <span>你可以继续发送消息。</span>}</div>
            </div>}
          </div>}
        </div>}
        {composer}
        {emptyConversation && <div className="starter-chips">{(project ? starters : chatStarters).map(starter => <button className="starter-chip" key={starter.title} onClick={() => { setInput(starter.text); textarea.current?.focus(); }}><Icon name={starter.icon} size={16} /><span>{starter.title}</span></button>)}</div>}
      </div>
    </section>
    {project && panelOpen && <Files project={project} revision={revision} locked={!!running} tab={panelTab} onTabChange={setPanelTab} onClose={closePanel} />}
  </div>;
}
