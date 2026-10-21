// Region scaling: drag the inner edge of an editor's sidebar (or other side region) to resize it;
// dragging it nearly closed hides the region. Sizes are kept per area (saved with the layout) and
// applied with a generated style sheet, so the editors need no code of their own for it.
import { app, type AreaLike } from '../app/app';

/** A resizable side region, found by its class inside an area. */
export interface SideRegion {
  /** CSS selector of the region element */
  sel: string;
  /** which side of the area the region is docked to */
  side: 'left' | 'right';
  /** default width in pixels */
  width: number;
  min?: number;
  max?: number;
  /** extra CSS for a width (e.g. overlays that sit next to the region) */
  css?: (scope: string, w: number) => string;
  /** hide the region (dragged nearly closed) */
  hide?: (area: AreaLike) => void;
}

const hideUi = (area: AreaLike) => app.run('wm.context_toggle', { data_path: 'space_data.show_region_ui' }, { area });

/** Known side regions (modules may add theirs). */
export const sideRegions: SideRegion[] = [
  { sel: '.v3d-sidebar', side: 'right', width: 270, css: (s, w) => `${s} .v3d-sidebar ~ .nav-gizmo-wrap{right:${w + 8}px}`, hide: hideUi },
  { sel: '.anim-sb', side: 'right', width: 270, hide: hideUi },
  { sel: '.nd-sidebar', side: 'right', width: 270, hide: hideUi },
  { sel: '.te-sidebar', side: 'right', width: 250, hide: (area) => app.run('text.toggle_sidebar', {}, { area }) },
  { sel: '.clip-sidebar', side: 'right', width: 270, hide: hideUi },
  { sel: '.fb-side', side: 'left', width: 150, min: 100, hide: (area) => app.run('file.sidebar_toggle', {}, { area }) },
];

/** Width below which a dragged region closes. */
const CLOSE_PX = 60;
/** Distance from the inner edge that grabs it. */
const GRAB_PX = 5;

/** Saved sizes: area id → selector → width. */
const sizes = new Map<string, Record<string, number>>();

let styleEl: HTMLStyleElement | null = null;
function applyStyles() {
  if (typeof document === 'undefined') return;
  styleEl ??= document.head.appendChild(document.createElement('style'));
  const rules: string[] = [];
  for (const [id, m] of sizes)
    for (const [sel, w] of Object.entries(m)) {
      const reg = sideRegions.find((r) => r.sel === sel);
      const scope = `.area[data-area="${CSS.escape(id)}"]`;
      rules.push(`${scope} ${sel}{width:${w}px !important;flex-basis:${w}px !important}`);
      if (reg?.css) rules.push(reg.css(scope, w));
    }
  styleEl.textContent = rules.join('\n');
}

/** Region sizes of an area (for saving with the layout). */
export function regionSizes(areaId: string): Record<string, number> | undefined {
  const m = sizes.get(areaId);
  return m && Object.keys(m).length ? { ...m } : undefined;
}

/** Restore saved region sizes of an area. */
export function setRegionSizes(areaId: string, m: Record<string, number> | undefined) {
  if (m && Object.keys(m).length) sizes.set(areaId, { ...m });
  else sizes.delete(areaId);
  applyStyles();
}

/** Set one region's width in an area (clamped). */
export function setRegionWidth(areaId: string, sel: string, w: number) {
  const reg = sideRegions.find((r) => r.sel === sel);
  const v = Math.round(Math.max(reg?.min ?? 140, Math.min(reg?.max ?? 800, w)));
  const m = sizes.get(areaId) ?? {};
  m[sel] = v;
  sizes.set(areaId, m);
  applyStyles();
  return v;
}

/** The side region whose inner edge is under a client point, with its element and area. */
export function regionEdgeAt(x: number, y: number): { reg: SideRegion; el: HTMLElement; areaEl: HTMLElement } | null {
  if (typeof document === 'undefined') return null;
  const hit = document.elementFromPoint(x, y) as HTMLElement | null;
  const areaEl = hit?.closest<HTMLElement>('.area');
  if (!areaEl) return null;
  for (const reg of sideRegions) {
    for (const el of areaEl.querySelectorAll<HTMLElement>(reg.sel)) {
      if (el.closest('.area') !== areaEl || !el.offsetWidth) continue;
      const r = el.getBoundingClientRect();
      if (y < r.top || y > r.bottom) continue;
      const edge = reg.side === 'right' ? r.left : r.right;
      if (Math.abs(x - edge) <= GRAB_PX) return { reg, el, areaEl };
    }
  }
  return null;
}

/** Interactive resize of a side region from a pointer position. Returns false when none is there. */
export function startRegionScale(x: number, y: number, areaOf: (el: HTMLElement) => AreaLike | null): boolean {
  const hit = regionEdgeAt(x, y);
  if (!hit) return false;
  const area = areaOf(hit.areaEl);
  if (!area) return false;
  const { reg, el } = hit;
  const w0 = el.getBoundingClientRect().width;
  const x0 = x;
  const id = area.id;
  const before = sizes.get(id)?.[reg.sel];
  let closing = false;
  document.body.classList.add('region-scaling');
  const move = (e: PointerEvent) => {
    const d = reg.side === 'right' ? x0 - e.clientX : e.clientX - x0;
    const w = w0 + d;
    closing = w < CLOSE_PX && !!reg.hide;
    el.style.opacity = closing ? '0.4' : '';
    if (!closing) setRegionWidth(id, reg.sel, w);
    (area.editor as { resize?(): void }).resize?.();
  };
  const end = (ok: boolean) => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('keydown', key, true);
    document.body.classList.remove('region-scaling');
    el.style.opacity = '';
    if (!ok) {
      const m = sizes.get(id) ?? {};
      if (before === undefined) delete m[reg.sel];
      else m[reg.sel] = before;
      sizes.set(id, m);
      applyStyles();
    } else if (closing) {
      // reopening gives the width the region had before the drag
      const m = sizes.get(id) ?? {};
      if (before === undefined) delete m[reg.sel];
      else m[reg.sel] = before;
      applyStyles();
      reg.hide!(area);
    }
    (area.editor as { resize?(): void }).resize?.();
    app.changed('ui', 'view');
  };
  const up = () => end(true);
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    end(false);
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  addEventListener('keydown', key, true);
  return true;
}

/** Hover feedback: a resize cursor over region edges. */
export function installRegionScale(areaOf: (el: HTMLElement) => AreaLike | null) {
  if (typeof document === 'undefined') return;
  let on = false;
  addEventListener(
    'pointermove',
    (e) => {
      if (e.buttons) return;
      const near = !!regionEdgeAt(e.clientX, e.clientY);
      if (near !== on) document.body.classList.toggle('region-edge-hover', (on = near));
    },
    { passive: true, capture: true },
  );
  addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || app.modal) return;
      if (!regionEdgeAt(e.clientX, e.clientY)) return;
      e.preventDefault();
      e.stopPropagation();
      startRegionScale(e.clientX, e.clientY, areaOf);
    },
    true,
  );
}
