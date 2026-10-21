// Mesh element access for scripts: vertices, edges, polygons, loops, loop triangles,
// attributes / color attributes / legacy vertex colors, custom split normals and the
// low-level construction protocol (vertices.add / edges.add / loops.add / polygons.add,
// foreach_set, then mesh.update()).
//
// Meshes store faces as corner lists; edges are derived (face edges in topology order,
// then the mesh's loose edges). Edge flags (seam, sharp, crease) live on the face corners
// whose edge starts there, so reading or writing an edge goes through those corners.
import { app } from '../app/app';
import type { AttributeType, ColorAttribute, MeshData } from '../data/types';
import { validAttributes, attrWidth, newAttribute, ATTRIBUTE_TYPES } from '../mesh/attributes';
import { buildMesh, cornerNormals, edgeTopology, faceCenter, faceVerts, polyNormal, triangulatePoly, type PolyFace } from '../mesh/mesh';
import { cow } from '../data/cow';
import { Vector } from './mathutils';
import { PropCollection, boundVector, pyError, tableOf, toPlain, touched, kwMethod } from './rna';

type Any = Record<string, unknown>;

export const meshOf = (id: string) => {
  const me = tableOf(app.doc, 'meshes')[id] as unknown as MeshData | undefined;
  if (!me) throw pyError('ReferenceError', 'Mesh has been removed');
  return me;
};

const meshPath = (id: string) => `bpy.data.meshes[${JSON.stringify(tableOf(app.doc, 'meshes')[id]?.name)}]`;

const flat = (seq: unknown): number[] => {
  const a = toPlain(seq);
  if (!Array.isArray(a)) throw pyError('TypeError', 'foreach_set: expected a sequence');
  return (a as unknown[]).flat(2).map(Number);
};

/** Copies `out` into a caller-provided list (Python passes one in) and returns it. */
function fill(out: ArrayLike<number | boolean>, seq?: unknown) {
  const arr = Array.from(out, (x) => (typeof x === 'boolean' ? x : Number(x)));
  if (Array.isArray(seq)) for (let i = 0; i < arr.length && i < seq.length; i++) seq[i] = arr[i];
  return arr;
}

function checkIndex(key: number | string, n: number) {
  if (typeof key !== 'number') throw pyError('TypeError', 'bpy_prop_collection: index must be an int');
  const i = key < 0 ? key + n : key;
  if (i < 0 || i >= n) throw pyError('IndexError', `bpy_prop_collection[index]: index ${key} out of range, size ${n}`);
  return i;
}

const unsupported = (fn: string, attr: string, ok: string[]) => pyError('TypeError', `${fn}: unsupported attribute "${attr}" (supported: ${ok.join(', ')})`);

// ---------------------------------------------------------------------------
// topology helpers (cached on the arrays, which are replaced on every change)

interface EdgeInfo {
  /** vertex pairs: face edges, then loose edges */
  verts: Uint32Array;
  faceEdges: number;
  /** corner → edge */
  cornerEdge: Uint32Array;
  /** edge → corners (CSR) */
  edgeCornerOffsets: Uint32Array;
  edgeCorners: Uint32Array;
}
const edgeInfoCache = new WeakMap<object, { loose: unknown; info: EdgeInfo }>();

export function edgeInfo(me: MeshData): EdgeInfo {
  const hit = edgeInfoCache.get(me.indices);
  if (hit && hit.loose === me.loose_edges && hit.info.cornerEdge.length === me.indices.length) return hit.info;
  const topo = edgeTopology(me);
  const nf = topo.verts.length / 2;
  const pairs: number[] = Array.from(topo.verts);
  if (me.loose_edges?.length) {
    const nv = me.positions.length / 3;
    const seen = new Set<number>();
    for (let e = 0; e < nf; e++) seen.add(topo.verts[e * 2] * nv + topo.verts[e * 2 + 1]);
    for (let i = 0; i + 1 < me.loose_edges.length; i += 2) {
      const a = Math.min(me.loose_edges[i], me.loose_edges[i + 1]),
        b = Math.max(me.loose_edges[i], me.loose_edges[i + 1]);
      if (seen.has(a * nv + b)) continue;
      seen.add(a * nv + b);
      pairs.push(me.loose_edges[i], me.loose_edges[i + 1]);
    }
  }
  const ne = pairs.length / 2;
  const counts = new Uint32Array(ne + 1);
  for (let c = 0; c < topo.cornerEdge.length; c++) counts[topo.cornerEdge[c] + 1]++;
  for (let e = 0; e < ne; e++) counts[e + 1] += counts[e];
  const corners = new Uint32Array(topo.cornerEdge.length);
  const at = counts.slice(0, ne);
  for (let c = 0; c < topo.cornerEdge.length; c++) corners[at[topo.cornerEdge[c]]++] = c;
  const info: EdgeInfo = { verts: new Uint32Array(pairs), faceEdges: nf, cornerEdge: topo.cornerEdge, edgeCornerOffsets: counts, edgeCorners: corners };
  edgeInfoCache.set(me.indices, { loose: me.loose_edges, info });
  return info;
}

const vertexNormalCache = new WeakMap<object, { pos: Float32Array; n: Float32Array }>();
/** Area-weighted vertex normals. */
export function vertexNormals(me: MeshData): Float32Array {
  const hit = vertexNormalCache.get(me.indices);
  if (hit && hit.pos === me.positions) return hit.n;
  const P = me.positions;
  const out = new Float32Array(P.length);
  for (let f = 0; f < me.offsets.length - 1; f++) {
    const s = me.offsets[f],
      e = me.offsets[f + 1];
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let c = s; c < e; c++) {
      const a = me.indices[c] * 3,
        b = me.indices[c + 1 < e ? c + 1 : s] * 3;
      nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    for (let c = s; c < e; c++) {
      const v = me.indices[c] * 3;
      out[v] += nx;
      out[v + 1] += ny;
      out[v + 2] += nz;
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]);
    if (l > 0) {
      out[i] /= l;
      out[i + 1] /= l;
      out[i + 2] /= l;
    } else {
      // loose vertices point away from the origin, as a fallback
      const lp = Math.hypot(P[i], P[i + 1], P[i + 2]) || 1;
      out[i] = P[i] / lp;
      out[i + 1] = P[i + 1] / lp;
      out[i + 2] = P[i + 2] / lp;
    }
  }
  vertexNormalCache.set(me.indices, { pos: P, n: out });
  return out;
}

/** Shading normals per corner: the custom split normals when set, else the computed ones. */
export function loopNormals(me: MeshData): Float32Array {
  if (me.custom_normals && me.custom_normals.length === me.indices.length * 3) return me.custom_normals;
  return cornerNormals(me);
}

function polyArea(me: MeshData, f: number) {
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
}

const nVerts = (me: MeshData) => me.positions.length / 3;
const nFaces = (me: MeshData) => me.offsets.length - 1;

function ensureU8(me: MeshData, key: 'select_vert' | 'hide_vert' | 'hide_poly' | 'smooth', n: number): Uint8Array {
  const cur = me[key];
  if (!cur || cur.length !== n) {
    const a = new Uint8Array(n);
    if (cur) a.set(cur.subarray(0, Math.min(n, cur.length)));
    me[key] = a;
    return a;
  }
  return cow(me, key) as Uint8Array;
}

