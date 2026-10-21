// Armature Edit Mode operators: extrude forked, fill, split, separate, dissolve, selection
// (mirror, more/less, linked, similar, hierarchy), names (flip, auto-side), hide/reveal, bone
// options, interactive roll / envelope distance, and X-Axis Mirror.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators, onAppReady, operators, registerOperator, type OpContext } from '../../app/app';
import { promptText } from '../../ui/menu';
import { activeElementHooks } from '../editxform';
import { activeView3D, type View3D } from '../../editors/view3d/view3d';
import { startTransform } from '../../ops/transform';
import { newArmature, newObject } from '../../data/defaults';
import { uniqueName } from '../../ops/object';
import type { ArmatureData, Bone, ObjectData, PoseBone, Vec3 } from '../../data/types';
import { activeArmature, ensurePose, pickBone, newBone, forkedMirror, syncConnected } from './armature';
import { transformModes } from '../transformmodes';
import { startValueModal } from '../valuemodal';
import * as A from './armkernels';
import { objectCurves } from '../../anim/slots';

const inArmEdit = () => app.doc.mode === 'EDIT' && !!activeArmature();
const poll = () => inArmEdit();
const arm = () => activeArmature()!.arm;
const visible = (b: Bone) => A.boneVisible(arm(), b);
const anySel = () => inArmEdit() && arm().bones.some((b) => visible(b) && (b.select || b.select_head || b.select_tail));
const world = (ob: ObjectData) => app.graph.get(ob.id)?.world ?? new Matrix4();

function viewMouse(ctx: OpContext): { v: View3D; x: number; y: number } | null {
  const v = (ctx.area?.editor as View3D | undefined) ?? activeView3D();
  if (!v || !(v as unknown as { project?: unknown }).project) return null;
  const r = v.el.getBoundingClientRect();
  const e = ctx.event ?? app.pointer;
  return { v, x: e.x - r.left, y: e.y - r.top };
}

/** Apply bone renames to everything that refers to bones by name. */
export function applyRenames(ob: ObjectData, changes: Map<string, string>) {
  if (!changes.size) return;
  if (ob.pose) {
    const next: Record<string, PoseBone> = {};
    for (const [n, pb] of Object.entries(ob.pose)) next[changes.get(n) ?? n] = pb;
    ob.pose = next;
  }
  for (const o of Object.values(app.doc.objects)) {
    if (o.type !== 'MESH' || !o.data || !o.modifiers.some((m) => m.type === 'ARMATURE' && m.object === ob.id)) continue;
    const me = app.doc.meshes[o.data];
    const old = me.vertex_groups.map((g) => g.name);
    me.vertex_groups.forEach((g, i) => (g.name = changes.get(old[i]) ?? g.name));
  }
  for (const fc of objectCurves(app.doc, ob)) {
    const m = /^pose\.bones\["(.*?)"\]/.exec(fc.data_path);
    if (m && changes.has(m[1])) fc.data_path = fc.data_path.replace(`pose.bones["${m[1]}"]`, `pose.bones["${changes.get(m[1])}"]`);
    if (fc.group && changes.has(fc.group)) fc.group = changes.get(fc.group)!;
  }
  // constraints targeting the renamed bones
  for (const o of Object.values(app.doc.objects)) {
    const lists = [o.constraints ?? [], ...Object.values(o.pose ?? {}).map((pb) => pb.constraints)];
    for (const cs of lists) for (const c of cs) if (c.target === ob.id && c.subtarget && changes.has(c.subtarget)) c.subtarget = changes.get(c.subtarget)!;
  }
}

function clearSelection(a: ArmatureData) {
  for (const b of a.bones) A.setBoneSelected(b, false);
}

