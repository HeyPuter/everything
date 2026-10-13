/**
 * The on-demand part of format interoperability: importers (PDF, EPS/PS,
 * DXF, rasters) for Open and Place, and the EPS, TIFF and DXF writers for
 * Export As. Loaded by index.js on first use.
 */
import { UserError } from '../../lib/errors.js';
import { h } from '../../lib/dom.js';
import { VDocument } from '../../model/document.js';
import { createGroup, createImage } from '../../model/nodes.js';
import { nodeBounds, unionRect } from '../../model/geometry.js';
import { uid } from '../../lib/ids.js';
import { withProgress } from '../io/progress.js';
import { placeImported, reportWarnings } from '../io/place.js';
import { exportRegion, renderRegion } from '../io/raster.js';
import { collectTextOutlines } from '../io/outlines.js';
import { bytesToDataUrl, imageSize, sniffMime } from '../io/image-info.js';
import { allFamilies } from '../type/fonts.js';
import { isPDF, PDFError } from './pdf/document.js';
import { loadImageCodecs } from './pdf/images.js';
import { pdfPages, pdfToDocument, pdfToNodes } from './pdf/import.js';
import { makeLayerNode } from './pdf/build.js';
import { isPostScript, interpretEPS, previewNodes } from './ps/eps.js';
import { writeEPS, dosEPS } from './ps/eps-export.js';
import { readDXF, convertDXF } from './dxf/dxf-import.js';
import { writeDXF } from './dxf/dxf-export.js';
import { UNIT_CHOICES } from './dxf/common.js';
import { listPresets, getPreset } from '../prepress/presets.js';
import { normalizeFlattener } from '../prepress/flattener-presets.js';
import { encodeTIFF } from './codec/tiff.js';
import { encodePNG } from './codec/png.js';
import { rasterToPNG as toPNG } from './codec/raster.js';
import { pdfPlaceDialog, pdfOpenDialog, pdfPasswordDialog, dxfImportDialog, TEXT_MODES } from './dialogs.js';

export { reportWarnings };

export function report(app, warnings) {
  reportWarnings(app, warnings);
}

export async function rasterToPNG(bytes) {
  return toPNG(bytes);
}

function families() {
  try {
    return allFamilies().map((f) => f.family);
  } catch {
    return ['Inter', 'Roboto', 'Open Sans', 'Lato', 'Source Serif 4', 'Roboto Mono'];
  }
}

const stem = (name) => String(name || 'Untitled').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

function friendly(err, what) {
  if (err instanceof UserError) return err;
  if (err instanceof PDFError) return new UserError(err.message);
  return new UserError(`${what} could not be read. ${err?.message || ''}`.trim());
}

/** Decode DXF bytes: UTF-8 (R2007 and later), else Windows-1252. */
function dxfText(bytes) {
  const utf = new TextDecoder('utf-8').decode(bytes);
  if (!utf.includes('�')) return utf;
  try {
    return new TextDecoder('windows-1252').decode(bytes);
  } catch {
    return utf;
  }
}

/** Encoded image assets for decoded images: [{ id, img }] -> Map. */
async function encodeAssets(images) {
  const assets = new Map();
  for (const { id, img } of images || []) {
    if (img.kind === 'jpeg') assets.set(id, { mime: 'image/jpeg', data: bytesToDataUrl(img.bytes, 'image/jpeg'), name: '' });
    else assets.set(id, { mime: 'image/png', data: bytesToDataUrl(await encodePNG(img), 'image/png'), name: '' });
  }
  return assets;
}

/** A new document from builder layers ({ layers, nodes }) with one artboard. */
function documentFrom({ layers, nodes, assets, spots = [], artboard, name, units = 'pt', warnings = [] }) {
  const doc = VDocument.create({ name, width: artboard.w, height: artboard.h, units });
  const root = doc.root;
  for (const id of root.children) doc.nodes.delete(id);
  const recs = layers.length ? layers : [{ name: 'Layer 1', ids: [] }];
  const layerIds = recs.map((rec, i) => {
    const layer = makeLayerNode(rec, i);
    doc.nodes.set(layer.id, { ...layer, children: rec.ids, parent: 'root' });
    for (const id of rec.ids) nodes.set(id, { ...nodes.get(id), parent: layer.id });
    return layer.id;
  });
  for (const [id, n] of nodes) doc.nodes.set(id, n);
  doc.nodes.set('root', { ...root, children: layerIds, artboards: [{ ...root.artboards[0], ...artboard, name: 'Artboard 1' }], swatches: [...(root.swatches || []), ...spots] });
  for (const [id, a] of assets) doc.assets.set(id, a);
  doc.repairParents();
  doc.importWarnings = warnings;
  return doc;
}

