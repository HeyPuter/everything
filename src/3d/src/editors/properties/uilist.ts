// UI list widget (reference "UIList"): selectable rows with add/remove buttons.
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { openMenu, type MenuItem } from '../../ui/menu';

export interface ListItem {
  key: string;
  label: string;
  icon?: string;
  right?: Child;
}

const renaming = new Map<string, number>();

export function uiList(
  id: string,
  items: ListItem[],
  active: number,
  setActive: (i: number) => void,
  opts: { add?: () => void; remove?: () => void; rename?: (i: number, name: string) => void; extra?: Child; up?: () => void; down?: () => void; rows?: number; specials?: () => MenuItem[] } = {},
): Child {
  const rows = Math.max(opts.rows ?? 3, Math.min(items.length, 8));
  const editing = renaming.get(id);
  return h(
    'div',
    { class: 'uilist' },
    h(
      'div',
      { class: 'ul-main' },
      h(
        'div',
        { class: 'ul-rows', style: { minHeight: `${rows * 22 + 4}px` } },
        items.map((it, i) =>
          h(
            'div',
            {
              key: it.key + i,
              class: { 'ul-row': true, on: i === active },
              onpointerdown: () => setActive(i),
              ondblclick: () => {
                if (!opts.rename) return;
                renaming.set(id, i);
                setActive(i);
              },
            },
            it.icon ? icon(it.icon) : null,
            editing === i && opts.rename
              ? h('input', {
                  class: 'ul-rename',
                  value: it.label,
                  ref: (el: HTMLInputElement) =>
                    requestAnimationFrame(() => {
                      el.focus();
                      el.select();
                    }),
                  onkeydown: (e: KeyboardEvent) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      renaming.delete(id);
                      opts.rename!(i, (e.target as HTMLInputElement).value);
                    } else if (e.key === 'Escape') {
                      renaming.delete(id);
                      setActive(i);
                    }
                  },
                  onblur: (e: FocusEvent) => {
                    if (renaming.get(id) === i) {
                      renaming.delete(id);
                      opts.rename!(i, (e.target as HTMLInputElement).value);
                    }
                  },
                })
              : h('span', { class: 'ul-label' }, it.label),
            it.right ? h('span', { class: 'ul-right' }, it.right) : null,
          ),
        ),
      ),
      h(
        'div',
        { class: 'ul-side' },
        opts.add ? h('button', { class: 'icon-btn', 'data-tip': 'Add', onclick: opts.add }, icon('add')) : null,
        opts.remove ? h('button', { class: 'icon-btn', 'data-tip': 'Remove', disabled: !items.length, onclick: opts.remove }, icon('remove')) : null,
        opts.specials
          ? h(
              'button',
              {
                class: 'icon-btn ul-specials',
                'data-tip': 'More options',
                onpointerdown: (e: PointerEvent) => {
                  e.preventDefault();
                  openMenu(opts.specials!(), e.currentTarget as HTMLElement);
                },
              },
              icon('down_arrow_hlt'),
            )
          : null,
        opts.up ? h('button', { class: 'icon-btn', 'data-tip': 'Move Up', onclick: opts.up }, icon('triangle_up')) : null,
        opts.down ? h('button', { class: 'icon-btn', 'data-tip': 'Move Down', onclick: opts.down }, icon('triangle_down')) : null,
      ),
    ),
    opts.extra ?? null,
  );
}
