// Biovision Hierarchy (.bvh) motion capture: parser, import as an animated armature (or a
// hierarchy of empties) and export of an armature's animation.
//
// BVH semantics: a joint's rotation channels compose in the order they are listed
// (Zrotation Xrotation Yrotation → Rz·Rx·Ry, which is three.js Euler order 'ZXY'), angles are in
// degrees, position channels hold the joint's full translation in its parent's frame (the root's
// replaces its OFFSET), and OFFSETs place each joint relative to its parent in the rest pose.
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { ActionData, ArmatureData, Bone, DocumentData, FCurve, ObjectData, RotationMode, Vec3 } from '../../data/types';
import { newAction, newArmature, newObject } from '../../data/defaults';
import { newKeyframe, calcHandles } from '../../anim/fcurve';
import { boneRestMatrix, defaultPoseBone, sortedBones, evaluatePose } from '../../eval/armature';
import { compatibleEuler, threeOrder } from '../../eval/transform';
import type { Depsgraph } from '../../eval/depsgraph';
import { axisConversion, basisMatrix, defaultCollection, uniqueName, type AxisId } from './common';

export interface BvhJoint {
  name: string;
  offset: [number, number, number];
  channels: string[];
  /** index of the joint's first channel in a motion line */
  channelOffset: number;
  parent: BvhJoint | null;
  children: BvhJoint[];
  /** End Site offset */
  end: [number, number, number] | null;
}

export interface Bvh {
  roots: BvhJoint[];
  /** depth-first order */
  joints: BvhJoint[];
  frameTime: number;
  motion: Float64Array[];
}

const VALID_CHANNELS = new Set(['Xposition', 'Yposition', 'Zposition', 'Xrotation', 'Yrotation', 'Zrotation']);

export function parseBvh(text: string): Bvh {
  const tokens = text.split(/\s+/).filter(Boolean);
  let p = 0;
  const next = () => {
    if (p >= tokens.length) throw new Error('Unexpected end of the BVH file');
    return tokens[p++];
  };
  const expect = (t: string) => {
    const got = next();
    if (got.toUpperCase() !== t.toUpperCase()) throw new Error(`BVH: expected "${t}", found "${got}"`);
  };
  const num = () => {
    const v = Number(next());
    if (!Number.isFinite(v)) throw new Error(`BVH: expected a number near token ${p}`);
    return v;
  };
  expect('HIERARCHY');
  const roots: BvhJoint[] = [];
  const joints: BvhJoint[] = [];
  let channelCount = 0;
  const parseJoint = (parent: BvhJoint | null): BvhJoint => {
    const name = next();
    expect('{');
    const j: BvhJoint = { name, offset: [0, 0, 0], channels: [], channelOffset: channelCount, parent, children: [], end: null };
    joints.push(j);
    for (;;) {
      const t = next();
      const u = t.toUpperCase();
      if (u === 'OFFSET') j.offset = [num(), num(), num()];
      else if (u === 'CHANNELS') {
        const n = num();
        j.channelOffset = channelCount;
        for (let i = 0; i < n; i++) {
          const c = next();
          if (!VALID_CHANNELS.has(c)) throw new Error(`BVH: unknown channel "${c}"`);
          j.channels.push(c);
        }
        channelCount += n;
      } else if (u === 'JOINT') j.children.push(parseJoint(j));
      else if (u === 'END') {
        expect('Site');
        expect('{');
        expect('OFFSET');
        j.end = [num(), num(), num()];
        expect('}');
      } else if (t === '}') break;
      else throw new Error(`BVH: unexpected "${t}"`);
    }
    return j;
  };
  for (;;) {
    const t = next();
    if (t.toUpperCase() === 'ROOT') roots.push(parseJoint(null));
    else if (t.toUpperCase() === 'MOTION') break;
    else throw new Error(`BVH: unexpected "${t}"`);
  }
  if (!roots.length) throw new Error('BVH: no ROOT joint');
  expect('Frames:');
  const frames = Math.max(0, Math.floor(num()));
  expect('Frame');
  expect('Time:');
  const frameTime = num();
  const motion: Float64Array[] = [];
  for (let f = 0; f < frames && p < tokens.length; f++) {
    const row = new Float64Array(channelCount);
    for (let c = 0; c < channelCount; c++) row[c] = p < tokens.length ? Number(tokens[p++]) || 0 : 0;
    motion.push(row);
  }
  return { roots, joints, frameTime: frameTime > 0 ? frameTime : 1 / 30, motion };
}

