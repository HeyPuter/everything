// Generic struct / collection / bound-vector machinery for the scripting API.
// Wrappers never hold document objects directly: they hold a resolver that looks the
// data up in the *current* `app.doc` on every access, so they stay valid across undo,
// file loads and the copy-on-write array replacement used by the undo system.
import { app } from '../app/app';
import { cow } from '../data/cow';
import type { DocumentData } from '../data/types';
import { Vector, VecBase, Euler, Quaternion, Color, Matrix, type EulerOrder } from './mathutils';

export type Raw = Record<string, unknown>;

// ---------------------------------------------------------------------------
// script run state

export const scriptState = {
  /** >0 while a script (or console line) is executing: undo pushes are grouped. */
  depth: 0,
  /** set by every API write; decides whether a "Run Script" undo step is needed */
  mutated: false,
  lastEvalRevision: -1,
};

/** Called by every API write. */
export function touched(kind: 'doc' | 'geometry' | 'select' | 'frame' = 'doc') {
  scriptState.mutated = true;
  // arrays written in place keep their identity, which the evaluated-mesh cache keys on
  if (kind === 'geometry') app.graph?.invalidate();
  if (typeof requestAnimationFrame === 'function') app.changed(kind === 'geometry' ? 'geometry' : kind, 'doc');
  else app.revision++;
}

/** Make sure evaluated data (world matrices, evaluated meshes) reflects pending edits. */
export function ensureEvaluated() {
  if (scriptState.lastEvalRevision !== app.revision) {
    app.evaluate();
    scriptState.lastEvalRevision = app.revision;
  }
}

// ---------------------------------------------------------------------------
// errors (prefixes are translated to Python exception types by the bridge)

export const pyError = (type: 'AttributeError' | 'TypeError' | 'KeyError' | 'IndexError' | 'ValueError' | 'RuntimeError' | 'ReferenceError', msg: string) => {
  const e = new Error(`${type}: ${msg}`);
  e.name = type;
  return e;
};

// ---------------------------------------------------------------------------
// keyword-argument aware methods

export type KwFn = ((...args: unknown[]) => unknown) & { __params?: string[] };

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Declare parameter names of a method so Python keyword arguments map to positions, and
 * let JavaScript callers pass a trailing `{name: value}` options object instead.
 */
export function kwMethod(proto: object, name: string, params: string[]) {
  const orig = (proto as Record<string, KwFn>)[name];
  const wrapped: KwFn = function (this: unknown, ...args: unknown[]) {
    const last = args[args.length - 1];
    if (args.length && isPlain(last) && Object.keys(last).length && Object.keys(last).every((k) => params.includes(k)) && !(params.length && args.length - 1 >= params.length)) {
      const opts = args.pop() as Record<string, unknown>;
      for (const [k, v] of Object.entries(opts)) args[params.indexOf(k)] = v;
    }
    return orig.apply(this, args);
  };
  wrapped.__params = params;
  Object.defineProperty(proto, name, { value: wrapped, writable: true, configurable: true });
}

// ---------------------------------------------------------------------------
// ID lookup (string references inside the document)

export const ID_TABLES: [keyof DocumentData, string][] = [
  ['objects', 'Object'],
  ['meshes', 'Mesh'],
  ['materials', 'Material'],
  ['collections', 'Collection'],
  ['cameras', 'Camera'],
  ['lights', 'Light'],
  ['actions', 'Action'],
  ['images', 'Image'],
  ['texts', 'Text'],
  ['node_groups', 'NodeTree'],
  ['worlds', 'World'],
  ['curves', 'Curve'],
  ['armatures', 'Armature'],
  ['lattices', 'Lattice'],
  ['metaballs', 'MetaBall'],
  ['particles', 'ParticleSettings'],
  ['brushes', 'Brush'],
];

const EMPTY: Record<string, Raw> = Object.freeze({}) as Record<string, Raw>;
export function tableOf(doc: DocumentData, kind: string): Record<string, Raw> {
  return (doc as unknown as Record<string, Record<string, Raw> | undefined>)[kind] ?? EMPTY;
}

