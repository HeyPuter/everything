// Geometry node zones and Bake nodes from .blend files: items are rebuilt from the item sockets
// stored with the nodes (identifier, name and socket type), and zone inputs are paired with
// their outputs through the output node id kept in the input node's storage.
import type { NodeData, NodeTreeData } from '../../data/types';
import { interfaceSocketType } from '../../nodes/registry';
import type { BStruct } from './reader';

interface ZoneFile {
  /** item list key → socket identifier prefix, read from the node's inputs */
  lists: [string, string][];
}

const OUTPUTS: Record<string, ZoneFile> = {
  GeometryNodeRepeatOutput: { lists: [['repeat_items', 'Item_']] },
  GeometryNodeSimulationOutput: { lists: [['state_items', 'Item_']] },
  GeometryNodeBake: { lists: [['bake_items', 'Item_']] },
  GeometryNodeForeachGeometryElementOutput: {
    lists: [
      ['main_items', 'Main_'],
      ['generation_items', 'Generation_'],
    ],
  },
};

const INPUTS = new Set(['GeometryNodeRepeatInput', 'GeometryNodeSimulationInput', 'GeometryNodeForeachGeometryElementInput', 'NodeClosureInput']);

/** Item lists of bundle, closure and list nodes: [property, socket side, identifier prefix]. */
const ITEM_NODES: Record<string, [string, 'inputs' | 'outputs', string][]> = {
  NodeCombineBundle: [['bundle_items', 'inputs', 'Item_']],
  NodeSeparateBundle: [['bundle_items', 'outputs', 'Item_']],
  NodeEvaluateClosure: [
    ['input_items', 'inputs', 'Item_'],
    ['output_items', 'outputs', 'Item_'],
  ],
  GeometryNodeFieldToList: [['list_items', 'inputs', 'Field_']],
  GeometryNodeClosureToList: [['list_items', 'outputs', 'List_']],
};

const FOREACH_DOMAINS = ['POINT', 'EDGE', 'FACE', 'CORNER', 'CURVE', 'INSTANCE', 'LAYER'];

export interface ZonePending {
  /** bNode identifier → node */
  byIdentifier: Map<number, NodeData>;
  /** zone inputs and the bNode identifier of their output */
  inputs: [NodeData, number][];
  /** for-each input items (read from the input node), added to the paired output */
  foreachInputs: Map<NodeData, { id: number; name: string; socket_type: string }[]>;
  /** closure input items (read from the Closure Input node's outputs) */
  closureInputs: Map<NodeData, { id: number; name: string; socket_type: string }[]>;
}

export const newZonePending = (): ZonePending => ({ byIdentifier: new Map(), inputs: [], foreachInputs: new Map(), closureInputs: new Map() });

function itemsFrom(n: BStruct, prefix: string, side: 'inputs' | 'outputs' = 'inputs') {
  const out: { id: number; name: string; socket_type: string; attribute_domain?: string; domain?: string }[] = [];
  for (const s of n.list(side, 1000)) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(s.str('identifier'));
    if (!m) continue;
    const { type } = interfaceSocketType(s.str('idname'));
    out.push({ id: Number(m[1]), name: s.str('name'), socket_type: type });
  }
  return out;
}

const CAPTURE_TYPE: Record<string, string> = { FLOAT: 'FLOAT', INT: 'INT', BOOLEAN: 'BOOLEAN', VECTOR: 'FLOAT_VECTOR', RGBA: 'FLOAT_COLOR', ROTATION: 'QUATERNION' };

/** Read zone data (and Capture Attribute items) of one file node into the converted node. */
export function readZoneNode(n: BStruct, node: NodeData, pending: ZonePending) {
  if (n.has('identifier')) pending.byIdentifier.set(n.num('identifier'), node);
  if (node.type === 'GeometryNodeCaptureAttribute') {
    const items: { id: number; name: string; data_type: string }[] = [];
    for (const s of n.list('inputs', 1000)) {
      const m = /^Value(?:_(\d+))?$/.exec(s.str('identifier'));
      if (!m) continue;
      const t = CAPTURE_TYPE[interfaceSocketType(s.str('idname')).type];
      if (t) items.push({ id: m[1] ? Number(m[1]) : 0, name: s.str('name'), data_type: t });
    }
    if (items.length) node.props.capture_items = JSON.stringify(items);
    return;
  }
  const lists = ITEM_NODES[node.type];
  if (lists) {
    for (const [key, side, prefix] of lists) node.props[key] = JSON.stringify(itemsFrom(n, prefix, side));
    return;
  }
  if (node.type === 'NodeClosureOutput') {
    const items = itemsFrom(n, 'Item_');
    node.props.output_items = JSON.stringify(items);
    node.props.input_items = '[]';
    node.props.next_item_id = Math.max(0, ...items.map((i) => i.id + 1));
    return;
  }
  const z = OUTPUTS[node.type];
  if (z) {
    let next = 0;
    for (const [key, prefix] of z.lists) {
      const items = itemsFrom(n, prefix);
      if (key === 'state_items' || key === 'bake_items') for (const it of items) it.attribute_domain = 'POINT';
      if (key === 'generation_items') for (const it of items) it.domain = 'POINT';
      node.props[key] = JSON.stringify(items);
      for (const it of items) next = Math.max(next, it.id + 1);
    }
    node.props.next_item_id = next;
    const storage = n.ref('storage');
    if (node.type === 'GeometryNodeForeachGeometryElementOutput' && storage?.has('domain')) node.props.domain = FOREACH_DOMAINS[storage.num('domain')] ?? 'POINT';
    return;
  }
  if (!INPUTS.has(node.type)) return;
  const storage = n.ref('storage');
  if (storage?.has('output_node_id')) pending.inputs.push([node, storage.num('output_node_id')]);
  if (node.type === 'GeometryNodeForeachGeometryElementInput') pending.foreachInputs.set(node, itemsFrom(n, 'Input_'));
  if (node.type === 'NodeClosureInput') pending.closureInputs.set(node, itemsFrom(n, 'Item_', 'outputs'));
}

/** Pair zone inputs with their outputs once every node of the tree is converted. */
export function finishZones(tree: NodeTreeData, pending: ZonePending) {
  for (const [input, outId] of pending.inputs) {
    const out = pending.byIdentifier.get(outId);
    if (!out || !tree.nodes.includes(out)) continue;
    input.props.paired_output = out.id;
    const ci = pending.closureInputs.get(input);
    if (ci) {
      // closure item ids are per list in files: renumber the inputs after the outputs
      const outs = JSON.parse(String(out.props.output_items ?? '[]')) as { id: number }[];
      let next = Math.max(0, ...outs.map((i) => i.id + 1));
      const map = new Map<string, string>();
      const ins = ci.map((it) => {
        const id = next++;
        map.set(`Item_${it.id}`, `Item_${id}`);
        return { ...it, id };
      });
      out.props.input_items = JSON.stringify(ins);
      out.props.next_item_id = next;
      for (const l of tree.links) if (l.from_node === input.id && map.has(l.from_socket)) l.from_socket = map.get(l.from_socket)!;
    }
    const fi = pending.foreachInputs.get(input);
    if (fi?.length) {
      out.props.input_items = JSON.stringify(fi);
      out.props.next_item_id = Math.max(Number(out.props.next_item_id ?? 0), ...fi.map((i) => i.id + 1));
    }
  }
}