registerOperators([
  {
    idname: 'armature.extrude_forked',
    label: 'Extrude Forked',
    description: 'Extrude two mirrored bones (.L / .R) from each selected tail',
    poll: anySel,
    invoke: (ctx) => {
      const { ob, arm: a } = activeArmature()!;
      const tails = a.bones.filter((b) => visible(b) && b.select_tail);
      if (!tails.length) return 'CANCELLED';
      const created: Bone[] = [];
      forkedMirror.clear();
      for (const t of tails) {
        const base = A.stripSide(t.name);
        const l = newBone(a, `${base}.L`, t.tail, t.tail, t.name, true);
        const r = newBone(a, `${base}.R`, t.tail, t.tail, t.name, true);
        created.push(l);
        // only the left one is moved; its twin follows mirrored
        if (A.flipSideName(l.name) === r.name) forkedMirror.add(l.name);
        else created.push(r);
      }
      clearSelection(a);
      for (const c of created) c.select_tail = true;
      a.active_bone = created[created.length - 1].name;
      ensurePose(ob, a);
      app.changed('doc');
      app.flush();
      startTransform('TRANSLATION', { event: ctx.event, label: 'Extrude Forked' });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'armature.fill',
    label: 'Fill Between Joints',
    description: 'Add a bone between two selected joints, or from one selected joint to the 3D cursor',
    poll: anySel,
    exec: (ctx) => {
      const { ob, arm: a } = activeArmature()!;
      const cursor = new Vector3(...ctx.doc.scene.cursor.location).applyMatrix4(world(ob).clone().invert());
      const nb = A.fillJoints(a, [cursor.x, cursor.y, cursor.z], visible);
      if (!nb) {
        app.report('ERROR', 'Select one or two joints');
        return 'CANCELLED';
      }
      ensurePose(ob, a);
    },
  },
  {
    idname: 'armature.split',
    label: 'Split',
    description: 'Disconnect the selected bones from the unselected ones',
    poll: anySel,
    exec: () => (A.splitBones(arm()) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'armature.dissolve',
    label: 'Dissolve Selected Bone(s)',
    description: 'Merge selected bones into their connected chain, keeping its shape',
    poll: anySel,
    exec: () => {
      const { ob, arm: a } = activeArmature()!;
      if (!A.dissolveBones(a).length) return 'CANCELLED';
      ensurePose(ob, a);
    },
  },
  {
    idname: 'armature.separate',
    label: 'Separate Bones',
    description: 'Move the selected bones into a new armature object',
    poll: anySel,
    exec: (ctx) => {
      const { ob, arm: a } = activeArmature()!;
      const moving = a.bones.filter((b) => b.select);
      if (!moving.length || moving.length === a.bones.length) {
        app.report('ERROR', moving.length ? 'Cannot separate all bones' : 'No bones selected');
        return 'CANCELLED';
      }
      const names = new Set(moving.map((b) => b.name));
      const na = newArmature(uniqueName(ctx.doc, a.name, 'armatures'));
      Object.assign(na, { display_type: a.display_type, pose_position: a.pose_position, show_names: a.show_names, show_axes: a.show_axes, show_in_front: a.show_in_front });
      na.bones = moving.map((b) => ({ ...structuredClone(b), parent: b.parent && names.has(b.parent) ? b.parent : null, use_connect: !!(b.parent && names.has(b.parent) && b.use_connect) }));
      const used = new Set(na.bones.flatMap((b) => b.collections ?? []));
      na.collections = (a.collections ?? []).filter((c) => used.has(c.name)).map((c) => ({ ...c }));
      na.active_bone = na.bones.find((b) => b.name === a.active_bone)?.name ?? na.bones[0].name;
      a.bones = a.bones.filter((b) => !names.has(b.name));
      for (const b of a.bones)
        if (b.parent && names.has(b.parent)) {
          b.parent = null;
          b.use_connect = false;
        }
      if (a.active_bone && names.has(a.active_bone)) a.active_bone = null;
      ctx.doc.armatures[na.id] = na;
      const no = newObject(uniqueName(ctx.doc, ob.name), 'ARMATURE', na.id);
      for (const k of ['location', 'rotation_euler', 'scale'] as const) no[k] = [...ob[k]] as Vec3;
      no.rotation_quaternion = [...ob.rotation_quaternion] as typeof no.rotation_quaternion;
      no.rotation_mode = ob.rotation_mode;
      no.parent = ob.parent;
      no.matrix_parent_inverse = [...ob.matrix_parent_inverse];
      no.pose = {};
      for (const b of na.bones) if (ob.pose?.[b.name]) no.pose[b.name] = structuredClone(ob.pose[b.name]);
      ctx.doc.objects[no.id] = no;
      ctx.doc.object_order.push(no.id);
      for (const c of Object.values(ctx.doc.collections)) if (c.objects.includes(ob.id)) c.objects.push(no.id);
      ensurePose(ob, a);
      ensurePose(no, na);
    },
  },
  // ---- selection
  {
    idname: 'armature.select_mirror',
    label: 'Select Mirror',
    description: 'Select the mirrored counterparts (.L ↔ .R) of the selected bones',
    props: [{ id: 'extend', label: 'Extend', type: 'bool', default: false }],
    poll,
    exec: (_c, p) => A.selectMirror(arm(), !!p.extend),
  },
  {
    idname: 'armature.select_more',
    label: 'Select More',
    description: 'Also select the parents and children of the selected bones',
    poll,
    exec: () => A.selectMore(arm(), visible),
  },
  {
    idname: 'armature.select_less',
    label: 'Select Less',
    description: 'Deselect the bones at the border of the selection',
    poll,
    exec: () => A.selectLess(arm()),
  },
  {
    idname: 'armature.select_linked',
    label: 'Select Linked All',
    description: 'Select all bones connected to the selected ones',
    props: [{ id: 'all_forks', label: 'All Forks', type: 'bool', default: false }],
    poll,
    exec: (_c, p) => {
      const a = arm();
      const seeds = a.bones.filter((b) => b.select || b.select_head || b.select_tail);
      for (const b of A.linkedBones(a, seeds, !!p.all_forks)) if (visible(b)) A.setBoneSelected(b, true);
    },
  },
  {
    idname: 'armature.select_linked_pick',
    label: 'Select Linked',
    description: 'Select (or deselect) the bones connected to the bone under the mouse',
    props: [
      { id: 'deselect', label: 'Deselect', type: 'bool', default: false },
      { id: 'all_forks', label: 'All Forks', type: 'bool', default: false },
      { id: 'bone', label: 'Bone', type: 'string', default: '', hidden: true },
    ],
    poll,
    invoke: (ctx, p) => {
      const m = viewMouse(ctx);
      const hit = m ? pickBone(m.v, m.x, m.y, false) : null;
      if (!hit) return 'CANCELLED';
      app.run('armature.select_linked_pick', { ...p, bone: hit.bone.name }, { invoke: false });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const a = arm();
      const seed = a.bones.find((b) => b.name === p.bone);
      if (!seed) return 'CANCELLED';
      for (const b of A.linkedBones(a, [seed], !!p.all_forks)) if (visible(b)) A.setBoneSelected(b, !p.deselect);
      if (!p.deselect) a.active_bone = seed.name;
    },
  },
  {
    idname: 'armature.select_similar',
    label: 'Select Similar',
    description: 'Select bones similar to the active one',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'LENGTH',
        items: [
          ['LENGTH', 'Length'],
          ['DIRECTION', 'Direction (Y Axis)'],
          ['PREFIX', 'Prefix'],
          ['SUFFIX', 'Suffix'],
          ['BONE_COLLECTION', 'Bone Collection'],
          ['CHILDREN', 'Children'],
          ['CHILDREN_IMMEDIATE', 'Immediate Children'],
          ['SIBLINGS', 'Siblings'],
        ],
      },
      { id: 'threshold', label: 'Threshold', type: 'float', default: 0.1, min: 0, max: 1, subtype: 'factor' },
    ],
    poll: anySel,
    exec: (_c, p) => (A.selectSimilar(arm(), p.type as A.SimilarType, p.threshold as number, visible) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'armature.select_hierarchy',
    label: 'Select Hierarchy',
    description: 'Select the parent or the children of the active bone',
    props: [
      { id: 'direction', label: 'Direction', type: 'enum', default: 'PARENT', items: [['PARENT', 'Select Parent'], ['CHILD', 'Select Child']] },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: () => inArmEdit() && !!arm().active_bone,
    exec: (_c, p) => {
      const a = arm();
      const act = a.bones.find((b) => b.name === a.active_bone);
      if (!act) return 'CANCELLED';
      const next = (p.direction === 'PARENT' ? a.bones.filter((b) => b.name === act.parent) : A.childrenOf(a, act)).filter(visible);
      if (!next.length) return 'CANCELLED';
      if (!p.extend) clearSelection(a);
      for (const b of next) A.setBoneSelected(b, true);
      a.active_bone = next[0].name;
    },
  },
  // ---- names
  {
    idname: 'armature.flip_names',
    label: 'Flip Names',
    description: 'Swap the side markers (.L / .R, Left / Right) in the names of the selected bones',
    props: [{ id: 'do_strip_numbers', label: 'Strip Numbers', type: 'bool', default: false }],
    poll: anySel,
    exec: (_c, p) => {
      const { ob, arm: a } = activeArmature()!;
      const wanted = new Map<Bone, string>();
      for (const b of a.bones) {
        if (!b.select) continue;
        let n = A.flipSideName(b.name);
        if (p.do_strip_numbers) n = n.replace(/\.\d+$/, '');
        if (n !== b.name) wanted.set(b, n);
      }
      if (!wanted.size) return 'CANCELLED';
      applyRenames(ob, A.renameBones(a, wanted));
    },
  },
  {
    idname: 'armature.autoside_names',
    label: 'Auto-Name by Axis',
    description: 'Name the selected bones by their side of an axis (.L / .R, .Fr / .Bk, .Top / .Bot)',
    props: [{ id: 'type', label: 'Axis', type: 'enum', default: 'XAXIS', items: [['XAXIS', 'X-Axis'], ['YAXIS', 'Y-Axis'], ['ZAXIS', 'Z-Axis']] }],
    poll: anySel,
    exec: (_c, p) => {
      const { ob, arm: a } = activeArmature()!;
      const wanted = new Map<Bone, string>();
      for (const b of a.bones) if (b.select) wanted.set(b, A.autoSideName(b, p.type as 'XAXIS'));
      applyRenames(ob, A.renameBones(a, wanted));
    },
  },
  // ---- visibility
  {
    idname: 'armature.hide',
    label: 'Hide Selected',
    description: 'Hide the selected (or unselected) bones',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll,
    exec: (_c, p) => {
      const a = arm();
      for (const b of a.bones) {
        const sel = !!(b.select || b.select_head || b.select_tail);
        if (sel === !!p.unselected || !visible(b)) continue;
        b.hide = true;
        A.setBoneSelected(b, false);
      }
      syncConnected(a);
    },
  },
  {
    idname: 'armature.reveal',
    label: 'Reveal Hidden',
    description: 'Show all hidden bones',
    props: [{ id: 'select', label: 'Select', type: 'bool', default: true }],
    poll,
    exec: (_c, p) => {
      for (const b of arm().bones)
        if (b.hide) {
          b.hide = false;
          if (p.select) A.setBoneSelected(b, true);
        }
    },
  },
  {
    idname: 'armature.symmetrize',
    label: 'Symmetrize',
    description: 'Create or update the mirrored counterparts (.L ↔ .R) of the selected bones',
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'NEGATIVE_X', items: [['NEGATIVE_X', '-X to +X'], ['POSITIVE_X', '+X to -X']] }],
    poll: anySel,
    exec: (_c, p) => {
      const { ob, arm: a } = activeArmature()!;
      const map = new Map(a.bones.map((b) => [b.name, b]));
      const src = a.bones.filter((b) => {
        if (!b.select || A.flipSideName(b.name) === b.name) return false;
        // when both sides are selected, the direction decides which one is copied
        const twin = map.get(A.flipSideName(b.name));
        if (!twin?.select) return true;
        const x = (b.head[0] + b.tail[0]) / 2;
        return p.direction === 'NEGATIVE_X' ? x <= 1e-6 : x >= -1e-6;
      });
      const mirrored = new Map<Bone, Bone>();
      for (const b of src) {
        const name = A.flipSideName(b.name);
        let m = map.get(name);
        if (!m) {
          m = newBone(a, name, b.head, b.tail, null, false, b);
          map.set(name, m);
        }
        m.head = [-b.head[0], b.head[1], b.head[2]];
        m.tail = [-b.tail[0], b.tail[1], b.tail[2]];
        m.roll = -b.roll;
        for (const k of ['use_deform', 'use_inherit_rotation', 'inherit_scale', 'envelope_distance', 'head_radius', 'tail_radius', 'bbone_segments'] as const) (m as unknown as Record<string, unknown>)[k] = b[k];
        mirrored.set(b, m);
      }
      // parents: mirrored parent when there is one, else the same (centre) parent
      for (const [b, m] of mirrored) {
        const pName = b.parent ? A.flipSideName(b.parent) : null;
        m.parent = b.parent ? (map.has(pName!) ? pName : b.parent) : null;
        m.use_connect = b.use_connect && !!m.parent;
        if (m.use_connect) {
          const par = map.get(m.parent!);
          if (par) m.head = [...par.tail] as Vec3;
        }
      }
      if (!mirrored.size) return 'CANCELLED';
      ensurePose(ob, a);
    },
  },
]);

