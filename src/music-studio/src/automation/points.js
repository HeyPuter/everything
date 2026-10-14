// Pure edits on automation point lists ({ t, v } sorted by t, v in 0..1; see
// automation/evaluate.js for the time base). Every function returns a new
// array and leaves its input untouched.

import { clamp } from '../lib/util.js';
import { ceilToBar } from '../model/time.js';

const clamp01 = (v) => clamp(v, 0, 1);

/** Sorted copy with values clamped to 0..1 and times to >= 0. */
export function normalizePoints(points) {
  return points.map((p) => ({ t: Math.max(0, Math.round(p.t)), v: clamp01(p.v) })).sort((a, b) => a.t - b.t);
}

/** A flat line at `v` from 0 to `len` (two points, so both ends can be dragged). */
export function flatLine(v, len) {
  const value = clamp01(v);
  return len > 0 ? [{ t: 0, v: value }, { t: Math.round(len), v: value }] : [{ t: 0, v: value }];
}

/** Inserts a point in time order. Returns { points, index } (index of the new point). */
export function addPoint(points, { t, v }) {
  const p = { t: Math.max(0, Math.round(t)), v: clamp01(v) };
  let index = points.findIndex((q) => q.t > p.t);
  if (index < 0) index = points.length;
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
  out[index] = { t: nt, v: nv };
  return out;
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
