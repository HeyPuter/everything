// Action, Armature and Geometry Attribute constraints.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { ActionData, Constraint, DocumentData, RotationMode } from '../data/types';
import type { ConstraintContext, EvalMesh } from './types';
import { constraintTypes, decompose, eulerToQuat, mixMatrix, quatToEuler } from './constraints';
import { evaluateFCurve } from '../anim/fcurve';
import { threeOrder } from './transform';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------------------
// Action

/** Local transform an action produces at a frame for an object (no bone) or a pose bone. */
export function actionMatrix(action: ActionData, frame: number, bone: string | null, rotationMode: RotationMode = 'XYZ'): Matrix4 {
  const prefix = bone ? `pose.bones["${bone}"].` : '';
  const loc = [0, 0, 0],
    scale = [1, 1, 1],
    euler = [0, 0, 0],
    quat = [1, 0, 0, 0];
  let hasQuat = false,
    hasEuler = false;
  for (const fc of action.fcurves) {
    if (fc.mute || !fc.data_path.startsWith(prefix)) continue;
    const prop = fc.data_path.slice(prefix.length);
    if (prop.includes('.') || prop.includes('[')) continue;
    const v = evaluateFCurve(fc, frame);
    const i = fc.array_index;
    if (prop === 'location' && i < 3) loc[i] = v;
    else if (prop === 'scale' && i < 3) scale[i] = v;
    else if (prop === 'rotation_euler' && i < 3) {
      euler[i] = v;
      hasEuler = true;
    } else if (prop === 'rotation_quaternion' && i < 4) {
      quat[i] = v;
      hasQuat = true;
    }
  }
  let q: Quaternion;
  if (hasQuat && !hasEuler) q = new Quaternion(quat[1], quat[2], quat[3], quat[0]).normalize();
  else q = new Quaternion().setFromEuler(new Euler(euler[0], euler[1], euler[2], threeOrder(rotationMode === 'QUATERNION' || rotationMode === 'AXIS_ANGLE' ? 'XYZ' : rotationMode)));
  return new Matrix4().compose(new Vector3(loc[0], loc[1], loc[2]), q, new Vector3(scale[0], scale[1], scale[2]));
}

/** Frame of the action the constraint evaluates (from the target's channel or the evaluation time). */
export function actionFrame(c: Constraint, target: Matrix4 | null): number | null {
  const start = (c.frame_start as number) ?? 0,
    end = (c.frame_end as number) ?? 0;
  let s: number;
  if (c.use_eval_time) s = (c.eval_time as number) ?? 0;
  else {
    if (!target) return null;
    const d = decompose(target);
    const ch = String(c.transform_channel ?? 'LOCATION_X');
    const ax = ({ X: 0, Y: 1, Z: 2 } as const)[ch.slice(-1) as 'X' | 'Y' | 'Z'] ?? 0;
    let v: number;
    if (ch.startsWith('LOCATION')) v = [d.p.x, d.p.y, d.p.z][ax];
    else if (ch.startsWith('SCALE')) v = [d.s.x, d.s.y, d.s.z][ax];
    // rotation ranges are given in degrees
    else v = (quatToEuler(d.q, 'XYZ')[ax] * 180) / Math.PI;
    const lo = (c.min as number) ?? 0,
      hi = (c.max as number) ?? 0;
    s = hi !== lo ? (v - lo) / (hi - lo) : 0;
  }
  return start + clamp(s, 0, 1) * (end - start);
}

constraintTypes.ACTION = {
  type: 'ACTION',
  label: 'Action',
  category: 'RELATIONSHIP',
  usesTarget: true,
  // mixing happens on the owner's local transform; the target channel is read in the target space
  spaces: { owner: true, target: true },
  defaults: () => ({ owner_space: 'LOCAL', mix_mode: 'AFTER', transform_channel: 'LOCATION_X', action: null, use_bone_object_action: false, frame_start: 1, frame_end: 1, min: 0, max: 0, eval_time: 0, use_eval_time: false }),
  isValid: (c, { doc }) => !!doc.actions[c.action as string] && (!!c.use_eval_time || !!c.target),
  apply(owner, c, ctx) {
    const action = ctx.doc.actions[c.action as string];
    if (!action) return;
    const frame = actionFrame(c, ctx.target ?? null);
    if (frame === null) return;
    const bone = ctx.pchan && !c.use_bone_object_action ? ctx.pchan.name : null;
    const mode = bone ? ctx.ob.pose?.[bone]?.rotation_mode : ctx.ob.rotation_mode;
    mixMatrix(owner, actionMatrix(action, frame, bone, mode ?? 'XYZ'), (c.mix_mode as string) ?? 'AFTER');
  },
};