// ---------------------------------------------------------------------------
// bone options (Shift W / Shift Ctrl W / Alt W)

const BONE_OPTIONS: [string, string][] = [
  ['show_wire', 'Display Wire'],
  ['use_deform', 'Deform'],
  ['use_inherit_rotation', 'Inherit Rotation'],
  ['use_connect', 'Connected'],
];

registerOperators([
  {
    idname: 'wm.context_collection_boolean_set',
    label: 'Context Collection Boolean Set',
    description: 'Set a boolean property on every selected bone',
    props: [
      { id: 'data_path_iter', label: 'Iterator', type: 'string', default: 'selected_editable_bones' },
      { id: 'data_path_item', label: 'Property', type: 'string', default: 'use_deform' },
      { id: 'type', label: 'Type', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['ENABLE', 'Enable'], ['DISABLE', 'Disable']] },
    ],
    poll: () => !!activeArmature() && (app.doc.mode === 'EDIT' || app.doc.mode === 'POSE'),
    exec: (_c, p) => {
      const { ob, arm: a } = activeArmature()!;
      const key = p.data_path_item as string;
      if (!BONE_OPTIONS.some(([k]) => k === key)) return 'CANCELLED';
      const sel = a.bones.filter((b) => (app.doc.mode === 'POSE' ? ob.pose?.[b.name]?.select : b.select) && visible(b));
      if (!sel.length) return 'CANCELLED';
      const rec = (b: Bone) => b as unknown as Record<string, boolean>;
      const on = p.type === 'ENABLE' ? true : p.type === 'DISABLE' ? false : !sel.every((b) => !!rec(b)[key]);
      for (const b of sel) {
        if (key === 'use_connect' && !b.parent) continue;
        rec(b)[key] = on;
        if (key === 'use_connect' && on) {
          const par = a.bones.find((x) => x.name === b.parent);
          if (par) b.head = [...par.tail] as Vec3;
        }
      }
    },
  },
]);

