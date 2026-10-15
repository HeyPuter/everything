// bmesh for scripts: the editable mesh (verts, edges, faces, loops with full adjacency),
// element sequences and custom-data layers. Shared by JavaScript and Python scripts
// (Python reaches the same objects through the bridge, see py/bmesh.py).
//
// Adjacency: every vertex keeps its edges (disk list), every edge keeps the loops (face
// corners) that use it (radial list) and every face is a ring of loops linked with
// next/prev. Element sets are insertion ordered, so iteration order is creation order.
import { PropCollection, boundVector, pyError, kwMethod } from './rna';
import { Vector, Matrix, VecBase } from './mathutils';

export type Num3 = [number, number, number];
type Errors = Parameters<typeof pyError>[0];
const err = (type: Errors, msg: string) => pyError(type, msg);

let serial = 0;

// ---------------------------------------------------------------------------
// small vector helpers (plain arrays; elements store coordinates as number[3])

export const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Num3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: ArrayLike<number>, b: ArrayLike<number>): Num3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: ArrayLike<number>, s: number): Num3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Num3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: ArrayLike<number>) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const lerp = (a: ArrayLike<number>, b: ArrayLike<number>, t: number): Num3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export function normalize(a: ArrayLike<number>): Num3 {
  const l = len(a);
  return l > 1e-30 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export function angleBetween(a: ArrayLike<number>, b: ArrayLike<number>) {
  const la = len(a),
    lb = len(b);
  if (la < 1e-30 || lb < 1e-30) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb))));
}

/** Newell normal of a polygon given its points (unit length, zero when degenerate). */
export function newell(pts: ArrayLike<number>[]): Num3 {
  let x = 0,
    y = 0,
    z = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i],
      b = pts[(i + 1) % n];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normalize([x, y, z]);
}

/** Script value → 3 numbers (vectors, arrays, typed arrays; 2D values get z = 0). */
export function vec3(v: unknown, what: string): Num3 {
  let a: ArrayLike<unknown> | null = null;
  if (v instanceof VecBase) a = v.toArray();
  else if (Array.isArray(v) || ArrayBuffer.isView(v)) a = v as unknown as ArrayLike<unknown>;
  else if (v && typeof v === 'object' && typeof (v as Iterable<unknown>)[Symbol.iterator] === 'function') a = [...(v as Iterable<unknown>)];
  if (!a || a.length < 2 || a.length > 4) throw err('TypeError', `${what}: expected a sequence of 3 numbers, got ${describe(v)}`);
  const out: Num3 = [Number(a[0]), Number(a[1]), a.length > 2 ? Number(a[2]) : 0];
  if (out.some((x) => !Number.isFinite(x))) throw err('TypeError', `${what}: expected numbers, got ${describe(v)}`);
  return out;
}

/** Script value → n numbers. */
export function vecN(v: unknown, n: number, what: string): number[] {
  const a = v instanceof VecBase ? v.toArray() : Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v as ArrayLike<number>, Number) : v && typeof v === 'object' && Symbol.iterator in (v as object) ? [...(v as Iterable<number>)].map(Number) : null;
  if (!a || a.length !== n || a.some((x) => !Number.isFinite(x))) throw err('TypeError', `${what}: expected a sequence of ${n} numbers, got ${describe(v)}`);
  return a;
}

export function describe(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v !== 'object') return typeof v;
  return (v as { __type?: string }).__type ?? (Array.isArray(v) ? `sequence of ${v.length}` : (v as object).constructor?.name ?? 'object');
}

/** A 4×4 (or 3×3) matrix given as Matrix or nested arrays → 4×4 rows. */
export function mat4(m: unknown, what: string): number[][] {
  let rows: number[][] | null = null;
  if (m instanceof Matrix) rows = m.rows.map((r) => [...r]);
  else if (Array.isArray(m) && m.every((r) => Array.isArray(r) || r instanceof VecBase)) rows = m.map((r) => (r instanceof VecBase ? r.toArray() : (r as number[]).map(Number)));
  if (!rows || !((rows.length === 4 && rows.every((r) => r.length === 4)) || (rows.length === 3 && rows.every((r) => r.length === 3))))
    throw err('TypeError', `${what}: expected a 3x3 or 4x4 matrix, got ${describe(m)}`);
  if (rows.length === 3) return [[...rows[0], 0], [...rows[1], 0], [...rows[2], 0], [0, 0, 0, 1]];
  return rows;
}

export const IDENTITY4 = () => [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

export function mulPoint(m: number[][], p: ArrayLike<number>): Num3 {
  const x = p[0],
    y = p[1],
    z = p[2];
  return [m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3], m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3], m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3]];
}

export function mulMat(a: number[][], b: number[][]): number[][] {
  const out = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) out[i][j] += a[i][k] * b[k][j];
  return out;
}

export function invertMat(m: number[][]): number[][] {
  return new Matrix(m).inverted(new Matrix(IDENTITY4())).rows.map((r) => [...r]);
}

