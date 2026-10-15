// Polygon mesh helpers on top of the document MeshData representation.
// Arrays are immutable once committed; derived structures are cached per array identity.
import type { MeshData, Vec3 } from '../data/types';

export interface PolyFace {
  verts: number[];
  uvs?: number[]; // 2 per corner
  smooth?: boolean;
  material?: number;
  seams?: number[]; // per corner
  sharp?: number[]; // per corner
  creases?: number[]; // per corner
}

export const faceCount = (m: Pick<MeshData, 'offsets'>) => m.offsets.length - 1;
export const vertCount = (m: Pick<MeshData, 'positions'>) => m.positions.length / 3;

export function getPos(m: Pick<MeshData, 'positions'>, i: number): Vec3 {
  const p = m.positions;
  return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
}

/** Newell normal of a polygon (unit length, or zero for degenerate). */
export function polyNormal(pos: ArrayLike<number>, verts: ArrayLike<number>, out: Vec3 = [0, 0, 0]): Vec3 {
  let nx = 0,
    ny = 0,
    nz = 0;
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[i] * 3,
      b = verts[(i + 1) % n] * 3;
    nx += (pos[a + 1] - pos[b + 1]) * (pos[a + 2] + pos[b + 2]);
    ny += (pos[a + 2] - pos[b + 2]) * (pos[a] + pos[b]);
    nz += (pos[a] - pos[b]) * (pos[a + 1] + pos[b + 1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / l;
  out[1] = ny / l;
  out[2] = nz / l;
  return out;
}

export function faceVerts(m: Pick<MeshData, 'offsets' | 'indices'>, f: number): number[] {
  return Array.from(m.indices.subarray(m.offsets[f], m.offsets[f + 1]));
}

export function faceCenter(m: Pick<MeshData, 'offsets' | 'indices' | 'positions'>, f: number): Vec3 {
  const a = m.offsets[f],
    b = m.offsets[f + 1],
    c: Vec3 = [0, 0, 0];
  for (let i = a; i < b; i++) {
    const v = m.indices[i] * 3;
    c[0] += m.positions[v];
    c[1] += m.positions[v + 1];
    c[2] += m.positions[v + 2];
  }
  const n = b - a || 1;
  return [c[0] / n, c[1] / n, c[2] / n];
}

/** Build a MeshData-compatible set of arrays from polygon faces. */
export function buildMesh(
  positions: ArrayLike<number>,
  polys: PolyFace[],
): Pick<MeshData, 'positions' | 'offsets' | 'indices' | 'uvs' | 'normals' | 'seams' | 'smooth' | 'material_index' | 'sharp' | 'creases'> {
  let corners = 0;
  for (const f of polys) corners += f.verts.length;
  const offsets = new Uint32Array(polys.length + 1),
    indices = new Uint32Array(corners),
    uvs = new Float32Array(corners * 2),
    normals = new Float32Array(corners * 3),
    smooth = new Uint8Array(polys.length),
    mat = new Uint16Array(polys.length);
  const pos = positions instanceof Float32Array ? positions : new Float32Array(positions);
  let seams: Uint32Array | undefined, sharp: Uint32Array | undefined, creases: Float32Array | undefined;
  if (polys.some((f) => f.seams)) seams = new Uint32Array(corners);
  if (polys.some((f) => f.sharp)) sharp = new Uint32Array(corners);
  if (polys.some((f) => f.creases)) creases = new Float32Array(corners);
  let c = 0;
  const n: Vec3 = [0, 0, 0];
  polys.forEach((f, fi) => {
    offsets[fi] = c;
    polyNormal(pos, f.verts, n);
    for (let k = 0; k < f.verts.length; k++, c++) {
      indices[c] = f.verts[k];
      if (f.uvs) {
        uvs[c * 2] = f.uvs[k * 2];
        uvs[c * 2 + 1] = f.uvs[k * 2 + 1];
      }
      normals[c * 3] = n[0];
      normals[c * 3 + 1] = n[1];
      normals[c * 3 + 2] = n[2];
      if (seams && f.seams) seams[c] = f.seams[k];
      if (sharp && f.sharp) sharp[c] = f.sharp[k];
      if (creases && f.creases) creases[c] = f.creases[k];
    }
    smooth[fi] = f.smooth ? 1 : 0;
    mat[fi] = f.material ?? 0;
  });
  offsets[polys.length] = c;
  return {
    positions: Float32Array.from(pos),
    offsets,
    indices,
    uvs,
    normals,
    smooth,
    material_index: mat,
    ...(seams ? { seams } : {}),
    ...(sharp ? { sharp } : {}),
    ...(creases ? { creases } : {}),
  };
}

/** Convert mesh arrays back to polygon faces (used by topology-changing tools). */
export function toPolys(m: MeshData): PolyFace[] {
  const out: PolyFace[] = [];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const a = m.offsets[f],
      b = m.offsets[f + 1];
    out.push({
      verts: Array.from(m.indices.subarray(a, b)),
      uvs: Array.from(m.uvs.subarray(a * 2, b * 2)),
      smooth: !!m.smooth?.[f],
      material: m.material_index?.[f] ?? 0,
      ...(m.seams ? { seams: Array.from(m.seams.subarray(a, b)) } : {}),
      ...(m.sharp ? { sharp: Array.from(m.sharp.subarray(a, b)) } : {}),
      ...(m.creases ? { creases: Array.from(m.creases.subarray(a, b)) } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Edge topology (cached per indices array)

export interface EdgeTopology {
  /** pairs of vertex indices (a < b), 2 per edge */
  verts: Uint32Array;
  /** edge index for each face corner (edge from corner to next corner) */
  cornerEdge: Uint32Array;
  /** CSR: faces adjacent to each edge */
  faceOffsets: Uint32Array;
  faces: Uint32Array;
  /** face index for each corner */
  cornerFace: Uint32Array;
  count: number;
}

const edgeCache = new WeakMap<Uint32Array, EdgeTopology>();

export function edgeTopology(m: Pick<MeshData, 'offsets' | 'indices' | 'positions'>): EdgeTopology {
  const cached = edgeCache.get(m.indices);
  if (cached && cached.cornerFace.length === m.indices.length) return cached;
  const nv = m.positions.length / 3,
    nc = m.indices.length,
    nf = m.offsets.length - 1;
  const map = new Map<number, number>(),
    ev: number[] = [],
    cornerEdge = new Uint32Array(nc),
    cornerFace = new Uint32Array(nc);
  const useBig = nv > 94906265; // sqrt(2^53)
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    for (let c = s; c < e; c++) {
      cornerFace[c] = f;
      const x = m.indices[c],
        y = m.indices[c + 1 < e ? c + 1 : s],
        a = x < y ? x : y,
        b = x < y ? y : x;
      const key = useBig ? a * 2 ** 26 + b : a * nv + b;
      let id = map.get(key);
      if (id === undefined) {
        id = ev.length / 2;
        ev.push(a, b);
        map.set(key, id);
      }
      cornerEdge[c] = id;
    }
  }
  const ne = ev.length / 2,
    counts = new Uint32Array(ne + 1);
  for (let c = 0; c < nc; c++) counts[cornerEdge[c] + 1]++;
  for (let i = 0; i < ne; i++) counts[i + 1] += counts[i];
  const faces = new Uint32Array(nc),
    fill = counts.slice(0, ne);
  for (let c = 0; c < nc; c++) faces[fill[cornerEdge[c]]++] = cornerFace[c];
  const result: EdgeTopology = {
    verts: new Uint32Array(ev),
    cornerEdge,
    faceOffsets: counts,
    faces,
    cornerFace,
    count: ne,
  };
  edgeCache.set(m.indices, result);
  return result;
}

/** Vertex → faces adjacency (CSR), cached. */
const vfCache = new WeakMap<Uint32Array, { offsets: Uint32Array; faces: Uint32Array; corners: Uint32Array }>();
export function vertexFaces(m: Pick<MeshData, 'offsets' | 'indices' | 'positions'>) {
  const cached = vfCache.get(m.indices);
  const nv = m.positions.length / 3;
  if (cached && cached.offsets.length === nv + 1) return cached;
  const counts = new Uint32Array(nv + 1);
  for (let c = 0; c < m.indices.length; c++) counts[m.indices[c] + 1]++;
  for (let i = 0; i < nv; i++) counts[i + 1] += counts[i];
  const faces = new Uint32Array(m.indices.length),
    corners = new Uint32Array(m.indices.length),
    fill = counts.slice(0, nv);
  for (let f = 0; f < m.offsets.length - 1; f++)
    for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
      const v = m.indices[c],
        k = fill[v]++;
      faces[k] = f;
      corners[k] = c;
    }
  const result = { offsets: counts, faces, corners };
  vfCache.set(m.indices, result);
  return result;
}

/** Vertex → neighbouring vertices via edges (CSR). */
export function vertexNeighbors(m: Pick<MeshData, 'offsets' | 'indices' | 'positions'>) {
  const et = edgeTopology(m),
    nv = m.positions.length / 3,
    counts = new Uint32Array(nv + 1);
  for (let e = 0; e < et.count; e++) {
    counts[et.verts[e * 2] + 1]++;
    counts[et.verts[e * 2 + 1] + 1]++;
  }
  for (let i = 0; i < nv; i++) counts[i + 1] += counts[i];
  const out = new Uint32Array(et.count * 2),
    fill = counts.slice(0, nv);
  for (let e = 0; e < et.count; e++) {
    const a = et.verts[e * 2],
      b = et.verts[e * 2 + 1];
    out[fill[a]++] = b;
    out[fill[b]++] = a;
  }
  return { offsets: counts, neighbors: out };
}

// ---------------------------------------------------------------------------
// Triangulation (fan for convex, ear clipping otherwise)

export function triangulatePoly(pos: ArrayLike<number>, verts: ArrayLike<number>, out: number[], base = 0) {
  const n = verts.length;
  if (n === 3) {
    out.push(base, base + 1, base + 2);
    return;
  }
  if (n === 4) {
    // quads are split along their shorter diagonal
    const d02 = dist2(pos, verts[0], verts[2]),
      d13 = dist2(pos, verts[1], verts[3]);
    if (d02 <= d13) out.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else out.push(base, base + 1, base + 3, base + 1, base + 2, base + 3);
    return;
  }
  // project onto dominant plane
  const nrm = polyNormal(pos, verts);
  const ax = Math.abs(nrm[0]),
    ay = Math.abs(nrm[1]),
    az = Math.abs(nrm[2]);
  const [u, v] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
  const sign = (az >= ax && az >= ay ? nrm[2] : ax >= ay ? nrm[0] : nrm[1]) >= 0 ? 1 : -1;
  const px = new Float64Array(n),
    py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = pos[verts[i] * 3 + u];
    py[i] = pos[verts[i] * 3 + v] * sign;
  }
  const idx: number[] = Array.from({ length: n }, (_, i) => i);
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length],
        b = idx[i],
        c = idx[(i + 1) % idx.length];
      const cr = (px[b] - px[a]) * (py[c] - py[a]) - (py[b] - py[a]) * (px[c] - px[a]);
      if (cr <= 1e-14) continue;
      let inside = false;
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        if (pointInTri(px[p], py[p], px[a], py[a], px[b], py[b], px[c], py[c])) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push(base + a, base + b, base + c);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // degenerate / self-intersecting: fall back to a fan
      for (let i = 1; i < idx.length - 1; i++) out.push(base + idx[0], base + idx[i], base + idx[i + 1]);
      return;
    }
  }
  if (idx.length === 3) out.push(base + idx[0], base + idx[1], base + idx[2]);
}

