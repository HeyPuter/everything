// Face sets and Sculpt Mode visibility: pure helpers on mesh data (no app/UI dependencies).
// Face sets are per-face integer ids (1, 2, …); hidden faces are a per-face flag. A vertex counts
// as hidden when every face around it is hidden.
import type { MeshData } from '../data/types';
import { edgeTopology, vertexFaces } from '../mesh/mesh';

type Topo = Pick<MeshData, 'offsets' | 'indices' | 'positions'>;

export const faceCount = (me: Pick<MeshData, 'offsets'>) => me.offsets.length - 1;

/** The face set array when it matches the topology, else null (every face is in set 1). */
export function faceSetsOf(me: MeshData): Int32Array | null {
  const fs = me.sculpt_face_set;
  return fs && fs.length === faceCount(me) ? fs : null;
}

/** Face set id of a face (1 when the mesh has no face sets). */
export function faceSetAt(me: MeshData, f: number): number {
  const fs = faceSetsOf(me);
  return fs ? fs[f] : 1;
}

/** Hidden face flags when they match the topology, else null. */
export function hiddenFacesOf(me: MeshData): Uint8Array | null {
  const h = me.hide_poly;
  return h && h.length === faceCount(me) ? h : null;
}

export function anyHidden(h: Uint8Array | null | undefined): boolean {
  if (!h) return false;
  for (let i = 0; i < h.length; i++) if (h[i]) return true;
  return false;
}

const ahCache = new WeakMap<Uint8Array, boolean>();
/** Hidden face flags of the mesh when at least one face is hidden (cached per array). */
export function activeHiddenFaces(me: MeshData): Uint8Array | null {
  const h = hiddenFacesOf(me);
  if (!h) return null;
  let r = ahCache.get(h);
  if (r === undefined) {
    r = anyHidden(h);
    ahCache.set(h, r);
  }
  return r ? h : null;
}

/** Per-vertex hidden flags: a vertex is hidden when all faces using it are hidden. */
export function hiddenVertsFromFaces(me: Topo, hide: Uint8Array): Uint8Array {
  const nv = me.positions.length / 3;
  const vf = vertexFaces(me);
  const out = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    const a = vf.offsets[v],
      b = vf.offsets[v + 1];
    if (a === b) continue;
    let all = 1;
    for (let k = a; k < b; k++)
      if (!hide[vf.faces[k]]) {
        all = 0;
        break;
      }
    out[v] = all;
  }
  return out;
}

const hvCache = new WeakMap<Uint8Array, Uint8Array>();
/** Cached hidden vertex flags for the mesh (null when nothing is hidden). */
export function hiddenVerts(me: MeshData): Uint8Array | null {
  const h = activeHiddenFaces(me);
  if (!h) return null;
  let r = hvCache.get(h);
  if (!r || r.length !== me.positions.length / 3) {
    r = hiddenVertsFromFaces(me, h);
    hvCache.set(h, r);
  }
  return r;
}

/**
 * Store the hidden face flags (null/empty clears them) and mirror them into the edit-mode vertex
 * flags so both modes agree on what is hidden.
 */
export function setHiddenFaces(me: MeshData, hide: Uint8Array | null) {
  if (!hide || !anyHidden(hide)) {
    me.hide_poly = undefined;
    me.hide_vert = undefined;
    return;
  }
  me.hide_poly = hide;
  const hv = hiddenVertsFromFaces(me, hide);
  me.hide_vert = hv.some((x) => x) ? hv : undefined;
}

/**
 * Bring the face flags in line with the edit-mode vertex flags (called when entering Sculpt Mode):
 * faces touching a vertex hidden in Edit Mode are hidden, and revealing everything in Edit Mode
 * reveals the faces too.
 */
export function syncHiddenFromVerts(me: MeshData) {
  const nf = faceCount(me);
  const hv = me.hide_vert && me.hide_vert.length === me.positions.length / 3 ? me.hide_vert : null;
  if (!hv || !hv.some((x) => x)) {
    if (me.hide_poly) me.hide_poly = undefined;
    return;
  }
  const cur = hiddenFacesOf(me);
  const out = new Uint8Array(nf);
  let changed = !cur;
  for (let f = 0; f < nf; f++) {
    let h = cur ? cur[f] : 0;
    if (!h)
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++)
        if (hv[me.indices[c]]) {
          h = 1;
          break;
        }
    out[f] = h;
    if (cur && cur[f] !== h) changed = true;
  }
  if (changed) me.hide_poly = out;
}

