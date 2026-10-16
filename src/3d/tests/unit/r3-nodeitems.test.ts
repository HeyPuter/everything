// @vitest-environment happy-dom
// Item lists of the Viewer node (extra values) and the compositor File Output node.
import { describe, it, expect } from 'vitest';
import { setup, node, link, env } from './gnmesh-harness';
import { addItem } from '../../src/geonodes/nodes/items';
import { VIEWER_ITEMS, viewerItemIn } from '../../src/geonodes/nodes/vieweritems';
import { evaluateGroup } from '../../src/geonodes/modifier';
import { GeometrySet } from '../../src/geonodes/geometry';
import { columnsOf } from '../../src/spreadsheet/data';
import type { ModifierBase, NodeData, NodeTreeData } from '../../src/data/types';
import '../../src/compositor/nodes/defs';
import '../../src/compositor/nodes/extra';
import { addSlot, moveSlot, removeSlot, renameSlot } from '../../src/compositor/ops/fileoutitems';
import { fileSlots } from '../../src/compositor/ops/fileoutput';

describe('viewer extra values', () => {
  it('stores each linked extra value as its own spreadsheet column', () => {
    const t = setup();
    const cube = node(t, 'GeometryNodeMeshCube', { Size: [2, 2, 2] });
    link(t, cube, 'Mesh', t.out, 'Geometry');
    const viewer = node(t, 'GeometryNodeViewer', {}, { viewer_active: true });
    link(t, cube, 'Mesh', viewer, 'Geometry');
    const idx = node(t, 'GeometryNodeInputIndex');
    const pos = node(t, 'GeometryNodeInputPosition');
    link(t, idx, 'Index', viewer, 'Value');
    const it = addItem(viewer, VIEWER_ITEMS, [], 'Where', 'FLOAT_VECTOR');
    link(t, pos, 'Position', viewer, viewerItemIn(it));
    const m = { id: 'md', name: 'GN', type: 'NODES', node_group: t.group.id } as unknown as ModifierBase;
    const r = evaluateGroup(t.group, m, env(t.doc), GeometrySet.empty(), 'in', 'viewer-test', true);
    const cols = columnsOf(r.viewer!.mesh!, 'POINT');
    expect(cols.map((c) => c.name).slice(0, 3)).toEqual(['Viewer', 'Where', 'position']);
    const where = cols.find((c) => c.name === 'Where')!;
    expect(Array.from(where.data as Float32Array).slice(0, 3)).toEqual(Array.from(r.viewer!.mesh!.positions.slice(0, 3)));
  });
});

describe('file output inputs', () => {
  it('adds unique inputs, renames keeping links, moves and removes the active one', () => {
    const n = { id: 'fo', type: 'CompositorNodeOutputFile', name: 'File Output', location: [0, 0], inputs: {}, props: {} } as unknown as NodeData;
    const tree = { type: 'COMPOSITOR', nodes: [n], links: [] } as unknown as NodeTreeData;
    expect(fileSlots(n)).toEqual(['Image']);
    expect(addSlot(n)).toBe('Image_001');
    expect(addSlot(n, 'Depth')).toBe('Depth');
    tree.links.push({ id: 'l', from_node: 'x', from_socket: 'Image', to_node: 'fo', to_socket: 'Depth' });
    expect(renameSlot(tree, n, 2, 'Z')).toBe(true);
    expect(tree.links[0].to_socket).toBe('Z');
    expect(renameSlot(tree, n, 2, 'Image')).toBe(false);
    expect(n.props.active_index).toBe(2);
    expect(moveSlot(n, -1)).toBe(true);
    expect(fileSlots(n)).toEqual(['Image', 'Z', 'Image_001']);
    expect(removeSlot(tree, n)).toBe(true);
    expect(fileSlots(n)).toEqual(['Image', 'Image_001']);
    expect(tree.links).toEqual([]);
  });
});
