// Mesh helpers for geometry nodes: normals, areas, and conversion of per-edge flags.
import { MeshComponent, type MeshTopology } from './geometry';
import { cornerNormals as renderCornerNormals } from '../mesh/mesh';
import type { MeshData } from '../data/types';

const faceNormalCache = new WeakMap<Float32Array, { corners: Uint32Array; n: Float32Array }>();
const vertNormalCache = new WeakMap<Float32Array, { corners: Uint32Array; n: Float32Array }>();

/** Newell normals per face. */
export function faceNormals(m: MeshComponent): Float32Array {
  const c = faceNormalCache.get(m.positions);
  if (c && c.corners === m.corners) return c.n;
  const nf = m.faceCount,
    P = m.positions,
    out = new Float32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const s = m.faceOffsets[f],
      e = m.faceOffsets[f + 1];
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let k = s; k < e; k++) {
      const a = m.corners[k] * 3,
        b = m.corners[k + 1 < e ? k + 1 : s] * 3;
      nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    out[f * 3] = nx / l;
    out[f * 3 + 1] = ny / l;
    out[f * 3 + 2] = nz / l;
  }
  faceNormalCache.set(m.positions, { corners: m.corners, n: out });
  return out;
}

/** Vertex normals: face normals weighted by corner angles (loose vertices point along their position). */
export function vertexNormals(m: MeshComponent): Float32Array {
  const c = vertNormalCache.get(m.positions);
  if (c && c.corners === m.corners) return c.n;
  const fn = faceNormals(m),
    P = m.positions,
    nv = m.vertCount,
    out = new Float32Array(nv * 3);
  for (let f = 0; f < m.faceCount; f++) {
    const s = m.faceOffsets[f],
      e = m.faceOffsets[f + 1];
    for (let k = s; k < e; k++) {
      const v = m.corners[k] * 3,
        p = m.corners[k === s ? e - 1 : k - 1] * 3,
        q = m.corners[k + 1 < e ? k + 1 : s] * 3;
      const ax = P[p] - P[v],
        ay = P[p + 1] - P[v + 1],
        az = P[p + 2] - P[v + 2],
        bx = P[q] - P[v],
        by = P[q + 1] - P[v + 1],
        bz = P[q + 2] - P[v + 2];
      const la = Math.hypot(ax, ay, az),
        lb = Math.hypot(bx, by, bz);
      const w = la && lb ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb)))) : 0;
      out[v] += fn[f * 3] * w;
      out[v + 1] += fn[f * 3 + 1] * w;
      out[v + 2] += fn[f * 3 + 2] * w;
    }
  }
  for (let v = 0; v < nv; v++) {
    const i = v * 3;
    let l = Math.hypot(out[i], out[i + 1], out[i + 2]);
    if (!l) {
      out[i] = P[i];
      out[i + 1] = P[i + 1];
      out[i + 2] = P[i + 2];
      l = Math.hypot(out[i], out[i + 1], out[i + 2]);
      if (!l) {
        out[i + 2] = 1;
        l = 1;
      }
    }
    out[i] /= l;
    out[i + 1] /= l;
    out[i + 2] /= l;
  }
  vertNormalCache.set(m.positions, { corners: m.corners, n: out });
  return out;
}

/** Per-face smooth flags (from the sharp_face attribute; missing = smooth). */
export function smoothFlags(m: MeshComponent): Uint8Array {
  const sf = m.attrs.get('sharp_face');
  const out = new Uint8Array(m.faceCount);
  if (!sf || sf.domain !== 'FACE') {
    out.fill(1);
    return out;
  }
  for (let f = 0; f < out.length; f++) out[f] = sf.data[f] ? 0 : 1;
  return out;
}

