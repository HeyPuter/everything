// Index Switch, Menu Switch, the Menu input and the Warning node.
import './fdata';
import { gn, sprop, idSocketBody } from './defs';
import { h } from '../../ui/h';
import { enumMenu } from '../../ui/widgets';
import { fnField, Field, constOf, type Evaluated } from '../field';
import { fieldComps, type FieldType } from '../types';
import { valueSocket } from './geometry';
import { readItems, itemListUI, registerItemNode, itemSocket, type ItemListDef, type NodeItem } from './items';
import { allSockets, getNodeType } from '../../nodes/registry';
import { ctxOf } from '../../nodes/tree';
import { app } from '../../app/app';
import type { DocumentData, NodeData, NodeTreeData } from '../../data/types';
import type { NodeDrawContext, SocketDef, SocketType } from '../../nodes/types';
import type { Val } from '../exec';

const FIELDABLE = new Set(['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'ROTATION', 'MATRIX']);
const SWITCH_TYPES = ['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'ROTATION', 'MATRIX', 'STRING', 'OBJECT', 'IMAGE', 'GEOMETRY', 'COLLECTION', 'MATERIAL'];

/** Socket of a switch item of type `t`. */
function itemSocketOf(id: string, t: SocketType, name: string, field: boolean): SocketDef {
  if (field) return { ...valueSocket(id, t as FieldType, name), shape: 'DIAMOND_DOT' };
  const s: SocketDef = { name, identifier: id, type: t };
  if (t === 'STRING') s.default = '';
  if (t === 'OBJECT' || t === 'COLLECTION' || t === 'MATERIAL' || t === 'IMAGE') s.hide_value = true;
  return s;
}

const ID_ITEM_TYPES = new Set(['OBJECT', 'COLLECTION', 'MATERIAL']);

/** Data-block selectors for the item inputs of a switch whose items are objects, collections or materials. */
function idItemsBody(ids: (n: NodeData) => [string, string][]) {
  return {
    drawBody: (ctx: NodeDrawContext) => {
      const t = sprop(ctx.node, 'data_type');
      if (!ID_ITEM_TYPES.has(t)) return null;
      const names = ids(ctx.node);
      return idSocketBody(
        ctx,
        names.map(([id, name]) => ({ name, identifier: id, type: t as SocketType })),
      );
    },
    bodyHeight: (n: NodeData) => (ID_ITEM_TYPES.has(sprop(n, 'data_type')) ? 24 * ids(n).length + 2 : 0),
  };
}

/** Per-element choice between field values by an integer selector. */
function choiceField(t: FieldType, selector: Field, options: Field[], pick: (sel: number) => number): Field {
  const c = fieldComps(t);
  return fnField(t, [selector, ...options], ([s, ...opts]: Evaluated[], out, n) => {
    for (let i = 0; i < n; i++) {
      const k = pick(s.data[s.single ? 0 : i]);
      const o = opts[k];
      if (!o) continue;
      const j = o.single ? 0 : i;
      for (let q = 0; q < c; q++) out[i * c + q] = o.data[j * c + q];
    }
  });
}

// ---------------------------------------------------------------------------
// Index Switch

const indexItems = (n: NodeData) =>
  readItems(n, 'index_switch_items', [
    { id: 0, name: '0' },
    { id: 1, name: '1' },
  ]);
const indexIn = (it: NodeItem) => `Item_${it.id}`;
const INDEX_DEF: ItemListDef = { prop: 'index_switch_items', title: 'Items', inSocket: indexIn, named: false, defaultName: (items) => String(items.length), min: 1 };
registerItemNode('GeometryNodeIndexSwitch', INDEX_DEF, indexItems);

gn(
  'GeometryNodeIndexSwitch',
  'converter',
  {
    exec: (ctx) => {
      const t = (sprop(ctx.node, 'data_type') || 'FLOAT') as SocketType;
      const items = indexItems(ctx.node);
      const idx = ctx.input('Index');
      if (idx instanceof Field && constOf(idx) === undefined) {
        if (!FIELDABLE.has(t)) {
          ctx.warn('A field cannot pick between values of this type');
          return { Output: undefined };
        }
        const ft = t as FieldType;
        return {
          Output: choiceField(
            ft,
            idx,
            items.map((it) => ctx.field(indexIn(it), ft)),
            (k) => (k >= 0 && k < items.length ? k : -1),
          ),
        };
      }
      const k = Math.round(Number(idx instanceof Field ? constOf(idx) : idx) || 0);
      const it = items[k];
      return { Output: it ? (ctx.input(indexIn(it)) as Val) : undefined };
    },
  },
  {
    items: { data_type: SWITCH_TYPES },
    propPatch: { data_type: { noLabel: true } },
    dynamicSockets: (node) => {
      const t = (sprop(node, 'data_type') || 'FLOAT') as SocketType;
      const field = FIELDABLE.has(t);
      return {
        inputs: [
          { name: 'Index', identifier: 'Index', type: 'INT', default: 0, ...(field ? { shape: 'DIAMOND_DOT' as const } : {}) },
          ...indexItems(node).map((it, i) => itemSocketOf(indexIn(it), t, String(i), field)),
          itemSocket(),
        ],
        outputs: [{ ...itemSocketOf('Output', t, 'Output', field) }],
      };
    },
    drawOptions: (ctx) => itemListUI(ctx, INDEX_DEF, indexItems(ctx.node)),
    ...idItemsBody((n) => indexItems(n).map((it, i) => [indexIn(it), String(i)])),
  },
);

// ---------------------------------------------------------------------------
// Menu Switch

export const menuItems = (n: NodeData) =>
  readItems(n, 'enum_items', [
    { id: 0, name: 'A' },
    { id: 1, name: 'B' },
  ]);
const menuIn = (it: NodeItem) => `Item_${it.id}`;
const MENU_DEF: ItemListDef = {
  prop: 'enum_items',
  title: 'Menu Items',
  inSocket: menuIn,
  defaultName: (items) => {
    const names = new Set(items.map((i) => i.name));
    for (let k = 0; ; k++) {
      const nm = k < 26 ? String.fromCharCode(65 + k) : `Item ${k}`;
      if (!names.has(nm)) return nm;
    }
  },
  min: 1,
};
registerItemNode('GeometryNodeMenuSwitch', MENU_DEF, menuItems);

gn(
  'GeometryNodeMenuSwitch',
  'converter',
  {
    exec: (ctx) => {
      const t = (sprop(ctx.node, 'data_type') || 'GEOMETRY') as SocketType;
      const items = menuItems(ctx.node);
      const v = ctx.input('Menu');
      const name = typeof v === 'string' ? v : (items[0]?.name ?? '');
      const it = items.find((i) => i.name === name);
      const out: Record<string, Val> = { Output: it ? (ctx.input(menuIn(it)) as Val) : undefined };
      for (const x of items) out[menuIn(x)] = x === it;
      return out;
    },
  },
  {
    items: { data_type: SWITCH_TYPES },
    propPatch: { data_type: { noLabel: true } },
    dynamicSockets: (node) => {
      const t = (sprop(node, 'data_type') || 'GEOMETRY') as SocketType;
      const field = FIELDABLE.has(t);
      const items = menuItems(node);
      return {
        inputs: [
          { name: 'Menu', identifier: 'Menu', type: 'MENU', default: items[0]?.name ?? '', items: items.map((i) => i.name) },
          ...items.map((it) => itemSocketOf(menuIn(it), t, it.name, field)),
          itemSocket(),
        ],
        outputs: [itemSocketOf('Output', t, 'Output', field), ...items.map((it): SocketDef => ({ name: it.name, identifier: menuIn(it), type: 'BOOLEAN', default: false }))],
      };
    },
    drawOptions: (ctx) => itemListUI(ctx, MENU_DEF, menuItems(ctx.node)),
    ...idItemsBody((n) => menuItems(n).map((it) => [menuIn(it), it.name])),
  },
);

/**
 * Menu items reachable from an output socket: the items of the first menu input it is linked to,
 * following group inputs into nested groups.
 */
export function linkedMenuItems(doc: DocumentData, tree: NodeTreeData, nodeId: string, socket: string, depth = 0): string[] {
  if (depth > 16) return [];
  const ctx = ctxOf(doc, tree);
  for (const l of tree.links) {
    if (l.from_node !== nodeId || l.from_socket !== socket) continue;
    const to = tree.nodes.find((n) => n.id === l.to_node);
    if (!to) continue;
    if (to.type === 'NodeReroute') {
      const r = linkedMenuItems(doc, tree, to.id, 'Output', depth + 1);
      if (r.length) return r;
      continue;
    }
    const s = allSockets(to, ctx).inputs.find((x) => x.identifier === l.to_socket);
    if (s?.type === 'MENU' && s.items?.length) return s.items;
    if (to.type === 'GeometryNodeGroup' && typeof to.props.node_tree === 'string') {
      const g = doc.node_groups[to.props.node_tree];
      const r = g ? groupInputMenuItems(doc, g.tree, l.to_socket, depth + 1) : [];
      if (r.length) return r;
    }
  }
  return [];
}

/** Menu items of a group's menu input (from the menus it is linked to inside the group). */
export function groupInputMenuItems(doc: DocumentData, tree: NodeTreeData, identifier: string, depth = 0): string[] {
  for (const gi of tree.nodes.filter((n) => n.type === 'NodeGroupInput')) {
    const r = linkedMenuItems(doc, tree, gi.id, identifier, depth);
    if (r.length) return r;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Menu input

gn(
  'FunctionNodeInputMenu',
  'input',
  {
    exec: (ctx) => ({ Menu: String(ctx.node.props.value ?? '') }),
  },
  {
    drop: ['value'],
    drawBody: (ctx) => {
      const items = app ? linkedMenuItems(app.doc, ctx.tree, ctx.node.id, 'Menu') : [];
      const cur = String(ctx.node.props.value ?? '');
      if (items.length && !items.includes(cur)) ctx.node.props.value = items[0];
      return h(
        'div',
        { class: 'gn-id-rows' },
        enumMenu(
          `${ctx.key}:menu`,
          items.map((v) => ({ value: v, label: v })),
          items.includes(cur) ? cur : (items[0] ?? ''),
          (v) => {
            ctx.node.props.value = v;
            ctx.changed('Set Menu', true);
          },
          { title: 'Menu', disabled: !items.length, tip: items.length ? 'Menu' : 'Link to a menu input to choose an item' },
        ),
      );
    },
    bodyHeight: () => 26,
  },
);

// ---------------------------------------------------------------------------
// Warning

gn(
  'GeometryNodeWarning',
  'output',
  {
    exec: (ctx) => {
      const show = ctx.bool('Show');
      const msg = ctx.string('Message');
      if (show && msg) ctx.warn(msg);
      return { Show: show };
    },
  },
  { propPatch: { warning_type: { noLabel: true } } },
);

// group nodes: menu inputs list the items of the menus they feed inside the group
{
  const grp = getNodeType('GeometryNodeGroup');
  const prev = grp?.dynamicSockets;
  if (grp && prev)
    grp.dynamicSockets = (node, ctx) => {
      const r = prev(node, ctx);
      const g = typeof node.props.node_tree === 'string' ? ctx.doc.node_groups[node.props.node_tree] : undefined;
      if (!g || !r.inputs.some((s) => s.type === 'MENU')) return r;
      return {
        ...r,
        inputs: r.inputs.map((s) => {
          if (s.type !== 'MENU' || s.items?.length) return s;
          const items = groupInputMenuItems(ctx.doc, g.tree, s.identifier);
          return items.length ? { ...s, items, default: typeof s.default === 'string' && items.includes(s.default) ? s.default : items[0] } : s;
        }),
      };
    };
}
