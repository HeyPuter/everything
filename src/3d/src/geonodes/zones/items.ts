// Zone and bake items: the dynamic sockets of Repeat, Simulation, For Each Element zones and the
// Bake node. Items live on the zone's output node (or the Bake node) as JSON in `props[key]`
// ([{ id, name, socket_type, ... }]); socket identifiers derive from the item id so links survive
// renames and reordering. Zone input nodes find their items through `props.paired_output`.
import type { NodeData, NodeTreeData, SocketValue } from '../../data/types';
import type { SocketDef, SocketType } from '../../nodes/types';
import { defaultForType } from '../../nodes/registry';

export interface ZoneItem {
  id: number;
  name: string;
  socket_type: SocketType;
  /** simulation / bake: domain field values are stored on */
  attribute_domain?: string;
  /** for-each generation items: domain of field values */
  domain?: string;
  /** bake items: store a field as attribute */
  is_attribute?: boolean;
}

/** Socket identifier of the "add item" socket on zone nodes. */
export const EXTEND = '__extend__';

/** Socket types an item can have, in menu order. */
export const ITEM_TYPES: [SocketType, string][] = [
  ['FLOAT', 'Float'],
  ['INT', 'Integer'],
  ['BOOLEAN', 'Boolean'],
  ['VECTOR', 'Vector'],
  ['RGBA', 'Color'],
  ['ROTATION', 'Rotation'],
  ['MATRIX', 'Matrix'],
  ['STRING', 'String'],
  ['OBJECT', 'Object'],
  ['COLLECTION', 'Collection'],
  ['MATERIAL', 'Material'],
  ['IMAGE', 'Image'],
  ['GEOMETRY', 'Geometry'],
];

export const FIELD_ITEM_TYPES = new Set<SocketType>(['FLOAT', 'INT', 'BOOLEAN', 'VECTOR', 'RGBA', 'ROTATION']);

export function readItems(n: NodeData | undefined, key: string): ZoneItem[] {
  if (!n) return [];
  const raw = n.props[key];
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as ZoneItem[]) : [];
  } catch {
    return [];
  }
}

export function writeItems(n: NodeData, key: string, items: ZoneItem[]) {
  n.props[key] = JSON.stringify(items);
}

/** Next unused item id of a node (ids are never reused, like socket identifiers). */
export function nextItemId(n: NodeData, keys: string[]): number {
  let id = typeof n.props.next_item_id === 'number' ? n.props.next_item_id : 0;
  for (const k of keys) for (const it of readItems(n, k)) id = Math.max(id, it.id + 1);
  n.props.next_item_id = id + 1;
  return id;
}

/** Unique item name within a list ("Value", "Value.001", …). */
export function uniqueItemName(items: ZoneItem[], base: string): string {
  const names = new Set(items.map((i) => i.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}

export function itemDefault(t: SocketType): SocketValue {
  if (t === 'RGBA') return [0, 0, 0, 1];
  return defaultForType(t);
}

/** Socket of an item. Field-capable items get a diamond-dot shape like other field sockets. */
export function itemSocket(it: ZoneItem, identifier: string, opts: Partial<SocketDef> = {}): SocketDef {
  const s: SocketDef = {
    name: it.name,
    identifier,
    type: it.socket_type,
    default: itemDefault(it.socket_type),
    ...opts,
  };
  if (FIELD_ITEM_TYPES.has(it.socket_type) && !s.shape) s.shape = 'DIAMOND_DOT';
  if (['OBJECT', 'COLLECTION', 'MATERIAL', 'IMAGE', 'GEOMETRY', 'MATRIX'].includes(it.socket_type)) s.hide_value = true;
  return s;
}

export const extendSocket = (identifier = EXTEND): SocketDef => ({
  name: '',
  identifier,
  type: 'CUSTOM',
  hide_value: true,
});

/** The output node a zone input node is paired with. */
export function pairedOutput(tree: NodeTreeData, input: NodeData): NodeData | undefined {
  const id = input.props.paired_output;
  return typeof id === 'string' ? tree.nodes.find((n) => n.id === id) : undefined;
}

/** The input node paired with a zone output node. */
export function pairedInput(tree: NodeTreeData, output: NodeData, inputType?: string): NodeData | undefined {
  return tree.nodes.find((n) => n.props.paired_output === output.id && (!inputType || n.type === inputType));
}
