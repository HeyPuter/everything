/**
 * Transparency flattener presets: how transparent artwork turns into
 * opaque vectors and images (Object > Flatten Transparency, the Flattener
 * Preview panel, printing and PDF export).
 *
 *   balance              0 (everything rasterized) .. 100 (keep all vectors)
 *   lineArtPpi           resolution for rasterized line art and text
 *   gradientPpi          resolution for rasterized gradients and meshes
 *   textToOutlines       convert type to outlines first, so solid type stays vector
 *   strokesToOutlines    divide strokes like fills (false keeps strokes nothing covers)
 *   clipComplex          raster regions follow object outlines (false: their bounding boxes)
 *   antialias            smooth raster edges
 */
import { h } from '../../lib/dom.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { sliderField, checkField, numberRow } from '../effects/dialog-kit.js';
import { flattenSelection } from '../effects/flatten.js';
import { collectTextOutlines } from '../io/outlines.js';
import { registerPresetKind, presetPicker, savePreset, listPresets, uniqueName } from './presets.js';

export const DEFAULT_FLATTENER = Object.freeze({ balance: 75, lineArtPpi: 300, gradientPpi: 150, textToOutlines: false, strokesToOutlines: true, clipComplex: true, antialias: true });

export const FLATTENER_BUILTINS = {
  'High Resolution': { balance: 100, lineArtPpi: 1200, gradientPpi: 300, textToOutlines: false, strokesToOutlines: false, clipComplex: true, antialias: false },
  'Medium Resolution': { balance: 75, lineArtPpi: 300, gradientPpi: 300, textToOutlines: false, strokesToOutlines: false, clipComplex: true, antialias: true },
  'Low Resolution': { balance: 75, lineArtPpi: 150, gradientPpi: 150, textToOutlines: false, strokesToOutlines: false, clipComplex: true, antialias: true },
  'Mostly Raster': { balance: 10, lineArtPpi: 300, gradientPpi: 150, textToOutlines: true, strokesToOutlines: true, clipComplex: false, antialias: true },
};

export function normalizeFlattener(v = {}) {
  const num = (x, lo, hi, d) => (Number.isFinite(Number(x)) ? Math.max(lo, Math.min(hi, Math.round(Number(x)))) : d);
  const D = DEFAULT_FLATTENER;
  return {
    balance: num(v.balance, 0, 100, D.balance),
    // Settings saved before presets had one `resolution`.
    lineArtPpi: num(v.lineArtPpi ?? v.resolution, 72, 9600, D.lineArtPpi),
    gradientPpi: num(v.gradientPpi, 72, 2400, D.gradientPpi),
    textToOutlines: v.textToOutlines === undefined ? D.textToOutlines : Boolean(v.textToOutlines),
    strokesToOutlines: v.strokesToOutlines === undefined ? D.strokesToOutlines : Boolean(v.strokesToOutlines),
    clipComplex: v.clipComplex === undefined ? D.clipComplex : Boolean(v.clipComplex),
    antialias: v.antialias === undefined ? D.antialias : Boolean(v.antialias),
  };
}

const yes = (b) => (b ? 'On' : 'Off');
export function flattenerSummary(v) {
  return [
    ['Raster/Vector balance', v.balance],
    ['Line art and text resolution', `${v.lineArtPpi} ppi`],
    ['Gradient and mesh resolution', `${v.gradientPpi} ppi`],
    ['Convert all text to outlines', yes(v.textToOutlines)],
    ['Convert all strokes to outlines', yes(v.strokesToOutlines)],
    ['Clip complex regions', yes(v.clipComplex)],
    ['Anti-alias rasters', yes(v.antialias)],
  ];
}

/** The flattener controls; onChange(values) after each edit. */
export function flattenerControls(values, onChange = () => {}) {
  const v = normalizeFlattener(values);
  const changed = () => onChange(read());
  const balance = sliderField({ label: 'Raster/Vector balance', value: v.balance, min: 0, max: 100, integer: true, ends: ['Rasters', 'Vectors'], onInput: changed });
  const lineArt = numberRow({ label: 'Line art and text resolution (ppi)', value: v.lineArtPpi, min: 72, max: 9600, integer: true, onInput: changed });
  const gradient = numberRow({ label: 'Gradient and mesh resolution (ppi)', value: v.gradientPpi, min: 72, max: 2400, integer: true, onInput: changed });
  const text = checkField({ label: 'Convert all text to outlines', value: v.textToOutlines, onChange: changed });
  const strokes = checkField({ label: 'Convert all strokes to outlines', value: v.strokesToOutlines, onChange: changed });
  const clip = checkField({ label: 'Clip complex regions', value: v.clipComplex, onChange: changed });
  const aa = checkField({ label: 'Anti-alias rasters', value: v.antialias, onChange: changed });
  const read = () => normalizeFlattener({ balance: balance.get(), lineArtPpi: lineArt.get(), gradientPpi: gradient.get(), textToOutlines: text.get(), strokesToOutlines: strokes.get(), clipComplex: clip.get(), antialias: aa.get() });
  const set = (x) => {
    const n = normalizeFlattener(x);
    balance.set(n.balance);
    lineArt.set(n.lineArtPpi);
    gradient.set(n.gradientPpi);
    text.set(n.textToOutlines);
    strokes.set(n.strokesToOutlines);
    clip.set(n.clipComplex);
    aa.set(n.antialias);
  };
  return { el: h('div.pp-flattener', balance.el, lineArt.el, gradient.el, text.el, strokes.el, clip.el, aa.el), read, set, focus: balance.field };
}

