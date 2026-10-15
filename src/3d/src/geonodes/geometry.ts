// Geometry set and components (mesh, point cloud, curves, instances) with generic attributes.
// Components are immutable once built: operations create new components that share unchanged
// arrays, so results can be cached and reused between evaluations.
import type { AttrArray, DataType, Domain } from './types';
import { allocData, dataComps } from './types';

export interface Attribute {
  domain: Domain;
  type: DataType;
  data: AttrArray;
}

export type AttrMap = Map<string, Attribute>;

/** Anonymous attributes (captured fields, node outputs such as Top/Side) are not user visible. */
export const isAnonymous = (name: string) => name.startsWith('#');
export const isInternal = (name: string) => name.startsWith('.') || isAnonymous(name);

// ---------------------------------------------------------------------------
// Mesh topology

export interface MeshTopology {
  /** vertex pairs per edge (face edges in first-use order, then loose edges) */
  edges: Uint32Array;
  edgeCount: number;
  /** edge from each corner to the next corner of its face */
  cornerEdge: Uint32Array;
  cornerFace: Uint32Array;
  /** CSR edge → faces */
  edgeFaceOffsets: Uint32Array;
  edgeFaces: Uint32Array;
  /** CSR vertex → faces / corners */
  vertFaceOffsets: Uint32Array;
  vertFaces: Uint32Array;
  vertCorners: Uint32Array;
  /** CSR vertex → edges */
  vertEdgeOffsets: Uint32Array;
  vertEdges: Uint32Array;
}

const topoCache = new WeakMap<Uint32Array, { loose: Uint32Array; nv: number; topo: MeshTopology }>();

function nextPow2(n: number) {
  let p = 16;
  while (p < n) p <<= 1;
  return p;
}

/** Open-addressing hash from a sorted vertex pair to an edge index. */
export class EdgeHash {
  private a: Int32Array;
  private b: Int32Array;
  private v: Int32Array;
  private mask: number;
  size = 0;
  constructor(expected: number) {
    const cap = nextPow2(Math.max(16, expected * 2));
    this.a = new Int32Array(cap).fill(-1);
    this.b = new Int32Array(cap);
    this.v = new Int32Array(cap);
    this.mask = cap - 1;
  }
  private slot(x: number, y: number) {
    let h = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77)) >>> 0;
    h ^= h >>> 15;
    return h & this.mask;
  }
  get(x: number, y: number): number {
    if (x > y) [x, y] = [y, x];
    for (let s = this.slot(x, y); ; s = (s + 1) & this.mask) {
      const k = this.a[s];
      if (k === -1) return -1;
      if (k === x && this.b[s] === y) return this.v[s];
    }
  }
  /** returns the existing index or inserts `value` */
  getOrAdd(x: number, y: number, value: number): number {
    if (x > y) [x, y] = [y, x];
    if ((this.size + 1) * 2 > this.a.length) this.grow();
    for (let s = this.slot(x, y); ; s = (s + 1) & this.mask) {
      const k = this.a[s];
      if (k === -1) {
        this.a[s] = x;
        this.b[s] = y;
        this.v[s] = value;
        this.size++;
        return value;
      }
      if (k === x && this.b[s] === y) return this.v[s];
    }
  }
  private grow() {
    const oa = this.a,
      ob = this.b,
      ov = this.v;
    const cap = oa.length * 2;
    this.a = new Int32Array(cap).fill(-1);
    this.b = new Int32Array(cap);
    this.v = new Int32Array(cap);
    this.mask = cap - 1;
    this.size = 0;
    for (let i = 0; i < oa.length; i++) if (oa[i] !== -1) this.getOrAdd(oa[i], ob[i], ov[i]);
  }
}

function csr(count: number, n: number, keyOf: (i: number) => number): { offsets: Uint32Array; fill: Uint32Array } {
  const offsets = new Uint32Array(count + 1);
  for (let i = 0; i < n; i++) offsets[keyOf(i) + 1]++;
  for (let i = 0; i < count; i++) offsets[i + 1] += offsets[i];
  return { offsets, fill: offsets.slice(0, count) };
}

