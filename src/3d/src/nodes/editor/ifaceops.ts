// Operators on the interface of the edited node group (the Group tab's socket list): add sockets
// and panels, remove and duplicate items, and panel toggles (a boolean input shown as a checkbox
// in its panel's header).
import { app, registerOperators, type OpContext } from '../../app/app';
import type { NodeTreeData } from '../../data/types';
import { addInterfaceSocket } from '../tree';
import { addInterfacePanel, addPanelToggle, duplicateInterfaceItem, findPanel, findSocketItem, makePanelToggle, removeInterfaceItem, toggleCandidatePanel, unlinkPanelToggle } from '../iface';
import { ifaceState } from './sidebar';

/** Tree of the node editor running the operator, when it is a node group with an interface. */
function groupTree(ctx: OpContext): NodeTreeData | null {
  const ed = ctx.area?.editor as { tree?: () => NodeTreeData | null; path?: unknown[] } | undefined;
  const tree = typeof ed?.tree === 'function' ? ed.tree() : null;
  return tree && (tree.interface || ed?.path?.length) ? tree : null;
}

const active = (_tree: NodeTreeData) => ifaceState.activeKey;
const add = (tree: NodeTreeData) => (io: 'INPUT' | 'OUTPUT', name: string) => addInterfaceSocket(tree, io, name, tree.type === 'GEOMETRY' ? 'GEOMETRY' : 'FLOAT');
/** Panel of the active item (the panel itself, or the panel holding the active input). */
const activePanel = (tree: NodeTreeData) => findPanel(tree, active(tree)) ?? findPanel(tree, String(findSocketItem(tree, active(tree))?.panel ?? ''));

registerOperators([
  {
    idname: 'node.interface_item_new',
    label: 'New Item',
    description: 'Add an input, an output or a panel to the interface of the node group',
    props: [
      {
        id: 'item_type',
        label: 'Item Type',
        type: 'enum',
        default: 'INPUT',
        items: [
          ['INPUT', 'Input'],
          ['OUTPUT', 'Output'],
          ['PANEL', 'Panel'],
        ],
      },
    ],
    poll: (ctx) => !!groupTree(ctx),
    exec: (ctx, p) => {
      const tree = groupTree(ctx)!;
      if (p.item_type === 'PANEL') {
        ifaceState.activeKey = addInterfacePanel(tree).identifier;
      } else {
        const io = p.item_type === 'OUTPUT' ? 'OUTPUT' : 'INPUT';
        const panel = activePanel(tree);
        const it = add(tree)(io, io === 'INPUT' ? 'Input' : 'Output');
        if (tree.type !== 'GEOMETRY') it.default_value = 0;
        if (io === 'INPUT' && panel) it.panel = panel.identifier;
        ifaceState.activeKey = it.identifier;
      }
      app.changed('doc');
    },
  },
  {
    idname: 'node.interface_item_remove',
    label: 'Remove Item',
    description: 'Remove the active socket or panel of the node group interface (a panel’s sockets stay)',
    poll: (ctx) => {
      const t = groupTree(ctx);
      return !!t && (!!findSocketItem(t, active(t)) || !!findPanel(t, active(t)));
    },
    exec: (ctx) => {
      const tree = groupTree(ctx)!;
      if (!removeInterfaceItem(tree, active(tree))) return 'CANCELLED';
      app.changed('doc');
    },
  },
  {
    idname: 'node.interface_item_duplicate',
    label: 'Duplicate Item',
    description: 'Add a copy of the active interface socket right after it',
    poll: (ctx) => {
      const t = groupTree(ctx);
      return !!t && !!findSocketItem(t, active(t));
    },
    exec: (ctx) => {
      const tree = groupTree(ctx)!;
      const copy = duplicateInterfaceItem(tree, active(tree), add(tree));
      if (!copy) return 'CANCELLED';
      ifaceState.activeKey = copy.identifier;
      app.changed('doc');
    },
  },
  {
    idname: 'node.interface_item_new_panel_toggle',
    label: 'Add Panel Toggle',
    description: 'Add a checkbox to the header of the active panel that switches its contents on and off',
    poll: (ctx) => {
      const t = groupTree(ctx);
      const p = t && activePanel(t);
      return !!p && !p.toggle;
    },
    exec: (ctx) => {
      const tree = groupTree(ctx)!;
      if (!addPanelToggle(tree, activePanel(tree)!.identifier, add(tree))) return 'CANCELLED';
      app.changed('doc');
    },
  },
  {
    idname: 'node.interface_item_make_panel_toggle',
    label: 'Make Panel Toggle',
    description: 'Use the active boolean input as the checkbox in its panel’s header',
    poll: (ctx) => {
      const t = groupTree(ctx);
      return !!t && !!toggleCandidatePanel(t, active(t));
    },
    exec: (ctx) => {
      const tree = groupTree(ctx)!;
      if (!makePanelToggle(tree, active(tree))) return 'CANCELLED';
      app.changed('doc');
    },
  },
  {
    idname: 'node.interface_item_unlink_panel_toggle',
    label: 'Unlink Panel Toggle',
    description: 'Make the panel’s header checkbox an ordinary input of the panel again',
    poll: (ctx) => {
      const t = groupTree(ctx);
      return !!t && !!activePanel(t)?.toggle;
    },
    exec: (ctx) => {
      const tree = groupTree(ctx)!;
      if (!unlinkPanelToggle(tree, activePanel(tree)!.identifier)) return 'CANCELLED';
      app.changed('doc');
    },
  },
]);