/** Writes an edge flag to every corner on the edge. */
type EdgeKey = 'seams' | 'sharp' | 'creases' | 'bevel_weight_edge';
function setEdgeFlag(me: MeshData, key: EdgeKey, e: number, v: number) {
  const info = edgeInfo(me);
  if (e >= info.faceEdges) {
    if (v) app.report('WARNING', `edge ${e} is a loose edge: ${key === 'seams' ? 'seams' : key === 'sharp' ? 'sharp edges' : key === 'creases' ? 'creases' : 'bevel weights'} are only kept on face edges`);
    return;
  }
  const nc = me.indices.length;
  if (!me[key] || me[key]!.length !== nc) me[key] = (key === 'creases' || key === 'bevel_weight_edge' ? new Float32Array(nc) : new Uint32Array(nc)) as never;
  const arr = cow(me, key) as Float32Array | Uint32Array;
  for (let k = info.edgeCornerOffsets[e]; k < info.edgeCornerOffsets[e + 1]; k++) arr[info.edgeCorners[k]] = v;
}

function edgeFlag(me: MeshData, key: EdgeKey, e: number): number {
  const arr = me[key];
  if (!arr) return 0;
  const info = edgeInfo(me);
  if (e >= info.faceEdges) return 0;
  let v = 0;
  for (let k = info.edgeCornerOffsets[e]; k < info.edgeCornerOffsets[e + 1]; k++) v = Math.max(v, arr[info.edgeCorners[k]] ?? 0);
  return v;
}

// ---------------------------------------------------------------------------
// low-level construction: element counts grown by add(), filled by foreach_set, built by update()

interface Pending {
  loops: number[];
  loopStart: number[];
  loopTotal: number[];
  edges: number[];
}
const pending = new Map<string, Pending>();

function pendingOf(id: string): Pending {
  let p = pending.get(id);
  if (!p) {
    const me = meshOf(id);
    const nf = nFaces(me);
    p = {
      loops: Array.from(me.indices),
      loopStart: Array.from({ length: nf }, (_, f) => me.offsets[f]),
      loopTotal: Array.from({ length: nf }, (_, f) => me.offsets[f + 1] - me.offsets[f]),
      edges: Array.from(edgeInfo(me).verts),
    };
    pending.set(id, p);
  }
  return p;
}

export const hasPending = (id: string) => pending.has(id);

/** Builds faces and loose edges from what add() / foreach_set() staged (mesh.update()). */
export function commitPending(id: string) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  const me = meshOf(id);
  const nv = nVerts(me);
  const order = p.loopStart.map((_, f) => f).sort((a, b) => p.loopStart[a] - p.loopStart[b]);
  const polys: PolyFace[] = [];
  const oldSmooth = me.smooth,
    oldMat = me.material_index;
  for (const f of order) {
    const s = p.loopStart[f],
      t = p.loopTotal[f];
    if (t < 3) throw pyError('RuntimeError', `Error: polygon ${f} has ${t} loops; set loop_start and loop_total for every polygon before update()`);
    const verts = p.loops.slice(s, s + t);
    if (verts.length !== t || verts.some((v) => !(v >= 0 && v < nv))) throw pyError('RuntimeError', `Error: polygon ${f} refers to loops or vertices that don't exist (loops ${s}…${s + t - 1}, ${nv} vertices)`);
    polys.push({ verts, smooth: !!oldSmooth?.[f], material: oldMat?.[f] ?? 0 });
  }
  const keepUVs = me.uvs.length === p.loops.length * 2 && polys.length ? me.uvs : null;
  const arrays = buildMesh(me.positions, polys);
  Object.assign(me, arrays);
  if (keepUVs) me.uvs = keepUVs;
  for (const k of ['seams', 'sharp', 'creases', 'bevel_weight_edge', 'custom_normals', 'quad_flip', 'face_strength', 'hide_poly', 'sculpt_face_set'] as const) if (!(k in arrays)) delete (me as unknown as Any)[k];
  // explicit edges that no face uses become loose edges
  const faceEdge = new Set<string>();
  for (const f of polys) for (let k = 0; k < f.verts.length; k++) {
    const a = f.verts[k],
      b = f.verts[(k + 1) % f.verts.length];
    faceEdge.add(a < b ? `${a}:${b}` : `${b}:${a}`);
  }
  const loose: number[] = [];
  for (let i = 0; i + 1 < p.edges.length; i += 2) {
    const a = p.edges[i],
      b = p.edges[i + 1];
    if (a === b || !(a < nv && b < nv)) continue;
    if (!faceEdge.has(a < b ? `${a}:${b}` : `${b}:${a}`)) loose.push(a, b);
  }
  if (loose.length) me.loose_edges = new Uint32Array(loose);
  else delete me.loose_edges;
  me.color_attributes = me.color_attributes.filter((c) => c.data.length === (c.domain === 'POINT' ? nv : me.indices.length) * 4);
  touched('geometry');
  return true;
}

/** Drops staged changes (e.g. when the mesh is rebuilt another way). */
export function dropPending(id: string) {
  pending.delete(id);
}

// ---------------------------------------------------------------------------
// vertices