export function buildTopology(nv: number, faceOffsets: Uint32Array, corners: Uint32Array, loose: Uint32Array): MeshTopology {
  const nf = faceOffsets.length - 1,
    nc = corners.length;
  const hash = new EdgeHash(nc + loose.length / 2);
  const ev = new Uint32Array((nc + loose.length) * 2 + 2);
  let ne = 0;
  const cornerEdge = new Uint32Array(nc),
    cornerFace = new Uint32Array(nc);
  for (let f = 0; f < nf; f++) {
    const s = faceOffsets[f],
      e = faceOffsets[f + 1];
    for (let c = s; c < e; c++) {
      cornerFace[c] = f;
      const x = corners[c],
        y = corners[c + 1 < e ? c + 1 : s];
      const id = hash.getOrAdd(x, y, ne);
      if (id === ne) {
        ev[ne * 2] = Math.min(x, y);
        ev[ne * 2 + 1] = Math.max(x, y);
        ne++;
      }
      cornerEdge[c] = id;
    }
  }
  for (let i = 0; i < loose.length; i += 2) {
    const x = loose[i],
      y = loose[i + 1];
    if (x === y) continue;
    const id = hash.getOrAdd(x, y, ne);
    if (id === ne) {
      ev[ne * 2] = x;
      ev[ne * 2 + 1] = y;
      ne++;
    }
  }
  const edges = ev.slice(0, ne * 2);
  const ef = csr(ne, nc, (c) => cornerEdge[c]);
  const edgeFaces = new Uint32Array(nc);
  for (let c = 0; c < nc; c++) edgeFaces[ef.fill[cornerEdge[c]]++] = cornerFace[c];
  const vf = csr(nv, nc, (c) => corners[c]);
  const vertFaces = new Uint32Array(nc),
    vertCorners = new Uint32Array(nc);
  for (let c = 0; c < nc; c++) {
    const k = vf.fill[corners[c]]++;
    vertFaces[k] = cornerFace[c];
    vertCorners[k] = c;
  }
  const ve = csr(nv, ne * 2, (i) => edges[i]);
  const vertEdges = new Uint32Array(ne * 2);
  for (let i = 0; i < ne * 2; i++) vertEdges[ve.fill[edges[i]]++] = i >> 1;
  return {
    edges,
    edgeCount: ne,
    cornerEdge,
    cornerFace,
    edgeFaceOffsets: ef.offsets,
    edgeFaces,
    vertFaceOffsets: vf.offsets,
    vertFaces,
    vertCorners,
    vertEdgeOffsets: ve.offsets,
    vertEdges,
  };
}

// ---------------------------------------------------------------------------
// Components

export class MeshComponent {
  readonly kind = 'MESH' as const;
  constructor(
    public positions: Float32Array,
    public faceOffsets: Uint32Array,
    public corners: Uint32Array,
    /** edges that are not part of any face (vertex pairs) */
    public looseEdges: Uint32Array = new Uint32Array(0),
    public attrs: AttrMap = new Map(),
    public materials: (string | null)[] = [],
  ) {}
  get vertCount() {
    return this.positions.length / 3;
  }
  get faceCount() {
    return this.faceOffsets.length - 1;
  }
  get cornerCount() {
    return this.corners.length;
  }
  get edgeCount() {
    return this.topology().edgeCount;
  }
  topology(): MeshTopology {
    const nv = this.vertCount;
    const c = topoCache.get(this.corners);
    if (c && c.loose === this.looseEdges && c.nv === nv) return c.topo;
    const topo = buildTopology(nv, this.faceOffsets, this.corners, this.looseEdges);
    topoCache.set(this.corners, { loose: this.looseEdges, nv, topo });
    return topo;
  }
  domainSize(d: Domain): number {
    switch (d) {
      case 'POINT':
        return this.vertCount;
      case 'FACE':
        return this.faceCount;
      case 'CORNER':
        return this.cornerCount;
      case 'EDGE':
        return this.edgeCount;
      default:
        return 0;
    }
  }
  /** shallow copy (new attribute map, same arrays) */
  copy(): MeshComponent {
    return new MeshComponent(this.positions, this.faceOffsets, this.corners, this.looseEdges, new Map(this.attrs), [...this.materials]);
  }
  withPositions(p: Float32Array): MeshComponent {
    const m = this.copy();
    m.positions = p;
    return m;
  }
}

