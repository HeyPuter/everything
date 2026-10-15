// UI list widget: selectable rows with add/remove/move buttons, rename in place (double-click,
// Ctrl+click or F2), arrow-key navigation, and a filter bar (Ctrl+F) to search, invert, sort by
// name and reverse the displayed order.
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { keyInputHooks } from '../../app/keymap';

export interface ListItem {
  key: string;
  label: string;
  icon?: string;
  right?: Child;
}

interface ListFilter {
  open: boolean;
  text: string;
  invert: boolean;
  sortAlpha: boolean;
  reverse: boolean;
}

const renaming = new Map<string, number>();
const filters = new Map<string, ListFilter>();
/** per-list callbacks of the latest draw, used by the keyboard handler */
const lists = new Map<string, { count: number; active: number; visible: number[]; setActive: (i: number) => void; rename?: unknown }>();

function filterOf(id: string): ListFilter {
  let f = filters.get(id);
  if (!f) filters.set(id, (f = { open: false, text: '', invert: false, sortAlpha: false, reverse: false }));
  return f;
}

/** Indices of the items shown, in display order. */
export function visibleIndices(items: { label: string }[], f: Pick<ListFilter, 'text' | 'invert' | 'sortAlpha' | 'reverse'>): number[] {
  const q = f.text.trim().toLowerCase();
  let idx = items.map((_, i) => i);
  if (q) {
    const re = q.includes('*') ? new RegExp(`^${q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`) : null;
    idx = idx.filter((i) => {
      const l = items[i].label.toLowerCase();
      const m = re ? re.test(l) : l.includes(q);
      return f.invert ? !m : m;
    });
  }
  if (f.sortAlpha) idx.sort((a, b) => items[a].label.localeCompare(items[b].label, undefined, { numeric: true }));
  if (f.reverse) idx.reverse();
  return idx;
}

function redraw() {
  app.changed('ui');
}

