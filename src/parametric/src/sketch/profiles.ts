// Turns sketch curves into closed profile regions for extrude/revolve.
//
// Non-construction curves form a planar graph whose vertices are curve end
// points (merged by position). Dangling edges are pruned, then a half-edge
// traversal finds every face boundary: counter-clockwise cycles bound regions,
// clockwise cycles are the outside of a connected component and become holes
// of the smallest region that contains them. Regions alternate between
// material and empty by nesting depth (even-odd), which matches what people
// expect from nested profiles. Explicit sample points can pick regions instead.

import type { SkCurve, SkEntity, SkPoint } from '../model/types';
import { type Vec2, angle2, dist2, sub2 } from '../math/vec';
import { SketchIndex, arcAngles, splineBeziers, tessellate } from './geom';

/** Oriented profile segment. `src` is the sketch entity it came from. */
export type Seg2 =
  | { k: 'line'; a: Vec2; b: Vec2; src?: string }
  | { k: 'arc'; c: Vec2; r: number; a: Vec2; b: Vec2; ccw: boolean; src?: string }
  | { k: 'circle'; c: Vec2; r: number; ccw: boolean; src?: string }
  | { k: 'bez'; p: Vec2[]; src?: string };

export interface Loop {
  segs: Seg2[];
  /** Dense polygon used for containment tests and areas. */
  poly: Vec2[];
  area: number;
}

export interface Region {
  outer: Loop;
  holes: Loop[];
  /** A point strictly inside the region (not in a hole). */
  sample: Vec2;
}

export interface ProfileResult {
  regions: Region[];
  /** Every bounded region, material or not (for contour picking). */
  all: Region[];
  openEnds: Vec2[];
  /** Some closed contours cross each other (they are not trimmed where they meet). */
  crossing: boolean;
}

interface HalfEdge {
  curve: number;
  from: number;
  to: number;
  forward: boolean;
  /** Outgoing tangent angle at `from`. */
  angle: number;
  twin: number;
  next: number;
  used: boolean;
}

const CHORD_TOL = 0.002;

