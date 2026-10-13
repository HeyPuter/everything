/**
 * Swatches panel: the document's swatches (doc.root.swatches, undoable) in
 * small / medium / large thumbnail or small / large list views, with color
 * groups as folder rows, Recent Colors, a find field, Show Kinds, swatch
 * libraries, New Swatch / New Color Group / Swatch Options / Delete, drag
 * to reorder (or into a group) and keyboard navigation. Clicking a swatch
 * applies it to the focused fill or stroke; global and spot swatches stay
 * linked to the objects using them (see swatch-model.js). The panel menu
 * adds duplicate, merge, ungroup, select unused, add used or selected
 * colors, Edit Color Group (Recolor over a group's colors), Spot Colors,
 * sorting, and opening, saving, importing and exporting swatch libraries
 * (JSON, a binary swatch exchange format, CSS, text palettes).
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton, paintSwatch, updatePaintSwatch } from '../../ui/widgets.js';
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
import { recolorDialog } from './edit-colors-ui.js';
import { spotColorsDialog } from './spot-colors.js';
import { stackPaints, mapStackPaints } from '../../model/appearance.js';
import { isGradient } from '../../model/gradients.js';
import { createGradientSlider } from './gradient-slider.js';
import { setStop, moveStop, reverseGradient, setGradientType, gradientAngle, setGradientAngle } from './gradient-model.js';

/**
 * Swatch Options dialog. Resolves to { name, global, spot, mode, paint },
 * { ..., action: 'editPattern' } for a pattern swatch whose Edit Pattern
 * button was used, or null. Color swatches edit their color type, mode and
 * color; gradient swatches their type, stops (slider, stop color, opacity
 * and location), angle and aspect ratio; pattern swatches show their tile
 * and open pattern editing.
 */
export function swatchOptionsDialog(app, { title = 'Swatch Options', swatch, onPreview }) {
  const paint = swatch.paint;
  const isSolid = paint?.type === 'solid';
  const isGrad = isGradient(paint);
  const isPattern = paint?.type === 'pattern';
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
  const grad = isGrad ? gradientEditor(paint) : null;
  const result = (action) => ({
    name: name.value.trim() || (isSolid ? colorName(color) : swatch.name || (isPattern ? 'Pattern' : 'Gradient')),
    global: isSolid && type.value !== 'process',
    spot: isSolid && type.value === 'spot',
    mode,
    paint: isSolid ? { type: 'solid', color } : grad ? grad.paint() : paint,
    ...(action ? { action } : {}),
  });
  let close = null;
  const patternPart = isPattern
    ? h(
        'div.swo-pattern',
        h('div.swo-grad', paintSwatch(paint)),
        h('p.muted', 'The tile, its layout and its artwork are edited in pattern editing mode.'),
        app.commands?.get?.('pattern.edit') ? h('button.btn.small', { type: 'button', onclick: () => close?.('editPattern') }, 'Edit Pattern...') : null,
      )
    : null;
  const body = h(
    'div.form.swo',
    h('div.form-row', h('label', { for: 'swo-name' }, 'Swatch Name'), name),
    isSolid ? h('div.form-row', h('label', { for: 'swo-type' }, 'Color Type'), type) : null,
    isSolid ? h('div.form-row', h('label', { for: 'swo-mode' }, 'Color Mode'), modeSel) : null,
    isSolid ? h('div.swo-color', chip, sliders.el) : grad ? grad.el : patternPart || h('div.swo-grad', paintSwatch(paint)),
    isSolid ? h('div.form-row', h('label', '#'), hex) : null,
    isSolid && onPreview ? h('div.check-row', preview, h('label', { for: 'swo-preview' }, 'Preview')) : null,
  );
  if (isSolid) setColor(color);
  return openDialog({
    title,
    body,
    className: 'swatch-options',
    initialFocus: () => name,
    // The Edit Pattern button closes the dialog with that action.
    onOpen: ({ close: done }) => (close = (action) => done(result(action))),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, value: () => result() },
    ],
  });
}

