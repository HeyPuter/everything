// Pose Mode animation and editing tools: in-betweens (push, relax, breakdown, blend to
// neighbour/rest), propagate, selection sets, name flipping, mirror/linked/grouped
// selection, rotation mode, visual transform and rest pose application, flip quaternions,
// reset unkeyed and bone option toggles, plus the Pose / Select / context menus.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { app, registerOperators, type ModalHandler, type OpContext, type Operator } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { openMenu, promptText, type MenuItem } from '../../ui/menu';
import type { ActionData, ArmatureData, Bone, FCurve, ObjectData, PoseBone, RotationMode } from '../../data/types';
import { evaluateFCurve } from '../../anim/fcurve';
import { keyProperty, rotationPath } from '../../anim/keyframes';
import { getValue, setValue } from '../../data/rna';
import { defaultPoseBone, evaluatePose, sortedBones, boneRotation } from '../../eval/armature';
import { rotationQuaternion, setRotationFromQuaternion, poseBoneMatrix } from '../../eval/transform';
import { modeMenus } from '../../editors/view3d/modemenus';
import { constraintTypes, boneOnlyConstraints, newConstraint } from '../../eval/constraints';
import { uid } from '../../data/defaults';
import { activeView3D } from '../../editors/view3d/view3d';
import { activeArmature, renameBone, ensurePose, pickBone } from './armature';
import { armatureDataPanels } from '../../editors/properties/tabs';
import { uiList } from '../../editors/properties/uilist';
import { panel, opButton } from '../../ui/widgets';
import { h } from '../../ui/h';
import { BUILTIN_KEYING_SETS, keyingSetItems } from '../../anim/keyingsets';
import { flipSideName, autosideName, slideValue, poseRestValue, propagateCurve, type SlideMode, type PropagateMode } from './posemath';

const inPose = () => app.doc.mode === 'POSE' && !!activeArmature();
const posePoll = (_ctx?: OpContext) => inPose();

function armPose(): { ob: ObjectData; arm: ArmatureData; pose: Record<string, PoseBone> } {
  const { ob, arm } = activeArmature()!;
  ensurePose(ob, arm);
  return { ob, arm, pose: ob.pose! };
}

/** Selected, visible bone names. */
function selectedBones(): string[] {
  const { arm, pose } = armPose();
  return arm.bones.filter((b) => !b.hide && pose[b.name]?.select).map((b) => b.name);
}
const pollSelected = () => inPose() && selectedBones().length > 0;

function boneAction(ob: ObjectData): ActionData | undefined {
  const id = ob.animation_data?.action;
  return id ? app.doc.actions[id] : undefined;
}
const bonePath = (name: string) => `pose.bones["${name.replace(/"/g, '\\"')}"]`;
function boneCurves(ob: ObjectData, name: string): FCurve[] {
  const pre = bonePath(name) + '.';
  return boneAction(ob)?.fcurves.filter((f) => f.data_path.startsWith(pre)) ?? [];
}

const autoKey = () => app.doc.scene.tool_settings.use_keyframe_insert_auto;

// ---------------------------------------------------------------------------
// In-betweens (pose slide)

type Channels = 'ALL' | 'LOC' | 'ROT' | 'SIZE' | 'BBONE' | 'CUSTOM';
type AxisLock = 'FREE' | 'X' | 'Y' | 'Z';

interface SlideProps {
  factor: number;
  prev_frame: number;
  next_frame: number;
  channels: Channels;
  axis_lock: AxisLock;
}

/** Properties (path tail + indices) a slide touches on a bone. */
function slideTargets(pb: PoseBone, channels: Channels, axis: AxisLock): { prop: string; indices: number[] }[] {
  const ax = axis === 'FREE' ? [0, 1, 2] : [{ X: 0, Y: 1, Z: 2 }[axis]];
  const out: { prop: string; indices: number[] }[] = [];
  if (channels === 'ALL' || channels === 'LOC') out.push({ prop: 'location', indices: ax });
  if (channels === 'ALL' || channels === 'ROT') {
    const rp = rotationPath(pb);
    out.push({ prop: rp, indices: rp === 'rotation_euler' ? ax : [0, 1, 2, 3] });
  }
  if (channels === 'ALL' || channels === 'SIZE') out.push({ prop: 'scale', indices: ax });
  return out;
}

/** Neighbouring keyframes of a bone around a frame (props override when non-zero). */
function neighbourFrames(ob: ObjectData, name: string, frame: number, p: SlideProps): [number, number] | null {
  const frames = new Set<number>();
  for (const fc of boneCurves(ob, name)) for (const k of fc.keyframe_points) frames.add(k.co[0]);
  const list = [...frames].sort((a, b) => a - b);
  const prev = p.prev_frame || [...list].reverse().find((f) => f < frame - 1e-4);
  const next = p.next_frame || list.find((f) => f > frame + 1e-4);
  if (prev === undefined || next === undefined) return null;
  return [prev, next];
}

function applySlide(mode: SlideMode, p: SlideProps): number {
  const { ob, pose } = armPose();
  const frame = app.doc.scene.frame_current;
  let n = 0;
  for (const name of selectedBones()) {
    const pb = pose[name];
    const nb = mode === 'BLEND_WITH_REST' ? ([frame, frame] as [number, number]) : neighbourFrames(ob, name, frame, p);
    if (!nb) continue;
    const [pf, nf] = nb;
    const t = nf > pf ? (frame - pf) / (nf - pf) : 0.5;
    const curves = boneCurves(ob, name);
    for (const { prop, indices } of slideTargets(pb, p.channels, p.axis_lock)) {
      const path = `${bonePath(name)}.${prop}`;
      const cur = (pb as unknown as Record<string, number[]>)[prop];
      const isQuat = prop === 'rotation_quaternion';
      const next = [...cur];
      for (const i of indices) {
        const fc = curves.find((f) => f.data_path === path && f.array_index === i);
        const prevV = fc ? evaluateFCurve(fc, pf) : cur[i],
          nextV = fc ? evaluateFCurve(fc, nf) : cur[i];
        next[i] = slideValue(mode, cur[i], prevV, nextV, t, p.factor, poseRestValue(prop, i));
      }
      if (isQuat) {
        const l = Math.hypot(...next) || 1;
        for (let i = 0; i < 4; i++) next[i] /= l;
      }
      (pb as unknown as Record<string, number[]>)[prop] = next;
      if (autoKey()) keyProperty(app.doc, ob, path);
    }
    n++;
  }
  return n;
}

