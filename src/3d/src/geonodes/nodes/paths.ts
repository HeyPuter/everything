// Edge Paths to Curves / Edge Paths to Selection: follow "next vertex" links from start vertices.
import { geoNode, sock, geo } from './gndef';
import { evalOn } from './common';
import { CurvesComponent, EdgeHash, GeometrySet, allocData, dataComps, type MeshComponent } from '../geometry';
import { InputField, makeContext, evalFull, evalSelection, type Field } from '../field';

/** Vertex sequences walked from each start vertex (a path ends at −1, out of range or a repeat). */
export function edgePaths(nv: number, start: Uint8Array | null, next: ArrayLike<number>): number[][] {
  const out: number[][] = [];
  for (let v = 0; v < nv; v++) {
    if (start && !start[v]) continue;
    const path = [v];
    const seen = new Set([v]);
    let cur = v;
    for (;;) {
      const n = next[cur];
      if (n < 0 || n >= nv || n === cur || seen.has(n)) break;
      path.push(n);
      seen.add(n);
      cur = n;
    }
    out.push(path);
  }
  return out;
}

function pathCurves(m: MeshComponent, paths: number[][]): CurvesComponent | null {
  const used = paths.filter((p) => p.length > 1);
  if (!used.length) return null;
  const pts = used.flat();
  const offs = [0];
  for (const p of used) offs.push(offs[offs.length - 1] + p.length);
  const pos = new Float32Array(pts.length * 3);
  pts.forEach((v, i) => pos.set(m.positions.subarray(v * 3, v * 3 + 3), i * 3));
  const c = new CurvesComponent(pos, Uint32Array.from(offs), new Uint8Array(used.length), new Map(), [...m.materials]);
  for (const [name, a] of m.attrs) {
    if (a.domain !== 'POINT') continue;
    const comps = dataComps(a.type);
    const d = allocData(a.type, pts.length);
    pts.forEach((v, i) => {
      for (let k = 0; k < comps; k++) d[i * comps + k] = a.data[v * comps + k];
    });
    c.attrs.set(name, { ...a, data: d });
  }
  return c;
}

geoNode(
  {
    idname: 'GeometryNodeEdgePathsToCurves',
    label: 'Edge Paths to Curves',
    category: 'geometry',
    width: 160,
    description: 'Make a curve along the path that starts at each start vertex',
    inputs: [geo('Mesh'), sock('Start Vertices', 'BOOLEAN', { d: true, hide_value: true, field: true }), sock('Next Vertex Index', 'INT', { d: -1, hide_value: true, field: true })],
    outputs: [geo('Curves')],
  },
  {
    exec: (ctx) => {
      const m = ctx.geometry('Mesh').mesh;
      if (!m) return { Curves: GeometrySet.empty() };
      const r = evalOn(m, 'POINT', ctx.field('Start Vertices', 'BOOLEAN'), [ctx.field('Next Vertex Index', 'INT')]);
      const c = pathCurves(m, edgePaths(m.vertCount, r.sel, r.values[0]));
      return { Curves: c ? new GeometrySet(undefined, undefined, c) : GeometrySet.empty() };
    },
  },
);

/** Edges walked by the paths (consecutive path vertices joined by an edge). */
export function pathEdges(m: MeshComponent, paths: number[][]): Uint8Array {
  const topo = m.topology();
  const h = new EdgeHash(topo.edgeCount);
  for (let e = 0; e < topo.edgeCount; e++) h.getOrAdd(topo.edges[e * 2], topo.edges[e * 2 + 1], e);
  const sel = new Uint8Array(topo.edgeCount);
  for (const p of paths)
    for (let i = 0; i + 1 < p.length; i++) {
      const e = h.get(p[i], p[i + 1]);
      if (e >= 0) sel[e] = 1;
    }
  return sel;
}

geoNode(
  {
    idname: 'GeometryNodeEdgePathsToSelection',
    label: 'Edge Paths to Selection',
    category: 'geometry',
    width: 160,
    description: 'Select the edges along the paths that start at the start vertices',
    inputs: [sock('Start Vertices', 'BOOLEAN', { d: true, hide_value: true, field: true }), sock('Next Vertex Index', 'INT', { d: -1, hide_value: true, field: true })],
    outputs: [sock('Selection', 'BOOLEAN', { field: true })],
  },
  {
    exec: (ctx) => {
      const startF: Field = ctx.field('Start Vertices', 'BOOLEAN'),
        nextF: Field = ctx.field('Next Vertex Index', 'INT');
      return {
        Selection: new InputField('BOOLEAN', `edge_paths:${ctx.path}`, (fc) => {
          const c = fc.comp;
          if (c.kind !== 'MESH') return { data: new Uint8Array(1), single: true };
          const pc = makeContext(c, 'POINT');
          const sel = pathEdges(c, edgePaths(c.vertCount, evalSelection(startF, pc), evalFull(nextF, pc)));
          if (fc.domain === 'EDGE') return { data: sel, single: false };
          // other domains: an element is selected when its edges are
          const t = c.topology();
          if (fc.domain === 'POINT') {
            const out = new Uint8Array(c.vertCount);
            for (let e = 0; e < t.edgeCount; e++) if (sel[e]) out[t.edges[e * 2]] = out[t.edges[e * 2 + 1]] = 1;
            return { data: out, single: false };
          }
          return { data: new Uint8Array(fc.size), single: false };
        }),
      };
    },
  },
);
