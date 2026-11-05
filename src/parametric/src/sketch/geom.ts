// 2D sketch geometry: lookups, tessellation, projections and intersections.

import type { Id, SkArc, SkCircle, SkCurve, SkEntity, SkLine, SkPoint, SkSpline } from '../model/types';
import { type Vec2, angle2, cross2, dist2, dot2, sub2, wrap2Pi } from '../math/vec';

export const ORIGIN_ID = 'O';

/** Circle centre through three points; null when the points are collinear. */
export function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  // Work relative to a picked point. Squaring world coordinates loses small
  // radii when the sketch is far from the origin.
  const bx = b[0] - a[0], by = b[1] - a[1];
  const cx = c[0] - a[0], cy = c[1] - a[1];
  const d = 2 * (bx * cy - by * cx);
  if (Math.abs(d) < 1e-12) return null;
  const b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  return [a[0] + (b2 * cy - c2 * by) / d, a[1] + (bx * c2 - cx * b2) / d];
}

export class SketchIndex {
  readonly byId = new Map<Id, SkEntity>();
  constructor(readonly entities: SkEntity[]) {
    for (const e of entities) this.byId.set(e.id, e);
  }
  get(id: Id): SkEntity | undefined {
    return this.byId.get(id);
  }
  pt(id: Id): Vec2 {
    if (id === ORIGIN_ID) return [0, 0];
    const e = this.byId.get(id) as SkPoint | undefined;
    return e && e.t === 'point' ? [e.x, e.y] : [NaN, NaN];
  }
  /** Curves referencing a point id. */
  curvesUsing(pointId: Id): SkCurve[] {
    const out: SkCurve[] = [];
    for (const e of this.entities) {
      if (e.t === 'line' && (e.a === pointId || e.b === pointId)) out.push(e);
      else if (e.t === 'arc' && (e.a === pointId || e.b === pointId || e.c === pointId)) out.push(e);
      else if (e.t === 'circle' && e.c === pointId) out.push(e);
      else if (e.t === 'spline' && e.pts.includes(pointId)) out.push(e);
    }
    return out;
  }
}

export const isCurve = (e: SkEntity): e is SkCurve => e.t !== 'point';

export function pointIdsOf(e: SkEntity): Id[] {
  switch (e.t) {
    case 'point': return [e.id];
    case 'line': return [e.a, e.b];
    case 'circle': return [e.c];
    case 'arc': return [e.c, e.a, e.b];
    case 'spline': return e.pts;
  }
}

export function arcRadius(ix: SketchIndex, a: SkArc): number {
  return dist2(ix.pt(a.c), ix.pt(a.a));
}

/** Start angle and positive sweep of an arc (counter-clockwise). */
export function arcAngles(ix: SketchIndex, a: SkArc): { start: number; sweep: number; r: number; c: Vec2 } {
  const c = ix.pt(a.c);
  const pa = ix.pt(a.a);
  const pb = ix.pt(a.b);
  const start = angle2(sub2(pa, c));
  let sweep = wrap2Pi(angle2(sub2(pb, c)) - start);
  if (sweep < 1e-9) sweep = 2 * Math.PI;
  return { start, sweep, r: dist2(c, pa), c };
}

export function arcMid(ix: SketchIndex, a: SkArc): Vec2 {
  const { start, sweep, r, c } = arcAngles(ix, a);
  const t = start + sweep / 2;
  return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
}

// ---- Splines: centripetal Catmull-Rom through points, as cubic Beziers ----

