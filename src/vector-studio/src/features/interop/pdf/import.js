/**
 * PDF import: pages to a new document (one artboard per page) or one page
 * as a group to place, with a choice of the page box to crop to.
 *
 *   pdfPages(bytes, { password })        -> { doc, pages: [{ index, size, boxes }], title }
 *   pdfToDocument(bytes, opts)           -> VDocument (with importWarnings)
 *   pdfToNodes(bytes, opts)              -> { subtree, root, assets, bounds, warnings, swatches, patterns }
 *
 * Files saved with PDF compatibility by other vector editors (.ai) are
 * PDF files and go through the same code.
 */
import { PDFDocument, PDFError } from './document.js';
import { Interpreter } from './interpret.js';
import { Builder, makeLayerNode } from './build.js';
import { decodeImage, loadImageCodecs } from './images.js';
import { encodePNG } from '../codec/png.js';
import { VDocument } from '../../../model/document.js';
import { createGroup, createPath } from '../../../model/nodes.js';
import { nodeBounds, unionRect } from '../../../model/geometry.js';
import { multiply } from '../../../lib/matrix.js';
import { uid } from '../../../lib/ids.js';
import { bytesToDataUrl } from '../../io/image-info.js';

export { PDFError };

export const CROP_BOXES = [
  { value: 'bounding', label: 'Bounding Box (artwork)' },
  { value: 'art', label: 'Art Box' },
  { value: 'crop', label: 'Crop Box' },
  { value: 'trim', label: 'Trim Box' },
  { value: 'bleed', label: 'Bleed Box' },
  { value: 'media', label: 'Media Box' },
];

const nextTask = () => new Promise((r) => setTimeout(r, 0));

export function openPDF(bytes, opts) {
  return bytes instanceof PDFDocument ? bytes : new PDFDocument(bytes, opts);
}

/** Page list for the import dialogs. opts: { password } for encrypted files. */
export function pdfPages(bytes, opts) {
  const doc = openPDF(bytes, opts);
  return {
    doc,
    title: doc.title,
    pages: doc.pages.map((p, index) => ({ index, size: p.size('crop'), rotate: p.rotate, boxes: { media: p.mediaBox, crop: p.cropBox, bleed: p.bleedBox, trim: p.trimBox, art: p.artBox } })),
  };
}

/** Matrix from a page's user space to document space, with the box's top-left at (ox, oy). */
export function pageMatrix(page, box, ox = 0, oy = 0) {
  const W = box.w;
  const H = box.h;
  const flip = [1, 0, 0, -1, -box.x, box.y + box.h];
  const rot = { 0: [1, 0, 0, 1, 0, 0], 90: [0, 1, -1, 0, H, 0], 180: [-1, 0, 0, -1, W, H], 270: [0, -1, 1, 0, 0, W] }[page.rotate] || [1, 0, 0, 1, 0, 0];
  return multiply([1, 0, 0, 1, ox, oy], multiply(rot, flip));
}

/**
 * Decode an image whose codec was not loaded while interpreting: load it
 * and decode again (at the size the page placed it), or a gray stand-in.
 */
async function resolveDeferred(interp, img) {
  let out = null;
  try {
    await loadImageCodecs(img.codecs);
    const { stream, resources, fillRGB } = img.source;
    out = decodeImage(interp.xref, stream, resources, { fillRGB });
  } catch {
    out = null;
  }
  if (!out || (out.kind !== 'rgba' && out.kind !== 'jpeg')) {
    interp.warn('Some images could not be decoded and were replaced by gray boxes.');
    const data = new Uint8ClampedArray(img.width * img.height * 4).fill(200);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return { kind: 'rgba', width: img.width, height: img.height, data };
  }
  if (out.kind === 'rgba' && (out.width !== img.width || out.height !== img.height)) return resampleRGBA(out, img.width, img.height);
  return out;
}

function resampleRGBA(img, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / w));
      data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { kind: 'rgba', width: w, height: h, data };
}

/** Encode decoded images as PNG (or keep JPEG data) into assets. */
async function encodeImages(interp, assets) {
  for (const entry of interp.images) {
    if (entry.img.kind === 'deferred') entry.img = await resolveDeferred(interp, entry.img);
    const { id, img } = entry;
    if (img.kind === 'jpeg') assets.set(id, { mime: 'image/jpeg', data: bytesToDataUrl(img.bytes, 'image/jpeg'), name: '' });
    else if (img.kind === 'rgba') {
      const png = await encodePNG(img);
      assets.set(id, { mime: 'image/png', data: bytesToDataUrl(png, 'image/png'), name: '' });
    }
  }
}

function warningsOf(interp, doc) {
  const out = [...interp.warnings];
  if (interp.substituted?.size) out.push(`Fonts that are not available were substituted: ${[...interp.substituted].slice(0, 6).join(', ')}${interp.substituted.size > 6 ? '...' : ''}.`);
  if (interp.outlinedFonts?.size) out.push(`Text in fonts that are not available was converted to outlines: ${[...interp.outlinedFonts].slice(0, 6).join(', ')}${interp.outlinedFonts.size > 6 ? '...' : ''}.`);
  if (doc.repaired) out.unshift('The PDF was damaged and has been repaired; check the artwork.');
  return out;
}

function patternDefs(interp) {
  return interp.patterns.map(({ offset, ...def }) => def);
}

/**
 * A new document from PDF pages.
 * opts: { name, pages: [indices] (default all), families, textMode, onProgress }
 */
