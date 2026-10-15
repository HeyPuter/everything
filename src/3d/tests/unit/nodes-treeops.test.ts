import { describe, it, expect } from 'vitest';
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/nodes/shader/nodegen';
import { addNode, connect, ctxOf, makeGroup, makeLinks, nodeById } from '../../src/nodes/tree';
import {
  addReroutes,
  collapseHideUnused,
  connectToOutput,
  copyColor,
  detachLinks,
  detachNodes,
  groupInsert,
  groupSeparate,
  insertOffset,
  joinGroupInputs,
  nameParts,
  parentSet,
  sameTypeStep,
  selectGrouped,
  swapNode,
  toggleLinkMute,
} from '../../src/nodes/treeops';
import { emptyDocument } from '../../src/data/defaults';
import type { NodeTreeData } from '../../src/data/types';

const tree = (): NodeTreeData => ({ type: 'SHADER', nodes: [], links: [] });

describe('grouped selection', () => {
  it('splits names at the last separator', () => {
    expect(nameParts('Math.001')).toEqual(['Math', '001']);
    expect(nameParts('wood_mask')).toEqual(['wood', 'mask']);
    expect(nameParts('Noise')).toBeNull();
  });
  it('selects by type, color, prefix and suffix of the active node', () => {
    const t = tree();
    const a = addNode(t, 'ShaderNodeMath', [0, 0]);
    const b = addNode(t, 'ShaderNodeMath', [200, 0]);
    const c = addNode(t, 'ShaderNodeValue', [400, 0]);
    t.active_node = a.id;
    expect(selectGrouped(t, 'TYPE')).toBe(2);
    expect(c.select).toBeFalsy();
    // color: only nodes with the same custom color (or all without one)
    a.use_custom_color = true;
    a.color = [1, 0, 0];
    c.use_custom_color = true;
    c.color = [1, 0, 0];
    selectGrouped(t, 'COLOR');
    expect([a.select, b.select, c.select]).toEqual([true, false, true]);
    // prefix / suffix
    a.name = 'mask_x';
    b.name = 'mask_y';
    c.name = 'wood_x';
    selectGrouped(t, 'PREFIX');
    expect([a.select, b.select, c.select]).toEqual([true, true, false]);
    selectGrouped(t, 'SUFFIX');
    expect([a.select, b.select, c.select]).toEqual([true, false, true]);
    // extend keeps the current selection
    b.select = true;
    selectGrouped(t, 'SUFFIX', true);
    expect([a.select, b.select, c.select]).toEqual([true, true, true]);
  });
  it('steps through nodes of the same type left to right', () => {
    const t = tree();
    const a = addNode(t, 'ShaderNodeMath', [0, 0]);
    const b = addNode(t, 'ShaderNodeMath', [400, 0]);
    addNode(t, 'ShaderNodeValue', [200, 0]);
    const c = addNode(t, 'ShaderNodeMath', [200, 0]);
    t.active_node = a.id;
    expect(sameTypeStep(t, false)?.id).toBe(c.id);
    expect(sameTypeStep(t, false)?.id).toBe(b.id);
    expect(sameTypeStep(t, false)?.id).toBe(a.id);
    expect(sameTypeStep(t, true)?.id).toBe(b.id);
    expect(t.nodes.filter((n) => n.select).map((n) => n.id)).toEqual([b.id]);
  });
});

describe('frames', () => {
  it('attaches to the active frame and detaches from unselected frames', () => {
    const t = tree();
    const f = addNode(t, 'NodeFrame', [0, 0]);
    const a = addNode(t, 'ShaderNodeMath', [0, 0]);
    const b = addNode(t, 'ShaderNodeMath', [0, 0]);
    expect(parentSet(t, [a.id, b.id, f.id], f.id)).toBe(2);
    expect(a.parent).toBe(f.id);
    // a frame cannot go inside its own child frame
    const inner = addNode(t, 'NodeFrame', [0, 0]);
    inner.parent = f.id;
    expect(parentSet(t, [f.id], inner.id)).toBe(0);
    detachNodes(t, new Set([a.id]));
    expect(a.parent).toBeNull();
    // children keep a frame that is detached with them
    detachNodes(t, new Set([inner.id, b.id, f.id]));
    expect(b.parent).toBe(f.id);
  });
});

