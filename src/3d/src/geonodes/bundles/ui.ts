// Editor side of bundles and closures: item lists in the sidebar, Sync Sockets (node.sockets_sync)
// and automatic signatures for empty nodes linked to a node that defines one.
import { h, type Child } from '../../ui/h';
import { app, onAppReady, registerOperators, type OpContext } from '../../app/app';
import { getNodeType } from '../../nodes/registry';
import { nodeById } from '../../nodes/tree';
import type { NodeData, NodeTreeData } from '../../data/types';
import type { NodeDrawContext } from '../../nodes/types';
import { opButton } from '../../ui/widgets';
import { itemListUI, readItems } from '../nodes/items';
import { pairedOutput } from '../zones/items';
import { CLOSURE_INPUT, CLOSURE_OUTPUT } from '../zones/kinds';
import { COMBINE_BUNDLE, COMBINE_ITEMS, EVALUATE_CLOSURE, EVAL_INPUTS, EVAL_OUTPUTS, SEPARATE_BUNDLE, SEPARATE_ITEMS, SYNCABLE, linkedSignature, syncSockets, type Signature } from './nodes';

const strip = (l: { name: string; socket_type?: unknown }[]) => l.map((i) => `${i.name}:${String(i.socket_type ?? 'FLOAT')}`).join('|');

/** Current items of a node in signature form. */
function ownSignature(tree: NodeTreeData, n: NodeData): Signature {
  if (n.type === COMBINE_BUNDLE || n.type === SEPARATE_BUNDLE) return { items: readItems(n, 'bundle_items') as never };
  const holder = n.type === CLOSURE_INPUT ? pairedOutput(tree, n) : n;
  return {
    inputs: (holder ? readItems(holder, 'input_items') : []) as never,
    outputs: (holder ? readItems(holder, 'output_items') : []) as never,
  };
}

/** Whether a node's items differ from the signature of what it is linked to. */
export function outOfSync(tree: NodeTreeData, n: NodeData): boolean {
  const sig = linkedSignature(tree, n);
  if (!sig) return false;
  const own = ownSignature(tree, n);
  if (sig.items) return strip(sig.items) !== strip(own.items ?? []);
  return strip(sig.inputs ?? []) !== strip(own.inputs ?? []) || strip(sig.outputs ?? []) !== strip(own.outputs ?? []);
}

function syncRow(ctx: NodeDrawContext): Child {
  if (!outOfSync(ctx.tree, ctx.node)) return null;
  return h(
    'div',
    { class: 'gn-sync-row' },
    h('span', { class: 'prop-note' }, 'The linked node defines different items'),
    opButton(
      'node.sockets_sync',
      'Sync Sockets',
      { node_name: ctx.node.name },
      {
        icon: 'file_refresh',
        tip: 'Update the items of this node to match the node it is linked to',
      },
    ),
  );
}

const withSync =
  (draw: (ctx: NodeDrawContext) => Child) =>
  (ctx: NodeDrawContext): Child =>
    h('div', {}, syncRow(ctx), draw(ctx));

getNodeType(COMBINE_BUNDLE)!.drawOptions = withSync((ctx) => itemListUI(ctx, COMBINE_ITEMS));
getNodeType(SEPARATE_BUNDLE)!.drawOptions = withSync((ctx) => itemListUI(ctx, SEPARATE_ITEMS));
getNodeType(EVALUATE_CLOSURE)!.drawOptions = withSync((ctx) => [itemListUI(ctx, EVAL_INPUTS), itemListUI(ctx, EVAL_OUTPUTS)]);
for (const id of [CLOSURE_INPUT, CLOSURE_OUTPUT]) {
  const d = getNodeType(id)!;
  const prev = d.drawOptions;
  d.drawOptions = withSync((ctx) => prev?.(ctx) ?? null);
}

function treeOf(ctx: OpContext): NodeTreeData | null {
  const ed = ctx.area?.editor as { tree?: () => NodeTreeData | null } | undefined;
  return typeof ed?.tree === 'function' ? ed.tree() : null;
}

/** Nodes the operator acts on: the named node, else the selected syncable nodes (or the active one). */
function targets(tree: NodeTreeData, name: string): NodeData[] {
  if (name) return tree.nodes.filter((n) => n.name === name && SYNCABLE.has(n.type));
  const sel = tree.nodes.filter((n) => n.select && SYNCABLE.has(n.type));
  if (sel.length) return sel;
  const a = tree.active_node ? nodeById(tree, tree.active_node) : undefined;
  return a && SYNCABLE.has(a.type) ? [a] : [];
}

registerOperators([
  {
    idname: 'node.sockets_sync',
    label: 'Sync Sockets',
    description: 'Update the items of bundle and closure nodes to match the nodes they are linked to',
    props: [
      {
        id: 'node_name',
        label: 'Node Name',
        type: 'string',
        default: '',
        hidden: true,
      },
    ],
    poll: (ctx) => {
      const tree = treeOf(ctx);
      return !!tree && targets(tree, '').length + tree.nodes.filter((n) => SYNCABLE.has(n.type)).length > 0;
    },
    exec: (ctx, p) => {
      const tree = treeOf(ctx);
      if (!tree) return 'CANCELLED';
      let any = false;
      for (const n of targets(tree, String(p.node_name ?? ''))) if (syncSockets(tree, n)) any = true;
      if (!any) {
        app.report('INFO', 'Nothing to sync: the items already match');
        return 'CANCELLED';
      }
      app.changed('doc');
    },
  },
]);

// ---------------------------------------------------------------------------
// A node without items takes the signature of the node it gets linked to

const emptyNode = (tree: NodeTreeData, n: NodeData) => {
  const s = ownSignature(tree, n);
  return !(s.items?.length || s.inputs?.length || s.outputs?.length);
};

/** Links seen per tree, to react to new links only. */
const seen = new WeakMap<NodeTreeData, Set<string>>();

export function autoSync(tree: NodeTreeData): boolean {
  const prev = seen.get(tree);
  const now = new Set(tree.links.map((l) => l.id));
  seen.set(tree, now);
  if (!prev) return false;
  let any = false;
  for (const l of tree.links) {
    if (prev.has(l.id)) continue;
    for (const id of [l.to_node, l.from_node]) {
      const n = nodeById(tree, id);
      if (n && SYNCABLE.has(n.type) && emptyNode(tree, n) && syncSockets(tree, n)) any = true;
    }
  }
  if (any) seen.set(tree, new Set(tree.links.map((l) => l.id)));
  return any;
}

onAppReady((a) => {
  a.subscribe((kinds) => {
    if (!kinds.has('doc')) return;
    let any = false;
    for (const g of Object.values(a.doc.node_groups)) if (g.tree.type === 'GEOMETRY' && g.tree.nodes.some((n) => SYNCABLE.has(n.type)) && autoSync(g.tree)) any = true;
    if (any) a.changed('doc');
  });
});
