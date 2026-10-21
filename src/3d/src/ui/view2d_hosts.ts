// View2D hosts for the existing 2D editors, recognised by shape so the editors need no changes:
// time/value views (Dope Sheet, Timeline, Graph, Drivers, NLA), the Sequencer timeline and the
// scrolling button/row regions (Properties, Preferences, Outliner, Info, File Browser, Spreadsheet).
import { app, type AreaLike } from '../app/app';
import { view2dAdapters, type View2DHost, type ViewRect } from './view2d';

interface TimeView {
  x0: number;
  ppf: number;
  y0: number;
  ppv: number;
  width: number;
  height: number;
  xf(x: number): number;
  yv(y: number): number;
  zoomX(f: number, x: number): void;
  zoomY(f: number, y: number): void;
  panPx(dx: number, dy: number): void;
}

interface AnimLike {
  view: TimeView;
  canvas: HTMLCanvasElement;
  rowScroll?: boolean;
  hover?: string;
  draw(): void;
  scrollBy?(dy: number): void;
  contentBottom?(): number;
  afterViewChange?(): void;
  list?: { rows: unknown[] };
  rowH?: number;
  scrollY?: number;
}

const isFn = (o: unknown, k: string) => !!o && typeof (o as Record<string, unknown>)[k] === 'function';

function isTimeView(v: unknown): v is TimeView {
  return isFn(v, 'zoomX') && isFn(v, 'panPx') && isFn(v, 'xf') && typeof (v as TimeView).ppf === 'number';
}

const cache = new WeakMap<object, View2DHost>();
function cached(ed: object, make: () => View2DHost): View2DHost {
  let h = cache.get(ed);
  if (!h) cache.set(ed, (h = make()));
  return h;
}

/** Dope Sheet, Timeline, Graph, Drivers and NLA editors: frames along x, values or rows along y. */
function animHost(ed: AnimLike): View2DHost {
  // the time ruler sits above the view's value area
  const top = () => (ed.contentBottom ? ed.contentBottom() - ed.view.height : 0);
  const rows = () => ed.rowScroll !== false && !!ed.scrollBy;
  const after = () => {
    ed.draw();
    ed.afterViewChange?.();
  };
  return {
    kind: 'canvas',
    el: ed.canvas,
    get lockY() {
      return rows();
    },
    pan(dx, dy) {
      ed.view.panPx(dx, rows() ? 0 : dy);
      if (rows() && dy) ed.scrollBy!(-dy);
    },
    zoom(fx, fy, x, y) {
      if (fx !== 1) ed.view.zoomX(fx, x);
      if (fy !== 1 && !rows()) ed.view.zoomY(fy, y - top());
    },
    toView: (x, y) => [ed.view.xf(x), ed.view.yv(y - top())],
    getRect: () => ({ xmin: ed.view.x0, xmax: ed.view.xf(ed.view.width), ymin: ed.view.y0, ymax: ed.view.yv(0) }),
    setRect(r: ViewRect) {
      const v = ed.view;
      if (r.xmax > r.xmin) {
        v.ppf = Math.max(0.02, Math.min(400, v.width / (r.xmax - r.xmin)));
        v.x0 = r.xmin;
      }
      if (!rows() && r.ymax > r.ymin) {
        v.ppv = Math.max(1e-6, Math.min(1e7, v.height / (r.ymax - r.ymin)));
        v.y0 = r.ymin;
      }
    },
    extent() {
      const v = ed.view;
      const x0 = v.x0,
        x1 = v.xf(v.width);
      // the content along time: the scene's frame range
      const sc = app?.doc?.scene;
      const out: ReturnType<NonNullable<View2DHost['extent']>> = { x: [x0, x1, sc?.frame_start ?? 1, sc?.frame_end ?? 250] };
      if (rows() && ed.list && ed.rowH) {
        const total = ed.list.rows.length * ed.rowH;
        const s = ed.scrollY ?? 0;
        out.y = [s, s + v.height, 0, Math.max(total, s + v.height)];
      }
      return out;
    },
    redraw: after,
  };
}

interface SeqLike {
  x0: number;
  ppf: number;
  cy0: number;
  chH: number;
  canvas: HTMLCanvasElement;
  mainEl: HTMLElement;
  hover?: string;
  redraw(): void;
  xf(x: number): number;
  contentBottom(): number;
}

/** Sequencer timeline: frames along x, channels (bottom up) along y. */
function seqHost(ed: SeqLike): View2DHost {
  const H = () => ed.contentBottom();
  const W = () => ed.mainEl.clientWidth || ed.canvas.clientWidth;
  return {
    kind: 'canvas',
    el: ed.canvas,
    pan(dx, dy) {
      ed.x0 -= dx / ed.ppf;
      ed.cy0 = Math.max(-1, ed.cy0 + dy / ed.chH);
    },
    zoom(fx, fy, x, y) {
      const f = ed.xf(x);
      ed.ppf = Math.max(0.01, Math.min(400, ed.ppf * fx));
      ed.x0 = f - x / ed.ppf;
      if (fy !== 1) {
        const ch = ed.cy0 + (H() - y) / ed.chH;
        ed.chH = Math.max(18, Math.min(56, ed.chH * fy));
        ed.cy0 = ch - (H() - y) / ed.chH;
      }
    },
    toView: (x, y) => [ed.xf(x), ed.cy0 + (H() - y) / ed.chH],
    getRect: () => ({ xmin: ed.x0, xmax: ed.xf(W()), ymin: ed.cy0, ymax: ed.cy0 + H() / ed.chH }),
    setRect(r) {
      if (r.xmax > r.xmin) {
        ed.ppf = Math.max(0.01, Math.min(400, W() / (r.xmax - r.xmin)));
        ed.x0 = r.xmin;
      }
      if (r.ymax > r.ymin) {
        ed.chH = Math.max(18, Math.min(56, H() / (r.ymax - r.ymin)));
        ed.cy0 = r.ymin;
      }
    },
    extent: () => {
      const sc = app?.doc?.scene;
      return { x: [ed.x0, ed.xf(W()), sc?.frame_start ?? 1, sc?.frame_end ?? 250] };
    },
    redraw: () => ed.redraw(),
  };
}

