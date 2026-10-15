// Scripting access to the item lists of Format String (`format_items.new('FLOAT', "x")`),
// Index Switch (`index_switch_items.new()`) and Menu Switch (`enum_items.new("Name")`).
import type { NodeData, NodeTreeData } from '../../data/types';
import { PropCollection, kwMethod, pyError, touched } from '../../scripting/rna';
import { writeItems, type NodeItem } from './items';
import { formatItems } from './fn_string';
import { indexItems, menuItems } from './switches';

interface ListSpec {
  type: string;
  struct: string;
  read: (n: NodeData) => NodeItem[];
  /** socket types accepted by new() (Format String) */
  types?: string[];
  named: boolean;
}

const LISTS: Record<string, ListSpec> = {
  format_items: { type: 'FunctionNodeFormatString', struct: 'NodeFunctionFormatStringItem', read: formatItems, types: ['FLOAT', 'INT', 'STRING'], named: true },
  index_switch_items: { type: 'GeometryNodeIndexSwitch', struct: 'IndexSwitchItem', read: indexItems, named: false },
  enum_items: { type: 'GeometryNodeMenuSwitch', struct: 'NodeEnumItem', read: menuItems, named: true },
};

const uniqueName = (items: NodeItem[], name: string) => {
  const names = new Set(items.map((i) => i.name));
  if (!names.has(name)) return name;
  for (let k = 1; ; k++) {
    const n = `${name}.${String(k).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
};

class NodeItems extends PropCollection<unknown> {
  constructor(
    private tree: () => NodeTreeData,
    private node: () => NodeData,
    private key: string,
    private spec: ListSpec,
    path: string,
  ) {
    super(path);
  }
  private all() {
    return this.spec.read(this.node());
  }
  private write(items: NodeItem[]) {
    writeItems(this.node(), this.key, items);
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
    return {
      __kind: 'struct',
      __type: self.spec.struct,
      __itemId: id,
      get name() {
        return cur().name;
      },
      set name(v: string) {
        if (!self.spec.named) return;
        update({
          name: uniqueName(
            self.all().filter((x) => x.id !== id),
            String(v),
          ),
        });
      },
      get socket_type() {
        return cur().type ?? 'FLOAT';
      },
      set socket_type(v: string) {
        if (!self.spec.types?.includes(String(v))) throw pyError('TypeError', `bpy_struct: item.socket_type = '${v}' is not a supported type here`);
        update({ type: String(v) });
      },
      toString: () => `<bpy_struct, ${self.spec.struct}("${cur().name}")>`,
    };
  }
  new(a?: unknown, b?: unknown) {
    const items = this.all();
    let id = 0;
    while (items.some((i) => i.id === id)) id++;
    let it: NodeItem;
    if (this.spec.types) {
      const t = String(a ?? 'FLOAT');
      if (!this.spec.types.includes(t)) throw pyError('TypeError', `${this.__path}.new(): socket type '${a}' is not supported here`);
      it = { id, name: uniqueName(items, String(b ?? 'Value') || 'Value'), type: t };
    } else if (this.spec.named) it = { id, name: uniqueName(items, String(a ?? 'Item') || 'Item') };
    else it = { id, name: String(items.length) };
    this.write([...items, it]);
    return this.struct(id);
  }
  remove(item: unknown) {
    const id = (item as { __itemId?: number })?.__itemId;
    const items = this.all();
    const it = items.find((x) => x.id === id);
    if (!it) throw pyError('ValueError', `${this.__path}.remove(): item not found`);
    const tree = this.tree();
    const nid = this.node().id;
    const sock = `Item_${it.id}`;
    tree.links = tree.links.filter((l) => !((l.to_node === nid && l.to_socket === sock) || (l.from_node === nid && l.from_socket === sock)));
    this.write(items.filter((x) => x !== it));
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
  const spec = LISTS[key];
  const tree = getTree();
  const node = tree?.nodes.find((n) => n.id === nid);
  if (!spec || !tree || !node || node.type !== spec.type) return undefined;
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
  return new NodeItems(t, n, key, spec, path);
}