export function uiList(
  id: string,
  items: ListItem[],
  active: number,
  setActive: (i: number) => void,
  opts: { add?: () => void; remove?: () => void; rename?: (i: number, name: string) => void; extra?: Child; up?: () => void; down?: () => void; rows?: number } = {},
): Child {
  const f = filterOf(id);
  const visible = visibleIndices(items, f);
  const rows = Math.max(opts.rows ?? 3, Math.min(visible.length, 8));
  const editing = renaming.get(id);
  lists.set(id, { count: items.length, active, visible, setActive, rename: opts.rename });
  const startRename = (i: number) => {
    if (!opts.rename) return;
    renaming.set(id, i);
    setActive(i);
    redraw();
  };
  return h(
    'div',
    { class: 'uilist', 'data-list': id },
    h(
      'div',
      { class: 'ul-main' },
      h(
        'div',
        { class: 'ul-rows', style: { minHeight: `${rows * 22 + 4}px` } },
        visible.map((i) => {
          const it = items[i];
          return h(
            'div',
            {
              key: it.key + i,
              class: { 'ul-row': true, on: i === active },
              'data-index': String(i),
              onpointerdown: (e: PointerEvent) => {
                if (e.button !== 0) return;
                if ((e.ctrlKey || e.metaKey) && opts.rename) {
                  e.preventDefault();
                  startRename(i);
                  return;
                }
                setActive(i);
              },
              ondblclick: () => startRename(i),
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
          );
        }),
      ),
      h(
        'div',
        { class: 'ul-side' },
        opts.add ? h('button', { class: 'icon-btn', 'data-tip': 'Add', onclick: opts.add }, icon('add')) : null,
        opts.remove ? h('button', { class: 'icon-btn', 'data-tip': 'Remove', disabled: !items.length, onclick: opts.remove }, icon('remove')) : null,
        opts.up ? h('button', { class: 'icon-btn', 'data-tip': 'Move Up', onclick: opts.up }, icon('triangle_up')) : null,
        opts.down ? h('button', { class: 'icon-btn', 'data-tip': 'Move Down', onclick: opts.down }, icon('triangle_down')) : null,
      ),
    ),
    h(
      'div',
      { class: 'ul-filter-toggle-row' },
      h(
        'button',
        {
          class: { 'ul-filter-toggle': true, on: f.open || !!f.text || f.sortAlpha || f.reverse },
          'data-tip': 'Filter Options (Ctrl F)\nSearch, sort and reverse the list',
          'aria-expanded': f.open ? 'true' : 'false',
          onclick: () => ((f.open = !f.open), redraw()),
        },
        icon(f.open ? 'disclosure_tri_down' : 'disclosure_tri_right'),
      ),
    ),
    f.open
      ? h(
          'div',
          { class: 'ul-filter' },
          h(
            'label',
            { class: 'text-field ul-filter-text' },
            icon('search'),
            h('input', {
              value: f.text,
              placeholder: 'Filter by name',
              spellcheck: 'false',
              oninput: (e: Event) => ((f.text = (e.target as HTMLInputElement).value), redraw()),
              onkeydown: (e: KeyboardEvent) => {
                e.stopPropagation();
                if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
              },
            }),
          ),
          h(
            'button',
            {
              class: { 'ul-fbtn': true, on: f.invert },
              'data-tip': 'Invert\nShow the items that do not match',
              'aria-pressed': f.invert ? 'true' : 'false',
              onclick: () => ((f.invert = !f.invert), redraw()),
            },
            '⇄',
          ),
          h(
            'button',
            { class: { 'ul-fbtn': true, on: f.sortAlpha }, 'data-tip': 'Sort by Name', 'aria-pressed': f.sortAlpha ? 'true' : 'false', onclick: () => ((f.sortAlpha = !f.sortAlpha), redraw()) },
            icon('sort'),
          ),
          h(
            'button',
            { class: { 'ul-fbtn': true, on: f.reverse }, 'data-tip': 'Reverse Order', 'aria-pressed': f.reverse ? 'true' : 'false', onclick: () => ((f.reverse = !f.reverse), redraw()) },
            '⇅',
          ),
        )
      : null,
    opts.extra ?? null,
  );
}

/** The list under the pointer. */
function hoveredList(): string | null {
  const el = document.elementFromPoint(app.pointer.x, app.pointer.y)?.closest('.uilist') as HTMLElement | null;
  return el?.dataset.list ?? null;
}

// Ctrl+F opens the filter of the list under the mouse; Up/Down change its active item; F2 renames.
keyInputHooks.push((e) => {
  if (e.type !== 'keydown') return false;
  const id = hoveredList();
  if (!id) return false;
  const l = lists.get(id);
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.code === 'KeyF' && ctrl && !e.altKey && !e.shiftKey) {
    const f = filterOf(id);
    f.open = true;
    redraw();
    requestAnimationFrame(() => (document.querySelector(`.uilist[data-list="${CSS.escape(id)}"] .ul-filter-text input`) as HTMLInputElement | null)?.focus());
    return true;
  }
  if (e.code === 'KeyF' && e.altKey && !ctrl) {
    const f = filterOf(id);
    f.text = '';
    redraw();
    return true;
  }
  if (!l || ctrl || e.altKey) return false;
  if ((e.code === 'ArrowUp' || e.code === 'ArrowDown') && l.visible.length) {
    const pos = l.visible.indexOf(l.active);
    const next = l.visible[Math.max(0, Math.min(l.visible.length - 1, (pos < 0 ? -1 : pos) + (e.code === 'ArrowDown' ? 1 : -1)))];
    if (next !== undefined && next !== l.active) l.setActive(next);
    return true;
  }
  if (e.code === 'F2' && l.rename && l.active >= 0 && l.active < l.count) {
    renaming.set(id, l.active);
    redraw();
    return true;
  }
  return false;
});
