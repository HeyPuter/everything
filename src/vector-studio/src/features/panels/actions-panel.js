/**
 * Actions panel: action sets as a tree (set > action > steps). Each item
 * has an include checkbox (unchecked steps are skipped) and, for steps with
 * dialogs, a dialog toggle (show the dialog during playback, or apply the
 * recorded values directly). The footer records, plays (from the selected
 * step), and adds sets and actions; the panel menu holds Duplicate, Action
 * and Set Options, Insert Menu Item, Insert Stop, Play on All Open
 * Documents, Button Mode and saving and loading sets as files. In Button
 * Mode every action is a button. Actions can have a keyboard shortcut.
 */
import { h } from '../../lib/dom.js';
import { uid } from '../../lib/ids.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { icon } from '../../ui/icons.js';
import { IS_MAC, formatShortcut, normalizeShortcut } from '../../commands/registry.js';
import { pickWithInput } from '../files/service.js';
import { ActionEngine, defaultSets, exportSetsData, parseSetsData, findAction, stepDetail, hasDialog, isRecordable, playbackOptions } from './actions-model.js';

export const BUTTON_COLORS = ['none', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray'];

/** Shortcut text for a key event: "Shift+Mod+F5", or null for a bare modifier. */
export function shortcutFromEvent(e) {
  const k = e.key;
  if (!k || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(k)) return null;
  let key = k.length === 1 ? k.toUpperCase() : k;
  if (/^Key[A-Z]$/.test(e.code || '')) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code || '')) key = e.code.slice(5);
  const mods = [];
  if (IS_MAC ? e.ctrlKey : false) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (IS_MAC ? e.metaKey : e.ctrlKey) mods.push('Mod');
  return [...mods, key].join('+');
}

/** Who already uses a shortcut: a command label or tool name, or null when it is free. */
export function shortcutOwner(app, shortcut, ownId = null) {
  if (!shortcut) return null;
  const n = normalizeShortcut(shortcut);
  const cmd = app.commands.byShortcut.get(n);
  if (cmd && cmd !== ownId) return app.commands.label(cmd);
  const tool = app.toolKeys?.get(n);
  if (tool) return app.toolClasses.get(tool)?.label || tool;
  return null;
}

/** Register a command (with the shortcut) for every action that has one; drop the rest. */
export function syncActionCommands(app, engine) {
  const reg = app.commands;
  for (const [key, id] of [...reg.byShortcut]) if (id.startsWith('actions.run.')) reg.byShortcut.delete(key);
  for (const id of [...reg.commands.keys()]) if (id.startsWith('actions.run.')) reg.commands.delete(id);
  for (const set of engine.sets) {
    for (const a of set.actions) {
      if (!a.shortcut || shortcutOwner(app, a.shortcut, `actions.run.${a.id}`)) continue;
      reg.register({ id: `actions.run.${a.id}`, label: a.name, shortcut: a.shortcut, enabled: (x) => Boolean(x.editor), run: () => engine.play(a.id) });
    }
  }
}

export class ActionsPanel extends Panel {
  static id = 'actions';
  static title = 'Actions';
  static icon = 'panel-actions';
  static placement = 'strip';

  get engine() {
    return this.app.actions;
  }

  build() {
    this.expanded = new Set(this.app.prefs.get('actionsExpanded') || []);
    this.sel = null; // { kind: 'set'|'action'|'step', id }
    this.buttonMode = Boolean(this.app.prefs.get('actionsButtonMode'));
    this.tree = h('ul.ac-tree', { role: 'tree', 'aria-label': 'Actions', tabindex: '0' });
    this.tree.addEventListener('keydown', (e) => this.onKey(e));
    this.buttons = h('div.ac-buttons', { role: 'group', 'aria-label': 'Actions' });
    this.status = h('p.ac-status', { role: 'status' });
    this.footer = h(
      'div.ac-footer',
      (this.stopBtn = iconButton('stop', 'Stop Recording', () => this.engine.stopRecording(), { className: 'small' })),
      (this.recBtn = iconButton('record', 'Begin Recording', () => this.record(), { className: 'small ac-rec', pressed: false })),
      (this.playBtn = iconButton('play', 'Play Selection', () => this.play(), { className: 'small' })),
      h('span.ac-spacer'),
      iconButton('folder-plus-2', 'Create New Set', () => this.newSet(), { className: 'small' }),
      iconButton('file-plus-2', 'Create New Action', () => this.newAction(), { className: 'small' }),
      (this.delBtn = iconButton('trash', 'Delete Selection', () => this.deleteSelected(), { className: 'small' })),
    );
    this.el.append(this.tree, this.buttons, this.status, this.footer);
  }

