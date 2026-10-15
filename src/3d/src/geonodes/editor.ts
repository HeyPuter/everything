// Geometry Node Editor: edits the node group of the active object's active Geometry Nodes
// modifier (or a pinned node group). Viewer linking (Ctrl Shift click), item sockets of
// Capture Attribute, and the operators behind the header's New button.
import { h } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators } from '../app/app';
import { registerEditor, type Area } from '../ui/screen';
import { NodeEditor } from '../nodes/editor/editor';
import { registerNodeEditorProvider } from '../nodes/editor/context';
import { dataBlockSelector } from '../editors/properties/tabs';
import { newNodeGroup, uid } from '../data/defaults';
import { newModifier } from '../eval/modifiers';
import { getNodeType, nodeSockets, findSocket } from '../nodes/registry';
import { addNode, connect, ctxOf, nodeById, uniqueGroupName } from '../nodes/tree';
import type { ModifierBase, NodeData, NodeGroupData, NodeTreeData, ObjectData, SocketValue } from '../data/types';
import { VIEWER, isActiveViewer } from './nodes/output';
import { captureItems, ITEM_SOCKET, captureIn, captureOut, type CaptureItem } from './nodes/geometry';
import { viewerState } from './results';
import { setModifierNameHook } from './modifier';
import { interfaceSocketType } from '../nodes/registry';
import { enumMenu, textField, button } from '../ui/widgets';
import type { NodeDrawContext } from '../nodes/types';

export const GN_OBJECT_TYPES = ['MESH', 'CURVE', 'FONT'];

export function nodesModifiers(ob: ObjectData | null | undefined): ModifierBase[] {
  return ob ? ob.modifiers.filter((m) => m.type === 'NODES') : [];
}

/** The active Geometry Nodes modifier of an object (explicitly activated, or the last one). */
export function activeNodesModifier(ob: ObjectData | null | undefined): ModifierBase | undefined {
  const mods = nodesModifiers(ob);
  return mods.find((m) => m.is_active) ?? mods[mods.length - 1];
}

export function setActiveModifier(ob: ObjectData, m: ModifierBase) {
  for (const x of ob.modifiers) if (x.type === 'NODES') x.is_active = x === m;
}

