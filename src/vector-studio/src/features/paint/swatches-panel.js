/**
 * Swatches panel: the document's swatches (doc.root.swatches, undoable) in
 * small / medium / large thumbnail or small / large list views, with color
 * groups as folder rows, Recent Colors, a find field, Show Kinds, swatch
 * libraries, New Swatch / New Color Group / Swatch Options / Delete, drag
 * to reorder (or into a group) and keyboard navigation. Clicking a swatch
 * applies it to the focused fill or stroke; global and spot swatches stay
 * linked to the objects using them (see swatch-model.js). The panel menu
 * adds duplicate, merge, ungroup, select unused, add used colors, sorting,
 * and opening, saving, importing and exporting swatch libraries.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton, paintSwatch } from '../../ui/widgets.js';
import { icon } from '../../ui/icons.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { openPopover, closePopover } from '../../ui/popover.js';
import { applyStyle } from '../../ops/paint-ops.js';
import { isHex, normalizeHex } from '../../lib/color.js';
import { MODES, MODE_IDS } from './color-modes.js';
import { colorSliders, miniFillStroke, focusedPaint, displayColor } from './ui-common.js';
import { swatchRows, swatchesOf, groupsOf, findSwatch, addSwatch, removeSwatches, updateSwatch, moveSwatches, addGroup, renameGroup, paintFromSwatch, colorName, swatchUsage, duplicateSwatches, mergeSwatches, ungroupGroups, unusedSwatchIds, usedColorsMissing, sortSwatches, swatchKind } from './swatch-model.js';
import { swatchLibraryMenu, saveSwatchLibrary, exportSwatchLibrary, importSwatchLibrary } from './swatch-libraries.js';
import { recentColorsRow } from './recent-colors.js';
import { collectColors, colorTargets } from './edit-colors.js';
import { isGradient } from '../../model/gradients.js';

/** Swatch Options dialog. Resolves to { name, global, mode, paint } or null. */
export function swatchOptionsDialog(app, { title = 'Swatch Options', swatch, onPreview }) {
  const paint = swatch.paint;
  const isSolid = paint?.type === 'solid';
  const name = h('input', { type: 'text', id: 'swo-name', value: swatch.name || '', spellcheck: false, autocomplete: 'off' });
  const type = h(
    'select',
    { id: 'swo-type' },
    h('option', { value: 'process', selected: !swatch.global }, 'Process Color'),
    h('option', { value: 'global', selected: Boolean(swatch.global) && !swatch.spot }, 'Global Color'),
    h('option', { value: 'spot', selected: Boolean(swatch.spot) }, 'Spot Color'),
  );
  let mode = swatch.mode || 'rgb';
  let color = isSolid ? paint.color : '#000000';
  const modeSel = h('select', { id: 'swo-mode', onchange: () => {
    mode = modeSel.value;
    sliders.setMode(mode);
  } }, MODE_IDS.map((m) => h('option', { value: m, selected: m === mode }, MODES[m].label)));
  const chip = h('span.swo-chip');
  const hex = h('input.swo-hex', { type: 'text', maxlength: 7, 'aria-label': 'Hexadecimal color', spellcheck: false });
  const preview = h('input', { type: 'checkbox', id: 'swo-preview', checked: true });
  const sliders = colorSliders({ mode, label: 'Swatch', onInput: (c) => setColor(c, true) });
  const setColor = (c, fromSliders = false) => {
    color = c;
    chip.style.background = c;
    if (document.activeElement !== hex) hex.value = c.slice(1).toUpperCase();
    if (!fromSliders) sliders.setColor(c);
    if (preview.checked) onPreview?.(result());
  };
  hex.addEventListener('change', () => {
    const s = hex.value.startsWith('#') ? hex.value : `#${hex.value}`;
    if (isHex(s)) setColor(normalizeHex(s));
  });
  preview.addEventListener('change', () => onPreview?.(preview.checked ? result() : null));
  const result = () => ({
    name: name.value.trim() || (isSolid ? colorName(color) : swatch.name || 'Gradient'),
    global: type.value !== 'process',
    spot: type.value === 'spot',
    mode,
    paint: isSolid ? { type: 'solid', color } : paint,
  });
  const body = h(
    'div.form.swo',
    h('div.form-row', h('label', { for: 'swo-name' }, 'Swatch Name'), name),
    isSolid ? h('div.form-row', h('label', { for: 'swo-type' }, 'Color Type'), type) : null,
    isSolid ? h('div.form-row', h('label', { for: 'swo-mode' }, 'Color Mode'), modeSel) : null,
    isSolid ? h('div.swo-color', chip, sliders.el) : h('div.swo-grad', paintSwatch(paint)),
    isSolid ? h('div.form-row', h('label', '#'), hex) : null,
    isSolid && onPreview ? h('div.check-row', preview, h('label', { for: 'swo-preview' }, 'Preview')) : null,
  );
  if (isSolid) setColor(color);
  return openDialog({
    title,
    body,
    className: 'swatch-options',
    initialFocus: () => name,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, value: () => result() },
    ],
  });
}

