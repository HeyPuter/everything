/**
 * Export, Place and Print dialogs.
 *
 *   Export As          name, format, artboards (Use Artboards, All/Range),
 *                      destination, then the format's options
 *   Export for Screens artboards with thumbnails and checkboxes, several
 *                      formats/scales with suffixes, zip or separate files
 *   Export Selection   the same panel for the selected artwork
 *   Print              artboard range and scaling, then the browser's print
 *   Place              choose the source (device or Puter) when signed in
 */
import { UserError } from '../../lib/errors.js';
import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { formatLength, parseLength } from '../../lib/units.js';
import { FORMATS, parseRange, artworkBounds, renderFile, outlinesFor } from './jobs.js';
import { canSaveToPuter, deliverFiles, safeFileName } from './deliver.js';
import { thumbnail } from './raster.js';
import { placeFile } from './place.js';
import { pickDeviceFiles } from './kinds.js';

let uidc = 0;
const fid = (p) => `io-${p}-${++uidc}`;

function row(label, control, { help, id } = {}) {
  const cid = id || control.id || fid('c');
  control.id = cid;
  return h('div.form-row', h('label', { for: cid }, label), control, help ? h('p.form-help', help) : null);
}

function select(options, value) {
  return h(
    'select',
    {},
    options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)),
  );
}

function checkbox(label, checked, extra = {}) {
  const id = fid('cb');
  const input = h('input', { type: 'checkbox', id, checked: Boolean(checked), ...extra });
  return { input, el: h('div.form-row.check', input, h('label', { for: id }, label)) };
}

function radios(name, options, value, label) {
  const lid = fid('rl');
  const group = h(
    'div.radio-group',
    { role: 'radiogroup', 'aria-labelledby': lid },
    options.map((o) => h('label.radio', h('input', { type: 'radio', name, value: o.value, checked: o.value === value, disabled: o.disabled }), o.label)),
  );
  return { group, el: h('div.form-row', h('span.form-label', { id: lid }, label), group), get: () => group.querySelector('input:checked')?.value };
}

function docBaseName(editor) {
  return safeFileName(String(editor.file?.name || editor.name || 'Untitled').replace(/\.(vstudio|svg|pdf)$/i, ''));
}

function getPref(app, key, fallback) {
  const v = app.prefs?.get(`io.${key}`);
  return v && typeof v === 'object' ? { ...fallback, ...v } : fallback;
}

function setPref(app, key, value) {
  app.prefs?.set(`io.${key}`, value);
}

function destinationField(app, value) {
  if (!canSaveToPuter(app)) return null;
  return radios(fid('dest'), [{ value: 'device', label: 'This device (download)' }, { value: 'puter', label: 'Puter' }], value === 'puter' ? 'puter' : 'device', 'Save to');
}

// ---------------------------------------------------------------- format options

const RESOLUTIONS = [
  { value: '72', label: 'Screen (72 ppi)' },
  { value: '150', label: 'Medium (150 ppi)' },
  { value: '300', label: 'High (300 ppi)' },
  { value: 'other', label: 'Other' },
];

