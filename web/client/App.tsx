import { useCallback, useEffect, useRef, useState } from 'react';
import { api, compact, enc, messageOf, number } from './api';
import { Auth } from './Auth';
import { Account } from './Account';
import { Admin } from './Admin';
import { Workspace } from './Workspace';
import { Brand, Icon, Logo } from './icons';
import { getDirtyFile } from './navigation';
import { ErrorBox, Loading, useDialog, useNotice } from './ui';
import type { Project, Session, Thread, User } from './types';

type View = 'workspace' | 'account' | 'admin';
export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('workspace');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [chats, setChats] = useState<Thread[]>([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [chatsError, setChatsError] = useState('');
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsRevision, setThreadsRevision] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarOpenButton = useRef<HTMLButtonElement>(null);
  const sidebarCloseButton = useRef<HTMLButtonElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const [projectSearch, setProjectSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const projectRequest = useRef(0);
  const navigationRevision = useRef(0);
  const ask = useDialog(); const notify = useNotice();
  const user = session?.user;
  const selectedProject = projects.find(project => project.id === projectId) || null;
  const currentNavigation = navigationRevision.current;
  const activeLocation = useRef({ userId: user?.id, projectId, workspaceVersion, view });
  activeLocation.current = { userId: user?.id, projectId, workspaceVersion, view };

  useEffect(() => {
    if (!sidebarOpen || !user) return;
    const mobile = window.matchMedia('(max-width: 800px)');
    const hasModal = () => !!document.querySelector('[role="dialog"][aria-modal="true"]');
    const visible = (element: HTMLElement) => element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== 'hidden';
    const focusClose = () => {
      if (mobile.matches && !hasModal()) sidebarCloseButton.current?.focus({ preventScroll: true });
    };
    const sidebar = sidebarRef.current;
    const opened = (event: TransitionEvent) => {
      if (event.target === sidebar && event.propertyName === 'transform') focusClose();
    };
    sidebar?.addEventListener('transitionend', opened);
    const openingFrame = window.requestAnimationFrame(focusClose);
    const keydown = (event: KeyboardEvent) => {
      if (!mobile.matches || hasModal() || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setSidebarOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !sidebarRef.current) return;
      const focusable = Array.from(sidebarRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]'))
        .filter(element => element.tabIndex >= 0 && visible(element));
      if (!focusable.length) { event.preventDefault(); sidebarRef.current.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!focusable.some(element => element === active)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault(); first.focus();
      }
    };
    const resized = () => { if (!mobile.matches) setSidebarOpen(false); };
    document.addEventListener('keydown', keydown);
    mobile.addEventListener('change', resized);
    return () => {
      window.cancelAnimationFrame(openingFrame);
      sidebar?.removeEventListener('transitionend', opened);
      document.removeEventListener('keydown', keydown);
      mobile.removeEventListener('change', resized);
      const opener = sidebarOpenButton.current;
      if (!hasModal() && opener?.isConnected && visible(opener)) opener.focus();
    };
  }, [sidebarOpen, user?.id]);

  const refreshSession = useCallback(async (expectedUserId?: string) => {
    const result = await api<Session>('/api/session');
    if (expectedUserId && activeLocation.current.userId !== expectedUserId) return;
    setSession(result);
  }, []);
  const initialize = useCallback(async () => {
    setInitializing(true); setError('');
    try { await refreshSession(); } catch (e) { setError(messageOf(e)); } finally { setInitializing(false); }
  }, [refreshSession]);
  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => {
    const expire = () => {
      ++navigationRevision.current; ++projectRequest.current;
      setSession(old => old ? { ...old, user: null } : null); setProjects([]); setThreads([]); setChats([]); setProjectId(null); setThreadId(null); setSidebarOpen(false);
      notify('登录已失效，请重新登录。', 'info'); void api<Session>('/api/session').then(setSession).catch(() => undefined);
    };
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, [notify]);
  const loadProjects = useCallback(async () => {
    const userId = activeLocation.current.userId; const request = ++projectRequest.current;
    if (!userId) return;
    setProjectsLoading(true); setProjectsError('');
    const current = () => activeLocation.current.userId === userId && projectRequest.current === request;
    try { const result = await api<{ projects: Project[] }>('/api/projects'); if (!current()) return; setProjects(result.projects); setProjectId(old => result.projects.some(project => project.id === old) ? old : null); }
    catch (e) { if (current()) setProjectsError(messageOf(e)); } finally { if (current()) setProjectsLoading(false); }
  }, []);
  useEffect(() => { if (user?.id) void loadProjects(); }, [user?.id, loadProjects]);
  useEffect(() => {
    if (!user?.id) { setChats([]); setChatsLoading(false); return; }
    let cancelled = false; setChatsLoading(true); setChatsError('');
    api<{ threads: Thread[] }>('/api/threads').then(result => { if (!cancelled) setChats(result.threads); }).catch(e => { if (!cancelled) setChatsError(messageOf(e)); }).finally(() => { if (!cancelled) setChatsLoading(false); });
    return () => { cancelled = true; };
  }, [user?.id, threadsRevision]);
  useEffect(() => {
    if (!projectId || !user) { setThreads([]); setThreadsLoading(false); return; }
    let cancelled = false; setThreadsLoading(true);
    api<{ threads: Thread[] }>(`/api/projects/${enc(projectId)}/threads`).then(result => { if (!cancelled) setThreads(result.threads); }).catch(e => { if (!cancelled) notify(messageOf(e), 'error'); }).finally(() => { if (!cancelled) setThreadsLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, user?.id, threadsRevision]);
  const onThreadsChanged = useCallback(() => setThreadsRevision(old => old + 1), []);
  const onThreadCreated = useCallback((thread: Thread) => {
    const current = activeLocation.current;
    if (current.userId !== user?.id) return;
    if (thread.projectId == null) setChats(old => [thread, ...old.filter(item => item.id !== thread.id)]);
    else if (current.projectId === thread.projectId) setThreads(old => [thread, ...old.filter(item => item.id !== thread.id)]);
    if (navigationRevision.current === currentNavigation && current.view === 'workspace' && current.projectId === projectId && current.workspaceVersion === workspaceVersion) setThreadId(thread.id);
    setThreadsRevision(old => old + 1);
  }, [projectId, workspaceVersion, user?.id, currentNavigation]);
  async function confirmNavigation() {
    const path = getDirtyFile();
    return !path || !!await ask({ title: '离开未保存的文件？', description: `${path} 的修改尚未保存。离开后这些编辑内容将丢失。`, confirm: '放弃修改并继续', danger: true });
  }
  async function navigate(next: View) { if (next !== view && !(await confirmNavigation())) return; ++navigationRevision.current; setView(next); setSidebarOpen(false); if (user) void refreshSession(user.id).catch(() => undefined); }
  function openConversation(nextProjectId: string | null, nextThreadId: string | null) {
    ++navigationRevision.current;
    if (nextProjectId !== projectId) setThreads([]);
    setProjectId(nextProjectId); setThreadId(nextThreadId); setWorkspaceVersion(version => version + 1); setView('workspace'); setSidebarOpen(false);
    if (user) void refreshSession(user.id).catch(() => undefined);
  }
  async function selectProject(id: string) { if (!(await confirmNavigation())) return; openConversation(id, null); }
  async function selectThread(thread: Thread) {
    if (view === 'workspace' && thread.id === threadId && thread.projectId === projectId) { setSidebarOpen(false); return; }
    if (!(await confirmNavigation())) return;
    openConversation(thread.projectId, thread.id);
  }
  async function startNewConversation() {
    if (!(await confirmNavigation())) return;
    openConversation(null, null);
  }
  async function startProjectConversation() {
    if (!selectedProject || !(await confirmNavigation())) return;
    openConversation(selectedProject.id, null);
  }
  async function createProject() {
    if (!(await confirmNavigation())) return;
    const values = await ask({ title: '创建新项目', description: '每个项目都有独立的文件空间和对话历史。', fields: [{ name: 'name', label: '项目名称', placeholder: '例如：我的个人网站', maxLength: 80 }], confirm: '创建项目' });
    if (!values) return;
    const requestUser = user?.id; const location = navigationRevision.current;
    if (!requestUser) return;
    setCreating(true);
    try { const result = await api<{ project: Project }>('/api/projects', { method: 'POST', body: { name: values.name.trim() } }); if (activeLocation.current.userId !== requestUser) return; ++projectRequest.current; setProjectsLoading(false); setProjects(old => [result.project, ...old.filter(project => project.id !== result.project.id)]); if (navigationRevision.current === location) openConversation(result.project.id, null); notify('项目已创建'); }
    catch (e) { notify(messageOf(e), 'error'); } finally { setCreating(false); }
  }
  async function renameProject() {
    if (!selectedProject) return;
    const values = await ask({ title: '重命名项目', fields: [{ name: 'name', label: '项目名称', value: selectedProject.name, maxLength: 80 }], confirm: '保存名称' });
    if (!values) return;
    try { await api(`/api/projects/${enc(selectedProject.id)}`, { method: 'PATCH', body: { name: values.name.trim() } }); await loadProjects(); notify('项目名称已更新'); }
    catch (e) { notify(messageOf(e), 'error'); }
  }
  async function deleteProject() {
    if (!selectedProject) return;
    const values = await ask({ title: '永久删除项目？', description: `「${selectedProject.name}」的文件和对话历史将被删除。此操作无法撤销，请输入项目名称确认。`, fields: [{ name: 'name', label: '输入项目名称', placeholder: selectedProject.name }], confirm: '删除项目', danger: true });
    if (!values) return;
    if (values.name !== selectedProject.name) { notify('项目名称不匹配，未执行删除。', 'error'); return; }
    try { await api(`/api/projects/${enc(selectedProject.id)}`, { method: 'DELETE' }); if (activeLocation.current.projectId === selectedProject.id) openConversation(null, null); await loadProjects(); notify('项目已删除'); }
    catch (e) { notify(messageOf(e), 'error'); }
  }
  async function logout() {
    const confirmed = await ask({ title: '退出登录？', description: getDirtyFile() ? `${getDirtyFile()} 的修改尚未保存，退出将丢失这些编辑。已保存的项目和对话会保留。` : '已保存的项目和对话会保留。', confirm: '退出登录', danger: !!getDirtyFile() });
    if (!confirmed) return;
    try { await api('/api/auth/logout', { method: 'POST' }); ++navigationRevision.current; ++projectRequest.current; setProjects([]); setThreads([]); setChats([]); setProjectId(null); setThreadId(null); setSidebarOpen(false); setView('workspace'); await refreshSession(); }
    catch (e) { notify(messageOf(e), 'error'); }
  }
  async function onLogin(nextUser: User) { ++navigationRevision.current; setProjectId(null); setThreadId(null); setWorkspaceVersion(version => version + 1); setSession(old => ({ user: nextUser, csrfToken: old?.csrfToken || '', providerConfigured: old?.providerConfigured || false, model: old?.model })); setView('workspace'); await refreshSession(); }
  if (initializing) return <div className="boot-screen"><Brand /><Loading label="正在打开工作空间…" /></div>;
  if (error && !session) return <div className="boot-screen"><Brand /><ErrorBox error={error} onRetry={() => void initialize()} /></div>;
  if (!user) return <Auth onLogin={nextUser => void onLogin(nextUser)} />;
  return <div className={'app-shell' + (sidebarCollapsed ? ' sidebar-collapsed' : '')}>
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}
    {sidebarCollapsed && <aside className="desktop-rail" aria-label="收起的导航">
      <span className="rail-logo logo-container"><Logo /></span>
      <button className="icon-button" aria-label="展开侧栏" title="展开侧栏" onClick={() => setSidebarCollapsed(false)}><Icon name="sidebar" size={20} /></button>
      <button className="icon-button" aria-label="新对话" title="新对话" onClick={() => void startNewConversation()}><Icon name="edit" size={20} /></button>
      <div className="rail-spacer" />
      {user.role === 'admin' && <button className="icon-button" title="管理后台" aria-label="管理后台" onClick={() => void navigate('admin')}><Icon name="shield" size={20} /></button>}
      <button className="icon-button" title="账户设置" aria-label="账户设置" onClick={() => void navigate('account')}><Icon name="user" size={20} /></button>
    </aside>}
    <aside ref={sidebarRef} id="primary-navigation" aria-label="主导航" tabIndex={-1} className={'sidebar' + (sidebarOpen ? ' sidebar-open' : '')}>
      <div className="sidebar-brand">
        <Brand small />
        <button className="icon-button sidebar-collapse" aria-label="收起侧栏" title="收起侧栏" onClick={() => setSidebarCollapsed(true)}><Icon name="sidebar" size={19} /></button>
        <button ref={sidebarCloseButton} className="icon-button mobile-close" aria-label="关闭导航" onClick={() => setSidebarOpen(false)}><Icon name="close" /></button>
      </div>
      <div className="sidebar-top">
        <nav className="sidebar-primary" aria-label="工作空间">
          <button className={'sidebar-action sidebar-new-chat' + (view === 'workspace' && !projectId && !threadId ? ' selected' : '')} onClick={() => void startNewConversation()}><Icon name="edit" size={19} /><span>新对话</span></button>
          <button className="sidebar-action" disabled={creating} onClick={() => void createProject()}><Icon name="folder" size={19} /><span>{creating ? '正在创建…' : '创建项目'}</span></button>
        </nav>
      </div>
      <div className="sidebar-scroll">
        <div className="sidebar-section-label"><span>最近对话</span></div>
        {chatsLoading && chats.length === 0 ? <div className="sidebar-loading small">加载对话…</div> : chatsError ? <div className="sidebar-error"><p>{chatsError}</p><button onClick={onThreadsChanged}>重试</button></div> : chats.map(thread => <button key={thread.id} title={thread.title} className={'sidebar-thread' + (view === 'workspace' && !projectId && threadId === thread.id ? ' selected' : '')} onClick={() => void selectThread(thread)}><Icon name="chat" size={15} /><span>{thread.title || '未命名对话'}</span></button>)}
        {!chatsLoading && !chatsError && chats.length === 0 && <p className="sidebar-empty small">直接开始聊天，对话会保存在这里。</p>}
        <div className="sidebar-projects">
        <div className="sidebar-section-label"><span>项目空间</span><span>{projects.length}</span></div>
        <div className="sidebar-search"><Icon name="search" size={17} /><input value={projectSearch} onChange={event => setProjectSearch(event.target.value)} aria-label="搜索项目" placeholder="搜索项目" /></div>
        {projectsLoading ? <div className="sidebar-loading"><span className="spinner" />加载项目…</div> : projectsError ? <div className="sidebar-error"><p>{projectsError}</p><button onClick={() => void loadProjects()}>重试</button></div> : projects.filter(project => project.name.toLowerCase().includes(projectSearch.toLowerCase())).map(project => <button key={project.id} className={'sidebar-project' + (view === 'workspace' && projectId === project.id ? ' selected' : '')} onClick={() => void selectProject(project.id)}><Icon name="folder" size={17} /><span>{project.name}</span>{projectId === project.id && <span className="project-selected-dot" />}</button>)}
        {!projectsLoading && projects.length === 0 && <p className="sidebar-empty">需要操作文件和修改代码时，可以创建项目。</p>}
        {projectSearch && projects.length > 0 && !projects.some(project => project.name.toLowerCase().includes(projectSearch.toLowerCase())) && <p className="sidebar-empty">没有匹配的项目。</p>}
        {selectedProject && <div className="sidebar-conversations">
          <div className="sidebar-section-label"><span>项目对话</span><button className="icon-button" title="新建项目对话" aria-label="新建项目对话" onClick={() => void startProjectConversation()}><Icon name="plus" size={15} /></button></div>
          <p className="sidebar-project-context">{selectedProject.name}</p>
          {threadsLoading ? <div className="sidebar-loading small">加载对话…</div> : threads.map(thread => <button key={thread.id} title={thread.title} className={'sidebar-thread' + (view === 'workspace' && projectId === thread.projectId && threadId === thread.id ? ' selected' : '')} onClick={() => void selectThread(thread)}><Icon name="chat" size={15} /><span>{thread.title || '未命名对话'}</span></button>)}
          {!threadsLoading && threads.length === 0 && <p className="sidebar-empty small">对话开始后，会保存在这里。</p>}
        </div>}
        </div>
      </div>
      <div className="sidebar-bottom">
        <button className="sidebar-usage" onClick={() => void navigate('account')} title={'本站已知用量 ' + number(user.usedTokens) + ' tokens'}><div><Icon name="activity" size={16} /><span>本站用量</span><strong>{compact(user.usedTokens)}</strong></div><span><span>API Key · {user.apiKeyConfigured ? '已配置' : '未配置'}</span><Icon name="chevron" size={13} /></span></button>
        <nav className="sidebar-nav">
          <button className={view === 'account' ? 'selected' : ''} onClick={() => void navigate('account')}><Icon name="settings" size={18} />账户设置</button>
          {user.role === 'admin' && <button className={view === 'admin' ? 'selected' : ''} onClick={() => void navigate('admin')}><Icon name="shield" size={18} />管理后台</button>}
        </nav>
        <div className="sidebar-profile"><div className="sidebar-avatar">{(user.displayName || user.username).slice(0, 1).toUpperCase()}</div><div><strong>{user.displayName || user.username}</strong><span>{user.role === 'admin' ? '管理员' : '成员'}</span></div><button className="icon-button" title="退出登录" aria-label="退出登录" onClick={() => void logout()}><Icon name="logout" size={17} /></button></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="mobile-topbar"><button ref={sidebarOpenButton} className="icon-button" aria-label="打开导航" aria-expanded={sidebarOpen} aria-controls="primary-navigation" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button><Brand small /><button className="icon-button" aria-label="账户设置" onClick={() => void navigate('account')}><Icon name="user" /></button></header>
      {view === 'workspace' ? <Workspace key={(projectId || 'chat') + ':' + workspaceVersion} project={selectedProject} threadId={threadId} onThreadCreated={onThreadCreated} onThreadsChanged={onThreadsChanged} user={user} providerConfigured={!!session?.providerConfigured} model={session?.model} refreshSession={refreshSession} onRenameProject={() => void renameProject()} onDeleteProject={() => void deleteProject()} onOpenAccount={() => void navigate('account')} /> : view === 'admin' && user.role === 'admin' ? <Admin currentUser={user} /> : <Account user={user} refreshSession={refreshSession} />}
    </div>
  </div>;
}