export function buildProfiles(entities: SkEntity[], picks?: Vec2[]): ProfileResult {
  const ix = new SketchIndex(entities);
  const curves = entities.filter((e): e is SkCurve => e.t !== 'point' && !e.construction);
  const bounds = boundsOf(ix, curves);
  const tol = Math.max(1e-7, bounds * 1e-9);

  // Closed curves (circles, closed splines) are complete loops by themselves.
  const closedLoops: Loop[] = [];
  const openCurves: SkCurve[] = [];
  for (const c of curves) {
    if (c.t === 'circle') {
      if (c.r > tol) closedLoops.push(makeLoop([{ k: 'circle', c: ix.pt(c.c), r: c.r, ccw: true, src: c.id }]));
    } else if (c.t === 'spline' && c.pts.length > 2 && dist2(ix.pt(c.pts[0]), ix.pt(c.pts[c.pts.length - 1])) < tol) {
      const loop = makeLoop(curveSegs(ix, c, true));
      if (Math.abs(loop.area) > tol * tol) closedLoops.push(loop.area > 0 ? loop : reverseLoop(loop));
    } else openCurves.push(c);
  }

  // Merge end points by position. Small sketches use a short linear scan;
  // larger ones only inspect the nearby cells of a spatial index.
  const verts: Vec2[] = [];
  const mergeTol = tol * 10;
  let cells: Map<string, number[]> | undefined;
  const cellKey = (x: number, y: number) => `${x},${y}`;
  const indexVertex = (i: number) => {
    const p = verts[i], key = cellKey(Math.floor(p[0] / mergeTol), Math.floor(p[1] / mergeTol));
    const bucket = cells!.get(key);
    if (bucket) bucket.push(i);
    else cells!.set(key, [i]);
  };
  const vertexOf = (p: Vec2) => {
    const x = verts.length < 64 ? NaN : Math.floor(p[0] / mergeTol);
    const y = verts.length < 64 ? NaN : Math.floor(p[1] / mergeTol);
    // Extremely large coordinates cannot reliably address neighbouring cells.
    if (verts.length < 64 || !Number.isSafeInteger(x - 1) || !Number.isSafeInteger(x + 1) || !Number.isSafeInteger(y - 1) || !Number.isSafeInteger(y + 1)) {
      for (let i = 0; i < verts.length; i++) if (dist2(verts[i], p) <= mergeTol) return i;
    } else {
      if (!cells) { cells = new Map(); verts.forEach((_, i) => indexVertex(i)); }
      let first = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const i of cells.get(cellKey(x + dx, y + dy)) ?? []) {
          // Keep the same first-match rule when a point is close to two
          // distinct vertices; cell traversal order must not change topology.
          if (i < first && dist2(verts[i], p) <= mergeTol) first = i;
        }
      }
      if (first !== Infinity) return first;
    }
    verts.push(p);
    if (cells) indexVertex(verts.length - 1);
    return verts.length - 1;
  };
  const ends = openCurves.map((c) => {
    const [a, b] = endPoints(ix, c);
    return [vertexOf(a), vertexOf(b)] as [number, number];
  });

  // Peel dangling edges from their end vertices. Each edge is visited a
  // bounded number of times, even when a long chain is ordered centre-out.
  const alive = openCurves.map((_, i) => ends[i][0] !== ends[i][1] || openCurves[i].t === 'spline');
  const degree = new Int32Array(verts.length);
  openCurves.forEach((_, i) => { if (alive[i]) { degree[ends[i][0]]++; degree[ends[i][1]]++; } });
  const pending: number[] = [];
  for (let i = 0; i < degree.length; i++) if (degree[i] === 1) pending.push(i);
  // Closed profiles need no adjacency lists or pruning work.
  if (pending.length) {
    const incident: number[][] = verts.map(() => []);
    openCurves.forEach((_, i) => {
      if (alive[i]) { incident[ends[i][0]].push(i); incident[ends[i][1]].push(i); }
    });
    for (let at = 0; at < pending.length; at++) {
      for (const i of incident[pending[at]]) {
        if (!alive[i]) continue;
        const [a, b] = ends[i];
        alive[i] = false;
        if (--degree[a] === 1) pending.push(a);
        if (--degree[b] === 1) pending.push(b);
      }
    }
  }
  const openEnds: Vec2[] = [];
  const reported = new Uint8Array(verts.length);
  openCurves.forEach((_, i) => {
    if (alive[i]) return;
    // Different vertex ids are already farther apart than the merge tolerance.
    for (const v of ends[i]) if (degree[v] <= 0 && !reported[v]) {
      reported[v] = 1;
      openEnds.push(verts[v]);
    }
  });

  // Half-edges.
  const hes: HalfEdge[] = [];
  openCurves.forEach((c, i) => {
    if (!alive[i]) return;
    const [a, b] = ends[i];
    const [ta, tb] = endTangents(ix, c);
    const h0 = hes.length;
    hes.push({ curve: i, from: a, to: b, forward: true, angle: angle2(ta), twin: h0 + 1, next: -1, used: false });
    hes.push({ curve: i, from: b, to: a, forward: false, angle: angle2(tb), twin: h0, next: -1, used: false });
  });
  const outgoing: number[][] = verts.map(() => []);
  hes.forEach((h, i) => outgoing[h.from].push(i));
  for (const list of outgoing) list.sort((p, q) => hes[p].angle - hes[q].angle);
  for (let i = 0; i < hes.length; i++) {
    const h = hes[i];
    const list = outgoing[h.to];
    const k = list.indexOf(h.twin);
    // Next edge clockwise from the twin keeps the face on the left.
    h.next = list[(k - 1 + list.length) % list.length];
  }

  const ccw: Loop[] = [...closedLoops];
  const cw: Loop[] = closedLoops.map(reverseLoop);
  for (let i = 0; i < hes.length; i++) {
    if (hes[i].used) continue;
    const segs: Seg2[] = [];
    let j = i, guard = 0;
    while (!hes[j].used && guard++ < hes.length + 2) {
      hes[j].used = true;
      const h = hes[j];
      segs.push(...curveSegs(ix, openCurves[h.curve], h.forward));
      j = h.next;
    }
    if (j !== i || !segs.length) continue;
    const loop = makeLoop(segs);
    if (Math.abs(loop.area) < tol * tol) continue;
    (loop.area > 0 ? ccw : cw).push(loop);
  }

  // Contours drawn across each other without being trimmed (two overlapping
  // circles, a circle over a rectangle's edge) are not split where they cross.
  // Such a contour is never a hole of, nor nested in, one it crosses: each
  // stays a region of its own (they combine when used), whichever of its
  // points happens to be tested, and no hole ever crosses its outer boundary.
  const crosses = (a: Loop, b: Loop) => loopsCross(a, b, tol);

  // Assign component outer boundaries (cw) as holes of the smallest ccw loop
  // that contains them, excluding the loop that is the same boundary.
  const regionHoles: Loop[][] = ccw.map(() => []);
  for (const h of cw) {
    let best = -1, bestArea = Infinity;
    const hArea = Math.abs(h.area);
    for (let k = 0; k < ccw.length; k++) {
      const o = ccw[k];
      if (o.area <= hArea * (1 + 1e-9)) continue;
      if (sameBoundary(o, h)) continue;
      // Test a point of h off o's boundary: a hole touching its outline at
      // h's first point would otherwise be found outside it.
      if (o.area < bestArea && pointInPoly(pointOff(h, o, tol), o.poly) && !crosses(o, h)) { best = k; bestArea = o.area; }
    }
    if (best >= 0) regionHoles[best].push(h);
  }

  const all: Region[] = ccw.map((outer, k) => ({ outer, holes: regionHoles[k], sample: interiorPoint(outer, regionHoles[k]) }));
  let regions: Region[];
  if (picks && picks.length) {
    regions = [];
    for (const p of picks) {
      let best: Region | null = null;
      for (const r of all) {
        if (!inRegion(p, r)) continue;
        if (!best || r.outer.area < best.outer.area) best = r;
      }
      if (best && !regions.includes(best)) regions.push(best);
    }
  } else {
    regions = all.filter((r) => {
      let depth = 0;
      for (const g of all) if (g !== r && g.outer.area > r.outer.area && pointInPoly(r.sample, g.outer.poly) && !crosses(g.outer, r.outer)) depth++;
      return depth % 2 === 0;
    });
  }
  let crossing = false;
  // Boxes first: most pairs of a big sketch (a plate's many holes) are far apart.
  const boxes = ccw.map((l) => loopInfo(l).box);
  for (let i = 0; i < ccw.length && !crossing; i++) {
    const p = boxes[i];
    for (let j = i + 1; j < ccw.length && !crossing; j++) {
      const q = boxes[j];
      if (p[0] - q[2] > tol || q[0] - p[2] > tol || p[1] - q[3] > tol || q[1] - p[3] > tol) continue;
      crossing = crosses(ccw[i], ccw[j]);
    }
  }
  return { regions, all, openEnds, crossing };
}

