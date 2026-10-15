// Generic brush stroke driver: turns pointer input into dabs following the brush's stroke method
// (spaced along the path, a dab per event, airbrush over time, a straight line, or a single
// anchored / dragged dab), with optional stabilizing (lazy mouse).
import { h, type VNode } from '../ui/h';
import { editModeHooks } from '../editors/view3d/hooks';
import type { View3D } from '../editors/view3d/view3d';
import { renderContext } from '../render/context';
import { cursorState } from './cursorstate';

export type StrokeMethod = 'SPACE' | 'DOTS' | 'AIRBRUSH' | 'LINE' | 'ANCHORED' | 'DRAG_DOT';

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
  /** the handler supports `restore` dabs (anchored and drag dot strokes) */
  canRestore?: boolean;
}

let active: { handler: StrokeHandler; view: View3D } | null = null;

export function strokeActive() {
  return !!active;
}

/** Straight line of a Line stroke, drawn while dragging. */
const lineState = { view: null as View3D | null, a: null as { x: number; y: number } | null, b: null as { x: number; y: number } | null, anchorR: 0 };

editModeHooks.svg.push((v) => {
  if (lineState.view !== v || !lineState.a || !lineState.b) return null;
  const { a, b } = lineState;
  const parts: VNode[] = [];
  if (lineState.anchorR > 0) parts.push(h('circle', { cx: a.x, cy: a.y, r: lineState.anchorR, fill: 'none', stroke: '#fff', 'stroke-width': 1, 'stroke-dasharray': '4 3' }) as VNode);
  else
    parts.push(
      h('path', { d: `M${a.x} ${a.y}L${b.x} ${b.y}`, stroke: '#000', 'stroke-width': 3, opacity: 0.4 }) as VNode,
      h('path', { d: `M${a.x} ${a.y}L${b.x} ${b.y}`, stroke: '#fff', 'stroke-width': 1.2 }) as VNode,
    );
  return h('g', { key: 'stroke-line' }, ...parts) as VNode;
});

export function runStroke(v: View3D, e: PointerEvent, handler: StrokeHandler) {
  const el = v.el;
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // ignore (synthetic events)
  }
  active = { handler, view: v };
  const st = handler.settings?.() ?? {};
  let method: StrokeMethod = st.stroke_method ?? 'SPACE';
  if ((method === 'ANCHORED' || method === 'DRAG_DOT') && !handler.canRestore) method = 'SPACE';
  const p0 = v.local(e);
  const rawPressure = (ev: PointerEvent) => (ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : 1);
  // pressure drives the strength (unless turned off); size pressure scales the dab radius
  const pressure = (ev: PointerEvent) => (st.use_pressure_strength === false ? 1 : rawPressure(ev));
  let lastPressure = pressure(e);
  let lastRaw = rawPressure(e);
  const sizeP = !!st.use_pressure_size;
  const dabSize = () => (sizeP ? Math.max(0.05, lastRaw) : undefined);
  // stabilized brush position
  const pos = { x: p0.x, y: p0.y };
  const smooth = !!st.use_smooth_stroke && method !== 'LINE' && method !== 'ANCHORED';
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
    handler.dab({ x: p0.x, y: p0.y, pressure: lastPressure, first: true, sizeFactor: dabSize() });
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
      handler.dab({ x: last.x, y: last.y, pressure: lastPressure, first: false, sizeFactor: dabSize() });
      handler.update?.();
    }, ms);
  }
  const spaced = (q: { x: number; y: number }, pr: number) => {
    const spacing = handler.spacing();
    if (spacing <= 0 || method === 'DOTS') {
      if (q.x !== last.x || q.y !== last.y) handler.dab({ x: q.x, y: q.y, pressure: pr, first: false, sizeFactor: dabSize() });
      last = q;
      return;
    }
    const step = Math.max(1, (handler.radiusPx() * spacing) / 100);
    const dx = q.x - last.x,
      dy = q.y - last.y;
    const len = Math.hypot(dx, dy);
    if (len < step) return;
    const n = Math.min(200, Math.floor(len / step));
    for (let i = 1; i <= n; i++) {
      const t = (i * step) / len;
      handler.dab({ x: last.x + dx * t, y: last.y + dy * t, pressure: pr, first: false, sizeFactor: dabSize() });
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
  const up = () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('pointercancel', up, true);
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
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  addEventListener('pointercancel', up, true);
}
