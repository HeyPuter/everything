/**
 * History panel: the document's undo history as a list of states. Clicking
 * a state (or moving through the list with the arrow keys) undoes or redoes
 * to it; states after the current one stay listed, dimmed, until a new edit
 * replaces them. Snapshots are named states of the whole document kept for
 * the session: restoring one is a single undoable step, so it works even
 * after the undo history was trimmed or cleared. Every document gets an
 * automatic "opened" snapshot.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { icon } from '../../ui/icons.js';
import { uid } from '../../lib/ids.js';

const SNAPSHOTS = new WeakMap(); // doc -> { list: [{ id, name, time, state }], version }

function store(doc) {
  let s = SNAPSHOTS.get(doc);
  if (!s) {
    s = { list: [], version: 0, counter: 0 };
    SNAPSHOTS.set(doc, s);
  }
  return s;
}

export function snapshotsOf(doc) {
  return store(doc).list;
}

/** Keep the current document state under a name. Returns the snapshot. */
export function addSnapshot(doc, name) {
  const s = store(doc);
  s.counter++;
  const snap = { id: uid('snap'), name: name || `Snapshot ${s.counter}`, time: Date.now(), state: doc.snapshot() };
  s.list.push(snap);
  s.version++;
  doc.emit('history');
  return snap;
}

export function removeSnapshot(doc, id) {
  const s = store(doc);
  s.list = s.list.filter((x) => x.id !== id);
  s.version++;
  doc.emit('history');
}

export function renameSnapshot(doc, id, name) {
  const s = store(doc);
  const snap = s.list.find((x) => x.id === id);
  if (!snap || !name) return;
  snap.name = name;
  s.version++;
  doc.emit('history');
}

/** Make the document match a snapshot, as one undo step. */
export function restoreSnapshot(editor, id) {
  const doc = editor.doc;
  const snap = snapshotsOf(doc).find((x) => x.id === id);
  if (!snap || doc.tx) return false;
  doc.transact(`Snapshot: ${snap.name}`, () => doc.restoreSnapshot(snap.state));
  editor.select(editor.topSelection().filter((sid) => doc.has(sid)));
  return true;
}

/** History Options (prefs 'historyOptions'). */
export function historyOptions(prefs) {
  return { firstSnapshot: true, snapshotDialog: false, showTimes: true, ...(prefs?.get('historyOptions') || {}) };
}

/** The automatic snapshot of a document as it was when first shown (History Options can turn it off). */
export function ensureOpenSnapshot(editor, prefs = null) {
  const s = store(editor.doc);
  if (s.opened) return;
  s.opened = true;
  if (!historyOptions(prefs).firstSnapshot) return;
  const snap = { id: uid('snap'), name: editor.name, time: Date.now(), state: editor.doc.snapshot(), opened: true };
  s.list.unshift(snap);
  s.version++;
}

