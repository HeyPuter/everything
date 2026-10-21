// Pen tool (Edit Mode): build and shape Bézier strokes by clicking and dragging.
//   click empty space    add a point after the selected end point (or start a new stroke);
//                        dragging while adding pulls out symmetric handles
//   click a point        select it, drag to move it with its handles
//   click a handle       drag to move it (an aligned partner turns along)
//   click a segment      drag to bend that segment
//   Ctrl click           insert a point on a segment / delete a point
//   double click point   cycle its handle type (auto → vector → align → free)
// Clicking the other end of the stroke being extended closes it.
import { Vector3, type Matrix4 } from 'three';
import { app, registerOperators, type OpContext } from '../app/app';
import { activeTools } from '../app/prefs';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { toolSettingsRenderers, toolsByMode, type ToolDef } from '../editors/view3d/toolbar';
import { h } from '../ui/h';
import { numberField, enumMenu } from '../ui/widgets';
import { registerIcons } from '../ui/icons';
import { activeLayer, fromStrokes, gpOf, gpTS, newStroke, toStrokes, normalizeDrawing, type GPPoint, type GPStroke } from './data';
import { inGPEdit, editTargets, drawing, setDrawing, type EditTarget } from './edit';
import { editableDrawing } from './paint';
import { Placement } from './placement';
import { evaluatedDrawing, evaluatedControlIndex, strokeCurveType, withDerived, hasBezier, GP_BEZIER, H_ALIGN, H_AUTO, H_FREE, H_VECTOR } from './curves';
import type { GPDrawing } from './types';

registerIcons({
  gp_pen: '<path class="s" d="M2 14c1.5-4 4.5-6.5 9-7.5" fill="none" stroke-width="1.2" stroke-linecap="round" opacity=".6"/><path class="f" d="M9.2 3.4 12.6 6.8 10.4 9 7 5.6z"/><path class="f" d="M12 2.2 13.8 4 13 4.8 11.2 3z"/><circle class="s" cx="5.2" cy="10.8" r="1.4" fill="none" stroke-width="1.1"/>',
  gp_texture_gradient: '<path class="f" d="M2.5 2.5h11v11h-11z" opacity=".2"/><path class="f" d="M2.5 2.5h5.5v11H2.5z" opacity=".45"/><path class="s" d="M2.5 2.5h11v11h-11z" fill="none" stroke-width="1.1"/><path class="s" d="M4 12 12 4" stroke-width="1.3" stroke-linecap="round"/><circle class="f" cx="4" cy="12" r="1.4"/><circle class="f" cx="12" cy="4" r="1.4"/>',
});

type V3 = [number, number, number];

/** Pen tool settings (kept on the scene's tool settings). */
export function penSettings(): { radius: number; extrude_handle: 'AUTO' | 'VECTOR' } {
  const ts = gpTS(app.doc) as unknown as { gpencil_pen?: { radius: number; extrude_handle: 'AUTO' | 'VECTOR' } };
  return (ts.gpencil_pen ??= { radius: 0.01, extrude_handle: 'VECTOR' });
}

// ---------------------------------------------------------------------------
// hit testing (viewport pixels)

export type PenHit =
  | { kind: 'point'; t: EditTarget; i: number; d: number }
  | { kind: 'handle'; t: EditTarget; i: number; side: 'L' | 'R'; d: number }
  | { kind: 'segment'; t: EditTarget; s: number; k: number; u: number; d: number };

const tmp = new Vector3();
const scr = (v: View3D, a: ArrayLike<number>, i: number, m: Matrix4) => v.project(tmp.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]).applyMatrix4(m));

function shownHandles(v: View3D, d: GPDrawing, i: number) {
  const mode = v.overlay.display_handle ?? 'SELECTED';
  if (mode === 'ALL') return true;
  if (mode === 'NONE') return false;
  return !!(d.select![i] || d.select_handle_left?.[i] || d.select_handle_right?.[i]);
}

