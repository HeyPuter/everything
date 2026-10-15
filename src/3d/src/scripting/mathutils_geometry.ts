// `mathutils.geometry`: intersection, projection and polygon helpers for scripts.
// Original implementation; names, argument order and return shapes follow the public
// module (null where it returns None, arrays where it returns tuples).
import { Vector, toArray, mathError, type VecLike } from './mathutils';

type V3 = [number, number, number];
const EPS = 1e-12;

const v3 = (v: VecLike): V3 => {
  const a = toArray(v);
  return [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0];
};
const v2 = (v: VecLike): [number, number] => {
  const a = toArray(v);
  return [a[0] ?? 0, a[1] ?? 0];
};
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const cross2 = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
/** Vector with the dimension of the inputs (2D stays 2D). */
const out = (p: V3, dims: number) => new Vector(dims === 2 ? [p[0], p[1]] : p);
const dimsOf = (...vs: VecLike[]) => (vs.every((v) => toArray(v).length === 2) ? 2 : 3);

/** Closest point on triangle abc to p (all 3D). */
export function closestOnTri(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a);
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return add(b, scale(sub(c, b), w));
  }
  const den = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * den), scale(ac, vc * den)));
}

/** Newell normal of a polygon (not normalized). */
function newell(pts: V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i],
      b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return n;
}

/** Point-in-triangle sign in 2D: 1 inside a counter-clockwise triangle, -1 inside a clockwise one, 0 outside. */
function pointInTri2d(p: number[], a: number[], b: number[], c: number[]) {
  const d1 = cross2(a, b, p),
    d2 = cross2(b, c, p),
    d3 = cross2(c, a, p);
  if (d1 >= 0 && d2 >= 0 && d3 >= 0) return 1;
  if (d1 <= 0 && d2 <= 0 && d3 <= 0) return -1;
  return 0;
}

function segSegIntersect2d(a: number[], b: number[], c: number[], d: number[]): number[] | null {
  const r = [b[0] - a[0], b[1] - a[1]],
    s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < EPS) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  const e = 1e-9;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}

// ---------------------------------------------------------------------------
// polygon tessellation (ear clipping with hole bridging)

/** Triangulates simple 2D polygons (outer rings counter-clockwise) given as index loops into `pts`. */
function earClip(pts: number[][], loop: number[], tris: number[][]) {
  const idx = [...loop];
  const area2 = (i: number, j: number, k: number) => cross2(pts[i], pts[j], pts[k]);
  const same = (i: number, j: number) => pts[i][0] === pts[j][0] && pts[i][1] === pts[j][1];
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    const n = idx.length;
    let clipped = false;
    for (let k = 0; k < n; k++) {
      const i0 = idx[(k + n - 1) % n],
        i1 = idx[k],
        i2 = idx[(k + 1) % n];
      if (area2(i0, i1, i2) <= EPS) continue;
      let ok = true;
      for (let m = 0; m < n && ok; m++) {
        const q = idx[m];
        if (q === i0 || q === i1 || q === i2 || same(q, i0) || same(q, i1) || same(q, i2)) continue;
        const p = pts[q];
        if (cross2(pts[i0], pts[i1], p) >= 0 && cross2(pts[i1], pts[i2], p) >= 0 && cross2(pts[i2], pts[i0], p) >= 0) ok = false;
      }
      if (!ok) continue;
      tris.push([i0, i1, i2]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // degenerate input (collinear or self-touching): drop the flattest corner and keep going
      let best = 0,
        bestA = Infinity;
      for (let k = 0; k < idx.length; k++) {
        const a = Math.abs(area2(idx[(k + idx.length - 1) % idx.length], idx[k], idx[(k + 1) % idx.length]));
        if (a < bestA) [best, bestA] = [k, a];
      }
      const n2 = idx.length;
      if (bestA > EPS) tris.push([idx[(best + n2 - 1) % n2], idx[best], idx[(best + 1) % n2]]);
      idx.splice(best, 1);
    }
  }
  if (idx.length === 3 && Math.abs(area2(idx[0], idx[1], idx[2])) > EPS) tris.push([idx[0], idx[1], idx[2]]);
}