/** Find the table holding an id string (ids are globally unique). */
export function findIdTable(id: string): string | null {
  if (typeof id !== 'string' || id.length < 4 || !id.includes('_')) return null;
  const doc = app.doc as unknown as Record<string, unknown>;
  for (const [t] of ID_TABLES) {
    const tbl = doc[t] as Record<string, unknown> | undefined;
    if (tbl && Object.prototype.hasOwnProperty.call(tbl, id)) return t;
  }
  // tables added by other subsystems (e.g. textures)
  for (const [k, tbl] of Object.entries(doc)) {
    if (k === 'scene' || !tbl || typeof tbl !== 'object' || Array.isArray(tbl)) continue;
    if (Object.prototype.hasOwnProperty.call(tbl, id) && (tbl as Record<string, Raw>)[id]?.id === id) return k;
  }
  return null;
}

/** Hook set by api.ts: wrap a data-block by table + id. */
export const idFactory: { wrap: (table: string, id: string) => unknown } = { wrap: () => null };

export const isIdWrapper = (v: unknown): v is { __table: string; __id: string } => !!v && typeof v === 'object' && typeof (v as { __id?: unknown }).__id === 'string' && typeof (v as { __table?: unknown }).__table === 'string';

// ---------------------------------------------------------------------------
// value conversion

/** Convert script values (vectors, matrices, wrappers, sets) to plain document values. */
export function toPlain(v: unknown, current?: unknown): unknown {
  if (v === undefined) return null;
  if (v === null || typeof v !== 'object') return v;
  if (isIdWrapper(v)) return v.__id;
  if (v instanceof Matrix) return Array.isArray(current) && current.length === 16 ? v.toColumnMajor() : v.rows.map((r) => [...r]);
  if (v instanceof VecBase) return v.toArray();
  if (v instanceof Set) return [...v].map((x) => toPlain(x));
  if (Array.isArray(v)) return v.map((x) => toPlain(x));
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>);
  if (v instanceof BoundArray) return v.toArray().map((x) => toPlain(x));
  if (v instanceof Struct) return structuredClone(v.__raw);
  if (typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') return [...(v as Iterable<unknown>)].map((x) => toPlain(x));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = toPlain(x);
  return out;
}

const INT_KEY = /(^|_)(levels|count|segments|iterations|resolution(_[uvxy])?|samples|steps|seed|subdivisions|vertices|rings|frame(_start|_end|_step|_current|_offset)?|index|bounces|order_u|render_levels|quality|width|height|percentage|fps|offset_u|axis)$/;
export const isIntKey = (key: string) => INT_KEY.test(key) && !/factor|offset$|size/.test(key);

/** Assign a script value to a document field with type coercion. */
export function assignField(raw: Raw, key: string, value: unknown, typeName = 'struct') {
  const cur = raw[key];
  let v = toPlain(value, cur);
  if (typeof cur === 'boolean') {
    if (typeof v !== 'boolean' && typeof v !== 'number') throw pyError('TypeError', `${typeName}.${key} expected True/False, not ${typeof v}`);
    v = !!v;
  } else if (typeof cur === 'number') {
    if (typeof v === 'boolean') v = Number(v);
    if (typeof v !== 'number' || Number.isNaN(v)) throw pyError('TypeError', `${typeName}.${key} expected a number, not ${v === null ? 'None' : typeof v}`);
    if (Number.isInteger(cur) && isIntKey(key)) v = Math.round(v);
  } else if (typeof cur === 'string' && v !== null && typeof v !== 'string') {
    throw pyError('TypeError', `${typeName}.${key} expected a string, not ${typeof v}`);
  } else if ((Array.isArray(cur) || ArrayBuffer.isView(cur)) && cur) {
    const n = (cur as ArrayLike<unknown>).length;
    if (!Array.isArray(v)) {
      if (typeof v === 'number' && Array.isArray(cur)) v = (cur as unknown[]).map(() => v);
      else throw pyError('TypeError', `${typeName}.${key} expected a sequence of ${n} items`);
    }
    const arr = v as unknown[];
    if (n && n <= 16 && arr.length !== n && !(Array.isArray(cur) && typeof cur[0] !== 'number')) {
      throw pyError('ValueError', `${typeName}.${key} expected a sequence of ${n} items, got ${arr.length}`);
    }
    if (ArrayBuffer.isView(cur)) {
      const C = (cur as unknown as { constructor: new (a: ArrayLike<number>) => unknown }).constructor;
      v = new C(arr.map(Number));
    } else if (typeof (cur as unknown[])[0] === 'boolean') v = arr.map((x) => !!x);
    else if (typeof (cur as unknown[])[0] === 'number') v = arr.map(Number);
  }
  raw[key] = v;
}

