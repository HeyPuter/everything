// @vitest-environment happy-dom
// Bundles and closures in geometry nodes, plus the shared item list helpers of nodes with
// dynamic items.
import { describe, it, expect } from 'vitest';
import { setup, node, zone, link, run, positions } from './gnmesh-harness';
import { addItem as addZoneItem } from '../../src/geonodes/zones/itemops';
import { ZONES } from '../../src/geonodes/zones/kinds';
import { readItems as readZoneItems } from '../../src/geonodes/zones/items';
import { addItem, removeItem, moveActiveItem, listItems, readItems } from '../../src/geonodes/nodes/items';
import { COMBINE_ITEMS, SEPARATE_ITEMS, EVAL_INPUTS, EVAL_OUTPUTS, syncSockets, linkedSignature } from '../../src/geonodes/bundles/nodes';
import { BundleValue } from '../../src/geonodes/bundles/values';
import { nodeSockets } from '../../src/nodes/registry';
import { ctxOf } from '../../src/nodes/tree';

const closureList = (key: string) => ZONES.find((z) => z.id === 'CLOSURE')!.lists.find((l) => l.key === key)!;

describe('bundles', () => {
  it('combines values and separates them by name', () => {
    const t = setup();
    const comb = node(t, 'NodeCombineBundle');
    const g = addItem(comb, COMBINE_ITEMS, [], 'Mesh', 'GEOMETRY');
    const hgt = addItem(comb, COMBINE_ITEMS, listItems(comb, COMBINE_ITEMS), 'Height', 'FLOAT');
    comb.inputs[`Item_${hgt.id}`] = 2;
    const sep = node(t, 'NodeSeparateBundle');
    // separated in the other order: matched by name, not position
    const sh = addItem(sep, SEPARATE_ITEMS, [], 'Height', 'FLOAT');
    const sg = addItem(sep, SEPARATE_ITEMS, listItems(sep, SEPARATE_ITEMS), 'Mesh', 'GEOMETRY');
    const cube = node(t, 'GeometryNodeMeshCube', { Size: [1, 1, 1] });
    link(t, cube, 'Mesh', comb, `Item_${g.id}`);
    link(t, comb, 'Bundle', sep, 'Bundle');
    const xyz = node(t, 'ShaderNodeCombineXYZ');
    link(t, sep, `Item_${sh.id}`, xyz, 'Z');
    const sp = node(t, 'GeometryNodeSetPosition');
    link(t, sep, `Item_${sg.id}`, sp, 'Geometry');
    link(t, xyz, 'Vector', sp, 'Offset');
    const r = run(t, sp);
    const zs = positions(r.geometry).map((p) => p[2]);
    expect(Math.min(...zs)).toBeCloseTo(1.5);
    expect(Math.max(...zs)).toBeCloseTo(2.5);
  });

  it('gets and stores items at nested paths', () => {
    const b = new BundleValue().with('Settings/Size', { type: 'FLOAT', value: 3 }).with('Name', { type: 'STRING', value: 'x' });
    expect(b.get('Settings/Size')?.value).toBe(3);
    expect(b.get('Settings')?.type).toBe('BUNDLE');
    expect(b.get('Missing/Size')).toBeUndefined();
    expect(b.without('Settings/Size').get('Settings/Size')).toBeUndefined();
    expect(b.get('Name')?.value).toBe('x');
    const j = BundleValue.join([
      BundleValue.of([['A', { type: 'INT', value: 1 }]]),
      BundleValue.of([
        ['A', { type: 'INT', value: 2 }],
        ['B', { type: 'INT', value: 3 }],
      ]),
    ]);
    expect([j.get('A')?.value, j.get('B')?.value]).toEqual([1, 3]);

    const t = setup();
    const store = node(t, 'NodeStoreBundleItem', { Path: 'Offset/Z', Item: 4 }, { socket_type: 'FLOAT' });
    const get = node(t, 'NodeGetBundleItem', { Path: 'Offset/Z' }, { socket_type: 'FLOAT' });
    link(t, store, 'Bundle', get, 'Bundle');
    const xyz = node(t, 'ShaderNodeCombineXYZ');
    link(t, get, 'Item', xyz, 'Z');
    const cube = node(t, 'GeometryNodeMeshCube', { Size: [1, 1, 1] });
    const sp = node(t, 'GeometryNodeSetPosition');
    link(t, cube, 'Mesh', sp, 'Geometry');
    link(t, xyz, 'Vector', sp, 'Offset');
    const r = run(t, sp);
    expect(Math.max(...positions(r.geometry).map((p) => p[2]))).toBeCloseTo(4.5);
  });
});

