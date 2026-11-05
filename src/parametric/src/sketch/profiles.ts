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

  // Merge end points by position.
  const verts: Vec2[] = [];
  const vertexOf = (p: Vec2) => {
    for (let i = 0; i < verts.length; i++) if (dist2(verts[i], p) <= tol * 10) return i;
    verts.push(p);
    return verts.length - 1;
  };
  const ends = openCurves.map((c) => {
    const [a, b] = endPoints(ix, c);
    return [vertexOf(a), vertexOf(b)] as [number, number];
  });

  // Prune dangling edges iteratively.
  const alive = openCurves.map((_, i) => ends[i][0] !== ends[i][1] || openCurves[i].t === 'spline');
  const degree = new Int32Array(verts.length);
  openCurves.forEach((_, i) => { if (alive[i]) { degree[ends[i][0]]++; degree[ends[i][1]]++; } });
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < openCurves.length; i++) {
      if (!alive[i]) continue;
      const [a, b] = ends[i];
      if (degree[a] < 2 || degree[b] < 2) {
        alive[i] = false;
        degree[a]--;
        degree[b]--;
        changed = true;
      }
    }
  }
  const openEnds: Vec2[] = [];
  openCurves.forEach((_, i) => {
    if (alive[i]) return;
    for (const v of ends[i]) if (degree[v] <= 0 && !openEnds.some((p) => dist2(p, verts[v]) < tol)) openEnds.push(verts[v]);
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

  // Assign component outer boundaries (cw) as holes of the smallest ccw loop
  // that contains them, excluding the loop that is the same boundary.
  const regionHoles: Loop[][] = ccw.map(() => []);
  for (const h of cw) {
    let best = -1, bestArea = Infinity;
    const probe = h.poly[0];
    const hArea = Math.abs(h.area);
    for (let k = 0; k < ccw.length; k++) {
      const o = ccw[k];
      if (o.area <= hArea * (1 + 1e-9)) continue;
      if (sameBoundary(o, h)) continue;
      if (pointInPoly(probe, o.poly) && o.area < bestArea) { best = k; bestArea = o.area; }
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
      for (const g of all) if (g !== r && g.outer.area > r.outer.area && pointInPoly(r.sample, g.outer.poly)) depth++;
      return depth % 2 === 0;
    });
  }
  return { regions, all, openEnds };
}

export function inRegion(p: Vec2, r: Region): boolean {
  return pointInPoly(p, r.outer.poly) && !r.holes.some((h) => pointInPoly(p, h.poly));
}

function boundsOf(ix: SketchIndex, curves: SkCurve[]): number {
  let m = 1;
  for (const c of curves) {
    const pts = c.t === 'circle' ? [ix.pt(c.c)] : c.t === 'line' ? [ix.pt(c.a), ix.pt(c.b)] : c.t === 'arc' ? [ix.pt(c.c)] : c.pts.map((p) => ix.pt(p));
    for (const p of pts) m = Math.max(m, Math.abs(p[0]), Math.abs(p[1]));
    if (c.t === 'circle') m = Math.max(m, c.r);
  }
  return m;
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

function sameBoundary(a: Loop, b: Loop): boolean {
  if (Math.abs(Math.abs(a.area) - Math.abs(b.area)) > 1e-9 * Math.max(1, Math.abs(a.area))) return false;
  const pa = a.poly, pb = b.poly;
  if (pa.length !== pb.length) return false;
  return pb.some((p) => dist2(p, pa[0]) < 1e-9);
}

export function polyArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
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
