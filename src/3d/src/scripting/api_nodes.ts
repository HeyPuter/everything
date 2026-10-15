// Node group interfaces for scripts: ng.interface.new_socket(name, in_out=…, socket_type=…),
// new_panel, remove, items_tree; the group's Group Input / Group Output nodes and the Geometry
// Nodes modifiers using it pick the sockets up (mod["Socket_1"] = value).
import { app } from '../app/app';
import type { NodeTreeData } from '../data/types';
import { addInterfaceSocket } from '../nodes/tree';
import { addInterfacePanel, removeInterfacePanel, setSocketPanel } from '../nodes/iface';
import { interfaceSocketType } from '../nodes/registry';
import { ID_MIXINS, syncNodesModifier } from './api';
import { PropCollection, Struct, kwMethod, proxify, pyError, toPlain, touched, type Raw } from './rna';

type Item = NonNullable<NodeTreeData['interface']>[number];
type Panel = NonNullable<NodeTreeData['interface_panels']>[number];

const SOCKET_TYPES = ['NodeSocketFloat', 'NodeSocketInt', 'NodeSocketBool', 'NodeSocketVector', 'NodeSocketColor', 'NodeSocketString', 'NodeSocketGeometry', 'NodeSocketShader', 'NodeSocketObject', 'NodeSocketCollection', 'NodeSocketMaterial', 'NodeSocketImage', 'NodeSocketTexture', 'NodeSocketFont', 'NodeSocketRotation', 'NodeSocketMatrix', 'NodeSocketMenu'];

const treeOf = (id: string) => {
  const g = app.doc.node_groups[id];
  if (!g) throw pyError('ReferenceError', 'NodeTree has been removed');
  return g.tree;
};

/** Gives the Geometry Nodes modifiers that use the group values for new inputs. */
function syncUsers(groupId: string) {
  for (const ob of Object.values(app.doc.objects)) for (const m of ob.modifiers) if (m.type === 'NODES' && m.node_group === groupId) syncNodesModifier(m as unknown as Raw);
}

