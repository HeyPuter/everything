// Generic operators that read and write one setting addressed by a context data path, such as
// "tool_settings.use_snap", "space_data.show_region_ui", "object.data.energy" or
// "preferences.inputs.ndof_translation_sensitivity". Key bindings, menus and scripts use them to
// toggle, cycle, set and scale settings without a dedicated operator for each one.
import { activeViewLayer } from '../scenes/viewlayers';
import { app, operators, registerOperators, onAppReady, type Operator, type PropDef } from '../app/app';
import { prefs, type Preferences } from '../app/prefs';
import { setPref } from '../prefs/store';
import { resolve, tokenize } from '../data/rna';
import type { ObjectData } from '../data/types';
import { openMenu, openPie, type MenuItem, type PieItem } from '../ui/menu';
import { findBinding } from '../ui/binding';
import { editorTypes } from '../ui/screen';
import { cycleInt, cycleItem, enumLabel, parseContextValue, rotateArray, scaleValue } from './wm_context_core';

type Rec = Record<string, unknown>;
type Scope = 'doc' | 'ui' | 'prefs';

/** A setting found from a context path: `owner[key]`, and what changing it affects. */
export interface ContextRef {
  owner: Rec;
  key: string;
  scope: Scope;
  path: string;
}

const DATA_TABLES: Record<string, string> = { MESH: 'meshes', CURVE: 'curves', FONT: 'curves', SURFACE: 'curves', LIGHT: 'lights', CAMERA: 'cameras', ARMATURE: 'armatures', LATTICE: 'lattices', META: 'metaballs', GREASEPENCIL: 'grease_pencils', SPEAKER: 'speakers', CURVES: 'hair_curves', POINTCLOUD: 'pointclouds' };

function table(name: string): Record<string, Rec> | undefined {
  return (app.doc as unknown as Record<string, Record<string, Rec>>)[name];
}

function objectData(ob: ObjectData | null): Rec | null {
  const t = ob ? DATA_TABLES[ob.type] : undefined;
  return t && ob?.data ? (table(t)?.[ob.data] ?? null) : null;
}

/** A data-block with this id in any table (ids are unique across the document). */
function lookupId(id: string): Rec | null {
  for (const [k, t] of Object.entries(app.doc as unknown as Record<string, unknown>)) {
    if (k === 'scene' || !t || typeof t !== 'object' || Array.isArray(t)) continue;
    const rec = (t as Record<string, unknown>)[id];
    if (rec && typeof rec === 'object' && (rec as Rec).id === id) return rec as Rec;
  }
  return null;
}

const hovered = () => (app.hoverArea ?? app.activeArea) as unknown as { type: string; editor: Rec; setType?: (t: string) => void } | null;

// ---------------------------------------------------------------------------
// space_data: the editor under the pointer, with its settings under their scripting names

const SPACE_ALIASES: Record<string, string[]> = {
  show_region_toolbar: ['showToolbar'],
  show_region_ui: ['showSidebar'],
  show_region_tool_props: ['showSidebar'],
  show_region_channels: ['showChannels', 'showLeft'],
  show_gizmo: ['showGizmos', 'showGizmo'],
  show_overlays: ['showOverlays'],
  font_size: ['fontSize'],
};
const TOGGLERS: Record<string, string> = { showSidebar: 'toggleSidebar', showToolbar: 'toggleToolbar' };
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function spaceField(ed: Rec, name: string): string | null {
  for (const c of [...(SPACE_ALIASES[name] ?? []), name, camel(name)]) if (c in ed && typeof ed[c] !== 'function') return c;
  return null;
}

/** Editors keep some display switches in an overlay settings object: find the one that has `name`. */
function overlayOwner(ed: Rec, name: string): Rec | null {
  for (const k of ['overlay', 'overlays']) {
    const o = ed[k];
    if (o && typeof o === 'object' && name in (o as Rec)) return o as Rec;
  }
  return null;
}

/** Redraw an editor after one of its settings changed. */
export function refreshEditor(ed: Rec | undefined) {
  if (!ed) return;
  for (const m of ['layout', 'refresh', 'drawSvg'] as const) {
    const f = ed[m];
    if (typeof f === 'function') {
      try {
        (f as () => void).call(ed);
      } catch {
        // a partial redraw is fine; the next update repaints
      }
    }
  }
  app.changed('ui', 'view');
}

