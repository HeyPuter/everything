// Drop-cutter: the lowest height the tip of a cutter can go down to at a
// point without cutting into the part (a triangle mesh in work coordinates).
// The cutter touches a triangle on its face, along an edge or at a corner;
// each is solved for the cutter's shape (flat, ball, bull nose or cone),
// exactly where a closed form exists and by golden-section search otherwise
// (the height along an edge is concave in its parameter for these shapes).

import type { CamTool } from '../model/cam';

/** A rotationally symmetric cutter: the height of its surface above the tip at a radius. */
export interface Cutter {
  /** Radius (beyond it the cutter is a vertical shank). */
  r: number;
  kind: 'flat' | 'ball' | 'bull' | 'cone';
  /** Corner radius (ball: r; bull: the corner). */
  rc: number;
  /** Cone: height gained per unit of radius (1 / tan of the half angle). */
  k: number;
  h(rr: number): number;
}

/** A cutter of the tool's shape, grown by a radial and lowered by an axial allowance. */
export function cutterOf(tool: Pick<CamTool, 'type' | 'diameter' | 'cornerRadius' | 'tipAngle'>, radial = 0): Cutter {
  const r = tool.diameter / 2 + radial;
  switch (tool.type) {
    case 'ball': return makeCutter('ball', r, r, 0);
    case 'bull': {
      const rc = Math.min(Math.max(tool.cornerRadius ?? 0, 0), tool.diameter / 2) + radial;
      return rc > 1e-9 ? makeCutter('bull', r, Math.min(rc, r), 0) : makeCutter('flat', r, 0, 0);
    }
    case 'drill':
    case 'chamfer': {
      const half = Math.max(1, Math.min(179, tool.tipAngle ?? (tool.type === 'drill' ? 118 : 90))) / 2;
      return makeCutter('cone', r, 0, 1 / Math.tan((half * Math.PI) / 180));
    }
    default: return makeCutter('flat', r, 0, 0);
  }
}

export function makeCutter(kind: Cutter['kind'], r: number, rc: number, k: number): Cutter {
  const r0 = r - rc;
  let h: (rr: number) => number;
  switch (kind) {
    case 'ball': h = (rr) => r - Math.sqrt(Math.max(0, r * r - rr * rr)); break;
    case 'bull': h = (rr) => (rr <= r0 ? 0 : rc - Math.sqrt(Math.max(0, rc * rc - (rr - r0) * (rr - r0)))); break;
    case 'cone': h = (rr) => rr * k; break;
    default: h = () => 0;
  }
  return { r, kind, rc, k, h };
}

/** Triangles bucketed on a grid in XY for neighbourhood queries. */
export class TriIndex {
  readonly n: number;
  readonly x0: number;
  readonly y0: number;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  readonly zMin: number;
  readonly zMax: number;
  private starts: Int32Array;
  private items: Int32Array;
  private stamp: Int32Array;
  private stampId = 0;
  /** Per triangle: xy bounds and the plane (normal with nz >= 0, and d) used by the facet test. */
  readonly bounds: Float64Array;
  readonly planes: Float64Array;