/** Interactive factor slider in the 3D viewport (status bar readout). */
function startPoseSlider(label: string, idname: string, mode: SlideMode, props: SlideProps): boolean {
  const { ob, pose } = armPose();
  const names = selectedBones();
  if (!names.length) return false;
  const snap = names.map((n) => [n, structuredClone(pose[n])] as const);
  const act = boneAction(ob);
  const curveSnap = act ? structuredClone(act.fcurves) : null;
  const restore = () => {
    for (const [n, pb] of snap) pose[n] = structuredClone(pb);
    if (act && curveSnap) act.fcurves = structuredClone(curveSnap);
  };
  let value = props.factor;
  let base = value,
    baseX = app.pointer.x,
    precise = false,
    overshoot = false,
    numeric = '';
  let channels: Channels = props.channels,
    axis: AxisLock = props.axis_lock;
  const current = (): SlideProps => ({ ...props, factor: value, channels, axis_lock: axis });
  const update = (snapStep = false) => {
    if (numeric && numeric !== '-' && Number.isFinite(Number(numeric))) value = Number(numeric) / 100;
    else if (snapStep) value = Math.round(value * 10) / 10;
    if (!overshoot) value = Math.max(0, Math.min(1, value));
    restore();
    applySlide(mode, current());
    app.changed('doc');
  };
  const handler: ModalHandler = {
    label,
    cursor: 'ew-resize',
    header: () => `${label}: ${Math.round(value * 100)}%${numeric ? ` [${numeric}|]` : ''} · ${channels === 'ALL' ? 'All' : channels === 'LOC' ? 'Location' : channels === 'ROT' ? 'Rotation' : 'Scale'}${axis !== 'FREE' ? ` (${axis})` : ''}`,
    status: () => [
      ['LMB/Enter', 'Confirm'],
      ['RMB/Esc', 'Cancel'],
      ['G R S', 'Channels'],
      ['X Y Z', 'Axis'],
      ['E', 'Overshoot'],
      ['Ctrl', 'Increments'],
      ['Shift', 'Precision'],
    ],
    onPointerMove(e) {
      if (e.shiftKey !== precise) {
        precise = e.shiftKey;
        base = value;
        baseX = e.clientX;
      }
      value = base + ((e.clientX - baseX) / 300) * (precise ? 0.1 : 1);
      numeric = '';
      update(e.ctrlKey || e.metaKey);
    },
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined),
    onKey(e) {
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      if (e.type !== 'keydown') return true;
      const c = e.code;
      if (c === 'KeyG' || c === 'KeyR' || c === 'KeyS') {
        const want: Channels = c === 'KeyG' ? 'LOC' : c === 'KeyR' ? 'ROT' : 'SIZE';
        channels = channels === want ? 'ALL' : want;
      } else if (c === 'KeyX' || c === 'KeyY' || c === 'KeyZ') {
        const want = c.slice(3) as AxisLock;
        axis = axis === want ? 'FREE' : want;
      } else if (c === 'KeyE') overshoot = !overshoot;
      else if (/^[0-9.]$/.test(e.key) || (e.key === '-' && !numeric)) numeric += e.key;
      else if (e.key === 'Backspace') numeric = numeric.slice(0, -1);
      update();
      return true;
    },
    cancel() {
      restore();
      app.changed('doc');
    },
    finish() {
      handler.redoOp = { idname, props: { ...current() } };
    },
  };
  app.startModal(handler);
  update();
  return true;
}

const slideProps = [
  { id: 'factor', label: 'Factor', type: 'float' as const, default: 0.5, min: 0, max: 1, step: 0.01, subtype: 'factor' as const },
  { id: 'prev_frame', label: 'Previous Keyframe', type: 'int' as const, default: 0 },
  { id: 'next_frame', label: 'Next Keyframe', type: 'int' as const, default: 0 },
  {
    id: 'channels',
    label: 'Channels',
    type: 'enum' as const,
    default: 'ALL',
    items: [
      ['ALL', 'All Properties'],
      ['LOC', 'Location'],
      ['ROT', 'Rotation'],
      ['SIZE', 'Scale'],
    ] as [string, string][],
  },
  {
    id: 'axis_lock',
    label: 'Axis Lock',
    type: 'enum' as const,
    default: 'FREE',
    items: [
      ['FREE', 'Free'],
      ['X', 'X'],
      ['Y', 'Y'],
      ['Z', 'Z'],
    ] as [string, string][],
  },
];

const SLIDES: [string, string, SlideMode, string][] = [
  ['pose.push', 'Push Pose from Breakdown', 'PUSH', 'Exaggerate the current pose away from the in-between of the surrounding keyframes'],
  ['pose.relax', 'Relax Pose to Breakdown', 'RELAX', 'Move the current pose towards the in-between of the surrounding keyframes'],
  ['pose.breakdown', 'Pose Breakdowner', 'BREAKDOWN', 'Set the pose to a mix of the previous and next keyframed poses'],
  ['pose.blend_to_neighbor', 'Blend to Neighbor', 'BLEND_TO_NEIGHBOR', 'Blend the current pose towards the previous (below 50%) or next (above 50%) keyframed pose'],
  ['pose.blend_with_rest', 'Blend Pose with Rest Pose', 'BLEND_WITH_REST', 'Blend the current pose towards the rest pose'],
];

const slideOps: Operator[] = SLIDES.map(([idname, label, mode, description]) => ({
  idname,
  label,
  description,
  props: slideProps,
  poll: pollSelected,
  invoke: (_ctx, p) => (startPoseSlider(label, idname, mode, p as unknown as SlideProps) ? 'RUNNING_MODAL' : 'CANCELLED'),
  exec: (_ctx, p) => {
    if (!applySlide(mode, p as unknown as SlideProps)) {
      app.report('WARNING', 'No keyframes before and after the current frame to blend between');
      return 'CANCELLED';
    }
  },
}));

// ---------------------------------------------------------------------------
// Propagate

const propagateOp: Operator = {
  idname: 'pose.propagate',
  label: 'Propagate Pose',
  description: 'Copy the current pose of the selected bones to later keyframes',
  props: [
    {
      id: 'mode',
      label: 'Terminate Mode',
      type: 'enum',
      default: 'NEXT_KEY',
      items: [
        ['NEXT_KEY', 'To Next Keyframe', 'Propagate to the next keyframe only'],
        ['LAST_KEY', 'To Last Keyframe', 'Propagate to the last keyframe (makes cyclic motions match)'],
        ['BEFORE_FRAME', 'Before Frame', 'Propagate to every keyframe up to the end frame'],
        ['BEFORE_END', 'Before Last Keyframe', 'Propagate to every keyframe after the current frame'],
        ['SELECTED_KEYS', 'On Selected Keyframes', 'Propagate to the selected keyframes'],
        ['SELECTED_MARKERS', 'On Selected Markers', 'Propagate to keyframes on selected markers'],
      ],
    },
    { id: 'end_frame', label: 'End Frame', type: 'float', default: 250, showIf: (p) => p.mode === 'BEFORE_FRAME' },
  ],
  poll: pollSelected,
  exec: (ctx, p) => {
    const { ob } = armPose();
    const frame = ctx.doc.scene.frame_current;
    const markers = ctx.doc.scene.timeline_markers.filter((m) => m.select).map((m) => m.frame);
    let n = 0;
    for (const name of selectedBones())
      for (const fc of boneCurves(ob, name)) {
        const v = getValue(ctx.doc, ob, fc.data_path, fc.array_index);
        if (typeof v !== 'number') continue;
        n += propagateCurve(fc, v, frame, p.mode as PropagateMode, p.end_frame as number, markers);
      }
    if (!n) {
      app.report('WARNING', 'No keyframes to propagate the pose to');
      return 'CANCELLED';
    }
  },
};

// ---------------------------------------------------------------------------
// Selection sets (stored on the armature object)

interface SelectionSet {
  name: string;
  bones: string[];
}
type ObSets = ObjectData & { selection_sets?: SelectionSet[]; active_selection_set?: number };