export function splineBeziers(pts: Vec2[]): Vec2[][] {
  const n = pts.length;
  if (n < 2) return [];
  if (n === 2) {
    const [a, b] = pts;
    return [[a, [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3], [a[0] + (2 * (b[0] - a[0])) / 3, a[1] + (2 * (b[1] - a[1])) / 3], b]];
  }
  const out: Vec2[][] = [];
  const ext = (p: Vec2, q: Vec2): Vec2 => [2 * p[0] - q[0], 2 * p[1] - q[1]];
  for (let i = 0; i < n - 1; i++) {
    const p0 = i === 0 ? ext(pts[0], pts[1]) : pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = i + 2 < n ? pts[i + 2] : ext(pts[n - 1], pts[n - 2]);
    const d1 = Math.pow(Math.max(dist2(p0, p1), 1e-12), 0.5);
    const d2 = Math.pow(Math.max(dist2(p1, p2), 1e-12), 0.5);
    const d3 = Math.pow(Math.max(dist2(p2, p3), 1e-12), 0.5);
    // Barry-Goldman tangents for centripetal parameterization.
    const t1: Vec2 = [
      (p1[0] - p0[0]) / d1 - (p2[0] - p0[0]) / (d1 + d2) + (p2[0] - p1[0]) / d2,
      (p1[1] - p0[1]) / d1 - (p2[1] - p0[1]) / (d1 + d2) + (p2[1] - p1[1]) / d2,
    ];
    const t2: Vec2 = [
      (p2[0] - p1[0]) / d2 - (p3[0] - p1[0]) / (d2 + d3) + (p3[0] - p2[0]) / d3,
      (p2[1] - p1[1]) / d2 - (p3[1] - p1[1]) / (d2 + d3) + (p3[1] - p2[1]) / d3,
    ];
    out.push([
      p1,
      [p1[0] + (t1[0] * d2) / 3, p1[1] + (t1[1] * d2) / 3],
      [p2[0] - (t2[0] * d2) / 3, p2[1] - (t2[1] * d2) / 3],
      p2,
    ]);
  }
  return out;
}

export function bezierPoint(b: Vec2[], t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u, c1 = 3 * u * u * t, c2 = 3 * u * t * t, d = t * t * t;
  return [a * b[0][0] + c1 * b[1][0] + c2 * b[2][0] + d * b[3][0], a * b[0][1] + c1 * b[1][1] + c2 * b[2][1] + d * b[3][1]];
}

/**
 * Polyline approximation of a curve. `tol` is the maximum chord error in
 * sketch units.
 */
export function tessellate(ix: SketchIndex, e: SkCurve, tol = 0.01): Vec2[] {
  switch (e.t) {
    case 'line': return [ix.pt(e.a), ix.pt(e.b)];
    case 'circle': {
      const c = ix.pt(e.c);
      const n = segmentsFor(e.r, 2 * Math.PI, tol);
      const out: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * 2 * Math.PI;
        out.push([c[0] + e.r * Math.cos(t), c[1] + e.r * Math.sin(t)]);
      }
      return out;
    }
    case 'arc': {
      const { start, sweep, r, c } = arcAngles(ix, e);
      const n = segmentsFor(r, sweep, tol);
      const out: Vec2[] = [ix.pt(e.a)];
      for (let i = 1; i < n; i++) {
        const t = start + (i / n) * sweep;
        out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
      }
      out.push(ix.pt(e.b));
      return out;
    }
    case 'spline': {
      const bz = splineBeziers(e.pts.map((p) => ix.pt(p)));
      const out: Vec2[] = [];
      for (const b of bz) {
        const span = dist2(b[0], b[1]) + dist2(b[1], b[2]) + dist2(b[2], b[3]);
        const n = Math.max(4, Math.min(64, Math.ceil(Math.sqrt(span / Math.max(tol, 1e-6)))));
        for (let i = out.length ? 1 : 0; i <= n; i++) out.push(bezierPoint(b, i / n));
      }
      return out;
    }
  }
}

export function segmentsFor(r: number, sweep: number, tol: number): number {
  if (r <= tol) return Math.max(4, Math.ceil(sweep / (Math.PI / 4)));
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
  return Math.max(4, Math.min(512, Math.ceil(sweep / Math.max(step, 1e-3))));
}

