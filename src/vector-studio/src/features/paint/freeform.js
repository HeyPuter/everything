/**
 * Freeform gradients: colors placed at points over an object that blend
 * smoothly into each other.
 *
 *   { type: 'freeform', points: [{ x, y, color, opacity?, spread? }] }
 *
 * Point positions are fractions of the object's bounds (0..1), so the
 * gradient follows the object as it moves and resizes. Each pixel takes an
 * inverse-distance-weighted mix of the point colors; `spread` (0..1) is a
 * radius, as a fraction of the bounds' diagonal, inside which a point's
 * color stays solid.
 *
 * Rendering: drawHooks.paintStyle gets a canvas pattern of the blended
 * colors over the object's bounds; SVG export writes it as an image
 * pattern; other exporters get the average color (exportBakers).
 */
import { hexToRgb, rgbToHex } from '../../lib/color.js';
import { drawHooks } from '../../render/draw.js';
import { nodeBounds } from '../../model/geometry.js';
import { paintCssHooks } from '../../ui/widgets.js';
import { svgPaintHooks, exportBakers } from '../io/hooks.js';

export const isFreeform = (p) => Boolean(p && p !== 'mixed' && p.type === 'freeform');

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A starting freeform gradient: from a linear/radial gradient's stops, or three default colors. */
export function defaultFreeform(from = null) {
  const colors = from?.stops?.length ? from.stops.map((s) => s.color) : ['#ff5a5f', '#ffd166', '#3d7bfd'];
  const n = Math.max(2, Math.min(6, colors.length));
  const points = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    points.push({ x: 0.5 + Math.cos(a) * 0.3, y: 0.5 + Math.sin(a) * 0.3, color: colors[i % colors.length], spread: 0 });
  }
  return { type: 'freeform', points };
}

/**
 * Blend weights at (u, v) in bounds-fraction space for an object `aspect`
 * = width / height: distances are measured in the object's proportions.
 */
function weights(points, u, v, aspect) {
  const sx = Math.sqrt(aspect);
  const sy = 1 / sx;
  const diag = Math.hypot(sx, sy);
  const out = new Float64Array(points.length);
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const d = Math.hypot((u - p.x) * sx, (v - p.y) * sy) / diag;
    const r = Math.max(0, d - clamp01(p.spread || 0));
    if (r < 1e-6) {
      out.fill(0);
      out[i] = 1;
      return out;
    }
    const w = 1 / (r * r);
    out[i] = w;
    total += w;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Color { r, g, b, a } (0..255, a 0..1) at (u, v). */
export function sampleFreeform(paint, u, v, aspect = 1) {
  const pts = paint.points || [];
  if (!pts.length) return { r: 0, g: 0, b: 0, a: 0 };
  const rgb = pts.map((p) => hexToRgb(p.color));
  const w = weights(pts, u, v, aspect);
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    r += rgb[i].r * w[i];
    g += rgb[i].g * w[i];
    b += rgb[i].b * w[i];
    a += (pts[i].opacity ?? 1) * w[i];
  }
  return { r, g, b, a };
}

/** RGBA pixels for a w x h raster covering bounds-fraction rect [u0,u1] x [v0,v1]. */
export function freeformPixels(paint, w, h, aspect = 1, [u0, v0, u1, v1] = [0, 0, 1, 1]) {
  const data = new Uint8ClampedArray(w * h * 4);
  const pts = paint.points || [];
  if (!pts.length) return data;
  const rgb = pts.map((p) => hexToRgb(p.color));
  for (let y = 0; y < h; y++) {
    const v = v0 + ((y + 0.5) / h) * (v1 - v0);
    for (let x = 0; x < w; x++) {
      const u = u0 + ((x + 0.5) / w) * (u1 - u0);
      const wt = weights(pts, u, v, aspect);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        r += rgb[i].r * wt[i];
        g += rgb[i].g * wt[i];
        b += rgb[i].b * wt[i];
        a += (pts[i].opacity ?? 1) * wt[i];
      }
      const k = (y * w + x) * 4;
      data[k] = r;
      data[k + 1] = g;
      data[k + 2] = b;
      data[k + 3] = a * 255;
    }
  }
  return data;
}

/** The average color of the points (for exporters that cannot draw the blend). */
export function averageColor(paint) {
  const pts = paint.points || [];
  if (!pts.length) return '#000000';
  const s = pts.reduce((acc, p) => {
    const c = hexToRgb(p.color);
    return { r: acc.r + c.r, g: acc.g + c.g, b: acc.b + c.b };
  }, { r: 0, g: 0, b: 0 });
  return rgbToHex({ r: s.r / pts.length, g: s.g / pts.length, b: s.b / pts.length });
}

// ---- editing ----

export function setPoint(paint, i, patch) {
  return { ...paint, points: paint.points.map((p, j) => (j === i ? { ...p, ...patch } : p)) };
}

export function addPoint(paint, x, y, color) {
  return { paint: { ...paint, points: [...paint.points, { x: clamp01(x), y: clamp01(y), color, spread: 0 }] }, index: paint.points.length };
}