/** Preset editor (New / Edit in the presets manager). */
export async function flattenerPresetDialog(app, { name, values, title, names = [] }) {
  const nameInput = h('input', { type: 'text', value: name, id: 'pp-flat-name', autocomplete: 'off', spellcheck: false });
  const ctl = flattenerControls(values);
  const error = h('p.form-error', { role: 'alert' });
  return openDialog({
    title,
    className: 'fx-dialog pp-dialog',
    body: h('div.fx-body', h('div.fx-row', h('label.fx-label', { for: 'pp-flat-name' }, 'Name'), nameInput), ctl.el, error),
    initialFocus: () => nameInput,
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'OK',
        primary: true,
        validate: () => {
          const nm = nameInput.value.trim();
          if (!nm) error.textContent = 'Enter a name.';
          else if (names.includes(nm)) error.textContent = `A preset named "${nm}" already exists.`;
          else return true;
          nameInput.focus();
          return false;
        },
        value: () => ({ name: nameInput.value.trim(), values: ctl.read() }),
      },
    ],
  });
}

registerPresetKind('flattener', {
  title: 'Transparency Flattener Presets',
  noun: 'Flattener Preset',
  key: 'flattenerPresets',
  builtins: FLATTENER_BUILTINS,
  normalize: normalizeFlattener,
  summary: flattenerSummary,
  edit: flattenerPresetDialog,
});

/** Flatten options for flattenSelection from preset values (text outlines collected when asked). */
export async function flattenOptions(app, editor, values, ids = null) {
  const v = normalizeFlattener(values);
  const opts = { balance: v.balance, resolution: v.lineArtPpi, gradientResolution: v.gradientPpi, antialias: v.antialias, strokesToOutlines: v.strokesToOutlines, clipComplex: v.clipComplex };
  if (v.textToOutlines && app.textOutlines) opts.textOutlines = await collectTextOutlines(app, editor.doc, ids || editor.topSelection());
  return opts;
}

/** Object > Flatten Transparency: a preset or custom settings, then flatten the selection. */
export async function flattenTransparencyDialog(app) {
  const ed = app.editor;
  if (!ed) return false;
  let values = normalizeFlattener(app.prefs?.get?.('flattenTransparency') || FLATTENER_BUILTINS['Medium Resolution']);
  const picker = presetPicker(app, 'flattener', { values, onPick: (v) => (ctl.set(v), (values = v)) });
  const ctl = flattenerControls(values, (v) => {
    values = v;
    picker.sync(v);
  });
  const save = h('button.btn.small', { type: 'button', onclick: async () => {
    const names = listPresets(app, 'flattener').map((p) => p.name);
    const v = await app.dialogs.form({ title: 'Save Flattener Preset', fields: [{ key: 'name', label: 'Name', type: 'text', value: uniqueName(names, 'Flattener Preset', true) }] });
    const nm = v?.name?.trim();
    if (!nm) return;
    try {
      savePreset(app, 'flattener', nm, ctl.read());
    } catch (err) {
      app.notify(err.message, { error: true });
      return;
    }
    picker.sync(ctl.read());
  } }, 'Save Preset…');
  const res = await openDialog({
    title: 'Flatten Transparency',
    className: 'fx-dialog pp-dialog',
    body: h('div.fx-body', h('div.fx-row', h('label.fx-label', 'Preset'), h('div.pp-inline', picker.el, save)), ctl.el, h('p.fx-note', 'Transparent artwork becomes opaque shapes that look the same on white. Where colors cannot be reproduced as shapes, an image of the artwork fills in.')),
    initialFocus: () => picker.el,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => ctl.read() }],
  });
  if (!res) return false;
  app.prefs?.set?.('flattenTransparency', res);
  let r;
  try {
    r = await flattenSelection(ed, await flattenOptions(app, ed, res));
  } catch (err) {
    app.notify(err?.message || 'The artwork could not be flattened.', { error: true });
    return false;
  }
  if (r.error) {
    app.notify(r.error);
    return false;
  }
  return true;
}
