// @vitest-environment happy-dom
// Geometry nodes: evaluation cache invalidation and edge cases of individual nodes.
import { describe, it, expect } from 'vitest';
import { setup, node, link, run, env, attr, type T } from './gnmesh-harness';
import type { NodeData } from '../../src/data/types';
import { addNode, connect, ctxOf } from '../../src/nodes/tree';
import type { ModifierBase, NodeGroupData, NodeTreeData } from '../../src/data/types';
import { evaluateGroup, modifierDeps } from '../../src/geonodes/modifier';
import { GeometrySet, identity } from '../../src/geonodes/geometry';

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