export const SWATCH_VIEWS = [
  { id: 'smallThumb', label: 'Small Thumbnail View', list: false },
  { id: 'mediumThumb', label: 'Medium Thumbnail View', list: false },
  { id: 'largeThumb', label: 'Large Thumbnail View', list: false },
  { id: 'smallList', label: 'Small List View', list: true },
  { id: 'largeList', label: 'Large List View', list: true },
];
const isListView = (v) => SWATCH_VIEWS.find((x) => x.id === v)?.list || false;
const KIND_LABELS = { process: 'Process color', global: 'Global color', spot: 'Spot color', gradient: 'Gradient', pattern: 'Pattern', other: '' };

/**
 * New swatch from the focused fill or stroke (the Swatch Options dialog
 * first unless `direct`). A global swatch links the object it came from.
 * Resolves to the new swatch id, or null.
 */
export async function createSwatchFromFocused(app, { direct = false } = {}) {
  const ed = app.editor;
  if (!ed) return null;
  const { key, paint } = focusedPaint(ed);
  const p = paint && paint !== 'mixed' ? structuredClone(paint) : { type: 'solid', color: displayColor(ed, key, paint) };
  delete p.swatchId;
  delete p.tint;
  const base = { name: p.type === 'solid' ? colorName(p.color) : p.type === 'pattern' ? 'New Pattern Swatch' : 'New Gradient Swatch', paint: p };
  const res = direct ? { ...base, global: false } : await swatchOptionsDialog(app, { title: 'New Swatch', swatch: base });
  if (!res || app.editor !== ed) return null;
  const doc = ed.doc;
  let id = null;
  doc.transact('New Swatch', () => {
    id = addSwatch(doc, { name: res.name, paint: res.paint, global: res.global, spot: res.spot, mode: res.mode });
    // The object that supplied the color now uses the new swatch.
    if (res.global && res.paint.type === 'solid') applyStyle(ed, { [key]: { ...res.paint, swatchId: id } }, 'New Swatch');
  });
  return id;
}

export class SwatchesPanel extends Panel {
  static id = 'swatches';
  static title = 'Swatches';
  static icon = 'swatches';
  static placement = 'strip';

