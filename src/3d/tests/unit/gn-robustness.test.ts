// @vitest-environment happy-dom
// Geometry nodes: evaluation cache invalidation and edge cases of individual nodes.
import { describe, it, expect } from 'vitest';
import { setup, node, link, run } from './gnmesh-harness';
import { addNode, connect, ctxOf } from '../../src/nodes/tree';
import type { NodeGroupData, NodeTreeData } from '../../src/data/types';

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
});
