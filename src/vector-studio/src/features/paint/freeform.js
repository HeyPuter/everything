/**
 * Freeform gradients: colors placed at points over an object that blend
 * smoothly into each other.
 *
 *   { type: 'freeform', points: [{ x, y, color, opacity?, spread? }] }
 *
 *   { type: 'freeform', mode: 'lines', points, lines: [[i, j, ...]] }
 *
 * Point positions are fractions of the object's bounding box frame
 * (freeformFrame: 0..1, turned with the object), so the gradient follows
 * the object as it moves, resizes and rotates. Each pixel takes an
 * inverse-distance-weighted mix of the colors; `spread` (0..1) is a
 * radius, as a fraction of the frame's diagonal, inside which a point's
 * color stays solid. In lines mode, points joined by lines (polylines of
 * point indices) spread their colors along the lines: every point of a
 * segment carries the color between its ends.
 *
 * Rendering: drawHooks.paintStyle gets a canvas pattern of the blended
 * colors over the object's frame; SVG export writes it as an image
 * pattern; PDF fills draw it as an image inside the shape; other
 * exporters get the average color (exportBakers).
 */
import { hexToRgb, rgbToHex } from '../../lib/color.js';
import { drawHooks } from '../../render/draw.js';
import { frameBounds, nodeFrameAngle } from '../../model/geometry.js';
import { multiply, rotate, apply, invert } from '../../lib/matrix.js';
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
 * Color sources of a paint: free points, and in lines mode the segments of
 * its lines (each point of a segment takes the color between its ends).
 */
function prepare(paint) {
  const pts = paint.points || [];
  const col = pts.map((p) => ({ ...hexToRgb(p.color), a: p.opacity ?? 1 }));
  const lines = paint.mode === 'lines' ? (paint.lines || []).filter((l) => Array.isArray(l) && l.length > 1) : [];
  const segs = [];
  for (const l of lines) for (let k = 0; k + 1 < l.length; k++) if (pts[l[k]] && pts[l[k + 1]] && l[k] !== l[k + 1]) segs.push([l[k], l[k + 1]]);
  const onLine = new Set(segs.flat());
  const free = pts.map((_, i) => i).filter((i) => !onLine.has(i));
  return { pts, col, segs, free };
}

/**
 * The blended color { r, g, b, a } at (u, v) in frame-fraction space for an
 * object `aspect` = width / height (distances are measured in the
 * object's proportions): an inverse-distance-weighted mix of the sources,
 * solid within a point's spread.
 */
function blendAt(prep, u, v, aspect) {
  const { pts, col, segs, free } = prep;
  const sx = Math.sqrt(aspect);
  const sy = 1 / sx;
  const diag = Math.hypot(sx, sy);
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let total = 0;
  const add = (d, c) => {
    const w = 1 / (d * d);
    r += c.r * w;
    g += c.g * w;
    b += c.b * w;
    a += c.a * w;
    total += w;
  };
  for (const i of free) {
    const p = pts[i];
    const d = Math.max(0, Math.hypot((u - p.x) * sx, (v - p.y) * sy) / diag - clamp01(p.spread || 0));
    if (d < 1e-6) return { ...col[i] };
    add(d, col[i]);
  }
  for (const [i, j] of segs) {
    const p = pts[i];
    const q = pts[j];
    const ax = p.x * sx;
    const ay = p.y * sy;
    const dx = q.x * sx - ax;
    const dy = q.y * sy - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? clamp01(((u * sx - ax) * dx + (v * sy - ay) * dy) / len2) : 0;
    const spread = clamp01(p.spread || 0) + (clamp01(q.spread || 0) - clamp01(p.spread || 0)) * t;
    const d = Math.max(0, Math.hypot(u * sx - ax - dx * t, v * sy - ay - dy * t) / diag - spread);
    const c0 = col[i];
    const c1 = col[j];
    const c = { r: c0.r + (c1.r - c0.r) * t, g: c0.g + (c1.g - c0.g) * t, b: c0.b + (c1.b - c0.b) * t, a: c0.a + (c1.a - c0.a) * t };
    if (d < 1e-6) return c;
    add(d, c);
  }
  if (!total) return { r: 0, g: 0, b: 0, a: 0 };
  return { r: r / total, g: g / total, b: b / total, a: a / total };
}

/** Color { r, g, b, a } (0..255, a 0..1) at (u, v). */
export function sampleFreeform(paint, u, v, aspect = 1) {
  if (!paint.points?.length) return { r: 0, g: 0, b: 0, a: 0 };
  return blendAt(prepare(paint), u, v, aspect);
}

/** RGBA pixels for a w x h raster covering frame-fraction rect [u0,u1] x [v0,v1]. */
export function freeformPixels(paint, w, h, aspect = 1, [u0, v0, u1, v1] = [0, 0, 1, 1]) {
  const data = new Uint8ClampedArray(w * h * 4);
  if (!paint.points?.length) return data;
  const prep = prepare(paint);
  for (let y = 0; y < h; y++) {
    const v = v0 + ((y + 0.5) / h) * (v1 - v0);
    for (let x = 0; x < w; x++) {
      const u = u0 + ((x + 0.5) / w) * (u1 - u0);
      const c = blendAt(prep, u, v, aspect);
      const k = (y * w + x) * 4;
      data[k] = c.r;
      data[k + 1] = c.g;
      data[k + 2] = c.b;
      data[k + 3] = c.a * 255;
    }
  }
  return data;
}

// ---- frame ----

