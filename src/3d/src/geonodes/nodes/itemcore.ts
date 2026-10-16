// Dynamic item lists of nodes (logic; the sidebar list is in items.ts) (Format String inputs, Index Switch and Menu Switch items, Capture
// Attribute values, bundle and closure signatures, …): items are stored on the node as JSON,
// edited with a list in the sidebar (add, remove, reorder, rename, change type), managed by
// `node.<list>_item_add/remove/move` operators, and links dropped on the node's empty "item"
// socket turn into new items.
import type { Child } from '../../ui/h';
import { app, onAppReady, operators, registerOperators, type OpContext } from '../../app/app';
import { findSocket } from '../../nodes/registry';
import { ctxOf, nodeById } from '../../nodes/tree';
import { uid } from '../../data/defaults';
import type { NodeData, NodeTreeData } from '../../data/types';
import type { NodeDrawContext, SocketDef, TreeType } from '../../nodes/types';
import { readItems, writeItems, type NodeItem } from './itemdata';

export { readItems, writeItems, type NodeItem };

export const ITEM_SOCKET = '__item__';

export interface ItemListDef {
  /** node property holding the JSON list */
  prop: string;
  title: string;
  /** input / output socket identifiers of an item */
  inSocket?: (it: NodeItem) => string;
  outSocket?: (it: NodeItem) => string;
  /** item types offered in the sidebar ([value, label]) */
  types?: [string, string][];
  /** item key holding the type (default "type") */
  typeKey?: string;
  /** item type for a socket linked to the item socket (undefined: link refused) */
  typeFor?: (s: SocketDef) => string | undefined;
  /** default name of a new item */
  defaultName: (items: NodeItem[], s?: SocketDef) => string;
  /** whether items have editable names */
  named?: boolean;
  /** items cannot go below this count */
  min?: number;
  /** operator name part: `node.<ops>_item_add` etc. */
  ops?: string;
  /** label used by the operators ("Capture Attribute") */
  opLabel?: string;
  /** node property holding the active item index (default "active_index") */
  activeKey?: string;
  /** list fallback when the node has no stored list */
  read?: (n: NodeData) => NodeItem[];
  /** extra sidebar rows for the active item */
  extra?: (ctx: NodeDrawContext, it: NodeItem, update: (patch: Partial<NodeItem>) => void) => Child;
  /** initial fields of a new item */
  init?: (it: NodeItem) => void;
  /** new items without a name are named after their type */
  nameFromType?: boolean;
}

const typeKeyOf = (def: ItemListDef) => def.typeKey ?? 'type';
const activeKeyOf = (def: ItemListDef) => def.activeKey ?? 'active_index';

