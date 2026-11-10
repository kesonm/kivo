import { useCallback, useEffect, useRef, useState } from 'react';
import { api, enc, messageOf, number } from './api';
import { Auth } from './Auth';
import { Account } from './Account';
import { Admin } from './Admin';
import { Workspace } from './Workspace';
import { LocalDevices, LocalProjectDialog } from './Local';
import { Brand, Icon } from './icons';
import { getDirtyFile } from './navigation';
import { ErrorBox, Loading, Modal, useDialog, useNotice } from './ui';
import type { Project, Session, Thread, User, WorkSnapshot, WorkTask } from './types';

type View = 'workspace' | 'account' | 'admin' | 'local';
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('workspace');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState('');
  const [chats, setChats] = useState<Thread[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatsError, setChatsError] = useState('');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadsRevision, setThreadsRevision] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarOpenButton = useRef<HTMLButtonElement | null>(null);
  const sidebarCloseButton = useRef<HTMLButtonElement>(null);
  const [navigationPanel, setNavigationPanel] = useState<'history' | 'new' | 'account' | null>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 800px)').matches);
  const [primary, setPrimary] = useState<{ userId: string; thread: Thread } | null>(null);
  const [primaryLoading, setPrimaryLoading] = useState(true);
  const [primaryError, setPrimaryError] = useState('');
  const [primaryRetry, setPrimaryRetry] = useState(0);
  const [workSnapshot, setWorkSnapshot] = useState<WorkSnapshot | null>(null);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksError, setTasksError] = useState('');
  const [openingTask, setOpeningTask] = useState<string | null>(null);
  const [initialTask, setInitialTask] = useState<WorkTask | undefined>();
  const [recentThreads, setRecentThreads] = useState<Thread[]>([]);
  const [recentError, setRecentError] = useState('');
  const taskRequest = useRef(0);
  const [historySearch,setHistorySearch] = useState('');
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const [projectSearch, setProjectSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [localDialog, setLocalDialog] = useState<'create' | 'open' | null>(null);
  const projectRequest = useRef(0);
  const navigationRevision = useRef(0);
  const authEpoch = useRef(0);
  const previousNavigationOverlay = useRef(false);
  const ask = useDialog(); const notify = useNotice();
  const user = session?.user;
  const primaryThread = primary && primary.userId === user?.id ? primary.thread : null;
  const isKibot = !!primaryThread && threadId === primaryThread.id;
  const selectedProject = projects.find(project => project.id === projectId) || null;
  const currentNavigation = navigationRevision.current;
  const currentAuthEpoch = authEpoch.current;
  const activeLocation = useRef({ userId: user?.id, projectId, workspaceVersion, view });
  activeLocation.current = { userId: user?.id, projectId, workspaceVersion, view };

  const applySession = useCallback((next: Session | null) => {
    const nextUserId = next?.user?.id;
    if (activeLocation.current.userId !== nextUserId) {
      // A cookie can change in another tab. Invalidate all old-account work
      // before rendering the new identity, including callbacks awaiting a dialog.
      ++authEpoch.current; ++navigationRevision.current; ++projectRequest.current; ++taskRequest.current;
      activeLocation.current = { userId: nextUserId, projectId: null, workspaceVersion: activeLocation.current.workspaceVersion + 1, view: 'workspace' };
      setProjects([]); setProjectId(null); setProjectsLoading(false); setProjectsError('');
      setChats([]); setChatsLoading(false); setChatsError(''); setHistorySearch(''); setProjectSearch('');
      setThreadId(null); setWorkspaceVersion(version => version + 1); setView('workspace');
      setPrimary(null); setPrimaryLoading(!!nextUserId); setPrimaryError(''); setInitialTask(undefined);
      setWorkSnapshot(null); setTasksLoading(false); setTasksError(''); setOpeningTask(null);
      setRecentThreads([]); setRecentError(''); setSidebarOpen(false); setNavigationPanel(null); setLocalDialog(null); setCreating(false);
    }
    setSession(next);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 800px)');
    const changed = () => { setMobile(media.matches); if (!media.matches) setSidebarOpen(false); };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    if (!sidebarOpen || !mobile || !user) return;
    const previous = sidebarOpenButton.current;
    const timer = window.setTimeout(() => sidebarCloseButton.current?.focus(), 0);
    const keydown = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not(#primary-navigation)') || event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); setSidebarOpen(false); }
      if (event.key !== 'Tab' || !sidebarRef.current) return;
      const controls = Array.from(sidebarRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')).filter(el => el.getClientRects().length > 0);
      if (!controls.length) { event.preventDefault(); sidebarRef.current.focus(); return; }
      const first = controls[0], last = controls[controls.length - 1];
      if (!controls.includes(document.activeElement as HTMLElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      clearTimeout(timer); document.removeEventListener('keydown', keydown);
      window.requestAnimationFrame(() => { if (!document.querySelector('[role="dialog"][aria-modal="true"]')) previous?.focus(); });
    };
  }, [sidebarOpen, mobile, user?.id]);

  useEffect(() => {
    const hasOverlay = navigationPanel !== null || localDialog !== null;
    const hadOverlay = previousNavigationOverlay.current;
    previousNavigationOverlay.current = hasOverlay;
    if (!hadOverlay || hasOverlay || !mobile) return;
    const frame = window.requestAnimationFrame(() => {
      if (!document.querySelector('[role="dialog"][aria-modal="true"]')) sidebarOpenButton.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationPanel, localDialog, mobile]);

  const refreshSession = useCallback(async (expectedUserId?: string) => {
    const requestUser = expectedUserId ?? activeLocation.current.userId;
    const epoch = authEpoch.current;
    const result = await api<Session>('/api/session');
    if (epoch !== authEpoch.current || activeLocation.current.userId !== requestUser) return;
    applySession(result);
  }, [applySession]);
  const initialize = useCallback(async () => {
    setInitializing(true); setError('');
    try { await refreshSession(); } catch (e) { setError(messageOf(e)); } finally { setInitializing(false); }
  }, [refreshSession]);
  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => {
    const expire = () => {
      ++authEpoch.current;
      applySession(null);
      const epoch = authEpoch.current;
      notify('登录已失效，请重新登录。', 'info'); void api<Session>('/api/session').then(next => { if (authEpoch.current === epoch && !activeLocation.current.userId) applySession(next); }).catch(() => undefined);
    };
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, [notify, applySession]);
  const loadProjects = useCallback(async () => {
    const userId = activeLocation.current.userId; const request = ++projectRequest.current;
    if (!userId) return;
    setProjectsLoading(true); setProjectsError('');
    const current = () => activeLocation.current.userId === userId && projectRequest.current === request;
    try { const result = await api<{ projects: Project[] }>('/api/projects'); if (!current()) return; setProjects(result.projects); setProjectId(old => result.projects.some(project => project.id === old) ? old : null); }
    catch (e) { if (current()) setProjectsError(messageOf(e)); } finally { if (current()) setProjectsLoading(false); }
  }, []);
  useEffect(() => { if (user?.id) void loadProjects(); }, [user?.id, currentAuthEpoch, loadProjects]);
  useEffect(() => {
    if (!user?.id) { setPrimary(null); setPrimaryLoading(false); return; }
    const userId = user.id, location = navigationRevision.current, epoch = authEpoch.current;
    let cancelled = false;
    const current = () => !cancelled && activeLocation.current.userId === userId && authEpoch.current === epoch;
    setPrimaryLoading(true); setPrimaryError('');
    api<{ thread: Thread }>('/api/kibot', { method: 'POST', body: {} }).then(result => {
      if (!current()) return;
      setPrimary({ userId, thread: result.thread });
      if (navigationRevision.current === location) {
        ++navigationRevision.current; ++taskRequest.current;
        setProjectId(null); setThreadId(result.thread.id); setInitialTask(undefined);
        setWorkspaceVersion(value => value + 1);
      }
    }).catch(e => { if (current()) setPrimaryError(messageOf(e)); })
      .finally(() => { if (current()) setPrimaryLoading(false); });
    return () => { cancelled = true; };
  }, [user?.id, currentAuthEpoch, primaryRetry]);
  useEffect(() => {
    if (!user?.id) { setWorkSnapshot(null); setRecentThreads([]); return; }
    const userId = user.id, epoch = authEpoch.current;
    let cancelled = false; setTasksLoading(true); setTasksError(''); setRecentError('');
    const current = () => !cancelled && activeLocation.current.userId === userId && authEpoch.current === epoch;
    void api<WorkSnapshot>('/api/work').then(result => { if (current()) setWorkSnapshot(result); })
      .catch(e => { if (current()) setTasksError(messageOf(e)); }).finally(() => { if (current()) setTasksLoading(false); });
    void api<{ threads: Thread[] }>('/api/history').then(result => { if (current()) setRecentThreads(result.threads); })
      .catch(e => { if (current()) setRecentError(messageOf(e)); });
    return () => { cancelled = true; };
  }, [user?.id, currentAuthEpoch, threadsRevision]);
  useEffect(() => {
    if (!user?.id || navigationPanel !== 'history') return;
    const userId = user.id, epoch = authEpoch.current;
    const controller = new AbortController(); setChatsLoading(true); setChatsError('');
    const current = () => !controller.signal.aborted && activeLocation.current.userId === userId && authEpoch.current === epoch;
    const timer = window.setTimeout(() => {
      void api<{ threads: Thread[] }>(`/api/history?q=${enc(historySearch)}`, { signal: controller.signal })
        .then(result => { if (current()) setChats(result.threads); })
        .catch(e => { if (current()) setChatsError(messageOf(e)); })
        .finally(() => { if (current()) setChatsLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [user?.id, currentAuthEpoch, threadsRevision, historySearch, navigationPanel]);
  const onThreadsChanged = useCallback(() => setThreadsRevision(old => old + 1), []);
  const onThreadCreated = useCallback((thread: Thread) => {
    const current = activeLocation.current;
    if (current.userId !== user?.id || authEpoch.current !== currentAuthEpoch) return;
    if (thread.projectId == null) setChats(old => [thread, ...old.filter(item => item.id !== thread.id)]);
    if (navigationRevision.current === currentNavigation && current.view === 'workspace' && current.projectId === projectId && current.workspaceVersion === workspaceVersion) setThreadId(thread.id);
    setThreadsRevision(old => old + 1);
  }, [projectId, workspaceVersion, user?.id, currentNavigation, currentAuthEpoch]);
  function isCurrentUser() { return authEpoch.current === currentAuthEpoch && activeLocation.current.userId === user?.id; }
  async function confirmNavigation() {
    if (!isCurrentUser()) return false;
    const path = getDirtyFile();
    if (path) { setNavigationPanel(null); setSidebarOpen(false); }
    const confirmed = !path || !!await ask({ title: '离开未保存的文件？', description: `${path} 的修改尚未保存。离开后这些编辑内容将丢失。`, confirm: '放弃修改并继续', danger: true });
    return confirmed && isCurrentUser();
  }
  async function navigate(next: View) { if (!isCurrentUser() || next !== view && !(await confirmNavigation())) return; ++navigationRevision.current; setView(next); setSidebarOpen(false); setNavigationPanel(null); if (user) void refreshSession(user.id).catch(() => undefined); }
  function openConversation(nextProjectId: string | null, nextThreadId: string | null, task?: WorkTask) {
    if (!isCurrentUser()) return;
    ++navigationRevision.current; ++taskRequest.current;
    setInitialTask(task); setNavigationPanel(null);
    setProjectId(nextProjectId); setThreadId(nextThreadId); setWorkspaceVersion(version => version + 1); setView('workspace'); setSidebarOpen(false);
    if (user) void refreshSession(user.id).catch(() => undefined);
  }
  async function selectProject(id: string) { if (!(await confirmNavigation())) return; openConversation(id, null); }
  async function selectThread(thread: Thread) {
    if (view === 'workspace' && thread.id === threadId && thread.projectId === projectId && !initialTask) { setSidebarOpen(false); setNavigationPanel(null); return; }
    if (!(await confirmNavigation())) return;
    openConversation(thread.projectId, thread.id);
  }
  async function startNewConversation() {
    if (!(await confirmNavigation())) return;
    openConversation(null, null);
  }
  async function createProject() {
    if (!(await confirmNavigation())) return;
    setNavigationPanel(null); setSidebarOpen(false); setLocalDialog('create');
  }
  async function createCloudProject() {
    if (!(await confirmNavigation())) return;
    const values = await ask({ title: '创建新项目', description: '每个项目都有独立的文件空间和对话历史。', fields: [{ name: 'name', label: '项目名称', placeholder: '例如：我的个人网站', maxLength: 80 }], confirm: '创建项目' });
    if (!values || !isCurrentUser()) return;
    const requestUser = user?.id; const location = navigationRevision.current;
    if (!requestUser) return;
    setCreating(true);
    try { const result = await api<{ project: Project }>('/api/projects', { method: 'POST', body: { name: values.name.trim() } }); if (!isCurrentUser()) return; ++projectRequest.current; setProjectsLoading(false); setProjects(old => [result.project, ...old.filter(project => project.id !== result.project.id)]); if (navigationRevision.current === location) openConversation(result.project.id, null); notify('项目已创建'); }
    catch (e) { if (isCurrentUser()) notify(messageOf(e), 'error'); } finally { if (isCurrentUser()) setCreating(false); }
  }
  async function renameProject() {
    if (!selectedProject) return;
    const values = await ask({ title: '重命名项目', fields: [{ name: 'name', label: '项目名称', value: selectedProject.name, maxLength: 80 }], confirm: '保存名称' });
    if (!values || !isCurrentUser()) return;
    try { await api(`/api/projects/${enc(selectedProject.id)}`, { method: 'PATCH', body: { name: values.name.trim() } }); if (!isCurrentUser()) return; await loadProjects(); if (isCurrentUser()) notify('项目名称已更新'); }
    catch (e) { if (isCurrentUser()) notify(messageOf(e), 'error'); }
  }
  async function deleteProject() {
    if (!selectedProject) return;
    const values = await ask({ title: selectedProject.location === 'local' ? '移除本地项目关联？' : '永久删除项目？', description: selectedProject.location === 'local' ? `「${selectedProject.name}」的网页会话记录将被删除，电脑上的文件和检查点会保留。请输入项目名称确认。` : `「${selectedProject.name}」的文件和对话历史将被删除。此操作无法撤销，请输入项目名称确认。`, fields: [{ name: 'name', label: '输入项目名称', placeholder: selectedProject.name }], confirm: '删除项目', danger: true });
    if (!values || !isCurrentUser()) return;
    if (values.name !== selectedProject.name) { notify('项目名称不匹配，未执行删除。', 'error'); return; }
    try { await api(`/api/projects/${enc(selectedProject.id)}`, { method: 'DELETE' }); if (!isCurrentUser()) return; if (activeLocation.current.projectId === selectedProject.id) openConversation(null, null); await loadProjects(); if (isCurrentUser()) notify('项目已删除'); }
    catch (e) { if (isCurrentUser()) notify(messageOf(e), 'error'); }
  }
  async function logout() {
    const confirmed = await ask({ title: '退出登录？', description: getDirtyFile() ? `${getDirtyFile()} 的修改尚未保存，退出将丢失这些编辑。已保存的项目和对话会保留。` : '已保存的项目和对话会保留。', confirm: '退出登录', danger: !!getDirtyFile() });
    if (!confirmed || !isCurrentUser()) return;
    try { await api('/api/auth/logout', { method: 'POST' }); if (!isCurrentUser()) return; applySession(null); await refreshSession(); }
    catch (e) { if (isCurrentUser()) notify(messageOf(e), 'error'); }
  }
  async function onLogin(nextUser: User) {
    if (!isCurrentUser()) return;
    applySession({ user: nextUser, csrfToken: session?.csrfToken || '', providerConfigured: session?.providerConfigured || false, model: session?.model });
    await refreshSession(nextUser.id);
  }
  async function openTask(task: WorkTask) {
    if (!(await confirmNavigation())) return;
    const userId = user?.id, location = navigationRevision.current, request = ++taskRequest.current;
    if (!userId || !primaryThread) return;
    setOpeningTask(task.id);
    const current = () => isCurrentUser() && navigationRevision.current === location && taskRequest.current === request;
    try {
      const detail = await api<{ task: WorkTask; messages: { conversationId: string }[] }>(`/api/work/tasks/${enc(task.id)}`);
      if (!current()) return;
      const conversationId = [...detail.messages].reverse().find(message => message.conversationId !== primaryThread.id)?.conversationId;
      let thread: Thread;
      if (conversationId) {
        thread = (await api<{ thread: Thread }>(`/api/threads/${enc(conversationId)}`)).thread;
      } else {
        if (workSnapshot?.mode !== 'enforce') { notify('当前仅能查看任务，尚未启用继续执行。', 'info'); return; }
        thread = (await api<{ thread: Thread }>('/api/threads', { method: 'POST', body: { title: detail.task.goal.slice(0, 100) } })).thread;
      }
      if (!current()) return;
      openConversation(thread.projectId, thread.id, detail.task);
      onThreadsChanged();
    } catch (e) { if (current()) notify(messageOf(e), 'error'); }
    finally { if (isCurrentUser()) setOpeningTask(old => old === task.id ? null : old); }
  }
  function openNavigation(panel: 'history' | 'new' | 'account') {
    setNavigationPanel(panel); setSidebarOpen(false);
    if (panel === 'new') void loadProjects();
    if (panel === 'history') setHistorySearch('');
  }
  const taskLabels: Record<string, string> = { running: '执行中', waiting_input: '待确认', waiting_approval: '待审批', succeeded: '已完成', failed: '失败', cancelled: '已取消', needs_reconciliation: '待核对', ready: '待执行', paused: '已暂停' };
  const recentTasks = (workSnapshot?.tasks ?? []).slice(0, 12);
  const recentConversations = recentThreads.filter(thread => thread.id !== primaryThread?.id).slice(0, 8);
  if (initializing) return <div className="boot-screen"><Brand /><Loading label="正在打开工作空间…" /></div>;
  if (error && !session) return <div className="boot-screen"><Brand /><ErrorBox error={error} onRetry={() => void initialize()} /></div>;
  if (!user) return <Auth onLogin={nextUser => void onLogin(nextUser)} />;
  return <>
    <div className="app-shell kibot-shell" inert={navigationPanel !== null || localDialog !== null || undefined}>
      {mobile && sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}
      <aside ref={sidebarRef} id="primary-navigation" className={'kibot-sidebar' + (sidebarOpen ? ' kibot-sidebar-open' : '')}
        role={mobile && sidebarOpen ? 'dialog' : undefined} aria-modal={mobile && sidebarOpen ? true : undefined} aria-label="主导航"
        inert={mobile && !sidebarOpen || undefined} tabIndex={-1}>
        <div className="kibot-nav-brand"><Brand /><button ref={sidebarCloseButton} className="icon-button nav-mobile-close" aria-label="关闭导航" onClick={() => setSidebarOpen(false)}><Icon name="close" /></button></div>
        <button className={'kibot-primary-link' + (view === 'workspace' && isKibot ? ' selected' : '')} aria-current={view === 'workspace' && isKibot ? 'page' : undefined}
          disabled={!primaryThread} onClick={() => primaryThread && void selectThread(primaryThread)}><Icon name="spark" size={24} /><span><strong>kibot</strong><small>你的主对话</small></span></button>
        {primaryError && <ErrorBox error={primaryError} onRetry={() => setPrimaryRetry(value => value + 1)} />}
        <button className="nav-action" onClick={() => openNavigation('history')}><Icon name="search" size={20} /><span>搜索历史</span></button>
        <div className="nav-section-heading"><span>最近任务</span><button className="icon-button" title="新建任务" aria-label="新建任务" onClick={() => openNavigation('new')}><Icon name="plus" size={19} /></button></div>
        <div className="nav-recent-list">
          {tasksLoading && !workSnapshot && <p className="nav-empty">加载任务…</p>}
          {tasksError && <ErrorBox error={tasksError} onRetry={onThreadsChanged} />}
          {recentTasks.map(task => <button key={task.id} className={'nav-task-row' + (view === 'workspace' && initialTask?.id === task.id ? ' selected' : '')}
            disabled={openingTask !== null || !primaryThread} onClick={() => void openTask(task)} title={task.goal}>
            <Icon name={task.objects.some(object => object.role === 'target' && object.projectId) ? 'code' : 'chat'} size={18} />
            <span><strong>{task.goal}</strong><small className="nav-task-status">{openingTask === task.id ? '正在打开…' : taskLabels[task.status] || task.status}{workSnapshot?.mode !== 'enforce' ? ' · 仅查看' : ''}</small></span>
          </button>)}
          {recentTasks.length > 0 && recentConversations.length > 0 && <div className="nav-legacy-label">独立对话</div>}
          {recentConversations.map(thread => <button key={thread.id} title={thread.title} className={'nav-task-row' + (view === 'workspace' && !initialTask && thread.id === threadId ? ' selected' : '')} onClick={() => void selectThread(thread)}>
            <Icon name={thread.projectId ? 'folder' : 'chat'} size={18} /><span><strong>{thread.title || '未命名对话'}</strong><small>{thread.projectId ? '项目对话' : '独立对话'}</small></span>
          </button>)}
          {recentError && <ErrorBox error={recentError} onRetry={onThreadsChanged} />}
          {!tasksLoading && !tasksError && !recentError && recentTasks.length === 0 && recentConversations.length === 0 && <p className="nav-empty">还没有独立任务。<br />点击 ＋ 开始，或先和 kibot 聊聊。</p>}
          {(recentThreads.length > 8 || (workSnapshot?.tasks.length ?? 0) > 12) && <button className="nav-action nav-more" onClick={() => openNavigation('history')}>查看历史对话<Icon name="arrow" size={15} /></button>}
        </div>
        <div className="nav-bottom"><button className="nav-profile" onClick={() => openNavigation('account')} aria-label="个人设置"><span className="sidebar-avatar">{(user.displayName || user.username).slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName || user.username}</strong><small>个人设置</small></span><Icon name="settings" size={18} /></button></div>
      </aside>
      <div className="main-shell" inert={mobile && sidebarOpen || undefined}>
        <header className="kibot-mobile-topbar"><button ref={sidebarOpenButton} className="icon-button" aria-label="打开导航" aria-expanded={sidebarOpen} aria-controls="primary-navigation" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button><Brand small /><button className="icon-button" aria-label="新建任务" onClick={() => openNavigation('new')}><Icon name="plus" /></button></header>
        {view === 'workspace' ? (primaryLoading || (!primaryThread && !primaryError)) && !threadId ? <div className="boot-screen"><Loading label="正在打开 kibot…" /></div>
          : primaryError && !threadId ? <div className="boot-screen"><ErrorBox error={primaryError} onRetry={() => setPrimaryRetry(value => value + 1)} /></div>
          : <Workspace key={user.id + ':' + (projectId || 'chat') + ':' + workspaceVersion} project={selectedProject} threadId={threadId} isKibot={isKibot} initialTask={initialTask}
            onThreadCreated={onThreadCreated} onThreadsChanged={onThreadsChanged} user={user} providerConfigured={!!session?.providerConfigured} model={session?.model} defaultChatModel={session?.defaultChatModel} chatModels={session?.chatModels} refreshSession={refreshSession}
            onRenameProject={() => void renameProject()} onDeleteProject={() => void deleteProject()} onOpenAccount={() => void navigate('account')}
            onOpenLocal={async () => { if (await confirmNavigation()) setLocalDialog('open'); }} />
          : view === 'local' ? <LocalDevices /> : view === 'admin' && user.role === 'admin' ? <Admin currentUser={user} onModelsSaved={() => void refreshSession(user.id).catch(() => undefined)} /> : <Account user={user} refreshSession={refreshSession} />}
      </div>
    </div>
    {navigationPanel === 'history' && <Modal title="搜索历史" description="按标题查找独立对话；kibot 的历史记录在主会话摘要中查看。" onClose={() => setNavigationPanel(null)}>
      <div className="nav-search-field"><Icon name="search" /><input autoFocus aria-label="搜索历史对话" placeholder="搜索对话标题" value={historySearch} onChange={event => setHistorySearch(event.target.value)} /></div>
      <div className="nav-dialog-body">
        {primaryThread && (!historySearch.trim() || 'kibot 主会话'.includes(historySearch.trim().toLowerCase())) && <button className="nav-result-row" onClick={() => void selectThread(primaryThread)}><Icon name="spark" /><span><strong>kibot</strong><small>主会话 · 时间摘要与完整历史</small></span><Icon name="chevron" /></button>}
        {chatsLoading ? <Loading label="搜索中…" /> : chatsError ? <ErrorBox error={chatsError} onRetry={onThreadsChanged} /> : chats.filter(thread => thread.id !== primaryThread?.id).map(thread => <button key={thread.id} className="nav-result-row" onClick={() => void selectThread(thread)}><Icon name={thread.projectId ? 'folder' : 'chat'} /><span><strong>{thread.title || '未命名对话'}</strong><small>{thread.projectId ? '项目对话' : '独立对话'}</small></span><Icon name="chevron" /></button>)}
        {!chatsLoading && !chatsError && chats.length === 0 && <p className="nav-empty">{historySearch.trim() ? '没有匹配的历史对话。' : '还没有独立对话。'}</p>}
        <p className="nav-empty">最多显示最近 100 条匹配记录。</p>
      </div>
    </Modal>}
    {navigationPanel === 'new' && <Modal title="新建任务" description="独立任务与 kibot 主会话分开保存。需要操作文件时，选择一个项目。" onClose={() => setNavigationPanel(null)}>
      <div className="nav-dialog-actions"><button className="nav-result-row" onClick={() => void startNewConversation()}><Icon name="chat" /><span><strong>开始独立对话</strong><small>讨论想法、写作或研究</small></span><Icon name="arrow" /></button>
        <button className="nav-result-row" disabled={creating} onClick={() => void createProject()}><Icon name="plus" /><span><strong>创建项目</strong><small>在服务器或已配对电脑上创建项目</small></span><Icon name="arrow" /></button>
        <button className="nav-result-row" onClick={async () => { if (await confirmNavigation()) { setNavigationPanel(null); setLocalDialog('open'); } }}><Icon name="terminal" /><span><strong>打开本地项目</strong><small>连接已配对电脑上的现有文件夹</small></span><Icon name="arrow" /></button></div>
      <div className="nav-section-heading"><span>已有项目</span></div>
      <div className="nav-search-field"><Icon name="search" /><input aria-label="搜索项目" placeholder="搜索项目" value={projectSearch} onChange={event => setProjectSearch(event.target.value)} /></div>
      <div className="nav-dialog-body">{projectsLoading ? <Loading label="加载项目…" /> : projectsError ? <ErrorBox error={projectsError} onRetry={() => void loadProjects()} /> : projects.filter(project => project.name.toLowerCase().includes(projectSearch.toLowerCase())).map(project => <button className="nav-result-row" key={project.id} onClick={() => void selectProject(project.id)}><Icon name={project.location === 'local' ? 'terminal' : 'folder'} /><span><strong>{project.name}</strong><small>{project.location === 'local' ? '本地项目' : '云端项目'}</small></span><Icon name="chevron" /></button>)}
        {!projectsLoading && !projectsError && !projects.some(project => project.name.toLowerCase().includes(projectSearch.toLowerCase())) && <p className="nav-empty">{projectSearch ? '没有匹配的项目。' : '还没有项目。'}</p>}
      </div>
    </Modal>}
    {navigationPanel === 'account' && <Modal title="个人设置" description={user.displayName || user.username} onClose={() => setNavigationPanel(null)}>
      <div className="nav-dialog-actions"><button className="nav-result-row" onClick={() => void navigate('account')}><Icon name="settings" /><span><strong>账户与 API Key</strong><small>本站用量 {number(user.usedTokens)} tokens · 密钥{user.apiKeyConfigured ? '已配置' : '未配置'}</small></span><Icon name="chevron" /></button>
        <button className="nav-result-row" onClick={() => void navigate('local')}><Icon name="terminal" /><span><strong>本地助手</strong><small>管理配对电脑与授权</small></span><Icon name="chevron" /></button>
        {user.role === 'admin' && <button className="nav-result-row" onClick={() => void navigate('admin')}><Icon name="shield" /><span><strong>管理后台</strong><small>用户、用量、模型和会话记录</small></span><Icon name="chevron" /></button>}
        <button className="nav-result-row" onClick={() => { setNavigationPanel(null); void logout(); }}><Icon name="logout" /><span>退出登录</span></button></div>
    </Modal>}
    {localDialog && <LocalProjectDialog mode={localDialog} onClose={() => setLocalDialog(null)} onCloud={() => { setLocalDialog(null); void createCloudProject(); }} onSetup={() => { setLocalDialog(null); void navigate('local'); }} onProject={project => { if (!isCurrentUser()) return; setLocalDialog(null); setProjects(old => [project, ...old.filter(p => p.id !== project.id)]); openConversation(project.id, null); }} />}
  </>;
}
