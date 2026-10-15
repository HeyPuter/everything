// Object and bone constraints. Each type transforms the owner's matrix, given in the
// constraint's owner space (see constraint_solve.ts for space conversion, influence and
// the evaluation order); `ctx.target` holds the target matrix in the target space.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Constraint, RotationMode, Vec3 } from '../data/types';
import type { ConstraintContext, ConstraintType } from './types';
import { compatibleEuler, threeOrder } from './transform';
import { curvePath, pathPoint } from './curvepath';
import { closestPointOnMesh, raycastMesh } from './geomquery';

// ---------------------------------------------------------------------------
// Small math helpers

export interface LocRotScale {
  p: Vector3;
  q: Quaternion;
  s: Vector3;
}

export function decompose(m: Matrix4): LocRotScale {
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  m.decompose(p, q, s);
  return { p, q, s };
}

export const AXES: Record<string, Vector3> = {
  TRACK_X: new Vector3(1, 0, 0),
  TRACK_Y: new Vector3(0, 1, 0),
  TRACK_Z: new Vector3(0, 0, 1),
  TRACK_NEGATIVE_X: new Vector3(-1, 0, 0),
  TRACK_NEGATIVE_Y: new Vector3(0, -1, 0),
  TRACK_NEGATIVE_Z: new Vector3(0, 0, -1),
  UP_X: new Vector3(1, 0, 0),
  UP_Y: new Vector3(0, 1, 0),
  UP_Z: new Vector3(0, 0, 1),
};

const axisVec = (name: unknown, fallback = 'TRACK_Y') => (AXES[name as string] ?? AXES[fallback]).clone();
const axisIndex = (name: unknown) => ({ X: 0, Y: 1, Z: 2 })[String(name).slice(-1) as 'X' | 'Y' | 'Z'] ?? 1;
const KEYS = ['x', 'y', 'z'] as const;

