/**
 * Save for Web and Save Selected Slices (loaded on first use).
 *
 * The dialog previews the artboard (or the whole sliced area) as Original,
 * Optimized or both side by side, with the slices drawn over it; clicking a
 * slice (or picking it from the Slice list) selects it, and the settings on
 * the right apply to the selected slices (all slices when none is
 * selected). Formats: PNG-24, PNG-8 and GIF (color reduction, dithering,
 * transparency and matte), JPEG (quality, matte) and SVG. The estimated file
 * size and the color table update as you change settings. Save writes
 * every slice's image (and an HTML page placing them when there are several
 * slices, links or text cells); Done keeps the settings with the slices.
 */
import { h } from '../../lib/dom.js';
import { UserError } from '../../lib/errors.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { renderRegion } from '../io/raster.js';
import { canSaveToPuter, deliverFiles, safeFileName } from '../io/deliver.js';
import { quantize, indexedToRgba, encodeGIF, encodePNG8 } from './encode.js';
import { sliceTable, sliceAreas, clipsToArtboard, defaultSliceName, updateSlice, findSlice } from './model.js';
import { selectedSlices } from './tools.js';

export const FORMATS = [
  { value: 'png24', label: 'PNG-24', ext: 'png' },
  { value: 'png8', label: 'PNG-8', ext: 'png' },
  { value: 'jpeg', label: 'JPEG', ext: 'jpg' },
  { value: 'gif', label: 'GIF', ext: 'gif' },
  { value: 'svg', label: 'SVG', ext: 'svg' },
];

export const METHODS = [
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'perceptual', label: 'Perceptual' },
  { value: 'web', label: 'Web-safe' },
  { value: 'grayscale', label: 'Grayscale' },
  { value: 'bw', label: 'Black and White' },
];

export const DEFAULT_SETTINGS = Object.freeze({ format: 'png24', colors: 128, method: 'adaptive', dither: 100, transparency: true, matte: '#ffffff', interlace: false, quality: 80, svgDigits: 2, svgMinify: true, svgResponsive: false });

export const PRESETS = [
  { label: 'PNG, full color', s: { format: 'png24', transparency: true } },
  { label: 'PNG, 128 colors, dithered', s: { format: 'png8', colors: 128, dither: 100 } },
  { label: 'PNG, 64 colors, dithered', s: { format: 'png8', colors: 64, dither: 100 } },
  { label: 'GIF, 128 colors, dithered', s: { format: 'gif', colors: 128, dither: 100 } },
  { label: 'GIF, 64 colors, no dither', s: { format: 'gif', colors: 64, dither: 0 } },
  { label: 'GIF, 32 colors, no dither', s: { format: 'gif', colors: 32, dither: 0 } },
  { label: 'GIF, web-safe colors', s: { format: 'gif', colors: 216, method: 'web', dither: 0 } },
  { label: 'JPEG, high quality', s: { format: 'jpeg', quality: 80 } },
  { label: 'JPEG, medium quality', s: { format: 'jpeg', quality: 60 } },
  { label: 'JPEG, low quality', s: { format: 'jpeg', quality: 30 } },
  { label: 'SVG', s: { format: 'svg' } },
];

const fmtInfo = (f) => FORMATS.find((x) => x.value === f) || FORMATS[0];

/** Settings for a slice: its own, else the dialog defaults. */
export function settingsFor(row, defaults) {
  return { ...DEFAULT_SETTINGS, ...defaults, ...(row?.slice?.export || {}) };
}

/** The file name (without extension) of a slice row. */
export function sliceFileName(doc, row, single, base) {
  if (single && !row.slice) return safeFileName(base);
  return safeFileName(row.slice?.name || defaultSliceName(doc, row.number));
}

/**
 * The rows one area exports: its slices, or one row for the whole area
 * when it has no user or object slices.
 */
export function exportRows(doc, areaIndex) {
  const area = sliceAreas(doc)[areaIndex];
  if (!area) return { area: null, rows: [] };
  const rows = sliceTable(doc).filter((r) => r.area === areaIndex);
  if (!rows.some((r) => r.kind !== 'auto')) return { area, rows: [{ id: 'whole', kind: 'auto', rect: { x: area.x, y: area.y, w: area.w, h: area.h }, number: 1, slice: null, area: areaIndex }] };
  return { area, rows };
}

