// Adding nodes for data-blocks and files: node.add_image / add_object / add_collection /
// add_material / add_mask / add_group / add_color / add_import_node / add_group_input_node, and
// dropping outliner items or files from the computer onto a node editor (each drop runs the
// matching operator at the drop point).
import { app, registerOperators, type OpContext } from '../../app/app';
import type { NodeData, NodeTreeData, SocketValue } from '../../data/types';
import { ctxOf, makeNode } from '../tree';
import { getNodeType, nodeSockets } from '../registry';
import { groupIdnameFor } from '../common';
import { NodeEditor, editorOfElement } from './editor';
import { ifaceState } from './sidebar';
import { outlinerDrag } from '../../editors/outliner';
import { importImageFile } from '../../ops/data';
import { packFile } from '../../geonodes/curves/importers';

function editorOf(ctx: OpContext): NodeEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof NodeEditor ? ed : null;
}
function treeOf(ctx: OpContext): { ed: NodeEditor; tree: NodeTreeData } | null {
  const ed = editorOf(ctx);
  const tree = ed?.tree();
  return ed && tree ? { ed, tree } : null;
}

/** Node types per tree kind for each kind of data-block ([type, property holding the id]). */
const NODE_FOR: Record<string, Partial<Record<NodeTreeData['type'], [string, string]>>> = {
  image: { SHADER: ['ShaderNodeTexImage', 'image'], WORLD: ['ShaderNodeTexEnvironment', 'image'], COMPOSITOR: ['CompositorNodeImage', 'image'], GEOMETRY: ['GeometryNodeInputImage', 'image'] },
  object: { GEOMETRY: ['GeometryNodeObjectInfo', 'inputs.Object'] },
  collection: { GEOMETRY: ['GeometryNodeCollectionInfo', 'inputs.Collection'] },
  material: { GEOMETRY: ['GeometryNodeInputMaterial', 'material'] },
  mask: { COMPOSITOR: ['CompositorNodeMask', 'mask'] },
  color: { SHADER: ['ShaderNodeRGB', 'outputs.Color'], WORLD: ['ShaderNodeRGB', 'outputs.Color'], COMPOSITOR: ['CompositorNodeRGB', 'outputs.Color'], GEOMETRY: ['FunctionNodeInputColor', 'value'] },
};

/** Import node types by file extension. */
export const IMPORT_NODES: Record<string, string> = {
  obj: 'GeometryNodeImportOBJ',
  stl: 'GeometryNodeImportSTL',
  ply: 'GeometryNodeImportPLY',
  csv: 'GeometryNodeImportCSV',
  tsv: 'GeometryNodeImportCSV',
  txt: 'GeometryNodeImportText',
  vdb: 'GeometryNodeImportVDB',
};

/** Node-space location of an operator: `location` (pixels in the editor) or the pointer. */
function nodeLocation(ed: NodeEditor, p: Record<string, unknown>): [number, number] {
  const loc = p.location as number[] | undefined;
  const r = ed.el.getBoundingClientRect();
  const cx = Array.isArray(loc) && (loc[0] || loc[1]) ? r.left + loc[0] : app.pointer.x;
  const cy = Array.isArray(loc) && (loc[0] || loc[1]) ? r.top + loc[1] : app.pointer.y;
  const [x, y] = ed.toNode(cx, cy);
  return [x, -y];
}

/** Add a node centred under a location, selected and active. */
export function placeNode(ed: NodeEditor, tree: NodeTreeData, type: string, at: [number, number], settings: Record<string, SocketValue> = {}): NodeData {
  const n = makeNode(tree, type, at, settings);
  n.location = [at[0] - (n.width ?? 140) / 2, at[1] + 10];
  for (const k of Object.keys(settings))
    if (k.startsWith('inputs.')) {
      n.inputs[k.slice(7)] = settings[k];
      delete n.props[k];
    }
  for (const o of tree.nodes) o.select = false;
  n.select = true;
  tree.nodes.push(n);
  tree.active_node = n.id;
  void ed;
  return n;
}

