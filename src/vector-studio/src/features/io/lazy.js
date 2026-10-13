/**
 * The on-demand part of import/export (loaded with import() on first use):
 * the SVG parser, the SVG/PDF/raster writers, the export, place and print
 * dialogs, the zip writer and the clipboard SVG. index.js keeps only the
 * commands, the app hooks and the event wiring, so first load stays small.
 */
import { UserError } from '../../lib/errors.js';
import { VDocument } from '../../model/document.js';
import { selectionBounds } from '../../model/geometry.js';
import { svgToDocumentAsync, svgToNodes, svgToNodesAsync } from './svg-import.js';
import { withProgress } from './progress.js';
import { editorSVG, exportSVG } from './svg-export.js';
import { writePDF } from './pdf.js';
import { rasterExport, renderRegion } from './raster.js';
import { collectTextOutlines, normalizeTextOutlines } from './outlines.js';
import { imageNodeData, reportWarnings, placeFile, placeSVG, placeText } from './place.js';

export { exportAsDialog, exportScreensDialog, placeCommand, placeFiles } from './dialogs.js';
export { printDialog } from './print-dialog.js';
export { pdfOptionsDialog } from './pdf-dialog.js';
export { placeFile, placeSVG, placeText, imageNodeData, reportWarnings, svgToNodes, svgToNodesAsync };

/**
 * A new document from SVG text; import notes are shown once it is on
 * screen. Large files import in time slices with a progress pill, so the
 * page stays responsive.
 */
export async function importSvgDocument(app, text, { name } = {}) {
  const docName = name ? String(name).replace(/\.svgz?$/i, '') : 'Untitled';
  const doc = await withProgress(app, 'Importing SVG', (onProgress) => svgToDocumentAsync(text, { name: docName, onProgress }));
  if (doc.importWarnings?.length) setTimeout(() => reportWarnings(app, doc.importWarnings), 300);
  return doc;
}

/** SVG artwork as a subtree (see svgToNodes), imported in time slices with progress. */
export function importSvgNodes(app, text) {
  return withProgress(app, 'Importing SVG', (onProgress) => svgToNodesAsync(text, { onProgress }));
}

/** Text outlines resolved synchronously (when the type module answers synchronously). */
function syncOutlines(app, editor, opts) {
  if (opts.textMode !== 'outlines' || opts.outlines || !app.textOutlines) return opts;
  const map = new Map();
  editor.doc.walk((n) => {
    if (n.type !== 'text' || n.hidden) return;
    try {
      const r = app.textOutlines(n, { doc: editor.doc });
      if (r && typeof r.then !== 'function') {
        const runs = normalizeTextOutlines(r, n);
        if (runs.length) map.set(n.id, runs);
      }
    } catch {
      /* keep text */
    }
  });
  return { ...opts, outlines: map };
}

export async function svg(app, editor, opts = {}) {
  let o = opts;
  if (opts.textMode === 'outlines' && !opts.outlines) {
    o = syncOutlines(app, editor, opts);
    if (!o.outlines?.size) o = { ...opts, outlines: await collectTextOutlines(app, editor.doc, editor.doc.root.children) };
  }
  return editorSVG(editor, o);
}

/**
 * opts: artboards ('all' | [indices], default: the active one), bleed,
 * textOutlines (default true when available), selection, title.
 */
export async function pdf(app, editor, opts = {}) {
  const doc = editor.doc;
  let rects;
  let ids = null;
  if (opts.selection) {
    ids = editor.topSelection();
    const b = editor.selectionBounds(true);
    if (!b) throw new UserError('Select artwork to export.');
    rects = [b];
  } else {
    const idx = opts.artboards === 'all' ? doc.artboards.map((_, i) => i) : Array.isArray(opts.artboards) ? opts.artboards : [opts.artboard ?? editor.activeArtboard];
    rects = idx.map((i) => doc.artboards[i]).filter(Boolean);
  }
  const wantOutlines = opts.textOutlines !== false && Boolean(app.textOutlines);
  const outlines = wantOutlines ? await collectTextOutlines(app, doc, ids || doc.root.children) : null;
  const { bytes } = await writePDF(doc, rects, { bleed: opts.bleed || 0, ids, outlines, outlinesWanted: wantOutlines, title: opts.title || doc.name, background: opts.background });
  return bytes;
}

export function raster(editor, opts = {}) {
  return rasterExport(editor, opts);
}

export async function thumbnail(editor, { size = 256, artboard = 0 } = {}) {
  const a = editor.doc.artboards[artboard] || editor.doc.artboards[0];
  if (!a) return null;
  const canvas = await renderRegion(editor.doc, a, { scale: size / Math.max(a.w, a.h), background: '#ffffff' });
  return canvas.convertToBlob ? canvas.convertToBlob({ type: 'image/png' }) : new Promise((r) => canvas.toBlob(r, 'image/png'));
}

/** SVG text for the internal clipboard contents (works after Cut too). */
export function clipboardSVG(data, mark) {
  const doc = VDocument.create({ width: 100, height: 100 });
  const layer = doc.layers()[0];
  const roots = [];
  for (const item of data.items || []) {
    for (const n of item.nodes) doc.nodes.set(n.id, n);
    const root = doc.nodes.get(item.root);
    doc.nodes.set(item.root, { ...root, parent: layer.id });
    roots.push(item.root);
  }
  doc.nodes.set(layer.id, { ...layer, children: roots });
  for (const [id, a] of Object.entries(data.assets || {})) doc.assets.set(id, a);
  const rect = selectionBounds(doc, roots, true) || data.bounds;
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) return null;
  return exportSVG(doc, { rect, ids: roots, precision: 3, comment: `${mark}${data.stamp}`, idPrefix: `vs${(data.stamp % 1e6).toString(36)}-` });
}

/** Open an SVG file as a new document (used when the files module is not installed). */
export async function openSVGFile(app, file) {
  const text = await file.text();
  const doc = await withProgress(app, 'Importing SVG', (onProgress) => svgToDocumentAsync(text, { name: String(file.name || 'Untitled').replace(/\.svgz?$/i, ''), onProgress }));
  app.addDocument(doc, { file: null });
  reportWarnings(app, doc.importWarnings);
  return doc;
}

/** A new document sized to an image, with the image on it. */
export async function openImageFile(app, file) {
  const { node, assetId, asset, width, height } = await imageNodeData(file, { name: file.name.replace(/\.[^.]+$/, '') });
  const editor = app.newDocument({ name: file.name.replace(/\.[^.]+$/, ''), width, height, units: 'px' });
  const doc = editor.doc;
  doc.assets.set(assetId, asset);
  doc.transact('Place', () => doc.insert(node, editor.targetLayer().id));
  doc.undoStack.length = 0;
  doc.revision = doc.savedRevision = 0;
  doc.emit('history');
  return doc;
}

