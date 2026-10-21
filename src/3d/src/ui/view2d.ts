// Shared 2D view navigation: the view2d.* operators and the "View2D" / "View2D Buttons List" keymaps.
//
// An editor takes part by exposing a host (`editor.view2dHost()`), or through an adapter registered
// in `view2dAdapters` (see view2d_hosts.ts, which recognises the existing 2D editors without
// touching them). Canvas hosts are time/value or image style views; list hosts are scrolling panel
// regions (Properties, Preferences, Outliner, Info, …). The keyboard dispatcher adds the matching
// keymap after the editor's own keymaps, so editor-specific bindings keep priority.
import { app, registerOperators, type AreaLike, type OpContext } from '../app/app';
import { addKeys, areaKeymapHooks } from '../app/keymap';
import './screen.css';
import { stepFactor, borderRect, lerpRect, edgePanSpeed, type ViewRect, type EdgePanOptions } from './view2d_math';

export { stepFactor, borderRect, lerpRect, edgePanSpeed, type ViewRect, type EdgePanOptions };

export interface View2DHost {
  /** canvas: a pannable/zoomable view; list: a scrolling region of buttons/rows */
  kind: 'canvas' | 'list';
  /** main region element (pointer positions are relative to it) */
  el: HTMLElement;
  /** Move the contents by a pixel delta (they follow the pointer: +x right, +y down). */
  pan(dx: number, dy: number): void;
  /** Zoom by factors (>1 zooms in) around a region-local point. */
  zoom?(fx: number, fy: number, x: number, y: number): void;
  /** visible area in view units (smooth view, zoom border) */
  getRect?(): ViewRect;
  setRect?(r: ViewRect): void;
  /** region pixel → view units */
  toView?(x: number, y: number): [number, number];
  /** only the horizontal axis zooms (time lines whose rows scroll instead) */
  lockY?: boolean;
  /** Home in list regions: back to the top at 100% zoom */
  reset?(): void;
  /** redraw after a change (hosts that redraw inside pan/zoom can omit it) */
  redraw?(): void;
  /** scrollbar data for the shared scrollers: [visible start, visible end, total start, total end] per axis */
  extent?(): { x?: [number, number, number, number]; y?: [number, number, number, number] };
}

type HostEditor = { view2dHost?: () => View2DHost | null };

/** Adapters that recognise editors which do not implement `view2dHost` themselves. */
export const view2dAdapters: ((editor: unknown, area: AreaLike) => View2DHost | null)[] = [];

/** The 2D view host of an area, if its editor has one. */
export function view2dHost(area: AreaLike | null | undefined): View2DHost | null {
  if (!area) return null;
  const ed = area.editor as HostEditor | undefined;
  if (!ed) return null;
  if (typeof ed.view2dHost === 'function') return ed.view2dHost();
  for (const f of view2dAdapters) {
    const h = f(ed, area);
    if (h) return h;
  }
  return null;
}

/** Keymap the dispatcher adds for an area: View2D for canvas views, View2D Buttons List for lists. */
export function view2dKeymap(area: AreaLike | null | undefined): string | null {
  const h = view2dHost(area);
  return h ? (h.kind === 'list' ? 'View2D Buttons List' : 'View2D') : null;
}

const hostOf = (ctx: OpContext) => view2dHost(ctx.area ?? app.hoverArea ?? app.activeArea);

/** Pointer position local to the host element (centre of the region without a pointer event). */
function localPoint(h: View2DHost, ctx?: OpContext): { x: number; y: number } {
  const r = h.el.getBoundingClientRect();
  const p = ctx?.event ?? app.pointer;
  if (p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) return { x: p.x - r.left, y: p.y - r.top };
  return { x: r.width / 2, y: r.height / 2 };
}

/** Default step of the zoom in/out operators (each edge moves 3.75% of the view size). */
export const ZOOM_STEP = 0.0375;

function applyZoom(h: View2DHost, fx: number, fy: number, x: number, y: number) {
  if (!h.zoom) return false;
  h.zoom(fx, h.lockY ? 1 : fy, x, y);
  h.redraw?.();
  return true;
}

/** Smooth view transition length (Preferences ▸ Navigation ▸ Smooth View sets it; 0 jumps). */
export const view2dSettings = { smoothMs: 200 };

const running = new WeakMap<View2DHost['el'], number>();

