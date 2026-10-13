/**
 * Import dialogs: PDF pages (Open: which pages become artboards; Place:
 * which page and which box to crop to) with a live page preview, and DXF
 * drawing units. Choices are remembered in preferences.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { formatLength } from '../../lib/units.js';
import { thumbnail, preloadImages } from '../io/raster.js';
import { parseRange } from '../io/jobs.js';
import { CROP_BOXES, pdfToDocument } from './pdf/import.js';
import { UNIT_CHOICES, UNITS } from './dxf/common.js';

let uidc = 0;
const fid = (p) => `ix-${p}-${++uidc}`;

export const TEXT_MODES = [
  { value: 'auto', label: 'Editable where the font is available' },
  { value: 'outlines', label: 'Convert all text to outlines' },
  { value: 'text', label: 'Keep all text editable' },
];

function pref(app, key, fallback) {
  const v = app.prefs?.get(`interop.${key}`);
  return v && typeof v === 'object' ? { ...fallback, ...v } : fallback;
}

function setPref(app, key, value) {
  app.prefs?.set(`interop.${key}`, value);
}

function selectEl(options, value, attrs = {}) {
  return h('select', attrs, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
}

function row(label, control) {
  control.id = control.id || fid('c');
  return h('div.form-row', h('label', { for: control.id }, label), control);
}

/**
 * Page preview with navigation. `render(index)` resolves to a canvas.
 * Returns { el, index(), go(i), refresh() }.
 */
function pagePreview(count, render, { onChange } = {}) {
  let current = 0;
  let token = 0;
  const holder = h('div.ix-preview-canvas', { role: 'img', 'aria-label': 'Page preview' });
  const status = h('span.ix-preview-status', { 'aria-live': 'polite' });
  const input = h('input.ix-page-input', { type: 'number', min: 1, max: count, value: 1, 'aria-label': 'Page number' });
  const prev = h('button.icon-btn', { type: 'button', 'aria-label': 'Previous page', 'data-tip': 'Previous page' }, icon('chevron-left', 16));
  const next = h('button.icon-btn', { type: 'button', 'aria-label': 'Next page', 'data-tip': 'Next page' }, icon('chevron-right', 16));
  const nav = h('div.ix-page-nav', prev, h('label.ix-page-label', input, h('span', ` of ${count}`)), next);
  const overlay = h('div.ix-preview-box', { hidden: true });
  const frame = h('div.ix-preview-frame', holder, overlay);
  const el = h('div.ix-preview', frame, count > 1 ? nav : null, status);
  const show = async () => {
    const my = ++token;
    holder.replaceChildren(h('div.ix-preview-wait', 'Loading preview...'));
    prev.disabled = current <= 0;
    next.disabled = current >= count - 1;
    input.value = current + 1;
    try {
      const canvas = await render(current, () => my === token);
      if (my !== token) return;
      holder.replaceChildren(canvas || h('div.ix-preview-wait', 'No preview'));
      status.textContent = count > 1 ? `Page ${current + 1} of ${count}` : '';
    } catch (err) {
      if (my !== token) return;
      holder.replaceChildren(h('div.ix-preview-wait', 'This page could not be previewed.'));
    }
    onChange?.(current);
  };
  const go = (i) => {
    const n = Math.max(0, Math.min(count - 1, i));
    if (n === current && holder.firstChild) return;
    current = n;
    show();
  };
  prev.addEventListener('click', () => go(current - 1));
  next.addEventListener('click', () => go(current + 1));
  input.addEventListener('change', () => go(Number(input.value) - 1));
  return { el, overlay, index: () => current, go, refresh: show };
}