function spaceProxy(ed: Rec): Rec {
  return new Proxy({} as Rec, {
    has: (_t, k) => typeof k === 'string' && (spaceField(ed, k) !== null || k === 'type' || k === 'overlay' || !!overlayOwner(ed, k)),
    get(_t, k) {
      if (typeof k !== 'string') return undefined;
      if (k === 'type') return hovered()?.type;
      const f = spaceField(ed, k);
      if (f) return ed[f];
      // editors without an overlay settings object keep their overlay switches on the editor itself
      if (k === 'overlay') return spaceProxy(ed);
      return overlayOwner(ed, k)?.[k];
    },
    set(_t, k, v) {
      if (typeof k !== 'string') return false;
      const f = spaceField(ed, k);
      if (!f) {
        const o = overlayOwner(ed, k);
        if (!o) return false;
        o[k] = v;
        return true;
      }
      const toggler = TOGGLERS[f];
      if (toggler && typeof ed[toggler] === 'function') {
        if (!!ed[f] !== !!v) (ed[toggler] as () => void).call(ed);
        return true;
      }
      ed[f] = v;
      return true;
    },
  });
}

/** Scripting names of editor types that differ from ours. */
const AREA_TYPES: Record<string, string> = { GRAPH_EDITOR: 'GRAPH', DOPESHEET_EDITOR: 'DOPESHEET', NLA_EDITOR: 'NLA', TEXT_EDITOR: 'TEXT', NODE_EDITOR: 'SHADER', SEQUENCE_EDITOR: 'SEQUENCER', CLIP_EDITOR: 'CLIP', ShaderNodeTree: 'SHADER', GeometryNodeTree: 'GEOMETRY', CompositorNodeTree: 'COMPOSITOR' };

function areaProxy(): Rec | null {
  const a = hovered();
  if (!a) return null;
  return {
    get type() {
      return a.type;
    },
    set type(v: unknown) {
      const t = AREA_TYPES[String(v)] ?? String(v);
      if (editorTypes.has(t as never) && a.setType) a.setType(t);
    },
    get ui_type() {
      return a.type;
    },
    set ui_type(v: unknown) {
      (this as Rec).type = v;
    },
  };
}

// ---------------------------------------------------------------------------
// preferences: sections (view, inputs, edit, system, …) are flattened onto the preference keys

function prefsProxy(): Rec {
  const self: Rec = new Proxy({} as Rec, {
    has: () => true,
    get: (_t, k) => (typeof k !== 'string' ? undefined : k in prefs ? (prefs as unknown as Rec)[k] : self),
    set: (_t, k, v) => {
      if (typeof k !== 'string' || !(k in prefs)) return false;
      setPref(k as keyof Preferences, v as never);
      return true;
    },
  });
  return self;
}

// ---------------------------------------------------------------------------
// path resolution

function activeIf(ok: boolean): ObjectData | null {
  return ok ? app.activeObject : null;
}

const OBJECT_ROOTS: Record<string, () => ObjectData | null> = {
  object: () => app.activeObject,
  active_object: () => app.activeObject,
  edit_object: () => activeIf(app.doc.mode === 'EDIT'),
  sculpt_object: () => activeIf(app.doc.mode === 'SCULPT'),
  vertex_paint_object: () => activeIf(app.doc.mode === 'VERTEX_PAINT'),
  weight_paint_object: () => activeIf(app.doc.mode === 'WEIGHT_PAINT'),
  image_paint_object: () => activeIf(app.doc.mode === 'TEXTURE_PAINT'),
  particle_edit_object: () => activeIf(app.doc.mode === 'PARTICLE_EDIT'),
  pose_object: () => activeIf(app.doc.mode === 'POSE' && app.activeObject?.type === 'ARMATURE'),
};

const DATA_ROOTS: Record<string, string[]> = { mesh: ['MESH'], curve: ['CURVE', 'FONT', 'SURFACE'], armature: ['ARMATURE'], camera: ['CAMERA'], light: ['LIGHT'], lattice: ['LATTICE'], meta_ball: ['META'], grease_pencil: ['GREASEPENCIL'], speaker: ['SPEAKER'] };

