// Test helpers for geometry node trees: build a group, add and link nodes, evaluate it.
import '../../src/nodes/common';
import '../../src/nodes/shader/defs';
import '../../src/geonodes/core';
import { emptyDocument, uid } from '../../src/data/defaults';
import type { DocumentData, ModifierBase, NodeData, NodeGroupData, NodeTreeData, SocketValue } from '../../src/data/types';
import { addNode, connect, ctxOf } from '../../src/nodes/tree';
import { getNodeType } from '../../src/nodes/registry';
import { evaluateGroup } from '../../src/geonodes/modifier';
import type { EvalEnv } from '../../src/geonodes/exec';
import { GeometrySet, identity } from '../../src/geonodes/geometry';
import { makeContext, evalFull, type Field } from '../../src/geonodes/field';
import type { Domain, FieldType } from '../../src/geonodes/types';
import { attributeField } from '../../src/geonodes/inputs';

export interface T {
  doc: DocumentData;
  group: NodeGroupData;
  tree: NodeTreeData;
  out: NodeData;
  gin: NodeData;
}

export function setup(): T {
  const doc = emptyDocument();
  const tree: NodeTreeData = {
    type: 'GEOMETRY',
    nodes: [],
    links: [],
    interface: [
      {
        in_out: 'INPUT',
        name: 'Geometry',
        socket_type: 'NodeSocketGeometry',
        identifier: 'Socket_0',
      },
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
  const gin = addNode(tree, 'NodeGroupInput', [-400, 0]);
  return { doc, group, tree, out, gin };
}

export function node(t: T, type: string, inputs: Record<string, SocketValue> = {}, props: Record<string, SocketValue> = {}): NodeData {
  const n = addNode(t.tree, type, [0, 0], props);
  Object.assign(n.inputs, inputs);
  return n;
}

/** Add a zone input node with its paired output (as the editor does). */
export function zone(t: T, inputType: string): [NodeData, NodeData] {
  const i = node(t, inputType);
  const extra = getNodeType(inputType)!.onAdd!(t.tree, i);
  return [i, extra[0]];
}

export function link(t: T, a: NodeData, as: string, b: NodeData, bs: string) {
  const l = connect(ctxOf(t.doc, t.tree), a.id, as, b.id, bs);
  if (!l) throw new Error(`cannot link ${a.type}.${as} → ${b.type}.${bs}`);
}

export function env(doc: DocumentData, frame = 1): EvalEnv {
  return {
    doc,
    ob: null,
    selfWorld: identity(),
    frame,
    fps: 24,
    render: false,
    objectGeometry: () => null,
    objectWorld: () => null,
    collectionObjects: () => [],
    objectSig: () => '',
  };
}

const modifier = (t: T) =>
  ({
    id: 'md',
    name: 'GN',
    type: 'NODES',
    node_group: t.group.id,
  }) as unknown as ModifierBase;

/** Evaluate with `from.socket` linked to the group output. */
export function run(t: T, from: NodeData, socket = 'Geometry', input = GeometrySet.empty(), opts: { frame?: number; key?: string } = {}) {
  if (!t.tree.links.some((l) => l.to_node === t.out.id)) link(t, from, socket, t.out, 'Geometry');
  return evaluateGroup(t.group, modifier(t), env(t.doc, opts.frame ?? 1), input, 'in', opts.key ?? `test/${Math.random()}`, false);
}

/** Evaluate a field output (captured on the result geometry by storing it as an attribute first). */
export function fieldValues(g: GeometrySet, f: Field, domain: Domain = 'POINT'): number[] {
  const c = g.mesh ?? g.points ?? g.curves ?? g.instances;
  if (!c) return [];
  return Array.from(evalFull(f, makeContext(c, domain)));
}

export function attr(g: GeometrySet, name: string, domain: Domain = 'POINT', type: FieldType = 'FLOAT'): number[] {
  return fieldValues(g, attributeField(name, type), domain);
}

export function counts(g: GeometrySet) {
  const m = g.mesh;
  return m ? [m.vertCount, m.edgeCount, m.faceCount] : [0, 0, 0];
}

export function positions(g: GeometrySet): number[][] {
  const p = (g.mesh ?? g.points ?? g.curves)?.positions;
  if (!p) return [];
  const out: number[][] = [];
  for (let i = 0; i < p.length; i += 3) out.push([p[i], p[i + 1], p[i + 2]].map((x) => Math.round(x * 1e4) / 1e4));
  return out;
}

export const close = (a: number[], b: number[], eps = 1e-4) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps);