export function penHit(v: View3D, x: number, y: number, radius = 10): PenHit | null {
  let best: PenHit | null = null;
  const better = (hd: PenHit) => {
    if (!best || hd.d < best.d) best = hd;
  };
  for (const t of editTargets()) {
    const d = drawing(t);
    const n = d.position.length / 3;
    for (let i = 0; i < n; i++) {
      const p = scr(v, d.position, i, t.world);
      const dd = Math.hypot(p.x - x, p.y - y);
      if (p.z <= 1 && dd < radius) better({ kind: 'point', t, i, d: dd });
    }
    if (hasBezier(d))
      for (let s = 0; s + 1 < d.offsets.length; s++) {
        if (strokeCurveType(d, s) !== GP_BEZIER) continue;
        for (let i = d.offsets[s]; i < d.offsets[s + 1]; i++) {
          if (!shownHandles(v, d, i)) continue;
          for (const side of ['L', 'R'] as const) {
            const p = scr(v, side === 'L' ? d.handle_left! : d.handle_right!, i, t.world);
            // a handle lying on its point gives way to the point
            const dd = Math.hypot(p.x - x, p.y - y) + 0.5;
            if (p.z <= 1 && dd < radius) better({ kind: 'handle', t, i, side, d: dd });
          }
        }
      }
  }
  if (best) return best;
  // segments: nearest evaluated segment, mapped back to its control segment
  const segR = radius * 0.8;
  for (const t of editTargets()) {
    const d = drawing(t);
    const ev = evaluatedDrawing(d);
    const ci = evaluatedControlIndex(d);
    for (let s = 0; s + 1 < d.offsets.length; s++) {
      const a = ev.offsets[s],
        b = ev.offsets[s + 1];
      const cyc = !!d.cyclic[s] && b - a > 2;
      const ca = d.offsets[s],
        cb = d.offsets[s + 1];
      const nseg = cyc ? b - a : b - a - 1;
      for (let q = 0; q < nseg; q++) {
        const j0 = a + q,
          j1 = q + 1 < b - a ? j0 + 1 : a;
        const p0 = scr(v, ev.position, j0, t.world),
          p1 = scr(v, ev.position, j1, t.world);
        if (p0.z > 1 || p1.z > 1) continue;
        const dx = p1.x - p0.x,
          dy = p1.y - p0.y;
        const l2 = dx * dx + dy * dy;
        const f = l2 ? Math.max(0, Math.min(1, ((x - p0.x) * dx + (y - p0.y) * dy) / l2)) : 0;
        const dd = Math.hypot(p0.x + dx * f - x, p0.y + dy * f - y);
        if (dd >= segR || (best && dd >= (best as PenHit).d)) continue;
        // control segment k holding evaluated point j0
        let k = ca;
        if (ci) {
          for (let c = ca; c < cb; c++) if (ci[c] >= 0 && ci[c] <= j0) k = c;
        } else k = j0 - a + ca;
        const e0 = ci ? ci[k] : j0;
        const e1 = ci ? (k + 1 < cb ? ci[k + 1] : b) : e0 + 1;
        const span = Math.max(1, e1 - e0);
        best = { kind: 'segment', t, s, k: k - ca, u: Math.max(0.001, Math.min(0.999, (j0 - e0 + f) / span)), d: dd };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// stroke edits (pure on stroke lists)

const lerp3 = (a: number[], b: number[], t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function lerpPoint(p: GPPoint, q: GPPoint, t: number, co: V3): GPPoint {
  return {
    co,
    radius: p.radius + (q.radius - p.radius) * t,
    opacity: p.opacity + (q.opacity - p.opacity) * t,
    vertex_color: [0, 1, 2, 3].map((k) => p.vertex_color[k] + (q.vertex_color[k] - p.vertex_color[k]) * t) as [number, number, number, number],
  };
}

/** Insert a control point on segment k (point k → k+1) of a stroke at parameter u, keeping the shape. */
export function insertOnSegment(s: GPStroke, k: number, u: number): { stroke: GPStroke; index: number } {
  const n = s.points.length;
  const a = s.points[k],
    b = s.points[(k + 1) % n];
  const pts = s.points.map((p) => ({ ...p }));
  let np: GPPoint;
  if (s.curve_type === GP_BEZIER && a.handle_right && b.handle_left) {
    // de Casteljau split of the cubic a, a.R, b.L, b
    const p01 = lerp3(a.co, a.handle_right, u),
      p12 = lerp3(a.handle_right, b.handle_left, u),
      p23 = lerp3(b.handle_left, b.co, u);
    const p012 = lerp3(p01, p12, u),
      p123 = lerp3(p12, p23, u);
    const m = lerp3(p012, p123, u);
    np = { ...lerpPoint(a, b, u, m), handle_left: p012, handle_right: p123, handle_type_left: H_ALIGN, handle_type_right: H_ALIGN };
    const A = pts[k],
      B = pts[(k + 1) % n];
    A.handle_right = p01;
    B.handle_left = p23;
    // derived handles would change the shape: keep them where they are
    const keep = (t: number | undefined) => (t === H_AUTO ? H_ALIGN : t === H_VECTOR ? H_FREE : t);
    A.handle_type_right = keep(A.handle_type_right);
    A.handle_type_left = A.handle_type_left === H_AUTO ? H_ALIGN : A.handle_type_left;
    B.handle_type_left = keep(B.handle_type_left);
    B.handle_type_right = B.handle_type_right === H_AUTO ? H_ALIGN : B.handle_type_right;
  } else np = lerpPoint(a, b, u, lerp3(a.co, b.co, u));
  np.select = true;
  pts.splice(k + 1, 0, np);
  return { stroke: { ...s, points: pts }, index: k + 1 };
}

const CYCLE = [H_AUTO, H_VECTOR, H_ALIGN, H_FREE];
export function cycleHandleType(p: GPPoint): GPPoint {
  const cur = p.handle_type_left ?? H_AUTO;
  const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
  return { ...p, handle_type_left: next, handle_type_right: next };
}

// ---------------------------------------------------------------------------
// operator

const PEN_PROPS = ['extend', 'deselect', 'toggle', 'deselect_all', 'select_passthrough', 'extrude_point', 'delete_point', 'insert_point', 'move_segment', 'select_point', 'move_point', 'cycle_handle_type'];

function locate(t: EditTarget, i: number): { strokes: GPStroke[]; s: number; k: number } {
  const d = drawing(t);
  const strokes = toStrokes(d);
  let s = 0;
  while (s + 1 < d.offsets.length && d.offsets[s + 1] <= i) s++;
  return { strokes, s, k: i - d.offsets[s] };
}

function deselectAll() {
  for (const t of editTargets()) {
    const d = drawing(t);
    const n = d.position.length / 3;
    setDrawing(t, { ...d, select: new Uint8Array(n), ...(d.select_handle_left ? { select_handle_left: new Uint8Array(n), select_handle_right: new Uint8Array(n) } : {}) });
  }
}

/** Drag `fn(deltaLocal)` for a target until release; Esc / right click restores. */
function dragModal(v: View3D, t: EditTarget, anchorWorld: Vector3, label: string, start: { x: number; y: number }, base: GPDrawing, fn: (delta: V3, world: Vector3) => GPDrawing, onCancel: () => void, clickOnly?: () => void) {
  const r = v.el.getBoundingClientRect();
  const inv = t.world.clone().invert();
  const a = anchorWorld.clone().applyMatrix4(inv);
  let moved = false;
  app.startModal({
    label,
    onPointerMove(e) {
      if (!moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 3) return;
      moved = true;
      const w = v.unproject(e.clientX - r.left, e.clientY - r.top, anchorWorld);
      const l = w.clone().applyMatrix4(inv);
      setDrawing(t, fn([l.x - a.x, l.y - a.y, l.z - a.z], w));
      app.changed('doc');
    },
    onPointerUp() {
      if (!moved) clickOnly?.();
      return 'FINISHED';
    },
    onPointerDown(e) {
      if (e.button === 2) return 'CANCELLED';
    },
    onKey(e) {
      if (e.key === 'Escape') return 'CANCELLED';
    },
    cancel() {
      setDrawing(t, base);
      onCancel();
      app.changed('doc');
    },
    status: () => [
      ['LMB', 'Confirm'],
      ['RMB / Esc', 'Cancel'],
    ],
  });
}

const add3 = (a: ArrayLike<number>, i: number, dlt: V3, out: Float32Array) => {
  out[i * 3] = a[i * 3] + dlt[0];
  out[i * 3 + 1] = a[i * 3 + 1] + dlt[1];
  out[i * 3 + 2] = a[i * 3 + 2] + dlt[2];
};

function penInvoke(ctx: OpContext, p: Record<string, unknown>) {
  const v = activeView3D();
  const ob = app.activeObject;
  const gp = gpOf(app.doc, ob);
  if (!v || !ob || !gp) return 'CANCELLED' as const;
  const ev = ctx.event ?? app.pointer;
  const r = v.el.getBoundingClientRect();
  const x = ev.x - r.left,
    y = ev.y - r.top;
  const hit = penHit(v, x, y);
  const start = { x: ev.x, y: ev.y };

  // Ctrl: delete a point / insert one on a segment
  if (p.delete_point && hit?.kind === 'point') {
    const { strokes, s, k } = locate(hit.t, hit.i);
    strokes[s] = { ...strokes[s], points: strokes[s].points.filter((_, j) => j !== k) };
    setDrawing(hit.t, fromStrokes(strokes));
    return 'FINISHED' as const;
  }
  if (p.insert_point && hit?.kind === 'segment') {
    deselectAll();
    const cur = toStrokes(drawing(hit.t));
    cur[hit.s] = insertOnSegment(cur[hit.s], hit.k, hit.u).stroke;
    setDrawing(hit.t, fromStrokes(cur));
    return 'FINISHED' as const;
  }
  if (p.insert_point || p.delete_point) return 'CANCELLED' as const;

  // double click: cycle the handle type of a point
  if (p.cycle_handle_type) {
    if (hit?.kind !== 'point') return 'CANCELLED' as const;
    const { strokes, s, k } = locate(hit.t, hit.i);
    if (strokes[s].curve_type !== GP_BEZIER) return 'CANCELLED' as const;
    strokes[s].points[k] = cycleHandleType(strokes[s].points[k]);
    setDrawing(hit.t, fromStrokes(strokes));
    return 'FINISHED' as const;
  }

  // closing the stroke being extended: click its other end
  if (hit?.kind === 'point' && p.extrude_point) {
    const d = drawing(hit.t);
    const { strokes, s, k } = locate(hit.t, hit.i);
    const st = strokes[s];
    const n = st.points.length;
    const otherEnd = k === 0 ? n - 1 : k === n - 1 ? 0 : -1;
    if (n > 2 && otherEnd >= 0 && !st.cyclic && st.points[otherEnd].select && !st.points[k].select && st.points.filter((q) => q.select).length === 1 && d.select!.filter((q) => q).length === 1) {
      strokes[s] = { ...st, cyclic: true, points: st.points.map((q, j) => ({ ...q, select: j === k })) };
      setDrawing(hit.t, fromStrokes(strokes));
      return 'FINISHED' as const;
    }
  }

  if (hit?.kind === 'point' && (p.select_point || p.move_point)) {
    const d0 = drawing(hit.t);
    const already = !!d0.select![hit.i];
    if (p.select_point && !(p.select_passthrough && already)) {
      if (!p.extend && !p.toggle) deselectAll();
      const d = drawing(hit.t);
      const sel = d.select!.slice();
      sel[hit.i] = p.toggle && already ? 0 : 1;
      setDrawing(hit.t, { ...d, select: sel });
    }
    app.changed('select', 'doc');
    if (!p.move_point) return 'FINISHED' as const;
    const base = drawing(hit.t);
    const anchor = new Vector3(base.position[hit.i * 3], base.position[hit.i * 3 + 1], base.position[hit.i * 3 + 2]).applyMatrix4(hit.t.world);
    const i = hit.i;
    dragModal(v, hit.t, anchor, 'Pen', start, base, (dl) => {
      const pos = base.position.slice();
      add3(base.position, i, dl, pos);
      const out: GPDrawing = { ...base, position: pos };
      if (base.handle_left) {
        out.handle_left = base.handle_left.slice();
        out.handle_right = base.handle_right!.slice();
        add3(base.handle_left, i, dl, out.handle_left);
        add3(base.handle_right!, i, dl, out.handle_right);
      }
      return withDerived(out);
    }, () => {});
    return 'RUNNING_MODAL' as const;
  }

  if (hit?.kind === 'handle' && p.move_point) {
    const base0 = drawing(hit.t);
    if (!p.extend) deselectAll();
    const base = drawing(hit.t);
    const L = base.select_handle_left!.slice(),
      R = base.select_handle_right!.slice();
    (hit.side === 'L' ? L : R)[hit.i] = 1;
    const based: GPDrawing = { ...base, select_handle_left: L, select_handle_right: R };
    setDrawing(hit.t, based);
    app.changed('select', 'doc');
    const i = hit.i,
      side = hit.side;
    const own = side === 'L' ? based.handle_left! : based.handle_right!;
    const anchor = new Vector3(own[i * 3], own[i * 3 + 1], own[i * 3 + 2]).applyMatrix4(hit.t.world);
    dragModal(v, hit.t, anchor, 'Pen', start, base0, (dl) => moveHandle(based, i, side, dl), () => {});
    return 'RUNNING_MODAL' as const;
  }

  if (hit?.kind === 'segment' && p.move_segment) {
    const strokes0 = toStrokes(drawing(hit.t));
    const st = strokes0[hit.s];
    if (st.curve_type !== GP_BEZIER) return extrude(v, ob, gp, p, start, x, y);
    const base = drawing(hit.t);
    const a = base.offsets[hit.s] + hit.k;
    const n = base.offsets[hit.s + 1] - base.offsets[hit.s];
    const b = base.offsets[hit.s] + ((hit.k + 1) % n);
    const u = hit.u;
    // the curve point at u moves by 3u(1-u)·Δ when both inner handles move by Δ
    const gain = 1 / Math.max(0.2, 3 * u * (1 - u));
    const anchor = v.unproject(x, y, new Vector3(base.position[a * 3], base.position[a * 3 + 1], base.position[a * 3 + 2]).applyMatrix4(hit.t.world));
    dragModal(v, hit.t, anchor, 'Pen', start, base, (dl) => {
      const D: V3 = [dl[0] * gain, dl[1] * gain, dl[2] * gain];
      let out = moveHandle(base, a, 'R', D, true);
      out = moveHandle(out, b, 'L', D, true);
      return out;
    }, () => {});
    return 'RUNNING_MODAL' as const;
  }

  if (!p.extrude_point) {
    if (p.deselect_all && !p.extend) {
      deselectAll();
      app.changed('select', 'doc');
      return 'FINISHED' as const;
    }
    return 'CANCELLED' as const;
  }
  return extrude(v, ob, gp, p, start, x, y);
}

/** Move one handle by a local delta: derived types become editable, an aligned partner turns along. */
function moveHandle(base: GPDrawing, i: number, side: 'L' | 'R', dl: V3, keepAlignTypes = false): GPDrawing {
  const out: GPDrawing = { ...base, handle_left: base.handle_left!.slice(), handle_right: base.handle_right!.slice(), handle_type_left: base.handle_type_left!.slice(), handle_type_right: base.handle_type_right!.slice() };
  const own = side === 'L' ? out.handle_left! : out.handle_right!,
    other = side === 'L' ? out.handle_right! : out.handle_left!;
  const tOwn = side === 'L' ? out.handle_type_left! : out.handle_type_right!,
    tOther = side === 'L' ? out.handle_type_right! : out.handle_type_left!;
  add3(side === 'L' ? base.handle_left! : base.handle_right!, i, dl, own);
  if (tOwn[i] === H_AUTO) {
    tOwn[i] = H_ALIGN;
    if (tOther[i] === H_AUTO) tOther[i] = H_ALIGN;
  } else if (tOwn[i] === H_VECTOR) tOwn[i] = keepAlignTypes ? H_ALIGN : H_FREE;
  if (tOwn[i] === H_ALIGN && tOther[i] === H_VECTOR) tOther[i] = H_ALIGN;
  if (tOwn[i] === H_ALIGN && tOther[i] === H_ALIGN) {
    const P = [out.position[i * 3], out.position[i * 3 + 1], out.position[i * 3 + 2]];
    const dir = [P[0] - own[i * 3], P[1] - own[i * 3 + 1], P[2] - own[i * 3 + 2]];
    const l = Math.hypot(dir[0], dir[1], dir[2]);
    const ol = Math.hypot(other[i * 3] - P[0], other[i * 3 + 1] - P[1], other[i * 3 + 2] - P[2]);
    if (l > 1e-9) for (let c = 0; c < 3; c++) other[i * 3 + c] = P[c] + (dir[c] / l) * ol;
  }
  return withDerived(out);
}

/** Add a point after the selected end point (or start a new stroke) and pull its handles while dragging. */
function extrude(v: View3D, ob: NonNullable<typeof app.activeObject>, gp: NonNullable<ReturnType<typeof gpOf>>, p: Record<string, unknown>, start: { x: number; y: number }, x: number, y: number) {
  const layer = activeLayer(gp);
  if (!layer) {
    app.report('ERROR', 'No active layer');
    return 'CANCELLED' as const;
  }
  if (layer.lock || layer.hide) {
    app.report('WARNING', `Layer "${layer.name}" is ${layer.lock ? 'locked' : 'hidden'}`);
    return 'CANCELLED' as const;
  }
  const framesBefore = layer.frames.slice(),
    drawingsBefore = gp.drawings.slice();
  const idx = editableDrawing(gp, layer, app.doc.scene.frame_current, true);
  const base = normalizeDrawing(gp.drawings[idx]);
  const strokes = toStrokes(base);
  // the selected end point of a Bézier stroke in this drawing
  let target = -1,
    atStart = false;
  const selCount = base.select!.reduce((a, b) => a + b, 0);
  if (selCount === 1)
    strokes.forEach((s, si) => {
      if (s.curve_type !== GP_BEZIER || s.cyclic) return;
      const n = s.points.length;
      if (s.points[n - 1].select) target = si;
      else if (s.points[0].select) ((target = si), (atStart = true));
    });
  const pl = new Placement(v, ob, gp, layer);
  const w0 = pl.project(x, y);
  if (!w0) return 'CANCELLED' as const;
  const co = pl.toLocal(w0);
  const set = penSettings();
  const endType = set.extrude_handle === 'AUTO' ? H_AUTO : H_VECTOR;
  const deselected: GPStroke[] = strokes.map((s) => ({ ...s, points: s.points.map((q): GPPoint => ({ ...q, select: false, select_left: false, select_right: false })) }));
  let si = target,
    pi: number;
  const src = target >= 0 ? strokes[target].points[atStart ? 0 : strokes[target].points.length - 1] : null;
  const np: GPPoint = { co, radius: src?.radius ?? set.radius / pl.scale(), opacity: src?.opacity ?? 1, vertex_color: src ? [...src.vertex_color] : [0, 0, 0, 0], select: true, handle_left: [...co], handle_right: [...co], handle_type_left: endType, handle_type_right: endType };
  if (target >= 0) {
    const s = deselected[target];
    s.points = atStart ? [np, ...s.points] : [...s.points, np];
    pi = atStart ? 0 : s.points.length - 1;
  } else {
    const mat = Math.max(0, Math.min((gp.materials.length || 1) - 1, ob.active_material_index ?? 0));
    deselected.push(newStroke([np], { material_index: mat, curve_type: GP_BEZIER, resolution: 12 }));
    si = deselected.length - 1;
    pi = 0;
  }
  const d1 = fromStrokes(deselected);
  gp.drawings[idx] = d1;
  // the drag works on the new drawing as an edit target of the active layer
  const t: EditTarget = { layer, layerIndex: gp.layers.indexOf(layer), idx, world: pl.world };
  const gi = d1.offsets[si] + pi;
  const anchor = w0.clone();
  app.changed('select', 'doc');
  dragModal(
    v,
    t,
    anchor,
    'Pen',
    start,
    d1,
    (dl) => {
      // symmetric aligned handles: the outgoing one follows the pointer
      const out: GPDrawing = { ...d1, handle_left: d1.handle_left!.slice(), handle_right: d1.handle_right!.slice(), handle_type_left: d1.handle_type_left!.slice(), handle_type_right: d1.handle_type_right!.slice() };
      const fwd = atStart ? out.handle_left! : out.handle_right!,
        back = atStart ? out.handle_right! : out.handle_left!;
      for (let c = 0; c < 3; c++) {
        fwd[gi * 3 + c] = co[c] + dl[c];
        back[gi * 3 + c] = co[c] - dl[c];
      }
      out.handle_type_left![gi] = out.handle_type_right![gi] = H_ALIGN;
      return withDerived(out);
    },
    () => {
      layer.frames = framesBefore;
      gp.drawings = drawingsBefore;
    },
  );
  return 'RUNNING_MODAL' as const;
}

registerOperators([
  {
    idname: 'grease_pencil.pen',
    label: 'Grease Pencil Pen',
    description: 'Build Bézier strokes: click to add points, drag to shape them; Ctrl click inserts or deletes points',
    props: [
      ...PEN_PROPS.map((id) => ({ id, label: id.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), type: 'bool' as const, default: false, hidden: true })),
      { id: 'extrude_handle', label: 'Extrude Handle Type', type: 'enum', default: 'VECTOR', items: [['AUTO', 'Auto'], ['VECTOR', 'Vector']], hidden: true },
      { id: 'size', label: 'Size', type: 'float', default: 0.01, min: 0, hidden: true },
    ],
    poll: () => inGPEdit(),
    invoke: (ctx, p) => penInvoke(ctx, p),
    exec: () => 'CANCELLED',
  },
]);

// ---------------------------------------------------------------------------
// tool

const PEN_TOOL: ToolDef = { id: 'builtin.pen', label: 'Pen', icon: 'gp_pen', description: 'Draw Bézier strokes point by point: click to add, drag to pull handles, Ctrl click to insert or delete points' };
{
  // after the transform tools, before Radius / Bend
  const list = toolsByMode.EDIT_GREASEPENCIL;
  const at = list.findIndex((t) => t?.id === 'builtin.radius' || t?.id === 'builtin.extrude');
  if (at > 0) list.splice(at, 0, PEN_TOOL, null);
  else list.push(null, PEN_TOOL);
}

let lastClick = { time: 0, x: 0, y: 0 };
editModeHooks.pointer.unshift((_v, e) => {
  if (e.button !== 0 || !inGPEdit() || activeTools.EDIT !== 'builtin.pen') return false;
  const now = performance.now();
  const dbl = now - lastClick.time < 350 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 6;
  lastClick = { time: dbl ? 0 : now, x: e.clientX, y: e.clientY };
  const ctrl = e.ctrlKey || e.metaKey;
  const props = dbl ? { cycle_handle_type: true } : ctrl ? { insert_point: true, delete_point: true } : { extrude_point: true, move_segment: true, select_point: true, move_point: true, extend: e.shiftKey, toggle: false, extrude_handle: penSettings().extrude_handle, size: penSettings().radius };
  app.run('grease_pencil.pen', props, { event: { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl, alt: e.altKey } });
  return true;
});

toolSettingsRenderers['builtin.pen'] = () => {
  const s = penSettings();
  return [
    h('div', { style: { width: '130px', flex: 'none' } }, numberField({ id: 'gp-pen-r', label: 'Radius', value: s.radius, min: 0.0001, max: 10, step: 0.001, precision: 3, set: (x) => ((s.radius = x), app.changed('ui')) })),
    h(
      'div',
      { style: { width: '110px', flex: 'none' } },
      enumMenu(
        'gp-pen-ht',
        [
          { value: 'VECTOR', label: 'Vector' },
          { value: 'AUTO', label: 'Auto' },
        ],
        s.extrude_handle,
        (x) => ((s.extrude_handle = x as 'AUTO' | 'VECTOR'), app.changed('ui')),
        { tip: 'Handle type of points added with a click' },
      ),
    ),
    h('span', { class: 'th-label' }, 'Click: add · Drag: handles · Ctrl click: insert / delete · Double click: handle type'),
  ];
};
