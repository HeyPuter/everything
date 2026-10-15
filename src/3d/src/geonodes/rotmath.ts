// Rotation math for rotation fields. Rotation values are stored as XYZ Euler triples; the
// functions here convert to and from unit quaternions [w, x, y, z] so rotations can be combined
// without gimbal problems. Euler → quaternion uses single-precision steps so hashing a rotation
// gives the same bits as a float32 pipeline would.
import { matrixToEuler } from './field';

export type Quat = [number, number, number, number];
export type Vec3 = [number, number, number];

const fr = Math.fround;

export function eulerToQuat(x: number, y: number, z: number): Quat {
  const ti = fr(fr(x) * 0.5),
    tj = fr(fr(y) * 0.5),
    th = fr(fr(z) * 0.5);
  const ci = fr(Math.cos(ti)),
    cj = fr(Math.cos(tj)),
    ch = fr(Math.cos(th));
  const si = fr(Math.sin(ti)),
    sj = fr(Math.sin(tj)),
    sh = fr(Math.sin(th));
  const cc = fr(ci * ch),
    cs = fr(ci * sh),
    sc = fr(si * ch),
    ss = fr(si * sh);
  return [fr(fr(cj * cc) + fr(sj * ss)), fr(fr(cj * sc) - fr(sj * cs)), fr(fr(cj * ss) + fr(sj * cc)), fr(fr(cj * cs) - fr(sj * sc))];
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > 0 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [1, 0, 0, 0];
}

/** Column-major 3×3 rotation matrix (9 values) of a quaternion (normalized first). */
export function quatToMat3(qq: Quat): number[] {
  const [w, x, y, z] = quatNormalize(qq);
  const xx = x * x,
    yy = y * y,
    zz = z * z,
    xy = x * y,
    xz = x * z,
    yz = y * z,
    wx = w * x,
    wy = w * y,
    wz = w * z;
  return [1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy)];
}

export function quatToEuler(q: Quat, out: { [i: number]: number } = [0, 0, 0], o = 0) {
  matrixToEuler(quatToMat3(q), 0, out, o, 3);
  return out;
}

/**
 * Unit quaternion of the rotation part of a column-major matrix (stride 3 or 4). Columns are
 * normalized first; the largest of w, x, y, z picks the numerically stable branch, and w ends
 * up non-negative.
 */
export function matToQuat(m: ArrayLike<number>, o = 0, stride = 4): Quat {
  const col = (c: number) => {
    const x = m[o + c * stride],
      y = m[o + c * stride + 1],
      z = m[o + c * stride + 2];
    const l = Math.hypot(x, y, z);
    return l ? [x / l, y / l, z / l] : [x, y, z];
  };
  const a = col(0),
    b = col(1),
    c = col(2);
  // r<row><col>
  const r00 = a[0],
    r10 = a[1],
    r20 = a[2],
    r01 = b[0],
    r11 = b[1],
    r21 = b[2],
    r02 = c[0],
    r12 = c[1],
    r22 = c[2];
  let q: Quat;
  if (r22 < 0) {
    if (r00 > r11) {
      let s = 2 * Math.sqrt(1 + r00 - r11 - r22);
      if (r21 < r12) s = -s;
      q = [(r21 - r12) / s, 0.25 * s, (r10 + r01) / s, (r02 + r20) / s];
    } else {
      let s = 2 * Math.sqrt(1 - r00 + r11 - r22);
      if (r02 < r20) s = -s;
      q = [(r02 - r20) / s, (r10 + r01) / s, 0.25 * s, (r21 + r12) / s];
    }
  } else if (r00 < -r11) {
    let s = 2 * Math.sqrt(1 - r00 - r11 + r22);
    if (r10 < r01) s = -s;
    q = [(r10 - r01) / s, (r02 + r20) / s, (r21 + r12) / s, 0.25 * s];
  } else {
    const s = 2 * Math.sqrt(1 + r00 + r11 + r22);
    q = [0.25 * s, (r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s];
  }
  return quatNormalize(q);
}

export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export const quatConj = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];

export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const m = quatToMat3(q);
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
}

/** Rotation by `angle` around `axis` (normalized; a zero axis gives no rotation). */
export function axisAngleToQuat(axis: Vec3, angle: number): Quat {
  const l = Math.hypot(axis[0], axis[1], axis[2]);
  if (!l) return [1, 0, 0, 0];
  const s = Math.sin(angle / 2) / l;
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}

/** Axis and angle (0…2π) of a quaternion; the identity gives the Z axis. */
export function quatToAxisAngle(qq: Quat): { axis: Vec3; angle: number } {
  const q = quatNormalize(qq);
  const s = Math.hypot(q[1], q[2], q[3]);
  if (s < 1e-7) return { axis: [0, 0, 1], angle: 0 };
  const angle = 2 * Math.atan2(s, q[0]);
  return { axis: [q[1] / s, q[2] / s, q[3] / s], angle };
}

/** Rotation turning direction `a` onto direction `b` (both normalized), shortest arc. */
export function quatBetween(a: Vec3, b: Vec3): Quat {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const c: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const cl = Math.hypot(c[0], c[1], c[2]);
  if (cl < 1e-7) {
    if (d > 0) return [1, 0, 0, 0];
    // opposite: rotate half a turn around any perpendicular axis
    const p: Vec3 = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[2], 0, a[0]];
    return axisAngleToQuat(p, Math.PI);
  }
  return axisAngleToQuat(c, Math.atan2(cl, d));
}

/** Read rotation i of an evaluated Euler field (stride 0 for single values) as a quaternion. */
export function quatAt(d: ArrayLike<number>, i: number, single: boolean): Quat {
  const j = single ? 0 : i * 3;
  return eulerToQuat(d[j], d[j + 1], d[j + 2]);
}
