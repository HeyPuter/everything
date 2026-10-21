// Generic brush stroke driver: turns pointer input into dabs following the brush's stroke method
// (spaced along the path, a dab per event, airbrush over time, a straight line, or a single
// anchored / dragged dab), with optional stabilizing (lazy mouse).
import { h, type VNode } from '../ui/h';
import { tabletPressure } from '../app/prefs';
import { editModeHooks } from '../editors/view3d/hooks';
import type { View3D } from '../editors/view3d/view3d';
import { renderContext } from '../render/context';
import { cursorState } from './cursorstate';
import { revertToUndoState } from './session';
import { cachedCurveTable, sampleTable } from './math';

export type StrokeMethod = 'SPACE' | 'DOTS' | 'AIRBRUSH' | 'LINE' | 'ANCHORED' | 'DRAG_DOT' | 'CURVE';

export interface Dab {
  x: number;
  y: number;
  pressure: number;
  /** first dab of the stroke */
  first: boolean;
  /** brush radius in pixels for this dab (anchored strokes), else the brush radius */
  radiusPx?: number;
  /** pen pressure factor for the radius (size pressure) */
  sizeFactor?: number;
  /** undo the previous dabs of the stroke before this one (anchored / drag dot strokes) */
  restore?: boolean;
}

export interface StrokeSettings {
  stroke_method?: StrokeMethod;
  use_smooth_stroke?: boolean;
  /** stabilizer radius in pixels */
  smooth_stroke_radius?: number;
  /** stabilizer smoothness 0..1 */
  smooth_stroke_factor?: number;
  /** airbrush interval in seconds */
  rate?: number;
  use_pressure_size?: boolean;
  use_pressure_strength?: boolean;
  /** pressure response curves (control points), used when the matching flag is on */
  curve_size?: [number, number][];
  curve_strength?: [number, number][];
  use_size_curve?: boolean;
  use_strength_curve?: boolean;
  /** random dab offset: fraction of the radius (BRUSH) or pixels (VIEW) */
  jitter?: number;
  jitter_absolute?: number;
  jitter_unit?: 'VIEW' | 'BRUSH';
  use_pressure_jitter?: boolean;
  /** pen pressure scales the spacing */
  use_pressure_spacing?: boolean;
}

export interface StrokeHandler {
  /** spacing in percent of the radius (0 = a dab per pointer event) */
  spacing(): number;
  radiusPx(): number;
  dab(d: Dab): void;
  /** after the dabs of one pointer event (upload GPU buffers etc.) */
  update?(): void;
  end(): void;
  /** stroke method and stabilizer of the brush */
  settings?(): StrokeSettings;
  /** Esc during the stroke (default: back to the last undo state) */
  cancel?(): void;
  /** the handler supports `restore` dabs (anchored and drag dot strokes) */
  canRestore?: boolean;
}

/** What a stroke needs from the editor it runs in (the 3D Viewport, the Image Editor). */
export interface StrokeView {
  el: HTMLElement;
  /** pointer position in the editor's pixels (top-left origin) */
  local(e: { clientX: number; clientY: number }): { x: number; y: number };
  /** redraw overlays (line / anchored previews) */
  drawSvg(): void;
}

let active: { handler: StrokeHandler; view: StrokeView } | null = null;

/** A recorded stroke point in viewport pixels (top-left origin). */
export interface StrokePoint {
  x: number;
  y: number;
  /** pen pressure 0..1 (1 when not given) */
  pressure?: number;
}

/** Points of a scripted stroke: the next `runStroke` plays them back synchronously. */
let replay: StrokePoint[] | null = null;