// ---------------------------------------------------------------------------
// Struct (generic RNA-like wrapper)

const HIDDEN = new Set(['id', 'tree', 'custom', 'users', '__proto__']);
const READONLY = new Set(['type', 'bl_idname']);

export class Struct {
  readonly __kind: string = 'struct';
  constructor(
    readonly __type: string,
    readonly __resolve: () => Raw | null | undefined,
    protected __pathInit: string,
  ) {}
  /** Python-style path of this struct (used for repr and the Info log). */
  get __path(): string {
    return this.__pathInit;
  }
  /** Raw document object (throws if the data was removed). */
  get __raw(): Raw {
    const r = this.__resolve();
    if (!r) throw pyError('ReferenceError', `StructRNA of type ${this.__type} has been removed`);
    return r;
  }
  /** Extra raw field source (e.g. node props), consulted after the main record. */
  __extra(): Raw | null {
    return null;
  }
  /** Read-only raw keys hidden from generic access. */
  __hidden(): Set<string> {
    return HIDDEN;
  }
  get bl_rna() {
    return { identifier: this.__type, name: this.__type };
  }
  get rna_type() {
    return this.bl_rna;
  }
  path_from_id() {
    return this.__path;
  }
  /** Custom properties (`ob["key"]`) when the record has a `custom` dictionary. */
  getItem(key: string) {
    const c = (this.__raw.custom ?? null) as Raw | null;
    if (!c || !(key in c)) throw pyError('KeyError', `'bpy_struct[key]: key "${key}" not found'`);
    return c[key];
  }
  setItem(key: string, value: unknown) {
    const raw = this.__raw;
    const c = ((raw.custom as Raw | undefined) ??= {});
    c[key] = toPlain(value);
    touched();
  }
  delItem(key: string) {
    const c = this.__raw.custom as Raw | undefined;
    if (c) delete c[key];
    touched();
  }
  keys() {
    return Object.keys((this.__raw.custom as Raw | undefined) ?? {});
  }
  get(key: string, def: unknown = null) {
    const c = this.__raw.custom as Raw | undefined;
    return c && key in c ? c[key] : def;
  }
  /** Generic field names (for autocompletion / dir()). */
  __fields(): string[] {
    const raw = this.__resolve();
    const hidden = this.__hidden();
    const keys = new Set<string>();
    if (raw) for (const k of Object.keys(raw)) if (!hidden.has(k) && !k.startsWith('_')) keys.add(k);
    const extra = raw ? this.__extra() : null;
    if (extra) for (const k of Object.keys(extra)) keys.add(k);
    let p = Object.getPrototypeOf(this);
    while (p && p !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(p)) if (!k.startsWith('_') && k !== 'constructor' && !/^[A-Z]/.test(k) && k !== 'getItem' && k !== 'setItem' && k !== 'delItem') keys.add(k);
      p = Object.getPrototypeOf(p);
    }
    return [...keys].sort();
  }
  toString() {
    return `<bpy_struct, ${this.__type} at ${this.__path}>`;
  }
  repr() {
    return this.__path || this.toString();
  }
}

/** Wrap a raw field value as a script value (vector, nested struct, ID wrapper, …). */
export function wrapField(owner: Struct, key: string, getRaw: () => Raw | null | undefined): unknown {
  const raw = getRaw();
  if (!raw) return null;
  const v = raw[key];
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    if (key !== 'name' && key !== 'type' && v.includes('_')) {
      const t = findIdTable(v);
      if (t) return idFactory.wrap(t, v);
    }
    return v;
  }
  if (typeof v !== 'object') return v;
  const path = `${owner.__path}.${key}`;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const arr = v as ArrayLike<unknown>;
    const numeric = arr.length > 0 && typeof arr[0] === 'number';
    if (numeric && arr.length >= 2 && arr.length <= 4) return boundVector(subtypeFor(key), () => (getRaw()?.[key] as ArrayLike<number>) ?? [], (i, x) => writeIndex(getRaw, key, i, x), () => orderFor(getRaw()));
    if (numeric && arr.length === 16 && /matrix/.test(key)) return Matrix.fromColumnMajor(arr as ArrayLike<number>);
    return new BoundArray(owner.__type, path, () => getRaw()?.[key] as unknown[] | undefined, key);
  }
  if (Object.getPrototypeOf(v) === Object.prototype) {
    return proxify(new Struct(camel(key), () => getRaw()?.[key] as Raw | undefined, path));
  }
  return v;
}

