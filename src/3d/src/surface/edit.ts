// Surface Edit Mode: the control point grid in the viewport (lines along U and V, points), click /
// box / circle / lasso selection, transforms (with proportional editing over the grid), the gizmo
// centre and View Selected, entering the mode and its toolbar.
import { Matrix3, Matrix4, Vector3, Box3 } from 'three';
import { app, onAppReady, operators, registerOperator } from '../app/app';
import { editModeHooks, type SelectRegion } from '../editors/view3d/hooks';
import type { View3D } from '../editors/view3d/view3d';
import { h, type VNode } from '../ui/h';
import type { CurveData, ObjectData, Spline } from '../data/types';
import { transformProviders, type TElement } from '../ops/transform';
import { setGizmoCenterHook, gizmoCenterHook } from '../editors/view3d/gizmo';
import { frameHooks } from '../ops/view3d';
import { modeHandlers } from '../ops/modes';
import { inSelectRegion } from '../editors/view3d/selectshapes';
import { MODE_ITEMS } from '../editors/view3d/header';
import { toolsByMode, COMMON_TOOLS } from '../editors/view3d/toolbar';
import { activeTools } from '../app/prefs';
import { activeElementHooks } from '../modes/editxform';
import { proportionalWeights } from '../modes/proportional';
import { gridSize } from './nurbs';
import { neighbours } from './grid';

export function activeSurface(): { ob: ObjectData; cu: CurveData } | null {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'SURFACE' || !ob.data) return null;
  const cu = app.doc.curves[ob.data];
  return cu ? { ob, cu } : null;
}
export const inSurfaceEdit = () => app.doc.mode === 'EDIT' && !!activeSurface();

export const world = (ob: ObjectData) => app.graph.get(ob.id)?.world ?? new Matrix4();
const V3 = (a: ArrayLike<number>) => new Vector3(a[0], a[1], a[2]);

export interface PointRef {
  s: number;
  i: number;
}

/** Active (last clicked) point and the direction Select Control Point Row used last on it. */
export const surfaceState: { active: PointRef | null; rowDir: 'U' | 'V' } = { active: null, rowDir: 'V' };

export function allPoints(cu: CurveData): PointRef[] {
  const out: PointRef[] = [];
  cu.splines.forEach((sp, s) => {
    if (sp.hide) return;
    sp.points.forEach((p, i) => !p.hide && out.push({ s, i }));
  });
  return out;
}

const pointWorld = (cu: CurveData, r: PointRef, w: Matrix4) => V3(cu.splines[r.s].points[r.i].co).applyMatrix4(w);

export function deselectAll(cu: CurveData) {
  for (const sp of cu.splines) for (const p of sp.points) p.select = false;
}

