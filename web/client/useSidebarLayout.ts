import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

const STORAGE_KEY = 'kivo.sidebar-layout.v1';
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 220;
const MAX_WIDTH = 400;
const COLLAPSE_WIDTH = 200;
const CHAT_MIN_WIDTH = 560;
type Preference = { width: number; collapsed: boolean };
type Drag = { pointerId: number; element: HTMLDivElement; origin: number; width: number; candidate: number };

function readPreference(): Preference {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved.width === 'number' && Number.isFinite(saved.width) && typeof saved.collapsed === 'boolean') {
      return { width: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(saved.width))), collapsed: saved.collapsed };
    }
  } catch { /* Layout preferences are optional, including in private browsing. */ }
  return { width: DEFAULT_WIDTH, collapsed: false };
}

export function useSidebarLayout(onManualCollapse: () => void) {
  const [preference, setPreference] = useState(readPreference);
  const preferenceRef = useRef(preference); preferenceRef.current = preference;
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const collapseCallback = useRef(onManualCollapse); collapseCallback.current = onManualCollapse;
  const mobile = viewport <= 800;
  const overlayMode = mobile || viewport < preference.width + CHAT_MIN_WIDTH;
  const docked = !overlayMode && !preference.collapsed;
  const drawerOpen = overlayMode && sidebarOpen;
  const visible = docked || drawerOpen;
  const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewport - CHAT_MIN_WIDTH));
  const clamp = (width: number) => Math.max(MIN_WIDTH, Math.min(maxWidth, Math.round(width)));
  const width = overlayMode ? mobile ? 274 : preference.width : preview === null ? preference.width : clamp(preview);

  const save = useCallback((next: Preference) => {
    preferenceRef.current = next; setPreference(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Keep the in-memory preference. */ }
  }, []);
  const clearDrag = useCallback(() => {
    const previous = drag.current; drag.current = null;
    if (frame.current !== null) { window.cancelAnimationFrame(frame.current); frame.current = null; }
    if (previous?.element.hasPointerCapture(previous.pointerId)) previous.element.releasePointerCapture(previous.pointerId);
    setPreview(null);
  }, []);
  const collapse = useCallback(() => {
    clearDrag(); save({ ...preferenceRef.current, collapsed: true });
    collapseCallback.current();
  }, [clearDrag, save]);
  const expand = useCallback(() => save({ ...preferenceRef.current, collapsed: false }), [save]);

  useEffect(() => {
    let resizeFrame: number | null = null;
    const resize = () => {
      // Resizing the window cancels a drag; viewport changes never persist a
      // collapsed preference or replace the last manually chosen width.
      if (drag.current) clearDrag();
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => { resizeFrame = null; setViewport(window.innerWidth); });
    };
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      const active = drag.current; drag.current = null;
      if (active?.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
    };
  }, [clearDrag]);
  useEffect(() => { setSidebarOpen(false); }, [overlayMode, mobile]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!docked || event.button !== 0 || drag.current) return;
    event.preventDefault(); event.currentTarget.focus();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, element, origin: event.clientX, width: preference.width, candidate: preference.width };
    setPreview(preference.width);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.candidate = active.width + event.clientX - active.origin;
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      if (drag.current) setPreview(drag.current.candidate);
    });
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const candidate = active.width + event.clientX - active.origin;
    if (candidate < COLLAPSE_WIDTH) collapse();
    else { clearDrag(); save({ width: clamp(candidate), collapsed: false }); }
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); clearDrag(); return; }
    if (drag.current || !docked) return;
    if (event.key === 'Enter') { event.preventDefault(); collapse(); return; }
    const step = event.shiftKey ? 40 : 10;
    const next = event.key === 'ArrowLeft' ? preference.width - step : event.key === 'ArrowRight' ? preference.width + step
      : event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maxWidth : null;
    if (next !== null) { event.preventDefault(); save({ width: clamp(next), collapsed: false }); }
  }

  return {
    mobile, overlayMode, docked, drawerOpen, visible, sidebarOpen, setSidebarOpen, collapse, expand,
    resizing: preview !== null, collapseReady: preview !== null && preview < COLLAPSE_WIDTH,
    style: { '--nav-width': `${width}px` } as CSSProperties,
    separatorProps: {
      role: 'separator' as const, tabIndex: 0, 'aria-label': '调整侧栏宽度', 'aria-orientation': 'vertical' as const,
      'aria-controls': 'primary-navigation', 'aria-valuemin': MIN_WIDTH, 'aria-valuemax': maxWidth,
      'aria-valuenow': Math.round(width), 'aria-valuetext': `${Math.round(width)} 像素，按 Enter 收起侧栏`,
      onPointerDown, onPointerMove, onPointerUp, onKeyDown,
      onPointerCancel: clearDrag,
      onLostPointerCapture: () => { if (drag.current) clearDrag(); },
    },
  };
}
