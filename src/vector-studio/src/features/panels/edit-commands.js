/**
 * Edit menu commands: My Settings (export and import preferences,
 * shortcuts, workspaces and action sets as one JSON file), Convert to CMYK /
 * RGB, Recolor with Preset and Overprint Black.
 *
 * Colors are stored as sRGB. Convert to CMYK rounds each color through
 * whole CMYK percentages (so it is exactly representable as CMYK) and marks
 * solid paints and the swatches they use with mode 'cmyk' (and the CMYK
 * values), which the color controls show by default.
 */
import { UserError } from '../../lib/errors.js';
import { hexToRgb, rgbToHex, rgbToCmyk, cmykEngine } from '../../lib/color.js';
import { applyTheme } from '../../theme.js';
import { colorTargets, collectColors } from '../paint/edit-colors.js';
import { findSwatch, swatchesOf, updateSwatch } from '../paint/swatch-model.js';
import { SWATCH_LIBRARIES } from '../paint/swatch-libraries.js';
import { reduceColorsMap, harmonyMap, paletteMap, ruleById } from './color-harmony.js';
import { recolorDialog } from '../paint/edit-colors-ui.js';
import { pickWithInput } from '../files/service.js';

const hasSel = (a) => Boolean(a.editor?.selection.size);

// ---- My Settings ----

export const SETTINGS_FORMAT = 'vector-studio-settings';

/** Preferences that describe a session rather than a choice (not exported). */
const VOLATILE = new Set(['recentFiles', 'dockTab', 'dockOpen', 'openPanels', 'prefsSection']);
const isVolatile = (k) => VOLATILE.has(k) || /^last[A-Z]/.test(k);

export function exportSettingsData(prefs) {
  const values = {};
  for (const [k, v] of Object.entries(prefs.values)) if (!isVolatile(k) && v !== undefined) values[k] = v;
  return { format: SETTINGS_FORMAT, version: 1, exported: new Date().toISOString(), prefs: values };
}

/** Validate a settings file. Returns the preference values to apply. */
export function parseSettings(data) {
  if (!data || typeof data !== 'object' || data.format !== SETTINGS_FORMAT || !data.prefs || typeof data.prefs !== 'object') {
    throw new UserError('This file is not a Vector Studio settings file.');
  }
  const out = {};
  for (const [k, v] of Object.entries(data.prefs)) if (!isVolatile(k) && /^[A-Za-z][\w.-]*$/.test(k)) out[k] = v;
  return out;
}

export function applySettings(app, values) {
  for (const [k, v] of Object.entries(values)) app.prefs.set(k, v);
  applyTheme(app.prefs.get('theme'));
  for (const v of app.views.values()) v.refreshColors?.();
  app.emit('settings-imported', values);
  app.refreshChrome?.();
}

async function exportSettings(app) {
  const data = exportSettingsData(app.prefs);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const { deliverFiles } = await import('../io/deliver.js');
  const msg = await deliverFiles(app, [{ name: 'Vector Studio Settings.json', blob }], { dest: app.user && app.puter?.ui ? 'puter' : 'device' });
  if (msg) app.notify(msg, { polite: true });
}

async function importSettings(app) {
  const [file] = await pickWithInput('.json,application/json');
  if (!file) return;
  let values;
  try {
    values = parseSettings(JSON.parse(await file.text()));
  } catch (err) {
    throw err instanceof UserError ? err : new UserError('This settings file could not be read.');
  }
  const n = Object.keys(values).length;
  const ok = await app.dialogs.confirm({ title: 'Import Settings', message: `Replace your current settings with the ${n} settings in "${file.name}"? This includes preferences, shortcuts, workspaces and actions.`, okLabel: 'Import' });
  if (!ok) return;
  applySettings(app, values);
  app.notify('Settings imported.', { polite: true });
}

// ---- Convert to CMYK / RGB ----

export function quantizeCmyk(hex) {
  const c = cmykEngine.toCmyk(hexToRgb(hex));
  const cmyk = { c: Math.round(c.c), m: Math.round(c.m), y: Math.round(c.y), k: Math.round(c.k) };
  return { color: rgbToHex(cmykEngine.toRgb(cmyk)), cmyk };
}