function uniqueModifierName(ob: ObjectData | null, base = 'GeometryNodes') {
  const names = new Set((ob?.modifiers ?? []).map((m) => m.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}
// new NODES modifiers are named like the reference ("GeometryNodes")
setModifierNameHook(() => uniqueModifierName(app.activeObject));

/** Fill missing modifier input values from the group interface defaults. */
export function syncModifierInputs(m: ModifierBase, g: NodeGroupData | undefined) {
  if (!g) return;
  for (const it of g.tree.interface ?? []) {
    if (it.in_out !== 'INPUT') continue;
    const { type } = interfaceSocketType(it.socket_type);
    if (type === 'GEOMETRY') continue;
    if (m[it.identifier] === undefined) {
      const d = it.default_value;
      m[it.identifier] = Array.isArray(d)
        ? [...d]
        : (d ??
          (type === 'BOOLEAN'
            ? false
            : type === 'VECTOR' || type === 'ROTATION'
              ? [0, 0, 0]
              : type === 'RGBA'
                ? [0.8, 0.8, 0.8, 1]
                : type === 'STRING'
                  ? ''
                  : ['OBJECT', 'COLLECTION', 'MATERIAL'].includes(type)
                    ? null
                    : 0));
    }
  }
}

function changed(label: string) {
  app.pushUndo(label);
  app.changed('doc');
}

// ---------------------------------------------------------------------------
// Editor

export class GeometryNodeEditor extends NodeEditor {
  keymaps = ['Geometry Node Editor', 'Node Editor', 'Node Generic'];
  pinned: string | null = null;
  constructor(area: Area, state: unknown) {
    super(area, state, 'GEOMETRY');
    const st = (state ?? {}) as { pinned?: string | null };
    if (st.pinned) this.pinned = st.pinned;
  }
  serialize() {
    return { ...super.serialize(), pinned: this.pinned };
  }
}

function editorGroup(ed: GeometryNodeEditor): {
  group: NodeGroupData | undefined;
  ob: ObjectData | null;
  mod: ModifierBase | undefined;
} {
  const doc = app.doc;
  if (ed.pinned) {
    const g = doc.node_groups[ed.pinned];
    if (!g) ed.pinned = null;
    else return { group: g, ob: null, mod: undefined };
  }
  const ob = app.activeObject;
  const mod = activeNodesModifier(ob);
  const g = mod && typeof mod.node_group === 'string' ? doc.node_groups[mod.node_group] : undefined;
  return { group: g, ob, mod };
}

function newGroupFor(ed: GeometryNodeEditor) {
  const doc = app.doc;
  const g = newNodeGroup(uniqueGroupName(doc, 'Geometry Nodes'));
  doc.node_groups[g.id] = g;
  if (ed.pinned) {
    ed.pinned = g.id;
    changed('New Node Group');
    return;
  }
  const ob = app.activeObject;
  if (!ob || !GN_OBJECT_TYPES.includes(ob.type)) {
    ed.pinned = g.id;
    changed('New Node Group');
    return;
  }
  let m = activeNodesModifier(ob);
  if (!m) {
    m = newModifier('NODES', uid('md'), ob.modifiers);
    ob.modifiers.push(m);
  }
  setActiveModifier(ob, m);
  m.node_group = g.id;
  syncModifierInputs(m, g);
  ed.path = [];
  changed(m ? 'New Geometry Node Group' : 'New Geometry Nodes Modifier');
}

registerNodeEditorProvider({
  id: 'GEOMETRY',
  label: 'Geometry Node Editor',
  icon: 'geometry_nodes',
  treeType: () => 'GEOMETRY',
  root: (e) => {
    const ed = e as unknown as GeometryNodeEditor;
    const { group, ob, mod } = editorGroup(ed);
    if (!group) return null;
    const crumbs: [string, string][] =
      ob && mod
        ? [
            ['object', ob.name],
            ['modifier', mod.name],
            ['node_tree', group.name],
          ]
        : [['node_tree', group.name]];
    return { tree: group.tree, key: `ng:${group.id}`, crumbs, groupId: group.id };
  },
  emptyMessage: () => '',
  menuPoll: (idname) => !!getNodeType(idname)?.treeTypes.includes('GEOMETRY'),
  // Ctrl Shift click / node.link_viewer: link the node to the viewer
  linkViewer: (ed, node) => linkToViewer(ed as NodeEditor, node),
  headerRight: (e) => {
    const ed = e as GeometryNodeEditor;
    const doc = app.doc;
    const { group, ob, mod } = editorGroup(ed);
    const groups = Object.values(doc.node_groups).filter((g) => g.tree.type === 'GEOMETRY');
    const users = group ? Object.values(doc.objects).reduce((s, o) => s + o.modifiers.filter((m) => m.type === 'NODES' && m.node_group === group.id).length, 0) : 0;
    const canEdit = !!ed.pinned || (!!ob && GN_OBJECT_TYPES.includes(ob.type));
    return h(
      'div',
      { class: 'nd-ids gn-ids' },
      canEdit
        ? dataBlockSelector(
            'gn-ng',
            'node_tree',
            groups,
            group?.id ?? null,
            (id) => {
              if (ed.pinned) {
                if (id) ed.pinned = id;
                app.changed('ui');
                return;
              }
              if (!ob) return;
              let m = mod;
              if (!m && id) {
                m = newModifier('NODES', uid('md'), ob.modifiers);
                ob.modifiers.push(m);
                setActiveModifier(ob, m);
              }
              if (!m) return;
              m.node_group = id;
              if (id) syncModifierInputs(m, doc.node_groups[id]);
              ed.path = [];
              changed('Assign Node Group');
            },
            () => newGroupFor(ed),
            {
              users,
              duplicate: group
                ? () => {
                    const d = structuredClone(group);
                    d.id = uid('ng');
                    d.name = uniqueGroupName(doc, group.name);
                    doc.node_groups[d.id] = d;
                    if (ed.pinned) ed.pinned = d.id;
                    else if (mod) mod.node_group = d.id;
                    changed('Copy Node Group');
                  }
                : undefined,
            },
          )
        : null,
      h(
        'button',
        {
          class: { 'hdr-toggle': true, on: !!ed.pinned },
          'data-tip': 'Pin\nKeep showing this node group regardless of the active object',
          onclick: () => {
            ed.pinned = ed.pinned ? null : (group?.id ?? null);
            app.changed('ui');
          },
        },
        icon(ed.pinned ? 'pinned' : 'unpinned'),
      ),
    );
  },
});

registerEditor({
  id: 'GEOMETRY',
  label: 'Geometry Node Editor',
  icon: 'geometry_nodes',
  group: 'General',
  create: (a, s) => new GeometryNodeEditor(a, s),
});

// ---------------------------------------------------------------------------
// Viewer

const VIEW_DATA_TYPE: Record<string, string> = {
  FLOAT: 'FLOAT',
  INT: 'INT',
  BOOLEAN: 'BOOLEAN',
  VECTOR: 'FLOAT_VECTOR',
  RGBA: 'FLOAT_COLOR',
  ROTATION: 'QUATERNION',
};

/** Activate a viewer node (and remember which object/modifier shows it). */
export function activateViewer(tree: NodeTreeData, viewer: NodeData | null) {
  for (const n of tree.nodes) if (n.type === VIEWER) n.props.viewer_active = n === viewer;
  const ob = app.activeObject;
  const mod = activeNodesModifier(ob);
  if (viewer && ob && mod) {
    viewerState.objectId = ob.id;
    viewerState.modifierId = mod.id;
  } else if (!viewer) {
    viewerState.objectId = null;
    viewerState.modifierId = null;
  }
}

/** Upstream geometry socket feeding the first downstream node that consumes `start`'s outputs. */
function geometrySourceFor(tree: NodeTreeData, start: NodeData): { node: string; socket: string } | null {
  const ctx = ctxOf(app.doc, tree);
  const queue = [start.id],
    seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const l of tree.links.filter((x) => x.from_node === id)) {
      const to = nodeById(tree, l.to_node);
      if (!to || to.type === VIEWER) continue;
      const geoIn = nodeSockets(to, ctx).inputs.find((s) => s.type === 'GEOMETRY');
      if (geoIn) {
        const gl = tree.links.find((x) => x.to_node === to.id && x.to_socket === geoIn.identifier);
        if (gl) return { node: gl.from_node, socket: gl.from_socket };
      }
      queue.push(to.id);
    }
  }
  return null;
}