function writeIndex(getRaw: () => Raw | null | undefined, key: string, i: number, x: number) {
  const raw = getRaw();
  if (!raw) throw pyError('ReferenceError', 'data has been removed');
  const cur = raw[key];
  if (ArrayBuffer.isView(cur)) (cow(raw, key) as unknown as number[])[i] = x;
  else (cur as number[])[i] = x;
  touched();
}

const camel = (k: string) => k.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase());

function subtypeFor(key: string): 'EULER' | 'QUATERNION' | 'COLOR' | 'VECTOR' {
  if (/rotation_euler$/.test(key)) return 'EULER';
  if (/rotation_quaternion$/.test(key)) return 'QUATERNION';
  if (/(^|_)color$/.test(key) || key === 'default_value_color') return 'COLOR';
  return 'VECTOR';
}

function orderFor(raw: Raw | null | undefined): EulerOrder {
  const m = raw?.rotation_mode;
  return typeof m === 'string' && /^[XYZ]{3}$/.test(m) ? (m as EulerOrder) : 'XYZ';
}

/** Vector-like view onto a numeric array in the document. */
export function boundVector(subtype: 'EULER' | 'QUATERNION' | 'COLOR' | 'VECTOR', get: () => ArrayLike<number>, set: (i: number, v: number) => void, order?: () => EulerOrder): VecBase {
  const init = Array.from(get(), Number);
  const v = subtype === 'EULER' ? new Euler(init, order?.() ?? 'XYZ') : subtype === 'QUATERNION' ? new Quaternion(init) : subtype === 'COLOR' ? new Color(init) : new Vector(init);
  const n = init.length;
  const inst = v as unknown as Record<string, unknown>;
  inst.getc = (i: number) => Number(get()[i]);
  inst.setc = (i: number, x: number) => {
    if (!Number.isFinite(x)) throw pyError('TypeError', 'expected a number');
    set(i, x);
  };
  for (let i = 0; i < n; i++)
    Object.defineProperty(v, i, {
      get: () => Number(get()[i]),
      set: (x: number) => (inst.setc as (i: number, x: number) => void)(i, Number(x)),
      enumerable: true,
      configurable: true,
    });
  Object.defineProperty(v, '__bound', { value: true });
  return v;
}

/** Properties scripts declared on struct types (typeprops.ts): looked up after the stored fields. */
export const NOT_DECLARED = Symbol('not declared');
export const structTypeProps: {
  get: (t: Struct, key: string) => unknown;
  set: (t: Struct, key: string, v: unknown) => boolean;
  has: (t: Struct, key: string) => boolean;
} = { get: () => NOT_DECLARED, set: () => false, has: () => false };