  build() {
    const app = this.app;
    // Earlier versions stored 'grid' / 'list'.
    const stored = { grid: 'mediumThumb', list: 'smallList' }[app.prefs.get('swatchesView')] || app.prefs.get('swatchesView');
    this.view = SWATCH_VIEWS.some((v) => v.id === stored) ? stored : 'mediumThumb';
    this.findShown = app.prefs.get('swatchesFind') !== false;
    this.recent = recentColorsRow(app);
    this.show = 'all';
    this.query = '';
    this.selected = new Set();
    this.focusId = null;
    this.fs = miniFillStroke(app);
    this.search = h('input.sw-search', { type: 'search', placeholder: 'Search', 'aria-label': 'Search swatches' });
    this.search.addEventListener('input', () => {
      this.query = this.search.value;
      this.render();
    });
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    this.gridBtn = iconButton('grid-view', 'Show Swatches as Thumbnails', () => this.setView(isListView(this.view) ? this.app.prefs.get('swatchesThumbView') || 'mediumThumb' : this.view), { className: 'small', pressed: !isListView(this.view) });
    this.listBtn = iconButton('list-view', 'Show Swatches as List', () => this.setView(isListView(this.view) ? this.view : this.app.prefs.get('swatchesListView') || 'smallList'), { className: 'small', pressed: isListView(this.view) });
    this.list = h('div.sw-list', { role: 'listbox', 'aria-label': 'Swatches', 'aria-multiselectable': 'true', tabindex: '-1' });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.footer = h(
      'div.sw-footer',
      iconButton('library', 'Swatch Libraries Menu', (e) => this.openLibraries(e.currentTarget), { className: 'small' }),
      iconButton('filter', 'Show Swatch Kinds Menu', (e) => this.openKinds(e.currentTarget), { className: 'small' }),
      h('span.sw-spacer'),
      (this.optBtn = iconButton('sliders-horizontal', 'Swatch Options', () => this.editSelected(), { className: 'small' })),
      iconButton('folder-plus', 'New Color Group', () => this.newGroup(), { className: 'small' }),
      iconButton('plus', 'New Swatch', (e) => this.newSwatch(e.altKey), { className: 'small' }),
      (this.delBtn = iconButton('trash', 'Delete Swatch', () => this.deleteSelected(), { className: 'small' })),
    );
    this.search.hidden = !this.findShown;
    this.el.append(h('div.sw-top', this.fs.el, this.search, h('span.sw-spacer'), this.gridBtn, this.listBtn), this.recent.el, this.list, this.footer);
  }

  setView(v) {
    this.view = v;
    this.app.prefs.set('swatchesView', v);
    this.app.prefs.set(isListView(v) ? 'swatchesListView' : 'swatchesThumbView', v);
    this.gridBtn.setAttribute('aria-pressed', String(!isListView(v)));
    this.listBtn.setAttribute('aria-pressed', String(isListView(v)));
    this.render();
  }

  setFindShown(on) {
    this.findShown = on;
    this.app.prefs.set('swatchesFind', on);
    this.search.hidden = !on;
    if (!on && this.query) {
      this.query = '';
      this.search.value = '';
      this.render();
    }
    if (on) this.search.focus();
  }

  /** Ids of the selected swatches (not groups) that still exist. */
  selectedSwatchIds() {
    const doc = this.app.editor?.doc;
    return doc ? [...this.selected].filter((id) => findSwatch(doc, id)) : [];
  }

  selectedGroupIds() {
    const doc = this.app.editor?.doc;
    return doc ? groupsOf(doc).filter((g) => this.selected.has(g.id)).map((g) => g.id) : [];
  }

  menu() {
    const app = this.app;
    const ed = app.editor;
    const sw = this.selectedSwatchIds();
    const groups = this.selectedGroupIds();
    const has = Boolean(ed);
    return [
      { label: 'New Swatch...', enabled: has, run: () => this.newSwatch() },
      { label: 'New Color Group...', enabled: has, run: () => this.newGroup() },
      { label: 'Duplicate Swatch', enabled: sw.length > 0, run: () => this.duplicateSelected() },
      { label: 'Merge Swatches', enabled: sw.length > 1, run: () => this.mergeSelected() },
      { label: 'Delete Swatch', enabled: this.selected.size > 0, run: () => this.deleteSelected() },
      { label: 'Ungroup Color Group', enabled: groups.length > 0, run: () => this.ungroupSelected() },
      '-',
      { label: 'Select All Unused', enabled: has, run: () => this.selectUnused() },
      { label: 'Add Used Colors', enabled: has, run: () => this.addUsedColors() },
      '-',
      { label: 'Sort by Name', enabled: has, run: () => this.sortBy('name') },
      { label: 'Sort by Kind', enabled: has, run: () => this.sortBy('kind') },
      '-',
      { label: 'Show Find Field', checked: this.findShown, run: () => this.setFindShown(!this.findShown) },
      {
        label: 'Show Swatch Kinds',
        submenu: [
          ['all', 'Show All Swatches'],
          ['color', 'Show Color Swatches'],
          ['gradient', 'Show Gradient Swatches'],
          ['pattern', 'Show Pattern Swatches'],
        ].map(([v, label]) => ({ label, checked: this.show === v, run: () => this.setShow(v) })),
      },
      '-',
      ...SWATCH_VIEWS.map((v) => ({ label: v.label, checked: this.view === v.id, run: () => this.setView(v.id) })),
      '-',
      { label: 'Swatch Options...', enabled: this.selected.size === 1, run: () => this.editSelected() },
      '-',
      { label: 'Open Swatch Library', submenu: swatchLibraryMenu(app, (lib) => this.openLibraryFromMenu(lib)) },
      { label: 'Save Swatch Library...', enabled: has && swatchesOf(ed.doc).length > 0, run: () => saveSwatchLibrary(app, this.librarySwatches()) },
      { label: 'Export Swatch Library...', enabled: has && swatchesOf(ed.doc).length > 0, run: () => exportSwatchLibrary(app, this.librarySwatches()) },
      { label: 'Import Swatch Library...', enabled: has, run: () => importSwatchLibrary(app).then((lib) => lib && this.openLibraryFromMenu(lib)) },
    ];
  }

