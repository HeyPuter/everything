// Interactive transform operators (move / rotate / scale and the other transform tools).
//
// A transform runs in two halves that share the same math:
// - a modal session (startTransform) turns mouse motion, typed numbers, constraints and snapping
//   into a TState, applies it, and on confirm offers the equivalent operator call for
//   Adjust Last Operation;
// - the operators' exec() rebuilds the TState from their properties and applies it once.
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { app, onAppReady, operators, registerOperator, registerOperators, type ModalHandler, type Operator, type PropDef } from '../app/app';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { prefs } from '../app/prefs';
import type { ObjectData } from '../data/types';
import { applyMatrixToObject, toMatrix4, localMatrix } from '../eval/transform';
import { insertKeyframesForObjects } from '../anim/keyframes';
import { renderContext } from '../render/context';
import { findSnapTarget, snapIndicator, type SnapElement } from './snap';
import { editModeHooks } from '../editors/view3d/hooks';
import { h, type VNode } from '../ui/h';
import { currentOrientation, orientationBasis, orientationLabel } from './orientations';
import { BUILTIN_ORIENTATIONS } from './orientation_list';
import { around, basisAxis, bendMatrix, evalNumeric, falloffWeight, randomOffset, seededRandom, shearMatrix, toSpherePoint, warpPoint, type BendFrame } from './transform_math';

export type TransformMode = 'TRANSLATION' | 'ROTATION' | 'RESIZE' | 'TRACKBALL' | 'SHRINKFATTEN' | 'TOSPHERE' | 'SHEAR' | 'PUSHPULL' | 'EDGESLIDE' | 'BEND' | 'WARP' | 'TILT' | 'CURVE_SHRINKFATTEN' | 'GPENCIL_OPACITY' | 'MIRROR';

/** Modes that change a per-element value (curve tilt / radius) instead of positions. */
const VALUE_MODES = new Set<TransformMode>(['TILT', 'CURVE_SHRINKFATTEN', 'GPENCIL_OPACITY']);

/** Providers for the value modes (radius / opacity / tilt) of other data types, consulted first. */
export const valueProviders: TProvider[] = [];

/** An item being transformed. All math happens in world space. */
export interface TElement {
  /** world-space position used for pivot computations */
  center: Vector3;
  /** orientation basis for local constraints (world space, columns = axes) */
  basis: Matrix3;
  /** proportional influence 0..1 (1 = selected) */
  weight: number;
  /** distance to selection for proportional editing (world units) */
  distance?: number;
  /** apply a world-space matrix relative to the initial state (pivot already baked) */
  apply(m: Matrix4, ctx: { mode: TransformMode; value: number[] }): void;
  restore(): void;
  /** normal for shrink/fatten (world) */
  normal?: Vector3;
  /** pivot used with Individual Origins when it differs from `center` (e.g. a selected face region's center) */
  origin?: Vector3;
}

export interface TProvider {
  /** collect elements for the current mode; return null if not applicable */
  collect(opts: { proportional: boolean; connected: boolean; individual: boolean; mode?: TransformMode }): { elements: TElement[]; active?: Vector3; label: string; finish(): void; cancel(): void; onUpdate?(): void } | null;
}

export const transformProviders: TProvider[] = [];
/** Adjust an object's new loc/rot/scale while it is being transformed (e.g. limit constraints that affect transforms). */
export const objectTransformFilters: ((ob: ObjectData) => void)[] = [];

type Collected = NonNullable<ReturnType<TProvider['collect']>>;

// ---------------------------------------------------------------------------
// Objects provider

function objectWorld(ob: ObjectData) {
  return app.graph.get(ob.id)?.world.clone() ?? new Matrix4();
}

function hasSelectedAncestor(ob: ObjectData, set: Set<string>) {
  let p = ob.parent;
  while (p) {
    if (set.has(p)) return true;
    p = app.doc.objects[p]?.parent ?? null;
  }
  return false;
}

function snapshotTransform(ob: ObjectData) {
  return { location: [...ob.location], rotation_euler: [...ob.rotation_euler], rotation_quaternion: [...ob.rotation_quaternion], rotation_axis_angle: [...ob.rotation_axis_angle], scale: [...ob.scale] };
}

function objectElement(ob: ObjectData, ids: Set<string>, weight: number, distance?: number): TElement {
  const w0 = objectWorld(ob);
  const before = snapshotTransform(ob);
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  w0.decompose(p, q, s);
  const basis = new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(q));
  const parentEv = ob.parent ? app.graph.get(ob.parent) : undefined;
  const parentMat = parentEv ? parentEv.world.clone().multiply(toMatrix4(ob.matrix_parent_inverse)) : new Matrix4();
  const parentInv = parentMat.clone().invert();
  // constraints offset: compare evaluated world with world basis (pre-constraint)
  const basisWorld = app.graph.get(ob.id)?.worldBasis.clone() ?? w0.clone();
  const constraintFix = basisWorld.clone().multiply(w0.clone().invert());
  const ts = app.doc.scene.tool_settings;
  // Affect Only Origins: the object data is counter-transformed so the geometry stays in place
  const originOnly = !!ts.use_transform_data_origin && dataUsers(ob) === 1 ? originCompensator(ob) : null;
  // Affect Only Parents: direct children keep their world transform
  const children = ts.use_transform_skip_children
    ? Object.values(app.doc.objects)
        .filter((c) => c.parent === ob.id && !ids.has(c.id))
        .map((c) => ({ c, world: objectWorld(c), mpi: toMatrix4(c.matrix_parent_inverse), before: snapshotTransform(c) }))
    : [];
  return {
    center: p,
    basis,
    weight,
    distance,
    apply(m: Matrix4) {
      let target = m.clone().multiply(w0);
      // Affect Only Locations: rotating / scaling around the pivot moves the object without turning or resizing it
      if ((ts as { use_transform_pivot_point_align?: boolean }).use_transform_pivot_point_align) {
        const tp = new Vector3().setFromMatrixPosition(target);
        target = new Matrix4().compose(tp, q, s);
      }
      const unconstrained = constraintFix.clone().multiply(target);
      const local = parentInv.clone().multiply(unconstrained);
      Object.assign(ob, cloneBefore(before));
      applyMatrixToObject(ob, local);
      // respect transform locks
      for (let i = 0; i < 3; i++) {
        if (ob.lock_location[i]) ob.location[i] = before.location[i];
        if (ob.lock_rotation[i]) {
          ob.rotation_euler[i] = before.rotation_euler[i];
          if (ob.rotation_mode === 'QUATERNION') ob.rotation_quaternion[i + 1] = before.rotation_quaternion[i + 1];
        }
        if (ob.lock_scale[i]) ob.scale[i] = before.scale[i];
      }
      for (const f of objectTransformFilters) f(ob);
      originOnly?.apply();
      if (children.length) {
        const newWorld = parentMat.clone().multiply(localMatrix(ob, new Matrix4()));
        for (const ch of children) {
          Object.assign(ch.c, cloneBefore(ch.before));
          applyMatrixToObject(ch.c, newWorld.clone().multiply(ch.mpi).invert().multiply(ch.world));
        }
      }
    },
    restore() {
      Object.assign(ob, cloneBefore(before));
      originOnly?.restore();
      for (const ch of children) Object.assign(ch.c, cloneBefore(ch.before));
    },
  };
}

const objectProvider: TProvider = {
  collect({ proportional }) {
    if (app.doc.mode !== 'OBJECT') return null;
    const sel = app.selectedObjects().filter((o) => app.isSelectable(o.id) || o.select);
    if (!sel.length) return null;
    const ids = new Set(sel.map((o) => o.id));
    const roots = sel.filter((o) => !hasSelectedAncestor(o, ids));
    const elements: TElement[] = roots.map((ob) => objectElement(ob, ids, 1, 0));
    const moved = [...roots];
    if (proportional) {
      // unselected objects near the selection follow with a falloff
      const ts = app.doc.scene.tool_settings;
      const radius = Math.max(1e-6, ts.proportional_size);
      const centers = elements.map((e) => e.center);
      const rand = seededRandom(1);
      for (const ob of Object.values(app.doc.objects)) {
        if (ids.has(ob.id) || !app.isVisible(ob.id) || hasSelectedAncestor(ob, ids)) continue;
        const p = new Vector3().setFromMatrixPosition(objectWorld(ob));
        let d = Infinity;
        for (const c of centers) d = Math.min(d, c.distanceTo(p));
        if (d >= radius) continue;
        const w = falloffWeight(ts.proportional_edit_falloff, d / radius, rand);
        if (w <= 0) continue;
        elements.push(objectElement(ob, ids, w, d));
        moved.push(ob);
      }
    }
    const act = app.activeObject;
    return {
      elements,
      active: act && ids.has(act.id) ? new Vector3().setFromMatrixPosition(objectWorld(act)) : undefined,
      label: 'Object',
      finish() {
        if (app.doc.scene.tool_settings.use_keyframe_insert_auto) insertKeyframesForObjects(moved, 'Available');
      },
      cancel() {},
    };
  },
};

/** Number of objects sharing an object's data-block. */
function dataUsers(ob: ObjectData) {
  if (!ob.data) return 0;
  return Object.values(app.doc.objects).filter((o) => o.data === ob.data).length;
}

/** Keeps mesh / curve / lattice geometry fixed in world space while the object's transform changes. */
function originCompensator(ob: ObjectData) {
  const doc = app.doc;
  const L0 = localMatrix(ob, new Matrix4());
  const me = ob.type === 'MESH' && ob.data ? doc.meshes[ob.data] : undefined;
  const cu = (ob.type === 'CURVE' || ob.type === 'FONT') && ob.data ? doc.curves[ob.data] : undefined;
  if (!me && !(cu && ob.type === 'CURVE')) return null;
  const pos0 = me ? me.positions.slice() : null;
  const keys0 = me ? me.shape_keys.map((k) => k.data.slice()) : [];
  const splines0 = cu ? structuredClone(cu.splines) : null;
  const tp = (m: Matrix4, src: ArrayLike<number>, dst: { [i: number]: number }, n: number) => {
    const v = new Vector3();
    for (let i = 0; i < n; i += 3) {
      v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(m);
      dst[i] = v.x;
      dst[i + 1] = v.y;
      dst[i + 2] = v.z;
    }
  };
  return {
    apply() {
      const comp = localMatrix(ob, new Matrix4()).invert().multiply(L0);
      if (me && pos0) {
        const P = new Float32Array(pos0.length);
        tp(comp, pos0, P, pos0.length);
        me.positions = P;
        me.shape_keys.forEach((k, i) => {
          const d = new Float32Array(keys0[i].length);
          tp(comp, keys0[i], d, d.length);
          k.data = d;
        });
      }
      if (cu && splines0) {
        cu.splines = structuredClone(splines0);
        const v = new Vector3();
        const t3 = (a: number[]) => {
          v.set(a[0], a[1], a[2]).applyMatrix4(comp);
          a[0] = v.x;
          a[1] = v.y;
          a[2] = v.z;
        };
        for (const sp of cu.splines) {
          for (const b of sp.bezier_points) {
            t3(b.co);
            t3(b.handle_left);
            t3(b.handle_right);
          }
          for (const p of sp.points) t3(p.co);
        }
      }
      app.changed('geometry');
    },
    restore() {
      if (me && pos0) {
        me.positions = pos0.slice();
        me.shape_keys.forEach((k, i) => (k.data = keys0[i].slice()));
      }
      if (cu && splines0) cu.splines = structuredClone(splines0);
      app.changed('geometry');
    },
  };
}

