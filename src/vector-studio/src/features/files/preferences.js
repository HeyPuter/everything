/**
 * Preferences (Mod+K), in sections. Values are
 * staged while the dialog is open; OK writes them to app.prefs and applies
 * them (theme, guide and alignment guide colors, grid of the active document,
 * autosave), Cancel discards them.
 */
import { h } from '../../lib/dom.js';
import { formatLength, parseLength, parseNumber, unitOptions } from '../../lib/units.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { applyTheme } from '../../theme.js';
import { UNIT_OPTIONS } from './presets.js';

export const PREF_DEFAULTS = {
  constrainAngle: 0,
  cornerRadius: 12,
  doubleClickToIsolate: true,
  selectionTolerance: 3,
  selectBehind: true,
  anchorSize: 6,
  strokeUnits: 'pt',
  typeUnits: 'pt',
  guideColor: 'cyan',
  guideStyle: 'lines',
  gridColor: 'default',
  gridStyle: 'lines',
  gridSpacing: 72,
  gridSubdivisions: 8,
  gridsInBack: true,
  alignmentGuideColor: 'magenta',
  alignmentGuideLabels: true,
  alignmentGuideHighlight: true,
  snapTolerance: 5,
  autosaveEnabled: true,
  autosaveMinutes: 2,
  filesSaveDialog: 'vector-studio',
  filesUseDocuments: true,
  filesOfferSignIn: true,
  recentFilesMax: 20,
  transformPatterns: true,
  showTooltips: true,
  zoomWithWheel: false,
  showStartScreen: true,
  objectSelectionByPath: false,
  zoomToSelection: true,
  showMultiHandles: true,
  showArtboardNames: true,
  typeSizeIncrement: 2,
  typeTrackingIncrement: 20,
  typeBaselineIncrement: 2,
  typePlaceholder: true,
  bareNumbersArePoints: false,
  showSliceNumbers: true,
  canvasColor: 'match',
  undoLevels: 200,
};

export const GUIDE_COLORS = [
  { value: 'cyan', label: 'Cyan', color: '#3fd6ff' },
  { value: 'light-blue', label: 'Light Blue', color: '#4f9dff' },
  { value: 'green', label: 'Green', color: '#30c26b' },
  { value: 'magenta', label: 'Magenta', color: '#ff3fb4' },
  { value: 'red', label: 'Red', color: '#ff4f4f' },
  { value: 'orange', label: 'Orange', color: '#ff8a3d' },
  { value: 'yellow', label: 'Yellow', color: '#ffc34f' },
  { value: 'gray', label: 'Gray', color: '#8f8f8f' },
];