/** A canvas for one page (cached per page and text mode). */
function previewRenderer(app, info, families, textMode) {
  const cache = new Map();
  return async (index, alive) => {
    const key = `${index}|${textMode()}`;
    let doc = cache.get(key);
    if (!doc) {
      doc = await pdfToDocument(info.doc, { pages: [index], families, textMode: textMode() });
      cache.set(key, doc);
    }
    const board = doc.artboards[0];
    let canvas = thumbnail(doc, board, 240);
    // Images decode asynchronously: draw again once they are ready.
    if (doc.assets.size) {
      preloadImages(doc, board, 3000).then(() => {
        if (!alive()) return;
        const again = thumbnail(doc, board, 240);
        canvas.replaceWith(again);
        canvas = again;
      });
    }
    return canvas;
  };
}

function sizeText(app, size) {
  const unit = app.editor?.doc.root.units || 'pt';
  return `${formatLength(size.w, unit)} x ${formatLength(size.h, unit)}`;
}

/** Place PDF: { page, crop, textMode } or null. */
export async function pdfPlaceDialog(app, info, { name = '', families = [] } = {}) {
  const last = pref(app, 'pdfPlace', { crop: 'bounding', textMode: 'auto' });
  const count = info.pages.length;
  const crop = selectEl(CROP_BOXES, last.crop);
  const text = selectEl(TEXT_MODES, last.textMode);
  const sizeLine = h('p.form-help', { 'aria-live': 'polite' });
  const preview = pagePreview(count, previewRenderer(app, info, families, () => text.value), { onChange: () => update() });
  const update = () => {
    const p = info.pages[preview.index()];
    const box = crop.value === 'bounding' ? p.boxes.crop : p.boxes[crop.value];
    sizeLine.textContent = crop.value === 'bounding' ? `Page size ${sizeText(app, p.size)}; the artwork is placed at its own size.` : `Placed area ${sizeText(app, p.rotate % 180 ? { w: box.h, h: box.w } : box)}.`;
    // Outline of the chosen box relative to the crop box shown in the preview.
    const ov = preview.overlay;
    const c = p.boxes.crop;
    if (crop.value === 'bounding' || crop.value === 'crop' || !c.w || !c.h) ov.hidden = true;
    else {
      const l = ((box.x - c.x) / c.w) * 100;
      const t = ((c.y + c.h - (box.y + box.h)) / c.h) * 100;
      Object.assign(ov.style, { left: `${l}%`, top: `${t}%`, width: `${(box.w / c.w) * 100}%`, height: `${(box.h / c.h) * 100}%` });
      ov.hidden = false;
    }
  };
  crop.addEventListener('change', update);
  text.addEventListener('change', () => preview.refresh());
  update();
  const result = await app.dialogs.open({
    title: 'Place PDF',
    className: 'io-dialog ix-dialog',
    body: h(
      'div.ix-pdf',
      preview.el,
      h(
        'div.form',
        name ? h('p.ix-file', name) : null,
        row('Crop to', crop),
        sizeLine,
        row('Text', text),
        h('p.form-help', 'Text in fonts this app does not have is converted to outlines; choose Keep all text editable to substitute fonts instead.'),
      ),
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Place', primary: true, value: () => ({ page: preview.index(), crop: crop.value, textMode: text.value }) },
    ],
    onOpen: () => preview.refresh(),
  });
  if (result) setPref(app, 'pdfPlace', { crop: result.crop, textMode: result.textMode });
  return result;
}

