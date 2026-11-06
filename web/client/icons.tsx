import type { CSSProperties } from 'react';

const paths: Record<string, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  down: <path d="m5 9 7 7 7-7" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  chat: <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8Z" />,
  code: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" /></>,
  terminal: <><path d="m4 6 5 6-5 6m9 0h7" /></>,
  send: <><path d="M12 19V5m-6 6 6-6 6 6" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 3a4 4 0 0 1 0 7.8" /><circle cx="9" cy="7" r="4" /></>,
  shield: <><path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7Z" /><path d="m8 12 3 3 5-5" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9" /></>,
  settings: <><path d="m9 3-1 3-3 1v4l-2 1 2 1v4l3 1 1 3h6l1-3 3-1v-4l2-1-2-1V7l-3-1-1-3Z" /><circle cx="12" cy="12" r="3" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8m-8 4h5" /></>,
  diff: <><path d="M8 3v12a4 4 0 0 0 4 4h4M16 3v4a4 4 0 0 1-4 4H8" /><circle cx="8" cy="3" r="2" /><circle cx="16" cy="3" r="2" /><circle cx="16" cy="19" r="2" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 6a8 8 0 0 1 13 2l1 4M4 12l1 4a8 8 0 0 0 13 2" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  edit: <><path d="m15 5 4 4M4 20l4-1L20 7a3 3 0 0 0-4-4L4 15Z" /></>,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
  download: <><path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.01" /></>,
  alert: <><path d="m12 3 10 18H2Z" /><path d="M12 9v5m0 3v.01" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2" /></>,
  key: <><circle cx="8" cy="9" r="5" /><path d="m12 13 8 8m-3-3 3-3m-6 0 3-3" /></>,
  activity: <path d="M2 12h4l3-8 6 16 3-8h4" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  wallet: <><path d="M20 8V5H5a2 2 0 0 0 0 4h16v12H5a2 2 0 0 1-2-2V7" /><path d="M21 12h-6v5h6m-3-2.5h.01" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  panel: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></>,
  sidebar: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /></>,
  save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z" /><path d="M7 3v6h10V3M7 21v-8h10v8" /></>,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12" /><circle cx="12" cy="12" r="3" /></>,
};
export function Icon({ name, size = 18, className = '', style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  return <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name] || paths.code}</svg>;
}
export function Logo() {
  return <img className="brand-logo" src="/logo.png" alt="" aria-hidden="true" draggable={false} />;
}
export function Brand({ small = false }: { small?: boolean }) {
  return <div className={`brand ${small ? 'brand-small' : ''}`}><span className="brand-mark logo-container"><Logo /></span><span>kivo</span></div>;
}