/** Builder layers as one placeable subtree (layers become named groups when there are several). */
function subtreeFrom({ layers, nodes, assets, warnings = [], spots = [] }) {
  const nonEmpty = layers.filter((l) => l.ids.length);
  let top = [];
  if (nonEmpty.length > 1) {
    for (const l of nonEmpty) {
      const g = createGroup(l.ids, { name: l.name });
      nodes.set(g.id, g);
      for (const id of l.ids) nodes.set(id, { ...nodes.get(id), parent: g.id });
      top.push(g.id);
    }
  } else top = nonEmpty.flatMap((l) => l.ids);
  if (!top.length) return { root: null, subtree: null, assets: {}, bounds: null, warnings, swatches: [] };
  let rootId = top[0];
  if (top.length > 1 || nodes.get(top[0]).type !== 'group') {
    const g = createGroup(top);
    nodes.set(g.id, g);
    for (const id of top) nodes.set(id, { ...nodes.get(id), parent: g.id });
    rootId = g.id;
  }
  const list = [];
  const visit = (id, parent) => {
    const n = nodes.get(id);
    if (!n) return;
    list.push({ ...n, parent });
    for (const c of n.children || []) visit(c, id);
  };
  visit(rootId, undefined);
  const shim = { get: (id) => nodes.get(id) };
  const out = {};
  for (const [id, a] of assets) out[id] = a;
  return { root: rootId, subtree: { root: rootId, nodes: list }, assets: out, bounds: nodeBounds(shim, nodes.get(rootId)), warnings, swatches: spots };
}

/** Swatches and pattern definitions an import brings into a document (inside its transaction). */
function addDefinitions(doc, swatches = [], patterns = []) {
  const existing = doc.root.swatches || [];
  const names = new Set(existing.filter((s) => s.spot).map((s) => s.name));
  const remap = new Map();
  const add = [];
  for (const sw of swatches) {
    const same = existing.find((s) => s.spot && s.name === sw.name);
    if (same) remap.set(sw.id, same.id);
    else if (!names.has(sw.name)) {
      add.push(sw);
      names.add(sw.name);
    }
  }
  const patch = {};
  if (add.length) patch.swatches = [...existing, ...add];
  if (patterns.length) {
    patch.patterns = [...(doc.root.patterns || []), ...patterns];
    patch.swatches = [...(patch.swatches || existing), ...patterns.map((p) => ({ id: uid('sw'), name: p.name, paint: { type: 'pattern', id: p.id } }))];
  }
  if (Object.keys(patch).length) doc.updateRoot(patch);
  return remap;
}

/** Point paints at existing spot swatches with the same ink name. */
function relinkSpots(r, remap) {
  if (!remap.size || !r.subtree) return r;
  const fix = (p) => (p && p.swatchId && remap.has(p.swatchId) ? { ...p, swatchId: remap.get(p.swatchId) } : p);
  const nodes = r.subtree.nodes.map((n) => ({ ...n, ...(n.fill ? { fill: fix(n.fill) } : {}), ...(n.stroke ? { stroke: fix(n.stroke) } : {}) }));
  return { ...r, subtree: { ...r.subtree, nodes } };
}

/**
 * The page list of a PDF, asking for the password of an encrypted file
 * (again after a wrong one). Null when the user cancels.
 */
export async function openPDFInfo(app, bytes, name) {
  try {
    return pdfPages(bytes);
  } catch (err) {
    if (!(err instanceof PDFError) || err.code !== 'password') throw err;
  }
  const attempt = (password) => {
    try {
      return pdfPages(bytes, { password });
    } catch (err) {
      if (err instanceof PDFError && err.code === 'password') return null;
      throw err;
    }
  };
  return pdfPasswordDialog(app, { name, attempt });
}