/** Rotation letters of a joint in channel order ('ZXY'), or null without rotation channels. */
export function rotationOrder(j: BvhJoint): string | null {
  const s = j.channels
    .filter((c) => c.endsWith('rotation'))
    .map((c) => c[0])
    .join('');
  return s.length === 3 && new Set(s).size === 3 ? s : null;
}

/** World (source space) rotation and position of every joint at motion frame `f`. */
export function jointWorld(bvh: Bvh, f: number): Map<BvhJoint, { q: Quaternion; p: Vector3; local: Matrix4 }> {
  const row = bvh.motion[f] ?? new Float64Array(0);
  const out = new Map<BvhJoint, { q: Quaternion; p: Vector3; local: Matrix4 }>();
  const D = Math.PI / 180;
  for (const j of bvh.joints) {
    const t = new Vector3(...j.offset);
    let q = new Quaternion();
    // rotations compose in listed order (left to right)
    j.channels.forEach((c, i) => {
      const v = row[j.channelOffset + i] ?? 0;
      if (c === 'Xposition') t.x = v;
      else if (c === 'Yposition') t.y = v;
      else if (c === 'Zposition') t.z = v;
      else {
        const axis = c[0] === 'X' ? new Vector3(1, 0, 0) : c[0] === 'Y' ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
        q = q.multiply(new Quaternion().setFromAxisAngle(axis, v * D));
      }
    });
    const local = new Matrix4().compose(t, q, new Vector3(1, 1, 1));
    const par = j.parent ? out.get(j.parent)! : null;
    const p = par ? t.clone().applyQuaternion(par.q).add(par.p) : t.clone();
    out.set(j, { q: par ? par.q.clone().multiply(q) : q, p, local });
  }
  return out;
}

export interface BvhImportOptions {
  target?: 'ARMATURE' | 'OBJECT';
  scale?: number;
  frameStart?: number;
  /** stretch frames so the motion keeps its speed at the scene frame rate */
  useFpsScale?: boolean;
  sceneFps?: number;
  /** 'NATIVE' (the file's order per joint), 'QUATERNION' or an Euler order */
  rotateMode?: 'NATIVE' | RotationMode;
  forward?: AxisId;
  up?: AxisId;
  cyclic?: boolean;
  name?: string;
}

function fcurve(path: string, index: number, group: string): FCurve {
  return { data_path: path, array_index: index, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], group, color_mode: 'AUTO_RAINBOW' };
}

const addKey = (fc: FCurve, frame: number, v: number) => fc.keyframe_points.push(newKeyframe(frame, Math.abs(v) < 1e-10 ? 0 : v, 'LINEAR'));

function linkObject(doc: DocumentData, ob: ObjectData) {
  const col = defaultCollection(doc);
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[col].objects.push(ob.id);
}