  /** Swatches to save as a library: the selected ones, or all. */
  librarySwatches() {
    const doc = this.app.editor.doc;
    const ids = this.selectedSwatchIds();
    const gids = new Set(this.selectedGroupIds());
    const picked = swatchesOf(doc).filter((s) => ids.includes(s.id) || gids.has(s.group));
    return (picked.length ? picked : swatchesOf(doc)).map((s) => ({ name: s.name, paint: structuredClone(s.paint), ...(s.global ? { global: true } : {}), ...(s.spot ? { spot: true } : {}) }));
  }

  setShow(v) {
    this.show = v;
    this.render();
  }

  duplicateSelected() {
    const doc = this.app.editor?.doc;
    const ids = this.selectedSwatchIds();
    if (!doc || !ids.length) return;
    let out = [];
    doc.transact('Duplicate Swatches', () => (out = duplicateSwatches(doc, ids)));
    this.selected = new Set(out);
    this.focusId = out[0] || null;
  }

  async mergeSelected() {
    const doc = this.app.editor?.doc;
    const ids = this.selectedSwatchIds();
    if (!doc || ids.length < 2) return;
    let keep = null;
    doc.transact('Merge Swatches', () => (keep = mergeSwatches(doc, ids)));
    this.selected = new Set(keep ? [keep] : []);
    this.focusId = keep;
    this.app.notify(`Merged ${ids.length} swatches into "${findSwatch(doc, keep)?.name}".`, { polite: true });
  }

  ungroupSelected() {
    const doc = this.app.editor?.doc;
    const gids = this.selectedGroupIds();
    if (!doc || !gids.length) return;
    doc.transact('Ungroup Color Group', () => ungroupGroups(doc, gids));
    for (const g of gids) this.selected.delete(g);
  }

  selectUnused() {
    const doc = this.app.editor?.doc;
    if (!doc) return;
    const ids = unusedSwatchIds(doc);
    this.selected = new Set(ids);
    this.focusId = ids[0] || null;
    // Hidden kinds or a search would hide part of the selection.
    this.show = 'all';
    this.query = '';
    this.search.value = '';
    this.render();
    this.app.notify(ids.length ? `Selected ${ids.length} unused ${ids.length === 1 ? 'swatch' : 'swatches'}.` : 'Every swatch is in use.', { polite: true });
  }

  addUsedColors() {
    const doc = this.app.editor?.doc;
    if (!doc) return;
    const colors = usedColorsMissing(doc);
    if (!colors.length) {
      this.app.notify('Every color in the document is already a swatch.', { polite: true });
      return;
    }
    const ids = [];
    doc.transact('Add Used Colors', () => {
      for (const c of colors) ids.push(addSwatch(doc, { name: colorName(c), paint: { type: 'solid', color: c } }));
    });
    this.selected = new Set(ids);
    this.app.notify(`Added ${ids.length} ${ids.length === 1 ? 'color' : 'colors'} to Swatches.`, { polite: true });
  }

  sortBy(by) {
    const doc = this.app.editor?.doc;
    if (!doc) return;
    doc.transact(by === 'kind' ? 'Sort Swatches by Kind' : 'Sort Swatches by Name', () => sortSwatches(doc, by));
  }

