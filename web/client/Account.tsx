import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, dateTime, fullDate, messageOf, number } from './api';
import { Icon } from './icons';
import { ErrorBox, Loading, useDialog, useNotice } from './ui';
import { Pagination, UsageTable } from './Usage';
import type { ApiKeyStatus, UsagePage, User } from './types';

const PAGE_SIZE = 25;
export function Account({ user, refreshSession }: { user: User; refreshSession: () => Promise<void> }) {
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null);
  const [usage, setUsage] = useState<UsagePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const notify = useNotice(); const ask = useDialog();
  const loadKey = useCallback(async () => { setKeyStatus(await api<ApiKeyStatus>('/api/account/api-key')); }, []);
  const loadUsage = useCallback(async () => {
    setLoading(true); setError('');
    try { setUsage(await api<UsagePage>(`/api/account/usage?limit=${PAGE_SIZE}&offset=${offset}`)); }
    catch (e) { setError(messageOf(e)); } finally { setLoading(false); }
  }, [offset]);
  useEffect(() => { void loadKey().catch(e => setKeyError(messageOf(e))); }, [loadKey]);
  useEffect(() => { void loadUsage(); }, [loadUsage]);
  async function refresh() { await Promise.all([loadUsage(), loadKey(), refreshSession()]).catch(e => notify(messageOf(e), 'error')); }
  async function saveKey(event: FormEvent) {
    event.preventDefault(); const value = apiKey.trim();
    if (!value) return;
    setKeyBusy(true); setKeyError(''); setApiKey('');
    try {
      const result = await api<ApiKeyStatus>('/api/account/api-key', { method: 'PUT', body: { apiKey: value } });
      setKeyStatus(result); await refreshSession(); notify('个人 API Key 已保存，实际可用性以模型调用结果为准。');
    } catch (e) { setKeyError(messageOf(e)); } finally { setKeyBusy(false); }
  }
  async function deleteKey() {
    if (!await ask({ title: '删除个人 API Key？', description: '删除后，重新配置密钥才能发起新的模型任务。已有项目和对话会保留。', confirm: '删除密钥', danger: true })) return;
    setKeyBusy(true); setKeyError(''); setApiKey('');
    try { setKeyStatus(await api<ApiKeyStatus>('/api/account/api-key', { method: 'DELETE' })); await refreshSession(); notify('个人 API Key 已删除'); }
    catch (e) { setKeyError(messageOf(e)); } finally { setKeyBusy(false); }
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    if (form.get('newPassword') !== form.get('confirmPassword')) { setPasswordError('两次输入的新密码不一致。'); return; }
    setPasswordBusy(true); setPasswordError('');
    try { await api('/api/auth/password', { method: 'POST', body: { currentPassword: form.get('currentPassword'), newPassword: form.get('newPassword') } }); formElement.reset(); notify('密码已更新，其他登录会话已退出。'); await refreshSession(); }
    catch (e) { setPasswordError(messageOf(e)); } finally { setPasswordBusy(false); }
  }
  return <main className="dashboard-content">
    <div className="page-heading"><div><div className="eyebrow dark-eyebrow">YOUR ACCOUNT</div><h1>账户设置</h1><p>配置个人模型密钥，查看用量与账户安全。</p></div><button className="button secondary" onClick={() => void refresh()}><Icon name="refresh" size={16} />刷新</button></div>
    <div className="stats-grid"><div className="stat-card"><div className="stat-label"><Icon name="key" />个人 API Key</div><strong className="stat-text">{keyStatus?.configured ? '已配置' : '未配置'}</strong><span>{keyStatus?.configured ? `尾号 ${keyStatus.last4 || '••••'} · 仅用于你的任务` : '使用前请填写本人 OpenAI 密钥'}</span></div><div className="stat-card stat-primary"><div className="stat-label"><Icon name="activity" />本站累计用量</div><strong>{number(user.usedTokens)}</strong><span>已知输入与输出 token 总和</span></div><div className="stat-card"><div className="stat-label"><Icon name="activity" />OpenAI 账户余额</div><a className="billing-link" href="https://platform.openai.com/settings/organization/billing/overview" target="_blank" rel="noopener noreferrer">请在 OpenAI 查看 <Icon name="arrow" size={15} /></a><span>普通 API Key 无法读取账户余额</span></div></div>
    <section className="card api-key-card"><div className="card-heading"><div><h2>我的 OpenAI API Key</h2><p>每位用户使用自己的密钥，模型费用计入本人 OpenAI 账户。</p></div><span className={`status-badge ${keyStatus?.configured ? 'status-completed' : 'status-interrupted'}`}>{keyStatus?.configured ? '已配置' : '未配置'}</span></div><div className="api-key-body">{keyError && <ErrorBox error={keyError} />}{keyStatus?.configured && <div className="saved-key"><Icon name="lock" size={17} /><code>••••••••••••{keyStatus.last4}</code><span>{keyStatus.updatedAt ? `${dateTime(keyStatus.updatedAt)} 更新` : ''}</span></div>}<form className="api-key-form" onSubmit={saveKey}><label className="field"><span>{keyStatus?.configured ? '替换 API Key' : '输入 API Key'}</span><input type="password" name="personal-api-key" autoComplete="off" spellCheck={false} autoCapitalize="none" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="sk-…" required maxLength={1027} disabled={keyBusy} /><small>保存后不再显示完整密钥，只显示尾号。输入框会在提交后清空。</small></label><div className="api-key-actions">{keyStatus?.configured && <button type="button" className="button secondary danger-text" onClick={() => void deleteKey()} disabled={keyBusy}><Icon name="trash" size={15} />删除密钥</button>}<button type="submit" className="button primary" disabled={keyBusy || !apiKey.trim()}>{keyBusy ? <span className="spinner" /> : <Icon name="key" size={15} />}{keyStatus?.configured ? '保存新密钥' : '保存密钥'}</button></div></form><p className="key-help">“已配置”表示密钥已保存，不代表已验证网络、账户余额或模型权限。</p></div></section>
    <div className="info-strip privacy-notice"><Icon name="eye" size={17} /><p>工作空间管理员可以查看用户会话、任务执行记录和模型用量。管理后台不会显示你的 API Key 明文。</p></div>
    <section className="card"><div className="card-heading"><div><h2>本站模型用量</h2><p>仅记录通过本站发起的调用；更换密钥不会清除历史。实际余额与账单以 OpenAI 为准。</p></div><a className="button secondary small-button" href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer">OpenAI 用量<Icon name="arrow" size={14} /></a></div>{error ? <ErrorBox error={error} onRetry={() => void loadUsage()} /> : loading ? <Loading /> : usage ? <><UsageTable usage={usage.usage} /><Pagination total={usage.total} offset={offset} limit={PAGE_SIZE} onChange={setOffset} /></> : null}</section>
    <div className="account-bottom"><section className="card profile-card"><div className="card-heading"><div><h2>账户资料</h2><p>你的工作空间身份。</p></div></div><div className="profile-summary"><div className="profile-avatar">{(user.displayName || user.username).slice(0, 1).toUpperCase()}</div><div><strong>{user.displayName || user.username}</strong><span>@{user.username}</span></div><span className={`role-badge ${user.role === 'admin' ? 'role-admin' : ''}`}>{user.role === 'admin' ? '管理员' : '成员'}</span></div><dl className="profile-details"><div><dt>注册日期</dt><dd>{fullDate(user.createdAt)}</dd></div><div><dt>登录方式</dt><dd>账号与密码</dd></div><div><dt>模型费用</dt><dd>本人 OpenAI 账户</dd></div></dl></section><section className="card password-card"><div className="card-heading"><div><h2>更新密码</h2><p>使用至少 12 位字符，保持账户安全。</p></div><Icon name="lock" /></div><form onSubmit={changePassword} className="password-form">{passwordError && <ErrorBox error={passwordError} />}<label className="field"><span>当前密码</span><input type="password" name="currentPassword" autoComplete="current-password" required maxLength={128} /></label><div className="form-two-columns"><label className="field"><span>新密码</span><input type="password" name="newPassword" autoComplete="new-password" minLength={12} maxLength={128} required /></label><label className="field"><span>确认新密码</span><input type="password" name="confirmPassword" autoComplete="new-password" minLength={12} maxLength={128} required /></label></div><button className="button primary" disabled={passwordBusy}>{passwordBusy ? '正在更新…' : '更新密码'}</button></form></section></div>
  </main>;
}
