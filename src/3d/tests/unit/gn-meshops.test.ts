// @vitest-environment happy-dom
// Mesh operation nodes (results recorded from the reference behaviour of these nodes).
import { describe, it, expect } from 'vitest';
import { setup, node, link, run, counts, positions, attr, type T } from './gnmesh-harness';
import type { NodeData } from '../../src/data/types';
import { GeometrySet } from '../../src/geonodes/geometry';

const polys = (g: GeometrySet) => {
  const m = g.mesh!;
  const out: number[][] = [];
  for (let f = 0; f < m.faceCount; f++) out.push(Array.from(m.corners.subarray(m.faceOffsets[f], m.faceOffsets[f + 1])));
  return out;
};
const sortRows = (a: number[][]) => a.map((r) => r.join(',')).sort();

function cube(t: T) {
  return node(t, 'GeometryNodeMeshCube', { Size: [2, 2, 2] });
}
function grid(t: T, x = 3, y = 3) {
  return node(t, 'GeometryNodeMeshGrid', { 'Vertices X': x, 'Vertices Y': y });
}
/** Store a field output as a named attribute on the geometry going to the output. */
function store(t: T, geo: [NodeData, string], value: [NodeData, string], name: string, domain: string, type = 'FLOAT') {
  const st = node(t, 'GeometryNodeStoreNamedAttribute', { Name: name }, { data_type: type, domain });
  link(t, geo[0], geo[1], st, 'Geometry');
  link(t, value[0], value[1], st, 'Value');
  return st;
}

