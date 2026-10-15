// @vitest-environment happy-dom
// Geometry nodes: node evaluation compared with expected values
// (counts and positions recorded below).
import { describe, it, expect } from 'vitest';
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/geonodes/core';
import { emptyDocument, uid } from '../../src/data/defaults';
import type { DocumentData, ModifierBase, NodeData, NodeGroupData, NodeTreeData, SocketValue } from '../../src/data/types';
import { addNode, connect, ctxOf } from '../../src/nodes/tree';
import { evaluateGroup } from '../../src/geonodes/modifier';
import type { EvalEnv } from '../../src/geonodes/exec';
import { GeometrySet, identity } from '../../src/geonodes/geometry';
import { getNodeType, nodeMenu } from '../../src/nodes/registry';
import { cubeMesh, coneMesh, gridMesh } from '../../src/geonodes/ops/primitives';
import { makeContext, evalFull } from '../../src/geonodes/field';
import { positionField } from '../../src/geonodes/inputs';
import { geometryToEvalMesh, evalMeshToGeometry } from '../../src/geonodes/convert';

// ---------------------------------------------------------------------------
// helpers

interface T {
  doc: DocumentData;
  group: NodeGroupData;
  tree: NodeTreeData;
  out: NodeData;
}

function setup(): T {
  const doc = emptyDocument();
  const tree: NodeTreeData = {
    type: 'GEOMETRY',
    nodes: [],
    links: [],
    interface: [
      {
        in_out: 'OUTPUT',
        name: 'Geometry',
        socket_type: 'NodeSocketGeometry',
        identifier: 'Geometry',
      },
    ],
  };
  const group: NodeGroupData = {
    id: uid('ng'),
    name: 'Test',
    tree,
    is_modifier: true,
  };
  doc.node_groups[group.id] = group;
  const out = addNode(tree, 'NodeGroupOutput', [400, 0]);
  return { doc, group, tree, out };
}

function node(t: T, type: string, inputs: Record<string, SocketValue> = {}, props: Record<string, SocketValue> = {}): NodeData {
  const n = addNode(t.tree, type, [0, 0], props);
  Object.assign(n.inputs, inputs);
  return n;
}

function link(t: T, a: NodeData, as: string, b: NodeData, bs: string) {
  const l = connect(ctxOf(t.doc, t.tree), a.id, as, b.id, bs);
  if (!l) throw new Error(`cannot link ${a.type}.${as} → ${b.type}.${bs}`);
}

function env(doc: DocumentData): EvalEnv {
  return {
    doc,
    ob: null,
    selfWorld: identity(),
    frame: 1,
    fps: 24,
    render: false,
    objectGeometry: () => null,
    objectWorld: () => null,
    collectionObjects: () => [],
    objectSig: () => '',
  };
}

function run(t: T, from: NodeData, socket = 'Geometry' as string, input = GeometrySet.empty()) {
  link(t, from, socket, t.out, 'Geometry');
  const m = {
    id: 'md',
    name: 'GN',
    type: 'NODES',
    node_group: t.group.id,
  } as unknown as ModifierBase;
  return evaluateGroup(t.group, m, env(t.doc), input, 'in', `test/${Math.random()}`, false);
}

function counts(g: GeometrySet) {
  const m = g.mesh;
  return m ? [m.vertCount, m.edgeCount, m.faceCount] : [0, 0, 0];
}

function pos(g: GeometrySet, i: number) {
  return Array.from(g.mesh!.positions.subarray(i * 3, i * 3 + 3));
}

const close = (a: number[], b: number[], eps = 1e-4) => a.every((x, i) => Math.abs(x - b[i]) < eps);

// ---------------------------------------------------------------------------

describe('geometry node registry', () => {
  it('registers the expected node names, sockets and defaults', () => {
    const grid = getNodeType('GeometryNodeMeshGrid')!;
    expect(grid.label).toBe('Grid');
    expect(grid.inputs.map((s) => [s.identifier, s.default])).toEqual([
      ['Size X', 1],
      ['Size Y', 1],
      ['Vertices X', 3],
      ['Vertices Y', 3],
    ]);
    expect(getNodeType('GeometryNodeSetPosition')!.inputs.find((s) => s.identifier === 'Offset')!.subtype).toBe('TRANSLATION');
    expect(getNodeType('GeometryNodeDistributePointsOnFaces')!.width).toBe(180);
    expect(getNodeType('ShaderNodeMath')!.treeTypes).toContain('GEOMETRY');
    const labels = nodeMenu('GEOMETRY').map((c) => c.label);
    for (const l of ['Attribute', 'Input', 'Output', 'Geometry', 'Curve', 'Instances', 'Mesh', 'Mesh Primitives', 'Point', 'Utilities', 'Vector']) expect(labels).toContain(l);
  });
});

