// Immediate layer and canvas transforms: quarter turns and flips (exact
// pixel rearrangements), arbitrary canvas rotation and Transform Again.
import type { Editor } from '../../editor';
import { allLayers, findLayer, mapDocumentGeometry, type Layer, type PhotoDocument } from '../../model/document';
import { assertEditable } from '../../model/layers';
import { carryMask, setLayerPixels, setLivePixels, setPixelResampleMethod } from '../../model/pixel-layer';
import { transformVideo } from '../../model/video-layer';
import { emptyGrid, gridDocBounds, gridFromImage, readMask, readRGBA, TILE, writeRect, parseKey, type TileGrid, type TileStore } from '../../model/tiles';
import { applySelection, selectionGrid } from '../../model/selection';
import { normalizeAngle, selectionFrame } from '../../model/transform';
import { formDialog } from '../../ui/dialog';
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import { applyMat3, type Mat3 } from '../../imaging/filters/warp';
import { remapCompPositions } from '../../model/layer-comps';
import { mapMaskPoints } from '../../model/paths';
import { layerRGBA, legacyMaskToGrid } from '../pixels';
import { hasMask } from '../../model/masks';
import {
  about,
  compose,
  isAffine,
  mapQuad,
  maskFromRGBA,
  paramsFromAffine,
  quadBounds,
  rectQuad,
  rgbaFromMask,
  rotateM,
  rotatedCanvasSize,
  samplerInterp,
  scaleM,
  translate,
  type Quad,
} from './math';
import { exactPlacement, renderFrame } from './render';
import { currentSession, lastTransform, meshFromUnit, toPixelLayer } from './session';
import { effectiveFrame, instanceQuad } from '../embedded/frame-math';
import { setFrame } from '../embedded/frame';
import type { Assets } from '../../model/assets';
import type { MeshGrid } from '../../imaging/filters/mesh';
import { mapMesh } from './math';

// ----- Mask grids -----
/** Document rectangle covered by a grid's stored tiles (constant elsewhere). */
function tileExtent(grid: TileGrid): IRect | null {
  const keys = Object.keys(grid.tiles);
  if (!keys.length) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const k of keys) {
    const [tx, ty] = parseKey(k);
    x0 = Math.min(x0, tx);
    y0 = Math.min(y0, ty);
    x1 = Math.max(x1, tx);
    y1 = Math.max(y1, ty);
  }
  return { x: x0 * TILE + grid.x, y: y0 * TILE + grid.y, width: (x1 - x0 + 1) * TILE, height: (y1 - y0 + 1) * TILE };
}
function maskSourceRect(grid: TileGrid): IRect | null {
  return grid.fill ? tileExtent(grid) : gridDocBounds(grid);
}
/** Transform a 1-channel grid by a document matrix. Exact for quarter turns
 * and mirrors on whole pixels; resampled otherwise. Absent tiles keep the
 * grid's fill value (reveal-all masks stay revealed outside). */