/** Load the fax codec before interpreting PostScript that uses it (the interpreter is synchronous). */
async function preparePostScript(bytes) {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4 << 20)));
  if (text.includes('CCITTFaxDecode')) await loadImageCodecs(['CCITTFaxDecode']);
}

// ---------------------------------------------------------------- place

export async function placeForeign(app, editor, file, kind, opts = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = opts.name || stem(file.name);
  if (kind === 'pdf' && !isPDF(bytes) && isPostScript(bytes)) kind = 'eps';
  if (kind === 'eps' && isPDF(bytes)) kind = 'pdf';
  let r;
  try {
    if (kind === 'pdf') {
      if (!isPDF(bytes)) throw new UserError(`${file.name || 'The file'} is not a PDF file. Files from vector editors open here only when they were saved with PDF compatibility.`);
      const info = await openPDFInfo(app, bytes, file.name || name);
      if (!info) return null;
      const fams = families();
      const choice = await pdfPlaceDialog(app, info, { name: file.name || name, families: fams });
      if (!choice) return null;
      r = await withProgress(app, 'Importing PDF', () => pdfToNodes(info.doc, { page: choice.page, crop: choice.crop, families: fams, textMode: choice.textMode }));
      if (info.pages.length > 1 && !opts.name) r.name = `${name} (page ${choice.page + 1})`;
    } else if (kind === 'eps') {
      await preparePostScript(bytes);
      r = await withProgress(app, 'Importing PostScript', async () => {
        const res = interpretEPS(bytes, { families: families() });
        const built = res.kind === 'vector' ? res : { ...previewNodes(res.image, res.bbox), warnings: res.warnings };
        const assets = await encodeAssets(built.images);
        return subtreeFrom({ layers: built.layers, nodes: built.nodes, assets, warnings: res.warnings, spots: built.spots });
      });
    } else if (kind === 'dxf') {
      const data = readDXF(dxfText(bytes));
      const probe = convertDXF(data, { unitPt: 1, families: families() });
      const choice = await dxfImportDialog(app, data, { name: file.name || name, extent: probe.bounds });
      if (!choice) return null;
      r = await withProgress(app, 'Importing DXF', async () => {
        const conv = convertDXF(data, { unitPt: choice.unitPt, families: families() });
        return subtreeFrom({ layers: conv.layers, nodes: conv.nodes, assets: new Map(), warnings: conv.warnings });
      });
    }
  } catch (err) {
    throw friendly(err, file.name || 'The file');
  }
  if (!r) return null;
  // Spot inks the document already has keep their swatch: paints are linked to it.
  const remap = new Map();
  for (const sw of r.swatches || []) {
    const same = (editor.doc.root.swatches || []).find((s) => s.spot && s.name === sw.name);
    if (same) remap.set(sw.id, same.id);
  }
  r = relinkSpots(r, remap);
  return placeImported(app, editor, r, {
    point: opts.point,
    name: r.name || name,
    select: opts.select !== false,
    onInsert: (doc) => addDefinitions(doc, (r.swatches || []).filter((s) => !remap.has(s.id)), r.patterns),
  });
}

// ---------------------------------------------------------------- open

