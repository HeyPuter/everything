// Compact data-block selector for node bodies (text data-blocks, movie clips, …): a browse menu,
// the current name with an unlink button, or an Open button that loads a file.
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { openMenu } from '../../ui/menu';
import type { NodeData } from '../../data/types';
import { nodeChanged } from './nodeui';

export interface IdSelectOptions {
  /** items to choose from */
  items: () => { id: string; name: string }[];
  icon: string;
  /** e.g. "Text" — used in tooltips */
  kind: string;
  /** file types for the Open button (omit to hide it) */
  accept?: string;
  /** import a picked file, returning the new data-block id */
  open?: (f: File) => Promise<string | null>;
}

export function idSelector(node: NodeData, propId: string, o: IdSelectOptions): Child {
  const items = o.items();
  const cur = node.props[propId] as string | null | undefined;
  const sel = cur ? items.find((i) => i.id === cur) : undefined;
  const set = (v: string | null, label: string) => {
    node.props[propId] = v;
    nodeChanged(label);
  };
  return h(
    'div',
    { class: 'nd-image-sel' },
    h(
      'button',
      {
        class: 'nd-ids-browse',
        'data-tip': `Browse ${o.kind} to be linked`,
        onpointerdown: (e: PointerEvent) => {
          e.preventDefault();
          openMenu(
            items.length
              ? items.map((i) => ({ label: i.name, icon: o.icon, active: i.id === cur, action: () => set(i.id, `Assign ${o.kind}`) }))
              : [{ label: `No ${o.kind.toLowerCase()} data-blocks`, disabled: true }],
            e.currentTarget as HTMLElement,
          );
        },
      },
      icon(o.icon),
      icon('down_arrow_hlt', 'tiny'),
    ),
    sel
      ? [
          h('span', { class: 'nd-ids-name', title: sel.name }, sel.name),
          h('button', { class: 'nd-ids-btn', 'data-tip': `Unlink ${o.kind.toLowerCase()}`, onclick: () => set(null, `Unlink ${o.kind}`) }, icon('x')),
        ]
      : o.open
        ? h(
            'button',
            {
              class: 'nd-ids-open',
              'data-tip': `Open ${o.kind}\nLoad a file from disk`,
              onclick: () => {
                const input = document.createElement('input');
                input.type = 'file';
                if (o.accept) input.accept = o.accept;
                input.onchange = async () => {
                  const f = input.files?.[0];
                  if (!f) return;
                  const id = await o.open!(f);
                  if (id) set(id, `Open ${o.kind}`);
                };
                input.click();
              },
            },
            icon('file_folder'),
            'Open',
          )
        : h('span', { class: 'nd-ids-name prop-note' }, 'None'),
  );
}

/** Name not used by any data-block in `table` (".001" style suffixes). */
export function uniqueIdName(table: Record<string, { name: string }>, base: string) {
  const names = new Set(Object.values(table).map((o) => o.name));
  if (!names.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!names.has(n)) return n;
  }
}
