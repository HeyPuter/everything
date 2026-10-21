// Keyframe insertion/deletion on object properties.
import type { ActionData, DocumentData, FCurve, ObjectData } from '../data/types';
import { app } from '../app/app';
import { newAction } from '../data/defaults';
import { insertKeyframe, evaluateFCurve, keyframeDefaults } from './fcurve';
import { getValue } from '../data/rna';
import { ensureSlotForKeying, isSlotted, objectCurves, curveSlot } from './slots';

/** The object's action, created (with a slot for the object) when it has none. */
export function ensureAction(doc: DocumentData, ob: ObjectData): ActionData {
  if (!ob.animation_data) ob.animation_data = { action: null, nla_tracks: [], drivers: [] };
  let act = ob.animation_data.action ? doc.actions[ob.animation_data.action] : undefined;
  if (!act) {
    // unique data-block name (CubeAction, CubeAction.001, …)
    const taken = new Set(Object.values(doc.actions).map((a) => a.name));
    let name = `${ob.name}Action`;
    for (let i = 1; taken.has(name); i++) name = `${ob.name}Action.${String(i).padStart(3, '0')}`;
    act = newAction(name);
    doc.actions[act.id] = act;
    ob.animation_data.action = act.id;
  }
  return act;
}

/** The action keys of `ob` go into and the slot handle within it (undefined: unslotted action). */
export function keyingTarget(doc: DocumentData, ob: ObjectData): { act: ActionData; slot: number } {
  const act = ensureAction(doc, ob);
  return { act, slot: ensureSlotForKeying(doc, ob, ob.animation_data!, act).handle };
}

const GROUPS: Record<string, string> = {
  location: 'Object Transforms',
  rotation_euler: 'Object Transforms',
  rotation_quaternion: 'Object Transforms',
  rotation_axis_angle: 'Object Transforms',
  scale: 'Object Transforms',
};

/** The F-Curve for path/index in an action (in `slot` for actions with slots), created if needed. */
export function ensureFCurve(act: ActionData, path: string, index: number, slot?: number): FCurve {
  const inSlot = (f: FCurve) => slot === undefined || !isSlotted(act) || curveSlot(act, f) === slot;
  let fc = act.fcurves.find((f) => f.data_path === path && f.array_index === index && inSlot(f));
  if (!fc) {
    const bone = /^pose\.bones\["([^"]+)"\]/.exec(path);
    fc = {
      data_path: path,
      array_index: index,
      keyframe_points: [],
      extrapolation: 'CONSTANT',
      modifiers: [],
      group: bone ? bone[1] : GROUPS[path] ?? undefined,
      // vector transform channels default to "Auto XYZ to RGB"
      color_mode: !keyframeDefaults.xyzToRgb ? 'AUTO_RAINBOW' : /(^|\.)(location|rotation_euler|rotation_quaternion|rotation_axis_angle|scale|delta_location|delta_rotation_euler|delta_scale)$/.test(path) ? (/rotation_(quaternion|axis_angle)$/.test(path) ? 'AUTO_YRGB' : 'AUTO_RGB') : 'AUTO_RAINBOW',
    };
    if (slot !== undefined && isSlotted(act)) fc.slot = slot;
    act.fcurves.push(fc);
  }
  return fc;
}

/** With "Only Insert Needed", a key is skipped when the curve already has that value there. */
function needed(act: ActionData, slot: number, path: string, index: number, frame: number, value: number) {
  if (!keyframeDefaults.insertNeeded) return true;
  const fc = act.fcurves.find((f) => f.data_path === path && f.array_index === index && (!isSlotted(act) || curveSlot(act, f) === slot));
  if (!fc || !fc.keyframe_points.length) return true;
  return Math.abs(evaluateFCurve(fc, frame) - value) > 1e-6 * Math.max(1, Math.abs(value));
}

/** The curve keys go into; the property was just read, so a disabled curve works again. */
function liveCurve(act: ActionData, path: string, index: number, slot: number) {
  const n = act.fcurves.length;
  const fc = ensureFCurve(act, path, index, slot);
  if (fc.disabled) delete fc.disabled;
  // curves made by keying start selected (the Graph Editor shows the first one as active)
  if (act.fcurves.length > n) fc.select = true;
  return fc;
}

/** Insert keyframes for a property path (all array elements when index = -1). */
export function keyProperty(doc: DocumentData, ob: ObjectData, path: string, index = -1, frame = doc.scene.frame_current) {
  const val = getValue(doc, ob, path);
  const { act, slot } = keyingTarget(doc, ob);
  const type = doc.scene.tool_settings.keyframe_type;
  if (Array.isArray(val) || ArrayBuffer.isView(val)) {
    const arr = val as ArrayLike<number>;
    for (let i = 0; i < arr.length; i++) if ((index < 0 || i === index) && needed(act, slot, path, i, frame, Number(arr[i]))) insertKeyframe(liveCurve(act, path, i, slot), frame, Number(arr[i]), { type });
  } else if ((typeof val === 'number' || typeof val === 'boolean') && needed(act, slot, path, 0, frame, Number(val))) insertKeyframe(liveCurve(act, path, 0, slot), frame, Number(val), { type, interpolation: typeof val === 'boolean' ? 'CONSTANT' : keyframeDefaults.interpolation });
}