export async function openForeign(app, bytes, { name, format }) {
  const docName = stem(name);
  if (format === 'pdf' && !isPDF(bytes) && isPostScript(bytes)) format = 'eps';
  if (format === 'eps' && isPDF(bytes)) format = 'pdf';
  try {
    if (format === 'pdf') {
      if (!isPDF(bytes)) throw new UserError(`"${name}" is not a PDF file. Files from vector editors open here only when they were saved with PDF compatibility.`);
      const info = await openPDFInfo(app, bytes, name);
      if (!info) return null;
      const fams = families();
      let pages = null;
      let textMode = app.prefs?.get('interop.pdfOpen')?.textMode || 'auto';
      if (info.pages.length > 1) {
        const choice = await pdfOpenDialog(app, info, { name, families: fams });
        if (!choice) return null;
        pages = choice.pages;
        textMode = choice.textMode;
      }
      return await withProgress(app, 'Opening PDF', (onProgress) => pdfToDocument(info.doc, { name: docName, pages, families: fams, textMode, onProgress }));
    }
    if (format === 'eps') {
      await preparePostScript(bytes);
      return await withProgress(app, 'Opening PostScript', async () => {
        const res = interpretEPS(bytes, { families: families() });
        const built = res.kind === 'vector' ? res : { ...previewNodes(res.image, res.bbox), warnings: res.warnings };
        const assets = await encodeAssets(built.images);
        return documentFrom({ layers: built.layers, nodes: built.nodes, assets, spots: built.spots, artboard: { x: 0, y: 0, w: res.bbox.w, h: res.bbox.h }, name: docName, warnings: res.warnings });
      });
    }
    if (format === 'dxf') {
      const data = readDXF(dxfText(bytes));
      const probe = convertDXF(data, { unitPt: 1, families: families() });
      const choice = await dxfImportDialog(app, data, { name, extent: probe.bounds });
      if (!choice) return null;
      return await withProgress(app, 'Opening DXF', async () => {
        const conv = convertDXF(data, { unitPt: choice.unitPt, families: families() });
        const b = conv.bounds || { x: 0, y: 0, w: 612, h: 792 };
        // Move the drawing so its extents start at the artboard's corner.
        const pad = 0;
        const dx = -b.x + pad;
        const dy = -b.y + pad;
        const moved = moveNodes(conv.nodes, dx, dy);
        const unit = UNIT_CHOICES.find((u) => u.value === choice.unit);
        return documentFrom({ layers: conv.layers, nodes: moved, assets: new Map(), artboard: { x: 0, y: 0, w: Math.max(1, b.w + 2 * pad), h: Math.max(1, b.h + 2 * pad) }, name: docName, units: unit && ['mm', 'cm', 'in', 'pt', 'px'].includes(unit.value) ? unit.value : 'pt', warnings: conv.warnings });
      });
    }
    if (format === 'raster') return await openRaster(bytes, docName);
  } catch (err) {
    throw friendly(err, `"${name}"`);
  }
  return null;
}

async function openRaster(bytes, name) {
  let png = bytes;
  let mime = sniffMime(bytes);
  let size = mime ? imageSize(bytes) : null;
  if (!mime) {
    const r = await toPNG(bytes);
    if (!r) throw new UserError('This image format is not supported.');
    png = r.bytes;
    mime = 'image/png';
    size = { width: r.width, height: r.height };
  }
  if (!size) throw new UserError('This image could not be read.');
  const id = uid('img');
  const node = createImage(id, size.width, size.height, [1, 0, 0, 1, 0, 0], { name });
  const nodes = new Map([[node.id, node]]);
  const assets = new Map([[id, { mime, data: bytesToDataUrl(png, mime), name }]]);
  return documentFrom({ layers: [{ key: 'default', name: 'Layer 1', ids: [node.id] }], nodes, assets, artboard: { x: 0, y: 0, w: size.width, h: size.height }, name, units: 'px' });
}

/** Translate converted nodes (paths, compounds' children, text and images). */
function moveNodes(nodes, dx, dy) {
  if (!dx && !dy) return nodes;
  const out = new Map();
  for (const [id, n] of nodes) {
    let m = n;
    if (n.anchors) m = { ...n, anchors: n.anchors.map((a) => ({ x: a.x + dx, y: a.y + dy, ix: a.ix + dx, iy: a.iy + dy, ox: a.ox + dx, oy: a.oy + dy })) };
    else if (n.transform && (n.type === 'text' || n.type === 'image')) m = { ...n, transform: [n.transform[0], n.transform[1], n.transform[2], n.transform[3], n.transform[4] + dx, n.transform[5] + dy] };
    out.set(id, m);
  }
  return out;
}

// ---------------------------------------------------------------- export

/** flattenSelection options for a flattener preset name ('' or 'none': keep transparency out). */
async function flattenSettings(app, doc, ids, name) {
  if (!name || name === 'none') return null;
  const v = normalizeFlattener(getPreset(app, 'flattener', name)?.values || {});
  const opts = { balance: v.balance, resolution: v.lineArtPpi, gradientResolution: v.gradientPpi, antialias: v.antialias, strokesToOutlines: v.strokesToOutlines, clipComplex: v.clipComplex };
  if (v.textToOutlines && app.textOutlines) opts.textOutlines = await collectTextOutlines(app, doc, ids || doc.root.children);
  return opts;
}

