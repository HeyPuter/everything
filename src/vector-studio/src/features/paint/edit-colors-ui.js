/**
 * Edit > Edit Colors commands: Invert Colors, Convert to Grayscale, Adjust
 * Color Balance, Blend Horizontally / Vertically / Front to Back, Saturate
 * and Recolor. Dialog commands preview live inside a transaction
 * that Cancel rolls back.
 */
import { h } from '../../lib/dom.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { icon } from '../../ui/icons.js';
import { colorTargets, colorPatches, collectColors, invertColor, grayscaleColor, adjustColor, saturateColor, blendFills, recolorFn } from './edit-colors.js';
import { hexToRgb, rgbToHex, rgbToHsb, hsbToRgb } from '../../lib/color.js';
import { reduceColorsMap, harmonyMap, paletteMap, HARMONY_RULES } from '../panels/color-harmony.js';
import { swatchesOf } from './swatch-model.js';
import { SWATCH_LIBRARIES } from './swatch-libraries.js';

/** Colors kept as they are by the Preserve options. */
export function preservedColor(hex, { white = false, black = false, grays = false } = {}) {
  const { r, g, b } = hexToRgb(hex);
  const gray = Math.abs(r - g) < 3 && Math.abs(g - b) < 3;
  if (white && r > 251 && g > 251 && b > 251) return true;
  if (black && r < 4 && g < 4 && b < 4) return true;
  return grays && gray && !(r > 251 || r < 4);
}

/** A random saturation and brightness for a color (hue kept), for Recolor's randomize button. */
export function randomSatBright(hex, rand = Math.random) {
  const c = rgbToHsb(hexToRgb(hex));
  return rgbToHex(hsbToRgb({ h: c.h, s: 15 + rand() * 85, v: 25 + rand() * 75 }));
}

/** Palettes to recolor with: the document swatches and the built-in libraries (solid colors). */
function recolorPalettes(doc) {
  const solids = (list) => list.filter((s) => s.paint?.type === 'solid').map((s) => s.paint.color.toLowerCase());
  return [{ id: 'document', name: 'Document Swatches', colors: solids(swatchesOf(doc)) }, ...SWATCH_LIBRARIES.map((l) => ({ id: l.id, name: l.name, colors: solids(l.swatches) }))].filter((p) => p.colors.length);
}

function selectedColorNodes(editor) {
  return colorTargets(editor.doc, editor.topSelection());
}

/** Apply a color mapping to the selection as one undo step. */
export function mapSelectionColors(editor, label, fn, opts) {
  const nodes = selectedColorNodes(editor);
  const patches = colorPatches(nodes, fn, opts);
  if (!patches.size) return 0;
  editor.doc.transact(label, () => {
    for (const [id, p] of patches) editor.doc.update(id, p);
  });
  return patches.size;
}

/**
 * Run a dialog with live preview. `compute(values)` returns a color fn (or
 * null for no change); `values` come from `read()` in the dialog body.
 */
async function previewDialog(app, { title, body, read, compute, previewBox, opts = () => ({}) }) {
  const ed = app.editor;
  const doc = ed.doc;
  const nodes = selectedColorNodes(ed);
  const originals = new Map(nodes.map((n) => [n.id, n]));
  const tx = doc.begin(title);
  const restore = () => {
    for (const n of originals.values()) doc.update(n.id, { fill: n.fill, stroke: n.stroke, ...(n.type === 'text' ? { runs: n.runs } : {}) });
  };
  const preview = () => {
    restore();
    if (!previewBox.checked) return;
    const fn = compute(read());
    if (!fn) return;
    for (const [id, p] of colorPatches([...originals.values()], fn, opts(read()))) doc.update(id, p);
  };
  body.addEventListener('input', preview);
  body.addEventListener('change', preview);
  let ok = null;
  try {
    ok = await openDialog({
      title,
      body,
      onOpen: () => preview(),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'OK', primary: true, value: () => read() },
      ],
    });
  } catch (err) {
    tx.cancel();
    throw err;
  }
  if (!ok) {
    tx.cancel();
    return false;
  }
  restore();
  const fn = compute(ok);
  if (fn) for (const [id, p] of colorPatches([...originals.values()], fn, opts(ok))) doc.update(id, p);
  tx.commit();
  return true;
}

