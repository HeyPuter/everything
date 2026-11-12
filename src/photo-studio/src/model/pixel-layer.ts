import { layer, type Layer, type PhotoDocument } from './document';
import type { IRect, RGBA8 } from '../imaging/types';
import {
  emptyGrid,
  gridDocBounds,
  gridFromImage,
  gridTileIds,
  readMask,
  readRGBA,
  writeRect,
  type TileGrid,
  type TileStore,
} from './tiles';
import { allLayers } from './document';
import { mapMaskPoints } from './paths';
import { transformVideo } from './video-layer';
import type { Interp } from '../imaging/filters/sampling';
import { applyMat3, transformImage, transformedBounds } from '../imaging/filters/warp';
import { compose, exactQuarterTurn, quadBounds, rotate90, rotateM, scaleM, transformQuad, translate } from '../features/transform/math';

export function newPixelLayer(name: string, doc: Pick<PhotoDocument, 'width' | 'height'>, pixels: TileGrid = emptyGrid(4)): Layer {
  const l = layer('pixel', name, doc.width, doc.height);
  l.pixels = pixels;
  syncPixelTransform(l, doc);
  return l;
}
/** Pixel layers describe their tight content bounds through `transform`, so
 * selection handles, snapping and the Properties panel treat them like any
 * other bounded layer. Empty layers keep a canvas-sized placeholder box. */
export function syncPixelTransform(l: Layer, doc: Pick<PhotoDocument, 'width' | 'height'>) {
  const b = l.pixels ? gridDocBounds(l.pixels) : null;
  const r = b ?? { x: 0, y: 0, width: doc.width, height: doc.height };
  l.transform = { x: r.x, y: r.y, width: r.width, height: r.height, rotation: 0 };
  l.sourceWidth = r.width;
  l.sourceHeight = r.height;
}
/** Make a layer of any kind a pixel layer: drop the content of its old
 * kind (image, embedded object, shape, fill, type), so the project stays valid.
 * Its mask, style, opacity and blending are kept. */
export function clearToPixelLayer(l: Layer) {
  l.kind = 'pixel';
  delete l.asset;
  delete l.assetColorSpace;
  delete l.pinWarp;
  delete l.embed;
  delete l.vector;
  delete l.fill;
  delete l.textData;
  delete l.textFrame;
  l.text = '';
  l.strokes = [];
  l.filters = { brightness: 0, contrast: 0, saturation: 0, blur: 0 };
}
export function setLayerPixels(l: Layer, grid: TileGrid, doc: Pick<PhotoDocument, 'width' | 'height'>) {
  // Writing pixels destructively rasterizes Live Filters (the result is kept).
  dropLiveFilters(l);
  l.pixels = grid;
  syncPixelTransform(l, doc);
}
/** Store pixels that a canvas edit rearranged or resampled together with the
 * Live Filter source (and filter mask) moved the same way: the filter list is
 * kept and the cached result is re-rendered on the next filter edit. */
export function setLivePixels(l: Layer, grid: TileGrid, doc: Pick<PhotoDocument, 'width' | 'height'>, source: TileGrid, mask?: TileGrid) {
  const { liveFilters, liveMaskDisabled } = l;
  setLayerPixels(l, grid, doc);
  if (!liveFilters) return;
  l.liveSource = source;
  l.liveFilters = liveFilters;
  if (mask) l.liveMask = mask;
  if (mask && liveMaskDisabled) l.liveMaskDisabled = true;
}
export function dropLiveFilters(l: Layer) {
  delete l.liveSource;
  delete l.liveFilters;
  delete l.liveMask;
  delete l.liveMaskDisabled;
}
/** True when a pixel layer's transform only moved its content. */
export function pixelTransformKind(l: Layer): 'none' | 'translate' | 'resample' {
  const b = l.pixels ? gridDocBounds(l.pixels) : null;
  if (!b) return 'none';
  const t = l.transform;
  if (t.rotation % 360 === 0 && Math.abs(t.width - b.width) < 1e-6 && Math.abs(t.height - b.height) < 1e-6)
    return t.x === b.x && t.y === b.y ? 'none' : 'translate';
  return 'resample';
}
/** Apply a pending translation by moving the grid origin (no pixel copies).
 * Whole pixels only, as destructive layers live on the pixel grid. */