export function inRegion(p: Vec2, r: Region): boolean {
  return pointInPoly(p, r.outer.poly) && !r.holes.some((h) => pointInPoly(p, h.poly));
}

function boundsOf(ix: SketchIndex, curves: SkCurve[]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (p: Vec2) => {
    minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
    maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
  };
  for (const c of curves) {
    if (c.t === 'circle' || c.t === 'arc') {
      const center = ix.pt(c.c), r = c.t === 'circle' ? c.r : arcAngles(ix, c).r;
      add([center[0] - r, center[1] - r]);
      add([center[0] + r, center[1] + r]);
    } else for (const p of c.t === 'line' ? [c.a, c.b] : c.pts) add(ix.pt(p));
  }
  // Tolerance follows the geometry's size, not its distance from the origin.
  return Math.max(1, maxX - minX, maxY - minY);
}

function endPoints(ix: SketchIndex, c: SkCurve): [Vec2, Vec2] {
  switch (c.t) {
    case 'line': return [ix.pt(c.a), ix.pt(c.b)];
    case 'arc': return [ix.pt(c.a), ix.pt(c.b)];
    case 'spline': return [ix.pt(c.pts[0]), ix.pt(c.pts[c.pts.length - 1])];
    case 'circle': { const p = ix.pt(c.c); return [p, p]; }
  }
}

