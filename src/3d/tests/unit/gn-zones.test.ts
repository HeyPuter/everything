// @vitest-environment happy-dom
// Geometry node zones (Repeat, Simulation, For Each Element) and the Bake node.
import { describe, it, expect } from 'vitest';
import { setup, node, zone, link, run, counts, positions, attr } from './gnmesh-harness';
import { addItem } from '../../src/geonodes/zones/itemops';
import { ZONES } from '../../src/geonodes/zones/kinds';
import { readItems } from '../../src/geonodes/zones/items';
import { GeometrySet } from '../../src/geonodes/geometry';
import { constOf, type Field } from '../../src/geonodes/field';
import { nodeMenu, getNodeType, nodeSockets } from '../../src/nodes/registry';
import { ctxOf } from '../../src/nodes/tree';
import type { MenuCategory } from '../../src/nodes/types';

const list = (zoneId: string, key: string) => ZONES.find((z) => z.id === zoneId)!.lists.find((l) => l.key === key)!;

describe('repeat zone', () => {
  it('adds the paired output with a linked geometry item', () => {
    const t = setup();
    const [i, o] = zone(t, 'GeometryNodeRepeatInput');
    expect(o.type).toBe('GeometryNodeRepeatOutput');
    expect(i.props.paired_output).toBe(o.id);
    expect(readItems(o, 'repeat_items').map((x) => [x.name, x.socket_type])).toEqual([['Geometry', 'GEOMETRY']]);
    expect(t.tree.links.some((l) => l.from_node === i.id && l.to_node === o.id && l.from_socket === 'Item_0' && l.to_socket === 'Item_0')).toBe(true);
    const s = nodeSockets(i, ctxOf(t.doc, t.tree));
    expect(s.inputs.map((x) => x.identifier)).toEqual(['Iterations', 'Item_0', '__extend__']);
    expect(s.outputs.map((x) => x.identifier)).toEqual(['Iteration', 'Item_0', '__extend__']);
  });

  it('repeats a body (offset per iteration, accumulated value, iteration index)', () => {
    const t = setup();
    const [i, o] = zone(t, 'GeometryNodeRepeatInput');
    const v = addItem(o, list('REPEAT', 'repeat_items'), 'FLOAT', 'Value');
    const sum = addItem(o, list('REPEAT', 'repeat_items'), 'INT', 'Sum');
    i.inputs.Iterations = 3;
    i.inputs[`Item_${v.id}`] = 1;
    const cube = node(t, 'GeometryNodeMeshCube');
    link(t, cube, 'Mesh', i, 'Item_0');
    // body: set position offset z+1 (replacing the direct geometry link)
    t.tree.links = t.tree.links.filter((l) => !(l.from_node === i.id && l.to_node === o.id));
    const sp = node(t, 'GeometryNodeSetPosition', { Offset: [0, 0, 1] });
    link(t, i, 'Item_0', sp, 'Geometry');
    link(t, sp, 'Geometry', o, 'Item_0');
    const mul = node(t, 'ShaderNodeMath', { Value_001: 2 }, { operation: 'MULTIPLY' });
    link(t, i, `Item_${v.id}`, mul, 'Value');
    link(t, mul, 'Value', o, `Item_${v.id}`);
    const add = node(t, 'ShaderNodeMath', {}, { operation: 'ADD' });
    link(t, i, `Item_${sum.id}`, add, 'Value');
    link(t, i, 'Iteration', add, 'Value_001');
    link(t, add, 'Value', o, `Item_${sum.id}`);
    const r = run(t, o, 'Item_0');
    expect(counts(r.geometry)).toEqual([8, 12, 6]);
    expect(
      positions(r.geometry)
        .map((p) => p[2])
        .sort(),
    ).toEqual([2.5, 2.5, 2.5, 2.5, 3.5, 3.5, 3.5, 3.5]);
    expect(r.log.warnings.size).toBe(0);
    // value item: 1 * 2^3, sum of iteration indices 0+1+2
    const t2 = t;
    t2.tree.links = t2.tree.links.filter((l) => l.to_node !== t2.out.id);
    t2.tree.interface!.push(
      {
        in_out: 'OUTPUT',
        name: 'V',
        socket_type: 'NodeSocketFloat',
        identifier: 'V',
      },
      {
        in_out: 'OUTPUT',
        name: 'S',
        socket_type: 'NodeSocketInt',
        identifier: 'S',
      },
    );
    link(t2, o, `Item_${v.id}`, t2.out, 'V');
    link(t2, o, `Item_${sum.id}`, t2.out, 'S');
    link(t2, o, 'Item_0', t2.out, 'Geometry');
    const r2 = run(t2, o);
    expect(constOf(r2.outputs.V as Field)).toBe(8);
    expect(constOf(r2.outputs.S as Field)).toBe(3);
  });

  it('zero iterations passes the inputs through', () => {
    const t = setup();
    const [i, o] = zone(t, 'GeometryNodeRepeatInput');
    i.inputs.Iterations = 0;
    const cube = node(t, 'GeometryNodeMeshCube');
    link(t, cube, 'Mesh', i, 'Item_0');
    const r = run(t, o, 'Item_0');
    expect(counts(r.geometry)).toEqual([8, 12, 6]);
  });

  it('nested repeat zones', () => {
    const t = setup();
    const [i1, o1] = zone(t, 'GeometryNodeRepeatInput');
    const [i2, o2] = zone(t, 'GeometryNodeRepeatInput');
    i1.inputs.Iterations = 2;
    i2.inputs.Iterations = 3;
    const pts = node(t, 'GeometryNodeMeshLine', { Count: 1 });
    link(t, pts, 'Mesh', i1, 'Item_0');
    t.tree.links = t.tree.links.filter((l) => !(l.from_node === i1.id && l.to_node === o1.id) && !(l.from_node === i2.id && l.to_node === o2.id));
    link(t, i1, 'Item_0', i2, 'Item_0');
    const sp = node(t, 'GeometryNodeSetPosition', { Offset: [1, 0, 0] });
    link(t, i2, 'Item_0', sp, 'Geometry');
    link(t, sp, 'Geometry', o2, 'Item_0');
    link(t, o2, 'Item_0', o1, 'Item_0');
    const r = run(t, o1, 'Item_0');
    expect(positions(r.geometry)).toEqual([[6, 0, 0]]);
  });
});