export class PointsComponent {
  readonly kind = 'POINTS' as const;
  constructor(
    public positions: Float32Array,
    public attrs: AttrMap = new Map(),
    public materials: (string | null)[] = [],
  ) {}
  get count() {
    return this.positions.length / 3;
  }
  domainSize(d: Domain) {
    return d === 'POINT' ? this.count : 0;
  }
  copy() {
    return new PointsComponent(this.positions, new Map(this.attrs), [...this.materials]);
  }
}

/** Poly curves (evaluated points). Point attributes include radius and tilt; curve attributes include cyclic. */
export class CurvesComponent {
  readonly kind = 'CURVES' as const;
  constructor(
    public positions: Float32Array,
    /** point offsets per curve (curves + 1) */
    public curveOffsets: Uint32Array,
    public cyclic: Uint8Array,
    public attrs: AttrMap = new Map(),
    public materials: (string | null)[] = [],
  ) {}
  get pointCount() {
    return this.positions.length / 3;
  }
  get curveCount() {
    return this.curveOffsets.length - 1;
  }
  domainSize(d: Domain) {
    return d === 'POINT' ? this.pointCount : d === 'CURVE' ? this.curveCount : 0;
  }
  copy() {
    return new CurvesComponent(this.positions, this.curveOffsets, this.cyclic, new Map(this.attrs), [...this.materials]);
  }
  /** curve index of each point */
  pointCurve(): Uint32Array {
    const out = new Uint32Array(this.pointCount);
    for (let c = 0; c < this.curveCount; c++) out.fill(c, this.curveOffsets[c], this.curveOffsets[c + 1]);
    return out;
  }
}

export type InstanceReference =
  | { type: 'GEOMETRY'; geometry: GeometrySet; key: string }
  | { type: 'OBJECT'; objectId: string; geometry: GeometrySet; key: string }
  | {
      type: 'COLLECTION';
      collectionId: string;
      geometry: GeometrySet;
      key: string;
    };

export class InstancesComponent {
  readonly kind = 'INSTANCES' as const;
  constructor(
    /** column-major 4×4 per instance */
    public transforms: Float32Array,
    public refIndex: Int32Array,
    public references: InstanceReference[],
    public attrs: AttrMap = new Map(),
  ) {}
  get count() {
    return this.refIndex.length;
  }
  domainSize(d: Domain) {
    return d === 'INSTANCE' ? this.count : 0;
  }
  copy() {
    return new InstancesComponent(this.transforms, this.refIndex, this.references, new Map(this.attrs));
  }
}

export type Component = MeshComponent | PointsComponent | CurvesComponent | InstancesComponent;
export type ComponentKind = Component['kind'];

export class GeometrySet {
  constructor(
    public mesh?: MeshComponent,
    public points?: PointsComponent,
    public curves?: CurvesComponent,
    public instances?: InstancesComponent,
  ) {}
  static empty() {
    return new GeometrySet();
  }
  isEmpty() {
    return !this.mesh && !this.points && !this.curves && !this.instances;
  }
  components(): Component[] {
    const out: Component[] = [];
    if (this.mesh) out.push(this.mesh);
    if (this.points) out.push(this.points);
    if (this.curves) out.push(this.curves);
    if (this.instances) out.push(this.instances);
    return out;
  }
  with(c: Component | null | undefined, kind?: ComponentKind): GeometrySet {
    const g = new GeometrySet(this.mesh, this.points, this.curves, this.instances);
    const k = c?.kind ?? kind;
    if (k === 'MESH') g.mesh = (c as MeshComponent) ?? undefined;
    else if (k === 'POINTS') g.points = (c as PointsComponent) ?? undefined;
    else if (k === 'CURVES') g.curves = (c as CurvesComponent) ?? undefined;
    else if (k === 'INSTANCES') g.instances = (c as InstancesComponent) ?? undefined;
    return g;
  }
  /** Apply a function to each component (null removes it). */
  map(fn: (c: Component) => Component | null): GeometrySet {
    const g = new GeometrySet();
    for (const c of this.components()) {
      const r = fn(c);
      if (r) g.setComponent(r);
    }
    return g;
  }
  setComponent(c: Component) {
    if (c.kind === 'MESH') this.mesh = c;
    else if (c.kind === 'POINTS') this.points = c;
    else if (c.kind === 'CURVES') this.curves = c;
    else this.instances = c;
  }
}

