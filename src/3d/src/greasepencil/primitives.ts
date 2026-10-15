// Primitive tools (Line, Polyline, Arc, Curve, Box, Circle). A shape is dragged out, then stays
// editable until confirmed: drag its handles, E extrudes a new segment from the end, G / R / S
// move / rotate / scale it, F / Shift F change thickness / opacity, ↑ / ↓ (or the wheel) change
// the subdivisions; Enter, Space or middle click confirm, Esc / Q / right click cancel. Clicking
// away from the handles confirms the shape and starts the next one.
import { app, registerOperators, type ModalHandler } from '../app/app';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { h } from '../ui/h';
import { gpBrush, toStrokes, fromStrokes, newStroke, type GPStroke } from './data';
import { drawContext, checkLayer, materialUsable, brushColorFor, editableDrawing, samplesToPoints } from './paint';
import { Placement } from './placement';
import { setStrokePreview } from './render';

export type PrimType = 'LINE' | 'POLYLINE' | 'ARC' | 'CURVE' | 'BOX' | 'CIRCLE';
export interface P2 {
  x: number;
  y: number;
}

const ARC_K = 0.5523;

function cubic(a: P2, c1: P2, c2: P2, b: P2, n: number, incEnd: boolean, out: P2[]) {
  for (let i = 0; i <= n; i++) {
    if (i === n && !incEnd) break;
    const t = i / n,
      m = 1 - t;
    out.push({
      x: m * m * m * a.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * b.x,
      y: m * m * m * a.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * b.y,
    });
  }
}

const lerp2 = (a: P2, b: P2, t: number): P2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Control points per segment after the first point (LINE / POLYLINE 1, ARC 2, CURVE 3). */
export const SEG_STRIDE: Record<PrimType, number> = { LINE: 1, POLYLINE: 1, ARC: 2, CURVE: 3, BOX: 1, CIRCLE: 1 };

/**
 * Screen points of a primitive from its control points: LINE / POLYLINE a chain of points,
 * ARC a chain of (corner handle, point), CURVE a chain of (handle, handle, point), BOX / CIRCLE the
 * two corners of the bounding box.
 */
export function primitivePoints(type: PrimType, cp: P2[], subdivision: number): P2[] {
  const out: P2[] = [];
  const n = Math.max(1, subdivision + 1);
  if (!cp.length) return out;
  if (type === 'BOX') {
    const [a, b] = [cp[0], cp[cp.length - 1]];
    const c = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    for (let k = 0; k < 4; k++) for (let i = 0; i < n; i++) out.push(lerp2(c[k], c[(k + 1) % 4], i / n));
    return out;
  }
  if (type === 'CIRCLE') {
    const [a, b] = [cp[0], cp[cp.length - 1]];
    const cx = (a.x + b.x) / 2,
      cy = (a.y + b.y) / 2,
      rx = Math.abs(b.x - a.x) / 2,
      ry = Math.abs(b.y - a.y) / 2;
    const N = Math.max(8, subdivision);
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      out.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
    }
    return out;
  }
  const stride = SEG_STRIDE[type];
  const segs = Math.floor((cp.length - 1) / stride);
  if (!segs) return [cp[0]];
  for (let s = 0; s < segs; s++) {
    const a = cp[s * stride];
    const last = s === segs - 1;
    if (type === 'LINE' || type === 'POLYLINE') {
      const b = cp[s * stride + 1];
      for (let i = 0; i <= n; i++) if (i < n || last) out.push(lerp2(a, b, i / n));
    } else if (type === 'ARC') {
      const corner = cp[s * stride + 1],
        b = cp[s * stride + 2];
      cubic(a, lerp2(a, corner, ARC_K), lerp2(b, corner, ARC_K), b, Math.max(4, subdivision), last, out);
    } else {
      cubic(a, cp[s * stride + 1], cp[s * stride + 2], cp[s * stride + 3], Math.max(4, subdivision), last, out);
    }
  }
  return out;
}

/** Control points for a fresh segment from `a` to `b`. */
export function segmentControls(type: PrimType, a: P2, b: P2): P2[] {
  if (type === 'ARC') return [{ x: b.x, y: a.y }, b];
  if (type === 'CURVE') return [lerp2(a, b, 1 / 3), lerp2(a, b, 2 / 3), b];
  return [b];
}

// ---------------------------------------------------------------------------
// modal

interface Prim {
  view: View3D;
  type: PrimType;
  cp: P2[];
  subdivision: number;
  radiusScale: number;
  opacity: number;
}

let current: Prim | null = null;
let hoverHandle = -1;

const HANDLE_PX = 8;

