/**
 * Live corners: an anchor can carry `corner: { r, type, rounding? }` (type
 * 'round', 'inverted' or 'chamfer'; rounding 'absolute' (default: r is the
 * arc's radius) or 'relative' (r is how far the corner reaches along each
 * segment, so the curve follows the corner's angle)). The path keeps its sharp anchor for editing and
 * draws (and hit tests, measures and exports) with the corner cut: the two
 * neighboring segments are trimmed by the distance a circle of radius r
 * tangent to both would touch them, and the gap is joined by an arc, an
 * inverted arc around the corner point, or a straight chamfer. Trims are
 * limited to half of each neighboring segment so neighboring corners never
 * overlap; cornerLimits() reports when a corner is held at that limit.
 */
import { segmentPoints, segmentCount, split, isLine, cubicLength } from './bezier.js';

const EPS = 1e-9;

function unit(x, y) {
  const l = Math.hypot(x, y);
  return l < EPS ? null : { x: x / l, y: y / l };
}

/** Tangent directions at anchor i: { back: toward the previous segment, ahead: along the next }. */
function tangents(anchors, closed, i) {
  const n = anchors.length;
  if (!closed && (i === 0 || i === n - 1)) return null;
  const a = anchors[i];
  const p = anchors[(i - 1 + n) % n];
  const q = anchors[(i + 1) % n];
  // A retracted handle points along the segment toward the next control point.
  const back = unit(a.ix - a.x, a.iy - a.y) || unit(p.ox - a.x, p.oy - a.y) || unit(p.x - a.x, p.y - a.y);
  const ahead = unit(a.ox - a.x, a.oy - a.y) || unit(q.ix - a.x, q.iy - a.y) || unit(q.x - a.x, q.y - a.y);
  return back && ahead ? { back, ahead } : null;
}

/**
 * Geometry of the corner at anchor i, or null when it is not a corner (an
 * end point, or smooth): { x, y, back, ahead, theta (interior angle,
 * radians), bisector (unit vector into the corner) }.
 */
export function cornerGeometry(anchors, closed, i) {
  const t = tangents(anchors, closed, i);
  if (!t) return null;
  const cos = Math.max(-1, Math.min(1, t.back.x * t.ahead.x + t.back.y * t.ahead.y));
  const theta = Math.acos(cos);
  // Nearly straight (smooth) or folded back: no corner to round.
  if (theta > Math.PI - 0.02 || theta < 0.02) return null;
  const bisector = unit(t.back.x + t.ahead.x, t.back.y + t.ahead.y);
  if (!bisector) return null;
  const a = anchors[i];
  return { x: a.x, y: a.y, back: t.back, ahead: t.ahead, theta, bisector };
}

/** Distance along each segment that a corner of radius r trims. */
export function trimFor(r, theta) {
  return r / Math.tan(theta / 2);
}

/** Radius for a trim distance. */
export function radiusFor(d, theta) {
  return d * Math.tan(theta / 2);
}

/** A cubic whose control points all lie on its chord (straight, whatever its handles). */
function isStraight(c) {
  if (isLine(c)) return true;
  const dx = c[6] - c[0];
  const dy = c[7] - c[1];
  const L = Math.hypot(dx, dy);
  if (L < EPS) return false;
  const off = (x, y) => Math.abs((x - c[0]) * dy - (y - c[1]) * dx) / L;
  const along = (x, y) => ((x - c[0]) * dx + (y - c[1]) * dy) / (L * L);
  const inside = (x, y) => along(x, y) >= -1e-9 && along(x, y) <= 1 + 1e-9;
  return off(c[2], c[3]) < 1e-9 && off(c[4], c[5]) < 1e-9 && inside(c[2], c[3]) && inside(c[4], c[5]);
}

function segLength(c) {
  return isStraight(c) ? Math.hypot(c[6] - c[0], c[7] - c[1]) : cubicLength(c, 0.05);
}

/** Parameter t on cubic c where the arc length from the start is `len`. */
function paramAt(c, len) {
  if (len <= 0) return 0;
  if (isStraight(c)) {
    const L = Math.hypot(c[6] - c[0], c[7] - c[1]);
    // A straight cubic with retracted handles is not linear in t; invert its x/y progress.
    return L < EPS ? 0 : lineParam(c, Math.min(1, len / L));
  }
  const N = 256;
  let acc = 0;
  let px = c[0];
  let py = c[1];
  for (let k = 1; k <= N; k++) {
    const t = k / N;
    const mt = 1 - t;
    const x = mt * mt * mt * c[0] + 3 * mt * mt * t * c[2] + 3 * mt * t * t * c[4] + t * t * t * c[6];
    const y = mt * mt * mt * c[1] + 3 * mt * mt * t * c[3] + 3 * mt * t * t * c[5] + t * t * t * c[7];
    const step = Math.hypot(x - px, y - py);
    if (acc + step >= len) return (k - 1 + (len - acc) / Math.max(step, EPS)) / N;
    acc += step;
    px = x;
    py = y;
  }
  return 1;
}

