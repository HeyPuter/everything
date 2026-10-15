// Pure geometry: make a mesh symmetric by cutting it at an axis plane and mirroring one half
// over the other (used by Sculpt ▸ Symmetrize), and surface fairing for face sets.

export interface SymMesh {
  positions: Float32Array;
  offsets: Uint32Array;
  indices: Uint32Array;
  uvs: Float32Array;
}

export interface SymResult {
  positions: Float32Array;
  offsets: Uint32Array;
  indices: Uint32Array;
  uvs: Float32Array;
  /** for each new vertex: source vertices a, b and the mix factor (b weight); a === b for copies */
  srcA: Int32Array;
  srcB: Int32Array;
  srcT: Float32Array;
  /** source face of each new face */
  srcFace: Int32Array;
}

/**
 * Keep the half of the mesh where `sign * p[axis] >= 0`, cut faces crossing the plane, and add
 * the mirrored copy of that half (vertices on the plane are shared).
 */
export function symmetrizeMesh(m: SymMesh, axis: 0 | 1 | 2, sign: 1 | -1, tol = 1e-4): SymResult {
  const P = m.positions;
  const nv = P.length / 3;
  const pos: number[] = [];
  const srcA: number[] = [],
    srcB: number[] = [],
    srcT: number[] = [];
  const side = (v: number) => {
    const x = P[v * 3 + axis] * sign;
    return x > tol ? 1 : x < -tol ? -1 : 0;
  };
  const keepMap = new Int32Array(nv).fill(-1);
  const addVert = (x: number, y: number, z: number, a: number, b: number, t: number) => {
    pos.push(x, y, z);
    srcA.push(a);
    srcB.push(b);
    srcT.push(t);
    return pos.length / 3 - 1;
  };
  const kept = (v: number) => {
    if (keepMap[v] < 0) {
      const p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      if (side(v) === 0) p[axis] = 0; // snap to the plane
      keepMap[v] = addVert(p[0], p[1], p[2], v, v, 0);
    }
    return keepMap[v];
  };
  const cutMap = new Map<string, number>();
  const cut = (a: number, b: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let id = cutMap.get(key);
    if (id === undefined) {
      const xa = P[a * 3 + axis],
        xb = P[b * 3 + axis];
      const t = xa / (xa - xb);
      const p = [0, 1, 2].map((k) => P[a * 3 + k] + (P[b * 3 + k] - P[a * 3 + k]) * t);
      p[axis] = 0;
      id = addVert(p[0], p[1], p[2], a, b, t);
      cutMap.set(key, id);
    }
    return id;
  };
  const faces: { verts: number[]; uvs: number[]; src: number }[] = [];
  const nf = m.offsets.length - 1;
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    const n = e - s;
    const out: number[] = [],
      uv: number[] = [];
    for (let i = 0; i < n; i++) {
      const ca = s + i,
        cb = s + ((i + 1) % n);
      const a = m.indices[ca],
        b = m.indices[cb];
      const sa = side(a),
        sb = side(b);
      if (sa >= 0) {
        out.push(kept(a));
        uv.push(m.uvs[ca * 2] ?? 0, m.uvs[ca * 2 + 1] ?? 0);
      }
      if ((sa > 0 && sb < 0) || (sa < 0 && sb > 0)) {
        const id = cut(a, b);
        out.push(id);
        const t = srcT[id] * (srcA[id] === a ? 1 : 0) + (1 - srcT[id]) * (srcA[id] === b ? 1 : 0);
        uv.push((m.uvs[ca * 2] ?? 0) + ((m.uvs[cb * 2] ?? 0) - (m.uvs[ca * 2] ?? 0)) * t, (m.uvs[ca * 2 + 1] ?? 0) + ((m.uvs[cb * 2 + 1] ?? 0) - (m.uvs[ca * 2 + 1] ?? 0)) * t);
      }
    }
    // drop faces lying entirely on the plane
    if (out.length >= 3 && out.some((v) => Math.abs(pos[v * 3 + axis]) > tol)) faces.push({ verts: out, uvs: uv, src: f });
  }
  const half = pos.length / 3;
  // mirrored copy: plane vertices are shared, the rest duplicated with the axis flipped
  const mirrorOf = new Int32Array(half);
  for (let v = 0; v < half; v++) {
    if (Math.abs(pos[v * 3 + axis]) <= tol) {
      mirrorOf[v] = v;
      continue;
    }
    const p = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
    p[axis] = -p[axis];
    mirrorOf[v] = addVert(p[0], p[1], p[2], srcA[v], srcB[v], srcT[v]);
  }
  const all = faces.slice();
  for (const f of faces) {
    const n = f.verts.length;
    const verts: number[] = [],
      uvs: number[] = [];
    // reversed winding keeps the mirrored normals pointing outward
    for (let i = n - 1; i >= 0; i--) {
      verts.push(mirrorOf[f.verts[i]]);
      uvs.push(f.uvs[i * 2], f.uvs[i * 2 + 1]);
    }
    all.push({ verts, uvs, src: f.src });
  }
  let corners = 0;
  for (const f of all) corners += f.verts.length;
  const offsets = new Uint32Array(all.length + 1),
    indices = new Uint32Array(corners),
    uvs = new Float32Array(corners * 2),
    srcFace = new Int32Array(all.length);
  let c = 0;
  all.forEach((f, i) => {
    offsets[i] = c;
    srcFace[i] = f.src;
    for (let k = 0; k < f.verts.length; k++, c++) {
      indices[c] = f.verts[k];
      uvs[c * 2] = f.uvs[k * 2];
      uvs[c * 2 + 1] = f.uvs[k * 2 + 1];
    }
  });
  offsets[all.length] = c;
  return { positions: Float32Array.from(pos), offsets, indices, uvs, srcA: Int32Array.from(srcA), srcB: Int32Array.from(srcB), srcT: Float32Array.from(srcT), srcFace };
}