/** Proxy a struct so raw document fields are readable/writable as properties. */
export function proxify<T extends Struct>(s: T): T {
  return new Proxy(s, {
    get(t, p, r) {
      if (typeof p === 'symbol' || p in t) return Reflect.get(t, p, r);
      const raw = t.__resolve();
      if (!raw) return undefined;
      if (Object.prototype.hasOwnProperty.call(raw, p) && !t.__hidden().has(p)) return wrapField(t, p, () => t.__resolve());
      const ex = t.__extra();
      if (ex && Object.prototype.hasOwnProperty.call(ex, p)) return wrapField(t, p, () => (t.__resolve() ? t.__extra() : null));
      const declared = structTypeProps.get(t, p);
      return declared === NOT_DECLARED ? undefined : declared;
    },
    set(t, p, v, r) {
      if (typeof p === 'symbol' || p in t) {
        const ok = Reflect.set(t, p, v, r);
        if (!ok) throw pyError('AttributeError', `bpy_struct: attribute "${String(p)}" from "${t.__type}" is read-only`);
        return true;
      }
      const raw = t.__raw;
      if (READONLY.has(p)) throw pyError('AttributeError', `bpy_struct: attribute "${p}" from "${t.__type}" is read-only`);
      if (Object.prototype.hasOwnProperty.call(raw, p) && !t.__hidden().has(p)) {
        assignField(raw, p, v, t.__type);
        touched();
        return true;
      }
      const ex = t.__extra();
      if (ex && Object.prototype.hasOwnProperty.call(ex, p)) {
        assignField(ex, p, v, t.__type);
        touched();
        return true;
      }
      if (structTypeProps.set(t, p, v)) return true;
      throw pyError('AttributeError', `'${t.__type}' object has no attribute '${p}'`);
    },
    has(t, p) {
      if (p in t) return true;
      if (typeof p === 'symbol') return false;
      const raw = t.__resolve();
      return !!raw && ((Object.prototype.hasOwnProperty.call(raw, p) && !t.__hidden().has(p)) || !!(t.__extra() && p in t.__extra()!) || structTypeProps.has(t, p));
    },
  });
}

// ---------------------------------------------------------------------------
// Bound arrays (lists of structs or primitives inside the document)

/**
 * How to make items for lists reached through the generic wrappers, by path shape (indices and
 * keys replaced with `[]`, e.g. `bpy.data.masks[].layers[].splines`): enables new() / add() /
 * remove() / clear() on them.
 */
export const arrayFactories: { match: RegExp; make: (args: unknown[], list: unknown[]) => unknown }[] = [];