function cloneBefore(b: Record<string, number[]>) {
  const o: Record<string, number[]> = {};
  for (const k in b) o[k] = [...b[k]];
  return o as unknown as Partial<ObjectData>;
}

transformProviders.push(objectProvider);

// ---------------------------------------------------------------------------
// Session & state

const AXIS_NAMES = ['X', 'Y', 'Z'];

/** The transform being applied, independent of how it was produced (mouse, typed or redo). */
export interface TState {
  mode: TransformMode;
  /** mode specific: vector in orientation space (move / scale), angles in radians, factors, distances */
  value: number[];
  /** free axes of an axis/plane constraint (orientation space), null when unconstrained */
  axes: boolean[] | null;
  orientType: string;
  /** orientation basis (world, columns = axes) */
  basis: Matrix3;
  /** rotation / shear axis index */
  orientAxis: number;
  /** shear displacement axis index */
  orientAxisOrtho: number;
  /** pivot override (bend / warp use the 3D cursor) */
  center?: Vector3;
  /** bend frame (direction & length of the bent region) */
  bend?: { dir: Vector3; length: number };
  /** warp extents along the view's right axis */
  warp?: { min: number; max: number; offset: number };
  /** Align Rotation to Target: turn moved elements so their Z axis follows this surface normal */
  alignNormal?: Vector3;
}

interface Session {
  data: Collected;
  pivot: Vector3;
  sel: TElement[];
  /** Local orientation uses each object's own axes */
  perElement: boolean;
  individual: boolean;
  /** average distance of the selection from the pivot (To Sphere) */
  radius: number;
}

function proportionalEnabled() {
  const ts = app.doc.scene.tool_settings;
  return app.doc.mode === 'OBJECT' ? ts.use_proportional_edit_objects : ts.use_proportional_edit;
}

function collect(mode?: TransformMode): Collected | null {
  // world matrices come from the evaluated scene: make sure earlier edits are evaluated
  if (app.hasPending) app.flush();
  const ts = app.doc.scene.tool_settings;
  const proportional = proportionalEnabled();
  // value modes (tilt, radius) have their own element type
  if (mode && VALUE_MODES.has(mode)) {
    for (const vp of valueProviders) {
      const d = vp.collect({ proportional, connected: false, individual: false, mode });
      if (d && d.elements.length) return d;
    }
    return valueProvider.collect({ proportional, connected: false, individual: false, mode });
  }
  for (let i = transformProviders.length - 1; i >= 0; i--) {
    const d = transformProviders[i].collect({ proportional, connected: ts.use_proportional_connected, individual: ts.transform_pivot_point === 'INDIVIDUAL_ORIGINS', mode });
    if (d && d.elements.length) return d;
  }
  return null;
}

function computePivot(d: Collected): Vector3 {
  const ts = app.doc.scene.tool_settings;
  const sel = d.elements.filter((e) => e.weight >= 1);
  const pivot = new Vector3();
  const pp = ts.transform_pivot_point;
  if (pp === 'CURSOR') return pivot.fromArray(app.doc.scene.cursor.location);
  if (pp === 'ACTIVE_ELEMENT' && d.active) return pivot.copy(d.active);
  if (pp === 'BOUNDING_BOX_CENTER') {
    const min = new Vector3(Infinity, Infinity, Infinity),
      max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const e of sel) {
      min.min(e.center);
      max.max(e.center);
    }
    return sel.length ? pivot.addVectors(min, max).multiplyScalar(0.5) : pivot;
  }
  for (const e of sel) pivot.add(e.center);
  return pivot.multiplyScalar(1 / Math.max(1, sel.length));
}

function openSession(mode: TransformMode): Session | null {
  const d = collect(mode);
  if (!d) return null;
  const pivot = computePivot(d);
  const sel = d.elements.filter((e) => e.weight >= 1);
  const radius = sel.reduce((s, e) => s + e.center.distanceTo(pivot), 0) / Math.max(1, sel.length);
  return {
    data: d,
    pivot,
    sel,
    perElement: d.label === 'Object' || app.doc.mode === 'POSE',
    individual: app.doc.scene.tool_settings.transform_pivot_point === 'INDIVIDUAL_ORIGINS' && (mode === 'ROTATION' || mode === 'RESIZE' || mode === 'TRACKBALL'),
    radius,
  };
}

function orthonormalBasis(b: Matrix3): Matrix3 {
  const x = basisAxis(b, 0),
    y0 = basisAxis(b, 1);
  const z = new Vector3().crossVectors(x, y0).normalize();
  const y = new Vector3().crossVectors(z, x).normalize();
  return new Matrix3().set(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z);
}

const T = (p: Vector3) => new Matrix4().makeTranslation(p.x, p.y, p.z);

/** Value with unconstrained components neutralised (0 for vectors, 1 for scale). */
function maskedValue(st: TState): number[] {
  const neutral = st.mode === 'RESIZE' ? 1 : 0;
  return [0, 1, 2].map((i) => (st.axes && !st.axes[i] ? neutral : st.value[i] ?? neutral));
}

/** World matrix applied to one element for a state. */
function elementMatrix(s: Session, st: TState, e: TElement): Matrix4 {
  const w = e.weight;
  // Local constraints follow each object's own axes; free moves are shared by all elements
  const B = s.perElement && st.orientType === 'LOCAL' && st.axes ? orthonormalBasis(e.basis) : st.basis;
  const center = s.individual ? e.origin ?? e.center : st.center ?? s.pivot;
  switch (st.mode) {
    case 'TRANSLATION': {
      const v = maskedValue(st);
      const move = T(new Vector3(v[0], v[1], v[2]).applyMatrix3(B).multiplyScalar(w));
      if (st.alignNormal && w >= 1) {
        // rotate around the element's own center so its Z axis points along the target normal
        const z = basisAxis(e.basis, 2);
        const q = new Quaternion().setFromUnitVectors(z, st.alignNormal.clone().normalize());
        return move.multiply(around(e.center, new Matrix4().makeRotationFromQuaternion(q)));
      }
      return move;
    }
    case 'ROTATION':
      return around(center, new Matrix4().makeRotationAxis(basisAxis(B, st.orientAxis), (st.value[0] ?? 0) * w));
    case 'TRACKBALL': {
      const rx = new Matrix4().makeRotationAxis(basisAxis(B, 0), (st.value[0] ?? 0) * w);
      const ry = new Matrix4().makeRotationAxis(basisAxis(B, 1), (st.value[1] ?? 0) * w);
      return around(center, ry.multiply(rx));
    }
    case 'RESIZE': {
      const v = maskedValue(st).map((x) => 1 + (x - 1) * w);
      const b4 = new Matrix4().setFromMatrix3(B);
      return around(center, b4.clone().multiply(new Matrix4().makeScale(v[0], v[1], v[2])).multiply(b4.clone().invert()));
    }
    case 'SHEAR': {
      const along = basisAxis(B, st.orientAxisOrtho);
      const measure = new Vector3().crossVectors(basisAxis(B, st.orientAxis), along).normalize();
      return shearMatrix(center, along, measure, (st.value[0] ?? 0) * w);
    }
    case 'BEND': {
      if (!st.bend) return new Matrix4();
      const origin = st.center ?? s.pivot;
      const side = new Vector3().crossVectors(basisAxis(B, 2), st.bend.dir).normalize();
      const frame: BendFrame = { origin, dir: st.bend.dir, side, length: st.bend.length * (st.value[1] ?? 1) };
      return bendMatrix(frame, (st.value[0] ?? 0) * w, e.center);
    }
    case 'TOSPHERE': {
      const target = toSpherePoint(e.center, s.pivot, s.radius, Math.max(0, Math.min(1, st.value[0] ?? 0)) * w);
      return T(target.sub(e.center));
    }
    case 'PUSHPULL': {
      const dir = e.center.clone().sub(s.pivot);
      const len = dir.length();
      return len < 1e-9 ? new Matrix4() : T(dir.multiplyScalar(((st.value[0] ?? 0) * w) / len));
    }
    case 'SHRINKFATTEN':
      return T((e.normal ?? new Vector3()).clone().multiplyScalar((st.value[0] ?? 0) * w));
    case 'TILT':
    case 'CURVE_SHRINKFATTEN':
    case 'GPENCIL_OPACITY':
      return new Matrix4();
    case 'MIRROR': {
      // scale by -1 along the constrained axes
      const sv = [0, 1, 2].map((i) => (st.axes?.[i] ? -1 : 1));
      const b4 = new Matrix4().setFromMatrix3(B);
      return around(center, b4.clone().multiply(new Matrix4().makeScale(sv[0], sv[1], sv[2])).multiply(b4.clone().invert()));
    }
    case 'WARP': {
      const c = st.center ?? s.pivot;
      const wp = st.warp ?? { min: -1, max: 1, offset: 0 };
      const target = warpPoint(e.center, c, B, st.value[0] ?? 0, wp.offset, wp.min, wp.max);
      return T(target.sub(e.center).multiplyScalar(w));
    }
  }
  return new Matrix4();
}

/** Apply a state to all elements of a session. */
function applyState(s: Session, st: TState) {
  for (const e of s.data.elements) {
    let m = elementMatrix(s, st, e);
    // translation & rotation & scale with proportional weights are blended inside elementMatrix
    if (!Number.isFinite(m.elements[0])) m = new Matrix4();
    e.apply(m, { mode: st.mode, value: st.value });
  }
  s.data.onUpdate?.();
  app.changed('doc');
}