/** Import parsed motion into the document; returns the created objects (the first is the top one). */
export function importBvh(doc: DocumentData, bvh: Bvh, o: BvhImportOptions = {}): { objects: ObjectData[]; frameEnd: number; warnings: string[] } {
  const warnings: string[] = [];
  const axis = axisConversion(o.forward ?? '-Z', o.up ?? 'Y');
  if (!axis) throw new Error('Forward and Up axes must be different');
  const s = o.scale ?? 1;
  const A = basisMatrix(axis);
  const Ainv = A.clone().invert();
  const toDoc = (v: Vector3) => v.clone().applyMatrix4(A).multiplyScalar(s);
  const rotDoc = (q: Quaternion) => {
    const m = new Matrix4().makeRotationFromQuaternion(q);
    return new Quaternion().setFromRotationMatrix(A.clone().multiply(m).multiply(Ainv));
  };
  const start = o.frameStart ?? 1;
  const step = o.useFpsScale && o.sceneFps ? bvh.frameTime * o.sceneFps : 1;
  const frameOf = (i: number) => start + i * step;
  const frames = bvh.motion.length;
  const name = o.name || 'BVH';
  const curvesFor = (base: string, j: BvhJoint, mode: RotationMode, group: string) => {
    const hasPos = j.channels.some((c) => c.endsWith('position'));
    return {
      loc: hasPos ? [0, 1, 2].map((i) => fcurve(`${base}location`, i, group)) : [],
      rot: mode === 'QUATERNION' ? [0, 1, 2, 3].map((i) => fcurve(`${base}rotation_quaternion`, i, group)) : [0, 1, 2].map((i) => fcurve(`${base}rotation_euler`, i, group)),
    };
  };
  const modeOf = (j: BvhJoint): RotationMode => {
    if (o.rotateMode && o.rotateMode !== 'NATIVE') return o.rotateMode;
    return (rotationOrder(j) as RotationMode | null) ?? 'XYZ';
  };
  const worlds = Array.from({ length: frames }, (_, f) => jointWorld(bvh, f));
  const finish = (ob: ObjectData, fcurves: FCurve[]) => {
    for (const fc of fcurves) {
      if (o.cyclic) fc.modifiers.push({ type: 'CYCLES', mode_before: 'REPEAT', mode_after: 'REPEAT' } as never);
      calcHandles(fc);
    }
    if (!fcurves.length) return;
    const act: ActionData = newAction(uniqueName(doc, name, 'actions'));
    act.fcurves = fcurves;
    doc.actions[act.id] = act;
    ob.animation_data = { action: act.id, nla_tracks: [], drivers: [] };
  };

  if (o.target === 'OBJECT') {
    const objects: ObjectData[] = [];
    const byJoint = new Map<BvhJoint, ObjectData>();
    for (const j of bvh.joints) {
      const ob = newObject(uniqueName(doc, j.name, 'objects'), 'EMPTY', null);
      ob.empty_display_size = 0.1 * s;
      const mode = modeOf(j);
      ob.rotation_mode = mode;
      if (j.parent) ob.parent = byJoint.get(j.parent)!.id;
      const off = toDoc(new Vector3(...j.offset));
      ob.location = [off.x, off.y, off.z];
      linkObject(doc, ob);
      byJoint.set(j, ob);
      objects.push(ob);
      const c = curvesFor('', j, mode, 'Object Transforms');
      let prev: Vec3 | null = null;
      worlds.forEach((w, f) => {
        const l = w.get(j)!.local;
        const t = new Vector3(),
          q = new Quaternion(),
          sc = new Vector3();
        l.decompose(t, q, sc);
        const td = toDoc(t),
          qd = rotDoc(q);
        c.loc.forEach((fc, i) => addKey(fc, frameOf(f), [td.x, td.y, td.z][i]));
        if (mode === 'QUATERNION') [qd.w, qd.x, qd.y, qd.z].forEach((v, i) => addKey(c.rot[i], frameOf(f), v));
        else {
          const e = new Euler().setFromQuaternion(qd, threeOrder(mode));
          let v: Vec3 = [e.x, e.y, e.z];
          if (prev) v = compatibleEuler(v, prev);
          prev = v;
          v.forEach((x, i) => addKey(c.rot[i], frameOf(f), x));
        }
      });
      // each empty gets its own action
      finish(ob, [...c.loc, ...c.rot]);
    }
    return { objects, frameEnd: frameOf(Math.max(0, frames - 1)), warnings };
  }

  // ---- armature
  const arm: ArmatureData = newArmature(uniqueName(doc, name, 'armatures'));
  doc.armatures[arm.id] = arm;
  const ob = newObject(uniqueName(doc, name, 'objects'), 'ARMATURE', arm.id);
  ob.pose = {};
  const heads = new Map<BvhJoint, Vector3>();
  for (const j of bvh.joints) {
    const off = new Vector3(...j.offset);
    heads.set(j, j.parent ? heads.get(j.parent)!.clone().add(off) : off);
  }
  const headDoc = (j: BvhJoint) => toDoc(heads.get(j)!);
  const names = new Map<BvhJoint, string>();
  const taken = new Set<string>();
  for (const j of bvh.joints) {
    let n = j.name || 'Bone';
    for (let i = 1; taken.has(n); i++) n = `${j.name}.${String(i).padStart(3, '0')}`;
    taken.add(n);
    names.set(j, n);
  }
  for (const j of bvh.joints) {
    const head = headDoc(j);
    let tail: Vector3;
    if (j.children.length) {
      tail = new Vector3();
      for (const c of j.children) tail.add(headDoc(c));
      tail.multiplyScalar(1 / j.children.length);
    } else if (j.end) tail = head.clone().add(toDoc(new Vector3(...j.end)));
    else if (j.parent) {
      const dir = head.clone().sub(headDoc(j.parent));
      tail = head.clone().add(dir.lengthSq() > 1e-12 ? dir.multiplyScalar(0.5) : new Vector3(0, 0, 0.1 * s));
    } else tail = head.clone().add(new Vector3(0, 0, 0.1 * s));
    // bones need a length: nudge zero-length ones along the parent's direction (or up)
    if (tail.distanceTo(head) < 1e-6 * Math.max(1, s)) {
      const pd = j.parent ? head.clone().sub(headDoc(j.parent)) : new Vector3();
      tail = head.clone().add(pd.lengthSq() > 1e-12 ? pd.normalize().multiplyScalar(0.05 * s) : new Vector3(0, 0, 0.05 * s));
    }
    const b: Bone = {
      name: names.get(j)!,
      parent: j.parent ? names.get(j.parent)! : null,
      head: [head.x, head.y, head.z],
      tail: [tail.x, tail.y, tail.z],
      roll: 0,
      use_connect: false,
      use_deform: true,
      use_inherit_rotation: true,
      inherit_scale: 'FULL',
      envelope_distance: 0.25,
      head_radius: 0.1,
      tail_radius: 0.05,
      bbone_segments: 1,
    };
    arm.bones.push(b);
    const pb = defaultPoseBone();
    pb.rotation_mode = modeOf(j);
    ob.pose[b.name] = pb;
  }
  const rest = new Map<BvhJoint, Matrix4>();
  const restRot = new Map<BvhJoint, Quaternion>();
  for (const j of bvh.joints) {
    const m = boneRestMatrix(arm.bones.find((b) => b.name === names.get(j))!);
    rest.set(j, m);
    restRot.set(j, new Quaternion().setFromRotationMatrix(m));
  }
  const curves = new Map(bvh.joints.map((j) => [j, curvesFor(`pose.bones["${names.get(j)}"].`, j, modeOf(j), names.get(j)!)]));
  const prevEuler = new Map<BvhJoint, Vec3>();
  worlds.forEach((w, f) => {
    const pose = new Map<BvhJoint, Matrix4>();
    for (const j of bvh.joints) {
      const jw = w.get(j)!;
      const m = new Matrix4().compose(toDoc(jw.p), rotDoc(jw.q).multiply(restRot.get(j)!), new Vector3(1, 1, 1));
      pose.set(j, m);
      const parentFrame = j.parent ? pose.get(j.parent)!.clone().multiply(rest.get(j.parent)!.clone().invert()).multiply(rest.get(j)!) : rest.get(j)!.clone();
      const basis = parentFrame.invert().multiply(m);
      const t = new Vector3(),
        q = new Quaternion(),
        sc = new Vector3();
      basis.decompose(t, q, sc);
      const c = curves.get(j)!;
      c.loc.forEach((fc, i) => addKey(fc, frameOf(f), [t.x, t.y, t.z][i]));
      const mode = modeOf(j);
      if (mode === 'QUATERNION') [q.w, q.x, q.y, q.z].forEach((v, i) => addKey(c.rot[i], frameOf(f), v));
      else {
        const e = new Euler().setFromQuaternion(q, threeOrder(mode));
        let v: Vec3 = [e.x, e.y, e.z];
        const prev = prevEuler.get(j);
        if (prev) v = compatibleEuler(v, prev);
        prevEuler.set(j, v);
        v.forEach((x, i) => addKey(c.rot[i], frameOf(f), x));
      }
      if (f === 0) {
        const pb = ob.pose![names.get(j)!];
        pb.location = [t.x, t.y, t.z];
        pb.rotation_quaternion = [q.w, q.x, q.y, q.z];
        if (mode !== 'QUATERNION') pb.rotation_euler = prevEuler.get(j)!;
      }
    }
  });
  linkObject(doc, ob);
  finish(
    ob,
    [...curves.values()].flatMap((c) => [...c.loc, ...c.rot]),
  );
  if (!frames) warnings.push('The file has no motion frames');
  return { objects: [ob], frameEnd: frameOf(Math.max(0, frames - 1)), warnings };
}