export class MeshVertices extends PropCollection<unknown> {
  constructor(readonly meId: string) {
    super(`${meshPath(meId)}.vertices`);
  }
  override get length() {
    return nVerts(meshOf(this.meId));
  }
  list() {
    return Array.from({ length: this.length }, (_, i) => this.vertex(i));
  }
  nameOf() {
    return '';
  }
  override getItem(key: number | string) {
    return this.vertex(checkIndex(key, this.length));
  }
  private vertex(i: number) {
    const id = this.meId;
    const path = this.__path;
    return {
      __kind: 'struct',
      __type: 'MeshVertex',
      index: i,
      get co() {
        return boundVector('VECTOR', () => meshOf(id).positions.subarray(i * 3, i * 3 + 3), (k, x) => {
          cow(meshOf(id), 'positions')[i * 3 + k] = x;
          touched('geometry');
        });
      },
      set co(v: unknown) {
        const a = toPlain(v) as number[];
        const p = cow(meshOf(id), 'positions');
        for (let k = 0; k < 3; k++) p[i * 3 + k] = Number(a[k] ?? 0);
        touched('geometry');
      },
      get undeformed_co() {
        return new Vector(Array.from(meshOf(id).positions.subarray(i * 3, i * 3 + 3)));
      },
      get normal() {
        const n = vertexNormals(meshOf(id));
        return new Vector([n[i * 3], n[i * 3 + 1], n[i * 3 + 2]]);
      },
      get select() {
        return !!meshOf(id).select_vert?.[i];
      },
      set select(v: boolean) {
        const me = meshOf(id);
        ensureU8(me, 'select_vert', nVerts(me))[i] = v ? 1 : 0;
        touched('select');
      },
      get hide() {
        return !!meshOf(id).hide_vert?.[i];
      },
      set hide(v: boolean) {
        const me = meshOf(id);
        ensureU8(me, 'hide_vert', nVerts(me))[i] = v ? 1 : 0;
        touched('select');
      },
      /** Vertex groups this vertex is in: [{group, weight}]. */
      get groups() {
        const me = meshOf(id);
        const out: { __kind: string; __type: string; group: number; weight: number }[] = [];
        me.weights.forEach((w, g) => {
          if (w[i] > 0) out.push({ __kind: 'struct', __type: 'VertexGroupElement', group: g, weight: w[i] });
        });
        return out;
      },
      toString: () => `<bpy_struct, MeshVertex at ${path}[${i}]>`,
    };
  }
  /** Appends `count` vertices at the origin; faces can then be staged with loops.add / polygons.add. */
  add(count: number) {
    const n = Math.max(0, Math.round(Number(count)));
    const me = meshOf(this.meId);
    const nv = nVerts(me);
    const p = new Float32Array(me.positions.length + n * 3);
    p.set(me.positions);
    me.positions = p;
    me.weights = me.weights.map((w) => {
      const a = new Float32Array(nv + n);
      a.set(w.subarray(0, nv));
      return a;
    });
    for (const k of me.shape_keys) {
      const a = new Float32Array(p.length);
      a.set(k.data.subarray(0, nv * 3));
      k.data = a;
    }
    for (const key of ['select_vert', 'hide_vert'] as const)
      if (me[key]) {
        const a = new Uint8Array(nv + n);
        a.set(me[key]!.subarray(0, nv));
        me[key] = a;
      }
    if (me.sculpt_mask) {
      const a = new Float32Array(nv + n);
      a.set(me.sculpt_mask.subarray(0, nv));
      me.sculpt_mask = a;
    }
    for (const c of me.color_attributes)
      if (c.domain === 'POINT') {
        const a = new Float32Array((nv + n) * 4).fill(1);
        a.set(c.data.subarray(0, nv * 4));
        c.data = a;
      }
    touched('geometry');
  }
  foreach_get(attr: string, seq?: unknown) {
    const me = meshOf(this.meId);
    const nv = nVerts(me);
    switch (attr) {
      case 'co':
      case 'undeformed_co':
        return fill(me.positions, seq);
      case 'normal':
        return fill(vertexNormals(me), seq);
      case 'select':
        return fill(Array.from({ length: nv }, (_, i) => !!me.select_vert?.[i]), seq);
      case 'hide':
        return fill(Array.from({ length: nv }, (_, i) => !!me.hide_vert?.[i]), seq);
      case 'index':
        return fill(Array.from({ length: nv }, (_, i) => i), seq);
    }
    throw unsupported('foreach_get', attr, ['co', 'normal', 'select', 'hide', 'index']);
  }
  foreach_set(attr: string, seq: unknown) {
    const me = meshOf(this.meId);
    const a = flat(seq);
    const nv = nVerts(me);
    const want = attr === 'co' ? nv * 3 : nv;
    if (a.length !== want) throw pyError('ValueError', `foreach_set: expected ${want} values, got ${a.length}`);
    if (attr === 'co') me.positions = Float32Array.from(a);
    else if (attr === 'select') me.select_vert = Uint8Array.from(a, (x) => (x ? 1 : 0));
    else if (attr === 'hide') me.hide_vert = Uint8Array.from(a, (x) => (x ? 1 : 0));
    else throw unsupported('foreach_set', attr, ['co', 'select', 'hide']);
    touched(attr === 'co' ? 'geometry' : 'select');
  }
}
kwMethod(MeshVertices.prototype, 'add', ['count']);

// ---------------------------------------------------------------------------
// edges

export class MeshEdges extends PropCollection<unknown> {
  constructor(readonly meId: string) {
    super(`${meshPath(meId)}.edges`);
  }
  override get length() {
    const p = pending.get(this.meId);
    return p ? p.edges.length / 2 : edgeInfo(meshOf(this.meId)).verts.length / 2;
  }
  list() {
    return Array.from({ length: this.length }, (_, i) => this.edge(i));
  }
  nameOf() {
    return '';
  }
  override getItem(key: number | string) {
    return this.edge(checkIndex(key, this.length));
  }
  private edge(e: number) {
    const id = this.meId;
    const path = this.__path;
    const verts = () => {
      const p = pending.get(id);
      const v = p ? p.edges : edgeInfo(meshOf(id)).verts;
      return [v[e * 2], v[e * 2 + 1]];
    };
    const flagProp = (key: 'seams' | 'sharp' | 'creases', bool: boolean) => ({
      get: () => (bool ? !!edgeFlag(meshOf(id), key, e) : edgeFlag(meshOf(id), key, e)),
      set: (v: unknown) => {
        setEdgeFlag(meshOf(id), key, e, bool ? (v ? 1 : 0) : Math.max(0, Math.min(1, Number(v))));
        touched('geometry');
      },
      enumerable: true,
    });
    const o = {
      __kind: 'struct',
      __type: 'MeshEdge',
      index: e,
      get vertices() {
        return verts();
      },
      set vertices(v: unknown) {
        const a = flat(v);
        pendingOf(id).edges.splice(e * 2, 2, a[0], a[1]);
      },
      get key() {
        const [a, b] = verts();
        return [Math.min(a, b), Math.max(a, b)];
      },
      get is_loose() {
        return e >= edgeInfo(meshOf(id)).faceEdges;
      },
      get select() {
        const me = meshOf(id);
        const [a, b] = verts();
        return !!me.select_vert?.[a] && !!me.select_vert?.[b];
      },
      set select(v: boolean) {
        const me = meshOf(id);
        const s = ensureU8(me, 'select_vert', nVerts(me));
        for (const x of verts()) s[x] = v ? 1 : 0;
        touched('select');
      },
      get hide() {
        const me = meshOf(id);
        const [a, b] = verts();
        return !!me.hide_vert?.[a] && !!me.hide_vert?.[b];
      },
      toString: () => `<bpy_struct, MeshEdge at ${path}[${e}]>`,
    };
    return Object.defineProperties(o, { use_seam: flagProp('seams', true), use_edge_sharp: flagProp('sharp', true), crease: flagProp('creases', false) });
  }
  /** Appends `count` edges (vertices 0, 0) to fill with foreach_set('vertices', …) before mesh.update(). */
  add(count: number) {
    const p = pendingOf(this.meId);
    for (let i = 0; i < Math.max(0, Math.round(Number(count))); i++) p.edges.push(0, 0);
  }
  foreach_get(attr: string, seq?: unknown) {
    const me = meshOf(this.meId);
    const n = this.length;
    const p = pending.get(this.meId);
    switch (attr) {
      case 'vertices':
        return fill(p ? p.edges : edgeInfo(me).verts, seq);
      case 'use_seam':
      case 'use_edge_sharp':
        return fill(Array.from({ length: n }, (_, e) => !!edgeFlag(me, attr === 'use_seam' ? 'seams' : 'sharp', e)), seq);
      case 'crease':
        return fill(Array.from({ length: n }, (_, e) => edgeFlag(me, 'creases', e)), seq);
      case 'is_loose': {
        const f = edgeInfo(me).faceEdges;
        return fill(Array.from({ length: n }, (_, e) => e >= f), seq);
      }
      case 'select':
        return fill((this.list() as { select: boolean }[]).map((x) => x.select), seq);
    }
    throw unsupported('foreach_get', attr, ['vertices', 'use_seam', 'use_edge_sharp', 'crease', 'is_loose', 'select']);
  }
  foreach_set(attr: string, seq: unknown) {
    const a = flat(seq);
    if (attr === 'vertices') {
      const p = pendingOf(this.meId);
      if (a.length !== p.edges.length) throw pyError('ValueError', `foreach_set: expected ${p.edges.length} values (2 per edge), got ${a.length}`);
      p.edges = a.map((x) => Math.round(x));
      return;
    }
    const me = meshOf(this.meId);
    const n = this.length;
    if (a.length !== n) throw pyError('ValueError', `foreach_set: expected ${n} values, got ${a.length}`);
    const key = attr === 'use_seam' ? 'seams' : attr === 'use_edge_sharp' ? 'sharp' : attr === 'crease' ? 'creases' : null;
    if (!key) throw unsupported('foreach_set', attr, ['vertices', 'use_seam', 'use_edge_sharp', 'crease']);
    for (let e = 0; e < n; e++) setEdgeFlag(me, key, e, key === 'creases' ? a[e] : a[e] ? 1 : 0);
    touched('geometry');
  }
}
kwMethod(MeshEdges.prototype, 'add', ['count']);