function dist2(pos: ArrayLike<number>, a: number, b: number) {
  const dx = pos[a * 3] - pos[b * 3],
    dy = pos[a * 3 + 1] - pos[b * 3 + 1],
    dz = pos[a * 3 + 2] - pos[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

function pointInTri(x: number, y: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by),
    d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy),
    d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0,
    pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Triangulated corners: returns corner indices (3 per triangle) and the face of each triangle. */
const triCache = new WeakMap<Uint32Array, { tris: Uint32Array; triFace: Uint32Array; pos: Float32Array }>();
export function triangulateMesh(m: Pick<MeshData, 'offsets' | 'indices' | 'positions'>) {
  const cached = triCache.get(m.indices);
  // Triangulation only depends on positions for n-gons/quads diagonal choice; recompute if positions changed.
  if (cached && cached.pos === m.positions) return cached;
  const tris: number[] = [],
    triFace: number[] = [],
    tmp: number[] = [];
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    tmp.length = 0;
    triangulatePoly(m.positions, m.indices.subarray(s, e), tmp, s);
    for (let i = 0; i < tmp.length; i++) tris.push(tmp[i]);
    for (let i = 0; i < tmp.length / 3; i++) triFace.push(f);
  }
  const result = { tris: new Uint32Array(tris), triFace: new Uint32Array(triFace), pos: m.positions };
  triCache.set(m.indices, result);
  return result;
}