/** t for a fraction f of a straight cubic's length (handles may be retracted or anywhere on the line). */
function lineParam(c, f) {
  let lo = 0;
  let hi = 1;
  const L = Math.hypot(c[6] - c[0], c[7] - c[1]);
  for (let k = 0; k < 40; k++) {
    const t = (lo + hi) / 2;
    const mt = 1 - t;
    const x = mt * mt * mt * c[0] + 3 * mt * mt * t * c[2] + 3 * mt * t * t * c[4] + t * t * t * c[6];
    const y = mt * mt * mt * c[1] + 3 * mt * mt * t * c[3] + 3 * mt * t * t * c[5] + t * t * t * c[7];
    if (Math.hypot(x - c[0], y - c[1]) / L < f) lo = t;
    else hi = t;
  }
  return (lo + hi) / 2;
}

export function hasCorners(anchors) {
  return anchors.some((a) => a.corner && a.corner.r > 0);
}

/**
 * Trim distance actually used at each anchor (0 for none) and whether it
 * was limited: [{ d, limited, geom }].
 */
export function cornerLimits(anchors, closed) {
  const n = anchors.length;
  const segs = segmentCount(anchors, closed);
  const lens = [];
  for (let s = 0; s < segs; s++) lens.push(segLength(segmentPoints(anchors, s)));
  return anchors.map((a, i) => {
    const r = a.corner?.r || 0;
    if (!(r > 0)) return { d: 0, limited: false, geom: null };
    const geom = cornerGeometry(anchors, closed, i);
    if (!geom) return { d: 0, limited: false, geom: null };
    // Absolute rounding is a true radius; relative rounding measures r along the segments.
    const want = a.corner.rounding === 'relative' ? r : trimFor(r, geom.theta);
    const prev = lens[(i - 1 + n) % n] ?? 0;
    const next = lens[i] ?? 0;
    const max = Math.min(prev, next) / 2;
    return { d: Math.min(want, max), limited: want > max + 1e-6, geom };
  });
}

/** Anchors as drawn: every corner with a radius cut and joined by its corner shape. */
export function applyCorners(anchors, closed) {
  const n = anchors.length;
  if (n < 3 || !hasCorners(anchors)) return anchors;
  const lim = cornerLimits(anchors, closed);
  const segs = segmentCount(anchors, closed);
  // The middle part of every segment after trimming its two ends.
  const mids = [];
  for (let s = 0; s < segs; s++) {
    let c = segmentPoints(anchors, s);
    const L = segLength(c);
    const d0 = lim[s].d;
    const d1 = lim[(s + 1) % n].d;
    if (d1 > 0) {
      const t1 = paramAt(c, Math.max(0, L - d1));
      c = split(c, t1)[0];
    }
    if (d0 > 0) {
      const t0 = paramAt(c, d0);
      c = split(c, t0)[1];
    }
    mids.push(c);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = anchors[i];
    const prevMid = mids[(i - 1 + segs) % segs];
    const nextMid = i < segs ? mids[i] : null;
    const hasPrev = closed || i > 0;
    const { d, geom } = lim[i];
    if (!(d > 0) || !geom || !prevMid || !nextMid || !hasPrev) {
      out.push({
        x: a.x,
        y: a.y,
        ix: hasPrev && prevMid ? prevMid[4] : a.ix,
        iy: hasPrev && prevMid ? prevMid[5] : a.iy,
        ox: nextMid ? nextMid[2] : a.ox,
        oy: nextMid ? nextMid[3] : a.oy,
      });
      continue;
    }
    const p1 = { x: prevMid[6], y: prevMid[7] };
    const p2 = { x: nextMid[0], y: nextMid[1] };
    const type = a.corner.type || 'round';
    let h1 = { x: p1.x, y: p1.y };
    let h2 = { x: p2.x, y: p2.y };
    if (type === 'round') {
      // Arc tangent to both segments: radius from the trim actually used.
      const r = radiusFor(d, geom.theta);
      const phi = Math.PI - geom.theta;
      const k = (4 / 3) * Math.tan(phi / 4) * r;
      // Leaving p1 toward the corner, arriving at p2 from the corner.
      const in1 = unit(a.x - p1.x, a.y - p1.y) || { x: -geom.back.x, y: -geom.back.y };
      const in2 = unit(a.x - p2.x, a.y - p2.y) || geom.ahead;
      h1 = { x: p1.x + in1.x * k, y: p1.y + in1.y * k };
      h2 = { x: p2.x + in2.x * k, y: p2.y + in2.y * k };
    } else if (type === 'inverted') {
      // Arc of radius d around the corner point, bulging away from it.
      const k = (4 / 3) * Math.tan(geom.theta / 4) * d;
      const r1 = unit(p1.x - a.x, p1.y - a.y);
      const r2 = unit(p2.x - a.x, p2.y - a.y);
      if (r1 && r2) {
        // Tangents perpendicular to the radii, turning from p1 toward p2.
        const sgn = r1.x * r2.y - r1.y * r2.x >= 0 ? 1 : -1;
        const t1 = { x: -r1.y * sgn, y: r1.x * sgn };
        const t2 = { x: r2.y * sgn, y: -r2.x * sgn };
        h1 = { x: p1.x + t1.x * k, y: p1.y + t1.y * k };
        h2 = { x: p2.x + t2.x * k, y: p2.y + t2.y * k };
      }
    }
    out.push({ x: p1.x, y: p1.y, ix: prevMid[4], iy: prevMid[5], ox: h1.x, oy: h1.y });
    out.push({ x: p2.x, y: p2.y, ix: h2.x, iy: h2.y, ox: nextMid[2], oy: nextMid[3] });
  }
  // An open path's first anchor never had a previous segment: keep its own in-handle.
  return out;
}