function rootValue(name: string): { value: unknown; scope: Scope } | null {
  const doc = app.doc;
  switch (name) {
    case 'scene':
      return { value: doc.scene, scope: 'doc' };
    case 'tool_settings':
      return { value: doc.scene.tool_settings, scope: 'doc' };
    case 'view_layer':
      return { value: activeViewLayer(doc.scene), scope: 'doc' };
    case 'world':
      return { value: doc.scene.world ? table('worlds')?.[doc.scene.world] : null, scope: 'doc' };
    case 'space_data': {
      const a = hovered();
      return a?.editor ? { value: spaceProxy(a.editor), scope: 'ui' } : null;
    }
    case 'area':
      return { value: areaProxy(), scope: 'ui' };
    case 'preferences':
      return { value: prefsProxy(), scope: 'prefs' };
  }
  if (DATA_ROOTS[name]) {
    const ob = app.activeObject;
    return { value: ob && DATA_ROOTS[name].includes(ob.type) ? objectData(ob) : null, scope: 'doc' };
  }
  return null;
}

type Token = ReturnType<typeof tokenize>[number];

function step(cur: unknown, tok: Token, more: boolean): unknown {
  if (cur == null || typeof cur !== 'object') return undefined;
  let next: unknown;
  if (tok.kind === 'prop') next = (cur as Rec)[tok.name];
  else if (tok.kind === 'index') next = (cur as unknown[])[tok.index];
  else next = Array.isArray(cur) ? cur.find((x) => (x as { name?: string })?.name === tok.key) : (cur as Rec)[tok.key];
  // data-block references are stored as ids
  if (more && typeof next === 'string') return lookupId(next) ?? next;
  return next;
}

/** Find the setting a context data path addresses (null when the context doesn't have it). */
export function contextRef(path: string): ContextRef | null {
  let tokens: Token[];
  try {
    tokens = tokenize(path.trim());
  } catch {
    return null;
  }
  const [head, ...rest] = tokens;
  if (head?.kind !== 'prop' || !rest.length) return null;
  const obRoot = OBJECT_ROOTS[head.name];
  if (obRoot) {
    const ob = obRoot();
    if (!ob) return null;
    const restPath = path.trim().slice(head.name.length).replace(/^\./, '');
    const r = resolve(app.doc, ob, restPath);
    return r && r.owner && typeof r.owner === 'object' ? { owner: r.owner, key: r.key, scope: 'doc', path } : null;
  }
  const root = rootValue(head.name);
  if (!root || root.value == null) return null;
  let cur: unknown = root.value;
  for (let i = 0; i < rest.length - 1; i++) {
    cur = step(cur, rest[i], true);
    if (cur == null || typeof cur !== 'object') return null;
  }
  const last = rest[rest.length - 1];
  const key = last.kind === 'prop' ? last.name : last.kind === 'index' ? String(last.index) : last.key;
  if (!(key in (cur as object))) return null;
  return { owner: cur as Rec, key, scope: root.scope, path };
}

/** Bone record of the active armature's active bone. */
function activeBoneRecord(): Rec | null {
  const ob = app.activeObject;
  const arm = ob?.type === 'ARMATURE' && ob.data ? app.doc.armatures[ob.data] : undefined;
  return arm?.active_bone ? ((arm.bones.find((b) => b.name === arm.active_bone) as unknown as Rec) ?? null) : null;
}

function activeMaterialRecord(): Rec | null {
  const ob = app.activeObject;
  const d = objectData(ob) as { materials?: (string | null)[] } | null;
  const id = d?.materials?.[ob!.active_material_index] ?? null;
  return id ? (table('materials')?.[id] ?? null) : null;
}