export class BoundArray {
  readonly __kind = 'array';
  constructor(
    readonly __type: string,
    readonly __path: string,
    readonly __get: () => unknown[] | undefined,
    readonly __key: string,
  ) {
    return new Proxy(this, {
      get(t, p, r) {
        if (typeof p === 'string' && /^-?\d+$/.test(p)) return t.getItem(Number(p));
        return Reflect.get(t, p, r);
      },
      set(t, p, v, r) {
        if (typeof p === 'string' && /^\d+$/.test(p)) {
          t.setItem(Number(p), v);
          return true;
        }
        return Reflect.set(t, p, v, r);
      },
    });
  }
  private arr() {
    const a = this.__get();
    if (!a) throw pyError('ReferenceError', `${this.__path} has been removed`);
    return a;
  }
  get length() {
    return this.arr().length;
  }
  getItem(i: number | string): unknown {
    const a = this.arr();
    if (typeof i === 'string') {
      const idx = (a as { name?: string }[]).findIndex((x) => x && typeof x === 'object' && x.name === i);
      if (idx < 0) throw pyError('KeyError', `'bpy_prop_collection[key]: key "${i}" not found'`);
      i = idx;
    }
    if (i < 0) i += a.length;
    if (i < 0 || i >= a.length) throw pyError('IndexError', `bpy_prop_array[index]: index ${i} out of range`);
    const idx = i;
    const v = a[idx];
    if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) {
      if (Array.isArray(v)) {
        const getter = () => this.__get()?.[idx] as unknown[] | undefined;
        if (v.length >= 2 && v.length <= 4 && typeof v[0] === 'number')
          return boundVector('VECTOR', () => (getter() as number[]) ?? [], (k, x) => ((getter() as number[])[k] = x, touched()));
        return new BoundArray(this.__type, `${this.__path}[${idx}]`, getter, this.__key);
      }
      const label = (v as { name?: string }).name;
      return proxify(new Struct(camel(this.__key.replace(/s$/, '')), () => this.__get()?.[idx] as Raw | undefined, `${this.__path}[${label ? JSON.stringify(label) : idx}]`));
    }
    if (typeof v === 'string' && v.includes('_')) {
      const t = findIdTable(v);
      if (t) return idFactory.wrap(t, v);
    }
    return v;
  }
  setItem(i: number, v: unknown) {
    const a = this.arr();
    if (i < 0) i += a.length;
    if (i < 0 || i >= a.length) throw pyError('IndexError', `bpy_prop_array[index] = value: index ${i} out of range`);
    const cur = a[i];
    const plain = toPlain(v, cur);
    if (typeof cur === 'boolean') a[i] = !!plain;
    else if (typeof cur === 'number') a[i] = Number(plain);
    else a[i] = plain;
    touched();
  }
  toArray(): unknown[] {
    return Array.from({ length: this.length }, (_, i) => this.getItem(i));
  }
  [Symbol.iterator]() {
    return this.toArray()[Symbol.iterator]();
  }
  /** Python-style helpers */
  keys() {
    return this.arr().map((x, i) => ((x as { name?: string })?.name ?? i));
  }
  values() {
    return this.toArray();
  }
  items() {
    return this.toArray().map((v, i) => [(this.arr()[i] as { name?: string })?.name ?? i, v]);
  }
  find(name: string) {
    return (this.arr() as { name?: string }[]).findIndex((x) => x?.name === name);
  }
  get(key: string | number, def: unknown = null) {
    try {
      return this.getItem(key);
    } catch {
      return def;
    }
  }
  private factory() {
    const shape = this.__path.replace(/\[[^\]]*\]/g, '[]');
    const f = arrayFactories.find((x) => x.match.test(shape));
    if (!f) throw pyError('TypeError', `${this.__path}: items can't be added or removed from scripts here`);
    return f;
  }
  /** Adds an item (lists the app knows how to fill, e.g. mask layers, splines, selection sets). */
  new(...args: unknown[]) {
    const a = this.arr();
    const item = this.factory().make(args, a);
    a.push(item);
    touched();
    return this.getItem(a.length - 1);
  }
  /** Appends `count` default items (points etc.); returns the last one. */
  add(count: unknown = 1) {
    const f = this.factory();
    const a = this.arr();
    const n = typeof count === 'number' ? Math.max(0, Math.round(count)) : 1;
    for (let i = 0; i < n; i++) a.push(f.make(typeof count === 'number' ? [] : [count], a));
    touched();
    return a.length ? this.getItem(a.length - 1) : null;
  }
  remove(item: unknown) {
    this.factory();
    const a = this.arr();
    const raw = item instanceof Struct ? item.__resolve() : typeof item === 'number' ? a[item] : item;
    const i = a.indexOf(raw as never);
    if (i < 0) throw pyError('ValueError', `${this.__path}.remove(): item not found`);
    a.splice(i, 1);
    touched();
  }
  clear() {
    this.factory();
    this.arr().length = 0;
    touched();
  }
  move(from: number, to: number) {
    const a = this.arr();
    const [x] = a.splice(Number(from), 1);
    if (x !== undefined) a.splice(Number(to), 0, x);
    touched();
  }
  toString() {
    return `<bpy_prop_collection ${this.__path}>`;
  }
  repr() {
    return this.__path;
  }
}

// ---------------------------------------------------------------------------
// Collections of wrappers (bpy_prop_collection)

export abstract class PropCollection<T = unknown> {
  readonly __kind = 'collection';
  constructor(readonly __path: string) {
    return new Proxy(this, {
      get(t, p, r) {
        if (typeof p === 'string' && !(p in t)) {
          if (/^-?\d+$/.test(p)) return t.getItem(Number(p));
          return t.get(p, undefined);
        }
        return Reflect.get(t, p, r);
      },
    });
  }
  /** Current items. */
  abstract list(): T[];
  /** Name of an item (for string lookups). */
  abstract nameOf(item: T): string;
  get length() {
    return this.list().length;
  }
  getItem(key: number | string): T {
    const l = this.list();
    if (typeof key === 'number') {
      const i = key < 0 ? key + l.length : key;
      if (i < 0 || i >= l.length) throw pyError('IndexError', `bpy_prop_collection[index]: index ${key} out of range, size ${l.length}`);
      return l[i];
    }
    const it = l.find((x) => this.nameOf(x) === key);
    if (it === undefined) throw pyError('KeyError', `'bpy_prop_collection[key]: key "${key}" not found'`);
    return it;
  }
  get(key: string | number, def: unknown = null): T | unknown {
    try {
      return this.getItem(key);
    } catch {
      return def;
    }
  }
  contains(key: unknown) {
    if (typeof key === 'string') return this.list().some((x) => this.nameOf(x) === key);
    return this.list().some((x) => same(x, key));
  }
  find(name: string, ..._rest: unknown[]): unknown {
    return this.list().findIndex((x) => this.nameOf(x) === name);
  }
  keys(): unknown[] {
    return this.list().map((x) => this.nameOf(x));
  }
  values() {
    return this.list();
  }
  items() {
    return this.list().map((x) => [this.nameOf(x), x]);
  }
  [Symbol.iterator]() {
    return this.list()[Symbol.iterator]();
  }
  toString() {
    return `<bpy_collection[${this.length}], ${this.__path}>`;
  }
  repr() {
    return this.__path;
  }
}

