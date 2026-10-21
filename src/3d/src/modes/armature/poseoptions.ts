// Pose Options: X-Axis Mirror (transforming a bone gives its opposite-side twin the mirrored
// values, optionally relative to the twin's own pose) and Auto IK (grabbing a bone that is
// connected to its parent bends the connected chain so the bone's tail follows the pointer).
import { Matrix4, Quaternion, Vector3 } from 'three';
import { h, type Child } from '../../ui/h';
import { app } from '../../app/app';
import { checkbox } from '../../ui/widgets';
import type { ArmatureData, ObjectData, PoseBone, Vec3, Vec4 } from '../../data/types';
import type { BoneEval } from '../../eval/armature';
import { rotationQuaternion as rotQ, setRotationFromQuaternion, poseBoneMatrix } from '../../eval/transform';
import { solveChains } from '../../eval/ik';
import { toolOptionSections } from '../../editors/view3d/tooloptions';
import { flipSideName } from './posemath';

export interface PoseOptions {
  use_mirror_x?: boolean;
  use_mirror_relative?: boolean;
  use_auto_ik?: boolean;
}

/** The pose-level options of an armature object (created on demand). */
export function poseOptions(ob: ObjectData): PoseOptions {
  const o = ob as ObjectData & { pose_options?: PoseOptions };
  return (o.pose_options ??= {});
}

// ---------------------------------------------------------------------------
// X-Axis Mirror

const rotationQuaternion = (pb: PoseBone) => rotQ(pb.rotation_mode, pb.rotation_euler, pb.rotation_quaternion, pb.rotation_axis_angle, new Quaternion());
const mirrorLoc = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];
const mirrorQuat = (q: Quaternion) => new Quaternion(q.x, -q.y, -q.z, q.w);

/** Copy a bone's transform onto its twin, mirrored across the armature's X axis. */
export function mirrorPose(src: PoseBone, dst: PoseBone) {
  dst.location = mirrorLoc(src.location);
  dst.scale = [...src.scale] as Vec3;
  dst.rotation_euler = [src.rotation_euler[0], -src.rotation_euler[1], -src.rotation_euler[2]];
  dst.rotation_quaternion = [src.rotation_quaternion[0], src.rotation_quaternion[1], -src.rotation_quaternion[2], -src.rotation_quaternion[3]] as Vec4;
  dst.rotation_axis_angle = [src.rotation_axis_angle[0], src.rotation_axis_angle[1], -src.rotation_axis_angle[2], -src.rotation_axis_angle[3]] as Vec4;
  if (dst.rotation_mode !== src.rotation_mode) setRotationFromQuaternion(dst, mirrorQuat(rotationQuaternion(src)));
}

/** Relative mirror: the twin keeps its own pose and receives the mirrored change of the source. */
export function mirrorPoseRelative(before: PoseBone, now: PoseBone, twinBefore: PoseBone, dst: PoseBone) {
  dst.location = twinBefore.location.map((v, i) => v + mirrorLoc(now.location)[i] - mirrorLoc(before.location)[i]) as Vec3;
  dst.scale = twinBefore.scale.map((v, i) => v * (Math.abs(before.scale[i]) > 1e-12 ? now.scale[i] / before.scale[i] : 1)) as Vec3;
  const delta = rotationQuaternion(now).multiply(rotationQuaternion(before).invert());
  dst.rotation_euler = [...twinBefore.rotation_euler] as Vec3;
  setRotationFromQuaternion(dst, mirrorQuat(delta).multiply(rotationQuaternion(twinBefore)));
}

/** The opposite-side bone of `name` when X-Axis Mirror applies to it. */
export function mirrorTwin(ob: ObjectData, name: string, selected: Set<string>): string | null {
  if (!poseOptions(ob).use_mirror_x || !ob.pose) return null;
  const twin = flipSideName(name);
  return twin !== name && ob.pose[twin] && !selected.has(twin) ? twin : null;
}

// ---------------------------------------------------------------------------
// Auto IK

/** Bones bent when grabbing `name` with Auto IK: the bone and its connected parents, up to and including the first unconnected one. */
export function autoIKChain(arm: ArmatureData, name: string): string[] {
  const byName = new Map(arm.bones.map((b) => [b.name, b]));
  const first = byName.get(name);
  if (!first?.parent || !first.use_connect) return [];
  const out: string[] = [];
  let cur: typeof first | undefined = first;
  while (cur) {
    out.push(cur.name);
    if (!cur.use_connect || !cur.parent) break;
    cur = byName.get(cur.parent);
  }
  return out;
}

const cloneBones = (bones: Map<string, BoneEval>) => new Map([...bones].map(([n, b]) => [n, { ...b, pose: b.pose.clone() }]));

/**
 * Bend `chain` (tip first) so the tip's tail reaches `target` (armature space), starting from the
 * evaluated pose `start`; returns the new local rotation of each chain bone.
 */
export function solveAutoIK(ob: ObjectData, start: Map<string, BoneEval>, chain: string[], target: Vector3): Map<string, Quaternion> {
  const bones = cloneBones(start);
  solveChains(bones, ob, [{ owner: chain[0], bones: chain, useTail: true, target, targetRot: null, pole: null, poleAngle: 0, weight: 1, orientWeight: 1, influence: 1, iterations: 500, stretch: false }]);
  const out = new Map<string, Quaternion>();
  // parent spaces follow the solved parents (root first)
  const parentSpaceOld = (n: string) => start.get(n)!.pose.clone().multiply(poseBoneMatrix(ob.pose![n], new Matrix4()).invert());
  for (const n of [...chain].reverse()) {
    const be = bones.get(n)!;
    let ps = parentSpaceOld(n);
    const parent = be.parent && chain.includes(be.parent) ? be.parent : null;
    if (parent) ps = bones.get(parent)!.pose.clone().multiply(start.get(parent)!.pose.clone().invert()).multiply(ps);
    const local = ps.invert().multiply(be.pose);
    const q = new Quaternion();
    local.decompose(new Vector3(), q, new Vector3());
    out.set(n, q.normalize());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool settings: Options ▸ Pose Options

toolOptionSections.push((idp: string): Child => {
  const ob = app.activeObject;
  if (app.doc.mode !== 'POSE' || ob?.type !== 'ARMATURE') return null;
  const o = poseOptions(ob);
  const set = (key: keyof PoseOptions, label: string) => (v: boolean) => {
    o[key] = v;
    app.pushUndo(label);
    app.changed('ui');
  };
  return h(
    'div',
    { class: 'pose-options' },
    h('div', { class: 'opt-head' }, 'Pose Options'),
    h(
      'div',
      { class: 'opt-split' },
      h('span', { class: 'opt-label' }),
      h(
        'div',
        { class: 'opt-col' },
        checkbox(`${idp}-pose-autoik`, 'Auto IK', !!o.use_auto_ik, set('use_auto_ik', 'Auto IK'), { tip: 'Auto IK\nGrabbing a bone connected to its parent bends the connected chain so its tip follows' }),
        checkbox(`${idp}-pose-mirror`, 'X-Axis Mirror', !!o.use_mirror_x, set('use_mirror_x', 'X-Axis Mirror'), { tip: 'X-Axis Mirror\nTransforming a bone also gives its opposite-side bone (.L / .R) the mirrored transform' }),
        o.use_mirror_x ? checkbox(`${idp}-pose-mirror-rel`, 'Relative Mirror', !!o.use_mirror_relative, set('use_mirror_relative', 'Relative Mirror'), { tip: 'Relative Mirror\nThe opposite-side bone keeps its own pose and receives the mirrored change' }) : null,
      ),
    ),
  );
});
