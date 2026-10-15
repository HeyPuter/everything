// node.* operators and the Node Editor keymap.
import { registerOperators, app, type OpContext, type Operator } from '../../app/app';
import { addKeys } from '../../app/keymap';
import { openMenu, openPie, openSearch, promptText } from '../../ui/menu';
import { contextMenuItems, selectGroupedItems, separateItems } from './menus';
import type { LinkData, NodeData, NodeTreeData } from '../../data/types';
import { uid } from '../../data/defaults';
import { NodeEditor } from './editor';
import { ctxOf, dissolveNodes, groupContains, internalLinks, joinInFrame, makeGroup, removeNodes, toggleHiddenSockets, ungroup, uniqueNodeName, nodeById } from '../tree';
import { getNodeType, nodeLabel } from '../registry';

export function nodeEditorOf(ctx: OpContext): NodeEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof NodeEditor ? ed : null;
}

function treeOf(ctx: OpContext): { ed: NodeEditor; tree: NodeTreeData } | null {
  const ed = nodeEditorOf(ctx);
  const tree = ed?.tree();
  return ed && tree ? { ed, tree } : null;
}

const hasTree = (ctx: OpContext) => !!treeOf(ctx);
const hasSelection = (ctx: OpContext) => !!treeOf(ctx)?.tree.nodes.some((n) => n.select);
const selected = (tree: NodeTreeData) => tree.nodes.filter((n) => n.select);

/** Node clipboard (shared between editors of the same tree kind). */
let clipboard: {
  type: NodeTreeData['type'];
  nodes: NodeData[];
  links: LinkData[];
} | null = null;

function copyToClipboard(tree: NodeTreeData): number {
  const ids = new Set(selected(tree).map((n) => n.id));
  clipboard = {
    type: tree.type,
    nodes: structuredClone(selected(tree)),
    links: structuredClone(tree.links.filter((l) => ids.has(l.from_node) && ids.has(l.to_node))),
  };
  return ids.size;
}

function linked(tree: NodeTreeData, start: Set<string>, upstream: boolean) {
  const out = new Set<string>();
  for (const l of tree.links) {
    if (upstream && start.has(l.to_node)) out.add(l.from_node);
    if (!upstream && start.has(l.from_node)) out.add(l.to_node);
  }
  return out;
}

