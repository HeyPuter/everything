// Constraint stack evaluation: owner/target space conversion, influence blending and the
// per-bone evaluation of pose constraints (including the IK solvers).
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ArmatureData, Bone, Constraint, DocumentData, ObjectData } from '../data/types';
import type { BoneOwner, ConstraintContext } from './types';
import type { Depsgraph } from './depsgraph';
import type { BoneEval } from './armature';
import { constraintTypes } from './constraints';
import { applyBonePose, ikChainFor, solveChains, type IKChain } from './ik';
import { solveSplineIK } from './splineik';
import './constraints_more';

/** Where a matrix lives, for converting it between constraint spaces. */
export type SpaceInfo =
  | { kind: 'OBJECT'; parent: Matrix4 | null }
  | { kind: 'BONE'; armWorld: Matrix4; bones: Map<string, BoneEval>; arm: ArmatureData; name: string };

/** Blend two matrices through loc/rot/scale (influence). */
export function blendMatrices(a: Matrix4, b: Matrix4, t: number, out: Matrix4) {
  const pa = new Vector3(),
    pb = new Vector3(),
    sa = new Vector3(),
    sb = new Vector3(),
    qa = new Quaternion(),
    qb = new Quaternion();
  a.decompose(pa, qa, sa);
  b.decompose(pb, qb, sb);
  pa.lerp(pb, t);
  qa.slerp(qb, t);
  sa.lerp(sb, t);
  return out.compose(pa, qa, sa);
}

/** Matrix such that pose = base * local for a bone (its parent's pose and its rest offset). */
export function boneBaseMatrix(bones: Map<string, BoneEval>, arm: ArmatureData, name: string): Matrix4 {
  const b = bones.get(name);
  if (!b) return new Matrix4();
  const parent = b.parent ? bones.get(b.parent) : undefined;
  if (!parent) return b.rest.clone();
  const bone: Bone | undefined = arm.bones.find((x) => x.name === name);
  const relRest = parent.restInv.clone().multiply(b.rest);
  if (bone?.use_connect) relRest.setPosition(0, parent.length, 0);
  let parentPose = parent.pose;
  if (bone && (!bone.use_inherit_rotation || bone.inherit_scale === 'NONE')) {
    const p = new Vector3(),
      q = new Quaternion(),
      s = new Vector3(),
      qr = new Quaternion();
    parent.pose.decompose(p, q, s);
    parent.rest.decompose(new Vector3(), qr, new Vector3());
    parentPose = new Matrix4().compose(p, bone.use_inherit_rotation ? q : qr, bone.inherit_scale === 'NONE' ? new Vector3(1, 1, 1) : s);
  }
  return parentPose.clone().multiply(relRest);
}

/** Matrix converting from world space into the given space (multiply on the left). */
function spaceMatrix(space: string, info: SpaceInfo, c: Constraint, ctx: ConstraintContext, ownerInfo?: SpaceInfo): Matrix4 | null {
  if (space === 'CUSTOM') {
    const m = ctx.targetWorld?.(c.space_object as string, (c.space_subtarget as string) || undefined);
    return m ? m.clone().invert() : null;
  }
  if (info.kind === 'OBJECT') {
    if (space === 'LOCAL' || space === 'LOCAL_WITH_PARENT' || space === 'LOCAL_OWNER_ORIENT') return info.parent ? info.parent.clone().invert() : null;
    return null;
  }
  const armInv = info.armWorld.clone().invert();
  const b = info.bones.get(info.name);
  if (space === 'POSE' || !b) return space === 'WORLD' ? null : armInv;
  if (space === 'LOCAL_WITH_PARENT') return b.restInv.clone().multiply(armInv);
  if (space === 'LOCAL' || space === 'LOCAL_OWNER_ORIENT') return boneBaseMatrix(info.bones, info.arm, info.name).invert().multiply(armInv);
  void ownerInfo;
  return null;
}

