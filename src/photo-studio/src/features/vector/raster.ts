import type { Editor } from '../../editor';
import type { Mask8 } from '../../imaging/types';
import type { TileGrid } from '../../model/tiles';
import type { Rect } from '../../model/document';
import { emptyGrid, readMask, readRGBA, writeRect } from '../../model/tiles';
import { canvasRect, selectionGrid, selectionOutline } from '../../model/selection';
import { vectorBounds, vectorUnbounded, type VectorMask } from '../../model/vector';
import { layerLock } from '../../model/locks';
import { StrokeSession, type PaintTarget } from '../../engine/paint';
import { brushFor } from '../paint';
import { hexRgb, type PixelTarget } from '../pixels';
import { flatten, fitPath, parseSvgPath, commandsToPaths, segmentCount, type Pt, type SubPath } from './geometry';

/** Canvas-sized antialiased coverage of a path (boolean operations resolved). */
export async function maskCoverage(e: Editor, mask: VectorMask, doc = e.doc): Promise<Mask8> {
  const rect = canvasRect(doc);
  if (!mask.paths.length && !mask.fillStartsWithAllPixels && !mask.invert)
    return { width: rect.width, height: rect.height, data: new Uint8Array(rect.width * rect.height) };
  const r = await e.engine.vectorMask(mask, rect);
  return { width: rect.width, height: rect.height, data: r.coverage };
}
/** A one-channel tile grid holding a path's coverage; unbounded masks reveal
 * outside the stored area. Where the masked layer's content (`extent`) runs
 * past the canvas edge, the mask is rasterized there too (up to one canvas
 * size around it), so it stays whole when the layer moves that content onto
 * the canvas. */
