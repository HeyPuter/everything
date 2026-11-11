// Rendering for embedded objects: composites of nested documents, per-layer
// pixels for stack modes and native-resolution content for warps. A private
// compositor on a detached canvas does this work so the visible canvas never
// flashes another document's size or contents.
import type { Editor } from '../../editor';
import { layer, type Layer, type PhotoDocument } from '../../model/document';
import type { Assets } from '../../model/assets';
import type { Renderer } from '../../renderer/renderer';
import { createOffscreenRenderer } from '../offscreen-renderer';
import type { RGBA8 } from '../../imaging/types';
import { toRGBA8 } from '../pixels';
import { encodePng } from '../files/png';
import { floatTo16 } from '../files/color';

let shared: Promise<Renderer> | undefined;
let users = 0;
let timer = 0;

/** Run `task` with the shared offscreen compositor (released when idle). */
export async function withRenderer<T>(e: Editor, task: (r: Renderer) => Promise<T>): Promise<T> {
  users++;
  clearTimeout(timer);
  try {
    const created = (shared ??= createOffscreenRenderer(e.engine));
    // A failed creation is not kept, so the next use tries again.
    created.catch(() => shared === created && (shared = undefined));
    return await task(await created);
  } finally {
    if (--users === 0)
      timer = window.setTimeout(() => {
        const r = shared;
        shared = undefined;
        void r?.then((x) => x.dispose()).catch(() => {});
      }, 20_000);
  }
}

export type Samples = { width: number; height: number; data: Uint8Array | Float32Array };

/** Composite of a document as stored samples (document color space). */
export function documentSamples(e: Editor, doc: PhotoDocument, assets: Assets): Promise<Samples> {
  return withRenderer(e, async (r) => ({ width: doc.width, height: doc.height, data: await r.documentPixels(doc, assets) }));
}
/** Each visible top-level layer of a document rendered alone, as 8-bit RGBA. */
export function layerSamples(e: Editor, doc: PhotoDocument, assets: Assets): Promise<Uint8ClampedArray[]> {
  return withRenderer(e, async (r) => {
    const out: Uint8ClampedArray[] = [];
    for (const l of doc.layers) {
      if (!l.visible || l.kind === 'adjustment') continue;
      out.push(toRGBA8(await r.layerPixels(l, doc, assets), doc.width, doc.height).data);
    }
    return out;
  });
}
/** An image asset at its own resolution in `doc`'s color space (8-bit). */
export function assetRGBA(e: Editor, doc: PhotoDocument, assets: Assets, asset: string, colorSpace: 'document' | 'srgb', width: number, height: number): Promise<RGBA8> {
  const plain: Layer = { ...layer('image', 'content', width, height), id: `embedded-source:${asset}`, asset, assetColorSpace: colorSpace };
  const single: PhotoDocument = { ...doc, width, height, layers: [plain], selection: null, selectionMask: null };
  return withRenderer(e, async (r) => toRGBA8(await r.layerPixels(plain, single, assets), width, height));
}

/** Store samples as an immutable image asset: PNG for 8-bit, typed rasters
 * for 16 and 32 bits per channel. */
export async function addSamples(assets: Assets, s: Samples, depth: 8 | 16 | 32): Promise<string> {
  if (s.data instanceof Float32Array && depth !== 8) {
    if (depth === 32) return assets.addRaster({ width: s.width, height: s.height, data: s.data as Float32Array<ArrayBuffer> });
    return assets.addRaster({ width: s.width, height: s.height, data: floatTo16(s.data) as Uint16Array<ArrayBuffer> });
  }
  const rgba = toRGBA8(s.data, s.width, s.height);
  return addRGBA(assets, rgba);
}
export async function addRGBA(assets: Assets, img: RGBA8): Promise<string> {
  const png = encodePng({ width: img.width, height: img.height, data: img.data, channels: 4 }, { level: 1 });
  return assets.add(new Blob([png.slice()], { type: 'image/png' }));
}
/** Crop samples to a rectangle inside them. */
export function cropSamples(s: Samples, r: { x: number; y: number; width: number; height: number }): Samples {
  const Ctor = s.data.constructor as { new (n: number): Uint8Array | Float32Array };
  const out = new Ctor(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    const from = ((r.y + y) * s.width + r.x) * 4;
    out.set(s.data.subarray(from, from + r.width * 4), y * r.width * 4);
  }
  return { width: r.width, height: r.height, data: out };
}
/** Tight bounds of the pixels with any coverage, or null when empty. */
export function alphaBounds(s: Samples) {
  let x0 = s.width,
    y0 = s.height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++)
      if (s.data[(y * s.width + x) * 4 + 3] > (s.data instanceof Float32Array ? 0.5 / 255 : 0)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