function signedArea(pts: number[][], loop: number[]) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = pts[loop[i]],
      q = pts[loop[(i + 1) % loop.length]];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function pointInLoop(pts: number[][], loop: number[], p: number[]) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = pts[loop[i]],
      b = pts[loop[j]];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Joins holes (clockwise) into the outer loop (counter-clockwise) with bridge edges. */
function bridgeHoles(pts: number[][], outer: number[], holes: number[][]): number[] {
  let poly = [...outer];
  const pending = holes.map((h) => [...h]);
  pending.sort((a, b) => Math.max(...b.map((i) => pts[i][0])) - Math.max(...a.map((i) => pts[i][0])));
  const crosses = (a: number[], b: number[], loops: number[][], ia: number, ib: number) => {
    for (const loop of loops)
      for (let k = 0; k < loop.length; k++) {
        const c = loop[k],
          d = loop[(k + 1) % loop.length];
        if (c === ia || d === ia || c === ib || d === ib) continue;
        const pc = pts[c],
          pd = pts[d];
        const d1 = cross2(a, b, pc),
          d2 = cross2(a, b, pd),
          d3 = cross2(pc, pd, a),
          d4 = cross2(pc, pd, b);
        if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return true;
      }
    return false;
  };
  while (pending.length) {
    const hole = pending.shift()!;
    let hk = 0;
    for (let k = 1; k < hole.length; k++) if (pts[hole[k]][0] > pts[hole[hk]][0]) hk = k;
    const m = hole[hk];
    const order = poly.map((_, k) => k).sort((a, b) => {
      const pa = pts[poly[a]],
        pb = pts[poly[b]],
        pm = pts[m];
      return Math.hypot(pa[0] - pm[0], pa[1] - pm[1]) - Math.hypot(pb[0] - pm[0], pb[1] - pm[1]);
    });
    let pick = order[0];
    for (const k of order) {
      const p = poly[k];
      if (!crosses(pts[m], pts[p], [poly, hole, ...pending], m, p)) {
        // the bridge must leave the outer vertex into the polygon interior
        const prev = pts[poly[(k + poly.length - 1) % poly.length]],
          next = pts[poly[(k + 1) % poly.length]],
          cur = pts[p];
        const convex = cross2(prev, cur, next) >= 0;
        const l = cross2(prev, cur, pts[m]) >= 0,
          r = cross2(cur, next, pts[m]) >= 0;
        if (convex ? l && r : l || r) {
          pick = k;
          break;
        }
      }
    }
    const holeSeq = [...hole.slice(hk), ...hole.slice(0, hk), m];
    poly = [...poly.slice(0, pick + 1), ...holeSeq, ...poly.slice(pick)];
  }
  return poly;
}

/** Triangulate rings (outer boundaries and holes, nesting decided by containment). */
export function tessellateRings(rings3: V3[][]): number[][] {
  const pts3: V3[] = [];
  const loops: number[][] = [];
  for (const r of rings3) {
    const loop: number[] = [];
    for (const p of r) {
      loop.push(pts3.length);
      pts3.push(p);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  if (!loops.length) return [];
  // projection plane from the ring with the largest area
  let n: V3 = [0, 0, 0];
  for (const loop of loops) {
    const ln = newell(loop.map((i) => pts3[i]));
    if (len(ln) > len(n)) n = ln;
  }
  if (len(n) < EPS) return [];
  n = scale(n, 1 / len(n));
  const t: V3 = Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]);
  const u = scale(t, 1 / len(t));
  const w = cross(n, u);
  const pts = pts3.map((p) => [dot(p, u), dot(p, w)]);
  // nesting depth: even = boundary, odd = hole
  const depth = loops.map((loop, i) => loops.reduce((d, other, j) => (j !== i && pointInLoop(pts, other, pts[loop[0]]) ? d + 1 : d), 0));
  const tris: number[][] = [];
  loops.forEach((loop, i) => {
    if (depth[i] % 2) return;
    const outer = signedArea(pts, loop) >= 0 ? loop : [...loop].reverse();
    const holes = loops
      .filter((h, j) => depth[j] === depth[i] + 1 && pointInLoop(pts, loop, pts[h[0]]))
      .map((h) => (signedArea(pts, h) <= 0 ? h : [...h].reverse()));
    earClip(pts, holes.length ? bridgeHoles(pts, outer, holes) : outer, tris);
  });
  return tris;
}

// ---------------------------------------------------------------------------
// 2D packing / fitting