describe('links', () => {
  it('makes and replaces links between neighbours', () => {
    const t = tree();
    const ctx = ctxOf(emptyDocument(), t);
    const v = addNode(t, 'ShaderNodeValue', [0, 0]);
    const w = addNode(t, 'ShaderNodeValue', [0, 100]);
    const m = addNode(t, 'ShaderNodeMath', [200, 0]);
    connect(ctx, w.id, 'Value', m.id, 'Value');
    // the free second input is used
    expect(makeLinks(ctx, [v.id, m.id])).toBe(1);
    expect(t.links.find((l) => l.from_node === v.id)?.to_socket).toBe('Value_001');
    t.links = [{ id: 'l1', from_node: w.id, from_socket: 'Value', to_node: m.id, to_socket: 'Value' }, { id: 'l2', from_node: w.id, from_socket: 'Value', to_node: m.id, to_socket: 'Value_001' }];
    expect(makeLinks(ctx, [v.id, m.id])).toBe(0);
    expect(makeLinks(ctx, [v.id, m.id], true)).toBe(1);
    expect(t.links.find((l) => l.from_node === v.id)?.to_socket).toBe('Value');
  });
  it('mutes links and adds shared reroutes on crossed links', () => {
    const t = tree();
    const ctx = ctxOf(emptyDocument(), t);
    const v = addNode(t, 'ShaderNodeValue', [0, 0]);
    const a = addNode(t, 'ShaderNodeMath', [300, 0]);
    const b = addNode(t, 'ShaderNodeMath', [300, -200]);
    const l1 = connect(ctx, v.id, 'Value', a.id, 'Value')!;
    const l2 = connect(ctx, v.id, 'Value', b.id, 'Value')!;
    toggleLinkMute(t, new Set([l1.id]));
    expect(l1.is_muted).toBe(true);
    toggleLinkMute(t, new Set([l1.id, l2.id]));
    expect([l1.is_muted, l2.is_muted]).toEqual([true, true]);
    toggleLinkMute(t, new Set([l1.id, l2.id]));
    expect([l1.is_muted, l2.is_muted]).toEqual([undefined, undefined]);
    const made = addReroutes(t, [
      { link: l1.id, x: 150, y: 0 },
      { link: l2.id, x: 150, y: -100 },
    ]);
    expect(made).toHaveLength(1);
    expect(made[0].location).toEqual([150, -50]);
    expect(t.links.filter((l) => l.from_node === made[0].id)).toHaveLength(2);
    expect(t.links.find((l) => l.to_node === made[0].id)?.from_node).toBe(v.id);
  });
  it('detaches nodes, joining their neighbours', () => {
    const t = tree();
    const ctx = ctxOf(emptyDocument(), t);
    const a = addNode(t, 'ShaderNodeValue', [0, 0]);
    const m = addNode(t, 'ShaderNodeMath', [200, 0]);
    const b = addNode(t, 'ShaderNodeMath', [400, 0]);
    connect(ctx, a.id, 'Value', m.id, 'Value');
    connect(ctx, m.id, 'Value', b.id, 'Value');
    detachLinks(ctx, new Set([m.id]));
    expect(t.links).toHaveLength(1);
    expect(t.links[0]).toMatchObject({ from_node: a.id, to_node: b.id });
  });
  it('pushes downstream nodes right after an insert', () => {
    const t = tree();
    const ctx = ctxOf(emptyDocument(), t);
    const ins = addNode(t, 'ShaderNodeMath', [100, 0]);
    const b = addNode(t, 'ShaderNodeMath', [200, 0]);
    const c = addNode(t, 'ShaderNodeMath', [400, 0]);
    const left = addNode(t, 'ShaderNodeValue', [-200, 0]);
    connect(ctx, left.id, 'Value', ins.id, 'Value');
    connect(ctx, ins.id, 'Value', b.id, 'Value');
    connect(ctx, b.id, 'Value', c.id, 'Value');
    const dx = insertOffset(t, ins, () => 140, 40);
    expect(dx).toBe(80);
    expect(b.location[0]).toBe(280);
    expect(c.location[0]).toBe(480);
    expect(left.location[0]).toBe(-200);
  });
  it('connects to the material output, cycling outputs', () => {
    const t = tree();
    const ctx = ctxOf(emptyDocument(), t);
    const out = addNode(t, 'ShaderNodeOutputMaterial', [400, 0]);
    const tex = addNode(t, 'ShaderNodeTexNoise', [0, 0]);
    connectToOutput(ctx, tex, 'MATERIAL');
    expect(t.links).toHaveLength(1);
    expect(t.links[0]).toMatchObject({ from_node: tex.id, to_node: out.id, to_socket: 'Surface' });
    const first = t.links[0].from_socket;
    connectToOutput(ctx, tex, 'MATERIAL');
    expect(t.links).toHaveLength(1);
    expect(t.links[0].from_socket).not.toBe(first);
  });
});