/** Options dialog for a format. Resolves to an options object or null. */
export async function formatOptionsDialog(app, format) {
  const unit = app.editor?.doc.root.units || 'pt';
  const defaults = {
    svg: { precision: 3, minify: false, responsive: false, textMode: 'text', symbols: false },
    pdf: { bleed: 0, useDocBleed: true, textOutlines: true },
    png: { ppi: 72, background: 'transparent', antialias: true },
    jpeg: { ppi: 72, quality: 0.8, antialias: true },
    webp: { ppi: 72, quality: 0.9, background: 'transparent', antialias: true },
  }[format];
  const o = getPref(app, `opts.${format}`, defaults);
  const fields = [];
  const readers = [];
  if (format === 'svg') {
    const prec = select([1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: String(n) })), o.precision);
    const font = select([{ value: 'text', label: 'SVG text' }, { value: 'outlines', label: 'Convert to Outlines' }], o.textMode);
    if (!app.textOutlines) {
      font.value = 'text';
      font.disabled = true;
    }
    const minify = checkbox('Minify', o.minify);
    const responsive = checkbox('Responsive (no fixed width and height)', o.responsive);
    const symbols = checkbox('Write symbols as <symbol> and <use>', o.symbols);
    fields.push(row('Font', font, { help: app.textOutlines ? null : 'Converting text to outlines needs the type features.' }), h('div.form-row', h('span.form-label', 'Images'), h('span.io-static', 'Embed')), row('Decimal places', prec), minify.el, responsive.el, symbols.el);
    readers.push(() => ({ precision: Number(prec.value), textMode: font.value, minify: minify.input.checked, responsive: responsive.input.checked, symbols: symbols.input.checked }));
  } else if (format === 'pdf') {
    const docBleed = app.editor?.doc.root.bleed;
    const docSides = typeof docBleed === 'number' ? [docBleed] : ['top', 'bottom', 'left', 'right'].map((k) => docBleed?.[k] || 0);
    const bleed = h('input', { type: 'text', inputmode: 'decimal', value: formatLength(o.bleed || 0, unit), autocomplete: 'off', spellcheck: false });
    const useDoc = checkbox('Use Document Bleed Settings', o.useDocBleed !== false);
    const docHelp = `Document bleed: ${[...new Set(docSides)].map((v) => formatLength(v, unit)).join(', ') || formatLength(0, unit)}.`;
    const bleedRow = row('Bleed', bleed, { help: 'Added on every side of each page.' });
    const docRow = h('p.form-help', docHelp);
    const syncBleed = () => {
      bleed.disabled = useDoc.input.checked;
      docRow.hidden = !useDoc.input.checked;
    };
    useDoc.input.addEventListener('change', syncBleed);
    syncBleed();
    const outl = checkbox('Convert text to outlines', o.textOutlines !== false);
    if (!app.textOutlines) {
      outl.input.disabled = true;
      outl.input.checked = false;
    }
    fields.push(useDoc.el, docRow, bleedRow, outl.el);
    if (!app.textOutlines) fields.push(h('p.form-help', 'Text is written with a standard font.'));
    readers.push(() => {
      const b = parseLength(bleed.value, unit);
      if (!useDoc.input.checked && (!Number.isFinite(b) || b < 0 || b > 1000)) throw Object.assign(new Error('Enter a valid bleed.'), { field: bleed });
      return { bleed: Number.isFinite(b) ? b : 0, useDocBleed: useDoc.input.checked, textOutlines: outl.input.checked };
    });
  } else {
    const preset = RESOLUTIONS.some((r) => r.value === String(o.ppi)) ? String(o.ppi) : 'other';
    const res = select(RESOLUTIONS, preset);
    const ppi = h('input', { type: 'number', min: 10, max: 2400, step: 1, value: o.ppi, 'aria-label': 'Resolution in pixels per inch' });
    const ppiRow = row('Resolution (ppi)', ppi);
    ppiRow.hidden = preset !== 'other';
    res.addEventListener('change', () => {
      ppiRow.hidden = res.value !== 'other';
      if (res.value !== 'other') ppi.value = res.value;
    });
    fields.push(row('Resolution', res), ppiRow);
    let bg = null;
    if (format !== 'jpeg') {
      bg = select([{ value: 'transparent', label: 'Transparent' }, { value: '#ffffff', label: 'White' }, { value: '#000000', label: 'Black' }], o.background);
      fields.push(row('Background', bg));
    } else fields.push(h('div.form-row', h('span.form-label', 'Background'), h('span.io-static', 'White')));
    const aa = select([{ value: 'art', label: 'Art Optimized (Supersampling)' }, { value: 'none', label: 'None' }], o.antialias === false ? 'none' : 'art');
    fields.push(row('Anti-aliasing', aa));
    let quality = null;
    if (format !== 'png') {
      const qid = fid('q');
      const out = h('output', { for: qid }, String(Math.round((o.quality ?? 0.8) * 10)));
      quality = h('input', { type: 'range', id: qid, min: 0, max: 10, step: 1, value: Math.round((o.quality ?? 0.8) * 10) });
      quality.addEventListener('input', () => (out.textContent = quality.value));
      fields.push(h('div.form-row', h('label', { for: qid }, 'Quality'), h('div.range-wrap', quality, out)));
    }
    readers.push(() => {
      const p = res.value === 'other' ? Number(ppi.value) : Number(res.value);
      if (!Number.isFinite(p) || p < 10 || p > 2400) throw Object.assign(new Error('Enter a resolution between 10 and 2400 ppi.'), { field: ppi });
      return { ppi: p, scale: p / 72, background: bg ? bg.value : '#ffffff', antialias: aa.value !== 'none', quality: quality ? Math.max(0.05, Number(quality.value) / 10) : undefined };
    });
  }
  const error = h('p.form-error', { role: 'alert' });
  const read = () => Object.assign({}, ...readers.map((r) => r()));
  const title = { svg: 'SVG Options', pdf: 'PDF Options', png: 'PNG Options', jpeg: 'JPEG Options', webp: 'WebP Options' }[format];
  const result = await app.dialogs.open({
    title,
    className: 'io-dialog',
    body: h('div.form', fields, error),
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'OK',
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
  });
  if (result) setPref(app, `opts.${format}`, result);
  return result;
}

