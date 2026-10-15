// UV editing core: which faces the UV editor shows, UV vertex grouping (corners that share a
// mesh vertex and a UV location), UV edges, islands and selection access. Pure functions over
// MeshData so they can be unit tested without the app.
import type { MeshData } from '../../data/types';

export type UVSelectMode = 'VERTEX' | 'EDGE' | 'FACE' | 'ISLAND';
export type StickyMode = 'SHARED_LOCATION' | 'DISABLED' | 'SHARED_VERTEX';

/** UV coordinates closer than this are treated as the same UV vertex. */
export const UV_EPS = 1e-5;

export interface UVLayer {
  me: MeshData;
  /** faces shown in the UV editor */
  faces: number[];
  /** selection is the mesh vertex selection (UV Sync Selection) */
  sync: boolean;
  /** owning object id, for multi-object editing */
  objectId?: string;
}

/** Faces the UV editor shows: every unhidden face with sync selection, else the selected faces. */
export function visibleFaces(me: MeshData, sync: boolean): number[] {
  const out: number[] = [];
  const sel = me.select_vert,
    hide = me.hide_vert,
    uvHide = me.uv_hide && me.uv_hide.length === me.offsets.length - 1 ? me.uv_hide : null;
  for (let f = 0; f < me.offsets.length - 1; f++) {
    let all = true,
      hidden = false;
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
      const v = me.indices[c];
      if (!sel?.[v]) all = false;
      if (hide?.[v]) hidden = true;
    }
    if (hidden) continue;
    if (sync) out.push(f);
    else if (all && !uvHide?.[f]) out.push(f);
  }
  return out;
}

/** Corner → face lookup. */
export function cornerFaces(me: MeshData): Int32Array {
  const out = new Int32Array(me.indices.length);
  for (let f = 0; f < me.offsets.length - 1; f++) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) out[c] = f;
  return out;
}

/** Topology of the visible UVs of one mesh. */
export class UVTopo {
  readonly me: MeshData;
  readonly faces: number[];
  readonly sync: boolean;
  readonly cornerFace: Int32Array;
  readonly visible: Uint8Array;
  /** corner → UV vertex id, -1 for corners of faces that are not shown */
  readonly uvVert: Int32Array;
  /** UV vertex → its corners */
  readonly vertCorners: number[][];
  private _edges: Map<number, number[]> | null = null;
  private _islands: { faceIsland: Int32Array; count: number } | null = null;
  private _meshEdges: Map<number, number[]> | null = null;