function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export class HistoryPanel extends Panel {
  static id = 'history';
  static title = 'History';
  static icon = 'panel-history';
  static placement = 'strip';

  menu() {
    const ed = this.app.editor;
    const doc = ed?.doc;
    const snaps = doc ? snapshotsOf(doc) : [];
    const user = snaps.filter((x) => !x.opened);
    return [
      { label: 'Step Forward', enabled: Boolean(doc?.canRedo), run: () => this.step(1) },
      { label: 'Step Backward', enabled: Boolean(doc?.canUndo), run: () => this.step(-1) },
      '-',
      { label: 'New Snapshot...', enabled: Boolean(doc), run: () => this.newSnapshot(true) },
      { label: 'Restore Snapshot', submenu: snaps.map((x) => ({ label: x.name, run: () => restoreSnapshot(ed, x.id) })) },
      { label: 'Rename Snapshot', submenu: user.map((x) => ({ label: x.name, run: () => this.rename(x) })) },
      { label: 'Delete All Snapshots', enabled: user.length > 0, run: () => user.forEach((x) => removeSnapshot(doc, x.id)) },
      '-',
      { label: 'Clear History', enabled: Boolean(doc && doc.history().steps.length), run: () => this.clearHistory() },
      '-',
      { label: 'History Options...', run: () => this.optionsDialog() },
    ];
  }

  async optionsDialog() {
    const o = historyOptions(this.app.prefs);
    const v = await this.app.dialogs.form({
      title: 'History Options',
      fields: [
        { key: 'firstSnapshot', label: 'Automatically create a snapshot of each opened document', type: 'checkbox', value: o.firstSnapshot },
        { key: 'snapshotDialog', label: 'Ask for a name for new snapshots', type: 'checkbox', value: o.snapshotDialog },
        { key: 'showTimes', label: 'Show the time of each step', type: 'checkbox', value: o.showTimes },
      ],
    });
    if (!v) return;
    this.app.prefs.set('historyOptions', v);
    this.key = null;
    this.update();
  }

  build() {
    this.snapList = h('ul.hp-snaps', { 'aria-label': 'Snapshots' });
    this.list = h('ul.hp-list', {
      role: 'listbox',
      tabindex: '0',
      'aria-label': 'History states',
      'aria-description': 'Up and Down step backward and forward through the history',
    });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.status = h('p.hp-status', { 'aria-live': 'polite' });
    this.footer = h(
      'div.hp-footer',
      (this.backBtn = iconButton('step-back', 'Step Backward', () => this.step(-1), { shortcut: 'Mod+Z' })),
      (this.fwdBtn = iconButton('step-ahead', 'Step Forward', () => this.step(1), { shortcut: 'Shift+Mod+Z' })),
      h('span.hp-spacer'),
      iconButton('camera', 'New Snapshot', (e) => this.newSnapshot(Boolean(e?.altKey))),
      (this.clearBtn = iconButton('trash', 'Clear History', () => this.clearHistory())),
    );
    this.empty = h('p.panel-empty', 'No document open.');
    this.el.append(this.empty, this.snapList, this.list, this.status, this.footer);
  }

  update() {
    const ed = this.app.editor;
    this.empty.hidden = Boolean(ed);
    this.snapList.hidden = this.list.hidden = this.footer.hidden = this.status.hidden = !ed;
    if (!ed) return;
    const doc = ed.doc;
    const hist = doc.history();
    const s = store(doc);
    const last = doc.undoStack[doc.undoStack.length - 1];
    const key = `${hist.steps.length}|${hist.index}|${last?.time}|${s.version}|${doc.redoStack.length}`;
    if (this.key === key && this.keyDoc === doc) return;
    this.key = key;
    this.keyDoc = doc;
    this.renderSnapshots(ed);
    this.renderStates(ed, hist);
    this.backBtn.disabled = !doc.canUndo;
    this.fwdBtn.disabled = !doc.canRedo;
    this.clearBtn.disabled = !hist.steps.length;
    const undone = hist.steps.length - hist.index;
    this.status.textContent = `${hist.index} of ${hist.steps.length} steps applied${undone ? `, ${undone} undone` : ''}`;
  }

  renderSnapshots(ed) {
    const doc = ed.doc;
    this.snapList.replaceChildren(
      ...snapshotsOf(doc).map((snap) => {
        const restore = h(
          'button.hp-snap-btn',
          {
            type: 'button',
            'data-tip': `Restore "${snap.name}" (taken ${timeLabel(snap.time)})`,
            onclick: () => restoreSnapshot(ed, snap.id),
            ondblclick: () => !snap.opened && this.rename(snap),
            onkeydown: (e) => {
              if (e.key === 'F2' && !snap.opened) {
                e.preventDefault();
                this.rename(snap);
              }
            },
          },
          icon('snapshot-state', 16),
          h('span.hp-name', snap.name),
          h('span.hp-time', timeLabel(snap.time)),
        );
        const del = snap.opened ? null : iconButton('x', `Delete snapshot ${snap.name}`, () => removeSnapshot(doc, snap.id), { className: 'small' });
        return h('li.hp-snap', { dataset: { id: snap.id } }, restore, del);
      }),
    );
  }

  renderStates(ed, hist) {
    const focused = document.activeElement === this.list;
    const showTimes = historyOptions(this.app.prefs).showTimes;
    const rows = hist.steps.map((st, i) => {
      const applied = i < hist.index;
      const current = i === hist.index - 1;
      const row = h(
        'li.hp-row',
        { id: `hp-row-${i + 1}`, role: 'option', 'aria-selected': String(current), dataset: { index: String(i + 1) } },
        icon('history-state', 16),
        h('span.hp-name', st.label || 'Edit'),
        showTimes ? h('span.hp-time', { 'aria-hidden': 'true' }, timeLabel(st.time)) : null,
      );
      row.classList.toggle('undone', !applied);
      if (!applied) row.setAttribute('aria-description', 'Undone');
      row.addEventListener('click', () => this.goTo(i + 1));
      return row;
    });
    // State 0: the document before the first listed step.
    const base = h('li.hp-row.hp-base', { id: 'hp-row-0', role: 'option', 'aria-selected': String(hist.index === 0), dataset: { index: '0' } }, icon('file-text', 16), h('span.hp-name', 'Start of History'));
    base.addEventListener('click', () => this.goTo(0));
    this.list.replaceChildren(base, ...rows);
    this.list.setAttribute('aria-activedescendant', `hp-row-${hist.index}`);
    this.list.querySelector(`#hp-row-${hist.index}`)?.scrollIntoView?.({ block: 'nearest' });
    if (focused) this.list.focus({ preventScroll: true });
  }

  goTo(n) {
    const ed = this.app.editor;
    if (!ed) return;
    this.app.tool?.commit?.();
    ed.doc.goToHistory(n);
  }

  step(dir) {
    const ed = this.app.editor;
    if (!ed) return;
    this.goTo(ed.doc.undoStack.length + dir);
  }

  onKey(e) {
    const ed = this.app.editor;
    if (!ed) return;
    const { steps, index } = ed.doc.history();
    const go = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: steps.length }[e.key];
    if (go === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    this.goTo(go);
  }

  /** New Snapshot: asks for a name when History Options say so, or when `ask` (menu, Alt-click). */
  async newSnapshot(ask = false) {
    const ed = this.app.editor;
    if (!ed) return null;
    let name;
    if (ask || historyOptions(this.app.prefs).snapshotDialog) {
      const s = store(ed.doc);
      const v = await this.app.dialogs.form({ title: 'New Snapshot', fields: [{ key: 'name', label: 'Name', type: 'text', value: `Snapshot ${s.counter + 1}` }] });
      if (!v) return null;
      name = v.name?.trim();
    }
    const snap = addSnapshot(ed.doc, name);
    this.app.notify(`Saved ${snap.name}.`, { polite: true });
    return snap;
  }

  async rename(snap) {
    const ed = this.app.editor;
    const res = await this.app.dialogs.form({ title: 'Snapshot Options', fields: [{ key: 'name', label: 'Name', type: 'text', value: snap.name }] });
    if (res?.name?.trim() && ed) renameSnapshot(ed.doc, snap.id, res.name.trim());
  }

  async clearHistory() {
    const ed = this.app.editor;
    if (!ed) return;
    const ok = await this.app.dialogs.confirm({ title: 'Clear History', message: 'Clear the undo history of this document? Snapshots are kept. This cannot be undone.', okLabel: 'Clear', danger: true });
    if (ok) ed.doc.clearHistory();
  }
}