export function linkToViewer(ed: NodeEditor, node: NodeData): boolean {
  const tree = ed.tree();
  if (!tree) return false;
  const ctx = ctxOf(app.doc, tree);
  if (node.type === VIEWER) {
    activateViewer(tree, isActiveViewer(node) ? null : node);
    app.changed('doc');
    return true;
  }
  const outs = nodeSockets(node, ctx).outputs.filter((s) => s.type !== 'CUSTOM' && (s.type === 'GEOMETRY' || VIEW_DATA_TYPE[s.type]));
  if (!outs.length) return false;
  let viewer = tree.nodes.find((n) => n.type === VIEWER);
  if (!viewer) {
    viewer = addNode(tree, VIEWER, [node.location[0] + (node.width ?? 140) + 80, node.location[1]]);
  }
  // cycle through the node's outputs on repeated clicks
  const cur = tree.links.find((l) => l.from_node === node.id && l.to_node === viewer!.id);
  const i = cur ? outs.findIndex((s) => s.identifier === cur.from_socket) : -1;
  const sock = outs[(i + 1) % outs.length];
  if (sock.type === 'GEOMETRY') {
    tree.links = tree.links.filter((l) => !(l.to_node === viewer!.id && l.to_socket === 'Value'));
    connect(ctx, node.id, sock.identifier, viewer.id, 'Geometry');
  } else {
    viewer.props.data_type = VIEW_DATA_TYPE[sock.type];
    connect(ctx, node.id, sock.identifier, viewer.id, 'Value');
    if (!tree.links.some((l) => l.to_node === viewer!.id && l.to_socket === 'Geometry')) {
      const src = geometrySourceFor(tree, node);
      if (src) connect(ctx, src.node, src.socket, viewer.id, 'Geometry');
    }
  }
  activateViewer(tree, viewer);
  app.changed('doc');
  return true;
}

