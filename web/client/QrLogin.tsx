import { useEffect, useRef, useState } from 'react';
import { api, messageOf } from './api';
import { ErrorBox } from './ui';
import type { User } from './types';

type Challenge = { id: string; status: string; qrImage?: string; verificationCode: string; expiresAt: number };

export function QrLogin({ onLogin }: { onLogin: (user: User) => void }) {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [now, setNow] = useState(Date.now());
  const login = useRef(onLogin); login.current = onLogin;
  useEffect(() => {
    const controller = new AbortController();
    let id = '', finished = false, timer: ReturnType<typeof setTimeout>;
    setChallenge(null); setError('');
    async function poll() {
      try {
        const result = await api<Challenge>(`/api/auth/qr/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setChallenge(old => old ? { ...old, ...result } : result);
        if (result.status === 'approved') {
          const auth = await api<{ user: User }>(`/api/auth/qr/${id}/redeem`, { method: 'POST', signal: controller.signal });
          finished = true; login.current(auth.user); return;
        }
        if (['expired', 'denied'].includes(result.status)) return;
        timer = setTimeout(() => void poll(), 2000);
      } catch (e) { if (!controller.signal.aborted) setError(messageOf(e)); }
    }
    // Deferring also prevents React StrictMode's probe from creating two codes.
    timer = setTimeout(() => void (async () => {
      try {
        const result = await api<Challenge>('/api/auth/qr', { method: 'POST', signal: controller.signal });
        id = result.id;
        if (controller.signal.aborted) return;
        setChallenge(result); timer = setTimeout(() => void poll(), 2000);
      } catch (e) { if (!controller.signal.aborted) setError(messageOf(e)); }
    })(), 0);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      controller.abort(); clearTimeout(timer); clearInterval(clock);
      if (id && !finished) void api(`/api/auth/qr/${id}`, { method: 'DELETE' }).catch(() => undefined);
    };
  }, [version]);
  const expired = !!challenge && now >= challenge.expiresAt;
  const terminal = expired || challenge?.status === 'denied';
  const status = expired ? '二维码已过期' : challenge?.status === 'denied' ? '已取消授权' : challenge?.status === 'scanned' ? '已扫码，请在手机上确认' : challenge?.status === 'approved' ? '授权成功，正在登录…' : '使用 kivo iOS App 扫码';
  return <div className="qr-login">
    {error && <ErrorBox error={error} />}
    <div className="qr-login-code" aria-busy={!challenge && !error}>
      {challenge?.qrImage && !terminal && !error ? <img src={challenge.qrImage} width="240" height="240" alt="使用 kivo App 扫描的网页登录二维码" /> : !challenge && !error ? <span className="spinner" /> : <span>{terminal ? status : '暂时无法显示二维码'}</span>}
    </div>
    <strong aria-live="polite">{status}</strong>
    {challenge && !terminal && !error && <>
      <p className="muted">核对手机上的确认码 <b className="qr-verification">{challenge.verificationCode}</b></p>
      <small className="muted">{Math.max(0, Math.ceil((challenge.expiresAt - now) / 1000))} 秒内有效 · 扫码后需要手动确认</small>
    </>}
    <button type="button" className="button" onClick={() => setVersion(value => value + 1)}>刷新二维码</button>
    <p className="qr-instructions">先在 iPhone 的 kivo App 登录，再点击顶部“扫码登录”。请只扫描你自己打开的网页。</p>
  </div>;
}