export function rotationPath(ob: { rotation_mode: string }) {
  return ob.rotation_mode === 'QUATERNION' ? 'rotation_quaternion' : ob.rotation_mode === 'AXIS_ANGLE' ? 'rotation_axis_angle' : 'rotation_euler';
}

export type KeyingSet = 'Location' | 'Rotation' | 'Scale' | 'LocRotScale' | 'LocRot' | 'LocScale' | 'RotScale' | 'Available' | 'WholeCharacter' | 'BUILTIN_KSI_VisualLocRot' | `KS:${string}`;

/** Insert keys for every path of a user keying set; returns the number of paths keyed. */
export function insertUserKeyingSet(doc: DocumentData, name: string): number {
  const set = doc.scene.keying_sets?.find((k) => k.name === name);
  let n = 0;
  for (const p of set?.paths ?? []) {
    const ob = p.id ? doc.objects[p.id] : undefined;
    if (!ob || !p.data_path) continue;
    keyProperty(doc, ob, p.data_path, p.index);
    n++;
  }
  return n;
}

export function insertKeyframesForObjects(objects: ObjectData[], ks: KeyingSet = 'LocRotScale') {
  const doc = app.doc;
  if (ks.startsWith('KS:')) {
    insertUserKeyingSet(doc, ks.slice(3));
    return;
  }
  for (const ob of objects) {
    if (doc.mode === 'POSE' && ob.type === 'ARMATURE' && ob.pose) {
      insertBoneKeys(doc, ob, ks);
      continue;
    }
    const paths: string[] = [];
    if (ks === 'Available') {
      {
        const seen = new Set<string>();
        for (const fc of [...objectCurves(doc, ob)]) {
          const k = `${fc.data_path}|${fc.array_index}`;
          if (seen.has(k)) continue;
          seen.add(k);
          keyProperty(doc, ob, fc.data_path, fc.array_index);
        }
      }
      continue;
    }
    if (ks.includes('Loc') || ks === 'Location') paths.push('location');
    if (ks.includes('Rot') || ks === 'Rotation') paths.push(rotationPath(ob));
    if (ks.includes('Scale')) paths.push('scale');
    for (const p of paths) keyProperty(doc, ob, p);
  }
}

function insertBoneKeys(doc: DocumentData, ob: ObjectData, ks: KeyingSet) {
  const arm = ob.data ? doc.armatures[ob.data] : undefined;
  if (!arm || !ob.pose) return;
  const selected = Object.entries(ob.pose).filter(([, pb]) => pb.select);
  const bones = selected.length ? selected : arm.active_bone && ob.pose[arm.active_bone] ? [[arm.active_bone, ob.pose[arm.active_bone]] as const] : [];
  for (const [name, pb] of bones) {
    const base = `pose.bones["${name}"]`;
    if (ks.includes('Loc') || ks === 'Location' || ks === 'WholeCharacter') keyProperty(doc, ob, `${base}.location`);
    if (ks.includes('Rot') || ks === 'Rotation' || ks === 'WholeCharacter') keyProperty(doc, ob, `${base}.${rotationPath(pb)}`);
    if (ks.includes('Scale') || ks === 'WholeCharacter') keyProperty(doc, ob, `${base}.scale`);
  }
}

/** Remove keyframes at the current frame for the given objects. */
export function deleteKeyframesAt(objects: ObjectData[], frame: number) {
  const doc = app.doc;
  let n = 0;
  for (const ob of objects) {
    const act = ob.animation_data?.action ? doc.actions[ob.animation_data.action] : undefined;
    if (!act) continue;
    const mine = new Set(objectCurves(doc, ob));
    for (const fc of mine) {
      const before = fc.keyframe_points.length;
      fc.keyframe_points = fc.keyframe_points.filter((k) => Math.abs(k.co[0] - frame) > 0.5);
      n += before - fc.keyframe_points.length;
    }
    act.fcurves = act.fcurves.filter((f) => !mine.has(f) || f.keyframe_points.length || f.sampled_points?.length);
  }
  return n;
}

/** Keyframe state of a property for UI decorators. */
export function keyState(doc: DocumentData, ob: ObjectData | null | undefined, path: string, index = -1): 'none' | 'keyed' | 'animated' | 'driven' {
  if (!ob?.animation_data) return 'none';
  if (ob.animation_data.drivers.some((d) => d.data_path === path && (index < 0 || d.array_index === index))) return 'driven';
  const fcs = objectCurves(doc, ob).filter((f) => f.data_path === path && (index < 0 || f.array_index === index));
  if (!fcs.length) return 'none';
  const frame = doc.scene.frame_current;
  return fcs.some((f) => f.keyframe_points.some((k) => Math.abs(k.co[0] - frame) < 0.5)) ? 'keyed' : 'animated';
}

/** All keyframe frames for objects (for timeline/dope sheet summary). */
export function keyframeFrames(doc: DocumentData, objects: ObjectData[]): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const ob of objects) {
    for (const fc of objectCurves(doc, ob))
      for (const k of fc.keyframe_points) {
        const f = Math.round(k.co[0] * 100) / 100;
        out.set(f, (out.get(f) ?? false) || !!k.select_control_point);
      }
  }
  return out;
}