// ---------------------------------------------------------------------------
// Armature (deform like an armature modifier, for a whole object or bone)

export interface ArmatureTarget {
  target: string | null;
  subtarget: string;
  weight: number;
}

/** Envelope influence of a bone (rest position) on a point in armature space. */
export function envelopeWeight(head: Vector3, tail: Vector3, headRadius: number, tailRadius: number, dist: number, p: Vector3): number {
  const seg = tail.clone().sub(head);
  const len2 = seg.lengthSq();
  const t = len2 > 1e-12 ? clamp(p.clone().sub(head).dot(seg) / len2, 0, 1) : 0;
  const closest = head.clone().addScaledVector(seg, t);
  const d = p.distanceTo(closest);
  const r = headRadius + (tailRadius - headRadius) * t;
  if (d <= r) return 1;
  const outer = r + Math.max(0, dist);
  if (d >= outer) return 0;
  // quadratic falloff across the envelope distance
  return (outer * outer - d * d) / (outer * outer - r * r);
}

function dualQuatBlend(mats: { m: Matrix4; w: number }[]): Matrix4 {
  const r = new Quaternion(0, 0, 0, 0),
    dual = new Quaternion(0, 0, 0, 0);
  const sc = new Vector3();
  let ref: Quaternion | null = null,
    total = 0;
  for (const { m, w } of mats) {
    const d = decompose(m);
    const q = d.q;
    if (!ref) ref = q.clone();
    const s = q.dot(ref) < 0 ? -w : w;
    // dual part = 0.5 * t * q
    const t = new Quaternion(d.p.x, d.p.y, d.p.z, 0).multiply(q);
    r.set(r.x + q.x * s, r.y + q.y * s, r.z + q.z * s, r.w + q.w * s);
    dual.set(dual.x + t.x * 0.5 * s, dual.y + t.y * 0.5 * s, dual.z + t.z * 0.5 * s, dual.w + t.w * 0.5 * s);
    sc.addScaledVector(d.s, w);
    total += w;
  }
  const len = r.length();
  if (len < 1e-12 || total <= 0) return new Matrix4();
  r.set(r.x / len, r.y / len, r.z / len, r.w / len);
  dual.set(dual.x / len, dual.y / len, dual.z / len, dual.w / len);
  // translation = 2 * dual * conj(real)
  const tq = dual.clone().multiply(r.clone().invert());
  return new Matrix4().compose(new Vector3(tq.x * 2, tq.y * 2, tq.z * 2), r, sc.divideScalar(total));
}