// ---------------------------------------------------------------------------
// colors

/** Display color of a face set id (sRGB, 0..1). The default set is drawn white. */
export function faceSetColor(id: number, seed = 0, defaultId = 1): [number, number, number] {
  if (id === defaultId) return [1, 1, 1];
  // spread hues with the golden ratio; vary saturation/value a little per id
  const x = Math.abs(Math.imul(id ^ (seed * 7919), 0x9e3779b1)) >>> 0;
  const hue = (((id * 0.618033988749895 + seed * 0.1372) % 1) + 1) % 1;
  const sat = 0.45 + ((x >>> 8) & 255) / 255 * 0.3;
  const val = 0.85 + ((x >>> 16) & 255) / 255 * 0.15;
  return hsv(hue, sat, val);
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6),
    f = h * 6 - i;
  const p = v * (1 - s),
    q = v * (1 - f * s),
    t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

// ---------------------------------------------------------------------------
// face adjacency and flood fills

/** Face → neighbouring faces across edges (CSR) with the shared edge per entry. */
export function faceEdgeNeighbors(me: Topo) {
  const et = edgeTopology(me);
  const nf = me.offsets.length - 1;
  const counts = new Uint32Array(nf + 1);
  for (let f = 0; f < nf; f++)
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
      const e = et.cornerEdge[c];
      counts[f + 1] += et.faceOffsets[e + 1] - et.faceOffsets[e] - 1;
    }
  for (let f = 0; f < nf; f++) counts[f + 1] += counts[f];
  const faces = new Uint32Array(counts[nf]),
    edges = new Uint32Array(counts[nf]),
    corners = new Uint32Array(counts[nf]);
  const fill = counts.slice(0, nf);
  for (let f = 0; f < nf; f++)
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
      const e = et.cornerEdge[c];
      for (let k = et.faceOffsets[e]; k < et.faceOffsets[e + 1]; k++) {
        const g = et.faces[k];
        if (g === f) continue;
        const i = fill[f]++;
        faces[i] = g;
        edges[i] = e;
        corners[i] = c;
      }
    }
  return { offsets: counts, faces, edges, corners, et };
}

/**
 * Label connected regions of faces: two faces sharing an edge are in the same region when
 * `joins(f, g, corner)` returns true (corner = the corner of `f` starting the shared edge).
 * Returns labels starting at `first`.
 */
export function floodRegions(me: Topo, joins: (f: number, g: number, corner: number) => boolean, first = 1): Int32Array {
  const nf = me.offsets.length - 1;
  const adj = faceEdgeNeighbors(me);
  const out = new Int32Array(nf);
  let next = first;
  const stack: number[] = [];
  for (let s = 0; s < nf; s++) {
    if (out[s]) continue;
    const id = next++;
    out[s] = id;
    stack.push(s);
    while (stack.length) {
      const f = stack.pop()!;
      for (let k = adj.offsets[f]; k < adj.offsets[f + 1]; k++) {
        const g = adj.faces[k];
        if (out[g] || !joins(f, g, adj.corners[k])) continue;
        out[g] = id;
        stack.push(g);
      }
    }
  }
  return out;
}

function faceNormalsOf(me: Topo): Float32Array {
  const nf = me.offsets.length - 1;
  const P = me.positions,
    I = me.indices;
  const out = new Float32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const s = me.offsets[f],
      e = me.offsets[f + 1];
    let x = 0,
      y = 0,
      z = 0;
    for (let c = s; c < e; c++) {
      const a = I[c] * 3,
        b = I[c + 1 < e ? c + 1 : s] * 3;
      x += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      y += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      z += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    const l = Math.hypot(x, y, z) || 1;
    out[f * 3] = x / l;
    out[f * 3 + 1] = y / l;
    out[f * 3 + 2] = z / l;
  }
  return out;
}

export type FaceSetInitMode = 'LOOSE_PARTS' | 'FACE_SET_BOUNDARIES' | 'MATERIALS' | 'NORMALS' | 'UV_SEAMS' | 'CREASES' | 'SHARP_EDGES';

