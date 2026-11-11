// @vitest-environment happy-dom
// Geometry nodes: evaluation cache invalidation and edge cases of individual nodes.
import { describe, it, expect } from 'vitest';
import { setup, node, link, run, env, attr, positions, type T } from './gnmesh-harness';
import '../../src/volume/geonodes';
import type { NodeData } from '../../src/data/types';
import { addNode, connect, ctxOf } from '../../src/nodes/tree';
import type { ModifierBase, NodeGroupData, NodeTreeData } from '../../src/data/types';
import { evaluateGroup, modifierDeps } from '../../src/geonodes/modifier';
import { convexHull } from '../../src/geonodes/ops/hull';
import { coneMesh, cubeMesh, uvSphereMesh } from '../../src/geonodes/ops/primitives';
import { GeometrySet, geometryBounds, identity } from '../../src/geonodes/geometry';

/** A group with one geometry input and one geometry output. */
function geoGroup(id: string): NodeGroupData {
  const tree: NodeTreeData = {
    type: 'GEOMETRY',
    nodes: [],
    links: [],
    interface: [
      { in_out: 'INPUT', name: 'Geometry', socket_type: 'NodeSocketGeometry', identifier: 'Socket_0' },
      { in_out: 'OUTPUT', name: 'Geometry', socket_type: 'NodeSocketGeometry', identifier: 'Socket_1' },
    ],
  };
  return { id, name: id, tree };
}