const ops: Operator[] = [
  {
    idname: 'node.add_menu',
    label: 'Add Node',
    undo: false,
    poll: hasTree,
    invoke: (ctx) => {
      const ed = nodeEditorOf(ctx)!;
      const at = { x: app.pointer.x, y: app.pointer.y };
      // typing in the Add menu searches all nodes
      openMenu(ed.addMenuItems(at), at, { title: 'Add', onType: (ch) => ed.addSearch(at, ch) });
      return 'CANCELLED';
    },
  },
  {
    idname: 'node.add_search',
    label: 'Search Nodes',
    undo: false,
    poll: hasTree,
    invoke: (ctx) => {
      nodeEditorOf(ctx)!.addSearch({ x: app.pointer.x, y: app.pointer.y });
      return 'CANCELLED';
    },
  },
  {
    idname: 'node.add_node',
    label: 'Add Node',
    description: 'Add a node to the active tree',
    props: [
      { id: 'type', type: 'string', default: '', hidden: true },
      { id: 'settings', type: 'string', default: '{}', hidden: true },
    ],
    undo: false,
    poll: hasTree,
    invoke: (ctx, p) => {
      const ed = nodeEditorOf(ctx)!;
      let settings: Record<string, unknown> = {};
      try {
        settings = JSON.parse(String(p.settings || '{}'));
      } catch {
        settings = {};
      }
      if (!getNodeType(String(p.type))) {
        app.report('ERROR', `Unknown node type ${p.type}`);
        return 'CANCELLED';
      }
      ed.addNodeInteractive(String(p.type), settings);
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'node.select_all',
    label: '(De)select All',
    undo: false,
    props: [
      {
        id: 'action',
        type: 'enum',
        default: 'TOGGLE',
        items: [
          ['TOGGLE', 'Toggle'],
          ['SELECT', 'Select'],
          ['DESELECT', 'Deselect'],
          ['INVERT', 'Invert'],
        ],
      },
    ],
    poll: hasTree,
    exec: (ctx, p) => {
      const { tree } = treeOf(ctx)!;
      let action = p.action as string;
      if (action === 'TOGGLE') action = tree.nodes.some((n) => n.select) ? 'DESELECT' : 'SELECT';
      for (const n of tree.nodes) n.select = action === 'SELECT' ? true : action === 'DESELECT' ? false : !n.select;
      app.changed('ui');
    },
  },
  {
    idname: 'node.select_box',
    label: 'Box Select',
    description: 'Select nodes inside a rectangle dragged with the mouse',
    undo: false,
    props: [
      {
        id: 'mode',
        type: 'enum',
        default: 'ADD',
        items: [
          ['SET', 'Set'],
          ['ADD', 'Extend'],
          ['SUB', 'Subtract'],
        ],
        hidden: true,
      },
    ],
    poll: hasTree,
    invoke: (ctx, p) => {
      nodeEditorOf(ctx)!.startBoxSelect(p.mode === 'SET' || p.mode === 'SUB' ? p.mode : undefined);
      app.report('INFO', 'Box Select: drag to select (Shift to deselect)');
      return 'CANCELLED';
    },
  },
  {
    idname: 'node.select_linked_from',
    label: 'Select Linked From',
    description: 'Select nodes linked from the selected ones',
    undo: false,
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      const add = linked(tree, new Set(selected(tree).map((n) => n.id)), true);
      for (const n of tree.nodes) if (add.has(n.id)) n.select = true;
      app.changed('ui');
    },
  },
  {
    idname: 'node.select_linked_to',
    label: 'Select Linked To',
    description: 'Select nodes linked to the selected ones',
    undo: false,
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      const add = linked(tree, new Set(selected(tree).map((n) => n.id)), false);
      for (const n of tree.nodes) if (add.has(n.id)) n.select = true;
      app.changed('ui');
    },
  },
  {
    idname: 'node.find_node',
    label: 'Find Node',
    description: 'Search for a node by name and focus and select it',
    undo: false,
    poll: hasTree,
    invoke: (ctx) => {
      const { ed, tree } = treeOf(ctx)!;
      openSearch(
        () =>
          tree.nodes.map((n) => ({
            label: n.label ? `${n.label} (${n.name})` : n.name,
            path: getNodeType(n.type)?.label,
            run: () => {
              ed.selectOnly(tree, n);
              app.changed('ui');
              requestAnimationFrame(() => ed.viewAll(true));
            },
          })),
        app.pointer.x - 150,
        app.pointer.y - 20,
        'Find node…',
      );
      return 'CANCELLED';
    },
  },
  {
    idname: 'node.translate_attach',
    label: 'Move',
    description: 'Move nodes and attach them to frames',
    poll: hasSelection,
    invoke: (ctx) => {
      const { ed, tree } = treeOf(ctx)!;
      ed.startGrab(
        selected(tree).map((n) => n.id),
        'key',
        'Move',
      );
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'node.delete',
    label: 'Delete',
    description: 'Remove selected nodes',
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      removeNodes(tree, new Set(selected(tree).map((n) => n.id)));
    },
  },
  {
    idname: 'node.delete_reconnect',
    label: 'Delete with Reconnect',
    description: 'Remove nodes and reconnect nodes as if deletion was muted',
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      dissolveNodes(ctxOf(app.doc, tree), new Set(selected(tree).map((n) => n.id)));
    },
  },
  {
    idname: 'node.links_detach',
    label: 'Detach Links',
    description: 'Remove all links to selected nodes, and try to connect neighbor nodes together',
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      const sctx = ctxOf(app.doc, tree);
      const ids = new Set(selected(tree).map((n) => n.id));
      const add: LinkData[] = [];
      for (const n of selected(tree)) {
        for (const [inp, out] of internalLinks(sctx, n)) {
          const src = tree.links.find((l) => l.to_node === n.id && l.to_socket === inp.identifier && !ids.has(l.from_node));
          if (!src) continue;
          for (const dst of tree.links.filter((l) => l.from_node === n.id && l.from_socket === out.identifier && !ids.has(l.to_node)))
            add.push({
              id: uid('link'),
              from_node: src.from_node,
              from_socket: src.from_socket,
              to_node: dst.to_node,
              to_socket: dst.to_socket,
            });
        }
      }
      tree.links = tree.links.filter((l) => ids.has(l.from_node) === ids.has(l.to_node));
      tree.links.push(...add);
    },
  },
  {
    idname: 'node.hide_toggle',
    label: 'Collapse',
    description: 'Toggle collapsing of selected nodes',
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      const sel = selected(tree);
      const hide = !sel.every((n) => n.hide);
      for (const n of sel) n.hide = hide;
    },
  },
  {
    idname: 'node.hide_socket_toggle',
    label: 'Toggle Hidden Node Sockets',
    description: 'Toggle unused node socket display',
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      const sctx = ctxOf(app.doc, tree);
      const sel = selected(tree);
      const anyHidden = sel.some((n) => n.hidden_sockets?.length);
      for (const n of sel) {
        if (anyHidden) n.hidden_sockets = [];
        else toggleHiddenSockets(sctx, n);
      }
    },
  },
  {
    idname: 'node.mute_toggle',
    label: 'Toggle Node Mute',
    description: 'Toggle muting of selected nodes',
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      for (const n of selected(tree)) if (!getNodeType(n.type)?.layout && n.type !== 'NodeGroupInput' && n.type !== 'NodeGroupOutput') n.mute = !n.mute;
    },
  },
  {
    idname: 'node.options_toggle',
    label: 'Toggle Node Options',
    description: 'Toggle option buttons display for selected nodes',
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      const sel = selected(tree);
      const hide = !sel.every((n) => n.hide_options);
      for (const n of sel) n.hide_options = hide;
    },
  },
  {
    idname: 'node.join',
    label: 'Join Nodes in Frame',
    description: 'Attach selected nodes to a new common frame',
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      const f = joinInFrame(
        tree,
        selected(tree).map((n) => n.id),
      );
      if (!f) return 'CANCELLED';
      for (const n of tree.nodes) n.select = false;
      f.select = true;
      tree.active_node = f.id;
    },
  },
  {
    idname: 'node.group_make',
    label: 'Make Group',
    description: 'Make group from selected nodes',
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      const g = makeGroup(app.doc, tree, new Set(selected(tree).map((n) => n.id)));
      if (!g) return 'CANCELLED';
    },
  },
  {
    idname: 'node.group_ungroup',
    label: 'Ungroup',
    description: 'Ungroup selected group nodes',
    poll: (ctx) => !!treeOf(ctx)?.tree.nodes.some((n) => n.select && n.props.node_tree && getNodeType(n.type)?.dynamicSockets),
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      for (const n of selected(tree).filter((x) => x.props.node_tree && getNodeType(x.type)?.dynamicSockets)) ungroup(app.doc, tree, n.id);
    },
  },
  {
    idname: 'node.group_edit',
    label: 'Edit Group',
    description: 'Edit node group (Tab enters the active group node, or exits the current group)',
    undo: false,
    props: [{ id: 'exit', type: 'bool', default: false }],
    poll: hasTree,
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const act = tree.active_node ? nodeById(tree, tree.active_node) : undefined;
      const gid = act?.select && act.props.node_tree && getNodeType(act.type)?.dynamicSockets ? (act.props.node_tree as string) : null;
      if (!p.exit && gid && app.doc.node_groups[gid]) ed.path.push({ group: gid, node: act!.id });
      else if (ed.path.length) ed.path.pop();
      else return 'CANCELLED';
      app.changed('ui');
    },
  },
  {
    idname: 'node.tree_path_parent',
    label: 'Parent Node Tree',
    description: 'Go to parent node tree',
    undo: false,
    poll: (ctx) => !!nodeEditorOf(ctx)?.path.length,
    exec: (ctx) => {
      nodeEditorOf(ctx)!.path.pop();
      app.changed('ui');
    },
  },
  {
    idname: 'node.view_all',
    label: 'Frame All',
    description: 'Resize view so you can see all nodes',
    undo: false,
    poll: hasTree,
    exec: (ctx) => nodeEditorOf(ctx)!.viewAll(false),
  },
  {
    idname: 'node.view_selected',
    label: 'Frame Selected',
    description: 'Resize view so you can see selected nodes',
    undo: false,
    poll: hasTree,
    exec: (ctx) => nodeEditorOf(ctx)!.viewAll(true),
  },
  {
    idname: 'node.zoom',
    label: 'Zoom',
    undo: false,
    props: [{ id: 'factor', type: 'float', default: 1.25 }],
    poll: (ctx) => !!nodeEditorOf(ctx),
    exec: (ctx, p) => nodeEditorOf(ctx)!.zoomBy(Number(p.factor) || 1.25),
  },
  {
    idname: 'node.toggle_overlays',
    label: 'Show Overlays',
    description: 'Toggle wire colors, reroute labels and the context path',
    undo: false,
    poll: (ctx) => !!nodeEditorOf(ctx),
    exec: (ctx) => nodeEditorOf(ctx)!.toggleOverlays(),
  },
  {
    idname: 'node.toggle_snap',
    label: 'Snap',
    description: 'Toggle snapping nodes to the grid while moving and resizing them',
    undo: false,
    poll: (ctx) => !!nodeEditorOf(ctx),
    exec: (ctx) => nodeEditorOf(ctx)!.toggleSnap(),
  },
  {
    idname: 'node.toggle_toolbar',
    label: 'Toolbar',
    undo: false,
    poll: (ctx) => !!nodeEditorOf(ctx),
    exec: (ctx) => nodeEditorOf(ctx)!.toggleToolbar(),
  },
  {
    idname: 'node.toggle_sidebar',
    label: 'Sidebar',
    undo: false,
    poll: (ctx) => !!nodeEditorOf(ctx),
    exec: (ctx) => nodeEditorOf(ctx)!.toggleSidebar(),
  },
  {
    idname: 'node.clipboard_copy',
    label: 'Copy to Clipboard',
    description: 'Copy the selected nodes to the internal clipboard',
    undo: false,
    poll: hasSelection,
    exec: (ctx) => {
      const n = copyToClipboard(treeOf(ctx)!.tree);
      app.report('INFO', `Copied ${n} node${n === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'node.delete_copy_reconnect',
    label: 'Cut',
    description: 'Copy the selected nodes to the clipboard, then delete them and reconnect their neighbours',
    poll: hasSelection,
    exec: (ctx) => {
      const { tree } = treeOf(ctx)!;
      copyToClipboard(tree);
      dissolveNodes(ctxOf(app.doc, tree), new Set(selected(tree).map((n) => n.id)));
    },
  },
  {
    idname: 'node.clipboard_paste',
    label: 'Paste from Clipboard',
    description: 'Paste nodes from the internal clipboard to the active node tree',
    poll: (ctx) => hasTree(ctx) && !!clipboard?.nodes.length,
    exec: (ctx) => {
      const { ed, tree } = treeOf(ctx)!;
      const cb = clipboard!;
      const kind = (t: string) => (t === 'WORLD' ? 'SHADER' : t);
      if (kind(cb.type) !== kind(tree.type)) {
        app.report('ERROR', 'Clipboard nodes belong to a different kind of node tree');
        return 'CANCELLED';
      }
      // group input / output nodes only make sense inside node groups
      const cur = ed.currentGroupId();
      // a group cannot be pasted into itself (directly or nested)
      const recursive = (n: NodeData) => {
        const ref = n.props.node_tree as string | undefined;
        const g = ref ? app.doc.node_groups[ref] : undefined;
        return !!cur && !!g && (g.id === cur || groupContains(app.doc, g, cur));
      };
      const nodes = cb.nodes.filter((n) => (cur || (n.type !== 'NodeGroupInput' && n.type !== 'NodeGroupOutput')) && !recursive(n));
      if (nodes.length < cb.nodes.length) app.report('WARNING', 'Some nodes cannot be pasted here (group inputs / outputs outside groups, or a group into itself)');
      if (!nodes.length) return 'CANCELLED';
      const [px, py] = ed.toNode(app.pointer.x, app.pointer.y);
      const cx = nodes.reduce((s, n) => s + n.location[0], 0) / nodes.length,
        cy = nodes.reduce((s, n) => s + n.location[1], 0) / nodes.length;
      const map = new Map<string, string>();
      for (const n of tree.nodes) n.select = false;
      for (const src of nodes) {
        const n = structuredClone(src);
        n.id = uid('node');
        n.name = uniqueNodeName(tree, src.name);
        n.location = [src.location[0] - cx + px, src.location[1] - cy - py];
        n.select = true;
        map.set(src.id, n.id);
        tree.nodes.push(n);
      }
      for (const n of tree.nodes) if (n.select && n.parent) n.parent = map.get(n.parent) ?? null;
      for (const l of cb.links.filter((x) => map.has(x.from_node) && map.has(x.to_node)))
        tree.links.push({
          ...l,
          id: uid('link'),
          from_node: map.get(l.from_node)!,
          to_node: map.get(l.to_node)!,
        });
    },
  },
  {
    idname: 'node.rename',
    label: 'Rename Node',
    description: 'Set the label of the active node',
    undo: false,
    poll: (ctx) => !!treeOf(ctx)?.tree.active_node,
    invoke: (ctx) => {
      const { tree } = treeOf(ctx)!;
      const n = nodeById(tree, tree.active_node!);
      if (!n) return 'CANCELLED';
      promptText('Label', n.label || nodeLabel(n), (v) => {
        n.label = v === nodeLabel({ ...n, label: '' }) ? '' : v;
        app.pushUndo('Rename Node');
        app.changed('doc');
      });
      return 'CANCELLED';
    },
  },
];

registerOperators(ops);

/** The node editor under the pointer (for menu keys). */
function hoverEditor(): NodeEditor | null {
  const ed = (app.hoverArea ?? app.activeArea)?.editor;
  return ed instanceof NodeEditor ? ed : null;
}
const inTree = () => !!hoverEditor()?.tree();

addKeys('Node Editor', [
  { key: 'A', shift: true, op: 'node.add_menu' },
  {
    key: 'S',
    shift: true,
    when: () => inTree() && !!hoverEditor()?.selectedIds().length,
    action: () => {
      const ed = hoverEditor()!;
      openMenu(ed.swapMenuItems(), { x: app.pointer.x, y: app.pointer.y }, { title: 'Swap', onType: (ch) => ed.swapSearch(ch) });
    },
  },
  { key: 'A', op: 'node.select_all', props: { action: 'SELECT' } },
  { key: 'A', alt: true, op: 'node.select_all', props: { action: 'DESELECT' } },
  { key: 'I', ctrl: true, op: 'node.select_all', props: { action: 'INVERT' } },
  { key: 'B', op: 'node.select_box' },
  { key: 'C', op: 'node.select_circle' },
  { key: 'L', op: 'node.select_linked_from' },
  { key: 'L', shift: true, op: 'node.select_linked_to' },
  { key: 'G', shift: true, menu: () => selectGroupedItems(), menuTitle: 'Select Grouped', when: () => !!hoverEditor()?.tree()?.active_node },
  { key: 'G', shift: true, ctrl: true, menu: () => selectGroupedItems(true), menuTitle: 'Select Grouped', when: () => !!hoverEditor()?.tree()?.active_node },
  { key: 'RIGHT_BRACKET', shift: true, op: 'node.select_same_type_step', props: { prev: false } },
  { key: 'LEFT_BRACKET', shift: true, op: 'node.select_same_type_step', props: { prev: true } },
  { key: 'F', ctrl: true, op: 'node.find_node' },
  { key: 'G', op: 'node.translate_attach' },
  { key: 'R', op: 'node.rotate' },
  { key: 'S', op: 'node.scale' },
  { key: 'D', shift: true, op: 'node.duplicate_move' },
  { key: 'D', alt: true, op: 'node.duplicate_move_linked' },
  { key: 'D', shift: true, ctrl: true, op: 'node.duplicate_move_keep_inputs' },
  { key: 'X', op: 'node.delete' },
  { key: 'DEL', op: 'node.delete' },
  { key: 'X', ctrl: true, op: 'node.delete_reconnect' },
  { key: 'DEL', ctrl: true, op: 'node.delete_reconnect' },
  { key: 'J', op: 'node.link_make', props: { replace: false } },
  { key: 'J', shift: true, op: 'node.link_make', props: { replace: true } },
  { key: 'F', op: 'node.join_named' },
  { key: 'J', ctrl: true, op: 'node.join_nodes' },
  { key: 'P', ctrl: true, op: 'node.parent_set' },
  { key: 'P', alt: true, op: 'node.detach' },
  { key: 'H', op: 'node.hide_toggle' },
  { key: 'H', ctrl: true, op: 'node.hide_socket_toggle' },
  { key: 'H', shift: true, op: 'node.preview_toggle' },
  { key: 'M', op: 'node.mute_toggle' },
  { key: 'G', ctrl: true, op: 'node.group_make' },
  { key: 'G', ctrl: true, alt: true, op: 'node.group_ungroup' },
  { key: 'P', menu: () => separateItems(), menuTitle: 'Separate', when: () => !!hoverEditor()?.path.length && !!hoverEditor()?.selectedIds().length },
  { key: 'TAB', op: 'node.group_edit', props: { exit: false } },
  { key: 'TAB', ctrl: true, op: 'node.group_edit', props: { exit: true } },
  { key: 'TAB', shift: true, op: 'node.toggle_snap' },
  { key: 'Z', shift: true, alt: true, op: 'node.toggle_overlays' },
  { key: 'HOME', op: 'node.view_all' },
  { key: 'NUMPAD_PERIOD', op: 'node.view_selected' },
  { key: 'NUMPAD_PLUS', op: 'node.zoom', props: { factor: 1.25 } },
  { key: 'NUMPAD_MINUS', op: 'node.zoom', props: { factor: 0.8 } },
  { key: 'EQUAL', ctrl: true, op: 'node.zoom', props: { factor: 1.25 } },
  { key: 'MINUS', ctrl: true, op: 'node.zoom', props: { factor: 0.8 } },
  {
    key: 'ACCENT_GRAVE',
    when: () => !!hoverEditor(),
    action: () => openPie('View', [{ label: 'Frame All', op: 'node.view_all' }, { label: 'Frame Selected', op: 'node.view_selected' }, null, null, null, null, null, null], app.pointer.x, app.pointer.y, 'ACCENT_GRAVE'),
  },
  {
    key: 'W',
    when: () => inTree(),
    action: () => {
      const ed = hoverEditor()!;
      const any = !!ed.selectedIds().length;
      openMenu(contextMenuItems(ed, any), { x: app.pointer.x, y: app.pointer.y }, { title: any ? 'Node' : 'Node Editor' });
    },
  },
  { key: 'C', ctrl: true, op: 'node.clipboard_copy' },
  { key: 'V', ctrl: true, op: 'node.clipboard_paste' },
  { key: 'F2', op: 'node.rename' },
  ...(['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'] as const).flatMap((key, i) => [
    { key, op: 'node.viewer_shortcut_get', props: { viewer_index: i + 1 } },
    { key, ctrl: true, op: 'node.viewer_shortcut_set', props: { viewer_index: i + 1 } },
  ]),
]);

addKeys('Node Generic', [
  { key: 'T', op: 'node.toggle_toolbar' },
  { key: 'N', op: 'node.toggle_sidebar' },
]);
