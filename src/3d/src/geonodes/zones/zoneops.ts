// Operators for zones: adding a zone (both nodes, linked) and managing zone / bake items on the
// active node (add, remove, move), usable from search and scripts.
import { app, onAppReady, operators, registerOperators, type OpContext, type Operator } from '../../app/app';
import { nodeEditorOf } from '../../nodes/editor/ops';
import { ctxOf, makeNode, nodeById } from '../../nodes/tree';
import { swapNode } from '../../nodes/treeops';
import { findSocket, getNodeType } from '../../nodes/registry';
import { uid } from '../../data/defaults';
import type { NodeData, NodeTreeData } from '../../data/types';
import type { SocketType } from '../../nodes/types';
import { ITEM_TYPES, readItems, writeItems, pairedOutput } from './items';
import { ZONES, BAKE, zoneOfType, type ItemList } from './kinds';
import { accepts, addItem, removeItem } from './itemops';

function activeNode(ctx: OpContext): { tree: NodeTreeData; node: NodeData } | null {
  const ed = nodeEditorOf(ctx);
  const tree = ed?.tree();
  if (!tree || tree.type !== 'GEOMETRY' || !tree.active_node) return null;
  const node = nodeById(tree, tree.active_node);
  return node ? { tree, node } : null;
}

/** The node holding the items of a list for the active node, if it belongs to that zone kind. */
function holderFor(ctx: OpContext, nodeTypes: string[]): { tree: NodeTreeData; holder: NodeData } | null {
  const a = activeNode(ctx);
  if (!a || !nodeTypes.includes(a.node.type)) return null;
  const z = zoneOfType(a.node.type);
  const holder = z && a.node.type === z.input ? pairedOutput(a.tree, a.node) : a.node;
  return holder ? { tree: a.tree, holder } : null;
}

const BAKE_LIST: ItemList = { key: 'bake_items', prefix: 'Item_', label: 'Bake Items', extend: [] };

function itemOps(prefix: string, label: string, list: ItemList, nodeTypes: string[], activeKey: string): Operator[] {
  const poll = (ctx: OpContext) => !!holderFor(ctx, nodeTypes);
  const done = () => app.changed('doc');
  return [
    {
      idname: `node.${prefix}_item_add`,
      label: `Add ${label} Item`,
      description: `Add an item to the ${label.toLowerCase()} items of the active node`,
      props: [{ id: 'socket_type', label: 'Type', type: 'enum', default: list.key === 'generation_items' ? 'GEOMETRY' : 'FLOAT', items: ITEM_TYPES.filter(([t]) => accepts(list, t)) }],
      poll,
      exec: (ctx, p) => {
        const h = holderFor(ctx, nodeTypes)!;
        addItem(h.holder, list, String(p.socket_type) as SocketType, '');
        h.holder.props[activeKey] = readItems(h.holder, list.key).length - 1;
        done();
      },
    },
    {
      idname: `node.${prefix}_item_remove`,
      label: `Remove ${label} Item`,
      description: `Remove the active item from the ${label.toLowerCase()} items`,
      poll: (ctx) => {
        const h = holderFor(ctx, nodeTypes);
        return !!h && readItems(h.holder, list.key).length > 0;
      },
      exec: (ctx) => {
        const h = holderFor(ctx, nodeTypes)!;
        const items = readItems(h.holder, list.key);
        const i = Math.max(0, Math.min(items.length - 1, Number(h.holder.props[activeKey] ?? 0)));
        removeItem(h.tree, h.holder, list, items[i].id);
        h.holder.props[activeKey] = Math.max(0, i - 1);
        done();
      },
    },
    {
      idname: `node.${prefix}_item_move`,
      label: `Move ${label} Item`,
      description: `Move the active item up or down`,
      props: [
        {
          id: 'direction',
          label: 'Direction',
          type: 'enum',
          default: 'UP',
          items: [
            ['UP', 'Up'],
            ['DOWN', 'Down'],
          ],
        },
      ],
      poll: (ctx) => {
        const h = holderFor(ctx, nodeTypes);
        return !!h && readItems(h.holder, list.key).length > 1;
      },
      exec: (ctx, p) => {
        const h = holderFor(ctx, nodeTypes)!;
        const items = readItems(h.holder, list.key);
        const i = Math.max(0, Math.min(items.length - 1, Number(h.holder.props[activeKey] ?? 0)));
        const j = i + (p.direction === 'DOWN' ? 1 : -1);
        if (j < 0 || j >= items.length) return 'CANCELLED';
        [items[i], items[j]] = [items[j], items[i]];
        writeItems(h.holder, list.key, items);
        h.holder.props[activeKey] = j;
        done();
      },
    },
  ];
}

