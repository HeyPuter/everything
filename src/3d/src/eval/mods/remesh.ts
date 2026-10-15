// Grid remeshing for the Remesh modifier's Blocks / Smooth / Sharp modes: the mesh's inside is
// sampled on a cubic grid (octree depth, scale); the surface of the inside cells becomes quads,
// optionally snapped onto the original surface.
import { Vector3 } from 'three';
import type { EvalMesh } from '../types';
import { MeshBuilder } from '../meshbuild';
import { SurfaceQuery } from './spatial';
import { vertexNormals } from '../meshbuild';

export interface GridRemeshOptions {
  mode: 'BLOCKS' | 'SMOOTH' | 'SHARP';
  depth: number;
  scale: number;
  removeDisconnected: boolean;
  threshold: number;
  smooth: boolean;
}

export function gridRemesh(m: EvalMesh, o: GridRemeshOptions): EvalMesh {
  const P = m.positions;
  if (P.length < 9 || m.offsets.length < 2) return m;
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], P[i]);
    hi[i % 3] = Math.max(hi[i % 3], P[i]);
  }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6) / Math.max(0.01, Math.min(0.99, o.scale));
  const n = 2 ** Math.max(1, Math.min(9, Math.round(o.depth)));
  const cell = size / n;
  const center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  // the grid is offset by half a cell so a cell is centred on the middle of the bounds
  const origin = center.map((c) => c - size / 2 - cell / 2);
  const q = new SurfaceQuery(m);
  const fn = new Vector3(),
    a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  // inside test: the nearest surface point's face looks away from the sample
  const inside = new Uint8Array(n * n * n);
  const p = new Vector3();
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        p.set(origin[0] + (x + 0.5) * cell, origin[1] + (y + 0.5) * cell, origin[2] + (z + 0.5) * cell);
        const h = q.nearest(p);
        if (!h) continue;
        a.fromArray(q.positions, h.tri[0] * 3);
        b.fromArray(q.positions, h.tri[1] * 3);
        c.fromArray(q.positions, h.tri[2] * 3);
        fn.subVectors(b, a).cross(c.sub(a));
        if (fn.dot(p.clone().sub(h.point)) < 0) inside[(z * n + y) * n + x] = 1;
      }
  const at = (x: number, y: number, z: number) => (x < 0 || y < 0 || z < 0 || x >= n || y >= n || z >= n ? 0 : inside[(z * n + y) * n + x]);
  const b2 = new MeshBuilder();
  const corner = new Map<number, number>();
  const vid = (x: number, y: number, z: number) => {
    const key = (z * (n + 1) + y) * (n + 1) + x;
    let id = corner.get(key);
    if (id === undefined) {
      id = b2.addVert(origin[0] + x * cell, origin[1] + y * cell, origin[2] + z * cell);
      corner.set(key, id);
    }
    return id;
  };
  const smooth = o.smooth ? 1 : 0;
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (!inside[(z * n + y) * n + x]) continue;
        // a quad on every side that faces an outside cell (counter-clockwise seen from outside)
        if (!at(x + 1, y, z)) b2.addFace([vid(x + 1, y, z), vid(x + 1, y + 1, z), vid(x + 1, y + 1, z + 1), vid(x + 1, y, z + 1)], undefined, smooth);
        if (!at(x - 1, y, z)) b2.addFace([vid(x, y, z), vid(x, y, z + 1), vid(x, y + 1, z + 1), vid(x, y + 1, z)], undefined, smooth);
        if (!at(x, y + 1, z)) b2.addFace([vid(x, y + 1, z), vid(x, y + 1, z + 1), vid(x + 1, y + 1, z + 1), vid(x + 1, y + 1, z)], undefined, smooth);
        if (!at(x, y - 1, z)) b2.addFace([vid(x, y, z), vid(x + 1, y, z), vid(x + 1, y, z + 1), vid(x, y, z + 1)], undefined, smooth);
        if (!at(x, y, z + 1)) b2.addFace([vid(x, y, z + 1), vid(x + 1, y, z + 1), vid(x + 1, y + 1, z + 1), vid(x, y + 1, z + 1)], undefined, smooth);
        if (!at(x, y, z - 1)) b2.addFace([vid(x, y, z), vid(x, y + 1, z), vid(x + 1, y + 1, z), vid(x + 1, y, z)], undefined, smooth);
      }
  let out = b2.build();
  if (o.removeDisconnected) out = dropSmallPieces(out, o.threshold);
  if (o.mode !== 'BLOCKS' && out.positions.length) {
    // snap onto the original surface (smooth mode also relaxes the result a little)
    const S = Float32Array.from(out.positions);
    const v = new Vector3();
    for (let i = 0; i < S.length; i += 3) {
      const h = q.nearest(v.fromArray(S, i));
      if (h) S.set([h.point.x, h.point.y, h.point.z], i);
    }
    out = { ...out, positions: S };
    if (o.mode === 'SMOOTH') out = relaxOnSurface(out, q);
  }
  return out;
}

