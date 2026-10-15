// Mesh topology and mesh read nodes: corners/edges/faces of elements, Edge/Face/Vertex
// Neighbors, Edge Vertices, Is Face Planar, Is Edge Smooth, Mesh Island and Shortest Edge Paths.
import './fdata';
import { gn } from './defs';
import { Field, allocField, evalFull, makeContext, type Evaluated, type FieldContext } from '../field';
import { adaptDomain, readAttribute, type MeshComponent, type MeshTopology } from '../geometry';
import { indexField, positionField } from '../inputs';
import { faceNormals } from '../meshutil';
import type { Domain, FieldType } from '../types';

const zeros = (type: FieldType): Evaluated => ({ data: allocField(type, 1), single: true });
const mesh = (ctx: FieldContext): MeshComponent | null => (ctx.comp.kind === 'MESH' ? ctx.comp : null);

/** Field computed per element of the context from the mesh (null result: zeros). */
class MeshField extends Field {
  constructor(
    type: FieldType,
    private readonly fn: (m: MeshComponent, ctx: FieldContext) => Float32Array | Int32Array | Uint8Array | null,
  ) {
    super(type);
  }
  protected compute(ctx: FieldContext): Evaluated {
    const m = mesh(ctx);
    const r = m ? this.fn(m, ctx) : null;
    return r ? { data: r, single: false } : zeros(this.type);
  }
}

/** Values defined on `from` of a mesh, interpolated to the context domain. */
const onDomain = (m: MeshComponent, ctx: FieldContext, data: Float32Array | Int32Array | Uint8Array, type: 'INT' | 'FLOAT' | 'BOOLEAN' | 'FLOAT_VECTOR', from: Domain) =>
  from === ctx.domain ? data : adaptDomain(m, data, type, from, ctx.domain);

const evalOnMesh = (m: MeshComponent, domain: Domain, f: Field) => evalFull(f, makeContext(m, domain));

// ---------------------------------------------------------------------------
// "X of Y" nodes with weights and sort index

/** CSR list of the elements around each element. */
interface Groups {
  offsets: ArrayLike<number>;
  items: ArrayLike<number>;
}

function vertCornerGroups(m: MeshComponent, t: MeshTopology): Groups {
  return { offsets: t.vertFaceOffsets, items: t.vertCorners };
}
function vertEdgeGroups(t: MeshTopology): Groups {
  return { offsets: t.vertEdgeOffsets, items: t.vertEdges };
}
function faceCornerGroups(m: MeshComponent): Groups {
  return { offsets: m.faceOffsets, items: { length: m.cornerCount } as ArrayLike<number> };
}
function edgeCornerGroups(m: MeshComponent, t: MeshTopology): Groups {
  const offsets = new Uint32Array(t.edgeCount + 1);
  for (let c = 0; c < m.cornerCount; c++) offsets[t.cornerEdge[c] + 1]++;
  for (let e = 0; e < t.edgeCount; e++) offsets[e + 1] += offsets[e];
  const fill = offsets.slice(0, t.edgeCount);
  const items = new Uint32Array(m.cornerCount);
  for (let c = 0; c < m.cornerCount; c++) items[fill[t.cornerEdge[c]]++] = c;
  return { offsets, items };
}

/**
 * For each context element: the element group selected by `index` (evaluated in the context),
 * sorted by `weights` (evaluated on the item domain, stable), picking the `sort`-th item
 * (wrapping); also the group size.
 */
function sortedPick(
  m: MeshComponent,
  ctx: FieldContext,
  groups: Groups,
  itemDomain: Domain,
  identityItems: boolean,
  index: Field,
  weights: Field,
  sort: Field,
): { pick: Int32Array; total: Int32Array } {
  const idx = evalFull(index, ctx),
    srt = evalFull(sort, ctx);
  const w = evalOnMesh(m, itemDomain, weights);
  const nGroups = groups.offsets.length - 1;
  const pick = new Int32Array(ctx.size),
    total = new Int32Array(ctx.size);
  const sorted = new Map<number, number[]>();
  const itemsOf = (g: number) => {
    let l = sorted.get(g);
    if (!l) {
      l = [];
      for (let k = groups.offsets[g]; k < groups.offsets[g + 1]; k++) l.push(identityItems ? k : groups.items[k]);
      l.sort((a, b) => w[a] - w[b] || 0);
      sorted.set(g, l);
    }
    return l;
  };
  for (let i = 0; i < ctx.size; i++) {
    const g = idx[i];
    if (g < 0 || g >= nGroups) continue;
    const l = itemsOf(g);
    total[i] = l.length;
    if (!l.length) continue;
    const s = srt[i];
    pick[i] = l[((s % l.length) + l.length) % l.length];
  }
  return { pick, total };
}