/**
 * Where a freeform gradient lies on an object: its bounding box frame
 * { x, y, w, h, angle } (frame space, turned by `angle` degrees with the
 * object, see geometry.js frameBounds). Point positions are fractions of
 * this box, so rotating the object turns the gradient with it.
 */
export function freeformFrame(doc, node) {
  const angle = nodeFrameAngle(node);
  const b = frameBounds(doc, node, angle);
  return b && b.w > 0 && b.h > 0 ? { ...b, angle } : null;
}

/** Matrix from frame fractions (u, v) to the document. */
export function frameFractionMatrix(f) {
  return multiply(rotate(f.angle || 0), [f.w, 0, 0, f.h, f.x, f.y]);
}

/** Document position of the frame fraction (u, v). */
export function framePoint(f, u, v) {
  return apply(frameFractionMatrix(f), u, v);
}

/** Frame fraction { u, v } of a document point. */
export function frameFraction(f, x, y) {
  const p = apply(invert(frameFractionMatrix(f)), x, y);
  return { u: p.x, v: p.y };
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

/**
 * Add a color point. In lines mode it continues the line through point
 * `after` (or starts one from it); without `after` it stands alone.
 */
export function addPoint(paint, x, y, color, { after = null } = {}) {
  const index = paint.points.length;
  const out = { ...paint, points: [...paint.points, { x: clamp01(x), y: clamp01(y), color, spread: 0 }] };
  if (paint.mode === 'lines' && after != null && paint.points[after]) {
    const lines = (paint.lines || []).map((l) => l.slice());
    const end = lines.find((l) => l[l.length - 1] === after);
    const start = end ? null : lines.find((l) => l[0] === after);
    if (end) end.push(index);
    else if (start) start.unshift(index);
    else lines.push([after, index]);
    out.lines = lines;
  }
  return { paint: out, index };
}

/** Insert a point on segment k of line `li` at t (0..1), with the color there. */
export function insertLinePoint(paint, li, k, t) {
  const line = paint.lines?.[li];
  if (!line || k + 1 >= line.length) return null;
  const a = paint.points[line[k]];
  const b = paint.points[line[k + 1]];
  const ca = hexToRgb(a.color);
  const cb = hexToRgb(b.color);
  const color = rgbToHex({ r: ca.r + (cb.r - ca.r) * t, g: ca.g + (cb.g - ca.g) * t, b: ca.b + (cb.b - ca.b) * t });
  const index = paint.points.length;
  const pt = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, color, spread: 0 };
  if (a.opacity != null || b.opacity != null) pt.opacity = (a.opacity ?? 1) + ((b.opacity ?? 1) - (a.opacity ?? 1)) * t;
  const lines = paint.lines.map((l, i) => (i === li ? [...l.slice(0, k + 1), index, ...l.slice(k + 1)] : l));
  return { paint: { ...paint, points: [...paint.points, pt], lines }, index };
}

export function removePoint(paint, i) {
  if (paint.points.length <= 1) return paint;
  const out = { ...paint, points: paint.points.filter((_, j) => j !== i) };
  if (paint.lines) out.lines = paint.lines.map((l) => l.filter((j) => j !== i).map((j) => (j > i ? j - 1 : j))).filter((l) => l.length > 1);
  return out;
}

/** Switch between points and lines (lines keep their connections for switching back). */
export function setFreeformMode(paint, mode) {
  return { ...paint, mode: mode === 'lines' ? 'lines' : 'points' };
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

/** Canvas style for a freeform paint on a node: a pattern of the blend over its frame. */
export function freeformStyle(ctx, doc, node, paint) {
  const f = freeformFrame(doc, node);
  if (!f) return averageColor(paint);
  // Strokes reach past the frame: cover them too.
  const pad = Math.max(0, node.strokeWidth || 0) + 1;
  const pu = pad / f.w;
  const pv = pad / f.h;
  const canvas = freeformRaster(paint, f.w / f.h, [-pu, -pv, 1 + pu, 1 + pv]);
  const pattern = canvas && ctx.createPattern?.(canvas, 'no-repeat');
  if (!pattern || typeof DOMMatrix === 'undefined' || !pattern.setTransform) return averageColor(paint);
  // Canvas pixels -> frame fractions -> document.
  const m = multiply(frameFractionMatrix(f), [(1 + 2 * pu) / canvas.width, 0, 0, (1 + 2 * pv) / canvas.height, -pu, -pv]);
  pattern.setTransform(new DOMMatrix(m));
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

/** SVG paint server: an image pattern of the blend over the object's frame. */
function svgFreeform(writer, paint, node, mapped) {
  const f = freeformFrame(writer.doc, node);
  if (!f) return null;
  const canvas = freeformRaster(paint, f.w / f.h);
  let href = null;
  try {
    href = canvas?.toDataURL?.('image/png');
  } catch {
    href = null;
  }
  if (!href || href.length < 30) return null;
  const m = frameFractionMatrix(f);
  if (mapped) {
    m[4] -= writer.ox;
    m[5] -= writer.oy;
  }
  const n = (v) => writer.n(v);
  const k = (v) => Number(v.toFixed(6));
  // One pattern unit is the whole frame; the matrix places (and turns) it.
  return writer.def('ff', (id) => `${writer.nl(2)}<pattern id="${id}" patternUnits="userSpaceOnUse" width="1" height="1" patternTransform="matrix(${[k(m[0]), k(m[1]), k(m[2]), k(m[3]), n(m[4]), n(m[5])].join(' ')})"><image width="1" height="1" preserveAspectRatio="none" href="${href}"/></pattern>`);
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
