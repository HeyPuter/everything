// @vitest-environment happy-dom
// Instance nodes: Geometry to Instance, Instances to Points, Split to Instances.
import { describe, it, expect } from 'vitest';
import { setup, node, link, run, counts, positions, attr } from './gnmesh-harness';

describe('instance nodes', () => {
  it('geometry to instance (empty geometry included) and instances to points', () => {
    const t = setup();
    const g2i = node(t, 'GeometryNodeGeometryToInstance');
    link(t, node(t, 'GeometryNodeMeshCube'), 'Mesh', g2i, 'Geometry');
    link(t, node(t, 'GeometryNodeMeshGrid', { 'Vertices X': 0 }), 'Mesh', g2i, 'Geometry');
    link(t, node(t, 'GeometryNodeMeshLine', { Count: 2 }), 'Mesh', g2i, 'Geometry');
    const tr = node(t, 'GeometryNodeTranslateInstances', { Translation: [1, 2, 3] });
    link(t, g2i, 'Instances', tr, 'Instances');
    const ip = node(t, 'GeometryNodeInstancesToPoints', { Radius: 0.3 });
    link(t, tr, 'Instances', ip, 'Instances');
    const r = run(t, ip, 'Points');
    expect(positions(r.geometry)).toEqual([
      [1, 2, 3],
      [1, 2, 3],
      [1, 2, 3],
    ]);
    expect(Array.from(r.geometry.points!.attrs.get('radius')!.data).map((x) => Math.round(x * 100) / 100)).toEqual([0.3, 0.3, 0.3]);
  });

  it('split to instances groups faces by id in order of first appearance', () => {
    const t = setup();
    const grid = node(t, 'GeometryNodeMeshGrid', { 'Vertices X': 4, 'Vertices Y': 3 });
    const mod = node(t, 'ShaderNodeMath', { Value_001: 3 }, { operation: 'FLOORED_MODULO' });
    const neg = node(t, 'ShaderNodeMath', { Value_001: -5 }, { operation: 'MULTIPLY' });
    link(t, node(t, 'GeometryNodeInputIndex'), 'Index', mod, 'Value');
    link(t, mod, 'Value', neg, 'Value');
    const s = node(t, 'GeometryNodeSplitToInstances', {}, { domain: 'FACE' });
    link(t, grid, 'Mesh', s, 'Geometry');
    link(t, neg, 'Value', s, 'Group ID');
    const st = node(t, 'GeometryNodeStoreNamedAttribute', { Name: 'gid' }, { data_type: 'INT', domain: 'INSTANCE' });
    link(t, s, 'Instances', st, 'Geometry');
    link(t, s, 'Group ID', st, 'Value');
    const re = node(t, 'GeometryNodeRealizeInstances');
    link(t, st, 'Geometry', re, 'Geometry');
    const r = run(t, re, 'Geometry');
    expect(counts(r.geometry)).toEqual([22, 24, 6]);
    expect(positions(r.geometry).slice(0, 7)).toEqual([
      [-0.5, -0.5, 0],
      [-0.5, 0, 0],
      [-0.1667, -0.5, 0],
      [-0.1667, 0, 0],
      [-0.1667, 0.5, 0],
      [0.1667, 0, 0],
      [0.1667, 0.5, 0],
    ]);
    expect(attr(r.geometry, 'gid', 'POINT', 'INT')).toEqual([0, 0, 0, 0, 0, 0, 0, -5, -5, -5, -5, -5, -5, -5, -5, -10, -10, -10, -10, -10, -10, -10]);
  });
});
