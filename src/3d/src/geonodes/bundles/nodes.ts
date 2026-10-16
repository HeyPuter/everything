// Bundle and closure nodes: Combine / Separate Bundle, Get / Store Bundle Item, Join Bundle, the
// Closure zone (Closure Input + Closure Output) and Evaluate Closure.
import type { NodeData, NodeTreeData } from '../../data/types';
import type { SocketDef, SocketType } from '../../nodes/types';
import { geoNode, sock, enumProp } from '../nodes/gndef';
import type { Val } from '../exec';
import { coerce } from '../evaluator';
import { registerItemNode, itemSocket as addSocket, readItems, type ItemListDef, type NodeItem } from '../nodes/items';
import { ITEM_TYPES, extendSocket, itemSocket, pairedInput, pairedOutput, readItems as readZoneItems, type ZoneItem } from '../zones/items';
import { CLOSURE_INPUT, CLOSURE_OUTPUT } from '../zones/kinds';
import { addPairedOutput } from '../zones/repeat';
import { BundleValue, ClosureValue, entryAs, type ClosureArg } from './values';

export const COMBINE_BUNDLE = 'NodeCombineBundle';
export const SEPARATE_BUNDLE = 'NodeSeparateBundle';
export const GET_BUNDLE_ITEM = 'NodeGetBundleItem';
export const STORE_BUNDLE_ITEM = 'NodeStoreBundleItem';
export const JOIN_BUNDLE = 'NodeJoinBundle';
export const EVALUATE_CLOSURE = 'NodeEvaluateClosure';

const itemId = (it: { id: number }) => `Item_${it.id}`;
const asZone = (it: NodeItem): ZoneItem => ({ id: it.id, name: it.name, socket_type: (it.socket_type as SocketType) ?? 'FLOAT' });
const typeOf = (it: NodeItem): SocketType => (it.socket_type as SocketType) ?? 'FLOAT';

/** Item type for a socket linked to an "add item" socket (every value type except shaders). */
const typeForSocket = (s: SocketDef): string | undefined => (ITEM_TYPES.some(([t]) => t === s.type) ? s.type : undefined);

function typedList(prop: string, title: string, ops: string, opLabel: string, side: 'in' | 'out', activeKey = 'active_index'): ItemListDef {
  return {
    prop,
    title,
    ...(side === 'in' ? { inSocket: itemId } : { outSocket: itemId }),
    types: ITEM_TYPES,
    typeKey: 'socket_type',
    typeFor: typeForSocket,
    defaultName: () => 'Item',
    nameFromType: true,
    ops,
    opLabel,
    activeKey,
  };
}

export const COMBINE_ITEMS = typedList('bundle_items', 'Bundle Items', 'combine_bundle', 'Combine Bundle', 'in');
export const SEPARATE_ITEMS = typedList('bundle_items', 'Bundle Items', 'separate_bundle', 'Separate Bundle', 'out');
export const EVAL_INPUTS = typedList('input_items', 'Closure Inputs', 'evaluate_closure_input', 'Evaluate Closure Input', 'in', 'active_input_index');
export const EVAL_OUTPUTS = typedList('output_items', 'Closure Outputs', 'evaluate_closure_output', 'Evaluate Closure Output', 'out', 'active_output_index');

const bundleItems = (n: NodeData) => readItems(n, 'bundle_items');
const evalInputs = (n: NodeData) => readItems(n, 'input_items');
const evalOutputs = (n: NodeData) => readItems(n, 'output_items');

registerItemNode(COMBINE_BUNDLE, COMBINE_ITEMS, bundleItems);
registerItemNode(SEPARATE_BUNDLE, SEPARATE_ITEMS, bundleItems);
registerItemNode(EVALUATE_CLOSURE, EVAL_INPUTS, evalInputs);
registerItemNode(EVALUATE_CLOSURE, EVAL_OUTPUTS, evalOutputs);