describe('primitives', () => {
  it('matches the expected element counts', () => {
    expect([gridMesh(1, 1, 3, 3, null)].map((m) => [m.vertCount, m.edgeCount, m.faceCount])[0]).toEqual([9, 12, 4]);
    const cube4 = cubeMesh([1, 1, 1], 4, 3, 2, null);
    expect([cube4.vertCount, cube4.edgeCount, cube4.faceCount]).toEqual([24, 44, 22]);
    const cyl = coneMesh(32, 1, 1, 1, 1, 1, -1, 'NGON', null).mesh;
    expect([cyl.vertCount, cyl.edgeCount, cyl.faceCount]).toEqual([64, 96, 34]);
    const cone = coneMesh(32, 1, 1, 0, 1, 2, 0, 'NGON', null).mesh;
    expect([cone.vertCount, cone.edgeCount, cone.faceCount]).toEqual([33, 64, 33]);
  });
  it('builds UV sphere and ico sphere with the expected element order', () => {
    const t = setup();
    const r = run(t, node(t, 'GeometryNodeMeshUVSphere'), 'Mesh');
    expect(counts(r.geometry)).toEqual([482, 992, 512]);
    const t2 = setup();
    const r2 = run(t2, node(t2, 'GeometryNodeMeshIcoSphere', { Subdivisions: 3 }), 'Mesh');
    expect(counts(r2.geometry)).toEqual([162, 480, 320]);
  });
  it('orders grid and cube vertices in the expected order', () => {
    const g = gridMesh(1, 1, 3, 3, null);
    expect(Array.from(g.positions.subarray(3, 6))).toEqual([-0.5, 0, 0]);
    expect(Array.from(g.corners.subarray(0, 4))).toEqual([0, 3, 4, 1]);
    const c = cubeMesh([1, 1, 1], 2, 2, 2, null);
    expect(Array.from(c.corners)).toEqual([0, 2, 3, 1, 0, 1, 5, 4, 4, 5, 7, 6, 2, 6, 7, 3, 0, 4, 6, 2, 1, 3, 7, 5]);
  });
});

