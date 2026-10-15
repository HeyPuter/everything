// Conversion of evaluated polygon meshes to GPU buffers.
import { BufferGeometry, Float32BufferAttribute, BufferAttribute, Uint32BufferAttribute } from 'three';
import type { EvalMesh } from '../eval/types';
import { cornerNormals, edgeTopology, triangulatePoly } from '../mesh/mesh';
import type { MeshData } from '../data/types';

export interface GeometryInfo {
  geometry: BufferGeometry;
  /** face index per triangle */
  triFace: Uint32Array;
  /** edges as vertex index pairs (in eval vertex space) */
  edges: Uint32Array;
}

const cache = new WeakMap<EvalMesh, GeometryInfo>();

export function meshGeometry(m: EvalMesh): GeometryInfo {
  const hit = cache.get(m);
  if (hit) return hit;
  const nc = m.indices.length,
    nf = m.offsets.length - 1;
  const pos = new Float32Array(nc * 3),
    uv = new Float32Array(nc * 2);
  const normals = m.custom_normals ?? cornerNormals(m as unknown as MeshData, m.positions);
  for (let c = 0; c < nc; c++) {
    const v = m.indices[c] * 3;
    pos[c * 3] = m.positions[v];
    pos[c * 3 + 1] = m.positions[v + 1];
    pos[c * 3 + 2] = m.positions[v + 2];
    uv[c * 2] = m.uvs[c * 2] ?? 0;
    // glTF-style flip so images map with V up
    uv[c * 2 + 1] = m.uvs[c * 2 + 1] ?? 0;
  }
  // triangulate per face, grouped by material
  const byMat = new Map<number, number[]>();
  const triFaceByMat = new Map<number, number[]>();
  const tmp: number[] = [];
  for (let f = 0; f < nf; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    tmp.length = 0;
    triangulatePoly(m.positions, m.indices.subarray(s, e), tmp, s);
    // flipped quad: use the other diagonal
    if (e - s === 4 && m.quad_flip?.[f]) tmp.splice(0, 6, ...(tmp[2] === s + 2 ? [s, s + 1, s + 3, s + 1, s + 2, s + 3] : [s, s + 1, s + 2, s, s + 2, s + 3]));
    const mi = m.material_index?.[f] ?? 0;
    let list = byMat.get(mi);
    if (!list) {
      list = [];
      byMat.set(mi, list);
      triFaceByMat.set(mi, []);
    }
    const tf = triFaceByMat.get(mi)!;
    for (let i = 0; i < tmp.length; i++) list.push(tmp[i]);
    for (let i = 0; i < tmp.length / 3; i++) tf.push(f);
  }
  const index: number[] = [],
    triFace: number[] = [];
  const g = new BufferGeometry();
  const mats = [...byMat.keys()].sort((a, b) => a - b);
  for (const mi of mats) {
    const list = byMat.get(mi)!;
    g.addGroup(index.length, list.length, mi);
    for (const i of list) index.push(i);
    for (const f of triFaceByMat.get(mi)!) triFace.push(f);
  }
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  if (m.colors && m.colors.length === nc * 4) g.setAttribute('color', new Float32BufferAttribute(m.colors, 4));
  g.setIndex(nc > 65535 ? new Uint32BufferAttribute(index, 1) : new BufferAttribute(new Uint16Array(index), 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  const et = edgeTopology(m);
  const info: GeometryInfo = { geometry: g, triFace: new Uint32Array(triFace), edges: et.verts };
  cache.set(m, info);
  return info;
}

/**
 * Reuse the GPU geometry built for `from` for `to` (same topology, e.g. after a sculpt/paint stroke
 * replaced arrays copy-on-write). The caller keeps the shared buffers up to date itself.
 */
export function shareGeometry(from: EvalMesh, to: EvalMesh): boolean {
  const info = cache.get(from);
  if (!info || from.indices.length !== to.indices.length || from.positions.length !== to.positions.length) return false;
  cache.set(to, info);
  const wire = wireCache.get(from);
  if (wire && !from.curves?.length) {
    wire.setAttribute('position', new BufferAttribute(to.positions, 3));
    wireCache.set(to, wire);
  }
  return true;
}

/** Line segments for all edges (for wireframe display) */
const wireCache = new WeakMap<EvalMesh, BufferGeometry>();
export function wireGeometry(m: EvalMesh): BufferGeometry {
  const hit = wireCache.get(m);
  if (hit) return hit;
  const et = edgeTopology(m);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  const idx = m.positions.length / 3 > 65535 ? new Uint32Array(et.verts) : new Uint16Array(et.verts);
  // loose curve polylines
  if (m.curves?.length && !m.indices.length) {
    const pts: number[] = [],
      ind: number[] = [];
    for (const c of m.curves) {
      const base = pts.length / 3,
        n = c.points.length / 3;
      for (let i = 0; i < c.points.length; i++) pts.push(c.points[i]);
      for (let i = 0; i < n - 1; i++) ind.push(base + i, base + i + 1);
      if (c.cyclic && n > 2) ind.push(base + n - 1, base);
    }
    g.setAttribute('position', new Float32BufferAttribute(pts, 3));
    g.setIndex(ind);
  } else g.setIndex(new BufferAttribute(idx, 1));
  if (m.looseEdges?.length) {
    const all = new Uint32Array(et.verts.length + m.looseEdges.length);
    all.set(et.verts);
    all.set(m.looseEdges, et.verts.length);
    g.setIndex(new BufferAttribute(all, 1));
  }
  wireCache.set(m, g);
  return g;
}

/** Points geometry for point clouds / loose vertices */
const pointCache = new WeakMap<EvalMesh, BufferGeometry>();
export function pointGeometry(m: EvalMesh): BufferGeometry {
  const hit = pointCache.get(m);
  if (hit) return hit;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  pointCache.set(m, g);
  return g;
}
