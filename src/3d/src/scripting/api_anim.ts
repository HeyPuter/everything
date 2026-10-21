// Animation for scripts: keyframe_insert / keyframe_delete / driver_add / driver_remove on any
// struct that can be animated, path_resolve / path_from_id / id_data on every struct,
// animation_data (action, NLA tracks and strips, drivers), F-Curves with keyframe_points and
// modifiers, keying sets and timeline markers.
//
// Animation lives on objects: a property of an object's data, active material or pose bones is
// keyed on the object with a path such as `data.energy`, `material.nodes["…"].inputs[…]` or
// `pose.bones["Arm"].location` (ui/rnapath.ts finds the object for a property owner).
import { app } from '../app/app';
import type { ActionData, AnimData, Driver, DriverVariable, FCurve, FModifier, KeyingSetData, NlaStrip, NlaTrack, ObjectData, TimelineMarker } from '../data/types';
import { newAction } from '../data/defaults';
import { getValue } from '../data/rna';
import { ensureFCurve, keyProperty } from '../anim/keyframes';
import { assignAction, objectCurves, slotCurves } from '../anim/slots';
import { calcHandles, evaluateFCurve, insertKeyframe, sortKeyframes } from '../anim/fcurve';
import { animTarget, locateOwner } from '../ui/rnapath';
import { ActionStruct, ObjectStruct, SceneStruct, uniqueName, wrapId } from './api';
import { Vector } from './mathutils';
import { PropCollection, Struct, expectId, isIdWrapper, kwMethod, mixin, proxify, pyError, resolvePath, structHooks, toPlain, touched, type Raw } from './rna';

type Any = Record<string, unknown>;
const q = (s: string) => JSON.stringify(s);
const isIdent = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);

// ---------------------------------------------------------------------------
// which object (and path) animates a property

interface Target {
  ob: ObjectData;
  path: string;
}

const objectOf = (raw: unknown): ObjectData | null => {
  const id = (raw as { id?: unknown })?.id;
  return typeof id === 'string' && app.doc.objects[id] === raw ? (raw as ObjectData) : null;
};

/** The object and object-relative path that animate `key` of the record `raw`. */
export function targetForRaw(raw: object, key: string): Target {
  const ob = objectOf(raw);
  if (ob) return { ob, path: key };
  const loc = locateOwner(app.doc, raw, app.revision);
  if (!loc) throw pyError('TypeError', `property "${key}" can't be animated here: its owner is not part of the scene's data`);
  const t = animTarget(app.doc, loc, key, app.activeObject);
  if (!t) {
    const why = loc.table === 'materials' ? 'a material is animated through an object that uses it as its active material' : loc.table === 'scenes' || loc.table === 'worlds' || loc.table === 'collections' ? `${loc.table} properties can't be animated` : 'no object uses this data';
    throw pyError('TypeError', `property "${key}" can't be animated: ${why}`);
  }
  return t;
}

/** Splits `modifiers["Bevel"].width` into the owner path and the last property. */
function splitPath(path: string): [string, string] {
  const m = /^(.*?)\.?([A-Za-z_][A-Za-z0-9_]*)$/.exec(path);
  if (!m) throw pyError('ValueError', `bpy_struct: path "${path}" must end with a property name`);
  return [m[1], m[2]];
}

/** Target for `data_path` given relative to a script struct. */
function targetFor(s: Struct, dataPath: string): Target {
  const path = String(dataPath ?? '');
  if (!path) throw pyError('TypeError', 'bpy_struct: data_path is empty');
  if (!isIdent(path)) {
    const ob = objectOf(s.__resolve());
    if (ob) return { ob, path };
    const [owner, last] = splitPath(path);
    const sub = owner ? resolvePath(s, owner) : s;
    if (!(sub instanceof Struct)) throw pyError('TypeError', `bpy_struct: "${owner}" is not a struct that can be animated`);
    return targetFor(sub, last);
  }
  return targetForRaw(s.__raw, path);
}

function keyframeAt(frame: unknown) {
  return frame === undefined || frame === null ? app.doc.scene.frame_current : Number(frame);
}

/** keyframe_insert for a target; returns True when a key was set. */
export function insertKey(t: Target, index: number, frame: unknown, group?: string, keytype?: string) {
  const val = getValue(app.doc, t.ob, t.path);
  if (val === undefined) throw pyError('TypeError', `bpy_struct.keyframe_insert() property "${t.path}" not found`);
  if (typeof val !== 'number' && typeof val !== 'boolean' && !Array.isArray(val) && !ArrayBuffer.isView(val)) throw pyError('TypeError', `bpy_struct.keyframe_insert() property "${t.path}" not animatable`);
  const ts = app.doc.scene.tool_settings as unknown as { keyframe_type: string };
  const prevType = ts.keyframe_type;
  if (keytype) ts.keyframe_type = String(keytype);
  try {
    keyProperty(app.doc, t.ob, t.path, index ?? -1, keyframeAt(frame));
  } finally {
    ts.keyframe_type = prevType;
  }
  if (group) for (const fc of objectCurves(app.doc, t.ob)) if (fc.data_path === t.path) fc.group = String(group);
  touched();
  return true;
}

export function deleteKey(t: Target, index: number, frame: unknown) {
  const f = keyframeAt(frame);
  const act = t.ob.animation_data?.action ? app.doc.actions[t.ob.animation_data.action] : null;
  let removed = false;
  if (act) {
    const mine = new Set(objectCurves(app.doc, t.ob));
    for (const fc of mine) {
      if (fc.data_path !== t.path || (index >= 0 && fc.array_index !== index)) continue;
      const n = fc.keyframe_points.length;
      fc.keyframe_points = fc.keyframe_points.filter((k) => Math.abs(k.co[0] - f) > 1e-4);
      removed ||= fc.keyframe_points.length !== n;
    }
    act.fcurves = act.fcurves.filter((fc) => !mine.has(fc) || fc.keyframe_points.length || fc.data_path !== t.path);
  }
  if (!removed) throw pyError('RuntimeError', `keyframe_delete: no keyframe at frame ${f} for "${t.path}"`);
  touched();
  return true;
}

function ensureAnimData(ob: ObjectData): AnimData {
  ob.animation_data ??= { action: null, nla_tracks: [], drivers: [] };
  return ob.animation_data;
}

