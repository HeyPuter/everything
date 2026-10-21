// Cluster by Distance and Cluster by Connected: group nearby elements and give every element the
// index of its cluster's first element.
//   by distance: in index order, an element not yet in a cluster starts one and takes every
//     later free element (of the same group) within the distance of it;
//   by connected: a cluster grows from its first point along mesh edges, taking neighbours within
//     the distance of the center of the cluster's bounding box.
import { geoNode, sock, selection } from './gndef';
import { Field, allocField, evalFull, makeContext, type Evaluated, type FieldContext } from '../field';
import { adaptDomain, type Component, type MeshComponent } from '../geometry';
import { positionField } from '../inputs';

/** Cluster ids of points (n), with selection, group ids and per-element distances. */
export function clusterByDistance(pos: ArrayLike<number>, n: number, sel: ArrayLike<number> | null, group: ArrayLike<number> | null, dist: (i: number) => number): Int32Array {
  const ids = new Int32Array(n).fill(-1);
  // uniform hash grid with the largest distance as cell size
  let cell = 0;
  for (let i = 0; i < n; i++) cell = Math.max(cell, dist(i));
  cell = cell > 0 ? cell : 1;
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    if (sel && !sel[i]) continue;
    const k = key(Math.floor(pos[i * 3] / cell), Math.floor(pos[i * 3 + 1] / cell), Math.floor(pos[i * 3 + 2] / cell));
    let b = grid.get(k);
    if (!b) grid.set(k, (b = []));
    b.push(i);
  }
  for (let i = 0; i < n; i++) {
    if (ids[i] >= 0) continue;
    ids[i] = i;
    if (sel && !sel[i]) continue;
    const d = dist(i),
      d2 = d * d;
    const x = pos[i * 3],
      y = pos[i * 3 + 1],
      z = pos[i * 3 + 2];
    const cx = Math.floor(x / cell),
      cy = Math.floor(y / cell),
      cz = Math.floor(z / cell);
    const r = Math.max(1, Math.ceil(d / cell));
    for (let a = -r; a <= r; a++)
      for (let b = -r; b <= r; b++)
        for (let c = -r; c <= r; c++) {
          const list = grid.get(key(cx + a, cy + b, cz + c));
          if (!list) continue;
          for (const j of list) {
            if (j <= i || ids[j] >= 0) continue;
            if (group && group[j] !== group[i]) continue;
            const dx = pos[j * 3] - x,
              dy = pos[j * 3 + 1] - y,
              dz = pos[j * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= d2) ids[j] = i;
          }
        }
  }
  return ids;
}

/** Cluster ids of mesh points grown along edges, around the center of the cluster's bounds. */
export function clusterByConnected(pos: ArrayLike<number>, n: number, neighbours: (v: number) => number[], sel: ArrayLike<number> | null, dist: (i: number) => number): Int32Array {
  const ids = new Int32Array(n).fill(-1);
  for (let s = 0; s < n; s++) {
    if (ids[s] >= 0) continue;
    ids[s] = s;
    if (sel && !sel[s]) continue;
    const d = dist(s),
      d2 = d * d;
    const lo = [pos[s * 3], pos[s * 3 + 1], pos[s * 3 + 2]],
      hi = [...lo];
    const queue = [s];
    for (let q = 0; q < queue.length; q++) {
      for (const v of neighbours(queue[q])) {
        if (ids[v] >= 0 || (sel && !sel[v])) continue;
        let l2 = 0;
        for (let k = 0; k < 3; k++) {
          const c = (lo[k] + hi[k]) / 2 - pos[v * 3 + k];
          l2 += c * c;
        }
        if (l2 > d2) continue;
        ids[v] = s;
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k], pos[v * 3 + k]);
          hi[k] = Math.max(hi[k], pos[v * 3 + k]);
        }
        queue.push(v);
      }
    }
  }
  return ids;
}

class ClusterDistanceField extends Field {
  constructor(private inputs: Field[]) {
    super('INT');
  }
  protected compute(ctx: FieldContext): Evaluated {
    const [sel, group, pos, dist] = this.inputs.map((f) => evalFull(f, ctx));
    return { data: clusterByDistance(pos, ctx.size, sel, group, (i) => Math.max(0, dist[i])), single: false };
  }
}

class ClusterConnectedField extends Field {
  constructor(private inputs: Field[]) {
    super('INT');
  }
  protected compute(ctx: FieldContext): Evaluated {
    const c: Component = ctx.comp;
    const pctx = ctx.domain === 'POINT' ? ctx : makeContext(c, 'POINT');
    const n = pctx.size;
    if (!n) return { data: allocField('INT', 1), single: true };
    const [sel, pos, dist] = this.inputs.map((f) => evalFull(f, pctx));
    let neighbours: (v: number) => number[] = () => [];
    if (c.kind === 'MESH') {
      const topo = (c as MeshComponent).topology();
      neighbours = (v) => {
        const out: number[] = [];
        for (let k = topo.vertEdgeOffsets[v]; k < topo.vertEdgeOffsets[v + 1]; k++) {
          const e = topo.vertEdges[k];
          const a = topo.edges[e * 2],
            b = topo.edges[e * 2 + 1];
          out.push(a === v ? b : a);
        }
        return out.sort((x, y) => x - y);
      };
    }
    const ids = clusterByConnected(pos, n, neighbours, sel, (i) => Math.max(0, dist[i]));
    if (ctx.domain === 'POINT') return { data: ids, single: false };
    return { data: adaptDomain(c, ids, 'INT', 'POINT', ctx.domain), single: false };
  }
}

geoNode(
  {
    idname: 'GeometryNodeClusterByDistance',
    label: 'Cluster by Distance',
    category: 'converter',
    description: 'Group elements that lie within a distance of a cluster’s first element',
    inputs: [selection(), sock('Group ID', 'INT', { d: 0, hide_value: true, field: true }), sock('Position', 'VECTOR', { hide_value: true, field: true }), sock('Distance', 'FLOAT', { d: 0.001, min: 0, subtype: 'DISTANCE', dot: true })],
    outputs: [sock('Cluster ID', 'INT', { field: true })],
  },
  {
    exec: (ctx) => ({ 'Cluster ID': new ClusterDistanceField([ctx.field('Selection', 'BOOLEAN'), ctx.field('Group ID', 'INT'), ctx.field('Position', 'VECTOR'), ctx.field('Distance', 'FLOAT')]) }),
    implicit: { Position: positionField },
  },
);

geoNode(
  {
    idname: 'GeometryNodeClusterByConnected',
    label: 'Cluster by Connected',
    category: 'converter',
    width: 160,
    description: 'Group mesh points connected by edges, growing each cluster while points stay within the distance of its center',
    inputs: [selection(), sock('Position', 'VECTOR', { hide_value: true, field: true }), sock('Distance', 'FLOAT', { d: 0.001, min: 0, subtype: 'DISTANCE', dot: true })],
    outputs: [sock('Cluster ID', 'INT', { field: true })],
  },
  {
    exec: (ctx) => ({ 'Cluster ID': new ClusterConnectedField([ctx.field('Selection', 'BOOLEAN'), ctx.field('Position', 'VECTOR'), ctx.field('Distance', 'FLOAT')]) }),
    implicit: { Position: positionField },
  },
);