describe('show / hide and color', () => {
  it('collapses and hides unused sockets, then restores', () => {
    const t = tree();
    const ctx = ctxOf(emptyDocument(), t);
    const a = addNode(t, 'ShaderNodeValue', [0, 0]);
    const m = addNode(t, 'ShaderNodeMath', [200, 0]);
    connect(ctx, a.id, 'Value', m.id, 'Value');
    collapseHideUnused(ctx, [m]);
    expect(m.hide).toBe(true);
    expect(m.hidden_sockets).toEqual(['in:Value_001', 'out:Value']);
    collapseHideUnused(ctx, [m]);
    expect(m.hide).toBe(false);
    expect(m.hidden_sockets).toEqual([]);
  });
  it('copies the active color to the selection', () => {
    const t = tree();
    const a = addNode(t, 'ShaderNodeValue', [0, 0]);
    const b = addNode(t, 'ShaderNodeValue', [0, 0]);
    a.use_custom_color = true;
    a.color = [0.2, 0.4, 0.6];
    t.active_node = a.id;
    a.select = b.select = true;
    expect(copyColor(t)).toBe(1);
    expect(b.color).toEqual([0.2, 0.4, 0.6]);
    expect(b.use_custom_color).toBe(true);
  });
});

describe('swap', () => {
  it('keeps links by socket name and type and keeps values', () => {
    const t = tree();
    const ctx = ctxOf(emptyDocument(), t);
    const tex = addNode(t, 'ShaderNodeTexNoise', [0, 0]);
    const bsdf = addNode(t, 'ShaderNodeBsdfDiffuse', [200, 0]);
    const out = addNode(t, 'ShaderNodeOutputMaterial', [400, 0]);
    connect(ctx, tex.id, 'Color', bsdf.id, 'Color');
    connect(ctx, bsdf.id, 'BSDF', out.id, 'Surface');
    bsdf.inputs.Roughness = 0.7;
    bsdf.label = 'Base';
    t.active_node = bsdf.id;
    const n = swapNode(ctx, bsdf, 'ShaderNodeBsdfPrincipled')!;
    expect(nodeById(t, bsdf.id)).toBeUndefined();
    expect(n.location).toEqual([200, 0]);
    expect(n.label).toBe('Base');
    expect(t.active_node).toBe(n.id);
    expect(t.links.find((l) => l.to_node === n.id)).toMatchObject({ from_node: tex.id, to_socket: 'Base Color' });
    expect(t.links.find((l) => l.from_node === n.id)).toMatchObject({ to_node: out.id, to_socket: 'Surface' });
    expect(n.inputs.Roughness).toBe(0.7);
  });
});