/** Move the view of `h` to `target`, animated over the smooth view time. */
export function smoothView(h: View2DHost, target: ViewRect, ms = view2dSettings.smoothMs) {
  if (!h.getRect || !h.setRect) return false;
  const from = h.getRect();
  if (h.lockY) ((target.ymin = from.ymin), (target.ymax = from.ymax));
  const prev = running.get(h.el);
  if (prev) cancelAnimationFrame(prev);
  if (ms <= 0 || typeof requestAnimationFrame !== 'function') {
    h.setRect(target);
    h.redraw?.();
    return true;
  }
  const t0 = performance.now();
  const step = () => {
    const t = (performance.now() - t0) / ms;
    h.setRect!(lerpRect(from, target, t));
    h.redraw?.();
    if (t < 1) running.set(h.el, requestAnimationFrame(step));
    else running.delete(h.el);
  };
  // the first frame lands right away so scripts see the change start
  step();
  return true;
}

/** Run a pointer drag over the window until release (Esc / right click cancel). */
function drag(opts: { move: (dx: number, dy: number, e: PointerEvent) => void; end?: (ok: boolean) => void; cursor?: string; button?: number }) {
  let last: { x: number; y: number } | null = null;
  const prevCursor = document.body.style.cursor;
  if (opts.cursor) document.body.style.cursor = opts.cursor;
  const stop = (ok: boolean) => {
    removeEventListener('pointermove', mv, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('pointerdown', dn, true);
    removeEventListener('keydown', key, true);
    document.body.style.cursor = prevCursor;
    opts.end?.(ok);
  };
  const mv = (e: PointerEvent) => {
    if (last) opts.move(e.clientX - last.x, e.clientY - last.y, e);
    last = { x: e.clientX, y: e.clientY };
  };
  const up = (e: PointerEvent) => {
    if (opts.button === undefined || e.button === opts.button) stop(true);
  };
  const dn = (e: PointerEvent) => {
    if (e.button === 2) {
      e.preventDefault();
      e.stopPropagation();
      stop(false);
    }
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      stop(e.key === 'Enter');
    }
  };
  last = { x: app.pointer.x, y: app.pointer.y };
  addEventListener('pointermove', mv, true);
  addEventListener('pointerup', up, true);
  addEventListener('pointerdown', dn, true);
  addEventListener('keydown', key, true);
}

/** Drag a rectangle inside the host region; resolves with region-local corners and whether it zooms out. */
function borderGesture(h: View2DHost, done: (r: { x0: number; y0: number; x1: number; y1: number }, zoomOut: boolean) => void) {
  const box = document.createElement('div');
  box.className = 'v2d-border';
  const hint = document.createElement('div');
  hint.className = 'v2d-border-hint';
  hint.textContent = 'Zoom Border: drag with LMB to zoom in, MMB to zoom out, Esc to cancel';
  document.body.append(box, hint);
  let start: { x: number; y: number; button: number } | null = null;
  const reg = () => h.el.getBoundingClientRect();
  const clampP = (x: number, y: number) => {
    const r = reg();
    return { x: Math.max(r.left, Math.min(r.right, x)), y: Math.max(r.top, Math.min(r.bottom, y)) };
  };
  // a crosshair until the drag starts
  const cross = (x: number, y: number) => Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: '0px', height: '0px', display: 'none' });
  cross(app.pointer.x, app.pointer.y);
  document.body.classList.add('v2d-border-active');
  const finish = () => {
    removeEventListener('pointerdown', dn, true);
    removeEventListener('pointermove', mv, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('keydown', key, true);
    box.remove();
    hint.remove();
    document.body.classList.remove('v2d-border-active');
  };
  const dn = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.button === 2) return finish();
    const p = clampP(e.clientX, e.clientY);
    start = { ...p, button: e.button };
  };
  const mv = (e: PointerEvent) => {
    e.stopPropagation();
    if (!start) return;
    const p = clampP(e.clientX, e.clientY);
    Object.assign(box.style, { display: '', left: `${Math.min(p.x, start.x)}px`, top: `${Math.min(p.y, start.y)}px`, width: `${Math.abs(p.x - start.x)}px`, height: `${Math.abs(p.y - start.y)}px` });
  };
  const up = (e: PointerEvent) => {
    e.stopPropagation();
    if (!start) return;
    const p = clampP(e.clientX, e.clientY);
    const r = reg();
    const s = start;
    finish();
    if (Math.abs(p.x - s.x) < 3 && Math.abs(p.y - s.y) < 3) return;
    done({ x0: Math.min(s.x, p.x) - r.left, y0: Math.min(s.y, p.y) - r.top, x1: Math.max(s.x, p.x) - r.left, y1: Math.max(s.y, p.y) - r.top }, s.button === 1);
  };
  const key = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') finish();
  };
  addEventListener('pointerdown', dn, true);
  addEventListener('pointermove', mv, true);
  addEventListener('pointerup', up, true);
  addEventListener('keydown', key, true);
}