let sid = 0;
function slider(label, min, max, value) {
  const id = `ec-${++sid}`;
  const range = h('input', { type: 'range', id, min, max, step: 1, value });
  const num = h('input.ec-num', { type: 'text', value: String(value), inputmode: 'numeric', 'aria-label': `${label} value` });
  range.addEventListener('input', () => (num.value = range.value));
  num.addEventListener('change', () => {
    const v = Math.max(min, Math.min(max, Number(num.value) || 0));
    num.value = String(v);
    range.value = String(v);
    range.dispatchEvent(new Event('input', { bubbles: true }));
  });
  num.addEventListener('keydown', (e) => e.key === 'Enter' && e.preventDefault());
  const el = h('div.ec-slider', h('label', { for: id }, label), range, num, h('span.cs-unit', '%'));
  return { el, get value() {
    return Number(range.value);
  } };
}

function checkbox(label, checked = true) {
  const id = `ec-${++sid}`;
  const input = h('input', { type: 'checkbox', id, checked });
  return { input, el: h('div.check-row', input, h('label', { for: id }, label)) };
}

async function adjustBalance(app) {
  const modeSel = h('select', { id: 'ec-mode' }, h('option', { value: 'rgb' }, 'RGB'), h('option', { value: 'cmyk' }, 'CMYK'), h('option', { value: 'grayscale' }, 'Grayscale'));
  const rgb = [slider('Red', -100, 100, 0), slider('Green', -100, 100, 0), slider('Blue', -100, 100, 0)];
  const cmyk = [slider('Cyan', -100, 100, 0), slider('Magenta', -100, 100, 0), slider('Yellow', -100, 100, 0), slider('Black', -100, 100, 0)];
  const rgbBox = h('div.ec-group', rgb.map((s) => s.el));
  const cmykBox = h('div.ec-group', { hidden: true }, cmyk.map((s) => s.el));
  const gray = slider('Black', -100, 100, 0);
  const grayBox = h('div.ec-group', { hidden: true }, gray.el);
  // Grayscale adjusts gray colors only, unless Convert makes every color gray first.
  const convert = checkbox('Convert', false);
  convert.input.disabled = true;
  modeSel.addEventListener('change', () => {
    rgbBox.hidden = modeSel.value !== 'rgb';
    cmykBox.hidden = modeSel.value !== 'cmyk';
    grayBox.hidden = modeSel.value !== 'grayscale';
    convert.input.disabled = modeSel.value !== 'grayscale';
  });
  const fill = checkbox('Fill');
  const stroke = checkbox('Stroke');
  const prev = checkbox('Preview');
  const body = h('div.form.ec', h('div.form-row', h('label', { for: 'ec-mode' }, 'Color Mode'), modeSel), convert.el, rgbBox, cmykBox, grayBox, h('div.ec-checks', h('span.form-label', 'Adjust Options'), fill.el, stroke.el), prev.el);
  const read = () => ({
    mode: modeSel.value,
    r: rgb[0].value, g: rgb[1].value, b: rgb[2].value,
    c: cmyk[0].value, m: cmyk[1].value, y: cmyk[2].value, k: cmyk[3].value,
    gray: gray.value, convert: convert.input.checked,
    fill: fill.input.checked, stroke: stroke.input.checked,
  });
  return previewDialog(app, {
    title: 'Adjust Colors',
    body,
    read,
    previewBox: prev.input,
    opts: (v) => ({ fill: v.fill, stroke: v.stroke }),
    compute: (v) => (hex) => adjustColor(hex, v.mode, v),
  });
}

async function saturateDialog(app) {
  const s = slider('Intensity', -100, 100, 0);
  const prev = checkbox('Preview');
  const body = h('div.form.ec', s.el, prev.el);
  return previewDialog(app, {
    title: 'Saturate',
    body,
    read: () => ({ amount: s.value }),
    previewBox: prev.input,
    compute: (v) => (v.amount ? (hex) => saturateColor(hex, v.amount) : null),
  });
}

