/**
 * Raster output of display lists (see core/display.js) onto a Canvas 2D
 * context, and PNG export through OffscreenCanvas or a DOM canvas.
 *
 * Paper mode (settings.paper or settings.custom set): the page is laid out
 * with computePlot and drawn at settings.dpi (default 150) pixels per inch.
 * Image mode: the drawing bounds (or settings.area) are fitted into
 * width x height pixels with a margin (settings.margin px, default 10).
 */
import { recordedBounds } from '../../core/display.js';
import {
  computePlot,
  dashArray,
  fitToSize,
  lineweightMm,
  lineweightOptions,
  pageSize,
  parseBackground,
  plotColor,
} from './plot.js';

const DEFAULT_STYLE = { rgb: [0, 0, 0], aci7: true, lw: -1, pattern: [], alpha: 1 };
/** Segments per canvas path before it is stroked and a new one started. */
const MAX_PATH_POINTS = 20000;

function isPaperMode(settings) {
  return settings.paper != null || settings.custom != null;
}

/** Pixel size of the page for paper-mode settings at settings.dpi. */
export function pagePixels(settings = {}) {
  const { w, h } = pageSize(settings);
  const pxPerMm = (settings.dpi ?? 150) / 25.4;
  return { width: Math.max(1, Math.round(w * pxPerMm)), height: Math.max(1, Math.round(h * pxPerMm)) };
}

/** Add one subpath to the context path, transformed to pixels. */
function tracePath(ctx, pts, closed, T) {
  const n = pts.length >> 1;
  if (n < 1) return 0;
  const [a, b, c, d, e, f] = T;
  const x0 = a * pts[0] + c * pts[1] + e;
  const y0 = b * pts[0] + d * pts[1] + f;
  ctx.moveTo(x0, y0);
  let moved = false;
  for (let i = 1; i < n; i++) {
    const x = pts[2 * i],
      y = pts[2 * i + 1];
    const px = a * x + c * y + e;
    const py = b * x + d * y + f;
    if (px !== x0 || py !== y0) moved = true;
    ctx.lineTo(px, py);
  }
  // Canvas drops zero-length segments, so a point needs a tiny real segment.
  if (!moved) ctx.lineTo(x0 + 0.01, y0);
  if (closed) ctx.closePath();
  return n;
}

const css = (rgb) => `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})`;

/**
 * Draw items onto a Canvas 2D context. settings: paper-mode plot settings
 * and dpi, or image-mode width/height (default ctx.canvas size), margin,
 * area; plus monochrome, background, lineweights, lineweightScale,
 * uniformWidth, lineCap ('round' default), minLinePx (default 1).
 * Image mode lineweights use settings.dpi (default 96).
 * Returns { transform, scale } (world to pixels, pixels per unit).
 */