// ---------------------------------------------------------------- running exports

async function runExport(app, files, dest, opts = {}) {
  try {
    const msg = await deliverFiles(app, files, { dest, ...opts });
    if (msg) app.notify(msg);
  } catch (err) {
    app.notify(err?.message || 'Export failed.', { error: true });
  }
}

/** Export As: step 1 (name, format, artboards, destination), step 2 (format options). */
export async function exportAsDialog(app) {
  const editor = app.editor;
  if (!editor) return;
  const doc = editor.doc;
  const last = getPref(app, 'exportAs', { format: 'svg', useArtboards: true, range: 'all', dest: 'device' });
  const name = h('input', { type: 'text', value: docBaseName(editor), autocomplete: 'off', spellcheck: false });
  const format = select(Object.entries(FORMATS).map(([value, f]) => ({ value, label: f.label })), last.format);
  const use = checkbox('Use Artboards', last.useArtboards);
  const count = doc.artboards.length;
  const rangeGroup = radios(fid('range'), [{ value: 'all', label: 'All' }, { value: 'range', label: 'Range' }], last.range === 'range' ? 'range' : 'all', 'Export');
  const rangeInput = h('input.io-range', { type: 'text', value: `1-${count}`, 'aria-label': 'Artboard range', autocomplete: 'off', spellcheck: false });
  rangeGroup.group.querySelector('input[value="range"]').parentElement.append(rangeInput);
  const dest = destinationField(app, last.dest);
  const sync = () => {
    const on = use.input.checked;
    for (const r of rangeGroup.group.querySelectorAll('input')) r.disabled = !on;
    rangeInput.disabled = !on || rangeGroup.get() !== 'range';
  };
  rangeGroup.group.addEventListener('change', sync);
  use.input.addEventListener('change', sync);
  rangeInput.addEventListener('focus', () => {
    rangeGroup.group.querySelector('input[value="range"]').checked = true;
    sync();
  });
  sync();
  const info = h('p.form-help', `${count} artboard${count === 1 ? '' : 's'} in this document.`);
  const error = h('p.form-error', { role: 'alert' });
  const read = () => {
    const nm = safeFileName(name.value, '');
    if (!nm) throw Object.assign(new Error('Enter a file name.'), { field: name });
    let indices = null;
    if (use.input.checked) {
      indices = rangeGroup.get() === 'range' ? parseRange(rangeInput.value, count) : doc.artboards.map((_, i) => i);
      if (!indices) throw Object.assign(new Error(`Enter artboard numbers between 1 and ${count}, like 1-3, 5.`), { field: rangeInput });
    }
    return { name: nm, format: format.value, useArtboards: use.input.checked, range: rangeGroup.get(), indices, dest: dest?.get() || 'device' };
  };
  const step1 = await app.dialogs.open({
    title: 'Export As',
    className: 'io-dialog',
    body: h('div.form', row('File name', name), row('Format', format), h('fieldset.io-fieldset', h('legend', 'Artboards'), use.el, rangeGroup.el, info), dest?.el, error),
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Export',
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
  });
  if (!step1) return;
  setPref(app, 'exportAs', { format: step1.format, useArtboards: step1.useArtboards, range: step1.range, dest: step1.dest });
  const options = await formatOptionsDialog(app, step1.format);
  if (!options) return;
  const fmt = FORMATS[step1.format];
  app.notify('Exporting...', { timeout: 2000 });
  const files = [];
  try {
    if (!step1.useArtboards) {
      const rect = artworkBounds(doc);
      if (!rect) throw new UserError('There is no artwork to export.');
      files.push({ name: `${step1.name}.${fmt.ext}`, blob: await renderFile(app, editor, step1.format, { rect }, { ...options, title: step1.name }) });
    } else if (step1.format === 'pdf') {
      const rects = step1.indices.map((i) => doc.artboards[i]);
      files.push({ name: `${step1.name}.pdf`, blob: await renderFile(app, editor, 'pdf', { rects }, { ...options, title: step1.name }) });
    } else {
      for (const i of step1.indices) {
        const board = doc.artboards[i];
        const suffix = step1.indices.length > 1 ? `-${safeFileName(board.name || `Artboard ${i + 1}`)}` : '';
        files.push({ name: `${step1.name}${suffix}.${fmt.ext}`, blob: await renderFile(app, editor, step1.format, { artboard: i }, { ...options, title: board.name }) });
      }
    }
  } catch (err) {
    app.notify(err?.message || 'Export failed.', { error: true });
    return;
  }
  await runExport(app, files, step1.dest, { zipName: `${step1.name}.zip` });
}

