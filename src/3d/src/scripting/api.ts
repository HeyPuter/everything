// The `bpy`-style scripting object model over the document (independent implementation;
// the public names follow the `bpy` naming conventions so existing snippets keep working).
//
//   bpy.data      data-block collections with [name] / get / new / remove / iteration
//   bpy.context   scene, object, selected_objects, view_layer.objects.active, mode, collection
//   bpy.ops       bpy.ops.<module>.<operator>(props) → app.run(idname, props)
//   bpy.types / bpy.utils / bpy.props   operator & panel registration (see registry.ts)
//
// All writes mark the document changed; script runs group them into one undo step
// (see runner.ts).
import { Matrix4 } from 'three';
import { app, operators, type OpResult } from '../app/app';
import type { DocumentData, ObjectData, MeshData, NodeTreeData, NodeData, ID, ImageData, TextData, CollectionData, MaterialData } from '../data/types';
import { newMetaball } from '../metaball/data';
import {
  newObject,
  newMeshData,
  newMaterial,
  newCollection,
  newCamera,
  newLight,
  newImage,
  newText,
  newAction,
  newNodeGroup,
  newWorld,
  newCurve,
  newArmature,
  newLattice,
  uid,
} from '../data/defaults';
import { buildMesh, edgeTopology, emptyMeshArrays, faceCenter, faceVerts, polyNormal } from '../mesh/mesh';
import { cow, cloneShared } from '../data/cow';
import { newModifier, modifierTypes } from '../eval/modifiers';
import { newConstraint, constraintTypes, boneOnlyConstraints } from '../eval/constraints';
import { keyProperty, ensureAction, ensureFCurve } from '../anim/keyframes';
import { insertKeyframe, evaluateFCurve as evaluateFC } from '../anim/fcurve';
import { localMatrix, applyMatrixToObject } from '../eval/transform';
import { getValue } from '../data/rna';
import { uiState } from '../app/prefs';
import { scriptFile, scriptFileNames } from './files';
import { Matrix, Vector, mathutils } from './mathutils';
import { allSockets, getNodeType, nodeSockets, nodeTypes, socketDefault } from '../nodes/registry';
import { ctxOf, makeNode } from '../nodes/tree';
import { zoneItemsFor, pairWithOutput } from '../geonodes/zones/script';
import { nodeItemsFor } from '../geonodes/nodes/itemscript';
import type { SocketDef } from '../nodes/types';
import {
  Struct,
  PropCollection,
  BoundArray,
  proxify,
  wrapField,
  idFactory,
  isIdWrapper,
  tableOf,
  touched,
  ensureEvaluated,
  pyError,
  kwMethod,
  toPlain,
  expectId,
  boundVector,
  scriptState,
  same,
  ID_TABLES,
  type Raw,
} from './rna';

// ---------------------------------------------------------------------------
// helpers

const doc = (): DocumentData => app.doc;

export function uniqueName(table: Record<string, { name: string }>, base: string, exceptId?: string) {
  const names = new Set(
    Object.values(table)
      .filter((x) => (x as { id?: string }).id !== exceptId)
      .map((o) => o.name),
  );
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

const DATA_TABLE: Record<string, keyof DocumentData> = {
  MESH: 'meshes',
  CURVE: 'curves',
  FONT: 'curves',
  SURFACE: 'curves',
  LIGHT: 'lights',
  CAMERA: 'cameras',
  ARMATURE: 'armatures',
  LATTICE: 'lattices',
  META: 'metaballs',
};
const TABLE_OBTYPE: Record<string, ObjectData['type']> = { meshes: 'MESH', curves: 'CURVE', lights: 'LIGHT', cameras: 'CAMERA', armatures: 'ARMATURE', lattices: 'LATTICE', metaballs: 'META' };
const TYPE_NAME = Object.fromEntries(ID_TABLES) as Record<string, string>;

/** Active collection (same rules as the outliner/add operators). */
export function activeCollectionId(d: DocumentData = doc()): ID {
  const id = (uiState as unknown as { activeCollection?: string }).activeCollection;
  if (id && d.collections[id]) return id;
  const act = d.scene.active_object;
  const holder = act ? Object.values(d.collections).find((c) => c.id !== d.scene.collection && c.objects.includes(act)) : undefined;
  if (holder) return holder.id;
  return d.collections[d.scene.collection]?.children[0] ?? d.scene.collection;
}

/** Objects linked anywhere in the scene's collection tree. */
function sceneObjectIds(d: DocumentData = doc()): ID[] {
  const out = new Set<ID>();
  const walk = (cid: ID, seen: Set<ID>) => {
    const c = d.collections[cid];
    if (!c || seen.has(cid)) return;
    seen.add(cid);
    c.objects.forEach((o) => out.add(o));
    c.children.forEach((ch) => walk(ch, seen));
  };
  walk(d.scene.collection, new Set());
  return d.object_order.filter((id) => out.has(id) && d.objects[id]);
}

function countUsers(id: ID): number {
  let n = 0;
  const visit = (v: unknown, depth: number) => {
    if (depth > 12 || v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) return;
    if (Array.isArray(v)) {
      for (const x of v)
        if (x === id) n++;
        else visit(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (k === 'id') continue;
      if (x === id) n++;
      else visit(x, depth + 1);
    }
  };
  const d = doc() as unknown as Record<string, unknown>;
  for (const [k, t] of Object.entries(d)) {
    if (k === 'object_order') continue;
    if (k === 'scene') visit(t, 0);
    else if (t && typeof t === 'object') for (const [rid, rec] of Object.entries(t as Record<string, unknown>)) if (rid !== id) visit(rec, 0);
  }
  return n;
}

// ---------------------------------------------------------------------------
// ID base

/** Asset marking for scripts (installed by the asset system). */
export const idAssetHooks: { mark?: (table: string, id: string) => void; clear?: (table: string, id: string) => void; preview?: (table: string, id: string) => void } = {};

export class IDStruct extends Struct {
  readonly __kind: string = 'id';
  constructor(
    readonly __table: string,
    readonly __id: string,
  ) {
    super(TYPE_NAME[__table] ?? 'ID', () => tableOf(app.doc, __table)[__id], '');
  }
  override get __path() {
    const r = this.__resolve();
    return `bpy.data.${this.__table}[${JSON.stringify(r?.name ?? '?')}]`;
  }
  get name(): string {
    return this.__raw.name as string;
  }
  set name(v: string) {
    const raw = this.__raw;
    const n = String(v).slice(0, 63) || TYPE_NAME[this.__table] || 'ID';
    raw.name = uniqueName(tableOf(app.doc, this.__table) as Record<string, { name: string }>, n, this.__id);
    touched();
  }
  get name_full() {
    return this.name;
  }
  get users() {
    return countUsers(this.__id) + (this.__raw.use_fake_user ? 1 : 0);
  }
  get use_fake_user() {
    return !!this.__raw.use_fake_user;
  }
  set use_fake_user(v: boolean) {
    this.__raw.use_fake_user = !!v;
    touched();
  }
  get is_evaluated() {
    return false;
  }
  get original() {
    return this;
  }
  get session_uid() {
    return this.__id;
  }
  /** Duplicate the data-block (not linked into the scene). */
  copy() {
    const raw = this.__raw;
    const c = cloneShared(raw) as Raw;
    c.id = uid(this.__table.slice(0, 2));
    c.name = uniqueName(tableOf(app.doc, this.__table) as Record<string, { name: string }>, raw.name as string);
    delete c.use_fake_user;
    tableOf(app.doc, this.__table)[c.id as string] = c;
    if (this.__table === 'objects') {
      const ob = c as unknown as ObjectData;
      ob.select = false;
      ob.modifiers = ob.modifiers.map((m) => ({ ...m, id: uid('md') }));
      ob.constraints = ob.constraints.map((k) => ({ ...k, id: uid('cn') }));
      app.doc.object_order.push(ob.id);
    }
    touched();
    return wrapId(this.__table, c.id as string);
  }
  evaluated_get(_depsgraph?: unknown) {
    ensureEvaluated();
    return this;
  }
  user_clear() {
    /* users are derived from references in this implementation */
  }
  /** Asset metadata (None unless the data-block is an asset). */
  get asset_data() {
    return this.__raw.asset_data ? wrapField(this, 'asset_data', () => this.__resolve()) : null;
  }
  asset_mark() {
    idAssetHooks.mark?.(this.__table, this.__id);
    touched();
  }
  asset_clear() {
    idAssetHooks.clear?.(this.__table, this.__id);
    touched();
  }
  asset_generate_preview() {
    idAssetHooks.preview?.(this.__table, this.__id);
    touched();
  }
  animation_data_create() {
    const raw = this.__raw;
    if (!('animation_data' in raw)) throw pyError('TypeError', `${this.__type} has no animation data`);
    raw.animation_data ??= { action: null, nla_tracks: [], drivers: [] };
    touched();
    return wrapField(this, 'animation_data', () => this.__resolve());
  }
  animation_data_clear() {
    const raw = this.__raw;
    if ('animation_data' in raw) raw.animation_data = null;
    touched();
  }
  override toString() {
    return `<bpy_struct, ${this.__type}("${this.__resolve()?.name ?? '<removed>'}")>`;
  }
  override repr() {
    return this.__path;
  }
}

const idCache = new Map<string, unknown>();
export function wrapId(table: string, id: string): unknown {
  const key = `${table}:${id}`;
  let w = idCache.get(key);
  if (!w) {
    const C = ID_CLASSES[table] ?? IDStruct;
    w = proxify(new C(table, id));
    idCache.set(key, w);
  }
  return w;
}
idFactory.wrap = wrapId;

// ---------------------------------------------------------------------------
// Object

class ObjectStruct extends IDStruct {
  private get ob() {
    return this.__raw as unknown as ObjectData;
  }
  get type() {
    return this.ob.type;
  }
  get data() {
    const ob = this.ob;
    const t = DATA_TABLE[ob.type];
    return ob.data && t ? wrapId(t, ob.data) : null;
  }
  set data(v: unknown) {
    const ob = this.ob;
    if (v === null || v === undefined) {
      if (ob.type !== 'EMPTY') throw pyError('TypeError', 'Only empties can have no data');
      return;
    }
    if (!isIdWrapper(v) || TABLE_OBTYPE[v.__table] === undefined) throw pyError('TypeError', 'expected object data (Mesh, Curve, Light, Camera, …)');
    const want = TABLE_OBTYPE[v.__table];
    if (want !== ob.type && !(ob.type === 'FONT' && want === 'CURVE')) throw pyError('TypeError', `cannot assign ${TYPE_NAME[v.__table]} data to a ${ob.type} object`);
    ob.data = v.__id;
    touched('geometry');
  }
  get parent() {
    const p = this.ob.parent;
    return p && app.doc.objects[p] ? wrapId('objects', p) : null;
  }
  set parent(v: unknown) {
    const ob = this.ob;
    if (v === null || v === undefined) ob.parent = null;
    else {
      const pid = expectId(v, 'objects', 'Object');
      for (let p: string | null = pid; p; p = app.doc.objects[p]?.parent ?? null) if (p === ob.id) throw pyError('ValueError', 'loop in parents');
      ob.parent = pid;
      ob.parent_type = 'OBJECT';
    }
    touched();
  }
  get children() {
    return Object.values(app.doc.objects)
      .filter((o) => o.parent === this.__id)
      .map((o) => wrapId('objects', o.id));
  }
  get children_recursive() {
    const out: unknown[] = [];
    const walk = (id: string) => {
      for (const o of Object.values(app.doc.objects))
        if (o.parent === id) {
          out.push(wrapId('objects', o.id));
          walk(o.id);
        }
    };
    walk(this.__id);
    return out;
  }
  get mode() {
    return app.doc.scene.active_object === this.__id ? app.doc.mode : 'OBJECT';
  }
  get modifiers() {
    return new ModifierCollection(this.__id);
  }
  get constraints() {
    return new ConstraintCollection(this.__id);
  }
  get users_collection() {
    return Object.values(app.doc.collections)
      .filter((c) => c.objects.includes(this.__id))
      .map((c) => wrapId('collections', c.id));
  }
  get users_scene() {
    return sceneObjectIds().includes(this.__id) ? [bpyData.scenes.getItem(0)] : [];
  }
  get matrix_world(): Matrix {
    ensureEvaluated();
    const ev = app.graph.get(this.__id);
    if (ev) return Matrix.fromColumnMajor(ev.world.elements);
    return this.matrix_basis;
  }
  set matrix_world(m: unknown) {
    const M = asMatrix(m);
    const ob = this.ob;
    let local = new Matrix4().fromArray(M.toColumnMajor());
    if (ob.parent && app.doc.objects[ob.parent]) {
      ensureEvaluated();
      const pw = app.graph.get(ob.parent)?.world;
      if (pw) {
        const pinv = new Matrix4().fromArray(ob.matrix_parent_inverse);
        local = pw.clone().multiply(pinv).invert().multiply(local);
      }
    }
    applyMatrixToObject(ob, local);
    touched();
  }
  get matrix_basis(): Matrix {
    return Matrix.fromColumnMajor(localMatrix(this.ob).elements);
  }
  set matrix_basis(m: unknown) {
    applyMatrixToObject(this.ob, new Matrix4().fromArray(asMatrix(m).toColumnMajor()));
    touched();
  }
  get matrix_local(): Matrix {
    const ob = this.ob;
    return Matrix.fromColumnMajor(new Matrix4().fromArray(ob.matrix_parent_inverse).multiply(localMatrix(ob)).elements);
  }
  get matrix_parent_inverse(): Matrix {
    return Matrix.fromColumnMajor(this.ob.matrix_parent_inverse);
  }
  set matrix_parent_inverse(m: unknown) {
    this.ob.matrix_parent_inverse = asMatrix(m).toColumnMajor();
    touched();
  }
  get dimensions(): Vector {
    ensureEvaluated();
    const ev = app.graph.get(this.__id);
    const P = ev?.mesh?.positions;
    if (!P || !P.length) return new Vector([0, 0, 0]);
    const mn = [Infinity, Infinity, Infinity],
      mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3)
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], P[i + k]);
        mx[k] = Math.max(mx[k], P[i + k]);
      }
    const s = this.ob.scale;
    return new Vector([0, 1, 2].map((k) => (mx[k] - mn[k]) * Math.abs(s[k])));
  }
  get active_material() {
    const slots = materialSlots(this.ob);
    const id = slots[this.ob.active_material_index] ?? null;
    return id ? wrapId('materials', id) : null;
  }
  set active_material(v: unknown) {
    const ob = this.ob;
    const me = dataRecord(ob) as { materials?: (ID | null)[] } | null;
    if (!me?.materials) throw pyError('TypeError', `${ob.type} objects have no material slots`);
    const id = v === null || v === undefined ? null : expectId(v, 'materials', 'Material');
    if (!me.materials.length) me.materials.push(id);
    else me.materials[Math.min(ob.active_material_index, me.materials.length - 1)] = id;
    touched();
  }
  get material_slots() {
    const ob = this.ob;
    return materialSlots(ob).map((id, i) => ({
      __kind: 'struct',
      name: id ? (app.doc.materials[id]?.name ?? '') : '',
      material: id ? wrapId('materials', id) : null,
      link: ob.material_slots_link?.[i] ?? 'DATA',
      slot_index: i,
    }));
  }
  get vertex_groups() {
    return new VertexGroupCollection(this.__id);
  }
  select_get() {
    return !!this.ob.select;
  }
  select_set(state: unknown = true) {
    this.ob.select = !!state;
    touched('select');
  }
  hide_get() {
    return !!this.ob.hide;
  }
  hide_set(state: unknown = true) {
    this.ob.hide = !!state;
    if (state) this.ob.select = false;
    touched('select');
  }
  visible_get() {
    ensureEvaluated();
    return app.isVisible(this.__id);
  }
  /** Insert a keyframe for `data_path` (all channels when index = -1). Returns True on success. */
  keyframe_insert(data_path: string, index: number = -1, frame?: number | null, group?: string) {
    const ob = this.ob;
    const f = frame === undefined || frame === null ? app.doc.scene.frame_current : Number(frame);
    const val = getValue(app.doc, ob, data_path);
    if (val === undefined) throw pyError('TypeError', `bpy_struct.keyframe_insert() property "${data_path}" not found`);
    if (typeof val !== 'number' && typeof val !== 'boolean' && !Array.isArray(val) && !ArrayBuffer.isView(val))
      throw pyError('TypeError', `bpy_struct.keyframe_insert() property "${data_path}" not animatable`);
    keyProperty(app.doc, ob, data_path, index ?? -1, f);
    if (group) {
      const act = ensureAction(app.doc, ob);
      for (const fc of act.fcurves) if (fc.data_path === data_path) fc.group = group;
    }
    touched();
    return true;
  }
  keyframe_delete(data_path: string, index: number = -1, frame?: number | null) {
    const ob = this.ob;
    const f = frame === undefined || frame === null ? app.doc.scene.frame_current : Number(frame);
    const act = ob.animation_data?.action ? app.doc.actions[ob.animation_data.action] : null;
    if (!act) return false;
    let removed = false;
    for (const fc of act.fcurves) {
      if (fc.data_path !== data_path || (index >= 0 && fc.array_index !== index)) continue;
      const n = fc.keyframe_points.length;
      fc.keyframe_points = fc.keyframe_points.filter((k) => Math.abs(k.co[0] - f) > 1e-4);
      removed ||= fc.keyframe_points.length !== n;
    }
    act.fcurves = act.fcurves.filter((fc) => fc.keyframe_points.length);
    if (!removed) throw pyError('RuntimeError', `keyframe_delete: no keyframe at frame ${f} for "${data_path}"`);
    touched();
    return true;
  }
  shape_key_add(name = 'Key', from_mix = true) {
    void from_mix;
    const me = dataRecord(this.ob) as MeshData | null;
    if (!me || this.ob.type !== 'MESH') throw pyError('TypeError', 'shape keys require a mesh object');
    const basis = !me.shape_keys.length;
    me.shape_keys.push({
      name: basis ? 'Basis' : uniqueName(Object.fromEntries(me.shape_keys.map((k, i) => [i, k])), name),
      data: new Float32Array(me.positions),
      value: 0,
      slider_min: 0,
      slider_max: 1,
      mute: false,
      relative_key: me.shape_keys[0]?.name ?? 'Basis',
    });
    touched('geometry');
    const i = me.shape_keys.length - 1;
    return proxify(new Struct('ShapeKey', () => (dataRecord(this.ob) as MeshData | null)?.shape_keys[i] as unknown as Raw, `${this.__path}.data.shape_keys.key_blocks[${i}]`));
  }
}
kwMethod(ObjectStruct.prototype, 'keyframe_insert', ['data_path', 'index', 'frame', 'group', 'options', 'keytype']);
kwMethod(ObjectStruct.prototype, 'keyframe_delete', ['data_path', 'index', 'frame', 'group']);
kwMethod(ObjectStruct.prototype, 'select_set', ['state', 'view_layer']);
kwMethod(ObjectStruct.prototype, 'hide_set', ['state', 'view_layer']);
kwMethod(ObjectStruct.prototype, 'shape_key_add', ['name', 'from_mix']);