describe('evaluation cache', () => {
  it('keeps the results of unchanged inputs through a long playback', () => {
    const t = setup();
    const grid = node(t, 'GeometryNodeMeshGrid');
    const sub = node(t, 'GeometryNodeSubdivideMesh', { Level: 1 });
    link(t, grid, 'Mesh', sub, 'Mesh');
    const comb = node(t, 'ShaderNodeCombineXYZ');
    link(t, node(t, 'GeometryNodeInputSceneTime'), 'Seconds', comb, 'Z');
    const sp = node(t, 'GeometryNodeSetPosition');
    link(t, sub, 'Mesh', sp, 'Geometry');
    link(t, comb, 'Vector', sp, 'Offset');
    link(t, sp, 'Geometry', t.out, 'Geometry');
    // the grid is upstream of the cached Subdivide Mesh on every frame
    for (let f = 1; f <= 40; f++) run(t, sp, 'Geometry', undefined, { key: 'playback', frame: f });
    sub.inputs.Level = 2;
    // only Subdivide Mesh and Set Position run again
    expect(run(t, sp, 'Geometry', undefined, { key: 'playback', frame: 40 }).log.executed).toBe(2);
  });

  it('re-evaluates a group node when a group nested inside its group changes', () => {
    const t = setup();
    const inner = geoGroup('ng_inner');
    const ii = addNode(inner.tree, 'NodeGroupInput', [0, 0]);
    const io = addNode(inner.tree, 'NodeGroupOutput', [0, 0]);
    const tr = addNode(inner.tree, 'GeometryNodeTransform', [0, 0]);
    tr.inputs.Translation = [0, 0, 1];
    const ictx = ctxOf(t.doc, inner.tree);
    connect(ictx, ii.id, 'Socket_0', tr.id, 'Geometry');
    connect(ictx, tr.id, 'Geometry', io.id, 'Socket_1');
    t.doc.node_groups[inner.id] = inner;
    const outer = geoGroup('ng_outer');
    const oi = addNode(outer.tree, 'NodeGroupInput', [0, 0]);
    const oo = addNode(outer.tree, 'NodeGroupOutput', [0, 0]);
    const gi = addNode(outer.tree, 'GeometryNodeGroup', [0, 0], { node_tree: inner.id });
    const octx = ctxOf(t.doc, outer.tree);
    connect(octx, oi.id, 'Socket_0', gi.id, 'Socket_0');
    connect(octx, gi.id, 'Socket_1', oo.id, 'Socket_1');
    t.doc.node_groups[outer.id] = outer;
    const cube = node(t, 'GeometryNodeMeshCube');
    const go = node(t, 'GeometryNodeGroup', {}, { node_tree: outer.id });
    link(t, cube, 'Mesh', go, 'Socket_0');
    expect(run(t, go, 'Socket_1', undefined, { key: 'nested' }).geometry.mesh!.positions[2]).toBeCloseTo(0.5);
    tr.inputs.Translation = [0, 0, 5];
    expect(run(t, go, 'Socket_1', undefined, { key: 'nested' }).geometry.mesh!.positions[2]).toBeCloseTo(4.5);
  });

  it('re-evaluates Object Info when the object linked from the modifier input moves', () => {
    const t = setup();
    t.tree.interface!.push({ in_out: 'INPUT', name: 'Object', socket_type: 'NodeSocketObject', identifier: 'Socket_2' } as never);
    t.doc.objects.obX = { id: 'obX', name: 'X' } as never;
    const info = node(t, 'GeometryNodeObjectInfo');
    link(t, t.gin, 'Socket_2', info, 'Object');
    const cube = node(t, 'GeometryNodeMeshCube');
    const tr = node(t, 'GeometryNodeTransform');
    link(t, cube, 'Mesh', tr, 'Geometry');
    link(t, info, 'Location', tr, 'Translation');
    link(t, tr, 'Geometry', t.out, 'Geometry');
    const m = { id: 'md', name: 'GN', type: 'NODES', node_group: t.group.id, Socket_2: 'obX' } as unknown as ModifierBase;
    let x = 1;
    const e = () => ({
      ...env(t.doc),
      objectWorld: () => {
        const w = identity();
        w[12] = x;
        return w;
      },
      objectSig: () => `moved ${x}`,
    });
    expect(evaluateGroup(t.group, m, e(), GeometrySet.empty(), 'in', 'objinfo', false).geometry.mesh!.positions[0]).toBeCloseTo(0.5);
    x = 3;
    expect(evaluateGroup(t.group, m, e(), GeometrySet.empty(), 'in', 'objinfo', false).geometry.mesh!.positions[0]).toBeCloseTo(2.5);
  });

  it('makes the modifier depend on objects chosen on a Switch feeding Object Info', () => {
    const t = setup();
    t.doc.objects.obX = { id: 'obX', name: 'X' } as never;
    const sw = node(t, 'GeometryNodeSwitch', { True: 'obX' }, { input_type: 'OBJECT' });
    const info = node(t, 'GeometryNodeObjectInfo');
    link(t, sw, 'Output', info, 'Object');
    link(t, info, 'Geometry', t.out, 'Geometry');
    const m = { id: 'md', name: 'GN', type: 'NODES', node_group: t.group.id } as unknown as ModifierBase;
    expect(modifierDeps(t.doc, m)).toEqual(['obX']);
  });
});

describe('large geometry', () => {
  // more elements than a spread call (`Math.max(...values)`) can take as arguments
  const bigGrid = (t: T) => node(t, 'GeometryNodeMeshGrid', { 'Vertices X': 400, 'Vertices Y': 400, 'Size X': 2, 'Size Y': 2 });
  const store = (t: T, geo: NodeData, value: NodeData, socket: string, name: string, type = 'FLOAT') => {
    const st = node(t, 'GeometryNodeStoreNamedAttribute', { Name: name }, { data_type: type, domain: 'POINT' });
    link(t, geo, 'Mesh', st, 'Geometry');
    link(t, value, socket, st, 'Value');
    return st;
  };

  it('Field Min & Max', () => {
    const t = setup();
    const g = bigGrid(t);
    const sep = node(t, 'ShaderNodeSeparateXYZ');
    link(t, node(t, 'GeometryNodeInputPosition'), 'Position', sep, 'Vector');
    const mm = node(t, 'GeometryNodeFieldMinAndMax');
    link(t, sep, 'X', mm, 'Value');
    const r = run(t, store(t, g, mm, 'Max', 'max'));
    expect([...r.log.warnings.values()].flat()).toEqual([]);
    expect(attr(r.geometry, 'max')[0]).toBeCloseTo(1);
  });

  it('Geometry Proximity to points', () => {
    const t = setup();
    const g = bigGrid(t);
    const prox = node(t, 'GeometryNodeProximity', {}, { target_element: 'POINTS' });
    link(t, g, 'Mesh', prox, 'Target');
    const r = run(t, store(t, g, prox, 'Distance', 'dist'));
    expect([...r.log.warnings.values()].flat()).toEqual([]);
    expect(attr(r.geometry, 'dist').every((d) => d === 0)).toBe(true);
  });

  it('Points to Curves', () => {
    const t = setup();
    const p = node(t, 'GeometryNodeMeshToPoints');
    link(t, bigGrid(t), 'Mesh', p, 'Mesh');
    const pc = node(t, 'GeometryNodePointsToCurves');
    link(t, p, 'Points', pc, 'Points');
    const r = run(t, pc, 'Curves');
    expect([...r.log.warnings.values()].flat()).toEqual([]);
    expect(r.geometry.curves!.pointCount).toBe(160000);
  });
});