const zone = (id: string) => ZONES.find((z) => z.id === id)!;
const REPEAT_INPUT_TYPE = 'GeometryNodeRepeatInput';
const types = (id: string) => [zone(id).input, zone(id).output];
const list = (id: string, key: string) => zone(id).lists.find((l) => l.key === key)!;

/** Add a zone (its input node; the output follows) at the pointer in the node editor. */
function addZoneOp(idname: string, label: string, inputType: string): Operator {
  return {
    idname,
    label,
    description: `Add a ${label.replace(/^Add /, '').toLowerCase()}: an input and an output node with the zone between them`,
    undo: false,
    poll: (ctx) => {
      const ed = nodeEditorOf(ctx);
      return !!ed?.tree() && ed.tree()!.type === 'GEOMETRY';
    },
    invoke: (ctx) => {
      nodeEditorOf(ctx)!.addNodeInteractive(inputType, {});
      return 'RUNNING_MODAL';
    },
    exec: (ctx) => {
      nodeEditorOf(ctx)!.addNodeInteractive(inputType, {});
      return 'RUNNING_MODAL';
    },
  };
}

registerOperators([
  addZoneOp('node.add_repeat_zone', 'Add Repeat Zone', zone('REPEAT').input),
  addZoneOp('node.add_simulation_zone', 'Add Simulation Zone', zone('SIMULATION').input),
  addZoneOp('node.add_foreach_geometry_element_zone', 'Add For Each Geometry Element Zone', zone('FOREACH').input),
  addZoneOp('node.add_closure_zone', 'Add Closure Zone', zone('CLOSURE').input),
  {
    idname: 'node.add_zone',
    label: 'Add Zone',
    description: 'Add a zone: an input and an output node with the zone between them',
    undo: false,
    props: [
      { id: 'input_node_type', type: 'string', default: zone('REPEAT').input, hidden: true },
      { id: 'output_node_type', type: 'string', default: zone('REPEAT').output, hidden: true },
    ],
    poll: (ctx) => !!nodeEditorOf(ctx)?.tree(),
    invoke: (ctx, p) => {
      const z = ZONES.find((k) => k.input === p.input_node_type);
      if (!z) return 'CANCELLED';
      nodeEditorOf(ctx)!.addNodeInteractive(z.input, {});
      return 'RUNNING_MODAL';
    },
  },
  ...itemOps('repeat_zone', 'Repeat', list('REPEAT', 'repeat_items'), types('REPEAT'), 'active_index'),
  ...itemOps('simulation_zone', 'Simulation State', list('SIMULATION', 'state_items'), types('SIMULATION'), 'active_index'),
  ...itemOps('foreach_geometry_element_zone_input', 'Input', list('FOREACH', 'input_items'), types('FOREACH'), 'active_input_index'),
  ...itemOps('foreach_geometry_element_zone_main', 'Main', list('FOREACH', 'main_items'), types('FOREACH'), 'active_main_index'),
  ...itemOps('foreach_geometry_element_zone_generation', 'Generation', list('FOREACH', 'generation_items'), types('FOREACH'), 'active_generation_index'),
  ...itemOps('bake_node', 'Bake', BAKE_LIST, [BAKE], 'active_index'),
  ...itemOps('closure_input', 'Closure Input', list('CLOSURE', 'input_items'), types('CLOSURE'), 'active_input_index'),
  ...itemOps('closure_output', 'Closure Output', list('CLOSURE', 'output_items'), types('CLOSURE'), 'active_output_index'),
]);

// ---------------------------------------------------------------------------
// Swapping to a zone (Shift S): turn a selected zone into another kind, or wrap the selection

const KEYS: Record<string, string> = { REPEAT: 'repeat_items', SIMULATION: 'state_items', FOREACH: 'generation_items', CLOSURE: 'output_items' };

/** Items of a zone converted for another kind (same ids, so sockets keep matching). */
function convertedItems(from: NodeData, fromKind: string, toKind: string): Record<string, string | number> {
  const items = readItems(from, KEYS[fromKind]).map((it) => ({ ...it }));
  const kept = items;
  for (const it of kept) {
    if (toKind === 'SIMULATION') it.attribute_domain ??= 'POINT';
    if (toKind === 'FOREACH') it.domain ??= 'POINT';
  }
  const next = Math.max(Number(from.props.next_item_id ?? 0), ...items.map((i) => i.id + 1));
  return { [KEYS[toKind]]: JSON.stringify(kept), next_item_id: next };
}