function sets(): { ob: ObSets; list: SelectionSet[] } {
  const ob = activeArmature()!.ob as ObSets;
  return { ob, list: (ob.selection_sets ??= []) };
}
const activeSet = () => {
  const { ob, list } = sets();
  return list[ob.active_selection_set ?? 0] ?? null;
};
function uniqueSetName(list: SelectionSet[], base = 'SelectionSet') {
  if (!list.some((s) => s.name === base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!list.some((s) => s.name === n)) return n;
  }
}
let setClipboard: SelectionSet[] | null = null;
const hasSets = () => inPose() && sets().list.length > 0;

const selectionSetOps: Operator[] = [
  {
    idname: 'pose.selection_set_add',
    label: 'Create Selection Set',
    description: 'Add a new, empty selection set',
    poll: posePoll,
    exec: () => {
      const { ob, list } = sets();
      list.push({ name: uniqueSetName(list), bones: [] });
      ob.active_selection_set = list.length - 1;
    },
  },
  {
    idname: 'pose.selection_set_remove',
    label: 'Delete Selection Set',
    description: 'Remove the active selection set',
    poll: hasSets,
    exec: () => {
      const { ob, list } = sets();
      const i = ob.active_selection_set ?? 0;
      if (!list[i]) return 'CANCELLED';
      list.splice(i, 1);
      ob.active_selection_set = Math.max(0, Math.min(i, list.length - 1));
    },
  },
  {
    idname: 'pose.selection_set_assign',
    label: 'Add Bones to Selection Set',
    description: 'Add the selected bones to the active selection set',
    poll: () => hasSets() && pollSelected(),
    exec: () => {
      const s = activeSet();
      if (!s) return 'CANCELLED';
      for (const n of selectedBones()) if (!s.bones.includes(n)) s.bones.push(n);
    },
  },
  {
    idname: 'pose.selection_set_unassign',
    label: 'Remove Bones from Selection Set',
    description: 'Remove the selected bones from the active selection set',
    poll: () => hasSets() && pollSelected(),
    exec: () => {
      const s = activeSet();
      if (!s) return 'CANCELLED';
      const sel = new Set(selectedBones());
      s.bones = s.bones.filter((b) => !sel.has(b));
    },
  },
  {
    idname: 'pose.selection_set_select',
    label: 'Select Selection Set',
    description: 'Select the bones of a selection set (the active one by default)',
    props: [
      { id: 'selection_set_index', label: 'Selection Set Index', type: 'int', default: -1 },
      { id: 'extend', label: 'Extend', type: 'bool', default: true },
    ],
    poll: hasSets,
    exec: (_ctx, p) => {
      const { ob, list } = sets();
      const i = (p.selection_set_index as number) >= 0 ? (p.selection_set_index as number) : ob.active_selection_set ?? 0;
      const s = list[i];
      if (!s) return 'CANCELLED';
      const { pose, arm } = armPose();
      if (!p.extend) for (const pb of Object.values(pose)) pb.select = false;
      for (const n of s.bones) if (pose[n] && !arm.bones.find((b) => b.name === n)?.hide) pose[n].select = true;
    },
  },
  {
    idname: 'pose.selection_set_deselect',
    label: 'Deselect Selection Set',
    description: 'Deselect the bones of the active selection set',
    poll: hasSets,
    exec: () => {
      const s = activeSet();
      if (!s) return 'CANCELLED';
      const { pose } = armPose();
      for (const n of s.bones) if (pose[n]) pose[n].select = false;
    },
  },
  {
    idname: 'pose.selection_set_add_and_assign',
    label: 'Create and Add Bones to Selection Set',
    description: 'Make a new selection set from the selected bones',
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: pollSelected,
    exec: (_ctx, p) => {
      const { ob, list } = sets();
      list.push({ name: uniqueSetName(list, String(p.name || 'SelectionSet')), bones: selectedBones() });
      ob.active_selection_set = list.length - 1;
    },
  },
  {
    idname: 'pose.selection_set_delete_all',
    label: 'Delete All Sets',
    description: 'Remove every selection set of the armature',
    poll: hasSets,
    exec: () => {
      const { ob } = sets();
      ob.selection_sets = [];
      ob.active_selection_set = 0;
    },
  },
  {
    idname: 'pose.selection_set_remove_bones',
    label: 'Remove Selected Bones from All Sets',
    description: 'Take the selected bones out of every selection set',
    poll: () => hasSets() && pollSelected(),
    exec: () => {
      const sel = new Set(selectedBones());
      for (const s of sets().list) s.bones = s.bones.filter((b) => !sel.has(b));
    },
  },
  {
    idname: 'pose.selection_set_copy',
    label: 'Copy Selection Set(s)',
    description: 'Copy the selection sets of the armature',
    undo: false,
    poll: hasSets,
    exec: () => {
      setClipboard = structuredClone(sets().list);
    },
  },
  {
    idname: 'pose.selection_set_paste',
    label: 'Paste Selection Set(s)',
    description: 'Add copied selection sets to the armature',
    poll: () => inPose() && !!setClipboard,
    exec: () => {
      const { list } = sets();
      for (const s of structuredClone(setClipboard!)) list.push({ name: uniqueSetName(list, s.name), bones: s.bones });
    },
  },
  {
    idname: 'pose.selection_set_move',
    label: 'Move Selection Set in List',
    description: 'Move the active selection set up or down',
    props: [
      {
        id: 'direction',
        label: 'Move Direction',
        type: 'enum',
        default: 'UP',
        items: [
          ['UP', 'Up'],
          ['DOWN', 'Down'],
        ],
      },
    ],
    poll: hasSets,
    exec: (_ctx, p) => {
      const { ob, list } = sets();
      const i = ob.active_selection_set ?? 0;
      const j = p.direction === 'UP' ? i - 1 : i + 1;
      if (!list[i] || j < 0 || j >= list.length) return 'CANCELLED';
      [list[i], list[j]] = [list[j], list[i]];
      ob.active_selection_set = j;
    },
  },
];

export function selectionSetsMenu(): MenuItem[] {
  if (!inPose()) return [];
  const list = sets().list;
  if (!list.length) return [{ label: 'No selection sets', disabled: true }];
  return list.map((s, i) => ({ label: s.name, op: 'pose.selection_set_select', props: { selection_set_index: i, extend: false } }));
}

// ---------------------------------------------------------------------------
// Names

/** Rename several bones at once without name clashes between them. */
function renameMany(ob: ObjectData, arm: ArmatureData, pairs: [string, string][]) {
  const todo = pairs.filter(([a, b]) => a !== b);
  const tmp = todo.map(([a], i) => [renameBone(ob, arm, a, `__rename_${i}_${a}`), todo[i][1]] as const);
  for (const [t, final] of tmp) renameBone(ob, arm, t, final);
  return todo.length;
}