/** Gradient swatch editing: type, slider with stops, stop color / opacity / location, angle, aspect. */
function gradientEditor(initial) {
  let paint = structuredClone(initial);
  let sel = 0;
  const swatch = paintSwatch(paint);
  const slider = createGradientSlider({
    label: 'Swatch gradient',
    onSelect: (i) => {
      sel = i;
      syncStop();
    },
    onChange: (p) => {
      paint = p;
      sel = slider.selected;
      sync();
    },
    onEditStop: () => stopColor.click(),
  });
  const typeSel = h('select', { id: 'swo-gtype' }, h('option', { value: 'linear', selected: paint.type === 'linear' }, 'Linear'), h('option', { value: 'radial', selected: paint.type === 'radial' }, 'Radial'));
  typeSel.addEventListener('change', () => {
    paint = setGradientType(paint, typeSel.value);
    sync();
  });
  const num = (id, label, value, min, max, onChange) => {
    const input = h('input.swo-num', { type: 'number', id, min, max, step: 1, value: String(value) });
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
    });
    return { input, row: h('div.form-row', h('label', { for: id }, label), input) };
  };
  const angle = num('swo-angle', 'Angle (°)', Math.round(gradientAngle(paint) * 100) / 100, -360, 360, (v) => {
    paint = setGradientAngle(paint, v);
    sync();
  });
  const aspect = num('swo-aspect', 'Aspect Ratio (%)', Math.round((paint.aspect ?? 1) * 100), 1, 32767, (v) => {
    paint = { ...paint, aspect: v / 100 };
    sync();
  });
  const stopColor = h('input.swo-stop-color', { type: 'color', id: 'swo-stop-color' });
  stopColor.addEventListener('input', () => {
    paint = setStop(paint, sel, { color: stopColor.value });
    sync(false);
  });
  const opacity = num('swo-stop-opacity', 'Opacity (%)', 100, 0, 100, (v) => {
    paint = setStop(paint, sel, { opacity: v / 100 });
    sync();
  });
  const location = num('swo-stop-location', 'Location (%)', 0, 0, 100, (v) => {
    const r = moveStop(paint, sel, v / 100);
    paint = r.paint;
    sel = r.index;
    sync();
  });
  const reverse = h('button.btn.small', { type: 'button', onclick: () => {
    paint = reverseGradient(paint);
    sync();
  } }, 'Reverse');
  const syncStop = () => {
    const s = paint.stops[sel];
    if (!s) return;
    stopColor.value = s.color;
    opacity.input.value = String(Math.round((s.opacity ?? 1) * 100));
    location.input.value = String(Math.round(s.offset * 1000) / 10);
  };
  const sync = (setSlider = true) => {
    updatePaintSwatch(swatch, paint);
    if (setSlider) slider.set(paint, sel);
    aspect.row.hidden = paint.type !== 'radial';
    angle.input.value = String(Math.round(gradientAngle(paint) * 100) / 100);
    syncStop();
  };
  const el = h(
    'div.swo-gradient',
    h('div.swo-grad', swatch),
    h('div.form-row', h('label', { for: 'swo-gtype' }, 'Type'), typeSel, reverse),
    h('div.swo-slider', slider.el),
    h('div.swo-stop', h('div.form-row', h('label', { for: 'swo-stop-color' }, 'Stop Color'), stopColor), opacity.row, location.row),
    angle.row,
    aspect.row,
  );
  slider.set(paint, 0);
  sync();
  return { el, paint: () => paint };
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
      (this.groupBtn = iconButton('palette', 'Edit Color Group', () => this.editColorGroup(), { className: 'small' })),
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
    const hasArtColors = has && ed.selection.size > 0;
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
      { label: 'Add Selected Colors', enabled: hasArtColors, run: () => this.addSelectedColors() },
      { label: 'Add Selected Colors as Global Swatches', enabled: hasArtColors, run: () => this.addSelectedColors({ global: true }) },
      { label: 'Add Selected Colors as Color Group', enabled: hasArtColors, run: () => this.addSelectedColors({ group: true }) },
      '-',
      { label: 'Edit Color Group...', enabled: Boolean(this.editableGroup()), run: () => this.editColorGroup() },
      { label: 'Spot Colors...', enabled: has, run: () => spotColorsDialog(app) },
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
      { label: 'Export as Swatch Exchange File...', enabled: has && swatchesOf(ed.doc).length > 0, run: () => exportSwatchLibrary(app, this.librarySwatches(), { format: 'vswx' }) },
      { label: 'Import Swatch Library...', enabled: has, run: () => importSwatchLibrary(app).then((lib) => lib && this.openLibraryFromMenu(lib)) },
    ];
  }

  /** Swatches to save as a library: the selected ones, or all. */
  librarySwatches() {
    const doc = this.app.editor.doc;
    const ids = this.selectedSwatchIds();
    const gids = new Set(this.selectedGroupIds());
    const picked = swatchesOf(doc).filter((s) => ids.includes(s.id) || gids.has(s.group));
    const groupName = new Map(groupsOf(doc).map((g) => [g.id, g.name]));
    return (picked.length ? picked : swatchesOf(doc)).map((s) => ({
      name: s.name,
      paint: structuredClone(s.paint),
      ...(s.global ? { global: true } : {}),
      ...(s.spot ? { spot: true } : {}),
      ...(s.mode && s.mode !== 'rgb' ? { mode: s.mode } : {}),
      ...(s.spotCmyk ? { spotCmyk: { ...s.spotCmyk } } : {}),
      ...(groupName.has(s.group) ? { group: groupName.get(s.group) } : {}),
    }));
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

  /**
   * Add the colors of the selected artwork as swatches (those not already
   * swatches): process swatches, global swatches the artwork then links
   * to, or a new color group.
   */
  addSelectedColors({ global = false, group = false } = {}) {
    const ed = this.app.editor;
    if (!ed) return;
    const doc = ed.doc;
    const colors = collectColors(colorTargets(doc, ed.topSelection())).map((c) => c.color.toLowerCase());
    if (!colors.length) {
      this.app.notify('The selection has no colors to add.', { polite: true });
      return;
    }
    const have = new Map();
    for (const s of swatchesOf(doc)) if (s.paint?.type === 'solid' && !s.group && (!global || s.global)) have.set(s.paint.color.toLowerCase(), s.id);
    const ids = [];
    doc.transact(group ? 'Add Selected Colors as Color Group' : 'Add Selected Colors', () => {
      if (group) {
        const gid = addGroup(doc, `Color Group ${groupsOf(doc).length + 1}`, { paints: colors.map((c) => ({ name: colorName(c), paint: { type: 'solid', color: c } })) });
        ids.push(gid);
        return;
      }
      for (const c of colors) {
        if (have.has(c)) continue;
        const id = addSwatch(doc, { name: colorName(c), paint: { type: 'solid', color: c }, global });
        have.set(c, id);
        ids.push(id);
      }
      // Global swatches: the artwork the colors came from now uses them.
      if (global) linkColorsToSwatches(doc, ed.topSelection(), have);
    });
    this.selected = new Set(ids);
    this.focusId = ids[0] || null;
    if (!ids.length) this.app.notify('Every selected color is already a swatch.', { polite: true });
    else this.app.notify(group ? `Added a color group of ${colors.length} ${colors.length === 1 ? 'color' : 'colors'}.` : `Added ${ids.length} ${ids.length === 1 ? 'swatch' : 'swatches'}.`, { polite: true });
  }

  /** The color group Edit Color Group works on: the selected group, or the group of the selected swatch. */
  editableGroup() {
    const doc = this.app.editor?.doc;
    if (!doc) return null;
    const groups = this.selectedGroupIds();
    if (groups.length === 1) return groups[0];
    if (groups.length) return null;
    const owners = new Set(this.selectedSwatchIds().map((id) => findSwatch(doc, id)?.group).filter(Boolean));
    return owners.size === 1 ? [...owners][0] : null;
  }

  /** Edit Color Group: recolor the group's colors (and optionally the selected artwork). */
  editColorGroup() {
    const gid = this.editableGroup();
    if (gid) return recolorDialog(this.app, { group: gid });
    return null;
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
    this.groupBtn.disabled = !this.editableGroup();
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
    // Double-clicking a color group edits its colors (Swatch Options renames it).
    el.addEventListener('dblclick', () => recolorDialog(this.app, { group: g.id }));
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
    updateSwatch(doc, id, { name: res.name, paint: res.paint, global: res.global || undefined, spot: res.spot || undefined, mode: res.paint?.type === 'solid' ? res.mode : undefined });
    tx.commit();
    if (sw.global && swatchUsage(doc, id)) this.app.notify(`Updated objects using "${res.name}".`, { polite: true });
    if (res.action === 'editPattern' && sw.paint?.type === 'pattern') this.app.commands.run('pattern.edit', { patternId: sw.paint.id });
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
        // A library's own color groups stay groups; the rest go into one group named after the library.
        const groups = new Map();
        const groupFor = (name) => {
          if (!groups.has(name)) groups.set(name, addGroup(ed.doc, name));
          return groups.get(name);
        };
        for (const s of lib.swatches) {
          const { group, pattern, ...rest } = structuredClone(s);
          addSwatch(ed.doc, { ...rest, group: groupFor(group || lib.name) });
        }
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

/** Link the solid paints of the artwork under `ids` to swatches by color (Map color -> swatch id). */
export function linkColorsToSwatches(doc, ids, byColor) {
  const link = (p) => {
    if (p?.type !== 'solid' || p.swatchId) return p;
    const id = byColor.get(p.color.toLowerCase());
    return id ? { ...p, swatchId: id } : p;
  };
  for (const n of colorTargets(doc, ids)) {
    const patch = {};
    for (const key of ['fill', 'stroke']) {
      const next = link(n[key]);
      if (next !== n[key]) patch[key] = next;
    }
    if (n.type === 'text' && n.runs?.some((r) => r.fill || r.stroke)) {
      const runs = n.runs.map((r) => ({ ...r, ...(r.fill ? { fill: link(r.fill) } : {}), ...(r.stroke ? { stroke: link(r.stroke) } : {}) }));
      patch.runs = runs;
    }
    if (stackPaints(n).length) {
      const stack = mapStackPaints(n, (p) => link(p));
      if (stack) patch.appearance = stack;
    }
    if (Object.keys(patch).length) doc.update(n.id, patch);
  }
}
