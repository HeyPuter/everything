// @vitest-environment happy-dom
// Function, field, topology and input geometry nodes: trees from tests/fixtures/geonodes are
// evaluated and their stored attributes compared with the recorded expected values.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSpec, firstMismatch, type GnSpec } from './gnspec';

const dir = join(__dirname, '../fixtures/geonodes');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const cases = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { name: string; spec: GnSpec; expected: Record<string, unknown[]> }[];
  describe(`geometry nodes: ${file.replace('.json', '')}`, () => {
    for (const c of cases)
      it(c.name, () => {
        const r = runSpec(c.spec);
        expect(r.errors).toEqual([]);
        for (const [label, exp] of Object.entries(c.expected)) {
          const got = r.values[label];
          expect(got, `${label} missing`).toBeDefined();
          const i = firstMismatch(exp, got);
          expect(i, `${label}[${i}]: expected ${JSON.stringify(exp[i])}, got ${JSON.stringify(got?.[i])}`).toBe(-1);
        }
      });
  });
}

// ---------------------------------------------------------------------------
// behaviour that is not a stored attribute

import { emptyDocument, uid } from '../../src/data/defaults';
import { addNode, connect, ctxOf } from '../../src/nodes/tree';
import { evaluateGroup } from '../../src/geonodes/modifier';
import { GeometrySet } from '../../src/geonodes/geometry';
import { groupInputMenuItems } from '../../src/geonodes/nodes/switches';
import { resolveItemLinks, ITEM_SOCKET } from '../../src/geonodes/nodes/items';
import { formatItems } from '../../src/geonodes/nodes/fn_string';
import { formatString, shortestFloat } from '../../src/geonodes/strformat';
import { testEnv } from './gnspec';
import { getNodeType } from '../../src/nodes/registry';
import { TreeEval } from '../../src/geonodes/evaluator';
import type { ModifierBase, NodeGroupData, NodeTreeData } from '../../src/data/types';

function group(): { doc: ReturnType<typeof emptyDocument>; g: NodeGroupData; tree: NodeTreeData } {
  const doc = emptyDocument();
  const tree: NodeTreeData = {
    type: 'GEOMETRY',
    nodes: [],
    links: [],
    interface: [
      { in_out: 'INPUT', name: 'Mode', socket_type: 'NodeSocketMenu', identifier: 'Socket_0' },
      { in_out: 'OUTPUT', name: 'Geometry', socket_type: 'NodeSocketGeometry', identifier: 'Socket_1' },
    ],
  };
  const g: NodeGroupData = { id: uid('ng'), name: 'G', tree, is_modifier: true };
  doc.node_groups[g.id] = g;
  return { doc, g, tree };
}

describe('menus', () => {
  it('a group menu input takes the items of the menu switch it feeds, and the modifier value picks the branch', () => {
    const { doc, g, tree } = group();
    const gi = addNode(tree, 'NodeGroupInput', [0, 0]);
    const out = addNode(tree, 'NodeGroupOutput', [400, 0]);
    const ms = addNode(tree, 'GeometryNodeMenuSwitch', [200, 0], {
      enum_items: JSON.stringify([
        { id: 0, name: 'Cube' },
        { id: 1, name: 'Line' },
      ]),
    } as Record<string, never>);
    const cube = addNode(tree, 'GeometryNodeMeshCube', [0, 0]);
    const line = addNode(tree, 'GeometryNodeMeshLine', [0, 0]);
    const ctx = ctxOf(doc, tree);
    expect(connect(ctx, gi.id, 'Socket_0', ms.id, 'Menu')).toBeTruthy();
    connect(ctx, cube.id, 'Mesh', ms.id, 'Item_0');
    connect(ctx, line.id, 'Mesh', ms.id, 'Item_1');
    connect(ctx, ms.id, 'Output', out.id, 'Socket_1');
    expect(groupInputMenuItems(doc, tree, 'Socket_0')).toEqual(['Cube', 'Line']);
    const run = (v?: string) => {
      const m = { id: 'md', name: 'GN', type: 'NODES', node_group: g.id, ...(v ? { Socket_0: v } : {}) } as unknown as ModifierBase;
      return evaluateGroup(g, m, testEnv(doc), GeometrySet.empty(), 'in', `menu/${uid('k')}`, false).geometry.mesh!.vertCount;
    };
    expect(run()).toBe(8);
    expect(run('Line')).toBe(10);
  });
});