export function boneOptionsMenu(type: 'TOGGLE' | 'ENABLE' | 'DISABLE') {
  return BONE_OPTIONS.map(([k, l]) => ({ label: l, op: 'wm.context_collection_boolean_set', props: { data_path_iter: app.doc.mode === 'POSE' ? 'selected_bones' : 'selected_editable_bones', data_path_item: k, type } }));
}

// ---------------------------------------------------------------------------
// interactive roll (Ctrl R) and envelope distance (Alt S)

function selectedBones() {
  const a = activeArmature();
  if (!a) return [];
  return a.arm.bones.filter((b) => visible(b) && (b.select || (b.select_head && b.select_tail)));
}

function bonesPivot(bones: Bone[]) {
  const { ob } = activeArmature()!;
  const w = world(ob);
  const c = new Vector3();
  for (const b of bones) c.add(new Vector3(...b.head).add(new Vector3(...b.tail)).multiplyScalar(0.5));
  return c.multiplyScalar(1 / Math.max(1, bones.length)).applyMatrix4(w);
}

transformModes.BONE_ROLL = {
  label: 'Roll',
  poll: () => inArmEdit() && selectedBones().length > 0,
  invoke: (ctx, p) => {
    const bones = selectedBones();
    const before = bones.map((b) => b.roll);
    return startValueModal({
      label: 'Roll',
      kind: 'ANGLE',
      pivot: bonesPivot(bones),
      event: ctx.event,
      apply: (v) => bones.forEach((b, i) => (b.roll = before[i] + v)),
      restore: () => bones.forEach((b, i) => (b.roll = before[i])),
      redo: (v) => ({ idname: 'transform.transform', props: { mode: 'BONE_ROLL', value: v } }),
      text: (v, t) => `Roll: ${t ? t + '|' : ((v * 180) / Math.PI).toFixed(2) + '°'}`,
      releaseConfirm: !!p.release_confirm,
    })
      ? 'RUNNING_MODAL'
      : 'CANCELLED';
  },
  exec: (_c, p) => {
    for (const b of selectedBones()) b.roll += p.value as number;
  },
};

