/**
 * Raster export (PNG, JPEG, WebP) with the shared drawArtwork renderer, so
 * exports match the canvas. Large images render in tiles on
 * OffscreenCanvas and yield between tiles so the UI keeps responding.
 */
import { UserError } from '../../lib/errors.js';
import { drawArtwork, drawNode, LayerPool, imageFor } from '../../render/draw.js';
import { selectionBounds, visualBounds, rectsIntersect, inflate } from '../../model/geometry.js';
import { crc32 } from './zip.js';
import { paintHooks } from './hooks.js';

const TILE = 2048;
const MAX_SIDE = 16384;
const MAX_AREA = 16384 * 16384;

export const RASTER_TYPES = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' };

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return Object.assign(document.createElement('canvas'), { width: w, height: h });
}

const nextTask = () =>
  new Promise((r) => {
    if (globalThis.scheduler?.yield) globalThis.scheduler.yield().then(r);
    else setTimeout(r, 0);
  });

/** Wait until every image used in the rect has decoded (draw.js decodes lazily). */
export async function preloadImages(doc, rect, timeout = 8000) {
  const ids = new Set();
  doc.walk((n) => {
    if (n.type === 'image' && !n.hidden) {
      const vb = visualBounds(doc, n);
      if (!rect || (vb && rectsIntersect(vb, rect))) ids.add(n.asset);
    }
  });
  const t0 = Date.now();
  for (const id of ids) {
    if (!doc.assets.has(id)) continue;
    while (!imageFor(doc, id) && Date.now() - t0 < timeout) await new Promise((r) => setTimeout(r, 25));
  }
  try {
    // Every face the document's text uses (the type module loads them on demand).
    await paintHooks.app?.textFontsReady?.(doc);
  } catch {
    /* draw with whatever fonts are available */
  }
  try {
    await document.fonts?.ready;
  } catch {
    /* fonts API unavailable */
  }
}

/** The document rect an export covers: { rect, ids } from artboard / selection / explicit rect options. */
export function exportRegion(editor, opts = {}) {
  const doc = editor.doc;
  if (opts.rect) return { rect: opts.rect, ids: opts.ids || null };
  if (opts.selection) {
    const ids = opts.ids || editor.topSelection();
    const rect = selectionBounds(doc, ids, true);
    if (!rect) throw new UserError('Select artwork to export.');
    return { rect, ids };
  }
  const a = editor.artboard(opts.artboard ?? editor.activeArtboard);
  if (!a) throw new UserError('This document has no artboards.');
  return { rect: { x: a.x, y: a.y, w: a.w, h: a.h }, ids: opts.ids || null };
}

/** Pixel size for a rect at a scale, validated against browser canvas limits. */
export function pixelSize(rect, scale) {
  const w = Math.max(1, Math.round(rect.w * scale));
  const h = Math.max(1, Math.round(rect.h * scale));
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_AREA) {
    throw new UserError(`The image would be ${w} x ${h} pixels, which is larger than the browser can create. Choose a lower resolution.`);
  }
  return { w, h };
}

/**
 * Render a document region into a canvas.
 *   scale       pixels per document unit
 *   background  null/'transparent' or a CSS color
 *   antialias   false snaps edge alpha (hard edges; transparent backgrounds only)
 *   ids         only these roots (selection export)
 *   onProgress  (done, total) per tile
 */
