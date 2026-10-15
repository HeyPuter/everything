// Curve Edit Mode: control point / handle selection and transforms, handle types, extrude,
// add vertex, delete, subdivide, cyclic toggle, make segment, duplicate, separate, spline type.
import { Matrix3, Matrix4, Vector3, Box3, Euler } from 'three';
import { app, registerOperators } from '../../app/app';
import { editModeHooks } from '../../editors/view3d/hooks';
import { activeView3D, type View3D } from '../../editors/view3d/view3d';
import { h, type VNode } from '../../ui/h';
import type { BezierPoint, CurveData, HandleType, ObjectData, Spline, SplinePoint, Vec3 } from '../../data/types';
import { transformProviders, startTransform, type TElement } from '../../ops/transform';
import { setGizmoCenterHook, gizmoCenterHook } from '../../editors/view3d/gizmo';
import { frameHooks } from '../../ops/view3d';
import { modeMenus } from '../../editors/view3d/modemenus';
import { addKeys } from '../../app/keymap';
import type { MenuItem } from '../../ui/menu';
import { newCurve, newObject } from '../../data/defaults';
import { uniqueName, curveEditHooks } from '../../ops/object';

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

/** Whether handles are drawn for a point (only for selected points, like the default overlay). */
function handlesShown(b: BezierPoint) {
  return !!(b.select_control_point || b.select_left_handle || b.select_right_handle);
}

function allItems(cu: CurveData, withHandles = true): Item[] {
  const out: Item[] = [];
  cu.splines.forEach((sp, s) => {
    if (sp.type === 'BEZIER')
      sp.bezier_points.forEach((b, i) => {
        out.push({ s, i, part: 'co' });
        if (withHandles && handlesShown(b)) out.push({ s, i, part: 'hl' }, { s, i, part: 'hr' });
      });
    else sp.points.forEach((_, i) => out.push({ s, i, part: 'co' }));
  });
  return out;
}

