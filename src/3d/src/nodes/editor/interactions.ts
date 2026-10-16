// Node editor operators for pointer interactions: selecting at a location, attaching to and
// detaching from frames while moving, moving with links detached, resizing, entering groups under
// the pointer, insert offset, duplicating in place and sampling the compositor backdrop. The
// editor's own pointer handling does the same things; these make them available from search,
// keymaps and scripts.
import { app, registerOperators, type OpContext } from '../../app/app';
import type { NodeData, NodeTreeData } from '../../data/types';
import { setPref } from '../../prefs/store';
import { ctxOf, duplicateNodes, nodeById } from '../tree';
import { detachLinks, insertOffset } from '../treeops';
import { getNodeType, nodeEditorSettings } from '../registry';
import { NodeEditor } from './editor';
import { registerIcons } from '../../ui/icons';

registerIcons({
  node_insert_off: '<rect class="s" x="5.5" y="4.5" width="5" height="7" rx="1" fill="none" stroke-width="1.2"/><path class="s" d="M1 8h4M11 8h4" fill="none" stroke-width="1.2"/>',
  node_insert_on:
    '<rect class="s" x="3.5" y="4.5" width="5" height="7" rx="1" fill="none" stroke-width="1.2"/><path class="s" d="M1 8h2.5M8.5 8h6M12 5.5 14.5 8 12 10.5" fill="none" stroke-width="1.2" stroke-linejoin="round"/>',
});

function editorOf(ctx: OpContext): NodeEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof NodeEditor ? ed : null;
}
function treeOf(ctx: OpContext): { ed: NodeEditor; tree: NodeTreeData } | null {
  const ed = editorOf(ctx);
  const tree = ed?.tree();
  return ed && tree ? { ed, tree } : null;
}
const isFrame = (n: NodeData | undefined) => !!n && getNodeType(n.type)?.layout === 'FRAME';
const selected = (tree: NodeTreeData) => tree.nodes.filter((n) => n.select);
const hasTree = (ctx: OpContext) => !!treeOf(ctx);
const hasSelection = (ctx: OpContext) => !!treeOf(ctx)?.tree.nodes.some((n) => n.select);

/** Client coordinates of an operator: the `location` prop (pixels in the editor), else the pointer. */
function pointOf(ed: NodeEditor, p: Record<string, unknown>): { x: number; y: number } {
  const loc = p.location as number[] | undefined;
  if (Array.isArray(loc) && (loc[0] || loc[1])) {
    const r = ed.el.getBoundingClientRect();
    return { x: r.left + loc[0], y: r.top + loc[1] };
  }
  return { x: app.pointer.x, y: app.pointer.y };
}

/** Frame containing a node-space point (the innermost one). */
function frameAt(ed: NodeEditor, tree: NodeTreeData, x: number, y: number, exclude: Set<string>): NodeData | undefined {
  let best: NodeData | undefined;
  let area = Infinity;
  for (const f of tree.nodes) {
    if (!isFrame(f) || exclude.has(f.id)) continue;
    const l = ed.layouts.get(f.id);
    if (!l || x < l.x || x > l.x + l.w || y < l.y || y > l.y + l.h) continue;
    if (l.w * l.h < area) ((best = f), (area = l.w * l.h));
  }
  return best;
}

/** Frames cannot contain themselves (directly or through their children). */
function insideOf(tree: NodeTreeData, n: NodeData, frame: NodeData): boolean {
  for (let p: NodeData | undefined = frame, i = 0; p && i < 64; p = p.parent ? nodeById(tree, p.parent) : undefined, i++) if (p.id === n.id) return true;
  return false;
}

