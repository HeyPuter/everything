// Armature rest/pose evaluation and linear blend skinning.
// Bone convention: the bone's local Y axis points from head to tail, roll rotates
// around Y. Rest matrices are in armature space with translation at the head.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ArmatureData, Bone, DocumentData, ObjectData, PoseBone, Vec3 } from '../data/types';
import { poseBoneMatrix } from './transform';
import type { Depsgraph } from './depsgraph';
import { solveBoneConstraints } from './constraint_solve';

export interface BoneEval {
  name: string;
  rest: Matrix4; // armature space
  restInv: Matrix4;
  pose: Matrix4; // armature space, posed
  /** pose * restInv: deforms rest-space vertices */
  deform: Matrix4;
  length: number;
  parent: string | null;
}

export interface PoseResult {
  bones: Map<string, BoneEval>;
  order: string[];
  signature: string;
}

/** Rotation that maps +Y onto `dir` with roll around it. */
export function boneRotation(dir: Vector3, roll: number, out = new Matrix4()): Matrix4 {
  const y = dir.clone().normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), y);
  if (y.y < -0.99999) q.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
  const r = new Quaternion().setFromAxisAngle(y, roll);
  q.premultiply(r);
  return out.makeRotationFromQuaternion(q);
}

export function boneRestMatrix(b: Bone, out = new Matrix4()): Matrix4 {
  const head = new Vector3(...b.head),
    tail = new Vector3(...b.tail);
  boneRotation(tail.clone().sub(head), b.roll, out);
  out.setPosition(head);
  return out;
}

export function defaultPoseBone(): PoseBone {
  return {
    location: [0, 0, 0],
    rotation_mode: 'QUATERNION',
    rotation_quaternion: [1, 0, 0, 0],
    rotation_euler: [0, 0, 0],
    rotation_axis_angle: [0, 0, 1, 0],
    scale: [1, 1, 1],
    constraints: [],
  };
}

export function sortedBones(arm: ArmatureData): Bone[] {
  const byName = new Map(arm.bones.map((b) => [b.name, b]));
  const out: Bone[] = [],
    seen = new Set<string>();
  const visit = (b: Bone) => {
    if (seen.has(b.name)) return;
    seen.add(b.name);
    if (b.parent && byName.has(b.parent)) visit(byName.get(b.parent)!);
    out.push(b);
  };
  arm.bones.forEach(visit);
  return out;
}

export function evaluatePose(doc: DocumentData, ob: ObjectData, arm: ArmatureData, graph?: Depsgraph): PoseResult {
  const bones = new Map<string, BoneEval>(),
    order: string[] = [];
  const restPosition = arm.pose_position === 'REST' || !!graph?.editObjects.has(ob.id);
  const local = new Matrix4();
  for (const b of sortedBones(arm)) {
    const rest = boneRestMatrix(b);
    const ev: BoneEval = {
      name: b.name,
      rest,
      restInv: rest.clone().invert(),
      pose: new Matrix4(),
      deform: new Matrix4(),
      length: new Vector3(...b.tail).distanceTo(new Vector3(...b.head)),
      parent: b.parent,
    };
    const pb = ob.pose?.[b.name];
    if (pb && !restPosition) poseBoneMatrix(pb, local);
    else local.identity();
    const parent = b.parent ? bones.get(b.parent) : undefined;
    // the bone's frame before its own pose: the parent's pose carried to the bone's rest place
    let inh: { full: Matrix4; frame: Matrix4; after: Vector3 | null };
    if (parent) {
      // parent pose * (parent rest^-1 * rest)
      const relRest = parent.restInv.clone().multiply(rest);
      // connected bones start at the parent's tail
      if (b.use_connect) relRest.setPosition(0, parent.length, 0);
      inh = inheritedFrame(parent, relRest, b);
    } else inh = { full: rest.clone(), frame: rest.clone(), after: null };
    let loc: Vector3 | null = null;
    if (b.use_local_location === false && (local.elements[12] || local.elements[13] || local.elements[14])) {
      // location in the parent's (armature's, for roots) axes instead of the bone's own
      loc = new Vector3().setFromMatrixPosition(local);
      local.setPosition(0, 0, 0);
    }
    ev.pose.multiplyMatrices(inh.frame, local);
    if (inh.after) ev.pose.scale(inh.after);
    // the head follows the fully transformed parent (with the bone's own location)
    const head = new Vector3().setFromMatrixPosition(new Matrix4().multiplyMatrices(inh.full, local));
    if (loc) {
      const pf = parent ? parent.pose : new Matrix4();
      head.add(loc.applyMatrix4(new Matrix4().extractRotation(pf).scale(new Vector3().setFromMatrixScale(pf))));
    }
    ev.pose.setPosition(head);
    bones.set(b.name, ev);
    order.push(b.name);
  }
  // Bone constraints (IK, copy rotation, damped track...) in hierarchy order
  if (ob.pose && !restPosition && graph) solveBoneConstraints(graph, doc, ob, arm, bones, order, (name, m) => setBonePose(bones, name, m));
  let sig = '';
  for (const name of order) {
    const ev = bones.get(name)!;
    ev.deform.multiplyMatrices(ev.pose, ev.restInv);
    sig += ev.pose.elements.map((x) => x.toFixed(4)).join(',') + ',' + ev.length.toFixed(4) + ';';
  }
  return { bones, order, signature: hashString(sig) };
}

/**
 * How a child bone inherits its parent's pose: the parent's pose carried to the child's rest
 * placement (`relRest`) gives the "full" frame; `frame` is the one the child's own pose applies
 * in (rotation / scale inheritance options), `after` an extra scale applied after the child's
 * own transform (Aligned), and the head always follows the full frame.
 */