describe('groups', () => {
  it('joins group input nodes', () => {
    const t: NodeTreeData = { type: 'SHADER', nodes: [], links: [], interface: [] };
    const g1 = addNode(t, 'NodeGroupInput', [0, 0]);
    const g2 = addNode(t, 'NodeGroupInput', [0, -200]);
    const m = addNode(t, 'ShaderNodeMath', [200, 0]);
    t.interface!.push({ in_out: 'INPUT', name: 'A', socket_type: 'NodeSocketFloat', identifier: 'Socket_0' }, { in_out: 'INPUT', name: 'B', socket_type: 'NodeSocketFloat', identifier: 'Socket_1' });
    t.links.push({ id: 'a', from_node: g1.id, from_socket: 'Socket_0', to_node: m.id, to_socket: 'Value' }, { id: 'b', from_node: g2.id, from_socket: 'Socket_1', to_node: m.id, to_socket: 'Value_001' });
    t.active_node = g2.id;
    const keep = joinGroupInputs(t, new Set([g1.id, g2.id]))!;
    expect(keep.id).toBe(g2.id);
    expect(t.nodes.filter((n) => n.type === 'NodeGroupInput')).toHaveLength(1);
    expect(t.links.every((l) => l.from_node === g2.id)).toBe(true);
  });
  it('inserts nodes into a group and separates them again', () => {
    const d = emptyDocument();
    const t = tree();
    const ctx = ctxOf(d, t);
    const val = addNode(t, 'ShaderNodeValue', [0, 0]);
    const m1 = addNode(t, 'ShaderNodeMath', [200, 0]);
    const m2 = addNode(t, 'ShaderNodeMath', [400, 0]);
    const out = addNode(t, 'ShaderNodeOutputMaterial', [600, 0]);
    connect(ctx, val.id, 'Value', m1.id, 'Value');
    connect(ctx, m1.id, 'Value', m2.id, 'Value');
    connect(ctx, m2.id, 'Value', out.id, 'Surface');
    const gnode = makeGroup(d, t, new Set([m1.id]))!;
    const group = d.node_groups[gnode.props.node_tree as string];
    // m2 follows the group: insert it
    expect(groupInsert(d, t, gnode.id, new Set([m2.id]))).toBe(true);
    expect(nodeById(t, m2.id)).toBeUndefined();
    expect(group.tree.nodes.filter((n) => n.type === 'ShaderNodeMath')).toHaveLength(2);
    // the group now feeds the output directly through a new interface output
    const outer = t.links.find((l) => l.to_node === out.id)!;
    expect(outer.from_node).toBe(gnode.id);
    const innerMaths = group.tree.nodes.filter((n) => n.type === 'ShaderNodeMath');
    const gout = group.tree.nodes.find((n) => n.type === 'NodeGroupOutput')!;
    expect(group.tree.links.some((l) => innerMaths.some((x) => x.id === l.from_node) && l.to_node === gout.id && l.to_socket === outer.from_socket)).toBe(true);
    // separate (copy) the second math node back out
    const second = innerMaths.find((n) => !group.tree.links.some((l) => nodeById(group.tree, l.from_node)?.type === 'NodeGroupInput' && l.to_node === n.id))!;
    const made = groupSeparate(d, t, gnode.id, new Set([second.id]), 'COPY');
    expect(made).toHaveLength(1);
    expect(t.links.some((l) => l.from_node === made[0].id && l.to_node === out.id)).toBe(true);
    expect(group.tree.nodes.filter((n) => n.type === 'ShaderNodeMath')).toHaveLength(2);
    groupSeparate(d, t, gnode.id, new Set([second.id]), 'MOVE');
    expect(group.tree.nodes.filter((n) => n.type === 'ShaderNodeMath')).toHaveLength(1);
  });
  it('refuses to insert a group into itself', () => {
    const d = emptyDocument();
    const t = tree();
    const m = addNode(t, 'ShaderNodeMath', [0, 0]);
    const gnode = makeGroup(d, t, new Set([m.id]))!;
    const copy = addNode(t, 'ShaderNodeGroup', [0, 0], { node_tree: gnode.props.node_tree as string });
    expect(groupInsert(d, t, gnode.id, new Set([copy.id]))).toBe(false);
  });
});
