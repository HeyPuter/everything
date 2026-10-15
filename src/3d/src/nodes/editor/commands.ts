// Node editor operators for selection tools, duplicate variants, frames, groups, swapping,
// link gestures and viewing node results. The keymap and menus are in ops.ts / menus.ts.
import { registerOperators, app, type OpContext, type Operator } from '../../app/app';
import { promptText } from '../../ui/menu';
import type { NodeData, NodeTreeData, SocketValue } from '../../data/types';
import { uid } from '../../data/defaults';
import { NodeEditor } from './editor';
import { GROUPED_TYPES } from './menus';
import { ctxOf, duplicateNodes, joinInFrame, makeLinks, makeNode, nodeById, uniqueGroupName } from '../tree';
import { getNodeType } from '../registry';
import { groupIdnameFor } from '../common';
import {
  collapseHideUnused,
  connectToOutput,
  copyColor,
  detachNodes,
  groupInsert,
  groupSeparate,
  isFrame,
  isGroupNode,
  joinGroupInputs,
  parentSet,
  sameTypeStep,
  selectGrouped,
  swapNode,
  type GroupedType,
} from '../treeops';

function editorOf(ctx: OpContext): NodeEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof NodeEditor ? ed : null;
}
function treeOf(ctx: OpContext): { ed: NodeEditor; tree: NodeTreeData } | null {
  const ed = editorOf(ctx);
  const tree = ed?.tree();
  return ed && tree ? { ed, tree } : null;
}
const hasTree = (ctx: OpContext) => !!treeOf(ctx);
const selected = (tree: NodeTreeData) => tree.nodes.filter((n) => n.select);
const hasSelection = (ctx: OpContext) => !!treeOf(ctx)?.tree.nodes.some((n) => n.select);
const activeNode = (tree: NodeTreeData) => (tree.active_node ? nodeById(tree, tree.active_node) : undefined);
const hasActive = (ctx: OpContext) => {
  const t = treeOf(ctx)?.tree;
  return !!t && !!activeNode(t);
};

const SELECT_MODES: [string, string][] = [
  ['SET', 'Set'],
  ['ADD', 'Extend'],
  ['SUB', 'Subtract'],
];

/** Duplicate the selection and start moving the copies. */
function duplicateAndMove(ctx: OpContext, keepInputs: boolean, label: string) {
  const { ed, tree } = treeOf(ctx)!;
  const ids = new Set(selected(tree).map((n) => n.id));
  // frames take their children along
  for (const n of tree.nodes) if (n.parent && ids.has(n.parent)) ids.add(n.id);
  const map = duplicateNodes(tree, ids, [0, 0], keepInputs);
  for (const n of tree.nodes) n.select = false;
  for (const c of map.values()) c.select = true;
  const act = tree.active_node ? map.get(tree.active_node) : undefined;
  tree.active_node = act?.id ?? [...map.values()][0]?.id ?? null;
  app.changed('doc');
  ed.render();
  ed.startGrab(
    [...map.values()].filter((n) => !n.parent || !map.has(n.parent)).map((n) => n.id),
    'key',
    label,
  );
  return 'RUNNING_MODAL' as const;
}

/** The group node being edited and the tree containing it (inside a group only). */
function editedGroup(ed: NodeEditor): { parent: NodeTreeData; node: NodeData } | null {
  if (!ed.path.length) return null;
  const root = ed.root();
  if (!root) return null;
  let t = root.tree;
  for (let i = 0; i < ed.path.length - 1; i++) {
    const g = app.doc.node_groups[ed.path[i].group];
    if (!g) return null;
    t = g.tree;
  }
  const node = nodeById(t, ed.path[ed.path.length - 1].node);
  return node ? { parent: t, node } : null;
}

