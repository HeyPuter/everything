// Curve Edit Mode: control point / handle selection and transforms, handle types, extrude,
// add vertex, delete, subdivide, cyclic toggle, make segment, duplicate, separate, spline type.
// More operators live in ops-more.ts, menus and keys in menus.ts, toolbar tools in tools.ts.
import { Matrix3, Matrix4, Vector3, Box3, Euler } from 'three';
import { app, registerOperators } from '../../app/app';
import { editModeHooks } from '../../editors/view3d/hooks';
import { activeView3D, type View3D } from '../../editors/view3d/view3d';
import { h, type VNode } from '../../ui/h';
import type { BezierPoint, CurveData, HandleType, ObjectData, Spline, SplinePoint, Vec3 } from '../../data/types';
import { transformProviders, startTransform, type TElement } from '../../ops/transform';
import { curveTransformExtras } from '../../editors/view3d/transformui';
import { setGizmoCenterHook, gizmoCenterHook } from '../../editors/view3d/gizmo';
import { frameHooks } from '../../ops/view3d';
import { newCurve, newObject } from '../../data/defaults';
import { uniqueName, curveEditHooks } from '../../ops/object';
import { inSelectRegion } from '../../editors/view3d/selectshapes';
import type { SelectRegion } from '../../editors/view3d/hooks';
import * as K from './curveops';
import { sampleSpline, frames } from '../../eval/curve';
import { activeElementHooks } from '../editxform';
import { proportionalWeights } from '../proportional';

type Part = 'co' | 'hl' | 'hr';
interface Item {
  s: number; // spline index
  i: number; // point index
  part: Part;
}

export function activeCurve(): { ob: ObjectData; cu: CurveData } | null {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'CURVE' || !ob.data) return null;
  const cu = app.doc.curves[ob.data];
  return cu ? { ob, cu } : null;
}
export const inCurveEdit = () => app.doc.mode === 'EDIT' && !!activeCurve();

const world = (ob: ObjectData) => app.graph.get(ob.id)?.world ?? new Matrix4();
const V3 = (a: ArrayLike<number>) => new Vector3(a[0], a[1], a[2]);

function partKey(p: Part): 'co' | 'handle_left' | 'handle_right' {
  return p === 'co' ? 'co' : p === 'hl' ? 'handle_left' : 'handle_right';
}

function itemPos(cu: CurveData, it: Item): Vector3 {
  const sp = cu.splines[it.s];
  if (sp.type === 'BEZIER') return V3(sp.bezier_points[it.i][partKey(it.part)]);
  return V3(sp.points[it.i].co);
}

function isSelected(cu: CurveData, it: Item): boolean {
  const sp = cu.splines[it.s];
  if (sp.type !== 'BEZIER') return !!sp.points[it.i].select;
  const b = sp.bezier_points[it.i];
  return it.part === 'co' ? !!b.select_control_point : it.part === 'hl' ? !!b.select_left_handle : !!b.select_right_handle;
}

function setSelected(cu: CurveData, it: Item, on: boolean) {
  const sp = cu.splines[it.s];
  if (sp.type !== 'BEZIER') {
    sp.points[it.i].select = on;
    return;
  }
  const b = sp.bezier_points[it.i];
  if (it.part === 'co') {
    // selecting a control point selects its handles too
    b.select_control_point = b.select_left_handle = b.select_right_handle = on;
  } else if (it.part === 'hl') b.select_left_handle = on;
  else b.select_right_handle = on;
}

type HandleDisplay = 'ALL' | 'SELECTED' | 'NONE';
/** Handle display of the viewport being drawn / picked in (overlay setting). */
let handleDisplay: HandleDisplay = 'SELECTED';
const useView = (v: View3D) => (handleDisplay = v.overlay.display_handle ?? 'SELECTED');

/** Whether handles are drawn (and pickable) for a point. */
function handlesShown(b: BezierPoint, mode: HandleDisplay = handleDisplay) {
  if (mode === 'ALL') return true;
  if (mode === 'NONE') return false;
  return !!(b.select_control_point || b.select_left_handle || b.select_right_handle);
}

function allItems(cu: CurveData, withHandles = true): Item[] {
  const out: Item[] = [];
  cu.splines.forEach((sp, s) => {
    if (sp.type === 'BEZIER')
      sp.bezier_points.forEach((b, i) => {
        if (b.hide) return;
        out.push({ s, i, part: 'co' });
        if (withHandles && handlesShown(b)) out.push({ s, i, part: 'hl' }, { s, i, part: 'hr' });
      });
    else sp.points.forEach((p, i) => !p.hide && out.push({ s, i, part: 'co' }));
  });
  return out;
}

function anySelected(cu: CurveData) {
  return allItems(cu, false).some((it) => isSelected(cu, it) || (cu.splines[it.s].type === 'BEZIER' && handlesShown(cu.splines[it.s].bezier_points[it.i], 'SELECTED')));
}