function ofNode(idname: string, indexId: string, outId: string, itemDomain: Domain, groupsFor: (m: MeshComponent, t: MeshTopology) => Groups, identityItems = false) {
  gn(idname, 'input', {
    exec: (ctx) => {
      const index = ctx.field(indexId, 'INT'),
        weights = ctx.field('Weights', 'FLOAT'),
        sort = ctx.field('Sort Index', 'INT');
      const cache = new WeakMap<FieldContext, ReturnType<typeof sortedPick>>();
      const get = (m: MeshComponent, c: FieldContext) => {
        let r = cache.get(c);
        if (!r) cache.set(c, (r = sortedPick(m, c, groupsFor(m, m.topology()), itemDomain, identityItems, index, weights, sort)));
        return r;
      };
      return {
        [outId]: new MeshField('INT', (m, c) => get(m, c).pick),
        Total: new MeshField('INT', (m, c) => get(m, c).total),
      };
    },
    implicit: { [indexId]: indexField },
  });
}

ofNode('GeometryNodeCornersOfVertex', 'Vertex Index', 'Corner Index', 'CORNER', (m, t) => vertCornerGroups(m, t));
ofNode('GeometryNodeEdgesOfVertex', 'Vertex Index', 'Edge Index', 'EDGE', (_m, t) => vertEdgeGroups(t));
ofNode('GeometryNodeCornersOfFace', 'Face Index', 'Corner Index', 'CORNER', (m) => faceCornerGroups(m), true);
ofNode('GeometryNodeCornersOfEdge', 'Edge Index', 'Corner Index', 'CORNER', (m, t) => edgeCornerGroups(m, t));

// ---------------------------------------------------------------------------
// Corner lookups

function cornerFaceIndex(m: MeshComponent, t: MeshTopology, c: number) {
  return { face: t.cornerFace[c], start: m.faceOffsets[t.cornerFace[c]], size: m.faceOffsets[t.cornerFace[c] + 1] - m.faceOffsets[t.cornerFace[c]] };
}

function cornerNode(idname: string, outs: Record<string, (m: MeshComponent, t: MeshTopology, c: number, extra: number) => number>, extraId?: string) {
  gn(idname, 'input', {
    exec: (ctx) => {
      const corner = ctx.field('Corner Index', 'INT');
      const extra = extraId ? ctx.field(extraId, 'INT') : null;
      const r: Record<string, Field> = {};
      for (const [id, fn] of Object.entries(outs))
        r[id] = new MeshField('INT', (m, c) => {
          const t = m.topology();
          const ci = evalFull(corner, c);
          const ex = extra ? evalFull(extra, c) : null;
          const out = new Int32Array(c.size);
          for (let i = 0; i < c.size; i++) {
            const k = ci[i];
            if (k < 0 || k >= m.cornerCount) continue;
            out[i] = fn(m, t, k, ex ? ex[i] : 0);
          }
          return out;
        });
      return r;
    },
    implicit: { 'Corner Index': indexField },
  });
}

cornerNode('GeometryNodeVertexOfCorner', { 'Vertex Index': (m, _t, c) => m.corners[c] });
cornerNode('GeometryNodeFaceOfCorner', {
  'Face Index': (_m, t, c) => t.cornerFace[c],
  'Index in Face': (m, t, c) => c - cornerFaceIndex(m, t, c).start,
});
cornerNode('GeometryNodeEdgesOfCorner', {
  'Next Edge Index': (_m, t, c) => t.cornerEdge[c],
  'Previous Edge Index': (m, t, c) => {
    const f = cornerFaceIndex(m, t, c);
    return t.cornerEdge[c === f.start ? f.start + f.size - 1 : c - 1];
  },
});
cornerNode(
  'GeometryNodeOffsetCornerInFace',
  {
    'Corner Index': (m, t, c, off) => {
      const f = cornerFaceIndex(m, t, c);
      return f.start + ((((c - f.start + off) % f.size) + f.size) % f.size);
    },
  },
  'Offset',
);

// ---------------------------------------------------------------------------
// Neighbor counts and edge vertices

gn('GeometryNodeInputMeshEdgeNeighbors', 'input', {
  exec: () => ({
    'Face Count': new MeshField('INT', (m, c) => {
      const t = m.topology();
      const n = new Int32Array(t.edgeCount);
      for (let e = 0; e < t.edgeCount; e++) n[e] = t.edgeFaceOffsets[e + 1] - t.edgeFaceOffsets[e];
      return onDomain(m, c, n, 'INT', 'EDGE');
    }),
  }),
});

