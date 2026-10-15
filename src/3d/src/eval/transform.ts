import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { ObjectData, PoseBone, RotationMode, Vec3, Vec4 } from '../data/types';

/** Document Euler order 'XYZ' (X applied first) equals three.js order 'ZYX'. */
export function threeOrder(mode: RotationMode): Euler['order'] {
  if (mode === 'QUATERNION' || mode === 'AXIS_ANGLE') return 'ZYX';
  return mode.split('').reverse().join('') as Euler['order'];
}

const _e = new Euler(),
  _q = new Quaternion(),
  _v = new Vector3(),
  _s = new Vector3(),
  _ax = new Vector3();

export function rotationQuaternion(
  mode: RotationMode,
  euler: Vec3,
  quat: Vec4,
  axisAngle: Vec4,
  out = new Quaternion(),
): Quaternion {
  if (mode === 'QUATERNION') {
    out.set(quat[1], quat[2], quat[3], quat[0]);
    const l = out.length();
    if (l > 0) out.normalize();
    else out.identity();
    return out;
  }
  if (mode === 'AXIS_ANGLE') {
    _ax.set(axisAngle[1], axisAngle[2], axisAngle[3]);
    if (_ax.lengthSq() === 0) return out.identity();
    return out.setFromAxisAngle(_ax.normalize(), axisAngle[0]);
  }
  _e.set(euler[0], euler[1], euler[2], threeOrder(mode));
  return out.setFromEuler(_e);
}

export function localMatrix(ob: ObjectData, out = new Matrix4()): Matrix4 {
  rotationQuaternion(ob.rotation_mode, ob.rotation_euler, ob.rotation_quaternion, ob.rotation_axis_angle, _q);
  const dr = ob.delta_rotation_euler;
  if (dr[0] || dr[1] || dr[2]) {
    _e.set(dr[0], dr[1], dr[2], threeOrder(ob.rotation_mode === 'QUATERNION' || ob.rotation_mode === 'AXIS_ANGLE' ? 'XYZ' : ob.rotation_mode));
    _q.premultiply(new Quaternion().setFromEuler(_e));
  }
  _v.set(ob.location[0] + ob.delta_location[0], ob.location[1] + ob.delta_location[1], ob.location[2] + ob.delta_location[2]);
  _s.set(ob.scale[0] * ob.delta_scale[0], ob.scale[1] * ob.delta_scale[1], ob.scale[2] * ob.delta_scale[2]);
  return out.compose(_v, _q, _s);
}

export function poseBoneMatrix(pb: PoseBone, out = new Matrix4()): Matrix4 {
  rotationQuaternion(pb.rotation_mode, pb.rotation_euler, pb.rotation_quaternion, pb.rotation_axis_angle, _q);
  _v.set(pb.location[0], pb.location[1], pb.location[2]);
  _s.set(pb.scale[0], pb.scale[1], pb.scale[2]);
  return out.compose(_v, _q, _s);
}

/** Write a matrix back into the object's loc/rot/scale using its rotation mode. */
export function applyMatrixToObject(ob: ObjectData, m: Matrix4) {
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  m.decompose(p, q, s);
  ob.location = [p.x - ob.delta_location[0], p.y - ob.delta_location[1], p.z - ob.delta_location[2]];
  ob.scale = [s.x / (ob.delta_scale[0] || 1), s.y / (ob.delta_scale[1] || 1), s.z / (ob.delta_scale[2] || 1)];
  setRotationFromQuaternion(ob, q);
}

export function setRotationFromQuaternion(
  target: Pick<ObjectData, 'rotation_mode' | 'rotation_euler' | 'rotation_quaternion' | 'rotation_axis_angle'>,
  q: Quaternion,
) {
  if (target.rotation_mode === 'QUATERNION') {
    target.rotation_quaternion = [q.w, q.x, q.y, q.z];
  } else if (target.rotation_mode === 'AXIS_ANGLE') {
    const angle = 2 * Math.acos(Math.max(-1, Math.min(1, q.w))),
      s = Math.sqrt(1 - q.w * q.w);
    target.rotation_axis_angle = s < 1e-6 ? [0, 0, 1, 0] : [angle, q.x / s, q.y / s, q.z / s];
  } else {
    // pick euler compatible with the previous value to avoid flips
    const e = new Euler().setFromQuaternion(q, threeOrder(target.rotation_mode));
    target.rotation_euler = compatibleEuler([e.x, e.y, e.z], target.rotation_euler);
  }
}

/** Adjust euler angles by multiples of 2π to stay close to a reference. */
export function compatibleEuler(e: Vec3, ref: Vec3): Vec3 {
  return e.map((v, i) => {
    const d = ref[i] - v;
    return v + Math.round(d / (Math.PI * 2)) * Math.PI * 2;
  }) as Vec3;
}

export const toMatrix4 = (a: number[]) => new Matrix4().fromArray(a);
export const fromMatrix4 = (m: Matrix4) => Array.from(m.elements);
