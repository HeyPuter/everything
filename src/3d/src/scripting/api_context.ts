// More bpy.context members (bones, paint objects, object data by type, tool settings,
// screen/area/region, sequencer and node selections) and context overrides:
// `with bpy.context.temp_override(active_object=ob, selected_objects=[ob]): …` in Python,
// `bpy.context.temp_override({active_object: ob}, () => { … })` in JavaScript.
import { app } from '../app/app';
import type { ObjectData } from '../data/types';
import { Context, DATA_TABLE, bpyData, sceneWrapper, wrapId } from './api';
import { PropCollection, Struct, isIdWrapper, mixin, pyError, touched, wrapField, type Raw } from './rna';

type Any = Record<string, unknown>;

const active = () => app.activeObject as ObjectData | null;
const armatureOf = (ob: ObjectData | null) => (ob?.type === 'ARMATURE' && ob.data ? app.doc.armatures[ob.data] : undefined);

function boneList(edit: boolean, which: 'all' | 'selected' | 'visible'): unknown[] {
  const ob = active();
  const arm = armatureOf(ob);
  if (!arm || !ob) return [];
  if (edit !== (app.doc.mode === 'EDIT')) return [];
  const coll = (wrapId('armatures', arm.id) as Any)[edit ? 'edit_bones' : 'bones'] as PropCollection;
  return (coll.list() as { name: string }[]).filter((b) => {
    const raw = arm.bones.find((x) => x.name === b.name);
    if (!raw) return false;
    if (which === 'selected') return edit ? !!(raw.select || raw.select_head || raw.select_tail) : !!ob.pose?.[raw.name]?.select || !!raw.select;
    if (which === 'visible') return !raw.hide;
    return true;
  });
}

function poseBones(which: 'selected' | 'visible'): unknown[] {
  const ob = active();
  if (!armatureOf(ob) || app.doc.mode !== 'POSE') return [];
  const pose = (wrapId('objects', ob!.id) as { pose: { bones: PropCollection } }).pose;
  const arm = armatureOf(ob)!;
  return (pose.bones.list() as { name: string }[]).filter((pb) => {
    const b = arm.bones.find((x) => x.name === pb.name);
    return which === 'visible' ? !b?.hide : !!(ob!.pose?.[pb.name]?.select || b?.select);
  });
}

const dataOfType = (type: string) => () => {
  const ob = active();
  if (!ob || (ob.type !== type && !(type === 'CURVE' && ob.type === 'FONT'))) return null;
  if (type === 'SPEAKER') return (wrapId('objects', ob.id) as Any).data;
  const t = DATA_TABLE[ob.type];
  return t && ob.data ? wrapId(t, ob.data) : null;
};

const area = () => app.hoverArea ?? app.activeArea;