describe('simulation zone', () => {
  function simTree() {
    const t = setup();
    const [i, o] = zone(t, 'GeometryNodeSimulationInput');
    const acc = addItem(o, list('SIMULATION', 'state_items'), 'FLOAT', 'Acc');
    // acc += 1 per step; x of the output geometry = acc; z += delta time * 24
    const add = node(t, 'ShaderNodeMath', { Value_001: 1 }, { operation: 'ADD' });
    link(t, i, `Item_${acc.id}`, add, 'Value');
    link(t, add, 'Value', o, `Item_${acc.id}`);
    const line = node(t, 'GeometryNodeMeshLine', { Count: 1 });
    link(t, line, 'Mesh', i, 'Item_0');
    t.tree.links = t.tree.links.filter((l) => !(l.from_node === i.id && l.to_node === o.id));
    const dt = node(t, 'ShaderNodeMath', { Value_001: 24 }, { operation: 'MULTIPLY' });
    link(t, i, 'Delta Time', dt, 'Value');
    const comb = node(t, 'ShaderNodeCombineXYZ');
    link(t, dt, 'Value', comb, 'Z');
    const sp = node(t, 'GeometryNodeSetPosition');
    link(t, i, 'Item_0', sp, 'Geometry');
    link(t, comb, 'Vector', sp, 'Offset');
    link(t, sp, 'Geometry', o, 'Item_0');
    const sp2 = node(t, 'GeometryNodeSetPosition');
    link(t, o, 'Item_0', sp2, 'Geometry');
    const comb2 = node(t, 'ShaderNodeCombineXYZ');
    const z = node(t, 'ShaderNodeSeparateXYZ');
    const pos = node(t, 'GeometryNodeInputPosition');
    link(t, pos, 'Position', z, 'Vector');
    link(t, o, `Item_${acc.id}`, comb2, 'X');
    link(t, z, 'Z', comb2, 'Z');
    link(t, comb2, 'Vector', sp2, 'Position');
    link(t, sp2, 'Geometry', t.out, 'Geometry');
    return { t, sp2 };
  }
  const xz = (g: GeometrySet) => [positions(g)[0][0], positions(g)[0][2]];

  it('steps one frame at a time and restarts when going back before the cache', () => {
    const { t, sp2 } = simTree();
    const key = `sim/${Math.random()}`;
    const at = (f: number) => xz(run(t, sp2, 'Geometry', GeometrySet.empty(), { frame: f, key }).geometry);
    // the first evaluated frame runs the zone once with a zero time step
    expect(at(1)).toEqual([1, 0]);
    expect(at(2)).toEqual([2, 1]);
    expect(at(3)).toEqual([3, 2]);
    // cached frame
    expect(at(1)).toEqual([1, 0]);
    // steps from the cached previous frame
    expect(at(4)).toEqual([4, 3]);
    // skipped frames: one step from the last evaluated earlier frame
    expect(at(8)).toEqual([5, 4]);
    // before every cached frame: start over
    const k2 = `sim/${Math.random()}`;
    const at2 = (f: number) => xz(run(t, sp2, 'Geometry', GeometrySet.empty(), { frame: f, key: k2 }).geometry);
    expect(at2(3)).toEqual([1, 0]);
    expect(at2(4)).toEqual([2, 1]);
    expect(at2(8)).toEqual([3, 2]);
    expect(at2(2)).toEqual([1, 0]);
    expect(at2(9)).toEqual([2, 1]);
  });

  it('skip keeps the previous state', () => {
    const { t, sp2 } = simTree();
    const so = t.tree.nodes.find((n) => n.type === 'GeometryNodeSimulationOutput')!;
    so.inputs.Skip = true;
    const key = `sim/${Math.random()}`;
    const at = (f: number) => xz(run(t, sp2, 'Geometry', GeometrySet.empty(), { frame: f, key }).geometry);
    expect(at(1)).toEqual([0, 0]);
    expect(at(2)).toEqual([0, 0]);
  });
});