function controlsFromDrag(type: PrimType, a: P2, b: P2, shift: boolean, alt: boolean): P2[] {
  if (type === 'BOX' || type === 'CIRCLE') {
    let bb = b;
    if (shift) {
      const d = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      bb = { x: a.x + Math.sign(b.x - a.x || 1) * d, y: a.y + Math.sign(b.y - a.y || 1) * d };
    }
    return alt ? [{ x: 2 * a.x - bb.x, y: 2 * a.y - bb.y }, bb] : [a, bb];
  }
  let bb = b;
  if (shift && type === 'LINE') {
    // snap the direction to 15° steps
    const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 12)) * (Math.PI / 12);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    bb = { x: a.x + Math.cos(ang) * d, y: a.y + Math.sin(ang) * d };
  }
  const start = alt && type === 'LINE' ? { x: 2 * a.x - bb.x, y: 2 * a.y - bb.y } : a;
  return [start, ...segmentControls(type, start, bb)];
}

function centerOf(cp: P2[]): P2 {
  const c = { x: 0, y: 0 };
  for (const p of cp) {
    c.x += p.x / cp.length;
    c.y += p.y / cp.length;
  }
  return c;
}

const OPS: [string, PrimType, string, number][] = [
  ['grease_pencil.primitive_line', 'LINE', 'Grease Pencil Line Shape', 6],
  ['grease_pencil.primitive_polyline', 'POLYLINE', 'Grease Pencil Polyline Shape', 6],
  ['grease_pencil.primitive_arc', 'ARC', 'Grease Pencil Arc Shape', 62],
  ['grease_pencil.primitive_curve', 'CURVE', 'Grease Pencil Curve Shape', 62],
  ['grease_pencil.primitive_box', 'BOX', 'Grease Pencil Box Shape', 3],
  ['grease_pencil.primitive_circle', 'CIRCLE', 'Grease Pencil Circle Shape', 94],
];
const TOOL_OF: Record<PrimType, string> = { LINE: 'builtin.line', POLYLINE: 'builtin.polyline', ARC: 'builtin.arc', CURVE: 'builtin.curve', BOX: 'builtin.box', CIRCLE: 'builtin.circle' };