constraintTypes.ARMATURE = {
  type: 'ARMATURE',
  label: 'Armature',
  category: 'RELATIONSHIP',
  defaults: () => ({ targets: [], use_deform_preserve_volume: false, use_bone_envelopes: false, use_current_location: false }),
  deps: (c) => ((c.targets as ArmatureTarget[]) ?? []).map((t) => t.target),
  isValid: (c, { doc }) => {
    const ts = (c.targets as ArmatureTarget[]) ?? [];
    return ts.length > 0 && ts.every((t) => doc.objects[t.target ?? '']?.type === 'ARMATURE' && !!t.subtarget);
  },
  apply(owner, c, ctx) {
    const targets = (c.targets as ArmatureTarget[]) ?? [];
    const pos = new Vector3().setFromMatrixPosition(owner);
    if (ctx.pchan && !c.use_current_location) {
      // envelopes use the owner bone's rest head
      const b = ctx.pchan.bones.get(ctx.pchan.name);
      if (b) pos.setFromMatrixPosition(b.rest).applyMatrix4(ctx.pchan.armWorld);
    }
    const mats: { m: Matrix4; w: number }[] = [];
    for (const t of targets) {
      if (!t.target || !t.subtarget || !(t.weight > 0)) continue;
      const ev = ctx.graph.get(t.target);
      if (!ev || ev.ob.type !== 'ARMATURE') continue;
      const self = ctx.pchan && t.target === ctx.ob.id;
      const bones = self ? ctx.pchan!.bones : ev.pose?.bones;
      const armWorld = self ? ctx.pchan!.armWorld : ev.world;
      const b = bones?.get(t.subtarget);
      if (!b) continue;
      let w = t.weight;
      if (c.use_bone_envelopes) {
        const bone = armBone(ctx.doc, ev.ob.data, t.subtarget);
        if (!bone) continue;
        const local = pos.clone().applyMatrix4(armWorld.clone().invert());
        w *= envelopeWeight(new Vector3(...bone.head), new Vector3(...bone.tail), bone.head_radius, bone.tail_radius, bone.envelope_distance, local);
        if (w <= 0) continue;
      }
      const deform = armWorld.clone().multiply(b.pose).multiply(b.restInv).multiply(armWorld.clone().invert());
      mats.push({ m: deform, w });
    }
    if (!mats.length) return;
    let blended: Matrix4;
    if (c.use_deform_preserve_volume) blended = dualQuatBlend(mats);
    else {
      const total = mats.reduce((a, x) => a + x.w, 0);
      const e = new Array(16).fill(0);
      for (const { m, w } of mats) for (let i = 0; i < 16; i++) e[i] += m.elements[i] * (w / total);
      blended = new Matrix4().fromArray(e);
    }
    owner.premultiply(blended);
  },
};

function armBone(doc: DocumentData, data: string | null | undefined, name: string) {
  return data ? doc.armatures[data]?.bones.find((b) => b.name === name) : undefined;
}

// ---------------------------------------------------------------------------
// Geometry Attribute (transform read from a target's evaluated geometry)

/** Value of a named attribute at an index of an evaluated mesh, as a matrix (location/rotation/transform). */
export function sampleAttribute(mesh: EvalMesh, doc: DocumentData, dataId: string | null | undefined, name: string, domain: string, index: number): { kind: 'VECTOR' | 'MATRIX'; v?: Vector3; m?: Matrix4 } | null {
  const P = mesh.positions;
  const vert = (i: number) => new Vector3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
  if (domain === 'INSTANCE') {
    const inst = mesh.instances?.[index];
    if (!inst) return null;
    const m = new Matrix4().fromArray(inst.matrix);
    if (name === 'instance_transform') return { kind: 'MATRIX', m };
    if (name === 'position') return { kind: 'VECTOR', v: new Vector3().setFromMatrixPosition(m) };
    return null;
  }
  if (name === 'position') {
    if (domain === 'POINT') return index * 3 < P.length ? { kind: 'VECTOR', v: vert(index) } : null;
    if (domain === 'FACE_CORNER') return index < mesh.indices.length ? { kind: 'VECTOR', v: vert(mesh.indices[index]) } : null;
    if (domain === 'FACE') {
      if (index >= mesh.offsets.length - 1) return null;
      const s = mesh.offsets[index],
        e = mesh.offsets[index + 1];
      const c = new Vector3();
      for (let k = s; k < e; k++) c.add(vert(mesh.indices[k]));
      return { kind: 'VECTOR', v: c.divideScalar(Math.max(1, e - s)) };
    }
    if (domain === 'EDGE') {
      const edges = meshEdges(mesh);
      if (index * 2 >= edges.length) return null;
      return { kind: 'VECTOR', v: vert(edges[index * 2]).add(vert(edges[index * 2 + 1])).multiplyScalar(0.5) };
    }
    if (domain === 'CURVE') {
      const cv = mesh.curves?.[index];
      if (!cv || !cv.points.length) return null;
      const c = new Vector3();
      const n = cv.points.length / 3;
      for (let k = 0; k < n; k++) c.add(new Vector3(cv.points[k * 3], cv.points[k * 3 + 1], cv.points[k * 3 + 2]));
      return { kind: 'VECTOR', v: c.divideScalar(n) };
    }
    return null;
  }
  // color attributes of the source mesh read as vectors (RGB)
  const me = dataId ? doc.meshes[dataId] : undefined;
  const ca = me?.color_attributes.find((a) => a.name === name);
  if (ca && me && me.positions.length === P.length) {
    let i = -1;
    if (domain === 'POINT') i = ca.domain === 'POINT' ? index : me.indices.indexOf(index);
    else if (domain === 'FACE_CORNER') i = ca.domain === 'CORNER' ? index : (me.indices[index] ?? -1);
    if (i < 0 || i * 4 >= ca.data.length) return null;
    return { kind: 'VECTOR', v: new Vector3(ca.data[i * 4], ca.data[i * 4 + 1], ca.data[i * 4 + 2]) };
  }
  return null;
}

