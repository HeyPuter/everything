// Curve Edit Mode operators: selection helpers (first/last, next/previous, more/less, random,
// checker, similar, linked pick, shortest path), split, dissolve, decimate, smoothing, radius /
// weight / tilt, handle recalculation, hide/reveal, shading, and the interactive radius & tilt.
import { Vector3, Matrix4 } from 'three';
import { app, registerOperators, type OpContext } from '../../app/app';
import { activeView3D, type View3D } from '../../editors/view3d/view3d';
import { activeCurve, inCurveEdit, recalcHandles, pickPoint, activePoint, setActivePoint, curveState } from './curve';
import { transformModes } from '../transformmodes';
import { startValueModal } from '../valuemodal';
import * as K from './curveops';
import type { CurveData } from '../../data/types';

const poll = () => inCurveEdit();
const cu = () => activeCurve()!.cu;
const recalcAll = (c: CurveData) => c.splines.forEach(recalcHandles);
const anySel = (c: CurveData) => c.splines.some((sp) => [...Array(K.pointCount(sp)).keys()].some((i) => K.isSel(sp, i)));
const pollSel = () => inCurveEdit() && anySel(cu());

/** Mouse position inside the 3D view the operator runs in. */
function viewMouse(ctx: OpContext): { v: View3D; x: number; y: number } | null {
  const v = (ctx.area?.editor as View3D | undefined) ?? activeView3D();
  if (!v || !(v as unknown as { project?: unknown }).project) return null;
  const r = v.el.getBoundingClientRect();
  const e = ctx.event ?? app.pointer;
  return { v, x: e.x - r.left, y: e.y - r.top };
}