describe('for each geometry element zone', () => {
  function forEach(domain: string) {
    const t = setup();
    const [i, o] = zone(t, 'GeometryNodeForeachGeometryElementInput');
    o.props.domain = domain;
    const m = addItem(o, list('FOREACH', 'main_items'), 'FLOAT', 'M');
    const grid = node(t, 'GeometryNodeMeshGrid', {
      'Vertices X': 3,
      'Vertices Y': 2,
    });
    link(t, grid, 'Mesh', i, 'Geometry');
    const mul = node(t, 'ShaderNodeMath', { Value_001: 2 }, { operation: 'MULTIPLY' });
    link(t, i, 'Index', mul, 'Value');
    link(t, mul, 'Value', o, `Main_${m.id}`);
    return { t, i, o, m };
  }

  it('adds the output with an element → generation link', () => {
    const { t, i, o } = forEach('POINT');
    expect(t.tree.links.some((l) => l.from_node === i.id && l.from_socket === 'Element' && l.to_node === o.id && l.to_socket === 'Generation_0')).toBe(true);
  });

  for (const [domain, n, gen] of [
    ['POINT', 6, [6, 0, 0]],
    ['EDGE', 7, [14, 7, 0]],
    ['FACE', 2, [8, 8, 2]],
  ] as const) {
    it(`main values and joined elements on ${domain}`, () => {
      const { t, o, m } = forEach(domain);
      const r = run(t, o, 'Geometry');
      expect(counts(r.geometry)).toEqual([6, 7, 2]);
      const name = [...r.geometry.mesh!.attrs.keys()].find((k) => k.endsWith(`:Main_${m.id}`))!;
      expect(attr(r.geometry, name, domain)).toEqual(Array.from({ length: n }, (_, k) => k * 2));
      const t2 = forEach(domain);
      const r2 = run(t2.t, t2.o, 'Generation_0');
      expect(counts(r2.geometry)).toEqual([...gen]);
    });
  }
});

describe('zone menus', () => {
  const find = (cats: MenuCategory['items'], path: string[]): MenuCategory | undefined => {
    let pool = cats;
    let c: MenuCategory | undefined;
    for (const p of path) {
      c = pool.find((x) => x !== 'SEPARATOR' && !('idname' in x) && x.label === p) as MenuCategory | undefined;
      if (!c) return undefined;
      pool = c.items;
    }
    return c;
  };
  it('places zones in Utilities and Simulation', () => {
    const menu = nodeMenu('GEOMETRY');
    const util = find(menu, ['Utilities'])!;
    const labels = util.items.map((x) => (x === 'SEPARATOR' ? '---' : 'idname' in x ? (x.label ?? getNodeType(x.idname)?.label) : x.label));
    expect(labels).toContain('Repeat');
    expect(labels).toContain('For Each Element');
    expect(labels.indexOf('Repeat')).toBeGreaterThan(labels.indexOf('Random Value'));
    expect(labels.indexOf('Repeat')).toBeLessThan(labels.indexOf('Switch'));
    const sim = find(menu, ['Simulation'])!;
    expect(sim.items).toEqual([{ idname: 'GeometryNodeSimulationInput', label: 'Simulation' }]);
    expect(find(menu, ['Geometry', 'Operations'])!.items.some((x) => x !== 'SEPARATOR' && 'idname' in x && x.idname === 'GeometryNodeBake')).toBe(true);
  });
});