// ---------------------------------------------------------------------------
// Normals

/** Per-face normals. */
export function faceNormals(m: Pick<MeshData, 'offsets' | 'indices' | 'positions'>): Float32Array {
  const nf = m.offsets.length - 1,
    out = new Float32Array(nf * 3),
    n: Vec3 = [0, 0, 0];
  for (let f = 0; f < nf; f++) {
    polyNormal(m.positions, m.indices.subarray(m.offsets[f], m.offsets[f + 1]), n);
    out[f * 3] = n[0];
    out[f * 3 + 1] = n[1];
    out[f * 3 + 2] = n[2];
  }
  return out;
}

/**
 * Per-corner render normals: flat faces use the face normal, smooth faces average
 * angle-weighted face normals around the vertex, split at sharp edges and (optionally)
 * by auto smooth angle.
 */
export function cornerNormals(m: MeshData, positions: Float32Array = m.positions): Float32Array {
  const mm = { ...m, positions };
  const nf = m.offsets.length - 1,
    nc = m.indices.length,
    fn = faceNormals(mm),
    out = new Float32Array(nc * 3);
  const anySmooth = m.smooth && m.smooth.some((s) => s);
  if (!anySmooth) {
    for (let f = 0; f < nf; f++)
      for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
        out[c * 3] = fn[f * 3];
        out[c * 3 + 1] = fn[f * 3 + 1];
        out[c * 3 + 2] = fn[f * 3 + 2];
      }
    return out;
  }
  // angle weights per corner
  const weight = new Float32Array(nc);
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1],
      n = e - s;
    for (let c = s; c < e; c++) {
      const prev = m.indices[c === s ? e - 1 : c - 1] * 3,
        cur = m.indices[c] * 3,
        next = m.indices[c + 1 < e ? c + 1 : s] * 3;
      const ax = positions[prev] - positions[cur],
        ay = positions[prev + 1] - positions[cur + 1],
        az = positions[prev + 2] - positions[cur + 2],
        bx = positions[next] - positions[cur],
        by = positions[next + 1] - positions[cur + 1],
        bz = positions[next + 2] - positions[cur + 2];
      const la = Math.hypot(ax, ay, az),
        lb = Math.hypot(bx, by, bz);
      const d = la && lb ? (ax * bx + ay * by + az * bz) / (la * lb) : 1;
      weight[c] = n === 3 || n > 0 ? Math.acos(Math.max(-1, Math.min(1, d))) : 1;
    }
  }
  const hasSharp = !!m.sharp?.some((s) => s) || m.auto_smooth_angle !== undefined;
  if (!hasSharp) {
    const vn = new Float32Array(positions.length);
    for (let f = 0; f < nf; f++) {
      if (!m.smooth![f]) continue;
      for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
        const v = m.indices[c] * 3,
          w = weight[c];
        vn[v] += fn[f * 3] * w;
        vn[v + 1] += fn[f * 3 + 1] * w;
        vn[v + 2] += fn[f * 3 + 2] * w;
      }
    }
    for (let f = 0; f < nf; f++)
      for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
        if (m.smooth![f]) {
          const v = m.indices[c] * 3,
            l = Math.hypot(vn[v], vn[v + 1], vn[v + 2]) || 1;
          out[c * 3] = vn[v] / l;
          out[c * 3 + 1] = vn[v + 1] / l;
          out[c * 3 + 2] = vn[v + 2] / l;
        } else {
          out[c * 3] = fn[f * 3];
          out[c * 3 + 1] = fn[f * 3 + 1];
          out[c * 3 + 2] = fn[f * 3 + 2];
        }
      }
    return out;
  }
  // Split normals: walk corner fans around each vertex, breaking at sharp edges.
  const et = edgeTopology(mm),
    cosLimit = m.auto_smooth_angle !== undefined ? Math.cos(m.auto_smooth_angle) : -2;
  const sharpEdge = new Uint8Array(et.count);
  for (let c = 0; c < nc; c++) {
    const e = et.cornerEdge[c];
    if (m.sharp?.[c]) sharpEdge[e] = 1;
  }
  for (let e = 0; e < et.count; e++) {
    const a = et.faceOffsets[e],
      b = et.faceOffsets[e + 1];
    if (b - a !== 2) {
      sharpEdge[e] = 1;
      continue;
    }
    const f0 = et.faces[a],
      f1 = et.faces[a + 1];
    if (!m.smooth![f0] || !m.smooth![f1]) sharpEdge[e] = 1;
    else if (cosLimit > -2) {
      const d = fn[f0 * 3] * fn[f1 * 3] + fn[f0 * 3 + 1] * fn[f1 * 3 + 1] + fn[f0 * 3 + 2] * fn[f1 * 3 + 2];
      if (d < cosLimit) sharpEdge[e] = 1;
    }
  }
  // union-find corners sharing a vertex across non-sharp edges
  const parent = new Int32Array(nc).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const vf = vertexFaces(mm);
  for (let e = 0; e < et.count; e++) {
    if (sharpEdge[e]) continue;
    const a = et.verts[e * 2],
      b = et.verts[e * 2 + 1],
      f0 = et.faces[et.faceOffsets[e]],
      f1 = et.faces[et.faceOffsets[e] + 1];
    for (const v of [a, b]) {
      let c0 = -1,
        c1 = -1;
      for (let k = vf.offsets[v]; k < vf.offsets[v + 1]; k++) {
        if (vf.faces[k] === f0) c0 = vf.corners[k];
        if (vf.faces[k] === f1) c1 = vf.corners[k];
      }
      if (c0 >= 0 && c1 >= 0) union(c0, c1);
    }
  }
  const acc = new Float32Array(nc * 3);
  for (let f = 0; f < nf; f++)
    for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
      const r = find(c) * 3,
        w = weight[c];
      acc[r] += fn[f * 3] * w;
      acc[r + 1] += fn[f * 3 + 1] * w;
      acc[r + 2] += fn[f * 3 + 2] * w;
    }
  for (let c = 0; c < nc; c++) {
    const r = find(c) * 3,
      l = Math.hypot(acc[r], acc[r + 1], acc[r + 2]) || 1;
    out[c * 3] = acc[r] / l;
    out[c * 3 + 1] = acc[r + 1] / l;
    out[c * 3 + 2] = acc[r + 2] / l;
  }
  return out;
}