/**
 * Fair the free vertices (flag 1) of a mesh: positions → as smooth as a membrane (harmonic),
 * tangency → also continuous in slope with the fixed surroundings (bi-harmonic). In place.
 */
export function fairVertices(P: Float32Array, nbOff: Uint32Array, nb: Uint32Array, free: Uint8Array, mode: 'POSITION' | 'TANGENCY', iterations = 300) {
  const nv = P.length / 3;
  const list: number[] = [];
  for (let v = 0; v < nv; v++) if (free[v]) list.push(v);
  if (!list.length) return;
  const lap = new Float32Array(nv * 3);
  const avgInto = (src: Float32Array, v: number, out: number[]) => {
    const a = nbOff[v],
      b = nbOff[v + 1];
    out[0] = out[1] = out[2] = 0;
    if (a === b) return false;
    for (let k = a; k < b; k++) {
      const u = nb[k] * 3;
      out[0] += src[u];
      out[1] += src[u + 1];
      out[2] += src[u + 2];
    }
    out[0] /= b - a;
    out[1] /= b - a;
    out[2] /= b - a;
    return true;
  };
  const t = [0, 0, 0];
  if (mode === 'POSITION') {
    for (let it = 0; it < iterations; it++)
      for (const v of list) if (avgInto(P, v, t)) (P[v * 3] = t[0]), (P[v * 3 + 1] = t[1]), (P[v * 3 + 2] = t[2]);
    return;
  }
  // tangency: the laplacian of the free region follows the laplacian of its neighbours
  const touched = new Uint8Array(nv);
  for (const v of list) {
    touched[v] = 1;
    for (let k = nbOff[v]; k < nbOff[v + 1]; k++) touched[nb[k]] = 1;
  }
  const lapList: number[] = [];
  for (let v = 0; v < nv; v++) if (touched[v]) lapList.push(v);
  for (let it = 0; it < iterations; it++) {
    for (const v of lapList) {
      if (!avgInto(P, v, t)) continue;
      lap[v * 3] = t[0] - P[v * 3];
      lap[v * 3 + 1] = t[1] - P[v * 3 + 1];
      lap[v * 3 + 2] = t[2] - P[v * 3 + 2];
    }
    for (const v of list) {
      if (!avgInto(lap, v, t)) continue;
      // move so that this vertex's laplacian matches the average laplacian around it
      P[v * 3] += (lap[v * 3] - t[0]) * 0.5;
      P[v * 3 + 1] += (lap[v * 3 + 1] - t[1]) * 0.5;
      P[v * 3 + 2] += (lap[v * 3 + 2] - t[2]) * 0.5;
    }
  }
}