/** Rotation turning the local `trackAxis` towards `track` with `upAxis` as close as possible to `up`. */
export function lookRotation(track: Vector3, trackAxis: string, upAxis: string, up = new Vector3(0, 0, 1)): Quaternion | null {
  const t = track.clone().normalize();
  if (t.lengthSq() < 1e-12) return null;
  const ta = axisVec(trackAxis),
    ua = axisVec(upAxis, 'UP_Z');
  if (Math.abs(ta.dot(ua)) > 0.999) return null;
  // project the up direction onto the plane perpendicular to the track direction
  let u = up.clone().addScaledVector(t, -up.dot(t));
  if (u.lengthSq() < 1e-10) {
    // up is parallel to the track direction: fall back to any perpendicular
    u = Math.abs(t.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
    u.addScaledVector(t, -u.dot(t));
  }
  u.normalize();
  const localB = new Matrix4().makeBasis(ta, ua, new Vector3().crossVectors(ta, ua));
  const worldB = new Matrix4().makeBasis(t, u, new Vector3().crossVectors(t, u));
  return new Quaternion().setFromRotationMatrix(worldB.multiply(localB.invert()));
}

/** Euler order used by a constraint: its own setting or the owner's rotation mode. */
export function eulerOrder(c: Constraint, ctx: ConstraintContext, key = 'euler_order'): RotationMode {
  const o = (c[key] as string) ?? 'AUTO';
  if (o && o !== 'AUTO') return o as RotationMode;
  const mode = ctx.pchan ? ctx.ob.pose?.[ctx.pchan.name]?.rotation_mode : ctx.ob.rotation_mode;
  return !mode || mode === 'QUATERNION' || mode === 'AXIS_ANGLE' ? 'XYZ' : mode;
}

export function quatToEuler(q: Quaternion, order: RotationMode, ref?: Vec3): Vec3 {
  const e = new Euler().setFromQuaternion(q, threeOrder(order));
  const v: Vec3 = [e.x, e.y, e.z];
  return ref ? compatibleEuler(v, ref) : v;
}

export function eulerToQuat(e: ArrayLike<number>, order: RotationMode): Quaternion {
  return new Quaternion().setFromEuler(new Euler(e[0], e[1], e[2], threeOrder(order)));
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** loc/rot/scale of `a` combined with `b` with a's scale applied along b's own axes (no shear). */
export function mulAligned(a: Matrix4, b: Matrix4, out = new Matrix4()): Matrix4 {
  const A = decompose(a),
    B = decompose(b);
  const loc = B.p.clone().applyMatrix4(a);
  return out.compose(loc, A.q.clone().multiply(B.q), B.s.clone().multiply(A.s));
}

/** Location, rotation and scale combined channel by channel (first then second). */
export function mulSplit(first: Matrix4, second: Matrix4, out = new Matrix4()): Matrix4 {
  const A = decompose(first),
    B = decompose(second);
  return out.compose(A.p.clone().add(B.p), A.q.clone().multiply(B.q), A.s.clone().multiply(B.s));
}

/** Mix a transform into the owner the way the copy-like constraints do. */
export function mixMatrix(owner: Matrix4, t: Matrix4, mode: string) {
  switch (mode) {
    case 'BEFORE_FULL':
      owner.premultiply(t);
      break;
    case 'AFTER_FULL':
      owner.multiply(t);
      break;
    case 'BEFORE':
      owner.copy(mulAligned(t, owner));
      break;
    case 'AFTER':
      owner.copy(mulAligned(owner, t));
      break;
    case 'BEFORE_SPLIT':
      owner.copy(mulSplit(t, owner));
      break;
    case 'AFTER_SPLIT':
      owner.copy(mulSplit(owner, t));
      break;
    default:
      owner.copy(t);
  }
}

/** Remove shear from a matrix keeping its Y axis direction (used for copied rotations). */
function orthogonalized(m: Matrix4): Matrix4 {
  const x = new Vector3(),
    y = new Vector3(),
    z = new Vector3();
  m.extractBasis(x, y, z);
  const sx = x.length(),
    sy = y.length(),
    sz = z.length();
  if (sy < 1e-12) return m.clone();
  y.normalize();
  z.addScaledVector(y, -z.dot(y)).normalize();
  const nx = new Vector3().crossVectors(y, z);
  if (nx.dot(x) < 0) nx.negate();
  const out = new Matrix4().makeBasis(nx.multiplyScalar(sx), y.multiplyScalar(sy), z.multiplyScalar(sz));
  out.setPosition(new Vector3().setFromMatrixPosition(m));
  return out;
}

/** Wrap an angle into the range around `center` and clamp it to [min, max] going the short way round. */
export function clampAngle(a: number, min: number, max: number): number {
  if (min > max) [min, max] = [max, min];
  if (a >= min && a <= max) return a;
  const TAU = Math.PI * 2;
  const mid = (min + max) / 2;
  const w = mid + ((((a - mid + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  if (w >= min && w <= max) return w;
  // outside: pick the nearer bound (measured around the circle)
  const dMin = Math.abs(((((w - min + Math.PI) % TAU) + TAU) % TAU) - Math.PI),
    dMax = Math.abs(((((w - max + Math.PI) % TAU) + TAU) % TAU) - Math.PI);
  return dMin < dMax ? min : max;
}

/** Soft limit of a volume bulge factor (used by Stretch To and Spline IK). */
export function limitBulge(bulge: number, c: Constraint): number {
  const smooth = (c.bulge_smooth as number) ?? 0;
  if (c.use_bulge_max && bulge > 1) {
    const bmax = Math.max(1, (c.bulge_max as number) ?? 1);
    const hard = Math.min(bulge, bmax),
      range = bmax - 1;
    const soft = 1 + (range > 0 ? (range * Math.atan((bulge - 1) / range)) / (Math.PI / 2) : 0);
    bulge = lerp(hard, soft, smooth);
  }
  if (c.use_bulge_min && bulge < 1) {
    const bmin = clamp((c.bulge_min as number) ?? 1, 0, 1);
    const hard = Math.max(bulge, bmin),
      range = 1 - bmin;
    const soft = 1 + (range > 0 ? (range * Math.atan((bulge - 1) / range)) / (Math.PI / 2) : 0);
    bulge = lerp(hard, soft, smooth);
  }
  return bulge;
}

const T = (ctx: ConstraintContext) => ctx.target ?? null;

/** A standard target constraint type (target object, optional bone and head/tail). */
function targeted(def: Omit<ConstraintType, 'usesTarget' | 'spaces'> & { spaces?: ConstraintType['spaces'] }): ConstraintType {
  return { spaces: { owner: true, target: true }, ...def, usesTarget: true };
}

// ---------------------------------------------------------------------------
// Constraint types

export const constraintTypes: Record<string, ConstraintType> = {
  COPY_LOCATION: targeted({
    type: 'COPY_LOCATION',
    label: 'Copy Location',
    category: 'TRANSFORM',
    defaults: () => ({ use_x: true, use_y: true, use_z: true, invert_x: false, invert_y: false, invert_z: false, use_offset: false, head_tail: 0, use_bbone_shape: false }),
    apply(owner, c, ctx) {
      const t = T(ctx);
      if (!t) return;
      const o = decompose(owner);
      const tp = new Vector3().setFromMatrixPosition(t);
      KEYS.forEach((k) => {
        if (c[`use_${k}`] === false) return;
        const v = c[`invert_${k}`] ? -tp[k] : tp[k];
        o.p[k] = c.use_offset ? o.p[k] + v : v;
      });
      owner.setPosition(o.p);
    },
  }),
  COPY_ROTATION: targeted({
    type: 'COPY_ROTATION',
    label: 'Copy Rotation',
    category: 'TRANSFORM',
    defaults: () => ({ use_x: true, use_y: true, use_z: true, invert_x: false, invert_y: false, invert_z: false, euler_order: 'AUTO', mix_mode: 'REPLACE' }),
    apply(owner, c, ctx) {
      const t = T(ctx);
      if (!t) return;
      const order = eulerOrder(c, ctx);
      const o = decompose(owner);
      const own = quatToEuler(o.q, order);
      const tq = decompose(orthogonalized(t)).q;
      const eul = quatToEuler(tq, order, own);
      const mode = (c.mix_mode as string) ?? 'REPLACE';
      if (mode === 'OFFSET') {
        // legacy offset: each enabled axis of the copied rotation is turned further by the owner's angle
        let e = eul;
        for (let i = 0; i < 3; i++) {
          if (c[`use_${KEYS[i]}`] === false) {
            e[i] = own[i];
            continue;
          }
          const axis = new Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
          e = quatToEuler(eulerToQuat(e, order).multiply(new Quaternion().setFromAxisAngle(axis, own[i])), order, e);
          if (c[`invert_${KEYS[i]}`]) e[i] = -e[i];
        }
        owner.compose(o.p, eulerToQuat(e, order), o.s);
        return;
      }
      const keepOwn = mode === 'REPLACE';
      for (let i = 0; i < 3; i++) {
        if (c[`use_${KEYS[i]}`] === false) eul[i] = keepOwn ? own[i] : 0;
        else if (c[`invert_${KEYS[i]}`]) eul[i] = -eul[i];
      }
      let q: Quaternion;
      if (mode === 'ADD') q = eulerToQuat([own[0] + eul[0], own[1] + eul[1], own[2] + eul[2]], order);
      else if (mode === 'BEFORE') q = eulerToQuat(eul, order).multiply(o.q);
      else if (mode === 'AFTER') q = o.q.clone().multiply(eulerToQuat(eul, order));
      else q = eulerToQuat(eul, order);
      owner.compose(o.p, q, o.s);
    },
  }),
  COPY_SCALE: targeted({
    type: 'COPY_SCALE',
    label: 'Copy Scale',
    category: 'TRANSFORM',
    defaults: () => ({ use_x: true, use_y: true, use_z: true, power: 1, use_make_uniform: false, use_offset: false, use_add: false }),
    apply(owner, c, ctx) {
      const t = T(ctx);
      if (!t) return;
      const o = decompose(owner),
        ts = decompose(t).s;
      const use = KEYS.map((k) => c[`use_${k}`] !== false);
      let target = [ts.x, ts.y, ts.z];
      if (c.use_make_uniform) {
        // one factor from the volume of the enabled axes, applied to all axes
        const vol = target.reduce((acc, v, i) => (use[i] ? acc * Math.abs(v) : acc), 1);
        const u = Math.cbrt(vol);
        target = [u, u, u];
        use.fill(true);
      }
      const pw = (c.power as number) ?? 1;
      target = target.map((v) => Math.sign(v) * Math.abs(v) ** pw);
      const own = [o.s.x, o.s.y, o.s.z];
      const s = own.map((ov, i) => {
        if (!use[i]) return ov;
        if (!c.use_offset) return target[i];
        return c.use_add ? ov + target[i] - 1 : ov * target[i];
      });
      owner.compose(o.p, o.q, new Vector3(s[0], s[1], s[2]));
    },
  }),
  COPY_TRANSFORMS: targeted({
    type: 'COPY_TRANSFORMS',
    label: 'Copy Transforms',
    category: 'TRANSFORM',
    defaults: () => ({ mix_mode: 'REPLACE', head_tail: 0, use_bbone_shape: false, remove_target_shear: false }),
    apply(owner, c, ctx) {
      const t = T(ctx);
      if (!t) return;
      mixMatrix(owner, c.remove_target_shear ? orthogonalized(t) : t, (c.mix_mode as string) ?? 'REPLACE');
    },
  }),
  LIMIT_DISTANCE: targeted({
    type: 'LIMIT_DISTANCE',
    label: 'Limit Distance',
    category: 'TRANSFORM',
    defaults: () => ({ distance: 0, limit_mode: 'LIMITDIST_INSIDE', head_tail: 0, use_bbone_shape: false, use_transform_limit: false }),
    apply(owner, c, ctx) {
      const t = T(ctx);
      if (!t) return;
      const p = new Vector3().setFromMatrixPosition(owner),
        tp = new Vector3().setFromMatrixPosition(t);
      const d = p.distanceTo(tp);
      // a zero distance is (re)initialised from the current distance
      if (!c.distance) c.distance = d;
      const dist = c.distance as number;
      const mode = c.limit_mode ?? 'LIMITDIST_INSIDE';
      const nd = mode === 'LIMITDIST_INSIDE' ? Math.min(d, dist) : mode === 'LIMITDIST_OUTSIDE' ? Math.max(d, dist) : dist;
      if (d > 1e-9 && nd !== d) owner.setPosition(p.sub(tp).multiplyScalar(nd / d).add(tp));
    },
  }),
  LIMIT_LOCATION: {
    type: 'LIMIT_LOCATION',
    label: 'Limit Location',
    category: 'TRANSFORM',
    spaces: { owner: true },
    defaults: () => ({ use_min_x: false, use_min_y: false, use_min_z: false, use_max_x: false, use_max_y: false, use_max_z: false, min_x: 0, min_y: 0, min_z: 0, max_x: 0, max_y: 0, max_z: 0, use_transform_limit: false }),
    apply(owner, c) {
      const p = new Vector3().setFromMatrixPosition(owner);
      KEYS.forEach((a) => {
        if (c[`use_min_${a}`]) p[a] = Math.max(p[a], c[`min_${a}`] as number);
        if (c[`use_max_${a}`]) p[a] = Math.min(p[a], c[`max_${a}`] as number);
      });
      owner.setPosition(p);
    },
  },
  LIMIT_ROTATION: {
    type: 'LIMIT_ROTATION',
    label: 'Limit Rotation',
    category: 'TRANSFORM',
    spaces: { owner: true },
    defaults: () => ({ use_limit_x: false, use_limit_y: false, use_limit_z: false, min_x: 0, min_y: 0, min_z: 0, max_x: 0, max_y: 0, max_z: 0, euler_order: 'AUTO', use_transform_limit: false, use_legacy_behavior: false }),
    apply(owner, c, ctx) {
      const order = eulerOrder(c, ctx);
      const o = decompose(owner);
      const e = quatToEuler(o.q, order);
      KEYS.forEach((a, i) => {
        if (!c[`use_limit_${a}`]) return;
        const lo = c[`min_${a}`] as number,
          hi = c[`max_${a}`] as number;
        e[i] = c.use_legacy_behavior ? clamp(e[i], lo, hi) : clampAngle(e[i], lo, hi);
      });
      owner.compose(o.p, eulerToQuat(e, order), o.s);
    },
  },
  LIMIT_SCALE: {
    type: 'LIMIT_SCALE',
    label: 'Limit Scale',
    category: 'TRANSFORM',
    spaces: { owner: true },
    defaults: () => ({ use_min_x: false, use_min_y: false, use_min_z: false, use_max_x: false, use_max_y: false, use_max_z: false, min_x: 1, min_y: 1, min_z: 1, max_x: 1, max_y: 1, max_z: 1, use_transform_limit: false }),
    apply(owner, c) {
      const o = decompose(owner);
      KEYS.forEach((a) => {
        if (c[`use_min_${a}`]) o.s[a] = Math.max(o.s[a], c[`min_${a}`] as number);
        if (c[`use_max_${a}`]) o.s[a] = Math.min(o.s[a], c[`max_${a}`] as number);
      });
      owner.compose(o.p, o.q, o.s);
    },
  },
  MAINTAIN_VOLUME: {
    type: 'MAINTAIN_VOLUME',
    label: 'Maintain Volume',
    category: 'TRANSFORM',
    spaces: { owner: true },
    defaults: () => ({ free_axis: 'SAMEVOL_Y', mode: 'STRICT', volume: 1 }),
    apply(owner, c) {
      const o = decompose(owner);
      const vol = (c.volume as number) ?? 1;
      const ax = KEYS[axisIndex(c.free_axis ?? 'SAMEVOL_Y')];
      const free = o.s[ax];
      let base: number;
      if (c.mode === 'UNIFORM') base = free ** 3;
      else if (c.mode === 'SINGLE_AXIS') base = free;
      else base = o.s.x * o.s.y * o.s.z;
      if (Math.abs(base) < 1e-12) return;
      const k = Math.sqrt(Math.abs(vol / base));
      KEYS.forEach((a) => a !== ax && (o.s[a] *= k));
      owner.compose(o.p, o.q, o.s);
    },
  },
  TRANSFORM: targeted({
    type: 'TRANSFORM',
    label: 'Transformation',
    category: 'TRANSFORM',
    defaults: () => ({
      map_from: 'LOCATION',
      map_to: 'LOCATION',
      map_to_x_from: 'X',
      map_to_y_from: 'Y',
      map_to_z_from: 'Z',
      use_motion_extrapolate: false,
      from_rotation_mode: 'AUTO',
      to_euler_order: 'AUTO',
      mix_mode: 'ADD',
      mix_mode_rot: 'ADD',
      mix_mode_scale: 'REPLACE',
      ...Object.fromEntries(KEYS.flatMap((a) => [`from_min_${a}`, `from_max_${a}`, `to_min_${a}`, `to_max_${a}`, `from_min_${a}_rot`, `from_max_${a}_rot`, `to_min_${a}_rot`, `to_max_${a}_rot`].map((k) => [k, 0]))),
      ...Object.fromEntries(KEYS.flatMap((a) => [`from_min_${a}_scale`, `from_max_${a}_scale`, `to_min_${a}_scale`, `to_max_${a}_scale`].map((k) => [k, 1]))),
    }),
    apply(owner, c, ctx) {
      const t = T(ctx);
      if (!t) return;
      const td = decompose(t);
      const from = (c.map_from as string) ?? 'LOCATION',
        to = (c.map_to as string) ?? 'LOCATION';
      const fsuf = from === 'ROTATION' ? '_rot' : from === 'SCALE' ? '_scale' : '';
      const tsuf = to === 'ROTATION' ? '_rot' : to === 'SCALE' ? '_scale' : '';
      let src: number[];
      if (from === 'LOCATION') src = [td.p.x, td.p.y, td.p.z];
      else if (from === 'SCALE') src = [td.s.x, td.s.y, td.s.z];
      else src = sourceRotation(td.q, (c.from_rotation_mode as string) ?? 'AUTO', c, ctx);
      const out = KEYS.map((a) => {
        const fa = KEYS[axisIndex(c[`map_to_${a}_from`] ?? a.toUpperCase())];
        const fi = KEYS.indexOf(fa);
        const fmin = (c[`from_min_${fa}${fsuf}`] as number) ?? 0,
          fmax = (c[`from_max_${fa}${fsuf}`] as number) ?? 0;
        let k = fmax !== fmin ? (src[fi] - fmin) / (fmax - fmin) : 0;
        if (!c.use_motion_extrapolate) k = clamp(k, 0, 1);
        const tmin = (c[`to_min_${a}${tsuf}`] as number) ?? 0,
          tmax = (c[`to_max_${a}${tsuf}`] as number) ?? 0;
        return tmin + (tmax - tmin) * k;
      });
      const o = decompose(owner);
      if (to === 'LOCATION') {
        const v = new Vector3(out[0], out[1], out[2]);
        owner.setPosition(c.mix_mode === 'REPLACE' ? v : o.p.add(v));
      } else if (to === 'SCALE') {
        const v = new Vector3(out[0], out[1], out[2]);
        owner.compose(o.p, o.q, c.mix_mode_scale === 'MULTIPLY' ? o.s.multiply(v) : v);
      } else {
        const order = eulerOrder(c, ctx, 'to_euler_order');
        const mode = (c.mix_mode_rot as string) ?? 'ADD';
        let q: Quaternion;
        if (mode === 'REPLACE') q = eulerToQuat(out, order);
        else if (mode === 'BEFORE') q = eulerToQuat(out, order).multiply(o.q);
        else if (mode === 'AFTER') q = o.q.clone().multiply(eulerToQuat(out, order));
        else {
          const e = quatToEuler(o.q, order);
          q = eulerToQuat([e[0] + out[0], e[1] + out[1], e[2] + out[2]], order);
        }
        owner.compose(o.p, q, o.s);
      }
    },
  }),
  CLAMP_TO: {
    type: 'CLAMP_TO',
    label: 'Clamp To',
    category: 'TRACKING',
    defaults: () => ({ main_axis: 'CLAMPTO_AUTO', use_cyclic: false }),
    deps: (c) => [c.target as string],
    isValid: (c, { doc }) => doc.objects[c.target as string]?.type === 'CURVE',
    apply(owner, c, ctx) {
      const tob = c.target ? ctx.graph.get(c.target as string) : undefined;
      const cu = tob?.ob.type === 'CURVE' && tob.ob.data ? ctx.doc.curves[tob.ob.data] : undefined;
      const path = cu ? curvePath(cu) : null;
      if (!tob || !path) return;
      // the path's bounds (in curve space, widened by the point radii) decide the clamping axis and
      // the path parameter; the owner's location is compared with them directly
      const min = new Vector3(Infinity, Infinity, Infinity),
        max = new Vector3(-Infinity, -Infinity, -Infinity);
      path.points.forEach((p, i) => {
        const r = Math.abs(path.radii[i] ?? 1);
        min.min(new Vector3(p.x - r, p.y - r, p.z - r));
        max.max(new Vector3(p.x + r, p.y + r, p.z + r));
      });
      const size = max.clone().sub(min);
      let axis: 0 | 1 | 2;
      if (c.main_axis === 'CLAMPTO_X') axis = 0;
      else if (c.main_axis === 'CLAMPTO_Y') axis = 1;
      else if (c.main_axis === 'CLAMPTO_Z') axis = 2;
      else axis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
      const k = KEYS[axis];
      const own = new Vector3().setFromMatrixPosition(owner);
      const len = size[k];
      let f = len > 1e-12 ? (own[k] - min[k]) / len : 0;
      if (c.use_cyclic && (f < 0 || f > 1)) f -= Math.floor(f);
      else f = clamp(f, 0, 1);
      const pt = pathPoint(path, f);
      owner.setPosition(pt.point.applyMatrix4(tob.world));
    },
  },
  DAMPED_TRACK: targeted({
    type: 'DAMPED_TRACK',
    label: 'Damped Track',
    category: 'TRACKING',
    spaces: {},
    defaults: () => ({ track_axis: 'TRACK_Y', head_tail: 0, use_bbone_shape: false }),
    apply(owner, c, ctx) {
      const t = T(ctx);
      if (!t) return;
      const o = decompose(owner);
      const dir = new Vector3().setFromMatrixPosition(t).sub(o.p);
      if (dir.lengthSq() < 1e-12) return;
      const axis = axisVec(c.track_axis).applyQuaternion(o.q);
      owner.compose(o.p, new Quaternion().setFromUnitVectors(axis, dir.normalize()).multiply(o.q), o.s);
    },
  }),
  LOCKED_TRACK: targeted({
    type: 'LOCKED_TRACK',
    label: 'Locked Track',
    category: 'TRACKING',
    spaces: {},
    defaults: () => ({ track_axis: 'TRACK_Y', lock_axis: 'LOCK_Z', head_tail: 0, use_bbone_shape: false }),
    isValid: (c) => axisIndex(c.track_axis) !== axisIndex(c.lock_axis),
    apply(owner, c, ctx) {
      const t = T(ctx);
      if (!t) return;
      const o = decompose(owner);
      const lock = axisVec(String(c.lock_axis ?? 'LOCK_Z').replace('LOCK_', 'TRACK_'), 'TRACK_Z').applyQuaternion(o.q).normalize();
      const track = axisVec(c.track_axis).applyQuaternion(o.q);
      const dir = new Vector3().setFromMatrixPosition(t).sub(o.p);
      dir.addScaledVector(lock, -dir.dot(lock));
      track.addScaledVector(lock, -track.dot(lock));
      if (dir.lengthSq() < 1e-12 || track.lengthSq() < 1e-12) return;
      dir.normalize();
      track.normalize();
      let ang = Math.acos(clamp(track.dot(dir), -1, 1));
      if (new Vector3().crossVectors(track, dir).dot(lock) < 0) ang = -ang;
      owner.compose(o.p, new Quaternion().setFromAxisAngle(lock, ang).multiply(o.q), o.s);
    },
  }),
  STRETCH_TO: targeted({
    type: 'STRETCH_TO',
    label: 'Stretch To',
    category: 'TRACKING',
    spaces: {},
    defaults: () => ({ rest_length: 0, bulge: 1, use_bulge_min: false, use_bulge_max: false, bulge_min: 1, bulge_max: 1, bulge_smooth: 0, volume: 'VOLUME_XZX', keep_axis: 'SWING_Y', head_tail: 0, use_bbone_shape: false }),
    apply(owner, c, ctx) {
      const t = T(ctx);
      if (!t) return;
      const o = decompose(owner);
      const dir = new Vector3().setFromMatrixPosition(t).sub(o.p);
      const dist = dir.length();
      if (dist < 1e-9) return;
      dir.divideScalar(dist);
      // length measured in the owner's own (Y) scale, so scaling the owner keeps it attached
      const rel = dist / (Math.abs(o.s.y) > 1e-12 ? o.s.y : 1);
      if (!c.rest_length) c.rest_length = rel;
      const stretch = rel / ((c.rest_length as number) || 1);
      const bulge = limitBulge((1 / stretch) ** ((c.bulge as number) ?? 1), c);
      const sx = c.volume === 'VOLUME_XZX' ? Math.sqrt(bulge) : c.volume === 'VOLUME_X' ? bulge : 1;
      const sz = c.volume === 'VOLUME_XZX' ? Math.sqrt(bulge) : c.volume === 'VOLUME_Z' ? bulge : 1;
      const xo = new Vector3(1, 0, 0).applyQuaternion(o.q),
        yo = new Vector3(0, 1, 0).applyQuaternion(o.q),
        zo = new Vector3(0, 0, 1).applyQuaternion(o.q);
      let x: Vector3, z: Vector3;
      if (c.keep_axis === 'PLANE_X') {
        z = new Vector3().crossVectors(xo, dir);
        if (z.lengthSq() < 1e-12) z = zo.clone();
        z.normalize();
        x = new Vector3().crossVectors(dir, z).normalize();
      } else if (c.keep_axis === 'PLANE_Z') {
        x = new Vector3().crossVectors(dir, zo);
        if (x.lengthSq() < 1e-12) x = xo.clone();
        x.normalize();
        z = new Vector3().crossVectors(x, dir).normalize();
      } else {
        const swing = new Quaternion().setFromUnitVectors(yo, dir);
        x = xo.applyQuaternion(swing);
        z = zo.applyQuaternion(swing);
      }
      const rot = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, dir, z));
      owner.compose(o.p, rot, new Vector3(o.s.x * sx, o.s.y * stretch, o.s.z * sz));
    },
  }),
  TRACK_TO: targeted({
    type: 'TRACK_TO',
    label: 'Track To',
    category: 'TRACKING',
    defaults: () => ({ track_axis: 'TRACK_NEGATIVE_Z', up_axis: 'UP_Y', use_target_z: false, head_tail: 0, use_bbone_shape: false }),
    isValid: (c) => axisIndex(c.track_axis) !== axisIndex(c.up_axis),
    apply(owner, c, ctx) {
      const t = T(ctx);
      if (!t) return;
      const o = decompose(owner);
      const dir = new Vector3().setFromMatrixPosition(t).sub(o.p);
      const up = c.use_target_z ? new Vector3(0, 0, 1).applyQuaternion(decompose(t).q) : new Vector3(0, 0, 1);
      const q = lookRotation(dir, (c.track_axis as string) ?? 'TRACK_NEGATIVE_Z', (c.up_axis as string) ?? 'UP_Y', up);
      if (q) owner.compose(o.p, q, o.s);
    },
  }),
  CHILD_OF: targeted({
    type: 'CHILD_OF',
    label: 'Child Of',
    category: 'RELATIONSHIP',
    spaces: {},
    defaults: () => ({
      inverse_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      use_location_x: true,
      use_location_y: true,
      use_location_z: true,
      use_rotation_x: true,
      use_rotation_y: true,
      use_rotation_z: true,
      use_scale_x: true,
      use_scale_y: true,
      use_scale_z: true,
      set_inverse_pending: true,
    }),
    apply(owner, c, ctx) {
      const t = T(ctx);
      if (!t) return;
      const parent = childOfParentMatrix(t, c);
      if (c.set_inverse_pending) {
        // the owner keeps its current placement: remember the parent's inverse at this moment
        c.inverse_matrix = Array.from(parent.clone().invert().elements);
        c.set_inverse_pending = false;
      }
      const inv = new Matrix4().fromArray(c.inverse_matrix as number[]);
      owner.premultiply(parent.multiply(inv));
    },
  }),
  FLOOR: targeted({
    type: 'FLOOR',
    label: 'Floor',
    category: 'RELATIONSHIP',
    spaces: {},
    defaults: () => ({ floor_location: 'FLOOR_Z', offset: 0, use_rotation: false }),
    apply(owner, c, ctx) {
      const t = T(ctx);
      if (!t) return;
      const name = String(c.floor_location ?? 'FLOOR_Z');
      const neg = name.includes('NEGATIVE');
      const k = KEYS[axisIndex(name)];
      const off = (c.offset as number) ?? 0;
      const p = new Vector3().setFromMatrixPosition(owner);
      if (c.use_rotation) {
        // the floor plane follows the target's orientation
        const frame = new Matrix4().compose(new Vector3().setFromMatrixPosition(t), decompose(t).q, new Vector3(1, 1, 1));
        const lp = p.clone().applyMatrix4(frame.clone().invert());
        if (!neg && lp[k] < off) lp[k] = off;
        else if (neg && lp[k] > off) lp[k] = off;
        else return;
        owner.setPosition(lp.applyMatrix4(frame));
        return;
      }
      const tp = new Vector3().setFromMatrixPosition(t);
      const limit = tp[k] + off;
      if (!neg && p[k] < limit) p[k] = limit;
      else if (neg && p[k] > limit) p[k] = limit;
      else return;
      owner.setPosition(p);
    },
  }),
  FOLLOW_PATH: {
    type: 'FOLLOW_PATH',
    label: 'Follow Path',
    category: 'RELATIONSHIP',
    defaults: () => ({ offset: 0, offset_factor: 0, use_curve_follow: false, use_fixed_location: false, use_curve_radius: false, forward_axis: 'FORWARD_Y', up_axis: 'UP_Z', path_duration: 100 }),
    deps: (c) => [c.target as string],
    isValid: (c, { doc }) => doc.objects[c.target as string]?.type === 'CURVE',
    apply(owner, c, ctx) {
      const tob = c.target ? ctx.graph.get(c.target as string) : undefined;
      const cu = tob?.ob.type === 'CURVE' && tob.ob.data ? ctx.doc.curves[tob.ob.data] : undefined;
      const path = cu ? curvePath(cu) : null;
      if (!tob || !cu || !path) return;
      let f: number;
      if (c.use_fixed_location) f = (c.offset_factor as number) ?? 0;
      else {
        // the curve's evaluation time drives the path once it is set (Animate Path); before that the
        // scene frame does, so a new path constraint moves without extra setup
        const time = typeof cu.eval_time === 'number' ? cu.eval_time : ctx.frame - 1;
        const dur = typeof cu.eval_time === 'number' ? cu.path_duration || 100 : (c.path_duration as number) || cu.path_duration || 100;
        f = (time - ((c.offset as number) ?? 0)) / dur;
      }
      f = path.cyclic ? ((f % 1) + 1) % 1 : clamp(f, 0, 1);
      const pt = pathPoint(path, f);
      const world = pt.point.applyMatrix4(tob.world);
      const o = decompose(owner);
      let q = o.q;
      if (c.use_curve_follow) {
        const dir = pt.tangent.transformDirection(tob.world);
        const fwd = String(c.forward_axis ?? 'FORWARD_Y').replace('FORWARD_', 'TRACK_');
        const up = new Vector3(0, 0, 1).transformDirection(tob.world);
        const look = lookRotation(dir, fwd, (c.up_axis as string) ?? 'UP_Z', up);
        if (look) {
          if (pt.tilt) look.premultiply(new Quaternion().setFromAxisAngle(dir.clone().normalize(), pt.tilt));
          q = look.multiply(o.q);
        }
      }
      const s = c.use_curve_radius ? o.s.multiplyScalar(pt.radius) : o.s;
      owner.compose(o.p.add(world), q, s);
    },
  },
  PIVOT: targeted({
    type: 'PIVOT',
    label: 'Pivot',
    category: 'RELATIONSHIP',
    spaces: {},
    defaults: () => ({ offset: [0, 0, 0], use_relative_location: true, rotation_range: 'NX', head_tail: 0, use_bbone_shape: false }),
    apply(owner, c, ctx) {
      const o = decompose(owner);
      const range = (c.rotation_range as string) ?? 'NX';
      if (range !== 'ALWAYS_ACTIVE') {
        // only active while the owner's rotation around the axis is on the chosen side
        const e = quatToEuler(o.q, eulerOrder(c, ctx));
        const v = e[axisIndex(range)];
        if (range.startsWith('N') ? v >= 0 : v <= 0) return;
      }
      const off = new Vector3(...((c.offset as number[]) ?? [0, 0, 0]));
      const t = T(ctx);
      let pivot: Vector3;
      if (t) pivot = new Vector3().setFromMatrixPosition(t).add(off);
      else if (c.use_relative_location !== false) pivot = o.p.clone().add(off);
      else pivot = off;
      const rel = o.p.clone().sub(pivot).applyQuaternion(o.q);
      owner.setPosition(pivot.add(rel));
    },
  }),
  SHRINKWRAP: {
    type: 'SHRINKWRAP',
    label: 'Shrinkwrap',
    category: 'RELATIONSHIP',
    needsTargetData: true,
    defaults: () => ({ shrinkwrap_type: 'NEAREST_SURFACE', wrap_mode: 'ON_SURFACE', distance: 0, project_axis: 'POS_Z', project_axis_space: 'LOCAL', project_limit: 0, use_project_opposite: false, cull_face: 'OFF', use_invert_cull: false, use_track_normal: false, track_axis: 'TRACK_X' }),
    deps: (c) => [c.target as string],
    isValid: (c, { doc }) => doc.objects[c.target as string]?.type === 'MESH',
    apply(owner, c, ctx) {
      const t = c.target ? ctx.graph.get(c.target as string) : undefined;
      if (!t?.mesh || t.ob.type !== 'MESH') return;
      shrinkwrap(owner, c, t.world, t.mesh);
    },
  },
};

// IK and Spline IK are pose bone constraints solved by the armature evaluation (eval/ik.ts, eval/splineik.ts).
constraintTypes.IK = {
  type: 'IK',
  label: 'Inverse Kinematics',
  category: 'TRACKING',
  boneOnly: true,
  defaults: () => ({
    chain_count: 0,
    iterations: 500,
    pole_target: null,
    pole_subtarget: '',
    pole_angle: 0,
    use_tail: true,
    use_stretch: true,
    weight: 1,
    orient_weight: 1,
    use_location: true,
    use_rotation: false,
    reference_axis: 'BONE',
  }),
  deps: (c) => [c.pole_target as string],
  apply() {},
};
constraintTypes.SPLINE_IK = {
  type: 'SPLINE_IK',
  label: 'Spline IK',
  category: 'TRACKING',
  boneOnly: true,
  defaults: () => ({
    chain_count: 1,
    use_chain_offset: false,
    use_even_divisions: false,
    use_curve_radius: true,
    xz_scale_mode: 'NONE',
    y_scale_mode: 'FIT_CURVE',
    use_original_scale: true,
    bulge: 1,
    use_bulge_min: false,
    use_bulge_max: false,
    bulge_min: 1,
    bulge_max: 1,
    bulge_smooth: 0,
  }),
  deps: (c) => [c.target as string],
  isValid: (c, { doc }) => doc.objects[c.target as string]?.type === 'CURVE',
  apply() {},
};

/** Child Of parent matrix with the disabled location/rotation/scale channels removed. */
function childOfParentMatrix(t: Matrix4, c: Constraint): Matrix4 {
  const all = KEYS.every((a) => c[`use_location_${a}`] !== false && c[`use_rotation_${a}`] !== false && c[`use_scale_${a}`] !== false);
  if (all) return t.clone();
  const d = decompose(t);
  const e = new Euler().setFromQuaternion(d.q, 'ZYX');
  const loc = new Vector3(...KEYS.map((a) => (c[`use_location_${a}`] !== false ? d.p[a] : 0)));
  const rot = new Euler(...(KEYS.map((a) => (c[`use_rotation_${a}`] !== false ? e[a] : 0)) as [number, number, number]), 'ZYX');
  const scale = new Vector3(...KEYS.map((a) => (c[`use_scale_${a}`] !== false ? d.s[a] : 1)));
  return new Matrix4().compose(loc, new Quaternion().setFromEuler(rot), scale);
}

/** Target rotation as three values for the Transformation constraint's rotation source. */
function sourceRotation(q: Quaternion, mode: string, c: Constraint, ctx: ConstraintContext): number[] {
  if (mode === 'QUATERNION') {
    // the vector part scaled to angles: 2*asin-free approximation of the rotation vector
    const qq = q.w < 0 ? new Quaternion(-q.x, -q.y, -q.z, -q.w) : q;
    const ang = 2 * Math.acos(clamp(qq.w, -1, 1));
    const s = Math.sqrt(Math.max(0, 1 - qq.w * qq.w));
    return s < 1e-9 ? [0, 0, 0] : [(qq.x / s) * ang, (qq.y / s) * ang, (qq.z / s) * ang];
  }
  if (mode.startsWith('SWING_TWIST_')) {
    // twist around the chosen axis (applied first), then the swing that aims that axis
    const ax = axisIndex(mode);
    const comp = [q.x, q.y, q.z][ax];
    const twistAngle = 2 * Math.atan2(comp, q.w);
    const axis = new Vector3(0, 0, 0).setComponent(ax, 1);
    const twist = new Quaternion().setFromAxisAngle(axis, twistAngle);
    const swing = q.clone().multiply(twist.invert());
    const out = sourceRotation(swing, 'QUATERNION', c, ctx);
    out[ax] = twistAngle;
    return out;
  }
  return quatToEuler(q, mode === 'AUTO' ? 'XYZ' : (mode as RotationMode));
}

/** Place the owner on (or relative to) the target mesh surface. */
function shrinkwrap(owner: Matrix4, c: Constraint, world: Matrix4, mesh: import('./types').EvalMesh) {
  const o = decompose(owner);
  const inv = world.clone().invert();
  const lp = o.p.clone().applyMatrix4(inv);
  const type = (c.shrinkwrap_type as string) ?? 'NEAREST_SURFACE';
  let hit: { point: Vector3; normal: Vector3 } | null = null;
  if (type === 'NEAREST_VERTEX') {
    const P = mesh.positions;
    let best = Infinity,
      bi = -1;
    for (let i = 0; i < P.length; i += 3) {
      const d = (P[i] - lp.x) ** 2 + (P[i + 1] - lp.y) ** 2 + (P[i + 2] - lp.z) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    if (bi >= 0) {
      const pt = new Vector3(P[bi], P[bi + 1], P[bi + 2]);
      hit = { point: pt, normal: lp.clone().sub(pt).normalize() };
    }
  } else if (type === 'PROJECT') {
    const name = String(c.project_axis ?? 'POS_Z');
    const dirLocal = new Vector3(0, 0, 0);
    dirLocal.setComponent(axisIndex(name), name.startsWith('NEG') ? -1 : 1);
    // the projection axis is given in the owner's local orientation unless world space is chosen
    const dirWorld = c.project_axis_space === 'WORLD' ? dirLocal : dirLocal.applyQuaternion(o.q);
    const d = dirWorld.clone().transformDirection(inv);
    const limit = (c.project_limit as number) ?? 0;
    const cull = (c.cull_face as string) ?? 'OFF';
    const tryDir = (dir: Vector3, invertCull: boolean) => raycastMesh(mesh, lp, dir, limit > 0 ? limit : Infinity, cull === 'OFF' ? 'OFF' : (cull === 'FRONT') !== invertCull ? 'FRONT' : 'BACK');
    let r = tryDir(d, false);
    if (c.use_project_opposite) {
      const r2 = tryDir(d.clone().negate(), !!c.use_invert_cull);
      if (r2 && (!r || r2.distance < r.distance)) r = r2;
    }
    if (r) hit = { point: r.point, normal: r.normal };
  } else {
    const r = closestPointOnMesh(mesh, lp);
    if (r) hit = { point: r.point, normal: r.normal };
  }
  if (!hit) return;
  const pw = hit.point.clone().applyMatrix4(world);
  const nw = hit.normal.clone().transformDirection(world);
  const dist = (c.distance as number) ?? 0;
  const mode = (c.wrap_mode as string) ?? 'ON_SURFACE';
  const toOwner = o.p.clone().sub(pw);
  const n = nw.lengthSq() > 1e-12 ? nw.clone().normalize() : toOwner.clone().normalize();
  const side = toOwner.dot(n);
  let result: Vector3;
  if (mode === 'INSIDE' || mode === 'OUTSIDE') {
    // only points on the wrong side (or closer than the distance) are moved
    const ok = mode === 'INSIDE' ? side < 0 : side > 0;
    if (ok && toOwner.length() >= dist) return;
    result = pw.clone().addScaledVector(n, mode === 'INSIDE' ? -dist : dist);
  } else if (mode === 'ABOVE_SURFACE') result = pw.clone().addScaledVector(n, dist);
  else {
    const dir = toOwner.lengthSq() > 1e-12 ? toOwner.clone().normalize() : n.clone();
    if (mode === 'OUTSIDE_SURFACE' && side < 0) dir.negate();
    result = pw.clone().addScaledVector(dir, dist);
  }
  let q = o.q;
  if (c.use_track_normal && nw.lengthSq() > 0) {
    const axis = axisVec(c.track_axis, 'TRACK_X').applyQuaternion(o.q);
    q = new Quaternion().setFromUnitVectors(axis.normalize(), nw.normalize()).multiply(o.q);
  }
  owner.compose(result, q, o.s);
}

/** Bone-level constraint labels (kept for older callers; IK types are in `constraintTypes`). */
export const boneOnlyConstraints: Record<string, string> = { IK: 'Inverse Kinematics', SPLINE_IK: 'Spline IK' };

/** Order of the types in the Add Constraint menus. */
export const CONSTRAINT_ORDER = [
  'CAMERA_SOLVER',
  'FOLLOW_TRACK',
  'OBJECT_SOLVER',
  'COPY_LOCATION',
  'COPY_ROTATION',
  'COPY_SCALE',
  'COPY_TRANSFORMS',
  'LIMIT_DISTANCE',
  'LIMIT_LOCATION',
  'LIMIT_ROTATION',
  'LIMIT_SCALE',
  'MAINTAIN_VOLUME',
  'TRANSFORM',
  'TRANSFORM_CACHE',
  'CLAMP_TO',
  'DAMPED_TRACK',
  'IK',
  'LOCKED_TRACK',
  'SPLINE_IK',
  'STRETCH_TO',
  'TRACK_TO',
  'ACTION',
  'ARMATURE',
  'CHILD_OF',
  'FLOOR',
  'FOLLOW_PATH',
  'GEOMETRY_ATTRIBUTE',
  'PIVOT',
  'SHRINKWRAP',
];

/** Constraint types available for an owner (bone-only types need a pose bone), in menu order. */
export function availableConstraintTypes(bone: boolean): ConstraintType[] {
  const rank = (t: string) => {
    const i = CONSTRAINT_ORDER.indexOf(t);
    return i < 0 ? 1000 : i;
  };
  return Object.values(constraintTypes)
    .filter((t) => bone || !t.boneOnly)
    .sort((a, b) => rank(a.type) - rank(b.type));
}

/** Unique constraint name within a stack ("Copy Location", "Copy Location.001", …). */
export function uniqueConstraintName(base: string, list: { name: string }[]): string {
  const names = new Set(list.map((c) => c.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

export function newConstraint(type: string, id: string, list?: { name: string }[]): Constraint {
  const t = constraintTypes[type];
  const label = t?.label ?? boneOnlyConstraints[type] ?? type;
  return {
    id,
    name: list ? uniqueConstraintName(label, list) : label,
    type,
    mute: false,
    influence: 1,
    show_expanded: true,
    target: null,
    subtarget: '',
    owner_space: 'WORLD',
    target_space: 'WORLD',
    space_object: null,
    space_subtarget: '',
    ...(t?.defaults() ?? {}),
  };
}
