// Scripting access to the item lists of nodes: Format String (`format_items.new('FLOAT', "x")`),
// Index Switch (`index_switch_items.new()`), Menu Switch (`enum_items.new("Name")`), Capture
// Attribute (`capture_items`), Viewer (`viewer_items`), bundles (`bundle_items`), Evaluate Closure
// (`input_items` / `output_items`) and lists (`list_items`). Lists are the ones registered with
// `registerItemNode`, so sockets, types and links follow the same rules as in the editor.
import type { NodeData, NodeTreeData } from '../../data/types';
import { PropCollection, kwMethod, pyError, touched } from '../../scripting/rna';
import { writeItems, type NodeItem } from './itemdata';
import { itemListsOf, listItems, removeItem, uniqueName, type ItemListDef } from './itemcore';

/** Struct names per list property (and node type where they differ). */
const STRUCTS: Record<string, string> = {
  format_items: 'NodeFunctionFormatStringItem',
  index_switch_items: 'IndexSwitchItem',
  enum_items: 'NodeEnumItem',
  capture_items: 'NodeGeometryCaptureAttributeItem',
  viewer_items: 'NodeGeometryViewerItem',
  bundle_items: 'NodeBundleItem',
  'NodeEvaluateClosure:input_items': 'NodeEvaluateClosureInputItem',
  'NodeEvaluateClosure:output_items': 'NodeEvaluateClosureOutputItem',
  list_items: 'NodeListItem',
};

class NodeItems extends PropCollection<unknown> {
  constructor(
    private tree: () => NodeTreeData,
    private node: () => NodeData,
    private def: ItemListDef,
    private struct_: string,
    path: string,
  ) {
    super(path);
  }
  private get typeKey() {
    return this.def.typeKey ?? 'type';
  }
  private get types(): string[] | undefined {
    return this.def.types?.map(([t]) => t);
  }
  private all() {
    return listItems(this.node(), this.def);
  }
  private write(items: NodeItem[]) {
    writeItems(this.node(), this.def.prop, items);
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
    const update = (patch: Partial<NodeItem>) => self.write(self.all().map((x) => (x.id === id ? { ...x, ...patch } : x)));
    const setType = (v: string) => {
      if (!self.types?.includes(String(v))) throw pyError('TypeError', `bpy_struct: item type '${v}' is not supported here`);
      update({ [self.typeKey]: String(v) } as Partial<NodeItem>);
    };
    return {
      __kind: 'struct',
      __type: self.struct_,
      __itemId: id,
      get name() {
        return cur().name;
      },
      set name(v: string) {
        if (self.def.named === false) return;
        update({
          name: uniqueName(
            self.all().filter((x) => x.id !== id),
            String(v),
          ),
        });
      },
      get socket_type() {
        return String(cur()[self.typeKey] ?? self.def.types?.[0][0] ?? 'FLOAT');
      },
      set socket_type(v: string) {
        setType(v);
      },
      get data_type() {
        return String(cur()[self.typeKey] ?? self.def.types?.[0][0] ?? 'FLOAT');
      },
      set data_type(v: string) {
        setType(v);
      },
      toString: () => `<bpy_struct, ${self.struct_}("${cur().name}")>`,
    };
  }
  new(a?: unknown, b?: unknown) {
    const items = this.all();
    let id = 0;
    while (items.some((i) => i.id === id)) id++;
    let it: NodeItem;
    if (this.types) {
      const t = String(a ?? this.types[0]);
      if (!this.types.includes(t)) throw pyError('TypeError', `${this.__path}.new(): socket type '${a}' is not supported here`);
      const base = b === undefined || b === null || b === '' ? (this.def.types!.find(([v]) => v === t)?.[1] ?? 'Value') : String(b);
      it = { id, name: uniqueName(items, base), [this.typeKey]: t };
    } else if (this.def.named !== false) it = { id, name: uniqueName(items, String(a ?? 'Item') || 'Item') };
    else it = { id, name: String(items.length) };
    this.def.init?.(it);
    this.write([...items, it]);
    return this.struct(id);
  }
  remove(item: unknown) {
    const id = (item as { __itemId?: number })?.__itemId;
    if (!this.all().some((x) => x.id === id)) throw pyError('ValueError', `${this.__path}.remove(): item not found`);
    removeItem(this.tree(), this.node(), this.def, id!);
    touched();
  }
  clear() {
    for (const it of this.list()) this.remove(it);
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
kwMethod(NodeItems.prototype, 'new', ['socket_type', 'name']);
kwMethod(NodeItems.prototype, 'move', ['from_index', 'to_index']);

/** The item collection `key` of a node, or undefined when the node has none. */
export function nodeItemsFor(getTree: () => NodeTreeData | null | undefined, nid: string, key: string, path: string): unknown {
  const tree = getTree();
  const node = tree?.nodes.find((n) => n.id === nid);
  if (!tree || !node) return undefined;
  const def = itemListsOf(node.type).find((d) => d.prop === key);
  if (!def) return undefined;
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
  return new NodeItems(t, n, def, STRUCTS[`${node.type}:${key}`] ?? STRUCTS[key] ?? 'NodeItem', path);
}
