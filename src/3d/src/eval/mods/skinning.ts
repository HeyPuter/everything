// Armature deformation for the Armature modifier: bone weights from vertex groups and/or bone
// envelopes, blended linearly or with dual quaternions (volume preserving).
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Bone } from '../../data/types';
import type { PoseResult } from '../armature';
import { bboneDeformAt } from '../bbone';

export interface SkinOptions {
  useGroups: boolean;
  useEnvelopes: boolean;
  preserveVolume: boolean;
}

/** Envelope weight of a point (armature space) for a bone. */
export function envelopeWeight(b: Bone, p: Vector3): number {
  const h = new Vector3(...b.head),
    t = new Vector3(...b.tail);
  const ax = t.clone().sub(h);
  const len2 = ax.lengthSq();
  const s = len2 > 0 ? Math.max(0, Math.min(1, p.clone().sub(h).dot(ax) / len2)) : 0;
  const d = p.distanceTo(h.clone().addScaledVector(ax, s));
  const r = b.head_radius + (b.tail_radius - b.head_radius) * s;
  if (d <= r) return 1;
  const e = b.envelope_distance;
  if (e <= 0 || d >= r + e) return 0;
  const f = 1 - (d - r) / e;
  return f * f;
}

/** Unit dual quaternion (real, dual) of a rigid transform. */
function toDual(rot: Quaternion, tr: Vector3): [Quaternion, Quaternion] {
  const real = rot.clone();
  const t = new Quaternion(tr.x, tr.y, tr.z, 0);
  const dual = t.multiply(real);
  dual.x *= 0.5;
  dual.y *= 0.5;
  dual.z *= 0.5;
  dual.w *= 0.5;
  return [real, dual];
}

/** Rigid dual quaternion and leftover scale of a matrix (for volume preserving blending). */
function dualOf(m: Matrix4): { real: Quaternion; dual: Quaternion; scale: Matrix4 } {
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  m.decompose(p, q, s);
  const scale = new Matrix4().compose(p, q, new Vector3(1, 1, 1)).invert().multiply(m);
  const [real, dual] = toDual(q, p);
  return { real, dual, scale };
}

