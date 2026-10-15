// @vitest-environment happy-dom
// Curve geometry nodes: primitives, spline types and evaluation, curve operations.
// Expected values are recorded below.
import { describe, it, expect } from 'vitest';
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/geonodes/core';
import { emptyDocument, uid } from '../../src/data/defaults';
import type { DocumentData, ModifierBase, NodeData, NodeGroupData, NodeTreeData, SocketValue } from '../../src/data/types';
import { addNode, connect, ctxOf } from '../../src/nodes/tree';
import { evaluateGroup } from '../../src/geonodes/modifier';
import type { EvalEnv } from '../../src/geonodes/exec';
import { GeometrySet, identity, type CurvesComponent } from '../../src/geonodes/geometry';
import { evaluateCurves, setCurveAttr } from '../../src/geonodes/curves/curvedata';
import { CurvesComponent as CC } from '../../src/geonodes/geometry';
import { nodeMenu, getNodeType } from '../../src/nodes/registry';
import CASES from './gn_curves.cases.json';

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

function run(t: T, from: NodeData, socket = 'Geometry', input = GeometrySet.empty()) {
  link(t, from, socket, t.out, 'Geometry');
  const m = {
    id: 'md',
    name: 'GN',
    type: 'NODES',
    node_group: t.group.id,
  } as unknown as ModifierBase;
  return evaluateGroup(t.group, m, env(t.doc), input, 'in', `test/${Math.random()}`, false).geometry;
}

/** Chain nodes: each node's first geometry input gets the previous node's output. */
function chain(t: T, ...steps: [NodeData, string, string?][]): GeometrySet {
  for (let i = 1; i < steps.length; i++) link(t, steps[i - 1][0], steps[i - 1][1], steps[i][0], steps[i][2] ?? 'Curve');
  const last = steps[steps.length - 1];
  return run(t, last[0], last[1]);
}

const pts = (c: CurvesComponent | undefined) => {
  const out: number[][] = [];
  if (!c) return out;
  for (let i = 0; i < c.pointCount; i++) out.push(Array.from(c.positions.subarray(i * 3, i * 3 + 3)));
  return out;
};
const vecs = (data: ArrayLike<number>) => {
  const out: number[][] = [];
  for (let i = 0; i < data.length; i += 3) out.push([data[i], data[i + 1], data[i + 2]]);
  return out;
};
function close(a: number[][], b: number[][], eps = 2e-4) {
  expect(a.length).toBe(b.length);
  a.forEach((p, i) => p.forEach((x, k) => expect(Math.abs(x - b[i][k]), `point ${i}[${k}]: ${x} vs ${b[i][k]}`).toBeLessThan(eps)));
}
const attr = (c: CurvesComponent | undefined, name: string) => Array.from(c!.attrs.get(name)!.data);

function curve(points: number[][], cyclic: boolean, type: number, res: number, ints: Record<string, number> = {}): CC {
  const c = new CC(new Float32Array(points.flat()), new Uint32Array([0, points.length]), new Uint8Array([cyclic ? 1 : 0]));
  setCurveAttr(c.attrs, 'curve_type', 'INT8', new Int32Array([type]));
  setCurveAttr(c.attrs, 'resolution', 'INT', new Int32Array([res]));
  for (const [k, v] of Object.entries(ints)) setCurveAttr(c.attrs, k, 'INT8', new Int32Array([v]));
  return c;
}

// ---------------------------------------------------------------------------