/** Convert a world matrix into a constraint space (in place). */
export function toSpace(m: Matrix4, space: string | undefined, info: SpaceInfo, c: Constraint, ctx: ConstraintContext, ownerInfo?: SpaceInfo): Matrix4 {
  if (!space || space === 'WORLD') return m;
  const s = spaceMatrix(space, info, c, ctx, ownerInfo);
  if (s) m.premultiply(s);
  if (space === 'LOCAL_OWNER_ORIENT' && info.kind === 'BONE' && ownerInfo?.kind === 'BONE') {
    // the target's local transform expressed along the owner bone's rest axes
    const rt = new Quaternion(),
      ro = new Quaternion();
    const tb = info.bones.get(info.name),
      ob = ownerInfo.bones.get(ownerInfo.name);
    if (tb && ob) {
      new Matrix4().multiplyMatrices(info.armWorld, tb.rest).decompose(new Vector3(), rt, new Vector3());
      new Matrix4().multiplyMatrices(ownerInfo.armWorld, ob.rest).decompose(new Vector3(), ro, new Vector3());
      const r = new Matrix4().makeRotationFromQuaternion(ro.invert().multiply(rt));
      m.premultiply(r).multiply(r.clone().invert());
    }
  }
  return m;
}

/** Convert a matrix from a constraint space back to world space (in place). */
export function fromSpace(m: Matrix4, space: string | undefined, info: SpaceInfo, c: Constraint, ctx: ConstraintContext): Matrix4 {
  if (!space || space === 'WORLD') return m;
  const s = spaceMatrix(space, info, c, ctx);
  if (s) m.premultiply(s.invert());
  return m;
}

/** World matrix of a target object or bone (bones of the owner armature come from the pose being evaluated). */
export function makeTargetWorld(graph: Depsgraph, owner: ObjectData, pchan?: BoneOwner) {
  return (id: string | null | undefined, bone?: string, headTail = 0): Matrix4 | null => {
    if (!id) return null;
    const t = graph.get(id);
    if (!t) return null;
    if (!bone) return t.world.clone();
    const bones = pchan && id === owner.id ? pchan.bones : t.pose?.bones;
    const b = bones?.get(bone);
    const armWorld = pchan && id === owner.id ? pchan.armWorld : t.world;
    if (!b) return armWorld.clone();
    const m = armWorld.clone().multiply(b.pose);
    if (headTail) m.multiply(new Matrix4().makeTranslation(0, b.length * headTail, 0));
    return m;
  };
}

/** Space information for a constraint's target. */
function targetInfo(graph: Depsgraph, doc: DocumentData, c: Constraint, owner: ObjectData, pchan?: BoneOwner): SpaceInfo {
  const t = graph.get(c.target as string);
  if (t && c.subtarget && t.ob.type === 'ARMATURE' && t.ob.data) {
    const arm = doc.armatures[t.ob.data];
    const self = pchan && t.ob.id === owner.id;
    if (arm) return { kind: 'BONE', armWorld: self ? pchan!.armWorld : t.world, bones: self ? pchan!.bones : (t.pose?.bones ?? new Map()), arm, name: c.subtarget as string };
  }
  return { kind: 'OBJECT', parent: t?.parentMatrix ?? null };
}

/** Objects a constraint depends on (targets, pole targets, custom space objects…). */
export function constraintDeps(c: Constraint, doc: DocumentData): string[] {
  const out: string[] = [];
  const add = (id: unknown) => typeof id === 'string' && id && !out.includes(id) && out.push(id);
  add(c.target);
  add(c.pole_target);
  add(c.space_object);
  for (const d of constraintTypes[c.type]?.deps?.(c, doc) ?? []) add(d);
  return out;
}

/**
 * Evaluate one constraint on a world-space owner matrix (in place): converts to the constraint's
 * spaces, applies it and blends the result by its influence.
 */
