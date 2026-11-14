/**
 * Corners for the freehand tools (Pencil, Paintbrush, Merge Brush): with the
 * Corners setting on, sharp turns in a stroke stay sharp while Fidelity and
 * Smoothing still smooth the stretches between them.
 *
 * Corners are found on the pen's own samples (before Smoothing). A point is
 * a corner when the direction of the stroke just before it and just after it
 * differ by at least the angle the setting allows, and the turn is
 * concentrated there: along a curve the turn grows with the distance looked
 * at, at a corner it stays the same. A pen slowing down into the turn counts
 * in its favour. Distances are in screen pixels, so it works the same at
 * every zoom; the stroke is averaged over a few pixels first so pen jitter
 * is not taken for corners.
 *
 * The stroke is then fitted piece by piece between its corners, each corner
 * becoming an anchor with independent handles; with Smoothing on, the
 * pulled string restarts at each corner instead of cutting across it.
 */
import { fitCurve, simplifyPolyline } from '../model/bezier.js';

/** Distance (screen pixels) over which the direction on each side of a point is measured. */
export const CORNER_WINDOW_PX = 10;

/** Below this share of the stroke's typical speed the pen counts as slowing into a corner. */
const SLOW = 0.35;

/** The smallest turn (degrees) that counts as a corner for a Corners amount 0 (off) .. 100. */
export function cornerAngle(amount) {
  const a = Math.max(0, Math.min(100, Number(amount) || 0));
  return a > 0 ? 130 - a * 1.1 : Infinity;
}

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** Each point averaged with its neighbors within `r` along the stroke (symmetrically, so the ends stay put). */
function averaged(points, r) {
  const n = points.length;
  const arc = new Float64Array(n);
  const sx = new Float64Array(n + 1);
  const sy = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    if (i) arc[i] = arc[i - 1] + dist(points[i - 1], points[i]);
    sx[i + 1] = sx[i] + points[i].x;
    sy[i + 1] = sy[i] + points[i].y;
  }
  const out = new Array(n);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (arc[i] - arc[lo] > r) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && arc[hi + 1] - arc[i] <= r) hi++;
    const k = Math.min(i - lo, hi - i);
    const c = 2 * k + 1;
    out[i] = { x: (sx[i + k + 1] - sx[i - k]) / c, y: (sy[i + k + 1] - sy[i - k]) / c };
  }
  return out;
}

const ENDED = -1;
const WOUND = -2;

/**
 * The first point from `i` (stepping by `dir`) at least `d` away from it in a
 * straight line; ENDED when the stroke ends first, WOUND when it winds back
 * on itself (goes on for three times as far along it, or curls round to
 * its end).
 */
function reach(pts, i, dir, d) {
  let along = 0;
  let k = i + dir;
  for (; k >= 0 && k < pts.length; k += dir) {
    along += dist(pts[k - dir], pts[k]);
    if (dist(pts[i], pts[k]) >= d) return k;
    if (along > d * 3) return WOUND;
  }
  return along > dist(pts[i], pts[k - dir]) * 1.3 ? WOUND : ENDED;
}

/**
 * The turn (degrees) at point i: between the direction of the stroke from
 * 1.5w to 0.5w before it and from 0.5w to 1.5w after it. Null near the ends
 * and where the stroke winds back on itself; with `toEnds`, an arm the end
 * of the stroke cuts short is measured up to the end instead.
 */
function turnAt(pts, i, w, toEnds = false) {
  const a1 = reach(pts, i, -1, w / 2);
  const b1 = reach(pts, i, 1, w / 2);
  if (a1 < 0 || b1 < 0) return null;
  let a0 = reach(pts, i, -1, w * 1.5);
  let b0 = reach(pts, i, 1, w * 1.5);
  if (toEnds && a0 === ENDED && a1 > 0) a0 = 0;
  if (toEnds && b0 === ENDED && b1 < pts.length - 1) b0 = pts.length - 1;
  if (a0 < 0 || b0 < 0) return null;
  const ux = pts[a1].x - pts[a0].x;
  const uy = pts[a1].y - pts[a0].y;
  const vx = pts[b0].x - pts[b1].x;
  const vy = pts[b0].y - pts[b1].y;
  const l = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (!(l > 0)) return null;
  return (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / l))) * 180) / Math.PI;
}

/** Which points the pen slowed down at (from timestamps), or null without usable times. */
function slowPoints(points, times, zoom) {
  const n = points.length;
  if (!times || times.length !== n || !times.every(Number.isFinite)) return null;
  const speed = points.map((_, i) => {
    const a = Math.max(0, i - 2);
    const b = Math.min(n - 1, i + 2);
    let d = 0;
    for (let k = a; k < b; k++) d += dist(points[k], points[k + 1]);
    return (d * zoom) / Math.max(1, times[b] - times[a]);
  });
  const sorted = speed.filter((s) => s > 0).sort((x, y) => x - y);
  if (!sorted.length) return null;
  const typical = sorted[Math.floor(sorted.length / 2)];
  return speed.map((s) => s < typical * SLOW);
}