function convertPaint(p, mode) {
  if (!p) return p;
  if (p.type === 'solid') {
    if (mode === 'cmyk') {
      const q = quantizeCmyk(p.color);
      return { ...p, color: q.color, mode: 'cmyk', cmyk: q.cmyk };
    }
    const out = { ...p, mode: 'rgb' };
    delete out.cmyk;
    return out;
  }
  if ((p.type === 'linear' || p.type === 'radial') && mode === 'cmyk') return { ...p, stops: p.stops.map((s) => ({ ...s, color: quantizeCmyk(s.color).color })) };
  return p;
}

/** Convert the selection's colors (and the swatches they use) to CMYK or RGB. Returns the number of changed objects. */
export function convertSelectionColors(editor, mode) {
  const doc = editor.doc;
  const nodes = colorTargets(doc, editor.topSelection());
  let changed = 0;
  doc.transact(mode === 'cmyk' ? 'Convert to CMYK' : 'Convert to RGB', () => {
    const swatchIds = new Set();
    for (const n of nodes) {
      const patch = {};
      for (const key of ['fill', 'stroke']) {
        const p = n[key];
        if (!p) continue;
        if (p.swatchId) swatchIds.add(p.swatchId);
        const next = convertPaint(p, mode);
        if (JSON.stringify(next) !== JSON.stringify(p)) patch[key] = next;
      }
      if (n.type === 'text' && n.runs) {
        const runs = n.runs.map((r) => ({ ...r, ...(r.fill ? { fill: convertPaint(r.fill, mode) } : {}), ...(r.stroke ? { stroke: convertPaint(r.stroke, mode) } : {}) }));
        if (JSON.stringify(runs) !== JSON.stringify(n.runs)) patch.runs = runs;
      }
      if (Object.keys(patch).length) {
        doc.update(n.id, patch);
        changed++;
      }
    }
    for (const id of swatchIds) {
      const sw = findSwatch(doc, id);
      if (!sw) continue;
      const paint = sw.paint?.type === 'solid' ? { ...sw.paint, color: mode === 'cmyk' ? quantizeCmyk(sw.paint.color).color : sw.paint.color } : sw.paint;
      updateSwatch(doc, id, { paint, mode });
    }
  });
  return changed;
}

// ---- Overprint Black ----

/** CMYK of a paint's color: its stored CMYK when converted, else computed. */
function paintCmyk(p) {
  if (!p || p.type !== 'solid') return null;
  return p.cmyk || rgbToCmyk(hexToRgb(p.color));
}

/** Is a paint black enough: K at least `percent`, and no C, M or Y unless `withCMY`. */
export function isBlack(p, percent = 100, withCMY = false) {
  const c = paintCmyk(p);
  if (!c) return false;
  if (c.k + 0.5 < percent) return false;
  return withCMY || (c.c < 0.5 && c.m < 0.5 && c.y < 0.5);
}

/** Set or clear overprint on black fills and strokes of the selection. Returns the number of changed objects. */
export function overprintBlack(editor, { add = true, percent = 100, fill = true, stroke = true, withCMY = false } = {}) {
  const doc = editor.doc;
  const nodes = colorTargets(doc, editor.topSelection());
  let changed = 0;
  doc.transact(add ? 'Add Black Overprint' : 'Remove Black Overprint', () => {
    for (const n of nodes) {
      const patch = {};
      if (fill && isBlack(n.fill, percent, withCMY) && Boolean(n.overprintFill) !== add) patch.overprintFill = add;
      if (stroke && isBlack(n.stroke, percent, withCMY) && Boolean(n.overprintStroke) !== add) patch.overprintStroke = add;
      if (Object.keys(patch).length) {
        doc.update(n.id, patch);
        changed++;
      }
    }
  });
  return changed;
}

