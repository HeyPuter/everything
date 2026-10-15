// Dynamic topology for Sculpt Mode: while a brush stroke runs, long edges under the brush are
// split and short ones collapsed so the triangle density follows the detail size. Works on a
// mutable triangle mesh that mirrors the MeshData during the stroke.

/** Per-vertex float attributes carried through splits/collapses (mask, weights, colors…). */
export interface VAttr {
  data: number[];
  comps: number;
}

export interface TriMesh {
  pos: number[];
  /** 3 vertex indices per triangle; deleted triangles have tri[t*3] === -1 */
  tri: number[];
  /** 6 uv values per triangle (corner order) */
  uv: number[];
  /** per-triangle attributes */
  fset: number[];
  mat: number[];
  smooth: number[];
  hide: number[];
  vattrs: VAttr[];
}

export interface RemeshStats {
  splits: number;
  collapses: number;
}

const edgeLen2 = (P: number[], a: number, b: number) => {
  const dx = P[a * 3] - P[b * 3],
    dy = P[a * 3 + 1] - P[b * 3 + 1],
    dz = P[a * 3 + 2] - P[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
};

function triNormal(P: number[], a: number, b: number, c: number): [number, number, number] {
  const ux = P[b * 3] - P[a * 3],
    uy = P[b * 3 + 1] - P[a * 3 + 1],
    uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3],
    vy = P[c * 3 + 1] - P[a * 3 + 1],
    vz = P[c * 3 + 2] - P[a * 3 + 2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/**
 * Refine the triangles around the region vertices: split edges longer than `maxLen`, collapse
 * edges shorter than `minLen` (either can be disabled with Infinity / 0). Returns counts.
 */
export function remeshRegion(m: TriMesh, region: Set<number>, maxLen: number, minLen: number, limit = 4000): RemeshStats {
  const stats = { splits: 0, collapses: 0 };
  const T = m.tri;
  // vertex → triangles for every triangle touching the region
  const vt = new Map<number, Set<number>>();
  const addVT = (v: number, t: number) => {
    let s = vt.get(v);
    if (!s) vt.set(v, (s = new Set()));
    s.add(t);
  };
  const regionTris = new Set<number>();
  for (let t = 0; t < T.length / 3; t++) {
    const a = T[t * 3];
    if (a < 0) continue;
    if (region.has(a) || region.has(T[t * 3 + 1]) || region.has(T[t * 3 + 2])) regionTris.add(t);
  }
  // full adjacency of the vertices involved (their triangles outside the region matter for collapses)
  const involved = new Set<number>();
  for (const t of regionTris) for (let k = 0; k < 3; k++) involved.add(T[t * 3 + k]);
  for (let t = 0; t < T.length / 3; t++) {
    if (T[t * 3] < 0) continue;
    for (let k = 0; k < 3; k++) if (involved.has(T[t * 3 + k])) for (let j = 0; j < 3; j++) addVT(T[t * 3 + j], t);
  }
  const trisOfEdge = (a: number, b: number): number[] => {
    const sa = vt.get(a),
      sb = vt.get(b);
    if (!sa || !sb) return [];
    const out: number[] = [];
    for (const t of sa) if (sb.has(t)) out.push(t);
    return out;
  };
  const newVert = (a: number, b: number, f: number) => {
    const id = m.pos.length / 3;
    for (let k = 0; k < 3; k++) m.pos.push(m.pos[a * 3 + k] + (m.pos[b * 3 + k] - m.pos[a * 3 + k]) * f);
    for (const at of m.vattrs) for (let k = 0; k < at.comps; k++) at.data.push(at.data[a * at.comps + k] * (1 - f) + at.data[b * at.comps + k] * f);
    return id;
  };
  const cornerOf = (t: number, v: number) => (T[t * 3] === v ? 0 : T[t * 3 + 1] === v ? 1 : 2);
  const setTri = (t: number, a: number, b: number, c: number) => {
    T[t * 3] = a;
    T[t * 3 + 1] = b;
    T[t * 3 + 2] = c;
  };
  const pushTri = (a: number, b: number, c: number, uv: number[], src: number) => {
    const t = T.length / 3;
    T.push(a, b, c);
    m.uv.push(...uv);
    m.fset.push(m.fset[src]);
    m.mat.push(m.mat[src]);
    m.smooth.push(m.smooth[src]);
    m.hide.push(m.hide[src]);
    return t;
  };

  // ---- split long edges (longest first)
  if (maxLen < Infinity) {
    const max2 = maxLen * maxLen;
    const queue: [number, number, number][] = [];
    const seen = new Set<string>();
    const consider = (a: number, b: number) => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(k)) return;
      seen.add(k);
      const l = edgeLen2(m.pos, a, b);
      if (l > max2 && (region.has(a) || region.has(b))) queue.push([l, a, b]);
    };
    for (const t of regionTris) for (let k = 0; k < 3; k++) consider(T[t * 3 + k], T[t * 3 + ((k + 1) % 3)]);
    queue.sort((x, y) => y[0] - x[0]);
    let qi = 0;
    while (qi < queue.length && stats.splits < limit) {
      const [, a, b] = queue[qi++];
      if (edgeLen2(m.pos, a, b) <= max2) continue;
      const tris = trisOfEdge(a, b);
      if (!tris.length || tris.length > 2) continue;
      const mid = newVert(a, b, 0.5);
      region.add(mid);
      for (const t of tris) {
        const ca = cornerOf(t, a),
          cb = cornerOf(t, b);
        // oriented: walk the triangle so that (p, q, r) has the edge p→q
        const forward = (ca + 1) % 3 === cb;
        const p = forward ? a : b,
          q = forward ? b : a;
        const cp = forward ? ca : cb,
          cq = forward ? cb : ca;
        const cr = 3 - cp - cq;
        const r = T[t * 3 + cr];
        const uv = m.uv.slice(t * 6, t * 6 + 6);
        const uvP = [uv[cp * 2], uv[cp * 2 + 1]],
          uvQ = [uv[cq * 2], uv[cq * 2 + 1]],
          uvR = [uv[cr * 2], uv[cr * 2 + 1]];
        const uvM = [(uvP[0] + uvQ[0]) / 2, (uvP[1] + uvQ[1]) / 2];
        // t becomes (p, mid, r); a new triangle (mid, q, r)
        setTri(t, p, mid, r);
        m.uv.splice(t * 6, 6, ...uvP, ...uvM, ...uvR);
        const t2 = pushTri(mid, q, r, [...uvM, ...uvQ, ...uvR], t);
        vt.get(q)?.delete(t);
        addVT(mid, t);
        addVT(mid, t2);
        addVT(q, t2);
        addVT(r, t2);
        regionTris.add(t2);
        // new edges may still be too long
        for (const [x, y] of [
          [p, mid],
          [mid, q],
          [mid, r],
        ]) {
          const l = edgeLen2(m.pos, x, y);
          if (l > max2) queue.push([l, x, y]);
        }
      }
      stats.splits++;
    }
  }

  // ---- collapse short edges (shortest first)
  if (minLen > 0) {
    const min2 = minLen * minLen;
    const cand: [number, number, number][] = [];
    for (const t of regionTris) {
      if (T[t * 3] < 0) continue;
      for (let k = 0; k < 3; k++) {
        const a = T[t * 3 + k],
          b = T[t * 3 + ((k + 1) % 3)];
        if (a < b && (region.has(a) || region.has(b))) {
          const l = edgeLen2(m.pos, a, b);
          if (l < min2) cand.push([l, a, b]);
        }
      }
    }
    cand.sort((x, y) => x[0] - y[0]);
    const dead = new Set<number>();
    for (const [, a, b] of cand) {
      if (stats.collapses >= limit) break;
      if (dead.has(a) || dead.has(b)) continue;
      if (edgeLen2(m.pos, a, b) >= min2) continue;
      const sa = vt.get(a),
        sb = vt.get(b);
      if (!sa || !sb) continue;
      const shared = trisOfEdge(a, b);
      if (shared.length !== 2) continue; // keep open borders and non-manifold edges
      // link condition: the only common neighbours are the two opposite corners
      const nbA = new Set<number>(),
        nbB = new Set<number>();
      for (const t of sa) for (let k = 0; k < 3; k++) nbA.add(T[t * 3 + k]);
      for (const t of sb) for (let k = 0; k < 3; k++) nbB.add(T[t * 3 + k]);
      let common = 0;
      for (const x of nbA) if (x !== a && x !== b && nbB.has(x)) common++;
      if (common !== 2) continue;
      // the merged vertex sits at the midpoint; reject collapses that would flip a triangle
      const mx = (m.pos[a * 3] + m.pos[b * 3]) / 2,
        my = (m.pos[a * 3 + 1] + m.pos[b * 3 + 1]) / 2,
        mz = (m.pos[a * 3 + 2] + m.pos[b * 3 + 2]) / 2;
      let flips = false;
      for (const t of [...sa, ...sb]) {
        if (shared.includes(t)) continue;
        const v0 = T[t * 3],
          v1 = T[t * 3 + 1],
          v2 = T[t * 3 + 2];
        const before = triNormal(m.pos, v0, v1, v2);
        const saved = [m.pos[a * 3], m.pos[a * 3 + 1], m.pos[a * 3 + 2], m.pos[b * 3], m.pos[b * 3 + 1], m.pos[b * 3 + 2]];
        m.pos[a * 3] = m.pos[b * 3] = mx;
        m.pos[a * 3 + 1] = m.pos[b * 3 + 1] = my;
        m.pos[a * 3 + 2] = m.pos[b * 3 + 2] = mz;
        const after = triNormal(m.pos, v0, v1, v2);
        m.pos.splice(a * 3, 3, saved[0], saved[1], saved[2]);
        m.pos.splice(b * 3, 3, saved[3], saved[4], saved[5]);
        if (before[0] * after[0] + before[1] * after[1] + before[2] * after[2] <= 0) {
          flips = true;
          break;
        }
      }
      if (flips) continue;
      // merge b into a
      m.pos[a * 3] = mx;
      m.pos[a * 3 + 1] = my;
      m.pos[a * 3 + 2] = mz;
      for (const at of m.vattrs) for (let k = 0; k < at.comps; k++) at.data[a * at.comps + k] = (at.data[a * at.comps + k] + at.data[b * at.comps + k]) / 2;
      for (const t of shared) {
        for (let k = 0; k < 3; k++) vt.get(T[t * 3 + k])?.delete(t);
        T[t * 3] = T[t * 3 + 1] = T[t * 3 + 2] = -1;
      }
      for (const t of [...sb]) {
        if (T[t * 3] < 0) continue;
        for (let k = 0; k < 3; k++) if (T[t * 3 + k] === b) T[t * 3 + k] = a;
        sa.add(t);
      }
      vt.delete(b);
      dead.add(b);
      region.delete(b);
      stats.collapses++;
    }
  }
  return stats;
}