transformModes.BONE_ENVELOPE_DIST = {
  label: 'Envelope Distance',
  poll: () => inArmEdit() && selectedBones().length > 0,
  invoke: (ctx, p) => {
    const bones = selectedBones();
    const before = bones.map((b) => b.envelope_distance);
    return startValueModal({
      label: 'Envelope Distance',
      kind: 'SCALE',
      pivot: bonesPivot(bones),
      event: ctx.event,
      apply: (v) => bones.forEach((b, i) => (b.envelope_distance = Math.max(0, before[i] * v))),
      restore: () => bones.forEach((b, i) => (b.envelope_distance = before[i])),
      redo: (v) => ({ idname: 'transform.transform', props: { mode: 'BONE_ENVELOPE_DIST', value: v } }),
      text: (v, t) => `Envelope: ${t ? t + '|' : v.toFixed(3)}`,
      releaseConfirm: !!p.release_confirm,
    })
      ? 'RUNNING_MODAL'
      : 'CANCELLED';
  },
  exec: (_c, p) => {
    for (const b of selectedBones()) b.envelope_distance = Math.max(0, b.envelope_distance * (p.value as number));
  },
};

// ---------------------------------------------------------------------------
// Select Pattern also matches bone names in armature Edit Mode (and asks for the pattern)