// ---------------------------------------------------------------- export for screens

const SCREEN_FORMATS = [
  { value: 'png', label: 'PNG', format: 'png', opts: {} },
  { value: 'jpg100', label: 'JPG 100', format: 'jpeg', opts: { quality: 1 } },
  { value: 'jpg80', label: 'JPG 80', format: 'jpeg', opts: { quality: 0.8 } },
  { value: 'jpg50', label: 'JPG 50', format: 'jpeg', opts: { quality: 0.5 } },
  { value: 'webp', label: 'WebP', format: 'webp', opts: { quality: 0.9 } },
  { value: 'svg', label: 'SVG', format: 'svg', opts: {} },
  { value: 'pdf', label: 'PDF', format: 'pdf', opts: {} },
];
const SCALES = [0.5, 0.75, 1, 1.5, 2, 3, 4];
const SCALE_SETS = {
  ios: [
    { scale: 1, suffix: '', fmt: 'png' },
    { scale: 2, suffix: '@2x', fmt: 'png' },
    { scale: 3, suffix: '@3x', fmt: 'png' },
  ],
  android: [
    { scale: 0.75, suffix: '-ldpi', fmt: 'png' },
    { scale: 1, suffix: '-mdpi', fmt: 'png' },
    { scale: 1.5, suffix: '-hdpi', fmt: 'png' },
    { scale: 2, suffix: '-xhdpi', fmt: 'png' },
    { scale: 3, suffix: '-xxhdpi', fmt: 'png' },
    { scale: 4, suffix: '-xxxhdpi', fmt: 'png' },
  ],
};
const scaleSuffix = (s) => (s === 1 ? '' : `@${s}x`);

/**
 * Export for Screens (mode 'artboards') or Export Selection (mode 'selection').
 */
