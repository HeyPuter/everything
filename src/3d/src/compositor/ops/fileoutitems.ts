// File Output node inputs as a list: the sidebar list (add, remove, reorder, rename) and the
// node.file_output_item_add / _remove / _move operators.
import { h } from '../../ui/h';
import { app, registerOperators, type OpContext } from '../../app/app';
import type { NodeData, NodeTreeData } from '../../data/types';
import { getNodeType } from '../../nodes/registry';
import { nodeById } from '../../nodes/tree';
import { uiList } from '../../editors/properties/uilist';
import { fileSlots } from './fileoutput';

const TYPE = 'CompositorNodeOutputFile';

const setSlots = (n: NodeData, list: string[]) => (n.props.file_slots = list.join('\n'));
export const activeSlot = (n: NodeData) => Math.max(0, Math.min(fileSlots(n).length - 1, Number(n.props.active_index ?? 0) || 0));

/** Add an input (named after `name`, made unique). Returns its name. */
export function addSlot(n: NodeData, name = 'Image'): string {
  const slots = fileSlots(n);
  const base = name.trim().replace(/\n/g, ' ') || 'Image';
  let nm = base;
  for (let k = 1; slots.includes(nm); k++) nm = `${base}_${String(k).padStart(3, '0')}`;
  setSlots(n, [...slots, nm]);
  n.props.active_index = slots.length;
  return nm;
}

/** Remove the active input and its link (the node keeps at least one input). */
export function removeSlot(tree: NodeTreeData, n: NodeData): boolean {
  const slots = fileSlots(n);
  if (slots.length <= 1) return false;
  const i = activeSlot(n);
  tree.links = tree.links.filter((l) => !(l.to_node === n.id && l.to_socket === slots[i]));
  setSlots(
    n,
    slots.filter((_, k) => k !== i),
  );
  n.props.active_index = Math.max(0, i - 1);
  return true;
}

export function moveSlot(n: NodeData, d: number): boolean {
  const slots = fileSlots(n);
  const i = activeSlot(n),
    j = i + d;
  if (j < 0 || j >= slots.length) return false;
  [slots[i], slots[j]] = [slots[j], slots[i]];
  setSlots(n, slots);
  n.props.active_index = j;
  return true;
}

/** Rename an input, keeping its link. */
export function renameSlot(tree: NodeTreeData, n: NodeData, i: number, name: string): boolean {
  const slots = fileSlots(n);
  const nm = name.trim().replace(/\n/g, ' ');
  if (!nm || slots[i] === undefined || (nm !== slots[i] && slots.includes(nm))) return false;
  for (const l of tree.links) if (l.to_node === n.id && l.to_socket === slots[i]) l.to_socket = nm;
  slots[i] = nm;
  setSlots(n, slots);
  return true;
}

{
  const d = getNodeType(TYPE);
  if (d)
    d.drawOptions = (ctx) => {
      const n = ctx.node;
      const slots = fileSlots(n);
      return h(
        'div',
        { class: 'gn-items gn-zone-items' },
        h('div', { class: 'sub-label' }, 'Inputs'),
        uiList(
          `${ctx.key}:file_slots`,
          slots.map((s, i) => ({ key: `${i}:${s}`, label: s, icon: 'file_image' })),
          activeSlot(n),
          (i) => {
            n.props.active_index = i;
            app.changed('ui');
          },
          {
            add: () => (addSlot(n), ctx.changed('Add Input', true)),
            remove: slots.length > 1 ? () => removeSlot(ctx.tree, n) && ctx.changed('Remove Input', true) : undefined,
            rename: (i, name) => renameSlot(ctx.tree, n, i, name) && ctx.changed('Rename Input', true),
            up: () => moveSlot(n, -1) && ctx.changed('Move Input', true),
            down: () => moveSlot(n, 1) && ctx.changed('Move Input', true),
            rows: 3,
          },
        ),
      );
    };
}

function target(ctx: OpContext): { tree: NodeTreeData; node: NodeData } | null {
  const ed = ctx.area?.editor as { tree?: () => NodeTreeData | null } | undefined;
  const tree = typeof ed?.tree === 'function' ? ed.tree() : null;
  const node = tree?.active_node ? nodeById(tree, tree.active_node) : undefined;
  return tree && node?.type === TYPE ? { tree, node } : null;
}

registerOperators([
  {
    idname: 'node.file_output_item_add',
    label: 'Add File Output Input',
    description: 'Add an input to the active File Output node; each input is saved as its own file',
    props: [{ id: 'name', label: 'Name', type: 'string', default: 'Image' }],
    poll: (ctx) => !!target(ctx),
    exec: (ctx, p) => {
      addSlot(target(ctx)!.node, String(p.name ?? 'Image'));
      app.changed('doc');
    },
  },
  {
    idname: 'node.file_output_item_remove',
    label: 'Remove File Output Input',
    description: 'Remove the active input of the File Output node',
    poll: (ctx) => {
      const t = target(ctx);
      return !!t && fileSlots(t.node).length > 1;
    },
    exec: (ctx) => {
      const t = target(ctx)!;
      if (!removeSlot(t.tree, t.node)) return 'CANCELLED';
      app.changed('doc');
    },
  },
  {
    idname: 'node.file_output_item_move',
    label: 'Move File Output Input',
    description: 'Move the active input of the File Output node up or down',
    props: [
      {
        id: 'direction',
        label: 'Direction',
        type: 'enum',
        default: 'UP',
        items: [
          ['UP', 'Up'],
          ['DOWN', 'Down'],
        ],
      },
    ],
    poll: (ctx) => {
      const t = target(ctx);
      return !!t && fileSlots(t.node).length > 1;
    },
    exec: (ctx, p) => {
      if (!moveSlot(target(ctx)!.node, p.direction === 'DOWN' ? 1 : -1)) return 'CANCELLED';
      app.changed('doc');
    },
  },
]);