describe('closures', () => {
  function closureTree() {
    const t = setup();
    const [ci, co] = zone(t, 'NodeClosureInput');
    expect(co.type).toBe('NodeClosureOutput');
    const inMesh = addZoneItem(co, closureList('input_items'), 'GEOMETRY', 'Mesh');
    const inAmt = addZoneItem(co, closureList('input_items'), 'FLOAT', 'Amount');
    const outRes = addZoneItem(co, closureList('output_items'), 'GEOMETRY', 'Result');
    // body: move the mesh up by Amount
    const xyz = node(t, 'ShaderNodeCombineXYZ');
    link(t, ci, `Item_${inAmt.id}`, xyz, 'Z');
    const sp = node(t, 'GeometryNodeSetPosition');
    link(t, ci, `Item_${inMesh.id}`, sp, 'Geometry');
    link(t, xyz, 'Vector', sp, 'Offset');
    link(t, sp, 'Geometry', co, `Item_${outRes.id}`);
    return { t, ci, co };
  }

  it('evaluates a closure body with the given inputs', () => {
    const { t, co } = closureTree();
    const ev = node(t, 'NodeEvaluateClosure');
    const a = addItem(ev, EVAL_INPUTS, [], 'Amount', 'FLOAT');
    const m = addItem(ev, EVAL_INPUTS, listItems(ev, EVAL_INPUTS), 'Mesh', 'GEOMETRY');
    const res = addItem(ev, EVAL_OUTPUTS, [], 'Result', 'GEOMETRY');
    ev.inputs[`Item_${a.id}`] = 3;
    link(t, co, 'Closure', ev, 'Closure');
    const cube = node(t, 'GeometryNodeMeshCube', { Size: [1, 1, 1] });
    link(t, cube, 'Mesh', ev, `Item_${m.id}`);
    const r = run(t, ev, `Item_${res.id}`);
    expect(Math.min(...positions(r.geometry).map((p) => p[2]))).toBeCloseTo(2.5);
    // evaluated twice with different inputs in the same tree
    const ev2 = node(t, 'NodeEvaluateClosure');
    syncSockets(t.tree, (link(t, co, 'Closure', ev2, 'Closure'), ev2));
    const ins = readItems(ev2, 'input_items');
    expect(ins.map((i) => i.name)).toEqual(['Mesh', 'Amount']);
    ev2.inputs[`Item_${ins[1].id}`] = -1;
    link(t, cube, 'Mesh', ev2, `Item_${ins[0].id}`);
    const outs = readItems(ev2, 'output_items');
    t.tree.links = t.tree.links.filter((l) => l.to_node !== t.out.id);
    const r2 = run(t, ev2, `Item_${outs[0].id}`);
    expect(Math.min(...positions(r2.geometry).map((p) => p[2]))).toBeCloseTo(-1.5);
  });

  it('outputs defaults without a closure and exposes the zone sockets', () => {
    const { t, ci, co } = closureTree();
    const s = nodeSockets(ci, ctxOf(t.doc, t.tree));
    expect(s.outputs.map((x) => x.name)).toEqual(['Mesh', 'Amount', '']);
    expect(nodeSockets(co, ctxOf(t.doc, t.tree)).outputs.map((x) => x.identifier)).toEqual(['Closure']);
    const ev = node(t, 'NodeEvaluateClosure');
    const res = addItem(ev, EVAL_OUTPUTS, [], 'Result', 'GEOMETRY');
    const r = run(t, ev, `Item_${res.id}`);
    expect(positions(r.geometry)).toEqual([]);
  });

  it('syncs a closure zone to the Evaluate Closure it feeds', () => {
    const t = setup();
    const [ci, co] = zone(t, 'NodeClosureInput');
    const ev = node(t, 'NodeEvaluateClosure');
    addItem(ev, EVAL_INPUTS, [], 'Count', 'INT');
    addItem(ev, EVAL_OUTPUTS, [], 'Out', 'GEOMETRY');
    link(t, co, 'Closure', ev, 'Closure');
    expect(linkedSignature(t.tree, ci)?.inputs).toEqual([{ name: 'Count', socket_type: 'INT' }]);
    expect(syncSockets(t.tree, ci)).toBe(true);
    expect(readZoneItems(co, 'input_items').map((i) => [i.name, i.socket_type])).toEqual([['Count', 'INT']]);
    expect(readZoneItems(co, 'output_items').map((i) => [i.name, i.socket_type])).toEqual([['Out', 'GEOMETRY']]);
    expect(syncSockets(t.tree, ci)).toBe(false);
  });
});