export function same(a: unknown, b: unknown) {
  if (a === b) return true;
  if (isIdWrapper(a) && isIdWrapper(b)) return a.__id === b.__id;
  if (a instanceof Struct && b instanceof Struct) return a.__resolve() === b.__resolve();
  return false;
}

/** Unwrap a script argument expected to be a data-block of `table` (accepts wrappers or names). */
export function expectId(v: unknown, table: string, what: string): string {
  if (isIdWrapper(v) && v.__table === table) return v.__id;
  if (typeof v === 'string') {
    const t = tableOf(app.doc, table);
    const hit = Object.values(t).find((x) => x.name === v);
    if (hit) return hit.id as string;
  }
  throw pyError('TypeError', `expected a ${what}, got ${v === null ? 'None' : typeof v === 'object' ? (v as { __type?: string }).__type ?? 'object' : typeof v}`);
}

// ---------------------------------------------------------------------------
// extension helpers

/**
 * Copies the getters, setters and methods of `source` (a class) onto `target` (a class), so
 * feature files can add members to the wrappers defined in api.ts. Existing members are kept
 * unless `override` is set.
 */
export function mixin(target: { prototype: object }, source: { prototype: object }, override = false) {
  for (const k of Object.getOwnPropertyNames(source.prototype)) {
    if (k === 'constructor') continue;
    if (!override && Object.prototype.hasOwnProperty.call(target.prototype, k)) continue;
    Object.defineProperty(target.prototype, k, Object.getOwnPropertyDescriptor(source.prototype, k)!);
  }
}

/** Steps through a data path (`modifiers["Bevel"].width`, `location[2]`) from a script value. */
export function resolvePath(root: unknown, path: string): unknown {
  const tokens = path.match(/[A-Za-z_][A-Za-z0-9_]*|\[\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+)\s*\]/g) ?? [];
  if (tokens.join('').replace(/\s/g, '') !== path.replace(/\./g, '').replace(/\s/g, '')) throw pyError('ValueError', `Path could not be resolved: "${path}"`);
  let cur: unknown = root;
  for (const t of tokens) {
    if (cur === null || cur === undefined) throw pyError('ValueError', `Path could not be resolved: "${path}"`);
    const o = cur as Record<string, unknown> & { getItem?: (k: unknown) => unknown; get?: (i: number) => unknown };
    if (t.startsWith('[')) {
      const inner = t.slice(1, -1).trim();
      const key: string | number = /^-?\d+$/.test(inner) ? Number(inner) : JSON.parse(inner.startsWith("'") ? `"${inner.slice(1, -1).replace(/"/g, '\\"')}"` : inner);
      if (typeof o.getItem === 'function') cur = o.getItem(key);
      else if (typeof key === 'number' && cur instanceof VecBase) cur = cur.get(key < 0 ? cur.size + key : key);
      else if (Array.isArray(cur) && typeof key === 'number') cur = cur[key < 0 ? cur.length + key : key];
      else throw pyError('ValueError', `Path could not be resolved: "${path}"`);
    } else {
      if (!(t in (o as object))) throw pyError('ValueError', `Path could not be resolved: "${path}" ("${t}" not found)`);
      cur = o[t];
    }
  }
  return cur;
}

/** Set by api_anim.ts: animate `key` of a raw record (used by structs built as plain objects, e.g. node sockets). */
export const structHooks: {
  keyframe?: (raw: object, key: string, index: number, frame: unknown) => boolean;
  driver?: (raw: object, key: string, index: number) => unknown;
} = {};
