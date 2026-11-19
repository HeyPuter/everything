// Canvas rasterization of a text layout. This is the only part of the text
// module that needs a 2D canvas; it works with OffscreenCanvas in workers and
// on the main thread (falling back to an HTMLCanvasElement where needed).
// Fonts must already be loaded (see `prepareFonts` in fonts.ts) or the
// browser draws with a fallback face.

import { checkCancelled, type Progress, type RGBA8 } from '../types';
import { layoutText, type GlyphRun, type Measure, type Rect, type TextLayout } from './layout';
import type { AntiAlias, TextLayerData } from './model';
import { isIdentityWarp, warpImage } from './warp';

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type Canvas2D = OffscreenCanvas | HTMLCanvasElement;
// Faux italic slant, a common synthetic oblique angle.
export const FAUX_ITALIC_SKEW = Math.tan((12 * Math.PI) / 180);
// Faux bold stroke width as a fraction of the em.
export const FAUX_BOLD_STROKE = 0.035;

export function createCanvas(width: number, height: number): Canvas2D {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, width);
  c.height = Math.max(1, height);
  return c;
}
const context = (c: Canvas2D) => c.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings) as Ctx2D | null;

let sharedMeasure: Measure | undefined;
// Canvas-backed `Measure` (one shared instance, so layout's measurement cache
// survives between calls). Ascent and descent are the font's, not the ink's,
// so line heights do not jump with the letters on a line.
export function canvasMeasure(): Measure {
  return (sharedMeasure ??= makeCanvasMeasure());
}
function makeCanvasMeasure(): Measure {
  const ctx = context(createCanvas(4, 4));
  if (!ctx) throw new Error('2D canvas is unavailable for text measurement.');
  const hasKerning = 'fontKerning' in ctx;
  // ctx.font reads back normalized, so remember what was set to skip reparsing.
  let lastFont = '', lastKerning: boolean | undefined;
  return (text, font, kerning = true) => {
    if (lastFont !== font) ctx.font = lastFont = font;
    if (hasKerning && lastKerning !== kerning) ctx.fontKerning = (lastKerning = kerning) ? 'normal' : 'none';
    const m = ctx.measureText(text || ' ');
    const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? 16);
    const ascent = Number.isFinite(m.fontBoundingBoxAscent) ? m.fontBoundingBoxAscent : size * 0.8;
    const descent = Number.isFinite(m.fontBoundingBoxDescent) ? m.fontBoundingBoxDescent : size * 0.2;
    return { width: text ? m.width : 0, ascent, descent };
  };
}

export type RenderOptions = {
  scale?: number; // device pixels per document pixel (previews < 1)
  resolution?: number; // document ppi for point sizes
  measure?: Measure;
  layout?: TextLayout; // reuse a layout computed for editing
  progress?: Progress;
};
export type RenderedText = {
  image: RGBA8;
  // Document position of the image's top-left; pixel (i, j) covers
  // (x + i / scale, y + j / scale).
  x: number;
  y: number;
  scale: number;
  layout: TextLayout;
};

export function renderText(data: TextLayerData, opts: RenderOptions = {}): RenderedText {
  const scale = opts.scale ?? 1;
  const layout = opts.layout ?? layoutText(data, { measure: opts.measure ?? canvasMeasure(), resolution: opts.resolution });
  const empty = (): RenderedText => ({ image: { width: 0, height: 0, data: new Uint8ClampedArray(0) }, x: layout.bounds.x, y: layout.bounds.y, scale, layout });
  if (!layout.runs.length && !layout.decorations.length) return empty();

  // Line boxes are not ink boxes: pad generously for overhangs, faux styles
  // and swashes, then crop to the drawn pixels.
  let maxEm = 0;
  for (const r of layout.runs) maxEm = Math.max(maxEm, r.sizePx * Math.max(r.scaleX, r.scaleY));
  const pad = maxEm * 0.6 + 2;
  const bx = layout.bounds.x - pad, by = layout.bounds.y - pad;
  const bw = layout.bounds.width + pad * 2, bh = layout.bounds.height + pad * 2;
  const cw = Math.min(16384, Math.ceil(bw * scale)), ch = Math.min(16384, Math.ceil(bh * scale));
  const canvas = createCanvas(cw, ch);
  const ctx = context(canvas);
  if (!ctx) throw new Error('2D canvas is unavailable for text rendering.');
  ctx.setTransform(scale, 0, 0, scale, -bx * scale, -by * scale);
  drawLayout(ctx, layout, opts.progress);
  const img = ctx.getImageData(0, 0, cw, ch);
  let image: RGBA8 = { width: cw, height: ch, data: img.data };
  applyAntiAlias(image, data.antiAlias);
  let x = bx, y = by;
  const crop = cropToAlpha(image);
  if (!crop) return empty();
  image = crop.image;
  x += crop.x / scale;
  y += crop.y / scale;
  if (!isIdentityWarp(data.warp) && !data.path) {
    const b = layout.bounds;
    const rect: Rect = { x: (b.x - x) * scale, y: (b.y - y) * scale, width: b.width * scale, height: b.height * scale };
    const w = warpImage(image, data.warp, rect, opts.progress);
    image = w.image;
    x += w.x / scale;
    y += w.y / scale;
    // The bilinear resampling softens edges; aliased text stays aliased.
    if (data.antiAlias === 'none') applyAntiAlias(image, 'none');
  }
  return { image, x, y, scale, layout };
}

