// Stroke spline conversions: change a stroke's spline type keeping its control points
// (setCurveType), or rebuild the stroke as another type that follows the same shape
// (convertCurveType: Bézier and Catmull-Rom fitting within a distance threshold, NURBS from the
// fitted Bézier, poly lines from the evaluated points). Handle type edits. Pure, unit tested.
import type { GPPoint, GPStroke } from './data';
import { fromStrokes, toStrokes } from './data';
import { evaluatedDrawing, GP_BEZIER, GP_CATMULL_ROM, GP_NURBS, GP_POLY, H_ALIGN, H_AUTO, H_FREE, H_VECTOR, KNOTS_BEZIER, KNOTS_ENDPOINT, KNOTS_ENDPOINT_BEZIER } from './curves';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const dist = (a: V3, b: V3) => len(sub(a, b));
const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0];
};

const clonePoint = (p: GPPoint, co: V3 = p.co): GPPoint => ({
  co: [...co],
  radius: p.radius,
  opacity: p.opacity,
  vertex_color: [...p.vertex_color],
  select: p.select,
  ...(p.weights ? { weights: { ...p.weights } } : {}),
  ...(p.miter_angle ? { miter_angle: p.miter_angle } : {}),
});

/** Points of the stroke without spline data (a plain point list). */
const plain = (pts: GPPoint[]) => pts.map((p) => clonePoint(p));

function withType(s: GPStroke, type: number, points: GPPoint[], extra: Partial<GPStroke> = {}): GPStroke {
  const out: GPStroke = { ...s, points, curve_type: type, resolution: s.resolution ?? 12, ...extra };
  if (type !== GP_NURBS) {
    delete out.nurbs_order;
    delete out.knots_mode;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Set Curve Type

/** Bézier handles of a Catmull-Rom spline through the points (same shape). */
function catmullHandles(pts: GPPoint[], cyclic: boolean): GPPoint[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const prev = i > 0 ? pts[i - 1].co : cyclic ? pts[n - 1].co : p.co;
    const next = i < n - 1 ? pts[i + 1].co : cyclic ? pts[0].co : p.co;
    const t = mul(sub(next as V3, prev as V3), 1 / 6);
    return { ...clonePoint(p), handle_left: sub(p.co, t), handle_right: add(p.co, t), handle_type_left: H_ALIGN, handle_type_right: H_ALIGN };
  });
}

/**
 * Change the spline type of a stroke, keeping its control points. `useHandles`: Bézier handles
 * become control points when leaving Bézier, and smooth types get matching handles when entering it.
 */
export function setCurveType(s: GPStroke, type: number, useHandles: boolean): GPStroke {
  const from = s.curve_type ?? GP_POLY;
  if (from === type) return s;
  if (type === GP_BEZIER) {
    if (from === GP_CATMULL_ROM || (useHandles && from === GP_NURBS)) return withType(s, GP_BEZIER, catmullHandles(s.points, s.cyclic));
    // poly lines keep their shape with vector handles
    return withType(
      s,
      GP_BEZIER,
      s.points.map((p) => ({ ...clonePoint(p), handle_type_left: H_VECTOR, handle_type_right: H_VECTOR, handle_left: [...p.co], handle_right: [...p.co] })),
    );
  }
  let points = plain(s.points);
  let knots = KNOTS_ENDPOINT;
  if (from === GP_BEZIER && useHandles) {
    // each control point with its two handles
    points = [];
    for (const p of s.points) {
      const l = clonePoint(p, (p.handle_left ?? p.co) as V3),
        r = clonePoint(p, (p.handle_right ?? p.co) as V3);
      l.select = r.select = p.select || p.select_left || p.select_right;
      points.push(l, clonePoint(p), r);
    }
    knots = KNOTS_BEZIER;
  }
  if (type === GP_POLY) {
    const out = withType(s, GP_POLY, points);
    delete out.curve_type;
    delete out.resolution;
    return out;
  }
  return withType(s, type, points, type === GP_NURBS ? { nurbs_order: s.nurbs_order ?? 4, knots_mode: knots } : {});
}

// ---------------------------------------------------------------------------
// Convert Curve Type (refit)

/** Poly line points of a stroke as drawn (smooth types evaluated). */
export function evaluatedPoints(s: GPStroke): GPPoint[] {
  if ((s.curve_type ?? GP_POLY) === GP_POLY) return s.points;
  const ev = toStrokes(evaluatedDrawing(fromStrokes([s])))[0];
  return ev ? ev.points.map((p) => ({ ...p, select: s.points.some((q) => q.select) })) : s.points;
}