export async function exportScreensDialog(app, mode = 'artboards') {
  const editor = app.editor;
  if (!editor) return;
  const doc = editor.doc;
  const last = getPref(app, 'screens', { rows: [{ scale: 1, suffix: '', fmt: 'png' }], prefix: '', zip: true, dest: 'device', bleed: false, fullDocument: false, subfolders: false });
  const assets = [];
  if (mode === 'selection') {
    const ids = editor.topSelection();
    if (!ids.length) {
      app.notify('Select artwork to export.');
      return;
    }
    const first = doc.get(ids[0]);
    const nm = (ids.length === 1 && first?.name) || 'Asset 1';
    assets.push({ name: nm, region: { selection: true, ids }, rect: null, checked: true });
  } else {
    doc.artboards.forEach((a, i) => assets.push({ name: a.name || `Artboard ${i + 1}`, region: { artboard: i }, rect: a, checked: true }));
  }

  // Left: assets with thumbnails.
  const list = h('ul.io-assets', { 'aria-label': mode === 'selection' ? 'Asset' : 'Artboards' });
  const checks = [];
  const nameInputs = [];
  assets.forEach((asset, i) => {
    const rect = asset.rect;
    let thumb;
    try {
      const r = rect || (mode === 'selection' ? editor.selectionBounds(true) : null);
      thumb = r ? thumbnail(doc, r, 112) : h('span');
    } catch {
      thumb = h('span');
    }
    thumb.classList.add('io-thumb');
    thumb.setAttribute('aria-hidden', 'true');
    const cid = fid('ab');
    const cb = h('input', { type: 'checkbox', id: cid, checked: true });
    checks.push(cb);
    const nameInput = h('input.io-asset-name', { type: 'text', value: asset.name, 'aria-label': `File name for ${asset.name}`, autocomplete: 'off', spellcheck: false });
    nameInputs.push(nameInput);
    const label = mode === 'selection' ? h('span.io-asset-num', 'Selection') : h('label.io-asset-num', { for: cid }, `${i + 1}`);
    list.append(h('li.io-asset', h('div.io-thumb-wrap', thumb), h('div.io-asset-meta', mode === 'selection' ? null : cb, label, nameInput)));
  });
  const selectAll = (v) => checks.forEach((c) => (c.checked = v));
  // A range ("1-3, 5") ticks exactly those artboards.
  const rangeInput = h('input.io-range', { type: 'text', 'aria-label': 'Artboard range', placeholder: 'Range, e.g. 1-3', autocomplete: 'off', spellcheck: false });
  rangeInput.addEventListener('input', () => {
    const picked = parseRange(rangeInput.value, checks.length);
    rangeInput.toggleAttribute('aria-invalid', Boolean(rangeInput.value.trim()) && !picked);
    if (picked) checks.forEach((c, i) => (c.checked = picked.includes(i)));
  });
  const bleedBox = checkbox('Include Bleed', last.bleed);
  const fullDoc = checkbox('Full Document (all artwork as one file)', last.fullDocument);
  const syncFull = () => {
    const on = fullDoc.input.checked;
    list.classList.toggle('io-disabled', on);
    for (const el of [...checks, rangeInput, bleedBox.input, ...list.querySelectorAll('input')]) el.disabled = on;
  };
  fullDoc.input.addEventListener('change', syncFull);
  if (mode !== 'selection') syncFull();
  const leftTools =
    mode === 'selection'
      ? null
      : h(
          'div.io-select-row',
          h('span', 'Select:'),
          h('button.btn.small.ghost', { type: 'button', onclick: () => selectAll(true) }, 'All'),
          h('button.btn.small.ghost', { type: 'button', onclick: () => selectAll(false) }, 'None'),
          rangeInput,
        );
  const leftOptions = mode === 'selection' ? null : h('div.form.io-screens-options', bleedBox.el, fullDoc.el);

  // Right: formats.
  const rowsHost = h('div.io-format-rows', { role: 'group', 'aria-label': 'Formats' });
  const rows = last.rows.map((r) => ({ ...r }));
  const renderRows = () => {
    rowsHost.replaceChildren(
      h('div.io-format-head', { 'aria-hidden': 'true' }, h('span', 'Scale'), h('span', 'Suffix'), h('span', 'Format'), h('span')),
      ...rows.map((r, i) => {
        const sc = select(SCALES.map((s) => ({ value: s, label: `${s}x` })), r.scale);
        sc.setAttribute('aria-label', `Scale ${i + 1}`);
        const suf = h('input', { type: 'text', value: r.suffix, 'aria-label': `Suffix ${i + 1}`, autocomplete: 'off', spellcheck: false, placeholder: 'none' });
        const fm = select(SCREEN_FORMATS.map((f) => ({ value: f.value, label: f.label })), r.fmt);
        fm.setAttribute('aria-label', `Format ${i + 1}`);
        sc.addEventListener('change', () => {
          const prevAuto = r.suffix === scaleSuffix(r.scale);
          r.scale = Number(sc.value);
          if (prevAuto || !r.suffix) {
            r.suffix = scaleSuffix(r.scale);
            suf.value = r.suffix;
          }
        });
        suf.addEventListener('input', () => (r.suffix = suf.value));
        fm.addEventListener('change', () => (r.fmt = fm.value));
        const del = h('button.icon-btn', { type: 'button', 'aria-label': `Remove format ${i + 1}`, 'data-tip': 'Remove', disabled: rows.length === 1, onclick: () => (rows.splice(i, 1), renderRows()) }, icon('x', 14));
        return h('div.io-format-row', sc, suf, fm, del);
      }),
    );
  };
  renderRows();
  const addBtn = h(
    'button.btn.small',
    {
      type: 'button',
      onclick: () => {
        const used = new Set(rows.map((r) => r.scale));
        const scale = [2, 3, 4, 1.5, 0.5, 0.75].find((s) => !used.has(s)) || 2;
        rows.push({ scale, suffix: scaleSuffix(scale), fmt: rows[rows.length - 1]?.fmt || 'png' });
        renderRows();
        rowsHost.querySelector('.io-format-row:last-child select')?.focus();
      },
    },
    icon('plus', 14),
    'Add Scale',
  );
  const prefix = h('input', { type: 'text', value: last.prefix, autocomplete: 'off', spellcheck: false, placeholder: 'none' });
  const zip = checkbox('Save as one ZIP file', last.zip);
  const subfolders = checkbox('Create Sub-folders (by scale and format)', last.subfolders);
  const syncZip = () => (subfolders.input.disabled = !zip.input.checked);
  zip.input.addEventListener('change', syncZip);
  syncZip();
  // Common scale sets for app icons and assets.
  const presetBtn = (label, key) =>
    h('button.btn.small.ghost', {
      type: 'button',
      onclick: () => {
        rows.splice(0, rows.length, ...SCALE_SETS[key].map((r) => ({ ...r })));
        renderRows();
      },
    }, label);
  const presets = h('div.io-format-presets', h('span', 'Presets:'), presetBtn('iOS', 'ios'), presetBtn('Android', 'android'));
  const dest = destinationField(app, last.dest);
  const error = h('p.form-error', { role: 'alert' });
  const body = h(
    'div.io-screens',
    h('section.io-screens-left', h('h3.form-heading', mode === 'selection' ? 'Asset' : 'Artboards'), leftTools, list, leftOptions),
    h('section.io-screens-right', h('h3.form-heading', 'Formats'), presets, rowsHost, addBtn, h('div.form', row('Prefix', prefix), zip.el, subfolders.el, dest?.el), error),
  );
  const ok = await app.dialogs.open({
    title: mode === 'selection' ? 'Export Selection' : 'Export for Screens',
    className: 'wide io-dialog',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: mode === 'selection' ? 'Export Asset' : 'Export Artboard',
        primary: true,
        validate: () => {
          if (mode !== 'selection' && fullDoc.input.checked) return true;
          if (!checks.some((c) => c.checked)) {
            error.textContent = 'Select at least one artboard.';
            return false;
          }
          return true;
        },
        value: true,
      },
    ],
  });
  if (!ok) return;
  const full = mode !== 'selection' && fullDoc.input.checked;
  const withBleed = mode !== 'selection' && bleedBox.input.checked;
  setPref(app, 'screens', { rows, prefix: prefix.value, zip: zip.input.checked, dest: dest?.get() || 'device', bleed: bleedBox?.input.checked ?? last.bleed, fullDocument: fullDoc?.input.checked ?? last.fullDocument, subfolders: subfolders.input.checked });
  app.notify('Exporting...', { timeout: 2000 });
  const files = [];
  const folders = zip.input.checked && subfolders.input.checked;
  const bleed = doc.root.bleed || {};
  const regionOf = (i) => {
    const r = assets[i].region;
    if (!withBleed || r.artboard == null) return r;
    const a = doc.artboards[r.artboard];
    const t = bleed.top || 0;
    const l = bleed.left || 0;
    return { rect: { x: a.x - l, y: a.y - t, w: a.w + l + (bleed.right || 0), h: a.h + t + (bleed.bottom || 0) } };
  };
  const jobs = full
    ? [{ name: docBaseName(editor), region: { rect: artworkBounds(doc) } }]
    : assets.map((a, i) => (checks[i].checked ? { name: nameInputs[i].value || a.name, region: regionOf(i) } : null)).filter(Boolean);
  if (full && !jobs[0].region.rect) {
    app.notify('There is no artwork to export.');
    return;
  }
  try {
    for (const job of jobs) {
      const base = safeFileName(`${prefix.value}${job.name}`);
      for (const r of rows) {
        const f = SCREEN_FORMATS.find((x) => x.value === r.fmt) || SCREEN_FORMATS[0];
        const fmt = FORMATS[f.format];
        const options = { ...f.opts, scale: r.scale, background: 'transparent' };
        if (f.format === 'svg' || f.format === 'pdf') options.scale = 1;
        const blob = await renderFile(app, editor, f.format, job.region, options);
        const folder = !folders ? '' : f.format === 'svg' || f.format === 'pdf' ? `${fmt.ext.toUpperCase()}/` : `${r.scale}x/`;
        files.push({ name: `${folder}${base}${safeFileName(r.suffix || '', '')}.${fmt.ext}`, blob });
      }
    }
  } catch (err) {
    app.notify(err?.message || 'Export failed.', { error: true });
    return;
  }
  await runExport(app, files, dest?.get() || 'device', { zip: zip.input.checked, zipName: `${safeFileName(docBaseName(editor))}.zip` });
}