// ---------------------------------------------------------------------------
// export

export interface BvhExportOptions {
  frameStart: number;
  frameEnd: number;
  scale?: number;
  /** 'NATIVE' uses each bone's Euler order (XYZ for quaternions) */
  rotateMode?: 'NATIVE' | Exclude<RotationMode, 'QUATERNION' | 'AXIS_ANGLE'>;
  rootTransformOnly?: boolean;
  sortChildrenByName?: boolean;
  fps: number;
}

const f6 = (v: number) => {
  const r = v.toFixed(6);
  return r === '-0.000000' ? '0.000000' : r;
};

/**
 * Write an armature's animation. `poseAt(frame)` returns armature-space pose matrices per bone
 * (the caller evaluates the scene); offsets are armature-space rest positions.
 */
export function writeBvh(arm: ArmatureData, poseAt: (frame: number) => Map<string, Matrix4>, modeOfBone: (name: string) => RotationMode, o: BvhExportOptions): string {
  const s = o.scale ?? 1;
  const bones = sortedBones(arm);
  const byName = new Map(bones.map((b) => [b.name, b]));
  const kids = new Map<string | null, Bone[]>();
  for (const b of bones) {
    const p = b.parent && byName.has(b.parent) ? b.parent : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(b);
  }
  if (o.sortChildrenByName) for (const l of kids.values()) l.sort((a, b) => a.name.localeCompare(b.name));
  const order: Bone[] = [];
  const letters = new Map<string, string>();
  const hasPos = new Map<string, boolean>();
  const lines: string[] = ['HIERARCHY'];
  const restRot = new Map<string, Quaternion>();
  for (const b of bones) restRot.set(b.name, new Quaternion().setFromRotationMatrix(boneRestMatrix(b)));
  const write = (b: Bone, depth: number) => {
    order.push(b);
    const ind = '\t'.repeat(depth);
    const root = !b.parent || !byName.has(b.parent);
    const head = new Vector3(...b.head);
    const off = root ? head : head.clone().sub(new Vector3(...byName.get(b.parent!)!.head));
    let mode: string = o.rotateMode && o.rotateMode !== 'NATIVE' ? o.rotateMode : modeOfBone(b.name);
    if (mode === 'QUATERNION' || mode === 'AXIS_ANGLE') mode = 'XYZ';
    letters.set(b.name, mode);
    const pos = root || (!o.rootTransformOnly && !b.use_connect);
    hasPos.set(b.name, pos);
    lines.push(`${ind}${root ? 'ROOT' : 'JOINT'} ${b.name.replace(/\s+/g, '_')}`, `${ind}{`);
    lines.push(`${ind}\tOFFSET ${f6(off.x * s)} ${f6(off.y * s)} ${f6(off.z * s)}`);
    const rot = mode.split('').map((c) => `${c}rotation`);
    lines.push(`${ind}\tCHANNELS ${pos ? 6 : 3} ${pos ? 'Xposition Yposition Zposition ' : ''}${rot.join(' ')}`);
    const children = kids.get(b.name) ?? [];
    if (children.length) for (const c of children) write(c, depth + 1);
    else {
      const t = new Vector3(...b.tail).sub(head);
      lines.push(`${ind}\tEnd Site`, `${ind}\t{`, `${ind}\t\tOFFSET ${f6(t.x * s)} ${f6(t.y * s)} ${f6(t.z * s)}`, `${ind}\t}`);
    }
    lines.push(`${ind}}`);
  };
  for (const r of kids.get(null) ?? []) write(r, 0);
  const n = Math.max(1, Math.round(o.frameEnd) - Math.round(o.frameStart) + 1);
  lines.push('MOTION', `Frames: ${n}`, `Frame Time: ${f6(1 / (o.fps || 24))}`);
  const prev = new Map<string, Vec3>();
  for (let i = 0; i < n; i++) {
    const pose = poseAt(Math.round(o.frameStart) + i);
    const world = new Map<string, { q: Quaternion; p: Vector3 }>();
    const vals: string[] = [];
    for (const b of order) {
      const m = pose.get(b.name) ?? boneRestMatrix(b);
      const p = new Vector3(),
        q = new Quaternion(),
        sc = new Vector3();
      m.decompose(p, q, sc);
      // joint rotation = pose orientation relative to the rest orientation (axis aligned in the rest pose)
      const qw = q.clone().multiply(restRot.get(b.name)!.clone().invert());
      world.set(b.name, { q: qw, p });
      const par = b.parent ? world.get(b.parent) : undefined;
      const ql = par ? par.q.clone().invert().multiply(qw) : qw;
      if (hasPos.get(b.name)) {
        const t = par ? p.clone().sub(par.p).applyQuaternion(par.q.clone().invert()) : p;
        vals.push(f6(t.x * s), f6(t.y * s), f6(t.z * s));
      }
      const order3 = letters.get(b.name)!;
      const e = new Euler().setFromQuaternion(ql, order3 as Euler['order']);
      let v: Vec3 = [e.x, e.y, e.z];
      const pv = prev.get(b.name);
      if (pv) v = compatibleEuler(v, pv);
      prev.set(b.name, v);
      const byAxis: Record<string, number> = { X: v[0], Y: v[1], Z: v[2] };
      for (const c of order3) vals.push(f6((byAxis[c] * 180) / Math.PI));
    }
    lines.push(`${vals.join(' ')} `);
  }
  return `${lines.join('\n')}\n`;
}

/** Armature-space pose matrices of an armature object at a frame (evaluates `graph`). */
export function armaturePoseAt(doc: DocumentData, graph: Depsgraph, ob: ObjectData, frame: number): Map<string, Matrix4> {
  doc.scene.frame_current = frame;
  doc.scene.frame_subframe = 0;
  graph.evaluate(doc);
  const arm = doc.armatures[ob.data!];
  const ev = graph.get(ob.id)?.pose ?? evaluatePose(doc, ob, arm, graph);
  const out = new Map<string, Matrix4>();
  for (const [name, b] of ev.bones) out.set(name, b.pose.clone());
  return out;
}