/** Closest point on segment ab to p, with parameter t in [0,1]. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { q: Vec2; t: number; d: number } {
  const ab = sub2(b, a);
  const l2 = dot2(ab, ab);
  let t = l2 < 1e-24 ? 0 : dot2(sub2(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  const q: Vec2 = [a[0] + ab[0] * t, a[1] + ab[1] * t];
  return { q, t, d: dist2(p, q) };
}

/** Distance from p to a curve (using its tessellation for splines). */
export function distanceToCurve(ix: SketchIndex, e: SkCurve, p: Vec2): { d: number; q: Vec2 } {
  switch (e.t) {
    case 'line': {
      const r = closestOnSegment(p, ix.pt(e.a), ix.pt(e.b));
      return { d: r.d, q: r.q };
    }
    case 'circle': {
      const c = ix.pt(e.c);
      const v = sub2(p, c);
      const l = Math.hypot(v[0], v[1]) || 1e-12;
      const q: Vec2 = [c[0] + (v[0] / l) * e.r, c[1] + (v[1] / l) * e.r];
      return { d: Math.abs(l - e.r), q };
    }
    case 'arc': {
      const { start, sweep, r, c } = arcAngles(ix, e);
      const v = sub2(p, c);
      const ang = wrap2Pi(angle2(v) - start);
      if (ang <= sweep) {
        const l = Math.hypot(v[0], v[1]) || 1e-12;
        return { d: Math.abs(l - r), q: [c[0] + (v[0] / l) * r, c[1] + (v[1] / l) * r] };
      }
      const pa = ix.pt(e.a), pb = ix.pt(e.b);
      const da = dist2(p, pa), db = dist2(p, pb);
      return da < db ? { d: da, q: pa } : { d: db, q: pb };
    }
    case 'spline': {
      const poly = tessellate(ix, e, 0.005);
      let best = { d: Infinity, q: p as Vec2 };
      for (let i = 0; i + 1 < poly.length; i++) {
        const r = closestOnSegment(p, poly[i], poly[i + 1]);
        if (r.d < best.d) best = { d: r.d, q: r.q };
      }
      return best;
    }
  }
}

// ---- Intersections (for trim / extend) ----

export interface Prim {
  kind: 'seg' | 'circ';
  a?: Vec2;
  b?: Vec2;
  c?: Vec2;
  r?: number;
  /** arc limits; undefined for full circle */
  start?: number;
  sweep?: number;
}

export function primsOf(ix: SketchIndex, e: SkCurve): Prim[] {
  switch (e.t) {
    case 'line': return [{ kind: 'seg', a: ix.pt(e.a), b: ix.pt(e.b) }];
    case 'circle': return [{ kind: 'circ', c: ix.pt(e.c), r: e.r }];
    case 'arc': {
      const { start, sweep, r, c } = arcAngles(ix, e);
      return [{ kind: 'circ', c, r, start, sweep }];
    }
    case 'spline': {
      const poly = tessellate(ix, e, 0.002);
      const out: Prim[] = [];
      for (let i = 0; i + 1 < poly.length; i++) out.push({ kind: 'seg', a: poly[i], b: poly[i + 1] });
      return out;
    }
  }
}

function onArc(p: Prim, pt: Vec2): boolean {
  if (p.start === undefined || p.sweep === undefined) return true;
  const ang = wrap2Pi(angle2(sub2(pt, p.c!)) - p.start);
  return ang <= p.sweep + 1e-9 || ang >= 2 * Math.PI - 1e-9;
}

