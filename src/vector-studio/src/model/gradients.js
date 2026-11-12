/**
 * Gradient stop math shared by the renderer, the Gradient panel and the
 * exporters. A gradient paint keeps its user stops ({ offset, color,
 * opacity, midpoint? }); `midpoint` (0..1, default 0.5) is where the color
 * between this stop and the next one is an even mix. Renderers that only
 * interpolate linearly (Canvas 2D, SVG, PDF) use expandStops() to get extra
 * stops that follow the midpoint curve.
 */
import { hexToRgb, rgbToHex } from '../lib/color.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Stops sorted by offset (stable for equal offsets). */
export function sortedStops(stops) {
  return stops
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.offset - b.s.offset || a.i - b.i)
    .map((x) => x.s);
}

/**
 * Mix weight at fraction t of a stop interval whose midpoint is m: a power
 * curve with weight(m) = 0.5, weight(0) = 0 and weight(1) = 1.
 */
export function midpointWeight(t, m = 0.5) {
  const mm = Math.min(0.99, Math.max(0.01, m ?? 0.5));
  if (Math.abs(mm - 0.5) < 1e-6) return t;
  return Math.pow(clamp01(t), Math.log(0.5) / Math.log(mm));
}

function mixRgb(a, b, w) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex({ r: A.r + (B.r - A.r) * w, g: A.g + (B.g - A.g) * w, b: A.b + (B.b - A.b) * w });
}

/** Color and opacity of a gradient at position t (0..1), honoring midpoints. */
export function sampleStops(stops, t) {
  const s = sortedStops(stops);
  if (!s.length) return { color: '#000000', opacity: 1 };
  if (t <= s[0].offset) return { color: s[0].color, opacity: s[0].opacity ?? 1 };
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i];
    const b = s[i + 1];
    if (t <= b.offset) {
      const span = b.offset - a.offset;
      const f = span > 1e-9 ? (t - a.offset) / span : 1;
      const w = midpointWeight(f, a.midpoint);
      return { color: mixRgb(a.color, b.color, w), opacity: (a.opacity ?? 1) + ((b.opacity ?? 1) - (a.opacity ?? 1)) * w };
    }
  }
  const last = s[s.length - 1];
  return { color: last.color, opacity: last.opacity ?? 1 };
}

/**
 * Stops for linear-interpolating renderers: the user stops plus samples
 * inside intervals whose midpoint is not centered. Offsets are clamped to
 * 0..1 and sorted.
 */
export function expandStops(stops, samples = 12) {
  const s = sortedStops(stops);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const a = s[i];
    out.push({ offset: clamp01(a.offset), color: a.color, opacity: a.opacity ?? 1 });
    const b = s[i + 1];
    if (!b) break;
    const m = a.midpoint ?? 0.5;
    if (Math.abs(m - 0.5) < 1e-6 || b.offset - a.offset < 1e-6) continue;
    for (let k = 1; k < samples; k++) {
      const t = k / samples;
      const w = midpointWeight(t, m);
      out.push({
        offset: clamp01(a.offset + (b.offset - a.offset) * t),
        color: mixRgb(a.color, b.color, w),
        opacity: (a.opacity ?? 1) + ((b.opacity ?? 1) - (a.opacity ?? 1)) * w,
      });
    }
  }
  return out;
}

export function isGradient(paint) {
  return Boolean(paint && (paint.type === 'linear' || paint.type === 'radial'));
}

/**
 * A gradient paint moved from an object with bounds `from` onto one with
 * bounds `to` ({ x, y, w, h }): explicit end points are document positions,
 * so they keep their place relative to the bounds instead. Without both
 * bounds (paint for objects not drawn yet) the end points are dropped and
 * the gradient fits whatever it lands on at its angle. Other paints pass
 * through.
 */
export function moveGradient(paint, from = null, to = null) {
  if (!isGradient(paint) || paint.x1 === undefined) return paint;
  const { x1, y1, x2, y2, ...rest } = paint;
  if (!from || !to || !(from.w > 0) || !(from.h > 0)) return rest;
  const mx = (x) => to.x + ((x - from.x) / from.w) * to.w;
  const my = (y) => to.y + ((y - from.y) / from.h) * to.h;
  const out = { ...rest, x1: mx(x1), y1: my(y1), x2: mx(x2), y2: my(y2) };
  // Flattened onto a line (zero width or height): fit at the angle instead.
  if (out.x1 === out.x2 && out.y1 === out.y2) return rest;
  const angle = (-Math.atan2(out.y2 - out.y1, out.x2 - out.x1) * 180) / Math.PI;
  return { ...out, angle: Math.round(angle * 1000) / 1000 + 0 };
}

/**
 * Offset {x, y} of a radial gradient's focal point from its center, and the
 * focal radius r, in the space of geometry g. paint.focal is [u, v] in the
 * gradient's unit circle (u along its major axis, v along the minor axis,
 * which is `aspect` times shorter); `aspect` 1 gives the circle's own frame.
 */
export function focalPoint(paint, g, aspect = paint.aspect || 1) {
  const fr = Math.max(0, (paint.focalRadius || 0) * g.r);
  if (!paint.focal) return { x: 0, y: 0, r: fr };
  const [u, v] = paint.focal;
  let ax = g.x2 - g.x1;
  let ay = g.y2 - g.y1;
  if (paint.x1 === undefined) {
    const a = (-(paint.angle || 0) * Math.PI) / 180;
    ax = Math.cos(a) * g.r;
    ay = Math.sin(a) * g.r;
  }
  return { x: u * ax - v * ay * aspect, y: u * ay + v * ax * aspect, r: fr };
}
