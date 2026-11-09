/**
 * Hatch geometry: boundary loops to rings, even-odd polygon grouping,
 * triangulation for solid fills, and pattern line generation.
 *
 * Loops use the schema hatch format: flat [x, y, bulge, ...], implicitly
 * closed. Rings are flat [x, y, ...], implicitly closed, without a repeated
 * closing point.
 */
import earcut from 'earcut';
import { getPattern, dashPeriod } from './patterns.js';

const D2R = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/** Default segment cap for patternSegments. */
export const MAX_PATTERN_SEGMENTS = 200000;

/** Arc data for a bulged segment, or null when it is straight. */
function bulgeArc(x0, y0, x1, y1, b) {
  if (!b || !Number.isFinite(b)) return null;
  const dx = x1 - x0,
    dy = y1 - y0;
  const L = Math.hypot(dx, dy);
  if (L === 0) return null;
  const sweep = 4 * Math.atan(b);
  const h = L / 2 / Math.tan(sweep / 2);
  const cx = (x0 + x1) / 2 - (dy / L) * h;
  const cy = (y0 + y1) / 2 + (dx / L) * h;
  const r = Math.hypot(x0 - cx, y0 - cy);
  return { cx, cy, r, a0: Math.atan2(y0 - cy, x0 - cx), sweep };
}

/** Append (x, y) unless it repeats the last point. */
function pushPt(out, x, y) {
  const n = out.length;
  if (n >= 2 && out[n - 2] === x && out[n - 1] === y) return;
  out.push(x, y);
}

/**
 * Bounding box [minX, minY, maxX, maxY] of hatch loops, including the
 * extent of bulge arcs, or null when there are no vertices.
 */
export function hatchBounds(loops) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  const add = (x, y) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const loop of loops ?? []) {
    const n = Math.floor(loop.length / 3);
    for (let i = 0; i < n; i++) {
      const ax = loop[i * 3],
        ay = loop[i * 3 + 1];
      add(ax, ay);
      const j = (i + 1) % n;
      const arc = bulgeArc(ax, ay, loop[j * 3], loop[j * 3 + 1], loop[i * 3 + 2]);
      if (!arc) continue;
      for (let q = 0; q < 4; q++) {
        const phi = (q * Math.PI) / 2;
        const rel = arc.sweep > 0 ? phi - arc.a0 : arc.a0 - phi;
        const m = ((rel % TWO_PI) + TWO_PI) % TWO_PI;
        if (m <= Math.abs(arc.sweep)) add(arc.cx + arc.r * Math.cos(phi), arc.cy + arc.r * Math.sin(phi));
      }
    }
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}

/**
 * Convert hatch loops to flat xy rings. Bulge arcs are tessellated so the
 * chord deviation stays within `tol` (default: 1e-4 of the bounds diagonal).
 * Rings with fewer than 3 distinct points are dropped.
 */
export function loopsToRings(loops, tol) {
  if (!(tol > 0)) {
    const b = hatchBounds(loops);
    tol = b ? Math.max(Math.hypot(b[2] - b[0], b[3] - b[1]) * 1e-4, 1e-9) : 1e-3;
  }
  const rings = [];
  for (const loop of loops ?? []) {
    const n = Math.floor(loop.length / 3);
    if (n < 2) continue;
    const out = [];
    for (let i = 0; i < n; i++) {
      const x0 = loop[i * 3],
        y0 = loop[i * 3 + 1];
      pushPt(out, x0, y0);
      const j = (i + 1) % n;
      const arc = bulgeArc(x0, y0, loop[j * 3], loop[j * 3 + 1], loop[i * 3 + 2]);
      if (!arc) continue;
      const da = tol < arc.r ? 2 * Math.acos(1 - tol / arc.r) : Math.PI / 2;
      const steps = Math.min(4096, Math.max(2, Math.ceil(Math.abs(arc.sweep) / Math.min(da, Math.PI / 4))));
      for (let k = 1; k < steps; k++) {
        const a = arc.a0 + (arc.sweep * k) / steps;
        pushPt(out, arc.cx + arc.r * Math.cos(a), arc.cy + arc.r * Math.sin(a));
      }
    }
    while (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
    if (out.length >= 6) rings.push(out);
  }
  return rings;
}

/** Signed area of a flat ring (positive = counter-clockwise). */
export function ringArea(r) {
  let s = 0;
  const n = r.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) s += (r[j] - r[i]) * (r[j + 1] + r[i + 1]);
  return s / 2;
}