function pointSelected(sp: Spline, i: number) {
  return sp.type === 'BEZIER' ? !!sp.bezier_points[i].select_control_point : !!sp.points[i].select;
}

function deselectAll(cu: CurveData) {
  for (const sp of cu.splines) {
    for (const b of sp.bezier_points) b.select_control_point = b.select_left_handle = b.select_right_handle = false;
    for (const p of sp.points) p.select = false;
  }
}

// ---------------------------------------------------------------------------
// handle recalculation

/** Recompute AUTO / VECTOR handles of a Bézier spline from the control points. */
export function recalcHandles(sp: Spline) {
  if (sp.type !== 'BEZIER') return;
  const bp = sp.bezier_points,
    n = bp.length;
  for (let i = 0; i < n; i++) {
    const b = bp[i];
    const co = V3(b.co);
    const prev = i > 0 ? V3(bp[i - 1].co) : sp.use_cyclic_u && n > 1 ? V3(bp[n - 1].co) : null;
    const next = i < n - 1 ? V3(bp[i + 1].co) : sp.use_cyclic_u && n > 1 ? V3(bp[0].co) : null;
    if (b.handle_left_type === 'AUTO' || b.handle_right_type === 'AUTO') {
      let dir: Vector3;
      if (prev && next) dir = next.clone().sub(prev);
      else if (next) dir = next.clone().sub(co);
      else if (prev) dir = co.clone().sub(prev);
      else dir = new Vector3(1, 0, 0);
      dir.normalize();
      const dl = prev ? co.distanceTo(prev) : next ? co.distanceTo(next) : 1;
      const dr = next ? co.distanceTo(next) : dl;
      if (b.handle_left_type === 'AUTO') b.handle_left = co.clone().addScaledVector(dir, -dl * 0.39).toArray() as Vec3;
      if (b.handle_right_type === 'AUTO') b.handle_right = co.clone().addScaledVector(dir, dr * 0.39).toArray() as Vec3;
    }
    if (b.handle_left_type === 'VECTOR') b.handle_left = (prev ? co.clone().lerp(prev, 1 / 3) : co.clone()).toArray() as Vec3;
    if (b.handle_right_type === 'VECTOR') b.handle_right = (next ? co.clone().lerp(next, 1 / 3) : co.clone()).toArray() as Vec3;
  }
}

/** Keep ALIGNED handle pairs collinear, using `moved` as the authoritative side. */
function alignOpposite(b: BezierPoint, moved: 'hl' | 'hr') {
  if (b.handle_left_type !== 'ALIGNED' || b.handle_right_type !== 'ALIGNED') return;
  const co = V3(b.co);
  const src = V3(moved === 'hl' ? b.handle_left : b.handle_right).sub(co);
  if (src.lengthSq() < 1e-12) return;
  const otherKey = moved === 'hl' ? 'handle_right' : 'handle_left';
  const len = V3(b[otherKey]).distanceTo(co);
  b[otherKey] = co.clone().addScaledVector(src.normalize(), -len).toArray() as Vec3;
}

// ---------------------------------------------------------------------------
// picking & selection

function pick(v: View3D, x: number, y: number): Item | null {
  const a = activeCurve();
  if (!a) return null;
  useView(v);
  const w = world(a.ob);
  let best: Item | null = null,
    bd = 12;
  for (const it of allItems(a.cu)) {
    const p = v.project(itemPos(a.cu, it).applyMatrix4(w));
    const d = Math.hypot(p.x - x, p.y - y) + (it.part === 'co' ? 0 : 1);
    if (d < bd) {
      bd = d;
      best = it;
    }
  }
  return best;
}

/** Active (last clicked) point, used by Checker Deselect, shortest path and the pen tool. */
export const curveState: { active: Item | null } = { active: null };
export const activePoint = (): K.PointRef | null => {
  const a = curveState.active,
    c = activeCurve();
  if (!a || !c) return null;
  const sp = c.cu.splines[a.s];
  return sp && a.i < K.pointCount(sp) ? { s: a.s, i: a.i } : null;
};
export function setActivePoint(p: K.PointRef | null) {
  curveState.active = p ? { ...p, part: 'co' } : null;
}

activeElementHooks.push(() => {
  const a = inCurveEdit() ? activeCurve() : null;
  const p = activePoint();
  if (!a || !p) return null;
  return K.pointCo(a.cu.splines[p.s], p.i).applyMatrix4(world(a.ob));
});

/** Point under the mouse (control points only), or null. */
export function pickPoint(v: View3D, x: number, y: number, radius = 12): K.PointRef | null {
  const a = activeCurve();
  if (!a) return null;
  const w = world(a.ob);
  let best: K.PointRef | null = null,
    bd = radius;
  for (const it of allItems(a.cu, false)) {
    const p = v.project(itemPos(a.cu, it).applyMatrix4(w));
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) {
      bd = d;
      best = { s: it.s, i: it.i };
    }
  }
  return best;
}

