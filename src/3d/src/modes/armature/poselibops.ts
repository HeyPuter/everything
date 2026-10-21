// Pose library: interactive Blend Pose Asset (drag to blend, Tab flips the pose), Copy Pose as
// Asset / Paste as New Asset (through a clipboard shared by browser tabs), and Restore Previous
// Action after a new pose asset was made the armature's action for editing.
import { app, registerOperators, type ModalHandler } from '../../app/app';
import type { ActionData, FCurve } from '../../data/types';
import { newAction } from '../../data/defaults';
import { applyPoseAsset, poseAsset, poseBones, poseToAction } from '../../assets/poselib';
import { newMetaData } from '../../assets/types';
import { assignAction } from '../../anim/slots';
import { flipSideName } from './armkernels';
import { setPoseSliderReadout } from './posetools';

const BONE_PATH = /^pose\.bones\["((?:[^"\\]|\\.)*)"\]\.(location|rotation_quaternion|rotation_euler|rotation_axis_angle|scale)$/;
const inPose = () => app.doc.mode === 'POSE' && app.activeObject?.type === 'ARMATURE' && !!app.activeObject.pose;

/** Mirror a pose action across the X axis: .L/.R channels swap, sideways motion changes sign. */
export function flipPoseAction(act: ActionData): ActionData {
  const out = newAction(act.name);
  out.fcurves = act.fcurves.map((fc): FCurve => {
    const m = BONE_PATH.exec(fc.data_path);
    if (!m) return structuredClone(fc);
    const name = flipSideName(m[1].replace(/\\"/g, '"'));
    const prop = m[2];
    const negate = (prop === 'location' && fc.array_index === 0) || (prop === 'rotation_euler' && fc.array_index > 0) || ((prop === 'rotation_quaternion' || prop === 'rotation_axis_angle') && fc.array_index > 1);
    const c = structuredClone(fc);
    c.data_path = `pose.bones["${name.replace(/"/g, '\\"')}"].${prop}`;
    if (c.group) c.group = flipSideName(c.group);
    if (negate)
      for (const k of c.keyframe_points) {
        k.co[1] = -k.co[1];
        k.handle_left[1] = -k.handle_left[1];
        k.handle_right[1] = -k.handle_right[1];
      }
    return c;
  });
  if (act.frame_range) out.frame_range = [...act.frame_range];
  return out;
}

// ---------------------------------------------------------------------------
// clipboard (localStorage, so a pose copied in one file can be pasted in another tab)

const CLIP_KEY = 'p3d.poselib.clipboard';
let memoryClip: string | null = null;
function writeClip(text: string) {
  memoryClip = text;
  try {
    localStorage.setItem(CLIP_KEY, text);
  } catch {
    /* storage unavailable: the in-memory copy still works in this tab */
  }
}
function readClip(): string | null {
  try {
    return localStorage.getItem(CLIP_KEY) ?? memoryClip;
  } catch {
    return memoryClip;
  }
}

/** Previous action of an armature whose action was replaced by a new pose asset for editing. */
type WithPrev = { _prev_pose_action?: { action: string | null } };

registerOperators([
  {
    idname: 'poselib.blend_pose_asset',
    label: 'Blend Pose Asset',
    description: 'Blend a pose asset into the selected bones by dragging (Tab flips the pose, Ctrl snaps to steps of 10%)',
    props: [
      { id: 'asset', label: 'Pose', type: 'string', default: '', hidden: true },
      { id: 'blend_factor', label: 'Blend Factor', type: 'float', default: 0, min: -2, max: 2, softMin: 0, softMax: 1, subtype: 'factor' },
      { id: 'flipped', label: 'Apply Flipped', type: 'bool', default: false },
      { id: 'release_confirm', label: 'Confirm on Release', type: 'bool', default: false, hidden: true },
    ],
    poll: inPose,
    invoke: (_ctx, p) => {
      const ob = app.activeObject!;
      const act = poseAsset(String(p.asset));
      if (!act || !ob.pose) return 'CANCELLED';
      const flippedAct = flipPoseAction(act);
      const names = new Set([...poseBones(act), ...poseBones(flippedAct)]);
      const snap = [...names].filter((n) => ob.pose![n]).map((n) => [n, structuredClone(ob.pose![n])] as const);
      const restore = () => {
        for (const [n, pb] of snap) ob.pose![n] = structuredClone(pb);
      };
      let factor = p.blend_factor as number;
      let flipped = !!p.flipped;
      const x0 = app.pointer.x;
      const f0 = factor;
      const apply = () => {
        restore();
        applyPoseAsset(app.doc, ob, flipped ? flippedAct : act, factor);
        setPoseSliderReadout({ label: `Blend ${act.name}`, value: factor, extra: flipped ? ' · Flipped' : '' });
        app.changed('doc');
      };
      const handler: ModalHandler = {
        label: 'Blend Pose Asset',
        cursor: 'ew-resize',
        header: () => `Blend ${act.name}: ${Math.round(factor * 100)}%${flipped ? ' (flipped)' : ''}`,
        status: () => [
          ['LMB/Enter', 'Confirm'],
          ['RMB/Esc', 'Cancel'],
          ['Tab', 'Flip Pose'],
          ['Ctrl', 'Increments'],
        ],
        onPointerMove(e) {
          factor = f0 + (e.clientX - x0) / 300;
          if (e.ctrlKey || e.metaKey) factor = Math.round(factor * 10) / 10;
          factor = Math.max(0, Math.min(1, factor));
          apply();
        },
        onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
        onPointerUp: (e) => (p.release_confirm && e.button === 0 ? 'FINISHED' : undefined),
        onKey(e) {
          if (e.key === 'Escape') return 'CANCELLED';
          if (e.key === 'Enter') return 'FINISHED';
          if (e.type === 'keydown' && e.key === 'Tab') {
            flipped = !flipped;
            apply();
          }
          return true;
        },
        cancel() {
          restore();
          setPoseSliderReadout(null);
          app.changed('doc');
        },
        finish() {
          setPoseSliderReadout(null);
          handler.redoOp = { idname: 'poselib.blend_pose_asset', props: { asset: p.asset, blend_factor: factor, flipped } };
        },
      };
      app.startModal(handler);
      apply();
      return 'RUNNING_MODAL';
    },
    exec: (ctx, p) => {
      const ob = app.activeObject;
      const act = poseAsset(String(p.asset));
      if (!act || !ob) return 'CANCELLED';
      return applyPoseAsset(ctx.doc, ob, p.flipped ? flipPoseAction(act) : act, p.blend_factor as number) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'poselib.copy_as_asset',
    label: 'Copy Pose as Asset',
    description: 'Copy the pose of the selected bones (all bones when none is selected) to the clipboard, to paste as a new pose asset',
    undo: false,
    poll: inPose,
    exec: () => {
      const ob = app.activeObject!;
      const act = poseToAction(ob, `${ob.name}Pose`);
      if (!act) return 'CANCELLED';
      writeClip(JSON.stringify({ kind: 'pose-asset', name: act.name, action: act }));
      app.report('INFO', 'Pose copied: use Paste as New Asset to store it in a file');
    },
  },
  {
    idname: 'poselib.paste_asset',
    label: 'Paste as New Asset',
    description: 'Make the copied pose a new pose asset of this file',
    poll: () => !!readClip(),
    exec: (ctx) => {
      let data: { kind?: string; name?: string; action?: ActionData } | null = null;
      try {
        data = JSON.parse(readClip() ?? 'null');
      } catch {
        data = null;
      }
      if (data?.kind !== 'pose-asset' || !data.action) {
        app.report('ERROR', 'The clipboard holds no copied pose');
        return 'CANCELLED';
      }
      const act = newAction(data.name ?? 'Pose');
      act.fcurves = data.action.fcurves;
      act.frame_range = data.action.frame_range;
      const taken = new Set(Object.values(ctx.doc.actions).map((a) => a.name));
      for (let i = 1; taken.has(act.name); i++) act.name = `${data.name}.${String(i).padStart(3, '0')}`;
      act.use_fake_user = true;
      (act as ActionData & { asset_data?: ReturnType<typeof newMetaData> }).asset_data = newMetaData();
      ctx.doc.actions[act.id] = act;
      app.report('INFO', `Pasted the pose asset "${act.name}"`);
    },
  },
  {
    idname: 'poselib.restore_previous_action',
    label: 'Restore Previous Action',
    description: 'Give the armature back the action it played before a pose asset was made its action for editing',
    poll: () => !!(app.activeObject as (typeof app.activeObject & WithPrev) | null)?._prev_pose_action,
    exec: (ctx) => {
      const ob = app.activeObject as NonNullable<typeof app.activeObject> & WithPrev;
      const prev = ob._prev_pose_action!;
      delete ob._prev_pose_action;
      ob.animation_data ??= { action: null, nla_tracks: [], drivers: [] };
      assignAction(ctx.doc, ob, ob.animation_data, prev.action && ctx.doc.actions[prev.action] ? prev.action : null);
    },
  },
  {
    idname: 'poselib.edit_pose_asset',
    label: 'Edit Pose Asset',
    description: 'Make a pose asset of this file the armature’s action so its keys can be edited (Restore Previous Action switches back)',
    props: [{ id: 'asset', label: 'Pose', type: 'string', default: '', hidden: true }],
    poll: inPose,
    exec: (ctx, p) => {
      const ob = app.activeObject as NonNullable<typeof app.activeObject> & WithPrev;
      const act = ctx.doc.actions[String(p.asset)] ?? poseAsset(String(p.asset));
      if (!act || !ctx.doc.actions[act.id]) {
        app.report('WARNING', 'Only pose assets of the current file can be edited');
        return 'CANCELLED';
      }
      ob.animation_data ??= { action: null, nla_tracks: [], drivers: [] };
      if (!ob._prev_pose_action) ob._prev_pose_action = { action: ob.animation_data.action };
      assignAction(ctx.doc, ob, ob.animation_data, act.id);
    },
  },
]);