function startPrimitive(type: PrimType, idname: string, label: string, ev: { x: number; y: number; shift?: boolean; alt?: boolean }): 'RUNNING_MODAL' | 'CANCELLED' {
  const c = drawContext();
  const v = activeView3D();
  if (!c || !v || !checkLayer(c.layer) || !materialUsable(c)) return 'CANCELLED';
  const tool = TOOL_OF[type];
  const b = gpBrush(app.doc, tool);
  const pl = new Placement(v, c.ob, c.gp, c.layer);
  const r = v.el.getBoundingClientRect();
  const p0 = { x: ev.x - r.left, y: ev.y - r.top };
  const prim: Prim = { view: v, type, cp: type === 'POLYLINE' ? [p0, { ...p0 }] : controlsFromDrag(type, p0, p0, false, false), subdivision: b.subdivision ?? 6, radiusScale: 1, opacity: b.strength };
  current = prim;
  const mat = Math.min(c.ob.active_material_index, Math.max(0, c.gp.materials.length - 1));
  const color = brushColorFor(gpBrush(app.doc, 'builtin.brush.Draw'));
  const cyclic = type === 'BOX' || type === 'CIRCLE';
  const build = (): GPStroke => {
    const pts = primitivePoints(type, prim.cp, prim.subdivision).map((q) => ({ ...q, pressure: 1 }));
    const brush = { ...b, size: b.size * prim.radiusScale, strength: prim.opacity };
    return newStroke(samplesToPoints(pl, pts, brush, color), { material_index: mat, cyclic });
  };
  const update = () => {
    setStrokePreview(c.ob.id, fromStrokes([build()]), c.layer);
    v.drawSvg();
    app.changed('ui');
  };
  type Phase = 'drag' | 'place' | 'edit' | 'handle' | 'extrude' | 'grab' | 'rotate' | 'scale' | 'radius' | 'opacity';
  let phase: Phase = type === 'POLYLINE' ? 'place' : 'drag';
  const dragStart = { ...p0 };
  let handle = -1;
  let sub: { cp: P2[]; start: P2; center: P2; value: number } | null = null;
  const mouse = (e: { clientX: number; clientY: number }) => v.local(e);
  const nearHandle = (q: P2) => {
    let best = -1,
      bd = HANDLE_PX;
    prim.cp.forEach((p, i) => {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d <= bd) [best, bd] = [i, d];
    });
    return best;
  };
  const finish = (): 'FINISHED' | 'CANCELLED' => {
    setStrokePreview(null, null);
    const st = build();
    if (st.points.length < 2) return 'CANCELLED';
    const idx = editableDrawing(c.gp, c.layer!, app.doc.scene.frame_current, false);
    c.gp.drawings[idx] = fromStrokes([...toStrokes(c.gp.drawings[idx]), st]);
    b.subdivision = prim.subdivision;
    return 'FINISHED';
  };
  const beginSub = (k: Phase, q: P2) => {
    phase = k;
    sub = { cp: prim.cp.map((p) => ({ ...p })), start: q, center: centerOf(prim.cp), value: k === 'radius' ? prim.radiusScale : prim.opacity };
  };
  const applySub = (q: P2) => {
    if (!sub) return;
    const { cp, start, center } = sub;
    if (phase === 'grab') prim.cp = cp.map((p) => ({ x: p.x + q.x - start.x, y: p.y + q.y - start.y }));
    else if (phase === 'rotate') {
      const a = Math.atan2(q.y - center.y, q.x - center.x) - Math.atan2(start.y - center.y, start.x - center.x);
      const cs = Math.cos(a),
        sn = Math.sin(a);
      prim.cp = cp.map((p) => ({ x: center.x + (p.x - center.x) * cs - (p.y - center.y) * sn, y: center.y + (p.x - center.x) * sn + (p.y - center.y) * cs }));
    } else if (phase === 'scale') {
      const f = Math.hypot(q.x - center.x, q.y - center.y) / Math.max(1, Math.hypot(start.x - center.x, start.y - center.y));
      prim.cp = cp.map((p) => ({ x: center.x + (p.x - center.x) * f, y: center.y + (p.y - center.y) * f }));
    } else if (phase === 'radius') prim.radiusScale = Math.max(0.05, sub.value * (1 + (q.x - start.x) / 100));
    else if (phase === 'opacity') prim.opacity = Math.max(0, Math.min(1, sub.value + (q.x - start.x) / 200));
  };
  let shift = !!ev.shift,
    alt = !!ev.alt;
  const handler: ModalHandler = {
    label,
    cursor: 'crosshair',
    onPointerMove: (e) => {
      shift = e.shiftKey;
      alt = e.altKey;
      const q = mouse(e);
      if (phase === 'drag') prim.cp = controlsFromDrag(type, dragStart, q, shift, alt);
      else if (phase === 'place') prim.cp[prim.cp.length - 1] = q;
      else if (phase === 'handle') {
        const d = { x: q.x - prim.cp[handle].x, y: q.y - prim.cp[handle].y };
        prim.cp[handle] = q;
        // curve end points carry their handles along
        if (type === 'CURVE' && handle % 3 === 0) for (const k of [handle - 1, handle + 1]) if (prim.cp[k]) prim.cp[k] = { x: prim.cp[k].x + d.x, y: prim.cp[k].y + d.y };
      } else if (phase === 'extrude') {
        const stride = SEG_STRIDE[type];
        const a = prim.cp[prim.cp.length - 1 - stride];
        prim.cp.splice(prim.cp.length - stride, stride, ...segmentControls(type, a, q));
      } else if (phase === 'edit') {
        const hh = nearHandle(q);
        if (hh !== hoverHandle) {
          hoverHandle = hh;
          v.drawSvg();
        }
        return;
      } else applySub(q);
      update();
    },
    onPointerUp: (e) => {
      if (e.button !== 0) return;
      if (phase === 'drag') {
        const bb = prim.cp[prim.cp.length - 1];
        if (Math.hypot(bb.x - dragStart.x, bb.y - dragStart.y) < 3) return 'CANCELLED';
        phase = 'edit';
        update();
      } else if (phase === 'handle') phase = 'edit';
    },
    onPointerDown: (e) => {
      const q = mouse(e);
      if (e.button === 1) return finish();
      if (phase === 'place') {
        if (e.button === 2) {
          prim.cp.pop();
          return prim.cp.length >= 2 ? finish() : 'CANCELLED';
        }
        const prev = prim.cp[prim.cp.length - 2];
        // clicking the previous point again (double click) finishes
        if (prev && Math.hypot(q.x - prev.x, q.y - prev.y) < 4) {
          prim.cp.pop();
          return finish();
        }
        prim.cp[prim.cp.length - 1] = q;
        prim.cp.push({ ...q });
        update();
        return;
      }
      if (e.button === 2) {
        if (sub && phase !== 'edit') {
          // cancel the sub-transform only
          prim.cp = sub.cp;
          if (phase === 'radius') prim.radiusScale = sub.value;
          if (phase === 'opacity') prim.opacity = sub.value;
          sub = null;
          phase = 'edit';
          update();
          return;
        }
        return 'CANCELLED';
      }
      if (phase === 'extrude' || (sub && phase !== 'edit')) {
        sub = null;
        phase = 'edit';
        update();
        return;
      }
      if (phase === 'edit') {
        const hh = nearHandle(q);
        if (hh >= 0) {
          handle = hh;
          phase = 'handle';
          return;
        }
        // clicking elsewhere confirms and starts the next shape there
        const r2 = finish();
        if (r2 === 'FINISHED') queueMicrotask(() => app.run(idname, {}, { event: { x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey } }));
        return r2;
      }
    },
    onWheel: (e) => {
      if (phase === 'drag' || phase === 'place') return;
      prim.subdivision = Math.max(0, prim.subdivision + (e.deltaY < 0 ? 1 : -1));
      update();
    },
    onKey: (e) => {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      if (e.key === 'Escape' || k === 'q') return 'CANCELLED';
      if (e.key === 'Enter' || e.key === ' ') {
        if (type === 'POLYLINE' && phase === 'place') prim.cp.pop();
        return finish();
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        prim.subdivision = Math.max(0, prim.subdivision + (e.key === 'ArrowUp' ? 1 : -1));
        update();
        return true;
      }
      if (phase !== 'edit' || e.ctrlKey || e.metaKey) return true;
      const q = { x: app.pointer.x - v.el.getBoundingClientRect().left, y: app.pointer.y - v.el.getBoundingClientRect().top };
      if (k === 'e' && type !== 'BOX' && type !== 'CIRCLE' && type !== 'POLYLINE') {
        const last = prim.cp[prim.cp.length - 1];
        prim.cp.push(...segmentControls(type, last, q));
        phase = 'extrude';
        update();
      } else if (k === 'g') beginSub('grab', q);
      else if (k === 'r') beginSub('rotate', q);
      else if (k === 's') beginSub('scale', q);
      else if (k === 'f') beginSub(e.shiftKey ? 'opacity' : 'radius', q);
      return true;
    },
    cancel: () => {
      setStrokePreview(null, null);
      current = null;
      v.drawSvg();
    },
    finish: () => {
      current = null;
      v.drawSvg();
    },
    header: () => {
      if (phase === 'place') return 'Polyline: click to add points; Enter, double click or right click to confirm; Esc to cancel';
      if (phase === 'drag') return `${label}: drag to size (Shift: ${type === 'LINE' ? 'snap angle' : 'square'}, Alt: from center)`;
      if (phase === 'radius') return `Thickness: ${prim.radiusScale.toFixed(2)}×`;
      if (phase === 'opacity') return `Opacity: ${prim.opacity.toFixed(2)}`;
      return `Drag handles to adjust · E: extrude · G / R / S: move / rotate / scale · F / Shift F: thickness / opacity · ↑↓: subdivisions (${prim.subdivision}) · Enter: confirm · Esc: cancel`;
    },
  };
  update();
  app.startModal(handler);
  return 'RUNNING_MODAL';
}