// ---------------------------------------------------------------------------
// polygons

export class MeshPolygons extends PropCollection<unknown> {
  constructor(readonly meId: string) {
    super(`${meshPath(meId)}.polygons`);
  }
  override get length() {
    const p = pending.get(this.meId);
    return p ? p.loopStart.length : nFaces(meshOf(this.meId));
  }
  list() {
    return Array.from({ length: this.length }, (_, i) => this.poly(i));
  }
  nameOf() {
    return '';
  }
  override getItem(key: number | string) {
    return this.poly(checkIndex(key, this.length));
  }
  get active() {
    return 0;
  }
  private poly(f: number) {
    const id = this.meId;
    const path = this.__path;
    return {
      __kind: 'struct',
      __type: 'MeshPolygon',
      index: f,
      get vertices() {
        return faceVerts(meshOf(id), f);
      },
      set vertices(v: unknown) {
        const me = meshOf(id);
        const a = flat(v);
        const s = me.offsets[f],
          e = me.offsets[f + 1];
        if (a.length !== e - s) throw pyError('ValueError', `MeshPolygon.vertices: expected ${e - s} indices (the polygon's size), got ${a.length}`);
        const idx = cow(me, 'indices');
        a.forEach((x, k) => (idx[s + k] = x));
        touched('geometry');
      },
      get loop_start() {
        const p = pending.get(id);
        return p ? p.loopStart[f] : meshOf(id).offsets[f];
      },
      get loop_total() {
        const p = pending.get(id);
        if (p) return p.loopTotal[f];
        const me = meshOf(id);
        return me.offsets[f + 1] - me.offsets[f];
      },
      get loop_indices() {
        const me = meshOf(id);
        return Array.from({ length: me.offsets[f + 1] - me.offsets[f] }, (_, k) => me.offsets[f] + k);
      },
      get edge_keys() {
        const vs = faceVerts(meshOf(id), f);
        return vs.map((a, k) => {
          const b = vs[(k + 1) % vs.length];
          return [Math.min(a, b), Math.max(a, b)];
        });
      },
      get normal() {
        const me = meshOf(id);
        return new Vector(polyNormal(me.positions, faceVerts(me, f)));
      },
      get center() {
        return new Vector(faceCenter(meshOf(id), f));
      },
      get area() {
        return polyArea(meshOf(id), f);
      },
      get use_smooth() {
        return !!meshOf(id).smooth?.[f];
      },
      set use_smooth(v: boolean) {
        const me = meshOf(id);
        ensureU8(me, 'smooth', nFaces(me))[f] = v ? 1 : 0;
        touched('geometry');
      },
      get material_index() {
        return meshOf(id).material_index?.[f] ?? 0;
      },
      set material_index(v: number) {
        const me = meshOf(id);
        if (!me.material_index || me.material_index.length !== nFaces(me)) me.material_index = new Uint16Array(nFaces(me));
        cow(me, 'material_index')![f] = Math.max(0, Math.round(v));
        touched('geometry');
      },
      get select() {
        const me = meshOf(id);
        return faceVerts(me, f).every((v) => me.select_vert?.[v]);
      },
      set select(v: boolean) {
        const me = meshOf(id);
        const s = ensureU8(me, 'select_vert', nVerts(me));
        for (const x of faceVerts(me, f)) s[x] = v ? 1 : 0;
        touched('select');
      },
      get hide() {
        return !!meshOf(id).hide_poly?.[f];
      },
      set hide(v: boolean) {
        const me = meshOf(id);
        ensureU8(me, 'hide_poly', nFaces(me))[f] = v ? 1 : 0;
        touched('select');
      },
      /** Reverses the corner order (and so the normal). */
      flip() {
        const me = meshOf(id);
        const s = me.offsets[f],
          e = me.offsets[f + 1];
        const idx = cow(me, 'indices');
        const vs = Array.from(idx.subarray(s, e));
        const rev = [vs[0], ...vs.slice(1).reverse()];
        rev.forEach((x, k) => (idx[s + k] = x));
        touched('geometry');
      },
      toString: () => `<bpy_struct, MeshPolygon at ${path}[${f}]>`,
    };
  }
  /** Appends `count` polygons; set loop_start / loop_total with foreach_set, then mesh.update(). */
  add(count: number) {
    const p = pendingOf(this.meId);
    for (let i = 0; i < Math.max(0, Math.round(Number(count))); i++) {
      p.loopStart.push(0);
      p.loopTotal.push(0);
    }
  }
  foreach_get(attr: string, seq?: unknown) {
    const me = meshOf(this.meId);
    const nf = nFaces(me);
    const p = pending.get(this.meId);
    const per = <T>(fn: (f: number) => T) => Array.from({ length: nf }, (_, f) => fn(f));
    switch (attr) {
      case 'use_smooth':
        return fill(per((f) => !!me.smooth?.[f]), seq);
      case 'material_index':
        return fill(per((f) => me.material_index?.[f] ?? 0), seq);
      case 'loop_start':
        return fill(p ? p.loopStart : per((f) => me.offsets[f]), seq);
      case 'loop_total':
        return fill(p ? p.loopTotal : per((f) => me.offsets[f + 1] - me.offsets[f]), seq);
      case 'normal':
        return fill(per((f) => polyNormal(me.positions, faceVerts(me, f))).flat(), seq);
      case 'center':
        return fill(per((f) => faceCenter(me, f)).flat(), seq);
      case 'area':
        return fill(per((f) => polyArea(me, f)), seq);
      case 'select':
        return fill(per((f) => faceVerts(me, f).every((v) => me.select_vert?.[v])), seq);
      case 'hide':
        return fill(per((f) => !!me.hide_poly?.[f]), seq);
      case 'vertices':
        return fill(me.indices, seq);
    }
    throw unsupported('foreach_get', attr, ['use_smooth', 'material_index', 'loop_start', 'loop_total', 'normal', 'center', 'area', 'select', 'hide', 'vertices']);
  }
  foreach_set(attr: string, seq: unknown) {
    const a = flat(seq);
    if (attr === 'loop_start' || attr === 'loop_total') {
      const p = pendingOf(this.meId);
      if (a.length !== p.loopStart.length) throw pyError('ValueError', `foreach_set: expected ${p.loopStart.length} values, got ${a.length}`);
      if (attr === 'loop_start') p.loopStart = a.map((x) => Math.round(x));
      else p.loopTotal = a.map((x) => Math.round(x));
      return;
    }
    const me = meshOf(this.meId);
    const nf = nFaces(me);
    if (attr === 'vertices') {
      if (a.length !== me.indices.length) throw pyError('ValueError', `foreach_set: expected ${me.indices.length} values (one per loop), got ${a.length}`);
      me.indices = Uint32Array.from(a);
      dropPending(this.meId);
      touched('geometry');
      return;
    }
    if (a.length !== nf) throw pyError('ValueError', `foreach_set: expected ${nf} values, got ${a.length}`);
    if (attr === 'use_smooth') me.smooth = Uint8Array.from(a, (x) => (x ? 1 : 0));
    else if (attr === 'material_index') me.material_index = Uint16Array.from(a, (x) => Math.max(0, Math.round(x)));
    else if (attr === 'hide') me.hide_poly = Uint8Array.from(a, (x) => (x ? 1 : 0));
    else if (attr === 'select') {
      const s = ensureU8(me, 'select_vert', nVerts(me));
      for (let f = 0; f < nf; f++) if (a[f]) for (const v of faceVerts(me, f)) s[v] = 1;
    } else throw unsupported('foreach_set', attr, ['use_smooth', 'material_index', 'hide', 'select', 'loop_start', 'loop_total']);
    touched('geometry');
  }
}
kwMethod(MeshPolygons.prototype, 'add', ['count']);