/** Glob-style name match (* and ?). */
export function patternMatcher(pattern: string, caseSensitive: boolean) {
  const src = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${src}$`, caseSensitive ? '' : 'i');
}

onAppReady(() => {
  const prev = operators.get('object.select_pattern');
  if (!prev) return;
  registerOperator({
    ...prev,
    poll: (ctx) => inArmEdit() || !prev.poll || prev.poll(ctx),
    invoke: (_ctx, p) => {
      promptText('Select Pattern', String(p.pattern ?? '*'), (v) => v && app.run('object.select_pattern', { ...p, pattern: v }, { invoke: false }));
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      if (!inArmEdit()) return prev.exec ? prev.exec(ctx, p) : 'CANCELLED';
      const re = patternMatcher(String(p.pattern), !!p.case_sensitive);
      for (const b of arm().bones) {
        if (!visible(b)) continue;
        if (re.test(b.name)) A.setBoneSelected(b, true);
        else if (!p.extend) A.setBoneSelected(b, false);
      }
    },
  });
});

activeElementHooks.push(() => {
  if (!inArmEdit()) return null;
  const { ob, arm: a } = activeArmature()!;
  const b = a.bones.find((x) => x.name === a.active_bone && visible(x));
  return b ? new Vector3(...b.head).applyMatrix4(world(ob)) : null;
});

registerOperators([
  {
    idname: 'transform.bbone_resize',
    label: 'Scale B-Bone',
    description: 'Scale the B-Bone display size of the selected bones',
    props: [
      { id: 'value', label: 'Scale', type: 'float', default: 1, min: 0 },
      { id: 'release_confirm', label: 'Confirm on Release', type: 'bool', default: false, hidden: true },
    ],
    poll: () => inArmEdit() && selectedBones().length > 0,
    invoke: (ctx, p) => {
      const bones = selectedBones();
      const len = (b: Bone) => new Vector3(...b.tail).distanceTo(new Vector3(...b.head));
      const before = bones.map((b) => [b.bbone_x ?? 0.1 * len(b), b.bbone_z ?? 0.1 * len(b)]);
      return startValueModal({
        label: 'Scale B-Bone',
        kind: 'SCALE',
        pivot: bonesPivot(bones),
        event: ctx.event,
        apply: (v) => bones.forEach((b, i) => ((b.bbone_x = Math.max(0, before[i][0] * v)), (b.bbone_z = Math.max(0, before[i][1] * v)))),
        restore: () => bones.forEach((b, i) => ((b.bbone_x = before[i][0]), (b.bbone_z = before[i][1]))),
        redo: (v) => ({ idname: 'transform.bbone_resize', props: { value: v } }),
        text: (v, t) => `Scale B-Bone: ${t ? t + '|' : v.toFixed(3)}`,
        releaseConfirm: !!p.release_confirm,
      })
        ? 'RUNNING_MODAL'
        : 'CANCELLED';
    },
    exec: (_c, p) => {
      for (const b of selectedBones()) {
        const len = new Vector3(...b.tail).distanceTo(new Vector3(...b.head));
        b.bbone_x = Math.max(0, (b.bbone_x ?? 0.1 * len) * (p.value as number));
        b.bbone_z = Math.max(0, (b.bbone_z ?? 0.1 * len) * (p.value as number));
      }
    },
  },
]);