interface BezSeg {
  p0: V3;
  c0: V3;
  c1: V3;
  p1: V3;
  /** indices of the end points in the source polyline */
  i0: number;
  i1: number;
}

const bez = (s: BezSeg, t: number): V3 => {
  const m = 1 - t;
  const a = m * m * m,
    b = 3 * m * m * t,
    c = 3 * m * t * t,
    d = t * t * t;
  return [a * s.p0[0] + b * s.c0[0] + c * s.c1[0] + d * s.p1[0], a * s.p0[1] + b * s.c0[1] + c * s.c1[1] + d * s.p1[1], a * s.p0[2] + b * s.c0[2] + c * s.c1[2] + d * s.p1[2]];
};
const bezD1 = (s: BezSeg, t: number): V3 => {
  const m = 1 - t;
  return add(add(mul(sub(s.c0, s.p0), 3 * m * m), mul(sub(s.c1, s.c0), 6 * m * t)), mul(sub(s.p1, s.c1), 3 * t * t));
};
const bezD2 = (s: BezSeg, t: number): V3 => add(mul(add(sub(s.c1, mul(s.c0, 2)), s.p0), 6 * (1 - t)), mul(add(sub(s.p1, mul(s.c1, 2)), s.c0), 6 * t));

/** Least-squares cubic through pts[first..last] with fixed end tangents (Schneider's method). */
function generateBezier(P: V3[], first: number, last: number, u: number[], t1: V3, t2: V3): BezSeg {
  const n = last - first + 1;
  let c00 = 0,
    c01 = 0,
    c11 = 0,
    x0 = 0,
    x1 = 0;
  const p0 = P[first],
    p3 = P[last];
  for (let i = 0; i < n; i++) {
    const t = u[i],
      m = 1 - t;
    const b0 = m * m * m,
      b1 = 3 * m * m * t,
      b2 = 3 * m * t * t,
      b3 = t * t * t;
    const a1 = mul(t1, b1),
      a2 = mul(t2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(P[first + i], add(add(mul(p0, b0 + b1), mul(p3, b2 + b3)), [0, 0, 0]));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = det ? (x0 * c11 - x1 * c01) / det : 0,
    alpha2 = det ? (c00 * x1 - c01 * x0) / det : 0;
  const segLen = dist(p0, p3);
  const eps = 1e-6 * segLen;
  if (!det || alpha1 < eps || alpha2 < eps) alpha1 = alpha2 = segLen / 3;
  return { p0, c0: add(p0, mul(t1, alpha1)), c1: add(p3, mul(t2, alpha2)), p1: p3, i0: first, i1: last };
}

function chordParams(P: V3[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + dist(P[i], P[i - 1]));
  const total = u[u.length - 1] || 1;
  return u.map((x) => x / total);
}

function maxError(P: V3[], seg: BezSeg, u: number[]): { err: number; split: number } {
  let err = 0,
    split = Math.floor((seg.i0 + seg.i1) / 2);
  for (let i = seg.i0 + 1; i < seg.i1; i++) {
    const d = dist(bez(seg, u[i - seg.i0]), P[i]);
    if (d > err) {
      err = d;
      split = i;
    }
  }
  return { err, split };
}

function reparameterize(P: V3[], seg: BezSeg, u: number[]): number[] {
  return u.map((t, k) => {
    const p = P[seg.i0 + k];
    const q = sub(bez(seg, t), p);
    const d1 = bezD1(seg, t),
      d2 = bezD2(seg, t);
    const den = dot(d1, d1) + dot(q, d2);
    if (!den) return t;
    return Math.min(1, Math.max(0, t - dot(q, d1) / den));
  });
}

function fitCubic(P: V3[], first: number, last: number, t1: V3, t2: V3, error: number, out: BezSeg[]) {
  if (last - first === 1) {
    const d = dist(P[first], P[last]) / 3;
    out.push({ p0: P[first], c0: add(P[first], mul(t1, d)), c1: add(P[last], mul(t2, d)), p1: P[last], i0: first, i1: last });
    return;
  }
  let u = chordParams(P, first, last);
  let seg = generateBezier(P, first, last, u, t1, t2);
  let { err, split } = maxError(P, seg, u);
  if (err < error) {
    out.push(seg);
    return;
  }
  if (err < error * 4) {
    for (let k = 0; k < 6; k++) {
      u = reparameterize(P, seg, u);
      seg = generateBezier(P, first, last, u, t1, t2);
      ({ err, split } = maxError(P, seg, u));
      if (err < error) {
        out.push(seg);
        return;
      }
    }
  }
  split = Math.min(last - 1, Math.max(first + 1, split));
  let tc = norm(sub(P[split - 1], P[split + 1]));
  if (!len(tc)) tc = norm(sub(P[split - 1], P[split]));
  fitCubic(P, first, split, t1, tc, error, out);
  fitCubic(P, split, last, mul(tc, -1), t2, error, out);
}

/** Bézier segments following a poly line within `error` (distance). */
export function fitBezier(P: V3[], error: number, cyclic = false): BezSeg[] {
  const pts = cyclic && P.length > 2 ? [...P, P[0]] : P;
  const n = pts.length;
  if (n < 2) return [];
  const out: BezSeg[] = [];
  const e = Math.max(1e-6, error);
  let t1 = norm(sub(pts[1], pts[0])),
    t2 = norm(sub(pts[n - 2], pts[n - 1]));
  if (cyclic && P.length > 2) {
    // a shared tangent at the seam keeps the closed curve smooth
    const tc = norm(sub(pts[1], pts[n - 2]));
    t1 = tc;
    t2 = mul(tc, -1);
  }
  fitCubic(pts, 0, n - 1, t1, t2, e, out);
  return out;
}

/** Bézier stroke following the stroke's shape. Inner handles are aligned, end handles free. */
function toBezier(s: GPStroke, threshold: number): GPStroke {
  const src = evaluatedPoints(s);
  if (src.length < 2) return setCurveType({ ...s, points: src, curve_type: GP_POLY }, GP_BEZIER, false);
  const cyc = s.cyclic && src.length > 2;
  const P = src.map((p) => [...p.co] as V3);
  const segs = fitBezier(P, threshold, cyc);
  const n0 = src.length;
  const pt = (i: number) => src[i % n0];
  const points: GPPoint[] = [];
  segs.forEach((g, k) => {
    const p = clonePoint(pt(g.i0), g.p0);
    p.handle_right = [...g.c0];
    const prev = k > 0 ? segs[k - 1] : cyc ? segs[segs.length - 1] : null;
    if (prev) p.handle_left = [...prev.c1];
    else p.handle_left = sub(mul(g.p0, 2), g.c0);
    p.handle_type_left = p.handle_type_right = prev ? H_ALIGN : H_FREE;
    points.push(p);
  });
  if (!cyc) {
    const g = segs[segs.length - 1];
    const p = clonePoint(pt(g.i1), g.p1);
    p.handle_left = [...g.c1];
    p.handle_right = sub(mul(g.p1, 2), g.c1);
    p.handle_type_left = p.handle_type_right = H_FREE;
    points.push(p);
  }
  return withType(s, GP_BEZIER, points);
}

/** Catmull-Rom point through segment a→b (with neighbours c, d) at t. */
function catmull(p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 {
  const t2 = t * t,
    t3 = t2 * t;
  const w = [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
  return [0, 1, 2].map((k) => w[0] * p0[k] + w[1] * p1[k] + w[2] * p2[k] + w[3] * p3[k]) as V3;
}

function segDist(p: V3, a: V3, b: V3): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return dist(p, add(a, mul(ab, t)));
}

/** Indices of the source points a Catmull-Rom spline keeps to stay within `error`. */
export function fitCatmull(P: V3[], error: number, cyclic = false): number[] {
  const n = P.length;
  if (n <= 2) return P.map((_, i) => i);
  const keep = cyclic ? [0, Math.floor(n / 3), Math.floor((2 * n) / 3)] : [0, n - 1];
  for (let guard = 0; guard < n; guard++) {
    keep.sort((a, b) => a - b);
    let worst = -1,
      worstErr = error;
    const m = keep.length;
    const spans = cyclic ? m : m - 1;
    const at = (k: number) => (cyclic ? keep[((k % m) + m) % m] : keep[Math.max(0, Math.min(m - 1, k))]);
    for (let q = 0; q < spans; q++) {
      const a = keep[q],
        b = q + 1 < m ? keep[q + 1] : keep[0] + n;
      if (b - a < 2) continue;
      const p0 = P[at(q - 1)],
        p1 = P[a],
        p2 = P[b % n],
        p3 = P[at(q + 2) % n];
      // distance of the skipped points to the span (sampled finely)
      const S = 24;
      const smp: V3[] = [];
      for (let j = 0; j <= S; j++) smp.push(catmull(p0, p1, p2, p3, j / S));
      for (let i = a + 1; i < b; i++) {
        const p = P[i % n];
        let e = Infinity;
        for (let j = 0; j < S; j++) e = Math.min(e, segDist(p, smp[j], smp[j + 1]));
        if (e > worstErr) {
          worstErr = e;
          worst = i % n;
        }
      }
    }
    if (worst < 0) break;
    keep.push(worst);
  }
  return [...new Set(keep)].sort((a, b) => a - b);
}

function toCatmull(s: GPStroke, threshold: number): GPStroke {
  const src = evaluatedPoints(s);
  const idx = fitCatmull(
    src.map((p) => [...p.co] as V3),
    threshold,
    s.cyclic && src.length > 2,
  );
  return withType(
    s,
    GP_CATMULL_ROM,
    idx.map((i) => clonePoint(src[i])),
  );
}

/** NURBS with Bézier knots: the fitted Bézier's points and handles as control points. */
function toNurbs(s: GPStroke, threshold: number): GPStroke {
  const b = toBezier(s, threshold);
  if (b.points.length < 2) return setCurveType(b, GP_NURBS, false);
  const pts: GPPoint[] = [];
  const n = b.points.length;
  b.points.forEach((p, i) => {
    if (i > 0 || s.cyclic) pts.push(clonePoint(p, p.handle_left as V3));
    pts.push(clonePoint(p));
    if (i < n - 1 || s.cyclic) pts.push(clonePoint(p, p.handle_right as V3));
  });
  return withType(s, GP_NURBS, pts, { nurbs_order: 4, knots_mode: s.cyclic ? KNOTS_BEZIER : KNOTS_ENDPOINT_BEZIER });
}

/** Rebuild a stroke as `type`, following its current shape within `threshold`. */
export function convertCurveType(s: GPStroke, type: number, threshold: number): GPStroke {
  switch (type) {
    case GP_POLY: {
      const pts = evaluatedPoints(s).map((p) => clonePoint(p));
      const out: GPStroke = { ...s, points: pts };
      for (const k of ['curve_type', 'resolution', 'nurbs_order', 'knots_mode'] as const) delete out[k];
      return out;
    }
    case GP_BEZIER:
      return toBezier(s, threshold);
    case GP_CATMULL_ROM:
      return toCatmull(s, threshold);
    case GP_NURBS:
      return toNurbs(s, threshold);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Handle types

export type HandleTypeOp = 'AUTO' | 'VECTOR' | 'ALIGN' | 'FREE_ALIGN' | 'TOGGLE_FREE_ALIGN';

/**
 * Set the handle type of the selected handles of a Bézier stroke (both handles of selected
 * control points). Returns null when the stroke has nothing selected.
 */
export function setHandleType(s: GPStroke, op: HandleTypeOp, toggleTo?: number): GPStroke | null {
  if (s.curve_type !== GP_BEZIER) return null;
  let any = false;
  const target = op === 'AUTO' ? H_AUTO : op === 'VECTOR' ? H_VECTOR : op === 'ALIGN' ? H_ALIGN : op === 'FREE_ALIGN' ? H_FREE : (toggleTo ?? H_FREE);
  const points = s.points.map((p) => {
    const l = p.select || p.select_left,
      r = p.select || p.select_right;
    if (!l && !r) return p;
    any = true;
    const q = { ...p };
    if (l) q.handle_type_left = target;
    if (r) q.handle_type_right = target;
    return q;
  });
  return any ? { ...s, points } : null;
}

/** Toggle Free/Align: free when some selected handle is not free, aligned otherwise. */
export function toggleTarget(strokes: GPStroke[]): number {
  for (const s of strokes) {
    if (s.curve_type !== GP_BEZIER) continue;
    for (const p of s.points) {
      if ((p.select || p.select_left) && p.handle_type_left !== H_FREE) return H_FREE;
      if ((p.select || p.select_right) && p.handle_type_right !== H_FREE) return H_FREE;
    }
  }
  return H_ALIGN;
}

/** A stroke counts as selected when a point or a handle of it is. */
export const strokeSelected = (s: GPStroke) => s.points.some((p) => p.select || p.select_left || p.select_right);