// ---------------------------------------------------------------------------
// loops

export class MeshLoops extends PropCollection<unknown> {
  constructor(readonly meId: string) {
    super(`${meshPath(meId)}.loops`);
  }
  override get length() {
    const p = pending.get(this.meId);
    return p ? p.loops.length : meshOf(this.meId).indices.length;
  }
  list() {
    return Array.from({ length: this.length }, (_, i) => this.loop(i));
  }
  nameOf() {
    return '';
  }
  override getItem(key: number | string) {
    return this.loop(checkIndex(key, this.length));
  }
  private loop(i: number) {
    const id = this.meId;
    const path = this.__path;
    return {
      __kind: 'struct',
      __type: 'MeshLoop',
      index: i,
      get vertex_index() {
        const p = pending.get(id);
        return p ? p.loops[i] : meshOf(id).indices[i];
      },
      set vertex_index(v: number) {
        const p = pending.get(id);
        if (p) p.loops[i] = Math.round(Number(v));
        else {
          cow(meshOf(id), 'indices')[i] = Math.round(Number(v));
          touched('geometry');
        }
      },
      get edge_index() {
        return edgeInfo(meshOf(id)).cornerEdge[i];
      },
      get normal() {
        const n = loopNormals(meshOf(id));
        return new Vector([n[i * 3], n[i * 3 + 1], n[i * 3 + 2]]);
      },
      toString: () => `<bpy_struct, MeshLoop at ${path}[${i}]>`,
    };
  }
  /** Appends `count` loops (vertex 0) to fill with foreach_set('vertex_index', …) before mesh.update(). */
  add(count: number) {
    const p = pendingOf(this.meId);
    for (let i = 0; i < Math.max(0, Math.round(Number(count))); i++) p.loops.push(0);
  }
  foreach_get(attr: string, seq?: unknown) {
    const me = meshOf(this.meId);
    const p = pending.get(this.meId);
    if (attr === 'vertex_index') return fill(p ? p.loops : me.indices, seq);
    if (attr === 'edge_index') return fill(edgeInfo(me).cornerEdge, seq);
    if (attr === 'normal') return fill(loopNormals(me), seq);
    throw unsupported('foreach_get', attr, ['vertex_index', 'edge_index', 'normal']);
  }
  foreach_set(attr: string, seq: unknown) {
    if (attr !== 'vertex_index') throw unsupported('foreach_set', attr, ['vertex_index']);
    const a = flat(seq);
    const p = pending.get(this.meId);
    if (p) {
      if (a.length !== p.loops.length) throw pyError('ValueError', `foreach_set: expected ${p.loops.length} values, got ${a.length}`);
      p.loops = a.map((x) => Math.round(x));
      return;
    }
    const me = meshOf(this.meId);
    if (a.length !== me.indices.length) throw pyError('ValueError', `foreach_set: expected ${me.indices.length} values, got ${a.length}`);
    me.indices = Uint32Array.from(a);
    touched('geometry');
  }
}
kwMethod(MeshLoops.prototype, 'add', ['count']);

// ---------------------------------------------------------------------------
// loop triangles

export class MeshLoopTriangles extends PropCollection<unknown> {
  constructor(readonly meId: string) {
    super(`${meshPath(meId)}.loop_triangles`);
  }
  private tris(): { loops: number[]; poly: number[] } {
    const me = meshOf(this.meId);
    const loops: number[] = [],
      poly: number[] = [],
      tmp: number[] = [];
    for (let f = 0; f < nFaces(me); f++) {
      const s = me.offsets[f];
      tmp.length = 0;
      triangulatePoly(me.positions, me.indices.subarray(s, me.offsets[f + 1]), tmp, s);
      for (const c of tmp) loops.push(c);
      for (let k = 0; k < tmp.length / 3; k++) poly.push(f);
    }
    return { loops, poly };
  }
  override get length() {
    return this.tris().poly.length;
  }
  list() {
    const t = this.tris();
    return t.poly.map((_, i) => this.tri(i, t));
  }
  nameOf() {
    return '';
  }
  override getItem(key: number | string) {
    const t = this.tris();
    return this.tri(checkIndex(key, t.poly.length), t);
  }
  private tri(i: number, t: { loops: number[]; poly: number[] }) {
    const me = meshOf(this.meId);
    const loops = t.loops.slice(i * 3, i * 3 + 3);
    const verts = loops.map((c) => me.indices[c]);
    const f = t.poly[i];
    const P = me.positions;
    const ln = loopNormals(me);
    return {
      __kind: 'struct',
      __type: 'MeshLoopTriangle',
      index: i,
      loops,
      vertices: verts,
      polygon_index: f,
      material_index: me.material_index?.[f] ?? 0,
      use_smooth: !!me.smooth?.[f],
      normal: new Vector(polyNormal(P, verts)),
      center: new Vector([0, 1, 2].map((k) => (P[verts[0] * 3 + k] + P[verts[1] * 3 + k] + P[verts[2] * 3 + k]) / 3)),
      area: polyArea({ positions: P, offsets: Uint32Array.of(0, 3), indices: Uint32Array.from(verts) } as MeshData, 0),
      split_normals: loops.map((c) => [ln[c * 3], ln[c * 3 + 1], ln[c * 3 + 2]]),
    };
  }
  foreach_get(attr: string, seq?: unknown) {
    const t = this.tris();
    const me = meshOf(this.meId);
    if (attr === 'loops') return fill(t.loops, seq);
    if (attr === 'vertices') return fill(t.loops.map((c) => me.indices[c]), seq);
    if (attr === 'polygon_index') return fill(t.poly, seq);
    if (attr === 'material_index') return fill(t.poly.map((f) => me.material_index?.[f] ?? 0), seq);
    throw unsupported('foreach_get', attr, ['loops', 'vertices', 'polygon_index', 'material_index']);
  }
}

// ---------------------------------------------------------------------------
// attributes

type Domain = 'POINT' | 'EDGE' | 'FACE' | 'CORNER';
interface AttrDef {
  name: string;
  domain: Domain;
  data_type: string;
  /** components per element */
  width: number;
  read(me: MeshData): ArrayLike<number>;
  write?(me: MeshData, values: number[]): void;
  remove?(me: MeshData): void;
  is_internal?: boolean;
  is_required?: boolean;
}

const domainSize = (me: MeshData, d: Domain) => (d === 'POINT' ? nVerts(me) : d === 'FACE' ? nFaces(me) : d === 'CORNER' ? me.indices.length : edgeInfo(me).verts.length / 2);