const nameOps: Operator[] = [
  {
    idname: 'pose.flip_names',
    label: 'Flip Names',
    description: 'Swap the left/right side in the names of the selected bones',
    props: [{ id: 'do_strip_numbers', label: 'Strip Numbers', type: 'bool', default: false }],
    poll: pollSelected,
    exec: (_ctx, p) => {
      const { ob, arm } = armPose();
      if (!renameMany(ob, arm, selectedBones().map((n) => [n, flipSideName(n, !!p.do_strip_numbers)]))) return 'CANCELLED';
    },
  },
  {
    idname: 'pose.autoside_names',
    label: 'Auto-Name by Axis',
    description: 'Add a side suffix to the selected bones from where they lie along an axis',
    props: [
      {
        id: 'axis',
        label: 'Axis',
        type: 'enum',
        default: 'XAXIS',
        items: [
          ['XAXIS', 'X-Axis', 'Left/Right'],
          ['YAXIS', 'Y-Axis', 'Front/Back'],
          ['ZAXIS', 'Z-Axis', 'Top/Bottom'],
        ],
      },
    ],
    poll: pollSelected,
    exec: (_ctx, p) => {
      const { ob, arm } = armPose();
      const i = { XAXIS: 0, YAXIS: 1, ZAXIS: 2 }[p.axis as 'XAXIS'];
      const pairs: [string, string][] = selectedBones().map((n) => {
        const b = arm.bones.find((x) => x.name === n)!;
        const v = Math.abs(b.head[i]) > 1e-5 ? b.head[i] : b.tail[i];
        return [n, autosideName(n, v, p.axis as 'XAXIS')];
      });
      if (!renameMany(ob, arm, pairs)) return 'CANCELLED';
    },
  },
];

// ---------------------------------------------------------------------------
// Selection

function setActive(arm: ArmatureData, name: string | null) {
  arm.active_bone = name;
}

