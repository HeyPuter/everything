// Pure edits on automation point lists ({ t, v, c? } sorted by t, v in 0..1,
// c the curve tension of the segment to the next point; see
// automation/evaluate.js for the time base and the curve shape). Every
// function returns a new array and leaves its input untouched.

import { clamp } from '../lib/util.js';
import { ceilToBar } from '../model/time.js';

const clamp01 = (v) => clamp(v, 0, 1);

/** A point with its curve kept only when it is a non-zero number (clamped to -1..1). */
function withCurve(p, c) {
  const k = typeof c === 'number' && Number.isFinite(c) ? clamp(Math.round(c * 1000) / 1000, -1, 1) : 0;
  return k ? { ...p, c: k } : p;
}

/** Sorted copy with values clamped to 0..1, times to >= 0 and curves to -1..1. */
export function normalizePoints(points) {
  return points.map((p) => withCurve({ t: Math.max(0, Math.round(p.t)), v: clamp01(p.v) }, p.c)).sort((a, b) => a.t - b.t);
}

/** A flat line at `v` from 0 to `len` (two points, so both ends can be dragged). */
export function flatLine(v, len) {
  const value = clamp01(v);
  return len > 0 ? [{ t: 0, v: value }, { t: Math.round(len), v: value }] : [{ t: 0, v: value }];
}

/**
 * Inserts a point in time order. Returns { points, index } (index of the new
 * point). A point added inside a curved segment takes that segment's curve,
 * so both halves keep its character.
 */
export function addPoint(points, { t, v, c }) {
  let p = { t: Math.max(0, Math.round(t)), v: clamp01(v) };
  let index = points.findIndex((q) => q.t > p.t);
  if (index < 0) index = points.length;
  p = withCurve(p, c ?? (index > 0 && index < points.length ? points[index - 1].c : 0));
  const out = points.slice();
  out.splice(index, 0, p);
  return { points: out, index };
}

/**
 * Moves point `index` to { t, v }. Time stays between its neighbours so the
 * order never changes under the pointer; the value is clamped to 0..1.
 */
export function movePoint(points, index, { t, v }) {
  const cur = points[index];
  if (!cur) return points;
  const lo = index > 0 ? points[index - 1].t : 0;
  const hi = index < points.length - 1 ? points[index + 1].t : Infinity;
  const nt = clamp(Math.round(t ?? cur.t), lo, hi);
  const nv = clamp01(v ?? cur.v);
  if (nt === cur.t && nv === cur.v) return points;
  const out = points.slice();
  out[index] = withCurve({ t: nt, v: nv }, cur.c);
  return out;
}

/**
 * Sets the curve tension (-1..1, 0 is linear) of the segment that starts at
 * point `index`. Returns the input when nothing changes.
 */
export function setCurve(points, index, c) {
  const cur = points[index];
  if (!cur) return points;
  const next = withCurve({ t: cur.t, v: cur.v }, c);
  if ((next.c || 0) === (cur.c || 0)) return points;
  const out = points.slice();
  out[index] = next;
  return out;
}

/** Curve presets for menus: tension values with readable labels. */
export const CURVE_PRESETS = [
  { id: 'linear', label: 'Linear', c: 0 },
  { id: 'easeIn', label: 'Ease in (slow start)', c: 0.5 },
  { id: 'easeOut', label: 'Ease out (slow end)', c: -0.5 },
  { id: 'strongIn', label: 'Strong ease in', c: 0.9 },
  { id: 'strongOut', label: 'Strong ease out', c: -0.9 },
];

/**
 * Index of the point that starts the segment containing local tick `t`
 * (between two points with distinct times), or -1 outside every segment.
 */
export function segmentAt(points, t) {
  for (let i = 0; i + 1 < points.length; i++) {
    if (t >= points[i].t && t < points[i + 1].t) return i;
  }
  return -1;
}

/**
 * Tension after dragging a segment's middle by `dv` (normalized value units,
 * positive is up). Dragging up bends the curve upwards whichever way the
 * segment goes; flat segments take no tension.
 */
export function dragCurve(c0, v0, v1, dv) {
  const dir = Math.sign(v1 - v0);
  if (!dir) return 0;
  return clamp((c0 || 0) - dir * dv * 2, -1, 1);
}

/** Removes point `index`; the last remaining point is kept. */
export function removePoint(points, index) {
  if (points.length <= 1 || index < 0 || index >= points.length) return points;
  return points.filter((_, i) => i !== index);
}

/**
 * The point under (x, y) given mappings from point time/value to pixels.
 * Returns the index of the nearest point within `radius` px, or -1.
 */
export function hitPoint(points, toX, toY, x, y, radius = 6) {
  let best = -1;
  let bestD = radius * radius;
  for (let i = 0; i < points.length; i++) {
    const dx = toX(points[i].t) - x;
    const dy = toY(points[i].v) - y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Natural clip length for an automation: its last point rounded up to whole bars (one bar minimum). */
export function automationLength(automation, sig = [4, 4]) {
  const last = automation?.points?.at(-1)?.t || 0;
  return ceilToBar(last, sig);
}