const bundleSock = (name = 'Bundle', o: Partial<SocketDef> = {}) => sock(name, 'BUNDLE', { hide_value: true, ...o });

// ---------------------------------------------------------------------------
// Bundles

geoNode(
  {
    idname: COMBINE_BUNDLE,
    label: 'Combine Bundle',
    category: 'converter',
    description: 'Pack several named values into one bundle',
    outputs: [bundleSock()],
    dynamicSockets: (node) => ({ inputs: [...bundleItems(node).map((it) => itemSocket(asZone(it), itemId(it))), addSocket()], outputs: [bundleSock()] }),
  },
  {
    exec: (ctx) => {
      const entries: [string, { type: SocketType; value: Val }][] = [];
      for (const it of bundleItems(ctx.node)) entries.push([it.name, { type: typeOf(it), value: ctx.input(itemId(it)) }]);
      return { Bundle: BundleValue.of(entries) };
    },
  },
);

geoNode(
  {
    idname: SEPARATE_BUNDLE,
    label: 'Separate Bundle',
    category: 'converter',
    description: 'Read named values out of a bundle (missing values use their defaults)',
    inputs: [bundleSock()],
    dynamicSockets: (node) => ({ inputs: [bundleSock()], outputs: [...bundleItems(node).map((it) => itemSocket(asZone(it), itemId(it))), addSocket()] }),
  },
  {
    exec: (ctx) => {
      const b = ctx.input('Bundle');
      const out: Record<string, Val> = {};
      for (const it of bundleItems(ctx.node)) out[itemId(it)] = entryAs(b instanceof BundleValue ? b.items.get(it.name) : undefined, typeOf(it));
      return out;
    },
  },
);

const VALUE_TYPES: [string, string][] = ITEM_TYPES.map(([t, l]) => [t, l]);
const itemTypeOf = (n: NodeData) => (String(n.props.socket_type ?? 'FLOAT') as SocketType) || 'FLOAT';
const valueSock = (n: NodeData, name: string) => itemSocket({ id: 0, name, socket_type: itemTypeOf(n) }, name);

geoNode(
  {
    idname: GET_BUNDLE_ITEM,
    label: 'Get Bundle Item',
    category: 'converter',
    description: 'Read one value of a bundle by its path (names separated by "/" reach into nested bundles)',
    props: [enumProp('socket_type', 'Type', VALUE_TYPES, 'FLOAT')],
    inputs: [bundleSock(), sock('Path', 'STRING', { d: '' }), sock('Remove', 'BOOLEAN', { d: false })],
    outputs: [bundleSock(), sock('Item', 'FLOAT'), sock('Exists', 'BOOLEAN')],
    dynamicSockets: (node) => ({
      inputs: [bundleSock(), sock('Path', 'STRING', { d: '' }), sock('Remove', 'BOOLEAN', { d: false })],
      outputs: [bundleSock(), valueSock(node, 'Item'), sock('Exists', 'BOOLEAN')],
    }),
  },
  {
    exec: (ctx) => {
      const b = ctx.input('Bundle');
      const bundle = b instanceof BundleValue ? b : new BundleValue();
      const path = ctx.string('Path');
      const e = bundle.get(path);
      return { Bundle: ctx.bool('Remove') ? bundle.without(path) : bundle, Item: entryAs(e, itemTypeOf(ctx.node)), Exists: !!e };
    },
  },
);

geoNode(
  {
    idname: STORE_BUNDLE_ITEM,
    label: 'Store Bundle Item',
    category: 'converter',
    description: 'Add or replace one value of a bundle at a path',
    props: [enumProp('socket_type', 'Type', VALUE_TYPES, 'FLOAT')],
    inputs: [bundleSock(), sock('Path', 'STRING', { d: '' }), sock('Item', 'FLOAT', { d: 0 })],
    outputs: [bundleSock()],
    dynamicSockets: (node) => ({ inputs: [bundleSock(), sock('Path', 'STRING', { d: '' }), valueSock(node, 'Item')], outputs: [bundleSock()] }),
  },
  {
    exec: (ctx) => {
      const b = ctx.input('Bundle');
      const bundle = b instanceof BundleValue ? b : new BundleValue();
      const path = ctx.string('Path');
      if (!path.trim()) {
        ctx.warn('The path is empty');
        return { Bundle: bundle };
      }
      return { Bundle: bundle.with(path, { type: itemTypeOf(ctx.node), value: ctx.input('Item') }) };
    },
  },
);