describe('primitive order matches the reference', () => {
  it('cube and grid vertex and face order', () => {
    const t = setup();
    const r = run(t, cube(t), 'Mesh');
    expect(positions(r.geometry)).toEqual([
      [-1, -1, -1],
      [1, -1, -1],
      [-1, 1, -1],
      [1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [-1, 1, 1],
      [1, 1, 1],
    ]);
    expect(polys(r.geometry)).toEqual([
      [0, 2, 3, 1],
      [0, 1, 5, 4],
      [4, 5, 7, 6],
      [2, 6, 7, 3],
      [0, 4, 6, 2],
      [1, 3, 7, 5],
    ]);
    const t2 = setup();
    const r2 = run(t2, grid(t2), 'Mesh');
    expect(polys(r2.geometry)).toEqual([
      [0, 3, 4, 1],
      [1, 4, 5, 2],
      [3, 6, 7, 4],
      [4, 7, 8, 5],
    ]);
  });
});

describe('Dual Mesh', () => {
  it('cube → octahedron', () => {
    const t = setup();
    const d = node(t, 'GeometryNodeDualMesh');
    link(t, cube(t), 'Mesh', d, 'Mesh');
    const r = run(t, d, 'Dual Mesh');
    expect(counts(r.geometry)).toEqual([6, 12, 8]);
    expect(positions(r.geometry)).toEqual([
      [0, 0, -1],
      [0, -1, 0],
      [0, 0, 1],
      [0, 1, 0],
      [-1, 0, 0],
      [1, 0, 0],
    ]);
    expect(polys(r.geometry)).toEqual([
      [0, 1, 4],
      [0, 5, 1],
      [0, 4, 3],
      [0, 3, 5],
      [1, 2, 4],
      [1, 5, 2],
      [2, 3, 4],
      [2, 5, 3],
    ]);
  });
  it('grid with and without boundaries', () => {
    const t = setup();
    const d = node(t, 'GeometryNodeDualMesh');
    link(t, grid(t), 'Mesh', d, 'Mesh');
    const r = run(t, d, 'Dual Mesh');
    expect(counts(r.geometry)).toEqual([4, 4, 1]);
    expect(polys(r.geometry)).toEqual([[0, 2, 3, 1]]);
    d.inputs['Keep Boundaries'] = true;
    const r2 = run(t, d, 'Dual Mesh');
    expect(counts(r2.geometry)).toEqual([20, 28, 9]);
    // the first four vertices are the face centres; the faces are those of the reference
    expect(positions(r2.geometry).slice(0, 4)).toEqual([
      [-0.25, -0.25, 0],
      [-0.25, 0.25, 0],
      [0.25, -0.25, 0],
      [0.25, 0.25, 0],
    ]);
    const P = positions(r2.geometry);
    const ref = [
      [
        [-0.25, -0.25],
        [-0.5, -0.25],
        [-0.5, -0.5],
        [-0.25, -0.5],
      ],
      [
        [-0.25, -0.25],
        [-0.25, 0.25],
        [-0.5, 0.25],
        [-0.5, 0],
        [-0.5, -0.25],
      ],
      [
        [-0.25, 0.25],
        [-0.25, 0.5],
        [-0.5, 0.5],
        [-0.5, 0.25],
      ],
      [
        [0.25, -0.25],
        [-0.25, -0.25],
        [-0.25, -0.5],
        [0, -0.5],
        [0.25, -0.5],
      ],
      [
        [-0.25, -0.25],
        [0.25, -0.25],
        [0.25, 0.25],
        [-0.25, 0.25],
      ],
      [
        [-0.25, 0.25],
        [0.25, 0.25],
        [0.25, 0.5],
        [0, 0.5],
        [-0.25, 0.5],
      ],
      [
        [0.25, -0.25],
        [0.25, -0.5],
        [0.5, -0.5],
        [0.5, -0.25],
      ],
      [
        [0.25, 0.25],
        [0.25, -0.25],
        [0.5, -0.25],
        [0.5, 0],
        [0.5, 0.25],
      ],
      [
        [0.25, 0.25],
        [0.5, 0.25],
        [0.5, 0.5],
        [0.25, 0.5],
      ],
    ];
    expect(polys(r2.geometry).map((f) => f.map((v) => [P[v][0], P[v][1]]))).toEqual(ref);
  });
});

describe('Split Edges', () => {
  it('all edges of a cube', () => {
    const t = setup();
    const s = node(t, 'GeometryNodeSplitEdges');
    link(t, cube(t), 'Mesh', s, 'Mesh');
    const r = run(t, s, 'Mesh');
    expect(counts(r.geometry)).toEqual([24, 24, 6]);
    expect(polys(r.geometry)).toEqual([
      [8, 12, 14, 10],
      [9, 11, 18, 16],
      [17, 19, 22, 20],
      [13, 21, 23, 15],
      [0, 4, 6, 2],
      [1, 3, 7, 5],
    ]);
  });
  it('selected edges of a grid (edges below y = 0.1)', () => {
    const t = setup();
    const s = node(t, 'GeometryNodeSplitEdges');
    link(t, grid(t), 'Mesh', s, 'Mesh');
    const p = node(t, 'GeometryNodeInputPosition');
    const sep = node(t, 'ShaderNodeSeparateXYZ');
    const cmp = node(t, 'FunctionNodeCompare', { B: 0.1 }, { data_type: 'FLOAT', operation: 'LESS_THAN' });
    link(t, p, 'Position', sep, 'Vector');
    link(t, sep, 'Y', cmp, 'A');
    link(t, cmp, 'Result', s, 'Selection');
    const r = run(t, s, 'Mesh');
    expect(counts(r.geometry)).toEqual([14, 15, 4]);
    expect(positions(r.geometry).slice(9)).toEqual([
      [-0.5, 0, 0],
      [0, -0.5, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0.5, 0, 0],
    ]);
    expect(polys(r.geometry)).toEqual([
      [0, 10, 11, 9],
      [1, 12, 5, 2],
      [3, 6, 13, 4],
      [12, 7, 8, 5],
    ]);
  });
});

describe('Scale Elements', () => {
  function scaled(mode: string, domain: string, sel: 'faces01' | 'leftEdges') {
    const t = setup();
    const s = node(t, 'GeometryNodeScaleElements', { Scale: 0.5, Axis: [1, 0, 0] }, { domain, 'Scale Mode': mode });
    link(t, grid(t, 4, 3), 'Mesh', s, 'Geometry');
    if (sel === 'faces01') {
      const i = node(t, 'GeometryNodeInputIndex');
      const cmp = node(t, 'FunctionNodeCompare', { B: 2 }, { data_type: 'INT', operation: 'LESS_THAN' });
      link(t, i, 'Index', cmp, 'A');
      link(t, cmp, 'Result', s, 'Selection');
    } else {
      const p = node(t, 'GeometryNodeInputPosition');
      const sep = node(t, 'ShaderNodeSeparateXYZ');
      const cmp = node(t, 'FunctionNodeCompare', { B: -0.49 }, { data_type: 'FLOAT', operation: 'LESS_THAN' });
      link(t, p, 'Position', sep, 'Vector');
      link(t, sep, 'X', cmp, 'A');
      link(t, cmp, 'Result', s, 'Selection');
    }
    return positions(run(t, s, 'Geometry').geometry);
  }
  it('uniform scale of two connected faces around their common centre', () => {
    expect(scaled('Uniform', 'FACE', 'faces01').slice(0, 6)).toEqual([
      [-0.4167, -0.25, 0],
      [-0.4167, 0, 0],
      [-0.4167, 0.25, 0],
      [-0.25, -0.25, 0],
      [-0.25, 0, 0],
      [-0.25, 0.25, 0],
    ]);
  });
  it('single axis', () => {
    expect(scaled('Single Axis', 'FACE', 'faces01').slice(0, 6)).toEqual([
      [-0.4167, -0.5, 0],
      [-0.4167, 0, 0],
      [-0.4167, 0.5, 0],
      [-0.25, -0.5, 0],
      [-0.25, 0, 0],
      [-0.25, 0.5, 0],
    ]);
  });
  it('edges', () => {
    expect(scaled('Uniform', 'EDGE', 'leftEdges').slice(0, 3)).toEqual([
      [-0.5, -0.25, 0],
      [-0.5, 0, 0],
      [-0.5, 0.25, 0],
    ]);
  });
});

describe('Duplicate Elements', () => {
  function dup(domain: string) {
    const t = setup();
    const d = node(t, 'GeometryNodeDuplicateElements', { Amount: 2 }, { domain });
    link(t, grid(t, 3, 2), 'Mesh', d, 'Geometry');
    const st = store(t, [d, 'Geometry'], [d, 'Duplicate Index'], 'dup', domain, 'INT');
    return run(t, st, 'Geometry').geometry;
  }
  it('points become loose vertices', () => {
    const g = dup('POINT');
    expect(counts(g)).toEqual([12, 0, 0]);
    expect(positions(g).slice(0, 4)).toEqual([
      [-0.5, -0.5, 0],
      [-0.5, -0.5, 0],
      [-0.5, 0.5, 0],
      [-0.5, 0.5, 0],
    ]);
    expect(attr(g, 'dup', 'POINT', 'INT')).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
  });
  it('edges and faces', () => {
    const e = dup('EDGE');
    expect(counts(e)).toEqual([28, 14, 0]);
    expect(attr(e, 'dup', 'EDGE', 'INT')).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
    const f = dup('FACE');
    expect(counts(f)).toEqual([16, 16, 4]);
    expect(polys(f)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9, 10, 11],
      [12, 13, 14, 15],
    ]);
    expect(attr(f, 'dup', 'FACE', 'INT')).toEqual([0, 1, 0, 1]);
  });
});