describe('fields', () => {
  it('Grid + Set Position with a math offset gives the expected positions', () => {
    const t = setup();
    const g = node(t, 'GeometryNodeMeshGrid', {
      'Size X': 2,
      'Size Y': 1,
      'Vertices X': 4,
      'Vertices Y': 3,
    });
    const p = node(t, 'GeometryNodeInputPosition');
    const sep = node(t, 'ShaderNodeSeparateXYZ');
    const mul = node(t, 'ShaderNodeMath', { Value_001: 0.5 }, { operation: 'MULTIPLY' });
    const add = node(t, 'ShaderNodeMath', {}, { operation: 'ADD' });
    const comb = node(t, 'ShaderNodeCombineXYZ');
    const sp = node(t, 'GeometryNodeSetPosition');
    link(t, p, 'Position', sep, 'Vector');
    link(t, sep, 'X', mul, 'Value');
    link(t, mul, 'Value', add, 'Value');
    link(t, sep, 'Y', add, 'Value_001');
    link(t, add, 'Value', comb, 'Z');
    link(t, g, 'Mesh', sp, 'Geometry');
    link(t, comb, 'Vector', sp, 'Offset');
    const r = run(t, sp);
    // expected: 12 verts, 17 edges, 6 faces
    expect(counts(r.geometry)).toEqual([12, 17, 6]);
    const ref = [
      [-1.0, -0.5, -1.0],
      [-1.0, 0.0, -0.5],
      [-1.0, 0.5, 0.0],
      [-0.33333, -0.5, -0.66667],
      [-0.33333, 0.0, -0.16667],
      [-0.33333, 0.5, 0.33333],
      [0.33333, -0.5, -0.33333],
      [0.33333, 0.0, 0.16667],
      [0.33333, 0.5, 0.66667],
      [1.0, -0.5, 0.0],
      [1.0, 0.0, 0.5],
      [1.0, 0.5, 1.0],
    ];
    ref.forEach((p3, i) => expect(close(pos(r.geometry, i), p3)).toBe(true));
  });

  it('Map Range / Compare / Boolean Math selection deletes the expected number of points', () => {
    const t = setup();
    const g = node(t, 'GeometryNodeMeshGrid', {
      'Vertices X': 10,
      'Vertices Y': 10,
    });
    const p = node(t, 'GeometryNodeInputPosition');
    const sep = node(t, 'ShaderNodeSeparateXYZ');
    const mr = node(t, 'ShaderNodeMapRange', {
      'From Min': -0.5,
      'From Max': 0.5,
    });
    const c1 = node(t, 'FunctionNodeCompare', { B: 0.5 }, { operation: 'GREATER_THAN' });
    const c2 = node(t, 'FunctionNodeCompare', { B: 0 }, { operation: 'LESS_THAN' });
    const bm = node(t, 'FunctionNodeBooleanMath', {}, { operation: 'AND' });
    const dl = node(t, 'GeometryNodeDeleteGeometry', {}, { domain: 'POINT' });
    link(t, p, 'Position', sep, 'Vector');
    link(t, sep, 'X', mr, 'Value');
    link(t, mr, 'Result', c1, 'A');
    link(t, sep, 'Y', c2, 'A');
    link(t, c1, 'Result', bm, 'Boolean');
    link(t, c2, 'Result', bm, 'Boolean_001');
    link(t, g, 'Mesh', dl, 'Geometry');
    link(t, bm, 'Boolean', dl, 'Selection');
    const r = run(t, dl);
    expect(r.geometry.mesh!.vertCount).toBe(75);
    expect(r.geometry.mesh!.faceCount).toBe(56);
  });

  it('adapts attribute values between mesh domains', () => {
    const g = gridMesh(1, 1, 3, 3, null);
    const ctx = makeContext(g, 'FACE');
    const p = evalFull(positionField(), ctx) as Float32Array;
    // face centers of the 2×2 grid
    expect(ctx.size).toBe(4);
    expect(close(Array.from(p.subarray(0, 3)), [-0.25, -0.25, 0])).toBe(true);
  });
});

describe('instances', () => {
  it('Instance on Points creates one instance per point; realizing gives the expected counts', () => {
    for (const realize of [false, true]) {
      const t = setup();
      const g = node(t, 'GeometryNodeMeshGrid', {
        'Vertices X': 3,
        'Vertices Y': 3,
      });
      const c = node(t, 'GeometryNodeMeshCube', { Size: [0.2, 0.2, 0.2] });
      const iop = node(t, 'GeometryNodeInstanceOnPoints');
      link(t, g, 'Mesh', iop, 'Points');
      link(t, c, 'Mesh', iop, 'Instance');
      let last = iop,
        sock = 'Instances';
      if (realize) {
        const rz = node(t, 'GeometryNodeRealizeInstances');
        link(t, iop, 'Instances', rz, 'Geometry');
        last = rz;
        sock = 'Geometry';
      }
      const r = run(t, last, sock);
      if (!realize) expect(r.geometry.instances!.count).toBe(9);
      else {
        expect(counts(r.geometry)).toEqual([72, 108, 54]);
        expect(close(pos(r.geometry, 0), [-0.6, -0.6, -0.1])).toBe(true);
      }
    }
  });
  it('converts instances to render instances sharing one mesh', () => {
    const t = setup();
    const g = node(t, 'GeometryNodeMeshGrid', {
      'Vertices X': 3,
      'Vertices Y': 3,
    });
    const c = node(t, 'GeometryNodeMeshCube');
    const iop = node(t, 'GeometryNodeInstanceOnPoints');
    link(t, g, 'Mesh', iop, 'Points');
    link(t, c, 'Mesh', iop, 'Instance');
    const r = run(t, iop, 'Instances');
    const em = geometryToEvalMesh(r.geometry);
    expect(em.instances!.length).toBe(9);
    expect(new Set(em.instances!.map((i) => i.mesh)).size).toBe(1);
  });
});