function anySelected(cu: CurveData) {
  return allItems(cu, false).some((it) => isSelected(cu, it) || (cu.splines[it.s].type === 'BEZIER' && handlesShown(cu.splines[it.s].bezier_points[it.i])));
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

let activeItem: Item | null = null;

editModeHooks.pick.push((v, x, y, o) => {
  if (!inCurveEdit()) return false;
  const { cu } = activeCurve()!;
  const hit = pick(v, x, y);
  if (!o.extend) deselectAll(cu);
  if (hit) {
    const on = !(o.toggle && isSelected(cu, hit));
    setSelected(cu, hit, on);
    activeItem = on ? hit : null;
  } else activeItem = null;
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
});

editModeHooks.box.push((v, x0, y0, x1, y1, mode) => {
  if (!inCurveEdit()) return false;
  const { ob, cu } = activeCurve()!;
  const w = world(ob);
  const [lx, hx, ly, hy] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
  for (const it of allItems(cu, false)) {
    const p = v.project(itemPos(cu, it).applyMatrix4(w));
    const hit = p.x >= lx && p.x <= hx && p.y >= ly && p.y <= hy;
    const cur = isSelected(cu, it);
    const next = mode === 'SET' ? hit : mode === 'ADD' ? cur || hit : mode === 'SUB' ? cur && !hit : mode === 'AND' ? cur && hit : cur !== hit;
    setSelected(cu, it, next);
  }
  app.pushUndo('Box Select');
  app.changed('select', 'doc');
  return true;
});

const HANDLE_COLORS: Record<HandleType, [string, string]> = {
  FREE: ['#000000', '#f0ff40'],
  AUTO: ['#909000', '#f0ff40'],
  VECTOR: ['#409030', '#40c030'],
  ALIGNED: ['#803060', '#f090a0'],
};

editModeHooks.svg.push((v) => {
  if (!inCurveEdit()) return null;
  const { ob, cu } = activeCurve()!;
  const w = world(ob);
  const lines: VNode[] = [],
    dots: VNode[] = [];
  const P = (a: ArrayLike<number>) => v.project(V3(a).applyMatrix4(w));
  cu.splines.forEach((sp, s) => {
    if (sp.type === 'BEZIER') {
      sp.bezier_points.forEach((b, i) => {
        const c = P(b.co);
        if (handlesShown(b)) {
          for (const side of ['hl', 'hr'] as const) {
            const hp = P(side === 'hl' ? b.handle_left : b.handle_right);
            const type = side === 'hl' ? b.handle_left_type : b.handle_right_type;
            const sel = side === 'hl' ? b.select_left_handle : b.select_right_handle;
            lines.push(h('line', { x1: c.x, y1: c.y, x2: hp.x, y2: hp.y, stroke: HANDLE_COLORS[type][sel ? 1 : 0], 'stroke-width': 1.5 }));
            dots.push(h('circle', { cx: hp.x, cy: hp.y, r: 3, fill: sel ? '#ff8500' : '#000', stroke: HANDLE_COLORS[type][sel ? 1 : 0], 'stroke-width': 1 }));
          }
        }
        const act = activeItem && activeItem.s === s && activeItem.i === i && activeItem.part === 'co';
        dots.push(h('circle', { cx: c.x, cy: c.y, r: 3.5, fill: b.select_control_point ? (act ? '#fff' : '#ff8500') : '#000', stroke: '#000', 'stroke-width': 0.8 }));
      });
    } else {
      const pts = sp.points.map((p) => P(p.co));
      for (let i = 0; i + 1 < pts.length; i++) lines.push(h('line', { x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y, stroke: '#90a0ff', 'stroke-width': 1, opacity: 0.7 }));
      if (sp.use_cyclic_u && pts.length > 2) lines.push(h('line', { x1: pts[pts.length - 1].x, y1: pts[pts.length - 1].y, x2: pts[0].x, y2: pts[0].y, stroke: '#90a0ff', 'stroke-width': 1, opacity: 0.7 }));
      pts.forEach((p, i) => dots.push(h('circle', { cx: p.x, cy: p.y, r: 3.5, fill: sp.points[i].select ? '#ff8500' : '#000', stroke: '#000', 'stroke-width': 0.8 })));
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
  collect() {
    if (!inCurveEdit()) return null;
    const { ob, cu } = activeCurve()!;
    const items = selectedTransformItems(cu);
    if (!items.length) return null;
    const w = world(ob),
      inv = w.clone().invert();
    const before = structuredClone(cu.splines);
    const els: TElement[] = items.map((it) => {
      const sp = cu.splines[it.s];
      const p0 = itemPos(cu, it).applyMatrix4(w);
      const b0 = sp.type === 'BEZIER' ? structuredClone(before[it.s].bezier_points[it.i]) : null;
      return {
        center: p0,
        basis: new Matrix3().setFromMatrix4(w),
        weight: 1,
        apply(m: Matrix4) {
          const local = (a: ArrayLike<number>) => V3(a).applyMatrix4(w).applyMatrix4(m).applyMatrix4(inv).toArray() as Vec3;
          if (sp.type !== 'BEZIER') {
            const q = local(before[it.s].points[it.i].co);
            const pt = sp.points[it.i];
            pt.co = [q[0], q[1], q[2], pt.co[3]];
            return;
          }
          const b = sp.bezier_points[it.i];
          if (it.part === 'co') {
            b.co = local(b0!.co);
            b.handle_left = local(b0!.handle_left);
            b.handle_right = local(b0!.handle_right);
          } else {
            const key = partKey(it.part) as 'handle_left' | 'handle_right';
            b[key] = local(b0![key]);
            // moving an automatic/vector handle makes it editable (aligned / free)
            const tk = it.part === 'hl' ? 'handle_left_type' : 'handle_right_type';
            const other = it.part === 'hl' ? 'handle_right_type' : 'handle_left_type';
            if (b0![tk] === 'AUTO') {
              b[tk] = 'ALIGNED';
              if (b0![other] === 'AUTO') b[other] = 'ALIGNED';
            } else if (b0![tk] === 'VECTOR') b[tk] = 'FREE';
            alignOpposite(b, it.part);
          }
        },
        restore() {
          cu.splines = structuredClone(before);
        },
      } as TElement;
    });
    return {
      elements: els,
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

function bezierMid(a: BezierPoint, b: BezierPoint): { mid: BezierPoint; aR: Vec3; bL: Vec3 } {
  // de Casteljau split at t = 0.5
  const p0 = V3(a.co),
    p1 = V3(a.handle_right),
    p2 = V3(b.handle_left),
    p3 = V3(b.co);
  const q0 = p0.clone().lerp(p1, 0.5),
    q1 = p1.clone().lerp(p2, 0.5),
    q2 = p2.clone().lerp(p3, 0.5);
  const r0 = q0.clone().lerp(q1, 0.5),
    r1 = q1.clone().lerp(q2, 0.5);
  const s = r0.clone().lerp(r1, 0.5);
  const mid = newBezierPoint(s.toArray() as Vec3, a.handle_right_type === 'VECTOR' && b.handle_left_type === 'VECTOR' ? 'VECTOR' : 'ALIGNED');
  mid.handle_left = r0.toArray() as Vec3;
  mid.handle_right = r1.toArray() as Vec3;
  mid.radius = (a.radius + b.radius) / 2;
  mid.tilt = (a.tilt + b.tilt) / 2;
  return { mid, aR: q0.toArray() as Vec3, bL: q2.toArray() as Vec3 };
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
      const { cu } = activeCurve()!;
      let a = p.action as string;
      if (a === 'TOGGLE') a = anySelected(cu) ? 'DESELECT' : 'SELECT';
      for (const sp of cu.splines) for (let i = 0; i < splinePointCount(sp); i++) selectPointFull(sp, i, a === 'SELECT' ? true : a === 'DESELECT' ? false : !pointSelected(sp, i));
    },
    redo: false,
  },
  {
    idname: 'curve.select_linked',
    label: 'Select Linked All',
    description: 'Select all points of splines that have a selected point',
    poll,
    exec: () => {
      for (const sp of activeCurve()!.cu.splines) {
        const n = splinePointCount(sp);
        if ([...Array(n).keys()].some((i) => pointSelected(sp, i))) for (let i = 0; i < n; i++) selectPointFull(sp, i);
      }
    },
  },
  {
    idname: 'curve.extrude_move',
    label: 'Extrude Curve and Move',
    poll,
    invoke: (ctx) => {
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
      startTransform('TRANSLATION', { event: ctx.event, label: 'Extrude' });
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
      const out: Spline[] = [];
      for (const sp of cu.splines) {
        const n = splinePointCount(sp);
        const sel = [...Array(n).keys()].map((i) => pointSelected(sp, i));
        if (p.type === 'VERT') {
          if (sp.type === 'BEZIER') sp.bezier_points = sp.bezier_points.filter((_, i) => !sel[i]);
          else sp.points = sp.points.filter((_, i) => !sel[i]);
          if (splinePointCount(sp)) {
            if (splinePointCount(sp) < 3) sp.use_cyclic_u = false;
            recalcHandles(sp);
            out.push(sp);
          }
          continue;
        }
        // segments: cut every segment whose both ends are selected
        const cut = (i: number) => sel[i] && sel[(i + 1) % n];
        const segs = sp.use_cyclic_u ? n : n - 1;
        if (![...Array(segs).keys()].some(cut)) {
          out.push(sp);
          continue;
        }
        const take = (from: number, count: number): Spline => {
          const idx = Array.from({ length: count }, (_, k) => (from + k) % n);
          return { ...structuredClone(sp), use_cyclic_u: false, bezier_points: sp.type === 'BEZIER' ? idx.map((i) => structuredClone(sp.bezier_points[i])) : [], points: sp.type === 'BEZIER' ? [] : idx.map((i) => structuredClone(sp.points[i])) };
        };
        const start = sp.use_cyclic_u ? [...Array(n).keys()].find(cut)! + 1 : 0;
        let runStart = start,
          len = 1;
        for (let k = 0; k < (sp.use_cyclic_u ? n : n - 1); k++) {
          const i = (start + k) % n;
          if (cut(i)) {
            if (len > 1) out.push(take(runStart, len));
            runStart = (i + 1) % n;
            len = 1;
          } else len++;
        }
        if (len > 1) out.push(take(runStart, len));
      }
      cu.splines = out;
      activeItem = null;
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
    props: [{ id: 'number_cuts', label: 'Number of Cuts', type: 'int', default: 1, min: 1, max: 100 }],
    poll,
    exec: (_ctx, p) => {
      const cuts = p.number_cuts as number;
      for (const sp of activeCurve()!.cu.splines) {
        for (let c = 0; c < cuts; c++) {
          const n = splinePointCount(sp);
          const segs = sp.use_cyclic_u ? n : n - 1;
          // walk backwards so indices stay valid while inserting
          for (let i = segs - 1; i >= 0; i--) {
            const j = (i + 1) % n;
            if (!pointSelected(sp, i) || !pointSelected(sp, j)) continue;
            // with several cuts, split the first part repeatedly so cuts are evenly spaced
            if (sp.type === 'BEZIER') {
              const a = sp.bezier_points[i],
                b = sp.bezier_points[j];
              const { mid, aR, bL } = bezierMid(a, b);
              if (a.handle_right_type !== 'VECTOR') a.handle_right = aR;
              if (b.handle_left_type !== 'VECTOR') b.handle_left = bL;
              if (a.handle_right_type === 'AUTO') a.handle_right_type = 'ALIGNED';
              if (b.handle_left_type === 'AUTO') b.handle_left_type = 'ALIGNED';
              mid.select_control_point = mid.select_left_handle = mid.select_right_handle = true;
              sp.bezier_points.splice(i + 1, 0, mid);
            } else {
              const a = sp.points[i],
                b = sp.points[j];
              sp.points.splice(i + 1, 0, { co: a.co.map((x, k) => (x + b.co[k]) / 2) as SplinePoint['co'], radius: (a.radius + b.radius) / 2, tilt: (a.tilt + b.tilt) / 2, select: true });
            }
          }
          if (cuts > 1) break; // one pass per cut count keeps selection-based spacing simple
        }
        recalcHandles(sp);
      }
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
    poll,
    invoke: (ctx) => {
      const { cu } = activeCurve()!;
      const copies: Spline[] = [];
      for (const sp of cu.splines) {
        const n = splinePointCount(sp);
        let run: number[] = [];
        const flush = () => {
          if (run.length) {
            copies.push({ ...structuredClone(sp), use_cyclic_u: run.length === n && sp.use_cyclic_u, bezier_points: sp.type === 'BEZIER' ? run.map((i) => structuredClone(sp.bezier_points[i])) : [], points: sp.type === 'BEZIER' ? [] : run.map((i) => structuredClone(sp.points[i])) });
            run = [];
          }
        };
        for (let i = 0; i < n; i++) {
          if (pointSelected(sp, i)) run.push(i);
          else flush();
        }
        flush();
      }
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
    description: 'Separate the selected splines into a new object',
    poll,
    exec: (ctx) => {
      const { ob, cu } = activeCurve()!;
      const moving = cu.splines.filter((sp) => [...Array(splinePointCount(sp)).keys()].some((i) => pointSelected(sp, i)));
      if (!moving.length || moving.length === cu.splines.length) return 'CANCELLED';
      cu.splines = cu.splines.filter((sp) => !moving.includes(sp));
      const nc: CurveData = { ...structuredClone({ ...cu, splines: [] }), ...newCurve(uniqueName(ctx.doc, cu.name, 'curves')) };
      Object.assign(nc, { dimensions: cu.dimensions, resolution_u: cu.resolution_u, bevel_depth: cu.bevel_depth, bevel_resolution: cu.bevel_resolution, extrude: cu.extrude, fill_mode: cu.fill_mode, materials: [...cu.materials] });
      nc.splines = moving;
      ctx.doc.curves[nc.id] = nc;
      const no = newObject(uniqueName(ctx.doc, ob.name), 'CURVE', nc.id);
      no.location = [...ob.location] as Vec3;
      no.rotation_euler = [...ob.rotation_euler] as Vec3;
      no.scale = [...ob.scale] as Vec3;
      no.parent = ob.parent;
      no.matrix_parent_inverse = [...ob.matrix_parent_inverse];
      ctx.doc.objects[no.id] = no;
      ctx.doc.object_order.push(no.id);
      for (const c of Object.values(ctx.doc.collections)) if (c.objects.includes(ob.id)) c.objects.push(no.id);
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

// ---------------------------------------------------------------------------
// menus & keys

function curveMenu(): MenuItem[] {
  return [
    { label: 'Transform', submenu: () => [{ label: 'Move', op: 'transform.translate', shortcut: 'G' }, { label: 'Rotate', op: 'transform.rotate', shortcut: 'R' }, { label: 'Scale', op: 'transform.resize', shortcut: 'S' }] },
    { separator: true },
    { label: 'Duplicate', op: 'curve.duplicate_move', shortcut: 'Shift D' },
    { label: 'Separate', op: 'curve.separate', shortcut: 'P' },
    { separator: true },
    { label: 'Extrude Curve and Move', op: 'curve.extrude_move', shortcut: 'E' },
    { label: 'Make Segment', op: 'curve.make_segment', shortcut: 'F' },
    { label: 'Subdivide', op: 'curve.subdivide' },
    { label: 'Toggle Cyclic', op: 'curve.cyclic_toggle', shortcut: 'Alt C' },
    { label: 'Switch Direction', op: 'curve.switch_direction' },
    { separator: true },
    { label: 'Set Spline Type', submenu: () => (['POLY', 'BEZIER', 'NURBS'] as const).map((t) => ({ label: t === 'BEZIER' ? 'Bézier' : t === 'POLY' ? 'Poly' : 'NURBS', op: 'curve.spline_type_set', props: { type: t } })) },
    { label: 'Set Handle Type', submenu: handleMenu },
    { separator: true },
    { label: 'Delete', submenu: deleteMenu },
  ];
}

function handleMenu(): MenuItem[] {
  return [
    { label: 'Automatic', op: 'curve.handle_type_set', props: { type: 'AUTOMATIC' } },
    { label: 'Vector', op: 'curve.handle_type_set', props: { type: 'VECTOR' } },
    { label: 'Aligned', op: 'curve.handle_type_set', props: { type: 'ALIGNED' } },
    { label: 'Free', op: 'curve.handle_type_set', props: { type: 'FREE_ALIGN' } },
    { separator: true },
    { label: 'Toggle Free/Align', op: 'curve.handle_type_set', props: { type: 'TOGGLE_FREE_ALIGN' } },
  ];
}

function deleteMenu(): MenuItem[] {
  return [
    { label: 'Vertices', op: 'curve.delete', props: { type: 'VERT' } },
    { label: 'Segments', op: 'curve.delete', props: { type: 'SEGMENT' } },
  ];
}

const prevEdit = modeMenus.EDIT;
modeMenus.EDIT = {
  ...prevEdit,
  header: () => (inCurveEdit() ? [['Curve', curveMenu], ['Control Points', () => [{ label: 'Extrude Curve and Move', op: 'curve.extrude_move', shortcut: 'E' }, { separator: true }, { label: 'Set Handle Type', submenu: handleMenu }]], ['Segments', () => [{ label: 'Subdivide', op: 'curve.subdivide' }, { label: 'Switch Direction', op: 'curve.switch_direction' }]]] : prevEdit?.header?.() ?? []),
  select: () => (inCurveEdit() ? [{ label: 'All', op: 'curve.select_all', props: { action: 'SELECT' }, shortcut: 'A' }, { label: 'None', op: 'curve.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' }, { label: 'Invert', op: 'curve.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' }, { separator: true }, { label: 'Select Linked', op: 'curve.select_linked', shortcut: 'Ctrl L' }] : prevEdit?.select?.() ?? []),
  add: () =>
    inCurveEdit()
      ? [
          { label: 'Bézier', icon: 'curve_bezcurve', op: 'curve.primitive_bezier_curve_add' },
          { label: 'Circle', icon: 'curve_bezcircle', op: 'curve.primitive_bezier_circle_add' },
          { separator: true },
          { label: 'Nurbs Curve', icon: 'curve_ncurve', op: 'curve.primitive_nurbs_curve_add' },
          { label: 'Nurbs Circle', icon: 'curve_ncircle', op: 'curve.primitive_nurbs_circle_add' },
          { label: 'Path', icon: 'curve_path', op: 'curve.primitive_nurbs_path_add' },
        ]
      : prevEdit?.add?.() ?? [],
  context: () => (inCurveEdit() ? curveMenu() : prevEdit?.context?.() ?? []),
  headerExtra: () => (inCurveEdit() ? null : prevEdit?.headerExtra?.() ?? null),
};

addKeys('Armature', [
  { key: 'A', op: 'curve.select_all', props: { action: 'SELECT' }, when: inCurveEdit },
  { key: 'A', alt: true, op: 'curve.select_all', props: { action: 'DESELECT' }, when: inCurveEdit },
  { key: 'I', ctrl: true, op: 'curve.select_all', props: { action: 'INVERT' }, when: inCurveEdit },
  { key: 'L', ctrl: true, op: 'curve.select_linked', when: inCurveEdit },
  { key: 'E', op: 'curve.extrude_move', when: inCurveEdit },
  { key: 'F', op: 'curve.make_segment', when: inCurveEdit },
  { key: 'C', alt: true, op: 'curve.cyclic_toggle', when: inCurveEdit },
  { key: 'D', shift: true, op: 'curve.duplicate_move', when: inCurveEdit },
  { key: 'P', op: 'curve.separate', when: inCurveEdit },
  { key: 'V', menu: handleMenu, menuTitle: 'Set Handle Type', when: inCurveEdit },
  { key: 'X', menu: deleteMenu, menuTitle: 'Delete', when: inCurveEdit },
  { key: 'DEL', menu: deleteMenu, menuTitle: 'Delete', when: inCurveEdit },
]);

// Ctrl + right click adds a control point
editModeHooks.context.push((v, e) => {
  if (!inCurveEdit() || !e.ctrlKey) return false;
  app.run('curve.vertex_add', {}, { area: v.area as never, event: { x: e.clientX, y: e.clientY } });
  return true;
});

curveEditHooks.addSpline = addSplineToEditedCurve;