// ---------------------------------------------------------------- place

async function pickPuterFiles(app) {
  const p = app.puter.ui.showOpenFilePicker({ multiple: true, accept: ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif'] });
  // Resolves undefined on cancel where the SDK supports it (the plain promise never settles then).
  const picked = await (p && p.undefinedOnCancel ? p.undefinedOnCancel : p);
  const items = Array.isArray(picked) ? picked : picked ? [picked] : [];
  const files = [];
  for (const it of items) {
    const blob = await it.read();
    const name = it.name || 'image';
    const ext = name.split('.').pop().toLowerCase();
    const type = blob.type || (ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    const file = new File([blob], name, { type });
    // Images placed from Puter stay linked to their file (Links panel: Update Link, Edit Original).
    if (it.path) file.puterPath = it.path;
    files.push(file);
  }
  return files;
}

export async function placeCommand(app) {
  const editor = app.editor;
  if (!editor) return;
  let source = 'device';
  if (canSaveToPuter(app) && app.puter.ui.showOpenFilePicker) {
    source = await app.dialogs.open({
      title: 'Place',
      className: 'io-dialog',
      body: h('div.io-place', h('p.dialog-message', 'Place SVG artwork or an image (PNG, JPEG, WebP, GIF) in the center of the view.'), h('div.io-place-buttons', h('button.btn.block', { type: 'button', 'data-src': 'device' }, icon('file-down', 16), 'From This Device...'), h('button.btn.block', { type: 'button', 'data-src': 'puter' }, icon('folder-open', 16), 'From Puter...'))),
      buttons: [{ label: 'Cancel', value: null }],
      onOpen: ({ content, close }) => {
        for (const b of content.querySelectorAll('[data-src]')) b.addEventListener('click', () => close(b.dataset.src));
      },
    });
    if (!source) return;
  }
  let files;
  try {
    files = source === 'puter' ? await pickPuterFiles(app) : await pickDeviceFiles();
  } catch (err) {
    app.notify(err?.message || 'Could not read the file.', { error: true });
    return;
  }
  if (app.editor === editor) await placeFiles(app, editor, files);
}

/** Place picked files around the view center and select them. */
export async function placeFiles(app, editor, files) {
  if (!files?.length) return;
  const placed = [];
  let offset = 0;
  const c = editor.view.toDoc(editor.view.width / 2, editor.view.height / 2);
  for (const f of files) {
    const id = await placeFile(app, editor, f, { point: { x: c.x + offset, y: c.y + offset }, select: false });
    if (id) placed.push(id);
    offset += 12;
  }
  if (placed.length) editor.select(placed);
}
