/**
 * Scalar, point and angle helpers shared by the geometry kernel.
 *
 * Angles are radians, counter-clockwise from +X. A CCW sweep is described by
 * a start angle a0 and a positive sweep s, covering a0 .. a0 + s.
 */
import { TWO_PI } from '../schema.js';

export { TWO_PI };
export const HALF_PI = Math.PI / 2;

/** Relative tolerance for geometric comparisons. */
export const EPS = 1e-9;

/** Absolute tolerance for values of the given magnitude(s). */
export function tolFor(a, b = 0, c = 0) {
  return EPS * Math.max(1, Math.abs(a), Math.abs(b), Math.abs(c));
}

export function dist(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

export function dist2(x1, y1, x2, y2) {
  const dx = x2 - x1,
    dy = y2 - y1;
  return dx * dx + dy * dy;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalize an angle to [0, 2PI). */
export function normAngle(a) {
  if (a >= 0 && a < TWO_PI) return a;
  if (!Number.isFinite(a)) return 0;
  a %= TWO_PI;
  if (a < 0) a += TWO_PI;
  return a >= TWO_PI ? 0 : a;
}

/** Wrap an angle to (-PI, PI]. */
export function wrapPi(a) {
  a = normAngle(a);
  return a > Math.PI ? a - TWO_PI : a;
}

/** CCW sweep from a0 to a1 in (0, 2PI]. Equal angles mean a full turn. */
export function ccwSweep(a0, a1) {
  const s = normAngle(a1 - a0);
  return s === 0 ? TWO_PI : s;
}

/** True when angle a lies on the CCW sweep starting at a0 (eps in radians). */
export function angleInSweep(a, a0, sweep, eps = 1e-12) {
  if (sweep >= TWO_PI - eps) return true;
  const d = normAngle(a - a0);
  return d <= sweep + eps || d >= TWO_PI - eps;
}

/**
 * Offset of angle a from a0 along a CCW sweep, chosen in the window centred
 * on the sweep, so points just before a0 come out slightly negative.
 */
export function sweepOffset(a, a0, sweep) {
  const d = normAngle(a - a0);
  return d > sweep / 2 + Math.PI ? d - TWO_PI : d;
}

/** Angle of the vector (x, y) in [0, 2PI). */
export function angleOf(x, y) {
  return normAngle(Math.atan2(y, x));
}

/** 2D cross product. */
export function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

/** Bounding box helper: grow box [minX, minY, maxX, maxY] in place. */
export function growBox(box, x, y) {
  if (x < box[0]) box[0] = x;
  if (y < box[1]) box[1] = y;
  if (x > box[2]) box[2] = x;
  if (y > box[3]) box[3] = y;
  return box;
}

/**
 * dedupePoints for long lists: kept points go into a grid of tol-sized cells,
 * so each point is only compared with the kept points around it. Returns
 * null when the grid cannot index the points (their extent is astronomically
 * larger than tol).
 */
function dedupeGrid(pts, tol) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  }
  if (!(Math.max(x1 - x0, y1 - y0) / tol < 1e12)) return null;
  const cols = new Map();
  const out = [];
  const t2 = tol * tol;
  outer: for (const p of pts) {
    const ix = Math.floor((p.x - x0) / tol),
      iy = Math.floor((p.y - y0) / tol);
    // Two cells each way: one for the distance, one for rounding in the division.
    for (let i = ix - 2; i <= ix + 2; i++) {
      const col = cols.get(i);
      if (!col) continue;
      for (let j = iy - 2; j <= iy + 2; j++) {
        const cell = col.get(j);
        if (cell) for (const q of cell) if (dist2(p.x, p.y, q.x, q.y) <= t2) continue outer;
      }
    }
    let col = cols.get(ix);
    if (!col) cols.set(ix, (col = new Map()));
    const cell = col.get(iy);
    if (cell) cell.push(p);
    else col.set(iy, [p]);
    out.push(p);
  }
  return out;
}

/** Remove points closer than tol to an already kept point. */
export function dedupePoints(pts, tol) {
  if (pts.length < 2) return pts;
  if (pts.length > 64 && tol > 0) {
    const fast = dedupeGrid(pts, tol);
    if (fast) return fast;
  }
  const out = [];
  const t2 = tol * tol;
  outer: for (const p of pts) {
    for (const q of out) if (dist2(p.x, p.y, q.x, q.y) <= t2) continue outer;
    out.push(p);
  }
  return out;
}
