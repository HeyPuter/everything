// B-Bones: a bone with several segments bends along a cubic Bézier from its head to its tail.
// The handles leave the head / arrive at the tail along the directions of the connected parent
// and child (or custom handle bones), pushed sideways by the Curve In / Out offsets; roll, scale
// and ease are interpolated along the segments. Frames are in the bone's own space (Y along the
// bone, length L); deformation interpolates between the frames of neighbouring segment joints.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Bone, PoseBone, Vec3 } from '../data/types';

export interface BBoneShape {
  segments: number;
  length: number;
  curveInX: number;
  curveInZ: number;
  curveOutX: number;
  curveOutZ: number;
  rollIn: number;
  rollOut: number;
  scaleIn: Vec3;
  scaleOut: Vec3;
  easeIn: number;
  easeOut: number;
  /** cross-section scale follows the ease too */
  scaleEasing: boolean;
  /** handle directions in the bone's space (unit; default along +Y) */
  startDir?: Vector3;
  endDir?: Vector3;
}

const add3 = (a: Vec3 | undefined, b: Vec3 | undefined, d: number): Vec3 => [(a?.[0] ?? d) * (b?.[0] ?? 1), (a?.[1] ?? d) * (b?.[1] ?? 1), (a?.[2] ?? d) * (b?.[2] ?? 1)];

/** The shape of a bone at rest (bone values) or posed (bone values plus the pose bone's). */
export function bboneShape(b: Bone, pb: PoseBone | null, length: number): BBoneShape {
  const v = (k: 'bbone_curveinx' | 'bbone_curveinz' | 'bbone_curveoutx' | 'bbone_curveoutz' | 'bbone_rollin' | 'bbone_rollout') => (b[k] ?? 0) + (pb?.[k] ?? 0);
  return {
    segments: Math.max(1, Math.min(32, Math.round(b.bbone_segments || 1))),
    length,
    curveInX: v('bbone_curveinx'),
    curveInZ: v('bbone_curveinz'),
    curveOutX: v('bbone_curveoutx'),
    curveOutZ: v('bbone_curveoutz'),
    rollIn: v('bbone_rollin'),
    rollOut: v('bbone_rollout'),
    scaleIn: add3(b.bbone_scalein, pb?.bbone_scalein, 1),
    scaleOut: add3(b.bbone_scaleout, pb?.bbone_scaleout, 1),
    easeIn: (b.bbone_easein ?? 1) + (pb?.bbone_easein ?? 0),
    easeOut: (b.bbone_easeout ?? 1) + (pb?.bbone_easeout ?? 0),
    scaleEasing: !!b.use_scale_easing,
  };
}

/** Whether the shape bends or scales at all (a straight, unscaled B-Bone deforms like a plain bone). */
export function bboneIsStraight(s: BBoneShape): boolean {
  const eps = 1e-6;
  const dirStraight = (d?: Vector3) => !d || (Math.abs(d.x) < eps && Math.abs(d.z) < eps);
  return (
    s.segments <= 1 ||
    (Math.abs(s.curveInX) < eps &&
      Math.abs(s.curveInZ) < eps &&
      Math.abs(s.curveOutX) < eps &&
      Math.abs(s.curveOutZ) < eps &&
      Math.abs(s.rollIn) < eps &&
      Math.abs(s.rollOut) < eps &&
      s.scaleIn.every((x) => Math.abs(x - 1) < eps) &&
      s.scaleOut.every((x) => Math.abs(x - 1) < eps) &&
      dirStraight(s.startDir) &&
      dirStraight(s.endDir))
  );
}