export function commitPixelTranslation(l: Layer) {
  const b = gridDocBounds(l.pixels!)!;
  const dx = Math.round(l.transform.x - b.x),
    dy = Math.round(l.transform.y - b.y);
  l.pixels = { ...l.pixels!, x: l.pixels!.x + dx, y: l.pixels!.y + dy };
  // Linked masks follow the content; unlinked masks stay in place.
  if (l.maskGrid && !l.maskUnlinked) l.maskGrid = { ...l.maskGrid, x: l.maskGrid.x + dx, y: l.maskGrid.y + dy };
  if (l.vectorMask && !l.vectorMask.unlinked && (dx || dy)) {
    const mask = structuredClone(l.vectorMask.mask);
    mapMaskPoints(mask, (x, y) => [x + dx, y + dy]);
    l.vectorMask = { ...l.vectorMask, mask };
  }
  if (l.liveSource) l.liveSource = { ...l.liveSource, x: l.liveSource.x + dx, y: l.liveSource.y + dy };
  if (l.liveMask) l.liveMask = { ...l.liveMask, x: l.liveMask.x + dx, y: l.liveMask.y + dy };
  l.transform = { ...l.transform, x: b.x + dx, y: b.y + dy };
}
// Interpolation used when pending pixel-layer transforms are baked; the
// transform options bar sets it (bicubic by default).
let resampleMethod: Interp = 'bicubic';
export function setPixelResampleMethod(method: Interp) {
  resampleMethod = method;
}
export const pixelResampleMethod = () => resampleMethod;
/** Resample a pixel layer through its pending scale/rotation into new tiles
 * aligned with the document grid. Quarter turns at unit scale that land on
 * whole pixels are exact rearrangements; anything else is resampled with the
 * current interpolation (alpha-weighted, antialiased edges). */
export function commitPixelResample(l: Layer, store: TileStore, doc: Pick<PhotoDocument, 'width' | 'height'>, method: Interp = resampleMethod) {
  const grid = l.pixels!,
    b = gridDocBounds(grid)!;
  const src = readRGBA(store, grid, b);
  const t = l.transform;
  const k = exactQuarterTurn(t, b);
  // Source pixels → document: scale to the transform size, rotate about its center.
  const m = compose(
    translate(t.x + t.width / 2, t.y + t.height / 2),
    rotateM(t.rotation),
    scaleM(t.width / b.width, t.height / b.height),
    translate(-b.width / 2, -b.height / 2),
  );
  // Bake any grid that lives in the same document space as the layer content;
  // the Live Filter source follows exactly the same transform and sampling.
  const bake = (g: TileGrid, image?: RGBA8): TileGrid => {
    const gb = gridDocBounds(g);
    if (!gb) return g;
    const img = image ?? readRGBA(store, g, gb);
    if (k !== null && gb.x === b.x && gb.y === b.y && gb.width === b.width && gb.height === b.height) {
      const q = quadBounds(transformQuad(t));
      return gridFromImage(store, rotate90(img, k), Math.round(q.x), Math.round(q.y));
    }
    const mm = compose(m, translate(gb.x - b.x, gb.y - b.y));
    const out = transformedBounds(mm, gb.width, gb.height);
    return gridFromImage(store, transformImage(img, mm, out, method), out.x, out.y);
  };
  l.pixels = bake(grid, src);
  syncPixelTransform(l, doc);
  // The cached Live Filter result was resampled above and is re-rendered on
  // the next filter edit; its source and filter mask follow the content.
  if (l.liveSource) l.liveSource = bake(l.liveSource);
  // Masks of the content (the layer mask when linked, the Live Filter mask)
  // follow it, as does a linked vector mask.
  const through = (img: RGBA8) => {
    const g = bake(gridFromImage(store, img, b.x, b.y));
    const ob = gridDocBounds(g);
    return ob ? { image: readRGBA(store, g, ob), x: ob.x, y: ob.y } : undefined;
  };
  if (l.maskGrid && !l.maskUnlinked) l.maskGrid = carryMask(store, l.maskGrid, b, through);
  if (l.liveMask) l.liveMask = carryMask(store, l.liveMask, b, through);
  // Every frame of a video layer follows the content.
  if (l.video) l.video = transformVideo(l.video, compose(m, translate(-b.x, -b.y)));
  if (l.vectorMask && !l.vectorMask.unlinked) {
    const mask = structuredClone(l.vectorMask.mask);
    mapMaskPoints(mask, (x, y) => {
      const p = applyMat3(m, x - b.x, y - b.y);
      return [p.x, p.y];
    });
    l.vectorMask = { ...l.vectorMask, mask };
  }
}
/** A mask carried through the transform of the content box `rect`: `render`
 * transforms an image of that box (exactly or resampled) and returns it with
 * its document position. Outside the transformed box the mask keeps its fill
 * (no content shows there). */