/** Reversed copy of a flat ring. */
function reverseRing(r) {
  const out = new Array(r.length);
  for (let i = 0, j = r.length - 2; j >= 0; i += 2, j -= 2) {
    out[i] = r[j];
    out[i + 1] = r[j + 1];
  }
  return out;
}

function ringBox(r) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < x0) x0 = r[i];
    if (r[i] > x1) x1 = r[i];
    if (r[i + 1] < y0) y0 = r[i + 1];
    if (r[i + 1] > y1) y1 = r[i + 1];
  }
  return [x0, y0, x1, y1];
}

/**
 * Point in ring (even-odd): 1 inside, 0 outside, -1 within eps of the
 * boundary.
 */
export function pointInRing(x, y, r, eps = 0) {
  let inside = false;
  const n = r.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = r[i],
      yi = r[i + 1],
      xj = r[j],
      yj = r[j + 1];
    if (eps > 0) {
      const ex = xi - xj,
        ey = yi - yj;
      const l2 = ex * ex + ey * ey;
      let t = l2 > 0 ? ((x - xj) * ex + (y - yj) * ey) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(xj + t * ex - x, yj + t * ey - y) <= eps) return -1;
    }
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? 1 : 0;
}

/** True when ring `a` lies inside ring `b` (rings assumed not to cross). */
function ringInside(a, b, eps) {
  for (let i = 0; i < a.length; i += 2) {
    const s = pointInRing(a[i], a[i + 1], b, eps);
    if (s >= 0) return s === 1;
  }
  // Every vertex touches b: decide with the midpoint of the first edge.
  return pointInRing((a[0] + a[2]) / 2, (a[1] + a[3]) / 2, b) === 1;
}

/**
 * Group rings into polygons by even-odd nesting. Returns an array of
 * polygons, each [outer, ...holes]: a ring inside an even number of other
 * rings is an outer boundary, inside an odd number it is a hole of its
 * nearest container. Outers come back counter-clockwise, holes clockwise.
 * Rings are assumed not to cross each other.
 */
export function solidPolygons(rings) {
  const items = [];
  for (const r of rings ?? []) {
    if (!r || r.length < 6) continue;
    const area = ringArea(r);
    if (area === 0) continue;
    items.push({ r, abs: Math.abs(area), ccw: area > 0, box: ringBox(r) });
  }
  items.sort((a, b) => b.abs - a.abs);
  const depth = new Int32Array(items.length);
  const polyOf = new Int32Array(items.length).fill(-1);
  const polys = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const eps = 1e-12 * Math.max(it.box[2] - it.box[0], it.box[3] - it.box[1], 1);
    let parent = -1;
    for (let j = i - 1; j >= 0; j--) {
      const bj = items[j].box;
      if (it.box[0] < bj[0] || it.box[1] < bj[1] || it.box[2] > bj[2] || it.box[3] > bj[3]) continue;
      if (ringInside(it.r, items[j].r, eps)) {
        parent = j;
        break;
      }
    }
    depth[i] = parent < 0 ? 0 : depth[parent] + 1;
    if (depth[i] % 2 === 0) {
      polyOf[i] = polys.length;
      polys.push([it.ccw ? it.r.slice() : reverseRing(it.r)]);
    } else {
      polys[polyOf[parent]].push(it.ccw ? reverseRing(it.r) : it.r.slice());
    }
  }
  return polys;
}

/**
 * Triangulate polygons ([outer, ...holes] each) with earcut. Vertices are
 * stored relative to (ox, oy) so float32 keeps its precision far from the
 * world origin. Returns { verts: Float32Array of x, y pairs (3 per
 * triangle), count: number of vertices }.
 */
export function triangulate(polygons, ox = 0, oy = 0) {
  const out = [];
  for (const poly of polygons ?? []) {
    const coords = [];
    const holes = [];
    for (let k = 0; k < poly.length; k++) {
      const r = poly[k];
      if (r.length < 6) continue;
      if (coords.length) holes.push(coords.length / 2);
      for (let i = 0; i < r.length; i += 2) coords.push(r[i] - ox, r[i + 1] - oy);
    }
    if (coords.length < 6) continue;
    const idx = earcut(coords, holes.length ? holes : null, 2);
    for (const v of idx) out.push(coords[v * 2], coords[v * 2 + 1]);
  }
  return { verts: new Float32Array(out), count: out.length / 2 };
}