/** New face sets for the whole mesh from its topology / attributes. */
export function initFaceSets(me: MeshData, mode: FaceSetInitMode, threshold = 0.5): Int32Array {
  const nf = faceCount(me);
  switch (mode) {
    case 'LOOSE_PARTS':
      return floodRegions(me, () => true);
    case 'FACE_SET_BOUNDARIES': {
      const fs = faceSetsOf(me);
      return floodRegions(me, (f, g) => (fs ? fs[f] === fs[g] : true));
    }
    case 'MATERIALS': {
      const out = new Int32Array(nf);
      for (let f = 0; f < nf; f++) out[f] = (me.material_index?.[f] ?? 0) + 1;
      return out;
    }
    case 'NORMALS': {
      const fn = faceNormalsOf(me);
      // threshold 0..1 maps to the cosine limit between neighbouring faces
      const cosLimit = Math.cos(threshold * Math.PI * 0.5);
      return floodRegions(me, (f, g) => fn[f * 3] * fn[g * 3] + fn[f * 3 + 1] * fn[g * 3 + 1] + fn[f * 3 + 2] * fn[g * 3 + 2] >= cosLimit);
    }
    case 'UV_SEAMS':
      return floodRegions(me, (_f, _g, c) => !me.seams?.[c] && !otherCorner(me, c, (k) => !!me.seams?.[k]));
    case 'CREASES':
      return floodRegions(me, (_f, _g, c) => (me.creases?.[c] ?? 0) < threshold && !otherCorner(me, c, (k) => (me.creases?.[k] ?? 0) >= threshold));
    case 'SHARP_EDGES':
      return floodRegions(me, (_f, _g, c) => !me.sharp?.[c] && !otherCorner(me, c, (k) => !!me.sharp?.[k]));
  }
}

/** Edge flags are stored per corner; check the corners of the other faces on the same edge too. */
function otherCorner(me: Topo, c: number, test: (corner: number) => boolean): boolean {
  const et = edgeTopology(me);
  const e = et.cornerEdge[c];
  for (let k = et.faceOffsets[e]; k < et.faceOffsets[e + 1]; k++) {
    const f = et.faces[k];
    for (let cc = me.offsets[f]; cc < me.offsets[f + 1]; cc++) if (cc !== c && et.cornerEdge[cc] === e && test(cc)) return true;
  }
  return false;
}

/** Faces sharing at least one vertex with a face of set `id` join the set (hidden faces stay). */
export function growFaceSet(me: MeshData, fs: Int32Array, id: number, hidden: Uint8Array | null): Int32Array {
  const out = fs.slice();
  const vf = vertexFaces(me);
  const nf = faceCount(me);
  for (let f = 0; f < nf; f++) {
    if (fs[f] !== id) continue;
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) {
      const v = me.indices[c];
      for (let k = vf.offsets[v]; k < vf.offsets[v + 1]; k++) {
        const g = vf.faces[k];
        if (!hidden?.[g]) out[g] = id;
      }
    }
  }
  return out;
}

/** Faces of set `id` touching another set take the id of a neighbour. */
export function shrinkFaceSet(me: MeshData, fs: Int32Array, id: number, hidden: Uint8Array | null): Int32Array {
  const out = fs.slice();
  const vf = vertexFaces(me);
  const nf = faceCount(me);
  for (let f = 0; f < nf; f++) {
    if (fs[f] !== id || hidden?.[f]) continue;
    let other = -1;
    for (let c = me.offsets[f]; c < me.offsets[f + 1] && other < 0; c++) {
      const v = me.indices[c];
      for (let k = vf.offsets[v]; k < vf.offsets[v + 1]; k++) {
        const g = vf.faces[k];
        if (fs[g] !== id && !hidden?.[g]) {
          other = fs[g];
          break;
        }
      }
    }
    if (other >= 0) out[f] = other;
  }
  return out;
}

export function maxFaceSet(fs: Int32Array | null): number {
  if (!fs) return 1;
  let m = 0;
  for (let i = 0; i < fs.length; i++) if (fs[i] > m) m = fs[i];
  return m;
}