describe('item lists', () => {
  it('adds unique names, moves the active item and unlinks removed items', () => {
    const t = setup();
    const comb = node(t, 'NodeCombineBundle');
    const a = addItem(comb, COMBINE_ITEMS, [], 'Value', 'FLOAT');
    const b = addItem(comb, COMBINE_ITEMS, listItems(comb, COMBINE_ITEMS), 'Value', 'INT');
    expect(listItems(comb, COMBINE_ITEMS).map((i) => i.name)).toEqual(['Value', 'Value.001']);
    comb.props.active_index = 1;
    expect(moveActiveItem(comb, COMBINE_ITEMS, -1)).toBe(true);
    expect(listItems(comb, COMBINE_ITEMS).map((i) => i.id)).toEqual([b.id, a.id]);
    expect(comb.props.active_index).toBe(0);
    expect(moveActiveItem(comb, COMBINE_ITEMS, -1)).toBe(false);
    const v = node(t, 'ShaderNodeValue');
    link(t, v, 'Value', comb, `Item_${a.id}`);
    removeItem(t.tree, comb, COMBINE_ITEMS, a.id);
    expect(t.tree.links.some((l) => l.to_node === comb.id)).toBe(false);
    expect(listItems(comb, COMBINE_ITEMS).map((i) => i.id)).toEqual([b.id]);
  });
});

describe('lists', () => {
  it('builds lists from fields and reads, filters and sorts them', async () => {
    const { FIELD_TO_LIST_ITEMS } = await import('../../src/geonodes/bundles/lists');
    const t = setup();
    const ftl = node(t, 'GeometryNodeFieldToList', { Count: 5 });
    const it = addItem(ftl, FIELD_TO_LIST_ITEMS, [], 'V', 'INT');
    // values: (index * 3) mod 5 → 0 3 1 4 2
    const idx = node(t, 'GeometryNodeInputIndex');
    const math = node(t, 'FunctionNodeIntegerMath', { Value_001: 3 }, { operation: 'MULTIPLY' });
    link(t, idx, 'Index', math, 'Value');
    const mod = node(t, 'FunctionNodeIntegerMath', { Value_001: 5 }, { operation: 'MODULO' });
    link(t, math, 'Value', mod, 'Value');
    link(t, mod, 'Value', ftl, `Field_${it.id}`);
    const sort = node(t, 'GeometryNodeSortList', {}, { socket_type: 'INT' });
    link(t, ftl, `List_${it.id}`, sort, 'List');
    link(t, mod, 'Value', sort, 'Sort Weight');
    const get = node(t, 'GeometryNodeListGetItem', { Index: 3 }, { socket_type: 'INT' });
    link(t, sort, 'List', get, 'List');
    const len = node(t, 'GeometryNodeListLength', {}, { data_type: 'INT' });
    link(t, ftl, `List_${it.id}`, len, 'List');
    // points: count = length, z of point = sorted[3] (= 3)
    const pts = node(t, 'GeometryNodePoints');
    link(t, len, 'Length', pts, 'Count');
    const xyz = node(t, 'ShaderNodeCombineXYZ');
    link(t, get, 'Value', xyz, 'Z');
    link(t, xyz, 'Vector', pts, 'Position');
    const r = run(t, pts, 'Points');
    const p = r.geometry.points!.positions as Float32Array;
    expect(p.length / 3).toBe(5);
    expect(p[2]).toBe(3);
  });
});