async function outlinesFor(app, doc, ids, wanted) {
  if (!wanted || !app.textOutlines) return null;
  const map = await collectTextOutlines(app, doc, ids || doc.root.children);
  return map.size ? map : null;
}

function pixelsOf(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: img.data };
}

export async function renderExport(app, key, editor, region, options = {}) {
  const doc = editor.doc;
  const { rect, ids } = exportRegion(editor, region.rects ? { rect: region.rects[0] } : region);
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) throw new UserError('There is nothing to export.');
  if (key === 'eps') {
    const outlines = await outlinesFor(app, doc, ids, options.textOutlines !== false);
    const flatten = await flattenSettings(app, doc, ids, options.flattener);
    const { text, warnings } = await writeEPS(doc, { rect, ids, level: options.level, colorMode: options.colorMode, outlines, title: options.title, flatten });
    if (warnings.length) app.notify?.([...new Set(warnings)].join(' '), { timeout: 6000 });
    if (options.preview === 'tiff') {
      try {
        const scale = Math.min(1, 512 / Math.max(rect.w, rect.h));
        const canvas = await renderRegion(doc, rect, { scale, background: '#ffffff', ids });
        const tiff = await encodeTIFF(pixelsOf(canvas), { mode: 'rgb', compression: 'none', byteOrder: 'II', ppi: 72 * scale });
        return new Blob([dosEPS(text, tiff)], { type: 'application/postscript' });
      } catch {
        /* no preview available here: plain EPS */
      }
    }
    return new Blob([text], { type: 'application/postscript' });
  }
  if (key === 'tiff') {
    const ppi = options.ppi || 300;
    const alpha = Boolean(options.alpha) && options.mode !== 'cmyk';
    const canvas = await renderRegion(doc, rect, { scale: ppi / 72, background: alpha ? null : '#ffffff', antialias: options.antialias !== false, ids });
    const bytes = await encodeTIFF(pixelsOf(canvas), { mode: options.mode, alpha, compression: options.compression, byteOrder: options.byteOrder, ppi });
    return new Blob([bytes], { type: 'image/tiff' });
  }
  if (key === 'dxf') {
    const outlines = await outlinesFor(app, doc, ids, Boolean(options.textOutlines));
    const { text, warnings } = writeDXF(doc, { rect, ids, version: options.version, unit: options.unit, curves: options.curves, fills: options.fills !== false, outlines });
    if (warnings.length) app.notify?.(warnings.join(' '), { timeout: 6000 });
    return new Blob([text], { type: 'application/dxf' });
  }
  throw new Error(`Unknown format ${key}`);
}

// ---------------------------------------------------------------- export options

const RESOLUTIONS = [
  { value: '72', label: 'Screen (72 ppi)' },
  { value: '150', label: 'Medium (150 ppi)' },
  { value: '300', label: 'High (300 ppi)' },
  { value: 'other', label: 'Other' },
];