/** Synthetic pointer event at a viewport position (client coordinates are derived from the view). */
export function strokeEvent(v: StrokeView, p: StrokePoint, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): PointerEvent {
  const r = v.el.getBoundingClientRect();
  const pr = p.pressure ?? 1;
  return {
    clientX: r.left + p.x,
    clientY: r.top + p.y,
    pointerId: -1,
    pointerType: pr !== 1 ? 'pen' : 'mouse',
    pressure: pr,
    button: 0,
    buttons: 1,
    ctrlKey: !!mods.ctrl,
    metaKey: false,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    target: v.el,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as PointerEvent;
}

/**
 * Run a stroke from recorded points instead of live pointer input: `start` receives a synthetic
 * press at the first point and starts the stroke as a pointer press would (it calls `runStroke`),
 * the remaining points are then played back and the stroke ends. Returns false when nothing started.
 */
export function playStroke(v: StrokeView, points: StrokePoint[], start: (e: PointerEvent) => boolean, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): boolean {
  if (!points.length || active) return false;
  replay = points.slice(1);
  try {
    return start(strokeEvent(v, points[0], mods)) !== false;
  } finally {
    replay = null;
  }
}

export function strokeActive() {
  return !!active;
}

/** Straight line of a Line stroke, drawn while dragging. */
const lineState = { view: null as StrokeView | null, a: null as { x: number; y: number } | null, b: null as { x: number; y: number } | null, anchorR: 0 };

editModeHooks.svg.push((v) => {
  if (lineState.view !== v || !lineState.a || !lineState.b) return null;
  const { a, b } = lineState;
  const parts: VNode[] = [];
  if (lineState.anchorR > 0) parts.push(h('circle', { cx: a.x, cy: a.y, r: lineState.anchorR, fill: 'none', stroke: '#ffffff', 'stroke-width': 1, 'stroke-dasharray': '4 3' }) as VNode);
  else
    parts.push(
      h('path', { d: `M${a.x} ${a.y}L${b.x} ${b.y}`, stroke: '#000000', 'stroke-width': 3, opacity: 0.4 }) as VNode,
      h('path', { d: `M${a.x} ${a.y}L${b.x} ${b.y}`, stroke: '#ffffff', 'stroke-width': 1.2 }) as VNode,
    );
  return h('g', { key: 'stroke-line' }, ...parts) as VNode;
});

export function runStroke(v: StrokeView, e: PointerEvent, handler: StrokeHandler) {
  const el = v.el;
  const scripted = replay;
  replay = null;
  if (!scripted)
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // ignore (synthetic events)
    }
  active = { handler, view: v };
  const st = handler.settings?.() ?? {};
  let method: StrokeMethod = st.stroke_method ?? 'SPACE';
  if ((method === 'ANCHORED' || method === 'DRAG_DOT') && !handler.canRestore) method = 'SPACE';
  // a curve stroke is played back along the curve: plain spacing
  const curve = method === 'CURVE';
  if (curve) method = 'SPACE';
  const p0 = v.local(e);
  const rawPressure = (ev: PointerEvent) => (ev.pointerType === 'pen' && ev.pressure > 0 ? tabletPressure(ev.pressure) : 1);
  // pressure drives the strength (unless turned off); size pressure scales the dab radius, both
  // through their response curves when those are on
  const strengthCurve = st.use_strength_curve ? cachedCurveTable(st.curve_strength) : null;
  const sizeCurve = st.use_size_curve ? cachedCurveTable(st.curve_size) : null;
  const pressure = (ev: PointerEvent) => {
    if (st.use_pressure_strength === false) return 1;
    const r = rawPressure(ev);
    return strengthCurve ? Math.max(0, sampleTable(strengthCurve, r)) : r;
  };
  let lastPressure = pressure(e);
  let lastRaw = rawPressure(e);
  const sizeP = !!st.use_pressure_size;
  const dabSize = () => (sizeP ? Math.max(0.05, sizeCurve ? sampleTable(sizeCurve, lastRaw) : lastRaw) : undefined);
  // jitter: dabs land at a random offset inside a disk
  const jitterOn = (st.jitter_unit === 'VIEW' ? (st.jitter_absolute ?? 0) : (st.jitter ?? 0)) > 0;
  let seed = 0x9e3779b9;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const jitterDab = (d: Dab): Dab => {
    if (!jitterOn) return d;
    const amount = (st.jitter_unit === 'VIEW' ? (st.jitter_absolute ?? 0) : (st.jitter ?? 0) * handler.radiusPx()) * (st.use_pressure_jitter ? lastRaw : 1);
    const a = rand() * Math.PI * 2,
      r = Math.sqrt(rand()) * amount;
    return { ...d, x: d.x + Math.cos(a) * r, y: d.y + Math.sin(a) * r };
  };
  // stabilized brush position
  const pos = { x: p0.x, y: p0.y };
  const smooth = !!st.use_smooth_stroke && method !== 'LINE' && method !== 'ANCHORED' && !curve;
  const smoothR = st.smooth_stroke_radius ?? 75,
    smoothF = Math.min(0.99, Math.max(0, st.smooth_stroke_factor ?? 0.9));
  const follow = (q: { x: number; y: number }) => {
    if (!smooth) return { x: q.x, y: q.y };
    const dx = q.x - pos.x,
      dy = q.y - pos.y;
    const d = Math.hypot(dx, dy);
    if (d <= smoothR) return { ...pos };
    // pull the brush toward the pointer, staying `smoothR` behind it, damped by the factor
    const k = ((d - smoothR) / d) * (1 - smoothF * 0.85);
    pos.x += dx * k;
    pos.y += dy * k;
    return { ...pos };
  };
  let last = { x: p0.x, y: p0.y };
  let firstDone = false;
  if (method === 'LINE' || method === 'ANCHORED') {
    lineState.view = v;
    lineState.a = { ...p0 };
    lineState.b = { ...p0 };
    lineState.anchorR = method === 'ANCHORED' ? 1 : 0;
  }
  if (method !== 'LINE' && method !== 'ANCHORED') {
    handler.dab(jitterDab({ x: p0.x, y: p0.y, pressure: lastPressure, first: true, sizeFactor: dabSize() }));
    firstDone = true;
    handler.update?.();
  }
  cursorState.x = p0.x;
  cursorState.y = p0.y;
  let raf = 0;
  let pending: PointerEvent[] = [];
  let airTimer = 0;
  if (method === 'AIRBRUSH') {
    const ms = Math.max(5, (st.rate ?? 0.1) * 1000);
    airTimer = window.setInterval(() => {
      handler.dab(jitterDab({ x: last.x, y: last.y, pressure: lastPressure, first: false, sizeFactor: dabSize() }));
      handler.update?.();
    }, ms);
  }
  const spaced = (q: { x: number; y: number }, pr: number) => {
    const spacing = handler.spacing();
    if (spacing <= 0 || method === 'DOTS') {
      if (q.x !== last.x || q.y !== last.y) handler.dab(jitterDab({ x: q.x, y: q.y, pressure: pr, first: false, sizeFactor: dabSize() }));
      last = q;
      return;
    }
    const step = Math.max(1, ((handler.radiusPx() * spacing) / 100) * (st.use_pressure_spacing ? Math.max(0.1, lastRaw) : 1));
    const dx = q.x - last.x,
      dy = q.y - last.y;
    const len = Math.hypot(dx, dy);
    if (len < step) return;
    const n = Math.min(200, Math.floor(len / step));
    for (let i = 1; i <= n; i++) {
      const t = (i * step) / len;
      handler.dab(jitterDab({ x: last.x + dx * t, y: last.y + dy * t, pressure: pr, first: false, sizeFactor: dabSize() }));
    }
    const t = (n * step) / len;
    last = { x: last.x + dx * t, y: last.y + dy * t };
  };
  const process = () => {
    raf = 0;
    const evs = pending;
    pending = [];
    if (!evs.length) return;
    for (const ev of evs) {
      const q = v.local(ev);
      lastPressure = pressure(ev);
      lastRaw = rawPressure(ev);
      if (method === 'LINE') {
        lineState.b = q;
        continue;
      }
      if (method === 'ANCHORED') {
        // one dab at the press point, its radius set by the drag distance
        const r = Math.max(1, Math.hypot(q.x - p0.x, q.y - p0.y));
        lineState.b = q;
        lineState.anchorR = r;
        continue;
      }
      if (method === 'DRAG_DOT') {
        last = q;
        continue;
      }
      spaced(follow(q), lastPressure);
    }
    if (method === 'ANCHORED' && lineState.b) {
      handler.dab({ x: p0.x, y: p0.y, pressure: lastPressure, first: !firstDone, radiusPx: lineState.anchorR, restore: firstDone });
      firstDone = true;
    } else if (method === 'DRAG_DOT') handler.dab({ x: last.x, y: last.y, pressure: lastPressure, first: false, restore: true, sizeFactor: dabSize() });
    if (method === 'LINE') v.drawSvg();
    handler.update?.();
    if (method === 'ANCHORED') v.drawSvg();
  };
  const move = (ev: PointerEvent) => {
    const q = v.local(ev);
    cursorState.x = q.x;
    cursorState.y = q.y;
    const coalesced = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
    if (coalesced.length) pending.push(...coalesced);
    else pending.push(ev);
    if (!raf) raf = requestAnimationFrame(process);
  };
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    // cancel: drop everything this stroke did
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('pointercancel', up, true);
    removeEventListener('keydown', key, true);
    if (raf) cancelAnimationFrame(raf);
    if (airTimer) clearInterval(airTimer);
    lineState.a = lineState.b = null;
    lineState.anchorR = 0;
    active = null;
    if (handler.cancel) handler.cancel();
    else revertToUndoState();
    renderContext?.engine.requestDraw();
    v.drawSvg();
  };
  const up = () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('pointercancel', up, true);
    removeEventListener('keydown', key, true);
    if (raf) cancelAnimationFrame(raf);
    if (airTimer) clearInterval(airTimer);
    process();
    if (method === 'LINE' && lineState.a && lineState.b) {
      // the whole line at once, spaced along it
      const a = lineState.a;
      handler.dab({ x: a.x, y: a.y, pressure: lastPressure, first: true });
      last = { ...a };
      spaced(lineState.b, lastPressure);
      handler.update?.();
    }
    lineState.a = lineState.b = null;
    lineState.anchorR = 0;
    active = null;
    handler.end();
    renderContext?.engine.requestDraw();
    v.drawSvg();
  };
  if (scripted) {
    // recorded stroke: every point at once, then finish
    if (airTimer) clearInterval(airTimer);
    airTimer = 0;
    const mods = { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey };
    for (const p of scripted) {
      const ev = { ...strokeEvent(v, p), ...mods };
      pending.push(ev);
      if (method === 'AIRBRUSH') {
        // one timed dab per recorded point
        process();
        handler.dab(jitterDab({ x: last.x, y: last.y, pressure: lastPressure, first: false, sizeFactor: dabSize() }));
      }
    }
    up();
    return;
  }
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  addEventListener('pointercancel', up, true);
  addEventListener('keydown', key, true);
}