/** Edge flags (EDGE domain attribute) expanded to the corner that starts each edge. */
export function edgeAttrToCorners(m: MeshComponent, name: string, topo: MeshTopology = m.topology()): Float32Array | null {
  const a = m.attrs.get(name);
  if (!a || a.domain !== 'EDGE') return null;
  const out = new Float32Array(m.cornerCount);
  let any = false;
  for (let c = 0; c < out.length; c++) {
    const v = a.data[topo.cornerEdge[c]];
    out[c] = v;
    if (v) any = true;
  }
  return any ? out : null;
}

/** Corner normals as rendered (smooth/sharp aware). */
export function cornerNormals(m: MeshComponent): Float32Array {
  const smooth = smoothFlags(m);
  const sharp = edgeAttrToCorners(m, 'sharp_edge');
  const md = {
    positions: m.positions,
    offsets: m.faceOffsets,
    indices: m.corners,
    smooth,
    sharp: sharp ? Uint32Array.from(sharp) : undefined,
  } as unknown as MeshData;
  return renderCornerNormals(md, m.positions);
}

export function faceAreas(m: MeshComponent): Float32Array {
  const P = m.positions,
    out = new Float32Array(m.faceCount);
  for (let f = 0; f < m.faceCount; f++) {
    const s = m.faceOffsets[f],
      e = m.faceOffsets[f + 1];
    let nx = 0,
      ny = 0,
      nz = 0;
    for (let k = s; k < e; k++) {
      const a = m.corners[k] * 3,
        b = m.corners[k + 1 < e ? k + 1 : s] * 3;
      nx += P[a + 1] * P[b + 2] - P[a + 2] * P[b + 1];
      ny += P[a + 2] * P[b] - P[a] * P[b + 2];
      nz += P[a] * P[b + 1] - P[a + 1] * P[b];
    }
    out[f] = Math.hypot(nx, ny, nz) / 2;
  }
  return out;
}

export function faceCenters(m: MeshComponent): Float32Array {
  const P = m.positions,
    out = new Float32Array(m.faceCount * 3);
  for (let f = 0; f < m.faceCount; f++) {
    const s = m.faceOffsets[f],
      e = m.faceOffsets[f + 1],
      n = e - s || 1;
    for (let k = s; k < e; k++) {
      const v = m.corners[k] * 3;
      out[f * 3] += P[v] / n;
      out[f * 3 + 1] += P[v + 1] / n;
      out[f * 3 + 2] += P[v + 2] / n;
    }
  }
  return out;
}

/** Unsigned and signed angle between the faces of each manifold edge. */
export function edgeAngles(m: MeshComponent): {
  unsigned: Float32Array;
  signed: Float32Array;
} {
  const topo = m.topology(),
    fn = faceNormals(m),
    ne = topo.edgeCount;
  const unsigned = new Float32Array(ne),
    signed = new Float32Array(ne);
  const centers = faceCenters(m),
    P = m.positions;
  for (let e = 0; e < ne; e++) {
    const a = topo.edgeFaceOffsets[e],
      b = topo.edgeFaceOffsets[e + 1];
    if (b - a !== 2) continue;
    const f0 = topo.edgeFaces[a],
      f1 = topo.edgeFaces[a + 1];
    const d = fn[f0 * 3] * fn[f1 * 3] + fn[f0 * 3 + 1] * fn[f1 * 3 + 1] + fn[f0 * 3 + 2] * fn[f1 * 3 + 2];
    const ang = Math.acos(Math.max(-1, Math.min(1, d)));
    unsigned[e] = ang;
    // concave when the second face center lies above the first face's plane
    const v = topo.edges[e * 2] * 3;
    const dx = centers[f1 * 3] - P[v],
      dy = centers[f1 * 3 + 1] - P[v + 1],
      dz = centers[f1 * 3 + 2] - P[v + 2];
    const side = dx * fn[f0 * 3] + dy * fn[f0 * 3 + 1] + dz * fn[f0 * 3 + 2];
    signed[e] = side > 1e-9 ? -ang : ang;
  }
  return { unsigned, signed };
}