  update() {
    const ed = this.app.editor;
    this.el.classList.toggle('disabled', !ed);
    this.fs.refresh();
    const paint = ed ? focusedPaint(ed).paint : null;
    const key = ed ? [ed.doc.root.swatches, ed.doc.root.swatchGroups, paint && paint !== 'mixed' ? paintKey(paint) : paint, ed.focusPaint] : [];
    if (this.renderKey && key.length === this.renderKey.length && key.every((k, i) => k === this.renderKey[i])) return;
    this.renderKey = key;
    this.render();
  }

  render() {
    const ed = this.app.editor;
    const listView = isListView(this.view);
    this.list.classList.toggle('grid', !listView);
    this.list.classList.toggle('list', listView);
    for (const v of SWATCH_VIEWS) this.list.classList.toggle(`view-${v.id}`, v.id === this.view);
    if (!ed) {
      this.list.replaceChildren(h('p.panel-empty', 'No document'));
      return;
    }
    const doc = ed.doc;
    const valid = new Set([...swatchesOf(doc).map((s) => s.id), ...groupsOf(doc).map((g) => g.id)]);
    for (const id of [...this.selected]) if (!valid.has(id)) this.selected.delete(id);
    const { paint } = focusedPaint(ed);
    const activeId = paint && paint !== 'mixed' ? matchSwatch(doc, paint) : null;
    const rows = swatchRows(doc, { show: this.show, query: this.query });
    const items = [];
    if (!this.query && this.show !== 'gradient') items.push(this.item({ id: '__none', name: '[None]', paint: null }, false, paint === null));
    for (const r of rows) {
      if (r.kind === 'group') items.push(this.groupRow(r.group));
      else items.push(this.item(r.swatch, Boolean(r.swatch.group), r.swatch.id === activeId));
    }
    this.list.replaceChildren(...items);
    if (!items.length) this.list.append(h('p.panel-empty', 'No swatches match.'));
    const focusEl = this.list.querySelector(`[data-id="${CSS.escape(this.focusId || '')}"]`) || this.list.querySelector('[data-id]');
    if (focusEl) focusEl.tabIndex = 0;
    this.delBtn.disabled = !this.selected.size;
    this.optBtn.disabled = this.selected.size !== 1;
    this.recent.refresh();
  }

  item(sw, grouped, active) {
    const sel = this.selected.has(sw.id);
    const list = isListView(this.view);
    const label = sw.name + (sw.spot ? ' (Spot)' : sw.global ? ' (Global)' : '');
    const kind = sw.paint ? swatchKind(sw) : 'other';
    const el = h(
      'div.sw-item',
      {
        role: 'option',
        tabindex: '-1',
        'aria-selected': String(sel),
        'aria-label': label,
        'data-tip': list ? null : label,
        'data-id': sw.id,
      },
      paintSwatch(sw.paint),
      list ? h('span.sw-name', sw.name) : null,
      list && this.view === 'largeList' && KIND_LABELS[kind] ? h('span.sw-kind-label', KIND_LABELS[kind]) : null,
      sw.global ? h(sw.spot ? 'span.sw-global.sw-spot' : 'span.sw-global', { 'aria-hidden': 'true' }) : null,
      list && sw.paint ? h('span.sw-kind', { 'aria-hidden': 'true' }, icon(sw.paint.type === 'solid' ? 'square' : sw.paint.type === 'pattern' ? 'pattern-swatch' : 'paint-gradient', 12)) : null,
    );
    el.classList.toggle('grouped', grouped);
    el.classList.toggle('active', active);
    el.addEventListener('click', (e) => this.onClick(sw, e));
    // Pattern swatches open in pattern editing mode.
    el.addEventListener('dblclick', () => sw.id !== '__none' && (sw.paint?.type === 'pattern' && this.app.commands.get('pattern.edit') ? this.app.commands.run('pattern.edit', { patternId: sw.paint.id }) : this.editSwatch(sw.id)));
    if (sw.id !== '__none') this.enableDrag(el, sw.id);
    return el;
  }