editModeHooks.pick.push((v, x, y, o) => {
  if (!inCurveEdit()) return false;
  const { cu } = activeCurve()!;
  const hit = pick(v, x, y);
  // Ctrl+click: select the shortest path from the active point along its spline
  const ev = window.event as PointerEvent | undefined;
  const act = activePoint();
  if (ev?.ctrlKey && !ev.shiftKey && hit && act && act.s === hit.s && hit.part === 'co') {
    K.selectPath(cu, act, hit);
    curveState.active = hit;
    app.pushUndo('Pick Shortest Path');
    app.changed('select', 'doc');
    return true;
  }
  if (!o.extend) deselectAll(cu);
  if (hit) {
    const on = !(o.toggle && isSelected(cu, hit));
    setSelected(cu, hit, on);
    curveState.active = on ? hit : null;
  } else curveState.active = null;
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
});

function regionSelect(v: View3D, r: SelectRegion, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR', label: string) {
  const { ob, cu } = activeCurve()!;
  const w = world(ob);
  for (const it of allItems(cu, false)) {
    const p = v.project(itemPos(cu, it).applyMatrix4(w));
    const hit = p.z <= 1 && inSelectRegion(r, p.x, p.y);
    const cur = isSelected(cu, it);
    const next = mode === 'SET' ? hit : mode === 'ADD' ? cur || hit : mode === 'SUB' ? cur && !hit : mode === 'AND' ? cur && hit : cur !== hit;
    setSelected(cu, it, next);
  }
  app.pushUndo(label);
  app.changed('select', 'doc');
  return true;
}

editModeHooks.box.push((v, x0, y0, x1, y1, mode) => (inCurveEdit() ? regionSelect(v, { kind: 'box', x0, y0, x1, y1 }, mode, 'Box Select') : false));
editModeHooks.region.push((v, r, mode) => (inCurveEdit() ? regionSelect(v, r, mode, r.kind === 'circle' ? 'Circle Select' : 'Lasso Select') : false));

const HANDLE_COLORS: Record<HandleType, [string, string]> = {
  FREE: ['#000000', '#f5feb8'],
  AUTO: ['#899102', '#f5feb8'],
  VECTOR: ['#3d8f32', '#3cc233'],
  ALIGNED: ['#7e315c', '#ef939e'],
};