/** Outgoing tangents at the start (forward) and at the end (reverse direction). */
function endTangents(ix: SketchIndex, c: SkCurve): [Vec2, Vec2] {
  switch (c.t) {
    case 'line': {
      const d = sub2(ix.pt(c.b), ix.pt(c.a));
      return [d, [-d[0], -d[1]]];
    }
    case 'arc': {
      const { c: ctr } = arcAngles(ix, c);
      const ra = sub2(ix.pt(c.a), ctr), rb = sub2(ix.pt(c.b), ctr);
      // CCW tangent at a is (-y, x); leaving b backwards is clockwise: (y, -x).
      // Tiny chord offset breaks ties between a line and a tangent arc.
      const ta: Vec2 = [-ra[1], ra[0]];
      const tb: Vec2 = [rb[1], -rb[0]];
      const poly = tessellate(ix, c, CHORD_TOL);
      return [blend(ta, sub2(poly[1], poly[0])), blend(tb, sub2(poly[poly.length - 2], poly[poly.length - 1]))];
    }
    case 'spline': {
      const poly = tessellate(ix, c, CHORD_TOL);
      return [sub2(poly[1], poly[0]), sub2(poly[poly.length - 2], poly[poly.length - 1])];
    }
    case 'circle': return [[1, 0], [-1, 0]];
  }
}

function blend(t: Vec2, chord: Vec2): Vec2 {
  const lt = Math.hypot(t[0], t[1]) || 1, lc = Math.hypot(chord[0], chord[1]) || 1;
  return [t[0] / lt + 1e-3 * (chord[0] / lc), t[1] / lt + 1e-3 * (chord[1] / lc)];
}

function curveSegs(ix: SketchIndex, c: SkCurve, forward: boolean): Seg2[] {
  switch (c.t) {
    case 'line': {
      const a = ix.pt(c.a), b = ix.pt(c.b);
      return [forward ? { k: 'line', a, b, src: c.id } : { k: 'line', a: b, b: a, src: c.id }];
    }
    case 'arc': {
      const { c: ctr, r } = arcAngles(ix, c);
      const a = ix.pt(c.a), b = ix.pt(c.b);
      return [forward ? { k: 'arc', c: ctr, r, a, b, ccw: true, src: c.id } : { k: 'arc', c: ctr, r, a: b, b: a, ccw: false, src: c.id }];
    }
    case 'circle': return [{ k: 'circle', c: ix.pt(c.c), r: c.r, ccw: forward, src: c.id }];
    case 'spline': {
      const bz = splineBeziers(c.pts.map((p) => ix.pt(p)));
      const segs: Seg2[] = bz.map((p) => ({ k: 'bez', p, src: c.id }));
      if (forward) return segs;
      return segs.reverse().map((s) => ({ k: 'bez', p: [...(s as { p: Vec2[] }).p].reverse(), src: c.id }));
    }
  }
}

export function segPolyline(s: Seg2): Vec2[] {
  switch (s.k) {
    case 'line': return [s.a, s.b];
    case 'circle': {
      const n = 96;
      const out: Vec2[] = [];
      for (let i = 0; i <= n; i++) {
        const t = ((s.ccw ? 1 : -1) * i * 2 * Math.PI) / n;
        out.push([s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]);
      }
      return out;
    }
    case 'arc': {
      const a0 = angle2(sub2(s.a, s.c));
      const a1 = angle2(sub2(s.b, s.c));
      let sweep = s.ccw ? a1 - a0 : a0 - a1;
      while (sweep <= 1e-12) sweep += 2 * Math.PI;
      const n = Math.max(8, Math.ceil((sweep / (2 * Math.PI)) * 96));
      const out: Vec2[] = [s.a];
      for (let i = 1; i < n; i++) {
        const t = a0 + (s.ccw ? 1 : -1) * (i / n) * sweep;
        out.push([s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]);
      }
      out.push(s.b);
      return out;
    }
    case 'bez': {
      const out: Vec2[] = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24, u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        out.push([a * s.p[0][0] + b * s.p[1][0] + c * s.p[2][0] + d * s.p[3][0], a * s.p[0][1] + b * s.p[1][1] + c * s.p[2][1] + d * s.p[3][1]]);
      }
      return out;
    }
  }
}