registerOperators([
  {
    idname: 'node.select',
    label: 'Select',
    description: 'Select the node at a location (the pointer when no location is given)',
    undo: true,
    props: [
      { id: 'location', label: 'Location', type: 'vec2', default: [0, 0], hidden: true },
      { id: 'extend', label: 'Extend', type: 'bool', default: false },
      { id: 'deselect', label: 'Deselect', type: 'bool', default: false },
      { id: 'toggle', label: 'Toggle', type: 'bool', default: false },
      { id: 'deselect_all', label: 'Deselect On Nothing', type: 'bool', default: true },
    ],
    poll: hasTree,
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const pt = pointOf(ed, p);
      const n = ed.hitNode(pt.x, pt.y);
      if (!n) {
        if (!p.deselect_all || p.extend || p.toggle) return 'CANCELLED';
        for (const o of tree.nodes) o.select = false;
        app.changed('ui');
        return;
      }
      if (p.toggle) n.select = !(n.select && tree.active_node === n.id);
      else if (p.deselect) n.select = false;
      else if (p.extend) n.select = true;
      else ed.selectOnly(tree, n);
      if (n.select) tree.active_node = n.id;
      app.changed('ui');
    },
  },
  {
    idname: 'node.select_link_viewer',
    label: 'Link to Viewer Node',
    description: 'Select the node under the pointer and show its result in a viewer (Ctrl Shift click)',
    poll: (ctx) => !!editorOf(ctx)?.provider.linkViewer && hasTree(ctx),
    exec: (ctx) => {
      const { ed, tree } = treeOf(ctx)!;
      const n = ed.hitNode(app.pointer.x, app.pointer.y, false) ?? (tree.active_node ? nodeById(tree, tree.active_node) : undefined);
      if (!n || isFrame(n)) return 'CANCELLED';
      ed.selectOnly(tree, n);
      return app.run('node.link_viewer', { node: n.id }, { area: ctx.area }) === 'FINISHED' ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'node.attach',
    label: 'Attach Nodes',
    description: 'Put the selected nodes into the frame under the pointer',
    props: [{ id: 'location', label: 'Location', type: 'vec2', default: [0, 0], hidden: true }],
    poll: hasSelection,
    exec: (ctx, p) => {
      const { ed, tree } = treeOf(ctx)!;
      const pt = pointOf(ed, p);
      const [x, y] = ed.toNode(pt.x, pt.y);
      const sel = selected(tree);
      const frame = frameAt(ed, tree, x, y, new Set(sel.filter(isFrame).map((n) => n.id)));
      if (!frame) {
        app.report('INFO', 'Point at a frame to attach the selected nodes to it');
        return 'CANCELLED';
      }
      let k = 0;
      for (const n of sel) if (n !== frame && !insideOf(tree, n, frame) && n.parent !== frame.id) ((n.parent = frame.id), k++);
      if (!k) return 'CANCELLED';
    },
  },
  {
    idname: 'node.detach_translate_attach',
    label: 'Detach and Move',
    description: 'Take the selected nodes out of their frames and move them; dropping them on a frame attaches them to it',
    poll: hasSelection,
    invoke: (ctx) => {
      const { ed, tree } = treeOf(ctx)!;
      const sel = selected(tree);
      const before = new Map(sel.map((n) => [n.id, n.parent]));
      for (const n of sel) if (n.parent && !sel.some((o) => o.id === n.parent)) delete n.parent;
      ed.render();
      ed.startGrab(
        sel.map((n) => n.id),
        'key',
        'Detach and Move',
        undefined,
        undefined,
        {
          onCancel: () => {
            for (const n of sel) {
              const p = before.get(n.id);
              if (p) n.parent = p;
            }
          },
        },
      );
      return 'RUNNING_MODAL';
    },
  },
  ...(['node.move_detach_links', 'node.move_detach_links_release'] as const).map((idname) => ({
    idname,
    label: 'Detach Links and Move',
    description: 'Remove the links of the selected nodes (joining the nodes around them) and move them (Alt drag)',
    poll: hasSelection,
    invoke: (ctx: OpContext) => {
      const { ed, tree } = treeOf(ctx)!;
      const before = structuredClone(tree.links);
      detachLinks(ctxOf(app.doc, tree), new Set(selected(tree).map((n) => n.id)));
      ed.render();
      ed.startGrab(
        selected(tree).map((n) => n.id),
        idname === 'node.move_detach_links_release' ? 'tweak' : 'key',
        'Detach',
        undefined,
        undefined,
        { onCancel: () => (tree.links = before) },
      );
      return 'RUNNING_MODAL' as const;
    },
  })),
  {
    idname: 'node.resize',
    label: 'Resize Node',
    description: 'Change the width of the active node by moving the pointer (click to confirm, Esc to cancel)',
    poll: (ctx) => {
      const t = treeOf(ctx);
      const n = t?.tree.active_node ? nodeById(t.tree, t.tree.active_node) : undefined;
      return !!n && !n.hide && getNodeType(n.type)?.layout !== 'REROUTE';
    },
    invoke: (ctx) => {
      const { ed, tree } = treeOf(ctx)!;
      const n = nodeById(tree, tree.active_node!)!;
      const def = getNodeType(n.type);
      const frame = isFrame(n);
      const minW = frame ? 40 : (def?.minWidth ?? 80),
        maxW = frame ? 1e5 : (def?.maxWidth ?? 700);
      const w0 = ed.layouts.get(n.id)?.w ?? n.width ?? 140;
      const width0 = n.width;
      const [x0] = ed.toNode(app.pointer.x, app.pointer.y);
      let w = w0;
      app.startModal({
        label: 'Resize Node',
        cursor: 'ew-resize',
        onPointerMove(e) {
          const [x] = ed.toNode(e.clientX, e.clientY);
          const snap = ed.snap !== (e.ctrlKey || e.metaKey);
          w = Math.round(Math.max(minW, Math.min(maxW, w0 + x - x0)));
          if (snap) w = Math.round(w / 10) * 10;
          n.width = w;
          if (frame) n.props.shrink = false;
          ed.render();
        },
        onPointerDown(e) {
          return e.button === 0 ? 'FINISHED' : 'CANCELLED';
        },
        onKey(e) {
          if (e.type !== 'keydown') return;
          if (e.key === 'Escape') return 'CANCELLED';
          if (e.key === 'Enter' || e.key === ' ') return 'FINISHED';
        },
        cancel() {
          n.width = width0;
          ed.render();
        },
        header: () => `Width: ${w}   Resize: LMB/Enter confirm, RMB/Esc cancel, Ctrl snap`,
      });
      return 'RUNNING_MODAL';
    },
  },
  {
    idname: 'node.group_enter_exit',
    label: 'Enter/Exit Group',
    description: 'Edit the node group of the group node under the pointer, or leave the group when there is none',
    undo: false,
    poll: hasTree,
    exec: (ctx) => {
      const { ed, tree } = treeOf(ctx)!;
      const n = ed.hitNode(app.pointer.x, app.pointer.y, false) ?? (tree.active_node ? nodeById(tree, tree.active_node) : undefined);
      if (n && n.props.node_tree && !isFrame(n)) {
        ed.selectOnly(tree, n);
        return app.run('node.group_edit', { exit: false }, { area: ctx.area }) === 'FINISHED' ? 'FINISHED' : 'CANCELLED';
      }
      if (!ed.path.length) return 'CANCELLED';
      return app.run('node.group_edit', { exit: true }, { area: ctx.area }) === 'FINISHED' ? 'FINISHED' : 'CANCELLED';
    },
  },
  {
    idname: 'node.insert_offset',
    label: 'Insert Offset',
    description: 'Move the nodes after the active node to the right so they do not overlap it',
    poll: (ctx) => {
      const t = treeOf(ctx);
      return !!t?.tree.active_node && !!nodeById(t.tree, t.tree.active_node);
    },
    exec: (ctx) => {
      const { ed, tree } = treeOf(ctx)!;
      const n = nodeById(tree, tree.active_node!)!;
      const dx = insertOffset(tree, n, (x) => ed.layouts.get(x.id)?.w ?? x.width ?? 140, nodeEditorSettings.insertMargin);
      if (!dx) return 'CANCELLED';
    },
  },
  {
    idname: 'node.insert_offset_toggle',
    label: 'Auto-offset',
    description: 'Make room automatically when a node is dropped onto a link between two nodes',
    undo: false,
    poll: hasTree,
    exec: () => {
      setPref('node_use_insert_offset', !nodeEditorSettings.insertOffset);
      app.changed('ui');
    },
  },
  {
    idname: 'node.duplicate',
    label: 'Duplicate Nodes',
    description: 'Duplicate the selected nodes in place',
    props: [
      { id: 'keep_inputs', label: 'Keep Inputs', type: 'bool', default: false },
      { id: 'linked', label: 'Linked', type: 'bool', default: true },
    ],
    poll: hasSelection,
    exec: (ctx, p) => {
      const { tree } = treeOf(ctx)!;
      const ids = new Set(selected(tree).map((n) => n.id));
      for (const n of tree.nodes) if (n.parent && ids.has(n.parent)) ids.add(n.id);
      const map = duplicateNodes(tree, ids, [20, -20], !!p.keep_inputs);
      if (!p.linked) {
        // unlinked copies get their own node groups
        for (const c of map.values()) {
          const gid = c.props.node_tree;
          const g = typeof gid === 'string' ? app.doc.node_groups[gid] : undefined;
          if (!g) continue;
          const copy = structuredClone(g);
          copy.id = `${g.id}_${Math.random().toString(36).slice(2, 8)}`;
          let k = 1;
          const names = new Set(Object.values(app.doc.node_groups).map((x) => x.name));
          while (names.has(`${g.name}.${String(k).padStart(3, '0')}`)) k++;
          copy.name = `${g.name}.${String(k).padStart(3, '0')}`;
          app.doc.node_groups[copy.id] = copy;
          c.props.node_tree = copy.id;
        }
      }
      for (const n of tree.nodes) n.select = false;
      for (const c of map.values()) c.select = true;
      const act = tree.active_node ? map.get(tree.active_node) : undefined;
      tree.active_node = act?.id ?? [...map.values()][0]?.id ?? null;
    },
  },
  {
    idname: 'node.backimage_sample',
    label: 'Backimage Sample',
    description: 'Show the color of the compositor backdrop under the pointer while the button is held (Alt click)',
    undo: false,
    poll: (ctx) => typeof (editorOf(ctx) as unknown as { sampleBackdrop?: unknown })?.sampleBackdrop === 'function',
    invoke: (ctx) => {
      (editorOf(ctx) as unknown as { sampleBackdrop(e: { clientX: number; clientY: number }): void }).sampleBackdrop({ clientX: app.pointer.x, clientY: app.pointer.y });
      return 'FINISHED';
    },
  },
]);
