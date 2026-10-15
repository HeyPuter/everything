// Dynamic item lists of geometry nodes (Format String inputs, Index Switch and Menu Switch
// items): items are stored on the node as JSON, edited in the sidebar, and links dropped on the
// node's empty "item" socket turn into new items.
import { h, type Child } from '../../ui/h';
import { button, enumMenu, textField } from '../../ui/widgets';
import { icon } from '../../ui/icons';
import { app, onAppReady } from '../../app/app';
import { findSocket } from '../../nodes/registry';
import { ctxOf, nodeById } from '../../nodes/tree';
import { uid } from '../../data/defaults';
import type { NodeData } from '../../data/types';
import type { NodeDrawContext, SocketDef } from '../../nodes/types';

export const ITEM_SOCKET = '__item__';

export interface NodeItem {
  id: number;
  name: string;
  /** socket type of the item (Format String) */
  type?: string;
}

export interface ItemListDef {
  /** node property holding the JSON list */
  prop: string;
  title: string;
  /** input / output socket identifiers of an item */
  inSocket?: (it: NodeItem) => string;
  outSocket?: (it: NodeItem) => string;
  /** item types offered in the sidebar ([value, label]) */
  types?: [string, string][];
  /** item type for a socket linked to the item socket (undefined: link refused) */
  typeFor?: (s: SocketDef) => string | undefined;
  /** default name of a new item */
  defaultName: (items: NodeItem[], s?: SocketDef) => string;
  /** whether items have editable names */
  named?: boolean;
  /** items cannot go below this count */
  min?: number;
}

export function readItems(n: NodeData, prop: string, fallback: NodeItem[] = []): NodeItem[] {
  const raw = n.props[prop];
  if (raw === undefined || raw === null) return fallback;
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function writeItems(n: NodeData, prop: string, items: NodeItem[]) {
  n.props[prop] = JSON.stringify(items);
}

export function addItem(n: NodeData, def: ItemListDef, current: NodeItem[], name?: string, type?: string): NodeItem {
  let id = 0;
  while (current.some((i) => i.id === id)) id++;
  const it: NodeItem = { id, name: name || def.defaultName(current), ...(type ? { type } : {}) };
  writeItems(n, def.prop, [...current, it]);
  return it;
}

/** Sidebar list editor for the items of a node. */
export function itemListUI(ctx: NodeDrawContext, def: ItemListDef, items: NodeItem[]): Child {
  const set = (list: NodeItem[], label: string) => {
    writeItems(ctx.node, def.prop, list);
    ctx.changed(label, true);
  };
  const unlink = (it: NodeItem) => {
    ctx.tree.links = ctx.tree.links.filter(
      (l) => !((def.inSocket && l.to_node === ctx.node.id && l.to_socket === def.inSocket(it)) || (def.outSocket && l.from_node === ctx.node.id && l.from_socket === def.outSocket(it))),
    );
  };
  return h(
    'div',
    { class: 'gn-items' },
    h('div', { class: 'sub-label' }, def.title),
    items.map((it, i) =>
      h(
        'div',
        { key: String(it.id), class: 'gn-item-row' },
        def.named === false
          ? h('span', { class: 'nd-label' }, String(i))
          : textField(`${ctx.key}:it-name:${it.id}`, it.name, (v) =>
              set(
                items.map((x) => (x === it ? { ...x, name: v || x.name } : x)),
                'Rename Item',
              ),
            ),
        def.types
          ? enumMenu(
              `${ctx.key}:it-type:${it.id}`,
              def.types.map(([value, label]) => ({ value, label })),
              it.type ?? def.types[0][0],
              (v) =>
                set(
                  items.map((x) => (x === it ? { ...x, type: v } : x)),
                  'Change Item Type',
                ),
            )
          : null,
        button(
          `${ctx.key}:it-up:${it.id}`,
          icon('triangle_up'),
          () => {
            if (i === 0) return;
            const l = [...items];
            [l[i - 1], l[i]] = [l[i], l[i - 1]];
            set(l, 'Move Item');
          },
          { tip: 'Move item up', disabled: i === 0 },
        ),
        button(
          `${ctx.key}:it-del:${it.id}`,
          icon('remove'),
          () => {
            unlink(it);
            set(
              items.filter((_, k) => k !== i),
              'Remove Item',
            );
          },
          { tip: 'Remove item', disabled: items.length <= (def.min ?? 0) },
        ),
      ),
    ),
    button(`${ctx.key}:it-add`, [icon('add'), 'Add Item'], () => {
      addItem(ctx.node, def, items, undefined, def.types?.[0][0]);
      ctx.changed('Add Item', true);
    }),
  );
}

const itemNodes = new Map<string, { def: ItemListDef; items: (n: NodeData) => NodeItem[] }>();

/** Register a node type whose item socket creates items when linked. */
export function registerItemNode(idname: string, def: ItemListDef, items: (n: NodeData) => NodeItem[]) {
  itemNodes.set(idname, { def, items });
}

/** Turn links made to or from the item socket into new items. Returns whether anything changed. */
export function resolveItemLinks(doc = app.doc): boolean {
  let any = false;
  for (const g of Object.values(doc.node_groups)) {
    const tree = g.tree;
    if (tree.type !== 'GEOMETRY') continue;
    for (const l of [...tree.links]) {
      const toItem = l.to_socket === ITEM_SOCKET,
        fromItem = l.from_socket === ITEM_SOCKET;
      if (!toItem && !fromItem) continue;
      const node = nodeById(tree, toItem ? l.to_node : l.from_node);
      const reg = node ? itemNodes.get(node.type) : undefined;
      if (!node || !reg) continue;
      const other = nodeById(tree, toItem ? l.from_node : l.to_node);
      tree.links = tree.links.filter((x) => x !== l);
      any = true;
      if (!other) continue;
      const s = findSocket(other, toItem ? l.from_socket : l.to_socket, toItem, ctxOf(doc, tree));
      if (!s) continue;
      const type = reg.def.typeFor ? reg.def.typeFor(s) : undefined;
      if (reg.def.typeFor && !type) continue;
      const cur = reg.items(node);
      const it = addItem(node, reg.def, cur, reg.def.named === false ? String(cur.length) : s.name || reg.def.defaultName(cur, s), type);
      if (toItem && reg.def.inSocket) tree.links.push({ ...l, id: uid('link'), to_socket: reg.def.inSocket(it) });
      if (fromItem && reg.def.outSocket) tree.links.push({ ...l, id: uid('link'), from_socket: reg.def.outSocket(it) });
    }
  }
  return any;
}

onAppReady((a) => {
  a.subscribe((kinds) => {
    if (kinds.has('doc') && itemNodes.size && resolveItemLinks(a.doc)) a.changed('doc');
  });
});

/** The empty socket that accepts links to create items. */
export const itemSocket = (): SocketDef => ({ name: '', identifier: ITEM_SOCKET, type: 'CUSTOM', hide_value: true });