  // ---- model helpers ----

  get sets() {
    return this.engine.sets;
  }

  locate(sel = this.sel) {
    if (!sel) return {};
    for (const set of this.sets) {
      if (sel.kind === 'set' && set.id === sel.id) return { set };
      for (const action of set.actions) {
        if (sel.kind === 'action' && action.id === sel.id) return { set, action };
        const i = action.steps.findIndex((s) => s.id === sel.id);
        if (sel.kind === 'step' && i >= 0) return { set, action, step: action.steps[i], index: i };
      }
    }
    return {};
  }

  /** The action the footer acts on (the selected action, or the one holding the selected step). */
  selectedAction() {
    return this.locate().action || null;
  }

  saveExpanded() {
    this.app.prefs.set('actionsExpanded', [...this.expanded]);
  }

  // ---- rendering ----

  update() {
    const e = this.engine;
    const rec = e.recording;
    this.recBtn.setAttribute('aria-pressed', String(Boolean(rec)));
    this.recBtn.classList.toggle('recording', Boolean(rec));
    this.stopBtn.disabled = !rec;
    this.playBtn.disabled = !this.selectedAction() || Boolean(rec) || e.playing || !this.app.editor;
    this.delBtn.disabled = !this.sel || Boolean(rec);
    this.status.textContent = rec ? `Recording "${rec.action.name}". Use menu commands, panels, tools and the arrow keys; Stop when done.` : '';
    this.status.hidden = !rec;
    this.tree.hidden = this.buttonMode;
    this.buttons.hidden = !this.buttonMode;
    const key = JSON.stringify([this.sets, this.sel, [...this.expanded], Boolean(rec), this.buttonMode]);
    if (key === this.renderKey) return;
    this.renderKey = key;
    if (this.buttonMode) this.renderButtons();
    else this.renderTree();
  }

  renderButtons() {
    this.buttons.replaceChildren(
      ...this.sets.flatMap((set) =>
        set.actions.map((a) =>
          h(
            `button.btn.ac-button.c-${a.color || 'none'}`,
            { type: 'button', 'data-tip': a.shortcut ? `${a.name} (${formatShortcut(a.shortcut)})` : a.name, onclick: () => this.engine.play(a.id).then(() => this.update()) },
            h('span.ac-button-name', a.name),
            a.shortcut ? h('kbd', formatShortcut(a.shortcut)) : null,
          ),
        ),
      ),
    );
  }