geoNode(
  {
    idname: JOIN_BUNDLE,
    label: 'Join Bundle',
    category: 'converter',
    description: 'Merge bundles into one; when a name appears in several, the first link wins',
    inputs: [bundleSock('Bundle', { multiInput: true })],
    outputs: [bundleSock()],
  },
  { exec: (ctx) => ({ Bundle: BundleValue.join(ctx.values('Bundle').filter((v): v is BundleValue => v instanceof BundleValue)) }) },
);

// ---------------------------------------------------------------------------
// Closure zone

const closureInputs = (out: NodeData | undefined) => readZoneItems(out, 'input_items');
const closureOutputs = (out: NodeData | undefined) => readZoneItems(out, 'output_items');

geoNode(
  {
    idname: CLOSURE_INPUT,
    label: 'Closure Input',
    category: 'converter',
    description: 'Start of a closure zone: the values the closure is called with',
    dynamicSockets: (node, ctx) => ({ inputs: [], outputs: [...closureInputs(pairedOutput(ctx.tree, node)).map((it) => itemSocket(it, itemId(it))), extendSocket()] }),
    onAdd: (tree, n) => addPairedOutput(tree, n, CLOSURE_OUTPUT),
  },
  {
    // only evaluated directly when its outputs are used outside the zone: defaults
    exec: (ctx) => {
      const out: Record<string, Val> = {};
      for (const it of closureInputs(pairedOutput(ctx.tree, ctx.node))) out[itemId(it)] = coerce(undefined, it.socket_type);
      return out;
    },
  },
);

geoNode(
  {
    idname: CLOSURE_OUTPUT,
    label: 'Closure Output',
    category: 'converter',
    hidden: true,
    description: 'End of a closure zone: packs the nodes of the zone into a closure value',
    init: (n) => {
      n.props.input_items ??= '[]';
      n.props.output_items ??= '[]';
    },
    outputs: [sock('Closure', 'CLOSURE', { hide_value: true })],
    dynamicSockets: (node) => ({ inputs: [...closureOutputs(node).map((it) => itemSocket(it, itemId(it))), extendSocket()], outputs: [sock('Closure', 'CLOSURE', { hide_value: true })] }),
  },
  {
    exec: (ctx) => {
      const inp = pairedInput(ctx.tree, ctx.node, CLOSURE_INPUT);
      if (!inp) {
        ctx.warn('The closure output has no paired closure input');
        return { Closure: null };
      }
      return { Closure: new ClosureValue(ctx.evaluator, inp, ctx.node, closureInputs(ctx.node), closureOutputs(ctx.node)) };
    },
  },
);

