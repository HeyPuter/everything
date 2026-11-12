// History panel: the active document's undo history. Selecting an entry
// returns the document to that state; later entries stay available to redo
// until a new edit is made.
//
// Edits change the history often, so the list is updated in place: one row per
// entry is kept (keyed by the entry object) and only rows that changed are
// touched. While the panel is hidden nothing is rendered; showing it catches up.
// The panel menu undoes, redoes, deletes the states after the current one or
// clears the history.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { confirmDialog } from '../ui/dialog.js';
import { resolveItems } from '../ui/menubar.js';

export function historyPanel(app) {
  const list = h('ol.history-list', { role: 'listbox', 'aria-label': 'History' });
  const count = h('span.muted');
  const clearHistory = async () => {
    const doc = app.active;
    if (!doc) return;
    if (await confirmDialog({ title: 'Clear History', message: 'Clear the undo history for this file? This cannot be undone.', confirm: 'Clear', danger: true })) {
      if (doc.clearHistory) doc.clearHistory();
      else doc.history.clear();
    }
  };
  const clearBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Clear history', title: 'Clear history', onclick: clearHistory }, icon('trash-2', 15));
  const el = h('div.history-panel', list, h('div.panel-footer', count, h('div.spacer'), clearBtn));
  let off = null;
  let visible = false;
  let stale = true;
  /** entry object -> its row; entries are replaced, never mutated in place (labels included). */
  let rows = new WeakMap();

  const hist = () => app.active?.history || null;

  const makeRow = (entry, first) => {
    const item = h(
      'li.history-item',
      {
        role: 'option',
        onclick: () => {
          const hh = hist();
          const i = hh ? hh.entries.indexOf(entry) : -1;
          if (i >= 0) hh.goTo(i);
        },
        onkeydown: (e) => {
          const hh = hist();
          const i = hh ? hh.entries.indexOf(entry) : -1;
          if (i < 0) return;
          if (e.key === 'ArrowDown' && i < hh.entries.length - 1) hh.goTo(i + 1);
          else if (e.key === 'ArrowUp' && i > 0) hh.goTo(i - 1);
          else return;
          e.preventDefault();
          e.stopPropagation();
          list.querySelector('[aria-selected=true]')?.focus();
        },
      },
      icon(first ? 'file-audio' : 'history', 14),
      h('span', entry.label),
    );
    item._entry = entry;
    return item;
  };

  /** Keeps the current entry visible by scrolling the list itself (never the page). */
  const reveal = (item) => {
    if (!item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  };

  const render = () => {
    if (!visible) {
      stale = true;
      return;
    }
    stale = false;
    const hh = hist();
    if (!hh) {
      list.replaceChildren();
      count.textContent = '0 Undo';
      clearBtn.disabled = true;
      return;
    }
    const wanted = hh.entries.map((entry, i) => {
      let item = rows.get(entry);
      if (!item) {
        item = makeRow(entry, i === 0);
        rows.set(entry, item);
      }
      return item;
    });
    // Reconcile only when the sequence changed (an edit, a trimmed or cleared history).
    const current = list.children;
    let same = current.length === wanted.length;
    for (let i = 0; same && i < wanted.length; i++) same = current[i] === wanted[i];
    if (!same) {
      // Common case: entries appended (after dropping redo entries).
      let k = 0;
      while (k < current.length && k < wanted.length && current[k] === wanted[k]) k++;
      while (current.length > k) list.lastChild.remove();
      for (let i = k; i < wanted.length; i++) list.append(wanted[i]);
    }
    let selected = null;
    wanted.forEach((item, i) => {
      const isCurrent = i === hh.index;
      const sel = String(isCurrent);
      if (item.getAttribute('aria-selected') !== sel) item.setAttribute('aria-selected', sel);
      const tab = isCurrent ? '0' : '-1';
      if (item.getAttribute('tabindex') !== tab) item.setAttribute('tabindex', tab);
      item.classList.toggle('future', i > hh.index);
      if (isCurrent) selected = item;
    });
    count.textContent = `${hh.index} Undo`;
    clearBtn.disabled = hh.entries.length < 2;
    reveal(selected);
  };

  const bind = () => {
    off?.();
    rows = new WeakMap();
    list.replaceChildren();
    off = app.active?.history ? app.active.history.on('change', render) : null;
    render();
  };
  app.on('active', bind);
  bind();
  const menu = () => {
    const hh = hist();
    return [
      ...resolveItems(app, ['edit.undo', 'edit.redo']),
      { type: 'sep' },
      { type: 'cmd', label: 'Delete Later States', enabled: Boolean(hh?.canRedo), run: () => hist()?.dropRedo() },
      { type: 'cmd', label: 'Clear History...', enabled: Boolean(hh && hh.entries.length > 1), run: clearHistory },
    ];
  };
  return {
    el,
    menu,
    show() {
      visible = true;
      if (stale) render();
    },
    hide() {
      visible = false;
    },
  };
}