export function removePoint(paint, i) {
  if (paint.points.length <= 1) return paint;
  return { ...paint, points: paint.points.filter((_, j) => j !== i) };
}

// ---- rendering ----

const RASTER = 128;
const rasterCache = new WeakMap();

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') return Object.assign(document.createElement('canvas'), { width: w, height: h });
  return new OffscreenCanvas(w, h);
}

/**
 * A canvas of the blend over `rect` (bounds-fraction space, may reach past
 * 0..1 for strokes), cached per paint.
 */
export function freeformRaster(paint, aspect, rect = [0, 0, 1, 1]) {
  const key = `${aspect.toFixed(4)}|${rect.map((v) => v.toFixed(4)).join()}`;
  const hit = rasterCache.get(paint);
  if (hit && hit.key === key) return hit.canvas;
  const w = Math.max(8, Math.round(RASTER * Math.min(1, Math.sqrt(aspect))));
  const h = Math.max(8, Math.round(RASTER * Math.min(1, 1 / Math.sqrt(aspect))));
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx?.createImageData) return null;
  const img = ctx.createImageData(w, h);
  if (!img?.data) return null;
  img.data.set(freeformPixels(paint, w, h, aspect, rect));
  ctx.putImageData(img, 0, 0);
  rasterCache.set(paint, { key, canvas });
  return canvas;
}

/** Canvas style for a freeform paint on a node: a pattern of the blend over its bounds. */
export function freeformStyle(ctx, doc, node, paint) {
  const b = nodeBounds(doc, node);
  if (!b || !(b.w > 0) || !(b.h > 0)) return averageColor(paint);
  // Strokes reach past the bounds: cover them too.
  const pad = Math.max(0, node.strokeWidth || 0) + 1;
  const rect = [-pad / b.w, -pad / b.h, 1 + pad / b.w, 1 + pad / b.h];
  const canvas = freeformRaster(paint, b.w / b.h, rect);
  const pattern = canvas && ctx.createPattern?.(canvas, 'no-repeat');
  if (!pattern || typeof DOMMatrix === 'undefined' || !pattern.setTransform) return averageColor(paint);
  const x0 = b.x - pad;
  const y0 = b.y - pad;
  pattern.setTransform(new DOMMatrix([(b.w + pad * 2) / canvas.width, 0, 0, (b.h + pad * 2) / canvas.height, x0, y0]));
  return pattern;
}

/** CSS for swatches and previews: layered radial gradients, one per point. */
export function freeformCss(paint) {
  const pts = paint.points || [];
  if (!pts.length) return null;
  const layers = pts.map((p) => {
    const { r, g, b } = hexToRgb(p.color);
    const reach = Math.round(45 + (p.spread || 0) * 60);
    return `radial-gradient(circle at ${Math.round(p.x * 100)}% ${Math.round(p.y * 100)}%, rgba(${r},${g},${b},${p.opacity ?? 1}) 0%, rgba(${r},${g},${b},0) ${reach}%)`;
  });
  return `${layers.join(', ')}, ${averageColor(paint)}`;
}

/** SVG paint server: an image pattern of the blend over the object's bounds. */
function svgFreeform(writer, paint, node, mapped) {
  const b = nodeBounds(writer.doc, node);
  if (!b || !(b.w > 0) || !(b.h > 0)) return null;
  const canvas = freeformRaster(paint, b.w / b.h);
  let href = null;
  try {
    href = canvas?.toDataURL?.('image/png');
  } catch {
    href = null;
  }
  if (!href || href.length < 30) return null;
  const x = mapped ? b.x - writer.ox : b.x;
  const y = mapped ? b.y - writer.oy : b.y;
  const n = (v) => writer.n(v);
  return writer.def('ff', (id) => `${writer.nl(2)}<pattern id="${id}" patternUnits="userSpaceOnUse" x="${n(x)}" y="${n(y)}" width="${n(b.w)}" height="${n(b.h)}"><image width="${n(b.w)}" height="${n(b.h)}" preserveAspectRatio="none" href="${href}"/></pattern>`);
}

const hasFreeform = (n) => isFreeform(n.fill) || isFreeform(n.stroke);

/** Install the renderer, preview and export hooks (once). */
let installed = false;
export function installFreeform() {
  if (installed) return;
  installed = true;
  const prev = drawHooks.paintStyle;
  drawHooks.paintStyle = (ctx, doc, node, paint, seg) => (paint?.type === 'freeform' ? freeformStyle(ctx, doc, node, paint) : prev ? prev(ctx, doc, node, paint, seg) : null);
  paintCssHooks.freeform = freeformCss;
  svgPaintHooks.freeform = svgFreeform;
  if (!exportBakers.some((b) => b.key === 'freeform')) {
    exportBakers.push({
      key: 'freeform',
      test: hasFreeform,
      bake: (n) => ({
        ...n,
        ...(isFreeform(n.fill) ? { fill: { type: 'solid', color: averageColor(n.fill) } } : {}),
        ...(isFreeform(n.stroke) ? { stroke: { type: 'solid', color: averageColor(n.stroke) } } : {}),
      }),
    });
  }
}