function builtinAttributes(me: MeshData): AttrDef[] {
  const out: AttrDef[] = [
    { name: 'position', domain: 'POINT', data_type: 'FLOAT_VECTOR', width: 3, read: (m) => m.positions, write: (m, v) => (m.positions = Float32Array.from(v)), is_required: true },
    { name: '.edge_verts', domain: 'EDGE', data_type: 'INT32_2D', width: 2, read: (m) => edgeInfo(m).verts, is_internal: true, is_required: true },
    { name: '.corner_vert', domain: 'CORNER', data_type: 'INT', width: 1, read: (m) => m.indices, is_internal: true, is_required: true },
    { name: '.corner_edge', domain: 'CORNER', data_type: 'INT', width: 1, read: (m) => edgeInfo(m).cornerEdge, is_internal: true, is_required: true },
  ];
  if (me.smooth?.some((s) => !s) || me.smooth === undefined)
    out.push({ name: 'sharp_face', domain: 'FACE', data_type: 'BOOLEAN', width: 1, read: (m) => Array.from({ length: nFaces(m) }, (_, f) => (m.smooth?.[f] ? 0 : 1)), write: (m, v) => (m.smooth = Uint8Array.from(v, (x) => (x ? 0 : 1))), remove: (m) => (m.smooth = new Uint8Array(nFaces(m)).fill(1)) });
  if (me.material_index?.some((x) => x))
    out.push({ name: 'material_index', domain: 'FACE', data_type: 'INT', width: 1, read: (m) => m.material_index ?? new Uint16Array(nFaces(m)), write: (m, v) => (m.material_index = Uint16Array.from(v)), remove: (m) => delete m.material_index });
  const edgeAttr = (name: string, key: EdgeKey, type: string): AttrDef => ({
    name,
    domain: 'EDGE',
    data_type: type,
    width: 1,
    read: (m) => Array.from({ length: edgeInfo(m).verts.length / 2 }, (_, e) => edgeFlag(m, key, e)),
    write: (m, v) => v.forEach((x, e) => setEdgeFlag(m, key, e, x)),
    remove: (m) => delete m[key],
  });
  if (me.sharp?.some((x) => x)) out.push(edgeAttr('sharp_edge', 'sharp', 'BOOLEAN'));
  if (me.creases?.some((x) => x)) out.push(edgeAttr('crease_edge', 'creases', 'FLOAT'));
  if (me.seams?.some((x) => x)) out.push(edgeAttr('.uv_seam', 'seams', 'BOOLEAN'));
  if (me.bevel_weight_edge) out.push(edgeAttr('bevel_weight_edge', 'bevel_weight_edge', 'FLOAT'));
  for (const k of ['bevel_weight_vert', 'crease_vert'] as const)
    if (me[k]) out.push({ name: k, domain: 'POINT', data_type: 'FLOAT', width: 1, read: (m) => m[k] ?? [], write: (m, v) => (m[k] = Float32Array.from(v)), remove: (m) => delete m[k] });
  if (me.select_vert) out.push({ name: '.select_vert', domain: 'POINT', data_type: 'BOOLEAN', width: 1, read: (m) => m.select_vert ?? [], write: (m, v) => (m.select_vert = Uint8Array.from(v, (x) => (x ? 1 : 0))), remove: (m) => delete m.select_vert, is_internal: true });
  if (me.hide_vert) out.push({ name: '.hide_vert', domain: 'POINT', data_type: 'BOOLEAN', width: 1, read: (m) => m.hide_vert ?? [], write: (m, v) => (m.hide_vert = Uint8Array.from(v, (x) => (x ? 1 : 0))), remove: (m) => delete m.hide_vert, is_internal: true });
  if (me.hide_poly) out.push({ name: '.hide_poly', domain: 'FACE', data_type: 'BOOLEAN', width: 1, read: (m) => m.hide_poly ?? [], write: (m, v) => (m.hide_poly = Uint8Array.from(v, (x) => (x ? 1 : 0))), remove: (m) => delete m.hide_poly, is_internal: true });
  if (me.sculpt_face_set) out.push({ name: '.sculpt_face_set', domain: 'FACE', data_type: 'INT', width: 1, read: (m) => m.sculpt_face_set ?? [], write: (m, v) => (m.sculpt_face_set = Int32Array.from(v)), remove: (m) => delete m.sculpt_face_set, is_internal: true });
  if (me.sculpt_mask) out.push({ name: '.sculpt_mask', domain: 'POINT', data_type: 'FLOAT', width: 1, read: (m) => m.sculpt_mask ?? [], write: (m, v) => (m.sculpt_mask = Float32Array.from(v)), remove: (m) => delete m.sculpt_mask, is_internal: true });
  if (me.custom_normals) out.push({ name: 'custom_normal', domain: 'CORNER', data_type: 'FLOAT_VECTOR', width: 3, read: (m) => m.custom_normals ?? [], write: (m, v) => (m.custom_normals = Float32Array.from(v)), remove: (m) => delete m.custom_normals });
  if (me.uvs.length && me.uvs.length === me.indices.length * 2) out.push({ name: me.uv_map_name || 'UVMap', domain: 'CORNER', data_type: 'FLOAT2', width: 2, read: (m) => m.uvs, write: (m, v) => (m.uvs = Float32Array.from(v)) });
  for (const g of validAttributes(me)) {
    out.push({
      name: g.name,
      domain: g.domain,
      data_type: g.data_type,
      width: attrWidth(g.data_type),
      // EDGE values are stored per corner: read / write them per edge
      read: (m) => {
        const cur = validAttributes(m).find((x) => x.name === g.name);
        if (!cur) return [];
        if (cur.domain !== 'EDGE') return cur.data;
        const info = edgeInfo(m);
        const w = attrWidth(cur.data_type);
        const nc = m.indices.length;
        const ne = info.verts.length / 2;
        const out: number[] = [];
        for (let e = 0; e < ne; e++) {
          const c = e < info.faceEdges ? info.edgeCorners[info.edgeCornerOffsets[e]] : nc + (e - info.faceEdges);
          for (let k = 0; k < w; k++) out.push(cur.data[c * w + k] ?? 0);
        }
        return out;
      },
      write: (m, v) => {
        const cur = validAttributes(m).find((x) => x.name === g.name);
        if (!cur) return;
        const data = cur.data.slice();
        const w = attrWidth(cur.data_type);
        if (cur.domain !== 'EDGE') data.set(v.slice(0, data.length));
        else {
          const info = edgeInfo(m);
          const nc = m.indices.length;
          for (let e = 0; e < info.verts.length / 2; e++) {
            const vals = v.slice(e * w, (e + 1) * w);
            if (e < info.faceEdges) for (let k = info.edgeCornerOffsets[e]; k < info.edgeCornerOffsets[e + 1]; k++) data.set(vals, info.edgeCorners[k] * w);
            else data.set(vals, (nc + e - info.faceEdges) * w);
          }
        }
        m.attributes = validAttributes(m).map((x) => (x === cur ? { ...cur, data } : x));
      },
      remove: (m) => (m.attributes = validAttributes(m).filter((x) => x.name !== g.name)),
    });
  }
  for (const c of me.color_attributes) {
    out.push({
      name: c.name,
      domain: c.domain,
      data_type: (c as ColorAttribute & { data_type?: string }).data_type ?? 'FLOAT_COLOR',
      width: 4,
      read: () => c.data,
      write: (m, v) => {
        const cur = m.color_attributes.find((x) => x.name === c.name);
        if (cur) cur.data = Float32Array.from(v);
      },
      remove: (m) => removeColorAttribute(m, c.name),
    });
  }
  return out;
}