/** driver_add for a target: one F-Curve, or a list of them when index is -1 and the property is an array. */
export function addDriver(t: Target, index: number): unknown {
  const val = getValue(app.doc, t.ob, t.path);
  if (val === undefined) throw pyError('TypeError', `bpy_struct.driver_add(): property "${t.path}" not found`);
  const ad = ensureAnimData(t.ob);
  const make = (i: number) => {
    let d = ad.drivers.find((x) => x.data_path === t.path && x.array_index === i);
    if (!d) {
      const cur = Array.isArray(val) || ArrayBuffer.isView(val) ? Number((val as ArrayLike<number>)[i]) : Number(val);
      d = { data_path: t.path, array_index: i, type: 'SCRIPTED', expression: Number.isInteger(cur) ? `${cur}.0` : String(cur), variables: [] };
      ad.drivers.push(d);
    }
    return driverFCurve(t.ob.id, d);
  };
  touched();
  if ((Array.isArray(val) || ArrayBuffer.isView(val)) && (index ?? -1) < 0) return Array.from({ length: (val as ArrayLike<number>).length }, (_, i) => make(i));
  return make(Math.max(0, index ?? 0));
}

export function removeDriver(t: Target, index: number) {
  const ad = t.ob.animation_data;
  if (!ad) return false;
  const n = ad.drivers.length;
  ad.drivers = ad.drivers.filter((d) => !(d.data_path === t.path && (index < 0 || d.array_index === index)));
  touched();
  return ad.drivers.length !== n;
}

// ---------------------------------------------------------------------------
// generic struct members