function pick(v: View3D, x: number, y: number, radius = 12): PointRef | null {
  const a = activeSurface();
  if (!a) return null;
  const w = world(a.ob);
  let best: PointRef | null = null,
    bd = radius;
  for (const r of allPoints(a.cu)) {
    const p = v.project(pointWorld(a.cu, r, w));
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  return best;
}
export { pick as pickSurfacePoint };

editModeHooks.pick.push((v, x, y, o) => {
  if (!inSurfaceEdit()) return false;
  const { cu } = activeSurface()!;
  const hit = pick(v, x, y);
  if (!o.extend) deselectAll(cu);
  if (hit) {
    const p = cu.splines[hit.s].points[hit.i];
    const on = !(o.toggle && p.select);
    p.select = on;
    surfaceState.active = on ? hit : null;
  } else surfaceState.active = null;
  app.pushUndo('Select');
  app.changed('select', 'doc');
  return true;
});

function regionSelect(v: View3D, r: SelectRegion, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR', label: string) {
  const { ob, cu } = activeSurface()!;
  const w = world(ob);
  for (const ref of allPoints(cu)) {
    const p = v.project(pointWorld(cu, ref, w));
    const hit = p.z <= 1 && inSelectRegion(r, p.x, p.y);
    const pt = cu.splines[ref.s].points[ref.i];
    const cur = !!pt.select;
    pt.select = mode === 'SET' ? hit : mode === 'ADD' ? cur || hit : mode === 'SUB' ? cur && !hit : mode === 'AND' ? cur && hit : cur !== hit;
  }
  app.pushUndo(label);
  app.changed('select', 'doc');
  return true;
}
editModeHooks.box.push((v, x0, y0, x1, y1, mode) => (inSurfaceEdit() ? regionSelect(v, { kind: 'box', x0, y0, x1, y1 }, mode, 'Box Select') : false));
editModeHooks.region.push((v, r, mode) => (inSurfaceEdit() ? regionSelect(v, r, mode, r.kind === 'circle' ? 'Circle Select' : 'Lasso Select') : false));

// ---------------------------------------------------------------------------
// drawing: the control grid

const LINE = '#97a0fd',
  LINE_SEL = '#f5d34a',
  PT = '#000000',
  PT_SEL = '#f58e04',
  PT_ACT = '#ffffff';

/** Grid segments of a spline as index pairs (U rows, V columns, closing segments of closed directions). */
export function gridSegments(sp: Spline): [number, number][] {
  const { u, v } = gridSize(sp);
  const segs: [number, number][] = [];
  for (let j = 0; j < v; j++)
    for (let i = 0; i < u; i++) {
      const k = j * u + i;
      if (i + 1 < u) segs.push([k, k + 1]);
      else if (sp.use_cyclic_u && u > 2) segs.push([k, j * u]);
      if (j + 1 < v) segs.push([k, k + u]);
      else if (sp.use_cyclic_v && v > 2) segs.push([k, i]);
    }
  return segs;
}

editModeHooks.svg.push((v) => {
  if (!inSurfaceEdit()) return null;
  const { ob, cu } = activeSurface()!;
  const w = world(ob);
  const lines: VNode[] = [],
    dots: VNode[] = [];
  cu.splines.forEach((sp, s) => {
    if (sp.hide) return;
    const P = sp.points.map((p) => v.project(V3(p.co).applyMatrix4(w)));
    for (const [a, b] of gridSegments(sp)) {
      if (sp.points[a].hide || sp.points[b].hide || P[a].z > 1 || P[b].z > 1) continue;
      const sel = sp.points[a].select && sp.points[b].select;
      lines.push(h('line', { x1: P[a].x, y1: P[a].y, x2: P[b].x, y2: P[b].y, stroke: sel ? LINE_SEL : LINE, 'stroke-width': 1, opacity: sel ? 0.9 : 0.7 }));
    }
    sp.points.forEach((p, i) => {
      if (p.hide || P[i].z > 1) return;
      const act = surfaceState.active?.s === s && surfaceState.active.i === i;
      dots.push(h('circle', { cx: P[i].x, cy: P[i].y, r: 3.5, fill: p.select ? (act ? PT_ACT : PT_SEL) : PT, stroke: '#000000', 'stroke-width': 0.8 }));
    });
  });
  return h('g', { class: 'surface-edit' }, lines, dots);
});

// ---------------------------------------------------------------------------
// transforms

transformProviders.push({
  collect({ proportional, connected }) {
    if (!inSurfaceEdit()) return null;
    const { ob, cu } = activeSurface()!;
    const refs = allPoints(cu);
    const sel = refs.map((r) => !!cu.splines[r.s].points[r.i].select);
    if (!sel.some(Boolean)) return null;
    const w = world(ob),
      inv = w.clone().invert();
    const before = structuredClone(cu.splines);
    const basis = new Matrix3().setFromMatrix4(w);
    const restore = () => {
      cu.splines = structuredClone(before);
    };
    const move = (r: PointRef, m: Matrix4) => {
      const c0 = before[r.s].points[r.i].co;
      const q = V3(c0).applyMatrix4(w).applyMatrix4(m).applyMatrix4(inv);
      cu.splines[r.s].points[r.i].co = [q.x, q.y, q.z, c0[3]];
    };
    const pts = refs.map((r) => pointWorld(cu, r, w));
    const els: TElement[] = [];
    refs.forEach((r, k) => sel[k] && els.push({ center: pts[k], basis, weight: 1, apply: (m: Matrix4) => move(r, m), restore } as TElement));
    if (proportional) {
      const index = new Map(refs.map((r, k) => [`${r.s}:${r.i}`, k]));
      const nb = (k: number) => {
        const r = refs[k];
        return neighbours(cu.splines[r.s], r.i)
          .map((j) => index.get(`${r.s}:${j}`))
          .filter((x): x is number => x !== undefined);
      };
      const { weight, dist } = proportionalWeights(pts, sel, connected, nb);
      refs.forEach((r, k) => {
        if (sel[k] || !weight[k]) return;
        els.push({ center: pts[k], basis, weight: weight[k], distance: dist[k], apply: (m: Matrix4) => move(r, m), restore } as TElement);
      });
    }
    const act = surfaceState.active && cu.splines[surfaceState.active.s]?.points[surfaceState.active.i] ? pointWorld(cu, surfaceState.active, w) : undefined;
    return { elements: els, active: act, label: 'Surface', finish() {}, cancel() {}, onUpdate: () => app.changed('doc', 'geometry') };
  },
});

export function selectedWorldPoints(): Vector3[] {
  const a = inSurfaceEdit() ? activeSurface() : null;
  if (!a) return [];
  const w = world(a.ob);
  return allPoints(a.cu)
    .filter((r) => a.cu.splines[r.s].points[r.i].select)
    .map((r) => pointWorld(a.cu, r, w));
}

const prevGizmo = gizmoCenterHook;
setGizmoCenterHook(() => {
  if (inSurfaceEdit()) {
    const pts = selectedWorldPoints();
    if (!pts.length) return null;
    const c = new Vector3();
    pts.forEach((p) => c.add(p));
    return { center: c.multiplyScalar(1 / pts.length) };
  }
  return prevGizmo?.() ?? null;
});

frameHooks.unshift(() => {
  if (!inSurfaceEdit()) return null;
  const pts = selectedWorldPoints();
  return pts.length ? new Box3().setFromPoints(pts) : null;
});

activeElementHooks.push(() => {
  const a = inSurfaceEdit() ? activeSurface() : null;
  const r = surfaceState.active;
  if (!a || !r || !a.cu.splines[r.s]?.points[r.i]?.select) return null;
  return pointWorld(a.cu, r, world(a.ob));
});

// ---------------------------------------------------------------------------
// mode switching, toolbar

const prevEdit = modeHandlers.EDIT;
modeHandlers.EDIT = {
  ...prevEdit,
  enter(ob) {
    if (ob.type !== 'SURFACE') return prevEdit?.enter ? prevEdit.enter(ob) : true;
    if (!ob.data || !app.doc.curves[ob.data]) return false;
    surfaceState.active = null;
    const ids = new Set(toolsByMode.EDIT_SURFACE.filter(Boolean).map((t) => t!.id));
    const cur = activeTools.EDIT;
    if (cur && !cur.startsWith('builtin.select') && !ids.has(cur)) activeTools.EDIT = 'builtin.select_box';
    return true;
  },
};

toolsByMode.EDIT_SURFACE = [...COMMON_TOOLS];

const editItem = MODE_ITEMS.find((m) => m.mode === 'EDIT');
if (editItem && !editItem.types.includes('SURFACE')) editItem.types.push('SURFACE');

// Tab toggles Edit Mode for surfaces too
onAppReady(() => {
  const base = operators.get('object.editmode_toggle');
  if (!base) return;
  registerOperator({ ...base, poll: (ctx) => app.activeObject?.type === 'SURFACE' || (base.poll ? base.poll(ctx) : true) });
});
