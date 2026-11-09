import { useEffect, useRef, useState } from 'react';
import { api, enc, messageOf } from './api';
import { Icon } from './icons';
import { ErrorBox, Modal, useDialog, useNotice } from './ui';
import type { Project } from './types';

type Device = { id: string; name: string; platform: string; rootName: string; online: boolean; createdAt: string };
function useDevices() {
  const [devices, setDevices] = useState<Device[]>([]), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    const refresh = () => api<{ devices: Device[] }>('/api/local-devices').then(r => { if (alive) { setDevices(r.devices); setError(''); } }).catch(e => { if (alive) setError(messageOf(e)); });
    void refresh(); const timer = setInterval(() => void refresh(), 8000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return { devices, error, setDevices };
}
export function LocalDevices() {
  const { devices, error, setDevices } = useDevices();
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false);
  const notify = useNotice(), ask = useDialog();
  async function pair() {
    if (busy) return; setBusy(true);
    try { const { device } = await api<{ device: Device }>('/api/local-devices/pair', { method: 'POST', body: { code } }); setDevices(old => [device, ...old]); setCode(''); notify('已完成配对，等待电脑连接'); }
    catch (e) { notify(messageOf(e), 'error'); } finally { setBusy(false); }
  }
  async function revoke(device: Device) {
    if (!await ask({ title: '断开这台电脑？', description: `将停止「${device.name}」上的 kivo 任务并撤销此设备的授权。本地文件会保留，再次使用需要重新配对。`, confirm: '断开配对', danger: true })) return;
    try { await api('/api/local-devices/' + enc(device.id), { method: 'DELETE' }); setDevices(old => old.filter(d => d.id !== device.id)); notify('设备授权已撤销'); } catch (e) { notify(messageOf(e), 'error'); }
  }
  return <section className="local-page"><header className="local-page-header"><h1>本地助手</h1><p>在网页中对话，在自己的电脑上读取文件、修改代码和运行项目。</p></header>
    {error && <ErrorBox error={error} />}
    <div className="local-setup-grid"><section className="local-card"><h2>1. 启动电脑上的助手</h2><p>需要 Node.js 22 或更新版本。安装程序会安装固定版本的 Codex，并询问你允许操作的项目父目录。</p>
      <label className="field"><span>macOS / Linux · 在终端中运行</span><pre className="install-command">curl -fL https://kivo.iptnet.xyz/local-assistant/install.sh -o /tmp/kivo-install.sh{'\n'}bash /tmp/kivo-install.sh</pre></label>
      <div className="row"><a className="button secondary" href="/local-assistant/install.sh" download>下载安装脚本</a><a className="button secondary" href="/local-assistant/kivo-local.mjs" download>下载助手源码</a></div>
      <p className="local-muted">助手主动连接网站，无需开放电脑端口。保持终端运行；关闭助手后，该电脑会显示离线。当前自动安装支持 macOS / Linux。</p>
    </section><section className="local-card"><h2>2. 配对到你的账号</h2><p>输入本地助手终端显示的 10 位配对码。只配对你自己的电脑。</p>
      <form onSubmit={e => { e.preventDefault(); void pair(); }}><label className="field"><span>配对码</span><input autoComplete="off" value={code} onChange={e => setCode(e.target.value.toUpperCase())} maxLength={16} placeholder="例如 A1B2C3D4E5" required /></label><button className="button primary" disabled={busy || code.replaceAll('-', '').length !== 10}>{busy ? '正在配对…' : '连接这台电脑'}</button></form>
      <p className="local-muted">文件和命令在本机处理。发给模型的上下文、对话和执行日志会经过 kivo，并按当前规则记录用量，管理员可查看会话记录。API Key 无需交给本地助手。</p>
    </section></div>
    <section className="local-card"><h2>我的电脑</h2>{!devices.length ? <p className="local-muted">尚未连接电脑。完成配对后，即可在“创建项目”或对话框中打开本地目录。</p> : devices.map(device => <div className="local-device" key={device.id}><Icon name="terminal" /><div><strong>{device.name}</strong><small>{device.platform} · 授权目录 {device.rootName}</small></div><span className={'device-presence' + (device.online ? ' online' : '')}>{device.online ? '在线' : '离线'}</span><button className="button secondary small-button" onClick={() => void revoke(device)}>断开配对</button></div>)}</section>
  </section>;
}