class StructAnim {
  /** Inserts keyframes for `data_path` (all channels when index = -1). */
  keyframe_insert(this: Struct, data_path: string, index = -1, frame?: number | null, group = '', options?: unknown, keytype?: string) {
    void options;
    return insertKey(targetFor(this, data_path), Number(index ?? -1), frame, group, keytype);
  }
  keyframe_delete(this: Struct, data_path: string, index = -1, frame?: number | null) {
    return deleteKey(targetFor(this, data_path), Number(index ?? -1), frame);
  }
  driver_add(this: Struct, path: string, index = -1) {
    return addDriver(targetFor(this, path), Number(index ?? -1));
  }
  driver_remove(this: Struct, path: string, index = -1) {
    return removeDriver(targetFor(this, path), Number(index ?? -1));
  }
  /** The value at a data path relative to this struct. */
  path_resolve(this: Struct, path: string, coerce = true) {
    void coerce;
    return resolvePath(this, String(path));
  }
  /** The data path from the data-block that owns this struct (with `property` appended). */
  path_from_id(this: Struct, property?: string) {
    const raw = this.__resolve();
    let base = '';
    if (raw && !objectOf(raw)) {
      const loc = locateOwner(app.doc, raw, app.revision);
      if (loc) base = loc.path;
      else base = this.__path.replace(/^bpy\.data\.\w+\[(?:"(?:[^"\\]|\\.)*")\]\.?/, '');
    }
    if (!property) return base;
    const p = isIdent(property) ? property : `[${q(property)}]`;
    return base ? (p.startsWith('[') ? base + p : `${base}.${p}`) : p;
  }
  /** The data-block this struct belongs to. */
  get id_data() {
    const self = this as unknown as Struct;
    const m = /^bpy\.data\.(\w+)\[("(?:[^"\\]|\\.)*")\]/.exec(self.__path);
    if (m && m[1] !== 'scenes') {
      const name = JSON.parse(m[2]);
      const hit = Object.values((app.doc as unknown as Record<string, Record<string, { id: string; name: string }>>)[m[1]] ?? {}).find((x) => x.name === name);
      if (hit) return wrapId(m[1], hit.id);
    }
    const raw = self.__resolve();
    const loc = raw ? locateOwner(app.doc, raw, app.revision) : null;
    if (!loc || loc.table === 'scenes') return null;
    return wrapId(loc.table, loc.id);
  }
  is_property_set(this: Struct, name: string) {
    const raw = this.__resolve();
    return !!raw && raw[name] !== undefined && raw[name] !== null;
  }
  property_unset(this: Struct, name: string) {
    void name;
  }
}
mixin(Struct, StructAnim, true);
for (const [m, p] of [
  ['keyframe_insert', ['data_path', 'index', 'frame', 'group', 'options', 'keytype']],
  ['keyframe_delete', ['data_path', 'index', 'frame', 'group']],
  ['driver_add', ['path', 'index']],
  ['driver_remove', ['path', 'index']],
  ['path_resolve', ['path', 'coerce']],
  ['path_from_id', ['property']],
] as [string, string[]][])
  kwMethod(Struct.prototype, m, p);

// object keyframes accept nested paths (pose.bones["B"].location) directly
class ObjectAnim {
  keyframe_insert(this: ObjectStruct, data_path: string, index = -1, frame?: number | null, group = '', options?: unknown, keytype?: string) {
    void options;
    return insertKey(targetFor(this, data_path), Number(index ?? -1), frame, group, keytype);
  }
  keyframe_delete(this: ObjectStruct, data_path: string, index = -1, frame?: number | null) {
    return deleteKey(targetFor(this, data_path), Number(index ?? -1), frame);
  }
  get animation_data() {
    const id = (this as unknown as ObjectStruct).__id;
    return app.doc.objects[id]?.animation_data ? animDataWrapper(id) : null;
  }
  animation_data_create(this: ObjectStruct) {
    ensureAnimData(app.doc.objects[this.__id]);
    touched();
    return animDataWrapper(this.__id);
  }
}
mixin(ObjectStruct, ObjectAnim, true);
kwMethod(ObjectStruct.prototype, 'keyframe_insert', ['data_path', 'index', 'frame', 'group', 'options', 'keytype']);
kwMethod(ObjectStruct.prototype, 'keyframe_delete', ['data_path', 'index', 'frame', 'group']);

// node sockets and other plain-object structs key through this hook
structHooks.keyframe = (raw, key, index, frame) => insertKey(targetForRaw(raw, key), index, frame);
structHooks.driver = (raw, key, index) => addDriver(targetForRaw(raw, key), index);

// ---------------------------------------------------------------------------
// animation data

const obOf = (id: string) => {
  const ob = app.doc.objects[id];
  if (!ob) throw pyError('ReferenceError', 'Object has been removed');
  return ob;
};
const adOf = (id: string) => {
  const ad = obOf(id).animation_data;
  if (!ad) throw pyError('ReferenceError', 'animation data has been cleared');
  return ad;
};
const obPath = (id: string) => `bpy.data.objects[${q(app.doc.objects[id]?.name ?? '?')}]`;

export class AnimDataStruct extends Struct {
  constructor(readonly __obId: string) {
    super('AnimData', () => app.doc.objects[__obId]?.animation_data as unknown as Raw, `${obPath(__obId)}.animation_data`);
  }
  override __hidden() {
    return new Set(['id', 'nla_tracks', 'drivers', 'tweak', 'action', 'action_slot_handle', 'slot_action', 'last_slot_identifier', 'use_pin']);
  }
  get action() {
    const a = adOf(this.__obId).action;
    return a && app.doc.actions[a] ? wrapId('actions', a) : null;
  }
  set action(v: unknown) {
    // like assigning in the UI: the slot is picked again (last used, own name, or a never-used one)
    assignAction(app.doc, obOf(this.__obId), adOf(this.__obId), v === null || v === undefined ? null : expectId(v, 'actions', 'Action'));
    touched();
  }
  get action_blend_type() {
    return adOf(this.__obId).action_blend_type ?? 'REPLACE';
  }
  set action_blend_type(v: string) {
    adOf(this.__obId).action_blend_type = String(v) as NlaStrip['blend_type'];
    touched();
  }
  get action_influence() {
    return adOf(this.__obId).action_influence ?? 1;
  }
  set action_influence(v: number) {
    adOf(this.__obId).action_influence = Math.max(0, Math.min(1, Number(v)));
    touched();
  }
  get nla_tracks() {
    return new NlaTracks(this.__obId);
  }
  get drivers() {
    return new Drivers(this.__obId);
  }
  get use_tweak_mode() {
    return !!adOf(this.__obId).tweak;
  }
  get use_pin() {
    return !!adOf(this.__obId).use_pin;
  }
  set use_pin(v: boolean) {
    adOf(this.__obId).use_pin = !!v;
    touched();
  }
  get use_nla() {
    return true;
  }
}

const animDataCache = new Map<string, unknown>();
function animDataWrapper(obId: string) {
  let w = animDataCache.get(obId);
  if (!w) animDataCache.set(obId, (w = proxify(new AnimDataStruct(obId))));
  return w;
}

class NlaTracks extends PropCollection<unknown> {
  constructor(readonly obId: string) {
    super(`${obPath(obId)}.animation_data.nla_tracks`);
  }
  list() {
    return adOf(this.obId).nla_tracks.map((t) => this.wrap(t));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  wrap(t: NlaTrack) {
    return trackWrapper(this.obId, t);
  }
  /** Adds a track at the top of the stack (or right above `prev`). */
  new(prev: unknown = null) {
    const ad = adOf(this.obId);
    const t: NlaTrack = { name: uniqueName(Object.fromEntries(ad.nla_tracks.map((x, i) => [i, x])), 'NlaTrack'), strips: [], mute: false, is_solo: false };
    const pi = prev ? ad.nla_tracks.indexOf((prev as { __track?: NlaTrack }).__track!) : -1;
    if (pi >= 0) ad.nla_tracks.splice(pi + 1, 0, t);
    else ad.nla_tracks.push(t);
    touched();
    return this.wrap(t);
  }
  remove(track: unknown) {
    const ad = adOf(this.obId);
    const i = ad.nla_tracks.indexOf((track as { __track?: NlaTrack })?.__track!);
    if (i < 0) throw pyError('RuntimeError', 'NlaTracks.remove(): track not found');
    ad.nla_tracks.splice(i, 1);
    touched();
  }
  get active() {
    const ad = adOf(this.obId);
    const t = ad.nla_tracks.find((x) => x.select) ?? ad.nla_tracks[ad.nla_tracks.length - 1];
    return t ? this.wrap(t) : null;
  }
}
kwMethod(NlaTracks.prototype, 'new', ['prev']);

function trackWrapper(obId: string, t: NlaTrack) {
  const s = new Struct('NlaTrack', () => (app.doc.objects[obId]?.animation_data?.nla_tracks.includes(t) ? (t as unknown as Raw) : null), `${obPath(obId)}.animation_data.nla_tracks[${q(t.name)}]`);
  Object.defineProperty(s, '__track', { value: t });
  Object.defineProperty(s, 'strips', { get: () => new NlaStrips(obId, () => t.strips, s.__path) });
  return proxify(s);
}

/** Frame range of an action's keys (0..1 when it has none). */
function actionRange(a: ActionData | undefined): [number, number] {
  let lo = Infinity,
    hi = -Infinity;
  for (const fc of a?.fcurves ?? [])
    for (const k of fc.keyframe_points) {
      lo = Math.min(lo, k.co[0]);
      hi = Math.max(hi, k.co[0]);
    }
  if (a?.frame_range) return [a.frame_range[0], a.frame_range[1]];
  if (!Number.isFinite(lo)) return [0, 1];
  return [lo, hi > lo ? hi : lo + 1];
}

/** Extra members of NlaStrip wrappers (e.g. action slots, see api_slots.ts). */
export const stripStructHooks: ((s: Struct, strip: NlaStrip, obId: string) => void)[] = [];

class NlaStrips extends PropCollection<unknown> {
  constructor(
    readonly obId: string,
    readonly strips: () => NlaStrip[],
    base: string,
  ) {
    super(`${base}.strips`);
  }
  list() {
    return this.strips().map((x) => this.wrap(x));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  wrap(st: NlaStrip): unknown {
    const s = new Struct('NlaStrip', () => (this.strips().includes(st) ? (st as unknown as Raw) : null), `${this.__path}[${q(st.name)}]`);
    Object.defineProperty(s, '__strip', { value: st });
    const obId = this.obId;
    for (const hook of stripStructHooks) hook(s, st, obId);
    Object.defineProperty(s, 'strips', { get: () => new NlaStrips(obId, () => (st.strips ??= []), s.__path) });
    // the strip's length follows its action range, scale and repeat
    const span = () => (st.action_frame_end - st.action_frame_start) * st.scale * st.repeat;
    for (const key of ['scale', 'repeat'] as const)
      Object.defineProperty(s, key, {
        get: () => st[key],
        set: (v: number) => {
          const x = Number(v);
          if (!(x > 0)) throw pyError('ValueError', `NlaStrip.${key} must be greater than 0`);
          st[key] = x;
          st.frame_end = st.frame_start + span();
          touched();
        },
      });
    Object.defineProperty(s, 'frame_end', {
      get: () => st.frame_end,
      set: (v: number) => {
        const len = Math.max(1e-3, Number(v) - st.frame_start);
        st.scale = len / Math.max(1e-6, (st.action_frame_end - st.action_frame_start) * st.repeat);
        st.frame_end = st.frame_start + len;
        touched();
      },
    });
    return proxify(s);
  }
  /** Adds a strip playing `action` from frame `start`; strips on a track may not overlap. */
  new(name: string, start: number, action: unknown) {
    const aid = expectId(action, 'actions', 'Action');
    const [a0, a1] = actionRange(app.doc.actions[aid]);
    const st: NlaStrip = { name: String(name || 'NlaStrip'), action: aid, frame_start: Number(start), frame_end: Number(start) + (a1 - a0), action_frame_start: a0, action_frame_end: a1, scale: 1, repeat: 1, blend_type: 'REPLACE', blend_in: 0, blend_out: 0, mute: false, extrapolation: 'HOLD_FORWARD' };
    const list = this.strips();
    if (list.some((o) => st.frame_start < o.frame_end && st.frame_end > o.frame_start)) throw pyError('RuntimeError', `Error: unable to add strip "${st.name}": it overlaps another strip on this track (frames ${st.frame_start}–${st.frame_end})`);
    if (!list.length) st.extrapolation = 'HOLD';
    list.push(st);
    list.sort((x, y) => x.frame_start - y.frame_start);
    touched();
    return this.wrap(st);
  }
  remove(strip: unknown) {
    const list = this.strips();
    const i = list.indexOf((strip as { __strip?: NlaStrip })?.__strip!);
    if (i < 0) throw pyError('RuntimeError', 'NlaStrips.remove(): strip not found');
    list.splice(i, 1);
    touched();
  }
}
kwMethod(NlaStrips.prototype, 'new', ['name', 'start', 'action']);

// ---------------------------------------------------------------------------
// drivers

class Drivers extends PropCollection<unknown> {
  constructor(readonly obId: string) {
    super(`${obPath(obId)}.animation_data.drivers`);
  }
  list() {
    return adOf(this.obId).drivers.map((d) => driverFCurve(this.obId, d));
  }
  nameOf(x: unknown) {
    return (x as { data_path: string }).data_path;
  }
  find(data_path: string, index = 0) {
    const d = adOf(this.obId).drivers.find((x) => x.data_path === data_path && x.array_index === Number(index));
    return d ? driverFCurve(this.obId, d) : null;
  }
  new(data_path: string, index = 0) {
    return addDriver({ ob: obOf(this.obId), path: String(data_path) }, Number(index));
  }
  remove(driver: unknown) {
    const ad = adOf(this.obId);
    const d = (driver as { __driver?: Driver })?.__driver;
    const i = d ? ad.drivers.indexOf(d) : -1;
    if (i < 0) throw pyError('RuntimeError', 'AnimDataDrivers.remove(): driver not found');
    ad.drivers.splice(i, 1);
    touched();
  }
}
kwMethod(Drivers.prototype, 'find', ['data_path', 'index']);
kwMethod(Drivers.prototype, 'new', ['data_path', 'index']);

const driverCache = new WeakMap<Driver, unknown>();

/** A driver shown as an F-Curve (`fcurve.driver`), as `driver_add` returns it. */
function driverFCurve(obId: string, d: Driver): unknown {
  let w = driverCache.get(d);
  if (w) return w;
  const alive = () => !!app.doc.objects[obId]?.animation_data?.drivers.includes(d);
  const path = () => `${obPath(obId)}.animation_data.drivers.find(${q(d.data_path)}, index=${d.array_index})`;
  const driver = proxify(new DriverStruct(d, alive, `${path()}.driver`));
  w = {
    __kind: 'struct',
    __type: 'FCurve',
    __driver: d,
    get data_path() {
      return d.data_path;
    },
    set data_path(v: string) {
      d.data_path = String(v);
      touched();
    },
    get array_index() {
      return d.array_index;
    },
    set array_index(v: number) {
      d.array_index = Math.round(Number(v));
      touched();
    },
    driver,
    get is_valid() {
      return alive();
    },
    keyframe_points: [],
    modifiers: [],
    mute: false,
    /** The driver's value now. */
    evaluate: () => {
      app.evaluate();
      return Number(getValue(app.doc, obOf(obId), d.data_path, d.array_index));
    },
    toString: () => `<bpy_struct, FCurve at ${path()}>`,
  };
  driverCache.set(d, w);
  return w;
}

class DriverStruct extends Struct {
  constructor(
    readonly __d: Driver,
    alive: () => boolean,
    path: string,
  ) {
    super('Driver', () => (alive() ? (__d as unknown as Raw) : null), path);
  }
  override __hidden() {
    return new Set(['variables', 'data_path', 'array_index']);
  }
  get type() {
    return this.__d.type;
  }
  set type(v: string) {
    const t = String(v).toUpperCase();
    if (!['AVERAGE', 'SUM', 'SCRIPTED', 'MIN', 'MAX'].includes(t)) throw pyError('TypeError', `bpy_struct: item.attr = val: enum "${v}" not found in ('AVERAGE', 'SUM', 'SCRIPTED', 'MIN', 'MAX')`);
    this.__d.type = t as Driver['type'];
    touched();
  }
  get variables() {
    return new DriverVariables(this.__d, `${this.__path}.variables`);
  }
  get is_valid() {
    return true;
  }
  get use_self() {
    return false;
  }
  set use_self(_v: boolean) {
    /* expressions here see the variables and `frame` */
  }
}

class DriverVariables extends PropCollection<unknown> {
  constructor(
    readonly d: Driver,
    path: string,
  ) {
    super(path);
  }
  list() {
    return this.d.variables.map((v) => this.wrap(v));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  private wrap(v: DriverVariable) {
    return proxify(new DriverVariableStruct(this.d, v, `${this.__path}[${q(v.name)}]`));
  }
  new() {
    const names = new Set(this.d.variables.map((v) => v.name));
    let name = 'var';
    for (let i = 1; names.has(name); i++) name = `var_${String(i).padStart(3, '0')}`;
    const v: DriverVariable = { name, type: 'SINGLE_PROP', targets: [{ id: null, data_path: '' }] };
    this.d.variables.push(v);
    touched();
    return this.wrap(v);
  }
  remove(variable: unknown) {
    const v = (variable as { __v?: DriverVariable })?.__v;
    const i = v ? this.d.variables.indexOf(v) : -1;
    if (i < 0) throw pyError('RuntimeError', 'ChannelDriverVariables.remove(): variable not found');
    this.d.variables.splice(i, 1);
    touched();
  }
}

class DriverVariableStruct extends Struct {
  constructor(
    readonly __d: Driver,
    readonly __v: DriverVariable,
    path: string,
  ) {
    super('DriverVariable', () => (__d.variables.includes(__v) ? (__v as unknown as Raw) : null), path);
  }
  override __hidden() {
    return new Set(['targets']);
  }
  get type() {
    return this.__v.type;
  }
  set type(v: string) {
    const t = String(v).toUpperCase() as DriverVariable['type'];
    if (!['SINGLE_PROP', 'TRANSFORMS', 'ROTATION_DIFF', 'LOC_DIFF'].includes(t)) throw pyError('TypeError', `bpy_struct: item.attr = val: enum "${v}" not found in ('SINGLE_PROP', 'TRANSFORMS', 'ROTATION_DIFF', 'LOC_DIFF')`);
    this.__v.type = t;
    const n = t === 'ROTATION_DIFF' || t === 'LOC_DIFF' ? 2 : 1;
    while (this.__v.targets.length < n) this.__v.targets.push({ id: null, data_path: '' });
    this.__v.targets.length = n;
    touched();
  }
  get targets() {
    const v = this.__v;
    return v.targets.map((t, i) => targetStruct(t, `${this.__path}.targets[${i}]`));
  }
  get is_name_valid() {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(this.__v.name);
  }
}

function targetStruct(t: DriverVariable['targets'][number], path: string) {
  return {
    __kind: 'struct',
    __type: 'DriverTarget',
    get id() {
      return t.id && app.doc.objects[t.id] ? wrapId('objects', t.id) : null;
    },
    set id(v: unknown) {
      t.id = v === null || v === undefined ? null : expectId(v, 'objects', 'Object (driver targets here are objects)');
      touched();
    },
    get id_type() {
      return 'OBJECT';
    },
    set id_type(v: string) {
      if (String(v) !== 'OBJECT') throw pyError('TypeError', 'driver targets here are objects (id_type OBJECT)');
    },
    get data_path() {
      return t.data_path;
    },
    set data_path(v: string) {
      t.data_path = String(v ?? '');
      touched();
    },
    get transform_type() {
      return t.transform_type ?? 'LOC_X';
    },
    set transform_type(v: string) {
      t.transform_type = String(v);
      touched();
    },
    get transform_space() {
      return t.transform_space ?? 'WORLD_SPACE';
    },
    set transform_space(v: string) {
      const sp = String(v);
      if (sp !== 'WORLD_SPACE' && sp !== 'TRANSFORM_SPACE' && sp !== 'LOCAL_SPACE') throw pyError('TypeError', `bpy_struct: item.attr = val: enum "${sp}" not found in ('WORLD_SPACE', 'TRANSFORM_SPACE', 'LOCAL_SPACE')`);
      t.transform_space = sp;
      touched();
    },
    bone_target: '',
    toString: () => `<bpy_struct, DriverTarget at ${path}>`,
  };
}

// ---------------------------------------------------------------------------
// actions: F-Curves with keyframe points and modifiers

class ActionAnim {
  get fcurves() {
    return new FCurves((this as unknown as ActionStruct).__id);
  }
  get id_root() {
    return 'OBJECT';
  }
  get groups() {
    const actId = (this as unknown as ActionStruct).__id;
    const act = app.doc.actions[actId];
    const names = [...new Set(act.fcurves.map((f) => f.group).filter(Boolean))] as string[];
    return names.map((name) => groupStruct(actId, name));
  }
}
mixin(ActionStruct, ActionAnim, true);

const actOf = (id: string) => {
  const a = app.doc.actions[id];
  if (!a) throw pyError('ReferenceError', 'Action has been removed');
  return a;
};

/** F-Curves of an action (`action.fcurves`), or of one slot of it (a channelbag's `fcurves`). */
export class FCurves extends PropCollection<unknown> {
  constructor(
    readonly actId: string,
    readonly slot?: number,
    path?: string,
  ) {
    super(path ?? `bpy.data.actions[${q(app.doc.actions[actId]?.name ?? '?')}].fcurves`);
  }
  private curves() {
    const act = actOf(this.actId);
    return this.slot === undefined ? act.fcurves : slotCurves(act, this.slot);
  }
  list() {
    return this.curves().map((f) => fcurveWrapper(this.actId, f));
  }
  nameOf(x: unknown) {
    return (x as { data_path: string }).data_path;
  }
  new(data_path: string, index = 0, action_group = '') {
    const act = actOf(this.actId);
    const i = Number(index ?? 0);
    if (this.curves().some((f) => f.data_path === data_path && f.array_index === i)) throw pyError('RuntimeError', `Error: F-Curve '${data_path}[${i}]' already exists in action '${act.name}'`);
    const fc = ensureFCurve(act, String(data_path), i, this.slot);
    if (action_group) fc.group = String(action_group);
    touched();
    return fcurveWrapper(this.actId, fc);
  }
  find(data_path: string, index = 0) {
    const fc = this.curves().find((f) => f.data_path === data_path && f.array_index === Number(index ?? 0));
    return fc ? fcurveWrapper(this.actId, fc) : null;
  }
  /** The F-Curve for data_path/index, created when missing. */
  ensure(data_path: string, index = 0, group_name = '') {
    return this.find(data_path, index) ?? this.new(data_path, index, group_name);
  }
  remove(fcurve: unknown) {
    const act = actOf(this.actId);
    const fc = (fcurve as { __fc?: FCurve })?.__fc;
    const i = fc ? act.fcurves.indexOf(fc) : -1;
    if (i < 0) throw pyError('RuntimeError', 'ActionFCurves.remove(): F-Curve not found');
    act.fcurves.splice(i, 1);
    touched();
  }
  clear() {
    const act = actOf(this.actId);
    const mine = new Set(this.curves());
    act.fcurves = act.fcurves.filter((f) => !mine.has(f));
    touched();
  }
}
kwMethod(FCurves.prototype, 'new', ['data_path', 'index', 'action_group']);
kwMethod(FCurves.prototype, 'ensure', ['data_path', 'index', 'group_name']);
kwMethod(FCurves.prototype, 'find', ['data_path', 'index']);

const fcCache = new WeakMap<FCurve, unknown>();
/** An action group (`fcurve.group`, `action.groups[...]`). */
export function groupStruct(actId: string, name: string) {
  const act = () => app.doc.actions[actId];
  return {
    __kind: 'struct',
    __type: 'ActionGroup',
    name,
    get channels() {
      return (act()?.fcurves ?? []).filter((f) => f.group === name).map((f) => fcurveWrapper(actId, f));
    },
    get use_pin() {
      return !!act()?.pinned_groups?.includes(name);
    },
    set use_pin(v: boolean) {
      const a = act();
      if (!a) return;
      const list = (a.pinned_groups ?? []).filter((g) => g !== name);
      a.pinned_groups = v ? [...list, name] : list;
      touched();
    },
    toString: () => `<bpy_struct, ActionGroup("${name}")>`,
  };
}

export function fcurveWrapper(actId: string, fc: FCurve): unknown {
  let w = fcCache.get(fc);
  if (w) return w;
  const alive = () => !!app.doc.actions[actId]?.fcurves.includes(fc);
  const path = () => `bpy.data.actions[${q(app.doc.actions[actId]?.name ?? '?')}].fcurves.find(${q(fc.data_path)}, index=${fc.array_index})`;
  const s = new Struct('FCurve', () => (alive() ? (fc as unknown as Raw) : null), '');
  Object.defineProperty(s, '__path', { get: path });
  Object.defineProperty(s, '__fc', { value: fc });
  Object.defineProperty(s, 'keyframe_points', { get: () => new KeyframePoints(fc, alive, `${path()}.keyframe_points`) });
  Object.defineProperty(s, 'modifiers', { get: () => new FModifiers(fc, alive, `${path()}.modifiers`) });
  Object.defineProperty(s, 'evaluate', { value: (frame: number) => evaluateFCurve(fc, Number(frame)) });
  Object.defineProperty(s, 'update', {
    value: () => {
      sortKeyframes(fc);
      calcHandles(fc);
      touched();
    },
  });
  Object.defineProperty(s, 'range', { value: () => new Vector(fc.keyframe_points.length ? [fc.keyframe_points[0].co[0], fc.keyframe_points[fc.keyframe_points.length - 1].co[0]] : [0, 0]) });
  Object.defineProperty(s, 'is_valid', { get: alive });
  Object.defineProperty(s, 'driver', { value: null });
  // the group is an ActionGroup (assigned from a group, or by name)
  Object.defineProperty(s, 'group', {
    get: () => (fc.group ? groupStruct(actId, fc.group) : null),
    set: (v: unknown) => {
      fc.group = v === null || v === undefined ? undefined : typeof v === 'string' ? v : String((v as { name?: unknown }).name ?? '');
      if (!fc.group) delete fc.group;
      touched();
    },
  });
  w = proxify(s);
  fcCache.set(fc, w);
  return w;
}

class KeyframePoints extends PropCollection<unknown> {
  constructor(
    readonly fc: FCurve,
    readonly alive: () => boolean,
    path: string,
  ) {
    super(path);
  }
  private kps() {
    if (!this.alive()) throw pyError('ReferenceError', 'F-Curve has been removed');
    return this.fc.keyframe_points;
  }
  list() {
    return this.kps().map((k, i) => this.wrap(i));
  }
  nameOf() {
    return '';
  }
  private wrap(i: number) {
    const fc = this.fc;
    const k = fc.keyframe_points[i];
    return proxify(new Struct('Keyframe', () => (fc.keyframe_points.includes(k) ? (k as unknown as Raw) : null), `${this.__path}[${i}]`));
  }
  /** Adds (or replaces) the key at `frame`; options may include 'REPLACE', 'NEEDED', 'FAST'. */
  insert(frame: number, value: number, options: unknown = null, keyframe_type = 'KEYFRAME') {
    void options;
    const k = insertKeyframe(this.fc, Number(frame), Number(value), { type: String(keyframe_type || 'KEYFRAME') as 'KEYFRAME' });
    touched();
    return this.wrap(this.fc.keyframe_points.indexOf(k));
  }
  /** Appends `count` keys at frame 0 (set them with foreach_set('co', …), then fcurve.update()). */
  add(count = 1) {
    const keys = this.kps();
    for (let i = 0; i < Math.max(0, Math.round(Number(count))); i++)
      keys.push({ co: [0, 0], handle_left: [0, 0], handle_right: [0, 0], handle_left_type: 'AUTO_CLAMPED', handle_right_type: 'AUTO_CLAMPED', interpolation: 'BEZIER', easing: 'AUTO', type: 'KEYFRAME' } as FCurve['keyframe_points'][number]);
    touched();
  }
  remove(keyframe: unknown, fast = false) {
    void fast;
    const keys = this.kps();
    const raw = (keyframe as Struct)?.__resolve?.();
    const i = raw ? keys.indexOf(raw as never) : -1;
    if (i < 0) throw pyError('RuntimeError', 'FCurveKeyframePoints.remove(): keyframe not found');
    keys.splice(i, 1);
    calcHandles(this.fc);
    touched();
  }
  clear() {
    this.kps().length = 0;
    touched();
  }
  foreach_get(attr: string, seq?: unknown) {
    const keys = this.kps();
    let out: unknown[];
    if (attr === 'co' || attr === 'handle_left' || attr === 'handle_right') out = keys.flatMap((k) => [k[attr][0], k[attr][1]]);
    else if (attr === 'select_control_point') out = keys.map((k) => !!k.select_control_point);
    else if (attr === 'interpolation' || attr === 'type') out = keys.map((k) => k[attr]);
    else throw pyError('TypeError', `foreach_get: unsupported attribute "${attr}" (supported: co, handle_left, handle_right, select_control_point, interpolation, type)`);
    if (Array.isArray(seq)) for (let i = 0; i < out.length && i < seq.length; i++) seq[i] = out[i];
    return out;
  }
  foreach_set(attr: string, seq: unknown) {
    const keys = this.kps();
    const a = (toPlain(seq) as unknown[]).flat() as number[];
    if (attr === 'co' || attr === 'handle_left' || attr === 'handle_right') {
      if (a.length !== keys.length * 2) throw pyError('ValueError', `foreach_set: expected ${keys.length * 2} values (frame, value per key), got ${a.length}`);
      keys.forEach((k, i) => {
        k[attr] = [Number(a[i * 2]), Number(a[i * 2 + 1])];
        if (attr === 'co') {
          k.handle_left = [k.co[0] - 1, k.co[1]];
          k.handle_right = [k.co[0] + 1, k.co[1]];
        }
      });
      if (attr === 'co') calcHandles(this.fc);
    } else if (attr === 'select_control_point') keys.forEach((k, i) => (k.select_control_point = !!a[i]));
    else throw pyError('TypeError', `foreach_set: unsupported attribute "${attr}" (supported: co, handle_left, handle_right, select_control_point)`);
    touched();
  }
}
kwMethod(KeyframePoints.prototype, 'insert', ['frame', 'value', 'options', 'keyframe_type']);
kwMethod(KeyframePoints.prototype, 'add', ['count']);
kwMethod(KeyframePoints.prototype, 'remove', ['keyframe', 'fast']);

const FMOD_TYPES: FModifier['type'][] = ['NOISE', 'CYCLES', 'GENERATOR', 'LIMITS', 'STEPPED', 'FNGENERATOR', 'ENVELOPE'];
const FMOD_DEFAULTS: Record<string, Any> = {
  NOISE: { scale: 1, strength: 1, phase: 1, offset: 0, depth: 0, blend_type: 'REPLACE' },
  CYCLES: { mode_before: 'REPEAT', mode_after: 'REPEAT', cycles_before: 0, cycles_after: 0 },
  GENERATOR: { mode: 'POLYNOMIAL', poly_order: 1, coefficients: [0, 1], use_additive: false },
  LIMITS: { use_min_x: false, use_max_x: false, use_min_y: false, use_max_y: false, min_x: 0, max_x: 0, min_y: 0, max_y: 0 },
  STEPPED: { frame_step: 2, frame_offset: 0, use_frame_start: false, use_frame_end: false, frame_start: 0, frame_end: 0 },
  FNGENERATOR: { function_type: 'SIN', amplitude: 1, phase_multiplier: 1, phase_offset: 0, value_offset: 0, use_additive: false },
  ENVELOPE: { reference_value: 0, default_min: -1, default_max: 1, control_points: [] },
};

class FModifiers extends PropCollection<unknown> {
  constructor(
    readonly fc: FCurve,
    readonly alive: () => boolean,
    path: string,
  ) {
    super(path);
  }
  list() {
    return this.fc.modifiers.map((m, i) => proxify(new Struct('FModifier', () => (this.fc.modifiers.includes(m) ? (m as unknown as Raw) : null), `${this.__path}[${i}]`)));
  }
  nameOf(x: unknown) {
    return (x as { type: string }).type;
  }
  new(type: string) {
    const t = String(type ?? '').toUpperCase() as FModifier['type'];
    if (!FMOD_TYPES.includes(t)) throw pyError('TypeError', `FCurveModifiers.new(): enum "${type}" not found in (${FMOD_TYPES.map((x) => `'${x}'`).join(', ')})`);
    const m = { type: t, mute: false, ...structuredClone(FMOD_DEFAULTS[t]) } as FModifier;
    this.fc.modifiers.push(m);
    touched();
    return this.getItem(this.fc.modifiers.length - 1);
  }
  remove(modifier: unknown) {
    const raw = (modifier as Struct)?.__resolve?.();
    const i = raw ? this.fc.modifiers.indexOf(raw as unknown as FModifier) : -1;
    if (i < 0) throw pyError('RuntimeError', 'FCurveModifiers.remove(): modifier not found');
    this.fc.modifiers.splice(i, 1);
    touched();
  }
}
kwMethod(FModifiers.prototype, 'new', ['type']);

// bpy.data.actions.new keeps working through api.ts; this makes sure new actions have no stale wrapper
void newAction;

// ---------------------------------------------------------------------------
// keying sets and timeline markers on the scene
// (the same path rules as the Keying Sets panel; kept here so scripting doesn't load the UI)

const BUILTIN_KEYING_SETS: [string, string][] = [
  ['Location', 'Location'],
  ['Rotation', 'Rotation'],
  ['Scale', 'Scale'],
  ['LocRotScale', 'Location, Rotation & Scale'],
  ['Available', 'Available'],
  ['WholeCharacter', 'Whole Character'],
];

function addKeyingPath(set: KeyingSetData, id: string, path: string, index: number) {
  if (set.paths.some((p) => p.id === id && p.data_path === path && (p.index === index || p.index === -1))) return false;
  if (index === -1) set.paths = set.paths.filter((p) => !(p.id === id && p.data_path === path));
  set.paths.push({ id, data_path: path, index });
  set.active_path_index = set.paths.length - 1;
  return true;
}

function removeKeyingPath(set: KeyingSetData, id: string, path: string, index: number) {
  const before = set.paths.length;
  set.paths = set.paths.filter((p) => !(p.id === id && p.data_path === path && (index === -1 || p.index === index || p.index === -1)));
  set.active_path_index = Math.max(0, Math.min(set.active_path_index ?? 0, set.paths.length - 1));
  return set.paths.length !== before;
}

class KeyingSets extends PropCollection<unknown> {
  constructor(readonly all = false) {
    super(`bpy.context.scene.keying_sets${all ? '_all' : ''}`);
  }
  private sets(): KeyingSetData[] {
    return (app.doc.scene.keying_sets ??= []);
  }
  list() {
    const user = this.sets().map((k) => this.wrap(k));
    if (!this.all) return user;
    return [...BUILTIN_KEYING_SETS.map(([id, label]) => ({ __kind: 'struct', __type: 'KeyingSet', bl_idname: id, bl_label: label, name: label, is_path_absolute: false, paths: [] })), ...user];
  }
  nameOf(x: unknown) {
    return (x as { bl_label: string }).bl_label;
  }
  wrap(k: KeyingSetData) {
    const s = new Struct('KeyingSet', () => ((app.doc.scene.keying_sets ?? []).includes(k) ? (k as unknown as Raw) : null), `bpy.context.scene.keying_sets[${q(k.name)}]`);
    Object.defineProperty(s, '__ks', { value: k });
    Object.defineProperties(s, {
      bl_label: { get: () => k.name, set: (v: string) => ((k.name = String(v)), touched()) },
      bl_idname: { get: () => k.name },
      bl_description: { value: '' },
      is_path_absolute: { value: true },
      paths: { get: () => new KeyingSetPaths(k, `${s.__path}.paths`) },
      refresh: { value: () => undefined },
    });
    return proxify(s);
  }
  /** Adds an empty keying set and makes it active. */
  new(idname = 'KeyingSet', name = 'KeyingSet') {
    void idname;
    const list = this.sets();
    const k: KeyingSetData = { name: uniqueName(Object.fromEntries(list.map((x, i) => [i, x])), String(name || 'KeyingSet')), paths: [] };
    list.push(k);
    app.doc.scene.keying_set = `KS:${k.name}`;
    touched();
    return this.wrap(k);
  }
  remove(ks: unknown) {
    const list = this.sets();
    const i = list.indexOf((ks as { __ks?: KeyingSetData })?.__ks!);
    if (i < 0) throw pyError('RuntimeError', 'KeyingSets.remove(): keying set not found');
    const [k] = list.splice(i, 1);
    if (app.doc.scene.keying_set === `KS:${k.name}`) app.doc.scene.keying_set = 'LocRotScale';
    touched();
  }
  get active() {
    const ks = app.doc.scene.keying_set ?? '';
    if (ks.startsWith('KS:')) {
      const k = this.sets().find((x) => x.name === ks.slice(3));
      return k ? this.wrap(k) : null;
    }
    return this.all ? (this.list() as { bl_idname: string }[]).find((x) => x.bl_idname === ks) ?? null : null;
  }
  set active(v: unknown) {
    const k = (v as { __ks?: KeyingSetData })?.__ks;
    if (k) app.doc.scene.keying_set = `KS:${k.name}`;
    else if ((v as { bl_idname?: string })?.bl_idname) app.doc.scene.keying_set = (v as { bl_idname: string }).bl_idname as never;
    touched();
  }
  get active_index() {
    const ks = app.doc.scene.keying_set ?? '';
    return ks.startsWith('KS:') ? this.sets().findIndex((x) => x.name === ks.slice(3)) : -1;
  }
  set active_index(i: number) {
    const k = this.sets()[Number(i)];
    if (k) app.doc.scene.keying_set = `KS:${k.name}`;
    touched();
  }
}
kwMethod(KeyingSets.prototype, 'new', ['idname', 'name']);

class KeyingSetPaths extends PropCollection<unknown> {
  constructor(
    readonly k: KeyingSetData,
    path: string,
  ) {
    super(path);
  }
  list() {
    return this.k.paths.map((p, i) => this.wrap(p, i));
  }
  nameOf(x: unknown) {
    return (x as { data_path: string }).data_path;
  }
  private wrap(p: KeyingSetData['paths'][number], i: number) {
    const k = this.k;
    return {
      __kind: 'struct',
      __type: 'KeyingSetPath',
      __p: p,
      get id() {
        return p.id && app.doc.objects[p.id] ? wrapId('objects', p.id) : null;
      },
      set id(v: unknown) {
        p.id = v === null || v === undefined ? null : expectId(v, 'objects', 'Object');
        touched();
      },
      id_type: 'OBJECT',
      get data_path() {
        return p.data_path;
      },
      set data_path(v: string) {
        p.data_path = String(v);
        touched();
      },
      get array_index() {
        return Math.max(0, p.index);
      },
      set array_index(v: number) {
        p.index = Math.round(Number(v));
        touched();
      },
      get use_entire_array() {
        return p.index < 0;
      },
      set use_entire_array(v: boolean) {
        p.index = v ? -1 : Math.max(0, p.index);
        touched();
      },
      group_method: 'NAMED',
      toString: () => `<bpy_struct, KeyingSetPath at ${q(k.name)}.paths[${i}]>`,
    };
  }
  /** Adds a path; targets are objects (a property of an object's data uses `data.<name>`). */
  add(target_id: unknown, data_path: string, index = -1, group_method = 'KEYINGSET', group_name = '') {
    void group_method;
    void group_name;
    let id: string;
    let path = String(data_path ?? '');
    if (isIdWrapper(target_id) && target_id.__table !== 'objects') {
      const t = targetForRaw(app.doc[target_id.__table as 'meshes'][target_id.__id] as object, path);
      id = t.ob.id;
      path = t.path;
    } else id = expectId(target_id, 'objects', 'Object');
    addKeyingPath(this.k, id, path, Number(index ?? -1));
    touched();
    return this.getItem(this.k.paths.length - 1);
  }
  remove(path: unknown) {
    const p = (path as { __p?: KeyingSetData['paths'][number] })?.__p;
    if (!p || !removeKeyingPath(this.k, p.id ?? '', p.data_path, p.index)) throw pyError('RuntimeError', 'KeyingSetPaths.remove(): path not found');
    touched();
  }
  clear() {
    this.k.paths = [];
    touched();
  }
  get active() {
    const p = this.k.paths[this.k.active_path_index ?? 0];
    return p ? this.getItem(this.k.active_path_index ?? 0) : null;
  }
}
kwMethod(KeyingSetPaths.prototype, 'add', ['target_id', 'data_path', 'index', 'group_method', 'group_name']);

class TimelineMarkers extends PropCollection<unknown> {
  constructor() {
    super('bpy.context.scene.timeline_markers');
  }
  private markers(): TimelineMarker[] {
    return app.doc.scene.timeline_markers;
  }
  list() {
    return this.markers().map((m) => this.wrap(m));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  private wrap(m: TimelineMarker) {
    const s = new Struct('TimelineMarker', () => (this.markers().includes(m) ? (m as unknown as Raw) : null), `${this.__path}[${q(m.name)}]`);
    Object.defineProperty(s, '__m', { value: m });
    Object.defineProperty(s, 'camera', {
      get: () => (m.camera && app.doc.objects[m.camera] ? wrapId('objects', m.camera) : null),
      set: (v: unknown) => {
        m.camera = v === null || v === undefined ? null : expectId(v, 'objects', 'Object');
        touched();
      },
    });
    return proxify(s);
  }
  new(name: string, frame = 1) {
    const m: TimelineMarker = { name: String(name ?? ''), frame: Math.round(Number(frame ?? 1)), select: false };
    this.markers().push(m);
    touched();
    return this.wrap(m);
  }
  remove(marker: unknown) {
    const i = this.markers().indexOf((marker as { __m?: TimelineMarker })?.__m!);
    if (i < 0) throw pyError('RuntimeError', 'TimelineMarkers.remove(): marker not found');
    this.markers().splice(i, 1);
    touched();
  }
  clear() {
    this.markers().length = 0;
    touched();
  }
}
kwMethod(TimelineMarkers.prototype, 'new', ['name', 'frame']);

class SceneAnim {
  get keying_sets() {
    return new KeyingSets();
  }
  get keying_sets_all() {
    return new KeyingSets(true);
  }
  get timeline_markers() {
    return new TimelineMarkers();
  }
}
mixin(SceneStruct, SceneAnim, true);