describe('node items', () => {
  it('linking to the empty item socket of Format String adds an input of the linked type', () => {
    const doc = emptyDocument();
    const tree: NodeTreeData = { type: 'GEOMETRY', nodes: [], links: [], interface: [] };
    doc.node_groups.x = { id: 'x', name: 'X', tree };
    const f = addNode(tree, 'FunctionNodeFormatString', [0, 0]);
    const i = addNode(tree, 'FunctionNodeInputInt', [0, 0]);
    tree.links.push({ id: 'l', from_node: i.id, from_socket: 'Integer', to_node: f.id, to_socket: ITEM_SOCKET });
    expect(resolveItemLinks(doc)).toBe(true);
    expect(formatItems(f)).toEqual([{ id: 0, name: 'Integer', type: 'INT' }]);
    expect(tree.links.map((l) => l.to_socket)).toEqual(['Item_0']);
  });
});

describe('text formatting', () => {
  it('formats numbers like the template language describes', () => {
    const v = (value: number | string, type: 'FLOAT' | 'INT' | 'STRING' = 'FLOAT') => [{ name: 'x', type, value }];
    expect(formatString('{x:.2f}', v(Math.fround(0.125))).text).toBe('0.12');
    expect(formatString('{x:>6}|', v('ab', 'STRING')).text).toBe('    ab|');
    expect(formatString('{x:+05}', v(42, 'INT')).text).toBe('+0042');
    expect(formatString('{y}', v(1)).error).toBeTruthy();
    expect(shortestFloat(Math.fround(0.1))).toBe('0.1');
    expect(shortestFloat(1e7)).toBe('1e+07');
  });
});

describe('warning node', () => {
  it('reports its message when shown', () => {
    const r = runSpec({
      nodes: { g: { type: 'GeometryNodeMeshLine' }, w: { type: 'GeometryNodeWarning', inputs: { Message: 'Too many points' } }, s: { type: 'GeometryNodeSwitch', props: { input_type: 'GEOMETRY' } } },
      links: [
        ['w', 'Show', 's', 'Switch'],
        ['g', 'Mesh', 's', 'True'],
      ],
      geometry: ['s', 'Output'],
    });
    expect(r.warnings).toContain('Too many points');
  });
});

// ---------------------------------------------------------------------------
// scene inputs (expected values recorded from equivalent scenes)

import { newArmature, newCamera, newObject } from '../../src/data/defaults';
import { defaultPoseBone } from '../../src/eval/armature';
import { composeMat } from '../../src/geonodes/geometry';
import type { Bone } from '../../src/data/types';

function single(r: ReturnType<typeof runSpec>, label: string) {
  return r.values[label]?.[0];
}
const near = (a: unknown, b: number[] | number, eps = 1e-4) => {
  const x = Array.isArray(a) ? a : [a as number];
  const y = Array.isArray(b) ? b : [b];
  expect(x.length).toBe(y.length);
  x.forEach((v, i) => expect(Math.abs((v as number) - y[i])).toBeLessThan(eps));
};