describe('spline evaluation', () => {
  const q = [
    [-1, 0, 0],
    [-0.3875, 0.75, 0.1875],
    [0.15, 1.0, 0.25],
    [0.6125, 0.75, 0.1875],
    [1, 0, 0],
  ];
  const kite = [
    [0, -3, 0],
    [1, 0, 0],
    [0, 1, 0],
    [-1, 0, 0],
  ];
  it('evaluates NURBS curves (endpoint knots, cyclic)', () => {
    close(pts(evaluateCurves(curve(q, false, 3, 2, { knots_mode: 1, nurbs_order: 4 })).curves), [
      [-1, 0, 0],
      [-0.29844, 0.71875, 0.17969],
      [0.13125, 0.875, 0.21875],
      [0.51406, 0.71875, 0.17969],
      [1, 0, 0],
    ]);
    close(pts(evaluateCurves(curve(kite, true, 3, 2, { knots_mode: 1 })).curves), [
      [0.66667, -0.33333, 0],
      [0.45833, 0.41667, 0],
      [0, 0.66667, 0],
      [-0.45833, 0.41667, 0],
      [-0.66667, -0.33333, 0],
      [-0.45833, -1.41667, 0],
      [0, -2, 0],
      [0.45833, -1.41667, 0],
    ]);
  });
  it('evaluates Catmull-Rom curves', () => {
    close(pts(evaluateCurves(curve(q, false, 0, 2)).curves), [
      [-1, 0, 0],
      [-0.72734, 0.35938, 0.08984],
      [-0.3875, 0.75, 0.1875],
      [-0.10938, 0.9375, 0.23438],
      [0.15, 1, 0.25],
      [0.39062, 0.9375, 0.23438],
      [0.6125, 0.75, 0.1875],
      [0.83516, 0.35938, 0.08984],
      [1, 0, 0],
    ]);
    close(pts(evaluateCurves(curve(kite, true, 0, 2)).curves), [
      [0, -3, 0],
      [0.625, -1.75, 0],
      [1, 0, 0],
      [0.625, 0.75, 0],
      [0, 1, 0],
      [-0.625, 0.75, 0],
      [-1, 0, 0],
      [-0.625, -1.75, 0],
    ]);
  });
});