  constructor(readonly tris: Float64Array) {
    const n = (this.n = Math.floor(tris.length / 9));
    this.bounds = new Float64Array(n * 4);
    this.planes = new Float64Array(n * 4);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    let area = 0;
    for (let t = 0; t < n; t++) {
      const o = t * 9;
      const ax = tris[o], ay = tris[o + 1], az = tris[o + 2], bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5], cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];
      const mnx = Math.min(ax, bx, cx), mny = Math.min(ay, by, cy), mxx = Math.max(ax, bx, cx), mxy = Math.max(ay, by, cy);
      this.bounds.set([mnx, mny, mxx, mxy], t * 4);
      x0 = Math.min(x0, mnx); y0 = Math.min(y0, mny); x1 = Math.max(x1, mxx); y1 = Math.max(y1, mxy);
      z0 = Math.min(z0, az, bz, cz); z1 = Math.max(z1, az, bz, cz);
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l > 0) { nx /= l; ny /= l; nz /= l; }
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      this.planes.set([nx, ny, nz, nx * ax + ny * ay + nz * az], t * 4);
      area += (mxx - mnx) * (mxy - mny);
    }
    if (!n) { x0 = y0 = 0; x1 = y1 = 1; z0 = z1 = 0; }
    this.zMin = z0;
    this.zMax = z1;
    // Buckets about the size of a typical triangle, at most ~1M of them.
    const w = Math.max(x1 - x0, 1e-6), hgt = Math.max(y1 - y0, 1e-6);
    const typical = n ? Math.sqrt(area / n) : 1;
    let cell = Math.max(typical * 1.5, Math.sqrt((w * hgt) / 1e6), 0.05);
    cell = Math.max(cell, Math.max(w, hgt) / 2048);
    this.cell = cell;
    this.x0 = x0;
    this.y0 = y0;
    this.nx = Math.max(1, Math.ceil(w / cell) + 1);
    this.ny = Math.max(1, Math.ceil(hgt / cell) + 1);
    const counts = new Int32Array(this.nx * this.ny + 1);
    const span = (t: number) => {
      const b = t * 4;
      return [
        Math.floor((this.bounds[b] - x0) / cell), Math.floor((this.bounds[b + 1] - y0) / cell),
        Math.floor((this.bounds[b + 2] - x0) / cell), Math.floor((this.bounds[b + 3] - y0) / cell),
      ];
    };
    for (let t = 0; t < n; t++) {
      const [i0, j0, i1, j1] = span(t);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * this.nx + i + 1]++;
    }
    for (let k = 1; k < counts.length; k++) counts[k] += counts[k - 1];
    this.starts = counts;
    this.items = new Int32Array(counts[counts.length - 1]);
    const fill = counts.slice(0, -1);
    for (let t = 0; t < n; t++) {
      const [i0, j0, i1, j1] = span(t);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.items[fill[j * this.nx + i]++] = t;
    }
    this.stamp = new Int32Array(n);
  }

  /** Calls fn with each triangle whose XY bounds overlap the box (once each). */
  query(x0: number, y0: number, x1: number, y1: number, fn: (t: number) => void) {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x0 - this.x0) / c)), j0 = Math.max(0, Math.floor((y0 - this.y0) / c));
    const i1 = Math.min(this.nx - 1, Math.floor((x1 - this.x0) / c)), j1 = Math.min(this.ny - 1, Math.floor((y1 - this.y0) / c));
    if (i0 > i1 || j0 > j1) return;
    let id = ++this.stampId;
    if (id >= 0x7fffffff) { this.stamp.fill(0); id = this.stampId = 1; }
    const b = this.bounds;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cellIdx = j * this.nx + i;
        for (let k = this.starts[cellIdx], e = this.starts[cellIdx + 1]; k < e; k++) {
          const t = this.items[k];
          if (this.stamp[t] === id) continue;
          this.stamp[t] = id;
          const o = t * 4;
          if (b[o] > x1 || b[o + 2] < x0 || b[o + 1] > y1 || b[o + 3] < y0) continue;
          fn(t);
        }
      }
    }
  }
}

/** Height reported where the cutter touches nothing. */
export const NO_CONTACT = -1e9;

const GOLDEN = (Math.sqrt(5) - 1) / 2;

/**
 * Drop-cutter queries for one cutter on one mesh. Not reentrant: it keeps
 * scratch state between calls for speed.
 */
export class DropCutter {
  private best = NO_CONTACT;
  private px = 0;
  private py = 0;
  private readonly visit: (t: number) => void;
  /** Number of triangles tested (for diagnostics). */
  tested = 0;

  constructor(readonly index: TriIndex, readonly cutter: Cutter) {
    this.visit = (t) => this.testTriangle(t);
  }

  /** Lowest tip height at (x, y), or `floor` where the cutter touches nothing higher. */
  drop(x: number, y: number, floor = NO_CONTACT): number {
    this.best = floor;
    this.px = x;
    this.py = y;
    const r = this.cutter.r;
    this.index.query(x - r, y - r, x + r, y + r, this.visit);
    return this.best;
  }