/** Warp extents: the selection's span along the view's right axis, relative to the center. */
function warpExtents(s: Session, center: Vector3, basis: Matrix3) {
  const right = basisAxis(basis, 0);
  let min = Infinity,
    max = -Infinity;
  for (const e of s.sel) {
    const x = e.center.clone().sub(center).dot(right);
    min = Math.min(min, x);
    max = Math.max(max, x);
  }
  return Number.isFinite(min) ? { min, max } : { min: -1, max: 1 };
}

// ---------------------------------------------------------------------------
// Operator properties

const ORIENT_ITEMS = BUILTIN_ORIENTATIONS.map(([id, label]) => [id, label] as [string, string]);
const AXIS_ITEMS: [string, string][] = [
  ['X', 'X'],
  ['Y', 'Y'],
  ['Z', 'Z'],
];
const FALLOFF_ITEMS: [string, string][] = [
  ['SMOOTH', 'Smooth'],
  ['SPHERE', 'Sphere'],
  ['ROOT', 'Root'],
  ['INVERSE_SQUARE', 'Inverse Square'],
  ['SHARP', 'Sharp'],
  ['LINEAR', 'Linear'],
  ['CONSTANT', 'Constant'],
  ['RANDOM', 'Random'],
];
const propOn = (p: Record<string, unknown>) => !!p.use_proportional_edit;
const PROPORTIONAL_PROPS: PropDef[] = [
  { id: 'use_proportional_edit', label: 'Proportional Editing', type: 'bool', default: false },
  { id: 'proportional_edit_falloff', label: 'Proportional Falloff', type: 'enum', default: 'SMOOTH', items: FALLOFF_ITEMS, showIf: propOn },
  { id: 'proportional_size', label: 'Proportional Size', type: 'float', default: 1, min: 1e-6, softMax: 100, subtype: 'distance', showIf: propOn },
  { id: 'use_proportional_connected', label: 'Connected', type: 'bool', default: false, showIf: propOn },
];
const ORIENT_PROPS: PropDef[] = [
  { id: 'orient_type', label: 'Orientation', type: 'enum', default: 'GLOBAL', items: ORIENT_ITEMS },
  { id: 'orient_matrix', label: 'Matrix', type: 'vec3', default: [], hidden: true },
];
const CONSTRAINT_PROP: PropDef = { id: 'constraint_axis', label: 'Constraint Axis', type: 'bools', default: [false, false, false] };

const MODE_OP: Partial<Record<TransformMode, string>> = {
  TRANSLATION: 'transform.translate',
  ROTATION: 'transform.rotate',
  RESIZE: 'transform.resize',
  TRACKBALL: 'transform.trackball',
  SHRINKFATTEN: 'transform.shrink_fatten',
  TOSPHERE: 'transform.tosphere',
  SHEAR: 'transform.shear',
  PUSHPULL: 'transform.push_pull',
  BEND: 'transform.bend',
  WARP: 'transform.vertex_warp',
  TILT: 'transform.tilt',
  CURVE_SHRINKFATTEN: 'transform.transform',
  GPENCIL_OPACITY: 'transform.transform',
  MIRROR: 'transform.mirror',
};

function proportionalProps() {
  const ts = app.doc.scene.tool_settings;
  return { use_proportional_edit: proportionalEnabled(), proportional_edit_falloff: ts.proportional_edit_falloff, proportional_size: ts.proportional_size, use_proportional_connected: ts.use_proportional_connected };
}

const round = (x: number) => Math.round(x * 1e9) / 1e9;

/** Operator call equivalent to a state (for Adjust Last Operation and the Info log). */
export function stateToOperator(st: TState): { idname: string; props: Record<string, unknown> } | undefined {
  const idname = MODE_OP[st.mode];
  if (!idname) return undefined;
  const orient = { orient_type: BUILTIN_ORIENTATIONS.some((b) => b[0] === st.orientType) ? st.orientType : 'GLOBAL', orient_matrix: st.basis.toArray().map(round) };
  const cons = { constraint_axis: st.axes ? [...st.axes] : [false, false, false] };
  const v = st.value.map(round);
  switch (st.mode) {
    case 'TRANSLATION':
      return { idname, props: { value: maskedValue({ ...st, value: v }), ...orient, ...cons, ...proportionalProps(), ...(st.alignNormal ? { snap_align: true, snap_normal: st.alignNormal.toArray().map(round) } : {}) } };
    case 'RESIZE':
      return { idname, props: { value: maskedValue({ ...st, value: v }), ...orient, ...cons, ...proportionalProps() } };
    case 'ROTATION':
      return { idname, props: { value: v[0], orient_axis: AXIS_NAMES[st.orientAxis], ...orient, ...cons, ...proportionalProps() } };
    case 'TRACKBALL':
      return { idname, props: { value: [v[0], v[1]], orient_matrix: orient.orient_matrix, ...proportionalProps() } };
    case 'SHEAR':
      return { idname, props: { angle: v[0], orient_axis: AXIS_NAMES[st.orientAxis], orient_axis_ortho: AXIS_NAMES[st.orientAxisOrtho], ...orient, ...proportionalProps() } };
    case 'BEND':
      return { idname, props: { value: v[0], radius: v[1] ?? 1, center_override: st.center?.toArray().map(round) ?? [0, 0, 0], bend_dir: st.bend?.dir.toArray().map(round) ?? [1, 0, 0], bend_length: st.bend?.length ?? 1, orient_matrix: orient.orient_matrix, ...proportionalProps() } };
    case 'WARP':
      return { idname, props: { warp_angle: v[0], offset_angle: st.warp?.offset ?? 0, min: round(st.warp?.min ?? -1), max: round(st.warp?.max ?? 1), center: st.center?.toArray().map(round) ?? [0, 0, 0], viewmat: orient.orient_matrix } };
    case 'CURVE_SHRINKFATTEN':
    case 'GPENCIL_OPACITY':
      return { idname, props: { mode: st.mode, value: [v[0], 0, 0], orient_type: 'GLOBAL' } };
    case 'MIRROR':
      return { idname, props: { ...orient, ...cons } };
    default:
      return { idname, props: { value: v[0], ...proportionalProps() } };
  }
}

function basisFromProps(p: Record<string, unknown>, fallbackType = 'GLOBAL'): { basis: Matrix3; type: string } {
  const type = String(p.orient_type ?? fallbackType);
  const m = p.orient_matrix as number[] | undefined;
  // the view and custom orientations cannot be rebuilt reliably later: use the stored matrix
  if ((type === 'VIEW' || !BUILTIN_ORIENTATIONS.some((b) => b[0] === type) || p.orient_type === undefined) && m && m.length === 9 && m.some((x) => x !== 0)) return { basis: new Matrix3().fromArray(m), type };
  return { basis: orientationBasis(type), type };
}

/** Run a transform non-interactively from operator properties. */
function execTransform(mode: TransformMode, p: Record<string, unknown>): 'FINISHED' | 'CANCELLED' {
  const ts = app.doc.scene.tool_settings;
  const objMode = app.doc.mode === 'OBJECT';
  const key = objMode ? 'use_proportional_edit_objects' : 'use_proportional_edit';
  const prevEnabled = ts[key];
  const prevConnected = ts.use_proportional_connected;
  if (p.use_proportional_edit !== undefined) {
    ts[key] = !!p.use_proportional_edit;
    if (p.use_proportional_edit) {
      ts.proportional_edit_falloff = (p.proportional_edit_falloff as typeof ts.proportional_edit_falloff) ?? ts.proportional_edit_falloff;
      ts.proportional_size = (p.proportional_size as number) ?? ts.proportional_size;
      ts.use_proportional_connected = !!p.use_proportional_connected;
    }
  }
  try {
    const s = openSession(mode);
    if (!s) return 'CANCELLED';
    const st = stateFromProps(mode, p);
    applyState(s, st);
    s.data.finish();
    return 'FINISHED';
  } finally {
    ts[key] = prevEnabled;
    ts.use_proportional_connected = prevConnected;
  }
}

/**
 * Move each selected element (object or component) to the point returned for it, e.g. for the
 * Snap menu. `target` gets the element's world position and the active element's position.
 */
export function snapSelectedElements(target: (center: Vector3, active: Vector3 | undefined) => Vector3 | null): boolean {
  const ts = app.doc.scene.tool_settings;
  const key = app.doc.mode === 'OBJECT' ? 'use_proportional_edit_objects' : 'use_proportional_edit';
  const prev = ts[key];
  ts[key] = false;
  try {
    const s = openSession('TRANSLATION');
    if (!s) return false;
    for (const e of s.data.elements) {
      if (e.weight < 1) continue;
      const t = target(e.center.clone(), s.data.active?.clone());
      if (t) e.apply(T(t.sub(e.center)), { mode: 'TRANSLATION', value: [] });
    }
    s.data.onUpdate?.();
    s.data.finish();
    app.changed('doc');
    return true;
  } finally {
    ts[key] = prev;
  }
}

/** World position of the active element of the current selection (active vertex, point, bone…). */
export function activeElementPosition(): Vector3 | null {
  return collect('TRANSLATION')?.active?.clone() ?? null;
}

/** Move the current selection (objects or components) by a world-space offset, without proportional editing. */
export function moveSelection(delta: Vector3): boolean {
  return execTransform('TRANSLATION', { value: [delta.x, delta.y, delta.z], orient_type: 'GLOBAL', constraint_axis: [false, false, false], use_proportional_edit: false }) === 'FINISHED';
}

function axisIndex(v: unknown, fallback: number) {
  const i = AXIS_NAMES.indexOf(String(v));
  return i >= 0 ? i : fallback;
}

