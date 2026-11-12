import type { Editor } from '../editor';
import { allLayers, findLayer, type Layer, type PhotoDocument } from '../model/document';
import { layerLock } from '../model/locks';
import { clearToPixelLayer, newPixelLayer, setLayerPixels } from '../model/pixel-layer';
import { emptyGrid, gridFromImage, readMask, readRGBA, writeRect, allMask, type TileGrid } from '../model/tiles';
import { canvasRect, selectionCoverage, selectionGrid } from '../model/selection';
import type { IRect, RGBA8 } from '../imaging/types';
import { rawPixelMaskCoverage } from '../model/pixel-mask';
import { hasMask } from '../model/masks';

/** Convert document samples (8-bit bytes or float) into 8-bit RGBA. */
export function toRGBA8(samples: Uint8Array | Float32Array, width: number, height: number): RGBA8 {
  if (samples instanceof Uint8Array) return { width, height, data: new Uint8ClampedArray(samples.buffer, samples.byteOffset, samples.length) };
  const data = new Uint8ClampedArray(samples.length);
  for (let i = 0; i < samples.length; i++) data[i] = Math.round(Math.max(0, Math.min(1, samples[i])) * 255);
  return { width, height, data };
}
/** Visible composite of the current document as 8-bit RGBA (sample merged). */
export async function compositeRGBA(e: Editor, doc: PhotoDocument = e.doc): Promise<RGBA8> {
  const samples = await e.renderer.documentPixels(doc, e.assets);
  return toRGBA8(samples, doc.width, doc.height);
}
/** Pixels of one layer rendered alone at document size. */
export async function layerRGBA(e: Editor, l: Layer, doc: PhotoDocument = e.doc): Promise<RGBA8> {
  if (l.kind === 'pixel' && l.pixels) return readRGBA(e.assets.tiles, l.pixels, canvasRect(doc));
  return toRGBA8(await e.renderer.layerPixels(l, doc, e.assets), doc.width, doc.height);
}

/** Rasterize a non-pixel layer into a pixel layer, keeping its mask, opacity
 * and blend mode. Off-canvas content of transformed sources is clipped. */
export async function rasterizeLayer(e: Editor, id: string, label = 'Rasterize Layer') {
  const apply = await prepareRasterize(e, id);
  if (apply) e.command(label, apply);
}
/** Render a layer's content and return an edit that turns it into a pixel
 * layer; several prepared edits can be committed as one history step. */
export async function prepareRasterize(e: Editor, id: string): Promise<((d: PhotoDocument) => void) | undefined> {
  const l = findLayer(e.doc.layers, id);
  if (!l || l.kind === 'pixel' || l.kind === 'group' || l.kind === 'adjustment') return;
  // The layer keeps its style, so the pixels must not include the effects.
  const plain: Layer = { ...l, mask: null, maskAsset: undefined, pixelMask: undefined, maskStrokes: undefined, maskGrid: undefined, maskInverted: false, maskDisabled: false, opacity: 1, blend: 'normal', fillOpacity: 1, style: undefined };
  const image = await layerRGBA(e, plain);
  const maskGridValue = await legacyMaskToGrid(e, l);
  const grid = gridFromImage(e.assets.tiles, image);
  return (d) => {
    const target = findLayer(d.layers, id);
    if (!target) return;
    const name = target.name;
    clearToPixelLayer(target);
    setLayerPixels(target, grid, d);
    target.name = name;
    if (maskGridValue !== undefined) {
      target.mask = null;
      delete target.maskAsset;
      delete target.pixelMask;
      delete target.maskStrokes;
      target.maskGrid = maskGridValue ?? undefined;
    }
  };
}
/** Convert an imported/legacy mask into an editable document-space mask grid. */
export async function legacyMaskToGrid(e: Editor, l: Layer): Promise<TileGrid | null | undefined> {
  if (l.maskGrid) return l.maskGrid;
  if (!hasMask(l)) return undefined;
  const doc = e.doc;
  if (l.pixelMask && !l.maskStrokes?.length) {
    const samples = l.pixelMask.asset ? e.assets.coverage(l.pixelMask.asset) : undefined;
    const out = new Uint8Array(doc.width * doc.height);
    for (let y = 0; y < doc.height; y++)
      for (let x = 0; x < doc.width; x++) out[y * doc.width + x] = Math.round(rawPixelMaskCoverage(l, samples, x + 0.5, y + 0.5) * 255);
    return writeRect(e.assets.tiles, emptyGrid(1), 0, 0, { width: doc.width, height: doc.height, data: out });
  }
  // Render the mask's effect on an opaque white stand-in to recover coverage.
  const probe: Layer = { ...l, kind: 'solid', color: '#ffffff', opacity: 1, blend: 'normal', asset: undefined, vector: undefined, style: undefined, fill: undefined, transform: l.kind === 'group' ? { x: 0, y: 0, width: doc.width, height: doc.height, rotation: 0 } : l.transform, maskInverted: l.maskInverted, filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0 } };
  const pixels = await layerRGBA(e, probe);
  const out = new Uint8Array(doc.width * doc.height);
  for (let i = 0; i < out.length; i++) out[i] = pixels.data[i * 4 + 3];
  return writeRect(e.assets.tiles, emptyGrid(1), 0, 0, { width: doc.width, height: doc.height, data: out });
}