describe('Convex Hull', () => {
  const counts = (m: { vertCount: number; edgeCount: number; faceCount: number }) => [m.vertCount, m.edgeCount, m.faceCount];

  it('keeps only the corners of points lying on edges and faces of the hull', () => {
    expect(counts(convexHull(cubeMesh([1, 2, 3], 4, 4, 4, null).positions))).toEqual([8, 12, 6]);
    // side segment rings lie on the cone's straight sides: ring + apex
    const cone = coneMesh(24, 3, 2, 0, 1, 1, -1, 'TRIANGLE_FAN', null).mesh;
    expect(convexHull(cone.positions).vertCount).toBe(25);
  });

  it('builds a closed hull of a dense sphere', { timeout: 60000 }, () => {
    // all points are on the hull (took tens of seconds when every new point was tested against every face)
    const h = convexHull(uvSphereMesh(200, 120, 1, null).positions);
    expect(h.vertCount).toBe(23802);
    expect(h.vertCount - h.edgeCount + h.faceCount).toBe(2);
  });
});

describe('instances', () => {
  it('Realize Instances keeps nested instances below the depth and volumes', () => {
    const t = setup();
    const inner = node(t, 'GeometryNodeInstanceOnPoints');
    link(t, node(t, 'GeometryNodeMeshLine', { Count: 2 }), 'Mesh', inner, 'Points');
    link(t, node(t, 'GeometryNodeMeshCube'), 'Mesh', inner, 'Instance');
    const outer = node(t, 'GeometryNodeInstanceOnPoints');
    link(t, node(t, 'GeometryNodeMeshLine', { Count: 3, Offset: [0, 5, 0] }), 'Mesh', outer, 'Points');
    link(t, inner, 'Instances', outer, 'Instance');
    const join = node(t, 'GeometryNodeJoinGeometry');
    link(t, outer, 'Instances', join, 'Geometry');
    link(t, node(t, 'GeometryNodeVolumeCube', { 'Resolution X': 4, 'Resolution Y': 4, 'Resolution Z': 4 }), 'Volume', join, 'Geometry');
    const re = node(t, 'GeometryNodeRealizeInstances', { 'Realize All': false, Depth: 0 });
    link(t, join, 'Geometry', re, 'Geometry');
    const g = run(t, re).geometry;
    // the outer level is realized: its references were the 2 inner instances
    expect(g.instances?.count).toBe(6);
    expect(g.volume?.grids.length).toBe(1);
  });

  it('Instance on Points keeps point attributes of several components and of source instances', () => {
    const t = setup();
    const line = node(t, 'GeometryNodeMeshLine', { Count: 3 });
    const st = node(t, 'GeometryNodeStoreNamedAttribute', { Name: 'foo' }, { data_type: 'FLOAT', domain: 'POINT' });
    link(t, line, 'Mesh', st, 'Geometry');
    link(t, node(t, 'GeometryNodeInputIndex'), 'Index', st, 'Value');
    const pts = node(t, 'GeometryNodeMeshToPoints');
    link(t, st, 'Geometry', pts, 'Mesh');
    const join = node(t, 'GeometryNodeJoinGeometry');
    link(t, st, 'Geometry', join, 'Geometry');
    link(t, pts, 'Points', join, 'Geometry');
    const iop = node(t, 'GeometryNodeInstanceOnPoints');
    link(t, join, 'Geometry', iop, 'Points');
    link(t, node(t, 'GeometryNodeMeshCube'), 'Mesh', iop, 'Instance');
    expect(attr(run(t, iop, 'Instances').geometry, 'foo', 'INSTANCE')).toEqual([0, 1, 2, 0, 1, 2]);
    // instancing again on those instances
    const t2 = setup();
    const first = node(t2, 'GeometryNodeInstanceOnPoints');
    link(t2, node(t2, 'GeometryNodeMeshLine', { Count: 3 }), 'Mesh', first, 'Points');
    link(t2, node(t2, 'GeometryNodeMeshCube'), 'Mesh', first, 'Instance');
    const st2 = node(t2, 'GeometryNodeStoreNamedAttribute', { Name: 'foo' }, { data_type: 'FLOAT', domain: 'INSTANCE' });
    link(t2, first, 'Instances', st2, 'Geometry');
    link(t2, node(t2, 'GeometryNodeInputIndex'), 'Index', st2, 'Value');
    const second = node(t2, 'GeometryNodeInstanceOnPoints');
    link(t2, st2, 'Geometry', second, 'Points');
    link(t2, node(t2, 'GeometryNodeMeshCube'), 'Mesh', second, 'Instance');
    expect(attr(run(t2, second, 'Instances').geometry, 'foo', 'INSTANCE')).toEqual([0, 1, 2]);
  });

  it('Instance on Points keeps the transform of a picked instance', () => {
    const t = setup();
    // two instances of a cube, the second one moved up by 5
    const two = node(t, 'GeometryNodeInstanceOnPoints');
    link(t, node(t, 'GeometryNodeMeshLine', { Count: 2, Offset: [0, 0, 5] }), 'Mesh', two, 'Points');
    link(t, node(t, 'GeometryNodeMeshCube'), 'Mesh', two, 'Instance');
    const iop = node(t, 'GeometryNodeInstanceOnPoints', { 'Pick Instance': true });
    link(t, node(t, 'FunctionNodeInputInt', {}, { integer: 1 }), 'Integer', iop, 'Instance Index');
    link(t, node(t, 'GeometryNodeMeshLine', { Count: 1, 'Start Location': [10, 0, 0] }), 'Mesh', iop, 'Points');
    link(t, two, 'Instances', iop, 'Instance');
    const re = node(t, 'GeometryNodeRealizeInstances');
    link(t, iop, 'Instances', re, 'Geometry');
    const b = geometryBounds(run(t, re).geometry)!;
    expect(b.min).toEqual([9.5, -0.5, 4.5]);
    expect(b.max).toEqual([10.5, 0.5, 5.5]);
  });

  it('Rotate Instances in local space turns a stretched instance rigidly', () => {
    const t = setup();
    const iop = node(t, 'GeometryNodeInstanceOnPoints', { Scale: [2, 1, 1] });
    link(t, node(t, 'GeometryNodeMeshLine', { Count: 1 }), 'Mesh', iop, 'Points');
    link(t, node(t, 'GeometryNodeMeshCube'), 'Mesh', iop, 'Instance');
    const rot = node(t, 'GeometryNodeRotateInstances', { Rotation: [0, 0, Math.PI / 2], 'Local Space': true });
    link(t, iop, 'Instances', rot, 'Instances');
    const re = node(t, 'GeometryNodeRealizeInstances');
    link(t, rot, 'Instances', re, 'Geometry');
    const b = geometryBounds(run(t, re).geometry)!;
    expect(b.max[0] - b.min[0]).toBeCloseTo(1);
    expect(b.max[1] - b.min[1]).toBeCloseTo(2);
  });
});