/** Frames (bone space) at the n + 1 joints of the segments, head to tail. */
export function bboneFrames(s: BBoneShape): Matrix4[] {
  const n = s.segments,
    L = s.length;
  const d0 = (s.startDir ?? new Vector3(0, 1, 0)).clone().normalize();
  const d1 = (s.endDir ?? new Vector3(0, 1, 0)).clone().normalize();
  // handle lengths: a third of the bone at ease 1 (straight bones keep evenly spaced joints)
  const h0 = (Math.max(0, s.easeIn) * L) / 3,
    h1 = (Math.max(0, s.easeOut) * L) / 3;
  const P0 = new Vector3(0, 0, 0),
    P3 = new Vector3(0, L, 0);
  const P1 = P0.clone().addScaledVector(d0, h0).add(new Vector3(s.curveInX, 0, s.curveInZ));
  const P2 = P3.clone().addScaledVector(d1, -h1).add(new Vector3(s.curveOutX, 0, s.curveOutZ));
  const point = (t: number) => {
    const u = 1 - t;
    return P0.clone()
      .multiplyScalar(u * u * u)
      .addScaledVector(P1, 3 * u * u * t)
      .addScaledVector(P2, 3 * u * t * t)
      .addScaledVector(P3, t * t * t);
  };
  const tangent = (t: number) => {
    const u = 1 - t;
    const v = P1.clone()
      .sub(P0)
      .multiplyScalar(3 * u * u)
      .addScaledVector(P2.clone().sub(P1), 6 * u * t)
      .addScaledVector(P3.clone().sub(P2), 3 * t * t);
    // degenerate handles (zero ease): fall back to the chord
    return v.lengthSq() > 1e-16 ? v.normalize() : P3.clone().sub(P0).normalize();
  };
  // joints are spaced evenly along the curve (arc length), not evenly in the curve parameter
  const SAMPLES = 32 * n;
  const lens = [0];
  let prev = point(0);
  for (let i = 1; i <= SAMPLES; i++) {
    const p = point(i / SAMPLES);
    lens.push(lens[i - 1] + p.distanceTo(prev));
    prev = p;
  }
  const total = lens[SAMPLES];
  const paramAt = (k: number) => {
    if (k <= 0 || total <= 0) return (k / n) * (total > 0 ? 1 : 1);
    if (k >= n) return 1;
    const want = (k / n) * total;
    let i = 1;
    while (i < SAMPLES && lens[i] < want) i++;
    const a = lens[i - 1],
      b = lens[i];
    return (i - 1 + (b > a ? (want - a) / (b - a) : 0)) / SAMPLES;
  };
  const out: Matrix4[] = [];
  // the cross-section axes are carried along the curve without twisting (parallel transport)
  const q = new Quaternion();
  let prevY = new Vector3(0, 1, 0);
  for (let k = 0; k <= n; k++) {
    const t = paramAt(k);
    const y = tangent(t);
    q.premultiply(new Quaternion().setFromUnitVectors(prevY, y));
    prevY = y;
    const along = k / n;
    const roll = s.rollIn + (s.rollOut - s.rollIn) * along;
    const rot = new Quaternion().setFromAxisAngle(y, roll).multiply(q);
    const f = s.scaleEasing ? along * along * (3 - 2 * along) : along;
    const sx = s.scaleIn[0] + (s.scaleOut[0] - s.scaleIn[0]) * f,
      sz = s.scaleIn[2] + (s.scaleOut[2] - s.scaleIn[2]) * f;
    out.push(new Matrix4().compose(point(t), rot, new Vector3(sx, 1, sz)));
  }
  return out;
}

/**
 * Deformation of a point (armature rest space) by a B-Bone: the joint deform matrices
 * (pose joint · rest joint⁻¹) are interpolated by the point's position along the rest bone.
 */
export function bboneDeformAt(deforms: Matrix4[], restInv: Matrix4, length: number, p: Vector3, out = new Matrix4(), curved?: Vector3[]): Matrix4 {
  const n = deforms.length - 1;
  let f: number;
  if (curved && curved.length === n + 1) {
    // Curved mapping: the nearest point on the rest curve (through the joints)
    let best = Infinity;
    f = 0;
    for (let k = 0; k < n; k++) {
      const a = curved[k],
        ab = curved[k + 1].clone().sub(a);
      const l2 = ab.lengthSq();
      const t = l2 > 0 ? Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / l2)) : 0;
      const d = a.clone().addScaledVector(ab, t).distanceToSquared(p);
      if (d < best) {
        best = d;
        f = k + t;
      }
    }
  } else {
    const y = p.clone().applyMatrix4(restInv).y;
    f = Math.max(0, Math.min(1, length > 0 ? y / length : 0)) * n;
  }
  const k = Math.min(n - 1, Math.floor(f)),
    w = f - k;
  const a = deforms[k].elements,
    b = deforms[k + 1].elements,
    o = out.elements;
  for (let i = 0; i < 16; i++) o[i] = a[i] + (b[i] - a[i]) * w;
  return out;
}