function hull2d(points: number[][]): number[] {
  const order = points.map((_, i) => i).sort((a, b) => points[a][0] - points[b][0] || points[a][1] - points[b][1]);
  if (order.length < 3) return order;
  const lower: number[] = [],
    upper: number[] = [];
  for (const i of order) {
    while (lower.length >= 2 && cross2(points[lower[lower.length - 2]], points[lower[lower.length - 1]], points[i]) <= 0) lower.pop();
    lower.push(i);
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    while (upper.length >= 2 && cross2(points[upper[upper.length - 2]], points[upper[upper.length - 1]], points[i]) <= 0) upper.pop();
    upper.push(i);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Bottom-left skyline packing of boxes [w, h] into a strip of the given width. */
function skylinePack(sizes: [number, number][], order: number[], width: number) {
  let sky: [number, number, number][] = [[0, width, 0]]; // [x, w, y]
  const pos: [number, number][] = new Array(sizes.length);
  for (const i of order) {
    const [bw, bh] = sizes[i];
    let best: [number, number] | null = null;
    for (let s = 0; s < sky.length; s++) {
      const x = sky[s][0];
      if (x + bw > width + 1e-9 && x > 0) continue;
      let y = 0,
        reach = 0;
      for (let k = s; k < sky.length && reach < bw - 1e-12; k++) {
        y = Math.max(y, sky[k][2]);
        reach = sky[k][0] + sky[k][1] - x;
      }
      if (reach < bw - 1e-9 && x > 0) continue;
      if (!best || y < best[1] - 1e-12 || (Math.abs(y - best[1]) <= 1e-12 && x < best[0])) best = [x, y];
    }
    const [x, y] = best ?? [0, Math.max(...sky.map((s) => s[2]))];
    pos[i] = [x, y];
    // raise the skyline under the box
    const next: [number, number, number][] = [];
    for (const seg of sky) {
      const [sx, sw, sy] = seg;
      const ex = sx + sw;
      if (ex <= x || sx >= x + bw) next.push(seg);
      else {
        if (sx < x) next.push([sx, x - sx, sy]);
        if (ex > x + bw) next.push([x + bw, ex - (x + bw), sy]);
      }
    }
    next.push([x, bw, y + bh]);
    next.sort((a, b) => a[0] - b[0]);
    sky = [];
    for (const seg of next) {
      const last = sky[sky.length - 1];
      if (last && Math.abs(last[2] - seg[2]) < 1e-12 && Math.abs(last[0] + last[1] - seg[0]) < 1e-12) last[1] += seg[1];
      else sky.push([...seg]);
    }
  }
  return pos;
}

function packBoxes(boxes: number[][]): [number, number] {
  if (!boxes.length) return [0, 0];
  const sizes = boxes.map((b) => [Number(b[2]), Number(b[3])] as [number, number]);
  const area = sizes.reduce((s, [w, h]) => s + w * h, 0);
  const maxW = Math.max(...sizes.map((s) => s[0]));
  const totalW = sizes.reduce((s, [w]) => s + w, 0);
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b][1] - sizes[a][1] || sizes[b][0] - sizes[a][0]);
  let best: { side: number; w: number; h: number; pos: [number, number][] } | null = null;
  const base = Math.max(maxW, Math.sqrt(area));
  const candidates = new Set<number>();
  for (let k = 0; k <= 24; k++) candidates.add(Math.min(totalW, base * (1 + k * 0.05)));
  candidates.add(maxW);
  for (const W of candidates) {
    const pos = skylinePack(sizes, order, W);
    let w = 0,
      h = 0;
    pos.forEach(([x, y], i) => {
      w = Math.max(w, x + sizes[i][0]);
      h = Math.max(h, y + sizes[i][1]);
    });
    const side = Math.max(w, h);
    if (!best || side < best.side - 1e-12 || (Math.abs(side - best.side) <= 1e-12 && w * h < best.w * best.h)) best = { side, w, h, pos };
  }
  best!.pos.forEach(([x, y], i) => {
    boxes[i][0] = x;
    boxes[i][1] = y;
  });
  return [best!.w, best!.h];
}

// ---------------------------------------------------------------------------

