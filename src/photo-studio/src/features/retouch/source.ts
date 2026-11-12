// Reading pixels for retouching (current layer or the merged image) and writing
// results back as one undo step, limited by the active selection.
import type { Editor } from '../../editor';
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import { findLayer } from '../../model/document';
import { layerLock } from '../../model/locks';
import { setLayerPixels } from '../../model/pixel-layer';
import { applySelection, canvasRect, selectionGrid } from '../../model/selection';
import { readMask, readRGBA, writeRect, type TileGrid } from '../../model/tiles';
import { commitTarget, compositeRGBA, pixelTarget, type PixelTarget } from '../pixels';
import { cropRGBA, limitToCoverage, paintOver } from './logic';

export type PixelsTarget = Extract<PixelTarget, { kind: 'pixels' }>;

/** The pixel layer a retouching tool edits, or undefined with a message. */
export async function retouchTarget(e: Editor, what: string): Promise<PixelsTarget | undefined> {
  const t = await pixelTarget(e, { allowMask: false, create: false });
  if (!t) return;
  if (t.kind !== 'pixels') {
    e.message(`${what} works on pixel layers.`);
    return;
  }
  return t;
}

// Merged-image reads go through the GPU; documents are immutable snapshots, so
// the layer stack's serialized form identifies the picture.
let composite: { key: string; img: RGBA8 } | undefined;
export function stackKey(e: Editor) {
  return `${e.doc.width}x${e.doc.height}:${JSON.stringify(e.doc.layers)}`;
}
export async function mergedImage(e: Editor): Promise<RGBA8> {
  const key = stackKey(e);
  if (composite?.key !== key) composite = { key, img: await compositeRGBA(e) };
  return composite.img;
}
/** Canvas-sized source: the merged image, or the current pixel layer. */
export async function sourceImage(e: Editor, sampleAll: boolean): Promise<RGBA8> {
  const l = e.layer;
  if (!sampleAll && l?.kind === 'pixel' && l.pixels) return readRGBA(e.assets.tiles, l.pixels, canvasRect(e.doc));
  return mergedImage(e);
}
export function sourceKey(e: Editor, sampleAll: boolean) {
  const l = e.layer;
  if (!sampleAll && l?.kind === 'pixel' && l.pixels) return `layer:${l.id}:${l.pixels.x},${l.pixels.y}:${JSON.stringify(l.pixels.tiles)}`;
  return `merged:${stackKey(e)}`;
}
/** A rectangle of the source; parts outside the canvas are transparent. */
export async function sourceRect(e: Editor, rect: IRect, sampleAll: boolean, target?: PixelsTarget): Promise<RGBA8> {
  if (!sampleAll && target) return readRGBA(e.assets.tiles, target.grid, rect);
  return cropSafe(await mergedImage(e), rect);
}
export function cropSafe(img: RGBA8, r: IRect): RGBA8 {
  if (r.x >= 0 && r.y >= 0 && r.x + r.width <= img.width && r.y + r.height <= img.height) return cropRGBA(img, r);
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = Math.max(0, -r.y); y < r.height && y + r.y < img.height; y++) {
    const x0 = Math.max(0, -r.x),
      x1 = Math.min(r.width, img.width - r.x);
    if (x1 > x0) out.set(img.data.subarray(((y + r.y) * img.width + r.x + x0) * 4, ((y + r.y) * img.width + r.x + x1) * 4), (y * r.width + x0) * 4);
  }
  return { width: r.width, height: r.height, data: out };
}
/** Canvas-sized selection coverage, or null when nothing is selected. */
export function selectionMask(e: Editor): Mask8 | null {
  const g = selectionGrid(e.doc, e.assets.tiles);
  return g ? readMask(e.assets.tiles, g, canvasRect(e.doc)) : null;
}
export function selectionCover(e: Editor, rect: IRect): Mask8 | null {
  const g = selectionGrid(e.doc, e.assets.tiles);
  return g ? readMask(e.assets.tiles, g, rect) : null;
}

/** Store a retouched rectangle. With a merged-image source the result is
 * painted over the layer where `weight` is set (the layer may be empty);
 * otherwise it replaces the layer pixels. `limit` restricts the change to the
 * active selection. */
export function writeResult(e: Editor, target: PixelsTarget, rect: IRect, before: RGBA8, after: RGBA8, label: string, opts: { sampleAll?: boolean; weight?: Mask8; limit?: boolean; selection?: TileGrid | null } = {}) {
  const cover = opts.limit === false ? null : selectionCover(e, rect);
  let out: RGBA8;
  if (opts.sampleAll && opts.weight) {
    const w = { width: opts.weight.width, height: opts.weight.height, data: new Uint8Array(opts.weight.data) };
    if (cover) for (let i = 0; i < w.data.length; i++) w.data[i] = (w.data[i] * cover.data[i]) / 255;
    out = paintOver(before, after, w);
  } else out = limitToCoverage(before, after, cover);
  // Locked transparency: the result keeps the layer's alpha.
  if (layerLock(e.doc.layers, target.layer.id, 'transparency')) {
    const o = out.data,
      b = before.data;
    for (let i = 0; i < o.length; i += 4) {
      // Pixels the result left empty have no color of their own.
      if (!o[i + 3]) for (let c = 0; c < 3; c++) o[i + c] = b[i + c];
      o[i + 3] = b[i + 3];
    }
  }
  const grid = writeRect(e.assets.tiles, target.grid, rect.x, rect.y, out);
  if (opts.selection === undefined) commitTarget(e, target, grid, label);
  else commitPixelsAndSelection(e, target, grid, opts.selection, label);
}
/** Pixels and a new selection in one undo step (Patch, Context Move). */
export function commitPixelsAndSelection(e: Editor, target: PixelsTarget, grid: TileGrid, selection: TileGrid | null, label: string) {
  const id = target.layer.id;
  e.session.lastSelection = selectionGrid(e.doc, e.assets.tiles);
  e.command(label, (d) => {
    const l = findLayer(d.layers, id);
    if (l) setLayerPixels(l, grid, d);
    applySelection(d, selection);
  });
}

export { gridSampler, imageSampler } from './samplers';
/** Data URL of an RGBA buffer (overlay previews). */
export function imageURL(img: RGBA8): string {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c.toDataURL();
}