class ContextExt {
  get active_bone() {
    const ob = active();
    const arm = armatureOf(ob);
    if (!arm?.active_bone) return null;
    const edit = app.doc.mode === 'EDIT';
    return ((wrapId('armatures', arm.id) as Any)[edit ? 'edit_bones' : 'bones'] as PropCollection).get(arm.active_bone, null);
  }
  get active_pose_bone() {
    const ob = active();
    const arm = armatureOf(ob);
    if (!arm?.active_bone || !ob?.pose?.[arm.active_bone]) return null;
    return ((wrapId('objects', ob.id) as { pose: { bones: PropCollection } }).pose.bones).get(arm.active_bone, null);
  }
  get bone() {
    return app.doc.mode === 'EDIT' ? null : (this as unknown as ContextExt).active_bone;
  }
  get edit_bone() {
    return app.doc.mode === 'EDIT' ? (this as unknown as ContextExt).active_bone : null;
  }
  get pose_bone() {
    return (this as unknown as ContextExt).active_pose_bone;
  }
  get selected_bones() {
    return boneList(app.doc.mode === 'EDIT', 'selected');
  }
  get selected_editable_bones() {
    return boneList(true, 'selected');
  }
  get editable_bones() {
    return boneList(true, 'all');
  }
  get visible_bones() {
    return boneList(app.doc.mode === 'EDIT', 'visible');
  }
  get selected_pose_bones() {
    return poseBones('selected');
  }
  get selected_pose_bones_from_active_object() {
    return poseBones('selected');
  }
  get visible_pose_bones() {
    return poseBones('visible');
  }
  get pose_object() {
    const ob = active();
    return ob?.type === 'ARMATURE' && app.doc.mode === 'POSE' ? wrapId('objects', ob.id) : null;
  }
  get sculpt_object() {
    return app.doc.mode === 'SCULPT' && active() ? wrapId('objects', active()!.id) : null;
  }
  get vertex_paint_object() {
    return app.doc.mode === 'VERTEX_PAINT' && active() ? wrapId('objects', active()!.id) : null;
  }
  get weight_paint_object() {
    return app.doc.mode === 'WEIGHT_PAINT' && active() ? wrapId('objects', active()!.id) : null;
  }
  get image_paint_object() {
    return app.doc.mode === 'TEXTURE_PAINT' && active() ? wrapId('objects', active()!.id) : null;
  }
  get particle_edit_object() {
    return null;
  }
  get mesh() {
    return dataOfType('MESH')();
  }
  get curve() {
    return dataOfType('CURVE')();
  }
  get armature() {
    return dataOfType('ARMATURE')();
  }
  get lattice() {
    return dataOfType('LATTICE')();
  }
  get camera() {
    return dataOfType('CAMERA')();
  }
  get light() {
    return dataOfType('LIGHT')();
  }
  get meta_ball() {
    return dataOfType('META')();
  }
  get grease_pencil() {
    return dataOfType('GREASEPENCIL')();
  }
  get speaker() {
    return dataOfType('SPEAKER')();
  }
  get world() {
    const w = app.doc.scene.world;
    return w && app.doc.worlds[w] ? wrapId('worlds', w) : null;
  }
  get material_slot() {
    const ob = active();
    if (!ob) return null;
    const slots = (wrapId('objects', ob.id) as { material_slots: unknown[] }).material_slots;
    return slots[ob.active_material_index] ?? null;
  }
  get object_data() {
    const ob = active();
    return ob ? (wrapId('objects', ob.id) as Any).data : null;
  }
  get tool_settings() {
    return wrapField(sceneWrapper as unknown as Struct, 'tool_settings', () => app.doc.scene as unknown as Raw);
  }
  get active_action() {
    const a = active()?.animation_data?.action;
    return a && app.doc.actions[a] ? wrapId('actions', a) : null;
  }
  get active_strip() {
    const ed = (sceneWrapper as unknown as { sequence_editor: Any | null }).sequence_editor;
    return ed ? ed.active_strip : null;
  }
  get active_sequence_strip() {
    return (this as unknown as ContextExt).active_strip;
  }
  get selected_strips() {
    const ed = (sceneWrapper as unknown as { sequence_editor: { strips_all: PropCollection } | null }).sequence_editor;
    return ed ? (ed.strips_all.list() as { select: boolean }[]).filter((s) => s.select) : [];
  }
  get selected_sequences() {
    return (this as unknown as ContextExt).selected_strips;
  }
  get selected_editable_strips() {
    return (this as unknown as ContextExt).selected_strips;
  }
  get region() {
    const a = area();
    if (!a) return null;
    const r = (a as unknown as { el?: HTMLElement }).el?.getBoundingClientRect?.();
    return { __kind: 'struct', __type: 'Region', type: 'WINDOW', width: Math.round(r?.width ?? 0), height: Math.round(r?.height ?? 0), x: Math.round(r?.left ?? 0), y: Math.round(r?.top ?? 0) };
  }
  get screen() {
    return { __kind: 'struct', __type: 'Screen', name: 'Layout', areas: [area()].filter(Boolean).map((a) => ({ __kind: 'struct', __type: 'Area', type: a!.type, ui_type: a!.type })), is_animation_playing: !!app.playing };
  }
  get window() {
    const self = this as unknown as Context;
    return { __kind: 'struct', __type: 'Window', screen: (self as unknown as ContextExt).screen, scene: sceneWrapper, view_layer: self.view_layer, workspace: (self as unknown as ContextExt).workspace };
  }
  get workspace() {
    return { __kind: 'struct', __type: 'WorkSpace', name: 'Layout' };
  }
  get active_operator() {
    const op = app.lastOp;
    return op ? { __kind: 'struct', __type: 'Operator', bl_idname: op.idname, name: op.label, properties: { __kind: 'struct', __type: 'OperatorProperties', ...op.props } } : null;
  }
  get blend_data() {
    return bpyData;
  }
  /** Runs `fn` with these context members overridden (object, active_object, selected_objects, …). */
  temp_override(overrides: unknown = {}, fn?: () => unknown) {
    const self = this as unknown as ContextExt;
    if (typeof overrides === 'function') {
      fn = overrides as () => unknown;
      overrides = {};
    }
    if (typeof fn !== 'function') throw pyError('TypeError', 'temp_override(): in JavaScript pass the overrides and a function to run: bpy.context.temp_override({active_object: ob}, () => { … })');
    self.temp_override_begin(overrides);
    try {
      return fn();
    } finally {
      self.temp_override_end();
    }
  }
  temp_override_begin(overrides: unknown) {
    overrideStack.push(applyOverride((overrides ?? {}) as Any));
  }
  temp_override_end() {
    const restore = overrideStack.pop();
    restore?.();
  }
}
mixin(Context, ContextExt, true);

const overrideStack: (() => void)[] = [];

const OVERRIDE_KEYS = new Set(['object', 'active_object', 'edit_object', 'selected_objects', 'selected_editable_objects', 'window', 'area', 'region', 'screen', 'scene', 'view_layer', 'workspace', 'space_data', 'blend_data', 'collection', 'mode']);

/** Applies an override (active object and selection are set on the scene); returns how to undo it. */
function applyOverride(o: Any): () => void {
  for (const k of Object.keys(o)) if (!OVERRIDE_KEYS.has(k)) throw pyError('TypeError', `temp_override(): unsupported keyword "${k}" (supported: ${[...OVERRIDE_KEYS].join(', ')})`);
  const d = app.doc;
  const prevActive = d.scene.active_object;
  const prevSel = Object.values(d.objects)
    .filter((ob) => ob.select)
    .map((ob) => ob.id);
  const act = o.active_object ?? o.object ?? o.edit_object;
  const sel = o.selected_objects ?? o.selected_editable_objects;
  let changed = false;
  if (act !== undefined) {
    if (act !== null && !(isIdWrapper(act) && act.__table === 'objects')) throw pyError('TypeError', 'temp_override(): active_object must be an Object or None');
    d.scene.active_object = act ? (act as { __id: string }).__id : null;
    changed = true;
  }
  if (sel !== undefined) {
    const ids = new Set([...(sel as Iterable<unknown>)].map((x) => (isIdWrapper(x) ? x.__id : null)).filter(Boolean) as string[]);
    for (const ob of Object.values(d.objects)) ob.select = ids.has(ob.id);
    changed = true;
  }
  if (changed) touched('select');
  return () => {
    if (!changed) return;
    if (app.doc !== d) return;
    d.scene.active_object = prevActive && d.objects[prevActive] ? prevActive : null;
    const keep = new Set(prevSel);
    for (const ob of Object.values(d.objects)) ob.select = keep.has(ob.id);
    touched('select');
  };
}