describe('modifier inputs', () => {
  it('converts a modifier input value when its socket type changes', async () => {
    const { syncModifierInputs } = await import('../../src/geonodes/editor');
    const t = setup();
    t.tree.interface!.push(
      { in_out: 'INPUT', name: 'A', socket_type: 'NodeSocketFloat', identifier: 'Socket_2' } as never,
      { in_out: 'INPUT', name: 'B', socket_type: 'NodeSocketInt', identifier: 'Socket_3' } as never,
      { in_out: 'INPUT', name: 'C', socket_type: 'NodeSocketColor', identifier: 'Socket_4' } as never,
      { in_out: 'INPUT', name: 'D', socket_type: 'NodeSocketObject', identifier: 'Socket_5' } as never,
      { in_out: 'INPUT', name: 'E', socket_type: 'NodeSocketVector', identifier: 'Socket_6' } as never,
    );
    // values kept from Vector, Object, Vector, Float and Color sockets
    const m = { Socket_2: [1, 2, 3], Socket_3: 'ob_x', Socket_4: [1, 2, 3], Socket_5: 2, Socket_6: [0.5, 0.25, 0, 1] } as unknown as ModifierBase;
    syncModifierInputs(m, t.group);
    expect([m.Socket_2, m.Socket_3, m.Socket_4, m.Socket_5, m.Socket_6]).toEqual([1, 0, [1, 2, 3, 1], null, [0.5, 0.25, 0]]);
  });
});

