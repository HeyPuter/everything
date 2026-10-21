/**
 * Crop regions: clip a view's 2D graphics to a rectangle { x0, y0, x1, y1 }.
 * Lines are clipped segment by segment, fills polygon by polygon, and text
 * outside the rectangle is dropped.
 */
import { PlanBuilder } from './plan.js';

/** Part of segment ab inside the rectangle, or null. */
export function clipSegment(a, b, r) {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const edges = [
    [-dx, a[0] - r.x0],
    [dx, r.x1 - a[0]],
    [-dy, a[1] - r.y0],
    [dy, r.y1 - a[1]],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [
    [a[0] + dx * t0, a[1] + dy * t0],
    [a[0] + dx * t1, a[1] + dy * t1],
  ];
}

/** Polygon clipped to the rectangle (may be empty). */
export function clipPolygon(poly, r) {
  let out = poly;
  const sides = [
    (p) => p[0] - r.x0,
    (p) => r.x1 - p[0],
    (p) => p[1] - r.y0,
    (p) => r.y1 - p[1],
  ];
  for (const f of sides) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i];
      const b = src[(i + 1) % src.length];
      const fa = f(a);
      const fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) {
        const t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    if (out.length < 3) return [];
  }
  return out;
}

function inside(p, r) {
  return p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1;
}

/** Graphics clipped to a crop rectangle, or null when nothing is left. */
export function cropGraphics(g, r) {
  if (!g) return g;
  const bb = g.bounds();
  if (!bb) return g;
  if (bb.x0 >= r.x0 && bb.x1 <= r.x1 && bb.y0 >= r.y0 && bb.y1 <= r.y1) return g;
  if (bb.x1 < r.x0 || bb.x0 > r.x1 || bb.y1 < r.y0 || bb.y0 > r.y1) return null;
  const b = new PlanBuilder();
  for (const l of g.lines) {
    const s = clipSegment(l.a, l.b, r);
    if (s) b.lines.push({ ...l, a: s[0], b: s[1] });
  }
  for (const f of g.fills) {
    const poly = clipPolygon(f.poly, r);
    if (poly.length < 3) continue;
    b.fills.push({ ...f, poly, holes: (f.holes || []).map((h) => clipPolygon(h, r)).filter((h) => h.length >= 3) });
  }
  for (const t of g.texts) if (inside(t.at, r)) b.texts.push(t);
  for (const p of g.picks) {
    const q = clipPolygon(p, r);
    if (q.length >= 3) b.picks.push(q);
  }
  return b.empty ? null : b;
}

/** Normalised rectangle from two corners. */
export function rectOf(a, b) {
  return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
}