function stateFromProps(mode: TransformMode, p: Record<string, unknown>): TState {
  let cons = p.constraint_axis as boolean[] | undefined;
  // older scripts mirror with a single axis index
  if (mode === 'MIRROR' && !cons?.some(Boolean) && typeof p.axis === 'number') cons = [0, 1, 2].map((i) => i === p.axis);
  const axes = cons && cons.some(Boolean) ? [...cons] : null;
  const { basis, type } = basisFromProps(p, mode === 'ROTATION' && !axes ? 'VIEW' : 'GLOBAL');
  const st: TState = { mode, value: [], axes, orientType: type, basis, orientAxis: axisIndex(p.orient_axis, 2), orientAxisOrtho: axisIndex(p.orient_axis_ortho, 0) };
  const num = (x: unknown, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  switch (mode) {
    case 'TRANSLATION': {
      const v = (p.value as number[]) ?? [0, 0, 0];
      st.value = [num(v[0]), num(v[1]), num(v[2])];
      const n = p.snap_normal as number[] | undefined;
      if (p.snap_align && n && n.length === 3) st.alignNormal = new Vector3().fromArray(n);
      break;
    }
    case 'RESIZE': {
      const v = (p.value as number[]) ?? [1, 1, 1];
      st.value = [num(v[0], 1), num(v[1], 1), num(v[2], 1)];
      break;
    }
    case 'TRACKBALL': {
      const v = (p.value as number[]) ?? [0, 0];
      st.value = [num(v[0]), num(v[1])];
      st.basis = basisFromProps({ ...p, orient_type: 'VIEW' }).basis;
      st.orientType = 'VIEW';
      break;
    }
    case 'SHEAR':
      st.value = [num(p.angle)];
      break;
    case 'BEND': {
      st.value = [num(p.value), num(p.radius, 1)];
      const c = p.center_override as number[] | undefined;
      st.center = c && c.length === 3 ? new Vector3().fromArray(c) : new Vector3().fromArray(app.doc.scene.cursor.location);
      const dir = new Vector3().fromArray((p.bend_dir as number[]) ?? [1, 0, 0]).normalize();
      st.bend = { dir, length: num(p.bend_length, 1) };
      st.basis = basisFromProps({ ...p, orient_type: 'VIEW' }).basis;
      st.orientType = 'VIEW';
      break;
    }
    case 'WARP': {
      st.value = [num(p.warp_angle, Math.PI * 2)];
      const c = p.center as number[] | undefined;
      st.center = c && c.length === 3 && c.some((x) => x !== 0) ? new Vector3().fromArray(c) : new Vector3().fromArray(app.doc.scene.cursor.location);
      st.basis = basisFromProps({ orient_type: 'VIEW', orient_matrix: p.viewmat }).basis;
      st.orientType = 'VIEW';
      st.warp = { min: num(p.min, -1), max: num(p.max, 1), offset: num(p.offset_angle) };
      break;
    }
    case 'CURVE_SHRINKFATTEN':
    case 'GPENCIL_OPACITY':
      st.value = [num(p.value, 1)];
      break;
    default:
      st.value = [num(p.value)];
  }
  return st;
}

// ---------------------------------------------------------------------------
// Modal

/** Live state of the running modal transform, read by the viewport overlay. */
const overlay: { pivot: Vector3 | null; axes: { dir: Vector3; color: string }[]; propRadius: number; mouse: { x: number; y: number } | null; helpFrom: Vector3 | null } = { pivot: null, axes: [], propRadius: 0, mouse: null, helpFrom: null };

const AXIS_COLORS = ['#fc364b', '#84e003', '#398efc'];

/** Typed numeric input, one text field per component. */
class NumInput {
  fields: string[] = ['', '', ''];
  idx = 0;
  /** expression mode: letters are typed into the field instead of acting as hotkeys */
  advanced = false;
  get active() {
    return this.fields.some((f) => f !== '');
  }
  values(kind: 'distance' | 'angle' | 'none'): (number | null)[] {
    return this.fields.map((f) => evalNumeric(f, kind));
  }
  type(ch: string) {
    const f = this.fields[this.idx];
    // a leading minus toggles the sign of the field
    if (ch === '-' && !this.advanced && (f === '' || f === '-')) this.fields[this.idx] = f === '-' ? '' : '-';
    else if (ch === '-' && !this.advanced && /^-?[\d.]+$/.test(f)) this.fields[this.idx] = f.startsWith('-') ? f.slice(1) : `-${f}`;
    else this.fields[this.idx] = f + ch;
  }
  backspace(all: boolean) {
    if (all) {
      this.fields = ['', '', ''];
      this.idx = 0;
      this.advanced = false;
    } else this.fields[this.idx] = this.fields[this.idx].slice(0, -1);
  }
  next(n: number, back = false) {
    this.idx = (this.idx + (back ? n - 1 : 1)) % n;
  }
  text(n: number) {
    return `[${this.fields.slice(0, n).map((f, i) => (i === this.idx ? `${f}|` : f || '…')).join(', ')}]`;
  }
}

export function startTransform(
  mode: TransformMode,
  opts: {
    constraint?: boolean[];
    orient?: string;
    release_confirm?: boolean;
    event?: { x: number; y: number };
    /** build the redo operator from the final transform value (Adjust Last Operation) */
    redo?: (value: number[]) => { idname: string; props: Record<string, unknown> } | undefined;
    /** offer the equivalent transform operator in Adjust Last Operation (operators invoked directly) */
    redoSelf?: boolean;
    /** label for the undo step */
    label?: string;
  } = {},
): boolean {
  const v = activeView3D();
  if (!v) return false;
  const ts = app.doc.scene.tool_settings;
  let s = openSession(mode);
  if (!s) return false;
  const rect = v.el.getBoundingClientRect();
  const start = opts.event ? { x: opts.event.x - rect.left, y: opts.event.y - rect.top } : { x: app.pointer.x - rect.left, y: app.pointer.y - rect.top };
  const proportional = proportionalEnabled();
  const pivot0 = s.pivot.clone();
  const sel0 = s.sel;
  // Snap With: Closest uses the bounding-box corners of moved objects (captured before moving)
  const closestSources: Vector3[] = [];
  if (app.doc.mode === 'OBJECT')
    for (const ob of app.selectedObjects()) {
      const ev = app.graph.get(ob.id);
      if (!ev) continue;
      const P = ev.mesh?.positions;
      if (!P || !P.length) {
        closestSources.push(new Vector3().setFromMatrixPosition(ev.world));
        continue;
      }
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < P.length; i += 3)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], P[i + k]);
          max[k] = Math.max(max[k], P[i + k]);
        }
      for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) closestSources.push(new Vector3(x, y, z).applyMatrix4(ev.world));
    }
  const active0 = s.data.active;
  /** Snap source point (Snap With: closest / center / median / active). */
  const snapSource = (target: Vector3 | null): Vector3 => {
    const st = ts.snap_target;
    if (st === 'ACTIVE' && active0) return active0.clone();
    if (st === 'MEDIAN') {
      const c = new Vector3();
      for (const e of sel0) c.add(e.center);
      return c.multiplyScalar(1 / Math.max(1, sel0.length));
    }
    if (st === 'CLOSEST' && target && closestSources.length) {
      let best = closestSources[0];
      for (const p of closestSources) if (p.distanceTo(target) < best.distanceTo(target)) best = p;
      return best.clone();
    }
    if (st === 'CLOSEST' && target && sel0.length) {
      let best = sel0[0].center;
      for (const e of sel0) if (e.center.distanceTo(target) < best.distanceTo(target)) best = e.center;
      return best.clone();
    }
    const min = new Vector3(Infinity, Infinity, Infinity),
      max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const e of sel0) {
      min.min(e.center);
      max.max(e.center);
    }
    return sel0.length ? min.add(max).multiplyScalar(0.5) : pivot0.clone();
  };

  let curMode = mode;
  let mouse = { ...start };
  let startMouse = { ...start };
  let constraint: { axes: boolean[]; orient: string } | null = opts.constraint ? { axes: [...opts.constraint], orient: opts.orient ?? currentOrientation() } : null;
  let lastAxisKey = '';
  let axisPresses = 0;
  const num = new NumInput();
  let snapBase = ts.use_snap;
  let snapInvert = false;
  const snapOn = () => snapBase !== snapInvert;
  let precise = false;
  let propSize = ts.proportional_size;
  /** MMB auto-constraint: active while the middle button is held */
  let auto: { plane: boolean; from: { x: number; y: number } } | null = null;
  let state: TState = { mode, value: [], axes: null, orientType: 'GLOBAL', basis: new Matrix3(), orientAxis: 2, orientAxisOrtho: 0 };
  // shear direction (view-space axis the points slide along)
  let shearOrtho = 0;
  // bend & warp work around the 3D cursor
  const cursor = new Vector3().fromArray(app.doc.scene.cursor.location);
  let bendFrame: { dir: Vector3; length: number } | null = null;
  let startDist = 1;

  const viewBasis = () => new Matrix3().setFromMatrix4(new Matrix4().makeRotationFromQuaternion(v.camera.quaternion));
  const pivotScreen = () => v.project(curMode === 'BEND' || curMode === 'WARP' ? cursor : s!.pivot);
  const viewDir = () => new Vector3(0, 0, -1).applyQuaternion(v.camera.quaternion);

  // rotation accumulates the mouse angle around the pivot across the ±π wrap
  let rotTotal = 0;
  let lastAngle = 0;
  const resetMouseRefs = () => {
    startMouse = { ...mouse };
    rotTotal = 0;
    const ps = pivotScreen();
    lastAngle = Math.atan2(mouse.y - ps.y, mouse.x - ps.x);
    startDist = Math.max(1, Math.hypot(mouse.x - ps.x, mouse.y - ps.y));
    if (curMode === 'BEND') {
      const a = v.unproject(mouse.x, mouse.y, cursor);
      const dir = a.sub(cursor);
      const length = dir.length();
      bendFrame = length > 1e-9 ? { dir: dir.normalize(), length } : { dir: basisAxis(viewBasis(), 0), length: Math.max(1e-3, v.nav.pixelSize(cursor) * 50) };
    }
  };
  resetMouseRefs();
  const warpExt = warpExtents(s, cursor, viewBasis());

  const numKind = (): 'distance' | 'angle' | 'none' => (curMode === 'TRANSLATION' || curMode === 'PUSHPULL' || curMode === 'SHRINKFATTEN' ? 'distance' : curMode === 'ROTATION' || curMode === 'TRACKBALL' || curMode === 'SHEAR' || curMode === 'BEND' || curMode === 'WARP' || curMode === 'TILT' ? 'angle' : 'none');
  const numFields = () => (curMode === 'TRANSLATION' || curMode === 'RESIZE' ? (constraint ? constraint.axes.filter(Boolean).length : 3) : curMode === 'TRACKBALL' || curMode === 'BEND' ? 2 : 1);

  const compute = () => {
    const dx = mouse.x - startMouse.x,
      dy = mouse.y - startMouse.y;
    const free = constraint?.axes ?? [true, true, true];
    const nFree = free.filter(Boolean).length;
    const orient = constraint?.orient ?? currentOrientation();
    const basis = orientationBasis(orient);
    const vals = num.active ? num.values(numKind()) : null;
    const typed = (i: number) => (vals ? vals[i] : null);
    const deg = Math.PI / 180;
    const ps = pivotScreen();
    const st: TState = { mode: curMode, value: [], axes: constraint ? [...constraint.axes] : null, orientType: orient, basis, orientAxis: 2, orientAxisOrtho: 0 };
    snapIndicator.point = null;
    overlay.helpFrom = null;
    if (curMode === 'TRANSLATION') {
      let delta = new Vector3();
      if (vals) {
        // typed values fill the free axes in order
        const freeIdx = [0, 1, 2].filter((i) => free[i]);
        const local = [0, 0, 0];
        freeIdx.forEach((ai, k) => (local[ai] = typed(k) ?? 0));
        st.value = local;
      } else {
        const a = v.unproject(startMouse.x, startMouse.y, pivot0),
          b = v.unproject(mouse.x, mouse.y, pivot0);
        delta = b.sub(a);
        if (constraint && nFree === 1) {
          const axis = basisAxis(basis, free.indexOf(true));
          // project mouse motion onto the screen-space axis direction
          const s0 = v.project(pivot0),
            s1 = v.project(pivot0.clone().add(axis));
          const sx = s1.x - s0.x,
            sy = s1.y - s0.y,
            sl = Math.hypot(sx, sy);
          delta = sl > 1e-6 ? axis.multiplyScalar((dx * sx + dy * sy) / (sl * sl)) : new Vector3();
        } else if (constraint && nFree === 2) {
          const normal = basisAxis(basis, free.indexOf(false));
          const hit = (r: { origin: Vector3; dir: Vector3 }) => {
            const den = r.dir.dot(normal);
            if (Math.abs(den) < 1e-6) return null;
            const t = pivot0.clone().sub(r.origin).dot(normal) / den;
            return r.origin.clone().addScaledVector(r.dir, t);
          };
          const h0 = hit(v.ray(startMouse.x, startMouse.y)),
            h1 = hit(v.ray(mouse.x, mouse.y));
          delta = h0 && h1 ? h1.sub(h0) : new Vector3();
        }
        if (snapOn()) {
          const els = (ts.snap_elements.length ? ts.snap_elements : ['INCREMENT']) as SnapElement[];
          const inv = basis.clone().invert();
          const keepFree = (vec: Vector3) => {
            if (!constraint) return vec;
            const lv = vec.clone().applyMatrix3(inv);
            if (!free[0]) lv.x = 0;
            if (!free[1]) lv.y = 0;
            if (!free[2]) lv.z = 0;
            return lv.applyMatrix3(basis);
          };
          const target = els.some((e) => e !== 'INCREMENT' && e !== 'GRID') ? findSnapTarget(v, mouse, els) : null;
          const inc = (precise ? 0.1 : 1) * (v.overlay.grid_scale || 1);
          if (target) {
            // move the snap source (closest / center / median / active) onto the target
            delta = keepFree(target.point.clone().sub(snapSource(target.point)));
            snapIndicator.point = target.point;
            snapIndicator.kind = target.kind;
            if (target.normal && (ts as { use_snap_align_rotation?: boolean }).use_snap_align_rotation) st.alignNormal = target.normal.clone();
          } else if (els.includes('GRID')) {
            // absolute grid snapping of the source point
            const src = snapSource(null);
            const lp = src.clone().add(delta).applyMatrix3(inv);
            lp.set(Math.round(lp.x / inc) * inc, Math.round(lp.y / inc) * inc, Math.round(lp.z / inc) * inc);
            delta = keepFree(lp.applyMatrix3(basis).sub(src));
          } else if (els.includes('INCREMENT') && (ts as { use_snap_grid_absolute?: boolean }).use_snap_grid_absolute) {
            // absolute increment: land the snap source on the grid
            const src = snapSource(null);
            const lp = src.clone().add(delta).applyMatrix3(inv);
            lp.set(Math.round(lp.x / inc) * inc, Math.round(lp.y / inc) * inc, Math.round(lp.z / inc) * inc);
            delta = keepFree(lp.applyMatrix3(basis).sub(src));
          } else if (els.includes('INCREMENT')) {
            const lv = delta.clone().applyMatrix3(inv);
            lv.set(Math.round(lv.x / inc) * inc, Math.round(lv.y / inc) * inc, Math.round(lv.z / inc) * inc);
            delta = lv.applyMatrix3(basis);
          }
        }
        const lv = delta.applyMatrix3(basis.clone().invert());
        st.value = [lv.x, lv.y, lv.z];
      }
    } else if (curMode === 'ROTATION') {
      if (constraint && nFree === 1) st.orientAxis = free.indexOf(true);
      else if (constraint && nFree === 2) st.orientAxis = free.indexOf(false);
      else {
        st.orientType = 'VIEW';
        st.basis = viewBasis();
        st.orientAxis = 2;
        st.axes = null;
      }
      let angle: number;
      if (vals) angle = (typed(0) ?? 0) * deg;
      else {
        angle = -rotTotal;
        // screen rotation direction vs axis direction relative to the viewer
        if (basisAxis(st.basis, st.orientAxis).dot(viewDir()) > 0) angle = -angle;
        if (snapOn()) {
          const step = rotationStep(precise);
          angle = Math.round(angle / step) * step;
        }
      }
      st.value = [angle];
      overlay.helpFrom = s!.pivot;
    } else if (curMode === 'TRACKBALL') {
      st.basis = viewBasis();
      st.orientType = 'VIEW';
      st.axes = null;
      let ax = (dy * Math.PI) / 360,
        ay = (dx * Math.PI) / 360;
      if (snapOn()) {
        const step = rotationStep(precise);
        ax = Math.round(ax / step) * step;
        ay = Math.round(ay / step) * step;
      }
      st.value = vals ? [(typed(0) ?? 0) * deg, (typed(1) ?? 0) * deg] : [ax, ay];
    } else if (curMode === 'RESIZE') {
      const d0 = Math.hypot(startMouse.x - ps.x, startMouse.y - ps.y),
        d1 = Math.hypot(mouse.x - ps.x, mouse.y - ps.y);
      let f = d0 > 1 ? d1 / d0 : 1;
      // flipped when crossing the pivot
      if ((startMouse.x - ps.x) * (mouse.x - ps.x) + (startMouse.y - ps.y) * (mouse.y - ps.y) < 0) f = -f;
      if (snapOn()) f = Math.round(f / (precise ? 0.01 : 0.1)) * (precise ? 0.01 : 0.1);
      let sv = [f, f, f];
      if (vals) {
        const freeIdx = [0, 1, 2].filter((i) => free[i]);
        const only = vals.slice(1).every((x) => x === null);
        sv = [1, 1, 1];
        freeIdx.forEach((ai, k) => (sv[ai] = (only ? typed(0) : typed(k)) ?? 1));
      }
      st.value = sv;
      overlay.helpFrom = s!.pivot;
    } else if (curMode === 'SHEAR') {
      st.basis = constraint ? basis : viewBasis();
      st.orientType = constraint ? orient : 'VIEW';
      st.axes = null;
      st.orientAxis = 2;
      st.orientAxisOrtho = shearOrtho;
      const along = shearOrtho === 0 ? dx : -dy;
      let a = Math.atan(along / 100);
      if (snapOn()) a = Math.round(a / ((precise ? 1 : 5) * deg)) * (precise ? 1 : 5) * deg;
      st.value = [vals ? (typed(0) ?? 0) * deg : a];
    } else if (curMode === 'BEND') {
      st.basis = viewBasis();
      st.orientType = 'VIEW';
      st.axes = null;
      st.center = cursor.clone();
      st.bend = bendFrame ?? undefined;
      let angle = -rotTotal;
      if (snapOn()) angle = Math.round(angle / (5 * deg)) * 5 * deg;
      const radius = Math.max(0.01, Math.hypot(mouse.x - ps.x, mouse.y - ps.y) / startDist);
      st.value = vals ? [(typed(0) ?? 0) * deg, typed(1) ?? radius] : [angle, radius];
      overlay.helpFrom = cursor;
    } else if (curMode === 'WARP') {
      st.basis = viewBasis();
      st.orientType = 'VIEW';
      st.axes = null;
      st.center = cursor.clone();
      st.warp = { ...warpExt, offset: 0 };
      let angle = dx * deg;
      if (snapOn()) angle = Math.round(angle / (5 * deg)) * 5 * deg;
      st.value = [vals ? (typed(0) ?? 0) * deg : angle];
      overlay.helpFrom = cursor;
    } else if (curMode === 'MIRROR') {
      // the mirror axis comes from the X / Y / Z keys only
      st.value = [];
    } else if (curMode === 'TILT') {
      // the tilt follows the mouse turning around the selection center
      let angle = -rotTotal;
      if (snapOn()) angle = Math.round(angle / rotationStep(precise)) * rotationStep(precise);
      st.value = [vals ? (typed(0) ?? 0) * deg : angle];
      overlay.helpFrom = s!.pivot;
    } else if (curMode === 'CURVE_SHRINKFATTEN' || curMode === 'GPENCIL_OPACITY') {
      const d0 = Math.hypot(startMouse.x - ps.x, startMouse.y - ps.y),
        d1 = Math.hypot(mouse.x - ps.x, mouse.y - ps.y);
      let f = d0 > 1 ? d1 / d0 : 1;
      if (snapOn()) f = Math.round(f / (precise ? 0.01 : 0.1)) * (precise ? 0.01 : 0.1);
      st.value = [vals ? typed(0) ?? 1 : Math.max(0, f)];
      overlay.helpFrom = s!.pivot;
    } else if (curMode === 'TOSPHERE') {
      let f = Math.max(0, Math.min(1, dx / 200));
      if (snapOn()) f = Math.round(f * 10) / 10;
      st.value = [vals ? Math.max(0, Math.min(1, typed(0) ?? 0)) : f];
    } else if (curMode === 'PUSHPULL' || curMode === 'SHRINKFATTEN') {
      // moving the mouse away from the pivot pushes outwards
      const d1 = Math.hypot(mouse.x - ps.x, mouse.y - ps.y);
      let amount = (d1 - startDist) * v.nav.pixelSize(s!.pivot);
      if (snapOn()) amount = Math.round(amount * 10) / 10;
      st.value = [vals ? typed(0) ?? 0 : amount];
      overlay.helpFrom = s!.pivot;
    }
    // after navigating the view mid-transform, mouse motion continues from the value reached so far
    if (navBase && navBase.mode === curMode && !vals) st.value = combineValues(curMode, navBase.value, st.value);
    state = st;
    applyState(s!, st);
    // overlay: constraint axes through the pivot, proportional radius
    overlay.pivot = (curMode === 'BEND' || curMode === 'WARP' ? cursor : s!.pivot).clone();
    overlay.axes = constraint && (curMode === 'TRANSLATION' || curMode === 'ROTATION' || curMode === 'RESIZE' || curMode === 'MIRROR') ? [0, 1, 2].filter((i) => (curMode === 'ROTATION' && nFree === 2 ? !constraint!.axes[i] : constraint!.axes[i])).map((i) => ({ dir: basisAxis(basis, i), color: AXIS_COLORS[i] })) : [];
    overlay.propRadius = proportional ? propSize : 0;
    overlay.mouse = { ...mouse };
    renderContext?.engine.requestDraw();
    v.drawSvg();
  };

  /** Pressing an axis key: first press uses the header orientation, the second the alternative, the third clears. */
  const setConstraint = (axis: number, plane: boolean) => {
    const key = `${axis}${plane}`;
    const hdr = currentOrientation();
    const alt = hdr === 'GLOBAL' ? 'LOCAL' : 'GLOBAL';
    if (lastAxisKey === key && constraint) {
      axisPresses++;
      if (axisPresses >= 2) {
        constraint = null;
        lastAxisKey = '';
        axisPresses = 0;
        return;
      }
      constraint = { axes: constraint.axes, orient: alt };
      return;
    }
    lastAxisKey = key;
    axisPresses = 0;
    constraint = { axes: [0, 1, 2].map((i) => (plane ? i !== axis : i === axis)), orient: hdr };
  };

  /** MMB auto-constraint: the orientation axis best matching the mouse motion since the press. */
  const updateAuto = () => {
    if (!auto) return;
    const mx = mouse.x - auto.from.x,
      my = mouse.y - auto.from.y;
    if (Math.hypot(mx, my) < 6) return;
    const orient = currentOrientation();
    const basis = orientationBasis(orient);
    const p0 = v.project(s!.pivot);
    let best = -1,
      bestDot = -1;
    for (let i = 0; i < 3; i++) {
      const p1 = v.project(s!.pivot.clone().add(basisAxis(basis, i).multiplyScalar(v.nav.pixelSize(s!.pivot) * 50)));
      const sx = p1.x - p0.x,
        sy = p1.y - p0.y,
        sl = Math.hypot(sx, sy);
      if (sl < 1) continue;
      const d = Math.abs((mx * sx + my * sy) / (sl * Math.hypot(mx, my)));
      if (d > bestDot) {
        bestDot = d;
        best = i;
      }
    }
    if (best < 0) return;
    constraint = { axes: [0, 1, 2].map((i) => (auto!.plane ? i !== best : i === best)), orient };
    lastAxisKey = '';
  };

  /** Value reached before navigating the view (Alt + MMB / wheel) during the transform. */
  let navBase: { mode: TransformMode; value: number[] } | null = null;
  let navigating = false;
  const rebase = () => {
    navBase = { mode: curMode, value: [...state.value] };
    // the next mouse-driven value starts from zero again
    if (curMode === 'BEND' || curMode === 'WARP') return;
    resetMouseRefs();
  };

  const switchMode = (next: TransformMode) => {
    navBase = null;
    for (const el of s!.data.elements) el.restore();
    s!.data.onUpdate?.();
    curMode = next;
    s!.individual = ts.transform_pivot_point === 'INDIVIDUAL_ORIGINS' && (next === 'ROTATION' || next === 'RESIZE' || next === 'TRACKBALL');
    num.backspace(true);
    resetMouseRefs();
    handler.label = opts.label ?? modeLabel();
    compute();
  };

  /** Proportional size changed: weights depend on it, so the elements are collected again. */
  const setPropSize = (size: number) => {
    propSize = Math.max(1e-4, size);
    ts.proportional_size = propSize;
    for (const el of s!.data.elements) el.restore();
    s!.data.onUpdate?.();
    const again = openSession(curMode);
    if (again) {
      again.pivot = s!.pivot;
      again.radius = s!.radius;
      s = again;
    }
    compute();
  };

  const modeLabel = () => ({ TRANSLATION: 'Move', ROTATION: 'Rotate', RESIZE: 'Resize', TRACKBALL: 'Trackball', SHRINKFATTEN: 'Shrink/Fatten', TOSPHERE: 'To Sphere', SHEAR: 'Shear', PUSHPULL: 'Push/Pull', EDGESLIDE: 'Edge Slide', BEND: 'Bend', WARP: 'Warp', TILT: 'Tilt', CURVE_SHRINKFATTEN: 'Radius', GPENCIL_OPACITY: 'Opacity', MIRROR: 'Mirror' })[curMode];

  const fmt = (x: number) => (Math.abs(x) < 1e-6 ? '0' : x.toFixed(4).replace(/\.?0+$/, ''));
  const fmtDeg = (x: number) => `${fmt((x * 180) / Math.PI)}°`;
  const header = () => {
    const st = state;
    const cname = constraint ? ` along ${orientationLabel(constraint.orient).toLowerCase()} ${constraint.axes.map((f, i) => (f ? AXIS_NAMES[i] : '')).join('')}` : '';
    const numTxt = num.active ? ` ${num.text(numFields())}` : '';
    const prop = proportional ? `  Proportional size: ${fmt(propSize)}` : '';
    const v0 = st.value;
    let body: string;
    if (curMode === 'TRANSLATION') {
      const d = maskedValue(st);
      const len = new Vector3(d[0], d[1], d[2]).length();
      body = constraint && constraint.axes.filter(Boolean).length === 1 ? `D: ${fmt(d[constraint.axes.indexOf(true)])} m (${fmt(len)} m)` : `D: ${fmt(d[0])} m  ${fmt(d[1])} m  ${fmt(d[2])} m (${fmt(len)} m)`;
    } else if (curMode === 'ROTATION') body = `Rot: ${fmtDeg(v0[0] ?? 0)}`;
    else if (curMode === 'TRACKBALL') body = `Trackball: ${fmtDeg(v0[0] ?? 0)} ${fmtDeg(v0[1] ?? 0)}`;
    else if (curMode === 'RESIZE') {
      const d = maskedValue(st);
      body = `Scale X: ${fmt(d[0])}  Y: ${fmt(d[1])}  Z: ${fmt(d[2])}`;
    } else if (curMode === 'SHEAR') body = `Shear: ${fmtDeg(v0[0] ?? 0)} (${AXIS_NAMES[shearOrtho]} to toggle direction)`;
    else if (curMode === 'BEND') body = `Bend Angle: ${fmtDeg(v0[0] ?? 0)}  Radius: ${fmt(v0[1] ?? 1)}`;
    else if (curMode === 'WARP') body = `Warp: ${fmtDeg(v0[0] ?? 0)}`;
    else if (curMode === 'TOSPHERE') body = `To Sphere: ${fmt(v0[0] ?? 0)}`;
    else if (curMode === 'TILT') body = `Tilt: ${fmtDeg(v0[0] ?? 0)}`;
    else if (curMode === 'MIRROR') body = constraint ? 'Mirror' : 'Mirror: press X, Y or Z to choose the axis';
    else if (curMode === 'CURVE_SHRINKFATTEN') body = `Shrink/Fatten: ${fmt(v0[0] ?? 1)}`;
    else if (curMode === 'GPENCIL_OPACITY') body = `Opacity: ${fmt(v0[0] ?? 1)}`;
    else body = `${modeLabel()}: ${fmt(v0[0] ?? 0)} m`;
    return `${body}${cname}${numTxt}${snapOn() ? '  (Snap)' : ''}${prop}`;
  };

  const handler: ModalHandler = {
    label: opts.label ?? modeLabel(),
    cursor: 'move',
    header,
    status: () => {
      const hints: [string, string][] = [
        ['LMB', 'Confirm'],
        ['RMB/Esc', 'Cancel'],
      ];
      if (curMode === 'TRANSLATION' || curMode === 'ROTATION' || curMode === 'RESIZE') hints.push(['X Y Z', 'Axis'], ['Shift X Y Z', 'Plane'], ['C', 'Clear Constraints'], ['MMB', 'Automatic Constraint']);
      if (curMode === 'MIRROR') hints.push(['X Y Z', 'Mirror Axis'], ['Shift X Y Z', 'Mirror Plane']);
      if (curMode === 'SHEAR') hints.push(['X Y', 'Direction']);
      hints.push(['Ctrl', 'Invert Snap'], ['Shift Tab', 'Snap Toggle'], ['Shift', 'Precision'], ['G R S', 'Mode']);
      if (proportional) hints.push(['Wheel/PgUp PgDn', 'Proportional Size']);
      hints.push(['Alt MMB/Wheel', 'Navigate']);
      return hints;
    },
    onPointerMove(e: PointerEvent) {
      const r = v.el.getBoundingClientRect();
      // Continuous Grab: with the pointer locked, motion keeps counting past the window edges
      const locked = document.pointerLockElement === v.el;
      const nx = locked ? lastRaw.x + e.movementX : e.clientX - r.left,
        ny = locked ? lastRaw.y + e.movementY : e.clientY - r.top;
      if (navigating) {
        // the view is being navigated: keep the transform as it is
        lastRaw = { x: nx, y: ny };
        mouse = { x: nx + precisionOffset.x, y: ny + precisionOffset.y };
        return;
      }
      precise = e.shiftKey;
      // precision: only a tenth of the motion counts while Shift is held (no jump on release)
      if (precise) {
        precisionOffset.x -= (nx - lastRaw.x) * 0.9;
        precisionOffset.y -= (ny - lastRaw.y) * 0.9;
      }
      lastRaw = { x: nx, y: ny };
      mouse = { x: nx + precisionOffset.x, y: ny + precisionOffset.y };
      snapInvert = e.ctrlKey || e.metaKey;
      const ps = pivotScreen();
      const a = Math.atan2(mouse.y - ps.y, mouse.x - ps.x);
      let da = a - lastAngle;
      if (da > Math.PI) da -= Math.PI * 2;
      if (da < -Math.PI) da += Math.PI * 2;
      lastAngle = a;
      rotTotal += da;
      updateAuto();
      compute();
    },
    onPointerDown(e: PointerEvent) {
      if (e.button === 0) return 'FINISHED';
      if (e.button === 2) return 'CANCELLED';
      if (e.button === 1 && e.altKey) {
        // Alt passes the middle mouse button through to view navigation
        e.preventDefault();
        navigating = true;
        v.navDrag(e, e.shiftKey ? 'pan' : e.ctrlKey ? 'zoom' : 'orbit');
        return undefined;
      }
      if (e.button === 1 && (curMode === 'TRANSLATION' || curMode === 'ROTATION' || curMode === 'RESIZE')) {
        e.preventDefault();
        auto = { plane: e.shiftKey, from: { ...mouse } };
      }
      return undefined;
    },
    onPointerUp(e: PointerEvent) {
      if (e.button === 1 && navigating) {
        navigating = false;
        rebase();
        compute();
        return undefined;
      }
      if (e.button === 1 && auto) {
        auto = null;
        return undefined;
      }
      if (opts.release_confirm && e.button === 0) return 'FINISHED';
      return undefined;
    },
    onWheel(e: WheelEvent) {
      if (e.altKey) {
        // Alt passes the wheel through to view zoom
        v.zoomBy(e.deltaY > 0 ? 1.2 : 1 / 1.2, mouse);
        v.afterNav();
        rebase();
        compute();
        return;
      }
      setPropSize(propSize * (e.deltaY > 0 ? 1.1 : 1 / 1.1));
    },
    onKey(e: KeyboardEvent) {
      const k = e.key;
      if (e.type !== 'keydown') {
        if (k === 'Control' || k === 'Meta') {
          snapInvert = false;
          compute();
        }
        return true;
      }
      if (k === 'Escape') return 'CANCELLED';
      if (k === 'Enter' || (k === ' ' && !num.advanced)) return 'FINISHED';
      if (k === 'Control' || k === 'Meta') {
        snapInvert = true;
        compute();
        return true;
      }
      const code = e.code;
      if (k === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) snapBase = !snapBase;
        else num.next(numFields(), e.ctrlKey);
        compute();
        return true;
      }
      // expression mode: '=' or '*' as the first character lets letters be typed (e.g. pi)
      if (num.advanced && k.length === 1 && !e.ctrlKey && !e.metaKey) {
        num.type(k);
        compute();
        return true;
      }
      if ((k === '=' || k === '*') && !num.fields[num.idx]) {
        num.advanced = true;
        if (k === '*') num.type('');
        compute();
        return true;
      }
      if (code === 'KeyX' || code === 'KeyY' || code === 'KeyZ') {
        const axis = code === 'KeyX' ? 0 : code === 'KeyY' ? 1 : 2;
        if (curMode === 'SHEAR') {
          if (axis < 2) shearOrtho = axis;
        } else if (curMode === 'TRANSLATION' || curMode === 'ROTATION' || curMode === 'RESIZE' || curMode === 'MIRROR') {
          setConstraint(axis, e.shiftKey);
          // typed values move to the newly constrained fields
          if (num.idx >= numFields()) num.idx = 0;
        }
        compute();
        return true;
      }
      if (code === 'KeyC' && !e.ctrlKey && !e.metaKey) {
        constraint = null;
        lastAxisKey = '';
        compute();
        return true;
      }
      if (code === 'KeyG' && curMode === 'TRANSLATION' && app.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH' && !constraint && !opts.label) {
        // G G: switch to edge/vertex slide
        setTimeout(() => app.run('transform.edge_slide'), 0);
        return 'CANCELLED';
      }
      if ((code === 'KeyG' || code === 'KeyR' || code === 'KeyS') && !e.ctrlKey && !e.metaKey && !e.altKey && !VALUE_MODES.has(curMode)) {
        switchMode(code === 'KeyG' ? 'TRANSLATION' : code === 'KeyR' ? (curMode === 'ROTATION' ? 'TRACKBALL' : 'ROTATION') : 'RESIZE');
        return true;
      }
      if (/^[0-9.]$/.test(k) || k === '-' || k === '+' || k === '*' || k === '/' || k === '(' || k === ')' || k === '^') {
        num.type(k === '^' ? '**' : k);
        compute();
        return true;
      }
      if (k === 'Backspace') {
        num.backspace(e.ctrlKey || e.metaKey);
        compute();
        return true;
      }
      if (k === 'PageUp' || k === 'PageDown') {
        if (proportional) setPropSize(propSize * (k === 'PageUp' ? 1.1 : 1 / 1.1));
        return true;
      }
      return true;
    },
    cancel() {
      releaseGrab(v);
      for (const e of s!.data.elements) e.restore();
      s!.data.onUpdate?.();
      s!.data.cancel();
      cleanupOverlay();
      app.changed('doc');
    },
    finish() {
      releaseGrab(v);
      s!.data.finish();
      cleanupOverlay();
      if (opts.redo) handler.redoOp = opts.redo(state.value);
      else if (opts.redoSelf) handler.redoOp = stateToOperator(state);
      if (opts.label) handler.label = opts.label;
    },
  };
  const precisionOffset = { x: 0, y: 0 };
  let lastRaw = { ...start };
  app.startModal(handler);
  if (prefs.use_mouse_continuous) {
    try {
      const req = v.el.requestPointerLock?.() as unknown as Promise<void> | undefined;
      req?.catch?.(() => {});
    } catch {
      // pointer lock unavailable: plain motion
    }
  }
  compute();
  return true;
}

