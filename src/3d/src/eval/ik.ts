// Inverse kinematics for pose bones: cyclic coordinate descent over all IK chains of an armature
// at once (chains sharing bones compromise by their weights), with pole targets, rotation targets,
// stretching and per-bone IK locks.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { ArmatureData, Constraint, ObjectData } from '../data/types';
import type { BoneEval } from './armature';

/** Replace a bone's pose matrix and carry its descendants along. */
export function applyBonePose(bones: Map<string, BoneEval>, name: string, m: Matrix4) {
  const b = bones.get(name);
  if (!b) return;
  const delta = m.clone().multiply(b.pose.clone().invert());
  b.pose.copy(m);
  const visit = (parent: string) => {
    for (const c of bones.values())
      if (c.parent === parent) {
        c.pose.premultiply(delta);
        visit(c.name);
      }
  };
  visit(name);
}

export interface IKChain {
  /** bone owning the constraint */
  owner: string;
  /** bones moved by the solver, from the owner (or its parent without "use tail") to the root */
  bones: string[];
  useTail: boolean;
  target: Vector3 | null;
  targetRot: Quaternion | null;
  pole: Vector3 | null;
  poleAngle: number;
  weight: number;
  orientWeight: number;
  influence: number;
  iterations: number;
  stretch: boolean;
}

const head = (b: BoneEval) => new Vector3().setFromMatrixPosition(b.pose);
const tail = (b: BoneEval) => new Vector3(0, b.length, 0).applyMatrix4(b.pose);

/** End effector of a chain (owner tail, or its head without "use tail"). */
function effector(bones: Map<string, BoneEval>, ch: IKChain): Vector3 {
  const b = bones.get(ch.owner)!;
  return ch.useTail ? tail(b) : head(b);
}

/** Bones of an IK chain for a constraint on `owner`. */
export function ikChainBones(bones: Map<string, BoneEval>, owner: string, chainCount: number, useTail: boolean): string[] {
  const out: string[] = [];
  let cur: string | null = useTail ? owner : (bones.get(owner)?.parent ?? null);
  // the chain length counts the owner bone even when its tail is not used
  const limit = chainCount > 0 ? (useTail ? chainCount : chainCount - 1) : Infinity;
  while (cur && out.length < limit) {
    out.push(cur);
    cur = bones.get(cur)?.parent ?? null;
  }
  return out;
}

/** Rotate a bone around its head (rotation `q` in armature space), honouring the bone's IK locks,
 *  stiffness and rotation limits. */
function rotateBone(bones: Map<string, BoneEval>, ob: ObjectData, name: string, q: Quaternion) {
  const b = bones.get(name)!;
  const pb = ob.pose?.[name];
  const stiff = pb ? [pb.lock_ik_x ? 1 : (pb.ik_stiffness_x ?? 0), pb.lock_ik_y ? 1 : (pb.ik_stiffness_y ?? 0), pb.lock_ik_z ? 1 : (pb.ik_stiffness_z ?? 0)] : [0, 0, 0];
  if (stiff.some((x) => x > 0)) {
    // express the rotation in the bone's own axes and damp (or drop) the stiff components
    const bq = new Quaternion();
    b.pose.decompose(new Vector3(), bq, new Vector3());
    const local = bq.clone().invert().multiply(q).multiply(bq);
    if (local.w < 0) local.set(-local.x, -local.y, -local.z, -local.w);
    const ang = 2 * Math.acos(Math.min(1, local.w));
    const s = Math.sqrt(Math.max(0, 1 - local.w * local.w));
    if (s < 1e-9) return;
    const v = new Vector3(local.x / s, local.y / s, local.z / s).multiplyScalar(ang);
    v.set(v.x * (1 - Math.min(1, stiff[0])), v.y * (1 - Math.min(1, stiff[1])), v.z * (1 - Math.min(1, stiff[2])));
    const len = v.length();
    if (len < 1e-9) return;
    const damped = new Quaternion().setFromAxisAngle(v.divideScalar(len), len);
    q = bq.clone().multiply(damped).multiply(bq.clone().invert());
  }
  turnAroundHead(bones, name, q);
  if (pb && (pb.use_ik_limit_x || pb.use_ik_limit_y || pb.use_ik_limit_z)) limitRotation(bones, pb, name);
}

function turnAroundHead(bones: Map<string, BoneEval>, name: string, q: Quaternion) {
  const b = bones.get(name)!;
  const o = head(b);
  const m = new Matrix4().makeTranslation(o.x, o.y, o.z).multiply(new Matrix4().makeRotationFromQuaternion(q)).multiply(new Matrix4().makeTranslation(-o.x, -o.y, -o.z)).multiply(b.pose);
  applyBonePose(bones, name, m);
}

