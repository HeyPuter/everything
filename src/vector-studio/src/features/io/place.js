/**
 * Placing artwork into the active document: SVG files become a group,
 * raster images (PNG, JPEG, WebP, GIF) become image objects. Used by
 * File > Place, drag and drop, and pasting from the system clipboard.
 */
import { UserError } from '../../lib/errors.js';
import { createImage, createText } from '../../model/nodes.js';
import { transformNodes } from '../../model/geometry.js';
import { translate, scale as scaleM, multiply } from '../../lib/matrix.js';
import { uid } from '../../lib/ids.js';
import { svgToNodesAsync } from './svg-import.js';
import { withProgress } from './progress.js';
import { blobToDataUrl, imageSize, sniffMime } from './image-info.js';
import { fileImporters, imageDecoders } from './hooks.js';

export { RASTER_EXT, PLACE_ACCEPT, fileKind } from './kinds.js';
import { fileKind } from './kinds.js';

function baseName(name) {
  return String(name || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
}

/** The view center in document coordinates. */
export function viewCenter(editor) {
  const v = editor.view;
  return v.toDoc(v.width / 2, v.height / 2);
}

function targetParent(app, editor) {
  if (!editor.canDrawInTarget()) {
    const layer = editor.doc.layers().slice().reverse().find((l) => !l.locked && !l.hidden);
    if (!layer) {
      app.notify('Unlock or show a layer to place artwork.', { error: true });
      return null;
    }
    return layer.id;
  }
  return editor.targetLayer().id;
}

/** Image node data for a raster blob: { node, assetId, asset, width, height }. */
export async function imageNodeData(blob, { name = '' } = {}) {
  let bytes = new Uint8Array(await blob.arrayBuffer());
  // Formats browsers cannot show (TIFF, PSD...) are converted first.
  if (!sniffMime(bytes)) {
    for (const decode of imageDecoders) {
      const r = await decode(bytes, name || blob.name || '');
      if (r) {
        bytes = r.bytes;
        break;
      }
    }
  }
  const mime = sniffMime(bytes) || blob.type || 'image/png';
  let size = imageSize(bytes);
  const data = await blobToDataUrl(new Blob([bytes], { type: mime }));
  if (!size && typeof Image !== 'undefined') {
    const img = new Image();
    img.src = data;
    try {
      await img.decode();
      size = { width: img.naturalWidth, height: img.naturalHeight };
    } catch {
      size = null;
    }
  }
  if (!size || !size.width || !size.height) throw new UserError('This image could not be read.');
  const assetId = uid('img');
  const asset = { mime, data, name };
  const node = createImage(assetId, size.width, size.height, [1, 0, 0, 1, 0, 0], { name });
  return { node, assetId, asset, width: size.width, height: size.height };
}

/**
 * Place a raster image centered at `point` (default: view center). Images
 * larger than the active artboard are scaled down to fit it.
 */
export async function placeImage(app, editor, blob, { point, name = '', select = true } = {}) {
  const parent = targetParent(app, editor);
  if (!parent) return null;
  const { node, assetId, asset, width, height } = await imageNodeData(blob, { name: name || baseName(blob.name) });
  const doc = editor.doc;
  const p = point || viewCenter(editor);
  const board = editor.artboard();
  let s = 1;
  if (board && (width > board.w || height > board.h)) s = Math.min(board.w / width, board.h / height);
  const m = multiply(translate(p.x - (width * s) / 2, p.y - (height * s) / 2), scaleM(s));
  doc.assets.set(assetId, asset);
  const link = blob.puterPath ? { source: 'puter', path: blob.puterPath, name: blob.name || name, size: blob.size, modified: blob.lastModified || Date.now() } : null;
  let id = null;
  doc.transact('Place', () => {
    id = doc.insert({ ...node, transform: m, ...(link ? { link } : {}) }, parent).id;
  });
  if (select) editor.select([id]);
  return id;
}

/**
 * Place SVG markup as a group centered at `point`. Resolves to the new id
 * (null when nothing was placed). Large markup imports in time slices with
 * a progress pill.
 */
export async function placeSVG(app, editor, text, { point, name = '', select = true } = {}) {
  if (!targetParent(app, editor)) return null;
  const r = await withProgress(app, 'Importing SVG', (onProgress) => svgToNodesAsync(text, { onProgress }));
  return placeImported(app, editor, r, { point, name, select, empty: 'The SVG has no visible artwork.' });
}

/**
 * Insert an imported subtree ({ subtree, root, assets, bounds, warnings },
 * optionally swatches and patterns for the document) centered at `point`.
 */
export function placeImported(app, editor, r, { point, name = '', select = true, empty = 'The file has no visible artwork.', onInsert = null } = {}) {
  // The document may have closed or changed while the import ran.
  if (app.editors && !app.editors.includes(editor)) return null;
  const parent = targetParent(app, editor);
  if (!parent) return null;
  if (!r.root) {
    app.notify(empty);
    return null;
  }
  const doc = editor.doc;
  for (const [id, a] of Object.entries(r.assets)) doc.assets.set(id, a);
  const p = point || viewCenter(editor);
  let id = null;
  doc.transact('Place', () => {
    onInsert?.(doc);
    const root = { ...r.subtree.nodes[0] };
    if (name && !root.name) root.name = name;
    const placed = doc.importSubtree({ root: r.root, nodes: [root, ...r.subtree.nodes.slice(1)] }, parent);
    id = placed.id;
    const b = r.bounds;
    if (b) transformNodes(doc, [id], translate(p.x - (b.x + b.w / 2), p.y - (b.y + b.h / 2)));
  });
  if (select) editor.select([id]);
  reportWarnings(app, r.warnings);
  return id;
}

export function reportWarnings(app, warnings) {
  if (!warnings?.length) return;
  const list = [...new Set(warnings)];
  app.notify(list.length === 1 ? list[0] : `${list[0]} (${list.length - 1} more note${list.length > 2 ? 's' : ''}: ${list.slice(1).join(' ')})`, { timeout: 6000 });
}

/** Place any supported file. Returns the new node id or null. */
/** SVG markup from a File or Blob, decompressing .svgz (gzip). */
export async function svgFileText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b && typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

export async function placeFile(app, editor, file, opts = {}) {
  const kind = fileKind(file);
  try {
    if (kind === 'svg') return await placeSVG(app, editor, await svgFileText(file), { name: baseName(file.name), ...opts });
    if (kind === 'image') return await placeImage(app, editor, file, { name: baseName(file.name), ...opts });
    if (kind && fileImporters[kind]) return await fileImporters[kind].place(app, editor, file, { name: baseName(file.name), ...opts });
  } catch (err) {
    app.notify(err?.message || `Could not place ${file.name || 'the file'}.`, { error: true });
    return null;
  }
  app.notify(`${file.name || 'This file'} is not a format that can be placed. Use SVG, PDF, EPS, DXF, PNG, JPEG, WebP, GIF, TIFF, BMP or PSD.`, { error: true });
  return null;
}

/** Place plain text as point type at a point (pasting text from other apps). */
export function placeText(app, editor, text, { point } = {}) {
  const parent = targetParent(app, editor);
  if (!parent) return null;
  const doc = editor.doc;
  const p = point || viewCenter(editor);
  let id = null;
  doc.transact('Paste', () => {
    id = doc.insert(createText(String(text).replace(/\r\n?/g, '\n').slice(0, 20000), p.x, p.y), parent).id;
  });
  editor.select([id]);
  return id;
}