const selectOps: Operator[] = [
  {
    idname: 'pose.select_mirror',
    label: 'Select Mirror',
    description: 'Select the bones on the other side (by name)',
    props: [
      { id: 'only_active', label: 'Active Only', type: 'bool', default: false },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: pollSelected,
    exec: (_ctx, p) => {
      const { arm, pose } = armPose();
      const src = p.only_active && arm.active_bone ? [arm.active_bone] : selectedBones();
      const mirrors = src.map((n) => flipSideName(n)).filter((m) => pose[m]);
      if (!p.extend) for (const pb of Object.values(pose)) pb.select = false;
      for (const m of mirrors) pose[m].select = true;
      if (arm.active_bone && pose[flipSideName(arm.active_bone)]) setActive(arm, flipSideName(arm.active_bone));
    },
  },
  {
    idname: 'pose.select_parent',
    label: 'Select Parent Bone',
    description: 'Select the parent of the active bone (and make it active)',
    poll: () => inPose() && !!activeArmature()!.arm.active_bone,
    exec: () => {
      const { arm, pose } = armPose();
      const b = arm.bones.find((x) => x.name === arm.active_bone);
      if (!b?.parent || !pose[b.parent]) return 'CANCELLED';
      pose[b.name].select = false;
      pose[b.parent].select = true;
      setActive(arm, b.parent);
    },
  },
  {
    idname: 'pose.select_linked',
    label: 'Select Connected',
    description: 'Select all bones connected to the selected ones',
    poll: pollSelected,
    exec: () => {
      const { arm, pose } = armPose();
      for (const n of selectedBones()) for (const m of connectedChain(arm, n)) if (pose[m]) pose[m].select = true;
    },
  },
  {
    idname: 'pose.select_linked_pick',
    label: 'Select Connected',
    description: 'Select the bones connected to the bone under the mouse',
    props: [{ id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll: () => inPose() && !!activeView3D(),
    exec: (ctx, p) => {
      const v = activeView3D()!;
      const r = v.el.getBoundingClientRect();
      const e = ctx.event ?? app.pointer;
      const hit = pickBone(v, e.x - r.left, e.y - r.top, true);
      if (!hit) return 'CANCELLED';
      const { arm, pose } = armPose();
      if (!p.extend) for (const pb of Object.values(pose)) pb.select = false;
      for (const m of connectedChain(arm, hit.bone.name)) if (pose[m]) pose[m].select = true;
      setActive(arm, hit.bone.name);
    },
  },
  {
    idname: 'pose.select_grouped',
    label: 'Select Grouped',
    description: 'Select bones that share a property with the active bone',
    props: [
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'COLLECTION',
        items: [
          ['COLLECTION', 'Collection', 'Same bone collections as the active bone'],
          ['CHILDREN', 'Children', 'All descendants of the selected bones'],
          ['CHILDREN_IMMEDIATE', 'Immediate Children', 'Direct children of the selected bones'],
          ['PARENT', 'Parent', 'Parents of the selected bones'],
          ['SIBLINGS', 'Siblings', 'Bones with the same parent as the selected bones'],
        ],
      },
    ],
    poll: pollSelected,
    exec: (_ctx, p) => {
      const { arm, pose } = armPose();
      const sel = selectedBones();
      const add = new Set<string>();
      const kids = (n: string) => arm.bones.filter((b) => b.parent === n).map((b) => b.name);
      for (const n of sel) {
        const b = arm.bones.find((x) => x.name === n)!;
        if (p.type === 'COLLECTION') {
          const act = arm.bones.find((x) => x.name === (arm.active_bone ?? n)) ?? b;
          const cols = act.layer_collections ?? [];
          for (const o of arm.bones) if ((o.layer_collections ?? []).some((c) => cols.includes(c))) add.add(o.name);
        } else if (p.type === 'CHILDREN') {
          const stack = kids(n);
          while (stack.length) {
            const c = stack.pop()!;
            add.add(c);
            stack.push(...kids(c));
          }
        } else if (p.type === 'CHILDREN_IMMEDIATE') kids(n).forEach((c) => add.add(c));
        else if (p.type === 'PARENT') {
          if (b.parent) add.add(b.parent);
        } else for (const o of arm.bones) if (o.parent === b.parent && o.name !== n) add.add(o.name);
      }
      const visible = [...add].filter((n) => pose[n] && !arm.bones.find((b) => b.name === n)?.hide);
      if (!visible.length) return 'CANCELLED';
      if (!p.extend) for (const pb of Object.values(pose)) pb.select = false;
      for (const n of visible) pose[n].select = true;
    },
  },
  {
    idname: 'pose.select_constraint_target',
    label: 'Select Constraint Target',
    description: 'Select the bones that constraints of the selected bones target',
    poll: pollSelected,
    exec: () => {
      const { ob, pose } = armPose();
      let n = 0;
      for (const name of selectedBones())
        for (const c of pose[name].constraints) {
          if (c.target === ob.id && c.subtarget && pose[c.subtarget as string]) {
            pose[c.subtarget as string].select = true;
            n++;
          }
          if (c.pole_target === ob.id && c.pole_subtarget && pose[c.pole_subtarget as string]) {
            pose[c.pole_subtarget as string].select = true;
            n++;
          }
        }
      if (!n) return 'CANCELLED';
    },
  },
];

/** Bones joined to `name` through connected parent/child links. */
function connectedChain(arm: ArmatureData, name: string): string[] {
  const byName = new Map(arm.bones.map((b) => [b.name, b]));
  let root = byName.get(name);
  while (root?.use_connect && root.parent && byName.get(root.parent)) root = byName.get(root.parent);
  if (!root) return [];
  const out = [root.name];
  const stack = [root.name];
  while (stack.length) {
    const n = stack.pop()!;
    for (const b of arm.bones)
      if (b.parent === n && b.use_connect) {
        out.push(b.name);
        stack.push(b.name);
      }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transform utilities

const ROT_MODES: [RotationMode, string][] = [
  ['QUATERNION', 'Quaternion (WXYZ)'],
  ['XYZ', 'XYZ Euler'],
  ['XZY', 'XZY Euler'],
  ['YXZ', 'YXZ Euler'],
  ['YZX', 'YZX Euler'],
  ['ZXY', 'ZXY Euler'],
  ['ZYX', 'ZYX Euler'],
  ['AXIS_ANGLE', 'Axis Angle'],
];

/** Armature-space matrix a bone's local pose is applied in (parent pose × rest offset). */
function parentSpace(arm: ArmatureData, b: Bone, poses: Map<string, Matrix4>, rests: Map<string, Matrix4>, lengths: Map<string, number>): Matrix4 {
  const rest = rests.get(b.name)!;
  const parentPose = b.parent ? poses.get(b.parent) : undefined;
  if (!b.parent || !parentPose) return rest.clone();
  const parentRest = rests.get(b.parent)!;
  const rel = parentRest.clone().invert().multiply(rest);
  if (b.use_connect) rel.setPosition(0, lengths.get(b.parent) ?? 0, 0);
  let pp = parentPose;
  if (!b.use_inherit_rotation || b.inherit_scale === 'NONE') {
    const p = new Vector3(),
      q = new Quaternion(),
      s = new Vector3(),
      pr = new Vector3(),
      qr = new Quaternion(),
      sr = new Vector3();
    parentPose.decompose(p, q, s);
    parentRest.decompose(pr, qr, sr);
    pp = new Matrix4().compose(p, b.use_inherit_rotation ? q : qr, b.inherit_scale === 'NONE' ? new Vector3(1, 1, 1) : s);
  }
  return pp.clone().multiply(rel);
}

function setLocalFromMatrix(pb: PoseBone, m: Matrix4) {
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  m.decompose(p, q, s);
  pb.location = [p.x, p.y, p.z];
  pb.scale = [s.x, s.y, s.z];
  setRotationFromQuaternion(pb, q);
}

const transformOps: Operator[] = [
  {
    idname: 'pose.rotation_mode_set',
    label: 'Set Rotation Mode',
    description: 'Change the rotation mode of the selected bones, keeping their orientation',
    props: [{ id: 'type', label: 'Rotation Mode', type: 'enum', default: 'QUATERNION', items: ROT_MODES }],
    poll: pollSelected,
    exec: (_ctx, p) => {
      const { pose } = armPose();
      for (const n of selectedBones()) {
        const pb = pose[n];
        const q = rotationQuaternion(pb.rotation_mode, pb.rotation_euler, pb.rotation_quaternion, pb.rotation_axis_angle);
        pb.rotation_mode = p.type as RotationMode;
        setRotationFromQuaternion(pb, q);
      }
    },
  },
  {
    idname: 'pose.quaternions_flip',
    label: 'Flip Quaternions',
    description: 'Flip the sign of the selected bones’ quaternions (same orientation, the other way round when interpolating)',
    poll: pollSelected,
    exec: () => {
      const { ob, pose } = armPose();
      let n = 0;
      for (const name of selectedBones()) {
        const pb = pose[name];
        if (pb.rotation_mode !== 'QUATERNION') continue;
        pb.rotation_quaternion = pb.rotation_quaternion.map((v) => -v) as PoseBone['rotation_quaternion'];
        if (autoKey()) keyProperty(app.doc, ob, `${bonePath(name)}.rotation_quaternion`);
        n++;
      }
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'pose.user_transforms_clear',
    label: 'Clear User Transforms',
    description: 'Reset unkeyed edits: animated channels return to their animation, the rest to the rest pose',
    props: [{ id: 'only_selected', label: 'Only Selected', type: 'bool', default: true }],
    poll: posePoll,
    exec: (ctx, p) => {
      const { ob, arm, pose } = armPose();
      const names = p.only_selected ? selectedBones() : arm.bones.map((b) => b.name);
      const frame = ctx.doc.scene.frame_current;
      for (const n of names) {
        const old = pose[n];
        pose[n] = { ...defaultPoseBone(), rotation_mode: old.rotation_mode, constraints: old.constraints, select: old.select, custom_shape: old.custom_shape };
        for (const fc of boneCurves(ob, n)) if (!fc.mute && fc.keyframe_points.length) setValue(ctx.doc, ob, fc.data_path, fc.array_index, evaluateFCurve(fc, frame));
      }
    },
  },
  {
    idname: 'pose.visual_transform_apply',
    label: 'Apply Visual Transform to Pose',
    description: 'Bake the effect of constraints into the selected bones’ pose',
    poll: pollSelected,
    exec: () => {
      const { ob, arm, pose } = armPose();
      const ev = app.graph.get(ob.id)?.pose;
      if (!ev) return 'CANCELLED';
      const poses = new Map<string, Matrix4>(),
        rests = new Map<string, Matrix4>(),
        lengths = new Map<string, number>();
      for (const [n, b] of ev.bones) {
        poses.set(n, b.pose.clone());
        rests.set(n, b.rest.clone());
        lengths.set(n, b.length);
      }
      const sel = new Set(selectedBones());
      for (const b of sortedBones(arm)) {
        if (!sel.has(b.name) || !poses.has(b.name)) continue;
        const local = parentSpace(arm, b, poses, rests, lengths).invert().multiply(poses.get(b.name)!);
        setLocalFromMatrix(pose[b.name], local);
      }
    },
  },
  {
    idname: 'pose.armature_apply',
    label: 'Apply Pose as Rest Pose',
    description: 'Make the current pose the armature’s rest pose (all bones, or only the selected ones)',
    props: [{ id: 'selected', label: 'Selected Only', type: 'bool', default: false }],
    poll: posePoll,
    exec: (ctx, p) => {
      const { ob, arm, pose } = armPose();
      const before = evaluatePose(ctx.doc, ob, arm);
      const apply = new Set(p.selected ? selectedBones() : arm.bones.map((b) => b.name));
      if (!apply.size) return 'CANCELLED';
      // new rest for the chosen bones from their posed matrices
      for (const b of arm.bones) {
        if (!apply.has(b.name)) continue;
        const m = before.bones.get(b.name)!;
        const head = new Vector3().setFromMatrixPosition(m.pose);
        const tail = new Vector3(0, m.length, 0).applyMatrix4(m.pose);
        b.head = [head.x, head.y, head.z];
        b.tail = [tail.x, tail.y, tail.z];
        b.roll = rollFromMatrix(tail.clone().sub(head), m.pose);
      }
      for (const n of apply) pose[n] = { ...defaultPoseBone(), rotation_mode: pose[n].rotation_mode, constraints: pose[n].constraints, select: pose[n].select, custom_shape: pose[n].custom_shape };
      // the other bones keep their posed placement
      if (p.selected) {
        for (const b of sortedBones(arm)) {
          if (apply.has(b.name)) continue;
          const now = evaluatePose(ctx.doc, ob, arm).bones.get(b.name)!;
          const target = before.bones.get(b.name)!.pose;
          const ps = now.pose.clone().multiply(poseBoneMatrix(pose[b.name]).invert());
          setLocalFromMatrix(pose[b.name], ps.invert().multiply(target));
        }
      }
      app.graph.invalidate?.();
    },
  },
];

/** Roll that makes a bone along `dir` match the orientation of matrix `m`. */
function rollFromMatrix(dir: Vector3, m: Matrix4): number {
  const base = boneRotation(dir, 0);
  const zBase = new Vector3(0, 0, 1).applyMatrix4(base).normalize();
  const xBase = new Vector3(1, 0, 0).applyMatrix4(base).normalize();
  const rot = new Matrix4().extractRotation(m);
  const z = new Vector3(0, 0, 1).applyMatrix4(rot).normalize();
  return Math.atan2(z.dot(xBase), z.dot(zBase));
}

// ---------------------------------------------------------------------------
// Bone options

const BONE_OPTIONS: [keyof Bone, string][] = [
  ['use_deform', 'Deform'],
  ['use_inherit_rotation', 'Inherit Rotation'],
];

const optionOp: Operator = {
  idname: 'pose.bone_option_set',
  label: 'Set Bone Option',
  description: 'Toggle, enable or disable an option on the selected bones',
  props: [
    { id: 'option', label: 'Option', type: 'enum', default: 'use_deform', items: BONE_OPTIONS as [string, string][] },
    {
      id: 'mode',
      label: 'Mode',
      type: 'enum',
      default: 'TOGGLE',
      items: [
        ['TOGGLE', 'Toggle'],
        ['ENABLE', 'Enable'],
        ['DISABLE', 'Disable'],
      ],
    },
  ],
  poll: pollSelected,
  exec: (_ctx, p) => {
    const { arm } = armPose();
    const sel = new Set(selectedBones());
    const bones = arm.bones.filter((b) => sel.has(b.name));
    const key = p.option as 'use_deform';
    const on = p.mode === 'TOGGLE' ? !bones.every((b) => b[key]) : p.mode === 'ENABLE';
    for (const b of bones) b[key] = on;
  },
};

const boneOptionsMenu = (mode: string) => (): MenuItem[] => BONE_OPTIONS.map(([k, l]) => ({ label: l, op: 'pose.bone_option_set', props: { option: k, mode } }));

// ---------------------------------------------------------------------------
// Keying set choice

const keyingSetOp: Operator = {
  idname: 'anim.keying_set_active_set',
  label: 'Set Active Keying Set',
  description: 'Choose the keying set used when inserting keyframes',
  props: [{ id: 'type', label: 'Keying Set', type: 'enum', default: 'LocRotScale', items: BUILTIN_KEYING_SETS }],
  invoke: () => {
    const cur = app.doc.scene.keying_set ?? 'LocRotScale';
    openMenu(
      keyingSetItems().map(([v, l]) => ({ label: l, active: v === cur, op: 'anim.keying_set_active_set', props: { type: v } })),
      { x: app.pointer.x, y: app.pointer.y },
      { title: 'Active Keying Set' },
    );
    return 'CANCELLED';
  },
  exec: (ctx, p) => {
    ctx.doc.scene.keying_set = p.type as 'LocRotScale';
  },
};

// ---------------------------------------------------------------------------
// Bone constraints

const CONSTRAINT_ITEMS = (): [string, string][] => [...Object.values(constraintTypes).map((t) => [t.type, t.label] as [string, string]), ...Object.entries(boneOnlyConstraints)];

const constraintOps: Operator[] = [
  {
    idname: 'pose.constraint_add_with_targets',
    label: 'Add Constraint (with Targets)',
    description: 'Add a constraint to the active bone, targeting the other selected bone (or selected object)',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'COPY_LOCATION', items: CONSTRAINT_ITEMS() }],
    poll: () => inPose() && !!activeArmature()!.arm.active_bone,
    invoke: () => {
      openMenu(
        CONSTRAINT_ITEMS().map(([v, l]) => ({ label: l, op: 'pose.constraint_add_with_targets', props: { type: v } })),
        { x: app.pointer.x, y: app.pointer.y },
        { title: 'Add Constraint (with Targets)' },
      );
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const { ob, arm, pose } = armPose();
      const act = arm.active_bone ? pose[arm.active_bone] : undefined;
      if (!act) return 'CANCELLED';
      const c = newConstraint(p.type as string, uid('cn'));
      const other = selectedBones().find((n) => n !== arm.active_bone);
      const otherOb = app.selectedObjects().find((o) => o.id !== ob.id);
      if (other) {
        c.target = ob.id;
        c.subtarget = other;
      } else if (otherOb) c.target = otherOb.id;
      act.constraints.push(c);
    },
  },
  {
    idname: 'pose.constraints_copy',
    label: 'Copy Constraints to Selected Bones',
    description: 'Copy the active bone’s constraints to the other selected bones',
    poll: () => inPose() && !!activeArmature()!.arm.active_bone && selectedBones().length > 1,
    exec: () => {
      const { arm, pose } = armPose();
      const src = pose[arm.active_bone!];
      if (!src?.constraints.length) return 'CANCELLED';
      for (const n of selectedBones()) if (n !== arm.active_bone) pose[n].constraints.push(...src.constraints.map((c) => ({ ...structuredClone(c), id: uid('cn') })));
    },
  },
];

registerOperators([...constraintOps, ...slideOps, propagateOp, ...selectionSetOps, ...nameOps, ...selectOps, ...transformOps, optionOp, keyingSetOp]);

// ---------------------------------------------------------------------------
// Menus

export function inBetweensMenu(): MenuItem[] {
  return [
    { label: 'Blend with Rest Pose', op: 'pose.blend_with_rest' },
    { label: 'Push Pose from Breakdown', op: 'pose.push', shortcut: 'Ctrl E' },
    { label: 'Relax Pose to Breakdown', op: 'pose.relax', shortcut: 'Alt E' },
    { label: 'Pose Breakdowner', op: 'pose.breakdown', shortcut: 'Shift E' },
    { label: 'Blend to Neighbor', op: 'pose.blend_to_neighbor', shortcut: 'Shift Alt E' },
  ];
}

export function propagateMenu(): MenuItem[] {
  return [
    { label: 'To Next Keyframe', op: 'pose.propagate', props: { mode: 'NEXT_KEY' } },
    { label: 'To Last Keyframe (Make Cyclic)', op: 'pose.propagate', props: { mode: 'LAST_KEY' } },
    { separator: true },
    { label: 'On Selected Keyframes', op: 'pose.propagate', props: { mode: 'SELECTED_KEYS' } },
    { separator: true },
    { label: 'On Selected Markers', op: 'pose.propagate', props: { mode: 'SELECTED_MARKERS' } },
  ];
}

function animationMenu(): MenuItem[] {
  return [
    { label: 'In-Betweens', submenu: inBetweensMenu },
    { separator: true },
    { label: 'Insert Keyframe', op: 'anim.keyframe_insert', shortcut: 'I' },
    { label: 'Insert Keyframe with Keying Set…', op: 'anim.keyframe_insert_menu', shortcut: 'K' },
    { label: 'Delete Keyframes…', op: 'anim.keyframe_delete_v3d', shortcut: 'Alt I' },
    { label: 'Clear Keyframes…', op: 'anim.keyframe_clear_v3d' },
    { label: 'Change Keying Set…', op: 'anim.keying_set_active_set', shortcut: 'Shift K' },
    { separator: true },
    { label: 'Bake Action…', op: 'nla.bake' },
  ];
}

export function motionPathsMenu(): MenuItem[] {
  return [
    { label: 'Calculate', op: 'pose.paths_calculate' },
    { label: 'Clear', op: 'pose.paths_clear' },
  ];
}

function namesMenu(): MenuItem[] {
  return [
    { label: 'Auto-Name Left/Right', op: 'pose.autoside_names', props: { axis: 'XAXIS' } },
    { label: 'Auto-Name Front/Back', op: 'pose.autoside_names', props: { axis: 'YAXIS' } },
    { label: 'Auto-Name Top/Bottom', op: 'pose.autoside_names', props: { axis: 'ZAXIS' } },
    { label: 'Flip Names', op: 'pose.flip_names' },
  ];
}

export function poseApplyMenu(): MenuItem[] {
  return [
    { label: 'Apply Pose as Rest Pose', op: 'pose.armature_apply' },
    { label: 'Apply Selected as Rest Pose', op: 'pose.armature_apply', props: { selected: true } },
    { label: 'Apply Visual Transform to Pose', op: 'pose.visual_transform_apply' },
  ];
}

function clearTransformMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'pose.transforms_clear' },
    { separator: true },
    { label: 'Location', op: 'pose.loc_clear', shortcut: 'Alt G' },
    { label: 'Rotation', op: 'pose.rot_clear', shortcut: 'Alt R' },
    { label: 'Scale', op: 'pose.scale_clear', shortcut: 'Alt S' },
    { separator: true },
    { label: 'Reset Unkeyed', op: 'pose.user_transforms_clear' },
  ];
}