export function renderToCanvas(ctx, items, settings = {}) {
  const bounds = recordedBounds(items);
  let T, scale, W, H, clip;
  let pxPerMm;
  if (isPaperMode(settings)) {
    const plot = computePlot(settings, bounds);
    pxPerMm = (settings.dpi ?? 150) / 25.4;
    T = plot.transformDown.map((v) => v * pxPerMm);
    scale = plot.scale * pxPerMm;
    W = plot.pageW * pxPerMm;
    H = plot.pageH * pxPerMm;
    const c = plot.clipDown;
    clip = { x: c.x * pxPerMm, y: c.y * pxPerMm, w: c.w * pxPerMm, h: c.h * pxPerMm };
  } else {
    W = settings.width ?? ctx.canvas?.width ?? 800;
    H = settings.height ?? ctx.canvas?.height ?? 600;
    pxPerMm = (settings.dpi ?? 96) / 25.4;
    const fit = fitToSize(settings.area ?? bounds, W, H, settings.margin ?? 10);
    T = fit.transform;
    scale = fit.scale;
    clip = settings.area ? { x: 0, y: 0, w: W, h: H } : null;
  }

  const bg = parseBackground(settings.background);
  const lwOpts = lineweightOptions(settings);
  const baseCap = settings.lineCap ?? 'round';
  const minPx = settings.minLinePx ?? 1;
  const cache = new WeakMap();
  const descOf = (style) => {
    let r = cache.get(style);
    if (r) return r;
    const dash = dashArray(style.pattern, scale, 0.5);
    r = {
      color: css(plotColor(style, settings, bg)),
      width: Math.max(minPx, lineweightMm(style.lw, lwOpts) * pxPerMm),
      dash: dash ? dash.array : [],
      offset: dash ? dash.offset : 0,
      cap: dash && dash.hasDot ? 'round' : baseCap,
      alpha: Math.max(0, Math.min(1, style.alpha ?? 1)),
    };
    r.key = `${r.color}|${r.width}|${r.dash.join(',')}|${r.offset}|${r.cap}|${r.alpha}`;
    cache.set(style, r);
    return r;
  };

  ctx.save();
  if (bg) {
    ctx.fillStyle = css(bg);
    ctx.fillRect(0, 0, W, H);
  }
  if (clip) {
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
  }
  ctx.lineJoin = 'round';

  let openKey = '';
  let points = 0;
  const strokeOpen = () => {
    if (openKey) ctx.stroke();
    openKey = '';
    points = 0;
  };

  for (const it of items) {
    const ds = descOf(it.style ?? DEFAULT_STYLE);
    if (it.kind === 'line') {
      if (!it.pts || it.pts.length < 2) continue;
      if (openKey !== ds.key || points > MAX_PATH_POINTS) {
        strokeOpen();
        ctx.strokeStyle = ds.color;
        ctx.lineWidth = ds.width;
        ctx.lineCap = ds.cap;
        ctx.globalAlpha = ds.alpha;
        ctx.setLineDash(ds.dash);
        ctx.lineDashOffset = ds.offset;
        ctx.beginPath();
        openKey = ds.key;
      }
      points += tracePath(ctx, it.pts, it.closed, T);
    } else if (it.kind === 'fill') {
      if (!it.rings || !it.rings.length) continue;
      strokeOpen();
      ctx.fillStyle = ds.color;
      ctx.globalAlpha = ds.alpha;
      ctx.beginPath();
      for (const ring of it.rings) tracePath(ctx, ring, true, T);
      ctx.fill('evenodd');
    }
  }
  strokeOpen();
  ctx.restore();
  return { transform: T, scale };
}

/** Largest canvas side browsers accept (Chrome fails above it with a zero-size canvas). */
export const MAX_PNG_SIDE = 16384;

/**
 * Settings with the image size resolved and scaled down, keeping the
 * aspect ratio, so neither side exceeds MAX_PNG_SIDE: image mode sets
 * width and height, paper mode lowers dpi.
 */
export function pngSettings(settings = {}) {
  const opts = { ...settings };
  if (isPaperMode(opts)) {
    const { width, height } = pagePixels(opts);
    const k = MAX_PNG_SIDE / Math.max(width, height);
    if (k < 1) opts.dpi = (opts.dpi ?? 150) * k * 0.999;
    return opts;
  }
  let w = Math.max(1, opts.width ?? 1600);
  let h = Math.max(1, opts.height ?? 1200);
  const k = Math.min(1, MAX_PNG_SIDE / Math.max(w, h));
  opts.width = Math.max(1, Math.min(MAX_PNG_SIDE, Math.round(w * k)));
  opts.height = Math.max(1, Math.min(MAX_PNG_SIDE, Math.round(h * k)));
  return opts;
}

/**
 * Render items to a PNG Blob. Paper mode sizes the image from the page and
 * dpi; otherwise width and height (default 1600 x 1200) are used.
 * The background defaults to white.
 */
export async function exportPng(items, settings = {}) {
  const opts = pngSettings({
    ...settings,
    background: settings.background === undefined ? '#ffffff' : settings.background,
  });
  const { width, height } = isPaperMode(opts) ? pagePixels(opts) : opts;
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    renderToCanvas(canvas.getContext('2d'), items, opts);
    return canvas.convertToBlob({ type: 'image/png' });
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    renderToCanvas(canvas.getContext('2d'), items, opts);
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
    });
  }
  throw new Error('No canvas available for PNG export');
}