/** Keep the bone's rotation relative to its rest orientation (under its parent) within the IK limits. */
function limitRotation(bones: Map<string, BoneEval>, pb: NonNullable<ObjectData['pose']>[string], name: string) {
  const b = bones.get(name)!;
  const parent = b.parent ? bones.get(b.parent) : undefined;
  const rot = (m: Matrix4) => {
    const r = new Quaternion();
    m.decompose(new Vector3(), r, new Vector3());
    return r;
  };
  const base = parent ? rot(parent.pose).multiply(rot(parent.restInv.clone().multiply(b.rest))) : rot(b.rest);
  const cur = rot(b.pose);
  const local = base.clone().invert().multiply(cur);
  const e = new Euler().setFromQuaternion(local, 'ZYX');
  const lim = (v: number, on: boolean | undefined, lo = 0, hi = 0) => (on ? Math.max(Math.min(lo, hi), Math.min(Math.max(lo, hi), v)) : v);
  const nx = lim(e.x, pb.use_ik_limit_x, pb.ik_min_x, pb.ik_max_x),
    ny = lim(e.y, pb.use_ik_limit_y, pb.ik_min_y, pb.ik_max_y),
    nz = lim(e.z, pb.use_ik_limit_z, pb.ik_min_z, pb.ik_max_z);
  if (nx === e.x && ny === e.y && nz === e.z) return;
  const want = base.clone().multiply(new Quaternion().setFromEuler(new Euler(nx, ny, nz, 'ZYX')));
  turnAroundHead(bones, name, want.multiply(cur.invert()));
}

/** Weighted average of rotations (sign-aligned quaternion sum). */
function averageRotation(rots: { q: Quaternion; w: number }[]): Quaternion {
  if (rots.length === 1) return rots[0].q;
  const acc = new Quaternion(0, 0, 0, 0);
  const ref = rots[0].q;
  for (const { q, w } of rots) {
    const s = q.dot(ref) < 0 ? -w : w;
    acc.set(acc.x + q.x * s, acc.y + q.y * s, acc.z + q.z * s, acc.w + q.w * s);
  }
  return acc.lengthSq() < 1e-12 ? new Quaternion() : acc.normalize();
}

/** Stretch the chain's bones (by their IK stretch amount) when the target is out of reach. */
function stretchChain(bones: Map<string, BoneEval>, ob: ObjectData, ch: IKChain) {
  if (!ch.stretch || !ch.target || !ch.bones.length) return;
  const root = bones.get(ch.bones[ch.bones.length - 1])!;
  const reach = ch.bones.reduce((acc, n) => acc + (n === ch.owner && !ch.useTail ? 0 : bones.get(n)!.length), 0);
  const dist = head(root).distanceTo(ch.target);
  if (dist <= reach + 1e-6) return;
  const caps = ch.bones.map((n) => Math.max(0, Math.min(1, ob.pose?.[n]?.ik_stretch ?? 0)) * bones.get(n)!.length);
  const total = caps.reduce((a, b) => a + b, 0);
  if (total <= 1e-9) return;
  const extra = dist - reach;
  // root first: a stretched parent scales its children, so each bone is sized from its current length
  for (let i = ch.bones.length - 1; i >= 0; i--) {
    if (!caps[i]) continue;
    const b = bones.get(ch.bones[i])!;
    const cur = head(b).distanceTo(tail(b));
    if (cur < 1e-9) continue;
    const f = (b.length + (extra * caps[i]) / total) / cur;
    applyBonePose(bones, b.name, b.pose.clone().multiply(new Matrix4().makeScale(f, f, f)));
  }
}

