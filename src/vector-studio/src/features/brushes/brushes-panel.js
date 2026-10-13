/**
 * Brushes panel (F5): the document's brushes, grouped by type, in
 * thumbnail or list view, or the brushes of a built-in library. Clicking a
 * brush paints the selected paths with it (and makes it the Paintbrush's
 * brush); double-clicking opens its options. The footer holds the library
 * menu, Remove Brush Stroke, Options of Selected Object, New Brush and
 * Delete Brush; the panel menu adds duplicate, select unused, sorting,
 * type filters, views, and opening or saving brush libraries (the user's
 * saved libraries appear under User Defined).
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { BRUSH_TYPES, docBrushes, brushLibraries, brushById } from './brush-model.js';
import { selectionBrush, brushTargets, applyBrush, removeBrush, duplicateBrushes, unusedBrushIds, moveBrush } from './brush-ops.js';
import { brushState, newBrush, editBrush, editSelectedStrokeOptions, confirmDeleteBrushes, useLibraryBrush } from './brush-actions.js';
import { brushThumb, inkColor } from './thumbs.js';
import { setDocBrushes } from './brush-model.js';
import { userLibraries, userLibraryMenu, saveLibraryDialog } from '../paint/user-libraries.js';

const TYPE_ORDER = ['calligraphic', 'scatter', 'art', 'bristle', 'pattern'];

const showIn = (a, id) => {
  a.openPanel('brushes');
  a.dock.panels.get('brushes')?.showSource(id);
};

/** Menu entries for opening brush libraries (Window > Brush Libraries and the panel's library menu). */
export function libraryMenuItems(app) {
  return [
    ...brushLibraries().map((lib) => ({
      label: lib.name,
      run: (a) => {
        a.brushState = { ...brushState(a), source: lib.id };
        showIn(a, lib.id);
      },
    })),
    '-',
    { label: 'User Defined', submenu: userLibraryMenu(app, 'brushes', (l) => showIn(app, `user:${l.id}`)) },
  ];
}

/** A user-defined brush library by source id ('user:<id>'), or null. */
function userLibrary(app, source) {
  if (!String(source).startsWith('user:')) return null;
  const id = source.slice(5);
  const lib = userLibraries(app, 'brushes').find((l) => l.id === id);
  return lib ? { id: source, name: lib.name, brushes: lib.items } : null;
}

export class BrushesPanel extends Panel {
  static id = 'brushes';
  static title = 'Brushes';
  static icon = 'brushes';
  static placement = 'strip';
  static shortcut = 'F5';

  build() {
    const app = this.app;
    this.view = app.prefs.get('brushesView') || 'thumbnail';
    this.hiddenTypes = new Set(app.prefs.get('brushesHiddenTypes') || []);
    this.source = 'document';
    this.selected = new Set();
    this.focusId = null;
    this.sourceSel = h(
      'select.select.br-source',
      { 'aria-label': 'Brushes shown', onchange: () => this.showSource(this.sourceSel.value) },
      h('option', { value: 'document' }, 'Document Brushes'),
      h('optgroup', { label: 'Libraries' }, brushLibraries().map((l) => h('option', { value: l.id }, l.name))),
    );
    this.thumbBtn = iconButton('grid-view', 'Thumbnail View', () => this.setView('thumbnail'), { className: 'small', pressed: this.view === 'thumbnail' });
    this.listBtn = iconButton('list-view', 'List View', () => this.setView('list'), { className: 'small', pressed: this.view === 'list' });
    this.list = h('div.br-list', { role: 'listbox', 'aria-label': 'Brushes', 'aria-multiselectable': 'true', tabindex: '-1' });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.libBtn = iconButton('library', 'Brush Libraries Menu', (e) => app.showMenuAt(e.currentTarget, libraryMenuItems(app), 'Brush libraries'), { className: 'small' });
    this.libBtn.setAttribute('aria-haspopup', 'menu');
    this.removeBtn = iconButton('brush-remove', 'Remove Brush Stroke', () => this.edit(() => removeBrush(app.editor)), { className: 'small' });
    this.strokeOptBtn = iconButton('brush-stroke-options', 'Options of Selected Object', () => editSelectedStrokeOptions(app), { className: 'small' });
    this.newBtn = iconButton('plus', 'New Brush', () => (this.source === 'document' ? newBrush(app) : this.addSelectedLibraryBrushes()), { className: 'small' });
    this.delBtn = iconButton('trash', 'Delete Brush', () => this.deleteSelected(), { className: 'small' });
    this.status = h('p.br-status', { 'aria-live': 'polite' });
    this.footer = h('div.br-footer', this.libBtn, h('span.br-spacer'), this.removeBtn, this.strokeOptBtn, this.newBtn, this.delBtn);
    this.el.append(h('div.br-top', this.sourceSel, this.thumbBtn, this.listBtn), this.list, this.status, this.footer);
  }