function swapZone(tree: NodeTreeData, kind: (typeof ZONES)[number]): boolean {
  const sctx = ctxOf(app.doc, tree);
  const sel = tree.nodes.filter((n) => n.select && getNodeType(n.type)?.layout !== 'FRAME');
  const selOut = sel.find((n) => ZONES.some((z) => z.output === n.type));
  const zin = sel.find((n) => ZONES.some((z) => z.input === n.type)) ?? (selOut ? tree.nodes.find((n) => n.props.paired_output === selOut.id) : undefined);
  if (zin) {
    const from = zoneOfType(zin.type)!;
    const oldOut = pairedOutput(tree, zin);
    if (from === kind || !oldOut) return false;
    const settings = convertedItems(oldOut, from.id, kind.id);
    const tmp = makeNode(tree, kind.output, oldOut.location, settings);
    tree.nodes.push(tmp);
    const newIn = swapNode(sctx, zin, kind.input, { paired_output: tmp.id });
    tree.nodes = tree.nodes.filter((n) => n !== tmp);
    const newOut = swapNode(sctx, oldOut, kind.output, settings);
    if (!newIn || !newOut) return false;
    newIn.props.paired_output = newOut.id;
    return true;
  }
  if (!sel.length) return false;
  // wrap the selection: geometry entering it passes the zone input, geometry leaving it the output
  const ids = new Set(sel.map((n) => n.id));
  const x0 = Math.min(...sel.map((n) => n.location[0])),
    x1 = Math.max(...sel.map((n) => n.location[0] + (n.width ?? 140)));
  const y = sel.reduce((s, n) => s + n.location[1], 0) / sel.length;
  const out = makeNode(tree, kind.output, [x1 + 60, y]);
  const inp = makeNode(tree, kind.input, [x0 - 200, y], { paired_output: out.id });
  tree.nodes.push(inp, out);
  const isGeo = (n: NodeData, s: string, output: boolean) => findSocket(n, s, output, sctx)?.type === 'GEOMETRY';
  const g = kind.id === 'FOREACH' ? null : readItems(out, KEYS[kind.id]).find((i) => i.socket_type === 'GEOMETRY');
  const outItem = kind.id === 'FOREACH' ? readItems(out, 'generation_items').find((i) => i.socket_type === 'GEOMETRY') : g;
  const enter = tree.links.find((l) => ids.has(l.to_node) && !ids.has(l.from_node) && isGeo(nodeById(tree, l.from_node)!, l.from_socket, true));
  if (enter && (g || kind.id === 'FOREACH')) {
    const [inSock, outSock] = kind.id === 'FOREACH' ? ['Geometry', 'Element'] : [`Item_${g!.id}`, `Item_${g!.id}`];
    tree.links.push({ id: uid('link'), from_node: enter.from_node, from_socket: enter.from_socket, to_node: inp.id, to_socket: inSock });
    enter.from_node = inp.id;
    enter.from_socket = outSock;
  }
  const leave = tree.links.filter((l) => ids.has(l.from_node) && !ids.has(l.to_node) && isGeo(nodeById(tree, l.from_node)!, l.from_socket, true));
  if (leave.length && outItem) {
    const sid = kind.id === 'FOREACH' ? `Generation_${outItem.id}` : `Item_${outItem.id}`;
    const first = leave[0];
    tree.links.push({ id: uid('link'), from_node: first.from_node, from_socket: first.from_socket, to_node: out.id, to_socket: sid });
    for (const l of leave.filter((x) => x.from_node === first.from_node && x.from_socket === first.from_socket)) {
      l.from_node = out.id;
      l.from_socket = sid;
    }
  }
  inp.select = out.select = true;
  return true;
}

registerOperators([
  {
    idname: 'node.swap_zone',
    label: 'Swap Zone',
    description: 'Turn the selected zone into another kind of zone, or wrap the selected nodes in a new zone',
    props: [
      { id: 'input_node_type', label: 'Input Node Type', type: 'string', default: REPEAT_INPUT_TYPE, hidden: true },
      { id: 'output_node_type', label: 'Output Node Type', type: 'string', default: '', hidden: true },
    ],
    poll: (ctx) => !!nodeEditorOf(ctx)?.tree()?.nodes.some((n) => n.select),
    exec: (ctx, p) => {
      const kind = ZONES.find((z) => z.input === p.input_node_type);
      const tree = nodeEditorOf(ctx)?.tree();
      if (!kind || !tree) return 'CANCELLED';
      if (!swapZone(tree, kind)) return 'CANCELLED';
      app.changed('doc');
    },
  },
]);

onAppReady(() => {
  const prev = operators.get('node.swap_node');
  if (!prev?.exec) return;
  const exec = prev.exec;
  registerOperators([
    {
      ...prev,
      exec: (ctx, p) => {
        const kind = ZONES.find((z) => z.input === p.type);
        const tree = nodeEditorOf(ctx)?.tree();
        if (!kind || !tree) return exec(ctx, p);
        return swapZone(tree, kind) ? 'FINISHED' : 'CANCELLED';
      },
    },
  ]);
});