function idOp(kind: 'image' | 'object' | 'collection' | 'material' | 'mask', table: 'images' | 'objects' | 'collections' | 'materials' | 'masks', label: string) {
  const prop = 'name';
  return {
    idname: `node.add_${kind}`,
    label: `Add ${label}`,
    description: `Add a node using a ${label.toLowerCase()} at the pointer (dropping a ${label.toLowerCase()} on the editor does this)`,
    props: [
      { id: prop, label: 'Name', type: 'string' as const, default: '' },
      { id: 'session_uid', label: 'Session UID', type: 'string' as const, default: '', hidden: true },
      { id: 'location', label: 'Location', type: 'vec2' as const, default: [0, 0], hidden: true },
    ],
    poll: (ctx: OpContext) => {
      const t = treeOf(ctx);
      return !!t && !!NODE_FOR[kind][t.tree.type];
    },
    exec: (ctx: OpContext, p: Record<string, unknown>) => {
      const { ed, tree } = treeOf(ctx)!;
      const rows = Object.values((app.doc as unknown as Record<string, Record<string, { id: string; name: string }>>)[table] ?? {});
      const d = rows.find((x) => x.id === p.session_uid) ?? rows.find((x) => x.name === p[prop]);
      if (!d) {
        app.report('ERROR', `No ${label.toLowerCase()} named "${String(p[prop] ?? '')}"`);
        return 'CANCELLED' as const;
      }
      const [type, key] = NODE_FOR[kind][tree.type]!;
      placeNode(ed, tree, type, nodeLocation(ed, p), { [key]: d.id });
      app.changed('doc');
    },
  };
}

registerOperators([
  idOp('image', 'images', 'Image'),
  idOp('object', 'objects', 'Object'),
  idOp('collection', 'collections', 'Collection'),
  idOp('material', 'materials', 'Material'),
  idOp('mask', 'masks', 'Mask'),
  {
    idname: 'node.add_group',
    label: 'Add Node Group',
    description: 'Add a group node using a node group at the pointer (dropping a node group on the editor does this)',
    props: [
      { id: 'name', label: 'Name', type: 'string', default: '' },
      { id: 'session_uid', label: 'Session UID', type: 'string', default: '', hidden: true },
      { id: 'location', label: 'Location', type: 'vec2', default: [0, 0], hidden: true },
    ],
    poll: (ctx) => !!treeOf(ctx),
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const g = Object.values(app.doc.node_groups).find((x) => x.id === p.session_uid) ?? Object.values(app.doc.node_groups).find((x) => x.name === p.name);
      const kind = tree.type === 'WORLD' ? 'SHADER' : tree.type;
      if (!g || g.tree.type !== kind) {
        app.report('ERROR', g ? `"${g.name}" is a different kind of node group` : `No node group named "${String(p.name ?? '')}"`);
        return 'CANCELLED';
      }
      if (g.tree === tree || ed.path.some((s) => s.group === g.id)) {
        app.report('ERROR', 'A node group cannot contain itself');
        return 'CANCELLED';
      }
      const n = placeNode(ed, tree, groupIdnameFor(tree.type), nodeLocation(ed, p), { node_tree: g.id });
      if (g.tree.default_group_node_width) n.width = g.tree.default_group_node_width;
      app.changed('doc');
    },
  },
  {
    idname: 'node.add_color',
    label: 'Add Color',
    description: 'Add a color node with the given color at the pointer',
    props: [
      { id: 'color', label: 'Color', type: 'color', default: [0.8, 0.8, 0.8, 1] },
      { id: 'gamma', label: 'Gamma Corrected', type: 'bool', default: false },
      { id: 'location', label: 'Location', type: 'vec2', default: [0, 0], hidden: true },
    ],
    poll: (ctx) => {
      const t = treeOf(ctx);
      return !!t && !!NODE_FOR.color[t.tree.type];
    },
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const c = [...((p.color as number[]) ?? [0.8, 0.8, 0.8])];
      // display (gamma corrected) colors become linear values
      const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const rgba = [0, 1, 2].map((i) => (p.gamma ? lin(c[i] ?? 0) : (c[i] ?? 0))).concat([c[3] ?? 1]);
      const [type, key] = NODE_FOR.color[tree.type]!;
      placeNode(ed, tree, type, nodeLocation(ed, p), { [key]: rgba });
      app.changed('doc');
    },
  },
  {
    idname: 'node.add_import_node',
    label: 'Add Import Node',
    description: 'Add an import node for a file stored in the project (dropping .obj, .stl, .ply, .csv or .txt files on the editor does this)',
    props: [
      { id: 'filepath', label: 'File Path', type: 'string', default: '' },
      { id: 'location', label: 'Location', type: 'vec2', default: [0, 0], hidden: true },
    ],
    poll: (ctx) => treeOf(ctx)?.tree.type === 'GEOMETRY',
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const path = String(p.filepath ?? '');
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const type = IMPORT_NODES[ext];
      if (!type || !getNodeType(type)) {
        app.report('ERROR', ext ? `No import node reads .${ext} files` : 'Give the file to import');
        return 'CANCELLED';
      }
      placeNode(ed, tree, type, nodeLocation(ed, p), { 'inputs.Path': path });
      app.changed('doc');
    },
  },
  {
    idname: 'node.add_group_input_node',
    label: 'Add Group Input Node',
    description: 'Add a Group Input node that shows only one socket of the group interface',
    props: [
      { id: 'socket_identifier', label: 'Socket Identifier', type: 'string', default: '' },
      { id: 'panel_identifier', label: 'Panel Identifier', type: 'string', default: '' },
      { id: 'location', label: 'Location', type: 'vec2', default: [0, 0], hidden: true },
    ],
    poll: (ctx) => !!treeOf(ctx)?.tree.interface,
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const keep = new Set<string>();
      const sid = String(p.socket_identifier ?? '');
      const pid = String(p.panel_identifier ?? '');
      for (const it of tree.interface ?? []) if (it.in_out === 'INPUT' && (it.identifier === sid || (pid && it.panel === pid))) keep.add(it.identifier);
      if (!keep.size) {
        app.report('ERROR', 'Choose an input socket (or panel) of the group interface');
        return 'CANCELLED';
      }
      const n = placeNode(ed, tree, 'NodeGroupInput', nodeLocation(ed, p));
      n.hidden_sockets = nodeSockets(n, ctxOf(app.doc, tree))
        .outputs.filter((s) => !keep.has(s.identifier))
        .map((s) => `out:${s.identifier}`);
      app.changed('doc');
    },
  },
]);