describe('scene input nodes', () => {
  it('Camera Info reports lens values and the projection for the render size', () => {
    const doc = emptyDocument();
    doc.scene.render.resolution_x = 1920;
    doc.scene.render.resolution_y = 1080;
    const cd = newCamera('Cam');
    Object.assign(cd, { lens: 35, sensor_width: 32, sensor_height: 20, shift_x: 0.1, shift_y: -0.2, clip_start: 0.2, clip_end: 50, ortho_scale: 7 });
    cd.dof.focus_distance = 12;
    doc.cameras[cd.id] = cd;
    const cam = newObject('Cam', 'CAMERA', cd.id);
    doc.objects[cam.id] = cam;
    const cd2 = newCamera('Cam2');
    Object.assign(cd2, { type: 'ORTHO', ortho_scale: 5, sensor_fit: 'VERTICAL' });
    doc.cameras[cd2.id] = cd2;
    const cam2 = newObject('Cam2', 'CAMERA', cd2.id);
    doc.objects[cam2.id] = cam2;
    doc.scene.camera = cam2.id;
    const outs = (n: string): [string, string, string, string, string][] => [
      [`${n}P`, n, 'Projection Matrix', 'FLOAT4X4', 'POINT'],
      [`${n}F`, n, 'Focal Length', 'FLOAT', 'POINT'],
      [`${n}S`, n, 'Sensor', 'FLOAT_VECTOR', 'POINT'],
      [`${n}H`, n, 'Shift', 'FLOAT_VECTOR', 'POINT'],
      [`${n}O`, n, 'Is Orthographic', 'BOOLEAN', 'POINT'],
    ];
    const r = runSpec(
      {
        nodes: {
          g: { type: 'GeometryNodeMeshLine', inputs: { Count: 1 } },
          a: { type: 'GeometryNodeCameraInfo', inputs: { Camera: cam.id } },
          ac: { type: 'GeometryNodeInputActiveCamera' },
          b: { type: 'GeometryNodeCameraInfo' },
        },
        links: [['ac', 'Active Camera', 'b', 'Camera']],
        geometry: ['g', 'Mesh'],
        outputs: [...outs('a'), ...outs('b')],
      },
      { doc },
    );
    near(single(r, 'aP'), [2.1875, 0, 0, 0, 0, 3.88889, 0, 0, 0.2, -0.71111, -1.00803, -1, 0, 0, -0.40161, 0]);
    near(single(r, 'aF'), 35);
    near(single(r, 'aS'), [32, 18, 0]);
    near(single(r, 'aH'), [0.1, -0.35556, 0]);
    expect(single(r, 'aO')).toBe(false);
    near(single(r, 'bP'), [0.225, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, -0.002, 0, 0, 0, -1.0002, 1]);
    near(single(r, 'bS'), [42.66667, 24, 0]);
    expect(single(r, 'bO')).toBe(true);
  });

  it('Bone Info reports rest and pose matrices of a bone', () => {
    const doc = emptyDocument();
    const arm = newArmature('Arm');
    const bone = (name: string, parent: string | null, head: number[], tail: number[], roll: number, connect: boolean): Bone =>
      ({
        name,
        parent,
        head,
        tail,
        roll,
        use_connect: connect,
        use_deform: true,
        use_inherit_rotation: true,
        inherit_scale: 'FULL',
        envelope_distance: 0.25,
        head_radius: 0.1,
        tail_radius: 0.05,
        bbone_segments: 1,
      }) as Bone;
    arm.bones = [bone('Root', null, [0, 0, 0], [0, 0, 2], 0, false), bone('Child', 'Root', [0, 0, 2], [0, 1, 3], 0.3, true)];
    doc.armatures[arm.id] = arm;
    const ao = newObject('Arm', 'ARMATURE', arm.id);
    ao.pose = {
      Root: { ...defaultPoseBone(), rotation_mode: 'XYZ', rotation_euler: [0.2, 0, 0], location: [0.1, 0, 0] },
      Child: { ...defaultPoseBone(), rotation_mode: 'XYZ', rotation_euler: [0, 0, 0.4], scale: [1, 2, 1] },
    };
    doc.objects[ao.id] = ao;
    const armWorld = Array.from(composeMat([1, 0, 0], [0, 0, 0.5], [1, 1, 1]));
    const selfWorld = Array.from(composeMat([0, 0, 1], [0.3, 0, 0], [1, 1, 1]));
    const outs = (n: string): [string, string, string, string, string][] => [
      [`${n}P`, n, 'Pose', 'FLOAT4X4', 'POINT'],
      [`${n}L`, n, 'Local Pose', 'FLOAT4X4', 'POINT'],
      [`${n}R`, n, 'Rest Pose', 'FLOAT4X4', 'POINT'],
      [`${n}N`, n, 'Rest Length', 'FLOAT', 'POINT'],
      [`${n}E`, n, 'Exists', 'BOOLEAN', 'POINT'],
    ];
    const r = runSpec(
      {
        nodes: {
          g: { type: 'GeometryNodeMeshLine', inputs: { Count: 1 } },
          c: { type: 'GeometryNodeBoneInfo', inputs: { Armature: ao.id, 'Bone Name': 'Child' } },
          rel: { type: 'GeometryNodeBoneInfo', props: { transform_space: 'RELATIVE' }, inputs: { Armature: ao.id, 'Bone Name': 'Child' } },
          r0: { type: 'GeometryNodeBoneInfo', inputs: { Armature: ao.id, 'Bone Name': 'Root' } },
          x: { type: 'GeometryNodeBoneInfo', inputs: { Armature: ao.id, 'Bone Name': 'Nope' } },
        },
        geometry: ['g', 'Mesh'],
        outputs: [...outs('c'), ...outs('rel'), ...outs('r0'), ...outs('x')],
      },
      { doc, env: { selfWorld, objectWorld: (id) => (id === ao.id ? armWorld : null) } },
    );
    near(single(r, 'cR'), [0.95534, 0.20896, -0.20896, 0, 0, 0.70711, 0.70711, 0, 0.29552, -0.67552, 0.67552, 0, 0, 0, 2, 1]);
    near(single(r, 'cP'), [0.87992, 0.44204, 0.17418, 0, -0.74405, 0.82599, 1.66257, 0, 0.29552, -0.79627, 0.52785, 0, 0.1, -0.39734, 1.96013, 1]);
    near(single(r, 'cL'), [0.92106, 0.38942, 0, 0, -0.77884, 1.84212, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    near(single(r, 'cN'), 1.41421);
    near(single(r, 'relP'), [0.56028, 0.82509, -0.0729, 0, -1.04897, 0.84304, 1.47951, 0, 0.64109, -0.37623, 0.66891, 0, 1.27825, -0.00358, 1.00613, 1]);
    near(single(r, 'relR'), [0.7382, 0.551, -0.38918, 0, -0.33901, 0.80179, 0.49214, 0, 0.58321, -0.23137, 0.77868, 0, 1, 0.29552, 0.95534, 1]);
    near(single(r, 'r0P'), [1, 0, 0, 0, 0, -0.19867, 0.98007, 0, 0, -0.98007, -0.19867, 0, 0.1, 0, 0, 1]);
    near(single(r, 'r0N'), 2);
    expect(single(r, 'xE')).toBe(false);
    near(single(r, 'xP'), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
});

describe('Mix node rotation mode', () => {
  it('is offered in geometry trees only', () => {
    const p = getNodeType('ShaderNodeMix')!.props.find((x) => x.id === 'data_type')!;
    const ids = (t: 'GEOMETRY' | 'SHADER') => (p.itemsFor?.({ type: t, nodes: [], links: [] }) ?? p.items ?? []).map(([v]) => v);
    expect(ids('GEOMETRY')).toContain('ROTATION');
    expect(ids('SHADER')).not.toContain('ROTATION');
  });
});

describe('menus in nested groups', () => {
  it('a group node shows the menu items of the switch inside, and its value picks the branch', () => {
    const { doc, g, tree } = group();
    const gi = addNode(tree, 'NodeGroupInput', [0, 0]);
    const out = addNode(tree, 'NodeGroupOutput', [400, 0]);
    const ms = addNode(tree, 'GeometryNodeMenuSwitch', [200, 0], {
      enum_items: JSON.stringify([
        { id: 0, name: 'Cube' },
        { id: 1, name: 'Line' },
      ]),
    } as Record<string, never>);
    const ctx = ctxOf(doc, tree);
    connect(ctx, gi.id, 'Socket_0', ms.id, 'Menu');
    connect(ctx, addNode(tree, 'GeometryNodeMeshCube', [0, 0]).id, 'Mesh', ms.id, 'Item_0');
    connect(ctx, addNode(tree, 'GeometryNodeMeshLine', [0, 0]).id, 'Mesh', ms.id, 'Item_1');
    connect(ctx, ms.id, 'Output', out.id, 'Socket_1');
    // outer tree using the group as a node
    const outerTree: NodeTreeData = { type: 'GEOMETRY', nodes: [], links: [], interface: [{ in_out: 'OUTPUT', name: 'Geometry', socket_type: 'NodeSocketGeometry', identifier: 'Socket_0' }] };
    const outer: NodeGroupData = { id: uid('ng'), name: 'Outer', tree: outerTree, is_modifier: true };
    doc.node_groups[outer.id] = outer;
    const gn = addNode(outerTree, 'GeometryNodeGroup', [0, 0], { node_tree: g.id } as Record<string, never>);
    const oo = addNode(outerTree, 'NodeGroupOutput', [300, 0]);
    connect(ctxOf(doc, outerTree), gn.id, 'Socket_1', oo.id, 'Socket_0');
    const menu = getNodeType('GeometryNodeGroup')!.dynamicSockets!(gn, ctxOf(doc, outerTree)).inputs.find((s) => s.identifier === 'Socket_0')!;
    expect(menu.items).toEqual(['Cube', 'Line']);
    const run = () =>
      evaluateGroup(outer, { id: 'md', name: 'GN', type: 'NODES', node_group: outer.id } as unknown as ModifierBase, testEnv(doc), GeometrySet.empty(), 'in', `menu2/${uid('k')}`, false).geometry.mesh!
        .vertCount;
    expect(run()).toBe(8);
    gn.inputs.Socket_0 = 'Line';
    expect(run()).toBe(10);
  });
});

describe('matrix attributes', () => {
  it('Capture Attribute and Store/Named Attribute keep 4×4 matrices', () => {
    const r = runSpec({
      nodes: {
        g: { type: 'GeometryNodeMeshLine', inputs: { Count: 3 } },
        idx: { type: 'GeometryNodeInputIndex' },
        ct: { type: 'FunctionNodeCombineTransform' },
        cap: { type: 'GeometryNodeCaptureAttribute', props: { capture_items: JSON.stringify([{ id: 0, name: 'M', data_type: 'FLOAT4X4' }]) } },
        st: { type: 'GeometryNodeStoreNamedAttribute', props: { data_type: 'FLOAT4X4', domain: 'POINT' }, inputs: { Name: 'm' } },
        rd: { type: 'GeometryNodeInputNamedAttribute', props: { data_type: 'FLOAT4X4' }, inputs: { Name: 'm' } },
        sep: { type: 'FunctionNodeSeparateTransform' },
      },
      links: [
        ['idx', 'Index', 'ct', 'Translation'],
        ['g', 'Mesh', 'cap', 'Geometry'],
        ['ct', 'Transform', 'cap', 'Value'],
        ['cap', 'Geometry', 'st', 'Geometry'],
        ['cap', 'Attribute', 'st', 'Value'],
        ['rd', 'Attribute', 'sep', 'Transform'],
      ],
      geometry: ['st', 'Geometry'],
      outputs: [['t', 'sep', 'Translation', 'FLOAT_VECTOR', 'POINT']],
    });
    expect(r.errors).toEqual([]);
    expect(r.values.t).toEqual([
      [0, 0, 0],
      [1, 1, 1],
      [2, 2, 2],
    ]);
  });
});

describe('data-block inputs', () => {
  it('pass the chosen object, collection, material, image and font on', () => {
    const doc = emptyDocument();
    doc.fonts = { f1: { id: 'f1', name: 'Sans', filepath: '', bytes: null } };
    const tree: NodeTreeData = { type: 'GEOMETRY', nodes: [], links: [], interface: [] };
    const te = new TreeEval(
      testEnv(doc),
      tree,
      'x',
      () => undefined,
      () => '',
      new Map(),
      { warnings: new Map(), executed: 0, generation: 1 },
    );
    const font = addNode(tree, 'GeometryNodeInputFont', [0, 0], { font: 'f1' } as Record<string, never>);
    const missing = addNode(tree, 'GeometryNodeInputFont', [0, 0], { font: 'nope' } as Record<string, never>);
    const mat = addNode(tree, 'GeometryNodeInputMaterial', [0, 0], { material: 'm1' } as Record<string, never>);
    expect(te.nodeOutputs(font).Font).toBe('f1');
    expect(te.nodeOutputs(missing).Font).toBe(null);
    expect(te.nodeOutputs(mat).Material).toBe('m1');
  });
});

describe('primitive edge order', () => {
  const cases = JSON.parse(readFileSync(join(__dirname, '../fixtures/geonodes_edges/primitive_edges.json'), 'utf8')) as {
    name: string;
    type: string;
    inputs: Record<string, never>;
    props: Record<string, never>;
    edges: number[][];
  }[];
  for (const c of cases)
    it(c.name, () => {
      const m = runSpec({ nodes: { g: { type: c.type, inputs: c.inputs, props: c.props } }, geometry: ['g', 'Mesh'] }).geometry.mesh!;
      const t = m.topology();
      expect(Array.from({ length: t.edgeCount }, (_, e) => [t.edges[e * 2], t.edges[e * 2 + 1]])).toEqual(c.edges);
    });
  it('an edge order made for other faces is ignored', () => {
    const m = runSpec({ nodes: { g: { type: 'GeometryNodeMeshGrid', inputs: { 'Vertices X': 3, 'Vertices Y': 3 } as never } }, geometry: ['g', 'Mesh'] }).geometry.mesh!;
    const copy = m.copy();
    copy.corners = Uint32Array.from(m.corners).reverse();
    const t = copy.topology();
    expect(t.edgeCount).toBe(12);
    // closing edge of the first face first
    const f0 = Array.from(copy.corners.subarray(copy.faceOffsets[0], copy.faceOffsets[1]));
    expect([t.edges[0], t.edges[1]]).toEqual([Math.min(f0[3], f0[0]), Math.max(f0[3], f0[0])]);
  });
});

describe('message severity', () => {
  it('the Warning node reports with its type, also when its result comes from the cache', () => {
    const doc = emptyDocument();
    const tree: NodeTreeData = { type: 'GEOMETRY', nodes: [], links: [], interface: [{ in_out: 'OUTPUT', name: 'Geometry', socket_type: 'NodeSocketGeometry', identifier: 'Socket_0' }] };
    const g: NodeGroupData = { id: uid('ng'), name: 'W', tree, is_modifier: true };
    doc.node_groups[g.id] = g;
    const w = addNode(tree, 'GeometryNodeWarning', [0, 0], { warning_type: 'INFO' } as Record<string, never>);
    w.inputs.Message = 'Just so you know';
    const sw = addNode(tree, 'GeometryNodeSwitch', [0, 0], { input_type: 'GEOMETRY' } as Record<string, never>);
    const out = addNode(tree, 'NodeGroupOutput', [0, 0]);
    const ctx = ctxOf(doc, tree);
    connect(ctx, w.id, 'Show', sw.id, 'Switch');
    connect(ctx, sw.id, 'Output', out.id, 'Socket_0');
    const m = { id: 'md', name: 'GN', type: 'NODES', node_group: g.id } as unknown as ModifierBase;
    const kinds = () => [...evaluateGroup(g, m, testEnv(doc), GeometrySet.empty(), 'in', 'severity', false).log.kinds!.values()];
    expect(kinds()).toEqual(['INFO']);
    expect(kinds()).toEqual(['INFO']);
  });
});
