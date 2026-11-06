import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from './icons';

type Notice = { id: number; text: string; tone: 'success' | 'error' | 'info' };
const NoticeContext = createContext<(text: string, tone?: Notice['tone']) => void>(() => undefined);
export const useNotice = () => useContext(NoticeContext);
export function NoticeProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Notice[]>([]);
  const next = useRef(0);
  function notify(text: string, tone: Notice['tone'] = 'success') {
    const id = ++next.current;
    setItems(old => [...old.slice(-3), { id, text, tone }]);
    window.setTimeout(() => setItems(old => old.filter(item => item.id !== id)), tone === 'error' ? 8000 : 4500);
  }
  return <NoticeContext.Provider value={notify}>{children}<div className="toast-region" aria-live="polite">{items.map(item => <div key={item.id} className={`toast toast-${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'}><Icon name={item.tone === 'success' ? 'check' : item.tone === 'error' ? 'alert' : 'info'} /><span>{item.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setItems(old => old.filter(x => x.id !== item.id))}><Icon name="close" size={15} /></button></div>)}</div></NoticeContext.Provider>;
}

export function Modal({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => (panel.current?.querySelector('[autofocus], input, textarea, select, button') as HTMLElement | null)?.focus(), 0);
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key === 'Tab' && panel.current) {
        const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')).filter(item => item.getClientRects().length > 0);
        if (!focusable.length) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable[focusable.length - 1]?.focus(); }
        else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); focusable[0]?.focus(); }
      }
    }
    document.addEventListener('keydown', key);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', key); document.body.style.overflow = bodyOverflow; previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={panel} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-heading"><div><h2 id="modal-title">{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" aria-label="关闭对话框" onClick={onClose}><Icon name="close" /></button></div>{children}</div></div>;
}

export type FieldSpec = { name: string; label: string; value?: string; type?: string; placeholder?: string; hint?: string; min?: number; max?: number; minLength?: number; maxLength?: number; required?: boolean; multiline?: boolean };
type DialogSpec = { title: string; description?: string; fields?: FieldSpec[]; confirm?: string; danger?: boolean };
const DialogContext = createContext<(spec: DialogSpec) => Promise<Record<string, string> | null>>(async () => null);
export const useDialog = () => useContext(DialogContext);
export function DialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<{ spec: DialogSpec; resolve: (value: Record<string, string> | null) => void } | null>(null);
  function ask(spec: DialogSpec) { return new Promise<Record<string, string> | null>(resolve => setDialog({ spec, resolve })); }
  function finish(value: Record<string, string> | null) { dialog?.resolve(value); setDialog(null); }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    finish(Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>);
  }
  return <DialogContext.Provider value={ask}>{children}{dialog && <Modal title={dialog.spec.title} description={dialog.spec.description} onClose={() => finish(null)}><form onSubmit={submit}><div className="form-fields">{dialog.spec.fields?.map(field => <label className="field" key={field.name}><span>{field.label}</span>{field.multiline ? <textarea name={field.name} defaultValue={field.value} placeholder={field.placeholder} required={field.required !== false} maxLength={field.maxLength} rows={3} /> : <input name={field.name} type={field.type || 'text'} defaultValue={field.value} placeholder={field.placeholder} min={field.min} max={field.max} minLength={field.minLength} maxLength={field.maxLength} required={field.required !== false} autoComplete={field.type === 'password' ? 'new-password' : 'off'} />}{field.hint && <small>{field.hint}</small>}</label>)}</div><div className="modal-actions"><button type="button" className="button secondary" onClick={() => finish(null)}>取消</button><button type="submit" className={`button ${dialog.spec.danger ? 'danger' : 'primary'}`}>{dialog.spec.confirm || '确认'}</button></div></form></Modal>}</DialogContext.Provider>;
}

export function Empty({ icon = 'folder', title, description, action }: { icon?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={24} /></span><h3>{title}</h3>{description && <p>{description}</p>}{action}</div>;
}
export function Loading({ label = '正在加载…' }: { label?: string }) { return <div className="loading-state" role="status"><span className="spinner" /><span>{label}</span></div>; }
export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) { return <div className="error-box" role="alert"><Icon name="alert" /><span>{error}</span>{onRetry && <button className="text-button" onClick={onRetry}>重试</button>}</div>; }
export function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = { completed: '已完成', running: '运行中', failed: '调用失败', interrupted: '已停止', unknown: '用量未知', incomplete: '未完整返回', error: '调用失败', legacy: '历史记录', settled: '已记录', actual: '已记录', refunded: '无用量' };
  return <span className={`status-badge status-${status}`}>{status === 'running' && <span className="pulse-dot" />}{labels[status] || status}</span>;
}