export function LocalProjectDialog({ mode, onClose, onCloud, onSetup, onProject }: { mode: 'create' | 'open'; onClose: () => void; onCloud: () => void; onSetup: () => void; onProject: (project: Project) => void }) {
  const { devices, error: devicesError } = useDevices();
  const [deviceId, setDeviceId] = useState(''), [folder, setFolder] = useState(''), [folders, setFolders] = useState<string[]>([]);
  const [name, setName] = useState(''), [create, setCreate] = useState(mode === 'create'), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const revision = useRef(0);
  const device = devices.find(d => d.id === deviceId);
  useEffect(() => { if (!deviceId && devices.some(d => d.online)) setDeviceId(devices.find(d => d.online)!.id); }, [devices, deviceId]);
  useEffect(() => {
    const current = ++revision.current; setFolders([]); setError('');
    if (!deviceId) return;
    setLoading(true);
    api<{ folders: string[] }>(`/api/local-devices/${enc(deviceId)}/folders?path=${enc(folder)}`).then(r => { if (revision.current === current) setFolders(r.folders); }).catch(e => { if (revision.current === current) setError(messageOf(e)); }).finally(() => { if (revision.current === current) setLoading(false); });
    return () => { ++revision.current; };
  }, [deviceId, folder]);
  async function connect() {
    if (busy || !device?.online) return; setBusy(true); setError('');
    try {
      const { project } = await api<{ project: Project }>('/api/local-projects', { method: 'POST', body: { deviceId, path: folder, create, name: create ? name.trim() : folder.split('/').at(-1) || device.rootName } });
      onProject(project);
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <Modal title={mode === 'create' ? '创建项目' : '打开本地文件夹'} description="选择你已连接的电脑和目录。读写文件与项目命令都在该电脑上执行。" onClose={busy ? () => {} : onClose}>
    <div className="local-picker">
      {mode === 'create' && <button className="button secondary" onClick={onCloud}>改为创建云端项目</button>}
      {!devices.length ? <div className="local-empty"><Icon name="terminal" size={28} /><p>先连接本地助手，再打开电脑上的项目。</p><button className="button primary" onClick={onSetup}>设置本地助手</button></div> : <>
        <label className="field"><span>电脑</span><select value={deviceId} onChange={e => { setDeviceId(e.target.value); setFolder(''); }} disabled={busy}><option value="">选择电脑</option>{devices.map(d => <option key={d.id} value={d.id}>{d.name} · {d.online ? '在线' : '离线'}</option>)}</select></label>
        <div className="local-path"><button className="icon-button" title="上一级" aria-label="上一级" disabled={!folder || busy} onClick={() => setFolder(folder.split('/').slice(0, -1).join('/'))}><Icon name="up" size={17} /></button><span>{device?.rootName || '授权目录'}{folder ? '/' + folder : ''}</span></div>
        <div className="local-folder-list">{loading ? <p>正在读取本地目录…</p> : folders.length ? folders.map(entry => <button key={entry} disabled={busy} onClick={() => setFolder([folder, entry].filter(Boolean).join('/'))}><Icon name="folder" size={17} /><span>{entry}</span><Icon name="chevron" size={13} /></button>) : <p>此目录下没有其他可选文件夹</p>}</div>
        <label className="local-toggle"><input type="checkbox" checked={create} onChange={e => setCreate(e.target.checked)} disabled={busy} />在当前目录新建项目文件夹</label>
        {create && <label className="field"><span>新文件夹名称</span><input value={name} onChange={e => setName(e.target.value)} maxLength={80} placeholder="my-project" disabled={busy} /></label>}
        <p className="local-muted">会在电脑上保存文本检查点，用于显示修改差异；不改动已有 Git 历史。密钥文件、依赖目录和符号链接不会在网页文件面板中显示。</p>
        <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={onClose}>取消</button><button className="button primary" disabled={!device?.online || busy || loading || (create && (!name.trim() || /[\\/]/.test(name)))} onClick={() => void connect()}>{busy ? '正在连接…' : create ? '在本机创建项目' : '打开此目录'}</button></div>
      </>}
      {(error || devicesError) && <ErrorBox error={error || devicesError} />}
    </div>
  </Modal>;
}

type Approval = { id: string; kind: string; command: string; reason: string; cwd: string; grantRoot: string; network: { host: string; protocol: string } | null };
export function LocalApprovals({ runId }: { runId: string }) {
  const [items, setItems] = useState<Approval[]>([]), [busy, setBusy] = useState('');
  const notify = useNotice();
  useEffect(() => {
    let alive = true;
    const read = () => api<{ approvals: Approval[] }>(`/api/runs/${enc(runId)}/approvals`).then(r => { if (alive) setItems(r.approvals); }).catch(() => {});
    void read(); const timer = setInterval(() => void read(), 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [runId]);
  async function decide(id: string, decision: 'accept' | 'decline') {
    setBusy(id);
    try { await api(`/api/runs/${enc(runId)}/approvals/${enc(id)}`, { method: 'POST', body: { decision } }); setItems(old => old.filter(item => item.id !== id)); }
    catch (e) { notify(messageOf(e), 'error'); } finally { setBusy(''); }
  }
  return <>{items.map(item => <div className="local-approval" key={item.id}><strong><Icon name="shield" size={17} />本地操作需要确认</strong>{item.reason && <p>{item.reason}</p>}{item.command && <pre>{item.command}</pre>}<p className="local-muted">目录：{item.cwd}{item.grantRoot && ` · 额外目录：${item.grantRoot}`}{item.network && ` · 网络：${item.network.host} (${item.network.protocol})`}</p><div className="row"><button className="button secondary" disabled={!!busy} onClick={() => void decide(item.id, 'decline')}>拒绝</button><button className="button primary" disabled={!!busy} onClick={() => void decide(item.id, 'accept')}>仅允许这一次</button></div></div>)}</>;
}
