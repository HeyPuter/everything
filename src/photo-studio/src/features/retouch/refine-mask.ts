// Layer → Layer Mask → Refine Mask Edge…: re-estimate a layer mask near its
// edge from the layer's own pixels, with the matting Select and Mask uses
// (guided filter in a band, adaptive radius, smoothing, feather, contrast and
// edge shift). Only the area around the edge is processed.
import type { Editor } from '../../editor';
import { findLayer, type Layer } from '../../model/document';
import { canvasRect } from '../../model/selection';
import { emptyGrid, readMask, writeRect } from '../../model/tiles';
import { layerLock } from '../../model/locks';
import type { Mask8, RGBA8 } from '../../imaging/types';
import { formDialog } from '../../ui/dialog';
import { layerRGBA, legacyMaskToGrid } from '../pixels';
import { heavy } from './client';
import type { RefineSettings } from './logic';

type Rect = { x: number; y: number; width: number; height: number };

/** Bounds of the mask's edge (soft pixels and value changes), grown by
 * `margin` and kept on the canvas; null when the mask is uniform. */
export function edgeBand(m: Mask8, margin: number): Rect | null {
  const { width: w, height: h, data } = m;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x,
        v = data[i];
      const edge = (v > 0 && v < 255) || (x + 1 < w && data[i + 1] !== v) || (y + 1 < h && data[i + w] !== v);
      if (!edge) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  if (x1 < 0) return null;
  const x = Math.max(0, x0 - margin),
    y = Math.max(0, y0 - margin);
  return { x, y, width: Math.min(w, x1 + 1 + margin) - x, height: Math.min(h, y1 + 1 + margin) - y };
}
const crop = <T extends Mask8 | RGBA8>(src: T, r: Rect, channels: 1 | 4): T => {
  const out = channels === 1 ? new Uint8Array(r.width * r.height) : new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    const from = ((r.y + y) * src.width + r.x) * channels;
    out.set(src.data.subarray(from, from + r.width * channels), y * r.width * channels);
  }
  return { width: r.width, height: r.height, data: out } as T;
};

export async function refineMaskEdge(e: Editor) {
  const l = e.layer;
  if (!l || l.kind === 'group' || l.kind === 'adjustment') return e.message('Select a layer with a layer mask.');
  if (layerLock(e.doc.layers, l.id, 'all')) return e.message('Unlock this layer to refine its mask.');
  const v = await formDialog('Refine Mask Edge', [
    { name: 'radius', label: 'Edge radius (px)', value: 8, type: 'number', min: 1, max: 250 },
    { name: 'adaptive', label: 'Adaptive radius (keep hard edges crisp)', value: 'yes', type: 'checkbox' },
    { name: 'smooth', label: 'Smooth', value: 0, type: 'number', min: 0, max: 100 },
    { name: 'feather', label: 'Feather (px)', value: 0, type: 'number', min: 0, max: 250 },
    { name: 'contrast', label: 'Contrast (%)', value: 0, type: 'number', min: 0, max: 100 },
    { name: 'shift', label: 'Shift edge (%)', value: 0, type: 'number', min: -100, max: 100 },
  ], 'Refine', 'The mask is re-estimated near its edge from the layer’s own pixels, so hair and soft outlines follow the image.');
  if (!v) return;
  const clamp = (k: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number(v[k]) || 0));
  const settings: RefineSettings = {
    radius: clamp('radius', 1, 250),
    adaptiveRadius: v.adaptive === 'yes',
    smooth: clamp('smooth', 0, 100),
    feather: clamp('feather', 0, 250),
    contrast: clamp('contrast', 0, 100),
    shiftEdge: clamp('shift', -100, 100),
    decontaminate: 0,
  };
  const area = canvasRect(e.doc);
  const store = e.assets.tiles;
  // The mask as it applies (an inverted mask is refined as it shows).
  const grid = l.maskGrid ?? (await legacyMaskToGrid(e, l));
  if (!grid) return e.message('This layer has no layer mask.');
  const mask = readMask(store, grid, area);
  if (l.maskGrid && l.maskInverted) for (let i = 0; i < mask.data.length; i++) mask.data[i] = 255 - mask.data[i];
  const band = edgeBand(mask, Math.ceil(settings.radius * 2 + settings.feather + 4));
  if (!band) return e.message('The mask has no edge to refine: it shows or hides the whole layer.');
  // The layer's own pixels, without its mask or effects, guide the matting.
  const plain: Layer = { ...l, mask: null, maskAsset: undefined, pixelMask: undefined, maskStrokes: undefined, maskGrid: undefined, maskInverted: false, maskDisabled: false, opacity: 1, blend: 'normal', fillOpacity: 1, style: undefined };
  const image = await layerRGBA(e, plain);
  const img = crop(image, band, 4),
    part = crop(mask, band, 1);
  const res = await heavy<{ mask: Mask8 }>(e, 'Refining mask edge', 'refine', { img, mask: part, settings, brushed: null, brushRadius: 0 });
  if (!res) return;
  for (let y = 0; y < band.height; y++) mask.data.set(res.mask.data.subarray(y * band.width, (y + 1) * band.width), (band.y + y) * area.width + band.x);
  const next = writeRect(store, emptyGrid(1), 0, 0, mask);
  const id = l.id;
  e.command('Refine Mask Edge', (d) => {
    const t = findLayer(d.layers, id);
    if (!t) return;
    t.mask = null;
    delete t.maskAsset;
    delete t.pixelMask;
    delete t.maskStrokes;
    delete t.maskInverted;
    t.maskGrid = next;
  });
  e.message('Refined the mask edge.');
}
