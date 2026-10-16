// Adding and removing zone / bake items.
import type { NodeData, NodeTreeData } from '../../data/types';
import type { SocketType } from '../../nodes/types';
import { ITEM_TYPES, FIELD_ITEM_TYPES, nextItemId, readItems, uniqueItemName, writeItems, type ZoneItem } from './items';
import { zoneOfType, allListKeys, type ItemList } from './kinds';

function allKeys(n: NodeData): string[] {
  const z = zoneOfType(n.type);
  return z ? allListKeys(z) : ['bake_items'];
}

/** Which types a list accepts. */
export function accepts(list: ItemList, t: SocketType): boolean {
  if (!ITEM_TYPES.some(([v]) => v === t)) return false;
  if (list.fieldOnly) return FIELD_ITEM_TYPES.has(t);
  return true;
}

export function addItem(holder: NodeData, list: ItemList, t: SocketType, name: string): ZoneItem {
  const items = readItems(holder, list.key);
  const it: ZoneItem = {
    id: nextItemId(holder, allKeys(holder)),
    name: uniqueItemName(items, name || ITEM_TYPES.find(([v]) => v === t)?.[1] || 'Value'),
    socket_type: t,
  };
  if (list.key === 'state_items' || list.key === 'bake_items') it.attribute_domain = 'POINT';
  if (list.key === 'generation_items') it.domain = 'POINT';
  items.push(it);
  writeItems(holder, list.key, items);
  return it;
}

/** Remove an item and every link to its sockets (on the holder and its paired input). */
export function removeItem(tree: NodeTreeData, holder: NodeData, list: ItemList, id: number) {
  const items = readItems(holder, list.key).filter((i) => i.id !== id);
  writeItems(holder, list.key, items);
  const sid = `${list.prefix}${id}`;
  const nodes = new Set([holder.id, ...tree.nodes.filter((n) => n.props.paired_output === holder.id).map((n) => n.id)]);
  tree.links = tree.links.filter((l) => !((nodes.has(l.to_node) && l.to_socket === sid) || (nodes.has(l.from_node) && l.from_socket === sid)));
}