geoNode(
  {
    idname: EVALUATE_CLOSURE,
    label: 'Evaluate Closure',
    category: 'converter',
    description: 'Call a closure with the given inputs; inputs and outputs are matched by name',
    inputs: [sock('Closure', 'CLOSURE', { hide_value: true })],
    dynamicSockets: (node) => ({
      inputs: [sock('Closure', 'CLOSURE', { hide_value: true }), ...evalInputs(node).map((it) => itemSocket(asZone(it), itemId(it))), addSocket()],
      outputs: [...evalOutputs(node).map((it) => itemSocket(asZone(it), itemId(it))), addSocket()],
    }),
  },
  {
    exec: (ctx) => {
      const c = ctx.input('Closure');
      const outs = evalOutputs(ctx.node);
      const result: Record<string, Val> = {};
      const defaults = () => {
        for (const it of outs) result[itemId(it)] = coerce(undefined, typeOf(it));
        return result;
      };
      if (!(c instanceof ClosureValue)) return defaults();
      const args: ClosureArg[] = evalInputs(ctx.node).map((it) => ({ name: it.name, type: typeOf(it), value: ctx.input(itemId(it)) }));
      const vals = c.evaluate(
        args,
        outs.map((it) => ({ name: it.name, type: typeOf(it) })),
      );
      if (!vals) {
        ctx.warn('Closures call each other too deeply', 'ERROR');
        return defaults();
      }
      outs.forEach((it, k) => (result[itemId(it)] = vals[k]));
      return result;
    },
  },
);

// ---------------------------------------------------------------------------
// Signatures: the items another node defines for a bundle or closure link

export interface Signature {
  inputs?: { name: string; socket_type: SocketType }[];
  outputs?: { name: string; socket_type: SocketType }[];
  items?: { name: string; socket_type: SocketType }[];
}

const byId = (tree: NodeTreeData, id: string) => tree.nodes.find((n) => n.id === id);

/** Follow reroutes upstream from an input socket to the node feeding it. */
function upstreamNode(tree: NodeTreeData, nodeId: string, socket: string): NodeData | undefined {
  let l = tree.links.find((x) => x.to_node === nodeId && x.to_socket === socket);
  for (let i = 0; l && i < 64; i++) {
    const from = byId(tree, l.from_node);
    if (from?.type !== 'NodeReroute') return from;
    l = tree.links.find((x) => x.to_node === from.id);
  }
  return undefined;
}

/** Nodes fed by an output socket (through reroutes). */
function downstreamNodes(tree: NodeTreeData, nodeId: string, socket: string): NodeData[] {
  const out: NodeData[] = [];
  const st = tree.links.filter((x) => x.from_node === nodeId && x.from_socket === socket);
  for (let i = 0; st.length && i < 256; i++) {
    const l = st.pop()!;
    const to = byId(tree, l.to_node);
    if (!to) continue;
    if (to.type === 'NodeReroute') st.push(...tree.links.filter((x) => x.from_node === to.id));
    else out.push(to);
  }
  return out;
}

const simple = (items: { name: string; socket_type?: unknown }[]) => items.map((it) => ({ name: it.name, socket_type: (it.socket_type as SocketType) ?? 'FLOAT' }));

/** The signature a linked node defines for this node's bundle or closure, if any. */
export function linkedSignature(tree: NodeTreeData, node: NodeData): Signature | null {
  if (node.type === SEPARATE_BUNDLE) {
    const src = upstreamNode(tree, node.id, 'Bundle');
    if (src?.type === COMBINE_BUNDLE) return { items: simple(bundleItems(src)) };
    return null;
  }
  if (node.type === COMBINE_BUNDLE) {
    const dst = downstreamNodes(tree, node.id, 'Bundle').find((n) => n.type === SEPARATE_BUNDLE);
    return dst ? { items: simple(bundleItems(dst)) } : null;
  }
  if (node.type === EVALUATE_CLOSURE) {
    const src = upstreamNode(tree, node.id, 'Closure');
    if (src?.type === CLOSURE_OUTPUT) return { inputs: simple(closureInputs(src)), outputs: simple(closureOutputs(src)) };
    return null;
  }
  if (node.type === CLOSURE_OUTPUT || node.type === CLOSURE_INPUT) {
    const out = node.type === CLOSURE_OUTPUT ? node : pairedOutput(tree, node);
    if (!out) return null;
    const dst = downstreamNodes(tree, out.id, 'Closure').find((n) => n.type === EVALUATE_CLOSURE);
    return dst ? { inputs: simple(evalInputs(dst)), outputs: simple(evalOutputs(dst)) } : null;
  }
  return null;
}

