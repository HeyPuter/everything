// History panel: the active document's undo history. Selecting an entry
// returns the document to that state; later entries stay available to redo
// until a new edit is made.
//
// Edits change the history often, so the list is updated in place: one row per
// entry is kept (keyed by the entry object) and only rows that changed are
// touched. While the panel is hidden nothing is rendered; showing it catches up.
// The panel menu undoes, redoes, deletes the states after the current one or
// clears the history.
//
// Snapshots keep a named copy of a state for as long as the file is open,
// even after the history is trimmed or cleared or a new edit drops the redo
// states. Restoring one is itself an undoable edit. Right-click a state or a
// snapshot for its commands; double-click a snapshot to rename it.

import { h, announce } from '../lib/dom.js';
import { Camera } from 'lucide';
import { icon, registerIcons } from '../ui/icons.js';
import { confirmDialog, promptDialog } from '../ui/dialog.js';
import { resolveItems } from '../ui/menubar.js';

registerIcons({ camera: Camera });

/** document -> [{ id, name, state, at }] */
const snapshotLists = new WeakMap();
let snapshotSeq = 0;

/** The snapshots of a document, oldest first. */
export function snapshotsOf(doc) {
  return (doc && snapshotLists.get(doc)) || [];
}

/** Adds a snapshot of `state` (default: the current one) and returns it. */
export function addSnapshot(doc, { name, state = doc.state } = {}) {
  const list = snapshotsOf(doc);
  const snap = { id: `snap-${++snapshotSeq}`, name: name || `Snapshot ${list.length + 1}`, state, at: Date.now() };
  snapshotLists.set(doc, [...list, snap]);
  return snap;
}

/** Restores a snapshot as one undoable edit (nothing when the document is already in that state). */
export function restoreSnapshot(doc, snap) {
  if (!snap || doc.state === snap.state) return false;
  doc.apply(`Restore ${snap.name}`, snap.state);
  return true;
}

export function removeSnapshot(doc, id) {
  snapshotLists.set(doc, snapshotsOf(doc).filter((x) => x.id !== id));
}

export function renameSnapshot(doc, id, name) {
  snapshotLists.set(doc, snapshotsOf(doc).map((x) => (x.id === id ? { ...x, name } : x)));
}

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
  const snapBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'New Snapshot', title: 'Keep a named copy of the current state', onclick: () => newSnapshot() }, icon('camera', 15));
  const snapList = h('ol.history-list.history-snapshots', { role: 'listbox', 'aria-label': 'Snapshots' });
  const snapHead = h('div.history-section', 'Snapshots');
  const el = h('div.history-panel', snapHead, snapList, list, h('div.panel-footer', count, h('div.spacer'), snapBtn, clearBtn));

  // ---------------------------------------------------------- snapshots
  const newSnapshot = (state) => {
    const doc = app.active;
    if (!doc?.history) return null;
    const snap = addSnapshot(doc, state ? { state } : {});
    renderSnapshots();
    announce(`${snap.name} saved`);
    return snap;
  };
  const restore = (snap) => {
    const doc = app.active;
    if (doc && restoreSnapshot(doc, snap)) announce(`${snap.name} restored`);
  };
  const rename = async (snap) => {
    const doc = app.active;
    const name = await promptDialog({ title: 'Rename Snapshot', label: 'Name:', value: snap.name, confirm: 'Rename', validate: (v) => (v.trim() ? '' : 'Enter a name.') });
    if (name == null || !doc) return;
    renameSnapshot(doc, snap.id, name.trim());
    renderSnapshots();
  };
  const remove = (snap) => {
    if (!app.active) return;
    removeSnapshot(app.active, snap.id);
    renderSnapshots();
  };
  function renderSnapshots() {
    const doc = app.active;
    const snaps = snapshotsOf(doc);
    snapHead.hidden = !snaps.length;
    snapList.hidden = !snaps.length;
    snapBtn.disabled = !doc?.history;
    snapList.replaceChildren(
      ...snaps.map((snap, i) => {
        const current = doc.state === snap.state;
        return h(
          'li.history-item.history-snapshot',
          {
            role: 'option',
            'aria-selected': String(current),
            tabindex: i === 0 ? '0' : '-1',
            title: `Taken at ${new Date(snap.at).toLocaleTimeString()}. Click to restore; double-click to rename.`,
            onclick: () => restore(snap),
            ondblclick: () => rename(snap),
            oncontextmenu: (e) => {
              e.preventDefault();
              app.openMenu(
                [
                  { type: 'cmd', label: 'Restore Snapshot', enabled: !current, run: () => restore(snap) },
                  { type: 'cmd', label: 'Rename Snapshot...', enabled: true, run: () => rename(snap) },
                  { type: 'sep' },
                  { type: 'cmd', label: 'Delete Snapshot', enabled: true, run: () => remove(snap) },
                ],
                { x: e.clientX, y: e.clientY, label: 'Snapshot' },
              );
            },
            onkeydown: (e) => {
              const items = [...snapList.children];
              const k = items.indexOf(e.currentTarget);
              if (e.key === 'Enter') restore(snap);
              else if (e.key === 'F2') rename(snap);
              else if (e.key === 'Delete' || e.key === 'Backspace') remove(snap);
              else if (e.key === 'ArrowDown' && items[k + 1]) items[k + 1].focus();
              else if (e.key === 'ArrowUp' && items[k - 1]) items[k - 1].focus();
              else return;
              e.preventDefault();
              e.stopPropagation();
            },
          },
          icon('camera', 14),
          h('span', snap.name),
        );
      }),
    );
  }
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
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hh = hist();
      const i = hh ? hh.entries.indexOf(entry) : -1;
      if (i < 0) return;
      app.openMenu(
        [
          { type: 'cmd', label: 'Go to This State', enabled: i !== hh.index, run: () => hh.goTo(i) },
          { type: 'cmd', label: 'New Snapshot of This State', enabled: Boolean(entry.state), run: () => newSnapshot(entry.state) },
          { type: 'sep' },
          { type: 'cmd', label: 'Delete Later States', enabled: Boolean(hh.canRedo), run: () => hist()?.dropRedo() },
        ],
        { x: e.clientX, y: e.clientY, label: 'History state' },
      );
    });
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
      renderSnapshots();
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
    renderSnapshots();
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
      { type: 'sep' },
      { type: 'cmd', label: 'New Snapshot', enabled: Boolean(hh), run: () => newSnapshot() },
      { type: 'cmd', label: 'Delete All Snapshots', enabled: snapshotsOf(app.active).length > 0, run: () => {
        for (const x of snapshotsOf(app.active)) removeSnapshot(app.active, x.id);
        renderSnapshots();
      } },
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