export async function renderRegion(doc, rect, { scale = 1, background = null, antialias = true, ids = null, onProgress } = {}) {
  const { w, h } = pixelSize(rect, scale);
  await preloadImages(doc, rect);
  const out = makeCanvas(w, h);
  const octx = out.getContext('2d');
  const cols = Math.ceil(w / TILE);
  const rows = Math.ceil(h / TILE);
  const total = cols * rows;
  let done = 0;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const px = tx * TILE;
      const py = ty * TILE;
      const tw = Math.min(TILE, w - px);
      const th = Math.min(TILE, h - py);
      const tile = makeCanvas(tw, th);
      const ctx = tile.getContext('2d');
      const pool = new LayerPool(tw, th);
      const opaque = background && background !== 'transparent';
      if (opaque) {
        // Background first, so blend modes mix with it as they do on the canvas.
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, tw, th);
      }
      ctx.setTransform(scale, 0, 0, scale, -rect.x * scale - px, -rect.y * scale - py);
      const viewRect = inflate({ x: rect.x + px / scale, y: rect.y + py / scale, w: tw / scale, h: th / scale }, 2 / scale);
      const opts = { viewRect, outline: false, hairline: 1 / scale, scale, layerPool: pool };
      if (ids) for (const id of ids) drawNode(ctx, doc, doc.get(id), opts);
      else drawArtwork(ctx, doc, { ...opts, layerFilter: (l) => !l.template });
      if (!antialias && !opaque) hardenAlpha(ctx, tw, th);
      octx.drawImage(tile, px, py);
      done++;
      onProgress?.(done, total);
      if (total > 1) await nextTask();
    }
  }
  return out;
}

function hardenAlpha(ctx, w, h) {
  try {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
    ctx.putImageData(img, 0, 0);
  } catch {
    /* tainted canvas: keep antialiasing */
  }
}

async function canvasToBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), type, quality));
}

/** Add a pHYs chunk so PNGs carry their resolution (pixels per inch). */
export async function setPngPpi(blob, ppi) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 33 || bytes[12] !== 0x49 || bytes[13] !== 0x48) return blob; // IHDR must follow the signature
  const ppm = Math.round(ppi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // pHYs
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // meters
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const ihdrEnd = 8 + 25;
  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(bytes.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return new Blob([out], { type: 'image/png' });
}

/**
 * Editor-level raster export (the `app.exporters.raster` interface).
 *   format      'png' | 'jpeg' | 'webp'
 *   scale       resolution multiplier (1 = 72 ppi), or `ppi`
 *   artboard    artboard index (default: the active one); or selection: true; or rect
 *   background  'transparent' | 'white' | any CSS color (JPEG is always opaque)
 *   antialias   true (default) or false
 *   quality     0..1 for JPEG/WebP
 */
export async function rasterExport(editor, opts = {}) {
  const format = String(opts.format || 'png').toLowerCase();
  const type = RASTER_TYPES[format];
  if (!type) throw new Error(`Unknown image format "${format}".`);
  const scale = opts.ppi ? opts.ppi / 72 : opts.scale || 1;
  const { rect, ids } = exportRegion(editor, opts);
  let background = opts.background || 'transparent';
  if (background === 'white') background = '#ffffff';
  if (type === 'image/jpeg' && background === 'transparent') background = '#ffffff';
  const canvas = await renderRegion(editor.doc, rect, { scale, background, antialias: opts.antialias !== false, ids, onProgress: opts.onProgress });
  if (opts.colorModel === 'grayscale') toGrayscale(canvas);
  let blob = await canvasToBlob(canvas, type, opts.quality ?? (type === 'image/png' ? undefined : 0.9));
  if (blob.type && blob.type !== type) throw new UserError(`This browser cannot create ${format.toUpperCase()} images. Choose another format.`);
  if (type === 'image/png' && Math.abs(scale * 72 - 72) > 0.5) blob = await setPngPpi(blob, scale * 72);
  return blob;
}

/** Convert a canvas to gray by luminance, in place. */
function toGrayscale(canvas) {
  try {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    ctx.putImageData(img, 0, 0);
  } catch {
    // Unreadable canvas: keep the colors.
  }
}

/** Small preview canvas of a region (no image preloading; for thumbnails). */
export function thumbnail(doc, rect, maxSize = 160) {
  const s = maxSize / Math.max(rect.w, rect.h, 1);
  const w = Math.max(1, Math.round(rect.w * s));
  const h = Math.max(1, Math.round(rect.h * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(s, 0, 0, s, -rect.x * s, -rect.y * s);
  drawArtwork(ctx, doc, { viewRect: rect, outline: false, hairline: 1 / s, scale: s, layerPool: new LayerPool(w, h), layerFilter: (l) => !l.template });
  return canvas;
}