export function poseMenu(): MenuItem[] {
  return [
    {
      label: 'Transform',
      submenu: () => [
        { label: 'Move', op: 'transform.translate', shortcut: 'G' },
        { label: 'Rotate', op: 'transform.rotate', shortcut: 'R' },
        { label: 'Scale', op: 'transform.resize', shortcut: 'S' },
        { separator: true },
        { label: 'Set Rotation Mode', submenu: () => ROT_MODES.map(([v, l]) => ({ label: l, op: 'pose.rotation_mode_set', props: { type: v } })), shortcut: 'Ctrl R' },
      ],
    },
    { label: 'Clear Transform', submenu: clearTransformMenu },
    { label: 'Apply', submenu: poseApplyMenu, shortcut: 'Ctrl A' },
    { separator: true },
    { label: 'Animation', submenu: animationMenu },
    { label: 'Propagate', submenu: propagateMenu, shortcut: 'Alt P' },
    { separator: true },
    { label: 'Copy Pose', op: 'pose.copy', shortcut: 'Ctrl C' },
    { label: 'Paste Pose', op: 'pose.paste', shortcut: 'Ctrl V' },
    { label: 'Paste Pose Flipped', op: 'pose.paste', props: { flipped: true }, shortcut: 'Shift Ctrl V' },
    { separator: true },
    { label: 'Motion Paths', submenu: motionPathsMenu },
    { label: 'Selection Sets', submenu: selectionSetsSubmenu },
    { separator: true },
    {
      label: 'Inverse Kinematics',
      submenu: () => [
        { label: 'Add IK to Bone…', op: 'pose.ik_add', shortcut: 'Shift I' },
        { label: 'Clear IK', op: 'pose.ik_clear', shortcut: 'Ctrl Alt I' },
      ],
    },
    {
      label: 'Constraints',
      submenu: () => [
        { label: 'Add (with Targets)…', op: 'pose.constraint_add_with_targets', shortcut: 'Shift Ctrl C' },
        { label: 'Copy Constraints to Selected Bones', op: 'pose.constraints_copy' },
        { label: 'Clear Pose Constraints', op: 'pose.constraints_clear', shortcut: 'Ctrl Alt C' },
      ],
    },
    { separator: true },
    { label: 'Names', submenu: namesMenu },
    { label: 'Flip Quaternions', op: 'pose.quaternions_flip', shortcut: 'Alt F' },
    { separator: true },
    {
      label: 'Show/Hide',
      submenu: () => [
        { label: 'Reveal Bones', op: 'pose.reveal', shortcut: 'Alt H' },
        { label: 'Hide Selected', op: 'pose.hide', shortcut: 'H' },
        { label: 'Hide Unselected', op: 'pose.hide', props: { unselected: true }, shortcut: 'Shift H' },
      ],
    },
    { label: 'Bone Settings', submenu: boneOptionsMenu('TOGGLE'), shortcut: 'Shift W' },
  ];
}