/** Editors whose main region is a scrolling list of buttons or rows. */
const LIST_EDITORS = new Set(['PROPERTIES', 'PREFERENCES', 'OUTLINER', 'INFO', 'FILE_BROWSER', 'SPREADSHEET', 'ASSETS']);

function scrollable(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const st = getComputedStyle(el);
  return /(auto|scroll)/.test(st.overflowY + st.overflowX) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
}

/** The scrolling element of a list region: the one under the pointer, else the largest one. */
function listElement(root: HTMLElement, at?: { x: number; y: number }): HTMLElement | null {
  if (at) {
    let e = document.elementFromPoint(at.x, at.y);
    while (e && root.contains(e)) {
      if (scrollable(e)) return e;
      e = e.parentElement;
    }
  }
  let best: HTMLElement | null = null;
  let area = 0;
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (el.clientHeight < 40 || !scrollable(el)) continue;
    const a = el.clientWidth * el.clientHeight;
    if (a > area) ((area = a), (best = el));
  }
  return best ?? (scrollable(root) ? root : null);
}

interface ZoomableList {
  zoomBy?(f: number): void;
  resetView?(): void;
  body?: HTMLElement;
}

function listHost(area: AreaLike, ed: ZoomableList & { el: HTMLElement }): View2DHost {
  const p = (globalThis as { app?: { pointer: { x: number; y: number } } }).app?.pointer;
  const el = (ed.body && scrollable(ed.body) ? ed.body : listElement(ed.el, p)) ?? ed.body ?? ed.el;
  const host: View2DHost = {
    kind: 'list',
    el,
    pan(dx, dy) {
      el.scrollLeft -= dx;
      el.scrollTop -= dy;
    },
    reset() {
      if (ed.resetView) return ed.resetView();
      el.scrollTop = 0;
      el.scrollLeft = 0;
    },
    extent: () => ({ y: [el.scrollTop, el.scrollTop + el.clientHeight, 0, el.scrollHeight] }),
  };
  // regions that scale their panels (Properties) also zoom
  if (typeof ed.zoomBy === 'function') host.zoom = (fx, fy) => ed.zoomBy!(Math.sqrt(fx * fy));
  void area;
  return host;
}

view2dAdapters.push((editor, area) => {
  const ed = editor as Record<string, unknown> | null;
  if (!ed || typeof ed !== 'object') return null;
  if (isTimeView(ed.view) && ed.canvas instanceof HTMLCanvasElement && isFn(ed, 'draw')) return cached(ed, () => animHost(ed as unknown as AnimLike));
  if (typeof ed.x0 === 'number' && typeof ed.ppf === 'number' && typeof ed.cy0 === 'number' && typeof ed.chH === 'number' && ed.canvas instanceof HTMLCanvasElement && isFn(ed, 'redraw')) {
    // only the timeline part of the sequencer (the preview has its own view keys)
    if (ed.hover === 'preview' || ed.view === 'PREVIEW') return null;
    return cached(ed, () => seqHost(ed as unknown as SeqLike));
  }
  if (LIST_EDITORS.has(area.type) && ed.el instanceof HTMLElement) return listHost(area, ed as unknown as ZoomableList & { el: HTMLElement });
  return null;
});

// Middle-drag in list regions scrolls them (Ctrl: zooms regions that scale, e.g. the Properties).
if (typeof window !== 'undefined')
  addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 1 || app?.modal) return;
      const t = e.target as HTMLElement | null;
      if (!t || t.closest('input, textarea, .popup-layer, canvas')) return;
      const areaEl = t.closest<HTMLElement>('.area');
      const area = (app?.hoverArea as (AreaLike & { el: HTMLElement }) | null) ?? null;
      if (!areaEl || !area || area.el !== areaEl || !t.closest('.area-main')) return;
      // resolve the host for the element under the pointer
      const host = (() => {
        for (const f of view2dAdapters) {
          const h = f(area.editor, area);
          if (h) return h;
        }
        return null;
      })();
      if (!host || host.kind !== 'list') return;
      e.preventDefault();
      e.stopPropagation();
      let lx = e.clientX,
        ly = e.clientY;
      const zoom = (e.ctrlKey || e.metaKey) && !!host.zoom;
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - lx,
          dy = ev.clientY - ly;
        lx = ev.clientX;
        ly = ev.clientY;
        if (zoom) host.zoom!(Math.exp(-dy * 0.01), Math.exp(-dy * 0.01), 0, 0);
        else host.pan(dx, dy);
      };
      const up = () => {
        removeEventListener('pointermove', move, true);
        removeEventListener('pointerup', up, true);
        document.body.classList.remove('v2d-panning');
      };
      document.body.classList.add('v2d-panning');
      addEventListener('pointermove', move, true);
      addEventListener('pointerup', up, true);
    },
    true,
  );