describe('Sort Elements', () => {
  it('sorts selected points by group, then weight', () => {
    const t = setup();
    const s = node(t, 'GeometryNodeSortElements');
    link(t, grid(t), 'Mesh', s, 'Geometry');
    const i = node(t, 'GeometryNodeInputIndex');
    const neg = node(t, 'ShaderNodeMath', { Value_001: -1 }, { operation: 'MULTIPLY' });
    const mod = node(t, 'ShaderNodeMath', { Value_001: 2 }, { operation: 'FLOORED_MODULO' });
    const gid = node(t, 'ShaderNodeMath', { Value_001: 3 }, { operation: 'FLOORED_MODULO' });
    link(t, i, 'Index', neg, 'Value');
    link(t, i, 'Index', mod, 'Value');
    link(t, i, 'Index', gid, 'Value');
    link(t, neg, 'Value', s, 'Sort Weight');
    link(t, mod, 'Value', s, 'Selection');
    link(t, gid, 'Value', s, 'Group ID');
    const r = run(t, s, 'Geometry');
    expect(positions(r.geometry)).toEqual([
      [-0.5, -0.5, 0],
      [0, -0.5, 0],
      [-0.5, 0.5, 0],
      [0.5, 0, 0],
      [0, 0, 0],
      [-0.5, 0, 0],
      [0.5, -0.5, 0],
      [0, 0.5, 0],
      [0.5, 0.5, 0],
    ]);
    expect(polys(r.geometry)).toEqual([
      [0, 1, 4, 5],
      [5, 4, 7, 2],
      [1, 6, 3, 4],
      [4, 3, 8, 7],
    ]);
  });
});

