// Pose assets: an action holding one key per bone channel. Creating one stores the selected
// bones' current pose; applying one sets (or blends towards) that pose on the selected bones of
// an armature, or on every bone of the pose when none of them is selected.
import { app, registerOperators } from '../app/app';
import type { ActionData, DocumentData, FCurve, ObjectData, PoseBone } from '../data/types';
import { newAction } from '../data/defaults';
import { evaluateFCurve, insertKeyframe } from '../anim/fcurve';
import { promptText } from '../ui/menu';
import { renderPreview } from './preview';
import { ensureCatalogPath } from './catalogs';
import { newMetaData } from './types';

const BONE_PATH = /^pose\.bones\["((?:[^"\\]|\\.)*)"\]\.(location|rotation_quaternion|rotation_euler|rotation_axis_angle|scale)$/;

export function isPoseAction(a: ActionData): boolean {
  return a.fcurves.length > 0 && a.fcurves.every((f) => BONE_PATH.test(f.data_path));
}

/** Bones a pose action has channels for. */
export function poseBones(a: ActionData): string[] {
  const out = new Set<string>();
  for (const f of a.fcurves) {
    const m = BONE_PATH.exec(f.data_path);
    if (m) out.add(m[1].replace(/\\"/g, '"'));
  }
  return [...out];
}

/** Frame the pose is read at: the first key of the action. */
function poseFrame(a: ActionData) {
  let f = Infinity;
  for (const fc of a.fcurves) if (fc.keyframe_points.length) f = Math.min(f, fc.keyframe_points[0].co[0]);
  return Number.isFinite(f) ? f : a.frame_range?.[0] ?? 1;
}

/** Set (factor 1) or blend towards a pose on an armature object; returns the number of bones changed. */
export function applyPoseAsset(doc: DocumentData, ob: ObjectData, act: ActionData, factor = 1): number {
  if (ob.type !== 'ARMATURE' || !ob.pose) return 0;
  const names = poseBones(act);
  const anySelected = names.some((n) => ob.pose![n]?.select);
  const frame = poseFrame(act);
  const touched = new Set<string>();
  for (const fc of act.fcurves) {
    const m = BONE_PATH.exec(fc.data_path);
    if (!m) continue;
    const name = m[1].replace(/\\"/g, '"');
    const pb = ob.pose[name];
    if (!pb || (anySelected && !pb.select)) continue;
    const prop = m[2] as 'location' | 'rotation_quaternion' | 'rotation_euler' | 'rotation_axis_angle' | 'scale';
    const arr = [...(pb[prop] as number[])];
    if (fc.array_index >= arr.length) continue;
    const v = evaluateFCurve(fc, frame);
    arr[fc.array_index] = arr[fc.array_index] + (v - arr[fc.array_index]) * factor;
    (pb as unknown as Record<string, number[]>)[prop] = arr;
    touched.add(name);
  }
  void doc;
  return touched.size;
}

function rotationProp(pb: PoseBone) {
  return pb.rotation_mode === 'QUATERNION' ? 'rotation_quaternion' : pb.rotation_mode === 'AXIS_ANGLE' ? 'rotation_axis_angle' : 'rotation_euler';
}

/** A new action with the pose of the selected bones (all bones when none is selected). */
export function poseToAction(ob: ObjectData, name: string): ActionData | null {
  if (!ob.pose) return null;
  const all = Object.entries(ob.pose);
  const sel = all.filter(([, pb]) => pb.select);
  const bones = sel.length ? sel : all;
  if (!bones.length) return null;
  const act = newAction(name);
  for (const [bname, pb] of bones) {
    const base = `pose.bones["${bname.replace(/"/g, '\\"')}"]`;
    for (const prop of ['location', rotationProp(pb), 'scale'] as const) {
      const vals = pb[prop] as number[];
      vals.forEach((v, i) => {
        const fc: FCurve = { data_path: `${base}.${prop}`, array_index: i, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], group: bname };
        insertKeyframe(fc, 1, v, { select_control_point: false, select_left_handle: false, select_right_handle: false });
        act.fcurves.push(fc);
      });
    }
  }
  act.frame_range = [1, 1];
  return act;
}

const inPose = () => app.doc.mode === 'POSE' && app.activeObject?.type === 'ARMATURE' && !!app.activeObject.pose;

registerOperators([
  {
    idname: 'poselib.create_pose_asset',
    label: 'Create Pose Asset',
    description: 'Store the pose of the selected bones as a pose asset of the current file',
    props: [
      { id: 'pose_name', label: 'Pose Name', type: 'string', default: '' },
      { id: 'catalog_path', label: 'Catalog', type: 'string', default: '' },
    ],
    poll: inPose,
    invoke: (ctx, p) => {
      if (p.pose_name) return createExec(ctx.doc, p);
      promptText('Create Pose Asset', 'Pose', (n) => n && app.run('poselib.create_pose_asset', { ...p, pose_name: n }, { invoke: false, area: ctx.area }));
      return 'CANCELLED';
    },
    exec: (ctx, p) => createExec(ctx.doc, p),
  },
  {
    idname: 'poselib.apply_pose_asset',
    label: 'Apply Pose Asset',
    description: 'Set the selected bones (or all bones of the pose) to a pose asset of the current file',
    props: [
      { id: 'action', label: 'Pose', type: 'string', default: '', hidden: true },
      { id: 'blend_factor', label: 'Blend Factor', type: 'float', default: 1, min: 0, max: 1, subtype: 'factor' },
    ],
    poll: inPose,
    exec: (ctx, p) => {
      const act = ctx.doc.actions[String(p.action)];
      const ob = app.activeObject;
      if (!act || !ob) return 'CANCELLED';
      return applyPoseAsset(ctx.doc, ob, act, p.blend_factor as number) ? 'FINISHED' : 'CANCELLED';
    },
  },
]);

function createExec(doc: DocumentData, p: Record<string, unknown>) {
  const ob = app.activeObject!;
  const act = poseToAction(ob, String(p.pose_name || 'Pose'));
  if (!act) return 'CANCELLED' as const;
  const taken = new Set(Object.values(doc.actions).map((a) => a.name));
  for (let i = 1; taken.has(act.name); i++) act.name = `${String(p.pose_name || 'Pose')}.${String(i).padStart(3, '0')}`;
  act.use_fake_user = true;
  doc.actions[act.id] = act;
  const meta = newMetaData();
  if (p.catalog_path) meta.catalog_id = ensureCatalogPath((doc.asset_catalogs ??= []), String(p.catalog_path));
  const url = renderPreview(doc, 'objects', ob.id, ob.id);
  if (url) meta.preview = url;
  (act as ActionData & { asset_data?: typeof meta }).asset_data = meta;
  app.report('INFO', `Created the pose asset "${act.name}"`);
  return 'FINISHED' as const;
}