describe('mesh operations', () => {
  const extrude = (mode: string, individual: boolean, src: 'cube' | 'grid') => {
    const t = setup();
    const s = node(t, src === 'cube' ? 'GeometryNodeMeshCube' : 'GeometryNodeMeshGrid');
    const e = node(t, 'GeometryNodeExtrudeMesh', { Individual: individual, 'Offset Scale': 0.5 }, { mode });
    link(t, s, 'Mesh', e, 'Mesh');
    return run(t, e, 'Mesh').geometry;
  };
  it('Extrude Mesh matches the expected counts', () => {
    expect(counts(extrude('FACES', true, 'cube'))).toEqual([32, 60, 30]);
    const all = extrude('FACES', false, 'cube');
    expect(counts(all)).toEqual([8, 12, 6]);
    expect(close(pos(all, 0), [-0.66667, -0.66667, -0.66667])).toBe(true);
    const grid = extrude('FACES', false, 'grid');
    expect(counts(grid)).toEqual([17, 28, 12]);
    expect(close(pos(grid, 4), [0, 0, 0.5])).toBe(true);
    expect(close(pos(grid, 9), [-0.5, -0.5, 0.5])).toBe(true);
    expect(counts(extrude('VERTICES', false, 'grid'))).toEqual([18, 21, 4]);
    expect(counts(extrude('EDGES', false, 'grid'))).toEqual([18, 33, 16]);
  });

  const subdiv = (type: string, level: number, limit?: boolean, src = 'GeometryNodeMeshCube', extra: Record<string, SocketValue> = {}, props: Record<string, SocketValue> = {}) => {
    const t = setup();
    const c = node(t, src, src === 'GeometryNodeMeshGrid' ? { 'Vertices X': 3, 'Vertices Y': 3 } : {});
    const s = node(
      t,
      type,
      {
        Level: level,
        ...(limit === undefined ? {} : { 'Limit Surface': limit }),
        ...extra,
      },
      props,
    );
    link(t, c, 'Mesh', s, 'Mesh');
    return run(t, s, 'Mesh').geometry;
  };
  it('Subdivide Mesh and Subdivision Surface match the expected counts and positions', () => {
    const simple = subdiv('GeometryNodeSubdivideMesh', 2);
    expect(counts(simple)).toEqual([98, 192, 96]);
    const s1 = subdiv('GeometryNodeSubdivisionSurface', 1, true);
    expect(counts(s1)).toEqual([26, 48, 24]);
    expect(close(pos(s1, 0), [-0.25, -0.25, -0.25])).toBe(true);
    const s1n = subdiv('GeometryNodeSubdivisionSurface', 1, false);
    expect(close(pos(s1n, 0), [-0.27778, -0.27778, -0.27778])).toBe(true);
    // edge points of the limit surface
    const ep = Array.from({ length: s1.mesh!.vertCount }, (_, i) => pos(s1, i));
    expect(ep.some((p) => close(p, [0, -0.30478, -0.30478]))).toBe(true);
    const s2 = subdiv('GeometryNodeSubdivisionSurface', 2, true);
    expect(counts(s2)).toEqual([98, 192, 96]);
    expect(close(pos(s2, 0), [-0.25, -0.25, -0.25])).toBe(true);
    const all = subdiv('GeometryNodeSubdivisionSurface', 1, false, 'GeometryNodeMeshGrid', {}, { 'Boundary Smooth': 'All' });
    expect(close(pos(all, 0), [-0.4375, -0.4375, 0])).toBe(true);
    const corners = subdiv('GeometryNodeSubdivisionSurface', 1, false, 'GeometryNodeMeshGrid', {}, { 'Boundary Smooth': 'Keep Corners' });
    expect(close(pos(corners, 0), [-0.5, -0.5, 0])).toBe(true);
    expect(counts(corners)).toEqual([25, 40, 16]);
  });

  it('Triangulate, Convex Hull, Bounding Box', () => {
    let t = setup();
    let c = node(t, 'GeometryNodeMeshCube');
    const tri = node(t, 'GeometryNodeTriangulate');
    link(t, c, 'Mesh', tri, 'Mesh');
    expect(counts(run(t, tri, 'Mesh').geometry)).toEqual([8, 18, 12]);
    t = setup();
    c = node(t, 'GeometryNodeMeshCube');
    const h = node(t, 'GeometryNodeConvexHull');
    link(t, c, 'Mesh', h, 'Geometry');
    expect(counts(run(t, h, 'Convex Hull').geometry)).toEqual([8, 12, 6]);
    t = setup();
    const sph = node(t, 'GeometryNodeMeshUVSphere', { Segments: 8, Rings: 4 });
    const h2 = node(t, 'GeometryNodeConvexHull');
    link(t, sph, 'Mesh', h2, 'Geometry');
    expect(counts(run(t, h2, 'Convex Hull').geometry)).toEqual([26, 72, 48]);
    t = setup();
    c = node(t, 'GeometryNodeMeshCube');
    const tr = node(t, 'GeometryNodeTransform', {
      Rotation: [0, 0, Math.PI / 4],
    });
    const bb = node(t, 'GeometryNodeBoundBox');
    link(t, c, 'Mesh', tr, 'Geometry');
    link(t, tr, 'Geometry', bb, 'Geometry');
    const b = run(t, bb, 'Bounding Box').geometry;
    expect(close(pos(b, 0), [-0.70711, -0.70711, -0.5])).toBe(true);
    expect(close(pos(b, 7), [0.70711, 0.70711, 0.5])).toBe(true);
  });

  it('Join + Merge by Distance welds the shared column', () => {
    const t = setup();
    const g1 = node(t, 'GeometryNodeMeshGrid');
    const g2 = node(t, 'GeometryNodeMeshGrid');
    const tr = node(t, 'GeometryNodeTransform', { Translation: [1, 0, 0] });
    const j = node(t, 'GeometryNodeJoinGeometry');
    const mg = node(t, 'GeometryNodeMergeByDistance');
    link(t, g2, 'Mesh', tr, 'Geometry');
    link(t, tr, 'Geometry', j, 'Geometry');
    link(t, g1, 'Mesh', j, 'Geometry');
    link(t, j, 'Geometry', mg, 'Geometry');
    expect(counts(run(t, mg).geometry)).toEqual([15, 22, 8]);
  });

  it('Delete Geometry on faces and points', () => {
    let t = setup();
    let g = node(t, 'GeometryNodeMeshGrid', {
      'Vertices X': 4,
      'Vertices Y': 4,
    });
    const idx = node(t, 'GeometryNodeInputIndex');
    let cmp = node(t, 'FunctionNodeCompare', { B: 3 }, { operation: 'LESS_THAN' });
    let dl = node(t, 'GeometryNodeDeleteGeometry', {}, { domain: 'FACE' });
    link(t, idx, 'Index', cmp, 'A');
    link(t, g, 'Mesh', dl, 'Geometry');
    link(t, cmp, 'Result', dl, 'Selection');
    let r = run(t, dl).geometry;
    expect(counts(r)).toEqual([12, 17, 6]);
    expect(close(pos(r, 0), [-0.16667, -0.5, 0])).toBe(true);
    t = setup();
    g = node(t, 'GeometryNodeMeshGrid', { 'Vertices X': 4, 'Vertices Y': 4 });
    const p = node(t, 'GeometryNodeInputPosition');
    const sep = node(t, 'ShaderNodeSeparateXYZ');
    cmp = node(t, 'FunctionNodeCompare', {}, { operation: 'GREATER_THAN' });
    dl = node(t, 'GeometryNodeDeleteGeometry', {}, { domain: 'POINT' });
    link(t, p, 'Position', sep, 'Vector');
    link(t, sep, 'X', cmp, 'A');
    link(t, g, 'Mesh', dl, 'Geometry');
    link(t, cmp, 'Result', dl, 'Selection');
    r = run(t, dl).geometry;
    expect(counts(r)).toEqual([8, 10, 3]);
  });

  it('Mesh to Points (faces)', () => {
    const t = setup();
    const c = node(t, 'GeometryNodeMeshCube');
    const mp = node(t, 'GeometryNodeMeshToPoints', {}, { mode: 'FACES' });
    link(t, c, 'Mesh', mp, 'Mesh');
    expect(run(t, mp, 'Points').geometry.points!.count).toBe(6);
  });
});