export function inheritedFrame(parent: { pose: Matrix4; rest: Matrix4 }, relRest: Matrix4, b: Pick<Bone, 'use_inherit_rotation' | 'inherit_scale'>): { full: Matrix4; frame: Matrix4; after: Vector3 | null } {
  const full = parent.pose.clone().multiply(relRest);
  const mode = b.inherit_scale ?? 'FULL';
  const one = new Vector3(1, 1, 1);
  if (b.use_inherit_rotation !== false && mode === 'FULL') return { full, frame: full, after: null };
  const p = new Vector3(),
    q = new Quaternion(),
    sc = new Vector3();
  parent.pose.decompose(p, q, sc);
  if (b.use_inherit_rotation === false) parent.rest.decompose(new Vector3(), q, new Vector3());
  const relRot = new Matrix4().extractRotation(relRest);
  switch (mode) {
    case 'NONE':
    case 'NONE_LEGACY':
      return { full, frame: new Matrix4().compose(p, q, one).multiply(relRot), after: null };
    case 'AVERAGE': {
      // uniform: the cube root of the parent's volume change
      const v = Math.cbrt(Math.abs(sc.x * sc.y * sc.z)) || 1;
      return { full, frame: new Matrix4().compose(p, q, one).multiply(relRot), after: new Vector3(v, v, v) };
    }
    case 'ALIGNED':
      // the parent's X / Y / Z scale along the child's own X / Y / Z axes
      return { full, frame: new Matrix4().compose(p, q, one).multiply(relRot), after: sc.clone() };
    case 'FIX_SHEAR':
      return { full, frame: removeShear(b.use_inherit_rotation === false ? new Matrix4().compose(p, q, sc).multiply(relRest) : full), after: null };
    default:
      return { full, frame: new Matrix4().compose(p, q, sc).multiply(relRest), after: null };
  }
}

/**
 * Remove shear around the bone axis: Y stays, X and Z are made perpendicular to it and to each
 * other symmetrically (the bisector of the pair stays), keeping the volume.
 */
export function removeShear(m: Matrix4): Matrix4 {
  const e = m.elements;
  const X = new Vector3(e[0], e[1], e[2]),
    Y = new Vector3(e[4], e[5], e[6]),
    Z = new Vector3(e[8], e[9], e[10]);
  const yn = Y.clone().normalize();
  const xp = X.clone().addScaledVector(yn, -X.dot(yn)),
    zp = Z.clone().addScaledVector(yn, -Z.dot(yn));
  const lx = xp.length(),
    lz = zp.length();
  if (lx < 1e-12 || lz < 1e-12) return m.clone();
  const xn = xp.clone().divideScalar(lx),
    zn = zp.clone().divideScalar(lz);
  const b1 = xn.clone().add(zn).normalize(),
    b2 = xn.clone().sub(zn).normalize();
  const s = Math.SQRT1_2;
  const xd = b1.clone().add(b2).multiplyScalar(s),
    zd = b1.clone().sub(b2).multiplyScalar(s);
  // keep the area of the X/Z pair (sin of their angle) so the volume does not change
  const k = Math.sqrt(Math.max(1e-12, xp.clone().cross(zp).length() / (lx * lz)));
  xd.multiplyScalar(lx * k);
  zd.multiplyScalar(lz * k);
  const out = m.clone();
  const o = out.elements;
  [o[0], o[1], o[2]] = [xd.x, xd.y, xd.z];
  [o[8], o[9], o[10]] = [zd.x, zd.y, zd.z];
  return out;
}

function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function propagateChildren(bones: Map<string, BoneEval>, name: string, delta: Matrix4) {
  for (const b of bones.values())
    if (b.parent === name) {
      b.pose.premultiply(delta);
      propagateChildren(bones, b.name, delta);
    }
}

/** Replace a bone's pose matrix and carry its children along. */
export function setBonePose(bones: Map<string, BoneEval>, name: string, m: Matrix4) {
  const b = bones.get(name)!;
  const delta = m.clone().multiply(b.pose.clone().invert());
  b.pose.copy(m);
  propagateChildren(bones, name, delta);
}

/** Deform positions (object space) by an armature; returns new array. */
export function skinPositions(
  positions: Float32Array,
  groups: { name: string }[],
  weights: Float32Array[],
  pose: PoseResult,
  meshToArm: Matrix4,
  armToMesh: Matrix4,
  preserveVolume = false,
  envelopeFallback = false,
): Float32Array {
  void preserveVolume;
  void envelopeFallback;
  const n = positions.length / 3,
    out = new Float32Array(positions.length);
  const mats: (Matrix4 | null)[] = groups.map((g) => {
    const b = pose.bones.get(g.name);
    return b ? armToMesh.clone().multiply(b.deform).multiply(meshToArm) : null;
  });
  const v = new Vector3(),
    acc = new Vector3(),
    tmp = new Vector3();
  for (let i = 0; i < n; i++) {
    v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    acc.set(0, 0, 0);
    let total = 0;
    for (let g = 0; g < mats.length; g++) {
      const m = mats[g];
      if (!m) continue;
      const w = weights[g]?.[i] ?? 0;
      if (w <= 0) continue;
      tmp.copy(v).applyMatrix4(m).multiplyScalar(w);
      acc.add(tmp);
      total += w;
    }
    if (total > 0) acc.multiplyScalar(1 / total);
    else acc.copy(v);
    out[i * 3] = acc.x;
    out[i * 3 + 1] = acc.y;
    out[i * 3 + 2] = acc.z;
  }
  return out;
}

export function boneTailWorld(b: Bone): Vec3 {
  return [...b.tail] as Vec3;
}