  renderTree() {
    const focused = this.tree.contains(document.activeElement);
    const rows = [];
    const row = (kind, item, level, { expandable = false, expanded = false, on, mixed = false, modal = null, label, detail = '', posinset, setsize }) => {
      const id = `ac-${item.id}`;
      const selected = this.sel?.kind === kind && this.sel.id === item.id;
      const chk = h('input.ac-on', { type: 'checkbox', checked: on, 'aria-label': `Include ${label}`, tabindex: '-1', onclick: (e) => e.stopPropagation(), onchange: () => this.toggleOn(kind, item.id) });
      chk.indeterminate = mixed;
      const modalBtn =
        modal === null
          ? h('span.ac-modal-spacer')
          : h('button.icon-btn.small.ac-modal', { type: 'button', tabindex: '-1', 'aria-pressed': String(modal === true), 'aria-label': `Show dialog for ${label}`, 'data-tip': 'Toggle Dialog On/Off', onclick: (e) => {
            e.stopPropagation();
            this.toggleModal(kind, item.id);
          } }, icon('modal-dialog', 14));
      const twisty = expandable ? h('span.ac-twisty', { 'aria-hidden': 'true', onclick: (e) => {
        e.stopPropagation();
        this.toggleExpand(item.id);
      } }, icon(expanded ? 'chevron-down' : 'chevron-right', 12)) : h('span.ac-twisty');
      const el = h(
        `li.ac-row.ac-${kind}`,
        { id, role: 'treeitem', 'aria-level': String(level), 'aria-selected': String(selected), 'aria-posinset': String(posinset), 'aria-setsize': String(setsize), ...(expandable ? { 'aria-expanded': String(expanded) } : {}) },
        chk,
        modalBtn,
        h('span.ac-indent', { style: { width: `${(level - 1) * 14}px` } }),
        twisty,
        kind === 'set' ? icon('folder', 14) : null,
        h('span.ac-label', label, detail ? h('span.ac-detail', ` (${detail})`) : null),
        kind === 'action' && item.shortcut ? h('kbd.ac-key', formatShortcut(item.shortcut)) : null,
      );
      el.classList.toggle('off', !on && !mixed);
      el.addEventListener('click', () => this.select({ kind, id: item.id }));
      el.addEventListener('dblclick', () => {
        if (kind === 'action') this.actionOptions(item.id);
        else if (kind === 'set') this.setOptions(item.id);
        else if (hasDialog(item)) this.toggleModal('step', item.id);
      });
      rows.push(el);
    };
    const allOn = (list) => (list.every((x) => x) ? { on: true, mixed: false } : list.some((x) => x) ? { on: false, mixed: true } : { on: false, mixed: false });
    this.sets.forEach((set, si) => {
      const stepsOf = set.actions.flatMap((a) => a.steps);
      const st = allOn(stepsOf.length ? stepsOf.map((s) => s.on) : [true]);
      const open = this.expanded.has(set.id);
      row('set', set, 1, { expandable: true, expanded: open, ...st, label: set.name, posinset: si + 1, setsize: this.sets.length });
      if (!open) return;
      set.actions.forEach((a, ai) => {
        const recording = this.engine.recording?.action === a || this.engine.recording?.action?.id === a.id;
        const aOn = allOn(a.steps.length ? a.steps.map((s) => s.on) : [true]);
        const dialogs = a.steps.filter(hasDialog);
        const modal = dialogs.length ? (dialogs.every((s) => s.modal) ? true : dialogs.some((s) => s.modal) ? 'mixed' : false) : null;
        const aOpen = this.expanded.has(a.id);
        row('action', a, 2, { expandable: a.steps.length > 0, expanded: aOpen, ...aOn, modal, label: a.name + (recording ? ' (recording)' : ''), posinset: ai + 1, setsize: set.actions.length });
        if (!aOpen) return;
        a.steps.forEach((s, k) => row('step', s, 3, { on: s.on, modal: hasDialog(s) ? Boolean(s.modal) : null, label: s.label || s.cmd || s.kind, detail: stepDetail(s), posinset: k + 1, setsize: a.steps.length }));
      });
    });
    this.tree.replaceChildren(...rows);
    if (!rows.length) this.tree.append(h('li.panel-empty', 'No actions. Create a set and an action, then record.'));
    const active = this.sel ? this.tree.querySelector(`#ac-${CSS.escape(this.sel.id)}`) : null;
    if (active) this.tree.setAttribute('aria-activedescendant', active.id);
    else this.tree.removeAttribute('aria-activedescendant');
    active?.scrollIntoView?.({ block: 'nearest' });
    if (focused) this.tree.focus({ preventScroll: true });
  }

  // ---- interactions ----

  select(sel) {
    this.sel = sel;
    this.update();
  }