editModeHooks.svg.push((v) => {
  if (!inCurveEdit()) return null;
  const { ob, cu } = activeCurve()!;
  const w = world(ob);
  useView(v);
  const lines: VNode[] = [],
    dots: VNode[] = [];
  const P = (a: ArrayLike<number>) => v.project(V3(a).applyMatrix4(w));
  if (v.overlay.show_curve_normals !== false && v.overlay.normals_length > 0) {
    // normals (rotated by tilt) along the evaluated curve
    const len = v.overlay.normals_length;
    for (const sp of cu.splines) {
      const smp = sampleSpline(sp, cu.resolution_u);
      if (smp.points.length < 2) continue;
      const { N, B } = frames(smp.points, smp.cyclic, cu.dimensions === '2D');
      smp.points.forEach((p, i) => {
        const t = smp.tilt[i];
        const n = V3(N[i]).multiplyScalar(Math.cos(t)).add(V3(B[i]).multiplyScalar(Math.sin(t))).multiplyScalar(len * smp.radius[i]);
        const a = P(p),
          b = P(V3(p).add(n).toArray());
        lines.push(h('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: '#90d0fd', 'stroke-width': 1, opacity: 0.8 }));
      });
    }
  }
  cu.splines.forEach((sp, s) => {
    if (sp.type === 'BEZIER') {
      sp.bezier_points.forEach((b, i) => {
        if (b.hide) return;
        const c = P(b.co);
        if (handlesShown(b)) {
          for (const side of ['hl', 'hr'] as const) {
            const hp = P(side === 'hl' ? b.handle_left : b.handle_right);
            const type = side === 'hl' ? b.handle_left_type : b.handle_right_type;
            const sel = side === 'hl' ? b.select_left_handle : b.select_right_handle;
            lines.push(h('line', { x1: c.x, y1: c.y, x2: hp.x, y2: hp.y, stroke: HANDLE_COLORS[type][sel ? 1 : 0], 'stroke-width': 1.5 }));
            dots.push(h('circle', { cx: hp.x, cy: hp.y, r: 3, fill: sel ? '#f58e04' : '#000000', stroke: HANDLE_COLORS[type][sel ? 1 : 0], 'stroke-width': 1 }));
          }
        }
        const act = curveState.active && curveState.active.s === s && curveState.active.i === i && curveState.active.part === 'co';
        dots.push(h('circle', { cx: c.x, cy: c.y, r: 3.5, fill: b.select_control_point ? (act ? '#ffffff' : '#f58e04') : '#000000', stroke: '#000000', 'stroke-width': 0.8 }));
      });
    } else {
      const pts = sp.points.map((p) => P(p.co));
      for (let i = 0; i + 1 < pts.length; i++) lines.push(h('line', { x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y, stroke: '#97a0fd', 'stroke-width': 1, opacity: 0.7 }));
      if (sp.use_cyclic_u && pts.length > 2) lines.push(h('line', { x1: pts[pts.length - 1].x, y1: pts[pts.length - 1].y, x2: pts[0].x, y2: pts[0].y, stroke: '#97a0fd', 'stroke-width': 1, opacity: 0.7 }));
      pts.forEach((p, i) => {
        if (sp.points[i].hide) return;
        const act = curveState.active && curveState.active.s === s && curveState.active.i === i;
        dots.push(h('circle', { cx: p.x, cy: p.y, r: 3.5, fill: sp.points[i].select ? (act ? '#ffffff' : '#f58e04') : '#000000', stroke: '#000000', 'stroke-width': 0.8 }));
      });
    }
  });
  return h('g', { class: 'curve-edit' }, lines, dots);
});

// ---------------------------------------------------------------------------
// transforms

function selectedTransformItems(cu: CurveData): Item[] {
  const out: Item[] = [];
  cu.splines.forEach((sp, s) => {
    if (sp.type === 'BEZIER')
      sp.bezier_points.forEach((b, i) => {
        if (b.select_control_point) out.push({ s, i, part: 'co' });
        else {
          if (b.select_left_handle) out.push({ s, i, part: 'hl' });
          if (b.select_right_handle) out.push({ s, i, part: 'hr' });
        }
      });
    else sp.points.forEach((p, i) => p.select && out.push({ s, i, part: 'co' }));
  });
  return out;
}

transformProviders.push({
  collect({ proportional, connected }) {
    if (!inCurveEdit()) return null;
    const { ob, cu } = activeCurve()!;
    const items = selectedTransformItems(cu);
    if (!items.length) return null;
    const w = world(ob),
      inv = w.clone().invert();
    const before = structuredClone(cu.splines);
    const basis = new Matrix3().setFromMatrix4(w);
    const local = (a: ArrayLike<number>, m: Matrix4) => V3(a).applyMatrix4(w).applyMatrix4(m).applyMatrix4(inv).toArray() as Vec3;
    /** move a whole control point (with its handles) */
    const movePoint = (s: number, i: number, m: Matrix4) => {
      const sp = cu.splines[s];
      if (sp.type !== 'BEZIER') {
        const q = local(before[s].points[i].co, m);
        sp.points[i].co = [q[0], q[1], q[2], sp.points[i].co[3]];
        return;
      }
      const b = sp.bezier_points[i],
        b0 = before[s].bezier_points[i];
      b.co = local(b0.co, m);
      b.handle_left = local(b0.handle_left, m);
      b.handle_right = local(b0.handle_right, m);
    };
    const restore = () => {
      cu.splines = structuredClone(before);
    };
    const els: TElement[] = items.map((it) => {
      const sp = cu.splines[it.s];
      const p0 = itemPos(cu, it).applyMatrix4(w);
      const b0 = sp.type === 'BEZIER' ? structuredClone(before[it.s].bezier_points[it.i]) : null;
      return {
        center: p0,
        basis,
        weight: 1,
        apply(m: Matrix4) {
          if (sp.type !== 'BEZIER' || it.part === 'co') {
            movePoint(it.s, it.i, m);
            return;
          }
          const b = sp.bezier_points[it.i];
          const key = partKey(it.part) as 'handle_left' | 'handle_right';
          b[key] = local(b0![key], m);
          // moving an automatic/vector handle makes it editable (aligned / free)
          const tk = it.part === 'hl' ? 'handle_left_type' : 'handle_right_type';
          const other = it.part === 'hl' ? 'handle_right_type' : 'handle_left_type';
          if (b0![tk] === 'AUTO') {
            b[tk] = 'ALIGNED';
            if (b0![other] === 'AUTO') b[other] = 'ALIGNED';
          } else if (b0![tk] === 'VECTOR') b[tk] = 'FREE';
          alignOpposite(b, it.part);
        },
        restore,
      } as TElement;
    });
    if (proportional) {
      // unselected control points follow with a falloff (along the spline when Connected)
      const refs: { s: number; i: number }[] = [];
      const pts: Vector3[] = [];
      const sel: boolean[] = [];
      const start: number[] = [];
      cu.splines.forEach((sp, s) => {
        start.push(refs.length);
        for (let i = 0; i < K.pointCount(sp); i++) {
          if (K.isHidden(sp, i)) continue;
          refs.push({ s, i });
          pts.push(K.pointCo(sp, i).applyMatrix4(w));
          sel.push(K.anyPartSelected(sp, i));
        }
      });
      const index = new Map(refs.map((r, k) => [`${r.s}:${r.i}`, k]));
      const neighbours = (k: number) => {
        const r = refs[k];
        const sp = cu.splines[r.s];
        return ([-1, 1] as const).map((d) => K.neighbour(sp, r.i, d)).filter((j) => j >= 0).map((j) => index.get(`${r.s}:${j}`)).filter((x): x is number => x !== undefined);
      };
      const { weight, dist } = proportionalWeights(pts, sel, connected, neighbours);
      refs.forEach((r, k) => {
        if (sel[k] || !weight[k]) return;
        els.push({ center: pts[k], basis, weight: weight[k], distance: dist[k], apply: (m: Matrix4) => movePoint(r.s, r.i, m), restore } as TElement);
      });
    }
    const act = activePoint();
    return {
      elements: els,
      active: act && cu.splines[act.s] ? K.pointCo(cu.splines[act.s], act.i).applyMatrix4(w) : undefined,
      label: 'Curve',
      finish() {},
      cancel() {},
      onUpdate: () => {
        for (const sp of cu.splines) recalcHandles(sp);
        app.changed('doc', 'geometry');
      },
    };
  },
});

function selectedWorldPoints(): Vector3[] {
  const a = inCurveEdit() ? activeCurve() : null;
  if (!a) return [];
  const w = world(a.ob);
  return selectedTransformItems(a.cu).map((it) => itemPos(a.cu, it).applyMatrix4(w));
}

const prevGizmo = gizmoCenterHook;
setGizmoCenterHook(() => {
  if (inCurveEdit()) {
    const pts = selectedWorldPoints();
    if (!pts.length) return null;
    const c = new Vector3();
    pts.forEach((p) => c.add(p));
    return { center: c.multiplyScalar(1 / pts.length) };
  }
  return prevGizmo?.() ?? null;
});

frameHooks.unshift(() => {
  if (!inCurveEdit()) return null;
  const pts = selectedWorldPoints();
  return pts.length ? new Box3().setFromPoints(pts) : null;
});

// ---------------------------------------------------------------------------
// operators

const poll = () => inCurveEdit();

function newBezierPoint(co: Vec3, type: HandleType = 'AUTO'): BezierPoint {
  return { co: [...co] as Vec3, handle_left: [...co] as Vec3, handle_right: [...co] as Vec3, handle_left_type: type, handle_right_type: type, radius: 1, tilt: 0 };
}

function splinePointCount(sp: Spline) {
  return sp.type === 'BEZIER' ? sp.bezier_points.length : sp.points.length;
}

function selectPointFull(sp: Spline, i: number, on = true) {
  if (sp.type === 'BEZIER') {
    const b = sp.bezier_points[i];
    b.select_control_point = b.select_left_handle = b.select_right_handle = on;
  } else sp.points[i].select = on;
}

registerOperators([
  {
    idname: 'curve.select_all',
    label: '(De)select All',
    props: [{ id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['SELECT', 'Select'], ['DESELECT', 'Deselect'], ['INVERT', 'Invert']] }],
    poll,
    exec: (_ctx, p) => {
      K.selectAll(activeCurve()!.cu, p.action as 'TOGGLE');
    },
    redo: false,
  },
  {
    idname: 'curve.select_linked',
    label: 'Select Linked All',
    description: 'Select all points of splines that have a selected point',
    poll,
    exec: () => {
      K.selectLinked(activeCurve()!.cu);
    },
  },
  {
    idname: 'curve.extrude_move',
    label: 'Extrude Curve and Move',
    description: 'Extrude the selected end points and move the new points',
    props: [{ id: 'release_confirm', label: 'Confirm on Release', type: 'bool', default: false, hidden: true }],
    poll,
    invoke: (ctx, p) => {
      const { cu } = activeCurve()!;
      let added = 0;
      for (const sp of cu.splines) {
        if (sp.use_cyclic_u) continue;
        const n = splinePointCount(sp);
        if (!n) continue;
        const last = pointSelected(sp, n - 1),
          first = n > 1 && pointSelected(sp, 0);
        for (let i = 0; i < n; i++) selectPointFull(sp, i, false);
        if (sp.type === 'BEZIER') {
          if (last) {
            const b = newBezierPoint(sp.bezier_points[n - 1].co, 'AUTO');
            sp.bezier_points.push(b);
            selectPointFull(sp, sp.bezier_points.length - 1);
            added++;
          }
          if (first) {
            sp.bezier_points.unshift(newBezierPoint(sp.bezier_points[0].co, 'AUTO'));
            selectPointFull(sp, 0);
            added++;
          }
        } else {
          if (last) {
            const p = sp.points[n - 1];
            sp.points.push({ co: [...p.co] as SplinePoint['co'], radius: p.radius, tilt: p.tilt, select: true });
            added++;
          }
          if (first) {
            const p = sp.points[0];
            sp.points.unshift({ co: [...p.co] as SplinePoint['co'], radius: p.radius, tilt: p.tilt, select: true });
            added++;
          }
        }
      }
      if (!added) {
        app.report('WARNING', 'Select an end point of an open spline to extrude');
        return 'CANCELLED';
      }
      app.changed('doc', 'geometry');
      app.flush();
      startTransform('TRANSLATION', { event: ctx.event, label: 'Extrude', release_confirm: !!p.release_confirm });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'curve.vertex_add',
    label: 'Extrude to Cursor or Add',
    description: 'Add a new control point at the mouse position (linked to the selected end point)',
    props: [{ id: 'location', label: 'Location', type: 'vec3', default: null, subtype: 'distance' }],
    poll,
    invoke: (ctx) => {
      const view = activeView3D();
      const { ob, cu } = activeCurve()!;
      const w = world(ob);
      // depth: the selected end point, or the 3D cursor
      let depth = V3(ctx.doc.scene.cursor.location);
      for (const sp of cu.splines) {
        const n = splinePointCount(sp);
        if (n && pointSelected(sp, n - 1)) depth = (sp.type === 'BEZIER' ? V3(sp.bezier_points[n - 1].co) : V3(sp.points[n - 1].co)).applyMatrix4(w);
      }
      if (!view || !ctx.event) return 'CANCELLED';
      const r = view.el.getBoundingClientRect();
      const p = view.unproject(ctx.event.x - r.left, ctx.event.y - r.top, depth);
      // run as exec so the redo panel and undo record the resolved location
      app.run('curve.vertex_add', { location: p.toArray() }, { invoke: false });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const { ob, cu } = activeCurve()!;
      const loc = V3((p.location as number[]) ?? ctx.doc.scene.cursor.location).applyMatrix4(world(ob).clone().invert());
      const co = loc.toArray() as Vec3;
      // append after a selected end point
      for (const sp of cu.splines) {
        const n = splinePointCount(sp);
        if (!n || sp.use_cyclic_u) continue;
        const atEnd = pointSelected(sp, n - 1),
          atStart = !atEnd && pointSelected(sp, 0);
        if (!atEnd && !atStart) continue;
        deselectAll(cu);
        if (sp.type === 'BEZIER') {
          const b = newBezierPoint(co, 'AUTO');
          if (atEnd) sp.bezier_points.push(b);
          else sp.bezier_points.unshift(b);
          selectPointFull(sp, atEnd ? sp.bezier_points.length - 1 : 0);
        } else {
          const pt: SplinePoint = { co: [co[0], co[1], co[2], 1], radius: 1, tilt: 0, select: true };
          if (atEnd) sp.points.push(pt);
          else sp.points.unshift(pt);
        }
        recalcHandles(sp);
        return;
      }
      // nothing selected: start a new spline
      deselectAll(cu);
      const sp: Spline = { type: 'BEZIER', bezier_points: [newBezierPoint(co, 'AUTO')], points: [], use_cyclic_u: false, resolution_u: cu.resolution_u, order_u: 4, use_smooth: true, material_index: 0 };
      selectPointFull(sp, 0);
      cu.splines.push(sp);
    },
  },
  {
    idname: 'curve.delete',
    label: 'Delete',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'VERT', items: [['VERT', 'Vertices'], ['SEGMENT', 'Segments']] }],
    poll,
    exec: (_ctx, p) => {
      const { cu } = activeCurve()!;
      if (p.type === 'SEGMENT') K.cutSelectedSegments(cu, false);
      else {
        const out: Spline[] = [];
        for (const sp of cu.splines) {
          if (sp.type === 'BEZIER') sp.bezier_points = sp.bezier_points.filter((b) => !b.select_control_point);
          else sp.points = sp.points.filter((q) => !q.select);
          if (!splinePointCount(sp)) continue;
          if (splinePointCount(sp) < (sp.type === 'BEZIER' ? 2 : 3)) sp.use_cyclic_u = false;
          out.push(sp);
        }
        cu.splines = out;
      }
      for (const sp of cu.splines) recalcHandles(sp);
      curveState.active = null;
    },
  },
  {
    idname: 'curve.handle_type_set',
    label: 'Set Handle Type',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'AUTOMATIC', items: [['AUTOMATIC', 'Automatic'], ['VECTOR', 'Vector'], ['ALIGNED', 'Aligned'], ['FREE_ALIGN', 'Free'], ['TOGGLE_FREE_ALIGN', 'Toggle Free/Align']] }],
    poll,
    exec: (_ctx, p) => {
      const { cu } = activeCurve()!;
      for (const sp of cu.splines) {
        if (sp.type !== 'BEZIER') continue;
        for (const b of sp.bezier_points) {
          const sides: ('handle_left_type' | 'handle_right_type')[] = [];
          if (b.select_control_point || b.select_left_handle) sides.push('handle_left_type');
          if (b.select_control_point || b.select_right_handle) sides.push('handle_right_type');
          for (const s of sides) {
            if (p.type === 'AUTOMATIC') b[s] = 'AUTO';
            else if (p.type === 'VECTOR') b[s] = 'VECTOR';
            else if (p.type === 'ALIGNED') b[s] = 'ALIGNED';
            else if (p.type === 'FREE_ALIGN') b[s] = 'FREE';
            else b[s] = b[s] === 'FREE' ? 'ALIGNED' : 'FREE';
          }
          if (p.type === 'ALIGNED' || (p.type === 'TOGGLE_FREE_ALIGN' && b.handle_left_type === 'ALIGNED')) alignOpposite(b, 'hr');
        }
        recalcHandles(sp);
      }
    },
  },
  {
    idname: 'curve.cyclic_toggle',
    label: 'Toggle Cyclic',
    poll,
    exec: () => {
      for (const sp of activeCurve()!.cu.splines) {
        const n = splinePointCount(sp);
        if (n > 1 && [...Array(n).keys()].some((i) => pointSelected(sp, i))) {
          sp.use_cyclic_u = !sp.use_cyclic_u;
          recalcHandles(sp);
        }
      }
    },
  },
  {
    idname: 'curve.switch_direction',
    label: 'Switch Direction',
    poll,
    exec: () => {
      for (const sp of activeCurve()!.cu.splines) {
        const n = splinePointCount(sp);
        if (![...Array(n).keys()].some((i) => pointSelected(sp, i))) continue;
        if (sp.type === 'BEZIER') {
          sp.bezier_points.reverse();
          for (const b of sp.bezier_points) {
            [b.handle_left, b.handle_right] = [b.handle_right, b.handle_left];
            [b.handle_left_type, b.handle_right_type] = [b.handle_right_type, b.handle_left_type];
            [b.select_left_handle, b.select_right_handle] = [b.select_right_handle, b.select_left_handle];
          }
        } else sp.points.reverse();
      }
    },
  },
  {
    idname: 'curve.subdivide',
    label: 'Subdivide',
    description: 'Subdivide the segments between selected control points',
    props: [{ id: 'number_cuts', label: 'Number of Cuts', type: 'int', default: 1, min: 1, max: 1000 }],
    poll,
    exec: (_ctx, p) => {
      const { cu } = activeCurve()!;
      K.subdivide(cu, p.number_cuts as number);
      for (const sp of cu.splines) recalcHandles(sp);
    },
  },
  {
    idname: 'curve.make_segment',
    label: 'Make Segment',
    description: 'Join two splines at their selected end points, or close a spline whose two ends are selected',
    poll,
    exec: () => {
      const { cu } = activeCurve()!;
      const ends: { s: number; atEnd: boolean }[] = [];
      cu.splines.forEach((sp, s) => {
        const n = splinePointCount(sp);
        if (!n || sp.use_cyclic_u) return;
        if (pointSelected(sp, n - 1)) ends.push({ s, atEnd: true });
        if (n > 1 && pointSelected(sp, 0)) ends.push({ s, atEnd: false });
      });
      if (ends.length !== 2) {
        app.report('ERROR', 'Select exactly two end points');
        return 'CANCELLED';
      }
      const [e1, e2] = ends;
      if (e1.s === e2.s) {
        cu.splines[e1.s].use_cyclic_u = true;
        recalcHandles(cu.splines[e1.s]);
        return;
      }
      const a = cu.splines[e1.s],
        b = cu.splines[e2.s];
      if (a.type !== b.type) {
        app.report('ERROR', 'Cannot join splines of different types');
        return 'CANCELLED';
      }
      const rev = (sp: Spline) => {
        if (sp.type === 'BEZIER') {
          sp.bezier_points.reverse();
          for (const bp of sp.bezier_points) {
            [bp.handle_left, bp.handle_right] = [bp.handle_right, bp.handle_left];
            [bp.handle_left_type, bp.handle_right_type] = [bp.handle_right_type, bp.handle_left_type];
          }
        } else sp.points.reverse();
      };
      if (!e1.atEnd) rev(a);
      if (e2.atEnd) rev(b);
      if (a.type === 'BEZIER') a.bezier_points.push(...b.bezier_points);
      else a.points.push(...b.points);
      cu.splines.splice(e2.s, 1);
      recalcHandles(a);
    },
  },
  {
    idname: 'curve.duplicate_move',
    label: 'Duplicate',
    description: 'Duplicate the selected control points and move them',
    poll,
    invoke: (ctx) => {
      const { cu } = activeCurve()!;
      const copies = K.selectedRuns(cu);
      if (!copies.length) return 'CANCELLED';
      deselectAll(cu);
      for (const c of copies) for (let i = 0; i < splinePointCount(c); i++) selectPointFull(c, i);
      cu.splines.push(...copies);
      app.changed('doc', 'geometry');
      app.flush();
      startTransform('TRANSLATION', { event: ctx.event, label: 'Duplicate' });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'curve.separate',
    label: 'Separate',
    description: 'Separate the selected points into a new object',
    poll,
    exec: (ctx) => {
      const { ob, cu } = activeCurve()!;
      const moving = K.extractSelected(cu);
      if (!moving.length) {
        app.report('ERROR', 'Nothing selected to separate');
        return 'CANCELLED';
      }
      for (const sp of cu.splines) recalcHandles(sp);
      const nc: CurveData = { ...structuredClone({ ...cu, splines: [] }), ...newCurve(uniqueName(ctx.doc, cu.name, 'curves')) };
      Object.assign(nc, { dimensions: cu.dimensions, resolution_u: cu.resolution_u, bevel_depth: cu.bevel_depth, bevel_resolution: cu.bevel_resolution, extrude: cu.extrude, offset: cu.offset, fill_mode: cu.fill_mode, use_fill_caps: cu.use_fill_caps, materials: [...cu.materials] });
      for (const sp of moving) for (let i = 0; i < splinePointCount(sp); i++) selectPointFull(sp, i, false);
      nc.splines = moving;
      ctx.doc.curves[nc.id] = nc;
      const no = newObject(uniqueName(ctx.doc, ob.name), 'CURVE', nc.id);
      no.location = [...ob.location] as Vec3;
      no.rotation_euler = [...ob.rotation_euler] as Vec3;
      no.rotation_quaternion = [...ob.rotation_quaternion] as typeof no.rotation_quaternion;
      no.rotation_mode = ob.rotation_mode;
      no.scale = [...ob.scale] as Vec3;
      no.parent = ob.parent;
      no.matrix_parent_inverse = [...ob.matrix_parent_inverse];
      ctx.doc.objects[no.id] = no;
      ctx.doc.object_order.push(no.id);
      for (const c of Object.values(ctx.doc.collections)) if (c.objects.includes(ob.id)) c.objects.push(no.id);
      curveState.active = null;
    },
  },
  {
    idname: 'curve.spline_type_set',
    label: 'Set Spline Type',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'POLY', items: [['POLY', 'Poly'], ['BEZIER', 'Bézier'], ['NURBS', 'NURBS']] }],
    poll,
    exec: (_ctx, p) => {
      const t = p.type as Spline['type'];
      for (const sp of activeCurve()!.cu.splines) {
        const n = splinePointCount(sp);
        if (sp.type === t || ![...Array(n).keys()].some((i) => pointSelected(sp, i))) continue;
        if (sp.type === 'BEZIER') {
          sp.points = sp.bezier_points.map((b) => ({ co: [b.co[0], b.co[1], b.co[2], 1], radius: b.radius, tilt: b.tilt, select: !!b.select_control_point }));
          sp.bezier_points = [];
        } else if (t === 'BEZIER') {
          sp.bezier_points = sp.points.map((q) => ({ ...newBezierPoint([q.co[0], q.co[1], q.co[2]], 'AUTO'), radius: q.radius, tilt: q.tilt, select_control_point: !!q.select, select_left_handle: !!q.select, select_right_handle: !!q.select }));
          sp.points = [];
        }
        sp.type = t;
        if (t === 'NURBS') sp.order_u = Math.min(4, Math.max(2, splinePointCount(sp)));
        recalcHandles(sp);
      }
    },
  },
]);