/** Zoom the host so the region-local pixel box fills the view (or the view shrinks into the box). */
export function zoomToPixels(h: View2DHost, r: { x0: number; y0: number; x1: number; y1: number }, zoomOut = false, smooth = true) {
  if (h.getRect && h.toView && h.setRect) {
    const [ax, ay] = h.toView(r.x0, r.y1);
    const [bx, by] = h.toView(r.x1, r.y0);
    const box = { xmin: Math.min(ax, bx), xmax: Math.max(ax, bx), ymin: Math.min(ay, by), ymax: Math.max(ay, by) };
    const target = borderRect(h.getRect(), box, zoomOut);
    if (smooth) smoothView(h, target);
    else {
      if (h.lockY) {
        const cur = h.getRect();
        ((target.ymin = cur.ymin), (target.ymax = cur.ymax));
      }
      h.setRect(target);
      h.redraw?.();
    }
    return true;
  }
  if (!h.zoom) return false;
  // hosts without a rect: zoom around the box centre by the size ratio
  const reg = h.el.getBoundingClientRect();
  const fx = reg.width / Math.max(1, r.x1 - r.x0),
    fy = reg.height / Math.max(1, r.y1 - r.y0);
  const f = Math.min(fx, fy);
  const cx = (r.x0 + r.x1) / 2,
    cy = (r.y0 + r.y1) / 2;
  h.pan(reg.width / 2 - cx, reg.height / 2 - cy);
  applyZoom(h, zoomOut ? 1 / f : f, zoomOut ? 1 / f : f, reg.width / 2, reg.height / 2);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Edge pan: dragging something near (or past) the region edge scrolls the view

/**
 * Start edge panning for a drag in `h`'s region; call `update(x, y)` with the pointer on every move
 * and `stop()` when the drag ends. `onPan` runs after each pan step (e.g. to move the dragged item).
 */
export function startEdgePan(h: View2DHost, opts: EdgePanOptions = {}, onPan?: (dx: number, dy: number) => void) {
  let px = app.pointer.x,
    py = app.pointer.y;
  let raf = 0;
  let last = performance.now();
  const t0 = last;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if ((now - t0) / 1000 >= (opts.delay ?? 0)) {
      const [vx, vy] = edgePanSpeed(h.el.getBoundingClientRect(), px, py, opts);
      if (vx || vy) {
        // content moves against the pointer: the view travels towards the edge
        const dx = -vx * dt,
          dy = -vy * dt;
        h.pan(dx, dy);
        h.redraw?.();
        onPan?.(dx, dy);
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    update(x: number, y: number) {
      px = x;
      py = y;
    },
    stop() {
      cancelAnimationFrame(raf);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Operators

const poll = (ctx: OpContext) => !!hostOf(ctx);
const pollZoom = (ctx: OpContext) => !!hostOf(ctx)?.zoom;
const intProp = (id: string, label: string) => ({ id, label, type: 'int' as const, default: 0 });
const facProps = [
  { id: 'zoomfacx', label: 'Zoom Factor X', type: 'float' as const, default: 0, min: -2, max: 0.45, step: 0.01 },
  { id: 'zoomfacy', label: 'Zoom Factor Y', type: 'float' as const, default: 0, min: -2, max: 0.45, step: 0.01 },
];
const rectProps = ['xmin', 'xmax', 'ymin', 'ymax'].map((id) => intProp(id, id.replace('min', ' Min').replace('max', ' Max').toUpperCase()));

/** Default scroll step in pixels (wheel notch / scroll operators). */
const SCROLL_STEP = 40;

function scroll(ctx: OpContext, dx: number, dy: number, page: boolean) {
  const h = hostOf(ctx)!;
  if (page) {
    const r = h.el.getBoundingClientRect();
    // keep a line of context when paging
    dy = Math.sign(dy) * Math.max(SCROLL_STEP, r.height - SCROLL_STEP);
  }
  // scroll down / right: the view moves down / right, the contents up / left
  h.pan(-dx, -dy);
  h.redraw?.();
}

registerOperators([
  {
    idname: 'view2d.pan',
    label: 'Pan View',
    description: 'Move the 2D view; dragging moves the contents with the pointer',
    undo: false,
    props: [intProp('deltax', 'Delta X'), intProp('deltay', 'Delta Y')],
    poll,
    invoke: (ctx, p) => {
      if (p.deltax || p.deltay) return app.run('view2d.pan', p, { invoke: false, area: ctx.area });
      const h = hostOf(ctx)!;
      drag({ cursor: 'grabbing', move: (dx, dy) => (h.pan(dx, dy), h.redraw?.()) });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const h = hostOf(ctx)!;
      // positive deltas move the view right / up (contents left / down)
      h.pan(-Number(p.deltax), Number(p.deltay));
      h.redraw?.();
    },
  },
  {
    idname: 'view2d.scroll_up',
    label: 'Scroll Up',
    description: 'Scroll the view up',
    undo: false,
    props: [intProp('deltax', 'Delta X'), intProp('deltay', 'Delta Y'), { id: 'page', label: 'Page', type: 'bool', default: false }],
    poll,
    exec: (ctx, p) => scroll(ctx, Number(p.deltax), -(Number(p.deltay) || SCROLL_STEP), !!p.page),
  },
  {
    idname: 'view2d.scroll_down',
    label: 'Scroll Down',
    description: 'Scroll the view down',
    undo: false,
    props: [intProp('deltax', 'Delta X'), intProp('deltay', 'Delta Y'), { id: 'page', label: 'Page', type: 'bool', default: false }],
    poll,
    exec: (ctx, p) => scroll(ctx, Number(p.deltax), Number(p.deltay) || SCROLL_STEP, !!p.page),
  },
  {
    idname: 'view2d.scroll_left',
    label: 'Scroll Left',
    description: 'Scroll the view to the left',
    undo: false,
    props: [intProp('deltax', 'Delta X'), intProp('deltay', 'Delta Y')],
    poll,
    exec: (ctx, p) => scroll(ctx, -(Number(p.deltax) || SCROLL_STEP), Number(p.deltay), false),
  },
  {
    idname: 'view2d.scroll_right',
    label: 'Scroll Right',
    description: 'Scroll the view to the right',
    undo: false,
    props: [intProp('deltax', 'Delta X'), intProp('deltay', 'Delta Y')],
    poll,
    exec: (ctx, p) => scroll(ctx, Number(p.deltax) || SCROLL_STEP, Number(p.deltay), false),
  },
  {
    idname: 'view2d.zoom_in',
    label: 'Zoom In',
    description: 'Zoom in on the view, around the pointer',
    undo: false,
    props: facProps,
    poll: pollZoom,
    exec: (ctx, p) => {
      const h = hostOf(ctx)!;
      const { x, y } = localPoint(h, ctx);
      applyZoom(h, stepFactor(Number(p.zoomfacx) || ZOOM_STEP), stepFactor(Number(p.zoomfacy) || ZOOM_STEP), x, y);
    },
  },
  {
    idname: 'view2d.zoom_out',
    label: 'Zoom Out',
    description: 'Zoom out of the view, around the pointer',
    undo: false,
    props: facProps,
    poll: pollZoom,
    exec: (ctx, p) => {
      const h = hostOf(ctx)!;
      const { x, y } = localPoint(h, ctx);
      applyZoom(h, 1 / stepFactor(Number(p.zoomfacx) || ZOOM_STEP), 1 / stepFactor(Number(p.zoomfacy) || ZOOM_STEP), x, y);
    },
  },
  {
    idname: 'view2d.zoom',
    label: 'Zoom 2D View',
    description: 'Zoom by dragging: right or up zooms in, left or down zooms out',
    undo: false,
    props: [
      { id: 'deltax', label: 'Delta X', type: 'float', default: 0 },
      { id: 'deltay', label: 'Delta Y', type: 'float', default: 0 },
      { id: 'use_cursor_init', label: 'Use Mouse Position', type: 'bool', default: true },
    ],
    poll: pollZoom,
    invoke: (ctx, p) => {
      if (p.deltax || p.deltay) return app.run('view2d.zoom', p, { invoke: false, area: ctx.area });
      const h = hostOf(ctx)!;
      const at = p.use_cursor_init === false ? null : localPoint(h, ctx);
      drag({
        cursor: 'zoom-in',
        move: (dx, dy) => {
          const r = h.el.getBoundingClientRect();
          const c = at ?? { x: r.width / 2, y: r.height / 2 };
          // a mostly-vertical drag zooms both axes of 1D views
          const fx = Math.exp(dx * 0.01),
            fy = Math.exp(-dy * 0.01);
          applyZoom(h, h.lockY ? fx * fy : fx, fy, c.x, c.y);
        },
      });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const h = hostOf(ctx)!;
      const r = h.el.getBoundingClientRect();
      // deltas in pixels: the view's edges move in by that amount on each side
      const fx = r.width / Math.max(1, r.width - 2 * Number(p.deltax)),
        fy = r.height / Math.max(1, r.height - 2 * Number(p.deltay));
      const c = p.use_cursor_init === false ? { x: r.width / 2, y: r.height / 2 } : localPoint(h, ctx);
      applyZoom(h, fx, fy, c.x, c.y);
    },
  },
  {
    idname: 'view2d.zoom_border',
    label: 'Zoom to Border',
    description: 'Zoom in on a dragged rectangle (with the middle button: zoom out)',
    undo: false,
    props: [...rectProps, { id: 'wait_for_input', label: 'Wait for Input', type: 'bool', default: true, hidden: true }, { id: 'zoom_out', label: 'Zoom Out', type: 'bool', default: false }],
    poll: pollZoom,
    invoke: (ctx, p) => {
      if (p.xmin !== p.xmax && p.ymin !== p.ymax) return app.run('view2d.zoom_border', p, { invoke: false, area: ctx.area });
      const h = hostOf(ctx)!;
      borderGesture(h, (r, out) => zoomToPixels(h, r, out || !!p.zoom_out));
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const h = hostOf(ctx)!;
      const ht = h.el.getBoundingClientRect().height;
      // rect in region pixels with y up from the bottom
      const r = { x0: Number(p.xmin), x1: Number(p.xmax), y0: ht - Number(p.ymax), y1: ht - Number(p.ymin) };
      if (r.x1 - r.x0 < 1 || r.y1 - r.y0 < 1) return 'CANCELLED';
      zoomToPixels(h, r, !!p.zoom_out, false);
    },
  },
  {
    idname: 'view2d.reset',
    label: 'Reset View',
    description: 'Back to the top of the region at its default zoom',
    undo: false,
    poll: (ctx) => !!hostOf(ctx)?.reset,
    exec: (ctx) => {
      const h = hostOf(ctx)!;
      h.reset!();
      h.redraw?.();
    },
  },
  {
    idname: 'view2d.smoothview',
    label: 'Smooth View 2D',
    description: 'Move the view smoothly to the given rectangle (view units)',
    undo: false,
    internal: true,
    props: [
      { id: 'xmin', label: 'X Min', type: 'float', default: 0 },
      { id: 'xmax', label: 'X Max', type: 'float', default: 0 },
      { id: 'ymin', label: 'Y Min', type: 'float', default: 0 },
      { id: 'ymax', label: 'Y Max', type: 'float', default: 0 },
      { id: 'wait_for_input', label: 'Wait for Input', type: 'bool', default: true, hidden: true },
    ],
    poll: (ctx) => !!hostOf(ctx)?.setRect,
    exec: (ctx, p) => {
      const h = hostOf(ctx)!;
      const cur = h.getRect!();
      const t = { xmin: Number(p.xmin), xmax: Number(p.xmax), ymin: Number(p.ymin), ymax: Number(p.ymax) };
      if (!(t.xmax > t.xmin)) ((t.xmin = cur.xmin), (t.xmax = cur.xmax));
      if (!(t.ymax > t.ymin)) ((t.ymin = cur.ymin), (t.ymax = cur.ymax));
      smoothView(h, t);
    },
  },
  {
    idname: 'view2d.scroller_activate',
    label: 'Scroller Activate',
    description: 'Drag a scroll bar of the view: the bar pans, its ends zoom',
    undo: false,
    internal: true,
    poll,
    invoke: (ctx) => {
      const h = hostOf(ctx)!;
      const ext = h.extent?.();
      const r = h.el.getBoundingClientRect();
      const p = ctx.event ?? app.pointer;
      // vertical bar when the pointer is nearer the right edge than the bottom one
      const vertical = !!ext?.y && (!ext.x || r.right - p.x < r.bottom - p.y);
      const ax = vertical ? ext?.y : ext?.x;
      if (!ax) return 'PASS_THROUGH';
      const [v0, v1, t0, t1] = ax;
      const len = vertical ? r.height : r.width;
      const scale = (Math.max(t1, v1) - Math.min(t0, v0)) / Math.max(1, len);
      const unitPx = len / Math.max(1e-9, v1 - v0);
      drag({
        move: (dx, dy) => {
          const d = (vertical ? dy : dx) * scale * unitPx;
          if (vertical) h.pan(0, -d);
          else h.pan(-d, 0);
          h.redraw?.();
        },
      });
      return 'CANCELLED';
    },
  },
  {
    idname: 'view2d.edge_pan',
    label: 'View Edge Pan',
    description: 'Pan the view while the pointer is held near the region edge (for drags)',
    undo: false,
    internal: true,
    props: [
      { id: 'inside_padding', label: 'Inside Padding', type: 'float', default: 1, min: 0, max: 100 },
      { id: 'outside_padding', label: 'Outside Padding', type: 'float', default: 0, min: 0, max: 100 },
      { id: 'speed_ramp', label: 'Speed Ramp', type: 'float', default: 1, min: 0, max: 100 },
      { id: 'max_speed', label: 'Max Speed', type: 'float', default: 500, min: 0, max: 10000 },
      { id: 'delay', label: 'Delay', type: 'float', default: 1, min: 0, max: 10 },
      { id: 'zoom_influence', label: 'Zoom Influence', type: 'float', default: 0, min: 0, max: 1 },
    ],
    poll,
    invoke: (ctx, p) => {
      const h = hostOf(ctx)!;
      // paddings are in UI units (20 px each)
      const ep = startEdgePan(h, { inside_padding: Number(p.inside_padding) * 20, outside_padding: Number(p.outside_padding) * 20, speed_ramp: Number(p.speed_ramp) * 20, max_speed: Number(p.max_speed), delay: Number(p.delay) });
      drag({ move: (_dx, _dy, e) => ep.update(e.clientX, e.clientY), end: () => ep.stop() });
      return 'CANCELLED';
    },
  },
  {
    idname: 'view2d.ndof',
    label: 'NDOF Pan/Zoom',
    description: 'Pan and zoom the 2D view with a 3D mouse',
    undo: false,
    internal: true,
    props: [
      { id: 'pan_x', label: 'Pan X', type: 'float', default: 0 },
      { id: 'pan_y', label: 'Pan Y', type: 'float', default: 0 },
      { id: 'zoom', label: 'Zoom', type: 'float', default: 0 },
    ],
    poll,
    exec: (ctx, p) => {
      const h = hostOf(ctx)!;
      h.pan(-Number(p.pan_x), Number(p.pan_y));
      if (Number(p.zoom) && h.zoom) {
        const r = h.el.getBoundingClientRect();
        applyZoom(h, Math.exp(Number(p.zoom)), Math.exp(Number(p.zoom)), r.width / 2, r.height / 2);
      }
      h.redraw?.();
    },
  },
]);

// Keyboard parts of the shared 2D navigation keymaps (the editors handle the pointer/wheel parts).
addKeys('View2D', [
  { key: 'NUMPAD_PLUS', op: 'view2d.zoom_in' },
  { key: 'NUMPAD_MINUS', op: 'view2d.zoom_out' },
  { key: 'B', shift: true, op: 'view2d.zoom_border' },
]);
addKeys('View2D Buttons List', [
  { key: 'PAGE_DOWN', op: 'view2d.scroll_down', props: { page: true } },
  { key: 'PAGE_UP', op: 'view2d.scroll_up', props: { page: true } },
  { key: 'NUMPAD_PLUS', op: 'view2d.zoom_in' },
  { key: 'NUMPAD_MINUS', op: 'view2d.zoom_out' },
  { key: 'HOME', op: 'view2d.reset' },
]);

areaKeymapHooks.push((area) => view2dKeymap(area as AreaLike | null));