export function transformMaskGrid(store: TileStore, grid: TileGrid, m: Mat3, method = samplerInterp('bicubic'), doc?: Pick<PhotoDocument, 'width' | 'height'>): TileGrid {
  const r = maskSourceRect(grid);
  if (!r) return grid;
  const fill = grid.fill ?? 0;
  const mask = readMask(store, grid, r);
  const exact = exactPlacement(mask as unknown as RGBA8, compose(m, translate(r.x, r.y)));
  if (exact) return writeRect(store, { ...emptyGrid(1), fill }, exact.rect.x, exact.rect.y, exact.image as unknown as Mask8);
  // Resample "distance from fill" so the transparent outside blends to fill.
  const inv = fill === 255;
  if (inv) for (let i = 0; i < mask.data.length; i++) mask.data[i] = 255 - mask.data[i];
  const out = renderFrame(rgbaFromMask(mask), r, mapQuad(m, rectQuad(r)), undefined, { method, doc });
  if (!out) return { ...emptyGrid(1), fill };
  const result = maskFromRGBA(out.image);
  if (inv) for (let i = 0; i < result.data.length; i++) result.data[i] = 255 - result.data[i];
  return writeRect(store, { ...emptyGrid(1), fill }, out.rect.x, out.rect.y, result);
}
/** Pixel grid through a matrix: exact where possible, else resampled. */
export function transformPixelGrid(store: TileStore, grid: TileGrid, m: Mat3, method = samplerInterp('bicubic'), doc?: Pick<PhotoDocument, 'width' | 'height'>): TileGrid {
  const b = gridDocBounds(grid);
  if (!b) return grid;
  const src = readRGBA(store, grid, b);
  const out = renderFrame(src, b, mapQuad(m, rectQuad(b)), undefined, { method, exact: true, doc });
  return out ? gridFromImage(store, out.image, out.rect.x, out.rect.y) : emptyGrid(4);
}
/** Layer transform (center-rotated rectangle) carried through a similarity. */
function moveTransform(l: Layer, m: Mat3) {
  const t = l.transform;
  const c = applyMat3(m, t.x + t.width / 2, t.y + t.height / 2);
  const a = (Math.atan2(m[3], m[0]) * 180) / Math.PI;
  const s = Math.hypot(m[0], m[3]);
  const width = t.width * s,
    height = t.height * s;
  l.transform = { x: c.x - width / 2, y: c.y - height / 2, width, height, rotation: normalizeAngle(t.rotation + a) };
  if (l.mask) {
    const b = quadBounds(mapQuad(m, rectQuad(l.mask)));
    l.mask = b;
  }
}
const mirrored = (m: Mat3) => m[0] * m[4] - m[1] * m[3] < 0;
/** Rotation, uniform scale and translation (possibly mirrored). */
export function isSimilarity(m: Mat3, eps = 1e-9) {
  if (!isAffine(m)) return false;
  const [a, b, , c, d] = m;
  return Math.abs(Math.abs(a) - Math.abs(d)) < eps && Math.abs(Math.abs(b) - Math.abs(c)) < eps && Math.abs(a * b + c * d) < eps;
}

type Prepared = { video?: boolean; pixels?: TileGrid; live?: { source: TileGrid; mask?: TileGrid }; mask?: TileGrid; legacyMask?: boolean; toPixel?: boolean; transform?: boolean; fitCanvas?: boolean; frame?: { quad: Quad; mesh?: MeshGrid } };
/** Precompute new pixels for every leaf layer under a document matrix.
 * Pixel layers and their masks are rearranged or resampled; embedded objects
 * keep their transform for rotations and take a frame for mirror images
 * (re-rendered from their content); type and shapes are rasterized for
 * mirror images. Groups only carry their masks. */