function asMatrix(m: unknown): Matrix {
  if (m instanceof Matrix) return m;
  if (Array.isArray(m)) return new Matrix(m as number[][]);
  throw pyError('TypeError', 'expected a 4x4 Matrix');
}

function dataRecord(ob: ObjectData): Raw | null {
  const t = DATA_TABLE[ob.type];
  return t && ob.data ? (tableOf(app.doc, t as string)[ob.data] ?? null) : null;
}

function materialSlots(ob: ObjectData): (ID | null)[] {
  const d = dataRecord(ob) as { materials?: (ID | null)[] } | null;
  const base = d?.materials ?? [];
  return base.map((id, i) => (ob.material_slots_link?.[i] === 'OBJECT' ? (ob.object_materials?.[i] ?? null) : id));
}

/** Modifier/constraint stacks: `ob.modifiers.new(name, type)`, `.remove(m)`, `["Name"]`. */
class ModifierCollection extends PropCollection<unknown> {
  constructor(readonly obId: string) {
    super(`bpy.data.objects[${JSON.stringify(app.doc.objects[obId]?.name)}].modifiers`);
  }
  private ob() {
    const ob = app.doc.objects[this.obId];
    if (!ob) throw pyError('ReferenceError', 'Object has been removed');
    return ob;
  }
  list() {
    return this.ob().modifiers.map((m) => modifierWrapper(this.obId, m.id));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  new(name: string, type: string) {
    const ob = this.ob();
    const t = String(type ?? '').toUpperCase();
    if (!modifierTypes[t])
      throw pyError(
        'TypeError',
        `ObjectModifiers.new(): enum "${type}" not found in (${Object.keys(modifierTypes)
          .map((k) => `'${k}'`)
          .join(', ')})`,
      );
    if (ob.type !== 'MESH' && ob.type !== 'CURVE' && ob.type !== 'FONT' && ob.type !== 'LATTICE') throw pyError('RuntimeError', `Error: Object '${ob.name}' does not support modifiers`);
    const m = newModifier(t, uid('md'), ob.modifiers);
    if (name) m.name = uniqueName(Object.fromEntries(ob.modifiers.map((x) => [x.id, x])), String(name));
    ob.modifiers.push(m);
    touched('geometry');
    return modifierWrapper(ob.id, m.id);
  }
  remove(mod: unknown) {
    const ob = this.ob();
    const id = (mod as { __mid?: string })?.__mid;
    const i = ob.modifiers.findIndex((m) => m.id === id);
    if (i < 0) throw pyError('ReferenceError', 'Modifier not found in this object');
    ob.modifiers.splice(i, 1);
    touched('geometry');
  }
  clear() {
    this.ob().modifiers = [];
    touched('geometry');
  }
  move(from: number, to: number) {
    const l = this.ob().modifiers;
    const [m] = l.splice(from, 1);
    if (m) l.splice(to, 0, m);
    touched('geometry');
  }
  get active() {
    const l = this.ob().modifiers;
    return l.length ? modifierWrapper(this.obId, l[l.length - 1].id) : null;
  }
}
kwMethod(ModifierCollection.prototype, 'new', ['name', 'type']);

function modifierWrapper(obId: string, mid: string) {
  const s = new Struct('Modifier', () => app.doc.objects[obId]?.modifiers.find((m) => m.id === mid) as Raw | undefined, '');
  Object.defineProperty(s, '__mid', { value: mid });
  Object.defineProperty(s, '__path', {
    get: () => `bpy.data.objects[${JSON.stringify(app.doc.objects[obId]?.name)}].modifiers[${JSON.stringify(app.doc.objects[obId]?.modifiers.find((m) => m.id === mid)?.name)}]`,
  });
  return proxify(s);
}

class ConstraintCollection extends PropCollection<unknown> {
  constructor(readonly obId: string) {
    super(`bpy.data.objects[${JSON.stringify(app.doc.objects[obId]?.name)}].constraints`);
  }
  private ob() {
    const ob = app.doc.objects[this.obId];
    if (!ob) throw pyError('ReferenceError', 'Object has been removed');
    return ob;
  }
  list() {
    return this.ob().constraints.map((c) => constraintWrapper(this.obId, c.id));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  new(type: string) {
    const ob = this.ob();
    const t = String(type ?? '').toUpperCase();
    if (!constraintTypes[t] && !boneOnlyConstraints[t])
      throw pyError(
        'TypeError',
        `ObjectConstraints.new(): enum "${type}" not found in (${Object.keys(constraintTypes)
          .map((k) => `'${k}'`)
          .join(', ')})`,
      );
    const c = newConstraint(t, uid('cn'));
    c.name = uniqueName(Object.fromEntries(ob.constraints.map((x) => [x.id, x])), c.name);
    ob.constraints.push(c);
    touched();
    return constraintWrapper(ob.id, c.id);
  }
  remove(con: unknown) {
    const ob = this.ob();
    const id = (con as { __cid?: string })?.__cid;
    const i = ob.constraints.findIndex((c) => c.id === id);
    if (i < 0) throw pyError('ReferenceError', 'Constraint not found in this object');
    ob.constraints.splice(i, 1);
    touched();
  }
  clear() {
    this.ob().constraints = [];
    touched();
  }
}
kwMethod(ConstraintCollection.prototype, 'new', ['type']);

function constraintWrapper(obId: string, cid: string) {
  const s = new Struct('Constraint', () => app.doc.objects[obId]?.constraints.find((c) => c.id === cid) as Raw | undefined, '');
  Object.defineProperty(s, '__cid', { value: cid });
  Object.defineProperty(s, '__path', {
    get: () => `bpy.data.objects[${JSON.stringify(app.doc.objects[obId]?.name)}].constraints[${JSON.stringify(app.doc.objects[obId]?.constraints.find((c) => c.id === cid)?.name)}]`,
  });
  return proxify(s);
}

class VertexGroupCollection extends PropCollection<unknown> {
  constructor(readonly obId: string) {
    super(`bpy.data.objects[${JSON.stringify(app.doc.objects[obId]?.name)}].vertex_groups`);
  }
  private mesh(): MeshData {
    const ob = app.doc.objects[this.obId];
    const me = ob && ob.type === 'MESH' ? (dataRecord(ob) as MeshData | null) : null;
    if (!me) throw pyError('TypeError', 'vertex groups require a mesh object');
    return me;
  }
  list() {
    const me = this.mesh();
    return me.vertex_groups.map((_, i) => this.wrap(i));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  private wrap(i: number) {
    const s = new Struct('VertexGroup', () => this.mesh().vertex_groups[i] as unknown as Raw, `${this.__path}[${i}]`);
    const me = () => this.mesh();
    return proxify(
      Object.assign(s, {
        index: i,
        add: (index: number[], weight: number, _type = 'REPLACE') => {
          const m = me();
          const w = cow(m.weights, i as never) as unknown as Float32Array;
          for (const v of index) w[v] = weight;
          touched('geometry');
        },
        remove: (index: number[]) => {
          const m = me();
          const w = cow(m.weights, i as never) as unknown as Float32Array;
          for (const v of index) w[v] = 0;
          touched('geometry');
        },
        weight: (v: number) => me().weights[i]?.[v] ?? 0,
      }),
    );
  }
  new(name = 'Group') {
    const me = this.mesh();
    const n = uniqueName(Object.fromEntries(me.vertex_groups.map((g, i) => [i, g])), String(name));
    me.vertex_groups.push({ name: n });
    me.weights.push(new Float32Array(me.positions.length / 3));
    touched('geometry');
    return this.wrap(me.vertex_groups.length - 1);
  }
  remove(group: unknown) {
    const me = this.mesh();
    const i = me.vertex_groups.findIndex((g) => g.name === (group as { name?: string })?.name);
    if (i < 0) throw pyError('ReferenceError', 'vertex group not found');
    me.vertex_groups.splice(i, 1);
    me.weights.splice(i, 1);
    touched('geometry');
  }
}
kwMethod(VertexGroupCollection.prototype, 'new', ['name']);

// ---------------------------------------------------------------------------
// Mesh

class MeshStruct extends IDStruct {
  get me() {
    return this.__raw as unknown as MeshData;
  }
  override __hidden() {
    return MESH_HIDDEN;
  }
  get vertices() {
    return new MeshVertices(this.__id);
  }
  get edges() {
    return new MeshEdges(this.__id);
  }
  get polygons() {
    return new MeshPolygons(this.__id);
  }
  get loops() {
    return new MeshLoops(this.__id);
  }
  get uv_layers() {
    return new MeshUVLayers(this.__id);
  }
  get materials() {
    return new IDMaterials(() => this.me as unknown as { materials: (ID | null)[] }, `${this.__path}.materials`);
  }
  get shape_keys() {
    const me = this.me;
    if (!me.shape_keys.length) return null;
    return {
      __kind: 'struct',
      key_blocks: new BoundArray('ShapeKey', `${this.__path}.shape_keys.key_blocks`, () => (tableOf(app.doc, 'meshes')[this.__id] as unknown as MeshData | undefined)?.shape_keys, 'key_blocks'),
    };
  }
  /** Build geometry from Python-style lists: vertices [(x,y,z)…], edges [(a,b)…], faces [(i,j,k,…)…]. */
  from_pydata(vertices: unknown, edges: unknown = [], faces: unknown = [], shade_flat = true) {
    const vs = toPlain(vertices) as number[][];
    const fs = (toPlain(faces) ?? []) as number[][];
    const es = (toPlain(edges) ?? []) as number[][];
    if (!Array.isArray(vs)) throw pyError('TypeError', 'from_pydata(): vertices must be a sequence');
    const positions = new Float32Array(vs.length * 3);
    vs.forEach((v, i) => {
      if (!Array.isArray(v) || v.length < 2) throw pyError('ValueError', `from_pydata(): vertex ${i} must have 3 coordinates`);
      positions[i * 3] = Number(v[0]);
      positions[i * 3 + 1] = Number(v[1]);
      positions[i * 3 + 2] = Number(v[2] ?? 0);
    });
    const polys = fs.map((f, fi) => {
      const verts = Array.from(f, Number);
      if (verts.length < 3) throw pyError('ValueError', `from_pydata(): face ${fi} needs at least 3 vertices`);
      for (const v of verts) if (!(v >= 0 && v < vs.length)) throw pyError('IndexError', `from_pydata(): face ${fi} references vertex ${v} out of range`);
      return { verts, smooth: !shade_flat };
    });
    const arrays = polys.length ? buildMesh(positions, polys) : { ...emptyMeshArrays(), positions };
    const me = this.me;
    Object.assign(me, arrays);
    for (const k of ['seams', 'sharp', 'creases', 'select_vert', 'hide_vert'] as const) if (!(k in arrays)) delete (me as unknown as Raw)[k];
    me.weights = me.vertex_groups.map(() => new Float32Array(vs.length));
    me.shape_keys = [];
    me.color_attributes = [];
    if (es.length && !polys.length) app.report('WARNING', `from_pydata(): ${es.length} loose edge(s) ignored — meshes in this application store faces only`);
    touched('geometry');
  }
  update(calc_edges = false, calc_edges_loose = false) {
    void calc_edges;
    void calc_edges_loose;
    touched('geometry');
  }
  validate(verbose = false, clean_customdata = true) {
    void verbose;
    void clean_customdata;
    return false;
  }
  clear_geometry() {
    Object.assign(this.me, emptyMeshArrays());
    this.me.shape_keys = [];
    this.me.weights = this.me.vertex_groups.map(() => new Float32Array(0));
    touched('geometry');
  }
  transform(matrix: unknown) {
    const M = asMatrix(matrix);
    const p = cow(this.me, 'positions');
    for (let i = 0; i < p.length; i += 3) {
      const r = M.matmul([p[i], p[i + 1], p[i + 2]]) as Vector;
      p[i] = r.x;
      p[i + 1] = r.y;
      p[i + 2] = r.z;
    }
    touched('geometry');
  }
  shade_smooth() {
    this.me.smooth = new Uint8Array(this.me.offsets.length - 1).fill(1);
    touched('geometry');
  }
  shade_flat() {
    this.me.smooth = new Uint8Array(this.me.offsets.length - 1);
    touched('geometry');
  }
}
const MESH_HIDDEN = new Set([
  'id',
  'positions',
  'offsets',
  'indices',
  'uvs',
  'normals',
  'seams',
  'sharp',
  'creases',
  'smooth',
  'material_index',
  'select_vert',
  'hide_vert',
  'weights',
  'users',
  'materials',
  'shape_keys',
]);
kwMethod(MeshStruct.prototype, 'from_pydata', ['vertices', 'edges', 'faces', 'shade_flat']);
kwMethod(MeshStruct.prototype, 'update', ['calc_edges', 'calc_edges_loose']);

const meshOf = (id: string) => {
  const me = tableOf(app.doc, 'meshes')[id] as unknown as MeshData | undefined;
  if (!me) throw pyError('ReferenceError', 'Mesh has been removed');
  return me;
};

class MeshVertices extends PropCollection<unknown> {
  constructor(readonly meId: string) {
    super(`bpy.data.meshes[${JSON.stringify(tableOf(app.doc, 'meshes')[meId]?.name)}].vertices`);
  }
  override get length() {
    return meshOf(this.meId).positions.length / 3;
  }
  list() {
    return Array.from({ length: this.length }, (_, i) => this.vertex(i));
  }
  nameOf() {
    return '';
  }
  override getItem(key: number | string) {
    if (typeof key !== 'number') throw pyError('TypeError', 'bpy_prop_collection: index must be an int');
    const n = this.length;
    const i = key < 0 ? key + n : key;
    if (i < 0 || i >= n) throw pyError('IndexError', `bpy_prop_collection[index]: index ${key} out of range, size ${n}`);
    return this.vertex(i);
  }
  private vertex(i: number) {
    const id = this.meId;
    return {
      __kind: 'struct',
      __type: 'MeshVertex',
      index: i,
      get co() {
        return boundVector(
          'VECTOR',
          () => meshOf(id).positions.subarray(i * 3, i * 3 + 3),
          (k, x) => {
            cow(meshOf(id), 'positions')[i * 3 + k] = x;
            touched('geometry');
          },
        );
      },
      set co(v: unknown) {
        const a = toPlain(v) as number[];
        const p = cow(meshOf(id), 'positions');
        p[i * 3] = a[0];
        p[i * 3 + 1] = a[1];
        p[i * 3 + 2] = a[2];
        touched('geometry');
      },
      get select() {
        return !!meshOf(id).select_vert?.[i];
      },
      set select(v: boolean) {
        const me = meshOf(id);
        if (!me.select_vert) me.select_vert = new Uint8Array(me.positions.length / 3);
        cow(me, 'select_vert')![i] = v ? 1 : 0;
        touched('select');
      },
      get hide() {
        return !!meshOf(id).hide_vert?.[i];
      },
      get normal() {
        ensureEvaluated();
        const me = meshOf(id);
        const n = [0, 0, 0];
        for (let f = 0; f < me.offsets.length - 1; f++) {
          const vs = faceVerts(me, f);
          if (!vs.includes(i)) continue;
          const fn = polyNormal(me.positions, vs);
          n[0] += fn[0];
          n[1] += fn[1];
          n[2] += fn[2];
        }
        return new Vector(n).normalized();
      },
      toString: () => `<bpy_struct, MeshVertex at ${this.__path}[${i}]>`,
    };
  }
  /** Append `count` vertices at the origin (faces must be rebuilt with from_pydata). */
  add(count: number) {
    const me = meshOf(this.meId);
    const p = new Float32Array(me.positions.length + count * 3);
    p.set(me.positions);
    me.positions = p;
    touched('geometry');
  }
  foreach_get(attr: string, seq?: unknown) {
    if (attr !== 'co') throw pyError('TypeError', `foreach_get: unsupported attribute "${attr}" (supported: co)`);
    const out = Array.from(meshOf(this.meId).positions);
    if (Array.isArray(seq)) for (let i = 0; i < out.length && i < seq.length; i++) seq[i] = out[i];
    return out;
  }
  foreach_set(attr: string, seq: unknown) {
    if (attr !== 'co') throw pyError('TypeError', `foreach_set: unsupported attribute "${attr}" (supported: co)`);
    const a = toPlain(seq) as number[];
    const me = meshOf(this.meId);
    if (a.length !== me.positions.length) throw pyError('ValueError', `foreach_set: expected ${me.positions.length} values, got ${a.length}`);
    me.positions = Float32Array.from(a);
    touched('geometry');
  }
}

class MeshEdges extends PropCollection<unknown> {
  constructor(readonly meId: string) {
    super(`bpy.data.meshes[${JSON.stringify(tableOf(app.doc, 'meshes')[meId]?.name)}].edges`);
  }
  list() {
    const me = meshOf(this.meId);
    const topo = edgeTopology(me);
    return Array.from({ length: topo.count }, (_, i) => ({
      __kind: 'struct',
      __type: 'MeshEdge',
      index: i,
      vertices: [topo.verts[i * 2], topo.verts[i * 2 + 1]],
      key: [topo.verts[i * 2], topo.verts[i * 2 + 1]],
    }));
  }
  nameOf() {
    return '';
  }
}

class MeshPolygons extends PropCollection<unknown> {
  constructor(readonly meId: string) {
    super(`bpy.data.meshes[${JSON.stringify(tableOf(app.doc, 'meshes')[meId]?.name)}].polygons`);
  }
  override get length() {
    return meshOf(this.meId).offsets.length - 1;
  }
  list() {
    return Array.from({ length: this.length }, (_, i) => this.poly(i));
  }
  nameOf() {
    return '';
  }
  override getItem(key: number | string) {
    if (typeof key !== 'number') throw pyError('TypeError', 'bpy_prop_collection: index must be an int');
    const n = this.length;
    const i = key < 0 ? key + n : key;
    if (i < 0 || i >= n) throw pyError('IndexError', `bpy_prop_collection[index]: index ${key} out of range, size ${n}`);
    return this.poly(i);
  }
  private poly(f: number) {
    const id = this.meId;
    return {
      __kind: 'struct',
      __type: 'MeshPolygon',
      index: f,
      get vertices() {
        return faceVerts(meshOf(id), f);
      },
      get loop_start() {
        return meshOf(id).offsets[f];
      },
      get loop_total() {
        const me = meshOf(id);
        return me.offsets[f + 1] - me.offsets[f];
      },
      get loop_indices() {
        const me = meshOf(id);
        return Array.from({ length: me.offsets[f + 1] - me.offsets[f] }, (_, k) => me.offsets[f] + k);
      },
      get normal() {
        const me = meshOf(id);
        return new Vector(polyNormal(me.positions, faceVerts(me, f)));
      },
      get center() {
        return new Vector(faceCenter(meshOf(id), f));
      },
      get area() {
        const me = meshOf(id);
        const vs = faceVerts(me, f);
        const P = me.positions;
        let ax = 0,
          ay = 0,
          az = 0;
        for (let k = 1; k + 1 < vs.length; k++) {
          const a = vs[0] * 3,
            b = vs[k] * 3,
            c = vs[k + 1] * 3;
          const ux = P[b] - P[a],
            uy = P[b + 1] - P[a + 1],
            uz = P[b + 2] - P[a + 2];
          const vx = P[c] - P[a],
            vy = P[c + 1] - P[a + 1],
            vz = P[c + 2] - P[a + 2];
          ax += uy * vz - uz * vy;
          ay += uz * vx - ux * vz;
          az += ux * vy - uy * vx;
        }
        return Math.hypot(ax, ay, az) / 2;
      },
      get use_smooth() {
        return !!meshOf(id).smooth?.[f];
      },
      set use_smooth(v: boolean) {
        const me = meshOf(id);
        if (!me.smooth) me.smooth = new Uint8Array(me.offsets.length - 1);
        cow(me, 'smooth')![f] = v ? 1 : 0;
        touched('geometry');
      },
      get material_index() {
        return meshOf(id).material_index?.[f] ?? 0;
      },
      set material_index(v: number) {
        const me = meshOf(id);
        if (!me.material_index) me.material_index = new Uint16Array(me.offsets.length - 1);
        cow(me, 'material_index')![f] = Math.max(0, Math.round(v));
        touched('geometry');
      },
      get select() {
        const me = meshOf(id);
        return faceVerts(me, f).every((v) => me.select_vert?.[v]);
      },
    };
  }
  foreach_set(attr: string, seq: unknown) {
    const a = toPlain(seq) as number[];
    const me = meshOf(this.meId);
    const n = me.offsets.length - 1;
    if (a.length !== n) throw pyError('ValueError', `foreach_set: expected ${n} values, got ${a.length}`);
    if (attr === 'use_smooth') me.smooth = Uint8Array.from(a, (x) => (x ? 1 : 0));
    else if (attr === 'material_index') me.material_index = Uint16Array.from(a);
    else throw pyError('TypeError', `foreach_set: unsupported attribute "${attr}" (supported: use_smooth, material_index)`);
    touched('geometry');
  }
}

class MeshLoops extends PropCollection<unknown> {
  constructor(readonly meId: string) {
    super(`bpy.data.meshes[${JSON.stringify(tableOf(app.doc, 'meshes')[meId]?.name)}].loops`);
  }
  override get length() {
    return meshOf(this.meId).indices.length;
  }
  list() {
    const me = meshOf(this.meId);
    return Array.from(me.indices, (v, i) => ({ __kind: 'struct', __type: 'MeshLoop', index: i, vertex_index: v }));
  }
  nameOf() {
    return '';
  }
  override getItem(key: number | string) {
    if (typeof key !== 'number') throw pyError('TypeError', 'bpy_prop_collection: index must be an int');
    const me = meshOf(this.meId);
    const n = me.indices.length;
    const i = key < 0 ? key + n : key;
    if (i < 0 || i >= n) throw pyError('IndexError', `bpy_prop_collection[index]: index ${key} out of range, size ${n}`);
    return { __kind: 'struct', __type: 'MeshLoop', index: i, vertex_index: me.indices[i] };
  }
  foreach_get(attr: string, seq?: unknown) {
    if (attr !== 'vertex_index') throw pyError('TypeError', `foreach_get: unsupported attribute "${attr}" (supported: vertex_index)`);
    const out = Array.from(meshOf(this.meId).indices);
    if (Array.isArray(seq)) for (let i = 0; i < out.length && i < seq.length; i++) seq[i] = out[i];
    return out;
  }
}

const hasUVs = (me: MeshData) => me.indices.length > 0 && me.uvs.length === me.indices.length * 2;

/**
 * A mesh's UV maps. Meshes here have one, stored per face corner (loop):
 * uv_layers.active.data[loop_index].uv, or all at once with
 * foreach_get / foreach_set('uv', flat). new() gives the one map a name.
 */
class MeshUVLayers extends PropCollection<unknown> {
  constructor(readonly meId: string) {
    super(`bpy.data.meshes[${JSON.stringify(tableOf(app.doc, 'meshes')[meId]?.name)}].uv_layers`);
  }
  list() {
    return hasUVs(meshOf(this.meId)) ? [this.layer()] : [];
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  get active() {
    return hasUVs(meshOf(this.meId)) ? this.layer() : null;
  }
  set active(_v: unknown) {
    /* there is only one */
  }
  /** The mesh's UV map, made (all corners at 0, 0) if it has none; a mesh holds one, so a second new() returns it renamed. */
  new(name = 'UVMap', do_init = true) {
    void do_init;
    const me = meshOf(this.meId);
    if (!me.indices.length) throw pyError('RuntimeError', 'Error: a mesh without faces has no UV map; build its faces first');
    if (!hasUVs(me)) me.uvs = new Float32Array(me.indices.length * 2);
    me.uv_map_name = String(name || 'UVMap');
    touched('geometry');
    return this.layer();
  }
  remove(_layer: unknown) {
    throw pyError('RuntimeError', 'Error: this app keeps one UV map per mesh; it cannot be removed');
  }
  private layer() {
    const id = this.meId;
    const path = `${this.__path}[${JSON.stringify(meshOf(id).uv_map_name || 'UVMap')}]`;
    const n = () => meshOf(id).indices.length;
    const write = (i: number, u: number, v: number) => {
      const uvs = cow(meshOf(id), 'uvs');
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
      touched('geometry');
    };
    const loop = (i: number) => ({
      __kind: 'struct',
      __type: 'MeshUVLoop',
      get uv() {
        return boundVector(
          'VECTOR',
          () => meshOf(id).uvs.subarray(i * 2, i * 2 + 2),
          (k, x) => {
            cow(meshOf(id), 'uvs')[i * 2 + k] = x;
            touched('geometry');
          },
        );
      },
      set uv(v: unknown) {
        const a = toPlain(v) as number[];
        write(i, Number(a?.[0]), Number(a?.[1]));
      },
      toString: () => `<bpy_struct, MeshUVLoop at ${path}.data[${i}]>`,
    });
    const data = new (class extends PropCollection<unknown> {
      override get length() {
        return n();
      }
      list() {
        return Array.from({ length: n() }, (_, i) => loop(i));
      }
      nameOf() {
        return '';
      }
      override getItem(key: number | string) {
        if (typeof key !== 'number') throw pyError('TypeError', 'bpy_prop_collection: index must be an int');
        const i = key < 0 ? key + n() : key;
        if (i < 0 || i >= n()) throw pyError('IndexError', `bpy_prop_collection[index]: index ${key} out of range, size ${n()}`);
        return loop(i);
      }
      foreach_get(attr: string, seq?: unknown) {
        return uvForeachGet(attr, seq);
      }
      foreach_set(attr: string, seq: unknown) {
        uvForeachSet(attr, seq);
      }
    })(`${path}.data`);
    const uvForeachGet = (attr: string, seq?: unknown) => {
      if (attr !== 'uv') throw pyError('TypeError', `foreach_get: unsupported attribute "${attr}" (supported: uv)`);
      const out = Array.from(meshOf(id).uvs);
      if (Array.isArray(seq)) for (let i = 0; i < out.length && i < seq.length; i++) seq[i] = out[i];
      return out;
    };
    const uvForeachSet = (attr: string, seq: unknown) => {
      if (attr !== 'uv') throw pyError('TypeError', `foreach_set: unsupported attribute "${attr}" (supported: uv)`);
      const a = (toPlain(seq) as unknown[]).flat() as number[];
      const me = meshOf(id);
      if (a.length !== me.indices.length * 2) throw pyError('ValueError', `foreach_set: expected ${me.indices.length * 2} values (u, v per loop), got ${a.length}`);
      me.uvs = Float32Array.from(a, Number);
      touched('geometry');
    };
    return {
      __kind: 'struct',
      __type: 'MeshUVLoopLayer',
      get name() {
        return meshOf(id).uv_map_name || 'UVMap';
      },
      set name(v: string) {
        meshOf(id).uv_map_name = String(v || 'UVMap');
        touched();
      },
      active: true,
      active_render: true,
      data,
      foreach_get: uvForeachGet,
      foreach_set: uvForeachSet,
      toString: () => `<bpy_struct, MeshUVLoopLayer("${meshOf(id).uv_map_name || 'UVMap'}") at ${path}>`,
    };
  }
}
kwMethod(MeshUVLayers.prototype, 'new', ['name', 'do_init']);

/** Material slots of mesh/curve data: append / pop / clear. */
class IDMaterials extends PropCollection<unknown> {
  constructor(
    readonly owner: () => { materials: (ID | null)[] },
    path: string,
  ) {
    super(path);
  }
  list() {
    return this.owner().materials.map((id) => (id && app.doc.materials[id] ? wrapId('materials', id) : null));
  }
  nameOf(x: unknown) {
    return (x as { name?: string } | null)?.name ?? '';
  }
  append(mat: unknown) {
    const id = mat === null || mat === undefined ? null : expectId(mat, 'materials', 'Material');
    this.owner().materials.push(id);
    touched();
  }
  pop(index = -1) {
    const l = this.owner().materials;
    const i = index < 0 ? l.length + index : index;
    if (i < 0 || i >= l.length) throw pyError('IndexError', 'pop index out of range');
    const [id] = l.splice(i, 1);
    touched();
    return id ? wrapId('materials', id) : null;
  }
  clear() {
    this.owner().materials.length = 0;
    touched();
  }
  setItem(i: number, mat: unknown) {
    const l = this.owner().materials;
    if (i < 0) i += l.length;
    if (i < 0 || i >= l.length) throw pyError('IndexError', 'index out of range');
    l[i] = mat === null || mat === undefined ? null : expectId(mat, 'materials', 'Material');
    touched();
  }
}

// ---------------------------------------------------------------------------
// Materials, worlds, node trees

/** Public default values of common shader node inputs (used when a value was never set). */
const SOCKET_DEFAULTS: Record<string, Record<string, unknown>> = {
  ShaderNodeBsdfPrincipled: {
    'Base Color': [0.8, 0.8, 0.8, 1],
    Metallic: 0,
    Roughness: 0.5,
    IOR: 1.5,
    Alpha: 1,
    Normal: [0, 0, 0],
    'Subsurface Weight': 0,
    'Subsurface Radius': [1, 0.2, 0.1],
    'Subsurface Scale': 0.05,
    'Specular IOR Level': 0.5,
    'Specular Tint': [1, 1, 1, 1],
    Anisotropic: 0,
    'Anisotropic Rotation': 0,
    'Transmission Weight': 0,
    'Coat Weight': 0,
    'Coat Roughness': 0.03,
    'Coat IOR': 1.5,
    'Sheen Weight': 0,
    'Sheen Roughness': 0.5,
    'Emission Color': [1, 1, 1, 1],
    'Emission Strength': 0,
    'Thin Film Thickness': 0,
  },
  ShaderNodeEmission: { Color: [1, 1, 1, 1], Strength: 1 },
  ShaderNodeBackground: { Color: [0.05, 0.05, 0.05, 1], Strength: 1 },
  ShaderNodeBsdfDiffuse: { Color: [0.8, 0.8, 0.8, 1], Roughness: 0 },
  ShaderNodeMixShader: { Fac: 0.5 },
  ShaderNodeBsdfGlass: { Color: [1, 1, 1, 1], Roughness: 0, IOR: 1.5 },
  ShaderNodeBsdfTransparent: { Color: [1, 1, 1, 1] },
  ShaderNodeValue: { Value: 0.5 },
};

/** Legacy node type names, and what replaced them. */
const LEGACY_NODES: Record<string, string> = {
  ShaderNodeMixRGB: "ShaderNodeMix with data_type = 'RGBA'; its sockets are Factor, A, B and Result",
  ShaderNodeTexMusgrave: 'ShaderNodeTexNoise (noise_type FBM, MULTIFRACTAL, …)',
  ShaderNodeBsdfGlossy: 'ShaderNodeBsdfAnisotropic',
  ShaderNodeBsdfVelvet: 'ShaderNodeBsdfSheen',
  ShaderNodeSeparateRGB: 'ShaderNodeSeparateColor',
  ShaderNodeCombineRGB: 'ShaderNodeCombineColor',
  ShaderNodeSeparateHSV: "ShaderNodeSeparateColor with mode = 'HSV'",
  ShaderNodeCombineHSV: "ShaderNodeCombineColor with mode = 'HSV'",
};

const NODE_LABELS: Record<string, string> = {
  ShaderNodeBsdfPrincipled: 'Principled BSDF',
  ShaderNodeOutputMaterial: 'Material Output',
  ShaderNodeOutputWorld: 'World Output',
  ShaderNodeTexImage: 'Image Texture',
  ShaderNodeTexNoise: 'Noise Texture',
  ShaderNodeTexCoord: 'Texture Coordinate',
  ShaderNodeMixShader: 'Mix Shader',
  ShaderNodeBsdfDiffuse: 'Diffuse BSDF',
  ShaderNodeValToRGB: 'Color Ramp',
  ShaderNodeRGB: 'RGB',
};

function nodeLabel(type: string) {
  if (NODE_LABELS[type]) return NODE_LABELS[type];
  const stem = type.replace(/^(ShaderNode|GeometryNode|CompositorNode|FunctionNode|NodeGroup|Node)/, '');
  return (
    stem
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^Bsdf (.*)$/, '$1 BSDF')
      .replace(/^Tex (.*)$/, '$1 Texture') || type
  );
}

function nodeTypeEnum(bl: string) {
  return nodeLabel(bl).toUpperCase().replace(/\s+/g, '_');
}

class NodeTreeStruct extends Struct {
  constructor(
    readonly getTree: () => NodeTreeData | null | undefined,
    path: string,
    readonly ownerName: string,
  ) {
    super('NodeTree', () => getTree() as unknown as Raw, path);
  }
  get nodes() {
    return new NodesCollection(this.getTree, `${this.__path}.nodes`);
  }
  get links() {
    return new LinksCollection(this.getTree, `${this.__path}.links`);
  }
  get name() {
    return this.ownerName;
  }
  get bl_idname() {
    const t = this.getTree()?.type;
    return t === 'GEOMETRY' ? 'GeometryNodeTree' : t === 'COMPOSITOR' ? 'CompositorNodeTree' : 'ShaderNodeTree';
  }
}

const treeOrThrow = (get: () => NodeTreeData | null | undefined) => {
  const t = get();
  if (!t) throw pyError('ReferenceError', 'node tree has been removed');
  return t;
};

class NodesCollection extends PropCollection<unknown> {
  constructor(
    readonly getTree: () => NodeTreeData | null | undefined,
    path: string,
  ) {
    super(path);
  }
  list() {
    return treeOrThrow(this.getTree).nodes.map((n) => nodeWrapper(this.getTree, n.id, this.__path));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  new(type: string) {
    const tree = treeOrThrow(this.getTree);
    if (typeof type !== 'string' || !/^[A-Z][A-Za-z0-9]+$/.test(type)) throw pyError('RuntimeError', `Error: Node type ${type} undefined`);
    let n: NodeData;
    if (getNodeType(type)) {
      // A registered type gets its default settings and set-up, as when added in the node editor.
      n = makeNode(tree, type, [0, 0]);
      n.name = uniqueName(Object.fromEntries(tree.nodes.map((x) => [x.id, x])), n.name);
      n.select = true;
    } else if (Object.values(nodeTypes).some((d) => d.treeTypes.includes(tree.type) && !d.idname.startsWith('Node') && !d.idname.endsWith('NodeGroup'))) {
      const hint = LEGACY_NODES[type] ? ` (use ${LEGACY_NODES[type]})` : '';
      throw pyError('RuntimeError', `Error: Node type ${type} undefined${hint}`);
    } else {
      // Without this kind of tree's own node definitions loaded (only frames, reroutes and groups), any type is accepted so values can be set ahead of them.
      const label = nodeLabel(type);
      n = { id: uid('node'), type, name: uniqueName(Object.fromEntries(tree.nodes.map((x) => [x.id, x])), label), location: [0, 0], inputs: {}, props: {}, select: true };
    }
    for (const o of tree.nodes) o.select = false;
    tree.nodes.push(n);
    tree.active_node = n.id;
    touched();
    return nodeWrapper(this.getTree, n.id, this.__path);
  }
  remove(node: unknown) {
    const tree = treeOrThrow(this.getTree);
    const id = (node as { __nid?: string })?.__nid;
    const i = tree.nodes.findIndex((n) => n.id === id);
    if (i < 0) throw pyError('RuntimeError', 'Error: unable to locate node in this tree');
    tree.nodes.splice(i, 1);
    tree.links = tree.links.filter((l) => l.from_node !== id && l.to_node !== id);
    touched();
  }
  clear() {
    const tree = treeOrThrow(this.getTree);
    tree.nodes = [];
    tree.links = [];
    touched();
  }
  get active() {
    const tree = treeOrThrow(this.getTree);
    return tree.active_node && tree.nodes.some((n) => n.id === tree.active_node) ? nodeWrapper(this.getTree, tree.active_node, this.__path) : null;
  }
  set active(v: unknown) {
    const tree = treeOrThrow(this.getTree);
    tree.active_node = (v as { __nid?: string })?.__nid ?? null;
    touched();
  }
}
kwMethod(NodesCollection.prototype, 'new', ['type']);

class NodeStruct extends Struct {
  constructor(
    readonly getTree: () => NodeTreeData | null | undefined,
    readonly __nid: string,
    path: string,
  ) {
    super('Node', () => getTree()?.nodes.find((n) => n.id === __nid) as unknown as Raw, path);
  }
  private get node() {
    return this.__raw as unknown as NodeData;
  }
  override __extra() {
    return (this.__resolve()?.props as Raw) ?? null;
  }
  override __hidden() {
    return NODE_HIDDEN;
  }
  get bl_idname() {
    return this.node.type;
  }
  get type() {
    return nodeTypeEnum(this.node.type);
  }
  get name() {
    return this.node.name;
  }
  set name(v: string) {
    const tree = treeOrThrow(this.getTree);
    this.node.name = uniqueName(Object.fromEntries(tree.nodes.map((x) => [x.id, x])), String(v), this.__nid);
    touched();
  }
  get inputs() {
    return new SocketsCollection(this.getTree, this.__nid, false, `${this.__path}.inputs`);
  }
  /** Color Ramp nodes: the ramp (stored flat as position, r, g, b, a per stop). */
  get color_ramp() {
    if (!Array.isArray(this.node.props.color_ramp)) return undefined;
    return colorRamp(() => this.node, `${this.__path}.color_ramp`);
  }
  get outputs() {
    return new SocketsCollection(this.getTree, this.__nid, true, `${this.__path}.outputs`);
  }
  /** Image Texture, Environment Texture and image nodes: the image (stored as its id, unset until one is chosen). */
  get image() {
    if (!this.hasImage()) return undefined;
    const id = this.node.props.image as string | null | undefined;
    return id && app.doc.images[id] ? wrapId('images', id) : null;
  }
  set image(v: unknown) {
    if (!this.hasImage()) throw pyError('AttributeError', `'${nodeLabel(this.node.type).replace(/ /g, '')}' object has no attribute 'image'`);
    if (v !== null && v !== undefined && !(isIdWrapper(v) && v.__table === 'images')) throw pyError('TypeError', `${this.node.type}.image expected an Image (bpy.data.images[...]) or None`);
    this.node.props.image = v ? (v as { __id: string }).__id : null;
    touched();
  }
  private hasImage() {
    return 'image' in this.node.props || !!getNodeType(this.node.type)?.props.some((p) => p.id === 'image' && p.type === 'IMAGE');
  }
  // zone and bake items (output nodes of zones, Bake nodes) and zone pairing
  get repeat_items() {
    return zoneItemsFor(this.getTree, this.__nid, 'repeat_items', `${this.__path}.repeat_items`);
  }
  get state_items() {
    return zoneItemsFor(this.getTree, this.__nid, 'state_items', `${this.__path}.state_items`);
  }
  get input_items() {
    return zoneItemsFor(this.getTree, this.__nid, 'input_items', `${this.__path}.input_items`);
  }
  get main_items() {
    return zoneItemsFor(this.getTree, this.__nid, 'main_items', `${this.__path}.main_items`);
  }
  get generation_items() {
    return zoneItemsFor(this.getTree, this.__nid, 'generation_items', `${this.__path}.generation_items`);
  }
  get bake_items() {
    return zoneItemsFor(this.getTree, this.__nid, 'bake_items', `${this.__path}.bake_items`);
  }
  // Format String, Index Switch and Menu Switch items
  get format_items() {
    return nodeItemsFor(this.getTree, this.__nid, 'format_items', `${this.__path}.format_items`);
  }
  get index_switch_items() {
    return nodeItemsFor(this.getTree, this.__nid, 'index_switch_items', `${this.__path}.index_switch_items`);
  }
  get enum_items() {
    return nodeItemsFor(this.getTree, this.__nid, 'enum_items', `${this.__path}.enum_items`);
  }
  get paired_output(): unknown {
    const id = this.node.props.paired_output;
    return typeof id === 'string' && this.getTree()?.nodes.some((n) => n.id === id) ? nodeWrapper(this.getTree, id, this.__path.replace(/\[[^\]]*\]$/, '')) : undefined;
  }
  pair_with_output(output: unknown) {
    return pairWithOutput(this.getTree, this.__nid, output);
  }
}
const NODE_HIDDEN = new Set(['id', 'type', 'inputs', 'props', 'parent']);

const RAMP_STRIDE = 5;

function colorRamp(node: () => NodeData, path: string) {
  const flat = () => node().props.color_ramp as number[];
  /** Writes the stops back, sorted by position. */
  const write = (f: number[]) => {
    const stops: number[][] = [];
    for (let i = 0; i + RAMP_STRIDE <= f.length; i += RAMP_STRIDE) stops.push(f.slice(i, i + RAMP_STRIDE));
    stops.sort((a, b) => a[0] - b[0]);
    node().props.color_ramp = stops.flat();
    touched();
  };
  const elements = new RampElements(flat, write, `${path}.elements`);
  const prop = (key: string, def: string) => ({
    get: () => (node().props[key] as string | undefined) ?? def,
    set: (v: string) => {
      node().props[key] = String(v);
      touched();
    },
    enumerable: true,
  });
  return Object.defineProperties(
    { __kind: 'struct', __type: 'ColorRamp', elements, evaluate: (pos: number) => evaluateRamp(flat(), Number(pos)), toString: () => `<bpy_struct, ColorRamp at ${path}>` },
    { interpolation: prop('ramp_interpolation', 'LINEAR'), color_mode: prop('ramp_color_mode', 'RGB'), hue_interpolation: prop('ramp_hue_interpolation', 'NEAR') },
  );
}

/** Linear blend of the stops at `pos` (for ColorRamp.evaluate and new stops). */
function evaluateRamp(f: number[], pos: number): number[] {
  const stops: number[][] = [];
  for (let i = 0; i + RAMP_STRIDE <= f.length; i += RAMP_STRIDE) stops.push(f.slice(i, i + RAMP_STRIDE));
  stops.sort((a, b) => a[0] - b[0]);
  if (!stops.length) return [0, 0, 0, 1];
  if (pos <= stops[0][0]) return stops[0].slice(1);
  for (let i = 1; i < stops.length; i++) {
    if (pos <= stops[i][0]) {
      const a = stops[i - 1],
        b = stops[i];
      const t = b[0] > a[0] ? (pos - a[0]) / (b[0] - a[0]) : 0;
      return [1, 2, 3, 4].map((k) => a[k] + (b[k] - a[k]) * t);
    }
  }
  return stops[stops.length - 1].slice(1);
}

class RampElements extends PropCollection<unknown> {
  constructor(
    private flat: () => number[],
    private write: (f: number[]) => void,
    path: string,
  ) {
    super(path);
  }
  list() {
    return Array.from({ length: Math.floor(this.flat().length / RAMP_STRIDE) }, (_, i) => this.element(i));
  }
  nameOf() {
    return '';
  }
  private element(i: number) {
    const self = this;
    const at = (k: number) => self.flat()[i * RAMP_STRIDE + k];
    const set = (k: number, v: number) => {
      const f = [...self.flat()];
      f[i * RAMP_STRIDE + k] = v;
      self.write(f);
    };
    return {
      __kind: 'struct',
      __type: 'ColorRampElement',
      __index: i,
      get position() {
        return at(0);
      },
      set position(v: number) {
        set(0, Math.max(0, Math.min(1, Number(v))));
      },
      get color() {
        return boundVector(
          'COLOR',
          () => self.flat().slice(i * RAMP_STRIDE + 1, i * RAMP_STRIDE + 5),
          (k, x) => set(k + 1, x),
        );
      },
      set color(v: unknown) {
        const c = toPlain(v) as number[];
        const f = [...self.flat()];
        for (let k = 0; k < 4; k++) f[i * RAMP_STRIDE + 1 + k] = Number(c[k] ?? (k === 3 ? 1 : 0));
        self.write(f);
      },
      get alpha() {
        return at(4);
      },
      set alpha(v: number) {
        set(4, Number(v));
      },
      toString: () => `<bpy_struct, ColorRampElement at ${self.__path}[${i}]>`,
    };
  }
  /** A stop at `position`, colored as the ramp is there. */
  new(position: number) {
    const pos = Math.max(0, Math.min(1, Number(position)));
    this.write([...this.flat(), pos, ...evaluateRamp(this.flat(), pos)]);
    const i = this.list().findIndex((e) => (e as { position: number }).position === pos);
    return this.getItem(i < 0 ? this.length - 1 : i);
  }
  remove(element: unknown) {
    const i = (element as { __index?: number })?.__index;
    if (typeof i !== 'number' || i < 0 || i >= this.length) throw pyError('ValueError', 'ColorRampElements.remove(): element not found');
    if (this.length <= 1) throw pyError('RuntimeError', 'Error: unable to delete the only element');
    const f = [...this.flat()];
    f.splice(i * RAMP_STRIDE, RAMP_STRIDE);
    this.write(f);
  }
}
kwMethod(RampElements.prototype, 'new', ['position']);

function nodeWrapper(getTree: () => NodeTreeData | null | undefined, nid: string, base: string) {
  const s = new NodeStruct(getTree, nid, '');
  Object.defineProperty(s, '__path', { get: () => `${base}[${JSON.stringify(getTree()?.nodes.find((n) => n.id === nid)?.name)}]` });
  return proxify(s);
}

/**
 * A node's sockets. On a registered node type they are the node's real sockets
 * (looked up by name, then identifier; values and links are stored by
 * identifier). On an unknown type any name is accepted, so values can be set
 * before node definitions exist.
 */
class SocketsCollection extends PropCollection<unknown> {
  constructor(
    readonly getTree: () => NodeTreeData | null | undefined,
    readonly nid: string,
    readonly output: boolean,
    path: string,
  ) {
    super(path);
  }
  private node() {
    const n = treeOrThrow(this.getTree).nodes.find((x) => x.id === this.nid);
    if (!n) throw pyError('ReferenceError', 'node has been removed');
    return n;
  }
  /** The node's current sockets on this side, or null for an unknown node type. */
  private defs(all = false): SocketDef[] | null {
    const n = this.node();
    if (!getNodeType(n.type)) return null;
    const ctx = ctxOf(app.doc, treeOrThrow(this.getTree));
    const s = all ? allSockets(n, ctx) : nodeSockets(n, ctx);
    return this.output ? s.outputs : s.inputs;
  }
  /** A socket by name or identifier: the available ones first, then any the node type has. */
  private lookup(key: string): SocketDef | null {
    for (const list of [this.defs(), this.defs(true)]) {
      const hit = list?.find((d) => d.name === key) ?? list?.find((d) => d.identifier === key);
      if (hit) return hit;
    }
    return null;
  }
  list() {
    // Every socket in order, the unavailable ones too (enabled false), so indices stay stable.
    const all = this.defs(true);
    if (all) {
      const on = new Set(this.defs()!.map((d) => d.identifier));
      return all.map((d) => this.socket(d.identifier, d, on.has(d.identifier)));
    }
    const n = this.node();
    const tree = treeOrThrow(this.getTree);
    const names = new Set<string>();
    if (this.output) {
      for (const l of tree.links) if (l.from_node === n.id) names.add(l.from_socket);
    } else {
      Object.keys(SOCKET_DEFAULTS[n.type] ?? {}).forEach((k) => names.add(k));
      Object.keys(n.inputs).forEach((k) => names.add(k));
      for (const l of tree.links) if (l.to_node === n.id) names.add(l.to_socket);
    }
    return [...names].map((k) => this.socket(k));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  override getItem(key: number | string) {
    if (typeof key === 'number') return super.getItem(key);
    const defs = this.defs();
    if (!defs) return this.socket(key);
    const d = this.lookup(key);
    if (!d) {
      const menu = this.output ? undefined : this.menuProp(key);
      if (menu) return menu;
      throw pyError('KeyError', `'bpy_prop_collection[key]: key "${key}" not found' (${this.output ? 'outputs' : 'inputs'}: ${defs.map((x) => JSON.stringify(x.name)).join(', ') || 'none'})`);
    }
    return this.socket(
      d.identifier,
      d,
      defs.some((x) => x.identifier === d.identifier),
    );
  }
  /** A menu input the node shows as a property (e.g. Match String's Operation): its value is the property. */
  private menuProp(key: string) {
    const n = this.node();
    const p = getNodeType(n.type)?.props.find((x) => x.id === key && x.type === 'ENUM' && x.noLabel && x.items?.some(([v, l]) => v === l));
    if (!p) return undefined;
    const self = this;
    return {
      __kind: 'struct',
      __type: 'NodeSocketMenu',
      name: key,
      identifier: key,
      type: 'MENU',
      is_output: false,
      enabled: true,
      is_linked: false,
      get default_value() {
        return (self.node().props[key] ?? p.d ?? null) as unknown;
      },
      set default_value(v: unknown) {
        const val = String(v);
        if (!p.items!.some(([x]) => x === val)) throw pyError('TypeError', `bpy_struct: item.default_value = '${val}': enum "${val}" not found in (${p.items!.map(([x]) => `'${x}'`).join(', ')})`);
        self.node().props[key] = val;
        touched();
      },
      toString: () => `<bpy_struct, NodeSocketMenu("${key}")>`,
    };
  }
  override get(key: string | number, ...rest: unknown[]) {
    const def = rest.length ? rest[0] : null;
    if (typeof key === 'string') {
      // inputs['Name'] (the collection proxy passes an explicit undefined) raises, naming the sockets there are.
      if (rest.length === 1 && rest[0] === undefined && this.defs() && !/^(_|then$|toJSON$|asymmetricMatch$|nodeType$|\$\$)/.test(key)) return this.getItem(key);
      try {
        return this.getItem(key);
      } catch {
        return def;
      }
    }
    return super.get(key, def);
  }
  private socket(id: string, d?: SocketDef, enabled = true) {
    const self = this;
    const name = d?.name ?? id;
    const fallback = () => (d ? socketDefault(d) : ((SOCKET_DEFAULTS[self.node().type]?.[id] as unknown) ?? null));
    return {
      __kind: 'struct',
      __type: this.output ? 'NodeSocketOutput' : 'NodeSocketInput',
      __socket: { node: this.nid, name: id, output: this.output, tree: this.getTree },
      name,
      identifier: id,
      type: d?.type ?? 'VALUE',
      is_output: this.output,
      enabled,
      get node() {
        return nodeWrapper(self.getTree, self.nid, self.__path.replace(/\.(inputs|outputs)$/, '').replace(/\[[^\]]*\]$/, ''));
      },
      get is_linked() {
        return treeOrThrow(self.getTree).links.some((l) => (self.output ? l.from_node === self.nid && l.from_socket === id : l.to_node === self.nid && l.to_socket === id));
      },
      get links() {
        return new LinksCollection(self.getTree, `${self.__path}[${JSON.stringify(name)}].links`, (l) =>
          self.output ? l.from_node === self.nid && l.from_socket === id : l.to_node === self.nid && l.to_socket === id,
        ).list();
      },
      get default_value() {
        const n = self.node();
        if (self.output) return (n.props.value ?? null) as unknown;
        const v = (n.inputs[id] as unknown) ?? fallback();
        if (Array.isArray(v) && v.length >= 2 && v.length <= 4)
          return boundVector(
            v.length === 4 || /color/i.test(name) ? 'COLOR' : 'VECTOR',
            () => (self.node().inputs[id] ?? fallback() ?? v) as number[],
            (i, x) => {
              const node = self.node();
              const cur = Array.isArray(node.inputs[id]) ? (node.inputs[id] as number[]) : [...(v as number[])];
              cur[i] = x;
              node.inputs[id] = cur;
              touched();
            },
          );
        return v;
      },
      set default_value(val: unknown) {
        const n = self.node();
        const p = toPlain(val);
        if (self.output) n.props.value = p as never;
        else n.inputs[id] = p as never;
        touched();
      },
      toString: () => `<bpy_struct, NodeSocket("${name}")>`,
    };
  }
}

class LinksCollection extends PropCollection<unknown> {
  constructor(
    readonly getTree: () => NodeTreeData | null | undefined,
    path: string,
    readonly filter: (l: NodeTreeData['links'][number]) => boolean = () => true,
  ) {
    super(path);
  }
  list() {
    const tree = treeOrThrow(this.getTree);
    return tree.links.filter(this.filter).map((l) => this.wrap(l.id));
  }
  nameOf() {
    return '';
  }
  private wrap(lid: string) {
    const getTree = this.getTree;
    const s = new Struct('NodeLink', () => getTree()?.links.find((l) => l.id === lid) as unknown as Raw, `${this.__path}`);
    const link = () => treeOrThrow(getTree).links.find((l) => l.id === lid);
    const base = this.__path.replace(/\.links$/, '.nodes').replace(/\.nodes\[.*$/, '.nodes');
    Object.defineProperty(s, '__lid', { value: lid });
    return proxify(
      Object.defineProperties(s, {
        from_node: { get: () => nodeWrapper(getTree, link()!.from_node, base) },
        to_node: { get: () => nodeWrapper(getTree, link()!.to_node, base) },
        from_socket: { get: () => (nodeWrapper(getTree, link()!.from_node, base) as unknown as NodeStruct).outputs.getItem(link()!.from_socket) },
        to_socket: { get: () => (nodeWrapper(getTree, link()!.to_node, base) as unknown as NodeStruct).inputs.getItem(link()!.to_socket) },
        is_valid: { get: () => true },
      }),
    );
  }
  /** links.new(output_socket, input_socket) */
  new(a: unknown, b: unknown, verify_limits = true) {
    void verify_limits;
    const tree = treeOrThrow(this.getTree);
    const sa = (a as { __socket?: { node: string; name: string; output: boolean } })?.__socket;
    const sb = (b as { __socket?: { node: string; name: string; output: boolean } })?.__socket;
    if (!sa || !sb) throw pyError('TypeError', 'NodeLinks.new(): expected two node sockets');
    let from = sa,
      to = sb;
    if (!from.output && to.output) [from, to] = [to, from];
    if (!from.output || to.output) throw pyError('RuntimeError', 'Error: links must connect an output socket to an input socket');
    if (from.node === to.node) throw pyError('RuntimeError', 'Error: cannot link a node to itself');
    tree.links = tree.links.filter((l) => !(l.to_node === to.node && l.to_socket === to.name));
    const l = { id: uid('link'), from_node: from.node, from_socket: from.name, to_node: to.node, to_socket: to.name };
    tree.links.push(l);
    touched();
    return this.wrap(l.id);
  }
  remove(link: unknown) {
    const tree = treeOrThrow(this.getTree);
    const id = (link as { __lid?: string })?.__lid;
    const n = tree.links.length;
    tree.links = tree.links.filter((l) => l.id !== id);
    if (tree.links.length === n) throw pyError('RuntimeError', 'Error: unable to locate link in node tree');
    touched();
  }
  clear() {
    treeOrThrow(this.getTree).links = [];
    touched();
  }
}
kwMethod(LinksCollection.prototype, 'new', ['input', 'output', 'verify_limits']);

class MaterialStruct extends IDStruct {
  override __hidden() {
    return TREE_HIDDEN;
  }
  get node_tree() {
    const id = this.__id;
    return proxify(new NodeTreeStruct(() => (tableOf(app.doc, 'materials')[id] as unknown as MaterialData | undefined)?.tree, `${this.__path}.node_tree`, 'Shader Nodetree'));
  }
}
const TREE_HIDDEN = new Set(['id', 'tree', 'users']);

class WorldStruct extends IDStruct {
  override __hidden() {
    return TREE_HIDDEN;
  }
  get node_tree() {
    const id = this.__id;
    return proxify(new NodeTreeStruct(() => (tableOf(app.doc, 'worlds')[id] as unknown as { tree: NodeTreeData } | undefined)?.tree, `${this.__path}.node_tree`, 'Shader Nodetree'));
  }
}

class NodeGroupStruct extends IDStruct {
  override __hidden() {
    return TREE_HIDDEN;
  }
  get nodes() {
    const id = this.__id;
    return new NodesCollection(() => (tableOf(app.doc, 'node_groups')[id] as unknown as { tree: NodeTreeData } | undefined)?.tree, `${this.__path}.nodes`);
  }
  get links() {
    const id = this.__id;
    return new LinksCollection(() => (tableOf(app.doc, 'node_groups')[id] as unknown as { tree: NodeTreeData } | undefined)?.tree, `${this.__path}.links`);
  }
  get bl_idname() {
    const t = (this.__raw.tree as NodeTreeData | undefined)?.type;
    return t === 'SHADER' ? 'ShaderNodeTree' : t === 'COMPOSITOR' ? 'CompositorNodeTree' : 'GeometryNodeTree';
  }
}

class ImageStruct extends IDStruct {
  override __hidden() {
    return IMAGE_HIDDEN;
  }
  get size() {
    return [this.__raw.width as number, this.__raw.height as number];
  }
  get has_data() {
    return !!this.__raw.bytes || this.__raw.source === 'GENERATED';
  }
  get is_dirty() {
    return false;
  }
}
const IMAGE_HIDDEN = new Set(['id', 'bytes', 'users']);

class TextStruct extends IDStruct {
  get t() {
    return this.__raw as unknown as TextData;
  }
  as_string() {
    return this.t.body;
  }
  from_string(s: string) {
    this.t.body = String(s);
    touched();
  }
  write(s: string) {
    this.t.body += String(s);
    touched();
  }
  clear() {
    this.t.body = '';
    touched();
  }
  get lines() {
    return this.t.body.split('\n').map((body, i) => ({ __kind: 'struct', __type: 'TextLine', body, index: i }));
  }
  get filepath() {
    return '';
  }
  get is_in_memory() {
    return true;
  }
}
kwMethod(TextStruct.prototype, 'from_string', ['string']);
kwMethod(TextStruct.prototype, 'write', ['text']);

class CollectionStruct extends IDStruct {
  private get col() {
    return this.__raw as unknown as CollectionData;
  }
  override __hidden() {
    return COLL_HIDDEN;
  }
  get objects() {
    return new CollectionObjects(this.__id);
  }
  get children() {
    return new CollectionChildren(this.__id);
  }
  get all_objects() {
    const out = new Set<string>();
    const walk = (cid: string, seen: Set<string>) => {
      const c = app.doc.collections[cid];
      if (!c || seen.has(cid)) return;
      seen.add(cid);
      c.objects.forEach((o) => out.add(o));
      c.children.forEach((x) => walk(x, seen));
    };
    walk(this.__id, new Set());
    return [...out].filter((id) => app.doc.objects[id]).map((id) => wrapId('objects', id));
  }
  get children_recursive() {
    const out: unknown[] = [];
    const walk = (cid: string) =>
      app.doc.collections[cid]?.children.forEach((c) => {
        out.push(wrapId('collections', c));
        walk(c);
      });
    walk(this.__id);
    return out;
  }
  override get name(): string {
    return this.col.name;
  }
  override set name(v: string) {
    if (this.__id === app.doc.scene.collection) throw pyError('AttributeError', 'the scene master collection cannot be renamed');
    super.name = v;
  }
}
const COLL_HIDDEN = new Set(['id', 'objects', 'children', 'users']);

class CollectionObjects extends PropCollection<unknown> {
  constructor(readonly cid: string) {
    super(`bpy.data.collections[${JSON.stringify(app.doc.collections[cid]?.name)}].objects`);
  }
  private col() {
    const c = app.doc.collections[this.cid];
    if (!c) throw pyError('ReferenceError', 'Collection has been removed');
    return c;
  }
  list() {
    return this.col()
      .objects.filter((id) => app.doc.objects[id])
      .map((id) => wrapId('objects', id));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  link(ob: unknown) {
    const id = expectId(ob, 'objects', 'Object');
    const c = this.col();
    if (c.objects.includes(id)) throw pyError('RuntimeError', `Object '${app.doc.objects[id].name}' already in collection '${c.name}'`);
    c.objects.push(id);
    if (!app.doc.object_order.includes(id)) app.doc.object_order.push(id);
    touched();
  }
  unlink(ob: unknown) {
    const id = expectId(ob, 'objects', 'Object');
    const c = this.col();
    if (!c.objects.includes(id)) throw pyError('RuntimeError', `Object '${app.doc.objects[id]?.name}' not in collection '${c.name}'`);
    c.objects = c.objects.filter((x) => x !== id);
    touched();
  }
}

class CollectionChildren extends PropCollection<unknown> {
  constructor(readonly cid: string) {
    super(`bpy.data.collections[${JSON.stringify(app.doc.collections[cid]?.name)}].children`);
  }
  private col() {
    const c = app.doc.collections[this.cid];
    if (!c) throw pyError('ReferenceError', 'Collection has been removed');
    return c;
  }
  list() {
    return this.col()
      .children.filter((id) => app.doc.collections[id])
      .map((id) => wrapId('collections', id));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  link(child: unknown) {
    const id = expectId(child, 'collections', 'Collection');
    const c = this.col();
    if (id === c.id) throw pyError('RuntimeError', 'a collection cannot contain itself');
    if (c.children.includes(id)) throw pyError('RuntimeError', `Collection '${app.doc.collections[id].name}' already in collection '${c.name}'`);
    // reject cycles
    const contains = (root: string): boolean => root === c.id || (app.doc.collections[root]?.children.some(contains) ?? false);
    if (contains(id)) throw pyError('RuntimeError', 'linking would create a cycle');
    c.children.push(id);
    touched();
  }
  unlink(child: unknown) {
    const id = expectId(child, 'collections', 'Collection');
    const c = this.col();
    c.children = c.children.filter((x) => x !== id);
    touched();
  }
}

class ActionStruct extends IDStruct {
  get fcurves() {
    const id = this.__id;
    const getAct = () => tableOf(app.doc, 'actions')[id] as unknown as import('../data/types').ActionData | undefined;
    const arr = new BoundArray('FCurve', `${this.__path}.fcurves`, () => getAct()?.fcurves as unknown[] | undefined, 'fcurves');
    return Object.assign(arr, {
      new: (data_path: string, index = 0, action_group = '') => {
        const act = getAct();
        if (!act) throw pyError('ReferenceError', 'Action has been removed');
        if (act.fcurves.some((f) => f.data_path === data_path && f.array_index === index)) throw pyError('RuntimeError', `F-Curve '${data_path}[${index}]' already exists in action '${act.name}'`);
        const fc = ensureFCurve(act, data_path, index);
        if (action_group) fc.group = action_group;
        touched();
        return fcurveWrapper(getAct, act.fcurves.length - 1, this.__path);
      },
      find: (data_path: string, index = 0) => {
        const act = getAct();
        const i = act?.fcurves.findIndex((f) => f.data_path === data_path && f.array_index === index) ?? -1;
        return i >= 0 ? fcurveWrapper(getAct, i, this.__path) : null;
      },
      remove: (fc: unknown) => {
        const act = getAct();
        const i = (fc as { __fi?: number })?.__fi ?? -1;
        if (!act || i < 0) throw pyError('ReferenceError', 'F-Curve not found');
        act.fcurves.splice(i, 1);
        touched();
      },
      getItem: (i: number) => fcurveWrapper(getAct, i < 0 ? (getAct()?.fcurves.length ?? 0) + i : i, this.__path),
    });
  }
  get frame_range() {
    let a = Infinity,
      b = -Infinity;
    for (const fc of (this.__raw.fcurves as { keyframe_points: { co: number[] }[] }[]) ?? [])
      for (const k of fc.keyframe_points) {
        a = Math.min(a, k.co[0]);
        b = Math.max(b, k.co[0]);
      }
    return Number.isFinite(a) ? new Vector([a, b]) : new Vector([0, 0]);
  }
}

function fcurveWrapper(getAct: () => import('../data/types').ActionData | undefined, i: number, base: string) {
  const s = new Struct('FCurve', () => getAct()?.fcurves[i] as unknown as Raw, `${base}.fcurves[${i}]`);
  Object.defineProperty(s, '__fi', { value: i });
  const fc = () => getAct()?.fcurves[i];
  Object.defineProperty(s, 'keyframe_points', {
    get: () => {
      const arr = new BoundArray('Keyframe', `${base}.fcurves[${i}].keyframe_points`, () => fc()?.keyframe_points as unknown[] | undefined, 'keyframe_points');
      return Object.assign(arr, {
        insert: (frame: number, value: number) => {
          const f = fc();
          if (!f) throw pyError('ReferenceError', 'F-Curve removed');
          insertKeyframe(f, Number(frame), Number(value));
          touched();
          return arr.getItem(f.keyframe_points.findIndex((k) => Math.abs(k.co[0] - frame) < 1e-4));
        },
        add: (count = 1) => {
          const f = fc();
          if (!f) throw pyError('ReferenceError', 'F-Curve removed');
          const last = f.keyframe_points[f.keyframe_points.length - 1]?.co[0] ?? 0;
          for (let k = 1; k <= count; k++) insertKeyframe(f, last + k, 0);
          touched();
        },
      });
    },
  });
  Object.defineProperty(s, 'evaluate', {
    value: (frame: number) => {
      const f = fc();
      if (!f) return 0;
      return evaluateFC(f, frame);
    },
  });
  return proxify(s);
}

class CameraStruct extends IDStruct {
  /**
   * The corners of the camera's frame in its local space
   * (top right, bottom right, bottom left, top left): with a
   * scene, shaped by its render resolution and pixel aspect; lens shift included.
   */
  view_frame(scene: unknown = null) {
    void scene;
    const ca = this.__raw as unknown as import('../data/types').CameraData;
    const r = app.doc.scene.render;
    const aspect = (r.resolution_x * r.pixel_aspect_x) / Math.max(1e-9, r.resolution_y * r.pixel_aspect_y);
    const horizontal = ca.sensor_fit === 'HORIZONTAL' || (ca.sensor_fit === 'AUTO' && aspect >= 1);
    const d = ca.display_size || 1;
    let half: number;
    if (ca.type === 'ORTHO') half = ca.ortho_scale / 2;
    else half = ((ca.sensor_fit === 'VERTICAL' ? ca.sensor_height : ca.sensor_width) / 2 / ca.lens) * d;
    const [w, h] = horizontal ? [half, half / aspect] : [half * aspect, half];
    const big = 2 * Math.max(w, h);
    const sx = ca.shift_x * big,
      sy = ca.shift_y * big;
    return [new Vector([w + sx, h + sy, -d]), new Vector([w + sx, -h + sy, -d]), new Vector([-w + sx, -h + sy, -d]), new Vector([-w + sx, h + sy, -d])];
  }
}
kwMethod(CameraStruct.prototype, 'view_frame', ['scene']);

/**
 * bpy_extras.object_utils.world_to_camera_view: where a
 * world-space point falls in the camera's frame, x and y from 0 to 1 (bottom
 * left to top right, outside that range when off frame) and z the distance in
 * front of the camera. Used for projecting a photo onto a model through the camera.
 */
function worldToCameraView(scene: unknown, obj: unknown, coord: unknown) {
  if (!isIdWrapper(obj) || obj.__table !== 'objects' || (obj as unknown as { type: string }).type !== 'CAMERA') throw pyError('TypeError', 'world_to_camera_view(): obj must be a camera object');
  const ob = obj as unknown as { matrix_world: Matrix; data: CameraStruct };
  const co = ob.matrix_world
    .normalized()
    .inverted()
    .matmul(toPlain(coord) as number[]) as Vector;
  const z = -co.z;
  const cam = ob.data;
  let frame = cam.view_frame(scene).slice(0, 3);
  if ((cam as unknown as { type: string }).type !== 'ORTHO') {
    if (z === 0) return new Vector([0.5, 0.5, 0]);
    frame = frame.map((v) => new Vector([-(v.x / (v.z / z)), -(v.y / (v.z / z)), -(v.z / (v.z / z))]));
  }
  const [minX, maxX] = [frame[2].x, frame[1].x];
  const [minY, maxY] = [frame[1].y, frame[0].y];
  return new Vector([(co.x - minX) / (maxX - minX), (co.y - minY) / (maxY - minY), z]);
}

export const bpy_extras = { object_utils: { world_to_camera_view: worldToCameraView } };

export const ID_CLASSES: Record<string, new (table: string, id: string) => IDStruct> = {
  objects: ObjectStruct,
  meshes: MeshStruct,
  materials: MaterialStruct,
  worlds: WorldStruct,
  node_groups: NodeGroupStruct,
  images: ImageStruct,
  cameras: CameraStruct,
  texts: TextStruct,
  collections: CollectionStruct,
  actions: ActionStruct,
};

// ---------------------------------------------------------------------------
// bpy.data collections

/** Remove objects and clean references (same semantics as deleting in the viewport). */
export function removeObjects(d: DocumentData, ids: Set<string>) {
  for (const id of ids) {
    if (!d.objects[id]) continue;
    for (const child of Object.values(d.objects)) if (child.parent === id) child.parent = null;
    delete d.objects[id];
    for (const c of Object.values(d.collections)) c.objects = c.objects.filter((x) => x !== id);
    if (d.scene.camera === id) d.scene.camera = null;
    if (d.scene.active_object === id) d.scene.active_object = null;
  }
  d.object_order = d.object_order.filter((x) => !ids.has(x));
  for (const ob of Object.values(d.objects)) {
    for (const m of ob.modifiers) for (const k of Object.keys(m)) if (typeof m[k] === 'string' && ids.has(m[k] as string)) m[k] = null;
    for (const c of ob.constraints) if (c.target && ids.has(c.target as string)) c.target = null;
  }
}

/** Remove a data-block and every reference to it (objects using removed object data are removed too). */
export function removeDataBlock(table: string, id: string) {
  const d = app.doc;
  if (table === 'objects') return removeObjects(d, new Set([id]));
  if (table === 'collections') {
    if (id === d.scene.collection) throw pyError('RuntimeError', 'the scene master collection cannot be removed');
    for (const c of Object.values(d.collections)) c.children = c.children.filter((x) => x !== id);
    delete d.collections[id];
    return;
  }
  if (TABLE_OBTYPE[table]) {
    const users = Object.values(d.objects).filter((o) => o.data === id);
    removeObjects(d, new Set(users.map((o) => o.id)));
  }
  delete tableOf(d, table)[id];
  // clear remaining string references
  const scrub = (v: unknown, depth: number) => {
    if (depth > 12 || !v || typeof v !== 'object' || ArrayBuffer.isView(v)) return;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++)
        if (v[i] === id) v[i] = null;
        else scrub(v[i], depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Raw)) {
      if (k === 'id') continue;
      if (x === id) (v as Raw)[k] = null;
      else scrub(x, depth + 1);
    }
  };
  scrub(d, 0);
}

class IDCollection extends PropCollection<unknown> {
  constructor(readonly table: string) {
    super(`bpy.data.${table}`);
  }
  list() {
    const t = tableOf(app.doc, this.table);
    if (this.table === 'objects') return app.doc.object_order.filter((id) => t[id]).map((id) => wrapId('objects', id));
    return Object.keys(t)
      .sort((a, b) => String(t[a].name).localeCompare(String(t[b].name)))
      .map((id) => wrapId(this.table, id));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  override getItem(key: number | string) {
    if (typeof key === 'string') {
      const t = tableOf(app.doc, this.table);
      const hit = Object.values(t).find((x) => x.name === key);
      if (!hit) throw pyError('KeyError', `'bpy_prop_collection[key]: key "${key}" not found'`);
      return wrapId(this.table, hit.id as string);
    }
    return super.getItem(key);
  }
  private add<T extends { id: string; name: string }>(rec: T) {
    rec.name = uniqueName(tableOf(app.doc, this.table) as Record<string, { name: string }>, rec.name || TYPE_NAME[this.table]);
    tableOf(app.doc, this.table)[rec.id] = rec as unknown as Raw;
    touched();
    return wrapId(this.table, rec.id);
  }
  /** Create a new data-block. Arguments follow the `bpy` conventions per collection type. */
  new(name: string = TYPE_NAME[this.table], ...rest: unknown[]) {
    name = String(name ?? '');
    switch (this.table) {
      case 'objects': {
        const data = rest[0];
        let type: ObjectData['type'] = 'EMPTY',
          did: string | null = null;
        if (data !== null && data !== undefined) {
          if (!isIdWrapper(data) || !TABLE_OBTYPE[data.__table])
            throw pyError('TypeError', 'BlendDataObjects.new(): object_data must be a Mesh, Curve, Light, Camera, Armature, Lattice or MetaBall (or None)');
          type = TABLE_OBTYPE[data.__table];
          did = data.__id;
          if (data.__table === 'curves' && (tableOf(app.doc, 'curves')[did] as { body?: string })?.body !== undefined) type = 'FONT';
        }
        const ob = newObject(name || 'Object', type, did);
        const w = this.add(ob);
        app.doc.object_order.push(ob.id);
        return w;
      }
      case 'meshes':
        return this.add(newMeshData(name || 'Mesh', emptyMeshArrays()));
      case 'materials':
        return this.add(newMaterial(name || 'Material'));
      case 'collections':
        return this.add(newCollection(name || 'Collection'));
      case 'cameras':
        return this.add(newCamera(name || 'Camera'));
      case 'lights': {
        const type = String(rest[0] ?? 'POINT').toUpperCase();
        if (!['POINT', 'SUN', 'SPOT', 'AREA'].includes(type)) throw pyError('TypeError', `BlendDataLights.new(): enum "${rest[0]}" not found in ('POINT', 'SUN', 'SPOT', 'AREA')`);
        return this.add(newLight(type as 'POINT', name || 'Light'));
      }
      case 'actions':
        return this.add(newAction(name || 'Action'));
      case 'images': {
        const w = Math.max(1, Math.round(Number(rest[0] ?? 1024))),
          h = Math.max(1, Math.round(Number(rest[1] ?? 1024)));
        return this.add(newImage(name || 'Image', w, h, 'BLANK', [0, 0, 0, rest[2] ? 0 : 1]));
      }
      case 'texts': {
        const lang = /\.py$/i.test(name) ? 'python' : /\.m?js$/i.test(name) ? 'javascript' : 'python';
        return this.add(newText(name || 'Text', '', lang));
      }
      case 'node_groups': {
        const ng = newNodeGroup(name || 'NodeTree');
        const type = String(rest[0] ?? 'GeometryNodeTree');
        if (type === 'ShaderNodeTree') ng.tree.type = 'SHADER';
        else if (type === 'CompositorNodeTree') ng.tree.type = 'COMPOSITOR';
        return this.add(ng);
      }
      case 'worlds':
        return this.add(newWorld(name || 'World'));
      case 'curves': {
        const cu = newCurve(name || 'Curve');
        if (String(rest[0] ?? 'CURVE').toUpperCase() === 'FONT') cu.body = 'Text';
        return this.add(cu);
      }
      case 'armatures':
        return this.add(newArmature(name || 'Armature'));
      case 'lattices':
        return this.add(newLattice(name || 'Lattice'));
      case 'metaballs':
        app.doc.metaballs ??= {};
        return this.add(newMetaball(name || 'Mball'));
      default:
        throw pyError('RuntimeError', `bpy.data.${this.table}.new() is not supported`);
    }
  }
  remove(item: unknown, do_unlink = true) {
    void do_unlink;
    if (!isIdWrapper(item) || item.__table !== this.table) throw pyError('TypeError', `${this.__path}.remove(): expected a ${TYPE_NAME[this.table]}`);
    if (!tableOf(app.doc, this.table)[item.__id]) throw pyError('ReferenceError', `${TYPE_NAME[this.table]} has already been removed`);
    removeDataBlock(this.table, item.__id);
    idCache.delete(`${this.table}:${item.__id}`);
    touched();
  }
  /**
   * Images only: opens a file offered to scripts (scripting/files.ts), such as
   * an image attached to the AI assistant's chat; scripts have no file system.
   */
  load(filepath: string, check_existing = false) {
    const path = String(filepath ?? '');
    const offered = this.table === 'images' ? scriptFile(path) : null;
    if (!offered) {
      const names = this.table === 'images' ? scriptFileNames() : [];
      const can = names.length ? ` Files that can be loaded: ${names.map((n) => JSON.stringify(n)).join(', ')}.` : ' Images can be opened from the Image Editor (Image › Open).';
      throw pyError('RuntimeError', `Error: cannot read "${path}": scripts have no file system access in the browser.${can}`);
    }
    if (check_existing) {
      const hit = Object.values(app.doc.images).find((im) => im.filepath === offered.name);
      if (hit) return wrapId('images', hit.id);
    }
    const { name, bytes, mime, width, height } = offered;
    return this.add({ id: uid('im'), name, mime, bytes, width, height, source: 'FILE', colorspace: 'sRGB', filepath: name, revision: 0 } as ImageData);
  }
  get is_updated() {
    return false;
  }
  tag(_v: boolean) {
    /* no-op */
  }
}
kwMethod(IDCollection.prototype, 'new', ['name', 'object_data']);
kwMethod(IDCollection.prototype, 'remove', ['object', 'do_unlink']);
kwMethod(IDCollection.prototype, 'load', ['filepath', 'check_existing']);

// specialised `new` keyword names per collection
const NEW_PARAMS: Record<string, string[]> = {
  objects: ['name', 'object_data'],
  lights: ['name', 'type'],
  images: ['name', 'width', 'height', 'alpha'],
  node_groups: ['name', 'type'],
  curves: ['name', 'type'],
};

function idCollection(table: string) {
  const c = new IDCollection(table);
  const params = NEW_PARAMS[table];
  if (params) {
    const fn = function (this: IDCollection, ...a: unknown[]) {
      return IDCollection.prototype.new.apply(this, a as [string]);
    } as unknown as ((...a: unknown[]) => unknown) & { __params: string[] };
    fn.__params = params;
    Object.defineProperty(c, 'new', { value: wrapKw(fn, params) });
  }
  return c;
}

function wrapKw(fn: (...a: unknown[]) => unknown, params: string[]) {
  const holder = { f: fn };
  kwMethod(holder, 'f', params);
  return holder.f;
}

// ---------------------------------------------------------------------------
// Scene / view layer / context

class SceneStruct extends Struct {
  readonly __kind: string = 'id';
  readonly __table = 'scenes';
  readonly __id = 'scene';
  constructor() {
    super('Scene', () => app.doc.scene as unknown as Raw, 'bpy.data.scenes["Scene"]');
  }
  override __hidden() {
    return SCENE_HIDDEN;
  }
  get name() {
    return app.doc.scene.name;
  }
  set name(v: string) {
    app.doc.scene.name = String(v) || 'Scene';
    touched();
  }
  get frame_current() {
    return app.doc.scene.frame_current;
  }
  set frame_current(v: number) {
    app.doc.scene.frame_current = Math.round(Number(v));
    touched('frame');
  }
  frame_set(frame: number, subframe = 0) {
    app.setFrame(Number(frame), Number(subframe));
    scriptState.mutated = true;
    ensureEvaluated();
  }
  get objects() {
    return new SceneObjects();
  }
  get collection() {
    return wrapId('collections', app.doc.scene.collection);
  }
  get view_layers() {
    return [viewLayer];
  }
  get users() {
    return 1;
  }
  get use_fake_user() {
    return false;
  }
  override toString() {
    return `<bpy_struct, Scene("${app.doc.scene.name}")>`;
  }
  override repr() {
    return `bpy.data.scenes[${JSON.stringify(app.doc.scene.name)}]`;
  }
}
const SCENE_HIDDEN = new Set(['id', 'custom', 'active_object', 'collection', 'compositor']);
kwMethod(SceneStruct.prototype, 'frame_set', ['frame', 'subframe']);

class SceneObjects extends PropCollection<unknown> {
  constructor() {
    super('bpy.context.scene.objects');
  }
  list() {
    return sceneObjectIds().map((id) => wrapId('objects', id));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
}

class ScenesCollection extends PropCollection<unknown> {
  constructor() {
    super('bpy.data.scenes');
  }
  list() {
    return [sceneWrapper];
  }
  nameOf() {
    return app.doc.scene.name;
  }
  new() {
    throw pyError('RuntimeError', 'this application supports a single scene per file');
  }
}

class ViewLayerObjects extends SceneObjects {
  get active() {
    const id = app.doc.scene.active_object;
    return id && app.doc.objects[id] ? wrapId('objects', id) : null;
  }
  set active(v: unknown) {
    app.doc.scene.active_object = v === null || v === undefined ? null : expectId(v, 'objects', 'Object');
    touched('select');
  }
  get selected() {
    return Object.values(app.doc.objects)
      .filter((o) => o.select)
      .map((o) => wrapId('objects', o.id));
  }
}

const viewLayer = {
  __kind: 'struct',
  __type: 'ViewLayer',
  name: 'ViewLayer',
  objects: new ViewLayerObjects(),
  update() {
    ensureEvaluated();
  },
  get active_layer_collection() {
    const id = activeCollectionId();
    return { __kind: 'struct', __type: 'LayerCollection', name: app.doc.collections[id]?.name, collection: wrapId('collections', id) };
  },
  toString: () => '<bpy_struct, ViewLayer("ViewLayer")>',
};

const sceneWrapper = proxify(new SceneStruct());

/** Map document mode + active object type to the context mode identifiers. */
function contextMode() {
  const m = app.doc.mode;
  const t = app.activeObject?.type;
  if (m === 'EDIT')
    return t === 'CURVE' || t === 'FONT'
      ? `EDIT_${t === 'FONT' ? 'TEXT' : 'CURVE'}`
      : t === 'ARMATURE'
        ? 'EDIT_ARMATURE'
        : t === 'LATTICE'
          ? 'EDIT_LATTICE'
          : t === 'META'
            ? 'EDIT_METABALL'
            : 'EDIT_MESH';
  if (m === 'WEIGHT_PAINT') return 'PAINT_WEIGHT';
  if (m === 'VERTEX_PAINT') return 'PAINT_VERTEX';
  if (m === 'TEXTURE_PAINT') return 'PAINT_TEXTURE';
  return m;
}

export class Context {
  readonly __kind = 'struct';
  readonly __type = 'Context';
  get scene() {
    return sceneWrapper;
  }
  get object() {
    const ob = app.activeObject;
    return ob ? wrapId('objects', ob.id) : null;
  }
  get active_object() {
    return this.object;
  }
  get edit_object() {
    return app.doc.mode === 'EDIT' ? this.object : null;
  }
  get selected_objects() {
    ensureEvaluated();
    return app.selectedObjects().map((o) => wrapId('objects', o.id));
  }
  get selected_editable_objects() {
    return this.selected_objects;
  }
  get visible_objects() {
    ensureEvaluated();
    return app.doc.object_order.filter((id) => app.isVisible(id)).map((id) => wrapId('objects', id));
  }
  get view_layer() {
    return viewLayer;
  }
  get mode() {
    return contextMode();
  }
  get collection() {
    return wrapId('collections', activeCollectionId());
  }
  get blend_data() {
    return bpyData;
  }
  get area() {
    const a = app.hoverArea ?? app.activeArea;
    return a ? { __kind: 'struct', __type: 'Area', type: a.type, ui_type: a.type } : null;
  }
  get space_data() {
    const a = app.hoverArea ?? app.activeArea;
    return a ? { __kind: 'struct', __type: 'Space', type: a.type } : null;
  }
  get material() {
    const ob = app.activeObject;
    if (!ob) return null;
    const id = materialSlots(ob)[ob.active_material_index] ?? null;
    return id ? wrapId('materials', id) : null;
  }
  get preferences() {
    return { __kind: 'struct', __type: 'Preferences' };
  }
  get window_manager() {
    return { __kind: 'struct', __type: 'WindowManager' };
  }
  evaluated_depsgraph_get() {
    ensureEvaluated();
    return { __kind: 'struct', __type: 'Depsgraph', update: () => ensureEvaluated(), scene: sceneWrapper };
  }
  copy() {
    return { scene: this.scene, object: this.object, active_object: this.active_object, selected_objects: this.selected_objects, mode: this.mode, collection: this.collection };
  }
  toString() {
    return '<bpy_struct, Context>';
  }
}

// ---------------------------------------------------------------------------
// bpy.data

const DATA_NAMES = [
  'objects',
  'meshes',
  'materials',
  'collections',
  'cameras',
  'lights',
  'actions',
  'images',
  'texts',
  'node_groups',
  'worlds',
  'curves',
  'armatures',
  'lattices',
  'metaballs',
  'particles',
  'brushes',
];

export const bpyData: Record<string, unknown> & { scenes: ScenesCollection } = {
  __kind: 'struct',
  __type: 'BlendData',
  scenes: new ScenesCollection(),
  get filepath() {
    return app.filename;
  },
  get is_dirty() {
    return app.dirty;
  },
  get is_saved() {
    return false;
  },
  /** Remove unused data-blocks; returns the number removed. */
  orphans_purge(do_local_ids = true, do_linked_ids = true, do_recursive = true) {
    void do_local_ids;
    void do_linked_ids;
    const n = purgeOrphanData(app.doc, !!do_recursive);
    if (n) touched();
    return n;
  },
  batch_remove(ids: unknown) {
    for (const it of (Array.isArray(ids) ? ids : [...(ids as Iterable<unknown>)]) as unknown[]) if (isIdWrapper(it)) removeDataBlock(it.__table, it.__id);
    touched();
  },
  toString: () => '<bpy_struct, BlendData>',
};
for (const n of DATA_NAMES) bpyData[n] = idCollection(n);
kwMethod(bpyData, 'orphans_purge', ['do_local_ids', 'do_linked_ids', 'do_recursive']);

// ---------------------------------------------------------------------------
// Orphan purge (shared with the outliner.orphans_purge operator)

export const PURGEABLE = ['meshes', 'curves', 'lights', 'cameras', 'armatures', 'lattices', 'metaballs', 'materials', 'images', 'actions', 'node_groups', 'textures', 'particles', 'worlds'];

/** Delete data-blocks with zero users and no fake user. Returns how many were removed. */
export function purgeOrphanData(d: DocumentData, recursive = true): number {
  let removed = 0;
  for (let pass = 0; pass < 16; pass++) {
    const refs = new Set<string>();
    const visit = (v: unknown, self: string | null, depth: number) => {
      if (depth > 14 || v === null || v === undefined) return;
      if (typeof v === 'string') {
        if (v !== self) refs.add(v);
        return;
      }
      if (typeof v !== 'object' || ArrayBuffer.isView(v)) return;
      if (Array.isArray(v)) {
        for (const x of v) visit(x, self, depth + 1);
        return;
      }
      for (const [k, x] of Object.entries(v as Raw)) if (k !== 'id' && k !== 'name') visit(x, self, depth + 1);
    };
    const tables = d as unknown as Record<string, unknown>;
    for (const [k, t] of Object.entries(tables)) {
      if (k === 'object_order') continue;
      if (k === 'scene') visit(t, null, 0);
      else if (t && typeof t === 'object' && !Array.isArray(t)) for (const [id, rec] of Object.entries(t as Record<string, unknown>)) visit(rec, id, 0);
    }
    let n = 0;
    for (const table of PURGEABLE) {
      const t = tables[table] as Record<string, Raw> | undefined;
      if (!t) continue;
      for (const [id, rec] of Object.entries(t)) {
        if (rec?.use_fake_user || refs.has(id)) continue;
        if (table === 'worlds' && d.scene.world === id) continue;
        delete t[id];
        n++;
      }
    }
    removed += n;
    if (!n || !recursive) break;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// bpy.ops

export type ExecContext = 'EXEC_DEFAULT' | 'INVOKE_DEFAULT' | 'EXEC_REGION_WIN' | 'INVOKE_REGION_WIN' | 'EXEC_AREA' | 'INVOKE_AREA' | 'EXEC_SCREEN' | 'INVOKE_SCREEN';

/** Hook used by runner.ts to group undo steps. */
export const opHooks = {
  /** wraps app.run while scripts execute */
  run: (fn: () => OpResult): OpResult => fn(),
};

/** Run an operator from a script: `{'FINISHED'}` / `{'CANCELLED'}`, raises on poll failure or errors. */
export function callOperator(idname: string, props: Record<string, unknown> = {}, execContext: ExecContext = 'EXEC_DEFAULT'): 'FINISHED' | 'CANCELLED' | 'RUNNING_MODAL' | 'PASS_THROUGH' {
  const op = operators.get(idname);
  if (!op) throw pyError('AttributeError', `Calling operator "bpy.ops.${idname}" error, could not be found`);
  const invoke = String(execContext).startsWith('INVOKE');
  if (!app.poll(idname)) throw pyError('RuntimeError', `Operator bpy.ops.${idname}.poll() failed, context is incorrect`);
  const plain: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) plain[k] = toPlain(v);
  // rotation/value props given as Euler etc. are plain arrays now
  const before = app.reports.length;
  const docBefore = app.doc;
  const res = opHooks.run(() => app.run(idname, plain, { invoke }));
  if (res === 'CANCELLED') {
    const err = app.reports.slice(before).find((r) => r.type === 'ERROR');
    if (err) {
      if (app.doc !== docBefore) scriptState.mutated = false;
      throw pyError('RuntimeError', `Error: ${err.message}`);
    }
  }
  if (res === 'FINISHED' || res === undefined) scriptState.mutated = true;
  ensureEvaluated();
  return (res ?? 'FINISHED') as 'FINISHED';
}

function opModule(mod: string) {
  return new Proxy(
    { __kind: 'opmodule', __module: mod },
    {
      get(t, p) {
        if (typeof p === 'symbol' || p in t) return (t as Record<string | symbol, unknown>)[p];
        if (p === 'toString') return () => `<module like class 'bpy.ops.${mod}'>`;
        const idname = `${mod}.${p}`;
        if (!operators.has(idname)) return undefined;
        const fn = (...args: unknown[]) => {
          let ctx: ExecContext = 'EXEC_DEFAULT';
          let props: Record<string, unknown> = {};
          for (const a of args) {
            if (typeof a === 'string') ctx = a as ExecContext;
            else if (a && typeof a === 'object' && !isIdWrapper(a)) props = a as Record<string, unknown>;
          }
          return new Set([callOperator(idname, props, ctx)]);
        };
        Object.assign(fn, {
          __kind: 'op',
          idname: () => idname,
          poll: () => app.poll(idname),
          get_rna_type: () => ({ name: operators.get(idname)?.label, description: operators.get(idname)?.description ?? '' }),
          toString: () => `bpy.ops.${idname}()`,
        });
        return fn;
      },
      has(_t, p) {
        return typeof p === 'string' && operators.has(`${mod}.${p}`);
      },
      ownKeys() {
        return opNames(mod);
      },
      getOwnPropertyDescriptor(_t, p) {
        return typeof p === 'string' && operators.has(`${mod}.${p}`) ? { configurable: true, enumerable: true, value: undefined } : undefined;
      },
    },
  );
}

export function opModules(): string[] {
  return [...new Set([...operators.keys()].map((k) => k.split('.')[0]))].sort();
}
export function opNames(mod: string): string[] {
  return [...operators.keys()]
    .filter((k) => k.startsWith(`${mod}.`))
    .map((k) => k.slice(mod.length + 1))
    .sort();
}

export const bpyOps = new Proxy({ __kind: 'ops' } as Record<string, unknown>, {
  get(t, p) {
    if (typeof p === 'symbol' || p in t) return t[p as string];
    if (p === 'toString') return () => '<module like class bpy.ops>';
    return opModules().includes(p) ? opModule(p) : undefined;
  },
  has(_t, p) {
    return typeof p === 'string' && opModules().includes(p);
  },
  ownKeys() {
    return opModules();
  },
  getOwnPropertyDescriptor(_t, p) {
    return typeof p === 'string' && opModules().includes(p) ? { configurable: true, enumerable: true, value: undefined } : undefined;
  },
});

// ---------------------------------------------------------------------------
// bpy root (types/utils/props are attached by registry.ts)

export const bpyContext = new Context();

export const bpy: Record<string, unknown> = {
  __kind: 'module',
  data: bpyData,
  context: bpyContext,
  ops: bpyOps,
  app: {
    __kind: 'struct',
    __type: 'App',
    version: [1, 0, 0],
    version_string: '1.0.0',
    get binary_path() {
      return '';
    },
    background: false,
    toString: () => '<bpy.app>',
  },
  path: {
    abspath: (p: string) => p,
    basename: (p: string) => String(p).split(/[\\/]/).pop() ?? '',
    display_name: (p: string) =>
      String(p)
        .replace(/\.[^.]*$/, '')
        .replace(/_/g, ' '),
  },
};

export { mathutils, Matrix, Vector, sceneWrapper, same, IDCollection };