export const geometry = {
  /** Ray (direction `ray` from `orig`) against triangle v1 v2 v3; with clip=false the triangle's plane. */
  intersect_ray_tri(t1: VecLike, t2: VecLike, t3: VecLike, ray: VecLike, orig: VecLike, clip = true): Vector | null {
    const a = v3(t1),
      b = v3(t2),
      c = v3(t3),
      d = v3(ray),
      o = v3(orig);
    const e1 = sub(b, a),
      e2 = sub(c, a);
    const p = cross(d, e2);
    const det = dot(e1, p);
    if (Math.abs(det) < EPS) return null;
    const inv = 1 / det;
    const s = sub(o, a);
    const u = dot(s, p) * inv;
    const q = cross(s, e1);
    const v = dot(d, q) * inv;
    if (clip && (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9)) return null;
    const t = dot(e2, q) * inv;
    if (t < 0) return null;
    return new Vector(add(o, scale(d, t)));
  },

  /** Closest points between two infinite lines (2D or 3D); null for parallel lines. */
  intersect_line_line(a1: VecLike, a2: VecLike, b1: VecLike, b2: VecLike): [Vector, Vector] | null {
    const dims = dimsOf(a1, a2, b1, b2);
    const p1 = v3(a1),
      p3 = v3(b1);
    const d1 = sub(v3(a2), p1),
      d2 = sub(v3(b2), p3),
      r = sub(p1, p3);
    const a = dot(d1, d1),
      e = dot(d2, d2),
      b = dot(d1, d2),
      c = dot(d1, r),
      f = dot(d2, r);
    const den = a * e - b * b;
    if (a < EPS || e < EPS || Math.abs(den) <= 1e-10 * a * e) return null;
    const s = (b * f - c * e) / den,
      t = (a * f - b * c) / den;
    return [out(add(p1, scale(d1, s)), dims), out(add(p3, scale(d2, t)), dims)];
  },

  /** Intersection of two 2D line segments, or null. */
  intersect_line_line_2d(a1: VecLike, a2: VecLike, b1: VecLike, b2: VecLike): Vector | null {
    const r = segSegIntersect2d(v2(a1), v2(a2), v2(b1), v2(b2));
    return r ? new Vector(r) : null;
  },

  /** Intersection of the infinite line through a, b with a plane, or null when parallel. */
  intersect_line_plane(a: VecLike, b: VecLike, planeCo: VecLike, planeNo: VecLike, _noFlip = false): Vector | null {
    const A = v3(a),
      d = sub(v3(b), A),
      n = v3(planeNo);
    const den = dot(n, d);
    if (Math.abs(den) < EPS) return null;
    const t = dot(n, sub(v3(planeCo), A)) / den;
    return new Vector(add(A, scale(d, t)));
  },

  /** Line where two planes meet: [point closest to the origin, unit direction], or [null, null]. */
  intersect_plane_plane(aCo: VecLike, aNo: VecLike, bCo: VecLike, bNo: VecLike): [Vector, Vector] | [null, null] {
    const n1 = v3(aNo),
      n2 = v3(bNo);
    const dir = cross(n1, n2);
    const l2 = dot(dir, dir);
    if (l2 < 1e-12 * dot(n1, n1) * dot(n2, n2) || l2 < EPS) return [null, null];
    const d1 = dot(n1, v3(aCo)),
      d2 = dot(n2, v3(bCo));
    const n11 = dot(n1, n1),
      n22 = dot(n2, n2),
      n12 = dot(n1, n2);
    const det = n11 * n22 - n12 * n12;
    const c1 = (d1 * n22 - d2 * n12) / det,
      c2 = (d2 * n11 - d1 * n12) / det;
    return [new Vector(add(scale(n1, c1), scale(n2, c2))), new Vector(scale(dir, 1 / Math.sqrt(l2)))];
  },

  /** Line a→b against a sphere: [far hit, near hit] along the line; entries are null when missing (or outside the segment with clip). */
  intersect_line_sphere(a: VecLike, b: VecLike, co: VecLike, radius: number, clip = true): [Vector | null, Vector | null] {
    return lineSphere(a, b, co, radius, clip, dimsOf(a, b, co) === 2 ? 2 : 3);
  },
  intersect_line_sphere_2d(a: VecLike, b: VecLike, co: VecLike, radius: number, clip = true): [Vector | null, Vector | null] {
    return lineSphere(a, b, co, radius, clip, 2);
  },

  /** Intersection points of two circles, or [null, null]. */
  intersect_sphere_sphere_2d(pa: VecLike, ra: number, pb: VecLike, rb: number): [Vector, Vector] | [null, null] {
    const A = v2(pa),
      B = v2(pb);
    const dx = B[0] - A[0],
      dy = B[1] - A[1];
    const d = Math.hypot(dx, dy);
    if (d < EPS || d > ra + rb || d < Math.abs(ra - rb)) return [null, null];
    const a = (ra * ra - rb * rb + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, ra * ra - a * a));
    const mx = A[0] + (a * dx) / d,
      my = A[1] + (a * dy) / d;
    const px = -dy / d,
      py = dx / d;
    return [new Vector([mx - h * px, my - h * py]), new Vector([mx + h * px, my + h * py])];
  },

  /** Closest point on the infinite line through l1, l2 and its factor along l1→l2. */
  intersect_point_line(pt: VecLike, l1: VecLike, l2: VecLike): [Vector, number] {
    const dims = dimsOf(pt, l1, l2);
    const p = v3(pt),
      a = v3(l1),
      d = sub(v3(l2), a);
    const dd = dot(d, d);
    const t = dd < EPS ? 0 : dot(sub(p, a), d) / dd;
    return [out(add(a, scale(d, t)), dims), t];
  },

  /** The point projected onto the triangle's plane when that projection lies inside the triangle, else null. */
  intersect_point_tri(pt: VecLike, t1: VecLike, t2: VecLike, t3: VecLike): Vector | null {
    const p = v3(pt),
      a = v3(t1),
      b = v3(t2),
      c = v3(t3);
    const n = cross(sub(b, a), sub(c, a));
    const nn = dot(n, n);
    if (nn < EPS) return null;
    const proj = sub(p, scale(n, dot(sub(p, a), n) / nn));
    const e = -1e-9 * nn;
    if (dot(cross(sub(b, a), sub(proj, a)), n) < e || dot(cross(sub(c, b), sub(proj, b)), n) < e || dot(cross(sub(a, c), sub(proj, c)), n) < e) return null;
    return new Vector(proj);
  },

  /** 1 when inside a counter-clockwise triangle, -1 inside a clockwise one, 0 outside. */
  intersect_point_tri_2d(pt: VecLike, t1: VecLike, t2: VecLike, t3: VecLike): number {
    return pointInTri2d(v2(pt), v2(t1), v2(t2), v2(t3));
  },

  /** Same convention as intersect_point_tri_2d for a quad. */
  intersect_point_quad_2d(pt: VecLike, q1: VecLike, q2: VecLike, q3: VecLike, q4: VecLike): number {
    const p = v2(pt),
      a = v2(q1),
      b = v2(q2),
      c = v2(q3),
      d = v2(q4);
    return pointInTri2d(p, a, b, c) || pointInTri2d(p, a, c, d);
  },

  /** True when two 2D triangles overlap or touch. */
  intersect_tri_tri_2d(a1: VecLike, a2: VecLike, a3: VecLike, b1: VecLike, b2: VecLike, b3: VecLike): boolean {
    const A = [v2(a1), v2(a2), v2(a3)],
      B = [v2(b1), v2(b2), v2(b3)];
    for (const T of [A, B])
      for (let i = 0; i < 3; i++) {
        const p = T[i],
          q = T[(i + 1) % 3];
        const ax = q[1] - p[1],
          ay = p[0] - q[0];
        let amin = Infinity,
          amax = -Infinity,
          bmin = Infinity,
          bmax = -Infinity;
        for (const v of A) {
          const s = v[0] * ax + v[1] * ay;
          amin = Math.min(amin, s);
          amax = Math.max(amax, s);
        }
        for (const v of B) {
          const s = v[0] * ax + v[1] * ay;
          bmin = Math.min(bmin, s);
          bmax = Math.max(bmax, s);
        }
        const tol = 1e-12 * (Math.abs(ax) + Math.abs(ay) + 1);
        if (amax < bmin - tol || bmax < amin - tol) return false;
      }
    return true;
  },

  closest_point_on_tri(pt: VecLike, t1: VecLike, t2: VecLike, t3: VecLike): Vector {
    return new Vector(closestOnTri(v3(pt), v3(t1), v3(t2), v3(t3)));
  },

  /** Signed distance from the plane (positive on the side the normal points to). */
  distance_point_to_plane(pt: VecLike, planeCo: VecLike, planeNo: VecLike): number {
    const n = v3(planeNo);
    const l = len(n);
    return l < EPS ? 0 : dot(sub(v3(pt), v3(planeCo)), n) / l;
  },

  area_tri(a: VecLike, b: VecLike, c: VecLike): number {
    if (dimsOf(a, b, c) === 2) return Math.abs(cross2(v2(a), v2(b), v2(c))) / 2;
    const A = v3(a);
    return len(cross(sub(v3(b), A), sub(v3(c), A))) / 2;
  },

  /** Signed volume of the tetrahedron (v1, v2, v3, origin). */
  volume_tri(a: VecLike, b: VecLike, c: VecLike): number {
    return dot(v3(a), cross(v3(b), v3(c))) / 6;
  },

  /** Unit normal of a polygon given as points (or one list of points); zero vector when degenerate. */
  normal(...pts: (VecLike | VecLike[])[]): Vector {
    const list = (pts.length === 1 && isPointList(pts[0]) ? pts[0] : pts) as VecLike[];
    if (list.length < 3) throw mathError('ValueError', 'normal(): expected at least 3 points');
    const n = newell(list.map(v3));
    const l = len(n);
    return new Vector(l < EPS ? [0, 0, 0] : scale(n, 1 / l));
  },

  /** Map a point from one triangle to another (barycentric in the plane, height scaled with the triangle size). */
  barycentric_transform(point: VecLike, a1: VecLike, a2: VecLike, a3: VecLike, b1: VecLike, b2: VecLike, b3: VecLike): Vector {
    const p = v3(point),
      A = [v3(a1), v3(a2), v3(a3)],
      B = [v3(b1), v3(b2), v3(b3)];
    const na = cross(sub(A[1], A[0]), sub(A[2], A[0])),
      nb = cross(sub(B[1], B[0]), sub(B[2], B[0]));
    const la = len(na),
      lb = len(nb);
    if (la < EPS) return new Vector(B[0]);
    const h = dot(sub(p, A[0]), na) / la;
    const proj = sub(p, scale(na, h / la));
    const v0 = sub(A[1], A[0]),
      v1 = sub(A[2], A[0]),
      v2_ = sub(proj, A[0]);
    const d00 = dot(v0, v0),
      d01 = dot(v0, v1),
      d11 = dot(v1, v1),
      d20 = dot(v2_, v0),
      d21 = dot(v2_, v1);
    const den = d00 * d11 - d01 * d01;
    const v = (d11 * d20 - d01 * d21) / den,
      w = (d00 * d21 - d01 * d20) / den,
      u = 1 - v - w;
    let r = add(add(scale(B[0], u), scale(B[1], v)), scale(B[2], w));
    if (lb > EPS) r = add(r, scale(nb, (h * Math.sqrt(lb / la)) / lb));
    return new Vector(r);
  },

  /** `resolution` points along a cubic Bézier segment, end points included. */
  interpolate_bezier(knot1: VecLike, handle1: VecLike, handle2: VecLike, knot2: VecLike, resolution: number): Vector[] {
    const P = [toArray(knot1), toArray(handle1), toArray(handle2), toArray(knot2)];
    const dims = Math.max(...P.map((p) => p.length));
    const n = Math.floor(resolution);
    if (n < 1) throw mathError('ValueError', 'interpolate_bezier(): resolution must be at least 1');
    if (n === 1) return [new Vector(P[0])];
    const outPts: Vector[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1),
        s = 1 - t;
      const w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
      outPts.push(new Vector(Array.from({ length: dims }, (_, k) => P.reduce((acc, p, j) => acc + (p[k] ?? 0) * w[j], 0))));
    }
    return outPts;
  },

  /** Triangulate a list of point loops (boundaries and holes); indices refer to the points in order across all loops. */
  tessellate_polygon(veclistList: VecLike[][]): number[][] {
    return tessellateRings(Array.from(veclistList, (loop) => Array.from(loop, v3)));
  },

  /** Indices of the 2D convex hull, counter-clockwise starting at the lowest-x point. */
  convex_hull_2d(points: VecLike[]): number[] {
    return hull2d(Array.from(points, v2));
  },

  /** Rotation angle (radians) giving the smallest axis-aligned box around the points. */
  box_fit_2d(points: VecLike[]): number {
    const pts = Array.from(points, v2);
    const h = hull2d(pts);
    if (h.length < 2) return 0;
    let bestA = Infinity,
      bestAngle = 0;
    for (let i = 0; i < h.length; i++) {
      const p = pts[h[i]],
        q = pts[h[(i + 1) % h.length]];
      const ex = q[0] - p[0],
        ey = q[1] - p[1];
      const l = Math.hypot(ex, ey);
      if (l < EPS) continue;
      const ux = ex / l,
        uy = ey / l;
      let minU = Infinity,
        maxU = -Infinity,
        minV = Infinity,
        maxV = -Infinity;
      for (const k of h) {
        const a = pts[k][0] * ux + pts[k][1] * uy,
          b = -pts[k][0] * uy + pts[k][1] * ux;
        minU = Math.min(minU, a);
        maxU = Math.max(maxU, a);
        minV = Math.min(minV, b);
        maxV = Math.max(maxV, b);
      }
      const area = (maxU - minU) * (maxV - minV);
      if (area < bestA - 1e-12) {
        bestA = area;
        bestAngle = Math.PI / 2 - Math.atan2(ey, ex);
      }
    }
    return bestAngle;
  },

  /** Pack boxes [x, y, width, height] (x and y are written in place); returns [total width, total height]. */
  box_pack_2d(boxes: number[][]): [number, number] {
    return packBoxes(boxes);
  },

  /** Corner points of the convex volume bounded by planes (a, b, c, d: inside where ax+by+cz+d <= 0) and the planes used. */
  points_in_planes(planes: VecLike[], epsilonCoplanar = 1e-4, epsilonIsect = 1e-6): [Vector[], number[]] {
    const P = Array.from(planes, (p) => {
      const a = toArray(p);
      return [a[0], a[1], a[2], a[3] ?? 0];
    });
    const verts: V3[] = [];
    const used = new Set<number>();
    const n = P.length;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const nij = cross(P[i].slice(0, 3) as V3, P[j].slice(0, 3) as V3);
        if (dot(nij, nij) < epsilonCoplanar) continue;
        for (let k = j + 1; k < n; k++) {
          const ni = P[i].slice(0, 3) as V3,
            nj = P[j].slice(0, 3) as V3,
            nk = P[k].slice(0, 3) as V3;
          const det = dot(ni, cross(nj, nk));
          if (Math.abs(det) < epsilonCoplanar) continue;
          // solve ni.p = -di etc.
          const p = scale(add(add(scale(cross(nj, nk), -P[i][3]), scale(cross(nk, ni), -P[j][3])), scale(cross(ni, nj), -P[k][3])), 1 / det);
          if (P.every((q) => q[0] * p[0] + q[1] * p[1] + q[2] * p[2] + q[3] <= epsilonIsect)) {
            if (!verts.some((v) => len(sub(v, p)) < 1e-6)) verts.push(p);
            used.add(i).add(j).add(k);
          }
        }
      }
    return [verts.map((v) => new Vector(v)), [...used].sort((a, b) => a - b)];
  },
};

function isPointList(v: unknown): v is VecLike[] {
  if (!v || typeof v !== 'object' || !('length' in (v as object))) return false;
  const first = (v as ArrayLike<unknown>)[0];
  return !!first && typeof first === 'object';
}

function lineSphere(a: VecLike, b: VecLike, co: VecLike, radius: number, clip: boolean, dims: number): [Vector | null, Vector | null] {
  const A = v3(a),
    C = v3(co);
  const d = sub(v3(b), A);
  if (dims === 2) {
    A[2] = 0;
    C[2] = 0;
    d[2] = 0;
  }
  const m = sub(A, C);
  const qa = dot(d, d),
    qb = 2 * dot(m, d),
    qc = dot(m, m) - radius * radius;
  if (qa < EPS) return [null, null];
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return [null, null];
  const sq = Math.sqrt(disc);
  const t1 = (-qb + sq) / (2 * qa),
    t2 = (-qb - sq) / (2 * qa);
  const at = (t: number) => (clip && (t < 0 || t > 1) ? null : out(add(A, scale(d, t)), dims));
  return [at(t1), at(t2)];
}