describe('Merge Points', () => {
  function merged(points: boolean) {
    const t = setup();
    const s = node(t, 'GeometryNodeMergePoints');
    const g = grid(t);
    if (points) {
      const m2p = node(t, 'GeometryNodeMeshToPoints');
      link(t, g, 'Mesh', m2p, 'Mesh');
      link(t, m2p, 'Points', s, 'Geometry');
    } else link(t, g, 'Mesh', s, 'Geometry');
    const i = node(t, 'GeometryNodeInputIndex');
    const div = node(t, 'ShaderNodeMath', { Value_001: 3 }, { operation: 'DIVIDE' });
    const fl = node(t, 'ShaderNodeMath', {}, { operation: 'FLOOR' });
    const sel = node(t, 'FunctionNodeCompare', { B: 4 }, { data_type: 'INT', operation: 'NOT_EQUAL' });
    link(t, i, 'Index', div, 'Value');
    link(t, div, 'Value', fl, 'Value');
    link(t, fl, 'Value', s, 'Merge ID');
    link(t, i, 'Index', sel, 'A');
    link(t, sel, 'Result', s, 'Selection');
    return run(t, s, 'Geometry').geometry;
  }
  it('mesh', () => {
    const g = merged(false);
    expect(counts(g)).toEqual([4, 5, 2]);
    expect(positions(g)).toEqual([
      [-0.5, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0.5, 0, 0],
    ]);
    expect(sortRows(polys(g))).toEqual(
      sortRows([
        [0, 1, 2],
        [1, 3, 2],
      ]),
    );
  });
  it('point cloud', () => {
    const g = merged(true);
    expect(positions(g)).toEqual([
      [0, 0, 0],
      [-0.5, 0, 0],
      [0, 0, 0],
      [0.5, 0, 0],
    ]);
  });
});

describe('Points', () => {
  it('count, position field and radius', () => {
    const t = setup();
    const p = node(t, 'GeometryNodePoints', { Count: 3, Radius: 0.25 });
    const i = node(t, 'GeometryNodeInputIndex');
    const c = node(t, 'ShaderNodeCombineXYZ');
    link(t, i, 'Index', c, 'X');
    link(t, c, 'Vector', p, 'Position');
    const r = run(t, p, 'Geometry');
    expect(positions(r.geometry)).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    expect(Array.from(r.geometry.points!.attrs.get('radius')!.data)).toEqual([0.25, 0.25, 0.25]);
  });
});