/** Bounding box of positions. */
export function bounds(positions: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  if (min[0] === Infinity) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

// ---------------------------------------------------------------------------
// Edit selection helpers (vertex-flag based, edges/faces derived like vertex select mode flushing)

export function selectedVerts(m: MeshData): number[] {
  const out: number[] = [];
  const s = m.select_vert;
  if (!s) return out;
  for (let i = 0; i < s.length; i++) if (s[i]) out.push(i);
  return out;
}

export function isFaceSelected(m: MeshData, f: number) {
  const s = m.select_vert;
  if (!s) return false;
  for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) if (!s[m.indices[c]]) return false;
  return true;
}

export function selectedFaces(m: MeshData): number[] {
  const out: number[] = [];
  if (!m.select_vert) return out;
  for (let f = 0; f < m.offsets.length - 1; f++) if (isFaceSelected(m, f)) out.push(f);
  return out;
}

export function selectedEdges(m: MeshData): number[] {
  const out: number[] = [];
  const s = m.select_vert;
  if (!s) return out;
  const et = edgeTopology(m);
  for (let e = 0; e < et.count; e++) if (s[et.verts[e * 2]] && s[et.verts[e * 2 + 1]]) out.push(e);
  return out;
}

export function emptyMeshArrays(): Pick<MeshData, 'positions' | 'offsets' | 'indices' | 'uvs' | 'normals'> {
  return {
    positions: new Float32Array(0),
    offsets: new Uint32Array([0]),
    indices: new Uint32Array(0),
    uvs: new Float32Array(0),
    normals: new Float32Array(0),
  };
}