/** Normal transform of a 4×4 matrix (inverse transpose of the upper 3×3). */
export function normalMatrix(m: number[][]): number[][] {
  const inv = invertMat(m);
  return [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i < 3 && j < 3 ? inv[j][i] : i === j ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// custom data layers

export type Domain = 'verts' | 'edges' | 'faces' | 'loops';
export type LayerKind = 'uv' | 'color' | 'deform' | 'shape' | 'float' | 'int' | 'string' | 'float_vector' | 'bool';

const DOMAIN_KINDS: Record<Domain, LayerKind[]> = {
  verts: ['deform', 'shape', 'color', 'float', 'int', 'string', 'float_vector', 'bool'],
  edges: ['float', 'int', 'string', 'float_vector', 'bool'],
  faces: ['float', 'int', 'string', 'float_vector', 'bool'],
  loops: ['uv', 'color', 'float', 'int', 'string', 'float_vector', 'bool'],
};

const DEFAULT_NAMES: Record<LayerKind, string> = { uv: 'UVMap', color: 'Color', deform: '', shape: 'Key', float: 'Float', int: 'Int', string: 'String', float_vector: 'FloatVector', bool: 'Bool' };

export class BMLayerItem {
  readonly __key = `BMLayerItem#${++serial}`;
  /** property key used for `elem[layer]` in JavaScript */
  readonly __prop: string;
  constructor(
    readonly _bm: BMesh,
    readonly _domain: Domain,
    readonly _kind: LayerKind,
    readonly _slot: number,
    public _name: string,
  ) {
    this.__prop = `\u0001layer${serial}`;
    // `elem[layer]` works in JavaScript too: the layer's string form is a property key defined on the element class
    const proto = (_domain === 'verts' ? BMVert : _domain === 'edges' ? BMEdge : _domain === 'faces' ? BMFace : BMLoop).prototype;
    const layer = this;
    Object.defineProperty(proto, this.__prop, {
      get(this: BMElem) {
        return this.getItem(layer);
      },
      set(this: BMElem, v: unknown) {
        this.setItem(layer, v);
      },
      configurable: true,
    });
  }
  get __type() {
    return 'BMLayerItem';
  }
  get name() {
    return this._name;
  }
  set name(v: string) {
    this._name = String(v);
  }
  get is_valid() {
    return this._bm._layerSlots[this._domain][this._slot] === this;
  }
  /** Copy every element's value from another layer of the same kind. */
  copy_from(other: unknown) {
    if (!(other instanceof BMLayerItem) || other._kind !== this._kind || other._domain !== this._domain) throw err('TypeError', 'BMLayerItem.copy_from(): expected a layer of the same type');
    for (const el of this._bm._domainElems(this._domain)) el._cd[this._slot] = cloneValue(el._cd[other._slot]);
  }
  toString() {
    return this._name ? `<BMLayerItem ${this._kind} "${this._name}">` : `<BMLayerItem ${this._kind}>`;
  }
  repr() {
    return this.toString();
  }
  [Symbol.toPrimitive]() {
    return this.__prop;
  }
}

export function cloneValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.slice();
  if (v instanceof Map) return new Map(v);
  return v;
}

/** Value of a layer for an element (created with the default on first access). */
export function layerValue(el: BMElem, layer: BMLayerItem): unknown {
  let v = el._cd[layer._slot];
  if (v === undefined) {
    v = defaultValue(layer, el);
    el._cd[layer._slot] = v;
  }
  return v;
}

function defaultValue(layer: BMLayerItem, el: BMElem): unknown {
  switch (layer._kind) {
    case 'uv':
      return [0, 0, 0, 0, 0]; // u, v, pin, select, select_edge
    case 'color':
      return [1, 1, 1, 1];
    case 'deform':
      return new Map<number, number>();
    case 'shape':
      return el instanceof BMVert ? el._co.slice() : [0, 0, 0];
    case 'float_vector':
      return [0, 0, 0];
    case 'string':
      return '';
    case 'bool':
      return false;
    default:
      return 0;
  }
}

/** Weighted mix of layer values (sources are custom-data arrays with weights summing to ~1). */
export function mixCd(bm: BMesh, domain: Domain, sources: [unknown[], number][]): unknown[] {
  const out: unknown[] = [];
  if (!sources.length) return out;
  if (sources.length === 1) return sources[0][0].map(cloneValue);
  let best = 0;
  for (let i = 1; i < sources.length; i++) if (sources[i][1] > sources[best][1]) best = i;
  for (const layer of bm._layerSlots[domain]) {
    if (!layer) continue;
    const s = layer._slot;
    const vals = sources.map(([cd]) => cd[s]);
    if (vals.every((v) => v === undefined)) continue;
    const k = layer._kind;
    if (k === 'uv' || k === 'color' || k === 'float_vector' || k === 'shape') {
      const n = k === 'uv' ? 2 : k === 'color' ? 4 : 3;
      const base = (vals[best] as number[] | undefined) ?? (k === 'color' ? [1, 1, 1, 1] : k === 'uv' ? [0, 0, 0, 0, 0] : [0, 0, 0]);
      const r = base.slice();
      for (let c = 0; c < n; c++) {
        let acc = 0;
        sources.forEach(([cd, w]) => (acc += ((cd[s] as number[] | undefined)?.[c] ?? (k === 'color' ? 1 : 0)) * w));
        r[c] = acc;
      }
      out[s] = r;
    } else if (k === 'deform') {
      const m = new Map<number, number>();
      sources.forEach(([cd, w]) => (cd[s] as Map<number, number> | undefined)?.forEach((x, g) => m.set(g, (m.get(g) ?? 0) + x * w)));
      out[s] = m;
    } else if (k === 'float') {
      let acc = 0;
      sources.forEach(([cd, w]) => (acc += Number(cd[s] ?? 0) * w));
      out[s] = acc;
    } else out[s] = cloneValue(vals[best]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// elements

export abstract class BMElem {
  readonly __key: string;
  _bm: BMesh | null;
  /** custom data, one entry per layer slot of the element's domain */
  _cd: unknown[] = [];
  index = -1;
  tag = false;
  _sel = false;
  _hide = false;
  constructor(bm: BMesh, prefix: string) {
    this._bm = bm;
    this.__key = `${prefix}#${++serial}`;
  }
  abstract get __type(): string;
  abstract get _domain(): Domain;
  get is_valid() {
    return !!this._bm;
  }
  /** The owning mesh (raises when the element was removed). */
  get _m(): BMesh {
    if (!this._bm) throw err('ReferenceError', `BMesh data of type ${this.__type} has been removed`);
    return this._bm;
  }
  get select() {
    return this._sel;
  }
  set select(v: boolean) {
    this._m;
    this._sel = !!v;
  }
  get hide() {
    return this._hide;
  }
  set hide(v: boolean) {
    this._m;
    this._hide = !!v;
  }
  /** `elem[layer]` (Python) / `elem.getItem(layer)`. */
  getItem(layer: unknown): unknown {
    const bm = this._m;
    const l = this._layer(layer, bm);
    const v = layerValue(this, l);
    switch (l._kind) {
      case 'uv':
        return new BMLoopUV(this as unknown as BMLoop, l);
      case 'color':
        return boundVector('VECTOR', () => layerValue(this, l) as number[], (i, x) => ((layerValue(this, l) as number[])[i] = x));
      case 'shape':
      case 'float_vector':
        return boundVector('VECTOR', () => layerValue(this, l) as number[], (i, x) => ((layerValue(this, l) as number[])[i] = x));
      case 'deform':
        return new BMDeformVert(this as unknown as BMVert, l);
      default:
        return v;
    }
  }
  setItem(layer: unknown, value: unknown) {
    const bm = this._m;
    const l = this._layer(layer, bm);
    switch (l._kind) {
      case 'uv':
        throw err('AttributeError', 'BMLoop[uv_layer] is read-only: set its .uv instead');
      case 'color':
        this._cd[l._slot] = vecN(value, 4, 'color layer value');
        return;
      case 'shape':
      case 'float_vector':
        this._cd[l._slot] = vec3(value, `${l._kind} layer value`);
        return;
      case 'deform': {
        const m = new Map<number, number>();
        if (value instanceof BMDeformVert) value._map().forEach((w, g) => m.set(g, w));
        else if (value && typeof value === 'object') for (const [g, w] of value instanceof Map ? value : Object.entries(value)) m.set(Number(g), Number(w));
        this._cd[l._slot] = m;
        return;
      }
      case 'int':
        if (typeof value !== 'number' && typeof value !== 'boolean') throw err('TypeError', `int layer: expected a number, got ${describe(value)}`);
        this._cd[l._slot] = Math.trunc(Number(value));
        return;
      case 'float':
        if (typeof value !== 'number' && typeof value !== 'boolean') throw err('TypeError', `float layer: expected a number, got ${describe(value)}`);
        this._cd[l._slot] = Number(value);
        return;
      case 'bool':
        this._cd[l._slot] = !!value;
        return;
      case 'string':
        this._cd[l._slot] = String(value);
        return;
    }
  }
  _layer(layer: unknown, bm: BMesh): BMLayerItem {
    if (!(layer instanceof BMLayerItem)) throw err('KeyError', `${this.__type}[key]: expected a BMLayerItem from bm.${this._domain}.layers, got ${describe(layer)}`);
    if (layer._bm !== bm) throw err('ValueError', `${this.__type}[layer]: the layer belongs to another BMesh`);
    if (layer._domain !== this._domain) throw err('KeyError', `${this.__type}[layer]: the layer is a ${layer._domain} layer`);
    if (!layer.is_valid) throw err('ReferenceError', 'BMLayerItem has been removed');
    return layer;
  }
  repr() {
    return this.toString();
  }
}

export class BMVert extends BMElem {
  _co: number[];
  _no: number[] = [0, 0, 0];
  /** edges using this vertex (disk list) */
  _e: BMEdge[] = [];
  constructor(bm: BMesh, co: ArrayLike<number>) {
    super(bm, 'BMVert');
    this._co = [co[0], co[1], co[2]];
  }
  get __type() {
    return 'BMVert';
  }
  get _domain(): Domain {
    return 'verts';
  }
  get co(): Vector {
    this._m;
    return boundVector('VECTOR', () => this._co, (i, x) => (this._co[i] = x)) as Vector;
  }
  set co(v: unknown) {
    this._m;
    const a = vec3(v, 'BMVert.co');
    this._co[0] = a[0];
    this._co[1] = a[1];
    this._co[2] = a[2];
  }
  get normal(): Vector {
    this._m;
    return boundVector('VECTOR', () => this._no, (i, x) => (this._no[i] = x)) as Vector;
  }
  set normal(v: unknown) {
    this._no = vec3(v, 'BMVert.normal');
  }
  get link_edges(): BMEdge[] {
    this._m;
    return this._e.slice();
  }
  get link_loops(): BMLoop[] {
    this._m;
    return vertLoops(this);
  }
  get link_faces(): BMFace[] {
    this._m;
    return vertLoops(this).map((l) => l.face);
  }
  get is_boundary() {
    return this._e.some((e) => e._l.length === 1);
  }
  get is_wire() {
    return this._e.length > 0 && this._e.every((e) => e._l.length === 0);
  }
  get is_manifold() {
    if (!this._e.length || this._e.some((e) => e._l.length === 0 || e._l.length > 2)) return false;
    // one fan of faces around the vertex
    const loops = vertLoops(this);
    if (!loops.length) return false;
    const seen = new Set<BMLoop>([loops[0]]);
    const stack = [loops[0]];
    while (stack.length) {
      const l = stack.pop()!;
      for (const e of [l.edge, l._prev.edge]) for (const o of e._l) {
        const c = o.vert === this ? o : o._next.vert === this ? o._next : null;
        if (c && !seen.has(c)) {
          seen.add(c);
          stack.push(c);
        }
      }
    }
    return seen.size === loops.length;
  }
  /** Angle between the two edges of this vertex (0 when straight). */
  calc_edge_angle(fallback?: number) {
    if (this._e.length !== 2) {
      if (fallback !== undefined && fallback !== null) return fallback;
      throw err('ValueError', 'BMVert.calc_edge_angle(): vert must connect to exactly 2 edges');
    }
    const a = this._e[0].other(this)._co,
      b = this._e[1].other(this)._co;
    return Math.PI - angleBetween(sub(a, this._co), sub(b, this._co));
  }
  /** Scale factor that keeps a uniform shell thickness when offsetting along the normal. */
  calc_shell_factor() {
    const no = vertNormal(this);
    let acc = 0,
      tot = 0;
    for (const l of vertLoops(this)) {
      const fn = faceNormal(l.face);
      const ang = loopAngle(l);
      const c = Math.abs(dot(no, fn));
      acc += (c > 1e-6 ? 1 / c : 1) * ang;
      tot += ang;
    }
    return tot > 0 ? acc / tot : 1;
  }
  copy_from(other: unknown) {
    if (!(other instanceof BMVert)) throw err('TypeError', `BMVert.copy_from(): expected a BMVert, got ${describe(other)}`);
    if (other === this) return;
    this._co = other._co.slice();
    this._no = other._no.slice();
    copyAttrs(this, other);
  }
  /** Interpolate custom data from vertices with weights. */
  copy_from_vert_interp(verts: unknown, fac: unknown) {
    const vs = elems(verts, BMVert, 'copy_from_vert_interp');
    const ws = Array.from(vecN(fac, vs.length, 'copy_from_vert_interp(): weights'));
    this._cd = mixCd(this._m, 'verts', vs.map((v, i) => [v._cd, ws[i]]));
  }
  /** Interpolate custom data from the vertices of a face at this vertex's position. */
  copy_from_face_interp(face: unknown) {
    if (!(face instanceof BMFace)) throw err('TypeError', 'copy_from_face_interp(): expected a BMFace');
    const ls = faceLoops(face);
    const w = polyWeights(ls.map((l) => l.vert._co), this._co, faceNormal(face));
    this._cd = mixCd(this._m, 'verts', ls.map((l, i) => [l.vert._cd, w[i]]));
  }
  select_set(select: boolean) {
    this._m;
    this._sel = !!select;
    if (!select) {
      for (const e of this._e) e._sel = false;
      for (const l of vertLoops(this)) l.face._sel = false;
    }
  }
  hide_set(hide: boolean) {
    this._m;
    this._hide = !!hide;
    if (hide) {
      this._sel = false;
      for (const e of this._e) (e._hide = true), (e._sel = false);
      for (const l of vertLoops(this)) (l.face._hide = true), (l.face._sel = false);
    } else {
      for (const e of this._e) if (!e.other(this)._hide) e._hide = false;
      for (const l of vertLoops(this)) if (faceLoops(l.face).every((x) => !x.vert._hide)) l.face._hide = false;
    }
  }
  normal_update() {
    this._no = vertNormal(this);
  }
  toString() {
    return this._bm ? `<BMVert(index=${this.index}, co=(${this._co.map((x) => fmt(x)).join(', ')}))>` : '<BMVert dead>';
  }
}

export class BMEdge extends BMElem {
  /** loops (face corners) along this edge (radial list) */
  _l: BMLoop[] = [];
  seam = false;
  smooth = true;
  /** subdivision crease weight (kept through from_mesh / to_mesh) */
  _crease = 0;
  constructor(
    bm: BMesh,
    public v1: BMVert,
    public v2: BMVert,
  ) {
    super(bm, 'BMEdge');
  }
  get __type() {
    return 'BMEdge';
  }
  get _domain(): Domain {
    return 'edges';
  }
  other(v: BMVert): BMVert {
    return v === this.v1 ? this.v2 : this.v1;
  }
  get verts(): BMVert[] {
    this._m;
    return [this.v1, this.v2];
  }
  other_vert(v: unknown) {
    this._m;
    if (!(v instanceof BMVert)) throw err('TypeError', `BMEdge.other_vert(): expected a BMVert, got ${describe(v)}`);
    return v === this.v1 ? this.v2 : v === this.v2 ? this.v1 : null;
  }
  get link_faces(): BMFace[] {
    this._m;
    return this._l.map((l) => l.face);
  }
  get link_loops(): BMLoop[] {
    this._m;
    return this._l.slice();
  }
  get is_boundary() {
    return this._l.length === 1;
  }
  get is_manifold() {
    return this._l.length === 2;
  }
  get is_wire() {
    return this._l.length === 0;
  }
  get is_contiguous() {
    return this._l.length === 2 && this._l[0].vert !== this._l[1].vert;
  }
  get is_convex() {
    if (this._l.length !== 2) return true;
    const l = this._l[0];
    const n1 = faceNormal(l.face),
      n2 = faceNormal(this._l[1].face);
    return dot(cross(n1, n2), sub(l._next.vert._co, l.vert._co)) >= -1e-9;
  }
  calc_length() {
    return dist(this.v1._co, this.v2._co);
  }
  calc_face_angle(fallback?: number) {
    if (this._l.length !== 2) {
      if (fallback !== undefined && fallback !== null) return fallback;
      throw err('ValueError', 'BMEdge.calc_face_angle(): edge must be manifold');
    }
    return angleBetween(faceNormal(this._l[0].face), faceNormal(this._l[1].face));
  }
  calc_face_angle_signed(fallback?: number) {
    if (this._l.length !== 2) {
      if (fallback !== undefined && fallback !== null) return fallback;
      throw err('ValueError', 'BMEdge.calc_face_angle_signed(): edge must be manifold');
    }
    const a = this.calc_face_angle();
    return this.is_convex ? a : -a;
  }
  /** Direction perpendicular to the edge, in the plane of the loop's face, pointing into the face. */
  calc_tangent(loop: unknown): Vector {
    if (!(loop instanceof BMLoop) || loop.edge !== this) throw err('ValueError', 'BMEdge.calc_tangent(): expected a loop of this edge');
    return new Vector(normalize(cross(faceNormal(loop.face), sub(loop._next.vert._co, loop.vert._co))));
  }
  select_set(select: boolean) {
    this._m;
    this._sel = !!select;
    this.v1._sel = !!select;
    this.v2._sel = !!select;
    if (!select) for (const l of this._l) l.face._sel = false;
  }
  hide_set(hide: boolean) {
    this._m;
    this._hide = !!hide;
    if (hide) {
      this._sel = false;
      for (const l of this._l) (l.face._hide = true), (l.face._sel = false);
    }
  }
  normal_update() {
    this.v1.normal_update();
    this.v2.normal_update();
  }
  copy_from(other: unknown) {
    if (!(other instanceof BMEdge)) throw err('TypeError', `BMEdge.copy_from(): expected a BMEdge, got ${describe(other)}`);
    copyAttrs(this, other);
  }
  toString() {
    return this._bm ? `<BMEdge(index=${this.index}, verts=(${this.v1.index}, ${this.v2.index}))>` : '<BMEdge dead>';
  }
}

export class BMFace extends BMElem {
  _first!: BMLoop;
  _len = 0;
  _no: number[] = [0, 0, 0];
  material_index = 0;
  smooth = false;
  constructor(bm: BMesh) {
    super(bm, 'BMFace');
  }
  get __type() {
    return 'BMFace';
  }
  get _domain(): Domain {
    return 'faces';
  }
  get loops(): BMLoop[] {
    this._m;
    return faceLoops(this);
  }
  get verts(): BMVert[] {
    this._m;
    return faceLoops(this).map((l) => l.vert);
  }
  get edges(): BMEdge[] {
    this._m;
    return faceLoops(this).map((l) => l.edge);
  }
  get normal(): Vector {
    this._m;
    return boundVector('VECTOR', () => this._no, (i, x) => (this._no[i] = x)) as Vector;
  }
  set normal(v: unknown) {
    this._no = vec3(v, 'BMFace.normal');
  }
  calc_area() {
    const pts = faceLoops(this).map((l) => l.vert._co);
    let x = 0,
      y = 0,
      z = 0;
    for (let i = 1; i + 1 < pts.length; i++) {
      const c = cross(sub(pts[i], pts[0]), sub(pts[i + 1], pts[0]));
      x += c[0];
      y += c[1];
      z += c[2];
    }
    return Math.hypot(x, y, z) / 2;
  }
  calc_perimeter() {
    return faceLoops(this).reduce((s, l) => s + dist(l.vert._co, l._next.vert._co), 0);
  }
  calc_center_median(): Vector {
    return new Vector(faceCenter(this));
  }
  /** Center weighted by the length of the edges at each corner. */
  calc_center_median_weighted(): Vector {
    const ls = faceLoops(this);
    const c: Num3 = [0, 0, 0];
    let tot = 0;
    for (const l of ls) {
      const w = dist(l._prev.vert._co, l.vert._co) + dist(l.vert._co, l._next.vert._co);
      for (let k = 0; k < 3; k++) c[k] += l.vert._co[k] * w;
      tot += w;
    }
    return tot > 0 ? new Vector(scale(c, 1 / tot)) : this.calc_center_median();
  }
  calc_center_bounds(): Vector {
    const ls = faceLoops(this);
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (const l of ls) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], l.vert._co[k])), (hi[k] = Math.max(hi[k], l.vert._co[k]));
    return new Vector([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]);
  }
  /** Direction of the longest edge. */
  calc_tangent_edge(): Vector {
    let best: Num3 = [0, 0, 0],
      bl = -1;
    for (const l of faceLoops(this)) {
      const d = sub(l._next.vert._co, l.vert._co);
      if (len(d) > bl) (bl = len(d)), (best = d);
    }
    return new Vector(normalize(best));
  }
  /** Direction across the two longest opposite edges. */
  calc_tangent_edge_pair(): Vector {
    const ls = faceLoops(this);
    if (ls.length !== 4) return this.calc_tangent_edge();
    const e = (i: number) => sub(ls[(i + 1) % 4].vert._co, ls[i].vert._co);
    const a = add(e(0), scale(e(2), -1)),
      b = add(e(1), scale(e(3), -1));
    return new Vector(normalize(len(a) >= len(b) ? a : b));
  }
  /** Direction of the longest diagonal (from an edge midpoint to the opposite vertex for triangles). */
  calc_tangent_edge_diagonal(): Vector {
    return this.calc_tangent_vert_diagonal();
  }
  calc_tangent_vert_diagonal(): Vector {
    const ls = faceLoops(this);
    let best: Num3 = [0, 0, 0],
      bl = -1;
    for (let i = 0; i < ls.length; i++)
      for (let j = i + 1; j < ls.length; j++) {
        const d = sub(ls[j].vert._co, ls[i].vert._co);
        if (len(d) > bl) (bl = len(d)), (best = d);
      }
    return new Vector(normalize(best));
  }
  normal_update() {
    this._no = faceNormal(this);
  }
  /** Reverse the winding (and the normal). */
  normal_flip() {
    flipFace(this);
  }
  /** Duplicate this face (with new vertices / edges unless told to reuse them). */
  copy(verts = true, edges = true): BMFace {
    const bm = this._m;
    const ls = faceLoops(this);
    const vs = verts ? ls.map((l) => makeVert(bm, l.vert._co, l.vert)) : ls.map((l) => l.vert);
    const es = ls.map((l, i) => (edges || verts ? makeEdge(bm, vs[i], vs[(i + 1) % vs.length], l.edge) : l.edge));
    return makeFace(bm, vs, { example: this, edges: es, loops: ls });
  }
  copy_from(other: unknown) {
    if (!(other instanceof BMFace)) throw err('TypeError', `BMFace.copy_from(): expected a BMFace, got ${describe(other)}`);
    copyAttrs(this, other);
  }
  copy_from_face_interp(face: unknown, vert = true) {
    if (!(face instanceof BMFace)) throw err('TypeError', 'copy_from_face_interp(): expected a BMFace');
    for (const l of faceLoops(this)) l.copy_from_face_interp(face, vert);
  }
  select_set(select: boolean) {
    this._m;
    this._sel = !!select;
    for (const l of faceLoops(this)) {
      l.vert._sel = !!select;
      l.edge._sel = !!select;
    }
  }
  hide_set(hide: boolean) {
    this._m;
    this._hide = !!hide;
    if (hide) this._sel = false;
    for (const l of faceLoops(this)) {
      if (hide) {
        // edges / verts only hide when no visible face uses them
        if (l.edge._l.every((o) => o.face._hide)) (l.edge._hide = true), (l.edge._sel = false);
        if (vertLoops(l.vert).every((o) => o.face._hide)) (l.vert._hide = true), (l.vert._sel = false);
      } else {
        l.edge._hide = false;
        l.vert._hide = false;
      }
    }
  }
  toString() {
    return this._bm ? `<BMFace(index=${this.index}, totverts=${this._len})>` : '<BMFace dead>';
  }
}

export class BMLoop extends BMElem {
  _next!: BMLoop;
  _prev!: BMLoop;
  constructor(
    bm: BMesh,
    public vert: BMVert,
    public edge: BMEdge,
    public face: BMFace,
  ) {
    super(bm, 'BMLoop');
  }
  get __type() {
    return 'BMLoop';
  }
  get _domain(): Domain {
    return 'loops';
  }
  get link_loop_next() {
    return this._next;
  }
  get link_loop_prev() {
    return this._prev;
  }
  get link_loop_radial_next() {
    const r = this.edge._l;
    return r[(r.indexOf(this) + 1) % r.length];
  }
  get link_loop_radial_prev() {
    const r = this.edge._l;
    return r[(r.indexOf(this) - 1 + r.length) % r.length];
  }
  /** Other loops (face corners) of the same vertex. */
  get link_loops(): BMLoop[] {
    return vertLoops(this.vert).filter((l) => l !== this);
  }
  calc_angle() {
    return loopAngle(this);
  }
  calc_normal(): Vector {
    const n = cross(sub(this._prev.vert._co, this.vert._co), sub(this._next.vert._co, this.vert._co));
    return new Vector(len(n) > 1e-12 ? normalize(n) : faceNormal(this.face));
  }
  calc_tangent(): Vector {
    const a = normalize(sub(this._prev.vert._co, this.vert._co)),
      b = normalize(sub(this._next.vert._co, this.vert._co));
    const t = add(a, b);
    if (len(t) < 1e-9) return new Vector(normalize(cross(faceNormal(this.face), b)));
    return new Vector(normalize(this.is_convex ? t : scale(t, -1)));
  }
  get is_convex() {
    const n = cross(sub(this.vert._co, this._prev.vert._co), sub(this._next.vert._co, this.vert._co));
    return dot(n, faceNormal(this.face)) >= 0;
  }
  copy_from(other: unknown) {
    if (!(other instanceof BMLoop)) throw err('TypeError', `BMLoop.copy_from(): expected a BMLoop, got ${describe(other)}`);
    copyAttrs(this, other);
  }
  /** Interpolate this corner's data (and its vertex's, with vert=True) from a face. */
  copy_from_face_interp(face: unknown, vert = true) {
    if (!(face instanceof BMFace)) throw err('TypeError', 'copy_from_face_interp(): expected a BMFace');
    const ls = faceLoops(face);
    const w = polyWeights(
      ls.map((l) => l.vert._co),
      this.vert._co,
      faceNormal(face),
    );
    const bm = this._m;
    this._cd = mixCd(bm, 'loops', ls.map((l, i) => [l._cd, w[i]]));
    if (vert) this.vert._cd = mixCd(bm, 'verts', ls.map((l, i) => [l.vert._cd, w[i]]));
  }
  toString() {
    return this._bm ? `<BMLoop(index=${this.index}, vert=${this.vert.index}, edge=${this.edge.index}, face=${this.face.index})>` : '<BMLoop dead>';
  }
}

const fmt = (x: number) => (Math.abs(x) < 5e-5 ? '0' : Number(x.toFixed(4)).toString());

function copyAttrs(dst: BMElem, src: BMElem) {
  dst._cd = src._cd.map(cloneValue);
  dst._sel = src._sel;
  dst._hide = src._hide;
  if (dst instanceof BMEdge && src instanceof BMEdge) {
    dst.seam = src.seam;
    dst.smooth = src.smooth;
    dst._crease = src._crease;
  }
  if (dst instanceof BMFace && src instanceof BMFace) {
    dst.material_index = src.material_index;
    dst.smooth = src.smooth;
  }
}

/** UV value of a loop: `.uv` (live), `.pin_uv`, `.select`, `.select_edge`. */
export class BMLoopUV {
  constructor(
    readonly _loop: BMLoop,
    readonly _layer: BMLayerItem,
  ) {}
  get __type() {
    return 'BMLoopUV';
  }
  private get d() {
    return layerValue(this._loop, this._layer) as number[];
  }
  get uv(): Vector {
    return boundVector('VECTOR', () => this.d.slice(0, 2), (i, x) => (this.d[i] = x)) as Vector;
  }
  set uv(v: unknown) {
    const a = vecN(v, 2, 'BMLoopUV.uv');
    this.d[0] = a[0];
    this.d[1] = a[1];
  }
  get pin_uv() {
    return !!this.d[2];
  }
  set pin_uv(v: boolean) {
    this.d[2] = v ? 1 : 0;
  }
  get select() {
    return !!this.d[3];
  }
  set select(v: boolean) {
    this.d[3] = v ? 1 : 0;
  }
  get select_edge() {
    return !!this.d[4];
  }
  set select_edge(v: boolean) {
    this.d[4] = v ? 1 : 0;
  }
  toString() {
    const d = this.d;
    return `<BMLoopUV(uv=(${fmt(d[0])}, ${fmt(d[1])}), pin_uv=${!!d[2]})>`;
  }
  repr() {
    return this.toString();
  }
}

/** Vertex-group weights of a vertex: a dict of group index → weight. */
export class BMDeformVert {
  readonly _bmpy = 'deform';
  constructor(
    readonly _vert: BMVert,
    readonly _layer: BMLayerItem,
  ) {}
  get __type() {
    return 'BMDeformVert';
  }
  _map() {
    return layerValue(this._vert, this._layer) as Map<number, number>;
  }
  private group(k: unknown) {
    const g = Number(k);
    if (!Number.isInteger(g) || g < 0) throw err('TypeError', `BMDeformVert[key]: expected a vertex group index (int >= 0), got ${describe(k)}`);
    return g;
  }
  getItem(k: unknown) {
    const m = this._map();
    const g = this.group(k);
    if (!m.has(g)) throw err('KeyError', `BMDeformVert[key] = x: key ${g} not found`);
    return m.get(g)!;
  }
  setItem(k: unknown, w: unknown) {
    if (typeof w !== 'number') throw err('TypeError', `BMDeformVert[key] = x: expected a float, got ${describe(w)}`);
    this._map().set(this.group(k), Math.max(0, Math.min(1, w)));
  }
  delItem(k: unknown) {
    const m = this._map();
    const g = this.group(k);
    if (!m.has(g)) throw err('KeyError', `del BMDeformVert[key]: key ${g} not found`);
    m.delete(g);
  }
  contains(k: unknown) {
    return this._map().has(Number(k));
  }
  get length() {
    return this._map().size;
  }
  keys() {
    return [...this._map().keys()].sort((a, b) => a - b);
  }
  values() {
    return this.keys().map((k) => this._map().get(k)!);
  }
  items() {
    return this.keys().map((k) => [k, this._map().get(k)!]);
  }
  get(k: unknown, fallback: unknown = null) {
    const m = this._map();
    return m.has(Number(k)) ? m.get(Number(k)) : fallback;
  }
  clear() {
    this._map().clear();
  }
  [Symbol.iterator]() {
    return this.keys()[Symbol.iterator]();
  }
  toString() {
    return `<BMDeformVert {${this.items()
      .map(([k, w]) => `${k}: ${fmt(w)}`)
      .join(', ')}}>`;
  }
  repr() {
    return this.toString();
  }
}

// ---------------------------------------------------------------------------
// topology queries

export function faceLoops(f: BMFace): BMLoop[] {
  const out: BMLoop[] = new Array(f._len);
  let l = f._first;
  for (let i = 0; i < f._len; i++, l = l._next) out[i] = l;
  return out;
}

export const faceVerts = (f: BMFace) => faceLoops(f).map((l) => l.vert);

export function vertLoops(v: BMVert): BMLoop[] {
  const out: BMLoop[] = [];
  for (const e of v._e) for (const l of e._l) if (l.vert === v) out.push(l);
  return out;
}

export function vertFaces(v: BMVert): BMFace[] {
  return vertLoops(v).map((l) => l.face);
}

export function edgeBetween(a: BMVert, b: BMVert): BMEdge | null {
  const [s, o] = a._e.length <= b._e.length ? [a, b] : [b, a];
  for (const e of s._e) if (e.v1 === o || e.v2 === o) return e;
  return null;
}

/** A face using exactly these vertices (any order / rotation). */
export function findFace(verts: BMVert[]): BMFace | null {
  if (verts.length < 3) return null;
  const set = new Set(verts);
  for (const l of vertLoops(verts[0])) {
    const f = l.face;
    if (f._len !== verts.length) continue;
    if (faceLoops(f).every((x) => set.has(x.vert))) return f;
  }
  return null;
}

export function faceNormal(f: BMFace): Num3 {
  return newell(faceLoops(f).map((l) => l.vert._co));
}

export function faceCenter(f: BMFace): Num3 {
  const c: Num3 = [0, 0, 0];
  let l = f._first;
  for (let i = 0; i < f._len; i++, l = l._next) for (let k = 0; k < 3; k++) c[k] += l.vert._co[k];
  return scale(c, 1 / Math.max(1, f._len));
}

export function loopAngle(l: BMLoop) {
  return angleBetween(sub(l._prev.vert._co, l.vert._co), sub(l._next.vert._co, l.vert._co));
}

/** Angle-weighted vertex normal from the current face normals (falls back to the position for wire / loose verts). */
export function vertNormal(v: BMVert): Num3 {
  const n: Num3 = [0, 0, 0];
  for (const l of vertLoops(v)) {
    const fn = faceNormal(l.face);
    const w = loopAngle(l);
    for (let k = 0; k < 3; k++) n[k] += fn[k] * w;
  }
  const r = normalize(n);
  if (len(r) > 0) return r;
  return normalize(v._co);
}

/** Interpolation weights of a point inside a polygon (mean value coordinates in the polygon plane). */
export function polyWeights(pts: ArrayLike<number>[], p: ArrayLike<number>, normal: ArrayLike<number>): number[] {
  const n = pts.length;
  const w = new Array(n).fill(0);
  if (!n) return w;
  for (let i = 0; i < n; i++) if (dist(pts[i], p) < 1e-9) return (w[i] = 1), w;
  // project to the plane's dominant axes
  const ax = Math.abs(normal[0]),
    ay = Math.abs(normal[1]),
    az = Math.abs(normal[2]);
  const [u, v] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
  const d = pts.map((q) => [q[u] - p[u], q[v] - p[v]]);
  const r = d.map((x) => Math.hypot(x[0], x[1]));
  const tanHalf = (i: number) => {
    const a = d[i],
      b = d[(i + 1) % n];
    const crs = a[0] * b[1] - a[1] * b[0],
      dt = a[0] * b[0] + a[1] * b[1];
    const ang = Math.atan2(Math.abs(crs), dt);
    return Math.tan(ang / 2);
  };
  let tot = 0;
  for (let i = 0; i < n; i++) {
    if (r[i] < 1e-12) continue;
    const x = (tanHalf((i - 1 + n) % n) + tanHalf(i)) / r[i];
    w[i] = Number.isFinite(x) ? x : 0;
    tot += w[i];
  }
  if (!(tot > 1e-12)) {
    // on an edge or degenerate: inverse distance
    tot = 0;
    for (let i = 0; i < n; i++) (w[i] = 1 / Math.max(1e-12, dist(pts[i], p))), (tot += w[i]);
  }
  return w.map((x) => x / tot);
}

// ---------------------------------------------------------------------------
// construction / destruction kernel

export function makeVert(bm: BMesh, co: ArrayLike<number>, example?: BMVert | null): BMVert {
  const v = new BMVert(bm, co);
  if (example) {
    v._cd = example._cd.map(cloneValue);
    v._no = example._no.slice();
    v._sel = example._sel;
    v._hide = example._hide;
  }
  bm._v.add(v);
  bm._vt = null;
  return v;
}

export function makeEdge(bm: BMesh, a: BMVert, b: BMVert, example?: BMEdge | null): BMEdge {
  const e = new BMEdge(bm, a, b);
  a._e.push(e);
  b._e.push(e);
  if (example) copyAttrs(e, example);
  bm._e.add(e);
  bm._et = null;
  return e;
}

/** Get the edge between a and b or make one. */
export function ensureEdge(bm: BMesh, a: BMVert, b: BMVert, example?: BMEdge | null): BMEdge {
  return edgeBetween(a, b) ?? makeEdge(bm, a, b, example);
}

export interface FaceOpts {
  example?: BMFace | null;
  /** edges to use (or examples for created ones), one per corner: corner i → i+1 */
  edges?: (BMEdge | null | undefined)[];
  /** example loops (their custom data is copied), one per corner */
  loops?: (BMLoop | null | undefined)[];
  /** custom data per corner (takes precedence over `loops`) */
  loopData?: (unknown[] | null | undefined)[];
}

/** Make a face over existing vertices; missing edges are created. No duplicate check. */
export function makeFace(bm: BMesh, verts: BMVert[], o: FaceOpts = {}): BMFace {
  const n = verts.length;
  const f = new BMFace(bm);
  if (o.example) copyAttrs(f, o.example);
  let prev: BMLoop | null = null;
  for (let i = 0; i < n; i++) {
    const a = verts[i],
      b = verts[(i + 1) % n];
    const given = o.edges?.[i];
    const e = given && given._bm && ((given.v1 === a && given.v2 === b) || (given.v1 === b && given.v2 === a)) ? given : ensureEdge(bm, a, b, given ?? null);
    const l = new BMLoop(bm, a, e, f);
    const data = o.loopData?.[i];
    const src = o.loops?.[i];
    if (data) l._cd = data.map(cloneValue);
    else if (src) l._cd = src._cd.map(cloneValue);
    e._l.push(l);
    if (prev) {
      prev._next = l;
      l._prev = prev;
    } else f._first = l;
    prev = l;
  }
  if (prev) {
    prev._next = f._first;
    f._first._prev = prev;
  }
  f._len = n;
  f._no = faceNormal(f);
  bm._f.add(f);
  bm._ft = null;
  bm._nloops += n;
  return f;
}

export function killFace(f: BMFace) {
  const bm = f._bm;
  if (!bm) return;
  for (const l of faceLoops(f)) {
    const r = l.edge._l;
    const i = r.indexOf(l);
    if (i >= 0) r.splice(i, 1);
    l._bm = null;
  }
  bm._nloops -= f._len;
  bm._f.delete(f);
  bm._ft = null;
  if (bm._active === f) bm._active = null;
  f._bm = null;
}

export function killEdge(e: BMEdge) {
  const bm = e._bm;
  if (!bm) return;
  for (const l of e._l.slice()) killFace(l.face);
  for (const v of [e.v1, e.v2]) {
    const i = v._e.indexOf(e);
    if (i >= 0) v._e.splice(i, 1);
  }
  bm._e.delete(e);
  bm._et = null;
  e._bm = null;
}

export function killVert(v: BMVert) {
  const bm = v._bm;
  if (!bm) return;
  for (const e of v._e.slice()) killEdge(e);
  bm._v.delete(v);
  bm._vt = null;
  v._bm = null;
}

/** Reverse a face's winding in place (corner data stays with its vertex). */
export function flipFace(f: BMFace) {
  const ls = faceLoops(f);
  const n = ls.length;
  const es = ls.map((l) => l.edge);
  for (const l of ls) {
    const r = l.edge._l;
    r.splice(r.indexOf(l), 1);
  }
  for (let i = 0; i < n; i++) {
    const l = ls[i];
    l.edge = es[(i - 1 + n) % n];
    l.edge._l.push(l);
  }
  for (const l of ls) {
    const t = l._next;
    l._next = l._prev;
    l._prev = t;
  }
  f._no = [-f._no[0], -f._no[1], -f._no[2]];
}

/**
 * Split an edge at `t` (0..1 measured from `from`): returns the new vertex and the new edge
 * (from the new vertex to the far end). Faces using the edge get the vertex inserted.
 */
export function splitEdge(bm: BMesh, e: BMEdge, from: BMVert, t: number): [BMVert, BMEdge] {
  const a = from,
    b = e.other(from);
  const nv = makeVert(bm, lerp(a._co, b._co, t));
  nv._cd = mixCd(bm, 'verts', [
    [a._cd, 1 - t],
    [b._cd, t],
  ]);
  nv._sel = a._sel && b._sel;
  nv._hide = a._hide && b._hide;
  nv._no = normalize(lerp(a._no, b._no, t));
  // e: a—nv, e2: nv—b
  const e2 = new BMEdge(bm, nv, b);
  copyAttrs(e2, e);
  if (e.v1 === a) e.v2 = nv;
  else e.v1 = nv;
  b._e.splice(b._e.indexOf(e), 1, e2);
  nv._e.push(e, e2);
  bm._e.add(e2);
  bm._et = null;
  for (const l of e._l.slice()) {
    const f = l.face;
    const nl = new BMLoop(bm, nv, e, f);
    const next = l._next;
    if (l.vert === a) {
      // a → nv (e), nv → b (e2)
      nl.edge = e2;
      e2._l.push(nl);
      nl._cd = mixCd(bm, 'loops', [
        [l._cd, 1 - t],
        [next._cd, t],
      ]);
    } else {
      // b → nv (e2), nv → a (e)
      const r = e._l;
      r.splice(r.indexOf(l), 1);
      l.edge = e2;
      e2._l.push(l);
      e._l.push(nl);
      nl._cd = mixCd(bm, 'loops', [
        [l._cd, t],
        [next._cd, 1 - t],
      ]);
    }
    l._next = nl;
    nl._prev = l;
    nl._next = next;
    next._prev = nl;
    f._len++;
    bm._nloops++;
  }
  return [nv, e2];
}

/**
 * Split a face between the vertices of two of its (non adjacent) loops. The original face keeps
 * the corners from `la` to `lb`; returns the new face and the new edge.
 */
export function splitFace(bm: BMesh, f: BMFace, la: BMLoop, lb: BMLoop, example?: BMEdge | null): [BMFace, BMEdge] | null {
  if (la === lb || la._next === lb || lb._next === la || la.face !== f || lb.face !== f) return null;
  const e = ensureEdge(bm, la.vert, lb.vert, example ?? null);
  const chainB: BMLoop[] = [];
  for (let l = lb; l !== la; l = l._next) chainB.push(l);
  const laPrev = la._prev,
    lbPrev = lb._prev;
  // face f: la … lbPrev, nA (at lb.vert → la)
  const nA = new BMLoop(bm, lb.vert, e, f);
  nA._cd = lb._cd.map(cloneValue);
  lbPrev._next = nA;
  nA._prev = lbPrev;
  nA._next = la;
  la._prev = nA;
  // new face: lb … laPrev, nB (at la.vert → lb)
  const g = new BMFace(bm);
  copyAttrs(g, f);
  const nB = new BMLoop(bm, la.vert, e, g);
  nB._cd = la._cd.map(cloneValue);
  laPrev._next = nB;
  nB._prev = laPrev;
  nB._next = lb;
  lb._prev = nB;
  for (const l of chainB) l.face = g;
  e._l.push(nA, nB);
  g._first = lb;
  g._len = chainB.length + 1;
  f._first = la;
  f._len = f._len - chainB.length + 1;
  g._no = f._no.slice();
  bm._f.add(g);
  bm._ft = null;
  bm._nloops += 2;
  return [g, e];
}

/** Snapshot of a face for rebuilding: vertices, corner data, attributes. */
export interface FaceSpec {
  verts: BMVert[];
  loopData: unknown[][];
  example: BMFace;
  /** edge examples per corner */
  edges?: (BMEdge | null)[];
}

export function faceSpec(f: BMFace): FaceSpec {
  const ls = faceLoops(f);
  return { verts: ls.map((l) => l.vert), loopData: ls.map((l) => l._cd.map(cloneValue)), example: f, edges: ls.map((l) => l.edge) };
}

/** Make a face from a spec unless it is degenerate or already exists. */
export function buildFace(bm: BMesh, s: FaceSpec): BMFace | null {
  // drop consecutive duplicates
  const verts: BMVert[] = [],
    data: unknown[][] = [],
    edges: (BMEdge | null)[] = [];
  s.verts.forEach((v, i) => {
    if (verts.length && verts[verts.length - 1] === v) return;
    verts.push(v);
    data.push(s.loopData[i]);
    edges.push(s.edges?.[i] ?? null);
  });
  while (verts.length > 1 && verts[0] === verts[verts.length - 1]) verts.pop(), data.pop(), edges.pop();
  if (verts.length < 3 || new Set(verts).size !== verts.length || verts.some((v) => !v._bm)) return null;
  if (findFace(verts)) return null;
  return makeFace(bm, verts, { example: s.example, loopData: data, edges });
}

/**
 * Merge vertices: every key vertex is replaced by its target. Faces are rebuilt (degenerate and
 * duplicate faces are dropped), edge flags are kept.
 */
export function weldVerts(bm: BMesh, map: Map<BMVert, BMVert>) {
  // resolve chains a→b→c
  const target = (v: BMVert) => {
    let t = v,
      guard = 0;
    while (map.has(t) && map.get(t) !== t && guard++ < 1000) t = map.get(t)!;
    return t;
  };
  const faces = new Set<BMFace>();
  const wires: [BMVert, BMVert, BMEdge][] = [];
  const edgeFlags = new Map<string, [BMVert, BMVert, BMEdge]>();
  for (const v of map.keys()) {
    if (target(v) === v) continue;
    for (const e of v._e) {
      if (!e._l.length) wires.push([e.v1, e.v2, e]);
      for (const l of e._l) faces.add(l.face);
    }
  }
  const specs: FaceSpec[] = [];
  for (const f of faces) {
    const s = faceSpec(f);
    for (let i = 0; i < s.verts.length; i++) {
      const a = target(s.verts[i]),
        b = target(s.verts[(i + 1) % s.verts.length]);
      const e = s.edges![i];
      if (e && a !== b) edgeFlags.set(pairKey(a, b), [a, b, e]);
      s.edges![i] = null;
    }
    s.verts = s.verts.map(target);
    specs.push(s);
    killFace(f);
  }
  for (const v of [...map.keys()]) if (target(v) !== v) killVert(v);
  for (const s of specs) buildFace(bm, s);
  for (const [a0, b0, e] of wires) {
    const a = target(a0),
      b = target(b0);
    if (a !== b && a._bm && b._bm && !edgeBetween(a, b)) makeEdge(bm, a, b, e);
  }
  for (const [va, vb, src] of edgeFlags.values()) {
    const e = va._bm && vb._bm ? edgeBetween(va, vb) : null;
    if (e && src !== e) {
      e.seam ||= src.seam;
      e.smooth &&= src.smooth;
      e._sel ||= src._sel;
    }
  }
}

const pairKey = (a: BMVert, b: BMVert) => (a.__key < b.__key ? `${a.__key}|${b.__key}` : `${b.__key}|${a.__key}`);

/** Remove a vertex from all its faces (joining its two edges) when it has exactly two edges. */
export function dissolveVertInFaces(bm: BMesh, v: BMVert): boolean {
  if (v._e.length !== 2) return false;
  const [e1, e2] = v._e;
  const a = e1.other(v),
    b = e2.other(v);
  if (a === b) return false;
  const faces = new Set(vertFaces(v));
  if ([...faces].some((f) => f._len <= 3)) {
    // triangles collapse: just remove the vertex
    killVert(v);
    return true;
  }
  const specs = [...faces].map(faceSpec);
  const flags = e1;
  for (const f of faces) killFace(f);
  killVert(v);
  const existing = edgeBetween(a, b);
  const ne = existing ?? makeEdge(bm, a, b, flags);
  for (const s of specs) {
    const i = s.verts.indexOf(v);
    s.verts.splice(i, 1);
    s.loopData.splice(i, 1);
    s.edges = s.verts.map(() => null);
    buildFace(bm, s);
  }
  void ne;
  return true;
}

// ---------------------------------------------------------------------------
// sequences

const elemTypeName = { verts: 'BMVert', edges: 'BMEdge', faces: 'BMFace' } as const;

export function elems<T extends BMElem>(v: unknown, cls: abstract new (...a: never[]) => T, what: string): T[] {
  const list = toList(v, what);
  for (const x of list) if (!(x instanceof cls)) throw err('TypeError', `${what}: expected a sequence of ${(cls as unknown as { name: string }).name}, not ${describe(x)}`);
  return list as T[];
}

export function toList(v: unknown, what: string): unknown[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  if (v instanceof BMElem) return [v];
  if (typeof v === 'object' && typeof (v as Iterable<unknown>)[Symbol.iterator] === 'function') return [...(v as Iterable<unknown>)];
  throw err('TypeError', `${what}: expected a sequence of elements, got ${describe(v)}`);
}

abstract class BMElemSeq<T extends BMElem> extends PropCollection<T> {
  readonly _bmpy = 'seq';
  constructor(
    readonly _bmesh: BMesh,
    readonly _kind: 'verts' | 'edges' | 'faces',
  ) {
    super(`bm.${_kind}`);
  }
  abstract get __type(): string;
  _set(): Set<T> {
    return this._bmesh._chk()[this._kind === 'verts' ? '_v' : this._kind === 'edges' ? '_e' : '_f'] as unknown as Set<T>;
  }
  list(): T[] {
    return [...this._set()];
  }
  nameOf() {
    return '';
  }
  override get length() {
    return this._set().size;
  }
  override getItem(key: number | string): T {
    if (typeof key !== 'number' || !Number.isInteger(key)) throw err('TypeError', `${this.__type}[index]: expected an int index, got ${describe(key)}`);
    const table = this._bmesh._table(this._kind);
    if (!table) throw err('IndexError', `${this.__type}[index]: outdated internal index table, run ensure_lookup_table() first`);
    const i = key < 0 ? key + table.length : key;
    if (i < 0 || i >= table.length) throw err('IndexError', `${this.__type}[index]: index ${key} out of range`);
    return table[i] as T;
  }
  override contains(x: unknown) {
    return x instanceof BMElem && x._bm === this._bmesh && this._set().has(x as T);
  }
  ensure_lookup_table() {
    this._bmesh._ensureTable(this._kind);
  }
  index_update() {
    let i = 0;
    for (const e of this._set()) e.index = i++;
  }
  /** Remove an element (and everything that uses it). */
  remove(elem: unknown) {
    const bm = this._bmesh._chk();
    const cls = this._kind === 'verts' ? BMVert : this._kind === 'edges' ? BMEdge : BMFace;
    if (!(elem instanceof cls)) throw err('TypeError', `${this.__type}.remove(): expected a ${elemTypeName[this._kind]}, got ${describe(elem)}`);
    if (elem._bm !== bm) throw err('ValueError', `${this.__type}.remove(): element is not in this BMesh`);
    if (elem instanceof BMVert) killVert(elem);
    else if (elem instanceof BMEdge) killEdge(elem);
    else killFace(elem as BMFace);
  }
  /** Sort with a key function (JavaScript), or by a permutation of the current order (used by Python). */
  sort(key?: unknown, reverse = false) {
    const items = this.list();
    let order = items.map((_, i) => i);
    if (typeof key === 'function') {
      const keys = items.map((x) => (key as (e: T) => unknown)(x));
      order.sort((a, b) => (keys[a]! < keys[b]! ? -1 : keys[a]! > keys[b]! ? 1 : a - b));
    } else if (key !== undefined && key !== null) throw err('TypeError', 'sort(): key must be a function');
    if (reverse) order.reverse();
    this._sort_order(order);
  }
  /** Reorder by a permutation: new position i holds the element formerly at order[i]. */
  _sort_order(order: unknown) {
    const items = this.list();
    const o = toList(order, 'sort').map(Number);
    if (o.length !== items.length || new Set(o).size !== o.length) throw err('ValueError', 'sort(): order must be a permutation');
    const set = this._set();
    set.clear();
    o.forEach((k, i) => {
      items[k].index = i;
      set.add(items[k]);
    });
    this._bmesh._invalidate(this._kind);
  }
  get layers() {
    return this._bmesh._layerAccess(this._kind);
  }
  override toString() {
    return `<${this.__type}(${this.length})>`;
  }
  override repr() {
    return this.toString();
  }
}

export class BMVertSeq extends BMElemSeq<BMVert> {
  constructor(bm: BMesh) {
    super(bm, 'verts');
  }
  get __type() {
    return 'BMVertSeq';
  }
  /** Add a vertex at `co` (custom data copied from `example`). */
  new(co: unknown = [0, 0, 0], example: unknown = null): BMVert {
    const bm = this._bmesh._chk();
    if (example !== null && example !== undefined && !(example instanceof BMVert)) throw err('TypeError', `verts.new(): example must be a BMVert, got ${describe(example)}`);
    const v = makeVert(bm, vec3(co ?? [0, 0, 0], 'verts.new(co)'), (example as BMVert) ?? null);
    if (example) v._co = vec3(co ?? (example as BMVert)._co, 'verts.new(co)');
    return v;
  }
}
kwMethod(BMVertSeq.prototype, 'new', ['co', 'example']);
kwMethod(BMVertSeq.prototype, 'sort', ['key', 'reverse']);

export class BMEdgeSeq extends BMElemSeq<BMEdge> {
  constructor(bm: BMesh) {
    super(bm, 'edges');
  }
  get __type() {
    return 'BMEdgeSeq';
  }
  new(verts: unknown, example: unknown = null): BMEdge {
    const bm = this._bmesh._chk();
    const vs = elems(verts, BMVert, 'edges.new(verts)');
    if (vs.length !== 2) throw err('TypeError', `edges.new(...): expected 2 vertices, got ${vs.length}`);
    if (vs[0] === vs[1]) throw err('ValueError', 'edges.new(...): found the same (BMVert) used multiple times');
    for (const v of vs) if (v._bm !== bm) throw err('ValueError', 'edges.new(...): vertex is not in this BMesh (removed or from another BMesh)');
    if (edgeBetween(vs[0], vs[1])) throw err('ValueError', 'edges.new(): this edge exists');
    if (example !== null && example !== undefined && !(example instanceof BMEdge)) throw err('TypeError', `edges.new(): example must be a BMEdge, got ${describe(example)}`);
    return makeEdge(bm, vs[0], vs[1], (example as BMEdge) ?? null);
  }
  /** The edge between two vertices, or `fallback`. */
  override get(verts: unknown, fallback: unknown = null): unknown {
    if (typeof verts === 'string' || typeof verts === 'number') return fallback;
    const vs = elems(verts, BMVert, 'edges.get(verts)');
    if (vs.length !== 2) throw err('TypeError', `edges.get(...): expected 2 vertices, got ${vs.length}`);
    return edgeBetween(vs[0], vs[1]) ?? fallback;
  }
}
kwMethod(BMEdgeSeq.prototype, 'new', ['verts', 'example']);
kwMethod(BMEdgeSeq.prototype, 'sort', ['key', 'reverse']);

export class BMFaceSeq extends BMElemSeq<BMFace> {
  constructor(bm: BMesh) {
    super(bm, 'faces');
  }
  get __type() {
    return 'BMFaceSeq';
  }
  new(verts: unknown, example: unknown = null): BMFace {
    const bm = this._bmesh._chk();
    const vs = elems(verts, BMVert, 'faces.new(verts)');
    if (vs.length < 3) throw err('TypeError', `faces.new(...): sequence incorrect size, expected at least 3 vertices, given ${vs.length}`);
    if (new Set(vs).size !== vs.length) throw err('ValueError', 'faces.new(...): found the same (BMVert) used multiple times');
    for (const v of vs) if (v._bm !== bm) throw err('ValueError', 'faces.new(...): vertex is not in this BMesh (removed or from another BMesh)');
    if (findFace(vs)) throw err('ValueError', 'faces.new(...): face already exists');
    if (example !== null && example !== undefined && !(example instanceof BMFace)) throw err('TypeError', `faces.new(): example must be a BMFace, got ${describe(example)}`);
    const ex = (example as BMFace) ?? null;
    const f = makeFace(bm, vs, { example: ex });
    if (ex) {
      // corner data from the example's corners at the same vertices, else interpolated
      const byVert = new Map(faceLoops(ex).map((l) => [l.vert, l]));
      for (const l of faceLoops(f)) {
        const src = byVert.get(l.vert);
        if (src) l._cd = src._cd.map(cloneValue);
      }
    }
    return f;
  }
  override get(verts: unknown, fallback: unknown = null): unknown {
    if (typeof verts === 'string' || typeof verts === 'number') return fallback;
    return findFace(elems(verts, BMVert, 'faces.get(verts)')) ?? fallback;
  }
  get active(): BMFace | null {
    const a = this._bmesh._chk()._active;
    return a && a._bm ? a : null;
  }
  set active(f: unknown) {
    if (f !== null && f !== undefined && !(f instanceof BMFace)) throw err('TypeError', `faces.active: expected a BMFace or None, got ${describe(f)}`);
    this._bmesh._chk()._active = (f as BMFace) ?? null;
  }
}
kwMethod(BMFaceSeq.prototype, 'new', ['verts', 'example']);
kwMethod(BMFaceSeq.prototype, 'sort', ['key', 'reverse']);

export class BMLoopSeq extends PropCollection<BMLoop> {
  constructor(readonly _bmesh: BMesh) {
    super('bm.loops');
  }
  get __type() {
    return 'BMLoopSeq';
  }
  list() {
    const out: BMLoop[] = [];
    for (const f of this._bmesh._chk()._f) out.push(...faceLoops(f));
    return out;
  }
  nameOf() {
    return '';
  }
  override get length() {
    return this._bmesh._chk()._nloops;
  }
  override getItem(): BMLoop {
    throw err('TypeError', 'BMLoopSeq does not support indexing: use face.loops');
  }
  get layers() {
    return this._bmesh._layerAccess('loops');
  }
  override toString() {
    return `<BMLoopSeq(${this.length})>`;
  }
  override repr() {
    return this.toString();
  }
}

/** bm.select_history: the selection order (simple list; the last item is the active one). */
export class BMEditSelSeq extends PropCollection<BMElem> {
  constructor(readonly _bmesh: BMesh) {
    super('bm.select_history');
  }
  get __type() {
    return 'BMEditSelSeq';
  }
  list() {
    const h = this._bmesh._hist;
    for (let i = h.length - 1; i >= 0; i--) if (!h[i]._bm) h.splice(i, 1);
    return h.slice();
  }
  nameOf() {
    return '';
  }
  get active(): BMElem | null {
    const l = this.list();
    return l.length ? l[l.length - 1] : null;
  }
  add(el: unknown) {
    if (!(el instanceof BMVert || el instanceof BMEdge || el instanceof BMFace)) throw err('TypeError', `select_history.add(): expected a BMVert, BMEdge or BMFace, got ${describe(el)}`);
    this.discard(el);
    this._bmesh._hist.push(el);
  }
  remove(el: unknown) {
    const h = this._bmesh._hist;
    const i = h.indexOf(el as BMElem);
    if (i < 0) throw err('ValueError', 'select_history.remove(): element not found in the selection history');
    h.splice(i, 1);
  }
  discard(el: unknown) {
    const h = this._bmesh._hist;
    const i = h.indexOf(el as BMElem);
    if (i >= 0) h.splice(i, 1);
  }
  clear() {
    this._bmesh._hist.length = 0;
  }
  /** Drop elements that are not selected. */
  validate() {
    const h = this._bmesh._hist;
    for (let i = h.length - 1; i >= 0; i--) if (!h[i]._bm || !h[i]._sel) h.splice(i, 1);
  }
  override toString() {
    return `<BMEditSelSeq(${this.length})>`;
  }
  override repr() {
    return this.toString();
  }
}

// ---------------------------------------------------------------------------
// layer collections

export class BMLayerCollection extends PropCollection<BMLayerItem> {
  constructor(
    readonly _bmesh: BMesh,
    readonly _domain: Domain,
    readonly _kind: LayerKind,
  ) {
    super(`bm.${_domain}.layers.${_kind}`);
  }
  get __type() {
    return 'BMLayerCollection';
  }
  list() {
    return this._bmesh._chk()._layerSlots[this._domain].filter((l): l is BMLayerItem => !!l && l._kind === this._kind);
  }
  nameOf(l: BMLayerItem) {
    return l._name;
  }
  get is_singleton() {
    return this._kind === 'deform';
  }
  get active(): BMLayerItem | null {
    const bm = this._bmesh._chk();
    const a = bm._activeLayer.get(`${this._domain}:${this._kind}`);
    if (a && a.is_valid) return a;
    return this.list()[0] ?? null;
  }
  set active(l: unknown) {
    if (!(l instanceof BMLayerItem) || l._domain !== this._domain || l._kind !== this._kind) throw err('TypeError', `layers.${this._kind}.active: expected a ${this._kind} layer of this collection`);
    this._bmesh._activeLayer.set(`${this._domain}:${this._kind}`, l);
  }
  new(name?: unknown): BMLayerItem {
    const bm = this._bmesh._chk();
    if (this.is_singleton && this.list().length) throw err('ValueError', `layers.${this._kind}.new(): is a singleton, use verify() instead`);
    return bm._addLayer(this._domain, this._kind, name === undefined || name === null ? DEFAULT_NAMES[this._kind] : String(name));
  }
  remove(layer: unknown) {
    if (!(layer instanceof BMLayerItem) || !this.list().includes(layer)) throw err('ValueError', `layers.${this._kind}.remove(): layer not found`);
    this._bmesh._removeLayer(layer);
  }
  /** The active layer, made if there is none. */
  verify(): BMLayerItem {
    return this.active ?? this.new();
  }
  override toString() {
    return `<BMLayerCollection ${this._domain}.${this._kind}(${this.length})>`;
  }
  override repr() {
    return this.toString();
  }
}
kwMethod(BMLayerCollection.prototype, 'new', ['name']);

export class BMLayerAccess {
  constructor(
    readonly _bmesh: BMesh,
    readonly _domain: Domain,
  ) {}
  get __type() {
    return `BMLayerAccess${this._domain === 'verts' ? 'Vert' : this._domain === 'edges' ? 'Edge' : this._domain === 'faces' ? 'Face' : 'Loop'}`;
  }
  private coll(kind: LayerKind) {
    if (!DOMAIN_KINDS[this._domain].includes(kind)) throw err('AttributeError', `'${this.__type}' object has no attribute '${kind}' (${this._domain} layers: ${DOMAIN_KINDS[this._domain].join(', ')})`);
    return this._bmesh._layerColl(this._domain, kind);
  }
  get uv() {
    return this.coll('uv');
  }
  /** colors (one set of RGBA layers; `color` and `float_color` are the same layers) */
  get color() {
    return this.coll('color');
  }
  get float_color() {
    return this.coll('color');
  }
  get deform() {
    return this.coll('deform');
  }
  get shape() {
    return this.coll('shape');
  }
  get float() {
    return this.coll('float');
  }
  get int() {
    return this.coll('int');
  }
  get string() {
    return this.coll('string');
  }
  get float_vector() {
    return this.coll('float_vector');
  }
  get bool() {
    return this.coll('bool');
  }
  toString() {
    return `<${this.__type}>`;
  }
  repr() {
    return this.toString();
  }
}

// ---------------------------------------------------------------------------
// BMesh

export class BMesh {
  readonly __key = `BMesh#${++serial}`;
  _v = new Set<BMVert>();
  _e = new Set<BMEdge>();
  _f = new Set<BMFace>();
  _nloops = 0;
  _vt: BMVert[] | null = null;
  _et: BMEdge[] | null = null;
  _ft: BMFace[] | null = null;
  _alive = true;
  _active: BMFace | null = null;
  _hist: BMElem[] = [];
  _selectMode = new Set<string>(['VERT']);
  _layerSlots: Record<Domain, (BMLayerItem | null)[]> = { verts: [], edges: [], faces: [], loops: [] };
  _activeLayer = new Map<string, BMLayerItem>();
  private _seqs: { verts?: BMVertSeq; edges?: BMEdgeSeq; faces?: BMFaceSeq; loops?: BMLoopSeq; hist?: BMEditSelSeq } = {};
  private _layerColls = new Map<string, BMLayerCollection>();
  private _access = new Map<Domain, BMLayerAccess>();
  /** set by from_edit_mesh: the mesh this BMesh edits */
  _editMesh: string | null = null;

  get __type() {
    return 'BMesh';
  }
  _chk(): this {
    if (!this._alive) throw err('ReferenceError', 'BMesh data of type BMesh has been removed');
    return this;
  }
  get verts(): BMVertSeq {
    this._chk();
    return (this._seqs.verts ??= new BMVertSeq(this));
  }
  get edges(): BMEdgeSeq {
    this._chk();
    return (this._seqs.edges ??= new BMEdgeSeq(this));
  }
  get faces(): BMFaceSeq {
    this._chk();
    return (this._seqs.faces ??= new BMFaceSeq(this));
  }
  get loops(): BMLoopSeq {
    this._chk();
    return (this._seqs.loops ??= new BMLoopSeq(this));
  }
  get select_history(): BMEditSelSeq {
    this._chk();
    return (this._seqs.hist ??= new BMEditSelSeq(this));
  }
  get select_mode(): Set<string> {
    return new Set(this._selectMode);
  }
  set select_mode(v: unknown) {
    const list = (v instanceof Set ? [...v] : typeof v === 'string' ? [v] : toList(v, 'select_mode')).map(String);
    for (const m of list) if (!['VERT', 'EDGE', 'FACE'].includes(m)) throw err('ValueError', `select_mode: expected a set of 'VERT', 'EDGE', 'FACE', got '${m}'`);
    if (!list.length) throw err('ValueError', 'select_mode: must not be empty');
    this._selectMode = new Set(list);
  }
  get is_valid() {
    return this._alive;
  }
  get is_wrapped() {
    return !!this._editMesh;
  }
  _table(kind: 'verts' | 'edges' | 'faces'): BMElem[] | null {
    return kind === 'verts' ? this._vt : kind === 'edges' ? this._et : this._ft;
  }
  _ensureTable(kind: 'verts' | 'edges' | 'faces') {
    this._chk();
    if (kind === 'verts') this._vt ??= [...this._v];
    else if (kind === 'edges') this._et ??= [...this._e];
    else this._ft ??= [...this._f];
  }
  _invalidate(kind: 'verts' | 'edges' | 'faces') {
    if (kind === 'verts') this._vt = null;
    else if (kind === 'edges') this._et = null;
    else this._ft = null;
  }
  _domainElems(d: Domain): Iterable<BMElem> {
    if (d === 'verts') return this._v;
    if (d === 'edges') return this._e;
    if (d === 'faces') return this._f;
    const out: BMLoop[] = [];
    for (const f of this._f) out.push(...faceLoops(f));
    return out;
  }
  _layerAccess(d: Domain) {
    let a = this._access.get(d);
    if (!a) this._access.set(d, (a = new BMLayerAccess(this, d)));
    return a;
  }
  _layerColl(d: Domain, k: LayerKind) {
    const key = `${d}:${k}`;
    let c = this._layerColls.get(key);
    if (!c) this._layerColls.set(key, (c = new BMLayerCollection(this, d, k)));
    return c;
  }
  _addLayer(d: Domain, k: LayerKind, name: string): BMLayerItem {
    const slots = this._layerSlots[d];
    const names = new Set(slots.filter((l) => l && l._kind === k).map((l) => l!._name));
    let n = name;
    for (let i = 1; names.has(n) && k !== 'deform'; i++) n = `${name}.${String(i).padStart(3, '0')}`;
    const layer = new BMLayerItem(this, d, k, slots.length, n);
    slots.push(layer);
    return layer;
  }
  _removeLayer(l: BMLayerItem) {
    this._layerSlots[l._domain][l._slot] = null;
    for (const el of this._domainElems(l._domain)) el._cd[l._slot] = undefined;
    const key = `${l._domain}:${l._kind}`;
    if (this._activeLayer.get(key) === l) this._activeLayer.delete(key);
  }
  /** Layers of a domain and kind (in creation order). */
  _layers(d: Domain, k: LayerKind): BMLayerItem[] {
    return this._layerSlots[d].filter((l): l is BMLayerItem => !!l && l._kind === k);
  }
  _activeOf(d: Domain, k: LayerKind): BMLayerItem | null {
    return this._layerColl(d, k).active;
  }

  /** Remove all geometry (layers are kept). */
  clear() {
    this._chk();
    for (const s of [this._v, this._e, this._f] as Set<BMElem>[]) for (const e of s) e._bm = null;
    for (const f of this._f) for (const l of faceLoops(f)) l._bm = null;
    this._v.clear();
    this._e.clear();
    this._f.clear();
    this._nloops = 0;
    this._vt = this._et = this._ft = null;
    this._active = null;
    this._hist.length = 0;
  }
  /** Release the mesh: it and its elements can no longer be used. */
  free() {
    if (!this._alive) return;
    this.clear();
    this._alive = false;
  }
  /** Recalculate face and vertex normals. */
  normal_update() {
    this._chk();
    for (const f of this._f) f._no = faceNormal(f);
    for (const v of this._v) v._no = vertNormal(v);
  }
  /** Selection flush: select=True selects edges/faces whose vertices are all selected; False deselects those with an unselected vertex. */
  select_flush(select: boolean) {
    this._chk();
    for (const e of this._e) {
      if (select && e.v1._sel && e.v2._sel && !e._hide) e._sel = true;
      if (!select && !(e.v1._sel && e.v2._sel)) e._sel = false;
    }
    for (const f of this._f) {
      const all = faceLoops(f).every((l) => l.vert._sel);
      if (select && all && !f._hide) f._sel = true;
      if (!select && !all) f._sel = false;
    }
  }
  /** Make edge and face selection consistent with the select mode. */
  select_flush_mode() {
    this._chk();
    const m = this._selectMode;
    if (m.has('VERT')) {
      for (const e of this._e) e._sel = e.v1._sel && e.v2._sel && !e._hide;
      for (const f of this._f) f._sel = !f._hide && faceLoops(f).every((l) => l.vert._sel);
    } else if (m.has('EDGE')) {
      for (const f of this._f) f._sel = !f._hide && faceLoops(f).every((l) => l.edge._sel);
      for (const v of this._v) v._sel = v._e.some((e) => e._sel);
    } else {
      for (const e of this._e) e._sel = e._l.some((l) => l.face._sel);
      for (const v of this._v) v._sel = v._e.some((e) => e._sel);
    }
  }
  /** Transform vertices by a matrix (optionally only those with `filter` flags, e.g. {'SELECT'}). */
  transform(matrix: unknown, filter: unknown = null) {
    this._chk();
    const m = mat4(matrix, 'BMesh.transform(matrix)');
    const flags = filter ? new Set(toList(filter instanceof Set ? [...filter] : filter, 'filter').map(String)) : null;
    for (const v of this._v) {
      if (flags && !((flags.has('SELECT') && v._sel) || (flags.has('HIDDEN') && v._hide) || (flags.has('TAG') && v.tag))) continue;
      const p = mulPoint(m, v._co);
      v._co[0] = p[0];
      v._co[1] = p[1];
      v._co[2] = p[2];
    }
  }
  /** Volume of a closed mesh (signed: negative when the normals point inwards). */
  calc_volume(signed = false) {
    this._chk();
    let vol = 0;
    for (const f of this._f) {
      const ls = faceLoops(f);
      const p0 = ls[0].vert._co;
      for (let i = 1; i + 1 < ls.length; i++) vol += dot(p0, cross(ls[i].vert._co, ls[i + 1].vert._co)) / 6;
    }
    return signed ? vol : Math.abs(vol);
  }
  /** Triangles covering every face, as triples of loops. */
  calc_loop_triangles(): BMLoop[][] {
    this._chk();
    const out: BMLoop[][] = [];
    for (const f of this._f) for (const t of triangulateFace(f)) out.push(t);
    return out;
  }
  /** Deep copy. */
  copy(): BMesh {
    this._chk();
    const bm = new BMesh();
    copyLayers(this, bm);
    copyGeometry(this, bm, [...this._v], [...this._e], [...this._f]);
    bm._selectMode = new Set(this._selectMode);
    return bm;
  }
  toString() {
    return this._alive ? `<BMesh(totvert=${this._v.size}, totedge=${this._e.size}, totface=${this._f.size}, totloop=${this._nloops})>` : '<BMesh dead>';
  }
  repr() {
    return this.toString();
  }
}
kwMethod(BMesh.prototype, 'transform', ['matrix', 'filter']);
kwMethod(BMesh.prototype, 'calc_volume', ['signed']);
kwMethod(BMesh.prototype, 'select_flush', ['select']);

/** Copy the layer layout of `src` into `dst` (same slots). */
export function copyLayers(src: BMesh, dst: BMesh) {
  for (const d of ['verts', 'edges', 'faces', 'loops'] as Domain[]) {
    for (const l of src._layerSlots[d]) {
      if (!l) {
        dst._layerSlots[d].push(null);
        continue;
      }
      dst._addLayer(d, l._kind, l._name);
    }
  }
  for (const [k, l] of src._activeLayer) {
    const m = dst._layerSlots[l._domain][l._slot];
    if (m) dst._activeLayer.set(k, m);
  }
}

/**
 * Copy elements (from the same or another BMesh with the same layer layout) into `dst`.
 * Returns old → new maps.
 */
export function copyGeometry(src: BMesh, dst: BMesh, verts: BMVert[], edges: BMEdge[], faces: BMFace[]) {
  const vmap = new Map<BMVert, BMVert>(),
    emap = new Map<BMEdge, BMEdge>(),
    fmap = new Map<BMFace, BMFace>();
  const vert = (v: BMVert) => {
    let n = vmap.get(v);
    if (!n) {
      n = makeVert(dst, v._co, v);
      n.index = v.index;
      n.tag = v.tag;
      vmap.set(v, n);
    }
    return n;
  };
  const edge = (e: BMEdge) => {
    let n = emap.get(e);
    if (!n) {
      n = edgeBetween(vert(e.v1), vert(e.v2)) ?? makeEdge(dst, vert(e.v1), vert(e.v2), e);
      n.index = e.index;
      emap.set(e, n);
    }
    return n;
  };
  for (const v of verts) vert(v);
  for (const e of edges) edge(e);
  for (const f of faces) {
    const ls = faceLoops(f);
    const nf = makeFace(dst, ls.map((l) => vert(l.vert)), { example: f, edges: ls.map((l) => edge(l.edge)), loops: ls });
    nf.index = f.index;
    nf._no = f._no.slice();
    fmap.set(f, nf);
    if (src._active === f && src !== dst) dst._active = nf;
  }
  return { vmap, emap, fmap };
}

/** Triangles of a face as loop triples (quads along the shorter diagonal, n-gons by ear clipping). */
export function triangulateFace(f: BMFace, quadMethod = 'BEAUTY', ngonMethod = 'BEAUTY'): BMLoop[][] {
  const ls = faceLoops(f);
  const n = ls.length;
  if (n === 3) return [ls];
  if (n === 4) {
    const d02 = dist(ls[0].vert._co, ls[2].vert._co),
      d13 = dist(ls[1].vert._co, ls[3].vert._co);
    let use02: boolean;
    if (quadMethod === 'FIXED') use02 = true;
    else if (quadMethod === 'ALTERNATE') use02 = false;
    else if (quadMethod === 'LONG_EDGE') use02 = d02 >= d13;
    else if (quadMethod === 'BEAUTY') use02 = beautyPrefers02(ls.map((l) => l.vert._co));
    else use02 = d02 <= d13; // SHORT_EDGE
    return use02
      ? [
          [ls[0], ls[1], ls[2]],
          [ls[0], ls[2], ls[3]],
        ]
      : [
          [ls[1], ls[2], ls[3]],
          [ls[1], ls[3], ls[0]],
        ];
  }
  void ngonMethod;
  const no = faceNormal(f);
  const ax = Math.abs(no[0]),
    ay = Math.abs(no[1]),
    az = Math.abs(no[2]);
  const [u, v] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
  const sign = (az >= ax && az >= ay ? no[2] : ax >= ay ? no[0] : no[1]) >= 0 ? 1 : -1;
  const px = ls.map((l) => l.vert._co[u]),
    py = ls.map((l) => l.vert._co[v] * sign);
  const idx = ls.map((_, i) => i);
  const out: BMLoop[][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    // prefer the ear with the best (largest minimum) angle
    let bestI = -1,
      bestQ = -Infinity;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length],
        b = idx[i],
        c = idx[(i + 1) % idx.length];
      const cr = (px[b] - px[a]) * (py[c] - py[a]) - (py[b] - py[a]) * (px[c] - px[a]);
      if (cr <= 1e-14) continue;
      let inside = false;
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        if (inTri(px[p], py[p], px[a], py[a], px[b], py[b], px[c], py[c])) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      const q = triQuality(ls[a].vert._co, ls[b].vert._co, ls[c].vert._co);
      if (q > bestQ) (bestQ = q), (bestI = i);
    }
    if (bestI >= 0) {
      const i = bestI;
      out.push([ls[idx[(i + idx.length - 1) % idx.length]], ls[idx[i]], ls[idx[(i + 1) % idx.length]]]);
      idx.splice(i, 1);
      clipped = true;
    }
    if (!clipped) {
      for (let i = 1; i < idx.length - 1; i++) out.push([ls[idx[0]], ls[idx[i]], ls[idx[i + 1]]]);
      return out;
    }
  }
  if (idx.length === 3) out.push([ls[idx[0]], ls[idx[1]], ls[idx[2]]]);
  return out;
}

function inTri(x: number, y: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by),
    d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy),
    d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Smallest angle of a triangle (bigger is better shaped). */
export function triQuality(a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>) {
  return Math.min(angleBetween(sub(b, a), sub(c, a)), angleBetween(sub(a, b), sub(c, b)), angleBetween(sub(a, c), sub(b, c)));
}

function beautyPrefers02(p: number[][]) {
  const q02 = Math.min(triQuality(p[0], p[1], p[2]), triQuality(p[0], p[2], p[3]));
  const q13 = Math.min(triQuality(p[1], p[2], p[3]), triQuality(p[1], p[3], p[0]));
  return q02 >= q13 - 1e-9;
}