/**
 * Indices of the corners of a stroke (pen samples in document units), in
 * order, never its first or last point.
 * @param {{x:number,y:number}[]} points
 * @param {{amount?:number, zoom?:number, times?:number[]|null}} opts
 *   amount: the Corners setting 0 (off) .. 100; times: a timestamp (ms) per
 *   point, if known.
 */
export function detectCorners(points, { amount = 0, zoom = 1, times = null } = {}) {
  const limit = cornerAngle(amount);
  const n = points?.length || 0;
  if (!Number.isFinite(limit) || n < 5) return [];
  const z = zoom > 0 ? zoom : 1;
  const w = CORNER_WINDOW_PX / z;
  const pts = averaged(points, w / 2);
  const slow = slowPoints(points, times, z);
  const found = [];
  for (let i = 1; i < n - 1; i++) {
    const turn = turnAt(pts, i, w);
    if (turn == null || turn < (slow?.[i] ? limit * 0.75 : limit)) continue;
    // On a curve, looking twice as far sees about twice the turn; at a corner, the same.
    const wide = turnAt(pts, i, w * 2, true);
    if (wide == null || turn < wide * 0.85) continue;
    found.push(i);
  }
  // Neighboring candidates are one corner: the pen sample farthest out from the chord across it
  // (the averaged stroke rounds the corner, so its own farthest point can sit beside it).
  const corners = [];
  let g = 0;
  while (g < found.length) {
    let e = g;
    while (e + 1 < found.length && dist(pts[found[e]], pts[found[e + 1]]) < w / 2) e++;
    const mid = found[(g + e) >> 1];
    const a = Math.max(0, reach(pts, mid, -1, w));
    const b = reach(pts, mid, 1, w);
    const end = b < 0 ? n - 1 : b;
    let best = mid;
    let bestD = -1;
    const ax = points[a].x;
    const ay = points[a].y;
    const dx = points[end].x - ax;
    const dy = points[end].y - ay;
    const len = Math.hypot(dx, dy) || 1;
    for (let k = a + 1; k < end; k++) {
      const d = Math.abs((points[k].x - ax) * dy - (points[k].y - ay) * dx) / len;
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    const prev = corners[corners.length - 1];
    if (best > 0 && best < n - 1 && (prev == null || (best > prev && dist(points[prev], points[best]) >= w / 2))) corners.push(best);
    g = e + 1;
  }
  return corners;
}

/**
 * Smoothing (the pulled string of `length`) redone so it keeps the corners:
 * the string restarts at each corner, and the stroke reaches each corner
 * instead of cutting across it. One point per pen sample, as before.
 */
export function restoreCorners(raw, corners, length) {
  const out = raw.map((p) => ({ x: p.x, y: p.y }));
  if (!(length > 0) || !corners.length) return out;
  const stops = [0, ...corners, raw.length - 1];
  for (let j = 0; j + 1 < stops.length; j++) {
    const s = stops[j];
    const e = stops[j + 1];
    const last = j + 2 === stops.length;
    let cur = { x: raw[s].x, y: raw[s].y };
    for (let i = s + 1; i <= e; i++) {
      if (i === e && !last) break; // The corner itself, as drawn.
      const d = dist(cur, raw[i]);
      if (d > length) {
        const k = (d - length) / d;
        cur = { x: cur.x + (raw[i].x - cur.x) * k, y: cur.y + (raw[i].y - cur.y) * k };
      }
      out[i] = { ...cur };
    }
  }
  return out;
}

/**
 * Fit a stroke with cubic Beziers, piece by piece between its corners
 * (indices into `points`): the curves between them are fitted as before, and
 * each corner is an anchor whose handles point their own ways. `error` is
 * the squared fit tolerance and `simplify` the simplify tolerance, as for
 * fitCurve and simplifyPolyline.
 */
export function fitStroke(points, corners, error, simplify) {
  if (!corners?.length) return fitCurve(simplifyPolyline(points, simplify), error);
  const stops = [0, ...corners, points.length - 1];
  let out = [];
  for (let j = 0; j + 1 < stops.length; j++) {
    const piece = fitCurve(simplifyPolyline(points.slice(stops[j], stops[j + 1] + 1), simplify), error);
    if (piece.length < 2) continue;
    if (!out.length) {
      out = piece;
      continue;
    }
    const joint = out[out.length - 1];
    out[out.length - 1] = { ...joint, ox: piece[0].ox, oy: piece[0].oy };
    out.push(...piece.slice(1));
  }
  return out.length >= 2 ? out : fitCurve(simplifyPolyline(points, simplify), error);
}
