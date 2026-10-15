// Repeat zone: runs its body a number of times, feeding each iteration's results into the next.
import type { NodeData, NodeTreeData } from '../../data/types';
import { makeNode } from '../../nodes/tree';
import { uid } from '../../data/defaults';
import { geoNode, sock } from '../nodes/gndef';
import type { Val } from '../exec';
import { coerce } from '../evaluator';
import { EXTEND, extendSocket, itemSocket, nextItemId, pairedInput, pairedOutput, readItems, writeItems, type ZoneItem } from './items';
import { REPEAT_INPUT, REPEAT_OUTPUT } from './kinds';
import { ZoneEval, inputOf, single, zoneBody } from './eval';

const KEY = 'repeat_items';
export const itemId = (it: ZoneItem) => `Item_${it.id}`;
/** Upper bound on iterations, so a stray huge value cannot hang the evaluation. */
export const MAX_ITERATIONS = 100000;

/** Initialize the item list of a new zone output node (one Geometry item). */
export function initItems(n: NodeData, key: string) {
  if (n.props[key] !== undefined) return;
  writeItems(n, key, [{ id: nextItemId(n, [key]), name: 'Geometry', socket_type: 'GEOMETRY' }]);
}

/**
 * Add the paired output of a newly added zone input: placed to the right, linked through the
 * first geometry item (if any).
 */
export function addPairedOutput(tree: NodeTreeData, input: NodeData, outputType: string, firstItem?: (out: NodeData) => [string, string] | null): NodeData[] {
  if (pairedOutput(tree, input)) return [];
  const out = makeNode(tree, outputType, [input.location[0] + 300, input.location[1]]);
  tree.nodes.push(out);
  input.props.paired_output = out.id;
  const pair = firstItem?.(out);
  if (pair)
    tree.links.push({
      id: uid('link'),
      from_node: input.id,
      from_socket: pair[0],
      to_node: out.id,
      to_socket: pair[1],
    });
  return [out];
}

geoNode(
  {
    idname: REPEAT_INPUT,
    label: 'Repeat Input',
    category: 'converter',
    description: 'Start of a repeat zone: values that pass through the zone and the current iteration index',
    inputs: [sock('Iterations', 'INT', { d: 1, min: 0 })],
    outputs: [sock('Iteration', 'INT')],
    dynamicSockets: (node, ctx) => {
      const items = readItems(pairedOutput(ctx.tree, node), KEY);
      return {
        inputs: [sock('Iterations', 'INT', { d: 1, min: 0 }), ...items.map((it) => itemSocket(it, itemId(it))), extendSocket()],
        outputs: [sock('Iteration', 'INT'), ...items.map((it) => itemSocket(it, itemId(it))), extendSocket()],
      };
    },
    onAdd: (tree, n) =>
      addPairedOutput(tree, n, REPEAT_OUTPUT, (out) => {
        const g = readItems(out, KEY).find((i) => i.socket_type === 'GEOMETRY');
        return g ? [itemId(g), itemId(g)] : null;
      }),
  },
  {
    // only evaluated directly when its outputs are used outside the zone: pass the inputs through
    exec: (ctx) => {
      const out: Record<string, Val> = { Iteration: 0 };
      const items = readItems(pairedOutput(ctx.tree, ctx.node), KEY);
      for (const it of items) out[itemId(it)] = ctx.input(itemId(it));
      return out;
    },
  },
);

geoNode(
  {
    idname: REPEAT_OUTPUT,
    label: 'Repeat Output',
    category: 'converter',
    hidden: true,
    description: 'End of a repeat zone: the results after the last iteration',
    init: (n) => initItems(n, KEY),
    dynamicSockets: (node) => {
      const items = readItems(node, KEY);
      return {
        inputs: [...items.map((it) => itemSocket(it, itemId(it))), extendSocket()],
        outputs: [...items.map((it) => itemSocket(it, itemId(it))), extendSocket()],
      };
    },
  },
  {
    exec: (ctx) => {
      const ev = ctx.evaluator;
      const node = ctx.node;
      const items = readItems(node, KEY);
      const inp = pairedInput(ctx.tree, node, REPEAT_INPUT);
      const result: Record<string, Val> = {};
      if (!inp) {
        ctx.warn('The repeat output has no paired repeat input');
        for (const it of items) result[itemId(it)] = ctx.input(itemId(it));
        return result;
      }
      // initial state from the zone input
      let state: Val[] = items.map((it) => inputOf(ev, inp, itemId(it)) ?? coerce(undefined, it.socket_type));
      const itv = single(inputOf(ev, inp, 'Iterations'));
      let n = typeof itv === 'number' ? Math.round(itv) : typeof itv === 'boolean' ? (itv ? 1 : 0) : 0;
      if (itv === undefined) ctx.warn('Iterations must be a single value');
      if (n > MAX_ITERATIONS) {
        ctx.warn(`Iterations are limited to ${MAX_ITERATIONS}`);
        n = MAX_ITERATIONS;
      }
      const body = zoneBody(ctx.tree, inp.id, node.id);
      for (let i = 0; i < n; i++) {
        const outs: Record<string, Val> = { Iteration: i };
        items.forEach((it, k) => (outs[itemId(it)] = state[k]));
        const z = new ZoneEval(ev, body, inp.id, outs);
        state = items.map((it) => z.outputInput(node, itemId(it)));
      }
      items.forEach((it, k) => (result[itemId(it)] = state[k]));
      return result;
    },
  },
);

export { EXTEND };