describe('modifier signature', () => {
  it('ignores moving, selecting and collapsing nodes and panning the editor', async () => {
    const { modifierTypes } = await import('../../src/eval/modifiers');
    const t = setup();
    const grid = node(t, 'GeometryNodeMeshGrid');
    link(t, grid, 'Mesh', t.out, 'Geometry');
    const ob = { id: 'ob', name: 'Ob', modifiers: [], material_slots: [] } as never;
    const m = { id: 'md', name: 'GN', type: 'NODES', node_group: t.group.id } as unknown as ModifierBase;
    const sig = () => modifierTypes.NODES.signature!(m, { doc: t.doc, ob, graph: null as never, frame: 1 });
    const before = sig();
    grid.location = [120, -40];
    grid.select = true;
    grid.hide = true;
    t.tree.view = { x: 10, y: 20, zoom: 2 };
    t.tree.active_node = grid.id;
    expect(sig()).toBe(before);
    grid.inputs['Vertices X'] = 7;
    expect(sig()).not.toBe(before);
  });
});

describe('mesh primitives', () => {
  it('Mesh Line by resolution spaces points by exactly the resolution', () => {
    const t = setup();
    const line = node(t, 'GeometryNodeMeshLine', { 'Start Location': [0, 0, 0], Offset: [1, 0, 0], Resolution: 0.3 }, { mode: 'END_POINTS', count_mode: 'RESOLUTION' });
    expect(positions(run(t, line, 'Mesh').geometry).map((p) => p[0])).toEqual([0, 0.3, 0.6, 0.9]);
  });
});

describe('curve fields', () => {
  it('Spline Parameter factor of a zero-length curve runs from 0 to 1 by point index', () => {
    const t = setup();
    const line = node(t, 'GeometryNodeMeshLine', { Count: 4, Offset: [0, 0, 0] });
    const curve = node(t, 'GeometryNodeMeshToCurve');
    link(t, line, 'Mesh', curve, 'Mesh');
    const st = node(t, 'GeometryNodeStoreNamedAttribute', { Name: 'f' }, { data_type: 'FLOAT', domain: 'POINT' });
    link(t, curve, 'Curve', st, 'Geometry');
    link(t, node(t, 'GeometryNodeSplineParameter'), 'Factor', st, 'Value');
    const f = attr(run(t, st).geometry, 'f');
    expect(f.map((x) => Math.round(x * 1000) / 1000)).toEqual([0, 0.333, 0.667, 1]);
  });
});