const edgeCache = new WeakMap<Uint32Array, Uint32Array>();
function meshEdges(mesh: EvalMesh): Uint32Array {
  const hit = edgeCache.get(mesh.indices);
  if (hit) return hit;
  const seen = new Set<string>(),
    out: number[] = [];
  for (let f = 0; f < mesh.offsets.length - 1; f++) {
    const s = mesh.offsets[f],
      e = mesh.offsets[f + 1];
    for (let k = s; k < e; k++) {
      const a = mesh.indices[k],
        b = mesh.indices[k + 1 < e ? k + 1 : s];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(Math.min(a, b), Math.max(a, b));
    }
  }
  const arr = Uint32Array.from(out);
  edgeCache.set(mesh.indices, arr);
  return arr;
}

constraintTypes.GEOMETRY_ATTRIBUTE = {
  type: 'GEOMETRY_ATTRIBUTE',
  label: 'Geometry Attribute',
  category: 'RELATIONSHIP',
  needsTargetData: true,
  defaults: () => ({ attribute_name: 'position', domain: 'POINT', apply_target_transform: false, data_type: 'VECTOR', sample_index: 0, mix_loc: true, mix_rot: true, mix_scl: true, mix_mode: 'REPLACE' }),
  deps: (c) => [c.target as string],
  isValid: (c, { doc }) => !!doc.objects[c.target as string] && !!c.attribute_name,
  apply(owner, c, ctx: ConstraintContext) {
    const t = c.target ? ctx.graph.get(c.target as string) : undefined;
    if (!t?.mesh) return;
    const val = sampleAttribute(t.mesh, ctx.doc, t.ob.data, String(c.attribute_name ?? 'position'), String(c.domain ?? 'POINT'), Math.max(0, Math.floor((c.sample_index as number) ?? 0)));
    if (!val) return;
    const type = (c.data_type as string) ?? 'VECTOR';
    let m: Matrix4;
    if (val.kind === 'MATRIX') {
      const d = decompose(val.m!);
      if (type === 'VECTOR') m = new Matrix4().makeTranslation(d.p.x, d.p.y, d.p.z);
      else if (type === 'QUATERNION') m = new Matrix4().makeRotationFromQuaternion(d.q);
      else m = val.m!.clone();
    } else {
      const v = val.v!;
      // vectors read as rotations are Euler angles
      if (type === 'QUATERNION') m = new Matrix4().makeRotationFromQuaternion(eulerToQuat([v.x, v.y, v.z], 'XYZ'));
      else m = new Matrix4().makeTranslation(v.x, v.y, v.z);
    }
    if (c.apply_target_transform) m.premultiply(t.world);
    const mode = (c.mix_mode as string) ?? 'REPLACE';
    if (c.mix_loc === false || c.mix_rot === false || c.mix_scl === false) {
      // channels left out keep the owner's values (replace) or contribute nothing (combine modes)
      const d = decompose(m),
        o = decompose(owner);
      const keep = mode === 'REPLACE';
      m.compose(c.mix_loc === false ? (keep ? o.p : new Vector3()) : d.p, c.mix_rot === false ? (keep ? o.q : new Quaternion()) : d.q, c.mix_scl === false ? (keep ? o.s : new Vector3(1, 1, 1)) : d.s);
    }
    mixMatrix(owner, m, mode);
  },
};