  private testTriangle(t: number) {
    this.tested++;
    const T = this.index.tris;
    const o = t * 9;
    const px = this.px, py = this.py;
    const c = this.cutter;
    const r = c.r, r2 = r * r;
    // Quick reject: the triangle's top is below the best height found.
    const top = Math.max(T[o + 2], T[o + 5], T[o + 8]);
    if (top <= this.best) return;
    // Corners.
    for (let k = 0; k < 9; k += 3) {
      const dx = T[o + k] - px, dy = T[o + k + 1] - py;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) {
        const z = T[o + k + 2] - c.h(Math.sqrt(d2));
        if (z > this.best) this.best = z;
      }
    }
    // Face.
    const pl = this.index.planes, q = t * 4;
    const nx = pl[q], ny = pl[q + 1], nz = pl[q + 2], d = pl[q + 3];
    if (nz > 1e-9) {
      const gx = -nx / nz, gy = -ny / nz;
      const s = Math.hypot(gx, gy);
      let rr = 0, ux = 0, uy = 0;
      if (s > 1e-12) {
        ux = gx / s; uy = gy / s;
        rr = contactRadius(c, s);
      }
      const cx = px + ux * rr, cy = py + uy * rr;
      if (inTriangle(T, o, cx, cy)) {
        const zc = (d - nx * cx - ny * cy) / nz;
        const z = zc - c.h(rr);
        if (z > this.best) this.best = z;
      }
    }
    // Edges.
    this.edge(T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5]);
    this.edge(T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8]);
    this.edge(T[o + 6], T[o + 7], T[o + 8], T[o], T[o + 1], T[o + 2]);
  }

  private edge(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    const c = this.cutter;
    if (Math.max(az, bz) <= this.best) return;
    const px = this.px, py = this.py, r = c.r;
    const ex = bx - ax, ey = by - ay;
    const L2 = ex * ex + ey * ey;
    if (L2 < 1e-18) return;
    // Parameter range of the edge within the cutter's radius.
    const fx = ax - px, fy = ay - py;
    const B = 2 * (fx * ex + fy * ey), C = fx * fx + fy * fy - r * r;
    const disc = B * B - 4 * L2 * C;
    if (disc < 0) return;
    const sq = Math.sqrt(disc);
    let t0 = (-B - sq) / (2 * L2), t1 = (-B + sq) / (2 * L2);
    if (t1 < 0 || t0 > 1) return;
    t0 = Math.max(0, t0);
    t1 = Math.min(1, t1);
    const ez = bz - az;
    const zAt = (t: number) => {
      const x = ax + ex * t - px, y = ay + ey * t - py;
      return az + ez * t - c.h(Math.sqrt(x * x + y * y));
    };
    let z: number;
    if (c.kind === 'flat') {
      z = Math.max(az + ez * t0, az + ez * t1);
    } else if (c.kind === 'ball') {
      // In the vertical plane through the edge the ball is a circle of radius
      // R' = sqrt(R² - d²), d the distance from the cutter axis to the edge's line.
      const L = Math.sqrt(L2);
      const tf = -(fx * ex + fy * ey) / L2; // foot of the perpendicular
      const dx = ax + ex * tf - px, dy = ay + ey * tf - py;
      const d2 = dx * dx + dy * dy;
      const rp2 = r * r - d2;
      if (rp2 <= 0) return;
      const rp = Math.sqrt(rp2);
      const m = ez / L; // slope along the edge
      const k = Math.sqrt(1 + m * m);
      const tc = tf + (rp * m) / k / L; // contact point
      if (tc < t0 || tc > t1) {
        z = Math.max(zAt(t0), zAt(t1));
      } else {
        const zl = az + ez * tf;
        z = zl + rp * k - r;
      }
    } else {
      // Concave in t: golden-section search.
      let lo = t0, hi = t1;
      let a = hi - GOLDEN * (hi - lo), b = lo + GOLDEN * (hi - lo);
      let fa = zAt(a), fb = zAt(b);
      for (let i = 0; i < 40 && hi - lo > 1e-7; i++) {
        if (fa < fb) { lo = a; a = b; fa = fb; b = lo + GOLDEN * (hi - lo); fb = zAt(b); }
        else { hi = b; b = a; fb = fa; a = hi - GOLDEN * (hi - lo); fa = zAt(a); }
      }
      z = Math.max(fa, fb, zAt(t0), zAt(t1));
    }
    if (z > this.best) this.best = z;
  }
}

/** Radius at which a cutter touches a plane of slope s (rise per run). */
function contactRadius(c: Cutter, s: number): number {
  switch (c.kind) {
    case 'flat': return c.r;
    case 'ball': return (c.r * s) / Math.sqrt(1 + s * s);
    case 'bull': return c.r - c.rc + (c.rc * s) / Math.sqrt(1 + s * s);
    case 'cone': return s > c.k ? c.r : 0;
  }
}

function inTriangle(T: Float64Array, o: number, x: number, y: number): boolean {
  const ax = T[o], ay = T[o + 1], bx = T[o + 3], by = T[o + 4], cx = T[o + 6], cy = T[o + 7];
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const eps = 1e-12;
  const neg = d1 < -eps || d2 < -eps || d3 < -eps;
  const pos = d1 > eps || d2 > eps || d3 > eps;
  return !(neg && pos);
}