// viewer node body: activation toggle
{
  const d = getNodeType(VIEWER)!;
  d.drawBody = (ctx: NodeDrawContext) =>
    h(
      'div',
      { class: 'gn-viewer-body' },
      button(
        `${ctx.key}:viewer-active`,
        [icon(isActiveViewer(ctx.node) ? 'hide_off' : 'hide_on'), isActiveViewer(ctx.node) ? 'Viewing' : 'Inactive'],
        () => {
          activateViewer(ctx.tree, isActiveViewer(ctx.node) ? null : ctx.node);
          changed('Toggle Viewer');
        },
        {
          tip: 'Show this viewer in the viewport and spreadsheet (Ctrl Shift click a node to view it)',
          active: isActiveViewer(ctx.node),
        },
      ),
    );
  d.bodyHeight = () => 26;
}

// ---------------------------------------------------------------------------
// Capture Attribute items

const ITEM_TYPE: Record<string, string> = {
  FLOAT: 'FLOAT',
  INT: 'INT',
  BOOLEAN: 'BOOLEAN',
  VECTOR: 'FLOAT_VECTOR',
  RGBA: 'FLOAT_COLOR',
  ROTATION: 'QUATERNION',
};

function addCaptureItem(node: NodeData, dataType: string, name: string): CaptureItem {
  const items = captureItems(node);
  let id = 0;
  while (items.some((i) => i.id === id)) id++;
  const it = { id, name: name || 'Value', data_type: dataType };
  items.push(it);
  node.props.capture_items = JSON.stringify(items);
  return it;
}

/** Turn links made to/from the "extend" socket of Capture Attribute into real items. */
function resolveItemLinks(): boolean {
  let any = false;
  const doc = app.doc;
  for (const g of Object.values(doc.node_groups)) {
    const tree = g.tree;
    if (tree.type !== 'GEOMETRY') continue;
    for (const l of [...tree.links]) {
      const toItem = l.to_socket === ITEM_SOCKET,
        fromItem = l.from_socket === ITEM_SOCKET;
      if (!toItem && !fromItem) continue;
      const cap = nodeById(tree, toItem ? l.to_node : l.from_node);
      const other = nodeById(tree, toItem ? l.from_node : l.to_node);
      if (!cap || cap.type !== 'GeometryNodeCaptureAttribute' || !other) continue;
      const ctx = ctxOf(doc, tree);
      const s = findSocket(other, toItem ? l.from_socket : l.to_socket, toItem, ctx);
      const dt = s ? ITEM_TYPE[s.type] : undefined;
      tree.links = tree.links.filter((x) => x !== l);
      any = true;
      if (!dt) continue;
      const it = addCaptureItem(cap, dt, s!.name);
      if (toItem) tree.links.push({ ...l, id: uid('link'), to_socket: captureIn(it) });
      else tree.links.push({ ...l, id: uid('link'), from_socket: captureOut(it) });
    }
  }
  return any;
}

let subscribed = false;
export function installItemResolver() {
  if (subscribed || !app) return;
  subscribed = true;
  app.subscribe((kinds) => {
    if (!kinds.has('doc')) return;
    if (resolveItemLinks()) app.changed('doc');
  });
}

