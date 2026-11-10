/**
 * Tessellation of curves into world-space polylines with a bounded chord
 * deviation. Used by the renderer, exporters and approximate algorithms.
 */
import { TWO_PI, ccwSweep } from './vec.js';
import { arcFromBulge } from './bulge.js';
import { ellipseAxes, ellipseSweep, isFullEllipse } from './ellipse.js';
import { sampleSpline } from './spline.js';

export const MIN_CIRCLE_SEGMENTS = 8;
export const MAX_SEGMENTS = 4096;

/**
 * Number of chords for an arc of radius r and the given sweep so that the
 * chord deviation stays within tol. At least 8 per full turn, at most 4096.
 */
export function arcSegments(r, sweep, tol) {
  const s = Math.abs(sweep);
  if (!(r > 0) || !(s > 0)) return 1;
  if (!(tol > 0)) tol = r * 1e-3;
  const c = 1 - tol / r;
  const step = c <= -1 ? TWO_PI : 2 * Math.acos(c);
  let n = Math.ceil(s / step - 1e-9);
  const lo = Math.ceil((MIN_CIRCLE_SEGMENTS * s) / TWO_PI - 1e-9);
  if (n < lo) n = lo;
  if (n < 1) n = 1;
  return n > MAX_SEGMENTS ? MAX_SEGMENTS : n;
}

/**
 * How many times finer than MAX_SEGMENTS chords an arc must be split to keep
 * the chord deviation within tol (1 when the limit is fine enough).
 */
function fineFactor(r, sweep, tol) {
  if (!(tol > 0) || !(r > 0)) return 1;
  const x = tol / r;
  // acos(1 - x) loses its digits for tiny x; sqrt(2x) is its leading term.
  const step = x < 1e-8 ? 2 * Math.sqrt(2 * x) : 2 * Math.acos(1 - x);
  const k = Math.ceil(Math.abs(sweep) / step / MAX_SEGMENTS - 1e-9);
  return k > 1 ? (k < FINE_MAX ? k : FINE_MAX) : 1;
}

/** Limits of view-dependent refinement: per chord, and points added per call. */
const FINE_MAX = 1 << 14;
const FINE_BUDGET = 1 << 16;

/**
 * View-dependent tessellation (the screen renderer): `clip` is
 * { box: () => [minX, minY, maxX, maxY], state: { used } }. A curve that needs
 * more than MAX_SEGMENTS chords gets them only where it passes through the
 * box, and state.used is set: the result is then good only for views inside
 * the box. The points are those of the plain tessellation plus the extra
 * ones in between.
 *
 * appendFine adds the points of n chords of a curve given by `at(t, out)`
 * (pushes x, y) over t0 .. t0 + sweep, splitting each chord that comes within
 * `pad` (its distance from the curve) of the box k times finer.
 */
function appendFine(out, at, t0, sweep, n, k, pad, clip, withStart) {
  clip.state.used = true;
  const box = clip.box();
  const x0 = box[0] - pad,
    y0 = box[1] - pad,
    x1 = box[2] + pad,
    y1 = box[3] + pad;
  const p = [];
  at(t0, p);
  let px = p[0],
    py = p[1];
  if (withStart) out.push(px, py);
  let budget = FINE_BUDGET;
  for (let i = 1; i <= n; i++) {
    const ta = t0 + (sweep * (i - 1)) / n,
      tb = t0 + (sweep * i) / n;
    p.length = 0;
    at(tb, p);
    const x = p[0],
      y = p[1];
    if (budget > 0 && !((px < x0 && x < x0) || (px > x1 && x > x1) || (py < y0 && y < y0) || (py > y1 && y > y1))) {
      for (let m = 1; m < k; m++) at(ta + ((tb - ta) * m) / k, out);
      budget -= k;
    }
    out.push(x, y);
    px = x;
    py = y;
  }
  return out;
}

/** appendArc with view-dependent refinement (see appendFine). */
function appendArcFine(out, cx, cy, r, a0, sweep, n, tol, clip, withStart = true) {
  const k = fineFactor(r, sweep, tol);
  if (k < 2) return appendArc(out, cx, cy, r, a0, sweep, n, withStart);
  const half = Math.abs(sweep) / n / 2;
  const at = (a, o) => o.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  return appendFine(out, at, a0, sweep, n, k, r * half * half * 0.51, clip, withStart);
}

