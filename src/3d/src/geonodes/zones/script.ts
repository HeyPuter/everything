// Scripting access to zone and bake items: `node.repeat_items.new('FLOAT', "Value")`,
// `state_items`, `input_items` / `main_items` / `generation_items`, `bake_items`, and
// `zone_input.pair_with_output(zone_output)`.
import type { NodeData, NodeTreeData } from '../../data/types';
import type { SocketType } from '../../nodes/types';
import { PropCollection, kwMethod, pyError, touched } from '../../scripting/rna';
import { ITEM_TYPES, readItems, writeItems, uniqueItemName, type ZoneItem } from './items';
import { ZONES, BAKE, type ItemList } from './kinds';
import { accepts, addItem, removeItem } from './itemops';

const BAKE_LIST: ItemList = { key: 'bake_items', prefix: 'Item_', label: 'Bake Items', extend: [] };

/** The item list a node type holds under `key` (output nodes and Bake nodes hold items). */
function listFor(type: string, key: string): ItemList | undefined {
  if (type === BAKE) return key === 'bake_items' ? BAKE_LIST : undefined;
  return ZONES.find((z) => z.output === type)?.lists.find((l) => l.key === key);
}

const ITEM_STRUCT: Record<string, string> = {
  repeat_items: 'RepeatItem',
  state_items: 'SimulationStateItem',
  input_items: 'ForeachGeometryElementInputItem',
  main_items: 'ForeachGeometryElementMainItem',
  generation_items: 'ForeachGeometryElementGenerationItem',
  bake_items: 'BakeItem',
};

class ZoneItems extends PropCollection<unknown> {
  constructor(
    private tree: () => NodeTreeData,
    private node: () => NodeData,
    private itemList: ItemList,
    path: string,
  ) {
    super(path);
  }
  private all(): ZoneItem[] {
    return readItems(this.node(), this.itemList.key);
  }
  private write(items: ZoneItem[]) {
    writeItems(this.node(), this.itemList.key, items);
    touched();
  }
  list() {
    return this.all().map((it) => this.struct(it.id));
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  private struct(id: number) {
    const self = this;
    const cur = () => {
      const it = self.all().find((x) => x.id === id);
      if (!it) throw pyError('ReferenceError', 'the item has been removed');
      return it;
    };
    const update = (patch: Partial<ZoneItem>) => self.write(self.all().map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const s = {
      __kind: 'struct',
      __type: ITEM_STRUCT[self.itemList.key] ?? 'NodeItem',
      __itemId: id,
      get name() {
        return cur().name;
      },
      set name(v: string) {
        const others = self.all().filter((x) => x.id !== id);
        update({ name: uniqueItemName(others, String(v)) });
      },
      get socket_type() {
        return cur().socket_type;
      },
      set socket_type(v: string) {
        const t = String(v) as SocketType;
        if (!ITEM_TYPES.some(([x]) => x === t) || !accepts(self.itemList, t)) throw pyError('TypeError', `bpy_struct: item.socket_type = '${v}' is not a supported type here`);
        update({ socket_type: t });
      },
      toString: () => `<bpy_struct, ${ITEM_STRUCT[self.itemList.key] ?? 'NodeItem'}("${cur().name}")>`,
    };
    if (self.itemList.key === 'state_items' || self.itemList.key === 'bake_items')
      Object.defineProperty(s, 'attribute_domain', {
        get: () => cur().attribute_domain ?? 'POINT',
        set: (v: string) => update({ attribute_domain: String(v) }),
        enumerable: true,
      });
    if (self.itemList.key === 'generation_items')
      Object.defineProperty(s, 'domain', {
        get: () => cur().domain ?? 'POINT',
        set: (v: string) => update({ domain: String(v) }),
        enumerable: true,
      });
    return s;
  }
  new(socket_type: string, name: string) {
    const t = String(socket_type) as SocketType;
    if (!ITEM_TYPES.some(([x]) => x === t) || !accepts(this.itemList, t)) throw pyError('TypeError', `${this.__path}.new(): socket type '${socket_type}' is not supported here`);
    const it = addItem(this.node(), this.itemList, t, String(name ?? ''));
    touched();
    return this.struct(it.id);
  }
  remove(item: unknown) {
    const id = (item as { __itemId?: number })?.__itemId;
    if (typeof id !== 'number' || !this.all().some((x) => x.id === id)) throw pyError('ValueError', `${this.__path}.remove(): item not found`);
    removeItem(this.tree(), this.node(), this.itemList, id);
    touched();
  }
  clear() {
    for (const it of this.all()) removeItem(this.tree(), this.node(), this.itemList, it.id);
    touched();
  }
  move(from_index: number, to_index: number) {
    const items = this.all();
    const a = Number(from_index),
      b = Number(to_index);
    if (!(a >= 0 && a < items.length && b >= 0 && b < items.length)) throw pyError('IndexError', `${this.__path}.move(): index out of range`);
    const [it] = items.splice(a, 1);
    items.splice(b, 0, it);
    this.write(items);
  }
}
kwMethod(ZoneItems.prototype, 'new', ['socket_type', 'name']);
kwMethod(ZoneItems.prototype, 'move', ['from_index', 'to_index']);

/** The item collection of a node under `key`, or undefined when the node has no such items. */
export function zoneItemsFor(getTree: () => NodeTreeData | null | undefined, nid: string, key: string, path: string): unknown {
  const tree = getTree();
  const node = tree?.nodes.find((n) => n.id === nid);
  if (!tree || !node) return undefined;
  const list = listFor(node.type, key);
  if (!list) return undefined;
  const t = () => {
    const x = getTree();
    if (!x) throw pyError('ReferenceError', 'node tree has been removed');
    return x;
  };
  const n = () => {
    const x = t().nodes.find((y) => y.id === nid);
    if (!x) throw pyError('ReferenceError', 'node has been removed');
    return x;
  };
  return new ZoneItems(t, n, list, path);
}

/** `zone_input.pair_with_output(zone_output)`: whether the two nodes now form a zone. */
export function pairWithOutput(getTree: () => NodeTreeData | null | undefined, nid: string, other: unknown): boolean {
  const tree = getTree();
  const node = tree?.nodes.find((n) => n.id === nid);
  const oid = (other as { __nid?: string })?.__nid;
  const out = tree?.nodes.find((n) => n.id === oid);
  if (!node || !out) return false;
  const z = ZONES.find((k) => k.input === node.type);
  if (!z || z.output !== out.type) return false;
  node.props.paired_output = out.id;
  touched();
  return true;
}

/** Item collection names exposed on nodes. */
export const ZONE_ITEM_KEYS = Object.keys(ITEM_STRUCT);