async function overprintBlackDialog(app) {
  const v = await app.dialogs.form({
    title: 'Overprint Black',
    fields: [
      { key: 'action', label: 'Action', type: 'select', value: 'add', options: [{ value: 'add', label: 'Add Black Overprint' }, { value: 'remove', label: 'Remove Black Overprint' }] },
      { key: 'percent', label: 'Black at least (%)', type: 'percent', value: 100, min: 0, max: 100 },
      { type: 'heading', label: 'Apply To' },
      { key: 'fill', label: 'Fill', type: 'checkbox', value: true },
      { key: 'stroke', label: 'Stroke', type: 'checkbox', value: true },
      { type: 'heading', label: 'Options' },
      { key: 'withCMY', label: 'Include blacks mixed with cyan, magenta or yellow', type: 'checkbox', value: false },
    ],
  });
  if (!v) return;
  if (!v.fill && !v.stroke) throw new UserError('Choose Fill, Stroke or both.');
  const n = overprintBlack(app.editor, { add: v.action !== 'remove', percent: v.percent, fill: v.fill, stroke: v.stroke, withCMY: v.withCMY });
  app.notify(n ? `${v.action === 'remove' ? 'Removed overprint from' : 'Set overprint on'} ${n} object${n === 1 ? '' : 's'}.` : 'No black fills or strokes matched.', { polite: Boolean(n) });
}

// ---- Recolor with Preset ----

function selectionColors(editor) {
  return collectColors(colorTargets(editor.doc, editor.topSelection()));
}

function openRecolor(app, map, title) {
  return recolorDialog(app, { map, title });
}

async function presetReduce(app, k) {
  const colors = selectionColors(app.editor);
  if (!colors.length) throw new UserError('The selection has no colors to recolor.');
  return openRecolor(app, reduceColorsMap(colors, k), `Recolor: ${k} Color${k === 1 ? '' : 's'}`);
}

async function presetHarmony(app) {
  const colors = selectionColors(app.editor);
  if (!colors.length) throw new UserError('The selection has no colors to recolor.');
  const rule = ruleById(app.prefs.get('colorGuideRule') || 'complementary');
  return openRecolor(app, harmonyMap(colors, rule.id), `Recolor: ${rule.label}`);
}

/** Palettes for "Limit to library": the document swatches and the built-in libraries. */
export function paletteChoices(doc) {
  const solidsOf = (list) => list.filter((s) => s.paint?.type === 'solid').map((s) => s.paint.color.toLowerCase());
  return [{ id: 'document', name: 'Document Swatches', colors: solidsOf(swatchesOf(doc)) }, ...SWATCH_LIBRARIES.map((l) => ({ id: l.id, name: l.name, colors: solidsOf(l.swatches) }))].filter((p) => p.colors.length);
}

async function presetLibrary(app) {
  const colors = selectionColors(app.editor);
  if (!colors.length) throw new UserError('The selection has no colors to recolor.');
  const choices = paletteChoices(app.editor.doc);
  const v = await app.dialogs.form({
    title: 'Recolor with Library',
    description: 'Each color of the selection is replaced with the closest color of the library you choose.',
    fields: [{ key: 'lib', label: 'Library', type: 'select', value: choices[0]?.id, options: choices.map((c) => ({ value: c.id, label: c.name })) }],
  });
  if (!v) return false;
  const lib = choices.find((c) => c.id === v.lib) || choices[0];
  return openRecolor(app, paletteMap(colors, lib.colors), `Recolor: ${lib.name}`);
}

export function registerEditCommands(app) {
  app.commands.register([
    { id: 'edit.exportSettings', label: 'Export Settings...', run: (a) => exportSettings(a) },
    { id: 'edit.importSettings', label: 'Import Settings...', run: (a) => importSettings(a) },
    { id: 'color.toCMYK', label: 'Convert to CMYK', enabled: hasSel, run: (a) => convertSelectionColors(a.editor, 'cmyk') },
    { id: 'color.toRGB', label: 'Convert to RGB', enabled: hasSel, run: (a) => convertSelectionColors(a.editor, 'rgb') },
    { id: 'color.overprintBlack', label: 'Overprint Black...', enabled: hasSel, run: (a) => overprintBlackDialog(a) },
    { id: 'color.preset.one', label: '1 Color...', enabled: hasSel, run: (a) => presetReduce(a, 1) },
    { id: 'color.preset.two', label: '2 Colors...', enabled: hasSel, run: (a) => presetReduce(a, 2) },
    { id: 'color.preset.three', label: '3 Colors...', enabled: hasSel, run: (a) => presetReduce(a, 3) },
    { id: 'color.preset.harmony', label: 'Color Harmony...', enabled: hasSel, run: (a) => presetHarmony(a) },
    { id: 'color.preset.library', label: 'Color Library...', enabled: hasSel, run: (a) => presetLibrary(a) },
  ]);
}