async function toBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), type, quality));
}

function makeCanvas(w, h) {
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

/** Pixel rect of a slice inside the area's rendered canvas. */
function pixelBox(area, rect, scale) {
  const x = Math.round((rect.x - area.x) * scale);
  const y = Math.round((rect.y - area.y) * scale);
  return { x, y, w: Math.max(1, Math.round((rect.x + rect.w - area.x) * scale) - x), h: Math.max(1, Math.round((rect.y + rect.h - area.y) * scale) - y) };
}

/**
 * Optimize one slice from the rendered area: { blob, bytes, preview (canvas
 * of what the file looks like), palette, box, type }. No Image slices have
 * no file.
 */
export async function optimizeSlice(app, editor, source, area, row, s, scale) {
  const box = pixelBox(area, row.rect, scale);
  if (row.slice?.type === 'noImage' || row.slice?.type === 'html') return { blob: null, bytes: 0, preview: null, palette: null, box, type: 'none' };
  const crop = makeCanvas(box.w, box.h);
  const ctx = crop.getContext('2d');
  const bg = row.slice?.bg || null;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, box.w, box.h);
  }
  ctx.drawImage(source, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  if (s.format === 'svg') {
    const text = await app.exporters.svg(editor, { rect: row.rect, precision: s.svgDigits, minify: s.svgMinify, responsive: s.svgResponsive, background: bg || undefined, title: row.slice?.name });
    const blob = new Blob([text], { type: 'image/svg+xml' });
    return { blob, bytes: blob.size, preview: crop, palette: null, box, type: 'svg' };
  }
  const opaque = s.format === 'jpeg' || !s.transparency;
  if (s.format === 'png24' || s.format === 'jpeg') {
    let out = crop;
    if (opaque) {
      out = makeCanvas(box.w, box.h);
      const o = out.getContext('2d');
      o.fillStyle = s.matte || '#ffffff';
      o.fillRect(0, 0, box.w, box.h);
      o.drawImage(crop, 0, 0);
    }
    const type = s.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await toBlob(out, type, s.format === 'jpeg' ? Math.max(0.01, Math.min(1, s.quality / 100)) : undefined);
    let preview = out;
    if (s.format === 'jpeg' && typeof createImageBitmap === 'function') {
      try {
        const bmp = await createImageBitmap(blob);
        preview = makeCanvas(box.w, box.h);
        preview.getContext('2d').drawImage(bmp, 0, 0);
      } catch {
        preview = out;
      }
    }
    return { blob, bytes: blob.size, preview, palette: null, box, type };
  }
  const img = ctx.getImageData(0, 0, box.w, box.h);
  const q = quantize(img.data, box.w, box.h, { colors: s.colors, method: s.method, dither: s.dither / 100, transparency: s.transparency, matte: s.matte || (s.transparency ? null : '#ffffff') });
  const bytes = s.format === 'gif' ? encodeGIF(box.w, box.h, q, { interlace: s.interlace }) : await encodePNG8(box.w, box.h, q);
  const blob = new Blob([bytes], { type: s.format === 'gif' ? 'image/gif' : 'image/png' });
  const preview = makeCanvas(box.w, box.h);
  const pctx = preview.getContext('2d');
  try {
    pctx.putImageData(new ImageData(indexedToRgba(q), box.w, box.h), 0, 0);
  } catch {
    pctx.drawImage(crop, 0, 0);
  }
  return { blob, bytes: blob.size, preview, palette: q.palette.slice(0, q.transparent >= 0 ? q.transparent : undefined), box, type: blob.type };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * An HTML page placing the slices: absolutely positioned images (links,
 * alt text, rollover messages) and text cells for No Image slices.
 */
export function slicesHtml(title, area, rows, files, scale) {
  const cells = rows.map((row) => {
    const b = pixelBox(area, row.rect, scale);
    const pos = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
    const s = row.slice || {};
    const bg = s.bg ? `;background:${s.bg}` : '';
    const file = files.get(row.id);
    let inner;
    if (!file) {
      const just = { left: 'flex-start', center: 'center', right: 'flex-end' }[s.align || 'left'];
      const al = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[s.valign || 'top'];
      inner = `<div class="cell" style="${pos}${bg};display:flex;justify-content:${just};align-items:${al}">${esc(s.html || '')}</div>`;
      return inner;
    }
    const img = `<img src="${esc(file)}" width="${b.w}" height="${b.h}" alt="${esc(s.alt || '')}"${s.message ? ` title="${esc(s.message)}"` : ''}>`;
    if (s.url) return `<a class="cell" href="${esc(s.url)}"${s.target ? ` target="${esc(s.target)}"` : ''} style="${pos}${bg}">${img}</a>`;
    return `<div class="cell" style="${pos}${bg}">${img}</div>`;
  });
  const w = Math.round(area.w * scale);
  const hh = Math.round(area.h * scale);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
.slices { position: relative; width: ${w}px; height: ${hh}px; margin: 0 auto; }
.slices .cell { position: absolute; display: block; overflow: hidden; }
.slices img { display: block; border: 0; }
</style>
</head>
<body>
<div class="slices">
${cells.join('\n')}
</div>
</body>
</html>
`;
}

/** Files to save for an area: images (in images/ when there is a page) and the page. */
async function buildFiles(app, editor, { area, rows, results, scale, base }) {
  const doc = editor.doc;
  const single = rows.length === 1;
  const needsPage = !single || rows.some((r) => r.slice?.url || r.slice?.type === 'noImage' || r.slice?.type === 'html');
  const files = [];
  const names = new Map();
  const used = new Set();
  for (const row of rows) {
    const res = results.get(row.id);
    if (!res?.blob) continue;
    let name = `${sliceFileName(doc, row, single, base)}.${res.ext}`;
    let i = 2;
    while (used.has(name)) name = `${sliceFileName(doc, row, single, base)}-${i++}.${res.ext}`;
    used.add(name);
    const path = needsPage ? `images/${name}` : name;
    names.set(row.id, path);
    files.push({ name: path, blob: res.blob });
  }
  if (needsPage) files.push({ name: `${safeFileName(base)}.html`, blob: new Blob([slicesHtml(base, area, rows, names, scale)], { type: 'text/html' }) });
  return files;
}

function formatBytes(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

let ctr = 0;
const fid = (p) => `sfw-${p}-${++ctr}`;

function labeled(label, control) {
  control.id ||= fid('c');
  return h('div.sfw-row', h('label', { for: control.id }, label), control);
}

/** File > Export > Save for Web. */
export async function saveForWebDialog(app, editor) {
  if (!editor) return;
  const doc = editor.doc;
  const last = app.prefs.get('saveForWeb') || {};
  let defaults = { ...DEFAULT_SETTINGS, ...(last.settings || {}) };
  const areas = sliceAreas(doc);
  if (!areas.length) throw new UserError('There is nothing to save: add artwork or an artboard first.');
  let areaIndex = clipsToArtboard(doc) ? Math.min(editor.activeArtboard, areas.length - 1) : 0;
  let percent = last.percent || 100;
  let antialias = last.antialias || 'art';
  let mode = 'optimized';
  let zoom = 'fit';
  let state = null; // { area, rows }
  let source = null; // rendered area canvas
  const results = new Map(); // row id -> optimize result (with ext, key)
  const local = new Map(); // row id -> settings edited in this dialog
  let selection = new Set();
  let busy = 0;
  const base = String(editor.file?.name || editor.name || 'Untitled').replace(/\.(vstudio|svg|pdf)$/i, '');

  // ---- controls ----
  const preset = h('select', h('option', { value: '' }, 'Custom'), PRESETS.map((p, i) => h('option', { value: String(i) }, p.label)));
  const format = h('select', FORMATS.map((f) => h('option', { value: f.value }, f.label)));
  const method = h('select', METHODS.map((m) => h('option', { value: m.value }, m.label)));
  const colors = h('select', [2, 4, 8, 16, 32, 64, 128, 216, 256].map((c) => h('option', { value: String(c) }, String(c))));
  const dither = h('input', { type: 'range', min: 0, max: 100, step: 1 });
  const ditherOut = h('output.sfw-out');
  const transparency = h('input', { type: 'checkbox' });
  const matteKind = h('select', [['none', 'None'], ['#ffffff', 'White'], ['#000000', 'Black'], ['other', 'Other']].map(([v, l]) => h('option', { value: v }, l)));
  const matteColor = h('input', { type: 'color', 'aria-label': 'Matte color' });
  const interlace = h('input', { type: 'checkbox' });
  const quality = h('input', { type: 'range', min: 1, max: 100, step: 1 });
  const qualityOut = h('output.sfw-out');
  const svgDigits = h('select', [0, 1, 2, 3, 4].map((d) => h('option', { value: String(d) }, String(d))));
  const svgMinify = h('input', { type: 'checkbox' });
  const svgResponsive = h('input', { type: 'checkbox' });
  const check = (input, label) => {
    input.id ||= fid('cb');
    return h('div.sfw-check', input, h('label', { for: input.id }, label));
  };
  const indexedRows = h('div.sfw-group', labeled('Reduction', method), labeled('Colors', colors), h('div.sfw-row', h('label', { for: (dither.id = fid('d')) }, 'Dither'), h('div.sfw-range', dither, ditherOut)), check(interlace, 'Interlaced (GIF)'));
  const jpegRows = h('div.sfw-group', h('div.sfw-row', h('label', { for: (quality.id = fid('q')) }, 'Quality'), h('div.sfw-range', quality, qualityOut)));
  const svgRows = h('div.sfw-group', labeled('Decimal places', svgDigits), check(svgMinify, 'Minify'), check(svgResponsive, 'Responsive (no fixed size)'));
  const transRow = check(transparency, 'Transparency');
  const matteRow = h('div.sfw-row', h('label', { for: (matteKind.id = fid('m')) }, 'Matte'), h('div.sfw-inline', matteKind, matteColor));
  const widthIn = h('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric' });
  const heightIn = h('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric' });
  const percentIn = h('input', { type: 'number', min: 1, max: 1000, step: 1, inputmode: 'numeric' });
  const aa = h('select', [['art', 'Art optimized (smooth)'], ['none', 'None (hard edges)']].map(([v, l]) => h('option', { value: v }, l)));
  const clip = h('input', { type: 'checkbox', checked: clipsToArtboard(doc) });
  const boardSel = h('select', doc.artboards.map((a, i) => h('option', { value: String(i) }, `${i + 1}. ${a.name || `Artboard ${i + 1}`}`)));
  const exportSel = h('select', [['all', 'All slices'], ['selected', 'Selected slices'], ['user', 'User slices']].map(([v, l]) => h('option', { value: v }, l)));
  exportSel.value = last.export || 'all';
  const sliceSel = h('select');
  const dest = canSaveToPuter(app) ? h('select', [['device', 'This device (download)'], ['puter', 'Puter']].map(([v, l]) => h('option', { value: v }, l))) : null;
  if (dest) dest.value = last.dest === 'puter' ? 'puter' : 'device';
  const palette = h('div.sfw-palette', { role: 'img', 'aria-label': 'Color table' });
  const status = h('p.sfw-status', { role: 'status', 'aria-live': 'polite' });
  const tabs = ['original', 'optimized', '2up'].map((m) => h('button.sfw-tab', { type: 'button', role: 'tab', 'aria-selected': String(m === mode), onclick: () => setMode(m) }, { original: 'Original', optimized: 'Optimized', '2up': '2-Up' }[m]));
  const zoomSel = h('select', { 'aria-label': 'Preview zoom' }, [['fit', 'Fit'], ['0.5', '50%'], ['1', '100%'], ['2', '200%']].map(([v, l]) => h('option', { value: v }, l)));
  const panes = h('div.sfw-panes');
  const scroller = h('div.sfw-preview', { tabindex: '0', role: 'region', 'aria-label': 'Preview (click a slice to select it)' }, panes);
  const infoL = h('p.sfw-info');
  const infoR = h('p.sfw-info');

  // ---- settings <-> controls ----
  const current = () => {
    const first = state?.rows.find((r) => selection.has(r.id)) || state?.rows[0];
    return { ...settingsFor(first, defaults), ...(first ? local.get(first.id) : {}) };
  };
  const readControls = () => ({
    format: format.value,
    method: method.value,
    colors: Number(colors.value),
    dither: Number(dither.value),
    transparency: transparency.checked,
    matte: matteKind.value === 'none' ? null : matteKind.value === 'other' ? matteColor.value : matteKind.value,
    interlace: interlace.checked,
    quality: Number(quality.value),
    svgDigits: Number(svgDigits.value),
    svgMinify: svgMinify.checked,
    svgResponsive: svgResponsive.checked,
  });
  const showControls = (s) => {
    format.value = s.format;
    method.value = s.method;
    colors.value = String(s.colors);
    if (!colors.value) colors.value = '128';
    dither.value = String(s.dither);
    ditherOut.textContent = `${s.dither}%`;
    transparency.checked = Boolean(s.transparency);
    matteKind.value = !s.matte ? 'none' : s.matte === '#ffffff' || s.matte === '#000000' ? s.matte : 'other';
    matteColor.value = s.matte && matteKind.value === 'other' ? s.matte : '#ffffff';
    interlace.checked = Boolean(s.interlace);
    quality.value = String(s.quality);
    qualityOut.textContent = String(s.quality);
    svgDigits.value = String(s.svgDigits);
    svgMinify.checked = Boolean(s.svgMinify);
    svgResponsive.checked = Boolean(s.svgResponsive);
    syncVisibility();
  };
  const syncVisibility = () => {
    const f = format.value;
    indexedRows.hidden = !(f === 'png8' || f === 'gif');
    interlace.parentElement.hidden = f !== 'gif';
    jpegRows.hidden = f !== 'jpeg';
    svgRows.hidden = f !== 'svg';
    transRow.hidden = f === 'jpeg' || f === 'svg';
    matteRow.hidden = f === 'svg';
    matteColor.hidden = matteKind.value !== 'other';
  };
  const targets = () => (selection.size ? state.rows.filter((r) => selection.has(r.id)) : state.rows);
  const applySettings = (patch) => {
    for (const r of targets()) local.set(r.id, { ...(local.get(r.id) || {}), ...patch });
    if (!selection.size) defaults = { ...defaults, ...patch };
    preset.value = '';
    syncVisibility();
    schedule();
  };
  for (const el of [format, method, colors, transparency, matteKind, matteColor, interlace, svgDigits, svgMinify, svgResponsive]) {
    el.addEventListener('change', () => applySettings(readControls()));
  }
  dither.addEventListener('input', () => {
    ditherOut.textContent = `${dither.value}%`;
    applySettings({ dither: Number(dither.value) });
  });
  quality.addEventListener('input', () => {
    qualityOut.textContent = quality.value;
    applySettings({ quality: Number(quality.value) });
  });
  preset.addEventListener('change', () => {
    const p = PRESETS[Number(preset.value)];
    if (!p) return;
    const s = { ...current(), ...p.s };
    showControls(s);
    applySettings(readControls());
    preset.value = String(PRESETS.indexOf(p));
  });

  // ---- size ----
  const area = () => state.area;
  const scale = () => percent / 100;
  const showSize = () => {
    widthIn.value = String(Math.round(area().w * scale()));
    heightIn.value = String(Math.round(area().h * scale()));
    percentIn.value = String(Math.round(percent * 100) / 100);
  };
  const setPercent = (p) => {
    if (!(p > 0) || !Number.isFinite(p)) return showSize();
    percent = Math.min(1000, p);
    showSize();
    rerender();
  };
  widthIn.addEventListener('change', () => setPercent((Number(widthIn.value) / area().w) * 100));
  heightIn.addEventListener('change', () => setPercent((Number(heightIn.value) / area().h) * 100));
  percentIn.addEventListener('change', () => setPercent(Number(percentIn.value)));
  aa.value = antialias;
  aa.addEventListener('change', () => {
    antialias = aa.value;
    rerender();
  });
  let clipTx = null;
  clip.addEventListener('change', () => {
    // Clipping changes the sliced area; it is a document setting (kept on Save or Done).
    if (clipTx) clipTx.cancel();
    clipTx = clip.checked === clipsToArtboard(doc) ? null : doc.begin('Clip Slices to Artboard');
    if (clipTx) doc.updateRoot({ sliceClip: clip.checked });
    areaIndex = clip.checked ? Math.min(Number(boardSel.value) || 0, doc.artboards.length - 1) : 0;
    boardSel.disabled = !clip.checked;
    load();
  });
  boardSel.value = String(areaIndex);
  boardSel.disabled = !clipsToArtboard(doc) || doc.artboards.length < 2;
  boardSel.addEventListener('change', () => {
    areaIndex = Number(boardSel.value);
    load();
  });
  zoomSel.addEventListener('change', () => {
    zoom = zoomSel.value;
    draw();
  });
  sliceSel.addEventListener('change', () => {
    selection = sliceSel.value ? new Set([sliceSel.value]) : new Set();
    showControls(current());
    draw();
  });

  function setMode(m) {
    mode = m;
    tabs.forEach((t, i) => t.setAttribute('aria-selected', String(['original', 'optimized', '2up'][i] === m)));
    draw();
  }

  // ---- rendering ----
  function load() {
    state = exportRows(doc, areaIndex);
    if (!state.area) state = exportRows(doc, (areaIndex = 0));
    const editorSel = selectedSlices(editor);
    selection = new Set(state.rows.filter((r) => editorSel.has(r.id)).map((r) => r.id));
    sliceSel.replaceChildren(h('option', { value: '' }, 'All slices'), ...state.rows.map((r) => h('option', { value: r.id }, `${String(r.number).padStart(2, '0')} ${r.slice?.name || (r.kind === 'auto' ? (r.id === 'whole' ? 'Whole artboard' : 'Auto slice') : defaultSliceName(doc, r.number))}`)));
    sliceSel.value = selection.size === 1 ? [...selection][0] : '';
    showSize();
    showControls(current());
    rerender();
  }

  async function rerender() {
    const token = ++busy;
    status.textContent = 'Rendering...';
    try {
      const a = area();
      const s = scale();
      const c = await renderRegion(doc, a, { scale: s, background: null, antialias: antialias !== 'none' });
      if (token !== busy) return;
      source = c;
      results.clear();
      await optimizeAll(token);
    } catch (err) {
      if (token === busy) status.textContent = err?.message || 'Could not render the preview.';
    }
  }

  let timer = 0;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => optimizeAll(++busy), 150);
  }

  async function optimizeAll(token) {
    if (!source) return;
    status.textContent = 'Optimizing...';
    for (const row of state.rows) {
      const s = { ...settingsFor(row, defaults), ...(local.get(row.id) || {}) };
      const key = JSON.stringify(s);
      if (results.get(row.id)?.key === key) continue;
      const res = await optimizeSlice(app, editor, source, area(), row, s, scale());
      if (token !== busy) return;
      results.set(row.id, { ...res, key, ext: fmtInfo(s.format).ext, settings: s });
    }
    status.textContent = '';
    draw();
  }

  function paneCanvas(kind) {
    const a = area();
    const s = scale();
    const W = Math.max(1, Math.round(a.w * s));
    const H = Math.max(1, Math.round(a.h * s));
    const c = makeCanvas(W, H);
    c.className = 'sfw-canvas';
    const ctx = c.getContext('2d');
    if (kind === 'original' && source) ctx.drawImage(source, 0, 0);
    else {
      for (const row of state.rows) {
        const r = results.get(row.id);
        const b = r?.box || pixelBox(a, row.rect, s);
        if (r?.preview) ctx.drawImage(r.preview, b.x, b.y);
        else if (row.slice?.bg) {
          ctx.fillStyle = row.slice.bg;
          ctx.fillRect(b.x, b.y, b.w, b.h);
        }
      }
    }
    // Slices over the preview.
    if (state.rows.length > 1) {
      ctx.save();
      ctx.font = '600 10px Inter, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      for (const row of state.rows) {
        const b = pixelBox(a, row.rect, s);
        const on = selection.has(row.id);
        ctx.strokeStyle = row.kind === 'auto' ? 'rgba(120,120,120,0.8)' : '#e8590c';
        ctx.setLineDash(row.kind === 'auto' ? [3, 3] : []);
        ctx.lineWidth = on ? 2 : 1;
        ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
        if (!on && selection.size) {
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillRect(b.x, b.y, b.w, b.h);
        }
        ctx.setLineDash([]);
        ctx.fillStyle = row.kind === 'auto' ? 'rgba(120,120,120,0.9)' : '#e8590c';
        ctx.fillRect(b.x + 1, b.y + 1, 22, 13);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(String(row.number).padStart(2, '0'), b.x + 5, b.y + 8);
      }
      ctx.restore();
    }
    const fit = zoom === 'fit' ? Math.min(1, (scroller.clientWidth - 24) / (mode === '2up' ? W * 2 + 12 : W) || 1, (scroller.clientHeight - 24) / H || 1) : Number(zoom);
    c.style.width = `${Math.max(1, W * (fit > 0 ? fit : 1))}px`;
    c.style.height = 'auto';
    c.addEventListener('click', (e) => {
      const r = c.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      const py = ((e.clientY - r.top) / r.height) * H;
      const hit = state.rows.find((row) => {
        const b = pixelBox(a, row.rect, s);
        return px >= b.x && py >= b.y && px <= b.x + b.w && py <= b.y + b.h;
      });
      if (!hit) selection = new Set();
      else if (e.shiftKey) {
        if (selection.has(hit.id)) selection.delete(hit.id);
        else selection.add(hit.id);
      } else selection = new Set([hit.id]);
      sliceSel.value = selection.size === 1 ? [...selection][0] : '';
      showControls(current());
      draw();
    });
    return c;
  }

  function draw() {
    if (!state) return;
    const sum = (rows) => rows.reduce((t, r) => t + (results.get(r.id)?.bytes || 0), 0);
    const shown = selection.size ? state.rows.filter((r) => selection.has(r.id)) : state.rows;
    const W = Math.round(area().w * scale());
    const H = Math.round(area().h * scale());
    const s = current();
    const first = results.get(shown[0]?.id);
    const size = sum(shown);
    infoR.textContent = `${fmtInfo(s.format).label}  ·  ${formatBytes(size)}${first?.palette ? `  ·  ${first.palette.length} colors` : ''}  ·  ${selection.size ? `${shown.length} of ${state.rows.length} slices` : `${W} × ${H} px`}  ·  about ${Math.max(1, Math.ceil((size * 8) / 2e6))} s at 2 Mbps`;
    infoL.textContent = `Original  ·  ${W} × ${H} px  ·  ${formatBytes(W * H * 4)} uncompressed`;
    const nodes = [];
    if (mode === 'original' || mode === '2up') nodes.push(h('figure.sfw-pane', paneCanvas('original'), h('figcaption', infoL)));
    if (mode === 'optimized' || mode === '2up') nodes.push(h('figure.sfw-pane', paneCanvas('optimized'), h('figcaption', infoR)));
    panes.replaceChildren(...nodes);
    palette.replaceChildren(...(first?.palette || []).slice(0, 256).map((p) => h('span.sfw-chip', { style: { background: `rgb(${p[0]},${p[1]},${p[2]})` } })));
    palette.hidden = !first?.palette;
  }

  // ---- dialog ----
  const settingsCol = h(
    'div.sfw-settings',
    h('fieldset.sfw-set', h('legend', 'Preset'), labeled('Preset', preset)),
    h('fieldset.sfw-set', h('legend', 'Format'), labeled('Format', format), indexedRows, jpegRows, svgRows, transRow, matteRow),
    h('fieldset.sfw-set', h('legend', 'Image Size'), labeled('Width (px)', widthIn), labeled('Height (px)', heightIn), labeled('Percent', percentIn), labeled('Anti-aliasing', aa), check(clip, 'Clip to Artboard')),
    h('fieldset.sfw-set', h('legend', 'Color Table'), palette),
    h('fieldset.sfw-set', h('legend', 'Export'), labeled('Artboard', boardSel), labeled('Slice', sliceSel), labeled('Save', exportSel), dest ? labeled('Save to', dest) : null),
  );
  const body = h(
    'div.sfw',
    h('div.sfw-main', h('div.sfw-bar', h('div.sfw-tabs', { role: 'tablist', 'aria-label': 'Preview' }, tabs), zoomSel), scroller, status),
    settingsCol,
  );

  const persist = (commitSettings) => {
    app.prefs.set('saveForWeb', { settings: defaults, percent, antialias, export: exportSel.value, dest: dest?.value || 'device' });
    if (!commitSettings) return;
    const stored = [...local].filter(([id]) => findSlice(doc, id));
    if (!stored.length && !clipTx) return;
    const write = () => {
      for (const [id, patch] of stored) updateSlice(doc, id, { export: { ...(findSlice(doc, id).export || {}), ...patch } });
    };
    if (clipTx) {
      write();
      clipTx.commit();
      clipTx = null;
    } else doc.transact('Save for Web Settings', write);
  };

  const action = await openDialog({
    title: 'Save for Web',
    className: 'sfw-dialog wide',
    body,
    onOpen: () => {
      setMode('optimized');
      load();
    },
    buttons: [
      { label: 'Preview in Browser', value: 'browser', left: true },
      { label: 'Cancel', value: null },
      { label: 'Done', value: 'done' },
      { label: 'Save', value: 'save', primary: true },
    ],
  });
  clearTimeout(timer);
  busy++;
  if (!action) {
    if (clipTx) clipTx.cancel();
    return;
  }
  // Results computed so far may be stale (debounce): finish them.
  if (action === 'browser' || action === 'save') {
    const token = ++busy;
    if (!source) await rerender();
    else await optimizeAll(token);
  }
  persist(true);
  if (action === 'done') return;
  const which = exportSel.value;
  const rows = state.rows.filter((r) => (which === 'selected' ? selection.has(r.id) || selectedSlices(editor).has(r.id) : which === 'user' ? r.kind !== 'auto' || r.id === 'whole' : true));
  if (!rows.length) {
    app.notify('No slices to save: select slices or choose All slices.', { error: true });
    return;
  }
  const files = await buildFiles(app, editor, { area: area(), rows, results, scale: scale(), base });
  if (action === 'browser') {
    previewInBrowser(files, base);
    return;
  }
  try {
    const msg = await deliverFiles(app, files, { dest: dest?.value || 'device', zip: files.length > 1, zipName: `${safeFileName(base)}.zip` });
    if (msg) app.notify(msg);
  } catch (err) {
    app.notify(err?.message || 'Could not save the files.', { error: true });
  }
}

/** Open the page (or the single image) in a new browser tab, with images as object URLs. */
function previewInBrowser(files, base) {
  const urls = new Map(files.filter((f) => !f.name.endsWith('.html')).map((f) => [f.name, URL.createObjectURL(f.blob)]));
  const page = files.find((f) => f.name.endsWith('.html'));
  const open = (url) => {
    if (!window.open(url, '_blank', 'noopener')) console.info(`The preview of ${base} was blocked by the browser.`);
  };
  if (!page) {
    const url = [...urls.values()][0];
    if (url) open(url);
    return;
  }
  page.blob.text().then((text) => {
    for (const [name, u] of urls) text = text.split(`"${name}"`).join(`"${u}"`);
    open(URL.createObjectURL(new Blob([text], { type: 'text/html' })));
  });
}

/** File > Save Selected Slices: the selected slices with their Save for Web settings, no dialog. */
export async function saveSelectedSlices(app, editor) {
  const doc = editor.doc;
  const sel = selectedSlices(editor);
  const table = sliceTable(doc);
  const rows = table.filter((r) => sel.has(r.id));
  if (!rows.length) throw new UserError('Select slices with the Slice Selection tool first.');
  const last = app.prefs.get('saveForWeb') || {};
  const defaults = { ...DEFAULT_SETTINGS, ...(last.settings || {}) };
  const percent = last.percent || 100;
  const base = String(editor.file?.name || editor.name || 'Untitled').replace(/\.(vstudio|svg|pdf)$/i, '');
  const files = [];
  app.notify('Saving slices...', { timeout: 1500 });
  for (const row of rows) {
    const s = settingsFor(row, defaults);
    const scale = percent / 100;
    const source = await renderRegion(doc, row.rect, { scale, background: null, antialias: last.antialias !== 'none' });
    const res = await optimizeSlice(app, editor, source, row.rect, row, s, scale);
    if (res.blob) files.push({ name: `${sliceFileName(doc, row, false, base)}.${fmtInfo(s.format).ext}`, blob: res.blob });
  }
  if (!files.length) throw new UserError('The selected slices have no images (No Image slices).');
  const msg = await deliverFiles(app, files, { dest: last.dest === 'puter' && canSaveToPuter(app) ? 'puter' : 'device', zip: files.length > 1, zipName: `${safeFileName(base)}-slices.zip` });
  if (msg) app.notify(msg);
}
