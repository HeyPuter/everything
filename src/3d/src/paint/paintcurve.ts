// Paint curves: with the Curve stroke method the brush follows a 2D Bézier curve drawn over the
// viewport. Ctrl+click adds points (drag to shape the handles), click-drag moves points and
// handles (Shift keeps the handles aligned), right-click selects, A toggles the selection,
// X / Delete removes points, G / R / S transform them, and Enter (or a click away from the curve)
// paints along it.
import { app, registerOperators, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import { h, type VNode } from '../ui/h';
import { uid } from '../data/defaults';
import type { DocumentData } from '../data/types';
import { editModeHooks, viewportExtensions } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { activeBrush, isBrushMode, type BrushMode, type PaintBrush } from './brushes';
import { paintHooks } from './painthooks';
import { playStroke } from './stroke';
import { curvePolyline, makeCurvePoint, moveCurveElement, pickCurvePoint, resamplePolyline, type PaintCurveData, type PaintCurvePoint, type Vec2 } from './strokemath';

export function paintCurvesOf(doc: DocumentData = app.doc): Record<string, PaintCurveData> {
  return (doc.paint_curves ??= {});
}

function brushNow(): PaintBrush | null {
  const m = app.doc.mode;
  return isBrushMode(m) ? activeBrush(m as BrushMode) : null;
}

/** The active brush uses the Curve stroke method. */
export const curveMethod = () => brushNow()?.stroke_method === 'CURVE';

export function activePaintCurve(b: PaintBrush | null = brushNow()): PaintCurveData | null {
  const id = b?.paint_curve;
  return (id && paintCurvesOf()[id]) || null;
}

function uniqueCurveName(doc: DocumentData, base: string) {
  const names = new Set(Object.values(paintCurvesOf(doc)).map((p) => p.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

export function newPaintCurve(doc: DocumentData, name = 'PaintCurve'): PaintCurveData {
  const c: PaintCurveData = { id: uid('pc'), name: uniqueCurveName(doc, name), points: [], add_index: -1 };
  paintCurvesOf(doc)[c.id] = c;
  return c;
}

/** The brush's curve, created on demand. */
function ensureCurve(b: PaintBrush): PaintCurveData {
  const c = activePaintCurve(b);
  if (c) return c;
  const n = newPaintCurve(app.doc);
  b.paint_curve = n.id;
  return n;
}

const viewFor = (ctx: OpContext): View3D | null => {
  const ed = ctx.area?.editor as View3D | undefined;
  return ed && typeof (ed as { local?: unknown }).local === 'function' && ed.camera ? ed : activeView3D();
};

/** Event position in viewport pixels (top-left origin). */
function eventPos(v: View3D, ctx: OpContext): Vec2 | null {
  if (!ctx.event) return null;
  const q = v.local({ clientX: ctx.event.x, clientY: ctx.event.y });
  return [q.x, q.y];
}

/** `location` prop (region pixels, y up) or the event position. */
function locOf(v: View3D, ctx: OpContext, p: Record<string, unknown>, useEvent: boolean): Vec2 | null {
  const l = p.location as number[] | undefined;
  if (!useEvent && l && l.length >= 2) return [l[0], v.height - l[1]];
  return eventPos(v, ctx) ?? (l && l.length >= 2 ? [l[0], v.height - l[1]] : null);
}

const redraw = () => {
  activeView3D()?.drawSvg();
  app.changed('ui');
};

const deselectAll = (c: PaintCurveData) => c.points.forEach((p) => (p.select = [false, false, false]));

function addPoint(c: PaintCurveData, at: Vec2): number {
  const n = c.points.length;
  const idx = c.add_index >= 0 && c.add_index < n ? c.add_index : n - 1;
  const prev = idx >= 0 ? c.points[idx].co : null;
  const next = idx + 1 < n ? c.points[idx + 1].co : null;
  const pt = makeCurvePoint(at, prev, prev ? null : next);
  deselectAll(c);
  c.points.splice(idx + 1, 0, pt);
  c.add_index = idx + 1;
  return idx + 1;
}

/** Drag an element of the curve with the mouse (modal). */
function slideModal(v: View3D, c: PaintCurveData, items: [number, number][], start: Vec2, align: boolean, label: string): 'RUNNING_MODAL' {
  const orig = c.points.map((p) => ({ h1: [...p.h1] as Vec2, co: [...p.co] as Vec2, h2: [...p.h2] as Vec2 }));
  const r = v.el.getBoundingClientRect();
  app.startModal({
    label,
    onPointerMove: (e) => {
      const dx = e.clientX - r.left - start[0],
        dy = e.clientY - r.top - start[1];
      // restore, then move by the total delta (no drift)
      c.points.forEach((p, i) => {
        p.h1 = [...orig[i].h1];
        p.co = [...orig[i].co];
        p.h2 = [...orig[i].h2];
      });
      for (const [i, k] of items) moveCurveElement(c.points[i], k, dx, dy, align);
      redraw();
    },
    onPointerUp: (e) => (e.button === 0 ? 'FINISHED' : undefined),
    onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : undefined),
    onKey: (e) => {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      return true;
    },
    cancel: () => {
      c.points.forEach((p, i) => {
        p.h1 = orig[i].h1;
        p.co = orig[i].co;
        p.h2 = orig[i].h2;
      });
      redraw();
    },
    header: () => 'Move the curve point · release to confirm · Esc cancels',
  });
  return 'RUNNING_MODAL';
}

/** Play a stroke of the active brush along the curve. */
export function drawCurve(v: View3D, c: PaintCurveData): boolean {
  if (c.points.length < 1 || !paintHooks.startStroke) return false;
  const line = resamplePolyline(curvePolyline(c.points, 48), 2);
  const pts = line.map(([x, y]) => ({ x, y }));
  // the stroke starts where the curve first reaches the mesh
  for (let i = 0; i < pts.length; i += 2) if (playStroke(v, pts.slice(i), (e) => paintHooks.startStroke!(v, e))) return true;
  return false;
}

const pollCurve = () => isBrushMode(app.doc.mode) && curveMethod();
const pollHasCurve = () => pollCurve() && !!activePaintCurve();
const locProp = { id: 'location', label: 'Location', type: 'vec2' as const, default: [0, 0], hidden: true };

registerOperators([
  {
    idname: 'paintcurve.new',
    label: 'Add New Paint Curve',
    description: 'Give the brush a new, empty paint curve',
    poll: () => !!brushNow(),
    exec: () => {
      const b = brushNow()!;
      b.paint_curve = newPaintCurve(app.doc).id;
      redraw();
    },
  },
  {
    idname: 'paintcurve.add_point',
    label: 'Add New Paint Curve Point',
    description: 'Add a point to the paint curve after the last added one',
    props: [locProp],
    poll: pollCurve,
    invoke: (ctx, p) => {
      const v = viewFor(ctx);
      const at = v && locOf(v, ctx, p, true);
      if (!v || !at) return 'CANCELLED';
      addPoint(ensureCurve(brushNow()!), at);
      redraw();
    },
    exec: (ctx, p) => {
      const v = viewFor(ctx);
      const at = v && locOf(v, ctx, p, false);
      if (!v || !at) return 'CANCELLED';
      addPoint(ensureCurve(brushNow()!), at);
      redraw();
    },
  },
  {
    idname: 'paintcurve.add_point_slide',
    label: 'Add Curve Point and Slide',
    description: 'Add a point to the paint curve, then drag to shape its handles',
    poll: pollCurve,
    invoke: (ctx) => {
      const v = viewFor(ctx);
      const at = v && eventPos(v, ctx);
      if (!v || !at) return 'CANCELLED';
      const c = ensureCurve(brushNow()!);
      const i = addPoint(c, at);
      redraw();
      // dragging pulls the outgoing handle out to the mouse; the other one mirrors it
      const pt = c.points[i];
      const h1 = [...pt.h1] as Vec2,
        h2 = [...pt.h2] as Vec2;
      const r = v.el.getBoundingClientRect();
      app.startModal({
        label: 'Add Curve Point and Slide',
        onPointerMove: (e) => {
          const x = e.clientX - r.left,
            y = e.clientY - r.top;
          if (Math.hypot(x - pt.co[0], y - pt.co[1]) < 3) return;
          pt.h2 = [x, y];
          pt.h1 = [2 * pt.co[0] - x, 2 * pt.co[1] - y];
          redraw();
        },
        onPointerUp: (e) => (e.button === 0 ? 'FINISHED' : undefined),
        onKey: (e) => (e.type === 'keydown' && e.key === 'Escape' ? 'CANCELLED' : true),
        cancel: () => {
          pt.h1 = h1;
          pt.h2 = h2;
          redraw();
        },
        header: () => 'Drag to shape the handles · release to confirm',
      });
      return 'RUNNING_MODAL';
    },
    exec: () => 'CANCELLED',
  },
  {
    idname: 'paintcurve.select',
    label: 'Select Paint Curve Point',
    description: 'Select the curve point or handle under the mouse (or toggle the selection of all)',
    props: [locProp, { id: 'toggle', label: 'Toggle', type: 'bool', default: false }, { id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: pollHasCurve,
    invoke: (ctx, p) => selectExec(ctx, p, true),
    exec: (ctx, p) => selectExec(ctx, p, false),
  },
  {
    idname: 'paintcurve.slide',
    label: 'Slide Paint Curve Point',
    description: 'Drag the curve point or handle under the mouse',
    props: [
      { id: 'align', label: 'Align Handles', type: 'bool', default: false },
      { id: 'select', label: 'Select', type: 'bool', default: true },
    ],
    poll: pollHasCurve,
    invoke: (ctx, p) => {
      const v = viewFor(ctx);
      const c = activePaintCurve();
      const at = v && eventPos(v, ctx);
      if (!v || !c || !at) return 'CANCELLED';
      const hit = pickCurvePoint(c.points, at[0], at[1], 12);
      if (!hit) return 'CANCELLED';
      if (p.select !== false) {
        deselectAll(c);
        if (hit[1] === 1) c.points[hit[0]].select = [true, true, true];
        else c.points[hit[0]].select[hit[1]] = true;
        c.add_index = hit[0];
      }
      redraw();
      return slideModal(v, c, [hit], at, !!p.align, 'Slide Paint Curve Point');
    },
    exec: () => 'CANCELLED',
  },
  {
    idname: 'paintcurve.delete_point',
    label: 'Remove Paint Curve Point',
    description: 'Remove the selected points of the paint curve',
    poll: pollHasCurve,
    exec: () => {
      const c = activePaintCurve()!;
      const before = c.points.length;
      c.points = c.points.filter((p) => !p.select[1]);
      if (c.points.length === before) return 'CANCELLED';
      c.add_index = c.points.length - 1;
      redraw();
    },
  },
  {
    idname: 'paintcurve.cursor',
    label: 'Place Cursor',
    description: 'Place the 3D cursor under the mouse',
    poll: pollCurve,
    invoke: (ctx) => app.run('view3d.cursor3d', {}, { event: ctx.event, area: ctx.area }),
    exec: () => 'CANCELLED',
  },
  {
    idname: 'paintcurve.draw',
    label: 'Draw Curve',
    description: 'Paint with the active brush along the paint curve',
    // the stroke pushes its own undo step
    undo: false,
    poll: () => pollHasCurve() && (activePaintCurve()?.points.length ?? 0) > 0,
    exec: (ctx) => {
      const v = viewFor(ctx);
      const c = activePaintCurve();
      if (!v || !c) return 'CANCELLED';
      if (!drawCurve(v, c)) {
        app.report('WARNING', 'The curve does not touch the mesh');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'paintcurve.transform',
    label: 'Transform Paint Curve',
    description: 'Move, rotate or scale the selected paint curve points with the mouse',
    internal: true,
    props: [{ id: 'mode', label: 'Mode', type: 'enum', default: 'TRANSLATION', items: [['TRANSLATION', 'Move'], ['ROTATION', 'Rotate'], ['RESIZE', 'Scale']] }],
    poll: pollHasCurve,
    invoke: (ctx, p) => transformModal(ctx, String(p.mode)),
    exec: () => 'CANCELLED',
  },
]);

function selectExec(ctx: OpContext, p: Record<string, unknown>, useEvent: boolean) {
  const v = viewFor(ctx);
  const c = activePaintCurve();
  if (!v || !c) return 'CANCELLED';
  if (p.toggle) {
    const any = c.points.some((q) => q.select.some(Boolean));
    c.points.forEach((q) => (q.select = [!any, !any, !any]));
    redraw();
    return 'FINISHED';
  }
  const at = locOf(v, ctx, p, useEvent);
  if (!at) return 'CANCELLED';
  const hit = pickCurvePoint(c.points, at[0], at[1], 12);
  if (!p.extend) deselectAll(c);
  if (!hit) {
    redraw();
    return 'FINISHED';
  }
  const q = c.points[hit[0]];
  if (hit[1] === 1) {
    const on = p.extend ? !q.select[1] : true;
    q.select = [on, on, on];
  } else q.select[hit[1]] = p.extend ? !q.select[hit[1]] : true;
  c.add_index = hit[0];
  redraw();
  return 'FINISHED';
}

/** G / R / S on the selected curve points (around their center). */
function transformModal(ctx: OpContext, mode: string): 'RUNNING_MODAL' | 'CANCELLED' {
  const v = viewFor(ctx);
  const c = activePaintCurve();
  const at = v && eventPos(v, ctx);
  if (!v || !c || !at) return 'CANCELLED';
  const sel: [PaintCurvePoint, number][] = [];
  for (const q of c.points) for (let k = 0; k < 3; k++) if (q.select[k]) sel.push([q, k]);
  if (!sel.length) return 'CANCELLED';
  const get = (q: PaintCurvePoint, k: number) => (k === 0 ? q.h1 : k === 1 ? q.co : q.h2);
  const orig = sel.map(([q, k]) => [...get(q, k)] as Vec2);
  let cx = 0,
    cy = 0;
  for (const o of orig) {
    cx += o[0];
    cy += o[1];
  }
  cx /= orig.length;
  cy /= orig.length;
  const r = v.el.getBoundingClientRect();
  const a0 = Math.atan2(at[1] - cy, at[0] - cx),
    d0 = Math.max(1, Math.hypot(at[0] - cx, at[1] - cy));
  const apply = (x: number, y: number) => {
    const ang = Math.atan2(y - cy, x - cx) - a0,
      k = Math.hypot(x - cx, y - cy) / d0;
    const cs = Math.cos(ang),
      sn = Math.sin(ang);
    sel.forEach(([q, kk], i) => {
      const o = orig[i];
      const t = get(q, kk);
      if (mode === 'TRANSLATION') {
        t[0] = o[0] + x - at[0];
        t[1] = o[1] + y - at[1];
      } else if (mode === 'ROTATION') {
        const dx = o[0] - cx,
          dy = o[1] - cy;
        t[0] = cx + dx * cs - dy * sn;
        t[1] = cy + dx * sn + dy * cs;
      } else {
        t[0] = cx + (o[0] - cx) * k;
        t[1] = cy + (o[1] - cy) * k;
      }
    });
    redraw();
  };
  app.startModal({
    label: 'Transform Paint Curve',
    onPointerMove: (e) => apply(e.clientX - r.left, e.clientY - r.top),
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
    onKey: (e) => {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      return true;
    },
    cancel: () => {
      sel.forEach(([q, k], i) => {
        const t = get(q, k);
        t[0] = orig[i][0];
        t[1] = orig[i][1];
      });
      redraw();
    },
    header: () => `${mode === 'TRANSLATION' ? 'Move' : mode === 'ROTATION' ? 'Rotate' : 'Scale'} the curve points · click to confirm · Esc cancels`,
  });
  return 'RUNNING_MODAL';
}

// ---------------------------------------------------------------------------
// keymap and input

addKeys('Paint Curve', [
  { key: 'A', op: 'paintcurve.select', props: { toggle: true } },
  { key: 'X', op: 'paintcurve.delete_point' },
  { key: 'DEL', op: 'paintcurve.delete_point' },
  { key: 'RET', op: 'paintcurve.draw' },
  { key: 'NUMPAD_ENTER', op: 'paintcurve.draw' },
  { key: 'G', op: 'paintcurve.transform', props: { mode: 'TRANSLATION' } },
  { key: 'R', op: 'paintcurve.transform', props: { mode: 'ROTATION' } },
  { key: 'S', op: 'paintcurve.transform', props: { mode: 'RESIZE' } },
]);
paintHooks.priorityKeymaps.push({ name: 'Paint Curve', active: pollCurve });

// LMB: Ctrl adds a point, Shift+Ctrl places the cursor, on a point slides it, elsewhere paints along the curve
paintHooks.brushPointer.push((v, e) => {
  if (!curveMethod() || e.altKey) return false;
  const ev = { x: e.clientX, y: e.clientY };
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.shiftKey) return app.run('paintcurve.cursor', {}, { event: ev, area: v.area as never }), true;
  if (ctrl) return app.run('paintcurve.add_point_slide', {}, { event: ev, area: v.area as never }), true;
  const c = activePaintCurve();
  if (c) {
    const q = v.local(e);
    if (pickCurvePoint(c.points, q.x, q.y, 12)) {
      app.run('paintcurve.slide', { align: e.shiftKey }, { event: ev, area: v.area as never });
      return true;
    }
  }
  if (!c || !c.points.length) {
    app.report('INFO', 'Curve stroke: Ctrl+click to add curve points, then click or press Enter to paint along the curve');
    return true;
  }
  app.run('paintcurve.draw', {}, { invoke: false, area: v.area as never });
  return true;
});

// RMB: select curve points
viewportExtensions.push((v) => {
  const down = (e: PointerEvent) => {
    if (e.defaultPrevented || e.button !== 2 || app.modal || !isBrushMode(app.doc.mode) || !curveMethod() || !activePaintCurve()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    app.run('paintcurve.select', { extend: e.shiftKey }, { event: { x: e.clientX, y: e.clientY }, area: v.area as never });
  };
  v.el.addEventListener('pointerdown', down, true);
  return () => v.el.removeEventListener('pointerdown', down, true);
});

// ---------------------------------------------------------------------------
// overlay

const SEL = '#ffaa33',
  DESEL = '#f0f0f0';

editModeHooks.svg.push(() => {
  if (!isBrushMode(app.doc.mode) || !curveMethod()) return null;
  const c = activePaintCurve();
  if (!c || !c.points.length) return null;
  const pts = c.points;
  let d = `M${pts[0].co[0]} ${pts[0].co[1]}`;
  for (let i = 0; i + 1 < pts.length; i++) d += `C${pts[i].h2[0]} ${pts[i].h2[1]} ${pts[i + 1].h1[0]} ${pts[i + 1].h1[1]} ${pts[i + 1].co[0]} ${pts[i + 1].co[1]}`;
  const parts: VNode[] = [
    h('path', { d, fill: 'none', stroke: '#000000', 'stroke-width': 4, opacity: 0.45 }) as VNode,
    h('path', { d, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.6 }) as VNode,
  ];
  pts.forEach((p, i) => {
    for (const k of [0, 2]) {
      const hh = k === 0 ? p.h1 : p.h2;
      parts.push(h('path', { key: `l${i}-${k}`, d: `M${p.co[0]} ${p.co[1]}L${hh[0]} ${hh[1]}`, stroke: p.select[k] ? SEL : '#c0c0c0', 'stroke-width': 1, opacity: 0.8 }) as VNode);
      parts.push(h('circle', { key: `h${i}-${k}`, cx: hh[0], cy: hh[1], r: 3.5, fill: p.select[k] ? SEL : DESEL, stroke: '#000000', 'stroke-width': 1 }) as VNode);
    }
    parts.push(h('circle', { key: `p${i}`, cx: p.co[0], cy: p.co[1], r: 5, fill: p.select[1] ? SEL : DESEL, stroke: '#000000', 'stroke-width': 1.2 }) as VNode);
  });
  return h('g', { key: 'paint-curve', class: 'paint-curve', 'pointer-events': 'none' }, ...parts) as VNode;
});