// ---------------------------------------------------------------------------
// Attribute helpers

export function domainSize(c: Component, d: Domain): number {
  return c.domainSize(d);
}

/** Domains available on a component (in canonical order). */
export function componentDomains(c: Component): Domain[] {
  switch (c.kind) {
    case 'MESH':
      return ['POINT', 'EDGE', 'FACE', 'CORNER'];
    case 'POINTS':
      return ['POINT'];
    case 'CURVES':
      return ['POINT', 'CURVE'];
    case 'INSTANCES':
      return ['INSTANCE'];
  }
}

/** Gather attribute values on one domain through a source index map (−1 → zero). */
export function gatherArray(src: AttrArray, comps: number, map: ArrayLike<number>, n = map.length): AttrArray {
  const out = new (src.constructor as { new (n: number): AttrArray })(n * comps);
  if (comps === 1) {
    for (let i = 0; i < n; i++) {
      const s = map[i];
      if (s >= 0) out[i] = src[s];
    }
  } else
    for (let i = 0; i < n; i++) {
      const s = map[i];
      if (s < 0) continue;
      for (let k = 0; k < comps; k++) out[i * comps + k] = src[s * comps + k];
    }
  return out;
}

/** Weighted interpolation sources for new elements (CSR). */
export interface Interp {
  offsets: Uint32Array;
  src: Uint32Array;
  w: Float32Array;
}

export function interpArray(srcArr: AttrArray, comps: number, ip: Interp, type: DataType): AttrArray {
  const n = ip.offsets.length - 1;
  const out = new (srcArr.constructor as { new (n: number): AttrArray })(n * comps);
  const isBool = type === 'BOOLEAN',
    isInt = type === 'INT' || type === 'INT8';
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < comps; k++) {
      let s = 0;
      for (let j = ip.offsets[i]; j < ip.offsets[i + 1]; j++) s += srcArr[ip.src[j] * comps + k] * ip.w[j];
      out[i * comps + k] = isBool ? (s >= 0.5 ? 1 : 0) : isInt ? Math.round(s) : s;
    }
  }
  return out;
}

/** Build attributes of one domain for a new component: gathered via `map`, or interpolated. */
export function propagate(src: AttrMap, dst: AttrMap, domain: Domain, how: { map: ArrayLike<number>; n?: number } | { interp: Interp }, skip?: Set<string>) {
  for (const [name, a] of src) {
    if (a.domain !== domain || skip?.has(name)) continue;
    const comps = dataComps(a.type);
    const data = 'map' in how ? gatherArray(a.data, comps, how.map, how.n) : interpArray(a.data, comps, how.interp, a.type);
    dst.set(name, { domain, type: a.type, data });
  }
}

export function setAttr(attrs: AttrMap, name: string, domain: Domain, type: DataType, data: AttrArray) {
  attrs.set(name, { domain, type, data });
}

export function newAttrData(type: DataType, n: number) {
  return allocData(type, n);
}

// ---------------------------------------------------------------------------
// Domain interpolation (mesh and curves)

type Acc = { sum: Float64Array; cnt: Float64Array };

function finish(acc: Acc, comps: number, type: DataType, mode: 'avg' | 'and' | 'or'): AttrArray {
  const n = acc.cnt.length;
  const out = allocData(type, n);
  for (let i = 0; i < n; i++) {
    const c = acc.cnt[i];
    for (let k = 0; k < comps; k++) {
      const s = acc.sum[i * comps + k];
      if (type === 'BOOLEAN') out[i] = c === 0 ? 0 : mode === 'and' ? (s >= c ? 1 : 0) : s > 0 ? 1 : 0;
      else if (type === 'INT' || type === 'INT8') out[i * comps + k] = c ? Math.round(s / c) : 0;
      else out[i * comps + k] = c ? s / c : 0;
    }
  }
  return out;
}

function accumulate(n: number, comps: number, pairs: (add: (dst: number, src: number) => void) => void, src: AttrArray): Acc {
  const sum = new Float64Array(n * comps),
    cnt = new Float64Array(n);
  const add =
    comps === 1
      ? (d: number, s: number) => {
          sum[d] += src[s];
          cnt[d]++;
        }
      : (d: number, s: number) => {
          for (let k = 0; k < comps; k++) sum[d * comps + k] += src[s * comps + k];
          cnt[d]++;
        };
  pairs(add);
  return { sum, cnt };
}