/** Items matching a signature, keeping the ids of same-named items (so their links survive). */
function syncList<T extends { id: number; name: string }>(
  cur: T[],
  sig: { name: string; socket_type: SocketType }[],
  make: (id: number, s: { name: string; socket_type: SocketType }) => T,
  firstId: number,
): T[] {
  let next = Math.max(firstId, ...cur.map((i) => i.id + 1));
  return sig.map((s) => {
    const keep = cur.find((i) => i.name === s.name);
    return keep ? { ...keep, socket_type: s.socket_type } : make(next++, s);
  });
}

/** Update a node's items to the signature of what it is linked to. Returns whether anything changed. */
export function syncSockets(tree: NodeTreeData, node: NodeData): boolean {
  const sig = linkedSignature(tree, node);
  if (!sig) return false;
  const holder = node.type === CLOSURE_INPUT ? pairedOutput(tree, node) : node;
  if (!holder) return false;
  const state = () => JSON.stringify([holder.props.bundle_items, holder.props.input_items, holder.props.output_items, tree.links.length]);
  const before = state();
  const mk = (id: number, s: { name: string; socket_type: SocketType }) => ({ id, name: s.name, socket_type: s.socket_type });
  const unlinkMissing = (holder: NodeData, keep: Set<number>, side: 'in' | 'out', nodes: string[]) => {
    tree.links = tree.links.filter((l) => {
      const sock = side === 'in' ? l.to_socket : l.from_socket;
      const nid = side === 'in' ? l.to_node : l.from_node;
      if (!nodes.includes(nid) || !/^Item_\d+$/.test(sock)) return true;
      return keep.has(Number(sock.slice(5)));
    });
  };
  if (sig.items) {
    const items = syncList(bundleItems(node), sig.items, mk, 0);
    node.props.bundle_items = JSON.stringify(items);
    unlinkMissing(node, new Set(items.map((i) => i.id)), node.type === COMBINE_BUNDLE ? 'in' : 'out', [node.id]);
  } else if (node.type === EVALUATE_CLOSURE) {
    const ins = syncList(evalInputs(node), sig.inputs ?? [], mk, 0);
    const outs = syncList(evalOutputs(node), sig.outputs ?? [], mk, 0);
    node.props.input_items = JSON.stringify(ins);
    node.props.output_items = JSON.stringify(outs);
    tree.links = tree.links.filter((l) => {
      if (l.to_node === node.id && /^Item_\d+$/.test(l.to_socket)) return ins.some((i) => itemId(i) === l.to_socket);
      if (l.from_node === node.id && /^Item_\d+$/.test(l.from_socket)) return outs.some((i) => itemId(i) === l.from_socket);
      return true;
    });
  } else {
    const out = node.type === CLOSURE_OUTPUT ? node : pairedOutput(tree, node)!;
    const inp = pairedInput(tree, out, CLOSURE_INPUT);
    const first = Number(out.props.next_item_id ?? 0);
    const ins = syncList(closureInputs(out), sig.inputs ?? [], mk, first);
    const outs = syncList(closureOutputs(out), sig.outputs ?? [], mk, Math.max(first, ...ins.map((i) => i.id + 1)));
    out.props.input_items = JSON.stringify(ins);
    out.props.output_items = JSON.stringify(outs);
    out.props.next_item_id = Math.max(first, ...ins.map((i) => i.id + 1), ...outs.map((i) => i.id + 1));
    if (inp) unlinkMissing(inp, new Set(ins.map((i) => i.id)), 'out', [inp.id]);
    unlinkMissing(out, new Set(outs.map((i) => i.id)), 'in', [out.id]);
  }
  return state() !== before;
}

/** Node types whose items can follow a linked signature. */
export const SYNCABLE = new Set([COMBINE_BUNDLE, SEPARATE_BUNDLE, EVALUATE_CLOSURE, CLOSURE_INPUT, CLOSURE_OUTPUT]);
