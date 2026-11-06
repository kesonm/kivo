import { useState, type FormEvent } from 'react';
import { api, messageOf } from './api';
import { Brand, Icon } from './icons';
import { ErrorBox } from './ui';
import type { Session, User } from './types';

export function Auth({ onLogin }: { onLogin: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') || '');
    if (mode === 'register' && password !== form.get('confirmPassword')) { setError('两次输入的密码不一致。'); return; }
    setBusy(true); setError('');
    try {
      await api<Session>('/api/session');
      const result = await api<{ user: User }>(`/api/auth/${mode}`, { method: 'POST', body: { username: String(form.get('username') || '').trim(), password, ...(mode === 'register' ? { displayName: String(form.get('displayName') || '').trim() } : {}) } });
      onLogin(result.user);
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  }
  function switchMode(next: 'login' | 'register') { setMode(next); setError(''); setShowPassword(false); }
  return <div className="auth-page">
    <header className="auth-brand"><Brand small /></header>
    <main className="auth-form-side">
      <div className="auth-form-wrap">
        <h1>{mode === 'login' ? '欢迎回来' : '创建你的账户'}</h1>
        <p className="muted">{mode === 'login' ? '登录 kivo，让想法继续。' : '从一次对话，开始你的下一个项目。'}</p>
        <div className="segmented auth-tabs" aria-label="账户入口">
          <button type="button" className={mode === 'login' ? 'selected' : ''} aria-pressed={mode === 'login'} onClick={() => switchMode('login')}>登录</button>
          <button type="button" className={mode === 'register' ? 'selected' : ''} aria-pressed={mode === 'register'} onClick={() => switchMode('register')}>注册</button>
        </div>
        <form key={mode} onSubmit={submit} className="auth-form">
          {error && <ErrorBox error={error} />}
          {mode === 'register' && <label className="field"><span>显示名称</span><input name="displayName" placeholder="如何称呼你" autoComplete="nickname" maxLength={60} required /></label>}
          <label className="field"><span>用户名</span><input name="username" placeholder="输入用户名" autoComplete="username" minLength={3} maxLength={32} pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}" title="使用 3–32 位字母、数字、下划线、点或短横线" required autoFocus />{mode === 'register' && <small>3–32 位字母、数字、下划线、点或短横线。</small>}</label>
          <label className="field"><span>密码</span><div className="password-input"><input name="password" type={showPassword ? 'text' : 'password'} placeholder={mode === 'login' ? '输入密码' : '至少 12 位字符'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 12 : undefined} maxLength={128} required /><button type="button" className="icon-button" aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(!showPassword)}><Icon name="eye" size={17} /></button></div></label>
          {mode === 'register' && <label className="field"><span>确认密码</span><input name="confirmPassword" type="password" placeholder="再次输入密码" autoComplete="new-password" minLength={12} maxLength={128} required /></label>}
          {mode === 'register' && <div className="registration-privacy"><Icon name="eye" size={16} /><span>工作空间管理员可以查看你的会话、执行记录与模型用量；后台不显示 API Key 明文。</span></div>}
          <button className="button primary auth-submit" disabled={busy} type="submit">{busy ? <><span className="spinner" />正在处理…</> : mode === 'login' ? '继续' : '创建账户'}</button>
        </form>
        <p className="auth-hint"><Icon name="lock" size={15} />{mode === 'register' ? '注册后，在账户设置填写你自己的 OpenAI API Key。' : '使用账号密码登录，个人 API Key 在账户设置中配置。'}</p>
      </div>
      <footer className="auth-form-footer">使用本人 OpenAI API Key · 费用计入本人 OpenAI 账户</footer>
    </main>
  </div>;
}