/** Convert attribute data between domains of a mesh or curves component. */
export function adaptDomain(c: Component, data: AttrArray, type: DataType, from: Domain, to: Domain): AttrArray {
  if (from === to) return data;
  const comps = dataComps(type);
  const isBool = type === 'BOOLEAN';
  if (c.kind === 'CURVES') {
    if (from === 'CURVE' && to === 'POINT') return gatherArray(data, comps, c.pointCurve());
    if (from === 'POINT' && to === 'CURVE') {
      const pc = c.pointCurve();
      const acc = accumulate(
        c.curveCount,
        comps,
        (add) => {
          for (let p = 0; p < pc.length; p++) add(pc[p], p);
        },
        data,
      );
      return finish(acc, comps, type, isBool ? 'and' : 'avg');
    }
    return allocData(type, c.domainSize(to));
  }
  if (c.kind !== 'MESH') return allocData(type, c.domainSize(to));
  const m = c;
  const nc = m.cornerCount;
  if (from === 'POINT' && to === 'CORNER') return gatherArray(data, comps, m.corners);
  const topo = m.topology();
  if (from === 'FACE' && to === 'CORNER') return gatherArray(data, comps, topo.cornerFace);
  const n = m.domainSize(to);
  let acc: Acc;
  let mode: 'avg' | 'and' | 'or' = 'avg';
  // booleans: an element made of other elements is true when all of them are; otherwise any
  const composed = to === 'FACE' || (to === 'EDGE' && (from === 'POINT' || from === 'CORNER')) || (to === 'CORNER' && from === 'EDGE');
  if (isBool) mode = composed ? 'and' : 'or';
  if (from === 'CORNER' && to === 'POINT')
    acc = accumulate(
      n,
      comps,
      (add) => {
        for (let k = 0; k < nc; k++) add(m.corners[k], k);
      },
      data,
    );
  else if (from === 'CORNER' && to === 'FACE')
    acc = accumulate(
      n,
      comps,
      (add) => {
        for (let k = 0; k < nc; k++) add(topo.cornerFace[k], k);
      },
      data,
    );
  else if (from === 'POINT' && to === 'FACE')
    acc = accumulate(
      n,
      comps,
      (add) => {
        for (let k = 0; k < nc; k++) add(topo.cornerFace[k], m.corners[k]);
      },
      data,
    );
  else if (from === 'FACE' && to === 'POINT')
    acc = accumulate(
      n,
      comps,
      (add) => {
        for (let k = 0; k < nc; k++) add(m.corners[k], topo.cornerFace[k]);
      },
      data,
    );
  else if (from === 'POINT' && to === 'EDGE')
    acc = accumulate(
      n,
      comps,
      (add) => {
        for (let e = 0; e < topo.edgeCount; e++) {
          add(e, topo.edges[e * 2]);
          add(e, topo.edges[e * 2 + 1]);
        }
      },
      data,
    );
  else if (from === 'EDGE' && to === 'POINT')
    acc = accumulate(
      n,
      comps,
      (add) => {
        for (let e = 0; e < topo.edgeCount; e++) {
          add(topo.edges[e * 2], e);
          add(topo.edges[e * 2 + 1], e);
        }
      },
      data,
    );
  else if (from === 'EDGE' && to === 'FACE')
    acc = accumulate(
      n,
      comps,
      (add) => {
        for (let k = 0; k < nc; k++) add(topo.cornerFace[k], topo.cornerEdge[k]);
      },
      data,
    );
  else if (from === 'FACE' && to === 'EDGE')
    acc = accumulate(
      n,
      comps,
      (add) => {
        for (let k = 0; k < nc; k++) add(topo.cornerEdge[k], topo.cornerFace[k]);
      },
      data,
    );
  else if (from === 'EDGE' && to === 'CORNER')
    acc = accumulate(
      n,
      comps,
      (add) => {
        for (let f = 0; f < m.faceCount; f++) {
          const s = m.faceOffsets[f],
            e = m.faceOffsets[f + 1];
          for (let k = s; k < e; k++) {
            add(k, topo.cornerEdge[k]);
            add(k, topo.cornerEdge[k === s ? e - 1 : k - 1]);
          }
        }
      },
      data,
    );
  else if (from === 'CORNER' && to === 'EDGE')
    acc = accumulate(
      n,
      comps,
      (add) => {
        for (let f = 0; f < m.faceCount; f++) {
          const s = m.faceOffsets[f],
            e = m.faceOffsets[f + 1];
          for (let k = s; k < e; k++) {
            add(topo.cornerEdge[k], k);
            add(topo.cornerEdge[k], k + 1 < e ? k + 1 : s);
          }
        }
      },
      data,
    );
  else if (from === 'FACE' && to === 'FACE') return data;
  else {
    // point → corner → … chains not covered above go through points
    const viaPoint = adaptDomain(c, data, type, from, 'POINT');
    return adaptDomain(c, viaPoint, type, 'POINT', to);
  }
  return finish(acc, comps, type, mode);
}