export async function prepareLayers(e: Editor, leaves: Layer[], m: Mat3, docAfter: Pick<PhotoDocument, 'width' | 'height'>, canvasOp: boolean) {
  const skipNonRaster = !canvasOp;
  // Rotations and uniform scales stay non-destructive in layer transforms.
  const rigid = isSimilarity(m) && !mirrored(m);
  const store = e.assets.tiles;
  const method = samplerInterp(e.settings.transformInterpolation as string);
  const out = new Map<string, Prepared>();
  const skipped: string[] = [];
  for (const l of leaves) {
    const p: Prepared = {};
    // Imported masks (PSD pixel masks) become mask grids that turn with the layer.
    const mask = l.maskGrid ?? (hasMask(l) ? await legacyMaskToGrid(e, l) : undefined);
    if (mask) p.mask = transformMaskGrid(store, mask, m, method, docAfter);
    if (mask && !l.maskGrid) p.legacyMask = true;
    if (l.kind === 'pixel') {
      if (l.pixels) p.pixels = transformPixelGrid(store, l.pixels, m, method, docAfter);
      // Every frame of a video layer follows (canvas edits carry them through
      // mapDocumentGeometry instead).
      if (l.video && !canvasOp) p.video = true;
      // Live Filters stay live: their source and filter mask move alike.
      if (l.liveSource && l.liveFilters)
        p.live = { source: transformPixelGrid(store, l.liveSource, m, method, docAfter), mask: l.liveMask && transformMaskGrid(store, l.liveMask, m, method, docAfter) };
    } else if (l.kind === 'adjustment' || l.kind === 'group') {
      // Adjustments and groups have no geometry of their own (only masks).
    } else if (l.kind === 'solid') {
      // Fill layers keep covering the whole canvas.
      if (canvasOp) p.fitCanvas = true;
      else if (rigid) p.transform = true;
    } else if (rigid) p.transform = true;
    else if (l.kind === 'image') {
      const f = effectiveFrame(l);
      p.frame = { quad: mapQuad(m, instanceQuad(l)), mesh: f?.mesh && mapMesh(m, f.mesh) };
    } else if (skipNonRaster) skipped.push(l.name);
    else {
      // Type, shapes and others: rasterize within the canvas, then rearrange.
      const plain: Layer = { ...l, opacity: 1, blend: 'normal', fillOpacity: 1, maskGrid: undefined, mask: null, maskAsset: undefined, pixelMask: undefined, maskStrokes: undefined };
      const img = await layerRGBA(e, plain);
      p.pixels = transformPixelGrid(store, gridFromImage(store, img), m, method, docAfter);
      p.toPixel = true;
    }
    out.set(l.id, p);
  }
  return { prepared: out, skipped };
}
export function applyPrepared(d: PhotoDocument, prepared: Map<string, Prepared>, m: Mat3, assets: Assets) {
  for (const l of allLayers(d.layers)) {
    const p = prepared.get(l.id);
    if (!p) continue;
    if (p.mask) l.maskGrid = p.mask;
    if (p.legacyMask) {
      l.mask = null;
      delete l.maskAsset;
      delete l.pixelMask;
      delete l.maskStrokes;
    }
    if (p.frame) setFrame(d, l, p.frame.quad, p.frame.mesh, assets);
    if (p.toPixel) toPixelLayer(l, undefined);
    // Vector mask geometry follows its rasterized mask.
    if (l.vectorMask) mapMaskPoints(l.vectorMask.mask, (x, y) => {
      const q = applyMat3(m, x, y);
      return [q.x, q.y];
    });
    if (p.video && l.video) l.video = transformVideo(l.video, m);
    if (p.pixels && p.live) setLivePixels(l, p.pixels, d, p.live.source, p.live.mask);
    else if (p.pixels) setLayerPixels(l, p.pixels, d);
    else if (p.transform) moveTransform(l, m);
    else if (p.fitCanvas) l.transform = { x: 0, y: 0, width: d.width, height: d.height, rotation: 0 };
  }
}
// Layers with content of their own: every layer but groups without a mask.
export const contentLayers = (roots: Layer[]) => allLayers(roots).filter((l) => l.kind !== 'group' || l.maskGrid || hasMask(l));

// ----- Edit > Transform: rotate and flip the selected layers -----
/** Pivot on half pixels with an integer offset between x and y, so quarter
 * turns about it map whole pixels onto whole pixels. */