describe('curves', () => {
  it('Curve to Mesh sweeps the profile as expected', () => {
    const t = setup();
    const c = node(t, 'GeometryNodeCurvePrimitiveCircle', { Resolution: 8 });
    const p = node(t, 'GeometryNodeCurvePrimitiveCircle', {
      Resolution: 4,
      Radius: 0.1,
    });
    const cm = node(t, 'GeometryNodeCurveToMesh');
    link(t, c, 'Curve', cm, 'Curve');
    link(t, p, 'Curve', cm, 'Profile Curve');
    const g = run(t, cm, 'Mesh').geometry;
    expect(counts(g)).toEqual([32, 64, 32]);
    expect(close(pos(g, 0), [1.1, 0, 0])).toBe(true);
    expect(close(pos(g, 1), [1.0, 0, -0.1])).toBe(true);
  });
  it('Fill Curve and Resample Curve', () => {
    for (const [mode, faces] of [
      ['Triangles', 6],
      ['N-gons', 1],
    ] as const) {
      const t = setup();
      const c = node(t, 'GeometryNodeCurvePrimitiveCircle', { Resolution: 8 });
      const f = node(t, 'GeometryNodeFillCurve', {}, { Mode: mode });
      link(t, c, 'Curve', f, 'Curve');
      const g = run(t, f, 'Mesh').geometry;
      expect(g.mesh!.vertCount).toBe(8);
      expect(g.mesh!.faceCount).toBe(faces);
    }
    const t = setup();
    const c = node(t, 'GeometryNodeCurvePrimitiveLine');
    const rs = node(t, 'GeometryNodeResampleCurve', { Count: 5 });
    link(t, c, 'Curve', rs, 'Curve');
    const cu = run(t, rs, 'Curve').geometry.curves!;
    expect(cu.pointCount).toBe(5);
    expect(Array.from(cu.positions.subarray(3, 6))).toEqual([0, 0, 0.25]);
  });
});