export async function pdfToDocument(bytes, opts = {}) {
  const pdf = openPDF(bytes);
  const indices = (opts.pages?.length ? opts.pages : pdf.pages.map((_, i) => i)).filter((i) => pdf.pages[i]);
  const builder = new Builder();
  const interp = new Interpreter(pdf, { families: opts.families, textMode: opts.textMode, builder });
  const artboards = [];
  let x = 0;
  const gap = opts.gap ?? 36;
  for (let k = 0; k < indices.length; k++) {
    const page = pdf.pages[indices[k]];
    const box = page.cropBox;
    const size = page.size('crop');
    const base = pageMatrix(page, box, x, 0);
    artboards.push({ x, y: 0, w: size.w, h: size.h, name: indices.length > 1 || pdf.pages.length > 1 ? `Page ${indices[k] + 1}` : 'Artboard 1' });
    try {
      interp.renderPage(page, base);
    } catch (err) {
      if (err instanceof PDFError) throw err;
      interp.warn(`Page ${indices[k] + 1} could not be read completely.`);
    }
    x += size.w + gap;
    opts.onProgress?.((k + 1) / (indices.length + 1));
    await nextTask();
  }
  const { layers, nodes } = builder.finish();
  const assets = new Map();
  await encodeImages(interp, assets);
  const first = artboards[0] || { w: 612, h: 792 };
  const doc = VDocument.create({ name: opts.name || pdf.title || 'Untitled', width: first.w, height: first.h, units: 'pt' });
  const root = doc.root;
  for (const id of root.children) doc.nodes.delete(id);
  const recs = layers.length ? layers : [{ name: 'Layer 1', ids: [] }];
  const layerIds = [];
  // Layers list top to bottom in the panel; the first PDF layer is drawn first (bottom).
  recs.forEach((rec, i) => {
    const layer = makeLayerNode(rec, i);
    doc.nodes.set(layer.id, { ...layer, children: rec.ids, parent: 'root' });
    for (const id of rec.ids) nodes.set(id, { ...nodes.get(id), parent: layer.id });
    layerIds.push(layer.id);
  });
  for (const [id, n] of nodes) doc.nodes.set(id, n);
  const boards = artboards.map((a, i) => ({ ...root.artboards[0], ...a, id: uid('a') }));
  const swatches = [...(root.swatches || []), ...interp.spots.values()];
  const patterns = patternDefs(interp);
  const patternSwatches = patterns.map((p) => ({ id: `sw-${p.id}`, name: p.name, paint: { type: 'pattern', id: p.id } }));
  doc.nodes.set('root', { ...root, children: layerIds, artboards: boards.length ? boards : root.artboards, swatches: [...swatches, ...patternSwatches], ...(patterns.length ? { patterns: [...(root.patterns || []), ...patterns] } : {}) });
  for (const [id, a] of assets) doc.assets.set(id, a);
  doc.repairParents();
  doc.importWarnings = warningsOf(interp, pdf);
  opts.onProgress?.(1);
  return doc;
}

/**
 * One page as a subtree to place.
 * opts: { page (index), crop: 'bounding'|'art'|'crop'|'trim'|'bleed'|'media', families, textMode }
 */
export async function pdfToNodes(bytes, opts = {}) {
  const pdf = openPDF(bytes);
  const page = pdf.pages[Math.max(0, Math.min(pdf.pages.length - 1, opts.page || 0))];
  const crop = opts.crop || 'bounding';
  const box = crop === 'bounding' ? page.cropBox : page.box(crop);
  const builder = new Builder();
  const interp = new Interpreter(pdf, { families: opts.families, textMode: opts.textMode, builder });
  const base = pageMatrix(page, box, 0, 0);
  interp.renderPage(page, base);
  const { layers, nodes } = builder.finish();
  const assets = new Map();
  await encodeImages(interp, assets);
  // Layers become named groups inside the placed group.
  let top = [];
  const nonEmpty = layers.filter((l) => l.ids.length);
  if (nonEmpty.length > 1) {
    for (const l of nonEmpty) {
      const g = createGroup(l.ids, { name: l.name, ...(l.hidden ? { hidden: true } : {}) });
      nodes.set(g.id, g);
      for (const id of l.ids) nodes.set(id, { ...nodes.get(id), parent: g.id });
      top.push(g.id);
    }
  } else top = nonEmpty.flatMap((l) => l.ids);
  const shim = { get: (id) => nodes.get(id) };
  let bounds = null;
  if (crop === 'bounding') {
    for (const id of top) bounds = unionRect(bounds, nodeBounds(shim, nodes.get(id)));
  } else {
    const size = page.size(crop);
    bounds = { x: 0, y: 0, w: size.w, h: size.h };
    let content = null;
    for (const id of top) content = unionRect(content, nodeBounds(shim, nodes.get(id)));
    const inside = content && content.x >= -0.01 && content.y >= -0.01 && content.x + content.w <= size.w + 0.01 && content.y + content.h <= size.h + 0.01;
    if (top.length && !inside) {
      const a = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
      const mask = createPath([a(0, 0), a(size.w, 0), a(size.w, size.h), a(0, size.h)], true, { fill: null, stroke: null });
      nodes.set(mask.id, mask);
      const g = createGroup([...top, mask.id], { clip: true });
      nodes.set(g.id, g);
      for (const id of [...top, mask.id]) nodes.set(id, { ...nodes.get(id), parent: g.id });
      top = [g.id];
    }
  }
  if (!top.length) return { nodes: [], root: null, subtree: null, assets: {}, bounds: null, warnings: warningsOf(interp, pdf), swatches: [], patterns: [] };
  let rootId;
  if (top.length === 1 && nodes.get(top[0]).type === 'group') rootId = top[0];
  else {
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
  const out = {};
  for (const [id, a] of assets) out[id] = a;
  return { nodes: list, root: rootId, subtree: { root: rootId, nodes: list }, assets: out, bounds, warnings: warningsOf(interp, pdf), swatches: [...interp.spots.values()], patterns: patternDefs(interp) };
}
