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
    if (keyframeDefaults.smoothing !== 'NONE') fc.auto_smoothing = keyframeDefaults.smoothing;
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
  if (keyframeDefaults.replaceOnly) return replaceKeys(doc, ob, path, index, frame);
  const val = getValue(doc, ob, path);
  const { act, slot } = keyingTarget(doc, ob);
  const type = doc.scene.tool_settings.keyframe_type;
  const cycleAware = keyingContext.cycleAware && !!doc.scene.tool_settings.use_keyframe_cycle_aware;
  const put = (i: number, v: number, opts: Parameters<typeof insertKeyframe>[3]) => {
    const existing = act.fcurves.find((f) => f.data_path === path && f.array_index === i && (!isSlotted(act) || curveSlot(act, f) === slot));
    const frames = cycleAware && existing ? cycleFrames(existing, frame) : [frame];
    if (!needed(act, slot, path, i, frames[0], v)) return;
    const fc = liveCurve(act, path, i, slot);
    for (const f of frames) insertKeyframe(fc, f, v, opts);
  };
  if (Array.isArray(val) || ArrayBuffer.isView(val)) {
    const arr = val as ArrayLike<number>;
    for (let i = 0; i < arr.length; i++) if (index < 0 || i === index) put(i, Number(arr[i]), { type });
  } else if (typeof val === 'number' || typeof val === 'boolean') put(0, Number(val), { type, interpolation: typeof val === 'boolean' ? 'CONSTANT' : keyframeDefaults.interpolation });
}

/** Keys inserted from the interface (not by scripts) follow Cycle-Aware Keying. */
export const keyingContext = { cycleAware: false };

/** Run an interface keying action with Cycle-Aware Keying in effect. */
export function withCycleAware<T>(fn: () => T): T {
  const was = keyingContext.cycleAware;
  keyingContext.cycleAware = true;
  try {
    return fn();
  } finally {
    keyingContext.cycleAware = was;
  }
}

/** The cycle of a curve whose first modifier repeats it unrestricted: [first key frame, last key frame]. */
export function curveCycle(fc: FCurve): [number, number] | null {
  const m = fc.modifiers[0];
  if (!m || m.type !== 'CYCLES' || m.mute || m.use_restricted_range || m.use_influence) return null;
  if ((m.mode_before ?? 'REPEAT') !== 'REPEAT' || (m.mode_after ?? 'REPEAT') !== 'REPEAT') return null;
  const k = fc.keyframe_points;
  if (k.length < 2) return null;
  const a = k[0].co[0],
    b = k[k.length - 1].co[0];
  return b - a > 1e-6 ? [a, b] : null;
}

/** Where a key for `frame` goes with Cycle-Aware Keying: inside the cycle, and on both ends at its start. */
export function cycleFrames(fc: FCurve, frame: number): number[] {
  const cyc = curveCycle(fc);
  if (!cyc) return [frame];
  const [a, b] = cyc;
  const p = b - a;
  const f = a + ((((frame - a) % p) + p) % p);
  return Math.abs(f - a) < 1e-4 || Math.abs(f - b) < 1e-4 ? [a, b] : [f];
}

/** Replace mode: update only keys that already exist on the frame (no new keys or curves). */
function replaceKeys(doc: DocumentData, ob: ObjectData, path: string, index: number, frame: number) {
  for (const fc of objectCurves(doc, ob)) {
    if (fc.data_path !== path || (index >= 0 && fc.array_index !== index)) continue;
    const k = fc.keyframe_points.find((x) => Math.abs(x.co[0] - frame) < 0.5);
    const v = getValue(doc, ob, path, fc.array_index);
    if (k && (typeof v === 'number' || typeof v === 'boolean')) insertKeyframe(fc, k.co[0], Number(v), { type: k.type });
  }
}

/**
 * Auto keying after a transform or edit: the active keying set when "Only Active Keying Set" is
 * on, only animated channels with "Only Insert Available", else the default key channels;
 * in Replace mode only keys that already exist on the current frame change.
 */
export function autoKeyObjects(objects: ObjectData[]) {
  const doc = app.doc;
  const ts = doc.scene.tool_settings;
  if (!ts.use_keyframe_insert_auto || !objects.length) return;
  const was = keyframeDefaults.replaceOnly,
    wasCycle = keyingContext.cycleAware;
  keyframeDefaults.replaceOnly = ts.auto_keying_mode === 'REPLACE_KEYS';
  keyingContext.cycleAware = true;
  try {
    if (ts.use_keyframe_insert_keyingset && doc.scene.keying_set) insertKeyframesForObjects(objects, doc.scene.keying_set as KeyingSet);
    else if (keyframeDefaults.autoAvailable || keyframeDefaults.replaceOnly) insertKeyframesForObjects(objects, 'Available');
    else insertKeyframesForObjects(objects, channelsKeyingSet());
  } finally {
    keyframeDefaults.replaceOnly = was;
    keyingContext.cycleAware = wasCycle;
  }
}

/** The built-in keying set matching the default key channels preference. */
function channelsKeyingSet(): KeyingSet {
  const c = keyframeDefaults.channels;
  const L = c.includes('LOCATION'),
    R = c.includes('ROTATION'),
    S = c.includes('SCALE');
  if (L && R && S) return 'LocRotScale';
  if (L && R) return 'LocRot';
  if (L && S) return 'LocScale';
  if (R && S) return 'RotScale';
  return L ? 'Location' : R ? 'Rotation' : S ? 'Scale' : 'LocRotScale';
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
  if (ks === 'Available') {
    const curves = objectCurves(doc, ob);
    for (const [name] of bones) {
      const base = `pose.bones["${name}"].`;
      const seen = new Set<string>();
      for (const fc of [...curves]) {
        const key = `${fc.data_path}|${fc.array_index}`;
        if (!fc.data_path.startsWith(base) || seen.has(key)) continue;
        seen.add(key);
        keyProperty(doc, ob, fc.data_path, fc.array_index);
      }
    }
    return;
  }
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