/** Intersection points of two primitives (segments clipped, arcs limited). */
export function intersectPrims(p: Prim, q: Prim, extendFirst = false): Vec2[] {
  if (p.kind === 'seg' && q.kind === 'seg') {
    const r = sub2(p.b!, p.a!);
    const s = sub2(q.b!, q.a!);
    const den = cross2(r, s);
    if (Math.abs(den) < 1e-14) return [];
    const qp = sub2(q.a!, p.a!);
    const t = cross2(qp, s) / den;
    const u = cross2(qp, r) / den;
    const e = 1e-9;
    if ((extendFirst || (t >= -e && t <= 1 + e)) && u >= -e && u <= 1 + e) return [[p.a![0] + r[0] * t, p.a![1] + r[1] * t]];
    return [];
  }
  if (p.kind === 'circ' && q.kind === 'circ') {
    const d = dist2(p.c!, q.c!);
    const r0 = p.r!, r1 = q.r!;
    if (d < 1e-12 || d > r0 + r1 + 1e-9 || d < Math.abs(r0 - r1) - 1e-9) return [];
    const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, r0 * r0 - a * a));
    const ex: Vec2 = [(q.c![0] - p.c![0]) / d, (q.c![1] - p.c![1]) / d];
    const m: Vec2 = [p.c![0] + ex[0] * a, p.c![1] + ex[1] * a];
    const pts: Vec2[] = h < 1e-12 ? [m] : [[m[0] - ex[1] * h, m[1] + ex[0] * h], [m[0] + ex[1] * h, m[1] - ex[0] * h]];
    return pts.filter((x) => (extendFirst || onArc(p, x)) && onArc(q, x));
  }
  const seg = p.kind === 'seg' ? p : q;
  const circ = p.kind === 'seg' ? q : p;
  const d = sub2(seg.b!, seg.a!);
  const f = sub2(seg.a!, circ.c!);
  const length = Math.hypot(d[0], d[1]);
  if (length < 1e-12) return [];
  const ux = d[0] / length, uy = d[1] / length;
  // Intersect around the circle's perpendicular projection onto the line.
  // The quadratic discriminant subtracts enormous nearly equal products for
  // long lines, losing both roots (or inventing an intersection on a miss).
  const perpendicular = ux * f[1] - uy * f[0];
  const distance = Math.abs(perpendicular), radius = circ.r!;
  if (distance > radius) return [];
  const halfChord = Math.sqrt((radius - distance) * (radius + distance));
  const along = -(f[0] * ux + f[1] * uy);
  const center: Vec2 = [circ.c![0] - uy * perpendicular, circ.c![1] + ux * perpendicular];
  const offsets = halfChord < 1e-12 ? [0] : [-halfChord, halfChord];
  const out: Vec2[] = [];
  const segIsFirst = p.kind === 'seg';
  for (const offset of offsets) {
    const t = (along + offset) / length;
    const pt: Vec2 = [center[0] + ux * offset, center[1] + uy * offset];
    const segOk = (segIsFirst && extendFirst) || (t >= -1e-9 && t <= 1 + 1e-9);
    const arcOk = (!segIsFirst && extendFirst) || onArc(circ, pt);
    if (segOk && arcOk) out.push(pt);
  }
  return out;
}

/** Parameter of a point along a curve, used to order trim cut points. */
export function curveParam(ix: SketchIndex, e: SkCurve, p: Vec2): number {
  switch (e.t) {
    case 'line': {
      const a = ix.pt(e.a), b = ix.pt(e.b);
      const ab = sub2(b, a);
      return dot2(sub2(p, a), ab) / (dot2(ab, ab) || 1);
    }
    case 'circle': return wrap2Pi(angle2(sub2(p, ix.pt(e.c))));
    case 'arc': {
      const { start, sweep } = arcAngles(ix, e);
      let a = wrap2Pi(angle2(sub2(p, ix.pt(e.c))) - start);
      if (a > sweep + 1e-9 && a > Math.PI + sweep / 2) a -= 2 * Math.PI;
      return a / sweep;
    }
    case 'spline': {
      const poly = tessellate(ix, e, 0.002);
      let best = Infinity, bestT = 0, acc = 0, total = 0;
      for (let i = 0; i + 1 < poly.length; i++) total += dist2(poly[i], poly[i + 1]);
      for (let i = 0; i + 1 < poly.length; i++) {
        const r = closestOnSegment(p, poly[i], poly[i + 1]);
        const seg = dist2(poly[i], poly[i + 1]);
        if (r.d < best) { best = r.d; bestT = (acc + r.t * seg) / (total || 1); }
        acc += seg;
      }
      return bestT;
    }
  }
}

export function lineDir(ix: SketchIndex, l: SkLine): Vec2 {
  return sub2(ix.pt(l.b), ix.pt(l.a));
}

export function circleCenterRadius(ix: SketchIndex, e: SkCircle | SkArc): { c: Vec2; r: number } {
  return e.t === 'circle' ? { c: ix.pt(e.c), r: e.r } : { c: ix.pt(e.c), r: arcRadius(ix, e) };
}

export function splinePoints(ix: SketchIndex, s: SkSpline): Vec2[] {
  return s.pts.map((p) => ix.pt(p));
}

/** Axis-aligned bounds of all sketch geometry. */
export function sketchBounds(ix: SketchIndex): { min: Vec2; max: Vec2 } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const addP = (p: Vec2) => {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  };
  for (const e of ix.entities) {
    if (e.t === 'point') addP([e.x, e.y]);
    else if (e.t === 'circle') {
      const c = ix.pt(e.c);
      addP([c[0] - e.r, c[1] - e.r]);
      addP([c[0] + e.r, c[1] + e.r]);
    } else for (const p of tessellate(ix, e, 0.1)) addP(p);
  }
  return minX === Infinity ? null : { min: [minX, minY], max: [maxX, maxY] };
}