/** Append points of an arc (a0 .. a0 + sweep, signed) to out, n chords. */
export function appendArc(out, cx, cy, r, a0, sweep, n, withStart = true) {
  for (let i = withStart ? 0 : 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

/** Flat points of an ellipse arc (parametric t0 .. t0 + sweep), n chords. */
export function appendEllipse(out, e, t0, sweep, n, withStart = true) {
  const r = e.ratio;
  for (let i = withStart ? 0 : 1; i <= n; i++) {
    const t = t0 + (sweep * i) / n;
    const c = Math.cos(t),
      s = Math.sin(t);
    out.push(e.cx + e.mx * c - r * e.my * s, e.cy + e.my * c + r * e.mx * s);
  }
  return out;
}

/**
 * Flat points of a stride-3 bulged point list (polyline or hatch loop). For
 * closed lists the closing segment is included but the first point is not
 * repeated.
 */
export function bulgePolyPoints(pts, closed, tol, clip) {
  const n = Math.floor(pts.length / 3);
  const out = [];
  if (n === 0) return out;
  const segs = closed ? n : n - 1;
  out.push(pts[0], pts[1]);
  for (let i = 0; i < segs; i++) {
    const a = i * 3,
      j = (i + 1) % n,
      b = j * 3;
    const x1 = pts[a],
      y1 = pts[a + 1],
      x2 = pts[b],
      y2 = pts[b + 1];
    const arc = arcFromBulge(x1, y1, x2, y2, pts[a + 2]);
    if (arc) {
      const k = arcSegments(arc.r, arc.sweep, tol);
      if (k === MAX_SEGMENTS && clip) {
        appendArcFine(out, arc.cx, arc.cy, arc.r, arc.a0, arc.sweep, k, tol, clip, false);
        out.length -= 2;
      } else for (let m = 1; m < k; m++) {
        const ang = arc.a0 + (arc.sweep * m) / k;
        out.push(arc.cx + arc.r * Math.cos(ang), arc.cy + arc.r * Math.sin(ang));
      }
    }
    if (j !== 0 || !closed) out.push(x2, y2);
  }
  return out;
}

/** Number of chords for an elliptical sweep (uniform parametric steps). */
export function ellipseSegments(e, sweep, tol) {
  // Uniform parametric steps deviate at most like a circle of the major radius.
  return arcSegments(ellipseAxes(e).a, sweep, tol);
}

/**
 * Tessellate an entity into world-space polylines: [{ pts, closed }].
 * tol is the maximum chord deviation in world units. Non-curve entities
 * (text, dimensions, inserts, xlines, rays, points) return []. `clip`
 * (optional) makes circles, arcs, ellipses and polyline arcs too large for
 * MAX_SEGMENTS chords exact inside a box around the view: see appendFine.
 */
export function tessellate(ent, tol, clip) {
  switch (ent.type) {
    case 'line':
      return [{ pts: [ent.x1, ent.y1, ent.x2, ent.y2], closed: false }];
    case 'circle': {
      const n = Math.max(MIN_CIRCLE_SEGMENTS, arcSegments(ent.r, TWO_PI, tol));
      const pts =
        n === MAX_SEGMENTS && clip
          ? appendArcFine([], ent.cx, ent.cy, ent.r, 0, TWO_PI, n, tol, clip)
          : appendArc([], ent.cx, ent.cy, ent.r, 0, TWO_PI, n);
      pts.length -= 2;
      return [{ pts, closed: true }];
    }
    case 'arc': {
      const sw = ccwSweep(ent.start, ent.end);
      const n = arcSegments(ent.r, sw, tol);
      if (n === MAX_SEGMENTS && clip) return [{ pts: appendArcFine([], ent.cx, ent.cy, ent.r, ent.start, sw, n, tol, clip), closed: false }];
      return [{ pts: appendArc([], ent.cx, ent.cy, ent.r, ent.start, sw, n), closed: false }];
    }
    case 'ellipse': {
      const full = isFullEllipse(ent);
      const sw = ellipseSweep(ent);
      const t0 = full ? 0 : ent.start;
      const n = Math.max(full ? MIN_CIRCLE_SEGMENTS : 1, ellipseSegments(ent, sw, tol));
      let pts;
      if (n === MAX_SEGMENTS && clip) {
        // Uniform parametric steps deviate at most like a circle of the major radius.
        const a = ellipseAxes(ent).a;
        const k = fineFactor(a, sw, tol);
        const half = Math.abs(sw) / n / 2;
        const r = ent.ratio;
        const at = (t, o) => {
          const c = Math.cos(t),
            s = Math.sin(t);
          o.push(ent.cx + ent.mx * c - r * ent.my * s, ent.cy + ent.my * c + r * ent.mx * s);
        };
        pts = k < 2 ? appendEllipse([], ent, t0, sw, n) : appendFine([], at, t0, sw, n, k, a * half * half * 0.51, clip, true);
      } else pts = appendEllipse([], ent, t0, sw, n);
      if (full) pts.length -= 2;
      return [{ pts, closed: full }];
    }
    case 'polyline': {
      if (ent.pts.length < 6) return [];
      return [{ pts: bulgePolyPoints(ent.pts, !!ent.closed, tol, clip), closed: !!ent.closed }];
    }
    case 'spline': {
      const pts = sampleSpline(ent, tol).pts;
      if (pts.length < 4) return [];
      let closed = !!ent.closed;
      if (closed) {
        const n = pts.length;
        const scale = Math.max(1, Math.abs(pts[0]), Math.abs(pts[1]));
        if (Math.abs(pts[n - 2] - pts[0]) + Math.abs(pts[n - 1] - pts[1]) <= 1e-9 * scale) pts.length -= 2;
      }
      return [{ pts, closed }];
    }
    case 'leader':
      return ent.pts.length >= 4 ? [{ pts: ent.pts.slice(), closed: false }] : [];
    case 'hatch':
      return (ent.loops || []).filter((l) => l.length >= 6).map((l) => ({ pts: bulgePolyPoints(l, true, tol), closed: true }));
    default:
      return [];
  }
}
