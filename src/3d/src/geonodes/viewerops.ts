// Viewer node activation from operators: activate the selected viewer, deactivate, or toggle the
// viewer under the pointer / the active one (the viewer node's eye button does the same).
import { app, registerOperators, type OpContext } from '../app/app';
import type { NodeData, NodeTreeData } from '../data/types';
import { nodeById } from '../nodes/tree';
import { VIEWER, isActiveViewer } from './nodes/output';
import { activateViewer } from './editor';

function geoTree(ctx: OpContext): { tree: NodeTreeData; ed: { hitNode?(x: number, y: number, frames?: boolean): NodeData | null } } | null {
  const ed = ctx.area?.editor as { tree?: () => NodeTreeData | null; hitNode?(x: number, y: number, frames?: boolean): NodeData | null } | undefined;
  const tree = typeof ed?.tree === 'function' ? ed.tree() : null;
  return tree?.type === 'GEOMETRY' ? { tree, ed: ed! } : null;
}
const viewers = (tree: NodeTreeData) => tree.nodes.filter((n) => n.type === VIEWER);
const selectedViewer = (tree: NodeTreeData) => {
  const a = tree.active_node ? nodeById(tree, tree.active_node) : undefined;
  return a?.type === VIEWER && a.select ? a : viewers(tree).find((n) => n.select);
};

registerOperators([
  {
    idname: 'node.activate_viewer',
    label: 'Activate Viewer Node',
    description: 'Show the selected viewer node in the viewport and the spreadsheet',
    poll: (ctx) => {
      const t = geoTree(ctx);
      return !!t && !!selectedViewer(t.tree);
    },
    exec: (ctx) => {
      const { tree } = geoTree(ctx)!;
      activateViewer(tree, selectedViewer(tree)!);
      app.changed('doc');
    },
  },
  {
    idname: 'node.deactivate_viewer',
    label: 'Deactivate Viewer Node',
    description: 'Stop showing the active viewer node',
    poll: (ctx) => {
      const t = geoTree(ctx);
      return !!t && viewers(t.tree).some(isActiveViewer);
    },
    exec: (ctx) => {
      activateViewer(geoTree(ctx)!.tree, null);
      app.changed('doc');
    },
  },
  {
    idname: 'node.toggle_viewer',
    label: 'Toggle Viewer Node',
    description: 'Show or stop showing the viewer node under the pointer (or the active one)',
    poll: (ctx) => {
      const t = geoTree(ctx);
      return !!t && viewers(t.tree).length > 0;
    },
    exec: (ctx) => {
      const { tree, ed } = geoTree(ctx)!;
      const hit = ed.hitNode?.(app.pointer.x, app.pointer.y, false);
      const v = hit?.type === VIEWER ? hit : (selectedViewer(tree) ?? viewers(tree)[0]);
      if (!v) return 'CANCELLED';
      activateViewer(tree, isActiveViewer(v) ? null : v);
      app.changed('doc');
    },
  },
]);