/** Vertex → loose part index (0-based). */
export function looseVertexParts(me: Topo): { part: Int32Array; count: number } {
  const nv = me.positions.length / 3;
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x: number) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let f = 0; f < me.offsets.length - 1; f++) {
    const a = find(me.indices[me.offsets[f]]);
    for (let c = me.offsets[f] + 1; c < me.offsets[f + 1]; c++) {
      const b = find(me.indices[c]);
      if (a !== b) parent[b] = a;
    }
  }
  const map = new Map<number, number>();
  const part = new Int32Array(nv);
  for (let v = 0; v < nv; v++) {
    const r = find(v);
    let p = map.get(r);
    if (p === undefined) {
      p = map.size;
      map.set(r, p);
    }
    part[v] = p;
  }
  return { part, count: map.size };
}

/** Per-vertex flag: the vertex lies on an open mesh boundary (an edge used by one face). */
export function boundaryVerts(me: Topo): Uint8Array {
  const et = edgeTopology(me);
  const out = new Uint8Array(me.positions.length / 3);
  for (let e = 0; e < et.count; e++)
    if (et.faceOffsets[e + 1] - et.faceOffsets[e] === 1) {
      out[et.verts[e * 2]] = 1;
      out[et.verts[e * 2 + 1]] = 1;
    }
  return out;
}

/** Per-vertex flag: the vertex touches faces of more than one face set. */
export function faceSetBoundaryVerts(me: MeshData): Uint8Array {
  const nv = me.positions.length / 3;
  const out = new Uint8Array(nv);
  const fs = faceSetsOf(me);
  if (!fs) return out;
  const vf = vertexFaces(me);
  for (let v = 0; v < nv; v++) {
    const a = vf.offsets[v],
      b = vf.offsets[v + 1];
    for (let k = a + 1; k < b; k++)
      if (fs[vf.faces[k]] !== fs[vf.faces[a]]) {
        out[v] = 1;
        break;
      }
  }
  return out;
}

// ---------------------------------------------------------------------------
// paint mode selection masking (vertex / weight / texture paint)

export interface PaintFilter {
  /** faces that may be painted (null: all) */
  faces: Uint8Array | null;
  /** vertices that may be painted (null: all) */
  verts: Uint8Array | null;
  /** faces hidden in the paint modes (null: none) */
  hidden: Uint8Array | null;
}

const pfCache = new WeakMap<Uint32Array, { key: unknown[]; f: PaintFilter }>();

/** Which faces / vertices the paint brushes may touch, from hiding and the selection masks. */
export function paintFilter(me: MeshData): PaintFilter {
  const nv = me.positions.length / 3,
    nf = faceCount(me);
  const hv = me.hide_vert && me.hide_vert.length === nv && me.hide_vert.some((x) => x) ? me.hide_vert : null;
  const sel = me.select_vert && me.select_vert.length === nv ? me.select_vert : null;
  const faceMask = !!me.use_paint_mask,
    vertMask = !!me.use_paint_mask_vertex && !faceMask;
  const key = [hv, sel, faceMask, vertMask, me.offsets];
  const c = pfCache.get(me.indices);
  if (c && c.key.every((k, i) => k === key[i])) return c.f;
  let hidden: Uint8Array | null = null;
  if (hv) {
    hidden = new Uint8Array(nf);
    for (let f = 0; f < nf; f++)
      for (let k = me.offsets[f]; k < me.offsets[f + 1]; k++)
        if (hv[me.indices[k]]) {
          hidden[f] = 1;
          break;
        }
  }
  let faces: Uint8Array | null = null,
    verts: Uint8Array | null = null;
  if (hidden || faceMask) {
    faces = new Uint8Array(nf);
    for (let f = 0; f < nf; f++) {
      if (hidden?.[f]) continue;
      let ok = 1;
      if (faceMask)
        for (let k = me.offsets[f]; k < me.offsets[f + 1]; k++)
          if (!sel?.[me.indices[k]]) {
            ok = 0;
            break;
          }
      faces[f] = ok;
    }
    verts = new Uint8Array(nv);
    for (let f = 0; f < nf; f++) if (faces[f]) for (let k = me.offsets[f]; k < me.offsets[f + 1]; k++) verts[me.indices[k]] = 1;
  }
  if (vertMask) {
    if (!verts) verts = new Uint8Array(nv).fill(1);
    for (let v = 0; v < nv; v++) if (!sel?.[v]) verts[v] = 0;
  }
  const f: PaintFilter = { faces, verts, hidden };
  pfCache.set(me.indices, { key, f });
  return f;
}
