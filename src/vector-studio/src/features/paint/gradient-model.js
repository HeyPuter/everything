/**
 * Pure gradient editing used by the Gradient panel and the Gradient tool.
 * Stops are kept sorted by offset after every edit, so stop indices refer
 * to positions along the gradient slider. `midpoint` on a stop applies to
 * the interval between it and the next stop.
 */
import { sampleStops, sortedStops, isGradient } from '../../model/gradients.js';
import { defaultFreeform } from './freeform.js';

export { isGradient };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const DEFAULT_LINEAR = Object.freeze({
  type: 'linear',
  angle: 0,
  stops: Object.freeze([Object.freeze({ offset: 0, color: '#ffffff', opacity: 1 }), Object.freeze({ offset: 1, color: '#000000', opacity: 1 })]),
});

function withStops(paint, stops) {
  return { ...paint, stops };
}

/** Sort stops, keeping track of where the stop at `index` ended up. */
function resort(paint, index) {
  const tagged = paint.stops.map((s, i) => ({ s, i }));
  tagged.sort((a, b) => a.s.offset - b.s.offset || a.i - b.i);
  return { paint: withStops(paint, tagged.map((t) => t.s)), index: tagged.findIndex((t) => t.i === index) };
}

/** Insert a stop at `offset` with the color the gradient has there. */
export function insertStop(paint, offset) {
  const o = clamp01(offset);
  const { color, opacity } = sampleStops(paint.stops, o);
  const stops = [...paint.stops, { offset: o, color, opacity: Math.round(opacity * 1000) / 1000 }];
  return resort(withStops(paint, stops), stops.length - 1);
}

/** Remove a stop (gradients keep at least two). */
export function removeStop(paint, index) {
  if (paint.stops.length <= 2 || index < 0 || index >= paint.stops.length) return paint;
  return withStops(
    paint,
    paint.stops.filter((_, i) => i !== index),
  );
}

/** Move a stop to a new offset; returns { paint, index } with the stop's new index. */
export function moveStop(paint, index, offset) {
  const stops = paint.stops.map((s, i) => (i === index ? { ...s, offset: clamp01(offset) } : s));
  return resort(withStops(paint, stops), index);
}

export function setStop(paint, index, patch) {
  return withStops(
    paint,
    paint.stops.map((s, i) => (i === index ? { ...s, ...patch } : s)),
  );
}

/** Set the midpoint between stop `index` and the next (0.05..0.95 of the interval). */
export function setMidpoint(paint, index, m) {
  return setStop(paint, index, { midpoint: Math.min(0.95, Math.max(0.05, m)) });
}

/** Reverse the gradient: offsets mirror and midpoints follow their intervals. */
export function reverseGradient(paint) {
  const s = sortedStops(paint.stops);
  const n = s.length;
  const stops = [];
  for (let j = 0; j < n; j++) {
    const src = s[n - 1 - j];
    const out = { ...src, offset: clamp01(1 - src.offset) };
    delete out.midpoint;
    const segOwner = s[n - 2 - j];
    if (j < n - 1 && segOwner && segOwner.midpoint != null) out.midpoint = 1 - segOwner.midpoint;
    stops.push(out);
  }
  return withStops(paint, stops);
}

/** Normalize a gradient paint: sorted stops with clamped offsets and opacities. */
export function normalizeGradient(paint) {
  return withStops(
    paint,
    sortedStops(paint.stops).map((s) => ({ ...s, offset: clamp01(s.offset), opacity: clamp01(s.opacity ?? 1) })),
  );
}

/** Switch between linear and radial, keeping stops and end points. */
export function setGradientType(paint, type) {
  if (paint.type === type) return paint;
  if (type === 'freeform') return defaultFreeform(paint);
  if (paint.type === 'freeform') {
    // Points become evenly spaced stops, in order.
    const pts = paint.points || [];
    const stops = (pts.length > 1 ? pts : [...pts, ...pts, { color: '#000000' }].slice(0, 2)).map((p, i, arr) => ({ offset: i / (arr.length - 1), color: p.color, opacity: p.opacity ?? 1 }));
    return { type, angle: 0, stops };
  }
  return { ...paint, type };
}

/** The gradient's angle in degrees (y up), from its end points when it has them. */
export function gradientAngle(paint) {
  if (paint.x1 !== undefined) return (-Math.atan2(paint.y2 - paint.y1, paint.x2 - paint.x1) * 180) / Math.PI;
  return paint.angle || 0;
}

/**
 * Rotate a gradient to an angle (degrees, y up). With explicit end points
 * the vector rotates around its midpoint (radial: around its center).
 */
export function setGradientAngle(paint, deg) {
  const angle = normalizeAngle(deg);
  if (paint.x1 === undefined) return { ...paint, angle };
  const len = Math.hypot(paint.x2 - paint.x1, paint.y2 - paint.y1);
  const a = (-angle * Math.PI) / 180;
  if (paint.type === 'radial') {
    return { ...paint, angle, x2: paint.x1 + Math.cos(a) * len, y2: paint.y1 + Math.sin(a) * len };
  }
  const cx = (paint.x1 + paint.x2) / 2;
  const cy = (paint.y1 + paint.y2) / 2;
  const dx = (Math.cos(a) * len) / 2;
  const dy = (Math.sin(a) * len) / 2;
  return { ...paint, angle, x1: cx - dx, y1: cy - dy, x2: cx + dx, y2: cy + dy };
}

export function normalizeAngle(deg) {
  let a = ((deg + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(a + 180) < 1e-9) a = 180;
  return Math.round(a * 1000) / 1000;
}

/** Gradient with explicit end points from a drag (document space). */
export function setGradientVector(paint, x1, y1, x2, y2) {
  const angle = normalizeAngle((-Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI);
  return { ...paint, x1, y1, x2, y2, angle };
}

/** Drop explicit end points so the gradient fits the object's bounds again. */
export function resetGradientVector(paint) {
  const out = { ...paint };
  delete out.x1;
  delete out.y1;
  delete out.x2;
  delete out.y2;
  return out;
}

/** Project a point onto the gradient bar: fraction along (x1,y1)-(x2,y2). */
export function projectOnVector(g, x, y) {
  const dx = g.x2 - g.x1;
  const dy = g.y2 - g.y1;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return 0;
  return ((x - g.x1) * dx + (y - g.y1) * dy) / l2;
}

/** Strip swatch links from a gradient so editing it does not touch a global swatch. */
export function detachSwatch(paint) {
  if (!paint || paint.swatchId === undefined) return paint;
  const out = { ...paint };
  delete out.swatchId;
  return out;
}