export async function maskToGrid(
  e: Editor,
  mask: VectorMask,
  doc = e.doc,
  extent?: Rect | null,
): Promise<TileGrid> {
  const base = { ...emptyGrid(1), fill: vectorUnbounded(mask) ? 255 : 0 };
  const canvas = canvasRect(doc);
  let rect = canvas;
  const v = extent && mask.paths.length ? vectorBounds(mask) : null;
  // Off-canvas coverage only matters over the layer's content.
  const b = v && extent && (vectorUnbounded(mask) ? extent : intersectRects(v, extent));
  if (b) {
    const x0 = Math.max(-canvas.width, Math.min(0, Math.floor(b.x))),
      y0 = Math.max(-canvas.height, Math.min(0, Math.floor(b.y))),
      x1 = Math.min(2 * canvas.width, Math.max(canvas.width, Math.ceil(b.x + b.width))),
      y1 = Math.min(2 * canvas.height, Math.max(canvas.height, Math.ceil(b.y + b.height)));
    rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  if (rect === canvas)
    return writeRect(e.assets.tiles, base, 0, 0, await maskCoverage(e, mask, doc));
  const r = await e.engine.vectorMask(mask, rect);
  const cov = { width: rect.width, height: rect.height, data: r.coverage };
  return writeRect(e.assets.tiles, base, rect.x, rect.y, cov);
}
/** Bounding box of nonzero coverage (canvas coordinates), or null. */
function intersectRects(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y),
    r = Math.min(a.x + a.width, b.x + b.width),
    t = Math.min(a.y + a.height, b.y + b.height);
  return r > x && t > y ? { x, y, width: r - x, height: t - y } : null;
}
export function coverageBounds(m: Mask8) {
  let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1;
  for (let y = 0; y < m.height; y++) {
    const row = y * m.width;
    for (let x = 0; x < m.width; x++)
      if (m.data[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
/** Composite a solid color through a coverage mask onto a pixel target. */
export function paintCoverage(e: Editor, target: PixelTarget, cov: Mask8, rgb: [number, number, number], opacity = 1): TileGrid {
  const box = coverageBounds(cov);
  if (!box) return target.grid;
  const store = e.assets.tiles;
  if (target.kind !== 'pixels') {
    const value = Math.round(rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114);
    const m = readMask(store, target.grid, box);
    for (let y = 0; y < box.height; y++)
      for (let x = 0; x < box.width; x++) {
        const i = y * box.width + x, a = (cov.data[(y + box.y) * cov.width + x + box.x] / 255) * opacity;
        m.data[i] = Math.round(m.data[i] + (value - m.data[i]) * a);
      }
    return writeRect(store, target.grid, box.x, box.y, m);
  }
  const lockAlpha = !!layerLock(e.doc.layers, target.layer.id, 'transparency');
  const img = readRGBA(store, target.grid, box);
  const d = img.data;
  for (let y = 0; y < box.height; y++)
    for (let x = 0; x < box.width; x++) {
      const a = (cov.data[(y + box.y) * cov.width + x + box.x] / 255) * opacity;
      if (!a) continue;
      const o = (y * box.width + x) * 4, da = d[o + 3] / 255;
      if (lockAlpha) {
        for (let c = 0; c < 3; c++) d[o + c] = Math.round(d[o + c] + (rgb[c] - d[o + c]) * a);
        continue;
      }
      // Straight-alpha source-over.
      const oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++) d[o + c] = Math.round((rgb[c] * a + d[o + c] * da * (1 - a)) / oa);
      d[o + 3] = Math.round(oa * 255);
    }
  return writeRect(store, target.grid, box.x, box.y, img);
}

/** Paint along a path with a brush-like tool's current settings (one dab stream per subpath). */
export function strokeWithBrush(e: Editor, target: PixelTarget, mask: VectorMask, tool: 'brush' | 'pencil' | 'eraser', simulatePressure: boolean): TileGrid {
  const s = brushFor(tool);
  let paint: PaintTarget;
  if (target.kind !== 'pixels') {
    const [r, g, b] = hexRgb(tool === 'eraser' ? e.background : e.color);
    paint = { kind: 'mask', value: Math.round(r * 0.299 + g * 0.587 + b * 0.114) };
  } else {
    const preserveAlpha = !!layerLock(e.doc.layers, target.layer.id, 'transparency');
    paint = tool === 'eraser'
      ? { kind: 'color', rgb: hexRgb(e.background), mode: 'normal', erase: !preserveAlpha, preserveAlpha }
      : { kind: 'color', rgb: hexRgb(e.color), mode: s.mode, preserveAlpha };
  }
  let grid = target.grid;
  for (const p of mask.paths) {
    if (segmentCount(p) < 1) continue;
    const pts = flatten(p, 0.25);
    if (!p.open && pts.length) pts.push(pts[0]);
    const session = new StrokeSession(e.assets.tiles, grid, {
      tip: { ...s, hardness: tool === 'pencil' ? 1 : s.hardness },
      dynamics: simulatePressure ? { ...s.dynamics, pressureSize: true } : s.dynamics,
      opacity: s.opacity,
      flow: tool === 'pencil' ? 1 : s.flow,
      target: paint,
      selection: target.kind === 'quick-mask' ? null : selectionGrid(e.doc, e.assets.tiles),
      seed: 1,
    });
    // Simulated pressure tapers both ends of each subpath.
    let total = 0;
    const along = pts.map((q, i) => (total += i ? Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) : 0));
    pts.forEach((q, i) => {
      const t = total ? along[i] / total : 0;
      session.addPoint(q[0], q[1], simulatePressure ? Math.max(0.05, Math.sin(Math.PI * t)) : 1);
    });
    grid = session.commit();
  }
  return grid;
}

/** Trace the active selection's 50% boundary and fit smooth curves to it. */
export function selectionToPath(e: Editor, tolerance: number): VectorMask | undefined {
  const grid = selectionGrid(e.doc, e.assets.tiles);
  if (!grid) return;
  const d = selectionOutline(e.doc, e.assets.tiles, grid, 4_000_000);
  if (!d) return;
  const loops = commandsToPaths(parseSvgPath(d)).filter((p) => !p.open);
  const paths: SubPath[] = [];
  for (const loop of loops) {
    const pts: Pt[] = loop.knots.map((k) => [k.points[2], k.points[3]]);
    const fitted = fitPath(pts, tolerance, true);
    if (fitted && fitted.knots.length > 1) {
      // Holes keep their opposite winding, so one non-zero component reproduces them.
      if (paths.length) delete fitted.operation;
      paths.push(fitted);
    }
  }
  return paths.length ? { paths } : undefined;
}
/** Bounds of a path in document space, rounded outward. */
export function pathPixelBounds(mask: VectorMask) {
  const b = vectorBounds(mask);
  if (!b) return null;
  const x = Math.floor(b.x), y = Math.floor(b.y);
  return { x, y, width: Math.ceil(b.x + b.width) - x, height: Math.ceil(b.y + b.height) - y };
}