describe('points', () => {
  const distribute = (seed: number, density = 10) => {
    const t = setup();
    const g = node(t, 'GeometryNodeMeshGrid', {
      'Size X': 2,
      'Size Y': 2,
      'Vertices X': 2,
      'Vertices Y': 2,
    });
    const d = node(t, 'GeometryNodeDistributePointsOnFaces', {
      Density: density,
      Seed: seed,
    });
    link(t, g, 'Mesh', d, 'Mesh');
    return run(t, d, 'Points').geometry.points!;
  };
  it('Distribute Points on Faces is deterministic and matches the expected count', () => {
    const a = distribute(0),
      b = distribute(0),
      c = distribute(1);
    // expected: 40 points for area 4 × density 10
    expect(a.count).toBe(40);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.positions)).not.toEqual(Array.from(c.positions));
    for (let i = 0; i < a.positions.length; i += 3) {
      expect(Math.abs(a.positions[i])).toBeLessThanOrEqual(1);
      expect(Math.abs(a.positions[i + 1])).toBeLessThanOrEqual(1);
    }
    expect(a.attrs.get('id')!.data.length).toBe(40);
  });
});

describe('caching and conversion', () => {
  it('reuses cached upstream results when only a downstream node changes', () => {
    const t = setup();
    const g = node(t, 'GeometryNodeMeshGrid', {
      'Vertices X': 50,
      'Vertices Y': 50,
    });
    const s = node(t, 'GeometryNodeSubdivisionSurface', { Level: 2 });
    const sp = node(t, 'GeometryNodeSetPosition', { Offset: [0, 0, 1] });
    link(t, g, 'Mesh', s, 'Mesh');
    link(t, s, 'Mesh', sp, 'Geometry');
    link(t, sp, 'Geometry', t.out, 'Geometry');
    const m = {
      id: 'md',
      name: 'GN',
      type: 'NODES',
      node_group: t.group.id,
    } as unknown as ModifierBase;
    const e = env(t.doc);
    const r1 = evaluateGroup(t.group, m, e, GeometrySet.empty(), 'in', 'cache-test', false);
    expect(r1.log.executed).toBe(3);
    sp.inputs.Offset = [0, 0, 2];
    const r2 = evaluateGroup(t.group, m, e, GeometrySet.empty(), 'in', 'cache-test', false);
    expect(r2.log.executed).toBe(1);
    expect(r2.geometry.mesh!.positions[2]).toBeCloseTo(2);
  });
  it('round-trips an evaluated mesh with attributes', () => {
    const grid = gridMesh(1, 1, 3, 3, 'UVMap');
    const em = geometryToEvalMesh(new GeometrySet(grid), { uvName: 'UVMap' });
    expect(em.uvs.length).toBe(grid.cornerCount * 2);
    const back = evalMeshToGeometry(em);
    expect(back.mesh!.vertCount).toBe(9);
    expect(back.mesh!.attrs.get('UVMap')!.domain).toBe('CORNER');
  });
});