registerOperators(
  OPS.map(([idname, type, label, sub]) => ({
    idname,
    label,
    description: `Create a ${type.toLowerCase()} stroke interactively`,
    props: [{ id: 'subdivision', label: 'Subdivisions', type: 'int' as const, default: sub, min: 0, max: 1024, hidden: true }],
    poll: () => app.doc.mode === 'PAINT_GREASE_PENCIL' && !!drawContext(),
    invoke: (ctx) => startPrimitive(type, idname, label, ctx.event ?? app.pointer),
  })),
);

// handles of the shape being edited
editModeHooks.svg.push((v) => {
  const p = current;
  if (!p || p.view !== v || p.type === 'POLYLINE') return null;
  const stride = SEG_STRIDE[p.type];
  const lines: P2[][] = [];
  if (p.type === 'CURVE')
    for (let i = 0; i + 3 < p.cp.length; i += 3) lines.push([p.cp[i], p.cp[i + 1]], [p.cp[i + 2], p.cp[i + 3]]);
  if (p.type === 'ARC') for (let i = 0; i + 2 < p.cp.length; i += 2) lines.push([p.cp[i], p.cp[i + 1]], [p.cp[i + 1], p.cp[i + 2]]);
  return h(
    'g',
    { key: 'gp-prim-handles', 'pointer-events': 'none' },
    ...lines.map(([a, b], i) => h('line', { key: `l${i}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: 'rgba(255,255,255,0.6)', 'stroke-width': 1, 'stroke-dasharray': '3 3' })),
    ...p.cp.map((q, i) => {
      const isPoint = i % stride === 0 || p.type === 'BOX' || p.type === 'CIRCLE';
      return h('circle', {
        key: `h${i}`,
        cx: q.x,
        cy: q.y,
        r: hoverHandle === i ? 6 : 4.5,
        fill: isPoint ? (hoverHandle === i ? '#ffb340' : '#ff8c00') : 'rgba(40,40,40,0.9)',
        stroke: isPoint ? '#000' : '#ff8c00',
        'stroke-width': 1.5,
      });
    }),
  );
});