function makeLoop(segs: Seg2[]): Loop {
  const poly: Vec2[] = [];
  for (const s of segs) {
    const p = segPolyline(s);
    for (let i = poly.length ? 1 : 0; i < p.length; i++) poly.push(p[i]);
  }
  return { segs, poly, area: polyArea(poly) };
}

function reverseLoop(l: Loop): Loop {
  const segs: Seg2[] = [...l.segs].reverse().map((s): Seg2 => {
    switch (s.k) {
      case 'line': return { k: 'line', a: s.b, b: s.a, src: s.src };
      case 'arc': return { k: 'arc', c: s.c, r: s.r, a: s.b, b: s.a, ccw: !s.ccw, src: s.src };
      case 'circle': return { k: 'circle', c: s.c, r: s.r, ccw: !s.ccw, src: s.src };
      case 'bez': return { k: 'bez', p: [...s.p].reverse(), src: s.src };
    }
  });
  return { segs, poly: [...l.poly].reverse(), area: -l.area };
}

/** How far a loop's polygon can be from its true curves. */
function chordError(l: Loop): number {
  let e = 0;
  for (const s of l.segs) {
    if (s.k === 'circle') e = Math.max(e, s.r * (1 - Math.cos(Math.PI / 96)));
    // Arcs are cut in steps of at most a 96th of a turn, like circles.
    else if (s.k === 'arc') e = Math.max(e, s.r * (1 - Math.cos(Math.PI / 96)));
    else if (s.k === 'bez') {
      const poly = segPolyline(s);
      for (let i = 0; i + 1 < poly.length; i++) {
        const t = (i + 0.5) / (poly.length - 1), u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        const q: Vec2 = [a * s.p[0][0] + b * s.p[1][0] + c * s.p[2][0] + d * s.p[3][0], a * s.p[0][1] + b * s.p[1][1] + c * s.p[2][1] + d * s.p[3][1]];
        e = Math.max(e, dist2(q, [(poly[i][0] + poly[i + 1][0]) / 2, (poly[i][1] + poly[i + 1][1]) / 2]));
      }
    }
  }
  return e;
}

type Box = [number, number, number, number];
const boxCache = new WeakMap<Loop, { box: Box; err: number }>();
function loopInfo(l: Loop) {
  let v = boxCache.get(l);
  if (!v) {
    const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of l.poly) { box[0] = Math.min(box[0], p[0]); box[1] = Math.min(box[1], p[1]); box[2] = Math.max(box[2], p[0]); box[3] = Math.max(box[3], p[1]); }
    boxCache.set(l, (v = { box, err: chordError(l) }));
  }
  return v;
}

function polyDist(p: Vec2, poly: Vec2[]): number {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    d = Math.min(d, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return d;
}

/** Whether an edge of a closed polygon passes within eps of a box (Liang-Barsky clip against the grown box). */
function nearBox(poly: Vec2[], box: Box, eps: number): boolean {
  const bx0 = box[0] - eps, by0 = box[1] - eps, bx1 = box[2] + eps, by1 = box[3] + eps;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], dx = poly[i][0] - ax, dy = poly[i][1] - ay;
    let t0 = 0, t1 = 1;
    const clip = (p: number, q: number) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    if (clip(-dx, ax - bx0) && clip(dx, bx1 - ax) && clip(-dy, ay - by0) && clip(dy, by1 - ay)) return true;
  }
  return false;
}

const crossEps = (a: Loop, b: Loop, tol: number) => loopInfo(a).err + loopInfo(b).err + tol * 10;

/** A point of loop a clearly off b's boundary (a's first point if none is). */
function pointOff(a: Loop, b: Loop, tol: number): Vec2 {
  const eps = crossEps(a, b, tol), box = loopInfo(b).box;
  for (const p of a.poly) {
    if (p[0] < box[0] - eps || p[0] > box[2] + eps || p[1] < box[1] - eps || p[1] > box[3] + eps) return p;
    if (polyDist(p, b.poly) > eps) return p;
  }
  return a.poly[0];
}

/**
 * Whether two closed contours cross: one has points clearly inside and
 * clearly outside the other. Points within the polygons' chord error of the
 * other boundary are left out, so contours that only touch (a hole tangent
 * to its outline, two faces sharing an edge) do not count.
 */
