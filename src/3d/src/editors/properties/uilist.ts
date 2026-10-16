// UI list widget: selectable rows with add/remove/move buttons, rename in place (double-click,
// Ctrl+click or F2), drag to reorder, arrow-key navigation, a filter bar (Ctrl+F) to search,
// invert, sort by name and reverse the displayed order, and a grip to resize the list.
import { h, type Child } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app, registerOperators } from '../../app/app';
import { keyInputHooks } from '../../app/keymap';
import { openMenu, type MenuItem } from '../../ui/menu';

export interface ListItem {
  key: string;
  label: string;
  icon?: string;
  right?: Child;
  /** width of the right-hand part: 'compact' (just icons) or 'wide' (several widgets) */
  rightSize?: 'compact' | 'wide';
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
/** rows shown by lists the user resized */
const listRows = new Map<string, number>();

interface ListOpts {
  add?: () => void;
  remove?: () => void;
  rename?: (i: number, name: string) => void;
  extra?: Child;
  up?: () => void;
  down?: () => void;
  /** move an item to another position (drag reordering); without it Move Up / Down are repeated */
  move?: (from: number, to: number) => void;
  rows?: number;
  specials?: () => MenuItem[];
}

/** per-list callbacks of the latest draw, used by the keyboard handler and the list operators */
const lists = new Map<string, { count: number; active: number; visible: number[]; setActive: (i: number) => void; opts: ListOpts }>();

const ROW = 22;

/** Move item `from` to position `to` with the list's move callback, or by repeating Move Up / Down. */
export function moveListItem(id: string, from: number, to: number): boolean {
  const l = lists.get(id);
  if (!l || from === to || from < 0 || to < 0 || from >= l.count || to >= l.count) return false;
  if (l.opts.move) {
    l.opts.move(from, to);
    return true;
  }
  const step = to < from ? l.opts.up : l.opts.down;
  if (!step) return false;
  if (l.active !== from) l.setActive(from);
  for (let n = Math.abs(to - from); n > 0; n--) step();
  return true;
}

function canReorder(id: string, f: ListFilter): boolean {
  const l = lists.get(id);
  return !!l && (!!l.opts.move || (!!l.opts.up && !!l.opts.down)) && !f.text && !f.sortAlpha && !f.reverse;
}

/** Press on a row and drag it up or down to move it; a short press just selects. */
function rowDrag(e: PointerEvent, id: string, index: number, f: ListFilter) {
  if (!canReorder(id, f)) return;
  const row = e.currentTarget as HTMLElement;
  const box = row.parentElement as HTMLElement;
  const y0 = e.clientY;
  let dragging = false;
  let target = index;
  const marker = document.createElement('div');
  marker.className = 'ul-drop';
  const move = (ev: PointerEvent) => {
    if (!dragging && Math.abs(ev.clientY - y0) < 5) return;
    if (!dragging) {
      dragging = true;
      row.classList.add('ul-dragging');
      box.append(marker);
    }
    const rows = [...box.querySelectorAll<HTMLElement>('.ul-row')];
    let t = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) {
        t = i;
        break;
      }
    }
    // dropping below the last row moves to the end
    const last = rows[rows.length - 1]?.getBoundingClientRect();
    const after = !!last && ev.clientY > last.top + last.height / 2;
    target = after ? rows.length - 1 : t > index ? t - 1 : t;
    const ref = rows[after ? rows.length - 1 : t]?.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    if (ref) marker.style.top = `${(after ? ref.bottom : ref.top) - br.top + box.scrollTop - 1}px`;
  };
  const up = () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    marker.remove();
    row.classList.remove('ul-dragging');
    if (dragging && target !== index) moveListItem(id, index, target);
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
}