  groupRow(g) {
    const sel = this.selected.has(g.id);
    const el = h(
      'div.sw-group',
      { role: 'option', tabindex: '-1', 'aria-selected': String(sel), 'aria-label': `Color group ${g.name}`, 'data-id': g.id, 'data-group': g.id },
      icon('folder', 14),
      h('span.sw-name', g.name),
    );
    el.addEventListener('click', (e) => {
      this.toggleSelect(g.id, e);
      this.render();
    });
    el.addEventListener('dblclick', () => this.renameGroup(g));
    return el;
  }

  toggleSelect(id, e) {
    if (e.metaKey || e.ctrlKey) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    } else if (e.shiftKey && this.focusId) {
      const ids = [...this.list.querySelectorAll('[data-id]')].map((n) => n.dataset.id).filter((x) => x !== '__none');
      const a = ids.indexOf(this.focusId);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(ids[i]);
    } else {
      this.selected = new Set(id === '__none' ? [] : [id]);
    }
    this.focusId = id;
  }

  onClick(sw, e) {
    this.toggleSelect(sw.id, e);
    if (!(e.metaKey || e.ctrlKey || e.shiftKey)) this.applySwatch(sw);
    this.render();
    this.list.querySelector(`[data-id="${CSS.escape(sw.id)}"]`)?.focus();
  }

  applySwatch(sw) {
    const ed = this.app.editor;
    if (!ed) return;
    const key = ed.focusPaint;
    const paint = sw.id === '__none' ? null : paintFromSwatch(sw);
    if (paint?.type === 'solid') ed.lastSolid = { ...(ed.lastSolid || {}), [key]: paint.color };
    applyStyle(ed, { [key]: paint }, 'Apply Swatch');
  }

  onKey(e) {
    const items = [...this.list.querySelectorAll('[data-id]')];
    const cur = items.indexOf(document.activeElement);
    if (cur < 0) return;
    const move = (i) => {
      const t = items[Math.max(0, Math.min(items.length - 1, i))];
      items.forEach((x) => (x.tabIndex = -1));
      t.tabIndex = 0;
      t.focus();
      this.focusId = t.dataset.id;
    };
    let cols = 1;
    if (!isListView(this.view) && items.length > 1) {
      const top = items[0].offsetTop;
      cols = Math.max(1, items.filter((x) => x.offsetTop === top).length);
    }
    e.stopPropagation();
    if (e.key === 'ArrowRight') move(cur + 1);
    else if (e.key === 'ArrowLeft') move(cur - 1);
    else if (e.key === 'ArrowDown') move(cur + cols);
    else if (e.key === 'ArrowUp') move(cur - cols);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      const id = items[cur].dataset.id;
      const sw = id === '__none' ? { id, paint: null } : findSwatch(this.app.editor.doc, id);
      if (sw) {
        this.selected = new Set(id === '__none' ? [] : [id]);
        this.applySwatch(sw);
      } else this.toggleSelect(id, e);
      this.render();
      this.list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
    } else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelected();
    else return;
    e.preventDefault();
  }

  enableDrag(el, id) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let dragging = false;
      let target = null;
      const move = (ev) => {
        if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 5) {
          dragging = true;
          if (!this.selected.has(id)) this.selected = new Set([id]);
          try {
            el.setPointerCapture(ev.pointerId);
          } catch {
            // Synthetic or already released pointer.
          }
          this.list.classList.add('dragging');
        }
        if (!dragging) return;
        const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-id]');
        this.list.querySelectorAll('.drop-before, .drop-into').forEach((n) => n.classList.remove('drop-before', 'drop-into'));
        target = under && this.list.contains(under) && under.dataset.id !== '__none' ? under : null;
        if (target) target.classList.add(target.dataset.group ? 'drop-into' : 'drop-before');
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        this.list.classList.remove('dragging');
        if (!dragging) return;
        this.list.querySelectorAll('.drop-before, .drop-into').forEach((n) => n.classList.remove('drop-before', 'drop-into'));
        const doc = this.app.editor?.doc;
        if (!doc || !target) return;
        const ids = [...this.selected].filter((s) => findSwatch(doc, s));
        if (!ids.length || ids.includes(target.dataset.id)) return;
        doc.transact('Move Swatches', () => {
          if (target.dataset.group) moveSwatches(doc, ids, null, target.dataset.group);
          else {
            const before = findSwatch(doc, target.dataset.id);
            moveSwatches(doc, ids, before.id, before.group || null);
          }
        });
        // Clicks after a drag should not apply the swatch.
        const stop = (ev) => {
          ev.stopPropagation();
          el.removeEventListener('click', stop, true);
        };
        el.addEventListener('click', stop, true);
        setTimeout(() => el.removeEventListener('click', stop, true), 0);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  async newSwatch(direct = false) {
    const id = await createSwatchFromFocused(this.app, { direct });
    if (!id) return;
    this.selected = new Set([id]);
    this.focusId = id;
    this.render();
  }

  async editSelected() {
    const id = [...this.selected][0];
    if (!id) return;
    const g = groupsOf(this.app.editor.doc).find((x) => x.id === id);
    if (g) this.renameGroup(g);
    else this.editSwatch(id);
  }

  async editSwatch(id) {
    const ed = this.app.editor;
    if (!ed) return;
    const doc = ed.doc;
    const sw = findSwatch(doc, id);
    if (!sw) return;
    // Preview runs inside an open transaction that Cancel rolls back.
    const tx = doc.begin('Swatch Options');
    const preview = (r) => {
      updateSwatch(doc, id, r ? { paint: r.paint, global: sw.global } : { paint: sw.paint, global: sw.global });
    };
    let res = null;
    try {
      res = await swatchOptionsDialog(this.app, { swatch: sw, onPreview: sw.global && sw.paint?.type === 'solid' ? preview : null });
    } finally {
      if (!res) tx.cancel();
    }
    if (!res) return;
    updateSwatch(doc, id, { name: res.name, paint: res.paint, global: res.global || undefined, spot: res.spot || undefined, mode: res.mode });
    tx.commit();
    if (sw.global && swatchUsage(doc, id)) this.app.notify(`Updated objects using "${res.name}".`, { polite: true });
  }

  async renameGroup(g) {
    const res = await this.app.dialogs.form({ title: 'Color Group Options', fields: [{ key: 'name', label: 'Name', type: 'text', value: g.name }] });
    if (!res || !res.name.trim()) return;
    const doc = this.app.editor.doc;
    doc.transact('Rename Color Group', () => renameGroup(doc, g.id, res.name.trim()));
  }

  async newGroup() {
    const ed = this.app.editor;
    if (!ed) return;
    const doc = ed.doc;
    const swIds = [...this.selected].filter((id) => findSwatch(doc, id));
    const artColors = ed.selection.size ? collectColors(colorTargets(doc, ed.topSelection())) : [];
    if (!swIds.length && !artColors.length) {
      this.app.notify('Select swatches or artwork to make a color group.');
      return;
    }
    const n = groupsOf(doc).length + 1;
    const fields = [{ key: 'name', label: 'Name', type: 'text', value: `Color Group ${n}` }];
    if (swIds.length && artColors.length) {
      fields.push({ key: 'from', label: 'Create From', type: 'radio', value: 'swatches', options: [{ value: 'swatches', label: 'Selected Swatches' }, { value: 'art', label: 'Selected Artwork' }] });
    }
    const res = await this.app.dialogs.form({ title: 'New Color Group', fields });
    if (!res) return;
    const fromArt = res.from ? res.from === 'art' : !swIds.length;
    doc.transact('New Color Group', () => {
      const gid = fromArt
        ? addGroup(doc, res.name, { paints: artColors.map((c) => ({ name: colorName(c.color), paint: { type: 'solid', color: c.color } })) })
        : addGroup(doc, res.name, { swatchIds: swIds });
      this.selected = new Set([gid]);
      this.focusId = gid;
    });
  }

  async deleteSelected() {
    const ed = this.app.editor;
    if (!ed || !this.selected.size) return;
    const ok = await this.app.dialogs.confirm({ title: 'Delete Swatches', message: 'Delete the swatch selection?', okLabel: 'Delete', danger: true });
    if (!ok) return;
    const doc = ed.doc;
    doc.transact('Delete Swatches', () => removeSwatches(doc, [...this.selected]));
    this.selected.clear();
  }

  openKinds(anchor) {
    const set = (v) => this.setShow(v);
    this.app.showMenuAt(
      anchor,
      [
        { label: 'Show All Swatches', checked: this.show === 'all', run: () => set('all') },
        { label: 'Show Color Swatches', checked: this.show === 'color', run: () => set('color') },
        { label: 'Show Gradient Swatches', checked: this.show === 'gradient', run: () => set('gradient') },
        { label: 'Show Pattern Swatches', checked: this.show === 'pattern', run: () => set('pattern') },
      ],
      'Show swatch kinds',
    );
  }

  openLibraries(anchor) {
    this.app.showMenuAt(anchor, swatchLibraryMenu(this.app, (lib) => this.openLibrary(anchor, lib)), 'Swatch libraries');
  }

  /** Open a library from a menu: anchored to the library button in the footer. */
  openLibraryFromMenu(lib) {
    const anchor = this.footer.querySelector('button') || this.el;
    this.openLibrary(anchor, lib);
  }

  openLibrary(anchor, lib) {
    const app = this.app;
    const grid = h('div.swatch-grid.sw-lib-grid', { role: 'listbox', 'aria-label': `${lib.name} swatches` });
    for (const s of lib.swatches) {
      grid.append(
        h('button.swatch-cell', {
          type: 'button',
          role: 'option',
          'aria-label': s.name,
          'data-tip': s.name,
          onclick: () => {
            const ed = app.editor;
            if (!ed) return;
            const doc = ed.doc;
            doc.transact('Add Swatch', () => {
              // Pattern swatches bring their pattern definition into the document.
              if (s.pattern) app.patterns?.ensureDef(doc, s.pattern);
              if (!swatchesOf(doc).some((x) => x.name === s.name && JSON.stringify(x.paint) === JSON.stringify(s.paint))) addSwatch(doc, structuredClone(s));
              applyStyle(ed, { [ed.focusPaint]: structuredClone(s.paint) }, 'Apply Swatch');
            });
          },
        }, paintSwatch(s.paint)),
      );
    }
    const addAll = h('button.btn.small', { type: 'button', onclick: () => {
      const ed = app.editor;
      if (!ed) return;
      ed.doc.transact('Add Swatches', () => {
        for (const s of lib.swatches) if (s.pattern) app.patterns?.ensureDef(ed.doc, s.pattern);
        addGroup(ed.doc, lib.name, { paints: lib.swatches.map((s) => ({ name: s.name, paint: structuredClone(s.paint) })) });
      });
      closePopover();
      app.notify(`Added ${lib.name} to Swatches.`, { polite: true });
    } }, 'Add All to Swatches');
    openPopover(anchor, h('div.sw-lib', h('h3.popover-title', lib.name), grid, h('div.popover-actions', addAll)), { label: `${lib.name} swatch library` });
  }
}

/** The swatch that a paint came from (by link) or matches exactly, or null. */
export function matchSwatch(doc, paint) {
  if (!paint) return null;
  const list = swatchesOf(doc);
  if (paint.swatchId && list.some((s) => s.id === paint.swatchId)) return paint.swatchId;
  if (paint.type === 'pattern') return list.find((s) => s.paint?.type === 'pattern' && s.paint.id === paint.id)?.id || null;
  if (paint.type === 'solid') {
    const c = paint.color.toLowerCase();
    for (const s of list) if (s.paint?.type === 'solid' && s.paint.color.toLowerCase() === c) return s.id;
    return null;
  }
  const key = paintKey(paint);
  for (const s of list) if (s.paint && s.paint.type !== 'solid' && paintKey(s.paint) === key) return s.id;
  return null;
}

const keyCache = new WeakMap();
function paintKey(p) {
  let k = keyCache.get(p);
  if (k === undefined) {
    const out = { ...p };
    delete out.swatchId;
    if (isGradient(out)) {
      delete out.x1;
      delete out.y1;
      delete out.x2;
      delete out.y2;
    }
    k = JSON.stringify(out);
    keyCache.set(p, k);
  }
  return k;
}