export function loopsCross(a: Loop, b: Loop, tol = 1e-9): boolean {
  const A = loopInfo(a), B = loopInfo(b);
  const eps = crossEps(a, b, tol);
  const x0 = Math.max(A.box[0], B.box[0]) - eps, y0 = Math.max(A.box[1], B.box[1]) - eps;
  const x1 = Math.min(A.box[2], B.box[2]) + eps, y1 = Math.min(A.box[3], B.box[3]) + eps;
  if (x0 > x1 || y0 > y1) return false;
  // Each boundary lies in its own box: when one does not come near the other's
  // box (a plate's edges around a hole well inside it), the boundaries cannot
  // touch, let alone cross.
  if (!nearBox(a.poly, B.box, eps) || !nearBox(b.poly, A.box, eps)) return false;
  // Polygon edges are sampled finely enough to land inside the overlap of the two boxes.
  const step = Math.max(Math.min(x1 - x0, y1 - y0) / 4, eps);
  const straddles = (pts: Vec2[], other: Loop, box: Box) => {
    let inside = false, outside = false;
    const test = (p: Vec2) => {
      if (p[0] < box[0] - eps || p[0] > box[2] + eps || p[1] < box[1] - eps || p[1] > box[3] + eps) { outside = true; return; }
      if (polyDist(p, other.poly) <= eps) return;
      if (pointInPoly(p, other.poly)) inside = true;
      else outside = true;
    };
    for (let i = 0; i < pts.length && !(inside && outside); i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const n = Math.max(1, Math.min(64, Math.ceil(dist2(p, q) / step)));
      for (let k = 0; k < n && !(inside && outside); k++) test([p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n]);
    }
    return inside && outside;
  };
  return straddles(b.poly, a, A.box) || straddles(a.poly, b, B.box);
}

function sameBoundary(a: Loop, b: Loop): boolean {
  if (Math.abs(Math.abs(a.area) - Math.abs(b.area)) > 1e-9 * Math.max(1, Math.abs(a.area))) return false;
  const pa = a.poly, pb = b.poly;
  if (pa.length !== pb.length) return false;
  return pb.some((p) => dist2(p, pa[0]) < 1e-9);
}

export function polyArea(poly: Vec2[]): number {
  let s = 0;
  const origin = poly[0];
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    // Subtract a nearby origin before multiplying to avoid cancellation of
    // large, nearly equal products for small profiles at large coordinates.
    s += (a[0] - origin[0]) * (b[1] - origin[1]) - (b[0] - origin[0]) * (a[1] - origin[1]);
  }
  return s / 2;
}

export function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1] || 1e-300) + a[0]) inside = !inside;
  }
  return inside;
}

/** A point inside the outer loop and outside every hole (widest scanline span). */
function interiorPoint(outer: Loop, holes: Loop[]): Vec2 {
  let minY = Infinity, maxY = -Infinity;
  for (const p of outer.poly) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  let best: Vec2 = outer.poly[0], bestW = -1;
  const loops = [outer.poly, ...holes.map((h) => h.poly)];
  for (let k = 1; k < 8; k++) {
    // Irrational-ish offsets avoid scanlines passing exactly through vertices.
    const y = minY + (maxY - minY) * ((k + 0.1234567) / 8.2469);
    const xs: number[] = [];
    for (const poly of loops) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if (a[1] > y !== b[1] > y) xs.push(((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]);
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (w > bestW) { bestW = w; best = [(xs[i] + xs[i + 1]) / 2, y]; }
    }
  }
  return best;
}

/** Stand-alone sketch points (not curve end points) - used by holes. */
export function sketchPoints(entities: SkEntity[]): SkPoint[] {
  const used = new Set<string>();
  for (const e of entities) {
    if (e.t === 'line' || e.t === 'arc') { used.add(e.a); used.add(e.b); if (e.t === 'arc') used.add(e.c); }
    else if (e.t === 'circle') used.add(e.c);
    else if (e.t === 'spline') e.pts.forEach((p) => used.add(p));
  }
  return entities.filter((e): e is SkPoint => e.t === 'point' && !used.has(e.id) && !e.construction);
}