describe('curve primitives', () => {
  it('Arc by radius, inverted with a connected center', () => {
    let t = setup();
    close(pts(run(t, node(t, 'GeometryNodeCurveArc', { Resolution: 4 }), 'Curve').curves), [
      [1, 0, 0],
      [-0.25882, 0.96593, 0],
      [-0.86603, -0.5, 0],
      [0.70711, -0.70711, 0],
    ]);
    t = setup();
    const c = run(
      t,
      node(t, 'GeometryNodeCurveArc', {
        Resolution: 4,
        'Connect Center': true,
        'Invert Arc': true,
        'Start Angle': 0.3,
      }),
      'Curve',
    ).curves!;
    close(pts(c), [
      [0.95534, 0.29552, 0],
      [0.99927, 0.03819, 0],
      [0.97511, -0.22174, 0],
      [0.88449, -0.46656, 0],
      [0, 0, 0],
    ]);
    expect(c.cyclic[0]).toBe(1);
    t = setup();
    expect(run(t, node(t, 'GeometryNodeCurveArc', { Resolution: 0 }), 'Curve').curves!.pointCount).toBe(2);
  });
  it('Arc through three points with offset angle', () => {
    let t = setup();
    const arc = {
      Resolution: 4,
      Start: [-1, 0, 0],
      Middle: [0, 2, 0.5],
      End: [1, 0, 0],
    };
    close(pts(run(t, node(t, 'GeometryNodeCurveArc', { ...arc, 'Offset Angle': 0.2 }, { mode: 'POINTS' }), 'Curve').curves), [
      [-1.13667, 0.20798, 0.052],
      [-0.66131, 1.82033, 0.45508],
      [1.03284, 1.48716, 0.37179],
      [0.82347, -0.17749, -0.04437],
    ]);
    t = setup();
    close(pts(run(t, node(t, 'GeometryNodeCurveArc', { ...arc, 'Invert Arc': true, 'Connect Center': true }, { mode: 'POINTS' }), 'Curve').curves), [
      [-1, 0, 0],
      [-0.37761, -0.41502, -0.10375],
      [0.37761, -0.41502, -0.10375],
      [1, 0, 0],
      [0, 0.76471, 0.19118],
    ]);
    t = setup();
    close(pts(run(t, node(t, 'GeometryNodeCurveArc', { ...arc, 'Invert Arc': true, 'Offset Angle': 0.2 }, { mode: 'POINTS' }), 'Curve').curves), [
      [-1.13667, 0.20798, 0.052],
      [-0.61167, -0.31872, -0.07968],
      [0.1285, -0.46428, -0.11607],
      [0.82347, -0.17749, -0.04437],
    ]);
  });
  it('Star alternates radii (at least three points)', () => {
    let t = setup();
    close(pts(run(t, node(t, 'GeometryNodeCurveStar', { Points: 3, Twist: 0.2 }), 'Curve').curves), [
      [2, 0, 0],
      [0.31798, 0.9481, 0],
      [-1, 1.73205, 0],
      [-0.98007, -0.19867, 0],
      [-1, -1.73205, 0],
      [0.66209, -0.74943, 0],
    ]);
    t = setup();
    expect(run(t, node(t, 'GeometryNodeCurveStar', { Points: 2 }), 'Curve').curves!.pointCount).toBe(6);
  });
  it('Bézier Segment in offset mode and Quadratic Bézier', () => {
    let t = setup();
    const c = run(t, node(t, 'GeometryNodeCurvePrimitiveBezierSegment', { Resolution: 5 }, { mode: 'OFFSET' }), 'Curve').curves!;
    close(vecs(attr(c, 'handle_right')), [
      [-1.5, 0.5, 0],
      [1, 0, 0],
    ]);
    close(vecs(attr(c, 'handle_left')), [
      [-0.5, -0.5, 0],
      [1, 0, 0],
    ]);
    expect(attr(c, 'handle_type_left')).toEqual([3, 3]);
    expect(attr(c, 'curve_type')).toEqual([2]);
    expect(attr(c, 'resolution')).toEqual([5]);
    t = setup();
    close(pts(run(t, node(t, 'GeometryNodeCurveQuadraticBezier', { Resolution: 4 }), 'Curve').curves), [
      [-1, 0, 0],
      [-0.5, 0.75, 0],
      [0, 1, 0],
      [0.5, 0.75, 0],
      [1, 0, 0],
    ]);
  });
  it('places the primitives in the Curve ▸ Primitives menu in order', () => {
    const curveMenu = nodeMenu('GEOMETRY').find((c) => c.label === 'Curve')!;
    const prim = curveMenu.items.find((i) => i !== 'SEPARATOR' && 'items' in i && i.label === 'Primitives') as { items: { idname: string }[] };
    expect(prim.items.map((i) => i.idname)).toEqual([
      'GeometryNodeCurveArc',
      'GeometryNodeCurvePrimitiveBezierSegment',
      'GeometryNodeCurvePrimitiveCircle',
      'GeometryNodeCurvePrimitiveLine',
      'GeometryNodeCurveSpiral',
      'GeometryNodeCurveQuadraticBezier',
      'GeometryNodeCurvePrimitiveQuadrilateral',
      'GeometryNodeCurveStar',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Recorded cases: node chains with the expected curves, points or mesh.

interface CaseSpec {
  nodes: Record<
    string,
    {
      type: string;
      inputs?: Record<string, SocketValue>;
      props?: Record<string, SocketValue | string[]>;
    }
  >;
  links?: [string, string, string, string][];
  out: [string, string];
  attrs?: string[];
}
interface Case {
  name: string;
  spec: CaseSpec;
  expect: {
    curves?: {
      positions: number[][];
      offsets: number[];
      attrs: Record<string, [string, unknown[]]>;
    };
    points?: {
      positions: number[][];
      attrs: Record<string, [string, unknown[]]>;
    };
    mesh?: { verts: number[][]; faces: number[][]; attrs?: Record<string, [string, unknown[]]> };
  };
}

const BUILTIN: Record<string, number> = {
  curve_type: 1,
  resolution: 12,
  nurbs_weight: 1,
  tilt: 0,
  radius: 1,
  nurbs_order: 4,
};

/** Build the node chain of a case in a fresh tree and evaluate it. */
export function runCase(spec: CaseSpec): GeometrySet {
  const t = setup();
  const made: Record<string, NodeData> = {};
  for (const [k, d] of Object.entries(spec.nodes)) {
    const def = getNodeType(d.type);
    if (!def) throw new Error(`no node type ${d.type}`);
    const props: Record<string, SocketValue> = {};
    for (const [pk, pv] of Object.entries(d.props ?? {})) props[pk] = Array.isArray(pv) && typeof pv[0] === 'string' ? (pv as string[]).join(',') : (pv as SocketValue);
    const inputs: Record<string, SocketValue> = {};
    for (const [ik, iv] of Object.entries(d.inputs ?? {})) {
      if (def.props.some((p) => p.id === ik)) props[ik] = iv;
      else inputs[ik] = iv;
    }
    made[k] = node(t, d.type, inputs, props);
  }
  // links into a multi-input socket: the most recently connected one comes first in the recorded data
  const links = spec.links ?? [];
  const multi = links.filter(([, , b, bs]) => spec.nodes[b].type === 'GeometryNodeJoinGeometry' && bs === 'Geometry').reverse();
  for (const [a, as, b, bs] of [...links.filter((l) => !multi.includes(l)), ...multi]) link(t, made[a], as, made[b], bs);
  return run(t, made[spec.out[0]], spec.out[1]);
}

function compareAttrs(
  c: {
    attrs: Map<string, { domain: string; data: ArrayLike<number> }>;
    cyclic?: Uint8Array;
  },
  exp: Record<string, [string, unknown[]]>,
  n: (d: string) => number,
  label: string,
) {
  const types = c.attrs.get('curve_type')?.data;
  const has = (t: number) => !!types && Array.from(types).includes(t);
  for (const [name, [domain, values]] of Object.entries(exp)) {
    // settings of spline types that no curve uses any more are irrelevant
    if (name.startsWith('handle_') && !has(2)) continue;
    if ((name === 'knots_mode' || name === 'nurbs_order' || name === 'nurbs_weight') && !has(3)) continue;
    const a = c.attrs.get(name);
    let flat: number[];
    if (a) flat = Array.from(a.data);
    else if (name === 'cyclic' && c.cyclic) flat = Array.from(c.cyclic);
    else if (name in BUILTIN) flat = new Array(n(domain)).fill(BUILTIN[name]);
    else throw new Error(`${label}: missing attribute ${name}`);
    const want = (values as unknown[]).flatMap((v) => (Array.isArray(v) ? v : [typeof v === 'boolean' ? (v ? 1 : 0) : v])) as number[];
    expect(flat.length, `${label}: ${name} size`).toBe(want.length);
    want.forEach((w, i) => expect(Math.abs(flat[i] - w), `${label}: ${name}[${i}] ${flat[i]} vs ${w}`).toBeLessThan(2e-4));
  }
}

describe('recorded node results', () => {
  for (const cs of CASES as unknown as Case[]) {
    it(cs.name, () => {
      const g = runCase(cs.spec);
      if (cs.expect.curves) {
        const c = g.curves;
        expect(c, 'curves').toBeTruthy();
        close(pts(c), cs.expect.curves.positions);
        expect(Array.from(c!.curveOffsets)).toEqual(cs.expect.curves.offsets);
        compareAttrs(c!, cs.expect.curves.attrs, (d) => (d === 'CURVE' ? c!.curveCount : c!.pointCount), cs.name);
      }
      if (cs.expect.points) {
        const p = g.points;
        expect(p, 'points').toBeTruthy();
        close(vecs(p!.positions), cs.expect.points.positions);
        compareAttrs(p!, cs.expect.points.attrs, () => p!.count, cs.name);
      }
      if (cs.expect.mesh) {
        const m = g.mesh!;
        close(vecs(m.positions), cs.expect.mesh.verts);
        const faces: number[][] = [];
        for (let f = 0; f < m.faceCount; f++) faces.push(Array.from(m.corners.subarray(m.faceOffsets[f], m.faceOffsets[f + 1])));
        expect(faces).toEqual(cs.expect.mesh.faces);
        compareAttrs(m, cs.expect.mesh.attrs ?? {}, (d) => m.domainSize(d as never), cs.name);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Text

import { textLayout } from '../../src/geonodes/curves/text';
import { layoutTextWith, type GlyphSource } from '../../src/io/textlayout';
import type { Spline } from '../../src/data/types';

const squareGlyph = (): Spline[] => [
  {
    type: 'BEZIER',
    bezier_points: [
      [0, 0],
      [0.4, 0],
      [0.4, 0.6],
      [0, 0.6],
    ].map(([x, y]) => ({ co: [x, y, 0], handle_left: [x, y, 0], handle_right: [x, y, 0], handle_left_type: 'VECTOR', handle_right_type: 'VECTOR', radius: 1, tilt: 0 })),
    points: [],
    use_cyclic_u: true,
    resolution_u: 0,
    order_u: 4,
    use_smooth: false,
    material_index: 0,
  },
];
const fakeFont: GlyphSource = { advance: () => 0.5, outline: () => squareGlyph(), hasStyle: () => true };

describe('text nodes', () => {
  it('String to Curves makes one instance per character with line and word indices', () => {
    textLayout.fn = (cu) => layoutTextWith(cu, fakeFont);
    const t = setup();
    const s = node(t, 'GeometryNodeStringToCurves', { String: 'Hi you  there\nab c', Size: 2 });
    const a = node(t, 'GeometryNodeStoreNamedAttribute', { Name: 'line' }, { data_type: 'INT', domain: 'INSTANCE' });
    const b = node(t, 'GeometryNodeStoreNamedAttribute', { Name: 'word' }, { data_type: 'INT', domain: 'INSTANCE' });
    link(t, s, 'Curve Instances', a, 'Geometry');
    link(t, s, 'Line', a, 'Value');
    link(t, a, 'Geometry', b, 'Geometry');
    link(t, s, 'Word', b, 'Value');
    const inst = run(t, b).instances!;
    expect(inst.count).toBe(18);
    expect(Array.from(inst.attrs.get('line')!.data)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    expect(Array.from(inst.attrs.get('word')!.data)).toEqual([0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4]);
    // advance 0.5 em at size 2: the second character starts one unit to the right
    expect(inst.transforms[16 + 12]).toBeCloseTo(1);
    const ref = inst.references[inst.refIndex[0]];
    expect(ref.geometry.curves!.pointCount).toBe(4);
    expect(Math.max(...ref.geometry.curves!.positions)).toBeCloseTo(1.2);
  });
  it('Join Strings joins linked strings with the delimiter', () => {
    textLayout.fn = (cu) => layoutTextWith(cu, fakeFont);
    const t = setup();
    const a = node(t, 'FunctionNodeInputString', {}, { string: 'ab' });
    const b = node(t, 'FunctionNodeInputString', {}, { string: 'cde' });
    const j = node(t, 'GeometryNodeStringJoin', { Delimiter: '--' });
    link(t, a, 'String', j, 'Strings');
    link(t, b, 'String', j, 'Strings');
    const s = node(t, 'GeometryNodeStringToCurves');
    link(t, j, 'String', s, 'String');
    expect(run(t, s, 'Curve Instances').instances!.count).toBe('ab--cde'.length);
  });
  it('truncates overflowing text into the remainder', () => {
    textLayout.fn = (cu) => layoutTextWith(cu, fakeFont);
    const make = () => {
      const t = setup();
      const s = node(t, 'GeometryNodeStringToCurves', { String: 'aa bb cc dd', 'Text Box Width': 2.6, 'Text Box Height': 1 }, { Overflow: 'Truncate' });
      return { t, s };
    };
    const a = make();
    expect(run(a.t, a.s, 'Curve Instances').instances!.count).toBe(6);
    const b = make();
    const j = node(b.t, 'GeometryNodeStringJoin');
    link(b.t, b.s, 'Remainder', j, 'Strings');
    const s2 = node(b.t, 'GeometryNodeStringToCurves');
    link(b.t, j, 'String', s2, 'String');
    expect(run(b.t, s2, 'Curve Instances').instances!.count).toBe('cc dd'.length);
  });
});

// ---------------------------------------------------------------------------
// Import nodes

import { packFile } from '../../src/geonodes/curves/importers';

const enc = (s: string) => new TextEncoder().encode(s);

describe('import nodes', () => {
  it('Import OBJ gives one instance per object with the file coordinates', () => {
    const t = setup();
    packFile(t.doc, 'two.obj', enc('o First\nv 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\no Second\nv 0 0 1\nv 0 1 2\nv 1 0 3\nv 1 1 4\nf 4 5 7 6\n'));
    const imp = node(t, 'GeometryNodeImportOBJ', { Path: 'two.obj' });
    const r = node(t, 'GeometryNodeRealizeInstances');
    link(t, imp, 'Instances', r, 'Geometry');
    const m = run(t, r).mesh!;
    const sorted = (v: number[][]) => v.map((p) => p.join(',')).sort();
    expect(sorted(vecs(m.positions))).toEqual(
      sorted([
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 0, 1],
        [0, 1, 2],
        [1, 0, 3],
        [1, 1, 4],
      ]),
    );
    expect(Array.from(m.faceOffsets)).toEqual([0, 3, 7]);
    const t2 = setup();
    packFile(t2.doc, 'two.obj', enc('o A\nv 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\no B\nv 0 0 1\nv 0 1 2\nv 1 0 3\nf 4 5 6\n'));
    expect(run(t2, node(t2, 'GeometryNodeImportOBJ', { Path: 'C:\\models\\two.obj' }), 'Instances').instances!.count).toBe(2);
  });
  it('Import CSV makes points with a numeric attribute per column', () => {
    const t = setup();
    packFile(t.doc, 'pts.csv', enc('x,y,z,temp,id\n1,2,3,0.5,7\n4,5,6,1.5,8\n-1,0,2,2.5,9\n'));
    const p = run(t, node(t, 'GeometryNodeImportCSV', { Path: 'pts.csv', Delimiter: ',' }), 'Point Cloud').points!;
    expect(p.count).toBe(3);
    expect(Array.from(p.attrs.get('x')!.data)).toEqual([1, 4, -1]);
    expect(p.attrs.get('id')!.type).toBe('INT');
    expect(Array.from(p.attrs.get('temp')!.data)).toEqual([0.5, 1.5, 2.5]);
  });
  it('Import STL and PLY read meshes; Import Text reads a string; missing files warn', () => {
    const t = setup();
    packFile(t.doc, 'tri.stl', enc('solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n'));
    const m = run(t, node(t, 'GeometryNodeImportSTL', { Path: 'tri.stl' }), 'Mesh').mesh!;
    expect([m.vertCount, m.faceCount]).toEqual([3, 1]);
    const t2 = setup();
    packFile(
      t2.doc,
      'q.ply',
      enc(
        'ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n1 1 0\n0 1 0\n4 0 1 2 3\n',
      ),
    );
    const q = run(t2, node(t2, 'GeometryNodeImportPLY', { Path: 'q.ply' }), 'Mesh').mesh!;
    expect([q.vertCount, q.faceCount]).toEqual([4, 1]);
    const t3 = setup();
    packFile(t3.doc, 'hello.txt', enc('hi there'));
    const s = node(t3, 'GeometryNodeStringToCurves');
    link(t3, node(t3, 'GeometryNodeImportText', { Path: 'hello.txt' }), 'String', s, 'String');
    expect(run(t3, s, 'Curve Instances').instances!.count).toBe(8);
    const t4 = setup();
    const missing = node(t4, 'GeometryNodeImportSTL', { Path: 'nope.stl' });
    link(t4, missing, 'Mesh', t4.out, 'Geometry');
    const m4 = { id: 'md', name: 'GN', type: 'NODES', node_group: t4.group.id } as unknown as ModifierBase;
    const res = evaluateGroup(t4.group, m4, env(t4.doc), GeometrySet.empty(), 'in', 'test/missing', false);
    expect([...res.log.warnings.values()].flat().join()).toContain('File not found');
  });
});

// ---------------------------------------------------------------------------
// Gizmo nodes

import { gizmoStates, valueTargets } from '../../src/geonodes/curves/gizmos';

describe('gizmo nodes', () => {
  it('record their handles when the modifier evaluates, even when unconnected', () => {
    const t = setup();
    const g = node(t, 'GeometryNodeGizmoLinear', { Position: [1, 2, 3], Direction: [0, 1, 0] }, { color_id: 'X', draw_style: 'BOX' });
    link(t, node(t, 'GeometryNodeMeshCube'), 'Mesh', t.out, 'Geometry');
    const m = { id: 'md', name: 'GN', type: 'NODES', node_group: t.group.id } as unknown as ModifierBase;
    const e = { ...env(t.doc), ob: { id: 'ob1' } as never };
    evaluateGroup(t.group, m, e, GeometrySet.empty(), 'in', 'ob1/md', false);
    const st = gizmoStates.get(`ob1/md/${g.id}`)!;
    expect(st.kind).toBe('LINEAR');
    expect(st.position).toEqual([1, 2, 3]);
    expect(st.axis).toEqual([0, 1, 0]);
    expect([st.color, st.drawStyle]).toEqual(['X', 'BOX']);
  });
  it('find the values a drag edits through math nodes and modifier inputs', () => {
    const t = setup();
    const val = node(t, 'ShaderNodeValue', {}, { 'outputs.Value': 0.5 });
    const mul = node(t, 'ShaderNodeMath', { Value_001: 2 }, { operation: 'MULTIPLY' });
    const sub = node(t, 'ShaderNodeMath', { Value: 10 }, { operation: 'SUBTRACT' });
    const dial = node(t, 'GeometryNodeGizmoDial');
    link(t, val, 'Value', mul, 'Value');
    link(t, mul, 'Value', sub, 'Value_001');
    link(t, sub, 'Value', dial, 'Value');
    const targets = valueTargets(t.doc, t.tree, null, dial);
    expect(targets.length).toBe(1);
    // gizmo value = 10 − 2·x: one unit of gizmo change is −0.5 of x
    expect(targets[0].factor).toBeCloseTo(-0.5);
    targets[0].set(targets[0].get() + targets[0].factor * 3);
    expect(val.props['outputs.Value']).toBeCloseTo(-1);
    // a modifier input linked through the group input node
    t.tree.interface!.push({ in_out: 'INPUT', name: 'Height', socket_type: 'NodeSocketFloat', identifier: 'Socket_1', default_value: 1 });
    const gi = addNode(t.tree, 'NodeGroupInput', [0, 0]);
    const lin = node(t, 'GeometryNodeGizmoLinear');
    link(t, gi, 'Socket_1', lin, 'Value');
    link(t, val, 'Value', lin, 'Value');
    const mod = { id: 'md', type: 'NODES', Socket_1: 4 } as unknown as ModifierBase;
    const tg = valueTargets(t.doc, t.tree, mod, lin);
    expect(tg.map((x) => x.get())).toEqual([4, -1]);
    tg[0].set(7);
    expect((mod as unknown as Record<string, number>).Socket_1).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Sound

import { encodeWav } from '../../src/sequencer/wav';

describe('Sample Sound Frequencies', () => {
  const sine = (freqs: number[], amp: number, scale = [1]) => {
    const rate = 48000;
    const chans = scale.map((s) => {
      const d = new Float32Array(rate);
      for (let i = 0; i < rate; i++) for (const f of freqs) d[i] += amp * s * Math.sin((2 * Math.PI * f * i) / rate);
      return d;
    });
    return encodeWav(chans, rate, 'S16');
  };
  const amp = (file: Uint8Array, inputs: Record<string, SocketValue>, props: Record<string, SocketValue> = {}) => {
    const t = setup();
    packFile(t.doc, 'a.wav', file);
    const s = node(t, 'GeometryNodeSampleSoundFrequencies', { Sound: 'a.wav', Time: 0.5, ...inputs }, props);
    const ml = node(t, 'GeometryNodeMeshLine', { Count: 1 });
    const sp = node(t, 'GeometryNodeSetPosition');
    link(t, ml, 'Mesh', sp, 'Geometry');
    link(t, s, 'Amplitude', sp, 'Offset');
    return run(t, sp).mesh!.positions[0];
  };
  it('measures the amplitude of a frequency band', () => {
    const one = sine([1000], 0.5);
    // recorded values (tolerance: windowing details)
    expect(amp(one, { Low: 900, High: 1100 })).toBeCloseTo(0.52635, 2);
    expect(amp(one, { Low: 0, High: 10000 })).toBeCloseTo(0.52734, 2);
    expect(amp(one, { Low: 2000, High: 3000 })).toBeLessThan(1e-3);
    expect(amp(one, { Low: 900, High: 1100 }, { 'FFT Size': '1024', 'Window Function': 'Rectangular' })).toBeCloseTo(0.4032, 1);
    const two = sine([440, 3000], 0.3, [1, 0.5]);
    expect(amp(two, { Low: 400, High: 500 })).toBeCloseTo(0.23652, 2);
    expect(amp(two, { Low: 400, High: 500, 'All Channels': false, Channel: 1 })).toBeCloseTo(0.15767, 2);
    expect(amp(two, { Low: 2900, High: 3100, 'All Channels': false, Channel: 0 }, { 'FFT Size': '2048', 'Window Function': 'Hamming' })).toBeCloseTo(0.27812, 2);
  });
});