const colorOf = (v, fallback) => GUIDE_COLORS.find((c) => c.value === v)?.color || (/^#[0-9a-f]{6}$/i.test(v || '') ? v : fallback);

/** Fill preference keys this module adds when the stored prefs predate them. */
export function ensurePrefDefaults(prefs) {
  for (const [k, v] of Object.entries(PREF_DEFAULTS)) if (prefs.values[k] === undefined) prefs.values[k] = v;
}

/** Push preference values into the running app (CSS variables, editors, theme). */
export function applyPrefs(app) {
  const p = app.prefs;
  const root = document.documentElement;
  const setVar = (name, value) => (value ? root.style.setProperty(name, value) : root.style.removeProperty(name));
  setVar('--guide-color', p.get('guideColor') === 'cyan' ? null : colorOf(p.get('guideColor'), null));
  setVar('--guide-style', p.get('guideStyle') === 'dots' ? 'dots' : null);
  setVar('--alignment-guide-color', p.get('alignmentGuideColor') === 'magenta' ? null : colorOf(p.get('alignmentGuideColor'), null));
  setVar('--grid-color', p.get('gridColor') === 'default' ? null : colorOf(p.get('gridColor'), null));
  setVar('--pasteboard', p.get('canvasColor') === 'white' ? '#ffffff' : null);
  // Tooltips read this switch when they are about to show.
  if (p.get('showTooltips') === false) root.dataset.tooltips = 'off';
  else delete root.dataset.tooltips;
  unitOptions.bareUnit = p.get('bareNumbersArePoints') ? 'pt' : null;
  for (const ed of app.editors) applyEditorPrefs(app, ed);
  for (const v of app.views.values()) (v.refreshColors ? v.refreshColors() : v.invalidate());
  app.rulers?.refresh?.();
}

/** Per-editor defaults taken from preferences (run when a document opens). */
export function applyEditorPrefs(app, editor) {
  const levels = Number(app.prefs.get('undoLevels'));
  if (Number.isFinite(levels) && levels >= 1) editor.doc.historyLimit = Math.round(levels);
  const front = app.prefs.get('gridsInBack') === false;
  if (Boolean(editor.viewOptions.gridInFront) !== front) editor.viewOptions = { ...editor.viewOptions, gridInFront: front };
  if (!editor._prefsApplied) {
    editor._prefsApplied = true;
    const sg = app.prefs.get('alignmentGuides');
    if (sg === false && editor.viewOptions.alignmentGuides) editor.viewOptions = { ...editor.viewOptions, alignmentGuides: false };
  }
}

/**
 * Section definitions. Field types: checkbox, select, length, number,
 * angle, color-select (named colors plus custom), button.
 */
export function sections(app) {
  const unitOpts = UNIT_OPTIONS;
  return [
    {
      id: 'general',
      label: 'General',
      fields: [
        { key: 'keyboardIncrement', label: 'Keyboard Increment', type: 'length', min: 0.001, max: 1000 },
        { key: 'constrainAngle', label: 'Constrain Angle', type: 'angle', min: -360, max: 360 },
        { key: 'cornerRadius', label: 'Corner Radius', type: 'length', min: 0, max: 1000 },
        { type: 'heading', label: 'Editing' },
        { key: 'autoAddDelete', label: 'Disable Auto Add/Delete', type: 'checkbox', invert: true, help: 'The Pen tool adds and deletes anchor points when it is over a selected path.' },
        { key: 'doubleClickToIsolate', label: 'Double Click To Isolate', type: 'checkbox' },
        { key: 'previewBounds', label: 'Use Preview Bounds', type: 'checkbox', help: 'Sizes and alignment include stroke widths and effects.' },
        { type: 'heading', label: 'Transforming' },
        { key: 'transformPatterns', label: 'Transform Pattern Tiles', type: 'checkbox' },
        { key: 'scaleCorners', label: 'Scale Corners', type: 'checkbox' },
        { key: 'scaleStrokes', label: 'Scale Strokes & Effects', type: 'checkbox' },
        { type: 'heading', label: 'Workspace' },
        { key: 'showTooltips', label: 'Show Tool Tips', type: 'checkbox' },
        { key: 'zoomWithWheel', label: 'Zoom with Mouse Wheel', type: 'checkbox', help: 'The wheel zooms; hold Alt (Option) to scroll instead.' },
        { key: 'showStartScreen', label: 'Show the Home Screen When No Documents Are Open', type: 'checkbox' },
      ],
    },
    {
      id: 'selection',
      label: 'Selection & Anchor Display',
      fields: [
        { type: 'heading', label: 'Selection' },
        { key: 'selectionTolerance', label: 'Tolerance (px)', type: 'number', min: 1, max: 8, step: 1, integer: true },
        { key: 'selectBehind', label: 'Command-click to select objects behind', type: 'checkbox' },
        { key: 'objectSelectionByPath', label: 'Object Selection by Path Only', type: 'checkbox', help: 'Clicking inside a filled shape does not select it; click its outline.' },
        { key: 'zoomToSelection', label: 'Zoom to Selection', type: 'checkbox', help: 'Zoom In and Zoom Out keep the selection in the middle of the window.' },
        { type: 'heading', label: 'Anchor Points and Handles' },
        {
          key: 'anchorSize',
          label: 'Anchor Point Size',
          type: 'select',
          options: [
            { value: 4, label: 'Small' },
            { value: 6, label: 'Medium' },
            { value: 8, label: 'Large' },
          ],
        },
        { key: 'showMultiHandles', label: 'Show Handles When Multiple Anchors Are Selected', type: 'checkbox' },
        { type: 'heading', label: 'Artboards' },
        { key: 'showArtboardNames', label: 'Show Artboard Names on Canvas', type: 'checkbox' },
      ],
    },
    {
      id: 'type',
      label: 'Type',
      fields: [
        { type: 'heading', label: 'Keyboard Increments' },
        { key: 'typeSizeIncrement', label: 'Size/Leading', type: 'length', min: 0.001, max: 72 },
        { key: 'typeTrackingIncrement', label: 'Tracking (/1000 em)', type: 'number', min: 1, max: 1000, integer: true },
        { key: 'typeBaselineIncrement', label: 'Baseline Shift', type: 'length', min: 0.001, max: 72 },
        { type: 'heading', label: 'New Type' },
        { key: 'typePlaceholder', label: 'Fill New Type Objects With Placeholder Text', type: 'checkbox' },
      ],
    },
    {
      id: 'units',
      label: 'Units',
      fields: [
        { key: 'units', label: 'General', type: 'select', options: unitOpts, help: 'Also changes the units of the active document.' },
        { key: 'strokeUnits', label: 'Stroke', type: 'select', options: unitOpts },
        { key: 'typeUnits', label: 'Type', type: 'select', options: unitOpts },
        { key: 'bareNumbersArePoints', label: 'Numbers Without Units Are Points', type: 'checkbox', help: 'A value typed without a unit (like 12) is read as points instead of the field\'s unit.' },
      ],
    },
    {
      id: 'guides',
      label: 'Guides & Grid',
      fields: [
        { type: 'heading', label: 'Guides' },
        { key: 'guideColor', label: 'Color', type: 'color-select', options: GUIDE_COLORS },
        { key: 'guideStyle', label: 'Style', type: 'select', options: [{ value: 'lines', label: 'Lines' }, { value: 'dots', label: 'Dots' }] },
        { type: 'heading', label: 'Grid' },
        { key: 'gridColor', label: 'Color', type: 'color-select', options: [{ value: 'default', label: 'Default', color: null }, ...GUIDE_COLORS] },
        { key: 'gridStyle', label: 'Style', type: 'select', options: [{ value: 'lines', label: 'Lines' }, { value: 'dots', label: 'Dots' }] },
        { key: 'gridSpacing', label: 'Gridline every', type: 'length', min: 1, max: 10000 },
        { key: 'gridSubdivisions', label: 'Subdivisions', type: 'number', min: 1, max: 100, integer: true },
        { key: 'gridsInBack', label: 'Grids In Back', type: 'checkbox' },
      ],
      note: 'Grid spacing applies to the active document and to new documents.',
    },
    {
      id: 'alignment',
      label: 'Alignment Guides',
      fields: [
        { key: 'alignmentGuides', label: 'Alignment Guides on in new windows', type: 'checkbox' },
        { key: 'alignmentGuideColor', label: 'Color', type: 'color-select', options: GUIDE_COLORS },
        { key: 'alignmentGuideHighlight', label: 'Object Highlighting', type: 'checkbox' },
        { key: 'alignmentGuideLabels', label: 'Anchor/Path Labels', type: 'checkbox' },
        { key: 'snapTolerance', label: 'Snapping Tolerance (px)', type: 'number', min: 1, max: 20, integer: true },
      ],
    },
    {
      id: 'slices',
      label: 'Slices',
      fields: [{ key: 'showSliceNumbers', label: 'Show Slice Numbers', type: 'checkbox' }],
    },
    {
      id: 'ui',
      label: 'User Interface',
      fields: [
        {
          key: 'theme',
          label: 'Theme',
          type: 'select',
          options: [
            { value: 'system', label: 'Use System Setting' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ],
        },
        {
          key: 'canvasColor',
          label: 'Canvas Color',
          type: 'select',
          options: [
            { value: 'match', label: 'Match Theme' },
            { value: 'white', label: 'White' },
          ],
        },
      ],
    },
    {
      id: 'performance',
      label: 'Performance',
      fields: [{ key: 'undoLevels', label: 'History States', type: 'number', min: 5, max: 1000, integer: true, help: 'How many steps Undo can go back in each document. Fewer steps use less memory.' }],
    },
    {
      id: 'files',
      label: 'File Handling',
      fields: [
        { key: 'autosaveEnabled', label: 'Automatically Save Recovery Data', type: 'checkbox' },
        { key: 'autosaveMinutes', label: 'Interval (minutes)', type: 'number', min: 0.5, max: 60 },
        {
          key: 'filesSaveDialog',
          label: 'Save As opens',
          type: 'select',
          options: [
            { value: 'vector-studio', label: 'Your files (with Choose Location)' },
            { value: 'puter', label: 'The Puter file dialog' },
          ],
        },
        { key: 'filesUseDocuments', label: 'Keep Your files in Documents/Vector Studio', type: 'checkbox', help: 'Asks once for access to your Documents folder. Otherwise files stay in the app folder.' },
        { key: 'filesOfferSignIn', label: 'Offer to sign in when saving while signed out', type: 'checkbox' },
        { key: 'recentFilesMax', label: 'Number of Recent Files', type: 'number', min: 1, max: 50, integer: true },
        { type: 'button', label: 'Clear Recent Files', run: () => app.files?.clearRecent() },
      ],
    },
  ];
}

/** Parse a staged field value from its input text. Returns NaN/undefined when invalid. */
export function parseField(f, text, units = 'pt') {
  if (f.type === 'length') return parseLength(text, units);
  if (f.type === 'number' || f.type === 'angle') {
    const v = parseNumber(text);
    if (!Number.isFinite(v)) return NaN;
    return f.integer ? Math.round(v) : v;
  }
  return text;
}

export function validField(f, v) {
  if (!['length', 'number', 'angle'].includes(f.type)) return true;
  return Number.isFinite(v) && (f.min == null || v >= f.min) && (f.max == null || v <= f.max);
}

export async function preferencesDialog(app, { section: startSection = null } = {}) {
  const prefs = app.prefs;
  const all = sections(app);
  const draft = {};
  const ed = app.editor;
  const grid = ed?.doc.root.grid;
  const units = prefs.get('units') || 'pt';
  const initial = (key) => {
    if (key === 'gridSpacing' && grid) return grid.spacing;
    if (key === 'gridSubdivisions' && grid) return grid.subdivisions;
    if (key === 'units' && ed) return ed.doc.root.units || units;
    const v = prefs.get(key);
    return v === undefined ? PREF_DEFAULTS[key] : v;
  };
  const inputs = new Map(); // key -> { f, el }
  const error = h('p.form-error', { role: 'alert' });
  let fid = 0;

  const buildField = (f) => {
    const id = `pref-${++fid}`;
    if (f.type === 'heading') return h('h4.prefs-subhead', f.label);
    if (f.type === 'button') return h('div.form-row', h('span'), h('button.btn', { type: 'button', onclick: () => f.run() }, f.label));
    const value = initial(f.key);
    let el;
    if (f.type === 'checkbox') {
      el = h('input', { type: 'checkbox', id, checked: f.invert ? !value : Boolean(value) });
      inputs.set(f.key, { f, el });
      return h('div.form-row.check', el, h('label', { for: id }, f.label), f.help ? h('p.form-help', f.help) : null);
    }
    if (f.type === 'select' || f.type === 'color-select') {
      const opts = [...f.options];
      const isCustom = f.type === 'color-select' && !opts.some((o) => o.value === value);
      if (f.type === 'color-select') opts.push({ value: 'custom', label: 'Custom...' });
      el = h('select.select', { id }, opts.map((o) => h('option', { value: String(o.value), selected: String(o.value) === String(value) || (isCustom && o.value === 'custom') }, o.label)));
      let ctl = el;
      if (f.type === 'color-select') {
        const swatch = h('input', { type: 'color', 'aria-label': `${f.label} custom color`, value: isCustom ? value : colorOf(value, '#3fd6ff') || '#3fd6ff' });
        const sync = () => {
          swatch.hidden = el.value !== 'custom';
        };
        el.addEventListener('change', () => {
          const c = f.options.find((o) => o.value === el.value)?.color;
          if (c) swatch.value = c;
          sync();
        });
        sync();
        el._swatch = swatch;
        ctl = h('div.files-ctl', el, swatch);
      }
      inputs.set(f.key, { f, el });
      return h('div.form-row', h('label', { for: id }, f.label), ctl, f.help ? h('p.form-help', f.help) : null);
    }
    const shown = f.type === 'length' ? formatLength(value, units) : f.type === 'angle' ? `${value}°` : String(value);
    el = h('input', { type: 'text', id, value: shown, inputmode: 'decimal', autocomplete: 'off', spellcheck: false });
    inputs.set(f.key, { f, el });
    return h('div.form-row', h('label', { for: id }, f.label), el, f.help ? h('p.form-help', f.help) : null);
  };

  const panels = all.map((s) =>
    h('div.prefs-panel', { role: 'tabpanel', id: `prefs-p-${s.id}`, 'aria-labelledby': `prefs-t-${s.id}`, hidden: true }, h('h3.prefs-title', s.label), h('div.form', s.fields.map(buildField)), s.note ? h('p.form-help', s.note) : null),
  );
  const tabs = all.map((s, i) =>
    h('button.prefs-tab', { type: 'button', role: 'tab', id: `prefs-t-${s.id}`, 'aria-controls': `prefs-p-${s.id}`, 'aria-selected': 'false', tabindex: '-1', dataset: { i: String(i) } }, s.label),
  );
  let current = 0;
  const show = (i, focus = false) => {
    tabs.forEach((t, j) => {
      t.setAttribute('aria-selected', String(i === j));
      t.tabIndex = i === j ? 0 : -1;
    });
    panels.forEach((p, j) => (p.hidden = i !== j));
    prefs.set('prefsSection', all[i].id);
    current = i;
    tabs[i].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (focus) tabs[i].focus();
  };
  for (const t of tabs) {
    t.addEventListener('click', () => show(Number(t.dataset.i)));
    t.addEventListener('keydown', (e) => {
      const i = Number(t.dataset.i);
      const j = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (j == null) return;
      e.preventDefault();
      show((j + tabs.length) % tabs.length, true);
    });
  }
  const startId = startSection || prefs.get('prefsSection');
  const startIndex = Math.max(0, all.findIndex((s) => s.id === startId));
  show(startIndex);

  // Search: typing filters every section down to the matching settings.
  const search = h('input.prefs-search', { type: 'search', placeholder: 'Search preferences', 'aria-label': 'Search preferences', autocomplete: 'off', spellcheck: false });
  const noMatch = h('p.form-help.prefs-nomatch', { hidden: true, role: 'status' }, 'No preferences match your search.');
  const filter = () => {
    const q = search.value.trim().toLowerCase();
    if (!q) {
      for (const p of panels) for (const r of p.querySelectorAll('.form > *, .prefs-title, :scope > .form-help')) r.hidden = false;
      tabs.forEach((t) => (t.hidden = false));
      noMatch.hidden = true;
      show(current);
      return;
    }
    let any = false;
    panels.forEach((p, i) => {
      const sectionHit = all[i].label.toLowerCase().includes(q);
      let hits = 0;
      for (const r of p.querySelectorAll('.form > *')) {
        const on = !r.matches('.prefs-subhead') && (sectionHit || r.textContent.toLowerCase().includes(q));
        r.hidden = !on;
        if (on) hits++;
      }
      for (const r of p.querySelectorAll(':scope > .form-help')) r.hidden = true;
      p.hidden = hits === 0;
      tabs[i].hidden = hits === 0;
      any ||= hits > 0;
    });
    noMatch.hidden = any;
  };
  search.addEventListener('input', filter);

  const read = () => {
    for (const [key, { f, el }] of inputs) {
      let v;
      if (f.type === 'checkbox') v = f.invert ? !el.checked : el.checked;
      else if (f.type === 'color-select') v = el.value === 'custom' ? el._swatch.value : el.value;
      else if (f.type === 'select') v = typeof f.options[0]?.value === 'number' ? Number(el.value) : el.value;
      else v = parseField(f, el.value, units);
      if (!validField(f, v)) {
        const sIndex = all.findIndex((s) => s.fields.includes(f));
        show(sIndex);
        error.textContent = `Enter a valid value for ${f.label}${f.min != null ? ` (${f.min} to ${f.max})` : ''}.`;
        el.focus();
        return null;
      }
      draft[key] = v;
    }
    error.textContent = '';
    return { ...draft };
  };

  const body = h(
    'div.prefs',
    h('div.prefs-side', search, h('div.prefs-tabs', { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Preference sections' }, tabs)),
    h('div.prefs-main', noMatch, panels, error),
  );
  let values = null;
  const result = await openDialog({
    title: 'Preferences',
    className: 'wide prefs-dialog',
    body,
    initialFocus: () => tabs[startIndex],
    buttons: [
      {
        label: 'Reset Preferences',
        left: true,
        value: 'reset',
      },
      { label: 'Cancel', value: null },
      {
        label: 'OK',
        primary: true,
        validate: () => Boolean((values = read())),
        value: () => values,
      },
    ],
  });
  if (result === 'reset') {
    const ok = await app.dialogs.confirm({ title: 'Reset Preferences', message: 'Restore all preferences on this page to their defaults?', okLabel: 'Reset', danger: true });
    if (!ok) return preferencesDialog(app);
    for (const s of all) for (const f of s.fields) if (f.key && PREF_DEFAULTS[f.key] !== undefined) prefs.set(f.key, PREF_DEFAULTS[f.key]);
    for (const [k, v] of Object.entries({ keyboardIncrement: 1, autoAddDelete: true, previewBounds: false, scaleCorners: false, scaleStrokes: false, alignmentGuides: true, theme: 'system', units: 'pt' })) prefs.set(k, v);
    applyAll(app, {});
    return true;
  }
  if (!result) return false;
  applyAll(app, result);
  return true;
}

/** Write staged values and apply the ones that touch the document or the UI. */
export function applyAll(app, values) {
  const prefs = app.prefs;
  const ed = app.editor;
  for (const [k, v] of Object.entries(values)) prefs.set(k, v);
  if (values.theme) {
    applyTheme(values.theme);
    for (const v of app.views.values()) v.invalidate();
  }
  if (ed) {
    const root = ed.doc.root;
    const patch = {};
    const g = root.grid || {};
    if (values.gridSpacing != null && (values.gridSpacing !== g.spacing || values.gridSubdivisions !== g.subdivisions)) patch.grid = { ...g, spacing: values.gridSpacing, subdivisions: values.gridSubdivisions };
    if (values.units && values.units !== root.units) patch.units = values.units;
    if (Object.keys(patch).length) ed.doc.transact('Preferences', () => ed.doc.updateRoot(patch));
  }
  applyPrefs(app);
}