function selectionSetsSubmenu(): MenuItem[] {
  return [
    { label: 'Create and Add Selected', op: 'pose.selection_set_add_and_assign' },
    { label: 'Select Selection Set', submenu: selectionSetsMenu, shortcut: 'Shift Alt W' },
    { separator: true },
    { label: 'Add Bones to Active Set', op: 'pose.selection_set_assign' },
    { label: 'Remove Bones from Active Set', op: 'pose.selection_set_unassign' },
    { label: 'Remove Selected Bones from All Sets', op: 'pose.selection_set_remove_bones' },
    { separator: true },
    { label: 'Copy Selection Sets', op: 'pose.selection_set_copy' },
    { label: 'Paste Selection Sets', op: 'pose.selection_set_paste' },
    { label: 'Delete All Sets', op: 'pose.selection_set_delete_all' },
  ];
}

export function poseContextMenu(): MenuItem[] {
  return [
    { label: 'Insert Keyframe', op: 'anim.keyframe_insert', shortcut: 'I' },
    { label: 'Insert Keyframe with Keying Set…', op: 'anim.keyframe_insert_menu', shortcut: 'K' },
    { separator: true },
    { label: 'Copy Pose', op: 'pose.copy', shortcut: 'Ctrl C' },
    { label: 'Paste Pose', op: 'pose.paste', shortcut: 'Ctrl V' },
    { label: 'Paste X-Flipped Pose', op: 'pose.paste', props: { flipped: true }, shortcut: 'Shift Ctrl V' },
    { separator: true },
    { label: 'Rename Active Bone…', op: 'armature.rename', shortcut: 'F2' },
    { separator: true },
    { label: 'Push Pose from Breakdown', op: 'pose.push', shortcut: 'Ctrl E' },
    { label: 'Relax Pose to Breakdown', op: 'pose.relax', shortcut: 'Alt E' },
    { label: 'Pose Breakdowner', op: 'pose.breakdown', shortcut: 'Shift E' },
    { label: 'Blend to Neighbor', op: 'pose.blend_to_neighbor', shortcut: 'Shift Alt E' },
    { separator: true },
    { label: 'Calculate Motion Paths', op: 'pose.paths_calculate' },
    { label: 'Clear Motion Paths', op: 'pose.paths_clear' },
    { label: 'Update Armature Motion Paths', op: 'pose.paths_update' },
    { label: 'Update All Motion Paths', op: 'object.paths_update_visible' },
    { separator: true },
    { label: 'Hide Selected', op: 'pose.hide', shortcut: 'H' },
    { label: 'Reveal Bones', op: 'pose.reveal', shortcut: 'Alt H' },
    { separator: true },
    { label: 'Reset Unkeyed', op: 'pose.user_transforms_clear' },
  ];
}