// ---------------------------------------------------------------------------
// Drag and drop onto node editors

/** The node editor under a drag event. */
function editorAt(e: DragEvent): NodeEditor | null {
  const target = e.target as HTMLElement | null;
  const el = target?.closest?.('.nd-editor');
  if (!el || target!.closest('.nd-sidebar, .nd-toolbar')) return null;
  const ed = editorOfElement.get(el);
  return ed && ed.tree() ? ed : null;
}

const ID_DROPS: Record<string, string> = {
  images: 'node.add_image',
  objects: 'node.add_object',
  collections: 'node.add_collection',
  materials: 'node.add_material',
  masks: 'node.add_mask',
  node_groups: 'node.add_group',
};

/** Operator and properties for an outliner item dropped on a node editor. */
function outlinerDrop(): [string, Record<string, unknown>][] {
  const d = outlinerDrag();
  if (!d) return [];
  if (d.kind === 'objects') return d.ids.map((id) => ['node.add_object', { session_uid: id }]);
  if (d.kind === 'collection') return [['node.add_collection', { session_uid: d.id }]];
  const op = ID_DROPS[d.table ?? 'materials'];
  return op ? [[op, { session_uid: d.id }]] : [];
}

addEventListener('dragover', (e) => {
  const ed = editorAt(e);
  if (!ed) return;
  const files = e.dataTransfer?.types.includes('Files');
  if (!files && !outlinerDrag() && !ifaceState.dragSocket) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});

addEventListener('drop', (e) => {
  const ed = editorAt(e);
  if (!ed) return;
  const r = ed.el.getBoundingClientRect();
  const location = [e.clientX - r.left, e.clientY - r.top];
  const run = (op: string, props: Record<string, unknown>, offset = 0) => app.run(op, { ...props, location: [location[0] + offset, location[1] + offset] }, { area: ed.area, invoke: false });
  if (ifaceState.dragSocket) {
    e.preventDefault();
    run('node.add_group_input_node', { socket_identifier: ifaceState.dragSocket });
    ifaceState.dragSocket = null;
    return;
  }
  const files = e.dataTransfer?.files ? [...e.dataTransfer.files] : [];
  if (files.length) {
    e.preventDefault();
    void dropFiles(ed, files, location);
    return;
  }
  const items = outlinerDrop();
  if (!items.length) return;
  e.preventDefault();
  outlinerDrag(true);
  items.forEach(([op, props], i) => run(op, props, i * 30));
});

async function dropFiles(ed: NodeEditor, files: File[], location: number[]) {
  const tree = ed.tree();
  if (!tree) return;
  let i = 0;
  for (const f of files) {
    const at = [location[0] + i * 30, location[1] + i * 30];
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (f.type.startsWith('image/') || /^(png|jpe?g|webp|gif|bmp|tga|exr|hdr|tiff?)$/.test(ext)) {
      const id = await importImageFile(f);
      if (id) app.run('node.add_image', { session_uid: id, location: at }, { area: ed.area, invoke: false });
    } else if (IMPORT_NODES[ext] && tree.type === 'GEOMETRY') {
      packFile(app.doc, f.name, new Uint8Array(await f.arrayBuffer()));
      app.run('node.add_import_node', { filepath: f.name, location: at }, { area: ed.area, invoke: false });
    } else {
      app.report('WARNING', `Cannot add a node for ${f.name}`);
      continue;
    }
    i++;
  }
}