/** Drag the grip under a list to show more or fewer rows. */
function resizeDrag(e: PointerEvent, id: string, rows: number) {
  e.preventDefault();
  e.stopPropagation();
  const y0 = e.clientY;
  const move = (ev: PointerEvent) => {
    const n = Math.max(1, Math.min(40, Math.round(rows + (ev.clientY - y0) / ROW)));
    if (n !== listRows.get(id)) {
      listRows.set(id, n);
      redraw();
    }
  };
  const up = () => {
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
}

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
  opts: ListOpts = {},
): Child {
  const f = filterOf(id);
  const visible = visibleIndices(items, f);
  const sized = listRows.get(id);
  const rows = sized ?? Math.max(opts.rows ?? 3, Math.min(visible.length, 8));
  const editing = renaming.get(id);
  // the entry follows the active item right away (the panel may redraw a little later)
  const entry = { count: items.length, active, visible, setActive: (i: number) => ((entry.active = i), setActive(i)), opts };
  lists.set(id, entry);
  const startRename = (i: number) => {
    if (!opts.rename) return;
    renaming.set(id, i);
    entry.setActive(i);
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
        { class: 'ul-rows', style: sized ? { height: `${rows * ROW + 4}px`, maxHeight: 'none' } : { minHeight: `${rows * ROW + 4}px` } },
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
                entry.setActive(i);
                rowDrag(e, id, i, f);
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
            it.right ? h('span', { class: { 'ul-right': true, compact: it.rightSize === 'compact', wide: it.rightSize === 'wide' } }, it.right) : null,
          );
        }),
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
    h(
      'div',
      { class: 'ul-filter-toggle-row' },
      h('span', { class: 'ul-grip-space' }),
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
      h('span', { class: 'ul-resize', 'data-tip': 'Drag to show more or fewer rows\nDouble-click to fit the list again', onpointerdown: (e: PointerEvent) => resizeDrag(e, id, rows), ondblclick: () => (listRows.delete(id), redraw()) }),
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

const pollList = () => {
  const id = hoveredList();
  return !!id && lists.has(id);
};

/** Open the filter options of a list and put the cursor in its search field. */
export function startListFilter(id: string) {
  const f = filterOf(id);
  f.open = true;
  redraw();
  requestAnimationFrame(() => (document.querySelector(`.uilist[data-list="${CSS.escape(id)}"] .ul-filter-text input`) as HTMLInputElement | null)?.focus());
}

registerOperators([
  {
    idname: 'ui.list_start_filter',
    label: 'List Filter',
    description: 'Search the list under the mouse by name',
    undo: false,
    poll: pollList,
    exec: () => startListFilter(hoveredList()!),
  },
  {
    idname: 'ui.view_item_rename',
    label: 'Rename View Item',
    description: 'Rename the active item of the list under the mouse',
    undo: false,
    poll: () => {
      const l = lists.get(hoveredList() ?? '');
      return !!l?.opts.rename && l.active >= 0 && l.active < l.count;
    },
    exec: () => {
      const id = hoveredList()!;
      renaming.set(id, lists.get(id)!.active);
      redraw();
    },
  },
  {
    idname: 'ui.view_item_delete',
    label: 'Delete Item',
    description: 'Remove the active item of the list under the mouse',
    undo: false,
    poll: () => !!lists.get(hoveredList() ?? '')?.opts.remove && (lists.get(hoveredList()!)?.count ?? 0) > 0,
    exec: () => lists.get(hoveredList()!)!.opts.remove!(),
  },
  {
    idname: 'ui.view_item_navigate',
    label: 'Navigate View',
    description: 'Make the item above or below the active one active (Home / End: the first / last)',
    undo: false,
    props: [
      {
        id: 'direction',
        label: 'Direction',
        type: 'enum',
        default: 'DOWN',
        items: [
          ['UP', 'Up'],
          ['DOWN', 'Down'],
          ['FIRST', 'First'],
          ['LAST', 'Last'],
        ],
      },
    ],
    poll: pollList,
    exec: (_c, p) => {
      const l = lists.get(hoveredList()!)!;
      if (!l.visible.length) return 'CANCELLED';
      const pos = l.visible.indexOf(l.active);
      const d = String(p.direction);
      const at = d === 'FIRST' ? 0 : d === 'LAST' ? l.visible.length - 1 : Math.max(0, Math.min(l.visible.length - 1, (pos < 0 ? -1 : pos) + (d === 'DOWN' ? 1 : -1)));
      const next = l.visible[at];
      if (next !== undefined && next !== l.active) l.setActive(next);
    },
  },
  {
    idname: 'ui.view_item_select',
    label: 'Select View Item',
    description: 'Make the list item under the mouse the active one',
    undo: false,
    poll: pollList,
    exec: () => {
      const id = hoveredList()!;
      const row = document.elementFromPoint(app.pointer.x, app.pointer.y)?.closest('.ul-row') as HTMLElement | null;
      const i = Number(row?.dataset.index);
      if (!row || !Number.isFinite(i)) return 'CANCELLED';
      lists.get(id)!.setActive(i);
    },
  },
]);

// Over a list: Ctrl+F filters, Alt+F clears the filter, Up / Down / Home / End move the active
// item, F2 renames it, Delete removes it.
keyInputHooks.push((e) => {
  if (e.type !== 'keydown') return false;
  const id = hoveredList();
  if (!id) return false;
  const l = lists.get(id);
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.code === 'KeyF' && ctrl && !e.altKey && !e.shiftKey) {
    startListFilter(id);
    return true;
  }
  if (e.code === 'KeyF' && e.altKey && !ctrl) {
    const f = filterOf(id);
    f.text = '';
    redraw();
    return true;
  }
  if (!l || ctrl || e.altKey || e.shiftKey) return false;
  const nav = ({ ArrowUp: 'UP', ArrowDown: 'DOWN', Home: 'FIRST', End: 'LAST' } as Record<string, string>)[e.code];
  if (nav && l.visible.length) {
    app.run('ui.view_item_navigate', { direction: nav });
    return true;
  }
  if (e.code === 'F2' && app.poll('ui.view_item_rename')) {
    app.run('ui.view_item_rename');
    return true;
  }
  if (e.code === 'Delete' && l.opts.remove && l.count) {
    app.run('ui.view_item_delete');
    return true;
  }
  return false;
});