/** The value a context path names (a data-block or struct): "object", "object.data", "scene", "material"… */
export function contextObject(path: string): unknown {
  const p = path.trim();
  if (OBJECT_ROOTS[p]) return OBJECT_ROOTS[p]();
  if (p === 'material') return activeMaterialRecord();
  if (p === 'active_bone' || p === 'bone' || p === 'edit_bone') return activeBoneRecord();
  if (p === 'active_pose_bone' || p === 'pose_bone') {
    const ob = app.activeObject;
    const name = (objectData(ob) as { active_bone?: string } | null)?.active_bone;
    return name && ob?.pose ? ((ob.pose as unknown as Record<string, Rec>)[name] ?? null) : null;
  }
  const dot = p.indexOf('.');
  if (dot > 0 && OBJECT_ROOTS[p.slice(0, dot)] && p.slice(dot + 1) === 'data') return objectData(OBJECT_ROOTS[p.slice(0, dot)]());
  const root = rootValue(p);
  if (root) return root.value;
  const r = contextRef(p);
  return r ? r.owner[r.key] : null;
}

export function readRef(r: ContextRef): unknown {
  return r.owner[r.key];
}

/** Write a value and let the app react (redraw, undo step for document data). */
export function writeRef(r: ContextRef, v: unknown, label: string) {
  r.owner[r.key] = v;
  if (r.scope === 'doc') {
    app.graph.invalidate?.();
    app.pushUndo(label);
    app.changed('doc');
  } else if (r.scope === 'ui') refreshEditor(hovered()?.editor);
  else app.changed('ui');
}

// ---------------------------------------------------------------------------
// enum items of a setting

/** Items of enum settings by property name (for settings no widget has shown yet). */
export const contextEnumItems: Record<string, () => [string, string][]> = {
  proportional_edit_falloff: () => ['SMOOTH', 'SPHERE', 'ROOT', 'INVERSE_SQUARE', 'SHARP', 'LINEAR', 'CONSTANT', 'RANDOM'].map((v) => [v, enumLabel(v)]),
  transform_pivot_point: () => [
    ['BOUNDING_BOX_CENTER', 'Bounding Box Center'],
    ['CURSOR', '3D Cursor'],
    ['INDIVIDUAL_ORIGINS', 'Individual Origins'],
    ['MEDIAN_POINT', 'Median Point'],
    ['ACTIVE_ELEMENT', 'Active Element'],
  ],
  snap_target: () => ['CLOSEST', 'CENTER', 'MEDIAN', 'ACTIVE'].map((v) => [v, enumLabel(v)]),
  uv_select_mode: () => ['VERTEX', 'EDGE', 'FACE', 'ISLAND'].map((v) => [v, enumLabel(v)]),
  snap_uv_element: () => [
    ['INCREMENT', 'Increment'],
    ['VERTEX', 'Vertex'],
  ],
  uv_sticky_select_mode: () => [
    ['SHARED_LOCATION', 'Shared Location'],
    ['DISABLED', 'Disabled'],
    ['SHARED_VERTEX', 'Shared Vertex'],
  ],
  stroke_method: () => ['SPACE', 'DOTS', 'AIRBRUSH', 'LINE', 'ANCHORED', 'DRAG_DOT'].map((v) => [v, v === 'DRAG_DOT' ? 'Drag Dot' : enumLabel(v)]),
  rotation_mode: () => [
    ['QUATERNION', 'Quaternion (WXYZ)'],
    ['XYZ', 'XYZ Euler'],
    ['XZY', 'XZY Euler'],
    ['YXZ', 'YXZ Euler'],
    ['YZX', 'YZX Euler'],
    ['ZXY', 'ZXY Euler'],
    ['ZYX', 'ZYX Euler'],
    ['AXIS_ANGLE', 'Axis Angle'],
  ],
};

/** Value/label pairs of an enum setting, or null when they are unknown. */
export function enumItemsOf(r: ContextRef): [string, string][] | null {
  const reg = contextEnumItems[r.key]?.();
  if (reg?.length) return reg;
  const b = findBinding(r.owner, r.key);
  if (b?.items?.length) return b.items.map((v) => [v, enumLabel(v)]);
  return null;
}

// ---------------------------------------------------------------------------
// operators

const pathProp = (label = 'Context Attributes'): PropDef => ({ id: 'data_path', label, type: 'string', default: '' });
const reverseProp: PropDef = { id: 'reverse', label: 'Reverse', type: 'bool', default: false };
const wrapProp: PropDef = { id: 'wrap', label: 'Wrap', type: 'bool', default: false };

function need(p: Rec): ContextRef | null {
  const r = contextRef(String(p.data_path ?? ''));
  if (!r) app.report('WARNING', `Nothing to change at "${p.data_path}" here`);
  return r;
}

