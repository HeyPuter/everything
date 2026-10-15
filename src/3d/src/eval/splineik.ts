// Spline IK: lays a chain of bones along a curve object.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Constraint, DocumentData } from '../data/types';
import type { BoneEval } from './armature';
import type { Depsgraph } from './depsgraph';
import { curvePath, pathPoint, type CurvePath } from './curvepath';
import { applyBonePose } from './ik';
import { limitBulge } from './constraints';

/** Chain from the root (first) to the owner bone (last). */
export function splineChain(bones: Map<string, BoneEval>, owner: string, count: number): string[] {
  const out: string[] = [];
  let cur: string | null = owner;
  while (cur && out.length < Math.max(1, count)) {
    out.unshift(cur);
    cur = bones.get(cur)?.parent ?? null;
  }
  return out;
}

/** Point at arc length `d` along a path transformed into armature space (clamped to the ends). */
function pointAt(path: CurvePath, toArm: Matrix4, d: number) {
  const s = pathPoint(path, path.total > 0 ? d / path.total : 0);
  return { point: s.point.applyMatrix4(toArm), radius: s.radius, tilt: s.tilt };
}

export function solveSplineIK(doc: DocumentData, graph: Depsgraph, bones: Map<string, BoneEval>, owner: string, armWorld: Matrix4, c: Constraint) {
  const tob = c.target ? graph.get(c.target as string) : undefined;
  const cu = tob?.ob.type === 'CURVE' && tob.ob.data ? doc.curves[tob.ob.data] : undefined;
  const path = cu ? curvePath(cu) : null;
  if (!tob || !path || path.total <= 0) return;
  const chain = splineChain(bones, owner, (c.chain_count as number) || 1);
  if (!chain.length) return;
  const toArm = armWorld.clone().invert().multiply(tob.world);
  // curve length measured in armature space
  let curveLen = 0;
  {
    let prev: Vector3 | null = null;
    for (const p of [...path.points, ...(path.cyclic ? [path.points[0]] : [])]) {
      const q = p.clone().applyMatrix4(toArm);
      if (prev) curveLen += q.distanceTo(prev);
      prev = q;
    }
  }
  if (curveLen <= 1e-9) return;
  const yMode = (c.y_scale_mode as string) ?? 'FIT_CURVE';
  const xzMode = (c.xz_scale_mode as string) ?? 'NONE';
  const before = chain.map((n) => {
    const p = new Vector3(),
      q = new Quaternion(),
      s = new Vector3();
    bones.get(n)!.pose.decompose(p, q, s);
    return { p, q, s };
  });
  const lengths = chain.map((n, i) => bones.get(n)!.length * (yMode === 'BONE_ORIGINAL' ? before[i].s.y : 1));
  const chainLen = lengths.reduce((a, b) => a + b, 0) || 1;
  // joint positions as arc lengths along the curve (in path units)
  const scaleToPath = path.total / curveLen;
  const joints: number[] = [0];
  for (let i = 0; i < chain.length; i++) {
    let d: number;
    if (yMode === 'FIT_CURVE') d = c.use_even_divisions ? ((i + 1) / chain.length) * curveLen : (joints.length ? lengthsUpTo(lengths, i + 1) / chainLen : 0) * curveLen;
    else d = lengthsUpTo(lengths, i + 1);
    joints.push(d * scaleToPath);
  }
  const offset = c.use_chain_offset ? before[0].p.clone().sub(pointAt(path, toArm, 0).point) : new Vector3();
  for (let i = 0; i < chain.length; i++) {
    const name = chain[i];
    const b = bones.get(name)!;
    const a = pointAt(path, toArm, joints[i]),
      e = pointAt(path, toArm, joints[i + 1]);
    const h = a.point.add(offset),
      t = e.point.add(offset);
    const dir = t.clone().sub(h);
    const len = dir.length();
    const cur = before[i];
    // swing the bone's current orientation so its Y axis follows the curve (keeps its roll)
    const yAxis = new Vector3(0, 1, 0).applyQuaternion(cur.q);
    let q = cur.q.clone();
    if (len > 1e-9) q = new Quaternion().setFromUnitVectors(yAxis.normalize(), dir.clone().normalize()).multiply(cur.q);
    const tilt = (a.tilt + e.tilt) / 2;
    if (tilt && len > 1e-9) q.premultiply(new Quaternion().setFromAxisAngle(dir.clone().normalize(), tilt));
    let sy = b.length > 1e-9 && len > 1e-9 ? len / b.length : 1;
    if (yMode === 'NONE') sy = 1;
    else if (yMode === 'BONE_ORIGINAL') sy = cur.s.y;
    let sx = 1,
      sz = 1;
    if (xzMode === 'BONE_ORIGINAL') {
      sx = cur.s.x;
      sz = cur.s.z;
    } else if (xzMode === 'INVERSE_PRESERVE') {
      sx = sz = sy > 1e-9 ? 1 / sy : 1;
    } else if (xzMode === 'VOLUME_PRESERVE') {
      const base = c.use_original_scale ? sy / (cur.s.y || 1) : sy;
      const bulge = limitBulge((1 / Math.max(1e-9, base)) ** ((c.bulge as number) ?? 1), c);
      sx = sz = Math.sqrt(bulge);
      if (c.use_original_scale) {
        sx *= cur.s.x;
        sz *= cur.s.z;
      }
    }
    if (c.use_curve_radius !== false) {
      const r = (a.radius + e.radius) / 2;
      sx *= r;
      sz *= r;
    }
    const m = new Matrix4().compose(h, q, new Vector3(sx, sy, sz));
    if (c.influence < 1) {
      const p0 = cur.p.clone(),
        q0 = cur.q.clone(),
        s0 = cur.s.clone();
      m.compose(p0.lerp(h, c.influence), q0.slerp(q, c.influence), s0.lerp(new Vector3(sx, sy, sz), c.influence));
    }
    applyBonePose(bones, name, m);
  }
}

function lengthsUpTo(lengths: number[], n: number) {
  let s = 0;
  for (let i = 0; i < n; i++) s += lengths[i];
  return s;
}
