// Object constraints, evaluated in world space on the owner matrix.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Constraint } from '../data/types';
import type { ConstraintContext, ConstraintType } from './types';
import { sampleSpline } from './curve';

const v2 = new Vector3();

function targetMatrix(c: Constraint, ctx: ConstraintContext): Matrix4 | null {
  const t = c.target ? ctx.graph.get(c.target as string) : undefined;
  if (!t) return null;
  const m = t.world.clone();
  if (c.subtarget && t.pose) {
    const b = t.pose.bones.get(c.subtarget as string);
    if (b) {
      m.multiply(b.pose);
      const headTail = (c.head_tail as number) ?? 0;
      if (headTail) m.multiply(new Matrix4().makeTranslation(0, b.length * headTail, 0));
    }
  }
  return m;
}

const AXES: Record<string, Vector3> = {
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

function decompose(m: Matrix4) {
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  m.decompose(p, q, s);
  return { p, q, s };
}

function lookRotation(track: Vector3, trackAxis: string, upAxis: string, worldUp = new Vector3(0, 0, 1)): Quaternion {
  // Build a basis where `trackAxis` points along `track` and `upAxis` is as close to worldUp as possible.
  const t = track.clone().normalize();
  let up = worldUp.clone();
  if (Math.abs(up.dot(t)) > 0.9999) up = new Vector3(0, 1, 0);
  const side = new Vector3().crossVectors(up, t).normalize();
  const realUp = new Vector3().crossVectors(t, side).normalize();
  // target frame columns for local axes
  const axisVec = (name: string) => AXES[name] ?? AXES.TRACK_Y;
  const ta = axisVec(trackAxis),
    ua = axisVec(upAxis);
  // local basis (ta, ua, ta×ua) → world basis (t, realUp, t×realUp)
  const localB = new Matrix4().makeBasis(ta, ua, new Vector3().crossVectors(ta, ua));
  const worldB = new Matrix4().makeBasis(t, realUp, new Vector3().crossVectors(t, realUp));
  const m = worldB.multiply(localB.clone().invert());
  return new Quaternion().setFromRotationMatrix(m);
}

function mixAxes(cur: Vector3, tgt: Vector3, c: Constraint, invertPrefix = 'invert_') {
  const use = [c.use_x !== false, c.use_y !== false, c.use_z !== false];
  const inv = [!!c[`${invertPrefix}x`], !!c[`${invertPrefix}y`], !!c[`${invertPrefix}z`]];
  const arr = [tgt.x, tgt.y, tgt.z].map((v, i) => (inv[i] ? -v : v));
  const base = [cur.x, cur.y, cur.z];
  const off = !!c.use_offset;
  return new Vector3(...arr.map((v, i) => (use[i] ? (off ? base[i] + v : v) : base[i])));
}

export const constraintTypes: Record<string, ConstraintType> = {
  COPY_LOCATION: {
    type: 'COPY_LOCATION',
    label: 'Copy Location',
    category: 'TRANSFORM',
    defaults: () => ({ use_x: true, use_y: true, use_z: true, invert_x: false, invert_y: false, invert_z: false, use_offset: false, head_tail: 0 }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      if (!t) return;
      const o = decompose(owner);
      v2.setFromMatrixPosition(t);
      owner.compose(mixAxes(o.p, v2, c), o.q, o.s);
    },
  },
  COPY_ROTATION: {
    type: 'COPY_ROTATION',
    label: 'Copy Rotation',
    category: 'TRANSFORM',
    defaults: () => ({ use_x: true, use_y: true, use_z: true, invert_x: false, invert_y: false, invert_z: false, mix_mode: 'REPLACE' }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      if (!t) return;
      const o = decompose(owner),
        tt = decompose(t);
      const eo = new Euler().setFromQuaternion(o.q, 'ZYX'),
        et = new Euler().setFromQuaternion(tt.q, 'ZYX');
      const r = mixAxes(new Vector3(eo.x, eo.y, eo.z), new Vector3(et.x, et.y, et.z), c);
      if (c.mix_mode === 'ADD' || c.mix_mode === 'AFTER') {
        owner.compose(o.p, o.q.multiply(tt.q), o.s);
        return;
      }
      owner.compose(o.p, new Quaternion().setFromEuler(new Euler(r.x, r.y, r.z, 'ZYX')), o.s);
    },
  },
  COPY_SCALE: {
    type: 'COPY_SCALE',
    label: 'Copy Scale',
    category: 'TRANSFORM',
    defaults: () => ({ use_x: true, use_y: true, use_z: true, use_offset: false, power: 1 }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      if (!t) return;
      const o = decompose(owner),
        tt = decompose(t);
      const pw = (c.power as number) ?? 1;
      tt.s.set(tt.s.x ** pw, tt.s.y ** pw, tt.s.z ** pw);
      const use = [c.use_x !== false, c.use_y !== false, c.use_z !== false];
      const s = new Vector3(use[0] ? tt.s.x * (c.use_offset ? o.s.x : 1) : o.s.x, use[1] ? tt.s.y * (c.use_offset ? o.s.y : 1) : o.s.y, use[2] ? tt.s.z * (c.use_offset ? o.s.z : 1) : o.s.z);
      owner.compose(o.p, o.q, s);
    },
  },
  COPY_TRANSFORMS: {
    type: 'COPY_TRANSFORMS',
    label: 'Copy Transforms',
    category: 'TRANSFORM',
    defaults: () => ({ mix_mode: 'REPLACE' }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      if (!t) return;
      if (c.mix_mode === 'AFTER') owner.multiply(t);
      else if (c.mix_mode === 'BEFORE') owner.premultiply(t);
      else owner.copy(t);
    },
  },
  LIMIT_LOCATION: {
    type: 'LIMIT_LOCATION',
    label: 'Limit Location',
    category: 'TRANSFORM',
    defaults: () => ({ use_min_x: false, use_min_y: false, use_min_z: false, use_max_x: false, use_max_y: false, use_max_z: false, min_x: 0, min_y: 0, min_z: 0, max_x: 0, max_y: 0, max_z: 0, owner_space: 'WORLD' }),
    apply(owner, c) {
      const o = decompose(owner);
      const p = [o.p.x, o.p.y, o.p.z];
      'xyz'.split('').forEach((a, i) => {
        if (c[`use_min_${a}`]) p[i] = Math.max(p[i], c[`min_${a}`] as number);
        if (c[`use_max_${a}`]) p[i] = Math.min(p[i], c[`max_${a}`] as number);
      });
      owner.compose(new Vector3(...p), o.q, o.s);
    },
  },
  LIMIT_ROTATION: {
    type: 'LIMIT_ROTATION',
    label: 'Limit Rotation',
    category: 'TRANSFORM',
    defaults: () => ({ use_limit_x: false, use_limit_y: false, use_limit_z: false, min_x: 0, min_y: 0, min_z: 0, max_x: 0, max_y: 0, max_z: 0 }),
    apply(owner, c) {
      const o = decompose(owner);
      const e = new Euler().setFromQuaternion(o.q, 'ZYX');
      const r = [e.x, e.y, e.z];
      'xyz'.split('').forEach((a, i) => {
        if (c[`use_limit_${a}`]) r[i] = Math.min(c[`max_${a}`] as number, Math.max(c[`min_${a}`] as number, r[i]));
      });
      owner.compose(o.p, new Quaternion().setFromEuler(new Euler(r[0], r[1], r[2], 'ZYX')), o.s);
    },
  },
  LIMIT_SCALE: {
    type: 'LIMIT_SCALE',
    label: 'Limit Scale',
    category: 'TRANSFORM',
    defaults: () => ({ use_min_x: false, use_min_y: false, use_min_z: false, use_max_x: false, use_max_y: false, use_max_z: false, min_x: 1, min_y: 1, min_z: 1, max_x: 1, max_y: 1, max_z: 1 }),
    apply(owner, c) {
      const o = decompose(owner);
      const s = [o.s.x, o.s.y, o.s.z];
      'xyz'.split('').forEach((a, i) => {
        if (c[`use_min_${a}`]) s[i] = Math.max(s[i], c[`min_${a}`] as number);
        if (c[`use_max_${a}`]) s[i] = Math.min(s[i], c[`max_${a}`] as number);
      });
      owner.compose(o.p, o.q, new Vector3(...s));
    },
  },
  LIMIT_DISTANCE: {
    type: 'LIMIT_DISTANCE',
    label: 'Limit Distance',
    category: 'TRANSFORM',
    defaults: () => ({ distance: 0, limit_mode: 'LIMITDIST_INSIDE' }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      if (!t) return;
      const o = decompose(owner);
      v2.setFromMatrixPosition(t);
      const d = o.p.distanceTo(v2);
      let dist = c.distance as number;
      if (!dist) {
        // first evaluation stores the current distance
        dist = d;
        c.distance = d;
      }
      const mode = c.limit_mode;
      let nd = d;
      if (mode === 'LIMITDIST_INSIDE') nd = Math.min(d, dist);
      else if (mode === 'LIMITDIST_OUTSIDE') nd = Math.max(d, dist);
      else nd = dist;
      if (d > 1e-9) o.p.sub(v2).multiplyScalar(nd / d).add(v2);
      owner.compose(o.p, o.q, o.s);
    },
  },
  TRACK_TO: {
    type: 'TRACK_TO',
    label: 'Track To',
    category: 'TRACKING',
    defaults: () => ({ track_axis: 'TRACK_NEGATIVE_Z', up_axis: 'UP_Y', use_target_z: false }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      if (!t) return;
      const o = decompose(owner);
      v2.setFromMatrixPosition(t).sub(o.p);
      if (v2.lengthSq() < 1e-12) return;
      const up = c.use_target_z ? new Vector3(0, 0, 1).applyQuaternion(decompose(t).q) : new Vector3(0, 0, 1);
      owner.compose(o.p, lookRotation(v2, (c.track_axis as string) ?? 'TRACK_NEGATIVE_Z', (c.up_axis as string) ?? 'UP_Y', up), o.s);
    },
  },
  DAMPED_TRACK: {
    type: 'DAMPED_TRACK',
    label: 'Damped Track',
    category: 'TRACKING',
    defaults: () => ({ track_axis: 'TRACK_Y' }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      if (!t) return;
      const o = decompose(owner);
      v2.setFromMatrixPosition(t).sub(o.p).normalize();
      const axis = (AXES[(c.track_axis as string) ?? 'TRACK_Y'] ?? AXES.TRACK_Y).clone().applyQuaternion(o.q);
      const rot = new Quaternion().setFromUnitVectors(axis, v2);
      owner.compose(o.p, rot.multiply(o.q), o.s);
    },
  },
  LOCKED_TRACK: {
    type: 'LOCKED_TRACK',
    label: 'Locked Track',
    category: 'TRACKING',
    defaults: () => ({ track_axis: 'TRACK_Y', lock_axis: 'LOCK_Z' }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      if (!t) return;
      const o = decompose(owner);
      const lockName = ((c.lock_axis as string) ?? 'LOCK_Z').replace('LOCK_', 'TRACK_');
      const lock = (AXES[lockName] ?? AXES.TRACK_Z).clone().applyQuaternion(o.q).normalize();
      const track = (AXES[(c.track_axis as string) ?? 'TRACK_Y'] ?? AXES.TRACK_Y).clone().applyQuaternion(o.q);
      v2.setFromMatrixPosition(t).sub(o.p);
      v2.sub(lock.clone().multiplyScalar(v2.dot(lock))).normalize();
      track.sub(lock.clone().multiplyScalar(track.dot(lock))).normalize();
      if (v2.lengthSq() < 1e-12 || track.lengthSq() < 1e-12) return;
      let ang = Math.acos(Math.max(-1, Math.min(1, track.dot(v2))));
      if (new Vector3().crossVectors(track, v2).dot(lock) < 0) ang = -ang;
      owner.compose(o.p, new Quaternion().setFromAxisAngle(lock, ang).multiply(o.q), o.s);
    },
  },
  STRETCH_TO: {
    type: 'STRETCH_TO',
    label: 'Stretch To',
    category: 'TRACKING',
    defaults: () => ({ rest_length: 0, bulge: 1, volume: 'VOLUME_XZX', keep_axis: 'PLANE_X' }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      if (!t) return;
      const o = decompose(owner);
      v2.setFromMatrixPosition(t).sub(o.p);
      const d = v2.length();
      if (!c.rest_length) c.rest_length = d;
      const stretch = d / ((c.rest_length as number) || 1);
      const axis = new Vector3(0, 1, 0).applyQuaternion(o.q);
      const rot = new Quaternion().setFromUnitVectors(axis, v2.clone().normalize());
      const vol = 1 / Math.sqrt(Math.max(1e-6, stretch));
      owner.compose(o.p, rot.multiply(o.q), new Vector3(o.s.x * vol, o.s.y * stretch, o.s.z * vol));
    },
  },
  CHILD_OF: {
    type: 'CHILD_OF',
    label: 'Child Of',
    category: 'RELATIONSHIP',
    defaults: () => ({ inverse_matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], use_location_x: true, use_location_y: true, use_location_z: true, use_rotation_x: true, use_rotation_y: true, use_rotation_z: true, use_scale_x: true, use_scale_y: true, use_scale_z: true, set_inverse_pending: false }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      if (!t) return;
      if (c.set_inverse_pending) {
        c.inverse_matrix = Array.from(t.clone().invert().elements);
        c.set_inverse_pending = false;
      }
      const inv = new Matrix4().fromArray(c.inverse_matrix as number[]);
      owner.premultiply(t.clone().multiply(inv));
    },
  },
  FLOOR: {
    type: 'FLOOR',
    label: 'Floor',
    category: 'RELATIONSHIP',
    defaults: () => ({ floor_location: 'FLOOR_Z', offset: 0, use_rotation: false }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      if (!t) return;
      const o = decompose(owner);
      v2.setFromMatrixPosition(t);
      const axis = ((c.floor_location as string) ?? 'FLOOR_Z').replace('FLOOR_', '');
      const neg = axis.startsWith('NEGATIVE_');
      const a = ({ X: 'x', Y: 'y', Z: 'z' } as const)[axis.replace('NEGATIVE_', '') as 'X' | 'Y' | 'Z'];
      const limit = v2[a] + ((c.offset as number) ?? 0);
      if (!neg && o.p[a] < limit) o.p[a] = limit;
      if (neg && o.p[a] > limit) o.p[a] = limit;
      owner.compose(o.p, o.q, o.s);
    },
  },
  FOLLOW_PATH: {
    type: 'FOLLOW_PATH',
    label: 'Follow Path',
    category: 'RELATIONSHIP',
    defaults: () => ({ offset: 0, offset_factor: 0, use_curve_follow: false, use_fixed_location: false, forward_axis: 'FORWARD_Y', up_axis: 'UP_Z', path_duration: 100 }),
    apply(owner, c, ctx) {
      const t = c.target ? ctx.graph.get(c.target as string) : undefined;
      const cu = t?.ob.data ? ctx.doc.curves[t.ob.data] : undefined;
      if (!t || !cu || !cu.splines.length) return;
      const s = sampleSpline(cu.splines[0], cu.resolution_u);
      if (s.points.length < 2) return;
      const lens = [0];
      for (let i = 1; i < s.points.length; i++) lens.push(lens[i - 1] + Math.hypot(...([0, 1, 2].map((k) => s.points[i][k] - s.points[i - 1][k]) as [number, number, number])));
      if (s.cyclic) lens.push(lens[lens.length - 1] + Math.hypot(...([0, 1, 2].map((k) => s.points[0][k] - s.points[s.points.length - 1][k]) as [number, number, number])));
      const total = lens[lens.length - 1] || 1;
      let f = c.use_fixed_location ? (c.offset_factor as number) : (ctx.frame - 1 + ((c.offset as number) ?? 0)) / ((c.path_duration as number) || 100);
      f = s.cyclic ? ((f % 1) + 1) % 1 : Math.max(0, Math.min(1, f));
      const target = f * total;
      let i = 1;
      while (i < lens.length - 1 && lens[i] < target) i++;
      const pts = s.cyclic ? [...s.points, s.points[0]] : s.points;
      const a = pts[i - 1],
        b = pts[i];
      const segT = (target - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
      const local = new Vector3(a[0] + (b[0] - a[0]) * segT, a[1] + (b[1] - a[1]) * segT, a[2] + (b[2] - a[2]) * segT);
      const world = local.clone().applyMatrix4(t.world);
      const o = decompose(owner);
      if (c.use_curve_follow) {
        const dir = new Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).transformDirection(t.world);
        const fwd = ((c.forward_axis as string) ?? 'FORWARD_Y').replace('FORWARD_', 'TRACK_');
        const q = lookRotation(dir, fwd, ((c.up_axis as string) ?? 'UP_Z'));
        owner.compose(o.p.add(world), q.multiply(o.q), o.s);
      } else owner.compose(o.p.add(world), o.q, o.s);
    },
  },
  TRANSFORM: {
    type: 'TRANSFORM',
    label: 'Transformation',
    category: 'TRANSFORM',
    defaults: () => ({ map_from: 'LOCATION', map_to: 'LOCATION', from_min_x: 0, from_max_x: 1, to_min_x: 0, to_max_x: 1, from_axis: 'X', to_axis: 'X' }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      if (!t) return;
      const tt = decompose(t);
      const axis = ((c.from_axis as string) ?? 'X').toLowerCase() as 'x' | 'y' | 'z';
      let src = 0;
      if (c.map_from === 'LOCATION') src = tt.p[axis];
      else if (c.map_from === 'ROTATION') src = new Euler().setFromQuaternion(tt.q, 'ZYX')[axis];
      else src = tt.s[axis];
      const fmin = c.from_min_x as number,
        fmax = c.from_max_x as number,
        tmin = c.to_min_x as number,
        tmax = c.to_max_x as number;
      const k = fmax !== fmin ? (src - fmin) / (fmax - fmin) : 0;
      const val = tmin + (tmax - tmin) * Math.max(0, Math.min(1, k));
      const o = decompose(owner);
      const to = ((c.to_axis as string) ?? 'X').toLowerCase() as 'x' | 'y' | 'z';
      if (c.map_to === 'LOCATION') o.p[to] += val;
      else if (c.map_to === 'ROTATION') {
        const e = new Euler().setFromQuaternion(o.q, 'ZYX');
        e[to] += val;
        o.q.setFromEuler(e);
      } else o.s[to] *= val || 1;
      owner.compose(o.p, o.q, o.s);
    },
  },
  SHRINKWRAP: {
    type: 'SHRINKWRAP',
    label: 'Shrinkwrap',
    category: 'RELATIONSHIP',
    defaults: () => ({ distance: 0, shrinkwrap_type: 'NEAREST_SURFACE' }),
    apply(owner, c, ctx) {
      const t = c.target ? ctx.graph.get(c.target as string) : undefined;
      if (!t?.mesh) return;
      const o = decompose(owner);
      const inv = t.world.clone().invert();
      const lp = o.p.clone().applyMatrix4(inv);
      // nearest vertex (approximation of nearest surface point)
      const P = t.mesh.positions;
      let best = Infinity,
        bi = -1;
      for (let i = 0; i < P.length; i += 3) {
        const d = (P[i] - lp.x) ** 2 + (P[i + 1] - lp.y) ** 2 + (P[i + 2] - lp.z) ** 2;
        if (d < best) {
          best = d;
          bi = i;
        }
      }
      if (bi < 0) return;
      const np = new Vector3(P[bi], P[bi + 1], P[bi + 2]).applyMatrix4(t.world);
      const dir = o.p.clone().sub(np);
      const dist = (c.distance as number) ?? 0;
      if (dir.lengthSq() > 0 && dist) np.add(dir.normalize().multiplyScalar(dist));
      owner.compose(np, o.q, o.s);
    },
  },
  PIVOT: {
    type: 'PIVOT',
    label: 'Pivot',
    category: 'RELATIONSHIP',
    defaults: () => ({ offset: [0, 0, 0] }),
    apply(owner, c, ctx) {
      const t = targetMatrix(c, ctx);
      const off = new Vector3(...((c.offset as number[]) ?? [0, 0, 0]));
      const pivot = t ? new Vector3().setFromMatrixPosition(t).add(off) : off.applyMatrix4(owner);
      const o = decompose(owner);
      const rel = o.p.clone().sub(pivot).applyQuaternion(o.q.clone().invert()).applyQuaternion(o.q);
      owner.compose(pivot.add(rel), o.q, o.s);
    },
  },
  MAINTAIN_VOLUME: {
    type: 'MAINTAIN_VOLUME',
    label: 'Maintain Volume',
    category: 'TRANSFORM',
    defaults: () => ({ free_axis: 'SAMEVOL_Y', volume: 1 }),
    apply(owner, c) {
      const o = decompose(owner);
      const vol = (c.volume as number) ?? 1;
      const ax = ((c.free_axis as string) ?? 'SAMEVOL_Y').slice(-1).toLowerCase() as 'x' | 'y' | 'z';
      const f = o.s[ax];
      const other = Math.sqrt(vol / Math.max(1e-6, Math.abs(f)));
      (['x', 'y', 'z'] as const).forEach((a) => a !== ax && (o.s[a] = other));
      owner.compose(o.p, o.q, o.s);
    },
  },
};

// Bone-level constraint labels also include IK (solved in armature evaluation).
export const boneOnlyConstraints: Record<string, string> = { IK: 'Inverse Kinematics', SPLINE_IK: 'Spline IK' };

export function newConstraint(type: string, id: string): Constraint {
  const t = constraintTypes[type];
  const label = t?.label ?? boneOnlyConstraints[type] ?? type;
  const extra = type === 'IK' ? { chain_count: 0, iterations: 500, pole_target: null, pole_angle: 0, use_tail: true, use_stretch: true } : {};
  return { id, name: label, type, mute: false, influence: 1, show_expanded: true, target: null, subtarget: '', owner_space: 'WORLD', target_space: 'WORLD', ...(t?.defaults() ?? {}), ...extra };
}