function releaseGrab(v: View3D) {
  if (document.pointerLockElement === v.el) document.exitPointerLock();
}

/** A value reached earlier combined with further mouse-driven change of the same mode. */
function combineValues(mode: TransformMode, base: number[], next: number[]): number[] {
  if (mode === 'RESIZE' || mode === 'CURVE_SHRINKFATTEN' || mode === 'GPENCIL_OPACITY') return next.map((x, i) => x * (base[i] ?? 1));
  if (mode === 'TOSPHERE') return [Math.max(0, Math.min(1, (base[0] ?? 0) + (next[0] ?? 0)))];
  if (mode === 'BEND' || mode === 'WARP') return next;
  return next.map((x, i) => x + (base[i] ?? 0));
}

/** Rotation snapping step (radians) from the snapping settings. */
function rotationStep(precise: boolean) {
  const ts = app.doc.scene.tool_settings as { snap_angle_increment_3d?: number; snap_angle_increment_3d_precision?: number };
  return precise ? ts.snap_angle_increment_3d_precision ?? Math.PI / 180 : ts.snap_angle_increment_3d ?? (5 * Math.PI) / 180;
}

function cleanupOverlay() {
  overlay.pivot = null;
  overlay.axes = [];
  overlay.propRadius = 0;
  overlay.mouse = null;
  overlay.helpFrom = null;
  snapIndicator.point = null;
}