registerOperators([
  {
    idname: 'curve.de_select_first',
    label: '(De)select First',
    description: 'Toggle the selection of the first point of each spline',
    poll,
    exec: () => K.toggleEnds(cu(), 'FIRST'),
  },
  {
    idname: 'curve.de_select_last',
    label: '(De)select Last',
    description: 'Toggle the selection of the last point of each spline',
    poll,
    exec: () => K.toggleEnds(cu(), 'LAST'),
  },
  {
    idname: 'curve.select_next',
    label: 'Select Next',
    description: 'Also select the point that follows each selected point',
    poll,
    exec: () => K.selectAdjacent(cu(), 'NEXT'),
  },
  {
    idname: 'curve.select_previous',
    label: 'Select Previous',
    description: 'Also select the point that precedes each selected point',
    poll,
    exec: () => K.selectAdjacent(cu(), 'PREVIOUS'),
  },
  {
    idname: 'curve.select_more',
    label: 'Select More',
    description: 'Grow the selection by one point along each spline',
    poll,
    exec: () => K.selectMore(cu()),
  },
  {
    idname: 'curve.select_less',
    label: 'Select Less',
    description: 'Shrink the selection by one point along each spline',
    poll,
    exec: () => K.selectLess(cu()),
  },
  {
    idname: 'curve.select_random',
    label: 'Select Random',
    description: 'Randomly select or deselect control points',
    props: [
      { id: 'ratio', label: 'Ratio', type: 'float', default: 0.5, min: 0, max: 1, subtype: 'factor' },
      { id: 'seed', label: 'Random Seed', type: 'int', default: 0, min: 0 },
      { id: 'action', label: 'Action', type: 'enum', default: 'SELECT', items: [['SELECT', 'Select'], ['DESELECT', 'Deselect']] },
    ],
    poll,
    exec: (_c, p) => K.selectRandom(cu(), p.ratio as number, p.seed as number, p.action as 'SELECT'),
  },
  {
    idname: 'curve.select_nth',
    label: 'Checker Deselect',
    description: 'Deselect every other run of selected points, counting from the active point',
    props: [
      { id: 'skip', label: 'Deselected', type: 'int', default: 1, min: 1 },
      { id: 'nth', label: 'Selected', type: 'int', default: 1, min: 1 },
      { id: 'offset', label: 'Offset', type: 'int', default: 0 },
    ],
    poll: pollSel,
    exec: (_c, p) => K.selectNth(cu(), p.skip as number, p.nth as number, p.offset as number, activePoint()),
  },
  {
    idname: 'curve.select_similar',
    label: 'Select Similar',
    description: 'Select points with a property similar to one of the selected points',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'WEIGHT', items: [['TYPE', 'Type'], ['RADIUS', 'Radius'], ['WEIGHT', 'Weight'], ['DIRECTION', 'Direction']] },
      { id: 'compare', label: 'Compare', type: 'enum', default: 'EQUAL', items: [['EQUAL', 'Equal'], ['GREATER', 'Greater'], ['LESS', 'Less']] },
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0.1, min: 0, max: 100 },
    ],
    poll: pollSel,
    exec: (_c, p) => (K.selectSimilar(cu(), p.type as 'TYPE', p.compare as 'EQUAL', p.threshold as number) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'curve.select_linked_pick',
    label: 'Select Linked',
    description: 'Select (or with Deselect, deselect) the spline under the mouse',
    props: [{ id: 'deselect', label: 'Deselect', type: 'bool', default: false }, { id: 'spline', label: 'Spline', type: 'int', default: -1, hidden: true }],
    poll,
    invoke: (ctx, p) => {
      const m = viewMouse(ctx);
      const hit = m ? pickPoint(m.v, m.x, m.y, 40) : null;
      if (!hit) return 'CANCELLED';
      app.run('curve.select_linked_pick', { deselect: p.deselect, spline: hit.s }, { invoke: false });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      if ((p.spline as number) < 0) return 'CANCELLED';
      K.selectSpline(cu(), p.spline as number, !!p.deselect);
    },
  },
  {
    idname: 'curve.shortest_path_pick',
    label: 'Pick Shortest Path',
    description: 'Select the points between the active point and the point under the mouse',
    poll: () => inCurveEdit() && !!activePoint(),
    invoke: (ctx) => {
      const m = viewMouse(ctx);
      const hit = m ? pickPoint(m.v, m.x, m.y, 40) : null;
      const act = activePoint();
      if (!hit || !act || !K.selectPath(cu(), act, hit)) return 'CANCELLED';
      setActivePoint(hit);
      return 'FINISHED';
    },
  },
  // ---- editing
  {
    idname: 'curve.split',
    label: 'Split',
    description: 'Split off the selected points into separate splines',
    poll: pollSel,
    exec: () => {
      const c = cu();
      if (!K.splitSelected(c).length) return 'CANCELLED';
      recalcAll(c);
      curveState.active = null;
    },
  },
  {
    idname: 'curve.dissolve_verts',
    label: 'Dissolve Vertices',
    description: 'Remove the selected control points while keeping the shape of the curve',
    poll: pollSel,
    exec: () => {
      const c = cu();
      K.dissolveVerts(c);
      recalcAll(c);
      curveState.active = null;
    },
  },
  {
    idname: 'curve.decimate',
    label: 'Decimate Curve',
    description: 'Simplify selected Bézier splines, removing the control points that matter least',
    props: [{ id: 'ratio', label: 'Ratio', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' }],
    poll: pollSel,
    exec: (_c, p) => {
      const c = cu();
      K.decimate(c, p.ratio as number);
      recalcAll(c);
      curveState.active = null;
    },
  },
  {
    idname: 'curve.smooth',
    label: 'Smooth',
    description: 'Smooth the positions of the selected control points',
    poll: pollSel,
    exec: () => {
      const c = cu();
      K.smoothPositions(c);
      recalcAll(c);
    },
  },
  {
    idname: 'curve.smooth_radius',
    label: 'Smooth Curve Radius',
    description: 'Even out the radius of the selected points',
    poll: pollSel,
    exec: () => K.smoothAttribute(cu(), 'radius'),
  },
  {
    idname: 'curve.smooth_tilt',
    label: 'Smooth Curve Tilt',
    description: 'Even out the tilt of the selected points',
    poll: pollSel,
    exec: () => K.smoothAttribute(cu(), 'tilt'),
  },
  {
    idname: 'curve.smooth_weight',
    label: 'Smooth Curve Weight',
    description: 'Even out the weight of the selected NURBS / poly points',
    poll: () => pollSel() && cu().splines.some((sp) => sp.type !== 'BEZIER'),
    exec: () => K.smoothAttribute(cu(), 'weight'),
  },
  {
    idname: 'curve.radius_set',
    label: 'Set Curve Radius',
    description: 'Set the radius of the selected control points',
    props: [{ id: 'radius', label: 'Radius', type: 'float', default: 1, min: 0, subtype: 'distance' }],
    poll: pollSel,
    exec: (_c, p) => K.setRadius(cu(), p.radius as number),
  },
  {
    idname: 'curve.spline_weight_set',
    label: 'Set Goal Weight',
    description: 'Set the weight of the selected NURBS / poly points',
    props: [{ id: 'weight', label: 'Weight', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' }],
    poll: () => pollSel() && cu().splines.some((sp) => sp.type !== 'BEZIER'),
    exec: (_c, p) => (K.setWeight(cu(), p.weight as number) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'curve.normals_make_consistent',
    label: 'Recalculate Handles',
    description: 'Point the handles of the selected control points along the curve again',
    props: [{ id: 'calc_length', label: 'Length', type: 'bool', default: false }],
    poll: pollSel,
    exec: (_c, p) => {
      const c = cu();
      K.makeNormalsConsistent(c, !!p.calc_length);
      recalcAll(c);
    },
  },
  {
    idname: 'curve.hide',
    label: 'Hide Selected',
    description: 'Hide the selected (or unselected) control points',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll,
    exec: (_c, p) => {
      K.hidePoints(cu(), !!p.unselected);
      curveState.active = null;
    },
  },
  {
    idname: 'curve.reveal',
    label: 'Reveal Hidden',
    description: 'Show all hidden control points',
    props: [{ id: 'select', label: 'Select', type: 'bool', default: true }],
    poll,
    exec: (_c, p) => K.revealPoints(cu(), !!p.select),
  },
  {
    idname: 'curve.shade_smooth',
    label: 'Shade Smooth',
    description: 'Smooth shading for the splines of the selected points',
    poll: pollSel,
    exec: () => K.setSmooth(cu(), true),
  },
  {
    idname: 'curve.shade_flat',
    label: 'Shade Flat',
    description: 'Flat shading for the splines of the selected points',
    poll: pollSel,
    exec: () => K.setSmooth(cu(), false),
  },
]);

// ---------------------------------------------------------------------------
// interactive radius (Alt S) and tilt (Ctrl T)

interface AttrSnapshot {
  pivot: Vector3;
  restore(): void;
  each(fn: (get: () => number, set: (v: number) => void, orig: number) => void): void;
}

function snapshot(key: 'radius' | 'tilt'): AttrSnapshot | null {
  const a = activeCurve();
  if (!a) return null;
  const w = app.graph.get(a.ob.id)?.world ?? new Matrix4();
  const items: { o: { radius: number; tilt: number }; v: number }[] = [];
  const pivot = new Vector3();
  for (const sp of a.cu.splines)
    for (let i = 0; i < K.pointCount(sp); i++) {
      if (!K.isSel(sp, i)) continue;
      const o = sp.type === 'BEZIER' ? sp.bezier_points[i] : sp.points[i];
      items.push({ o, v: o[key] });
      pivot.add(K.pointCo(sp, i).applyMatrix4(w));
    }
  if (!items.length) return null;
  pivot.multiplyScalar(1 / items.length);
  return {
    pivot,
    restore: () => items.forEach((it) => (it.o[key] = it.v)),
    each: (fn) => items.forEach((it) => fn(() => it.o[key], (v) => (it.o[key] = v), it.v)),
  };
}

function applyRadius(scale: number) {
  const s = snapshot('radius');
  s?.each((_g, set, orig) => set(Math.max(0, orig * scale)));
}
function applyTilt(delta: number) {
  const s = snapshot('tilt');
  s?.each((_g, set, orig) => set(orig + delta));
}

transformModes.CURVE_SHRINKFATTEN = {
  label: 'Curve Radius',
  poll: () => pollSel(),
  invoke: (ctx, p) => {
    const s = snapshot('radius');
    if (!s) return 'CANCELLED';
    const ok = startValueModal({
      label: 'Radius',
      kind: 'SCALE',
      pivot: s.pivot,
      event: ctx.event,
      apply: (v) => s.each((_g, set, orig) => set(Math.max(0, orig * v))),
      restore: s.restore,
      redo: (v) => ({ idname: 'transform.transform', props: { mode: 'CURVE_SHRINKFATTEN', value: v } }),
      text: (v, t) => `Shrink/Fatten: ${t ? t + '|' : v.toFixed(3)}`,
      releaseConfirm: !!p.release_confirm,
    });
    return ok ? 'RUNNING_MODAL' : 'CANCELLED';
  },
  exec: (_c, p) => applyRadius(p.value as number),
};

registerOperators([
  {
    idname: 'transform.tilt',
    label: 'Tilt',
    description: 'Twist the selected control points around the curve',
    props: [{ id: 'value', label: 'Angle', type: 'float', default: 0, subtype: 'angle' }, { id: 'release_confirm', label: 'Confirm on Release', type: 'bool', default: false, hidden: true }],
    poll: pollSel,
    invoke: (ctx, p) => {
      const s = snapshot('tilt');
      if (!s) return 'CANCELLED';
      const ok = startValueModal({
        label: 'Tilt',
        kind: 'ANGLE',
        pivot: s.pivot,
        event: ctx.event,
        apply: (v) => s.each((_g, set, orig) => set(orig + v)),
        restore: s.restore,
        redo: (v) => ({ idname: 'transform.tilt', props: { value: v } }),
        text: (v, t) => `Tilt: ${t ? t + '|' : ((v * 180) / Math.PI).toFixed(2) + '°'}`,
        releaseConfirm: !!p.release_confirm,
      });
      return ok ? 'RUNNING_MODAL' : 'CANCELLED';
    },
    exec: (_c, p) => applyTilt(p.value as number),
  },
]);