describe('face groups', () => {
  it('edges to face groups and their boundaries', () => {
    const t = setup();
    const g = grid(t, 4, 3);
    const p = node(t, 'GeometryNodeInputPosition');
    const sep = node(t, 'ShaderNodeSeparateXYZ');
    const cmp = node(t, 'FunctionNodeCompare', { B: 0 }, { data_type: 'FLOAT', operation: 'GREATER_THAN' });
    const e = node(t, 'GeometryNodeEdgesToFaceGroups');
    link(t, p, 'Position', sep, 'Vector');
    link(t, sep, 'X', cmp, 'A');
    link(t, cmp, 'Result', e, 'Boundary Edges');
    const st = store(t, [g, 'Mesh'], [e, 'Face Group ID'], 'grp', 'FACE', 'INT');
    const fb = node(t, 'GeometryNodeMeshFaceSetBoundaries');
    link(t, e, 'Face Group ID', fb, 'Face Set');
    const st2 = store(t, [st, 'Geometry'], [fb, 'Boundary Edges'], 'bnd', 'EDGE', 'BOOLEAN');
    const r = run(t, st2, 'Geometry');
    expect(attr(r.geometry, 'grp', 'FACE', 'INT')).toEqual([0, 0, 0, 0, 1, 2]);
    // boundary edges by vertex pair: (6,7), (7,8), (7,10)
    const m = r.geometry.mesh!;
    const topo = m.topology();
    const b = attr(r.geometry, 'bnd', 'EDGE', 'BOOLEAN');
    const pairs: string[] = [];
    for (let k = 0; k < topo.edgeCount; k++) if (b[k]) pairs.push(`${topo.edges[k * 2]},${topo.edges[k * 2 + 1]}`);
    expect(pairs.sort()).toEqual(['6,7', '7,10', '7,8']);
  });
});

describe('edge paths', () => {
  function paths(add: number) {
    const t = setup();
    const g = grid(t);
    const i = node(t, 'GeometryNodeInputIndex');
    const nx = node(t, 'ShaderNodeMath', { Value_001: add }, { operation: 'ADD' });
    const m3 = node(t, 'ShaderNodeMath', { Value_001: 3 }, { operation: 'FLOORED_MODULO' });
    const st = node(t, 'FunctionNodeCompare', { B: 0 }, { data_type: 'FLOAT', operation: 'EQUAL' });
    link(t, i, 'Index', nx, 'Value');
    link(t, i, 'Index', m3, 'Value');
    link(t, m3, 'Value', st, 'A');
    const ep = node(t, 'GeometryNodeEdgePathsToCurves');
    link(t, g, 'Mesh', ep, 'Mesh');
    link(t, st, 'Result', ep, 'Start Vertices');
    link(t, nx, 'Value', ep, 'Next Vertex Index');
    const es = node(t, 'GeometryNodeEdgePathsToSelection');
    link(t, st, 'Result', es, 'Start Vertices');
    link(t, nx, 'Value', es, 'Next Vertex Index');
    const s2 = store(t, [g, 'Mesh'], [es, 'Selection'], 'sel', 'EDGE', 'BOOLEAN');
    const j = node(t, 'GeometryNodeJoinGeometry');
    link(t, s2, 'Geometry', j, 'Geometry');
    link(t, ep, 'Curves', j, 'Geometry');
    const r = run(t, j, 'Geometry').geometry;
    const m = r.mesh!;
    const topo = m.topology();
    const sel = attr(r, 'sel', 'EDGE', 'BOOLEAN');
    const pairs: string[] = [];
    for (let k = 0; k < topo.edgeCount; k++) if (sel[k]) pairs.push(`${topo.edges[k * 2]},${topo.edges[k * 2 + 1]}`);
    const c = r.curves;
    const sizes = c ? Array.from({ length: c.curveCount }, (_, k) => c.curveOffsets[k + 1] - c.curveOffsets[k]) : [];
    return { pairs: pairs.sort(), sizes, curvePos: c ? positions(new GeometrySet(undefined, undefined, c)) : [] };
  }
  it('paths across rows; selection only where edges exist', () => {
    const r = paths(1);
    expect(r.pairs).toEqual(['0,1', '1,2', '3,4', '4,5', '6,7', '7,8']);
    expect(r.sizes).toEqual([9, 6, 3]);
  });
  it('diagonal steps make curves but select no edges', () => {
    const r = paths(4);
    expect(r.pairs).toEqual([]);
    expect(r.sizes).toEqual([3, 2]);
    expect(r.curvePos).toEqual([
      [-0.5, -0.5, 0],
      [0, 0, 0],
      [0.5, 0.5, 0],
      [0, -0.5, 0],
      [0.5, 0, 0],
    ]);
  });
});