  edit(fn) {
    const r = fn();
    this.update();
    return r;
  }

  /** Source choices: the document, the built-in libraries and the user's saved ones. */
  fillSources() {
    const user = userLibraries(this.app, 'brushes');
    const key = user.map((l) => `${l.id}:${l.name}`).join('|');
    if (key === this.sourcesKey) return;
    this.sourcesKey = key;
    this.sourceSel.replaceChildren(
      h('option', { value: 'document' }, 'Document Brushes'),
      h('optgroup', { label: 'Libraries' }, brushLibraries().map((l) => h('option', { value: l.id }, l.name))),
      user.length ? h('optgroup', { label: 'User Defined' }, user.map((l) => h('option', { value: `user:${l.id}` }, l.name))) : null,
    );
    this.sourceSel.value = this.source;
  }

  showSource(id) {
    this.ensureBuilt();
    this.fillSources();
    this.source = brushLibraries().some((l) => l.id === id) || userLibrary(this.app, id) ? id : 'document';
    this.sourceSel.value = this.source;
    this.selected.clear();
    this.renderKey = null;
    this.update();
  }

  setView(v) {
    this.view = v;
    this.app.prefs.set('brushesView', v);
    this.thumbBtn.setAttribute('aria-pressed', String(v === 'thumbnail'));
    this.listBtn.setAttribute('aria-pressed', String(v === 'list'));
    this.renderKey = null;
    this.update();
  }

  toggleType(type) {
    if (this.hiddenTypes.has(type)) this.hiddenTypes.delete(type);
    else this.hiddenTypes.add(type);
    this.app.prefs.set('brushesHiddenTypes', [...this.hiddenTypes]);
    this.renderKey = null;
    this.update();
  }

  brushes() {
    const ed = this.app.editor;
    const user = userLibrary(this.app, this.source);
    if (user) return user.brushes;
    if (this.source !== 'document') return brushLibraries().find((l) => l.id === this.source)?.brushes || [];
    return ed ? docBrushes(ed.doc) : [];
  }

  update() {
    const ed = this.app.editor;
    this.el.classList.toggle('disabled', !ed);
    this.fillSources();
    const active = ed ? selectionBrush(ed) : undefined;
    // The ink color is part of the key so a theme change redraws the previews.
    const key = [ed?.doc, ed ? docBrushes(ed.doc) : null, active, this.source, this.view, brushState(this.app).currentId, [...this.hiddenTypes].join(), inkColor(this.list)];
    const hasTargets = Boolean(ed && brushTargets(ed).length);
    this.removeBtn.disabled = !hasTargets || !(active && active !== null);
    this.strokeOptBtn.disabled = !(active && active !== 'mixed');
    this.newBtn.disabled = !ed || (this.source !== 'document' && !this.selected.size);
    this.newBtn.setAttribute('aria-label', this.source === 'document' ? 'New Brush' : 'Add to Document Brushes');
    this.newBtn.setAttribute('data-tip', this.source === 'document' ? 'New Brush' : 'Add to Document Brushes');
    this.delBtn.disabled = this.source !== 'document' || !this.selected.size;
    if (this.renderKey && key.every((k, i) => k === this.renderKey[i])) return;
    this.renderKey = key;
    this.render(active);
  }