function removeColorAttribute(me: MeshData, name: string) {
  const i = me.color_attributes.findIndex((c) => c.name === name);
  if (i < 0) return;
  me.color_attributes.splice(i, 1);
  me.active_color_index = Math.min(me.active_color_index, me.color_attributes.length - 1);
}

const ATTR_VALUE_KEY: Record<string, string> = { FLOAT: 'value', INT: 'value', BOOLEAN: 'value', INT8: 'value', FLOAT_VECTOR: 'vector', FLOAT2: 'vector', INT32_2D: 'value', FLOAT_COLOR: 'color', BYTE_COLOR: 'color', QUATERNION: 'value' };

function attributeStruct(meId: string, name: string, path: string) {
  const def = () => {
    const d = builtinAttributes(meshOf(meId)).find((a) => a.name === name);
    if (!d) throw pyError('ReferenceError', `attribute "${name}" has been removed`);
    return d;
  };
  const d0 = def();
  const valueKey = ATTR_VALUE_KEY[d0.data_type] ?? 'value';
  const n = () => domainSize(meshOf(meId), def().domain);
  const write = (values: number[]) => {
    const d = def();
    if (!d.write) throw pyError('AttributeError', `attribute "${name}" is read-only`);
    d.write(meshOf(meId), values);
    touched('geometry');
  };
  const element = (i: number) => {
    const get = () => {
      const d = def();
      const a = d.read(meshOf(meId));
      return Array.from({ length: d.width }, (_, k) => Number(a[i * d.width + k] ?? 0));
    };
    const setAt = (k: number, x: number) => {
      const d = def();
      const vals = Array.from(d.read(meshOf(meId)), Number);
      vals[i * d.width + k] = x;
      write(vals);
    };
    const o: Any = { __kind: 'struct', __type: `${d0.data_type === 'FLOAT_COLOR' || d0.data_type === 'BYTE_COLOR' ? 'FloatColor' : d0.width > 1 ? 'FloatVector' : 'Float'}AttributeValue`, index: i };
    Object.defineProperty(o, valueKey, {
      get: () => {
        const v = get();
        if (d0.width === 1) return d0.data_type === 'BOOLEAN' ? !!v[0] : v[0];
        return boundVector(valueKey === 'color' ? 'COLOR' : 'VECTOR', get, setAt);
      },
      set: (v: unknown) => {
        const a = d0.width === 1 ? [Number(toPlain(v))] : flat(v);
        const d = def();
        const vals = Array.from(d.read(meshOf(meId)), Number);
        for (let k = 0; k < d.width; k++) vals[i * d.width + k] = a[k] ?? vals[i * d.width + k];
        write(vals);
      },
      enumerable: true,
    });
    if (valueKey === 'color') Object.defineProperty(o, 'color_srgb', Object.getOwnPropertyDescriptor(o, 'color')!);
    return o;
  };
  const data = new (class extends PropCollection<unknown> {
    override get length() {
      return n();
    }
    list() {
      return Array.from({ length: n() }, (_, i) => element(i));
    }
    nameOf() {
      return '';
    }
    override getItem(key: number | string) {
      return element(checkIndex(key, n()));
    }
    foreach_get(attr: string, seq?: unknown) {
      return foreachGet(attr, seq);
    }
    foreach_set(attr: string, seq: unknown) {
      foreachSet(attr, seq);
    }
  })(`${path}.data`);
  const foreachGet = (attr: string, seq?: unknown) => {
    if (attr !== valueKey && !(valueKey === 'color' && attr === 'color_srgb')) throw unsupported('foreach_get', attr, [valueKey]);
    const d = def();
    const a = d.read(meshOf(meId));
    return fill(d.data_type === 'BOOLEAN' ? Array.from(a, (x) => !!x) : a, seq);
  };
  const foreachSet = (attr: string, seq: unknown) => {
    if (attr !== valueKey && !(valueKey === 'color' && attr === 'color_srgb')) throw unsupported('foreach_set', attr, [valueKey]);
    const a = flat(seq);
    const want = n() * def().width;
    if (a.length !== want) throw pyError('ValueError', `foreach_set: expected ${want} values, got ${a.length}`);
    write(a);
  };
  return {
    __kind: 'struct',
    __type: d0.data_type === 'FLOAT_COLOR' || d0.data_type === 'BYTE_COLOR' ? (d0.data_type === 'BYTE_COLOR' ? 'ByteColorAttribute' : 'FloatColorAttribute') : 'Attribute',
    name,
    domain: d0.domain,
    data_type: d0.data_type,
    is_internal: !!d0.is_internal,
    is_required: !!d0.is_required,
    data,
    foreach_get: foreachGet,
    foreach_set: foreachSet,
    toString: () => `<bpy_struct, Attribute("${name}") at ${path}>`,
  };
}