describe('attributes, groups and utilities', () => {
  it('Capture Attribute keeps values through topology changes; Store/Named Attribute round trip', () => {
    const t = setup();
    const g = node(t, 'GeometryNodeMeshGrid', {
      'Vertices X': 3,
      'Vertices Y': 3,
    });
    const idx = node(t, 'GeometryNodeInputIndex');
    const cap = node(
      t,
      'GeometryNodeCaptureAttribute',
      {},
      {
        capture_items: JSON.stringify([{ id: 0, name: 'Index', data_type: 'INT' }]),
      },
    );
    const sub = node(t, 'GeometryNodeSubdivideMesh', { Level: 1 });
    const store = node(t, 'GeometryNodeStoreNamedAttribute', { Name: 'orig' }, { data_type: 'INT' });
    link(t, g, 'Mesh', cap, 'Geometry');
    link(t, idx, 'Index', cap, 'Value');
    link(t, cap, 'Geometry', sub, 'Mesh');
    link(t, sub, 'Mesh', store, 'Geometry');
    link(t, cap, 'Attribute', store, 'Value');
    const r = run(t, store).geometry;
    const a = r.mesh!.attrs.get('orig')!;
    expect(a.type).toBe('INT');
    expect(a.data.length).toBe(25);
    // original vertices keep their captured index
    expect(Array.from(a.data.subarray(0, 9))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    // read a stored attribute back with Named Attribute
    const t2 = setup();
    const g2 = node(t2, 'GeometryNodeMeshGrid');
    const st2 = node(t2, 'GeometryNodeStoreNamedAttribute', {
      Name: 'h',
      Value: 2.5,
    });
    const na = node(t2, 'GeometryNodeInputNamedAttribute', { Name: 'h' });
    const comb = node(t2, 'ShaderNodeCombineXYZ');
    const sp = node(t2, 'GeometryNodeSetPosition');
    link(t2, g2, 'Mesh', st2, 'Geometry');
    link(t2, st2, 'Geometry', sp, 'Geometry');
    link(t2, na, 'Attribute', comb, 'Z');
    link(t2, comb, 'Vector', sp, 'Offset');
    const r2 = run(t2, sp).geometry;
    expect(r2.mesh!.positions[2]).toBeCloseTo(2.5);
  });

  it('evaluates node groups (GeometryNodeGroup) through their interface', () => {
    const t = setup();
    const inner: NodeTreeData = {
      type: 'GEOMETRY',
      nodes: [],
      links: [],
      interface: [
        {
          in_out: 'INPUT',
          name: 'Geometry',
          socket_type: 'NodeSocketGeometry',
          identifier: 'Socket_0',
        },
        {
          in_out: 'INPUT',
          name: 'Offset',
          socket_type: 'NodeSocketVector',
          identifier: 'Socket_1',
          default_value: [0, 0, 0],
        },
        {
          in_out: 'OUTPUT',
          name: 'Geometry',
          socket_type: 'NodeSocketGeometry',
          identifier: 'Socket_2',
        },
      ],
    };
    const gi = addNode(inner, 'NodeGroupInput', [0, 0]);
    const go = addNode(inner, 'NodeGroupOutput', [400, 0]);
    const tr = addNode(inner, 'GeometryNodeTransform', [200, 0]);
    const ictx = ctxOf(t.doc, inner);
    connect(ictx, gi.id, 'Socket_0', tr.id, 'Geometry');
    connect(ictx, gi.id, 'Socket_1', tr.id, 'Translation');
    connect(ictx, tr.id, 'Geometry', go.id, 'Socket_2');
    const grp: NodeGroupData = { id: 'ng_inner', name: 'Inner', tree: inner };
    t.doc.node_groups[grp.id] = grp;
    const cube = node(t, 'GeometryNodeMeshCube');
    const gnode = node(t, 'GeometryNodeGroup', { Socket_1: [0, 0, 3] }, { node_tree: grp.id });
    link(t, cube, 'Mesh', gnode, 'Socket_0');
    const r = run(t, gnode, 'Socket_2').geometry;
    expect(r.mesh!.vertCount).toBe(8);
    expect(r.mesh!.positions[2]).toBeCloseTo(2.5);
  });

  it('Random Value is deterministic per ID and seed; Switch evaluates only the chosen branch', () => {
    const build = () => {
      const t = setup();
      const g = node(t, 'GeometryNodeMeshGrid', {
        'Vertices X': 5,
        'Vertices Y': 5,
      });
      const rv = node(t, 'FunctionNodeRandomValue', {
        Min: 0,
        Max: 1,
        Seed: 3,
      });
      const comb = node(t, 'ShaderNodeCombineXYZ');
      const sp = node(t, 'GeometryNodeSetPosition');
      link(t, g, 'Mesh', sp, 'Geometry');
      link(t, rv, 'Value', comb, 'Z');
      link(t, comb, 'Vector', sp, 'Offset');
      return run(t, sp).geometry.mesh!.positions;
    };
    const a = build();
    const zs = Array.from({ length: 25 }, (_, i) => a[i * 3 + 2]);
    expect(zs.every((z) => z >= 0 && z <= 1)).toBe(true);
    expect(new Set(zs.map((z) => z.toFixed(4))).size).toBeGreaterThan(20);
    expect(Array.from(build())).toEqual(Array.from(a));
    const t3 = setup();
    const c = node(t3, 'GeometryNodeMeshCube');
    const gr = node(t3, 'GeometryNodeMeshGrid');
    const sw = node(t3, 'GeometryNodeSwitch', { Switch: true }, { input_type: 'GEOMETRY' });
    link(t3, c, 'Mesh', sw, 'False');
    link(t3, gr, 'Mesh', sw, 'True');
    const r3 = run(t3, sw, 'Output');
    expect(r3.geometry.mesh!.vertCount).toBe(9);
    expect(r3.log.executed).toBe(2); // switch + grid; the cube branch is never evaluated
  });

  it('Object Info and Collection Info read other objects (relative space, instances)', () => {
    const t = setup();
    const ob = {
      id: 'ob_a',
      name: 'A',
      type: 'MESH',
    } as unknown as DocumentData['objects'][string];
    t.doc.objects[ob.id] = ob;
    const coll = {
      id: 'co_a',
      name: 'C',
      objects: ['ob_a'],
      children: [],
      instance_offset: [0, 0, 0],
    } as unknown as DocumentData['collections'][string];
    t.doc.collections[coll.id] = coll;
    const cubeGeo = new GeometrySet(cubeMesh([1, 1, 1], 2, 2, 2, null));
    const world = Array.from(identity());
    world[12] = 5; // A is at x = 5
    const e: EvalEnv = {
      ...env(t.doc),
      objectGeometry: () => cubeGeo,
      objectWorld: () => world,
      collectionObjects: () => ['ob_a'],
      objectSig: (id) => id,
    };
    const evalWith = (from: NodeData, socket: string) => {
      link(t, from, socket, t.out, 'Geometry');
      const m = {
        id: 'md',
        name: 'GN',
        type: 'NODES',
        node_group: t.group.id,
      } as unknown as ModifierBase;
      return evaluateGroup(t.group, m, e, GeometrySet.empty(), 'in', `oi/${Math.random()}`, false);
    };
    const oi = node(t, 'GeometryNodeObjectInfo', { Object: 'ob_a' }, { transform_space: 'RELATIVE' });
    const r = evalWith(oi, 'Geometry');
    expect(r.geometry.mesh!.vertCount).toBe(8);
    expect(r.geometry.mesh!.positions[0]).toBeCloseTo(4.5);
    const ci = node(t, 'GeometryNodeCollectionInfo', {
      Collection: 'co_a',
      'Separate Children': true,
    });
    t.tree.links = t.tree.links.filter((l) => l.to_node !== t.out.id);
    const r2 = evalWith(ci, 'Instances');
    expect(r2.geometry.instances!.count).toBe(1);
    expect(r2.geometry.instances!.transforms[12]).toBeCloseTo(5);
  });

  it('Noise Texture field gives smooth values in 0..1', () => {
    const t = setup();
    const g = node(t, 'GeometryNodeMeshGrid', {
      'Vertices X': 20,
      'Vertices Y': 20,
    });
    const nz = node(t, 'ShaderNodeTexNoise', { Scale: 3 });
    const comb = node(t, 'ShaderNodeCombineXYZ');
    const sp = node(t, 'GeometryNodeSetPosition');
    link(t, g, 'Mesh', sp, 'Geometry');
    link(t, nz, 'Fac', comb, 'Z');
    link(t, comb, 'Vector', sp, 'Offset');
    const P = run(t, sp).geometry.mesh!.positions;
    const zs = Array.from({ length: 400 }, (_, i) => P[i * 3 + 2]);
    expect(Math.min(...zs)).toBeGreaterThan(0);
    expect(Math.max(...zs)).toBeLessThan(1);
    expect(Math.abs(zs[1] - zs[0])).toBeLessThan(0.2);
  });
});