  toggleExpand(id, force) {
    const open = force ?? !this.expanded.has(id);
    if (open) this.expanded.add(id);
    else this.expanded.delete(id);
    this.saveExpanded();
    this.update();
  }

  toggleOn(kind, id) {
    const { set, action, step } = this.locate({ kind, id });
    const steps = kind === 'set' ? set.actions.flatMap((a) => a.steps) : kind === 'action' ? action.steps : [step];
    const next = !steps.every((s) => s.on);
    for (const s of steps) s.on = next;
    this.engine.save();
  }

  toggleModal(kind, id) {
    const { action, step } = this.locate({ kind, id });
    const steps = (kind === 'action' ? action.steps : [step]).filter((s) => hasDialog(s) && !s.interactive);
    if (!steps.length) return;
    const next = !steps.every((s) => s.modal);
    for (const s of steps) s.modal = next;
    this.engine.save();
  }

  visibleRows() {
    return [...this.tree.querySelectorAll('.ac-row')];
  }

  onKey(e) {
    const rows = this.visibleRows();
    const i = rows.findIndex((r) => r.id === `ac-${this.sel?.id}`);
    const go = (j) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (!r) return;
      const kind = r.classList.contains('ac-set') ? 'set' : r.classList.contains('ac-action') ? 'action' : 'step';
      this.select({ kind, id: r.id.slice(3) });
    };
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'ArrowDown') return stop(), go(i + 1);
    if (e.key === 'ArrowUp') return stop(), go(i < 0 ? 0 : i - 1);
    if (e.key === 'Home') return stop(), go(0);
    if (e.key === 'End') return stop(), go(rows.length - 1);
    if (!this.sel) return;
    const r = rows[i];
    if (e.key === 'ArrowRight') {
      stop();
      if (r?.getAttribute('aria-expanded') === 'false') this.toggleExpand(this.sel.id, true);
      else go(i + 1);
    } else if (e.key === 'ArrowLeft') {
      stop();
      if (r?.getAttribute('aria-expanded') === 'true') this.toggleExpand(this.sel.id, false);
      else {
        const { set, action } = this.locate();
        if (this.sel.kind === 'step') this.select({ kind: 'action', id: action.id });
        else if (this.sel.kind === 'action') this.select({ kind: 'set', id: set.id });
      }
    } else if (e.key === ' ') {
      stop();
      this.toggleOn(this.sel.kind, this.sel.id);
    } else if (e.key === 'Enter') {
      stop();
      if (this.sel.kind === 'set') this.toggleExpand(this.sel.id);
      else this.play();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      stop();
      this.deleteSelected();
    } else if (e.key === 'F2') {
      stop();
      if (this.sel.kind === 'action') this.actionOptions(this.sel.id);
      else if (this.sel.kind === 'set') this.setOptions(this.sel.id);
    }
  }

  async play() {
    const { action, index } = this.locate();
    if (!action) return;
    await this.engine.play(action.id, { from: this.sel.kind === 'step' ? index : 0 });
    this.update();
  }

  async record() {
    if (this.engine.recording) return;
    const action = this.selectedAction();
    if (!action) return this.newAction();
    this.expanded.add(action.id);
    this.engine.startRecording(action.id);
  }

  async newSet() {
    const v = await this.app.dialogs.form({ title: 'New Set', fields: [{ key: 'name', label: 'Name', type: 'text', value: `Set ${this.sets.length + 1}` }] });
    if (!v?.name?.trim()) return;
    const set = { id: uid('set'), name: v.name.trim(), actions: [] };
    this.sets.push(set);
    this.expanded.add(set.id);
    this.sel = { kind: 'set', id: set.id };
    this.saveExpanded();
    this.engine.save();
  }

  async newAction() {
    if (!this.sets.length) this.sets.push({ id: uid('set'), name: 'Set 1', actions: [] });
    const current = this.locate().set || this.sets[0];
    const res = await this.optionsDialog({ title: 'New Action', name: `Action ${current.actions.length + 1}`, setId: current.id, okLabel: 'Record' });
    if (!res) return;
    const set = this.sets.find((s) => s.id === res.setId) || current;
    const action = { id: uid('act'), name: res.name, steps: [], ...(res.shortcut ? { shortcut: res.shortcut } : {}), ...(res.color !== 'none' ? { color: res.color } : {}) };
    set.actions.push(action);
    this.expanded.add(set.id);
    this.expanded.add(action.id);
    this.sel = { kind: 'action', id: action.id };
    this.saveExpanded();
    this.engine.save();
    syncActionCommands(this.app, this.engine);
    if (this.app.editor) this.engine.startRecording(action.id);
  }

  async actionOptions(id) {
    const found = findAction(this.sets, id);
    if (!found) return;
    const { set, action } = found;
    const res = await this.optionsDialog({ title: 'Action Options', name: action.name, setId: set.id, shortcut: action.shortcut || '', color: action.color || 'none', ownId: `actions.run.${action.id}` });
    if (!res) return;
    action.name = res.name;
    if (res.shortcut) action.shortcut = res.shortcut;
    else delete action.shortcut;
    if (res.color && res.color !== 'none') action.color = res.color;
    else delete action.color;
    if (res.setId !== set.id) {
      set.actions = set.actions.filter((a) => a !== action);
      this.sets.find((s) => s.id === res.setId)?.actions.push(action);
    }
    this.engine.save();
    syncActionCommands(this.app, this.engine);
  }

  async setOptions(id) {
    const set = this.sets.find((s) => s.id === id);
    if (!set) return;
    const v = await this.app.dialogs.form({ title: 'Set Options', fields: [{ key: 'name', label: 'Name', type: 'text', value: set.name }] });
    if (!v?.name?.trim()) return;
    set.name = v.name.trim();
    this.engine.save();
  }

  /** Name, set, shortcut and button color. Resolves to { name, setId, shortcut, color } or null. */
  optionsDialog({ title, name, setId, shortcut = '', color = 'none', ownId = null, okLabel = 'OK' }) {
    const app = this.app;
    const nameEl = h('input#aco-name', { type: 'text', value: name, spellcheck: false, autocomplete: 'off' });
    const setEl = h('select#aco-set', this.sets.map((s) => h('option', { value: s.id, selected: s.id === setId }, s.name)));
    let key = shortcut;
    const keyEl = h('input#aco-key', { type: 'text', readonly: true, value: key ? formatShortcut(key) : '', placeholder: 'Press a key combination', 'aria-describedby': 'aco-key-help' });
    const help = h('p#aco-key-help.form-help', 'Function keys with or without modifiers work best. Backspace clears.');
    keyEl.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' || e.key === 'Escape' || e.key === 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        key = '';
        keyEl.value = '';
        help.textContent = 'No shortcut.';
        return;
      }
      const s = shortcutFromEvent(e);
      if (!s) return;
      const owner = shortcutOwner(app, s, ownId);
      if (owner) {
        help.textContent = `${formatShortcut(s)} is used by ${owner}. Choose another.`;
        return;
      }
      key = s;
      keyEl.value = formatShortcut(s);
      help.textContent = 'Function keys with or without modifiers work best. Backspace clears.';
    });
    const colorEl = h('select#aco-color', BUTTON_COLORS.map((c) => h('option', { value: c, selected: c === color }, c === 'none' ? 'None' : c[0].toUpperCase() + c.slice(1))));
    const body = h(
      'div.form',
      h('div.form-row', h('label', { for: 'aco-name' }, 'Name'), nameEl),
      h('div.form-row', h('label', { for: 'aco-set' }, 'Set'), setEl),
      h('div.form-row', h('label', { for: 'aco-key' }, 'Shortcut'), keyEl, help),
      h('div.form-row', h('label', { for: 'aco-color' }, 'Button Color'), colorEl),
    );
    return app.dialogs.open({
      title,
      body,
      initialFocus: () => nameEl,
      buttons: [
        { label: 'Cancel', value: null },
        { label: okLabel, primary: true, validate: () => Boolean(nameEl.value.trim()), value: () => ({ name: nameEl.value.trim(), setId: setEl.value, shortcut: key, color: colorEl.value }) },
      ],
    });
  }

  async deleteSelected() {
    const { set, action, step, index } = this.locate();
    if (!this.sel) return;
    if (this.sel.kind === 'step') {
      action.steps.splice(index, 1);
      const next = action.steps[Math.min(index, action.steps.length - 1)];
      this.sel = next ? { kind: 'step', id: next.id } : { kind: 'action', id: action.id };
    } else {
      const what = this.sel.kind === 'set' ? `the set "${set.name}" and its ${set.actions.length} actions` : `the action "${action.name}"`;
      if (!(await this.app.dialogs.confirm({ title: 'Delete', message: `Delete ${what}?`, okLabel: 'Delete', danger: true }))) return;
      if (this.sel.kind === 'set') this.engine.sets = this.sets.filter((s) => s !== set);
      else set.actions = set.actions.filter((a) => a !== action);
      this.sel = null;
    }
    this.engine.save();
    syncActionCommands(this.app, this.engine);
  }

  duplicate() {
    const { set, action } = this.locate();
    if (this.sel?.kind === 'set') {
      const copy = structuredClone(set);
      copy.id = uid('set');
      copy.name = `${set.name} copy`;
      for (const a of copy.actions) {
        a.id = uid('act');
        delete a.shortcut;
        for (const s of a.steps) s.id = uid('st');
      }
      this.sets.splice(this.sets.indexOf(set) + 1, 0, copy);
      this.sel = { kind: 'set', id: copy.id };
    } else if (action) {
      const copy = structuredClone(action);
      copy.id = uid('act');
      copy.name = `${action.name} copy`;
      delete copy.shortcut;
      for (const s of copy.steps) s.id = uid('st');
      set.actions.splice(set.actions.indexOf(action) + 1, 0, copy);
      this.sel = { kind: 'action', id: copy.id };
    }
    this.engine.save();
  }

  /** Insert a step after the selected step (or at the end of the selected action). */
  insertStep(st) {
    const { action, index } = this.locate();
    if (!action) return false;
    const at = this.sel.kind === 'step' ? index + 1 : action.steps.length;
    action.steps.splice(at, 0, st);
    this.expanded.add(action.id);
    this.sel = { kind: 'step', id: st.id };
    this.saveExpanded();
    this.engine.save();
    return true;
  }

  async insertMenuItem() {
    if (!this.selectedAction()) return this.app.notify('Select an action first.');
    const app = this.app;
    const all = [...app.commands.commands.keys()]
      .filter((id) => isRecordable(id) && !id.startsWith('actions.'))
      .map((id) => ({ id, label: String(app.commands.label(id) || id).replace(/\.\.\.$/, '') }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const search = h('input#acim-search', { type: 'search', placeholder: 'Type to find a command', autocomplete: 'off', 'aria-controls': 'acim-list' });
    const list = h('ul#acim-list.acim-list', { role: 'listbox', 'aria-label': 'Commands', tabindex: '-1' });
    let chosen = null;
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const items = all.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)).slice(0, 200);
      if (!items.some((c) => c.id === chosen)) chosen = items[0]?.id || null;
      list.replaceChildren(
        ...items.map((c) =>
          h('li.acim-item', { id: `acim-${c.id.replace(/\W/g, '_')}`, role: 'option', 'aria-selected': String(c.id === chosen), onclick: () => {
            chosen = c.id;
            render();
          } }, h('span', c.label), h('span.muted', ` ${c.id.split('.')[0]}`)),
        ),
      );
      const sel = list.querySelector('[aria-selected="true"]');
      if (sel) search.setAttribute('aria-activedescendant', sel.id);
      sel?.scrollIntoView?.({ block: 'nearest' });
    };
    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const ids = [...list.querySelectorAll('.acim-item')].map((li) => li.id);
      const i = ids.indexOf(`acim-${String(chosen).replace(/\W/g, '_')}`);
      const j = Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
      chosen = all.find((c) => `acim-${c.id.replace(/\W/g, '_')}` === ids[j])?.id || chosen;
      render();
    });
    render();
    const id = await app.dialogs.open({
      title: 'Insert Menu Item',
      body: h('div.form.acim', h('label', { for: 'acim-search' }, 'Command'), search, list, h('p.form-help', 'The command runs on the selection when the action plays. Commands with dialogs show them.')),
      initialFocus: () => search,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Insert', primary: true, value: () => chosen }],
    });
    if (!id) return;
    const label = all.find((c) => c.id === id)?.label || id;
    this.insertStep({ id: uid('st'), kind: 'command', cmd: id, label, args: null, dialogs: [], on: true, modal: true, interactive: false });
  }

  async insertStop() {
    if (!this.selectedAction()) return this.app.notify('Select an action first.');
    const v = await this.app.dialogs.form({
      title: 'Insert Stop',
      fields: [
        { key: 'message', label: 'Message', type: 'textarea', value: '' },
        { key: 'canContinue', label: 'Allow Continue', type: 'checkbox', value: true },
      ],
    });
    if (!v) return;
    this.insertStep({ id: uid('st'), kind: 'stop', label: 'Stop', message: v.message, canContinue: v.canContinue, on: true, modal: false });
  }

  async saveActions() {
    const { set } = this.locate();
    const sets = set ? [set] : this.sets;
    const blob = new Blob([JSON.stringify(exportSetsData(sets), null, 2)], { type: 'application/json' });
    const { downloadBlob } = await import('../io/deliver.js');
    downloadBlob(blob, `${set ? set.name : 'Actions'}.actions.json`);
  }

  async loadActions() {
    const [file] = await pickWithInput('.json,application/json');
    if (!file) return 0;
    let sets;
    try {
      sets = parseSetsData(JSON.parse(await file.text()));
    } catch (err) {
      this.app.notify(err?.message?.includes('Vector Studio') ? err.message : 'This file could not be read as actions.', { error: true });
      return 0;
    }
    this.engine.sets.push(...sets);
    for (const s of sets) this.expanded.add(s.id);
    this.saveExpanded();
    this.engine.save();
    this.app.notify(`Loaded ${sets.length} action set${sets.length === 1 ? '' : 's'}.`, { polite: true });
    return sets.length;
  }

  async resetActions() {
    if (!(await this.app.dialogs.confirm({ title: 'Reset Actions', message: 'Replace all actions with the default set?', okLabel: 'Reset', danger: true }))) return;
    this.engine.sets = defaultSets();
    this.sel = null;
    this.engine.save();
    syncActionCommands(this.app, this.engine);
  }

  openMenu(anchor) {
    this.app.showMenuAt(anchor, this.menu(), 'Actions menu');
  }

  /** Insert Selected Path: a step that adds copies of the selected paths. */
  insertSelectedPath() {
    const ed = this.app.editor;
    if (!this.selectedAction()) return this.app.notify('Select an action first.');
    const ids = ed ? ed.topSelection().filter((id) => ['path', 'compound'].includes(ed.doc.get(id)?.type)) : [];
    if (!ids.length) return this.app.notify('Select a path to insert.');
    const subs = ids.map((id) => structuredClone(ed.doc.exportSubtree(id)));
    this.insertStep({ id: uid('st'), kind: 'path', label: 'Insert Path', subs, on: true, modal: false });
  }

  /** Select Object: a step that selects objects by name (or note). */
  async insertSelectObject() {
    if (!this.selectedAction()) return this.app.notify('Select an action first.');
    const ed = this.app.editor;
    const current = ed?.selectedNodes()[0];
    const v = await this.app.dialogs.form({
      title: 'Select Object',
      description: 'Playing the action selects the objects with this name or note (Attributes panel).',
      fields: [{ key: 'name', label: 'Name or note', type: 'text', value: current?.name || current?.notes || '' }],
    });
    const name = v?.name?.trim();
    if (!name) return;
    this.insertStep({ id: uid('st'), kind: 'select', label: 'Select Object', name, on: true, modal: false });
  }

  async playbackOptionsDialog() {
    const o = playbackOptions(this.app.prefs);
    const v = await this.app.dialogs.form({
      title: 'Playback Options',
      fields: [
        {
          key: 'mode',
          label: 'Performance',
          type: 'radio',
          value: o.mode,
          options: [
            { value: 'accelerated', label: 'Accelerated' },
            { value: 'step', label: 'Step by Step' },
            { value: 'pause', label: 'Pause between steps' },
          ],
        },
        { key: 'pause', label: 'Pause for (seconds)', type: 'number', value: o.pause, min: 0, max: 60 },
      ],
    });
    if (v) this.app.prefs.set('actionPlayback', { mode: v.mode, pause: v.pause });
  }

  async clearActions() {
    if (!(await this.app.dialogs.confirm({ title: 'Clear Actions', message: 'Delete every action set?', okLabel: 'Clear', danger: true }))) return;
    this.engine.sets = [];
    this.sel = null;
    this.engine.save();
    syncActionCommands(this.app, this.engine);
  }

  async replaceActions() {
    const before = this.engine.sets;
    this.engine.sets = [];
    const n = await this.loadActions();
    if (!n) this.engine.sets = before;
    else syncActionCommands(this.app, this.engine);
    this.engine.save();
  }

  menu() {
    const { action, set } = this.locate();
    const idle = !this.engine.recording && !this.engine.playing;
    return [
        { label: 'Button Mode', checked: this.buttonMode, run: () => this.setButtonMode(!this.buttonMode) },
        '-',
        { label: 'New Action...', enabled: idle, run: () => this.newAction() },
        { label: 'New Set...', enabled: idle, run: () => this.newSet() },
        { label: 'Duplicate', enabled: idle && Boolean(set), run: () => this.duplicate() },
        { label: 'Delete', enabled: idle && Boolean(this.sel), run: () => this.deleteSelected() },
        { label: 'Play', enabled: idle && Boolean(action) && Boolean(this.app.editor), run: () => this.play() },
        { label: 'Play on All Open Documents', enabled: idle && Boolean(action) && this.app.editors.length > 0, run: () => this.engine.playOnAll(action.id) },
        '-',
        { label: 'Start Recording', enabled: idle && Boolean(action), run: () => this.record() },
        { label: 'Insert Menu Item...', enabled: Boolean(action), run: () => this.insertMenuItem() },
        { label: 'Insert Stop...', enabled: Boolean(action), run: () => this.insertStop() },
        { label: 'Insert Selected Path', enabled: Boolean(action) && Boolean(this.app.editor?.selection.size), run: () => this.insertSelectedPath() },
        { label: 'Select Object...', enabled: Boolean(action), run: () => this.insertSelectObject() },
        '-',
        { label: 'Action Options...', enabled: Boolean(action), run: () => this.actionOptions(action.id) },
        { label: 'Set Options...', enabled: Boolean(set), run: () => this.setOptions(set.id) },
        { label: 'Playback Options...', run: () => this.playbackOptionsDialog() },
        '-',
        { label: 'Clear Actions', enabled: idle && this.sets.length > 0, run: () => this.clearActions() },
        { label: 'Reset Actions', enabled: idle, run: () => this.resetActions() },
        { label: 'Load Actions...', enabled: idle, run: () => this.loadActions() },
        { label: 'Replace Actions...', enabled: idle, run: () => this.replaceActions() },
        { label: set ? 'Save Set...' : 'Save Actions...', run: () => this.saveActions() },
    ];
  }

  setButtonMode(on) {
    this.buttonMode = on;
    this.app.prefs.set('actionsButtonMode', on);
    this.update();
  }
}
