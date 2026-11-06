import { useCallback, useEffect, useRef, useState } from 'react';
import { api, enc, messageOf } from './api';
import { Icon } from './icons';
import { setDirtyFile } from './navigation';
import { Empty, ErrorBox, Loading, useDialog, useNotice } from './ui';
import type { Diff, FileEntry, Project } from './types';

export function Files({ project, revision, locked, onClose }: { project: Project; revision: number; locked: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'files' | 'diff'>('files');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [diff, setDiff] = useState<Diff>({ diff: '', files: [], truncated: false });
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const requestSequence = useRef(0);
  const ask = useDialog(); const notify = useNotice();
  const dirty = content !== original;
  const prefix = `/api/projects/${enc(project.id)}`;
  const currentFile = useRef({ path, dirty }); currentFile.current = { path, dirty };

  useEffect(() => { setDirtyFile(dirty ? path : ''); return () => setDirtyFile(''); }, [dirty, path]);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [tree, changes] = await Promise.all([api<{ files: FileEntry[] }>(`${prefix}/tree`), api<Diff>(`${prefix}/diff`)]);
      setFiles(tree.files); setDiff(changes);
      const open = currentFile.current;
      if (open.path && !open.dirty) {
        if (!tree.files.some(file => file.path === open.path)) { setPath(''); setContent(''); setOriginal(''); }
        else {
          const latest = await api<{ path: string; content: string }>(`${prefix}/file?path=${enc(open.path)}`);
          if (currentFile.current.path === open.path && !currentFile.current.dirty) { setContent(latest.content); setOriginal(latest.content); }
        }
      }
    } catch (e) { setError(messageOf(e)); } finally { setLoading(false); }
  }, [prefix]);
  useEffect(() => { if (!locked) void refresh(); }, [refresh, revision, locked]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  async function discard() { return !dirty || !!await ask({ title: '放弃未保存的修改？', description: `${path} 的更改尚未保存。`, confirm: '放弃修改', danger: true }); }
  async function openFile(nextPath: string) {
    if (!(await discard())) return;
    const sequence = ++requestSequence.current;
    setFileLoading(true); setError('');
    try {
      const result = await api<{ path: string; content: string }>(`${prefix}/file?path=${enc(nextPath)}`);
      if (requestSequence.current !== sequence) return;
      setPath(result.path); setContent(result.content); setOriginal(result.content); setEditing(false);
    } catch (e) { if (sequence === requestSequence.current) setError(messageOf(e)); } finally { if (sequence === requestSequence.current) setFileLoading(false); }
  }
  async function save() {
    setBusy(true);
    try { await api(`${prefix}/file`, { method: 'PUT', body: { path, content } }); setOriginal(content); setEditing(false); notify('文件已保存'); await refresh(); }
    catch (e) { notify(messageOf(e), 'error'); } finally { setBusy(false); }
  }
  async function createFile() {
    if (!(await discard())) return;
    const values = await ask({ title: '新建文件', description: '可以使用相对路径创建目录中的文件。', fields: [{ name: 'path', label: '文件路径', placeholder: '例如 src/index.ts', maxLength: 240 }], confirm: '创建文件' });
    if (!values) return;
    if (files.some(file => file.path === values.path.trim())) { notify('同名文件已存在，请从文件列表打开。', 'error'); return; }
    setBusy(true);
    try { await api(`${prefix}/file`, { method: 'PUT', body: { path: values.path.trim(), content: '' } }); await refresh(); setPath(values.path.trim()); setContent(''); setOriginal(''); setEditing(true); }
    catch (e) { notify(messageOf(e), 'error'); } finally { setBusy(false); }
  }
  async function removeFile() {
    const values = await ask({ title: '删除文件？', description: `将删除 ${path}。尚未保存到版本中的内容无法通过版本恢复。`, confirm: '删除文件', danger: true });
    if (!values) return;
    setBusy(true);
    try { await api(`${prefix}/file`, { method: 'DELETE', body: { path } }); setPath(''); setContent(''); setOriginal(''); notify('文件已删除'); await refresh(); }
    catch (e) { notify(messageOf(e), 'error'); } finally { setBusy(false); }
  }
  async function importFiles(selected: FileList | null) {
    if (!selected?.length) return;
    if (!(await discard())) return;
    const list = Array.from(selected);
    if (list.length > 50) { notify('每次最多上传 50 个文本文件。', 'error'); return; }
    const existing = list.filter(file => files.some(x => x.path === file.name));
    if (existing.length && !await ask({ title: '覆盖同名文件？', description: `${existing.map(file => file.name).join('、')} 已存在。上传后将覆盖当前内容。`, confirm: '继续上传', danger: true })) return;
    if (dirty) { setContent(original); currentFile.current = { path, dirty: false }; }
    setBusy(true);
    let uploaded = 0;
    try {
      for (const file of list) {
        if (file.size > 1024 * 1024) throw new Error(`${file.name} 超过 1 MB，请拆分后上传。`);
        const text = await file.text();
        if (text.includes('\0')) throw new Error(`${file.name} 不是可编辑的文本文件。`);
        await api(`${prefix}/file`, { method: 'PUT', body: { path: file.name, content: text } }); uploaded++;
      }
      notify(`已上传 ${uploaded} 个文件`);
    } catch (e) { notify(`${uploaded ? `已上传 ${uploaded} 个文件。` : ''}${messageOf(e)}`, 'error'); }
    finally { setBusy(false); await refresh(); if (upload.current) upload.current.value = ''; }
  }
  async function commit() {
    if (dirty) { notify('请先保存正在编辑的文件。', 'info'); return; }
    const values = await ask({ title: '保存项目版本', description: '将当前全部文件修改保存为一个 Git 提交。保存后，差异视图会以这个版本作为新的比较基准。', fields: [{ name: 'message', label: '版本说明', placeholder: '简要描述这次修改', maxLength: 200 }], confirm: '保存版本' });
    if (!values) return;
    setBusy(true);
    try { await api(`${prefix}/commit`, { method: 'POST', body: { message: values.message } }); notify('项目版本已保存'); await refresh(); }
    catch (e) { notify(messageOf(e), 'error'); } finally { setBusy(false); }
  }
  function downloadFile() {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = path.split('/').pop() || 'file.txt'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const lines = diff.diff.split('\n');
  const additions = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
  const deletions = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  return <aside className="files-panel"><div className="panel-heading"><div className="panel-tabs" role="tablist" aria-label="项目内容"><button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}><Icon name="folder" size={16} />文件</button><button role="tab" aria-selected={tab === 'diff'} className={tab === 'diff' ? 'active' : ''} onClick={() => setTab('diff')}><Icon name="diff" size={16} />代码差异{diff.files.length > 0 && <span className="count">{diff.files.length}</span>}</button></div><div className="row"><button className="icon-button" title="刷新项目内容" aria-label="刷新项目内容" disabled={locked || busy} onClick={() => void refresh()}><Icon name="refresh" size={16} /></button><button className="icon-button" title="收起文件面板" aria-label="收起文件面板" onClick={async () => { if (await discard()) onClose(); }}><Icon name="close" size={16} /></button></div></div>{locked && <div className="panel-note"><span className="spinner" />任务运行中，结束后自动刷新文件和差异。</div>}{error && <ErrorBox error={error} onRetry={() => void refresh()} />}{loading && !locked ? <Loading label="正在读取项目…" /> : tab === 'files' ? <><div className="file-actions"><span className="caption">{files.length} 个文件</span><div className="row"><input type="file" multiple ref={upload} hidden onChange={event => void importFiles(event.target.files)} /><button className="icon-button" title="上传文本文件" aria-label="上传文本文件" disabled={busy || locked} onClick={() => upload.current?.click()}><Icon name="upload" size={16} /></button><button className="icon-button" title="新建文件" aria-label="新建文件" disabled={busy || locked} onClick={() => void createFile()}><Icon name="plus" size={18} /></button></div></div><div className="file-search"><Icon name="search" size={15} /><input aria-label="搜索项目文件" placeholder="查找文件…" value={search} onChange={event => setSearch(event.target.value)} /></div><div className={`file-list ${path ? 'file-list-compact' : ''}`}>{files.filter(file => file.path.toLowerCase().includes(search.toLowerCase())).map(file => <button key={file.path} className={`file-row ${path === file.path ? 'selected' : ''}`} disabled={locked} onClick={() => void openFile(file.path)} title={file.path}><Icon name="file" size={15} /><span>{file.path}</span><small>{file.size > 1024 ? `${(file.size / 1024).toFixed(1)} kB` : `${file.size} B`}</small></button>)}{files.length === 0 && <Empty icon="file" title="项目里还没有文件" description="上传文本文件，或让 kivo 帮你创建。" />}{files.length > 0 && !files.some(file => file.path.toLowerCase().includes(search.toLowerCase())) && <p className="muted center small">没有匹配的文件</p>}</div>{fileLoading ? <Loading label="正在打开文件…" /> : path ? <div className="editor"><div className="editor-toolbar"><span title={path}><Icon name="file" size={14} />{path}{dirty && <b className="unsaved-dot" title="未保存" />}</span><div className="row">{editing ? <button className="button small-button primary" disabled={busy || locked || !dirty} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button> : <button className="icon-button" title="编辑文件" aria-label="编辑文件" disabled={locked} onClick={() => setEditing(true)}><Icon name="edit" size={15} /></button>}<button className="icon-button" title="下载文件" aria-label="下载文件" onClick={downloadFile}><Icon name="download" size={15} /></button><button className="icon-button" title="删除文件" aria-label="删除文件" disabled={busy || locked} onClick={() => void removeFile()}><Icon name="trash" size={15} /></button></div></div>{editing ? <textarea className="code-editor" spellCheck={false} aria-label={`编辑 ${path}`} value={content} readOnly={locked} onChange={event => setContent(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); if (dirty && !busy && !locked) void save(); } }} /> : <pre className="code-preview"><code>{content || <span className="muted">空文件</span>}</code></pre>}<div className="editor-status"><span>{editing ? '编辑模式' : '只读预览'} · {content.split('\n').length} 行</span><span>{dirty ? '有未保存的修改' : '已保存'}</span></div></div> : files.length > 0 && <div className="file-preview-hint"><Icon name="code" size={24} /><span>选择一个文件查看内容</span></div>}</> : <div className="diff-panel"><div className="diff-summary"><span>{diff.files.length} 个已修改文件</span><div><b className="addition">+{additions}</b><b className="deletion">−{deletions}</b></div></div>{diff.files.length > 0 ? <><div className="diff-file-list">{diff.files.map(file => <div key={file.path}><span className={`file-status status-${file.status?.trim()}`}>{file.status?.trim() || 'M'}</span><span>{file.path}</span></div>)}</div>{diff.truncated && <div className="panel-note"><Icon name="info" size={15} />差异较大，当前显示部分内容。</div>}<div className="diff-content" aria-label="代码修改对比">{lines.map((line, index) => <div key={index} className={`diff-line ${line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ? 'diff-header' : line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : ''}`}><span className="diff-line-number">{index + 1}</span><code>{line || ' '}</code></div>)}</div><div className="diff-footer"><p>与上次保存的项目版本比较</p><button className="button primary" disabled={busy || locked} onClick={() => void commit()}><Icon name="check" size={16} />{busy ? '保存中…' : '保存项目版本'}</button></div></> : <Empty icon="check" title="所有修改已保存" description="kivo 或你修改文件后，代码差异会出现在这里。" />}</div>}</aside>;
}
