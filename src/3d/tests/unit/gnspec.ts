// Builds and evaluates a geometry node tree from a compact JSON description (used by the field and
// function node tests and their recorded expected values in tests/fixtures/geonodes).
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/geonodes/core';
import { emptyDocument, uid } from '../../src/data/defaults';
import type { DocumentData, ModifierBase, NodeData, NodeGroupData, NodeTreeData, SocketValue } from '../../src/data/types';
import { addNode, connect, ctxOf } from '../../src/nodes/tree';
import { evaluateGroup } from '../../src/geonodes/modifier';
import { TreeEval } from '../../src/geonodes/evaluator';
import { GeometrySet, identity } from '../../src/geonodes/geometry';
import type { EvalEnv } from '../../src/geonodes/exec';
import { dataComps } from '../../src/geonodes/types';
import { getNodeType } from '../../src/nodes/registry';

export interface GnSpec {
  nodes: Record<string, { type: string; props?: Record<string, SocketValue>; inputs?: Record<string, SocketValue> }>;
  links?: [string, string, string, string][];
  /** node and output socket providing the geometry the outputs are stored on */
  geometry?: [string, string];
  /** [attribute name, node, socket, data type, domain] */
  outputs?: [string, string, string, string, string][];
}

export interface GnSpecResult {
  values: Record<string, (number | boolean | number[] | string)[]>;
  errors: string[];
  warnings: string[];
  geometry: GeometrySet;
}

export function testEnv(doc: DocumentData, extra: Partial<EvalEnv> = {}): EvalEnv {
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
    ...extra,
  };
}

export function runSpec(spec: GnSpec, opts: { doc?: DocumentData; env?: Partial<EvalEnv>; input?: GeometrySet } = {}): GnSpecResult {
  const doc = opts.doc ?? emptyDocument();
  const tree: NodeTreeData = {
    type: 'GEOMETRY',
    nodes: [],
    links: [],
    interface: [
      { in_out: 'INPUT', name: 'Geometry', socket_type: 'NodeSocketGeometry', identifier: 'Socket_0' },
      { in_out: 'OUTPUT', name: 'Geometry', socket_type: 'NodeSocketGeometry', identifier: 'Socket_1' },
    ],
  };
  const group: NodeGroupData = { id: uid('ng'), name: 'Spec', tree, is_modifier: true };
  doc.node_groups[group.id] = group;
  const out = addNode(tree, 'NodeGroupOutput', [400, 0]);
  const N: Record<string, NodeData> = { in: addNode(tree, 'NodeGroupInput', [-400, 0]) };
  const errors: string[] = [];
  for (const [name, d] of Object.entries(spec.nodes)) {
    const props: Record<string, SocketValue> = { ...(d.props ?? {}) };
    // item lists given as [type, name] pairs
    const fi = props.format_items as unknown;
    if (Array.isArray(fi)) props.format_items = JSON.stringify(fi.map(([type, name]: [string, string], id: number) => ({ id, name, type })));
    const n = addNode(tree, d.type, [0, 0], props as Record<string, never>);
    // menu sockets that the node shows as properties
    const def = getNodeType(d.type);
    for (const [k, v] of Object.entries(d.inputs ?? {})) {
      if (def?.props.some((p) => p.id === k)) n.props[k] = v;
      else n.inputs[k] = v;
    }
    N[name] = n;
  }
  const sctx = ctxOf(doc, tree);
  const lk = (a: NodeData, as: string, b: NodeData, bs: string) => {
    if (!connect(sctx, a.id, as, b.id, bs)) errors.push(`cannot link ${a.type}.${as} -> ${b.type}.${bs}`);
  };
  for (const [a, as, b, bs] of spec.links ?? []) lk(N[a], as === 'Geometry' && a === 'in' ? 'Socket_0' : as, N[b], bs);
  let geo: [NodeData, string] = spec.geometry ? [N[spec.geometry[0]], spec.geometry[1]] : [N.in, 'Socket_0'];
  const strings: [string, string, string][] = [];
  for (const [label, node, s, dt, dom] of spec.outputs ?? []) {
    if (dt === 'STRING') {
      strings.push([label, node, s]);
      continue;
    }
    const st = addNode(tree, 'GeometryNodeStoreNamedAttribute', [0, 0], { data_type: dt, domain: dom } as Record<string, never>);
    st.inputs.Name = label;
    lk(geo[0], geo[1], st, 'Geometry');
    lk(N[node], s, st, 'Value');
    geo = [st, 'Geometry'];
  }
  lk(geo[0], geo[1], out, 'Socket_1');
  const m = { id: 'md', name: 'GN', type: 'NODES', node_group: group.id } as unknown as ModifierBase;
  const r = evaluateGroup(group, m, testEnv(doc, opts.env), opts.input ?? GeometrySet.empty(), 'in', `spec/${uid('k')}`, false);
  const values: GnSpecResult['values'] = {};
  for (const [label] of spec.outputs ?? []) {
    for (const c of r.geometry.components()) {
      const a = c.attrs.get(label);
      if (!a) continue;
      const comps = dataComps(a.type);
      const vals: (number | boolean | number[])[] = [];
      for (let i = 0; i < a.data.length / comps; i++) vals.push(comps === 1 ? (a.type === 'BOOLEAN' ? !!a.data[i] : a.data[i]) : Array.from(a.data.subarray(i * comps, i * comps + comps)));
      values[label] = vals;
      break;
    }
  }
  if (strings.length) {
    const te = new TreeEval(
      testEnv(doc, opts.env),
      tree,
      'strings',
      () => undefined,
      () => '',
      new Map(),
      { warnings: new Map(), executed: 0, generation: 1 },
    );
    for (const [label, node, s] of strings) values[label] = [String(te.nodeOutputs(N[node])[s] ?? '')];
  }
  return { values, errors, warnings: [...r.log.warnings.values()].flat(), geometry: r.geometry };
}

/** Index of the first value differing from `expected` beyond a relative tolerance (−1 when all match). */
export function firstMismatch(expected: unknown[], actual: unknown[], eps = 1e-4): number {
  const close = (a: unknown, b: unknown): boolean => {
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => close(x, b[i]));
    if (typeof a === 'boolean' || typeof b === 'boolean') return !!a === !!b;
    if (typeof a === 'string' || typeof b === 'string') return a === b;
    const x = Number(a),
      y = Number(b);
    return Math.abs(x - y) <= eps * Math.max(1, Math.abs(x), Math.abs(y));
  };
  if (expected.length !== actual.length) return Math.min(expected.length, actual.length);
  return expected.findIndex((e, i) => !close(e, actual[i]));
}