export function poseSelectMenu(): MenuItem[] {
  return [
    { label: 'All', op: 'pose.select_all', props: { action: 'SELECT' }, shortcut: 'A' },
    { label: 'None', op: 'pose.select_all', props: { action: 'DESELECT' }, shortcut: 'Alt A' },
    { label: 'Invert', op: 'pose.select_all', props: { action: 'INVERT' }, shortcut: 'Ctrl I' },
    { separator: true },
    { label: 'Box Select', op: 'view3d.select_box_tool', shortcut: 'B' },
    { label: 'Circle Select', op: 'view3d.select_circle', shortcut: 'C' },
    { separator: true },
    { label: 'Select Mirror', op: 'pose.select_mirror', shortcut: 'Shift Ctrl M' },
    { separator: true },
    {
      label: 'More/Less',
      submenu: () => [
        { label: 'Parent', op: 'pose.select_hierarchy', props: { direction: 'PARENT', extend: false }, shortcut: '[' },
        { label: 'Child', op: 'pose.select_hierarchy', props: { direction: 'CHILD', extend: false }, shortcut: ']' },
        { separator: true },
        { label: 'Extend Parent', op: 'pose.select_hierarchy', props: { direction: 'PARENT', extend: true }, shortcut: 'Shift [' },
        { label: 'Extend Child', op: 'pose.select_hierarchy', props: { direction: 'CHILD', extend: true }, shortcut: 'Shift ]' },
      ],
    },
    { separator: true },
    {
      label: 'Select Grouped',
      shortcut: 'Shift G',
      submenu: () =>
        [
          ['COLLECTION', 'Collection'],
          ['CHILDREN', 'Children'],
          ['CHILDREN_IMMEDIATE', 'Immediate Children'],
          ['PARENT', 'Parent'],
          ['SIBLINGS', 'Siblings'],
        ].map(([v, l]) => ({ label: l, op: 'pose.select_grouped', props: { type: v } })),
    },
    { label: 'Select Linked', op: 'pose.select_linked', shortcut: 'Ctrl L' },
    { label: 'Select Pattern…', op: 'object.select_pattern' },
    { separator: true },
    { label: 'Bone Selection Set', submenu: selectionSetsMenu, shortcut: 'Shift Alt W' },
    { label: 'Constraint Target', op: 'pose.select_constraint_target' },
  ];
}

const prevPose = modeMenus.POSE;
modeMenus.POSE = {
  ...prevPose,
  header: () => [['Pose', poseMenu]],
  select: poseSelectMenu,
  context: poseContextMenu,
};

const groupedMenu = (): MenuItem[] => poseSelectMenu().find((i) => i.label === 'Select Grouped')!.submenu!();

addKeys('Pose', [
  { key: 'E', ctrl: true, op: 'pose.push', when: inPose },
  { key: 'C', shift: true, ctrl: true, op: 'pose.constraint_add_with_targets', when: inPose },
  { key: 'E', alt: true, op: 'pose.relax', when: inPose },
  { key: 'E', shift: true, op: 'pose.breakdown', when: inPose },
  { key: 'E', shift: true, alt: true, op: 'pose.blend_to_neighbor', when: inPose },
  { key: 'P', alt: true, menu: propagateMenu, menuTitle: 'Propagate', when: inPose },
  { key: 'A', ctrl: true, menu: poseApplyMenu, menuTitle: 'Apply', when: inPose },
  { key: 'R', ctrl: true, menu: () => ROT_MODES.map(([v, l]) => ({ label: l, op: 'pose.rotation_mode_set', props: { type: v } })), menuTitle: 'Set Rotation Mode', when: inPose },
  { key: 'F', alt: true, op: 'pose.quaternions_flip', when: inPose },
  { key: 'P', shift: true, op: 'pose.select_parent', when: inPose },
  { key: 'LEFT_BRACKET', shift: true, op: 'pose.select_hierarchy', props: { direction: 'PARENT', extend: true }, when: inPose },
  { key: 'RIGHT_BRACKET', shift: true, op: 'pose.select_hierarchy', props: { direction: 'CHILD', extend: true }, when: inPose },
  { key: 'L', ctrl: true, op: 'pose.select_linked', when: inPose },
  { key: 'L', op: 'pose.select_linked_pick', when: inPose },
  { key: 'L', shift: true, op: 'pose.select_linked_pick', props: { extend: true }, when: inPose },
  { key: 'G', shift: true, menu: groupedMenu, menuTitle: 'Select Grouped', when: inPose },
  { key: 'M', shift: true, ctrl: true, op: 'pose.select_mirror', when: inPose },
  { key: 'W', shift: true, menu: boneOptionsMenu('TOGGLE'), menuTitle: 'Toggle Bone Options', when: inPose },
  { key: 'W', shift: true, ctrl: true, menu: boneOptionsMenu('ENABLE'), menuTitle: 'Enable Bone Options', when: inPose },
  { key: 'W', alt: true, menu: boneOptionsMenu('DISABLE'), menuTitle: 'Disable Bone Options', when: inPose },
  { key: 'W', shift: true, alt: true, menu: selectionSetsMenu, menuTitle: 'Select Selection Set', when: inPose },
  { key: 'K', op: 'anim.keyframe_insert_menu', when: inPose },
  { key: 'K', shift: true, op: 'anim.keying_set_active_set', when: () => app.doc.mode === 'POSE' || app.doc.mode === 'OBJECT' },
  { key: 'H', shift: true, op: 'pose.hide', props: { unselected: true }, when: inPose },
]);

armatureDataPanels.push((o) => {
  const ob = o as ObSets;
  const list = ob.selection_sets ?? [];
  const pose = app.doc.mode === 'POSE' && app.activeObject === o;
  return panel('ar-selsets', 'Selection Sets', () => [
    uiList(
      'selsets',
      list.map((st) => ({ key: st.name, label: st.name, icon: 'bone_data' })),
      ob.active_selection_set ?? 0,
      (i) => ((ob.active_selection_set = i), app.changed('doc')),
      {
        add: pose ? () => app.run('pose.selection_set_add') : undefined,
        remove: pose ? () => app.run('pose.selection_set_remove') : undefined,
        up: pose ? () => app.run('pose.selection_set_move', { direction: 'UP' }) : undefined,
        down: pose ? () => app.run('pose.selection_set_move', { direction: 'DOWN' }) : undefined,
        rename: (i, name) => {
          if (!list[i] || !name) return;
          list[i].name = name;
          app.pushUndo('Rename Selection Set');
          app.changed('doc');
        },
      },
    ),
    pose && list.length
      ? h(
          'div',
          { class: 'btn-row' },
          opButton('pose.selection_set_assign', 'Assign'),
          opButton('pose.selection_set_unassign', 'Remove'),
          opButton('pose.selection_set_select', 'Select', { selection_set_index: -1 }),
          opButton('pose.selection_set_deselect', 'Deselect'),
        )
      : null,
  ]);
});

/** Prompt for a new selection set name (sidebar/properties helper). */
export function promptNewSelectionSet() {
  promptText('New Selection Set', 'SelectionSet', (v) => v && app.run('pose.selection_set_add_and_assign', { name: v }, { invoke: false }));
}

export { sets as selectionSets };
export type { SelectionSet };