/** Operators that act on a context path never fail loudly from a key press: they just do nothing. */
const ctxOp = (o: Omit<Operator, 'undo' | 'internal'>): Operator => ({ ...o, undo: false, internal: true, poll: o.poll ?? (() => true) });

const setOp = (idname: string, label: string, type: PropDef['type'], def: unknown, convert: (v: unknown) => unknown): Operator =>
  ctxOp({
    idname,
    label,
    description: 'Set a context value',
    props: [pathProp(), { id: 'value', label: 'Value', type, default: def }],
    exec: (_c, p) => {
      const r = need(p);
      if (!r) return 'CANCELLED';
      writeRef(r, convert(p.value), label);
    },
  });

/** Text of the current enum value for reports, e.g. "Snap: on". */
function describe(r: ContextRef, v: unknown) {
  const name = enumLabel(r.key.replace(/^(use_|show_)/, ''));
  return `${name}: ${typeof v === 'boolean' ? (v ? 'on' : 'off') : typeof v === 'string' ? enumLabel(v) : String(v)}`;
}

let modalHeader = '';

registerOperators([
  ctxOp({
    idname: 'wm.context_toggle',
    label: 'Context Toggle',
    description: 'Switch a context setting on or off',
    props: [pathProp(), { id: 'module', label: 'Module', type: 'string', default: '', hidden: true }],
    exec: (_c, p) => {
      const r = need(p);
      if (!r) return 'CANCELLED';
      const v = !readRef(r);
      writeRef(r, v, 'Toggle');
      if (r.scope !== 'ui') app.report('INFO', describe(r, v));
    },
  }),
  ctxOp({
    idname: 'wm.context_toggle_enum',
    label: 'Context Toggle Values',
    description: 'Switch a context setting between two values',
    props: [pathProp(), { id: 'value_1', label: 'Value', type: 'string', default: '' }, { id: 'value_2', label: 'Value', type: 'string', default: '' }],
    exec: (_c, p) => {
      const r = need(p);
      if (!r) return 'CANCELLED';
      writeRef(r, readRef(r) === p.value_1 ? p.value_2 : p.value_1, 'Toggle Value');
    },
  }),
  setOp('wm.context_set_boolean', 'Context Set Boolean', 'bool', true, (v) => !!v),
  setOp('wm.context_set_int', 'Context Set Integer', 'int', 0, (v) => Math.round(Number(v))),
  setOp('wm.context_set_float', 'Context Set Float', 'float', 0, (v) => Number(v)),
  setOp('wm.context_set_string', 'Context Set String', 'string', '', (v) => String(v ?? '')),
  setOp('wm.context_set_enum', 'Context Set Enum', 'string', '', (v) => String(v ?? '')),
  setOp('wm.context_set_value', 'Context Set Value', 'string', '', (v) => parseContextValue(String(v ?? ''))),
  ctxOp({
    idname: 'wm.context_set_id',
    label: 'Set Library ID',
    description: 'Point a context setting to the data-block with the given name',
    props: [pathProp(), { id: 'value', label: 'Value', type: 'string', default: '' }],
    exec: (_c, p) => {
      const r = need(p);
      if (!r) return 'CANCELLED';
      const name = String(p.value ?? '');
      if (!name) return void writeRef(r, null, 'Set Data-Block');
      for (const [k, t] of Object.entries(app.doc as unknown as Record<string, unknown>)) {
        if (k === 'scene' || !t || typeof t !== 'object' || Array.isArray(t)) continue;
        for (const rec of Object.values(t as Record<string, { id?: string; name?: string }>)) {
          if (rec && rec.name === name && typeof rec.id === 'string') return void writeRef(r, rec.id, 'Set Data-Block');
        }
      }
      app.report('WARNING', `No data-block named "${name}"`);
      return 'CANCELLED';
    },
  }),
  ...(['float', 'int'] as const).map((t) =>
    ctxOp({
      idname: `wm.context_scale_${t}`,
      label: `Context Scale ${t === 'float' ? 'Float' : 'Integer'}`,
      description: 'Multiply a context value by a factor',
      props: [pathProp(), { id: 'value', label: 'Value', type: 'float', default: 1 }, ...(t === 'int' ? [{ id: 'always_step', label: 'Always Step', type: 'bool' as const, default: true }] : [])],
      exec: (_c, p) => {
        const r = need(p);
        const v = r ? readRef(r) : undefined;
        if (!r || typeof v !== 'number') return 'CANCELLED';
        writeRef(r, scaleValue(v, Number(p.value), t === 'int', !!p.always_step), 'Scale Value');
      },
    }),
  ),
  ctxOp({
    idname: 'wm.context_cycle_enum',
    label: 'Context Enum Cycle',
    description: 'Step a context setting to its next value',
    props: [pathProp(), reverseProp, wrapProp],
    exec: (_c, p) => {
      const r = need(p);
      const items = r ? enumItemsOf(r) : null;
      if (!r || !items) return 'CANCELLED';
      const next = cycleItem(
        items.map(([v]) => v),
        String(readRef(r)),
        !!p.reverse,
        !!p.wrap,
      );
      if (next !== undefined && next !== readRef(r)) writeRef(r, next, 'Cycle Value');
    },
  }),
  ctxOp({
    idname: 'wm.context_cycle_array',
    label: 'Context Array Cycle',
    description: 'Rotate the values of a context array by one place',
    props: [pathProp(), reverseProp],
    exec: (_c, p) => {
      const r = need(p);
      const v = r ? readRef(r) : undefined;
      if (!r || !(Array.isArray(v) || ArrayBuffer.isView(v))) return 'CANCELLED';
      const next = rotateArray(v as ArrayLike<unknown>, !!p.reverse);
      writeRef(r, ArrayBuffer.isView(v) ? new (v.constructor as Float32ArrayConstructor)(next as number[]) : next, 'Cycle Array');
    },
  }),
  ctxOp({
    idname: 'wm.context_menu_enum',
    label: 'Context Enum Menu',
    description: 'Choose the value of a context setting from a menu',
    props: [pathProp()],
    invoke: (_c, p) => {
      const r = need(p);
      const items = r ? enumItemsOf(r) : null;
      if (!r || !items) return 'CANCELLED';
      const cur = readRef(r);
      openMenu(
        items.map(([v, l]): MenuItem => ({ label: l, active: v === cur, action: () => writeRef(r, v, 'Set Value') })),
        { x: app.pointer.x, y: app.pointer.y },
        { title: enumLabel(r.key) },
      );
      return 'CANCELLED';
    },
    exec: () => 'CANCELLED',
  }),
  ctxOp({
    idname: 'wm.context_pie_enum',
    label: 'Context Enum Pie',
    description: 'Choose the value of a context setting from a pie menu',
    props: [pathProp()],
    invoke: (_c, p) => {
      const r = need(p);
      const items = r ? enumItemsOf(r) : null;
      if (!r || !items) return 'CANCELLED';
      const cur = readRef(r);
      openPie(
        enumLabel(r.key),
        pieSlots(items.map(([v, l]): PieItem => ({ label: l, active: v === cur, action: () => writeRef(r, v, 'Set Value') }))),
        app.pointer.x,
        app.pointer.y,
      );
      return 'CANCELLED';
    },
    exec: () => 'CANCELLED',
  }),
  ctxOp({
    idname: 'wm.operator_pie_enum',
    label: 'Operator Enum Pie',
    description: 'Choose an option of an operator from a pie menu, then run it',
    props: [
      { id: 'data_path', label: 'Operator', type: 'string', default: '' },
      { id: 'prop_string', label: 'Property', type: 'string', default: '' },
    ],
    invoke: (_c, p) => {
      const op = operators.get(String(p.data_path ?? ''));
      const prop = op?.props?.find((d) => d.id === p.prop_string);
      if (!op || !prop?.items?.length) {
        app.report('WARNING', `No options "${p.prop_string}" on ${p.data_path}`);
        return 'CANCELLED';
      }
      openPie(
        op.label,
        pieSlots(prop.items.map(([v, l]): PieItem => ({ label: l, op: op.idname, props: { [prop.id]: v } }))),
        app.pointer.x,
        app.pointer.y,
      );
      return 'CANCELLED';
    },
    exec: () => 'CANCELLED',
  }),
  ctxOp({
    idname: 'wm.context_modal_mouse',
    label: 'Context Modal Mouse',
    description: 'Change a value of all the items of a context list by moving the mouse',
    props: [
      { id: 'data_path_iter', label: 'Collection', type: 'string', default: 'selected_editable_objects' },
      { id: 'data_path_item', label: 'Item Value', type: 'string', default: '' },
      { id: 'header_text', label: 'Header Text', type: 'string', default: '' },
      { id: 'input_scale', label: 'Input Scale', type: 'float', default: 0.01 },
      { id: 'invert', label: 'Invert', type: 'bool', default: false },
      { id: 'initial_x', label: 'Initial X', type: 'int', default: 0, hidden: true },
    ],
    invoke: (_c, p) => startModalMouse(p),
    exec: () => 'CANCELLED',
  }),
]);