/** Remove connected pieces with fewer faces than `threshold` × the largest piece. */
function dropSmallPieces(m: EvalMesh, threshold: number): EvalMesh {
  const nv = m.positions.length / 3,
    nf = m.offsets.length - 1;
  const parent = Int32Array.from({ length: nv }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let f = 0; f < nf; f++) for (let k = m.offsets[f] + 1; k < m.offsets[f + 1]; k++) parent[find(m.indices[k])] = find(m.indices[m.offsets[f]]);
  const count = new Map<number, number>();
  for (let f = 0; f < nf; f++) {
    const r = find(m.indices[m.offsets[f]]);
    count.set(r, (count.get(r) ?? 0) + 1);
  }
  const largest = Math.max(0, ...count.values());
  const keepF = (f: number) => (count.get(find(m.indices[m.offsets[f]])) ?? 0) >= threshold * largest;
  const b = new MeshBuilder();
  const map = new Int32Array(nv).fill(-1);
  for (let f = 0; f < nf; f++) {
    if (!keepF(f)) continue;
    const vs: number[] = [];
    for (let k = m.offsets[f]; k < m.offsets[f + 1]; k++) {
      const v = m.indices[k];
      if (map[v] < 0) map[v] = b.addVert(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
      vs.push(map[v]);
    }
    b.addFace(vs, undefined, m.smooth?.[f] ?? 0);
  }
  return b.build();
}

/** One round of averaging along the surface, then snapping back onto it. */
function relaxOnSurface(m: EvalMesh, q: SurfaceQuery): EvalMesh {
  const nv = m.positions.length / 3;
  const sum = new Float64Array(nv * 3),
    cnt = new Uint32Array(nv);
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f],
      e = m.offsets[f + 1];
    for (let k = s; k < e; k++) {
      const a = m.indices[k],
        b = m.indices[k + 1 < e ? k + 1 : s];
      for (let j = 0; j < 3; j++) {
        sum[a * 3 + j] += m.positions[b * 3 + j];
        sum[b * 3 + j] += m.positions[a * 3 + j];
      }
      cnt[a]++;
      cnt[b]++;
    }
  }
  const N = vertexNormals(m);
  const out = Float32Array.from(m.positions);
  const v = new Vector3();
  for (let i = 0; i < nv; i++) {
    if (!cnt[i]) continue;
    // move half way to the neighbours' average, within the tangent plane
    const d = [0, 1, 2].map((j) => (sum[i * 3 + j] / cnt[i] - m.positions[i * 3 + j]) * 0.5);
    const dn = d[0] * N[i * 3] + d[1] * N[i * 3 + 1] + d[2] * N[i * 3 + 2];
    v.set(m.positions[i * 3] + d[0] - N[i * 3] * dn, m.positions[i * 3 + 1] + d[1] - N[i * 3 + 1] * dn, m.positions[i * 3 + 2] + d[2] - N[i * 3 + 2] * dn);
    const h = q.nearest(v);
    if (h) v.copy(h.point);
    out.set([v.x, v.y, v.z], i * 3);
  }
  return { ...m, positions: out };
}