/** Build a TriMesh from triangulated mesh data (every face must be a triangle). */
export function toTriMesh(positions: ArrayLike<number>, indices: ArrayLike<number>, uvs: ArrayLike<number>, perFace: { fset?: ArrayLike<number> | null; mat?: ArrayLike<number> | null; smooth?: ArrayLike<number> | null; hide?: ArrayLike<number> | null }, vattrs: VAttr[]): TriMesh {
  const nt = indices.length / 3;
  const f = (a: ArrayLike<number> | null | undefined, d: number) => Array.from({ length: nt }, (_, i) => (a ? a[i] : d));
  return {
    pos: Array.from(positions),
    tri: Array.from(indices),
    uv: Array.from(uvs.length === indices.length * 2 ? uvs : new Float32Array(indices.length * 2)),
    fset: f(perFace.fset, 1),
    mat: f(perFace.mat, 0),
    smooth: f(perFace.smooth, 0),
    hide: f(perFace.hide, 0),
    vattrs,
  };
}

/** Live triangles of the TriMesh as flat arrays (vertices are not compacted). */
export function fromTriMesh(m: TriMesh) {
  const live: number[] = [];
  for (let t = 0; t < m.tri.length / 3; t++) if (m.tri[t * 3] >= 0) live.push(t);
  const n = live.length;
  const indices = new Uint32Array(n * 3),
    uvs = new Float32Array(n * 6),
    offsets = new Uint32Array(n + 1),
    fset = new Int32Array(n),
    mat = new Uint16Array(n),
    smooth = new Uint8Array(n),
    hide = new Uint8Array(n);
  live.forEach((t, i) => {
    indices[i * 3] = m.tri[t * 3];
    indices[i * 3 + 1] = m.tri[t * 3 + 1];
    indices[i * 3 + 2] = m.tri[t * 3 + 2];
    for (let k = 0; k < 6; k++) uvs[i * 6 + k] = m.uv[t * 6 + k];
    fset[i] = m.fset[t];
    mat[i] = m.mat[t];
    smooth[i] = m.smooth[t];
    hide[i] = m.hide[t];
  });
  for (let i = 0; i <= n; i++) offsets[i] = i * 3;
  return { positions: Float32Array.from(m.pos), indices, uvs, offsets, fset, mat, smooth, hide };
}

/** Drop vertices no triangle uses; returns the old → new index map (-1 for removed). */
export function compactVertices(nv: number, indices: Uint32Array): { map: Int32Array; count: number } {
  const used = new Uint8Array(nv);
  for (let i = 0; i < indices.length; i++) used[indices[i]] = 1;
  const map = new Int32Array(nv).fill(-1);
  let n = 0;
  for (let v = 0; v < nv; v++) if (used[v]) map[v] = n++;
  for (let i = 0; i < indices.length; i++) indices[i] = map[indices[i]];
  return { map, count: n };
}