gn('GeometryNodeInputMeshFaceNeighbors', 'input', {
  exec: () => ({
    'Vertex Count': new MeshField('INT', (m, c) => {
      const n = new Int32Array(m.faceCount);
      for (let f = 0; f < m.faceCount; f++) n[f] = m.faceOffsets[f + 1] - m.faceOffsets[f];
      return onDomain(m, c, n, 'INT', 'FACE');
    }),
    'Face Count': new MeshField('INT', (m, c) => {
      const t = m.topology();
      const n = new Int32Array(m.faceCount);
      for (let f = 0; f < m.faceCount; f++)
        for (let k = m.faceOffsets[f]; k < m.faceOffsets[f + 1]; k++) {
          const e = t.cornerEdge[k];
          n[f] += t.edgeFaceOffsets[e + 1] - t.edgeFaceOffsets[e] - 1;
        }
      return onDomain(m, c, n, 'INT', 'FACE');
    }),
  }),
});

gn('GeometryNodeInputMeshVertexNeighbors', 'input', {
  exec: () => ({
    'Vertex Count': new MeshField('INT', (m, c) => {
      const t = m.topology();
      const n = new Int32Array(m.vertCount);
      for (let v = 0; v < m.vertCount; v++) n[v] = t.vertEdgeOffsets[v + 1] - t.vertEdgeOffsets[v];
      return onDomain(m, c, n, 'INT', 'POINT');
    }),
    'Face Count': new MeshField('INT', (m, c) => {
      const t = m.topology();
      const n = new Int32Array(m.vertCount);
      for (let v = 0; v < m.vertCount; v++) n[v] = t.vertFaceOffsets[v + 1] - t.vertFaceOffsets[v];
      return onDomain(m, c, n, 'INT', 'POINT');
    }),
  }),
});

function edgeVertexField(which: 0 | 1, position: boolean): Field {
  return new MeshField(position ? 'VECTOR' : 'INT', (m, c) => {
    const t = m.topology();
    if (position) {
      const p = new Float32Array(t.edgeCount * 3);
      for (let e = 0; e < t.edgeCount; e++) {
        const v = t.edges[e * 2 + which];
        p[e * 3] = m.positions[v * 3];
        p[e * 3 + 1] = m.positions[v * 3 + 1];
        p[e * 3 + 2] = m.positions[v * 3 + 2];
      }
      return onDomain(m, c, p, 'FLOAT_VECTOR', 'EDGE');
    }
    const n = new Int32Array(t.edgeCount);
    for (let e = 0; e < t.edgeCount; e++) n[e] = t.edges[e * 2 + which];
    return onDomain(m, c, n, 'INT', 'EDGE');
  });
}

gn('GeometryNodeInputMeshEdgeVertices', 'input', {
  exec: () => ({
    'Vertex Index 1': edgeVertexField(0, false),
    'Vertex Index 2': edgeVertexField(1, false),
    'Position 1': edgeVertexField(0, true),
    'Position 2': edgeVertexField(1, true),
  }),
});

// ---------------------------------------------------------------------------
// Is Face Planar / Is Edge Smooth

gn('GeometryNodeInputMeshFaceIsPlanar', 'input', {
  exec: (ctx) => {
    const threshold = ctx.field('Threshold', 'FLOAT');
    return {
      Planar: new MeshField('BOOLEAN', (m, c) => {
        const th = evalOnMesh(m, 'FACE', threshold);
        const fn = faceNormals(m);
        const P = m.positions;
        const out = new Uint8Array(m.faceCount);
        for (let f = 0; f < m.faceCount; f++) {
          const s = m.faceOffsets[f],
            e = m.faceOffsets[f + 1];
          if (e - s <= 3) {
            out[f] = 1;
            continue;
          }
          let lo = Infinity,
            hi = -Infinity;
          for (let k = s; k < e; k++) {
            const v = m.corners[k] * 3;
            const d = P[v] * fn[f * 3] + P[v + 1] * fn[f * 3 + 1] + P[v + 2] * fn[f * 3 + 2];
            lo = Math.min(lo, d);
            hi = Math.max(hi, d);
          }
          out[f] = (hi - lo) * 2 < th[f] ? 1 : 0;
        }
        return onDomain(m, c, out, 'BOOLEAN', 'FACE');
      }),
    };
  },
});

gn('GeometryNodeInputEdgeSmooth', 'input', {
  exec: () => ({
    Smooth: new MeshField('BOOLEAN', (m, c) => {
      const t = m.topology();
      const sharp = readAttribute(m, 'sharp_edge', 'EDGE');
      // the sharp flags are interpolated to the context domain, then inverted
      const flags = new Uint8Array(t.edgeCount);
      if (sharp) flags.set(sharp.data.subarray(0, t.edgeCount));
      const r = onDomain(m, c, flags, 'BOOLEAN', 'EDGE');
      const out = new Uint8Array(r.length);
      for (let i = 0; i < r.length; i++) out[i] = r[i] ? 0 : 1;
      return out;
    }),
  }),
});