/**
 * Recolor: the selection's colors with editable new colors and
 * global adjustments. `preset.map` ({ oldHex: newHex }) preassigns new
 * colors (Recolor with Preset); `preset.title` names the dialog.
 */
export async function recolorDialog(app, preset = {}) {
  const ed = app.editor;
  const colors = collectColors(selectedColorNodes(ed));
  if (!colors.length) {
    app.notify('The selection has no colors to recolor.');
    return false;
  }
  const map = {};
  for (const [k, v] of Object.entries(preset.map || {})) map[k.toLowerCase()] = v;
  const rows = colors.map(({ color, count }) => {
    const input = h('input.rc-new', { type: 'color', value: map[color.toLowerCase()] || color, 'aria-label': `New color for ${color.toUpperCase()}` });
    input.addEventListener('input', () => (map[color] = input.value));
    const reset = h('button.icon-btn.small.rc-reset', { type: 'button', 'aria-label': `Reset ${color.toUpperCase()}`, 'data-tip': 'Reset', onclick: () => {
      input.value = color;
      delete map[color];
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } }, icon('rotate-ccw', 14));
    return {
      color,
      input,
      el: h('div.rc-row', { role: 'listitem' }, h('span.rc-chip', { style: { background: color }, 'aria-hidden': 'true' }), h('span.rc-hex', color.toUpperCase()), h('span.rc-count.muted', `${count}`), h('span.rc-arrow', { 'aria-hidden': 'true' }, '→'), input, reset),
    };
  });
  const hue = slider('Hue Shift', -180, 180, 0);
  hue.el.querySelector('.cs-unit').textContent = '°';
  const sat = slider('Saturation', -100, 100, 0);
  const bri = slider('Brightness', -100, 100, 0);
  const shuffle = h('button.btn.small', { type: 'button', onclick: () => {
    // Randomly reassign the current new colors among the originals.
    const vals = rows.map((r) => r.input.value);
    for (let i = vals.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [vals[i], vals[j]] = [vals[j], vals[i]];
    }
    rows.forEach((r, i) => {
      r.input.value = vals[i];
      map[r.color] = vals[i];
    });
    body.dispatchEvent(new Event('input'));
  } }, 'Randomly Change Color Order');
  const randomize = h('button.btn.small', { type: 'button', onclick: () => {
    // New saturation and brightness for every new color; hues stay.
    rows.forEach((r) => {
      if (preserve().some(Boolean) && preservedColor(r.color, preserveOpts())) return;
      r.input.value = randomSatBright(r.input.value);
      map[r.color] = r.input.value;
    });
    body.dispatchEvent(new Event('input'));
  } }, 'Randomly Change Saturation and Brightness');
  // Set the new colors from a rule: fewer colors, a harmony, or the nearest colors of a library.
  const palettes = recolorPalettes(ed.doc);
  const ruleSel = h(
    'select.select',
    { id: 'rc-rule', 'aria-label': 'Set new colors from' },
    h('option', { value: '' }, 'Choose...'),
    h('optgroup', { label: 'Number of colors' }, [1, 2, 3, 4, 5, 6, 8].filter((k) => k < colors.length).map((k) => h('option', { value: `reduce:${k}` }, `${k} color${k === 1 ? '' : 's'}`))),
    h('optgroup', { label: 'Harmony' }, HARMONY_RULES.map((r) => h('option', { value: `harmony:${r.id}` }, r.label))),
    h('optgroup', { label: 'Library' }, palettes.map((p) => h('option', { value: `library:${p.id}` }, p.name))),
  );
  ruleSel.addEventListener('change', () => {
    const [kind, arg] = ruleSel.value.split(':');
    if (!kind) return;
    const m = kind === 'reduce' ? reduceColorsMap(colors, Number(arg)) : kind === 'harmony' ? harmonyMap(colors, arg) : paletteMap(colors, palettes.find((p) => p.id === arg)?.colors || []);
    rows.forEach((r) => {
      const next = m[r.color.toLowerCase()];
      if (!next || preservedColor(r.color, preserveOpts())) return;
      r.input.value = next;
      map[r.color] = next;
    });
    ruleSel.value = '';
    body.dispatchEvent(new Event('input'));
  });
  const keepWhite = checkbox('White', false);
  const keepBlack = checkbox('Black', false);
  const keepGrays = checkbox('Grays', false);
  const preserve = () => [keepWhite.input.checked, keepBlack.input.checked, keepGrays.input.checked];
  const preserveOpts = () => ({ white: keepWhite.input.checked, black: keepBlack.input.checked, grays: keepGrays.input.checked });
  // Preserved colors go back to themselves.
  const syncPreserved = () => {
    for (const r of rows) {
      const keep = preservedColor(r.color, preserveOpts());
      r.input.disabled = keep;
      if (keep) {
        r.input.value = r.color;
        delete map[r.color];
      }
    }
  };
  for (const c of [keepWhite, keepBlack, keepGrays]) c.input.addEventListener('change', syncPreserved);
  const prev = checkbox('Preview');
  const body = h(
    'div.form.ec.recolor',
    h('div.rc-head', h('span', 'Current Colors'), h('span', 'New')),
    h('div.rc-list', { role: 'list' }, rows.map((r) => r.el)),
    h('div.form-row', h('label', { for: 'rc-rule' }, 'Set new colors from'), ruleSel),
    h('div.rc-preserve', h('span.form-label', 'Preserve'), keepWhite.el, keepBlack.el, keepGrays.el),
    h('h3.form-heading', 'Adjust All'),
    hue.el,
    sat.el,
    bri.el,
    h('div.rc-actions', shuffle, randomize),
    prev.el,
  );
  return previewDialog(app, {
    title: preset.title || 'Recolor',
    body,
    read: () => ({ map: { ...map }, h: hue.value, s: sat.value, b: bri.value, preserve: preserveOpts() }),
    previewBox: prev.input,
    compute: (v) => {
      const fn = recolorFn(v.map, { h: v.h, s: v.s, b: v.b });
      return (hex) => (preservedColor(hex, v.preserve) ? hex : fn(hex));
    },
  });
}

