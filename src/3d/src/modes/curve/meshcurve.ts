// Mesh edges to poly splines (Convert ▸ Curve).
import type { Spline } from '../../data/types';
import { edgeTopology } from '../../mesh/mesh';
import type { EvalMesh } from '../../eval/types';

/** Chains of edges (open polylines and closed loops) as vertex index lists. */
export function edgeChains(nv: number, edges: ArrayLike<number>): { verts: number[]; cyclic: boolean }[] {
  const adj: number[][] = Array.from({ length: nv }, () => []);
  const ne = edges.length / 2;
  for (let e = 0; e < ne; e++) {
    adj[edges[e * 2]].push(e);
    adj[edges[e * 2 + 1]].push(e);
  }
  const used = new Uint8Array(ne);
  const other = (e: number, v: number) => (edges[e * 2] === v ? edges[e * 2 + 1] : edges[e * 2]);
  const out: { verts: number[]; cyclic: boolean }[] = [];
  const walk = (start: number, e0: number) => {
    const verts = [start];
    let v = start,
      e = e0;
    for (;;) {
      used[e] = 1;
      v = other(e, v);
      if (v === start) return { verts, cyclic: true };
      verts.push(v);
      // continue only through simple (degree 2) vertices
      if (adj[v].length !== 2) return { verts, cyclic: false };
      const next = adj[v].find((x) => !used[x]);
      if (next === undefined) return { verts, cyclic: false };
      e = next;
    }
  };
  // open chains start at branch / end vertices
  for (let v = 0; v < nv; v++) if (adj[v].length !== 2) for (const e of adj[v]) if (!used[e]) out.push(walk(v, e));
  // the rest are closed loops
  for (let e = 0; e < ne; e++) if (!used[e]) out.push(walk(edges[e * 2], e));
  return out;
}

function polySpline(points: number[][], cyclic: boolean): Spline {
  return { type: 'POLY', bezier_points: [], points: points.map((p) => ({ co: [p[0], p[1], p[2], 1], radius: 1, tilt: 0 })), use_cyclic_u: cyclic, resolution_u: 12, order_u: 4, use_smooth: true, material_index: 0 };
}

/** Poly splines along every edge of a mesh. */
export function meshToSplines(m: Pick<EvalMesh, 'positions' | 'offsets' | 'indices' | 'looseEdges'>): Spline[] {
  const nv = m.positions.length / 3;
  const topo = edgeTopology(m);
  const edges = [...Array.from(topo.verts), ...Array.from(m.looseEdges ?? [])];
  const P = (i: number) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
  return edgeChains(nv, edges).map((c) => polySpline(c.verts.map(P), c.cyclic));
}