  constructor(layer: UVLayer) {
    const me = layer.me;
    this.me = me;
    this.faces = layer.faces;
    this.sync = layer.sync;
    this.cornerFace = cornerFaces(me);
    this.visible = new Uint8Array(me.offsets.length - 1);
    for (const f of layer.faces) this.visible[f] = 1;
    this.uvVert = new Int32Array(me.indices.length).fill(-1);
    this.vertCorners = [];
    // group corners per mesh vertex, then by UV location
    const byVert = new Map<number, number[]>();
    for (const f of layer.faces)
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
        const v = me.indices[c];
        let l = byVert.get(v);
        if (!l) byVert.set(v, (l = []));
        l.push(c);
      }
    const uv = me.uvs;
    for (const list of byVert.values()) {
      const groups: number[] = [];
      for (const c of list) {
        let id = -1;
        for (const g of groups) {
          const r = this.vertCorners[g][0];
          if (Math.abs(uv[r * 2] - uv[c * 2]) < UV_EPS && Math.abs(uv[r * 2 + 1] - uv[c * 2 + 1]) < UV_EPS) {
            id = g;
            break;
          }
        }
        if (id < 0) {
          id = this.vertCorners.length;
          this.vertCorners.push([]);
          groups.push(id);
        }
        this.vertCorners[id].push(c);
        this.uvVert[c] = id;
      }
    }
  }

  get vertCount() {
    return this.vertCorners.length;
  }

  faceStart(f: number) {
    return this.me.offsets[f];
  }
  faceEnd(f: number) {
    return this.me.offsets[f + 1];
  }
  /** next corner around the face */
  next(c: number) {
    const f = this.cornerFace[c];
    return c + 1 < this.me.offsets[f + 1] ? c + 1 : this.me.offsets[f];
  }
  prev(c: number) {
    const f = this.cornerFace[c];
    return c > this.me.offsets[f] ? c - 1 : this.me.offsets[f + 1] - 1;
  }

  u(c: number) {
    return this.me.uvs[c * 2];
  }
  v(c: number) {
    return this.me.uvs[c * 2 + 1];
  }
  /** UV position of a UV vertex */
  vertUV(id: number): [number, number] {
    const c = this.vertCorners[id][0];
    return [this.me.uvs[c * 2], this.me.uvs[c * 2 + 1]];
  }

  /** key of the UV edge starting at corner c (UV vertex pair) */
  edgeKey(c: number) {
    const a = this.uvVert[c],
      b = this.uvVert[this.next(c)];
    const n = this.vertCorners.length + 1;
    return a < b ? a * n + b : b * n + a;
  }

  /** UV edge key → corners starting that edge (one per face using it) */
  get edges(): Map<number, number[]> {
    if (this._edges) return this._edges;
    const m = new Map<number, number[]>();
    for (const f of this.faces)
      for (let c = this.me.offsets[f]; c < this.me.offsets[f + 1]; c++) {
        const k = this.edgeKey(c);
        let l = m.get(k);
        if (!l) m.set(k, (l = []));
        l.push(c);
      }
    return (this._edges = m);
  }

  /** mesh edge key → visible corners starting that mesh edge */
  get meshEdges(): Map<number, number[]> {
    if (this._meshEdges) return this._meshEdges;
    const m = new Map<number, number[]>();
    const nv = this.me.positions.length / 3 + 1;
    for (const f of this.faces)
      for (let c = this.me.offsets[f]; c < this.me.offsets[f + 1]; c++) {
        const a = this.me.indices[c],
          b = this.me.indices[this.next(c)];
        const k = a < b ? a * nv + b : b * nv + a;
        let l = m.get(k);
        if (!l) m.set(k, (l = []));
        l.push(c);
      }
    return (this._meshEdges = m);
  }

  meshEdgeKey(c: number) {
    const nv = this.me.positions.length / 3 + 1;
    const a = this.me.indices[c],
      b = this.me.indices[this.next(c)];
    return a < b ? a * nv + b : b * nv + a;
  }

  /** a UV edge used by a single shown face (seam split or mesh boundary) */
  isBoundary(c: number) {
    return (this.edges.get(this.edgeKey(c))?.length ?? 0) < 2;
  }

  /** Islands: faces connected through shared UV vertices. */
  get islands(): { faceIsland: Int32Array; count: number } {
    if (this._islands) return this._islands;
    const faceIsland = new Int32Array(this.me.offsets.length - 1).fill(-1);
    let count = 0;
    for (const f0 of this.faces) {
      if (faceIsland[f0] >= 0) continue;
      const st = [f0];
      faceIsland[f0] = count;
      while (st.length) {
        const f = st.pop()!;
        for (let c = this.me.offsets[f]; c < this.me.offsets[f + 1]; c++)
          for (const o of this.vertCorners[this.uvVert[c]]) {
            const g = this.cornerFace[o];
            if (faceIsland[g] < 0) {
              faceIsland[g] = count;
              st.push(g);
            }
          }
      }
      count++;
    }
    return (this._islands = { faceIsland, count });
  }

  /** faces of each island */
  islandFaces(): number[][] {
    const { faceIsland, count } = this.islands;
    const out: number[][] = Array.from({ length: count }, () => []);
    for (const f of this.faces) out[faceIsland[f]].push(f);
    return out;
  }

  /** UV vertices of a list of faces */
  facesVerts(faces: Iterable<number>): Set<number> {
    const s = new Set<number>();
    for (const f of faces) for (let c = this.me.offsets[f]; c < this.me.offsets[f + 1]; c++) s.add(this.uvVert[c]);
    return s;
  }

  /** Corners selected along with a corner under the sticky mode. */
  stickyCorners(c: number, sticky: StickyMode): number[] {
    if (sticky === 'DISABLED') return [c];
    if (sticky === 'SHARED_VERTEX') {
      const v = this.me.indices[c];
      const out: number[] = [];
      for (const f of this.faces) for (let k = this.me.offsets[f]; k < this.me.offsets[f + 1]; k++) if (this.me.indices[k] === v) out.push(k);
      return out;
    }
    return this.vertCorners[this.uvVert[c]];
  }
}

// ---------------------------------------------------------------------------
// selection

/** Read access to the UV selection of a layer. */
export function selReader(layer: UVLayer): (c: number) => boolean {
  const me = layer.me;
  if (layer.sync) {
    const s = me.select_vert;
    return (c) => !!s?.[me.indices[c]];
  }
  const s = me.uv_select && me.uv_select.length === me.indices.length ? me.uv_select : null;
  return (c) => !!s?.[c];
}