export class MeshAttributes extends PropCollection<unknown> {
  constructor(
    readonly meId: string,
    readonly colorsOnly = false,
  ) {
    super(`${meshPath(meId)}.${colorsOnly ? 'color_attributes' : 'attributes'}`);
  }
  private defs() {
    const all = builtinAttributes(meshOf(this.meId));
    return this.colorsOnly ? all.filter((a) => a.width === 4 && /COLOR/.test(a.data_type)) : all;
  }
  list() {
    return this.defs().map((d) => attributeStruct(this.meId, d.name, `${this.__path}[${JSON.stringify(d.name)}]`));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  /**
   * Adds an attribute. Meshes here store color attributes (FLOAT_COLOR / BYTE_COLOR on POINT or
   * CORNER), one UV map (FLOAT2 on CORNER), face sets ('.sculpt_face_set', INT on FACE), the sculpt
   * mask ('.sculpt_mask', FLOAT on POINT), custom normals ('custom_normal') and the built-in flags.
   */
  new(name: string, type: string, domain: string) {
    const me = meshOf(this.meId);
    const t = String(type ?? '').toUpperCase(),
      dom = String(domain ?? '').toUpperCase() as Domain;
    const n = String(name ?? '');
    if (this.defs().some((d) => d.name === n) || builtinAttributes(me).some((d) => d.name === n)) throw pyError('RuntimeError', `Error: attribute "${n}" already exists`);
    if ((t === 'FLOAT_COLOR' || t === 'BYTE_COLOR') && (dom === 'POINT' || dom === 'CORNER')) {
      const size = dom === 'POINT' ? nVerts(me) : me.indices.length;
      me.color_attributes.push({ name: n, domain: dom, data: new Float32Array(size * 4).fill(1), ...(t === 'BYTE_COLOR' ? { data_type: 'BYTE_COLOR' } : {}) } as ColorAttribute);
      if (me.color_attributes.length === 1) me.active_color_index = 0;
    } else if (this.colorsOnly) throw pyError('TypeError', `AttributeGroup.new(): color attributes need type FLOAT_COLOR or BYTE_COLOR and domain POINT or CORNER`);
    else if (t === 'FLOAT2' && dom === 'CORNER') {
      if (me.uvs.length === me.indices.length * 2 && me.indices.length) throw pyError('RuntimeError', 'Error: this mesh already has its UV map (meshes here hold one); rename it with uv_layers.active.name');
      me.uvs = new Float32Array(me.indices.length * 2);
      me.uv_map_name = n;
    } else if (n === '.sculpt_face_set' && dom === 'FACE') me.sculpt_face_set = new Int32Array(nFaces(me)).fill(1);
    else if (n === '.sculpt_mask' && dom === 'POINT') me.sculpt_mask = new Float32Array(nVerts(me));
    else if (n === 'custom_normal' && dom === 'CORNER') me.custom_normals = Float32Array.from(cornerNormals(me));
    else if (n === 'sharp_face' && dom === 'FACE') me.smooth ??= new Uint8Array(nFaces(me)).fill(1);
    else if (n === 'material_index' && dom === 'FACE') me.material_index = new Uint16Array(nFaces(me));
    else if ((n === 'sharp_edge' || n === 'crease_edge') && dom === 'EDGE') {
      if (n === 'sharp_edge') me.sharp = new Uint32Array(me.indices.length);
      else me.creases = new Float32Array(me.indices.length);
    } else if (n === 'bevel_weight_edge' && dom === 'EDGE') me.bevel_weight_edge = new Float32Array(me.indices.length);
    else if ((n === 'bevel_weight_vert' || n === 'crease_vert') && dom === 'POINT') me[n] = new Float32Array(nVerts(me));
    else if (n === '.hide_poly' && dom === 'FACE') me.hide_poly = new Uint8Array(nFaces(me));
    else if ((n === '.select_vert' || n === '.hide_vert') && dom === 'POINT') me[n === '.select_vert' ? 'select_vert' : 'hide_vert'] = new Uint8Array(nVerts(me));
    else if (!n.startsWith('.') && ATTRIBUTE_TYPES.some(([x]) => x === t) && ['POINT', 'EDGE', 'FACE', 'CORNER'].includes(dom)) me.attributes = [...validAttributes(me), newAttribute(me, n, dom, t as AttributeType)];
    else throw pyError('RuntimeError', `Error: meshes here store color attributes (FLOAT_COLOR/BYTE_COLOR on POINT or CORNER), one UV map (FLOAT2 on CORNER) and the built-in attributes (.sculpt_face_set, .sculpt_mask, custom_normal, sharp_face, sharp_edge, crease_edge, crease_vert, bevel_weight_edge, bevel_weight_vert, material_index); "${n}" (${t} on ${dom}) can't be stored`);
    touched('geometry');
    return this.getItem(n);
  }
  remove(attr: unknown) {
    const name = typeof attr === 'string' ? attr : (attr as { name?: string })?.name;
    const d = this.defs().find((x) => x.name === name);
    if (!d) throw pyError('RuntimeError', `Error: attribute "${name}" not found`);
    if (!d.remove) throw pyError('RuntimeError', `Error: attribute "${name}" is required and can't be removed`);
    d.remove(meshOf(this.meId));
    touched('geometry');
  }
  get active() {
    return this.active_color;
  }
  get active_color() {
    const me = meshOf(this.meId);
    const c = me.color_attributes[me.active_color_index];
    return c ? this.getItem(c.name) : null;
  }
  set active_color(v: unknown) {
    const me = meshOf(this.meId);
    const i = me.color_attributes.findIndex((c) => c.name === (v as { name?: string })?.name);
    if (i >= 0) me.active_color_index = i;
    touched();
  }
  get active_color_index() {
    return meshOf(this.meId).active_color_index;
  }
  set active_color_index(i: number) {
    meshOf(this.meId).active_color_index = Math.round(Number(i));
    touched();
  }
  get active_color_name() {
    const me = meshOf(this.meId);
    return me.color_attributes[me.active_color_index]?.name ?? '';
  }
  set active_color_name(n: string) {
    const me = meshOf(this.meId);
    const i = me.color_attributes.findIndex((c) => c.name === n);
    if (i >= 0) me.active_color_index = i;
    touched();
  }
  get render_color_index() {
    return meshOf(this.meId).active_color_index;
  }
  get default_color_name() {
    return this.active_color_name;
  }
}
kwMethod(MeshAttributes.prototype, 'new', ['name', 'type', 'domain']);

/** Legacy vertex colors: the CORNER color attributes, with `data[i].color`. */
export class MeshVertexColors extends PropCollection<unknown> {
  constructor(readonly meId: string) {
    super(`${meshPath(meId)}.vertex_colors`);
  }
  private attrs() {
    return new MeshAttributes(this.meId, true);
  }
  list() {
    const me = meshOf(this.meId);
    return me.color_attributes.filter((c) => c.domain === 'CORNER').map((c) => this.attrs().getItem(c.name));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  new(name = 'Col', do_init = true) {
    void do_init;
    return this.attrs().new(String(name || 'Col'), 'BYTE_COLOR', 'CORNER');
  }
  remove(layer: unknown) {
    this.attrs().remove(layer);
  }
  get active() {
    const me = meshOf(this.meId);
    const c = me.color_attributes[me.active_color_index];
    return c && c.domain === 'CORNER' ? this.attrs().getItem(c.name) : (this.list()[0] ?? null);
  }
}
kwMethod(MeshVertexColors.prototype, 'new', ['name', 'do_init']);

// ---------------------------------------------------------------------------
// custom split normals

/** Sets one normal per loop (zero vectors use the computed normal); an empty list clears them. */
export function setCustomNormals(meId: string, normals: unknown, perVertex: boolean) {
  const me = meshOf(meId);
  const a = flat(normals);
  if (!a.length) {
    delete me.custom_normals;
    touched('geometry');
    return;
  }
  const nc = me.indices.length;
  const want = (perVertex ? nVerts(me) : nc) * 3;
  if (a.length !== want) throw pyError('ValueError', `expected ${want / 3} normals (one per ${perVertex ? 'vertex' : 'loop'}), got ${a.length / 3}`);
  const base = cornerNormals(me);
  const out = new Float32Array(nc * 3);
  for (let c = 0; c < nc; c++) {
    const src = perVertex ? me.indices[c] : c;
    let x = a[src * 3],
      y = a[src * 3 + 1],
      z = a[src * 3 + 2];
    const l = Math.hypot(x, y, z);
    if (l < 1e-12) {
      x = base[c * 3];
      y = base[c * 3 + 1];
      z = base[c * 3 + 2];
    } else {
      x /= l;
      y /= l;
      z /= l;
    }
    out[c * 3] = x;
    out[c * 3 + 1] = y;
    out[c * 3 + 2] = z;
  }
  me.custom_normals = out;
  touched('geometry');
}

/** A read-only list of normals as vectors (corner_normals / vertex_normals / polygon_normals). */
export function normalList(meId: string, kind: 'corner' | 'vertex' | 'polygon', path: string) {
  const get = (): ArrayLike<number> => {
    const me = meshOf(meId);
    if (kind === 'corner') return loopNormals(me);
    if (kind === 'vertex') return vertexNormals(me);
    const out: number[] = [];
    for (let f = 0; f < nFaces(me); f++) out.push(...polyNormal(me.positions, faceVerts(me, f)));
    return out;
  };
  const vec = (i: number) => {
    const a = get();
    return { __kind: 'struct', __type: 'MeshNormalValue', vector: new Vector([a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]) };
  };
  return new (class extends PropCollection<unknown> {
    override get length() {
      return get().length / 3;
    }
    list() {
      return Array.from({ length: this.length }, (_, i) => vec(i));
    }
    nameOf() {
      return '';
    }
    override getItem(key: number | string) {
      return vec(checkIndex(key, this.length));
    }
    foreach_get(attr: string, seq?: unknown) {
      if (attr !== 'vector') throw unsupported('foreach_get', attr, ['vector']);
      return fill(get(), seq);
    }
  })(path);
}