class NodeTreeInterface extends PropCollection<unknown> {
  constructor(readonly groupId: string) {
    super(`bpy.data.node_groups[${JSON.stringify(app.doc.node_groups[groupId]?.name ?? '?')}].interface.items_tree`);
  }
  list() {
    const t = treeOf(this.groupId);
    return [...(t.interface ?? []).map((i) => this.socket(i)), ...(t.interface_panels ?? []).map((p) => this.panel(p))];
  }
  nameOf(x: unknown) {
    return (x as { name: string }).name;
  }
  get items_tree() {
    return this.list();
  }
  private socket(it: Item) {
    const t = () => treeOf(this.groupId);
    const s = new Struct('NodeTreeInterfaceSocket', () => ((t().interface ?? []).includes(it) ? (it as unknown as Raw) : null), `${this.__path}[${JSON.stringify(it.name)}]`);
    Object.defineProperties(s, {
      __item: { value: it },
      item_type: { value: 'SOCKET' },
      bl_socket_idname: { get: () => it.socket_type },
      default_value: {
        get: () => it.default_value ?? null,
        set: (v: unknown) => {
          it.default_value = toPlain(v) as never;
          touched('geometry');
        },
      },
      min_value: { get: () => it.min_value ?? -Infinity, set: (v: number) => ((it.min_value = Number(v)), touched()) },
      max_value: { get: () => it.max_value ?? Infinity, set: (v: number) => ((it.max_value = Number(v)), touched()) },
      description: { get: () => it.description ?? '', set: (v: string) => ((it.description = String(v)), touched()) },
      parent: { get: () => (it.panel ? this.panel((t().interface_panels ?? []).find((p) => p.identifier === it.panel)!) : null) },
    });
    return proxify(s);
  }
  private panel(p: Panel) {
    const t = () => treeOf(this.groupId);
    const s = new Struct('NodeTreeInterfacePanel', () => ((t().interface_panels ?? []).includes(p) ? (p as unknown as Raw) : null), `${this.__path}[${JSON.stringify(p.name)}]`);
    Object.defineProperties(s, { __panel: { value: p }, item_type: { value: 'PANEL' } });
    return proxify(s);
  }
  /** Adds an input or output socket to the group. */
  new_socket(name: string, description = '', in_out = 'INPUT', socket_type = 'NodeSocketFloat', parent: unknown = null) {
    const io = String(in_out ?? 'INPUT').toUpperCase();
    if (io !== 'INPUT' && io !== 'OUTPUT') throw pyError('TypeError', `NodeTreeInterface.new_socket(): enum "${in_out}" not found in ('INPUT', 'OUTPUT')`);
    const st = String(socket_type ?? 'NodeSocketFloat');
    if (!SOCKET_TYPES.includes(st)) throw pyError('TypeError', `NodeTreeInterface.new_socket(): socket type "${socket_type}" not found in (${SOCKET_TYPES.join(', ')})`);
    const tree = treeOf(this.groupId);
    const it = addInterfaceSocket(tree, io as 'INPUT' | 'OUTPUT', String(name || 'Socket'), interfaceSocketType(st).type);
    it.socket_type = st;
    if (description) it.description = String(description);
    const pid = (parent as { __panel?: Panel } | null)?.__panel?.identifier;
    if (pid && io === 'INPUT') setSocketPanel(tree, it.identifier, pid);
    syncUsers(this.groupId);
    touched('geometry');
    return this.socket(it);
  }
  /** Adds a panel organizing the group node's inputs. */
  new_panel(name: string, description = '', default_closed = false) {
    void description;
    const p = addInterfacePanel(treeOf(this.groupId), String(name || 'Panel'));
    if (default_closed) p.default_closed = true;
    touched();
    return this.panel(p);
  }
  remove(item: unknown) {
    const tree = treeOf(this.groupId);
    const it = (item as { __item?: Item })?.__item;
    const p = (item as { __panel?: Panel })?.__panel;
    if (it) {
      const i = (tree.interface ?? []).indexOf(it);
      if (i < 0) throw pyError('RuntimeError', 'NodeTreeInterface.remove(): item not found');
      tree.interface!.splice(i, 1);
      // links into or out of the removed socket go with it
      tree.links = tree.links.filter((l) => l.from_socket !== it.identifier && l.to_socket !== it.identifier);
    } else if (p) removeInterfacePanel(tree, p.identifier);
    else throw pyError('TypeError', 'NodeTreeInterface.remove(): expected an interface socket or panel');
    touched('geometry');
  }
  clear() {
    const tree = treeOf(this.groupId);
    tree.interface = [];
    delete tree.interface_panels;
    touched('geometry');
  }
  move(item: unknown, to_position: number) {
    const tree = treeOf(this.groupId);
    const it = (item as { __item?: Item })?.__item;
    const list = tree.interface ?? [];
    const i = it ? list.indexOf(it) : -1;
    if (i < 0) return;
    list.splice(i, 1);
    list.splice(Math.max(0, Math.min(list.length, Math.round(Number(to_position)))), 0, it!);
    touched('geometry');
  }
}
kwMethod(NodeTreeInterface.prototype, 'new_socket', ['name', 'description', 'in_out', 'socket_type', 'parent']);
kwMethod(NodeTreeInterface.prototype, 'new_panel', ['name', 'description', 'default_closed']);
kwMethod(NodeTreeInterface.prototype, 'move', ['item', 'to_position']);

class NodeGroupInterface {
  get interface() {
    return new NodeTreeInterface((this as unknown as { __id: string }).__id);
  }
  get is_modifier() {
    return !!app.doc.node_groups[(this as unknown as { __id: string }).__id]?.is_modifier;
  }
  set is_modifier(v: boolean) {
    app.doc.node_groups[(this as unknown as { __id: string }).__id].is_modifier = !!v;
    touched();
  }
}
(ID_MIXINS.node_groups ??= []).push(NodeGroupInterface);