describe('Set Mesh Normal', () => {
  it('free custom normals reach the evaluated mesh; sharpness mode removes them', async () => {
    const { geometryToEvalMesh } = await import('../../src/geonodes/convert');
    const t = setup();
    const s = node(t, 'GeometryNodeSetMeshNormal', { 'Custom Normal': [0, 0, 2] }, { mode: 'FREE', domain: 'POINT' });
    link(t, cube(t), 'Mesh', s, 'Mesh');
    const r = run(t, s, 'Mesh');
    const em = geometryToEvalMesh(r.geometry);
    expect(em.custom_normals!.length).toBe(24 * 3);
    expect(Array.from(em.custom_normals!.subarray(0, 6))).toEqual([0, 0, 1, 0, 0, 1]);
    const s2 = node(t, 'GeometryNodeSetMeshNormal', {}, { mode: 'SHARPNESS' });
    t.tree.links = t.tree.links.filter((l) => l.to_node !== t.out.id);
    link(t, s, 'Mesh', s2, 'Mesh');
    const r2 = run(t, s2, 'Mesh');
    const em2 = geometryToEvalMesh(r2.geometry);
    expect(em2.custom_normals).toBeUndefined();
    expect(Array.from(em2.smooth!)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

describe('Mesh Bevel', () => {
  for (const [seg, c] of [
    [1, [24, 48, 26]],
    [2, [56, 108, 54]],
  ] as const)
    it(`bevels every cube edge with ${seg} segment(s)`, () => {
      const t = setup();
      const b = node(t, 'GeometryNodeMeshBevel', { Offset: 0.1, Segments: seg });
      link(t, cube(t), 'Mesh', b, 'Mesh');
      const st = store(t, [b, 'Mesh'], [b, 'Edge Face'], 'ef', 'FACE', 'BOOLEAN');
      const st2 = store(t, [st, 'Geometry'], [b, 'Vertex Face'], 'vf', 'FACE', 'BOOLEAN');
      const g = run(t, st2, 'Geometry').geometry;
      expect(counts(g)).toEqual([...c]);
      const ef = attr(g, 'ef', 'FACE', 'BOOLEAN'),
        vf = attr(g, 'vf', 'FACE', 'BOOLEAN');
      expect(ef.filter(Boolean).length).toBe(12 * seg);
      expect(ef.filter(Boolean).length + vf.filter(Boolean).length).toBe(c[2] - 6);
    });
});

describe('Mesh Bevel (selection and vertices)', () => {
  for (const [seg, c] of [
    [1, [12, 20, 10]],
    [2, [16, 28, 14]],
    [3, [20, 36, 18]],
  ] as const)
    it(`bevels the four top edges with ${seg} segment(s), sharing corners along the side edges`, () => {
      const t = setup();
      const b = node(t, 'GeometryNodeMeshBevel', { Offset: 0.2, Segments: seg });
      link(t, cube(t), 'Mesh', b, 'Mesh');
      const p = node(t, 'GeometryNodeInputPosition');
      const sx = node(t, 'ShaderNodeSeparateXYZ');
      const cmp = node(t, 'FunctionNodeCompare', { B: 0.5 }, { data_type: 'FLOAT', operation: 'GREATER_THAN' });
      link(t, p, 'Position', sx, 'Vector');
      link(t, sx, 'Z', cmp, 'A');
      link(t, cmp, 'Result', b, 'Selection');
      expect(counts(run(t, b, 'Mesh').geometry)).toEqual([...c]);
    });
  for (const [seg, c] of [
    [1, [24, 36, 14]],
    [3, [96, 156, 62]],
  ] as const)
    it(`bevels every cube vertex with ${seg} segment(s)`, () => {
      const t = setup();
      const b = node(t, 'GeometryNodeMeshBevel', { Offset: 0.1, Segments: seg }, { 'Affect Kind': 'Vertices' });
      link(t, cube(t), 'Mesh', b, 'Mesh');
      expect(counts(run(t, b, 'Mesh').geometry)).toEqual([...c]);
    });
  it('three segments on every edge', () => {
    const t = setup();
    const b = node(t, 'GeometryNodeMeshBevel', { Offset: 0.1, Segments: 3 });
    link(t, cube(t), 'Mesh', b, 'Mesh');
    expect(counts(run(t, b, 'Mesh').geometry)).toEqual([96, 192, 98]);
  });
});
