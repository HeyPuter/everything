// Layer → Layer Mask → Refine Mask Edge…: re-estimate a layer mask near its
// edge from the layer's own pixels, with the matting Select and Mask uses
// (guided filter in a band, adaptive radius, smoothing, feather, contrast and
// edge shift); Enhance Edge does the same in one step with automatic
// settings. Only the area around the edge is processed.
import type { Editor } from '../../editor';
import { findLayer, type Layer } from '../../model/document';
import { canvasRect } from '../../model/selection';
import { readMask, writeRect, type TileGrid, type TileStore } from '../../model/tiles';
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

/** Store a refined band (document rectangle `band`, values as the mask shows)
 * back into `grid`. Only the band changes: tiles outside it, including those
 * off the canvas, and the grid's fill stay as they were. With `inverted` the
 * grid holds the mask before inversion, so the values are inverted back. */
export function writeRefinedBand(store: TileStore, grid: TileGrid, band: Rect, refined: Mask8, inverted: boolean): TileGrid {
  const data = inverted ? refined.data.map((v) => 255 - v) : refined.data;
  return writeRect(store, grid, band.x, band.y, { width: band.width, height: band.height, data });
}

type MaskInput = { layer: Layer; grid: TileGrid; mask: Mask8; inverted: boolean; area: Rect };
/** The selected layer's mask as it applies (an inverted mask is refined as it
 * shows), or undefined after explaining why there is nothing to refine. */
async function maskInput(e: Editor, verb: string): Promise<MaskInput | undefined> {
  const l = e.layer;
  if (!l || l.kind === 'group' || l.kind === 'adjustment') return void e.message('Select a layer with a layer mask.');
  if (layerLock(e.doc.layers, l.id, 'all')) return void e.message(`Unlock this layer to ${verb} its mask.`);
  const area = canvasRect(e.doc);
  const grid = l.maskGrid ?? (await legacyMaskToGrid(e, l));
  if (!grid) return void e.message('This layer has no layer mask.');
  const mask = readMask(e.assets.tiles, grid, area);
  // A legacy mask is converted as it shows, so the result drops the flag.
  const inverted = !!(l.maskGrid && l.maskInverted);
  if (inverted) for (let i = 0; i < mask.data.length; i++) mask.data[i] = 255 - mask.data[i];
  // Checked before any work: a uniform mask has nothing to refine.
  if (!edgeBand(mask, 0)) return void e.message(`The mask has no edge to ${verb}: it shows or hides the whole layer.`);
  return { layer: l, grid, mask, inverted, area };
}
/** The layer's own pixels, without its mask or effects, which guide the matting. */
function plainLayer(l: Layer): Layer {
  return { ...l, mask: null, maskAsset: undefined, pixelMask: undefined, maskStrokes: undefined, maskGrid: undefined, maskInverted: false, maskDisabled: false, opacity: 1, blend: 'normal', fillOpacity: 1, style: undefined };
}
/** Store a refined band of the mask as one history step. */
function commitBand(e: Editor, input: MaskInput, band: Rect, refined: Mask8, label: string) {
  const { layer, grid, inverted, area } = input;
  const next = writeRefinedBand(e.assets.tiles, grid, { ...band, x: band.x + area.x, y: band.y + area.y }, refined, inverted);
  const id = layer.id;
  e.command(label, (d) => {
    const t = findLayer(d.layers, id);
    if (!t) return;
    t.mask = null;
    delete t.maskAsset;
    delete t.pixelMask;
    delete t.maskStrokes;
    if (inverted) t.maskInverted = true;
    else delete t.maskInverted;
    t.maskGrid = next;
  });
}

export async function refineMaskEdge(e: Editor) {
  const input = await maskInput(e, 'refine');
  if (!input) return;
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
  const band = edgeBand(input.mask, Math.ceil(settings.radius * 2 + settings.feather + 4))!;
  const image = await layerRGBA(e, plainLayer(input.layer));
  const img = crop(image, band, 4),
    part = crop(input.mask, band, 1);
  const res = await heavy<{ mask: Mask8 }>(e, 'Refining mask edge', 'refine', { img, mask: part, settings, brushed: null, brushRadius: 0 });
  if (!res) return;
  commitBand(e, input, band, res.mask, 'Refine Mask Edge');
  e.message('Refined the mask edge.');
}

// Context around the edge for the automatic band (at most 32 px) and the
// matting's local color estimates.
const ENHANCE_MARGIN = 72;
/** Layer → Layer Mask → Enhance Edge: refine the mask edge in one step, with
 * the band chosen automatically (in the retouching worker). */
export async function enhanceMaskEdge(e: Editor) {
  const input = await maskInput(e, 'enhance');
  if (!input) return;
  const band = edgeBand(input.mask, ENHANCE_MARGIN)!;
  const res = await heavy<{ mask: Mask8; radius: number }>(e, 'Enhancing mask edge', 'enhance-edge', async () => {
    const image = await layerRGBA(e, plainLayer(input.layer));
    return { img: crop(image, band, 4), mask: crop(input.mask, band, 1), canvas: { width: input.area.width, height: input.area.height } };
  });
  if (!res) return;
  commitBand(e, input, band, res.mask, 'Enhance Edge');
  e.message(`Enhanced the mask edge (${res.radius} px around it).`);
}