export function solveConstraint(world: Matrix4, c: Constraint, ctx: ConstraintContext, ownerInfo: SpaceInfo) {
  if (c.mute || !(c.influence > 0)) return;
  const t = constraintTypes[c.type];
  if (!t || t.boneOnly) return;
  if (t.needsTargetData && c.target) ctx.graph.ensureData(c.target as string);
  const before = world.clone();
  const ownerSpace = t.spaces?.owner ? (c.owner_space ?? 'WORLD') : 'WORLD';
  const m = toSpace(world.clone(), ownerSpace, ownerInfo, c, ctx);
  ctx.target = null;
  if (t.usesTarget && c.target) {
    const tw = ctx.targetWorld?.(c.target as string, (c.subtarget as string) || undefined, (c.head_tail as number) || 0);
    if (tw) ctx.target = toSpace(tw, t.spaces?.target ? (c.target_space ?? 'WORLD') : 'WORLD', targetInfo(ctx.graph, ctx.doc, c, ctx.ob, ctx.pchan), c, ctx, ownerInfo);
  }
  try {
    t.apply(m, c, ctx);
  } catch {
    return;
  }
  if (m.elements.some((x) => !Number.isFinite(x))) return;
  world.copy(fromSpace(m, ownerSpace, ownerInfo, c, ctx));
  if (c.influence < 1) blendMatrices(before, world, c.influence, world);
}

/** Evaluate an object's constraint stack on its world matrix. */
export function solveObjectConstraints(graph: Depsgraph, doc: DocumentData, ob: ObjectData, world: Matrix4, parent: Matrix4 | null, list = ob.constraints) {
  if (!list.length) return;
  const ctx: ConstraintContext = { doc, graph, ob, frame: graph.frame };
  ctx.targetWorld = makeTargetWorld(graph, ob);
  const info: SpaceInfo = { kind: 'OBJECT', parent };
  for (const c of list) solveConstraint(world, c, ctx, info);
}

/** Evaluate the pose constraints of every bone in hierarchy order (children follow their parents). */
export function solveBoneConstraints(graph: Depsgraph, doc: DocumentData, ob: ObjectData, arm: ArmatureData, bones: Map<string, BoneEval>, order: string[], setPose: (name: string, m: Matrix4) => void = (n, m) => applyBonePose(bones, n, m)) {
  if (!ob.pose) return;
  const armWorld = graph.get(ob.id)?.world ?? new Matrix4();
  const armInv = armWorld.clone().invert();
  let ikSolved = false;
  const connected = new Set(arm.bones.filter((b) => b.use_connect && b.parent).map((b) => b.name));
  for (const name of order) {
    const pb = ob.pose[name];
    if (!pb?.constraints.length) continue;
    const pchan: BoneOwner = { name, bones, arm, armWorld };
    const ctx: ConstraintContext = { doc, graph, ob, frame: graph.frame, pchan };
    ctx.targetWorld = makeTargetWorld(graph, ob, pchan);
    const info: SpaceInfo = { kind: 'BONE', armWorld, bones, arm, name };
    for (const c of pb.constraints) {
      if (c.mute || !(c.influence > 0)) continue;
      if (c.type === 'IK') {
        // all IK chains of the armature are solved together (chains sharing bones compromise)
        if (!ikSolved) {
          ikSolved = true;
          solveChains(bones, ob, collectIKChains(graph, ob, arm, bones, armWorld, armInv));
        }
        continue;
      }
      if (c.type === 'SPLINE_IK') {
        solveSplineIK(doc, graph, bones, name, armWorld, c);
        continue;
      }
      const b = bones.get(name);
      if (!b) break;
      const world = armWorld.clone().multiply(b.pose);
      solveConstraint(world, c, ctx, info);
      const pose = armInv.clone().multiply(world);
      // a connected bone's head stays on its parent's tail
      if (connected.has(name)) pose.setPosition(new Vector3().setFromMatrixPosition(b.pose));
      setPose(name, pose);
    }
  }
}

function collectIKChains(graph: Depsgraph, ob: ObjectData, arm: ArmatureData, bones: Map<string, BoneEval>, armWorld: Matrix4, armInv: Matrix4): IKChain[] {
  const out: IKChain[] = [];
  for (const [name, pb] of Object.entries(ob.pose ?? {}))
    for (const c of pb.constraints) {
      if (c.type !== 'IK' || c.mute || !(c.influence > 0)) continue;
      const tw = makeTargetWorld(graph, ob, { name, bones, arm, armWorld });
      const ch = ikChainFor(bones, name, c, armInv, tw);
      if (ch) out.push(ch);
    }
  return out;
}
