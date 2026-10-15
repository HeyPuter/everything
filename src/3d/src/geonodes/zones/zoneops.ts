// Operators for zones: adding a zone (both nodes, linked) and managing zone / bake items on the
// active node (add, remove, move), usable from search and scripts.
import { app, registerOperators, type OpContext, type Operator } from '../../app/app';
import { nodeEditorOf } from '../../nodes/editor/ops';
import { nodeById } from '../../nodes/tree';
import type { NodeData, NodeTreeData } from '../../data/types';
import type { SocketType } from '../../nodes/types';
import { readItems, writeItems, pairedOutput } from './items';
import { ZONES, BAKE, zoneOfType, type ItemList } from './kinds';
import { addItem, removeItem } from './itemops';

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

const ITEM_TYPE_ITEMS: [string, string][] = [
  ['FLOAT', 'Float'],
  ['INT', 'Integer'],
  ['BOOLEAN', 'Boolean'],
  ['VECTOR', 'Vector'],
  ['RGBA', 'Color'],
  ['ROTATION', 'Rotation'],
  ['STRING', 'String'],
  ['GEOMETRY', 'Geometry'],
];

function itemOps(prefix: string, label: string, list: ItemList, nodeTypes: string[], activeKey: string): Operator[] {
  const poll = (ctx: OpContext) => !!holderFor(ctx, nodeTypes);
  const done = () => app.changed('doc');
  return [
    {
      idname: `node.${prefix}_item_add`,
      label: `Add ${label} Item`,
      description: `Add an item to the ${label.toLowerCase()} items of the active node`,
      props: [{ id: 'socket_type', label: 'Type', type: 'enum', default: list.key === 'generation_items' ? 'GEOMETRY' : 'FLOAT', items: ITEM_TYPE_ITEMS }],
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
]);