export function exactPivot(cx: number, cy: number) {
  let x = Math.round(cx * 2) / 2,
    y = Math.round(cy * 2) / 2;
  if (Math.abs((x - y) % 1) > 1e-9) y += 0.5;
  return { x, y };
}
export async function turnLayers(e: Editor, op: 'rotate-180' | 'rotate-cw' | 'rotate-ccw' | 'flip-horizontal' | 'flip-vertical') {
  const s = currentSession();
  if (s) {
    if (op === 'rotate-180') s.rotateBy(180);
    else if (op === 'rotate-cw') s.rotateBy(90);
    else if (op === 'rotate-ccw') s.rotateBy(-90);
    else s.flipBy(op === 'flip-horizontal');
    return;
  }
  e.transform.apply();
  const roots = e.selectedLayers;
  if (!roots.length) {
    e.message('Select layers to transform.');
    return;
  }
  try {
    assertEditable(e.doc, roots, 'position');
  } catch (error) {
    e.message((error as Error).message);
    return;
  }
  const frame = selectionFrame(roots);
  if (!frame) {
    e.message('Select layers with content to transform.');
    return;
  }
  const c = exactPivot(frame.x + frame.width / 2, frame.y + frame.height / 2);
  const local =
    op === 'rotate-180' ? rotateM(180) : op === 'rotate-cw' ? rotateM(90) : op === 'rotate-ccw' ? rotateM(-90) : op === 'flip-horizontal' ? scaleM(-1, 1) : scaleM(1, -1);
  const m = about(local, c.x, c.y);
  const { prepared, skipped } = await prepareLayers(e, contentLayers(roots), m, e.doc, false);
  const labels = { 'rotate-180': 'Rotate 180°', 'rotate-cw': 'Rotate 90° Clockwise', 'rotate-ccw': 'Rotate 90° Counter Clockwise', 'flip-horizontal': 'Flip Horizontal', 'flip-vertical': 'Flip Vertical' };
  e.command(labels[op], (d) => applyPrepared(d, prepared, m, e.assets));
  if (skipped.length) e.message(`Rasterize type and shape layers to flip them (skipped: ${skipped.join(', ')}).`);
}

/** Rotate the selected layers by `deg` (clockwise on screen) about a
 * document point as one history step. Returns false when nothing rotated. */
export async function rotateLayers(e: Editor, label: string, deg: number, cx: number, cy: number) {
  e.transform.apply();
  currentSession()?.apply();
  const roots = e.selectedLayers;
  if (!roots.length) {
    e.message('Select layers to rotate.');
    return false;
  }
  try {
    assertEditable(e.doc, roots, 'position');
  } catch (error) {
    e.message((error as Error).message);
    return false;
  }
  const m = about(rotateM(deg), cx, cy);
  const { prepared } = await prepareLayers(e, contentLayers(roots), m, e.doc, false);
  e.command(label, (d) => applyPrepared(d, prepared, m, e.assets));
  return true;
}

// ----- Image > Image Rotation -----
/** Rotate or mirror the whole canvas; quarter turns and mirrors rearrange
 * pixels exactly, other angles enlarge the canvas and resample. */
export async function transformCanvas(e: Editor, label: string, local: Mat3, width: number, height: number) {
  const doc = e.doc;
  return transformCanvasBy(e, label, compose(translate(width / 2, height / 2), local, translate(-doc.width / 2, -doc.height / 2)), width, height);
}
/** Map every layer, mask, channel and the selection through a document
 * matrix onto a new width x height canvas (one history step). `trim` drops
 * pixels outside the new canvas. */