// Adding curve primitives in Edit Mode appends a spline to the edited curve.
export function addSplineToEditedCurve(sp: Spline, location: number[], rotation?: number[]) {
  const a = activeCurve();
  if (!a) return false;
  const inv = world(a.ob).clone().invert();
  const rot = new Matrix4();
  if (rotation) rot.makeRotationFromEuler(new Euler(rotation[0], rotation[1], rotation[2], 'ZYX'));
  const xf = inv.clone().multiply(new Matrix4().makeTranslation(location[0], location[1], location[2])).multiply(rot);
  const tp = (c: ArrayLike<number>) => V3(c).applyMatrix4(xf).toArray() as Vec3;
  for (const b of sp.bezier_points) {
    b.co = tp(b.co);
    b.handle_left = tp(b.handle_left);
    b.handle_right = tp(b.handle_right);
  }
  for (const q of sp.points) {
    const t = tp(q.co);
    q.co = [t[0], t[1], t[2], q.co[3]];
  }
  deselectAll(a.cu);
  for (let i = 0; i < splinePointCount(sp); i++) selectPointFull(sp, i);
  a.cu.splines.push(sp);
  return true;
}

// Ctrl + right click adds a control point (extrude to cursor)
editModeHooks.context.push((v, e) => {
  if (!inCurveEdit() || !e.ctrlKey) return false;
  app.run('curve.vertex_add', {}, { area: v.area as never, event: { x: e.clientX, y: e.clientY } });
  return true;
});

curveEditHooks.addSpline = addSplineToEditedCurve;