/** Solve a set of IK chains on a pose. */
export function solveChains(bones: Map<string, BoneEval>, ob: ObjectData, chains: IKChain[]) {
  chains = chains.filter((c) => c.bones.length && (c.target || c.targetRot));
  if (!chains.length) return;
  const involved = new Set<string>();
  for (const ch of chains) for (const n of ch.bones) involved.add(n);
  const original = new Map([...involved].map((n) => [n, bones.get(n)!.pose.clone()]));
  // bones processed from the tips towards the roots (deepest first)
  const depth = (n: string) => {
    let d = 0;
    for (let p = bones.get(n)?.parent; p; p = bones.get(p)?.parent) d++;
    return d;
  };
  const order = [...involved].sort((a, b) => depth(b) - depth(a));
  for (const ch of chains) stretchChain(bones, ob, ch);
  const iters = Math.max(1, Math.min(200, Math.max(...chains.map((c) => c.iterations || 500))));
  const tmpA = new Vector3(),
    tmpB = new Vector3();
  for (let it = 0; it < iters; it++) {
    for (const name of order) {
      const rots: { q: Quaternion; w: number }[] = [];
      for (const ch of chains) {
        if (!ch.target || !ch.bones.includes(name)) continue;
        const o = head(bones.get(name)!);
        tmpA.copy(effector(bones, ch)).sub(o);
        tmpB.copy(ch.target).sub(o);
        if (tmpA.lengthSq() < 1e-12 || tmpB.lengthSq() < 1e-12) continue;
        rots.push({ q: new Quaternion().setFromUnitVectors(tmpA.normalize(), tmpB.normalize()), w: ch.weight });
      }
      if (rots.length) rotateBone(bones, ob, name, averageRotation(rots));
    }
    if (chains.every((ch) => !ch.target || effector(bones, ch).distanceTo(ch.target) < 1e-5)) break;
  }
  for (const ch of chains) {
    // the pole turns the whole chain around the root→target axis so the root's X axis faces the pole
    // (the pole angle then turns it further around that axis)
    if (ch.pole && ch.target && ch.bones.length > 1) {
      const root = bones.get(ch.bones[ch.bones.length - 1])!;
      const rootPos = head(root);
      const axis = ch.target.clone().sub(rootPos);
      if (axis.lengthSq() > 1e-12) {
        axis.normalize();
        const project = (p: Vector3) => {
          const d = p.clone().sub(rootPos);
          return d.sub(axis.clone().multiplyScalar(d.dot(axis)));
        };
        const rootX = new Vector3(1, 0, 0).transformDirection(root.pose);
        const bend = rootX.sub(axis.clone().multiplyScalar(rootX.dot(axis)));
        const pole = project(ch.pole);
        if (bend.lengthSq() > 1e-12 && pole.lengthSq() > 1e-12) {
          bend.normalize();
          pole.normalize();
          let ang = Math.acos(Math.max(-1, Math.min(1, bend.dot(pole))));
          if (new Vector3().crossVectors(bend, pole).dot(axis) < 0) ang = -ang;
          rotateBone(bones, ob, root.name, new Quaternion().setFromAxisAngle(axis, ang + ch.poleAngle));
        }
      }
    }
    // rotation target: the owner bone turns towards the target's orientation
    if (ch.targetRot) {
      const b = bones.get(ch.owner)!;
      const cur = new Quaternion();
      b.pose.decompose(new Vector3(), cur, new Vector3());
      const want = cur.clone().slerp(ch.targetRot, ch.orientWeight);
      rotateBone(bones, ob, ch.owner, want.multiply(cur.clone().invert()));
    }
  }
  // influence: blend each chain's bones back towards the pose before the solve
  for (const ch of chains) {
    if (ch.influence >= 1) continue;
    for (const name of [...ch.bones].reverse()) {
      const b = bones.get(name)!;
      const p0 = new Vector3(),
        q0 = new Quaternion(),
        s0 = new Vector3(),
        p1 = new Vector3(),
        q1 = new Quaternion(),
        s1 = new Vector3();
      original.get(name)!.decompose(p0, q0, s0);
      b.pose.decompose(p1, q1, s1);
      applyBonePose(bones, name, new Matrix4().compose(p0.lerp(p1, ch.influence), q0.slerp(q1, ch.influence), s0.lerp(s1, ch.influence)));
    }
  }
}

/** IK chain description for a constraint (target positions in armature space). */
export function ikChainFor(
  bones: Map<string, BoneEval>,
  owner: string,
  c: Constraint,
  armInv: Matrix4,
  targetWorld: (id: string | null | undefined, bone?: string) => Matrix4 | null,
): IKChain | null {
  if (!bones.has(owner)) return null;
  const useTail = c.use_tail !== false;
  const tw = targetWorld(c.target as string, (c.subtarget as string) || undefined);
  if (!tw) return null;
  const tm = armInv.clone().multiply(tw);
  const useLoc = c.use_location !== false;
  const target = useLoc ? new Vector3().setFromMatrixPosition(tm) : null;
  let targetRot: Quaternion | null = null;
  if (c.use_rotation) {
    targetRot = new Quaternion();
    tm.decompose(new Vector3(), targetRot, new Vector3());
  }
  const pw = c.pole_target ? targetWorld(c.pole_target as string, (c.pole_subtarget as string) || undefined) : null;
  return {
    owner,
    bones: ikChainBones(bones, owner, (c.chain_count as number) || 0, useTail),
    useTail,
    target,
    targetRot,
    pole: pw ? new Vector3().setFromMatrixPosition(armInv.clone().multiply(pw)) : null,
    poleAngle: (c.pole_angle as number) ?? 0,
    weight: Math.max(0.01, (c.weight as number) ?? 1),
    orientWeight: Math.max(0.01, Math.min(1, (c.orient_weight as number) ?? 1)),
    influence: c.influence,
    iterations: (c.iterations as number) || 500,
    stretch: c.use_stretch !== false,
  };
}

/** Kept for callers of the former single-chain API. */
export function solveIK(bones: Map<string, BoneEval>, arm: ArmatureData, tipName: string, target: Vector3, chainCount: number, iterations: number, influence: number, pole: Vector3 | null, poleAngle: number) {
  void arm;
  const ob = { pose: {} } as unknown as ObjectData;
  solveChains(bones, ob, [{ owner: tipName, bones: ikChainBones(bones, tipName, chainCount, true), useTail: true, target, targetRot: null, pole, poleAngle, weight: 1, orientWeight: 1, influence, iterations, stretch: false }]);
}