export function exportOptions(app, key, o, { row, select, checkbox }) {
  const fields = [];
  if (key === 'eps') {
    const level = select([{ value: 3, label: 'Level 3 (smooth gradients)' }, { value: 2, label: 'Level 2 (older printers)' }], o.level);
    const color = select([{ value: 'rgb', label: 'RGB' }, { value: 'cmyk', label: 'CMYK' }], o.colorMode);
    const preview = select([{ value: 'tiff', label: 'TIFF (8-bit color)' }, { value: 'none', label: 'None' }], o.preview);
    const outl = checkbox('Convert text to outlines', o.textOutlines !== false);
    if (!app.textOutlines) {
      outl.input.checked = false;
      outl.input.disabled = true;
    }
    let presets = [];
    try {
      presets = listPresets(app, 'flattener');
    } catch {
      presets = [];
    }
    const flat = select([...presets.map((p) => ({ value: p.name, label: p.name })), { value: 'none', label: 'None (drop transparency)' }], presets.some((p) => p.name === o.flattener) ? o.flattener : presets[0]?.name || 'none');
    fields.push(
      row('PostScript', level),
      row('Color', color),
      row('Preview', preview, { help: 'Programs that cannot read PostScript show the preview image.' }),
      row('Flatten transparency', flat, { help: 'PostScript has no transparency: transparent artwork and what it overlaps become opaque shapes and images with this flattener preset.' }),
      outl.el,
    );
    return { fields, read: () => ({ level: Number(level.value), colorMode: color.value, preview: preview.value, textOutlines: outl.input.checked, flattener: flat.value }) };
  }
  if (key === 'tiff') {
    const mode = select([{ value: 'rgb', label: 'RGB' }, { value: 'cmyk', label: 'CMYK' }, { value: 'gray', label: 'Grayscale' }], o.mode);
    const preset = RESOLUTIONS.some((r) => r.value === String(o.ppi)) ? String(o.ppi) : 'other';
    const res = select(RESOLUTIONS, preset);
    const ppi = h('input', { type: 'number', min: 10, max: 2400, step: 1, value: o.ppi, 'aria-label': 'Resolution in pixels per inch' });
    const ppiRow = row('Resolution (ppi)', ppi);
    ppiRow.hidden = preset !== 'other';
    res.addEventListener('change', () => {
      ppiRow.hidden = res.value !== 'other';
      if (res.value !== 'other') ppi.value = res.value;
    });
    const aa = select([{ value: 'art', label: 'Art Optimized (Supersampling)' }, { value: 'none', label: 'None' }], o.antialias === false ? 'none' : 'art');
    const comp = select([{ value: 'lzw', label: 'LZW' }, { value: 'deflate', label: 'ZIP' }, { value: 'none', label: 'None' }], o.compression);
    const order = select([{ value: 'II', label: 'Little-endian (most computers)' }, { value: 'MM', label: 'Big-endian' }], o.byteOrder);
    const alpha = checkbox('Keep transparency', o.alpha);
    const syncAlpha = () => {
      alpha.input.disabled = mode.value === 'cmyk';
      if (mode.value === 'cmyk') alpha.input.checked = false;
    };
    mode.addEventListener('change', syncAlpha);
    syncAlpha();
    fields.push(row('Color model', mode), row('Resolution', res), ppiRow, row('Anti-aliasing', aa), row('Compression', comp), row('Byte order', order), alpha.el);
    return {
      fields,
      read: () => {
        const p = res.value === 'other' ? Number(ppi.value) : Number(res.value);
        if (!Number.isFinite(p) || p < 10 || p > 2400) throw Object.assign(new Error('Enter a resolution between 10 and 2400 ppi.'), { field: ppi });
        return { mode: mode.value, ppi: p, antialias: aa.value !== 'none', compression: comp.value, byteOrder: order.value, alpha: alpha.input.checked };
      },
    };
  }
  if (key === 'dxf') {
    const version = select([{ value: 'R2000', label: 'AutoCAD 2000 and later (AC1015)' }, { value: 'R12', label: 'Release 12 (AC1009)' }], o.version);
    const unit = select(UNIT_CHOICES.map((u) => ({ value: u.value, label: u.label })), o.unit);
    const curves = select([{ value: 'splines', label: 'Splines (exact)' }, { value: 'polylines', label: 'Polylines (flattened)' }], o.curves);
    const fills = checkbox('Export fills as solid hatches', o.fills !== false);
    const outl = checkbox('Convert text to outlines', Boolean(o.textOutlines));
    if (!app.textOutlines) {
      outl.input.checked = false;
      outl.input.disabled = true;
    }
    const sync = () => {
      const r12 = version.value === 'R12';
      curves.disabled = r12;
      fills.input.disabled = r12;
    };
    version.addEventListener('change', sync);
    sync();
    fields.push(row('Version', version), row('Units', unit, { help: 'One drawing unit in the file. Release 12 files do not record units.' }), row('Curves', curves), fills.el, outl.el);
    return { fields, read: () => ({ version: version.value, unit: unit.value, curves: curves.value, fills: fills.input.checked, textOutlines: outl.input.checked }) };
  }
  return null;
}

export { TEXT_MODES };