/** Deform object-space positions by the posed armature. */
export function armatureDeform(positions: Float32Array, groups: { name: string }[] | undefined, weights: Float32Array[] | undefined, bones: Bone[], pose: PoseResult, meshToArm: Matrix4, armToMesh: Matrix4, o: SkinOptions): Float32Array {
  const n = positions.length / 3;
  const out = new Float32Array(positions.length);
  const deformBones = bones.filter((b) => b.use_deform !== false && pose.bones.has(b.name));
  // per deform bone: its mesh-space matrix (and rigid parts for dual quaternions)
  const mats = new Map<string, Matrix4>();
  const duals = new Map<string, { real: Quaternion; dual: Quaternion; scale: Matrix4 }>();
  for (const b of deformBones) {
    const m = armToMesh.clone().multiply(pose.bones.get(b.name)!.deform).multiply(meshToArm);
    mats.set(b.name, m);
    if (o.preserveVolume) {
      const p = new Vector3(),
        q = new Quaternion(),
        s = new Vector3();
      m.decompose(p, q, s);
      // scale is applied (linearly blended) before the rigid part
      const rigidInv = new Matrix4().compose(p, q, new Vector3(1, 1, 1)).invert();
      const scale = rigidInv.multiply(m);
      const [real, dual] = toDual(q, p);
      duals.set(b.name, { real, dual, scale });
    }
  }
  const groupBone: (string | null)[] = (groups ?? []).map((g) => (mats.has(g.name) ? g.name : null));
  const boneByName = new Map(deformBones.map((b) => [b.name, b]));
  // bending B-Bones deform each point by the segment it lies along
  const bbones = new Map<string, { deform: Matrix4[]; restInv: Matrix4; length: number }>();
  for (const b of deformBones) {
    const ev = pose.bones.get(b.name)!;
    if (ev.bbone) bbones.set(b.name, { deform: ev.bbone.deform, restInv: ev.restInv, length: ev.length });
  }
  const segMat = new Matrix4();
  const armPt = new Vector3();
  /** mesh-space matrix of a bone for the current point */
  const matFor = (name: string): Matrix4 => {
    const bb = bbones.get(name);
    if (!bb) return mats.get(name)!;
    bboneDeformAt(bb.deform, bb.restInv, bb.length, armPt, segMat);
    return armToMesh.clone().multiply(segMat).multiply(meshToArm);
  };
  const v = new Vector3(),
    a = new Vector3(),
    acc = new Vector3(),
    tmp = new Vector3();
  const infl: [string, number][] = [];
  for (let i = 0; i < n; i++) {
    v.fromArray(positions, i * 3);
    infl.length = 0;
    let total = 0;
    armPt.copy(v).applyMatrix4(meshToArm);
    if (o.useGroups && weights)
      for (let g = 0; g < groupBone.length; g++) {
        const name = groupBone[g];
        let w = name ? weights[g]?.[i] ?? 0 : 0;
        // Envelope Multiply: the group weight is scaled by the bone's envelope
        const bone = name ? boneByName.get(name) : undefined;
        if (w > 0 && o.useEnvelopes && bone?.use_envelope_multiply) w *= envelopeWeight(bone, armPt) * (bone.envelope_weight ?? 1);
        if (w > 0) {
          infl.push([name!, w]);
          total += w;
        }
      }
    // envelopes reach the vertices no vertex group binds
    if (o.useEnvelopes && total === 0) {
      a.copy(v).applyMatrix4(meshToArm);
      for (const b of deformBones) {
        const w = envelopeWeight(b, a) * (b.envelope_weight ?? 1);
        if (w > 0) {
          infl.push([b.name, w]);
          total += w;
        }
      }
    }
    if (total <= 0) {
      out.set([v.x, v.y, v.z], i * 3);
      continue;
    }
    if (!o.preserveVolume) {
      acc.set(0, 0, 0);
      for (const [name, w] of infl) acc.add(tmp.copy(v).applyMatrix4(matFor(name)).multiplyScalar(w / total));
      out.set([acc.x, acc.y, acc.z], i * 3);
      continue;
    }
    // dual quaternion blend (keeping the shortest-arc sign consistent)
    const r = new Quaternion(0, 0, 0, 0),
      d = new Quaternion(0, 0, 0, 0);
    const sm = new Matrix4();
    sm.elements.fill(0);
    const first = duals.get(infl[0][0])!.real;
    for (const [name, w0] of infl) {
      const dq = bbones.has(name) ? dualOf(matFor(name)) : duals.get(name)!;
      const w = (w0 / total) * (dq.real.dot(first) < 0 ? -1 : 1);
      r.set(r.x + dq.real.x * w, r.y + dq.real.y * w, r.z + dq.real.z * w, r.w + dq.real.w * w);
      d.set(d.x + dq.dual.x * w, d.y + dq.dual.y * w, d.z + dq.dual.z * w, d.w + dq.dual.w * w);
      const e = dq.scale.elements;
      for (let k = 0; k < 16; k++) sm.elements[k] += e[k] * Math.abs(w);
    }
    const len = Math.hypot(r.x, r.y, r.z, r.w) || 1;
    r.set(r.x / len, r.y / len, r.z / len, r.w / len);
    d.set(d.x / len, d.y / len, d.z / len, d.w / len);
    // translation = 2 · dual · conj(real)
    const tq = new Quaternion(d.x, d.y, d.z, d.w).multiply(new Quaternion(-r.x, -r.y, -r.z, r.w));
    tmp.copy(v).applyMatrix4(sm).applyQuaternion(r).add(new Vector3(tq.x * 2, tq.y * 2, tq.z * 2));
    out.set([tmp.x, tmp.y, tmp.z], i * 3);
  }
  return out;
}