/** Open PDF: { pages: [indices], textMode } or null. */
export async function pdfOpenDialog(app, info, { name = '', families = [] } = {}) {
  const last = pref(app, 'pdfOpen', { textMode: 'auto' });
  const count = info.pages.length;
  const text = selectEl(TEXT_MODES, last.textMode);
  const rid = fid('range');
  const all = h('input', { type: 'radio', name: rid, value: 'all', checked: true, id: `${rid}-all` });
  const some = h('input', { type: 'radio', name: rid, value: 'range', id: `${rid}-range` });
  const range = h('input.io-range', { type: 'text', value: `1-${count}`, 'aria-label': 'Page range', autocomplete: 'off', spellcheck: false, disabled: true });
  const sync = () => (range.disabled = !some.checked);
  all.addEventListener('change', sync);
  some.addEventListener('change', sync);
  range.addEventListener('focus', () => {
    some.checked = true;
    sync();
  });
  const pages = h(
    'fieldset.io-fieldset',
    h('legend', 'Pages'),
    h('div.radio-group', { role: 'radiogroup' }, h('label.radio', all, `All (${count})`), h('label.radio', some, 'Range', range)),
    h('p.form-help', 'Each page becomes an artboard. Example: 1-3, 5'),
  );
  const preview = pagePreview(count, previewRenderer(app, info, families, () => text.value));
  text.addEventListener('change', () => preview.refresh());
  const error = h('p.form-error', { role: 'alert' });
  const read = () => {
    const list = some.checked ? parseRange(range.value, count) : info.pages.map((_, i) => i);
    if (!list) throw Object.assign(new Error(`Enter page numbers between 1 and ${count}, like 1-3, 5.`), { field: range });
    return { pages: list.sort((a, b) => a - b), textMode: text.value };
  };
  const result = await app.dialogs.open({
    title: 'Open PDF',
    className: 'io-dialog ix-dialog',
    body: h('div.ix-pdf', preview.el, h('div.form', name ? h('p.ix-file', name) : null, pages, row('Text', text), error)),
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Open',
        primary: true,
        validate: () => {
          try {
            read();
            return true;
          } catch (err) {
            error.textContent = err.message;
            err.field?.focus();
            return false;
          }
        },
        value: () => read(),
      },
    ],
    onOpen: () => preview.refresh(),
  });
  if (result) setPref(app, 'pdfOpen', { textMode: result.textMode });
  return result;
}

/** DXF import: { unitPt } or null. `data` is readDXF() output; `extent` the drawing's size in its own units. */
export async function dxfImportDialog(app, data, { name = '', extent = null } = {}) {
  const fromFile = UNITS[data.units]?.pt ? UNIT_CHOICES.find((u) => Math.abs(u.pt - UNITS[data.units].pt) < 1e-9) : null;
  const last = pref(app, 'dxf', { unit: 'mm', scale: 1 });
  const unitSel = selectEl(UNIT_CHOICES.map((u) => ({ value: u.value, label: u === fromFile ? `${u.label} (from the file)` : u.label })), fromFile ? fromFile.value : last.unit);
  const scale = h('input', { type: 'number', min: 0.000001, step: 'any', value: fromFile ? 1 : last.scale, 'aria-label': 'Scale factor' });
  const info = h('p.form-help', { 'aria-live': 'polite' });
  const update = () => {
    const u = UNIT_CHOICES.find((x) => x.value === unitSel.value) || UNIT_CHOICES[0];
    const s = Number(scale.value) || 1;
    if (extent) info.textContent = `The drawing will be ${sizeText(app, { w: extent.w * u.pt * s, h: extent.h * u.pt * s })}.`;
  };
  unitSel.addEventListener('change', update);
  scale.addEventListener('input', update);
  update();
  const layers = data.layers.size;
  const result = await app.dialogs.open({
    title: 'DXF Import Options',
    className: 'io-dialog',
    body: h(
      'div.form',
      name ? h('p.ix-file', name) : null,
      h('p.form-help', `${data.unitLabel === 'Unitless' ? 'The file does not say which units it uses.' : `The file is drawn in ${data.unitLabel.toLowerCase()}.`} ${layers} layer${layers === 1 ? '' : 's'}.`),
      row('One drawing unit is', unitSel),
      row('Scale', scale),
      info,
    ),
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'OK',
        primary: true,
        value: () => {
          const u = UNIT_CHOICES.find((x) => x.value === unitSel.value) || UNIT_CHOICES[0];
          const s = Number(scale.value) > 0 ? Number(scale.value) : 1;
          return { unit: u.value, scale: s, unitPt: u.pt * s };
        },
      },
    ],
  });
  if (result) setPref(app, 'dxf', { unit: result.unit, scale: result.scale });
  return result;
}