export function carryMask(store: TileStore, grid: TileGrid, rect: IRect, render: (img: RGBA8) => { image: RGBA8; x: number; y: number } | undefined): TileGrid {
  const m = readMask(store, grid, rect);
  const rgba = new Uint8ClampedArray(m.data.length * 4);
  for (let i = 0; i < m.data.length; i++) rgba.set([m.data[i], 0, 0, 255], i * 4);
  const out = render({ width: rect.width, height: rect.height, data: rgba });
  const empty = { ...emptyGrid(1), ...(grid.fill ? { fill: grid.fill } : {}) };
  if (!out) return empty;
  const fill = grid.fill ?? 0;
  const data = new Uint8Array(out.image.width * out.image.height);
  for (let i = 0; i < data.length; i++) data[i] = out.image.data[i * 4 + 3] ? out.image.data[i * 4] : fill;
  return writeRect(store, empty, out.x, out.y, { width: out.image.width, height: out.image.height, data });
}
export function resampleAffine(
  src: RGBA8,
  width: number,
  height: number,
  map: (x: number, y: number) => [number, number],
): RGBA8 {
  const out = new Uint8ClampedArray(width * height * 4);
  const { width: sw, height: sh, data } = src;
  const tap = (x: number, y: number, k: number) =>
    x < 0 || y < 0 || x >= sw || y >= sh ? 0 : data[(y * sw + x) * 4 + k];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [u, v] = map(x + 0.5, y + 0.5);
      const fx = u - 0.5,
        fy = v - 0.5;
      const ix = Math.floor(fx),
        iy = Math.floor(fy),
        ax = fx - ix,
        ay = fy - iy;
      if (ix < -1 || iy < -1 || ix >= sw || iy >= sh) continue;
      const w = [(1 - ax) * (1 - ay), ax * (1 - ay), (1 - ax) * ay, ax * ay];
      const pts = [
        [ix, iy],
        [ix + 1, iy],
        [ix, iy + 1],
        [ix + 1, iy + 1],
      ];
      let alpha = 0,
        r = 0,
        g = 0,
        b = 0;
      for (let k = 0; k < 4; k++) {
        const a = tap(pts[k][0], pts[k][1], 3) * w[k];
        alpha += a;
        r += tap(pts[k][0], pts[k][1], 0) * a;
        g += tap(pts[k][0], pts[k][1], 1) * a;
        b += tap(pts[k][0], pts[k][1], 2) * a;
      }
      if (alpha <= 0) continue;
      const o = (y * width + x) * 4;
      out[o] = r / alpha;
      out[o + 1] = g / alpha;
      out[o + 2] = b / alpha;
      out[o + 3] = alpha;
    }
  return { width, height, data: out };
}
/** Every tile ID a document refers to (layers, masks, channels, selection). */
export function documentTileIds(doc: PhotoDocument, into = new Set<string>()) {
  for (const l of allLayers(doc.layers)) {
    gridTileIds(l.pixels, into);
    gridTileIds(l.maskGrid, into);
    gridTileIds(l.liveSource, into);
    gridTileIds(l.liveMask, into);
    for (const g of Object.values(l.video?.altered ?? {})) gridTileIds(g, into);
  }
  gridTileIds(doc.selectionMask, into);
  gridTileIds(doc.quickMask, into);
  for (const c of doc.channels ?? []) gridTileIds(c.grid, into);
  for (const p of doc.patterns ?? []) gridTileIds(p.grid, into);
  return into;
}