  render(active) {
    const ed = this.app.editor;
    this.list.classList.toggle('thumbnail', this.view === 'thumbnail');
    this.list.classList.toggle('list', this.view === 'list');
    if (!ed) {
      this.list.replaceChildren(h('p.panel-empty', 'No document'));
      return;
    }
    const all = this.brushes();
    const valid = new Set(all.map((b) => b.id));
    for (const id of [...this.selected]) if (!valid.has(id)) this.selected.delete(id);
    const color = inkColor(this.list);
    const groups = [];
    for (const type of TYPE_ORDER) {
      if (this.hiddenTypes.has(type)) continue;
      const items = all.filter((b) => b.type === type);
      if (!items.length) continue;
      groups.push(
        h(
          'div.br-group',
          { role: 'group', 'aria-label': BRUSH_TYPES[type].label },
          h('h4.br-group-title', { 'aria-hidden': 'true' }, `${BRUSH_TYPES[type].short}`),
          h('div.br-items', items.map((b) => this.item(b, b.id === active, color))),
        ),
      );
    }
    this.list.replaceChildren(...groups);
    if (!groups.length) this.list.append(h('p.panel-empty', all.length ? 'All brush types are hidden.' : 'No brushes. Open a library or make a new brush.'));
    const focusEl = this.list.querySelector(`[data-id="${CSS.escape(this.focusId || '')}"]`) || this.list.querySelector('[aria-current="true"]') || this.list.querySelector('[data-id]');
    if (focusEl) focusEl.tabIndex = 0;
    const cur = active === 'mixed' ? 'Selection uses several brushes' : active ? `Selection: ${brushById(ed.doc, active)?.name || 'unknown brush'}` : active === null ? 'Selection: no brush' : '';
    this.status.textContent = this.source === 'document' ? cur : 'Click a brush to add it to the document and apply it.';
  }

  item(b, active, color) {
    const thumbnail = this.view === 'thumbnail';
    const sel = this.selected.has(b.id);
    const thumb = brushThumb(b, thumbnail ? { w: 76, h: 30, color } : { w: 110, h: 24, color });
    const el = h(
      'div.br-item',
      {
        role: 'option',
        tabindex: '-1',
        'aria-selected': String(sel),
        'aria-current': active ? 'true' : null,
        'aria-label': `${b.name}, ${BRUSH_TYPES[b.type].label}`,
        'data-tip': thumbnail ? b.name : null,
        'data-id': b.id,
      },
      thumb,
      thumbnail ? null : h('span.br-name', b.name),
    );
    el.classList.toggle('current', brushState(this.app).currentId === b.id);
    el.addEventListener('click', (e) => this.onClick(b, e));
    el.addEventListener('dblclick', () => this.source === 'document' && editBrush(this.app, b.id));
    if (this.source === 'document') this.enableDrag(el, b.id);
    return el;
  }