const ops: Operator[] = [
  // --- selection ------------------------------------------------------------
  {
    idname: 'node.select_circle',
    label: 'Circle Select',
    description: 'Select nodes by painting over them with a circle',
    undo: false,
    props: [{ id: 'mode', type: 'enum', default: 'ADD', items: SELECT_MODES }],
    poll: hasTree,
    invoke: (ctx, p) => {
      editorOf(ctx)!.startCircleSelect(p.mode as 'SET' | 'ADD' | 'SUB');
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'node.select_lasso',
    label: 'Lasso Select',
    description: 'Select nodes inside a freehand shape drawn with the mouse',
    undo: false,
    props: [{ id: 'mode', type: 'enum', default: 'SET', items: SELECT_MODES }],
    poll: hasTree,
    invoke: (ctx, p) => {
      editorOf(ctx)!.startLasso(p.mode as 'SET' | 'ADD' | 'SUB');
      app.report('INFO', 'Lasso Select: drag to draw the shape');
      return 'CANCELLED';
    },
  },
  {
    idname: 'node.select_grouped',
    label: 'Select Grouped',
    description: 'Select nodes that share the type, color, name prefix or name suffix of the active node',
    undo: false,
    props: [
      { id: 'type', type: 'enum', default: 'TYPE', items: GROUPED_TYPES },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
    ],
    poll: hasActive,
    exec: (ctx, p) => {
      const { tree } = treeOf(ctx)!;
      selectGrouped(tree, p.type as GroupedType, !!p.extend);
      app.changed('ui');
    },
  },
  {
    idname: 'node.select_same_type_step',
    label: 'Activate Same Type Next/Previous',
    description: 'Make the next (or previous) node of the active node type active and bring it into view',
    undo: false,
    props: [{ id: 'prev', label: 'Previous', type: 'bool', default: false }],
    poll: hasActive,
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const n = sameTypeStep(tree, !!p.prev);
      if (!n) return 'CANCELLED';
      app.changed('ui');
      requestAnimationFrame(() => ed.centerOn(n));
    },
  },
  // --- duplicate ------------------------------------------------------------
  {
    idname: 'node.duplicate_move',
    label: 'Duplicate',
    description: 'Duplicate selected nodes and move them',
    poll: hasSelection,
    invoke: (ctx) => duplicateAndMove(ctx, false, 'Duplicate'),
  },
  {
    idname: 'node.duplicate_move_linked',
    label: 'Duplicate Linked',
    description: 'Duplicate selected nodes; group nodes keep using the same node group',
    poll: hasSelection,
    invoke: (ctx) => duplicateAndMove(ctx, false, 'Duplicate Linked'),
  },
  {
    idname: 'node.duplicate_move_keep_inputs',
    label: 'Duplicate Keep Inputs',
    description: 'Duplicate selected nodes together with the links coming into them, and move them',
    poll: hasSelection,
    invoke: (ctx) => duplicateAndMove(ctx, true, 'Duplicate'),
  },
  // --- frames ---------------------------------------------------------------
  {
    idname: 'node.join_named',
    label: 'Join in Named Frame',
    description: 'Put the selected nodes in a new frame and type its label right away',
    poll: hasSelection,
    invoke: (ctx) => {
      const { tree } = treeOf(ctx)!;
      const f = joinInFrame(
        tree,
        selected(tree).map((n) => n.id),
      );
      if (!f) return 'CANCELLED';
      for (const n of tree.nodes) n.select = n === f;
      tree.active_node = f.id;
      app.pushUndo('Join in Frame');
      app.changed('doc');
      promptText('Frame Label', f.label || f.name, (v) => {
        if (!v || v === f.label) return;
        f.label = v;
        app.pushUndo('Rename Frame');
        app.changed('doc');
      });
      return 'CANCELLED';
    },
  },
  {
    idname: 'node.join_nodes',
    label: 'Join Group Inputs',
    description: 'Merge the selected Group Input nodes into one',
    poll: (ctx) => (treeOf(ctx)?.tree.nodes.filter((n) => n.select && n.type === 'NodeGroupInput').length ?? 0) > 1,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      if (!joinGroupInputs(tree, new Set(selected(tree).map((n) => n.id)))) return 'CANCELLED';
    },
  },
  {
    idname: 'node.parent_set',
    label: 'Make Parent',
    description: 'Put the selected nodes in the active frame',
    poll: (ctx) => {
      const t = treeOf(ctx)?.tree;
      return !!t && isFrame(activeNode(t)) && t.nodes.some((n) => n.select && n.id !== t.active_node);
    },
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      if (
        !parentSet(
          tree,
          selected(tree).map((n) => n.id),
          tree.active_node!,
        )
      )
        return 'CANCELLED';
    },
  },
  {
    idname: 'node.detach',
    label: 'Remove from Frame',
    description: 'Take the selected nodes out of their frames',
    poll: (ctx) => !!treeOf(ctx)?.tree.nodes.some((n) => n.select && n.parent),
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      detachNodes(tree, new Set(selected(tree).map((n) => n.id)));
    },
  },
  // --- groups ---------------------------------------------------------------
  {
    idname: 'node.group_insert',
    label: 'Insert Into Group',
    description: 'Move the selected nodes into the active group node',
    poll: (ctx) => {
      const t = treeOf(ctx)?.tree;
      const a = t ? activeNode(t) : undefined;
      return !!t && !!a?.select && isGroupNode(a) && !!a.props.node_tree && t.nodes.some((n) => n.select && n !== a);
    },
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      const ids = new Set(selected(tree).map((n) => n.id));
      if (!groupInsert(app.doc, tree, tree.active_node!, ids)) {
        app.report('WARNING', 'These nodes cannot be inserted into the group');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'node.group_separate',
    label: 'Separate',
    description: 'Copy or move the selected nodes out of the edited group into the tree that uses it',
    props: [
      {
        id: 'type',
        type: 'enum',
        default: 'COPY',
        items: [
          ['COPY', 'Copy'],
          ['MOVE', 'Move'],
        ],
        // the editor leaves the group afterwards, so this cannot be adjusted after the fact
        hidden: true,
      },
    ],
    poll: (ctx) => {
      const ed = editorOf(ctx);
      return !!ed?.path.length && hasSelection(ctx);
    },
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const at = editedGroup(ed);
      if (!at) return 'CANCELLED';
      const made = groupSeparate(app.doc, at.parent, at.node.id, new Set(selected(tree).map((n) => n.id)), p.type === 'MOVE' ? 'MOVE' : 'COPY');
      if (!made.length) return 'CANCELLED';
      // show the result in the tree that uses the group
      ed.path.pop();
      app.changed('ui');
    },
  },
  {
    idname: 'node.add_empty_group',
    label: 'New Group',
    description: 'Add a group node with a new, empty node group',
    poll: hasTree,
    invoke: (ctx) => {
      const ed = editorOf(ctx)!;
      const kind = ed.treeType() === 'WORLD' ? 'SHADER' : ed.treeType();
      const tree: NodeTreeData = { type: kind, nodes: [], links: [], interface: [] };
      tree.nodes.push(makeNode(tree, 'NodeGroupInput', [-200, 0]), makeNode(tree, 'NodeGroupOutput', [200, 0]));
      const g = { id: uid('ng'), name: uniqueGroupName(app.doc, 'NodeGroup'), tree };
      app.doc.node_groups[g.id] = g;
      ed.addNodeInteractive(groupIdnameFor(ed.treeType()), { node_tree: g.id });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'node.default_group_width_set',
    label: 'Set Default Group Node Width',
    description: 'Use the width of the group node being edited for new nodes of this group',
    poll: (ctx) => !!editorOf(ctx)?.path.length,
    exec: (ctx) => {
      const ed = editorOf(ctx)!;
      const at = editedGroup(ed);
      const g = at ? app.doc.node_groups[at.node.props.node_tree as string] : undefined;
      if (!at || !g) return 'CANCELLED';
      g.tree.default_group_node_width = at.node.width ?? 140;
    },
  },
  // --- show / hide, color ---------------------------------------------------
  {
    idname: 'node.collapse_hide_unused_toggle',
    label: 'Collapse and Hide Unused Sockets',
    description: 'Collapse the selected nodes and hide their unconnected sockets, or show them all again',
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      collapseHideUnused(
        ctxOf(app.doc, tree),
        selected(tree).filter((n) => !getNodeType(n.type)?.layout),
      );
    },
  },
  {
    idname: 'node.node_copy_color',
    label: 'Copy Color',
    description: 'Give all selected nodes the color of the active node',
    poll: (ctx) => {
      const t = treeOf(ctx)?.tree;
      return !!t && !!activeNode(t) && t.nodes.some((n) => n.select && n.id !== t.active_node);
    },
    exec: (ctx) => {
      copyColor(treeOf(ctx)!.tree);
    },
  },
  // --- links ----------------------------------------------------------------
  {
    idname: 'node.link_make',
    label: 'Make Links',
    description: 'Link neighbouring selected nodes from left to right',
    props: [{ id: 'replace', label: 'Replace', type: 'bool', default: false }],
    poll: hasSelection,
    exec: (ctx, p) => {
      const { tree } = treeOf(ctx)!;
      const n = makeLinks(
        ctxOf(app.doc, tree),
        selected(tree).map((x) => x.id),
        !!p.replace,
      );
      if (!n) {
        app.report('WARNING', 'Could not make links between the selected nodes');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'node.links_cut',
    label: 'Cut Links',
    description: 'Remove the links crossed by a drawn line (Ctrl right-drag)',
    undo: false,
    poll: hasTree,
    invoke: (ctx) => {
      editorOf(ctx)!.startGesture('CUT');
      app.report('INFO', 'Cut Links: drag across links');
      return 'CANCELLED';
    },
  },
  {
    idname: 'node.links_mute',
    label: 'Mute Links',
    description: 'Toggle muting of the links crossed by a drawn line (Ctrl Alt right-drag)',
    undo: false,
    poll: hasTree,
    invoke: (ctx) => {
      editorOf(ctx)!.startGesture('MUTE');
      app.report('INFO', 'Mute Links: drag across links');
      return 'CANCELLED';
    },
  },
  {
    idname: 'node.add_reroute',
    label: 'Add Reroute',
    description: 'Insert reroutes where a drawn line crosses links (Shift right-drag)',
    undo: false,
    poll: hasTree,
    invoke: (ctx) => {
      editorOf(ctx)!.startGesture('REROUTE');
      app.report('INFO', 'Add Reroute: drag across links');
      return 'CANCELLED';
    },
  },
  // --- swap -----------------------------------------------------------------
  {
    idname: 'node.swap_node',
    label: 'Swap Node',
    description: 'Replace the selected nodes with nodes of another type, keeping their links',
    props: [
      { id: 'type', type: 'string', default: '', hidden: true },
      { id: 'settings', type: 'string', default: '{}', hidden: true },
    ],
    poll: hasSelection,
    exec: (ctx, p) => {
      const { tree } = treeOf(ctx)!;
      const type = String(p.type);
      if (!getNodeType(type)) return 'CANCELLED';
      let settings: Record<string, SocketValue> = {};
      try {
        settings = JSON.parse(String(p.settings || '{}'));
      } catch {
        settings = {};
      }
      const sctx = ctxOf(app.doc, tree);
      let n = 0;
      for (const node of selected(tree)) {
        if (isFrame(node) && type !== 'NodeFrame') continue;
        if (node.type === type && JSON.stringify(settings) === '{}') continue;
        if (swapNode(sctx, node, type, settings)) n++;
      }
      if (!n) return 'CANCELLED';
    },
  },
  // --- viewing results ------------------------------------------------------
  {
    idname: 'node.link_viewer',
    label: 'Link to Viewer Node',
    description: 'Show the node’s result: link it to a viewer, cycling through its outputs (Ctrl Shift click)',
    props: [{ id: 'node', type: 'string', default: '', hidden: true }],
    poll: hasTree,
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const n = nodeById(tree, String(p.node || '') || tree.active_node || '');
      if (!n) return 'CANCELLED';
      if (ed.provider.linkViewer) return ed.provider.linkViewer(ed, n) ? 'FINISHED' : 'CANCELLED';
      return connectOutput(ed, tree, n) ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'node.connect_to_output',
    label: 'Connect to Output',
    description: 'Connect the node to the tree’s output, cycling through its outputs (Shift Alt click)',
    props: [{ id: 'node', type: 'string', default: '', hidden: true }],
    poll: hasActive,
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const n = nodeById(tree, String(p.node || '') || tree.active_node || '');
      if (!n || !connectOutput(ed, tree, n)) return 'CANCELLED';
    },
  },
  {
    idname: 'node.viewer_shortcut_set',
    label: 'Set Viewer Shortcut',
    description: 'Remember the selected node under a number key (Ctrl 1…9); the number key views it again',
    props: [{ id: 'viewer_index', type: 'int', default: 1, min: 1, max: 9 }],
    poll: (ctx) => !!editorOf(ctx)?.provider.linkViewer && hasActive(ctx),
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const n = activeNode(tree)!;
      const k = Number(p.viewer_index);
      for (const o of tree.nodes) if (o.viewer_shortcut === k) delete o.viewer_shortcut;
      n.viewer_shortcut = k;
      ed.provider.linkViewer!(ed, n);
      app.report('INFO', `Viewer shortcut ${k}: ${n.label || n.name}`);
    },
  },
  {
    idname: 'node.viewer_shortcut_get',
    label: 'View Shortcut Node',
    description: 'View the node remembered under this number key',
    props: [{ id: 'viewer_index', type: 'int', default: 1, min: 1, max: 9 }],
    poll: (ctx) => !!editorOf(ctx)?.provider.linkViewer && hasTree(ctx),
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const n = tree.nodes.find((o) => o.viewer_shortcut === Number(p.viewer_index));
      if (!n) return 'CANCELLED';
      return ed.provider.linkViewer!(ed, n) ? 'FINISHED' : 'CANCELLED';
    },
  },
  // --- transform ------------------------------------------------------------
  {
    idname: 'node.rotate',
    label: 'Rotate',
    description: 'Rotate the positions of the selected nodes around their centre',
    poll: hasSelection,
    invoke: (ctx) => {
      const { ed, tree } = treeOf(ctx)!;
      ed.startGrab(
        selected(tree).map((n) => n.id),
        'key',
        'Rotate',
        undefined,
        undefined,
        { kind: 'ROTATE' },
      );
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'node.scale',
    label: 'Scale',
    description: 'Spread or gather the selected nodes around their centre',
    poll: hasSelection,
    invoke: (ctx) => {
      const { ed, tree } = treeOf(ctx)!;
      ed.startGrab(
        selected(tree).map((n) => n.id),
        'key',
        'Scale',
        undefined,
        undefined,
        { kind: 'SCALE' },
      );
      return 'RUNNING_MODAL';
    },
  },
];

/** Connect a node to the output of the edited tree (material, world or group output). */
function connectOutput(ed: NodeEditor, tree: NodeTreeData, n: NodeData): boolean {
  const t = ed.treeType();
  const target = ed.path.length || t === 'GEOMETRY' || t === 'COMPOSITOR' ? 'GROUP' : t === 'WORLD' ? 'WORLD' : 'MATERIAL';
  const link = connectToOutput(ctxOf(app.doc, tree), n, target);
  if (!link) {
    app.report('WARNING', 'Nothing to connect to the output');
    return false;
  }
  return true;
}

registerOperators(ops);