export async function transformCanvasBy(e: Editor, label: string, m: Mat3, width: number, height: number, opts: { trim?: boolean } = {}) {
  e.transform.apply();
  currentSession()?.apply();
  const doc = e.doc;
  const after = { width, height };
  const method = samplerInterp(e.settings.transformInterpolation as string);
  setPixelResampleMethod(method);
  const { prepared } = await prepareLayers(e, contentLayers(doc.layers), m, after, true);
  const store = e.assets.tiles;
  if (opts.trim)
    for (const p of prepared.values()) if (p.pixels) p.pixels = trimGrid(store, p.pixels, { x: 0, y: 0, width, height });
  const sel = selectionGrid(doc, store);
  const selection = sel ? transformMaskGrid(store, sel, m, method, after) : null;
  const channels = doc.channels?.map((c) => ({ ...c, grid: transformMaskGrid(store, c.grid, m, method, after) }));
  e.command(label, (d) => {
    d.width = width;
    d.height = height;
    applyPrepared(d, prepared, m, e.assets);
    if (channels) d.channels = channels;
    applySelection(d, selection);
    const map = (x: number, y: number): [number, number] => {
      const p = applyMat3(m, x, y);
      return [p.x, p.y];
    };
    mapDocumentGeometry(d, map);
    // Shapes kept in document coordinates turn with the canvas.
    for (const l of allLayers(d.layers)) if (l.kind === 'vector' && l.vector?.mask.notLink) mapMaskPoints(l.vector.mask, map);
    remapCompPositions(doc, d, map);
  });
  e.fit();
  e.update();
}
/** Keep only the pixels of a grid inside `r`. */
export function trimGrid(store: TileStore, grid: TileGrid, r: IRect): TileGrid {
  const b = gridDocBounds(grid);
  if (!b) return grid;
  if (b.x >= r.x && b.y >= r.y && b.x + b.width <= r.x + r.width && b.y + b.height <= r.y + r.height) return grid;
  return gridFromImage(store, readRGBA(store, grid, r), r.x, r.y);
}
export const rotateCanvas = (e: Editor, deg: number) => {
  const size = rotatedCanvasSize(e.doc.width, e.doc.height, deg);
  const label = deg === 180 ? 'Rotate Canvas 180°' : deg === 90 ? 'Rotate Canvas 90° Clockwise' : deg === -90 ? 'Rotate Canvas 90° Counter Clockwise' : 'Rotate Canvas';
  if (size.width > 8192 || size.height > 8192 || size.width * size.height > 24_000_000) {
    e.message('The rotated canvas would exceed 8192 pixels or 24 megapixels.');
    return;
  }
  return transformCanvas(e, label, rotateM(deg), size.width, size.height);
};
export const flipCanvas = (e: Editor, horizontal: boolean) =>
  transformCanvas(e, horizontal ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical', scaleM(horizontal ? -1 : 1, horizontal ? 1 : -1), e.doc.width, e.doc.height);
export async function arbitraryRotation(e: Editor) {
  const v = await formDialog(
    'Rotate Canvas',
    [
      { name: 'angle', label: 'Angle (°)', value: Number(e.settings.arbitraryAngle ?? 0), type: 'number', min: -359.99, max: 359.99, step: 0.01 },
      { name: 'direction', label: 'Direction', value: String(e.settings.arbitraryDirection ?? 'cw'), type: 'select', options: [['cw', 'Clockwise'], ['ccw', 'Counter Clockwise']] },
    ],
    'Rotate',
    'The canvas grows to fit the rotated image. Quarter turns are exact.',
  );
  if (!v) return;
  const angle = Number(v.angle);
  if (!Number.isFinite(angle)) return;
  e.settings.arbitraryAngle = angle;
  e.settings.arbitraryDirection = v.direction;
  await rotateCanvas(e, v.direction === 'ccw' ? -angle : angle);
}

// ----- Transform Again -----
export async function transformAgain(e: Editor) {
  const t = lastTransform();
  if (!t) {
    e.message('Transform a layer first; Transform Again repeats it.');
    return;
  }
  e.transform.apply();
  currentSession()?.apply();
  const roots = e.selectedLayers;
  if (!roots.length) {
    e.message('Select layers to transform.');
    return;
  }
  try {
    assertEditable(e.doc, roots, 'position');
  } catch (error) {
    e.message((error as Error).message);
    return;
  }
  const store = e.assets.tiles;
  const method = samplerInterp(e.settings.transformInterpolation as string);
  const affine = isAffine(t.matrix);
  const params = affine ? paramsFromAffine(t.matrix, { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0 }) : undefined;
  const similar = !!params && !t.unitMesh && Math.abs(params.skewX) < 1e-6 && Math.abs(Math.abs(params.sx) - Math.abs(params.sy)) < 1e-6 && params.sy > 0;
  const updates = new Map<string, { pixels?: TileGrid; mask?: TileGrid; vectorMask?: boolean; video?: boolean; toPixel?: boolean; transform?: boolean; frame?: { quad: Quad; mesh?: MeshGrid } }>();
  const skipped: string[] = [];
  const warpedVideo: string[] = [];
  for (const l of allLayers(roots).filter((l) => l.kind !== 'group')) {
    if (l.kind === 'adjustment' || l.kind === 'solid') continue;
    let src: RGBA8 | undefined, rect: IRect | undefined, frame: Quad | undefined;
    if (l.video && t.unitMesh) {
      warpedVideo.push(l.name);
      continue;
    }
    if (l.kind === 'pixel' && l.pixels) {
      rect = gridDocBounds(l.pixels) ?? undefined;
      if (rect) {
        src = readRGBA(store, l.pixels, rect);
        frame = rectQuad(rect);
      }
    } else if (l.kind === 'image' && (!similar || t.unitMesh)) {
      const content = { x: 0, y: 0, width: Math.max(1, Math.round(l.sourceWidth)), height: Math.max(1, Math.round(l.sourceHeight)) };
      const prior = effectiveFrame(l);
      const quad = mapQuad(t.matrix, instanceQuad(l));
      const mesh = t.unitMesh ? meshFromUnit(t.unitMesh, content, quad) : prior?.mesh && mapMesh(t.matrix, prior.mesh);
      updates.set(l.id, { frame: { quad, mesh } });
      continue;
    } else if (similar) {
      updates.set(l.id, { transform: true });
      continue;
    } else {
      skipped.push(l.name);
      continue;
    }
    if (!src || !rect || !frame) continue;
    const quad = mapQuad(t.matrix, frame);
    // A mesh is replayed relative to the frame of the source rectangle.
    const mesh = t.unitMesh ? meshFromUnit(t.unitMesh, rect, quad) : undefined;
    const render = (img: RGBA8) => renderFrame(img, rect!, quad, mesh, { method, exact: true, doc: e.doc });
    const r = render(src);
    // A linked layer mask (and vector mask) follows the pixels, as in the
    // transform being repeated.
    const mask =
      l.maskGrid && !l.maskUnlinked
        ? carryMask(store, l.maskGrid, rect, (img) => {
            const out = render(img);
            return out && { image: out.image, x: out.rect.x, y: out.rect.y };
          })
        : undefined;
    updates.set(l.id, { pixels: r ? gridFromImage(store, r.image, r.rect.x, r.rect.y) : emptyGrid(4), mask, vectorMask: !!l.vectorMask && !l.vectorMask.unlinked && !mesh, video: !!l.video });
  }
  if (warpedVideo.length) e.message(`Video layers cannot be warped (skipped: ${warpedVideo.join(', ')}); rasterize them first.`);
  if (!updates.size) {
    if (warpedVideo.length) return;
    e.message(skipped.length ? 'Rasterize type and shape layers to repeat a skew, distortion or warp.' : 'Nothing to transform.');
    return;
  }
  e.command('Transform Again', (d) => {
    for (const [id, u] of updates) {
      const l = findLayer(d.layers, id);
      if (!l) continue;
      if (u.frame) setFrame(d, l, u.frame.quad, u.frame.mesh, e.assets);
      if (u.toPixel) toPixelLayer(l, undefined);
      if (u.video && l.video) l.video = transformVideo(l.video, t.matrix);
      if (u.pixels) setLayerPixels(l, u.pixels, d);
      else if (u.transform) moveTransform(l, t.matrix);
      if (u.mask) l.maskGrid = u.mask;
      if (u.vectorMask && l.vectorMask) {
        const mask = structuredClone(l.vectorMask.mask);
        mapMaskPoints(mask, (x, y) => {
          const q = applyMat3(t.matrix, x, y);
          return [q.x, q.y];
        });
        l.vectorMask = { ...l.vectorMask, mask };
      }
    }
  });
  if (skipped.length) e.message(`Skipped type and shape layers: ${skipped.join(', ')}.`);
}
export { selectionFrameOf } from './session-state';