// ---------------------------------------------------------------------------
// Mesh Island

/** Island of each vertex (connected through edges), numbered in order of first vertex. */
export function vertexIslands(m: MeshComponent): { island: Int32Array; count: number } {
  const t = m.topology();
  const parent = new Int32Array(m.vertCount);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let e = 0; e < t.edgeCount; e++) {
    const a = find(t.edges[e * 2]),
      b = find(t.edges[e * 2 + 1]);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  const island = new Int32Array(m.vertCount);
  const ids = new Map<number, number>();
  for (let v = 0; v < m.vertCount; v++) {
    const r = find(v);
    let id = ids.get(r);
    if (id === undefined) ids.set(r, (id = ids.size));
    island[v] = id;
  }
  return { island, count: ids.size };
}

/** Per-element island on a domain: elements take the island of their (first) vertex. */
function islandOn(m: MeshComponent, domain: Domain): Int32Array {
  const { island } = vertexIslands(m);
  if (domain === 'POINT') return island;
  const t = m.topology();
  if (domain === 'EDGE') return Int32Array.from({ length: t.edgeCount }, (_, e) => island[t.edges[e * 2]]);
  if (domain === 'CORNER') return Int32Array.from(m.corners, (v) => island[v]);
  if (domain === 'FACE') return Int32Array.from({ length: m.faceCount }, (_, f) => island[m.corners[m.faceOffsets[f]]]);
  return new Int32Array(0);
}

gn('GeometryNodeInputMeshIsland', 'input', {
  exec: () => ({
    'Island Index': new MeshField('INT', (m, c) => islandOn(m, c.domain)),
    'Island Count': new MeshField('INT', (m, c) => new Int32Array(c.size).fill(vertexIslands(m).count)),
  }),
});

// ---------------------------------------------------------------------------
// Shortest Edge Paths

/** Dijkstra from every end vertex: next vertex towards the nearest end and the path cost. */
export function shortestEdgePaths(m: MeshComponent, isEnd: ArrayLike<number>, edgeCost: ArrayLike<number>): { next: Int32Array; cost: Float32Array } {
  const t = m.topology();
  const nv = m.vertCount;
  const dist = new Float64Array(nv).fill(Infinity);
  const next = new Int32Array(nv).fill(-1);
  const done = new Uint8Array(nv);
  // binary heap of [dist, vertex], ties popped in vertex order
  const heap: [number, number][] = [];
  const less = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const push = (d: number, v: number) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1,
          r = l + 1;
        let s = i;
        if (l < heap.length && less(heap[l], heap[s])) s = l;
        if (r < heap.length && less(heap[r], heap[s])) s = r;
        if (s === i) break;
        [heap[s], heap[i]] = [heap[i], heap[s]];
        i = s;
      }
    }
    return top;
  };
  for (let v = 0; v < nv; v++)
    if (isEnd[v]) {
      dist[v] = 0;
      push(0, v);
    }
  while (heap.length) {
    const [d, v] = pop();
    if (done[v]) continue;
    done[v] = 1;
    for (let k = t.vertEdgeOffsets[v]; k < t.vertEdgeOffsets[v + 1]; k++) {
      const e = t.vertEdges[k];
      const o = t.edges[e * 2] === v ? t.edges[e * 2 + 1] : t.edges[e * 2];
      if (done[o]) continue;
      const nd = d + Math.max(0, edgeCost[e]);
      if (nd < dist[o]) {
        dist[o] = nd;
        next[o] = v;
        push(nd, o);
      }
    }
  }
  const cost = new Float32Array(nv);
  for (let v = 0; v < nv; v++) {
    if (next[v] < 0) next[v] = v;
    cost[v] = Number.isFinite(dist[v]) ? dist[v] : 0;
  }
  return { next, cost };
}

gn('GeometryNodeInputShortestEdgePaths', 'input', {
  exec: (ctx) => {
    const end = ctx.field('End Vertex', 'BOOLEAN'),
      cost = ctx.field('Edge Cost', 'FLOAT');
    const cache = new WeakMap<MeshComponent, ReturnType<typeof shortestEdgePaths>>();
    const get = (m: MeshComponent) => {
      let r = cache.get(m);
      if (!r) cache.set(m, (r = shortestEdgePaths(m, evalOnMesh(m, 'POINT', end), evalOnMesh(m, 'EDGE', cost))));
      return r;
    };
    return {
      'Next Vertex Index': new MeshField('INT', (m, c) => onDomain(m, c, get(m).next, 'INT', 'POINT')),
      'Total Cost': new MeshField('FLOAT', (m, c) => onDomain(m, c, get(m).cost, 'FLOAT', 'POINT')),
    };
  },
});

void positionField;