export type PixelTarget =
  | { kind: 'pixels'; layer: Layer; grid: TileGrid }
  | { kind: 'mask'; layer: Layer; grid: TileGrid }
  | { kind: 'quick-mask'; grid: TileGrid };

/** The editable raster for painting tools, rasterizing or creating as needed.
 * Painting an empty document adds a layer, a
 * selected mask receives mask paint, and embedded objects are rasterized. */
export async function pixelTarget(e: Editor, opts: { allowMask?: boolean; create?: boolean } = {}): Promise<PixelTarget | undefined> {
  const quick = e.settings.quickMask as TileGrid | undefined;
  if (quick && opts.allowMask !== false) return { kind: 'quick-mask', grid: quick };
  let l = e.layer;
  if (e.selectedIds.size > 1) {
    e.message('Select a single layer to paint on it.');
    return;
  }
  if (l && e.editingMask && opts.allowMask !== false) {
    if (layerLock(e.doc.layers, l.id, 'all')) {
      e.message('Unlock this layer to edit its mask.');
      return;
    }
    if (!l.maskGrid) {
      const converted = await legacyMaskToGrid(e, l);
      const grid = converted ?? allMask(255);
      e.command('Convert layer mask', (d) => {
        const t = findLayer(d.layers, l!.id)!;
        t.mask = null;
        delete t.maskAsset;
        delete t.pixelMask;
        delete t.maskStrokes;
        t.maskGrid = grid;
      });
      e.maskTarget = l.id;
      l = e.layer!;
    }
    return { kind: 'mask', layer: l, grid: l.maskGrid! };
  }
  if (l && l.kind === 'adjustment' && opts.allowMask !== false) {
    // Painting on an adjustment layer edits its mask (an imported mask is
    // converted first rather than replaced).
    if (layerLock(e.doc.layers, l.id, 'all')) {
      e.message('Unlock this layer to edit its mask.');
      return;
    }
    if (!l.maskGrid) {
      const grid = (await legacyMaskToGrid(e, l)) ?? allMask(255);
      e.command('Add layer mask', (d) => {
        const t = findLayer(d.layers, l!.id)!;
        t.mask = null;
        delete t.maskAsset;
        delete t.pixelMask;
        delete t.maskStrokes;
        t.maskGrid = grid;
      });
    }
    e.maskTarget = l.id;
    l = e.layer!;
    return { kind: 'mask', layer: l, grid: l.maskGrid! };
  }
  if (!l || l.kind === 'group') {
    if (opts.create === false) {
      e.message(l ? 'The target layer is a group. Select a layer inside it.' : 'Select a layer first.');
      return;
    }
    if (l?.kind === 'group') {
      e.message('The target layer is a group. Select a layer inside it.');
      return;
    }
    const nl = newPixelLayer(nextLayerName(e.doc), e.doc);
    e.command('New Layer', (d) => d.layers.push(nl));
    e.selected = nl.id;
    l = e.layer!;
  }
  if (!l.visible) {
    e.message('The target layer is hidden. Show it to paint on it.');
    return;
  }
  if (inHiddenGroup(e.doc.layers, l.id)) {
    e.message('The target layer is in a hidden group. Show the group to paint on it.');
    return;
  }
  if (l.kind !== 'pixel') {
    if (layerLock(e.doc.layers, l.id, 'all')) {
      e.message('Unlock this layer to rasterize it.');
      return;
    }
    await rasterizeLayer(e, l.id);
    l = e.layer!;
    // Adjustment layers (outside their mask) have no pixels to edit.
    if (l.kind !== 'pixel' || !l.pixels) {
      e.message('This layer has no pixels to edit. Select a pixel layer.');
      return;
    }
    e.message('Layer rasterized for pixel editing.');
  }
  if (layerLock(e.doc.layers, l.id, 'pixels')) {
    e.message('Unlock image pixels before painting.');
    return;
  }
  // Destructive edits keep the rendered result and drop the filter list (see setLayerPixels).
  if (l.liveFilters) e.message('Editing pixels rasterizes this layer’s Live Filters (undo restores them).');
  return { kind: 'pixels', layer: l, grid: l.pixels! };
}
/** True when a group containing the layer is hidden. */
function inHiddenGroup(layers: Layer[], id: string, hidden = false): boolean | undefined {
  for (const l of layers) {
    if (l.id === id) return hidden;
    const found = inHiddenGroup(l.children, id, hidden || !l.visible);
    if (found !== undefined) return found;
  }
}
export function nextLayerName(doc: PhotoDocument) {
  let n = 1;
  const names = new Set(allLayers(doc.layers).map((l) => l.name));
  while (names.has(`Layer ${n}`)) n++;
  return `Layer ${n}`;
}
/** Store a new grid for a pixel target as one history step. */
export function commitTarget(e: Editor, target: PixelTarget, grid: TileGrid, label: string) {
  if (target.kind === 'quick-mask') {
    e.settings.quickMask = grid;
    e.update();
    return;
  }
  const id = target.layer.id;
  e.command(label, (d) => {
    const l = findLayer(d.layers, id);
    if (!l) return;
    if (target.kind === 'mask') l.maskGrid = grid;
    else setLayerPixels(l, grid, d);
  });
  if (target.kind === 'mask') e.maskTarget = id;
}
/** Preview document with a target's grid replaced (no history entry). */
export function previewTarget(e: Editor, target: PixelTarget, grid: TileGrid): PhotoDocument {
  if (target.kind === 'quick-mask') {
    e.settings.quickMaskPreview = grid;
    return e.doc;
  }
  const replace = (layers: Layer[]): Layer[] =>
    layers.map((l) => {
      if (l.id === target.layer.id) {
        if (target.kind === 'mask') return { ...l, maskGrid: grid };
        const preview = { ...l };
        // Live strokes grow the grid bounds. Keep placement in document space,
        // just as on commit, so the renderer never scales the new bounds into
        // the layer's previous transform box.
        setLayerPixels(preview, grid, e.doc);
        return preview;
      }
      return l.children.length ? { ...l, children: replace(l.children) } : l;
    });
  return { ...e.doc, layers: replace(e.doc.layers) };
}
/** Apply a pixel operation to the target layer within the selection. */
export async function applyToLayer(e: Editor, label: string, op: (src: RGBA8, rect: IRect) => RGBA8 | Promise<RGBA8>) {
  const target = await pixelTarget(e, { create: false });
  if (!target) return;
  const doc = e.doc;
  const sel = selectionGrid(doc, e.assets.tiles);
  if (target.kind !== 'pixels') {
    // Masks are filtered as grayscale images.
    const rect = canvasRect(doc);
    const m = readMask(e.assets.tiles, target.grid, rect);
    const rgba = new Uint8ClampedArray(m.data.length * 4);
    for (let i = 0; i < m.data.length; i++) rgba.set([m.data[i], m.data[i], m.data[i], 255], i * 4);
    const out = await op({ width: rect.width, height: rect.height, data: rgba }, rect);
    const cover = sel ? selectionCoverage(doc, e.assets.tiles) : undefined;
    const next = new Uint8Array(m.data.length);
    for (let i = 0; i < next.length; i++) {
      const v = out.data[i * 4];
      next[i] = cover ? m.data[i] + ((v - m.data[i]) * cover.data[i]) / 255 : v;
    }
    commitTarget(e, target, writeRect(e.assets.tiles, target.grid, 0, 0, { width: rect.width, height: rect.height, data: next }), label);
    return;
  }
  const area = sel ? (doc.selection ? roundIRect(doc.selection) : canvasRect(doc)) : (target.grid.bounds ? { ...target.grid.bounds, x: target.grid.bounds.x + target.grid.x, y: target.grid.bounds.y + target.grid.y } : null);
  if (!area) {
    e.message('The layer is empty.');
    return;
  }
  const src = readRGBA(e.assets.tiles, target.grid, area);
  const out = await op(src, area);
  if (sel) {
    const cover = readMask(e.assets.tiles, sel, area);
    for (let i = 0; i < cover.data.length; i++) {
      const k = cover.data[i] / 255;
      if (k >= 1) continue;
      for (let c = 0; c < 4; c++) out.data[i * 4 + c] = src.data[i * 4 + c] + (out.data[i * 4 + c] - src.data[i * 4 + c]) * k;
    }
  }
  commitTarget(e, target, writeRect(e.assets.tiles, target.grid, area.x, area.y, out), label);
}
export function roundIRect(r: { x: number; y: number; width: number; height: number }): IRect {
  const x = Math.floor(r.x),
    y = Math.floor(r.y);
  return { x, y, width: Math.ceil(r.x + r.width) - x, height: Math.ceil(r.y + r.height) - y };
}
export function hexRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
export function rgbHex(r: number, g: number, b: number) {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