/** Unique item name within a list ("Value", "Value.001", …). */
export function uniqueName(items: NodeItem[], name: string): string {
  const names = new Set(items.map((i) => i.name));
  if (!names.has(name)) return name;
  for (let k = 1; ; k++) {
    const n = `${name}.${String(k).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

export function listItems(n: NodeData, def: ItemListDef): NodeItem[] {
  return def.read ? def.read(n) : readItems(n, def.prop);
}

export function addItem(n: NodeData, def: ItemListDef, current: NodeItem[], name?: string, type?: string): NodeItem {
  let id = 0;
  while (current.some((i) => i.id === id)) id++;
  const t = type ?? def.types?.[0][0];
  const base = name || (def.nameFromType && t ? def.types?.find(([v]) => v === t)?.[1] : undefined) || def.defaultName(current);
  const it: NodeItem = { id, name: def.named === false ? base : uniqueName(current, base) };
  if (t) (it as Record<string, unknown>)[typeKeyOf(def)] = t;
  def.init?.(it);
  writeItems(n, def.prop, [...current, it]);
  return it;
}

/** Remove an item of a node and the links of its sockets. */
export function removeItem(tree: NodeTreeData, n: NodeData, def: ItemListDef, id: number) {
  const items = listItems(n, def);
  const it = items.find((x) => x.id === id);
  if (!it) return;
  const inId = def.inSocket?.(it),
    outId = def.outSocket?.(it);
  tree.links = tree.links.filter((l) => !((inId && l.to_node === n.id && l.to_socket === inId) || (outId && l.from_node === n.id && l.from_socket === outId)));
  writeItems(
    n,
    def.prop,
    items.filter((x) => x.id !== id),
  );
}

export function activeIndex(n: NodeData, def: ItemListDef, items = listItems(n, def)): number {
  return Math.max(0, Math.min(items.length - 1, Number(n.props[activeKeyOf(def)] ?? 0) || 0));
}

/** Move the active item one place up (-1) or down (+1). Returns whether it moved. */
export function moveActiveItem(n: NodeData, def: ItemListDef, d: number): boolean {
  const items = listItems(n, def);
  const i = activeIndex(n, def, items);
  const j = i + d;
  if (j < 0 || j >= items.length) return false;
  [items[i], items[j]] = [items[j], items[i]];
  writeItems(n, def.prop, items);
  n.props[activeKeyOf(def)] = j;
  return true;
}

const itemNodes = new Map<string, { def: ItemListDef; items: (n: NodeData) => NodeItem[] }[]>();

/** Registered item lists by node type (several lists per node are keyed by property). */
const listsByType = new Map<string, ItemListDef[]>();

/** Item lists of a node type. */
export const itemListsOf = (type: string): ItemListDef[] => listsByType.get(type) ?? [];

/** Register a node type whose item socket creates items when linked. */
export function registerItemNode(idname: string, def: ItemListDef, items: (n: NodeData) => NodeItem[], linkable = true) {
  if (linkable) itemNodes.set(idname, [...(itemNodes.get(idname) ?? []), { def, items }]);
  const lists = listsByType.get(idname) ?? [];
  if (!lists.includes(def)) listsByType.set(idname, [...lists, def]);
  if (!def.read) def.read = items;
  if (def.ops) registerItemOperators(def, [idname]);
}

// ---------------------------------------------------------------------------
// Operators: node.<ops>_item_add / _item_remove / _item_move on the active node

/** Tree and active node of the node editor an operator runs in. */
function activeNodeOf(ctx: OpContext): { tree: NodeTreeData; node: NodeData } | null {
  const ed = ctx.area?.editor as { tree?: () => NodeTreeData | null } | undefined;
  const tree = typeof ed?.tree === 'function' ? ed.tree() : null;
  if (!tree?.active_node) return null;
  const node = nodeById(tree, tree.active_node);
  return node ? { tree, node } : null;
}

/** Node types (any tree) for which a list's operators apply; the holder may differ (zone pairs). */
export interface ItemOpTarget {
  types: string[];
  /** node holding the items for the active node (default: the active node) */
  holder?: (tree: NodeTreeData, active: NodeData) => NodeData | undefined;
  treeTypes?: TreeType[];
}

/** Register add / remove / move operators for an item list. */
export function registerItemOperators(def: ItemListDef, types: string[], target: Omit<ItemOpTarget, 'types'> = {}) {
  if (!def.ops || operators.has(`node.${def.ops}_item_add`)) return;
  const label = def.opLabel ?? def.title;
  const find = (ctx: OpContext) => {
    const a = activeNodeOf(ctx);
    if (!a || !types.includes(a.node.type)) return null;
    if (target.treeTypes && !target.treeTypes.includes(a.tree.type)) return null;
    const holder = target.holder ? target.holder(a.tree, a.node) : a.node;
    return holder ? { tree: a.tree, holder } : null;
  };
  const typeProp = def.types ? [{ id: 'item_type', label: 'Type', type: 'enum' as const, default: def.types[0][0], items: def.types }] : [];
  registerOperators([
    {
      idname: `node.${def.ops}_item_add`,
      label: `Add ${label} Item`,
      description: `Add an item to the ${def.title.toLowerCase()} of the active node`,
      props: [...typeProp, { id: 'name', label: 'Name', type: 'string', default: '', hidden: def.named === false }],
      poll: (ctx) => !!find(ctx),
      exec: (ctx, p) => {
        const f = find(ctx)!;
        const items = listItems(f.holder, def);
        addItem(f.holder, def, items, String(p.name ?? '') || undefined, def.types ? String(p.item_type ?? def.types[0][0]) : undefined);
        f.holder.props[activeKeyOf(def)] = items.length;
        app.changed('doc');
      },
    },
    {
      idname: `node.${def.ops}_item_remove`,
      label: `Remove ${label} Item`,
      description: `Remove the active item of the ${def.title.toLowerCase()}`,
      poll: (ctx) => {
        const f = find(ctx);
        return !!f && listItems(f.holder, def).length > (def.min ?? 0);
      },
      exec: (ctx) => {
        const f = find(ctx)!;
        const items = listItems(f.holder, def);
        const i = activeIndex(f.holder, def, items);
        removeItem(f.tree, f.holder, def, items[i].id);
        f.holder.props[activeKeyOf(def)] = Math.max(0, i - 1);
        app.changed('doc');
      },
    },
    {
      idname: `node.${def.ops}_item_move`,
      label: `Move ${label} Item`,
      description: 'Move the active item up or down in the list',
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
        const f = find(ctx);
        return !!f && listItems(f.holder, def).length > 1;
      },
      exec: (ctx, p) => {
        const f = find(ctx)!;
        if (!moveActiveItem(f.holder, def, p.direction === 'DOWN' ? 1 : -1)) return 'CANCELLED';
        app.changed('doc');
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Links to the item socket become new items

/** Turn links made to or from the item socket into new items. Returns whether anything changed. */
export function resolveItemLinks(doc = app.doc): boolean {
  let any = false;
  for (const g of Object.values(doc.node_groups)) {
    const tree = g.tree;
    for (const l of [...tree.links]) {
      const toItem = l.to_socket === ITEM_SOCKET,
        fromItem = l.from_socket === ITEM_SOCKET;
      if (!toItem && !fromItem) continue;
      const node = nodeById(tree, toItem ? l.to_node : l.from_node);
      const reg = node ? itemNodes.get(node.type)?.find((r) => (toItem ? r.def.inSocket : r.def.outSocket)) : undefined;
      if (!node || !reg) continue;
      const other = nodeById(tree, toItem ? l.from_node : l.to_node);
      tree.links = tree.links.filter((x) => x !== l);
      any = true;
      if (!other) continue;
      const s = findSocket(other, toItem ? l.from_socket : l.to_socket, toItem, ctxOf(doc, tree));
      if (!s || s.type === 'CUSTOM') continue;
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