// constraint lines, proportional circle and the dashed help line while transforming
editModeHooks.svg.push((v: View3D) => {
  if (!app.modal || !overlay.pivot) return null;
  const parts: VNode[] = [];
  const p = v.project(overlay.pivot);
  if (p.z > 1) return null;
  const big = v.nav.pixelSize(overlay.pivot) * Math.max(v.width, v.height) * 2;
  for (const a of overlay.axes) {
    const p0 = v.project(overlay.pivot.clone().addScaledVector(a.dir, -big)),
      p1 = v.project(overlay.pivot.clone().addScaledVector(a.dir, big));
    parts.push(h('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: a.color, 'stroke-width': 1.2, opacity: 0.9 }));
  }
  if (overlay.propRadius > 0) {
    const r = overlay.propRadius / Math.max(1e-9, v.nav.pixelSize(overlay.pivot));
    parts.push(h('circle', { cx: p.x, cy: p.y, r, fill: 'none', stroke: '#ffffff', 'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: 0.7 }));
  }
  if (overlay.helpFrom && overlay.mouse) {
    const f = v.project(overlay.helpFrom);
    parts.push(h('line', { x1: f.x, y1: f.y, x2: overlay.mouse.x, y2: overlay.mouse.y, stroke: '#000000', 'stroke-width': 1, 'stroke-dasharray': '4 4', opacity: 0.8 }));
  }
  return parts.length ? h('g', { class: 'transform-overlay' }, parts) : null;
});

// ---------------------------------------------------------------------------
// Operators

const v3dPoll = () => !!activeView3D();
const editPoll = () => !!activeView3D() && app.doc.mode === 'EDIT';

function invokeModal(mode: TransformMode, p: Record<string, unknown>, ctx: { event?: { x: number; y: number } }) {
  const cons = p.constraint_axis as boolean[] | undefined;
  return startTransform(mode, { constraint: cons && cons.some(Boolean) ? cons : undefined, orient: typeof p.orient_type === 'string' && p.orient_type !== 'GLOBAL' ? p.orient_type : undefined, event: ctx.event, release_confirm: !!p.release_confirm, redoSelf: true })
    ? 'RUNNING_MODAL'
    : 'CANCELLED';
}

function transformOp(idname: string, label: string, mode: TransformMode, description: string, props: PropDef[], poll = v3dPoll): Operator {
  return {
    idname,
    label,
    description,
    props: [...props, { id: 'release_confirm', label: 'Confirm on Release', type: 'bool', default: false, hidden: true }],
    poll,
    invoke: (ctx, p) => {
      // a mirror with a given axis applies right away (the menu's X / Y / Z entries)
      if (mode === 'MIRROR' && ((p.constraint_axis as boolean[] | undefined)?.some(Boolean) || (typeof p.axis === 'number' && p.axis >= 0))) return execTransform(mode, p);
      return invokeModal(mode, p, ctx);
    },
    exec: (_ctx, p) => execTransform(mode, p),
  };
}

registerOperators([
  transformOp('transform.translate', 'Move', 'TRANSLATION', 'Move selected items', [
    { id: 'value', label: 'Move', type: 'vec3', default: [0, 0, 0], subtype: 'distance' },
    ...ORIENT_PROPS,
    CONSTRAINT_PROP,
    ...PROPORTIONAL_PROPS,
    { id: 'snap_align', label: 'Align with Point Normal', type: 'bool', default: false, hidden: true },
    { id: 'snap_normal', label: 'Normal', type: 'vec3', default: [0, 0, 0], hidden: true },
  ]),
  transformOp('transform.rotate', 'Rotate', 'ROTATION', 'Rotate selected items', [{ id: 'value', label: 'Angle', type: 'float', default: 0, subtype: 'angle' }, { id: 'orient_axis', label: 'Axis', type: 'enum', default: 'Z', items: AXIS_ITEMS }, ...ORIENT_PROPS, CONSTRAINT_PROP, ...PROPORTIONAL_PROPS]),
  transformOp('transform.resize', 'Resize', 'RESIZE', 'Scale (resize) selected items', [{ id: 'value', label: 'Scale', type: 'vec3', default: [1, 1, 1] }, ...ORIENT_PROPS, CONSTRAINT_PROP, ...PROPORTIONAL_PROPS]),
  transformOp('transform.trackball', 'Trackball', 'TRACKBALL', 'Rotate selected items freely, like a trackball', [{ id: 'value', label: 'Angle', type: 'vec2', default: [0, 0], subtype: 'angle' }, { id: 'orient_matrix', label: 'Matrix', type: 'vec3', default: [], hidden: true }, ...PROPORTIONAL_PROPS]),
  transformOp('transform.shrink_fatten', 'Shrink/Fatten', 'SHRINKFATTEN', 'Move selected vertices along their normals', [{ id: 'value', label: 'Offset', type: 'float', default: 0, subtype: 'distance' }, ...PROPORTIONAL_PROPS], editPoll),
  transformOp('transform.tosphere', 'To Sphere', 'TOSPHERE', 'Move selected items outward in a spherical shape around the pivot', [{ id: 'value', label: 'Factor', type: 'float', default: 0, min: 0, max: 1, subtype: 'factor' }, ...PROPORTIONAL_PROPS]),
  transformOp('transform.push_pull', 'Push/Pull', 'PUSHPULL', 'Push selected items away from the pivot, or pull them towards it', [{ id: 'value', label: 'Distance', type: 'float', default: 0, subtype: 'distance' }, ...PROPORTIONAL_PROPS]),
  transformOp('transform.shear', 'Shear', 'SHEAR', 'Slant selected items along one axis in proportion to their position on another', [
    { id: 'angle', label: 'Angle', type: 'float', default: 0, subtype: 'angle' },
    { id: 'orient_axis', label: 'Axis', type: 'enum', default: 'Z', items: AXIS_ITEMS },
    { id: 'orient_axis_ortho', label: 'Axis Ortho', type: 'enum', default: 'X', items: AXIS_ITEMS },
    ...ORIENT_PROPS,
    ...PROPORTIONAL_PROPS,
  ]),
  transformOp('transform.bend', 'Bend', 'BEND', 'Bend selected items between the 3D cursor and the mouse', [
    { id: 'value', label: 'Angle', type: 'float', default: 0, subtype: 'angle' },
    { id: 'radius', label: 'Radius', type: 'float', default: 1, min: 0.01, softMax: 10 },
    { id: 'center_override', label: 'Center', type: 'vec3', default: [0, 0, 0], hidden: true },
    { id: 'bend_dir', label: 'Direction', type: 'vec3', default: [1, 0, 0], hidden: true },
    { id: 'bend_length', label: 'Length', type: 'float', default: 1, hidden: true },
    { id: 'orient_matrix', label: 'Matrix', type: 'vec3', default: [], hidden: true },
    ...PROPORTIONAL_PROPS,
  ]),
  transformOp(
    'transform.vertex_warp',
    'Warp',
    'WARP',
    'Wrap selected items around the 3D cursor, mapping their horizontal position in the view to an angle',
    [
      { id: 'warp_angle', label: 'Warp Angle', type: 'float', default: Math.PI * 2, subtype: 'angle' },
      { id: 'offset_angle', label: 'Offset Angle', type: 'float', default: 0, subtype: 'angle' },
      { id: 'min', label: 'Min', type: 'float', default: -1 },
      { id: 'max', label: 'Max', type: 'float', default: 1 },
      { id: 'center', label: 'Center', type: 'vec3', default: [0, 0, 0], hidden: true },
      { id: 'viewmat', label: 'View Matrix', type: 'vec3', default: [], hidden: true },
    ],
    editPoll,
  ),
  {
    idname: 'transform.vertex_random',
    label: 'Randomize Vertices',
    description: 'Displace selected vertices by random amounts',
    props: [
      { id: 'offset', label: 'Amount', type: 'float', default: 0.1, min: -10, max: 10, softMin: -1, softMax: 1, subtype: 'distance' },
      { id: 'uniform', label: 'Uniform', type: 'float', default: 0, min: 0, max: 1, subtype: 'factor' },
      { id: 'normal', label: 'Normal', type: 'float', default: 0, min: 0, max: 1, subtype: 'factor' },
      { id: 'seed', label: 'Random Seed', type: 'int', default: 0, min: 0, max: 10000 },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const s = openSession('TRANSLATION');
      if (!s) return 'CANCELLED';
      const rand = seededRandom(p.seed as number);
      for (const e of s.data.elements) {
        const d = randomOffset(rand, p.offset as number, p.uniform as number, p.normal as number, e.normal ?? null).multiplyScalar(e.weight);
        e.apply(T(d), { mode: 'TRANSLATION', value: [d.x, d.y, d.z] });
      }
      s.data.onUpdate?.();
      s.data.finish();
    },
  },
]);

registerOperators([
  transformOp('transform.mirror', 'Mirror', 'MIRROR', 'Mirror selected items around one or more axes', [
    ...ORIENT_PROPS,
    CONSTRAINT_PROP,
    { id: 'axis', label: 'Axis', type: 'int', default: -1, hidden: true },
  ]),
  transformOp('transform.tilt', 'Tilt', 'TILT', 'Tilt the selected curve control points', [{ id: 'value', label: 'Angle', type: 'float', default: 0, subtype: 'angle' }, ...PROPORTIONAL_PROPS], () => !!activeView3D() && curveEditData() !== null),
]);

function curveEditData() {
  const ob = app.activeObject;
  if (app.doc.mode !== 'EDIT' || ob?.type !== 'CURVE' || !ob.data) return null;
  const cu = app.doc.curves[ob.data];
  return cu ? { ob, cu } : null;
}

// Curve tilt and radius: each selected control point keeps its own starting value
const valueProvider: TProvider = {
  collect({ mode }) {
    if (!mode || !VALUE_MODES.has(mode)) return null;
    const c = curveEditData();
    if (!c) return null;
    const world = app.graph.get(c.ob.id)?.world ?? new Matrix4();
    const elements: TElement[] = [];
    for (const sp of c.cu.splines) {
      const pts = sp.type === 'BEZIER' ? sp.bezier_points.filter((b) => b.select_control_point) : sp.points.filter((p) => p.select);
      for (const p of pts) {
        const t0 = p.tilt,
          r0 = p.radius;
        elements.push({
          center: new Vector3(p.co[0], p.co[1], p.co[2]).applyMatrix4(world),
          basis: new Matrix3(),
          weight: 1,
          apply(_m, ctx) {
            if (ctx.mode === 'TILT') p.tilt = t0 + (ctx.value[0] ?? 0);
            else if (ctx.mode === 'CURVE_SHRINKFATTEN') p.radius = Math.max(0, r0 * (ctx.value[0] ?? 1));
          },
          restore() {
            p.tilt = t0;
            p.radius = r0;
          },
        });
      }
    }
    if (!elements.length) return null;
    return { elements, label: 'Curve Points', finish() {}, cancel() {}, onUpdate: () => app.changed('doc', 'geometry') };
  },
};

// The generic transform operator (mode chosen by property). Other editors may already provide
// modes of their own (e.g. Time Extend in the sequencer); those keep working through it.
const GENERIC_MODES: [string, TransformMode][] = [
  ['TRANSLATION', 'TRANSLATION'],
  ['ROTATION', 'ROTATION'],
  ['RESIZE', 'RESIZE'],
  ['TRACKBALL', 'TRACKBALL'],
  ['TOSPHERE', 'TOSPHERE'],
  ['SHEAR', 'SHEAR'],
  ['BEND', 'BEND'],
  ['SHRINKFATTEN', 'SHRINKFATTEN'],
  ['PUSHPULL', 'PUSHPULL'],
  ['TILT', 'TILT'],
  ['CURVE_SHRINKFATTEN', 'CURVE_SHRINKFATTEN'],
  ['GPENCIL_OPACITY', 'GPENCIL_OPACITY'],
];
onAppReady(() => {
  const prev = operators.get('transform.transform');
  const mine = (m: unknown) => GENERIC_MODES.find(([id]) => id === m)?.[1];
  registerOperator({
    idname: 'transform.transform',
    label: 'Transform',
    description: 'Transform selected items using the chosen transform mode',
    props: [
      { id: 'mode', label: 'Mode', type: 'enum', default: 'TRANSLATION', items: [...GENERIC_MODES.map(([id]) => [id, id[0] + id.slice(1).toLowerCase()] as [string, string]), ['ALIGN', 'Align'], ...((prev?.props?.find((d) => d.id === 'mode')?.items ?? []) as [string, string][])] , hidden: true },
      { id: 'value', label: 'Values', type: 'vec3', default: [0, 0, 0] },
      ...ORIENT_PROPS,
    ],
    poll: (ctx) => (prev?.poll?.(ctx) ?? false) || v3dPoll(),
    invoke: (ctx, p) => {
      const m = mine(p.mode);
      if (m) return invokeModal(m, p, ctx);
      if (p.mode === 'ALIGN') return alignToOrientation(p);
      return prev?.invoke ? prev.invoke(ctx, p) : 'CANCELLED';
    },
    exec: (ctx, p) => {
      const m = mine(p.mode);
      if (p.mode === 'ALIGN') return alignToOrientation(p);
      if (!m) return prev?.exec ? prev.exec(ctx, p) : 'CANCELLED';
      const v = (p.value as number[]) ?? [];
      const props = m === 'SHEAR' ? { ...p, angle: v[0] ?? 0 } : m === 'TRANSLATION' || m === 'RESIZE' ? p : { ...p, value: m === 'TRACKBALL' ? [v[0] ?? 0, v[1] ?? 0] : v[0] ?? 0 };
      return execTransform(m, props);
    },
  });
});

/** Align to Transform Orientation: rotate the selected objects onto the chosen orientation. */
function alignToOrientation(p: Record<string, unknown>): 'FINISHED' | 'CANCELLED' {
  if (app.doc.mode !== 'OBJECT') return 'CANCELLED';
  const target = basisFromProps(p, currentOrientation()).basis;
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().setFromMatrix3(target));
  for (const ob of app.selectedObjects()) {
    const ev = app.graph.get(ob.id);
    if (!ev) continue;
    const pos = new Vector3(),
      rot = new Quaternion(),
      scl = new Vector3();
    ev.world.decompose(pos, rot, scl);
    const world = new Matrix4().compose(pos, q, scl);
    const parentInv = ob.parent ? app.graph.get(ob.parent)!.world.clone().multiply(toMatrix4(ob.matrix_parent_inverse)).invert() : new Matrix4();
    applyMatrixToObject(ob, parentInv.multiply(world));
  }
  app.changed('doc');
  return 'FINISHED';
}

export type { View3D };
