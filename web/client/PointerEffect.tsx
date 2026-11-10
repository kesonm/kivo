import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './pointer-effect.css';

const TARGETS = 'button,a[href],summary,input:not([type="hidden"]),textarea,select,[data-pointer-target]';
const IGNORED = '[data-pointer-ignore],[inert],[aria-hidden="true"],[role="separator"]';
const BACKDROPS = '.sidebar-backdrop,.modal-backdrop,.kibot-history-backdrop,.menu-dismiss,[data-pointer-backdrop]';
const SURFACES = '[aria-modal="true"],dialog[open],[role="menu"],[role="listbox"],.composer-popover,.dropdown-menu';
const REACH = 48;
const MAX_PARTICLES = 24;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/** Decorative only: native cursor, focus rings and pointer hit testing are unchanged. */
export function PointerEffect() {
  const layer = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const halo = useRef<HTMLDivElement>(null);
  const specks = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = layer.current, outline = frame.current, glow = halo.current, nearSpecks = specks.current;
    if (!root || !outline || !glow || !nearSpecks) return;
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const visualViewport = window.visualViewport;
    let permitted = finePointer.matches && !reducedMotion.matches;
    let present = false, disposed = false, frameId = 0, dirty = true;
    let x = 0, y = 0;
    let targets: HTMLElement[] = [];
    let observedTarget: HTMLElement | null = null;
    const particles: { node: HTMLSpanElement; timer: number }[] = [];

    const clearParticles = () => {
      for (const particle of particles.splice(0)) { window.clearTimeout(particle.timer); particle.node.remove(); }
    };
    const hide = () => {
      present = false;
      root.dataset.state = 'hidden';
      if (frameId) { window.cancelAnimationFrame(frameId); frameId = 0; }
      if (observedTarget) { sizeObserver.unobserve(observedTarget); observedTarget = null; }
      clearParticles();
    };
    const usable = (element: HTMLElement) => {
      if (!element.isConnected || element.matches(BACKDROPS) || element.closest(IGNORED)
        || element.matches(':disabled,[aria-disabled="true"]') || element.closest('[aria-disabled="true"]')) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility === 'visible' && style.pointerEvents !== 'none'
        && Number(style.opacity) !== 0 && element.getClientRects().length > 0;
    };
    const setObservedTarget = (element: HTMLElement | null) => {
      if (element === observedTarget) return;
      if (observedTarget) sizeObserver.unobserve(observedTarget);
      observedTarget = element;
      if (element) sizeObserver.observe(element);
    };
    const geometry = (element: HTMLElement, bounds: DOMRect, near: boolean) => {
      const style = window.getComputedStyle(element);
      outline.style.transform = `translate3d(${bounds.left}px,${bounds.top}px,0)`;
      outline.style.width = `${bounds.width}px`; outline.style.height = `${bounds.height}px`;
      outline.style.borderTopLeftRadius = style.borderTopLeftRadius;
      outline.style.borderTopRightRadius = style.borderTopRightRadius;
      outline.style.borderBottomRightRadius = style.borderBottomRightRadius;
      outline.style.borderBottomLeftRadius = style.borderBottomLeftRadius;
      outline.style.setProperty('--pointer-local-x', `${x - bounds.left}px`);
      outline.style.setProperty('--pointer-local-y', `${y - bounds.top}px`);
      if (near) {
        // A small patch of light can touch the closest edge; it is never a box outline.
        const edgeX = clamp(x - bounds.left, 0, bounds.width);
        const edgeY = clamp(y - bounds.top, 0, bounds.height);
        const radius = Math.min(22, Math.max(1, Math.min(bounds.width, bounds.height) * .34));
        outline.style.setProperty('--pointer-edge-x', `${edgeX}px`);
        outline.style.setProperty('--pointer-edge-y', `${edgeY}px`);
        outline.style.setProperty('--pointer-edge-radius', `${radius}px`);
        nearSpecks.style.transform = `translate3d(${x}px,${y}px,0)`;
      }
      setObservedTarget(element);
    };
    const update = () => {
      frameId = 0;
      if (disposed || !permitted || !present || document.visibilityState !== 'visible') return;
      glow.style.transform = `translate3d(${x}px,${y}px,0)`;
      const hit = document.elementFromPoint(x, y);
      if (!hit) { hide(); return; }
      // closest() chooses the innermost genuine control; proximity never grants hover.
      const direct = hit.closest<HTMLElement>(TARGETS);
      if (direct && usable(direct)) {
        const bounds = direct.getBoundingClientRect();
        if (bounds.width > 0 && bounds.height > 0) {
          geometry(direct, bounds, false); root.dataset.state = 'hover'; return;
        }
      }
      if (hit.matches(BACKDROPS) || hit.closest(IGNORED) || direct && !usable(direct)) {
        root.dataset.state = 'free'; setObservedTarget(null); return;
      }
      if (dirty) { targets = Array.from(document.querySelectorAll<HTMLElement>(TARGETS)); dirty = false; }
      const surface = hit.closest(SURFACES);
      let nearest: { element: HTMLElement; bounds: DOMRect } | null = null;
      let best = REACH;
      for (const candidate of targets) {
        if (surface && !surface.contains(candidate)) continue;
        const bounds = candidate.getBoundingClientRect();
        if (bounds.width < 1 || bounds.height < 1 || bounds.right < 0 || bounds.bottom < 0
          || bounds.left > window.innerWidth || bounds.top > window.innerHeight) continue;
        const dx = Math.max(bounds.left - x, 0, x - bounds.right);
        const dy = Math.max(bounds.top - y, 0, y - bounds.bottom);
        const distance = Math.hypot(dx, dy);
        // An overlapped control underneath the pointer is not a nearby control.
        if (distance <= 0 || distance >= best || !usable(candidate)) continue;
        const insetX = Math.min(6, bounds.width / 2), insetY = Math.min(6, bounds.height / 2);
        const probeX = clamp(x, bounds.left + insetX, bounds.right - insetX);
        const probeY = clamp(y, bounds.top + insetY, bounds.bottom - insetY);
        const exposed = document.elementFromPoint(probeX, probeY);
        if (!exposed || !candidate.contains(exposed)) continue;
        const innermost = exposed.closest<HTMLElement>(TARGETS);
        if (innermost !== candidate && innermost && usable(innermost)) continue;
        nearest = { element: candidate, bounds }; best = distance;
      }
      if (nearest) {
        geometry(nearest.element, nearest.bounds, true);
        root.dataset.state = 'near';
      } else { root.dataset.state = 'free'; setObservedTarget(null); }
    };
    const schedule = () => {
      if (!frameId && !disposed && permitted && present && document.visibilityState === 'visible') frameId = window.requestAnimationFrame(update);
    };
    const sizeObserver = new ResizeObserver(schedule);
    const mutations = new MutationObserver(records => {
      if (records.every(record => root.contains(record.target))) return;
      dirty = true; schedule();
    });
    mutations.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-disabled', 'aria-hidden', 'inert', 'open'] });
    const move = (event: PointerEvent) => {
      permitted = finePointer.matches && !reducedMotion.matches;
      if (event.pointerType !== 'mouse' || event.buttons !== 0 || !permitted) { hide(); return; }
      present = true; x = event.clientX; y = event.clientY; schedule();
    };
    const leave = (event: PointerEvent) => { if (!event.relatedTarget) hide(); };
    const changePreference = () => {
      permitted = finePointer.matches && !reducedMotion.matches;
      if (!permitted) hide();
      dirty = true;
    };
    const viewportChanged = () => { dirty = true; schedule(); };
    const visibility = () => { if (document.visibilityState !== 'visible') hide(); };
    const keyboard = () => hide();
    const burst = (event: PointerEvent) => {
      permitted = finePointer.matches && !reducedMotion.matches;
      if (!permitted || event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const target = hit?.closest<HTMLElement>(TARGETS);
      if (!target || !usable(target)) return;
      present = true; x = event.clientX; y = event.clientY; schedule();
      // A bounded DOM pool with explicit expiry also works if animationend never fires.
      while (particles.length > MAX_PARTICLES - 6) {
        const oldest = particles.shift()!; window.clearTimeout(oldest.timer); oldest.node.remove();
      }
      for (let index = 0; index < 6; index++) {
        const node = document.createElement('span'); node.className = 'pointer-effect-particle';
        const angle = index * Math.PI / 3 + .25, distance = 15 + index % 3 * 7;
        node.style.left = `${x}px`; node.style.top = `${y}px`;
        node.style.setProperty('--particle-x', `${Math.cos(angle) * distance}px`);
        node.style.setProperty('--particle-y', `${Math.sin(angle) * distance}px`);
        node.style.setProperty('--particle-size', `${index % 2 ? 2 : 3}px`);
        root.appendChild(node);
        const particle = { node, timer: 0 };
        particle.timer = window.setTimeout(() => { node.remove(); const at = particles.indexOf(particle); if (at >= 0) particles.splice(at, 1); }, 620);
        particles.push(particle);
      }
    };
    finePointer.addEventListener('change', changePreference);
    reducedMotion.addEventListener('change', changePreference);
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerout', leave, { passive: true });
    document.addEventListener('pointerdown', burst, { passive: true, capture: true });
    document.addEventListener('keydown', keyboard, { passive: true });
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('scroll', viewportChanged, { passive: true, capture: true });
    window.addEventListener('resize', viewportChanged, { passive: true });
    visualViewport?.addEventListener('resize', viewportChanged, { passive: true });
    visualViewport?.addEventListener('scroll', viewportChanged, { passive: true });
    window.addEventListener('blur', hide);
    return () => {
      disposed = true; hide(); mutations.disconnect(); sizeObserver.disconnect();
      finePointer.removeEventListener('change', changePreference);
      reducedMotion.removeEventListener('change', changePreference);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerout', leave);
      document.removeEventListener('pointerdown', burst, true);
      document.removeEventListener('keydown', keyboard);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('scroll', viewportChanged, true);
      window.removeEventListener('resize', viewportChanged);
      visualViewport?.removeEventListener('resize', viewportChanged);
      visualViewport?.removeEventListener('scroll', viewportChanged);
      window.removeEventListener('blur', hide);
    };
  }, []);

  return createPortal(<div ref={layer} className="pointer-effect-layer" data-state="hidden" aria-hidden="true">
    <div ref={halo} className="pointer-effect-halo" />
    <div ref={frame} className="pointer-effect-frame"><div className="pointer-effect-inner" /><div className="pointer-effect-local-edge" /></div>
    <div ref={specks} className="pointer-effect-near-specks"><i /><i /><i /></div>
  </div>, document.body);
}