/** Read an attribute adapted to a domain (or undefined when missing). */
export function readAttribute(c: Component, name: string, domain: Domain): Attribute | undefined {
  if (name === 'position') {
    const pos = (c as { positions?: Float32Array }).positions;
    if (!pos) {
      if (c.kind === 'INSTANCES') {
        const n = c.count,
          out = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          out[i * 3] = c.transforms[i * 16 + 12];
          out[i * 3 + 1] = c.transforms[i * 16 + 13];
          out[i * 3 + 2] = c.transforms[i * 16 + 14];
        }
        return {
          domain: 'INSTANCE',
          type: 'FLOAT_VECTOR',
          data: domain === 'INSTANCE' ? out : allocData('FLOAT_VECTOR', c.domainSize(domain)),
        };
      }
      return undefined;
    }
    return {
      domain,
      type: 'FLOAT_VECTOR',
      data: adaptDomain(c, pos, 'FLOAT_VECTOR', 'POINT', domain),
    };
  }
  const a = c.attrs.get(name);
  if (!a) return undefined;
  if (a.domain === domain) return a;
  return {
    domain,
    type: a.type,
    data: adaptDomain(c, a.data, a.type, a.domain, domain),
  };
}

// ---------------------------------------------------------------------------
// Matrices (column-major 4×4 as number arrays)

export type Mat4 = Float64Array | Float32Array | number[];

export function identity(): Float64Array {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function mulMat(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array = new Float64Array(16)): Float64Array {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let rr = 0; rr < 4; rr++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
      r[c * 4 + rr] = s;
    }
  out.set(r);
  return out;
}

export function invertMat(m: ArrayLike<number>): Float64Array {
  const a = Array.from(m);
  const inv = new Float64Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!det) return identity();
  det = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}

/** Euler XYZ (radians) → 3×3 rotation, written into a column-major 4×4 with translation/scale. */
export function composeMat(t: ArrayLike<number>, euler: ArrayLike<number>, s: ArrayLike<number>, out: Float64Array = new Float64Array(16)): Float64Array {
  const cx = Math.cos(euler[0]),
    sx = Math.sin(euler[0]),
    cy = Math.cos(euler[1]),
    sy = Math.sin(euler[1]),
    cz = Math.cos(euler[2]),
    sz = Math.sin(euler[2]);
  // R = Rz * Ry * Rx
  const r00 = cy * cz,
    r01 = sx * sy * cz - cx * sz,
    r02 = cx * sy * cz + sx * sz;
  const r10 = cy * sz,
    r11 = sx * sy * sz + cx * cz,
    r12 = cx * sy * sz - sx * cz;
  const r20 = -sy,
    r21 = sx * cy,
    r22 = cx * cy;
  out[0] = r00 * s[0];
  out[1] = r10 * s[0];
  out[2] = r20 * s[0];
  out[3] = 0;
  out[4] = r01 * s[1];
  out[5] = r11 * s[1];
  out[6] = r21 * s[1];
  out[7] = 0;
  out[8] = r02 * s[2];
  out[9] = r12 * s[2];
  out[10] = r22 * s[2];
  out[11] = 0;
  out[12] = t[0];
  out[13] = t[1];
  out[14] = t[2];
  out[15] = 1;
  return out;
}