/** Fill the eight pie slots in the usual order (W, E, S, N, NW, NE, SW, SE). */
function pieSlots(items: PieItem[]): (PieItem | null)[] {
  const out: (PieItem | null)[] = items.slice(0, 8);
  while (out.length < 8) out.push(null);
  return out;
}

function iterObjects(path: string): ObjectData[] {
  switch (path) {
    case 'selected_objects':
    case 'selected_editable_objects':
      return app.selectedObjects();
    case 'visible_objects':
      return app.doc.object_order.map((id) => app.doc.objects[id]).filter((o) => o && app.isVisible(o.id));
    case 'objects':
      return Object.values(app.doc.objects);
  }
  return [];
}

function startModalMouse(p: Rec): 'RUNNING_MODAL' | 'CANCELLED' {
  const targets = iterObjects(String(p.data_path_iter))
    .map((ob) => resolve(app.doc, ob, String(p.data_path_item)))
    .filter((r): r is NonNullable<typeof r> => !!r && typeof r.owner[r.key] === 'number');
  if (!targets.length) {
    app.report('WARNING', `Nothing to change: no ${p.data_path_item} on the ${String(p.data_path_iter).replace(/_/g, ' ')}`);
    return 'CANCELLED';
  }
  const starts = targets.map((t) => t.owner[t.key] as number);
  const x0 = app.pointer.x;
  const scale = Number(p.input_scale) * (p.invert ? -1 : 1);
  let delta = 0;
  const apply = (d: number) => {
    targets.forEach((t, i) => (t.owner[t.key] = starts[i] + d));
    app.graph.invalidate?.();
    app.changed('doc');
  };
  const header = String(p.header_text || `${enumLabel(String(p.data_path_item).split('.').pop() ?? '')}: %.4f`);
  modalHeader = header;
  app.startModal({
    label: header.replace(/:.*$/, '') || 'Change Value',
    cursor: 'ew-resize',
    header: () => modalHeader.replace(/%[.\d]*f/, (targets[0].owner[targets[0].key] as number).toFixed(4)),
    status: () => [
      ['LMB / Enter', 'Confirm'],
      ['RMB / Esc', 'Cancel'],
    ],
    onPointerMove: (e) => {
      delta = (e.clientX - x0) * scale;
      apply(delta);
    },
    onPointerDown: (e) => (e.button === 0 ? 'FINISHED' : 'CANCELLED'),
    onKey: (e) => {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      return true;
    },
    cancel: () => apply(0),
  });
  return 'RUNNING_MODAL';
}

// The text and console editors register their own font-size stepping; keep it and add the generic
// integer stepping for any other path.
onAppReady(() => {
  const prev = operators.get('wm.context_cycle_int');
  registerOperators([
    ctxOp({
      idname: 'wm.context_cycle_int',
      label: 'Context Int Cycle',
      description: 'Step a context integer up or down by one',
      props: [pathProp(), reverseProp, wrapProp],
      exec: (ctx, p) => {
        if (prev?.exec && String(p.data_path) === 'space_data.font_size' && (!prev.poll || prev.poll(ctx))) return prev.exec(ctx, p);
        const r = need(p);
        const v = r ? readRef(r) : undefined;
        if (!r || typeof v !== 'number') return 'CANCELLED';
        const b = findBinding(r.owner, r.key);
        writeRef(r, cycleInt(v, !!p.reverse, !!p.wrap, b?.min, b?.max), 'Cycle Value');
      },
    }),
  ]);
});