  onClick(b, e) {
    this.focusId = b.id;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      if (this.selected.has(b.id)) this.selected.delete(b.id);
      else this.selected.add(b.id);
      this.renderKey = null;
      this.update();
      return;
    }
    this.selected = new Set([b.id]);
    this.choose(b);
  }

  /** Make a brush current and paint the selection with it. */
  choose(b) {
    const app = this.app;
    const ed = app.editor;
    if (!ed) return;
    if (this.source !== 'document') {
      // Saved (user) brushes are not built in: they join the document first.
      if (userLibrary(app, this.source) && !docBrushes(ed.doc).some((x) => x.id === b.id)) ed.doc.transact('Add Brush', () => setDocBrushes(ed.doc, [...docBrushes(ed.doc), structuredClone(b)]));
      useLibraryBrush(app, b);
    } else {
      brushState(app).currentId = b.id;
      if (brushTargets(ed).length) applyBrush(ed, b.id, `Apply ${b.name}`);
    }
    this.renderKey = null;
    this.update();
  }

  addSelectedLibraryBrushes() {
    for (const id of this.selected) {
      const b = this.brushes().find((x) => x.id === id);
      if (b) useLibraryBrush(this.app, b, { apply: false });
    }
    this.app.notify(`Added ${this.selected.size === 1 ? 'the brush' : `${this.selected.size} brushes`} to the document.`, { polite: true });
  }

  async deleteSelected() {
    if (this.source !== 'document') return;
    await confirmDeleteBrushes(this.app, [...this.selected]);
    this.selected.clear();
    this.update();
  }

  onKey(e) {
    const items = [...this.list.querySelectorAll('[data-id]')];
    const i = items.indexOf(document.activeElement);
    const go = (j) => {
      const el = items[Math.max(0, Math.min(items.length - 1, j))];
      if (!el) return;
      items.forEach((x) => (x.tabIndex = -1));
      el.tabIndex = 0;
      el.focus();
      this.focusId = el.dataset.id;
    };
    const perRow = this.view === 'thumbnail' ? Math.max(1, Math.round(this.list.clientWidth / 84)) : 1;
    const b = i >= 0 ? this.brushes().find((x) => x.id === items[i].dataset.id) : null;
    switch (e.key) {
      case 'ArrowRight':
        go(i + 1);
        break;
      case 'ArrowLeft':
        go(i - 1);
        break;
      case 'ArrowDown':
        go(i + perRow);
        break;
      case 'ArrowUp':
        go(i - perRow);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(items.length - 1);
        break;
      case 'Enter':
      case ' ':
        if (b) {
          this.selected = new Set([b.id]);
          this.choose(b);
          this.list.querySelector(`[data-id="${CSS.escape(b.id)}"]`)?.focus();
        }
        break;
      case 'Delete':
      case 'Backspace':
        if (b && this.source === 'document') {
          if (!this.selected.has(b.id)) this.selected = new Set([b.id]);
          this.deleteSelected();
        }
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /** Drag a brush onto another to reorder the list. */
  enableDrag(el, id) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/x-brush', id);
      this.dragId = id;
    });
    el.addEventListener('dragover', (e) => {
      if (this.dragId && this.dragId !== id) e.preventDefault();
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const ed = this.app.editor;
      if (!ed || !this.dragId || this.dragId === id) return;
      const list = docBrushes(ed.doc);
      moveBrush(ed.doc, this.dragId, list.findIndex((b) => b.id === id));
      this.dragId = null;
    });
    el.addEventListener('dragend', () => (this.dragId = null));
  }

  sortByName() {
    const doc = this.app.editor?.doc;
    if (!doc) return;
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    // Sorted within each type (the panel groups brushes by type).
    const list = docBrushes(doc).slice().sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || coll.compare(a.name, b.name));
    doc.transact('Sort Brushes', () => setDocBrushes(doc, list));
  }

  saveLibrary() {
    const ed = this.app.editor;
    if (!ed) return null;
    const ids = this.selected;
    const all = this.brushes();
    const picked = all.filter((b) => ids.has(b.id));
    return saveLibraryDialog(this.app, 'brushes', { title: 'Save Brush Library', items: structuredClone(picked.length ? picked : all), defaultName: 'My Brushes' }).then((name) => {
      this.fillSources();
      return name;
    });
  }

  menu() {
    const app = this.app;
    const ed = app.editor;
    const doc = ed?.doc;
    const isDoc = this.source === 'document';
    const one = this.selected.size === 1 ? [...this.selected][0] : null;
    return [
      { label: 'New Brush...', enabled: Boolean(ed) && isDoc, run: () => newBrush(app) },
      { label: 'Duplicate Brush', enabled: Boolean(ed) && isDoc && this.selected.size > 0, run: () => {
        const ids = duplicateBrushes(doc, [...this.selected]);
        this.selected = new Set(ids);
        this.update();
      } },
      { label: 'Delete Brush', enabled: Boolean(ed) && isDoc && this.selected.size > 0, run: () => this.deleteSelected() },
      '-',
      { label: 'Remove Brush Stroke', enabled: Boolean(ed && brushTargets(ed).some((n) => n.brush)), run: () => this.edit(() => removeBrush(ed)) },
      '-',
      { label: 'Sort by Name', enabled: Boolean(ed) && isDoc, run: () => this.sortByName() },
      { label: 'Select All Unused', enabled: Boolean(ed) && isDoc, run: () => {
        this.selected = new Set(unusedBrushIds(doc));
        this.renderKey = null;
        this.update();
        if (!this.selected.size) app.notify('Every brush is in use.', { polite: true });
      } },
      '-',
      ...TYPE_ORDER.map((t) => ({ label: `Show ${BRUSH_TYPES[t].short} Brushes`, checked: !this.hiddenTypes.has(t), run: () => this.toggleType(t) })),
      '-',
      { label: 'Thumbnail View', checked: this.view === 'thumbnail', run: () => this.setView('thumbnail') },
      { label: 'List View', checked: this.view === 'list', run: () => this.setView('list') },
      '-',
      { label: 'Options of Selected Object...', enabled: Boolean(ed) && Boolean(selectionBrush(ed)) && selectionBrush(ed) !== 'mixed', run: () => editSelectedStrokeOptions(app) },
      { label: 'Brush Options...', enabled: Boolean(one) && isDoc, run: () => editBrush(app, one) },
      '-',
      { label: 'Open Brush Library', submenu: libraryMenuItems(app) },
      { label: 'Save Brush Library...', enabled: Boolean(ed) && this.brushes().length > 0, run: () => this.saveLibrary() },
      { label: 'Show Document Brushes', enabled: !isDoc, run: () => this.showSource('document') },
    ];
  }
}