/** Writable copy of a layer's selection; `commit` stores it back on the mesh. */
export class SelEdit {
  private arr: Uint8Array;
  readonly sync: boolean;
  constructor(readonly layer: UVLayer) {
    const me = layer.me;
    this.sync = layer.sync;
    if (this.sync) {
      const nv = me.positions.length / 3;
      this.arr = me.select_vert && me.select_vert.length === nv ? new Uint8Array(me.select_vert) : new Uint8Array(nv);
    } else this.arr = me.uv_select && me.uv_select.length === me.indices.length ? new Uint8Array(me.uv_select) : new Uint8Array(me.indices.length);
  }
  get(c: number) {
    return !!this.arr[this.sync ? this.layer.me.indices[c] : c];
  }
  set(c: number, on: boolean) {
    this.arr[this.sync ? this.layer.me.indices[c] : c] = on ? 1 : 0;
  }
  /** clear the selection of every shown corner */
  clear() {
    if (this.sync) this.arr.fill(0);
    else for (const f of this.layer.faces) for (let c = this.layer.me.offsets[f]; c < this.layer.me.offsets[f + 1]; c++) this.arr[c] = 0;
  }
  commit() {
    if (this.sync) this.layer.me.select_vert = this.arr;
    else this.layer.me.uv_select = this.arr;
  }
}

export function faceSelected(layer: UVLayer, sel: (c: number) => boolean, f: number) {
  const me = layer.me;
  for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (!sel(c)) return false;
  return true;
}

/** Selected UV vertices (any selected corner in the group). */
export function selectedVerts(t: UVTopo, sel: (c: number) => boolean): number[] {
  const out: number[] = [];
  for (let id = 0; id < t.vertCorners.length; id++) if (t.vertCorners[id].some(sel)) out.push(id);
  return out;
}

/** Selected corners of the shown faces. */
export function selectedCorners(layer: UVLayer, sel: (c: number) => boolean = selReader(layer)): number[] {
  const out: number[] = [];
  const me = layer.me;
  for (const f of layer.faces) for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (sel(c)) out.push(c);
  return out;
}

export function isPinned(me: MeshData, c: number) {
  return !!(me.uv_pin && me.uv_pin.length === me.indices.length && me.uv_pin[c]);
}

// ---------------------------------------------------------------------------
// geometry helpers

/** Signed UV area of a face (positive = counter-clockwise). */
export function faceUVArea(me: MeshData, f: number) {
  let a = 0;
  const s = me.offsets[f],
    e = me.offsets[f + 1];
  for (let c = s; c < e; c++) {
    const n = c + 1 < e ? c + 1 : s;
    a += me.uvs[c * 2] * me.uvs[n * 2 + 1] - me.uvs[n * 2] * me.uvs[c * 2 + 1];
  }
  return a / 2;
}

/** 3D area of a face. */
export function face3DArea(me: MeshData, f: number) {
  const p = me.positions;
  const s = me.offsets[f],
    e = me.offsets[f + 1];
  let nx = 0,
    ny = 0,
    nz = 0;
  const a = me.indices[s] * 3;
  for (let c = s + 1; c < e - 1; c++) {
    const b = me.indices[c] * 3,
      d = me.indices[c + 1] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2];
    const vx = p[d] - p[a],
      vy = p[d + 1] - p[a + 1],
      vz = p[d + 2] - p[a + 2];
    nx += uy * vz - uz * vy;
    ny += uz * vx - ux * vz;
    nz += ux * vy - uy * vx;
  }
  return Math.hypot(nx, ny, nz) / 2;
}

export function faceUVCenter(me: MeshData, f: number): [number, number] {
  let u = 0,
    v = 0;
  const s = me.offsets[f],
    e = me.offsets[f + 1];
  for (let c = s; c < e; c++) {
    u += me.uvs[c * 2];
    v += me.uvs[c * 2 + 1];
  }
  return [u / (e - s), v / (e - s)];
}

export function pointInFace(me: MeshData, f: number, u: number, v: number) {
  const s = me.offsets[f],
    e = me.offsets[f + 1];
  let inside = false;
  for (let i = s, j = e - 1; i < e; j = i++) {
    const ui = me.uvs[i * 2],
      vi = me.uvs[i * 2 + 1],
      uj = me.uvs[j * 2],
      vj = me.uvs[j * 2 + 1];
    if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a segment, and the segment parameter of the closest point. */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number } {
  const dx = bx - ax,
    dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return { d: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)), t };
}

export function pointInPolygon(x: number, y: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Deterministic pseudo random numbers (mulberry32). */
export function rng(seed: number) {
  let a = (seed >>> 0) + 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Writable copy of the UVs of a mesh. */
export function uvCopy(me: MeshData): Float32Array {
  return new Float32Array(me.uvs);
}

/** Move a UV vertex (all its corners) to a position. */
export function setVert(t: UVTopo, uvs: Float32Array, id: number, u: number, v: number) {
  for (const c of t.vertCorners[id]) {
    uvs[c * 2] = u;
    uvs[c * 2 + 1] = v;
  }
}