{
  const d = getNodeType('GeometryNodeCaptureAttribute')!;
  d.drawOptions = (ctx: NodeDrawContext) => {
    const items = captureItems(ctx.node);
    const set = (list: CaptureItem[], label: string) => {
      ctx.node.props.capture_items = JSON.stringify(list);
      ctx.changed(label, true);
    };
    return h(
      'div',
      { class: 'gn-items' },
      h('div', { class: 'sub-label' }, 'Capture Items'),
      items.map((it, i) =>
        h(
          'div',
          { key: String(it.id), class: 'gn-item-row' },
          textField(`${ctx.key}:it-name:${it.id}`, it.name, (v) =>
            set(
              items.map((x) => (x === it ? { ...x, name: v || x.name } : x)),
              'Rename Item',
            ),
          ),
          enumMenu(
            `${ctx.key}:it-type:${it.id}`,
            [
              { value: 'FLOAT', label: 'Float' },
              { value: 'INT', label: 'Integer' },
              { value: 'BOOLEAN', label: 'Boolean' },
              { value: 'FLOAT_VECTOR', label: 'Vector' },
              { value: 'FLOAT_COLOR', label: 'Color' },
              { value: 'QUATERNION', label: 'Rotation' },
            ],
            it.data_type,
            (v) =>
              set(
                items.map((x) => (x === it ? { ...x, data_type: v } : x)),
                'Change Item Type',
              ),
          ),
          button(
            `${ctx.key}:it-del:${it.id}`,
            icon('remove'),
            () => {
              ctx.tree.links = ctx.tree.links.filter((l) => !((l.to_node === ctx.node.id && l.to_socket === captureIn(it)) || (l.from_node === ctx.node.id && l.from_socket === captureOut(it))));
              set(
                items.filter((_, k) => k !== i),
                'Remove Item',
              );
            },
            { tip: 'Remove item' },
          ),
        ),
      ),
      button(`${ctx.key}:it-add`, [icon('add'), 'Add Item'], () => {
        addCaptureItem(ctx.node, 'FLOAT', 'Value');
        ctx.changed('Add Item', true);
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// Operators and keys

registerOperators([
  {
    idname: 'node.new_geometry_nodes_modifier',
    label: 'New Geometry Node Group',
    description: 'Create a new modifier with a new geometry node group',
    poll: () => !!app.activeObject && GN_OBJECT_TYPES.includes(app.activeObject.type),
    exec: () => {
      const ob = app.activeObject!;
      const doc = app.doc;
      const g = newNodeGroup(uniqueGroupName(doc, 'Geometry Nodes'));
      doc.node_groups[g.id] = g;
      const m = newModifier('NODES', uid('md'), ob.modifiers);
      m.node_group = g.id;
      ob.modifiers.push(m);
      setActiveModifier(ob, m);
    },
  },
  {
    idname: 'node.new_geometry_node_group_assign',
    label: 'New Geometry Node Group',
    description: 'Create a new geometry node group and assign it to the active modifier',
    poll: () => !!activeNodesModifier(app.activeObject),
    exec: () => {
      const doc = app.doc;
      const m = activeNodesModifier(app.activeObject)!;
      const g = newNodeGroup(uniqueGroupName(doc, 'Geometry Nodes'));
      doc.node_groups[g.id] = g;
      m.node_group = g.id;
    },
  },
  {
    idname: 'object.geometry_nodes_input_attribute_toggle',
    label: 'Input Attribute Toggle',
    description: 'Switch between an attribute and a single value to define the data for every element',
    props: [
      { id: 'modifier_name', type: 'string', default: '', hidden: true },
      { id: 'input_name', type: 'string', default: '', hidden: true },
    ],
    poll: () => !!app.activeObject,
    exec: (_ctx, p) => {
      const m = app.activeObject!.modifiers.find((x) => x.name === p.modifier_name);
      if (!m) return 'CANCELLED';
      const k = `${p.input_name}_use_attribute`;
      m[k] = !m[k];
    },
  },
]);

export type { SocketValue };