// Draws glyph runs and decorations in document coordinates (the caller sets
// the transform). Exposed so the editor can paint live text on its overlay.
export function drawLayout(ctx: Ctx2D, layout: TextLayout, progress?: Progress) {
  const hasSpacing = 'letterSpacing' in ctx;
  const hasKerning = 'fontKerning' in ctx;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (let i = 0; i < layout.runs.length; i++) {
    if ((i & 63) === 0) checkCancelled(progress);
    drawRun(ctx, layout.runs[i], hasSpacing, hasKerning);
  }
  for (const d of layout.decorations) {
    ctx.fillStyle = `rgb(${d.color[0]},${d.color[1]},${d.color[2]})`;
    if (d.points) {
      // Along a path: a stroked centerline.
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = d.thickness;
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      d.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    } else if (!d.vertical) ctx.fillRect(d.x, d.y - d.thickness / 2, d.width, d.thickness);
    else ctx.fillRect(d.x - d.thickness / 2, d.y, d.thickness, d.width);
  }
  if (hasSpacing) (ctx as { letterSpacing: string }).letterSpacing = '0px';
}

function drawRun(ctx: Ctx2D, run: GlyphRun, hasSpacing: boolean, hasKerning: boolean) {
  const st = run.style;
  const color = `rgb(${st.color[0]},${st.color[1]},${st.color[2]})`;
  ctx.save();
  ctx.font = run.font;
  if (hasKerning) ctx.fontKerning = run.kerning ? 'normal' : 'none';
  ctx.fillStyle = color;
  ctx.translate(run.x, run.y);
  if (run.angle) ctx.rotate(run.angle);
  ctx.scale(run.scaleX, run.scaleY);
  if (st.fauxItalic) ctx.transform(1, 0, -FAUX_ITALIC_SKEW, 1, 0, 0);
  const stroke = st.fauxBold;
  if (stroke) {
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    ctx.lineWidth = run.sizePx * FAUX_BOLD_STROKE;
  }
  const paint = (t: string, x: number) => {
    ctx.fillText(t, x, 0);
    if (stroke) ctx.strokeText(t, x, 0);
  };
  // One fillText keeps kerning and ligatures; per-cluster drawing is used
  // when spacing cannot be expressed (no letterSpacing support) or ligatures
  // are off (clusters drawn apart cannot join).
  const sep = st.ligatures ? '' : '‌';
  if (run.rtl) {
    // The canvas orders and shapes right-to-left text itself; the run's
    // left edge stays at x.
    ctx.direction = 'rtl';
    ctx.textAlign = 'left';
    if (hasSpacing) (ctx as { letterSpacing: string }).letterSpacing = `${run.letterSpacing}px`;
    paint(run.clusters.join(sep), 0);
  } else if (run.vertical) paint(run.text, 0);
  // Fractional Widths off: each glyph at its whole-pixel advance.
  else if (!st.wholeWidths && (hasSpacing || run.letterSpacing === 0)) {
    if (hasSpacing) (ctx as { letterSpacing: string }).letterSpacing = `${run.letterSpacing}px`;
    paint(run.clusters.join(sep), 0);
  } else {
    let x = 0;
    for (let k = 0; k < run.clusters.length; k++) {
      paint(run.clusters[k], x);
      x += run.advances[k] / run.scaleX;
    }
  }
  ctx.restore();
}

// Anti-aliasing modes reshape edge coverage with a tone curve on alpha:
// none thresholds, sharp and crisp steepen the edge, strong thickens it,
// smooth keeps the rasterizer's coverage.
const aaCurves = new Map<AntiAlias, Uint8Array>();
export function antiAliasCurve(mode: AntiAlias): Uint8Array {
  let lut = aaCurves.get(mode);
  if (lut) return lut;
  lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const a = i / 255;
    let o: number;
    switch (mode) {
      case 'none': o = a >= 0.5 ? 1 : 0; break;
      case 'sharp': o = (a - 0.5) * 1.8 + 0.5; break;
      case 'crisp': o = (a - 0.5) * 1.35 + 0.5; break;
      case 'strong': o = Math.pow(a, 0.7); break;
      default: o = a;
    }
    lut[i] = Math.round(Math.min(1, Math.max(0, o)) * 255);
  }
  aaCurves.set(mode, lut);
  return lut;
}
export function applyAntiAlias(img: RGBA8, mode: AntiAlias) {
  if (mode === 'smooth') return;
  const lut = antiAliasCurve(mode);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = lut[d[i]];
}

// Smallest sub-image containing every pixel with alpha > 0.
export function cropToAlpha(img: RGBA8): { image: RGBA8; x: number; y: number } | undefined {
  const { width: w, height: h, data: d } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    let row = y * w * 4 + 3;
    for (let x = 0; x < w; x++, row += 4)
      if (d[row]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  }
  if (x1 < 0) return undefined;
  if (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) return { image: img, x: 0, y: 0 };
  const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
  const out = new Uint8ClampedArray(cw * chh * 4);
  for (let y = 0; y < chh; y++) out.set(d.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x1 + 1) * 4), y * cw * 4);
  return { image: { width: cw, height: chh, data: out }, x: x0, y: y0 };
}