/** Decompose a column-major matrix into translation, XYZ Euler and scale. */
export function decomposeMat(m: ArrayLike<number>): {
  t: [number, number, number];
  r: [number, number, number];
  s: [number, number, number];
} {
  const sx = Math.hypot(m[0], m[1], m[2]),
    sy = Math.hypot(m[4], m[5], m[6]);
  let sz = Math.hypot(m[8], m[9], m[10]);
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sz = -sz;
  const r00 = m[0] / (sx || 1),
    r10 = m[1] / (sx || 1),
    r20 = m[2] / (sx || 1);
  const r21 = m[6] / (sy || 1),
    r22 = m[10] / (sz || 1);
  const r01 = m[4] / (sy || 1),
    r11 = m[5] / (sy || 1);
  const y = Math.asin(Math.max(-1, Math.min(1, -r20)));
  let x: number, z: number;
  if (Math.abs(r20) < 0.9999999) {
    x = Math.atan2(r21, r22);
    z = Math.atan2(r10, r00);
  } else {
    x = Math.atan2(-m[9] / (sz || 1), r11);
    z = 0;
    void r01;
  }
  return { t: [m[12], m[13], m[14]], r: [x, y, z], s: [sx, sy, sz] };
}

export function transformPoint(m: ArrayLike<number>, p: Float32Array, i: number, out: Float32Array, o: number) {
  const x = p[i],
    y = p[i + 1],
    z = p[i + 2];
  out[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

export function transformPositions(m: ArrayLike<number>, p: Float32Array): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) transformPoint(m, p, i, out, i);
  return out;
}

/** Transform direction vectors by the inverse transpose (normals) and renormalize. */
export function transformNormals(m: ArrayLike<number>, n: Float32Array): Float32Array {
  const inv = invertMat(m);
  const out = new Float32Array(n.length);
  for (let i = 0; i < n.length; i += 3) {
    const x = n[i],
      y = n[i + 1],
      z = n[i + 2];
    // transpose of inverse: rows of inv
    const a = inv[0] * x + inv[1] * y + inv[2] * z,
      b = inv[4] * x + inv[5] * y + inv[6] * z,
      c = inv[8] * x + inv[9] * y + inv[10] * z;
    const l = Math.hypot(a, b, c) || 1;
    out[i] = a / l;
    out[i + 1] = b / l;
    out[i + 2] = c / l;
  }
  return out;
}

export function isIdentity(m: ArrayLike<number>) {
  for (let i = 0; i < 16; i++) if (Math.abs(m[i] - (i % 5 === 0 ? 1 : 0)) > 1e-9) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Bounds and counts

export function geometryBounds(g: GeometrySet, useRadius = true): { min: [number, number, number]; max: [number, number, number] } | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const addPos = (p: Float32Array, radius?: AttrArray) => {
    for (let i = 0, v = 0; i < p.length; i += 3, v++) {
      const r = useRadius && radius ? radius[v] : 0;
      for (let k = 0; k < 3; k++) {
        if (p[i + k] - r < min[k]) min[k] = p[i + k] - r;
        if (p[i + k] + r > max[k]) max[k] = p[i + k] + r;
      }
    }
  };
  if (g.mesh) addPos(g.mesh.positions);
  if (g.points) addPos(g.points.positions, g.points.attrs.get('radius')?.data);
  if (g.curves) addPos(g.curves.positions, g.curves.attrs.get('radius')?.data);
  if (g.instances) {
    const inst = g.instances;
    for (let i = 0; i < inst.count; i++) {
      const ref = inst.references[inst.refIndex[i]];
      if (!ref) continue;
      const b = geometryBounds(ref.geometry, useRadius);
      if (!b) continue;
      const m = inst.transforms.subarray(i * 16, i * 16 + 16);
      for (let k = 0; k < 8; k++) {
        const p = new Float32Array([k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]]);
        const o = new Float32Array(3);
        transformPoint(m, p, 0, o, 0);
        for (let a = 0; a < 3; a++) {
          if (o[a] < min[a]) min[a] = o[a];
          if (o[a] > max[a]) max[a] = o[a];
        }
      }
    }
  }
  if (min[0] === Infinity) return null;
  return { min, max };
}

export function makeGatherMap(n: number): Int32Array {
  const m = new Int32Array(n);
  for (let i = 0; i < n; i++) m[i] = i;
  return m;
}

export { dataComps, allocData };