export function registerEditColorCommands(app) {
  const has = (a) => Boolean(a.editor && a.editor.selection.size);
  const blend = (how, label) => (a) => {
    const ed = a.editor;
    const nodes = selectedColorNodes(ed);
    const res = blendFills(ed.doc, nodes, how);
    if (!res) {
      a.notify('Select three or more objects with solid fills to blend colors.');
      return;
    }
    ed.doc.transact(label, () => {
      for (const [id, color] of res) ed.doc.update(id, { fill: { type: 'solid', color } });
    });
  };
  app.commands.register([
    { id: 'color.invert', label: 'Invert Colors', enabled: has, run: (a) => mapSelectionColors(a.editor, 'Invert Colors', invertColor) },
    { id: 'color.grayscale', label: 'Convert to Grayscale', enabled: has, run: (a) => mapSelectionColors(a.editor, 'Convert to Grayscale', grayscaleColor) },
    { id: 'color.adjust', label: 'Adjust Color Balance...', enabled: has, run: (a) => adjustBalance(a) },
    { id: 'color.blendFrontToBack', label: 'Blend Front to Back', enabled: has, run: blend('front', 'Blend Front to Back') },
    { id: 'color.blendHorizontal', label: 'Blend Horizontally', enabled: has, run: blend('horizontal', 'Blend Horizontally') },
    { id: 'color.blendVertical', label: 'Blend Vertically', enabled: has, run: blend('vertical', 'Blend Vertically') },
    { id: 'color.saturate', label: 'Saturate...', enabled: has, run: (a) => saturateDialog(a) },
    { id: 'color.recolor', label: 'Recolor...', enabled: has, run: (a) => recolorDialog(a) },
  ]);
}