/** Growable Float64Array. */
class Buf {
  constructor(n = 1024) {
    this.a = new Float64Array(n);
    this.n = 0;
  }
  reserve(k) {
    if (this.n + k <= this.a.length) return;
    const b = new Float64Array(Math.max(this.a.length * 2, this.n + k));
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

/**
 * Pattern lines clipped to rings with the even-odd rule.
 *
 *   rings     flat xy rings (see loopsToRings)
 *   pattern   pattern object or name (see patterns.js); 'SOLID' gives nothing
 *   scale     pattern scale (lengths, spacings and origins are multiplied)
 *   angleRad  extra rotation of the whole pattern about (0, 0)
 *   opts.maxSegments  cap on generated segments plus dots (default 200000)
 *
 * Each family is swept as a scanline: ring edges are expressed in the
 * family frame, sorted by the first line they cross and kept in an active
 * list, so each line only looks at the edges it crosses. Dash phase is
 * measured from each line's own start point, so dashes line up between
 * lines as the family offset defines.
 *
 * Returns { segs: Float64Array [x1, y1, x2, y2, ...], dots: Float64Array
 * [x, y, ...], truncated: true when the cap was hit (pattern too dense) }.
 */
export function patternSegments(rings, pattern, scale = 1, angleRad = 0, opts = {}) {
  const pat = typeof pattern === 'string' ? getPattern(pattern) : pattern;
  const cap = opts.maxSegments ?? MAX_PATTERN_SEGMENTS;
  const segs = new Buf(4096);
  const dots = new Buf(1024);
  const result = () => ({ segs: segs.done(), dots: dots.done(), truncated });
  let truncated = false;
  if (!pat || !pat.families?.length || !(scale > 0) || !rings?.length) return result();

  // Flatten ring vertices and edges once.
  let nv = 0;
  for (const r of rings) if (r.length >= 6) nv += r.length >> 1;
  const X = new Float64Array(nv),
    Y = new Float64Array(nv);
  const ea = new Int32Array(nv),
    eb = new Int32Array(nv);
  let v = 0;
  for (const r of rings) {
    if (r.length < 6) continue;
    const n = r.length >> 1;
    for (let i = 0; i < n; i++) {
      X[v + i] = r[i * 2];
      Y[v + i] = r[i * 2 + 1];
      ea[v + i] = v + i;
      eb[v + i] = v + ((i + 1) % n);
    }
    v += n;
  }
  const ne = nv;
  const S = new Float64Array(nv),
    T = new Float64Array(nv);
  const eKmin = new Float64Array(ne),
    eKmax = new Float64Array(ne),
    eA = new Float64Array(ne),
    eB = new Float64Array(ne),
    eLo = new Float64Array(ne),
    eHi = new Float64Array(ne);
  let xs = new Float64Array(64);
  const ca = Math.cos(angleRad),
    sa = Math.sin(angleRad);
  let count = 0;
  let work = 0;
  const workCap = cap * 4;

  for (const fam of pat.families) {
    const th = fam.angle * D2R + angleRad;
    const ux = Math.cos(th),
      uy = Math.sin(th);
    const ox = (fam.x * ca - fam.y * sa) * scale,
      oy = (fam.x * sa + fam.y * ca) * scale;
    let dx = fam.dx * scale,
      dy = fam.dy * scale;
    if (dy < 0) {
      dx = -dx;
      dy = -dy;
    }
    if (!(dy > 0)) continue;
    const dashes = (fam.dashes ?? []).map((d) => d * scale);
    const period = dashPeriod(dashes);
    const solid = dashes.length === 0;
    if (!solid && !(period > 0)) continue;

    // Ring vertices in the family frame: s along the lines, t across them.
    for (let i = 0; i < nv; i++) {
      const px = X[i] - ox,
        py = Y[i] - oy;
      S[i] = px * ux + py * uy;
      T[i] = py * ux - px * uy;
    }
    // Edges crossing at least one line: line k (t = k * dy) crosses an edge
    // when tlo <= k * dy < thi (half-open, so shared vertices count once).
    const order = [];
    let kLo = Infinity,
      kHi = -Infinity;
    for (let e = 0; e < ne; e++) {
      const a = ea[e],
        b = eb[e];
      const t1 = T[a],
        t2 = T[b];
      if (t1 === t2) continue;
      const lo = Math.min(t1, t2),
        hi = Math.max(t1, t2);
      const k0 = Math.ceil(lo / dy),
        k1 = Math.ceil(hi / dy) - 1;
      if (k1 < k0) continue;
      const slope = (S[b] - S[a]) / (t2 - t1);
      eKmin[e] = k0;
      eKmax[e] = k1;
      eA[e] = S[a] - t1 * slope;
      eB[e] = dy * slope;
      eLo[e] = Math.min(S[a], S[b]);
      eHi[e] = Math.max(S[a], S[b]);
      order.push(e);
      if (k0 < kLo) kLo = k0;
      if (k1 > kHi) kHi = k1;
    }
    if (!order.length) continue;
    if (kHi - kLo + 1 > workCap - work) {
      truncated = true;
      break;
    }
    order.sort((p, q) => eKmin[p] - eKmin[q]);

    const active = [];
    let ptr = 0;
    let k = kLo;
    while (k <= kHi) {
      if (!active.length && ptr < order.length && eKmin[order[ptr]] > k) k = eKmin[order[ptr]];
      while (ptr < order.length && eKmin[order[ptr]] <= k) active.push(order[ptr++]);
      let m = 0,
        w = 0;
      if (xs.length < active.length) xs = new Float64Array(active.length * 2);
      for (let i = 0; i < active.length; i++) {
        const e = active[i];
        if (eKmax[e] < k) continue;
        active[w++] = e;
        // A crossing lies on its edge. For an edge almost along the lines
        // (rounding in T) the slope is huge and the formula meaningless.
        const x = eA[e] + eB[e] * k;
        xs[m++] = x < eLo[e] ? eLo[e] : x > eHi[e] ? eHi[e] : x;
      }
      active.length = w;
      work++;
      if (m >= 2) {
        const row = xs.subarray(0, m).sort();
        const t = k * dy;
        const bx = ox - t * uy,
          by = oy + t * ux;
        const p0 = k * dx;
        for (let i = 0; i + 1 < m; i += 2) {
          const s0 = row[i],
            s1 = row[i + 1];
          if (!(s1 > s0)) continue;
          if (solid) {
            if (count >= cap) {
              truncated = true;
              return result();
            }
            segs.reserve(4);
            segs.a[segs.n++] = bx + s0 * ux;
            segs.a[segs.n++] = by + s0 * uy;
            segs.a[segs.n++] = bx + s1 * ux;
            segs.a[segs.n++] = by + s1 * uy;
            count++;
            continue;
          }
          // Walk the dash pattern from the cycle containing s0.
          let cyc = Math.floor((s0 - p0) / period);
          for (;;) {
            let off = p0 + cyc * period;
            if (off > s1) break;
            for (let d = 0; d < dashes.length; d++) {
              const len = dashes[d];
              const e0 = off;
              const e1 = off + Math.abs(len);
              off = e1;
              if (e0 > s1) break;
              if (len > 0) {
                if (e1 <= s0) continue;
                const a = e0 > s0 ? e0 : s0,
                  b = e1 < s1 ? e1 : s1;
                if (!(b > a)) continue;
                if (count >= cap) {
                  truncated = true;
                  return result();
                }
                segs.reserve(4);
                segs.a[segs.n++] = bx + a * ux;
                segs.a[segs.n++] = by + a * uy;
                segs.a[segs.n++] = bx + b * ux;
                segs.a[segs.n++] = by + b * uy;
                count++;
              } else if (len === 0 && e0 >= s0) {
                if (count >= cap) {
                  truncated = true;
                  return result();
                }
                dots.reserve(2);
                dots.a[dots.n++] = bx + e0 * ux;
                dots.a[dots.n++] = by + e0 * uy;
                count++;
              }
            }
            cyc++;
            if (++work > workCap) {
              truncated = true;
              return result();
            }
          }
        }
      }
      k++;
      if (!active.length && ptr >= order.length) break;
    }
  }
  return result();
}
