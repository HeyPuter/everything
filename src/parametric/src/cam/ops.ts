// Toolpath generation for each kind of operation, in work coordinates.
//
// Everything is derived from drop-cutter heights (cl): where the tool may be
// at height z is where cl <= z. Clearing works level by level on that region:
// its boundary is found exactly (each grid crossing refined by bisection on
// the drop-cutter), the passes inside it are offsets from a distance
// transform of the region, cut from the innermost out so each pass takes one
// stepover of material. Waterline finishing follows the same exact
// boundaries; parallel finishing follows drop-cutter heights along lines.

import type { BoreOp, CamOperation, CamSetup, CamTool, ContourOp, DrillOp, FaceOp, ParallelOp, PocketOp, RoughOp, WaterlineOp } from '../model/cam';
import type { Vec3 } from '../math/vec';
import { type Cutter, cutterOf, DropCutter, NO_CONTACT, TriIndex, makeCutter } from './dropcutter';
import type { MachineFrame } from './frame';
import { type GridSpec, type Polyline, area, contours, edt, gridOver, pointInPolygon, polyLength, sample, signedDistance, simplify } from './grid';
import { PathBuilder, type Toolpath } from './toolpath';

export interface CamPart {
  frame: MachineFrame;
  /** Triangles in work coordinates. */
  tris: Float64Array;
  index: TriIndex;
}

/** A cylindrical face of the part (a hole candidate), in work coordinates. */
export interface Cylinder {
  name: string;
  /** A point on the axis and its direction. */
  p: Vec3;
  d: Vec3;
  radius: number;
  /** Its triangles. */
  tris: Float64Array;
  /** Picked in the operation (else it is a candidate only). */
  picked: boolean;
}

export interface OpInput {
  part: CamPart;
  setup: Pick<CamSetup, 'clearance' | 'retract'>;
  op: CamOperation;
  tool: CamTool;
  /** Pocket floors: the triangles of each picked face. */
  floors?: Float64Array[];
  cylinders?: Cylinder[];
  progress?: (fraction: number) => void;
  /** Checked between steps; generation stops when it returns true. */
  cancelled?: () => boolean;
}

export class CamError extends Error {}

class Cancelled extends Error {}

export function generate(input: OpInput): Toolpath {
  const { part, setup, op } = input;
  const top = part.frame.stock.max[2];
  const b = new PathBuilder(top + setup.clearance, top + setup.retract);
  const g = new Gen(input, b);
  switch (op.type) {
    case 'face': g.face(op); break;
    case 'contour': g.contour(op); break;
    case 'pocket': g.pocket(op); break;
    case 'drill': g.drill(op); break;
    case 'bore': g.bore(op); break;
    case 'rough': g.rough(op); break;
    case 'parallel': g.parallel(op); break;
    case 'waterline': g.waterline(op); break;
  }
  if (b.length === 0 && !b.warnings.length) b.warnings.push('The operation has nothing to cut.');
  return b.build();
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Heights from just below `top` down to `bottom` (included), `step` apart, with `extra` heights in between. */
export function stepLevels(top: number, bottom: number, step: number, extra: number[] = []): number[] {
  const out: number[] = [];
  if (!(top > bottom + 1e-9)) return [bottom];
  const n = Math.max(1, Math.ceil((top - bottom) / Math.max(step, 1e-3) - 1e-9));
  for (let i = 1; i <= n; i++) out.push(i === n ? bottom : top - i * step);
  for (const e of extra) if (e < top - 1e-6 && e > bottom + 1e-6 && out.every((z) => Math.abs(z - e) > 0.01)) out.push(e);
  return out.sort((a, c) => c - a);
}

interface Region {
  grid: GridSpec;
  /** Drop-cutter heights at the grid's nodes. */
  cl: Float64Array;
  /** Extra limit at the nodes (>= 0 where allowed), or null. */
  limit: Float64Array | null;
  limitAt: ((x: number, y: number) => number) | null;
  dc: DropCutter;
  /** Height added to drop-cutter heights (floor allowance). */
  lift: number;
}

class Gen {
  private readonly b: PathBuilder;
  private readonly part: CamPart;
  private readonly tool: CamTool;
  private readonly R: number;
  private steps = 0;
  private done = 0;

  constructor(private readonly input: OpInput, b: PathBuilder) {
    this.b = b;
    this.part = input.part;
    this.tool = input.tool;
    this.R = input.tool.diameter / 2;
  }

  private get stockTop() { return this.part.frame.stock.max[2]; }
  private get partTop() { return this.part.frame.part.max[2]; }
  private get partBottom() { return this.part.frame.part.min[2]; }

  private tick() {
    this.done++;
    if (this.input.cancelled?.()) throw new Cancelled('cancelled');
    this.input.progress?.(this.steps ? Math.min(1, this.done / this.steps) : 0);
  }

  // ---------- regions ----------

  /** Drop-cutter heights over a box, at a spacing fitting the tool. */
  private region(x0: number, y0: number, x1: number, y1: number, cutter: Cutter, lift = 0, cell?: number): Region {
    const c = cell ?? clamp(this.R / 5, 0.05, 0.5);
    const grid = gridOver(x0, y0, x1, y1, c, 450_000);
    const dc = new DropCutter(this.part.index, cutter);
    const cl = new Float64Array(grid.nx * grid.ny);
    for (let j = 0; j < grid.ny; j++) {
      const y = grid.y0 + j * grid.c;
      for (let i = 0; i < grid.nx; i++) cl[j * grid.nx + i] = dc.drop(grid.x0 + i * grid.c, y) + lift;
      if (j % 16 === 0 && this.input.cancelled?.()) throw new Cancelled('cancelled');
    }
    return { grid, cl, limit: null, limitAt: null, dc, lift };
  }

  /** Where the tool can be at height z (1) in a region. */
  private mask(r: Region, z: number): Uint8Array {
    const m = new Uint8Array(r.cl.length);
    for (let k = 0; k < m.length; k++) m[k] = r.cl[k] <= z + 1e-7 && (!r.limit || r.limit[k] >= 0) ? 1 : 0;
    return m;
  }

  /**
   * The boundary of where the tool can be at height z, exact: each crossing of
   * the grid is refined by bisection on the drop-cutter. Inside on the left.
   */
  private boundary(r: Region, z: number, tol: number): Polyline[] {
    const g = r.grid;
    const f = new Float64Array(r.cl.length);
    for (let k = 0; k < f.length; k++) f[k] = Math.min(z - r.cl[k], r.limit ? r.limit[k] : Infinity);
    const at = (x: number, y: number) => Math.min(z - (r.dc.drop(x, y) + r.lift), r.limitAt ? r.limitAt(x, y) : Infinity);
    const loops = contours(g, f, 0, (ax, ay, bx, by, t) => {
      // Bracket [lo, hi] with f(lo) >= 0 > f(hi).
      let lo = 0, hi = 1;
      const fa = at(ax + (bx - ax) * t, ay + (by - ay) * t);
      if (fa >= 0) lo = t; else hi = t;
      for (let i = 0; i < 16 && (hi - lo) * g.c > 1e-5; i++) {
        const m = (lo + hi) / 2;
        if (at(ax + (bx - ax) * m, ay + (by - ay) * m) >= 0) lo = m; else hi = m;
      }
      return lo;
    });
    return loops.filter((l) => polyLength(l.pts, 2, l.closed) > g.c * 1.5).map((l) => ({ pts: simplify(l.pts, tol, 2, l.closed), closed: l.closed }));
  }

  // ---------- path pieces ----------

  /** Rotates a closed loop to start at its point nearest (x, y). */
  private startNear(pts: number[], x: number, y: number): number[] {
    let best = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const d = (pts[i] - x) ** 2 + (pts[i + 1] - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return [...pts.slice(best), ...pts.slice(0, best)];
  }

  /** Cuts a closed loop at height z from its first point, back to it. */
  private loop(pts: number[], z: number) {
    const b = this.b;
    for (let i = 0; i < pts.length; i += 2) b.feed(pts[i], pts[i + 1], z);
    b.feed(pts[0], pts[1], z);
  }

  /**
   * Down along a closed loop from zFrom to z at the ramp angle, then once
   * round at z and on to the loop's first point.
   */
  private rampLoop(pts: number[], zFrom: number, z: number, angle: number) {
    const b = this.b;
    const n = pts.length / 2;
    const slope = Math.tan((clamp(angle, 0.5, 89) * Math.PI) / 180);
    let zc = zFrom;
    b.plunge(pts[0], pts[1], zc);
    let i = 0, guard = 0;
    // Ramp (possibly several laps on short loops).
    while (zc > z + 1e-9 && guard++ < n * 200) {
      const a = i % n, c = (i + 1) % n;
      const l = Math.hypot(pts[c * 2] - pts[a * 2], pts[c * 2 + 1] - pts[a * 2 + 1]);
      const dz = l * slope;
      if (zc - dz <= z) {
        const t = l > 0 ? (zc - z) / dz : 1;
        const x = pts[a * 2] + (pts[c * 2] - pts[a * 2]) * t, y = pts[a * 2 + 1] + (pts[c * 2 + 1] - pts[a * 2 + 1]) * t;
        b.plunge(x, y, z);
        zc = z;
        // Once round at depth from here, and on to the first point.
        for (let k = 1; k <= n; k++) { const q = (a + k) % n; b.feed(pts[q * 2], pts[q * 2 + 1], z); }
        b.feed(x, y, z);
        for (let q = (a + 1) % n; ; q = (q + 1) % n) {
          b.feed(pts[q * 2], pts[q * 2 + 1], z);
          if (q === 0) break;
        }
        return;
      }
      zc -= dz;
      b.plunge(pts[c * 2], pts[c * 2 + 1], zc);
      i++;
    }
    this.loop(pts, z);
  }

  /** A helix of radius rh around (cx, cy) from zFrom down to z, ending with one circle at z. */
  private helix(cx: number, cy: number, rh: number, zFrom: number, z: number, pitch: number, ccw: boolean, a0 = 0) {
    const b = this.b;
    const steps = 72;
    const turns = Math.max(0, (zFrom - z) / Math.max(pitch, 1e-3));
    const total = Math.ceil(turns * steps);
    const dir = ccw ? 1 : -1;
    b.plunge(cx + rh * Math.cos(a0), cy + rh * Math.sin(a0), zFrom);
    for (let s = 1; s <= total; s++) {
      const a = a0 + (dir * 2 * Math.PI * s) / steps;
      b.plunge(cx + rh * Math.cos(a), cy + rh * Math.sin(a), zFrom - ((zFrom - z) * s) / total);
    }
    const aEnd = a0 + (dir * 2 * Math.PI * total) / steps;
    for (let s = 1; s <= steps; s++) {
      const a = aEnd + (dir * 2 * Math.PI * s) / steps;
      b.feed(cx + rh * Math.cos(a), cy + rh * Math.sin(a), z);
    }
  }

  /** Down to the start of a cut at (x, y): rapid to just above the material (top), then the plunge feed. */
  private enter(x: number, y: number, top: number, z: number) {
    const b = this.b;
    const above = Math.min(b.retract, top + Math.min(1, b.retract));
    if (b.z > b.retract || Number.isNaN(b.z) || Math.hypot(b.x - x, b.y - y) > 1e-6) {
      b.rapidTo(x, y, b.retract);
      b.hop(b.retract, x, y, Math.max(above, z));
    }
    b.plunge(x, y, z);
  }

  /** Is the straight move from a to b inside the region (signed distance >= -slack)? */
  private insideAlong(g: GridSpec, s: Float64Array, ax: number, ay: number, bx: number, by: number, slack: number): boolean {
    const l = Math.hypot(bx - ax, by - ay);
    const n = Math.max(2, Math.ceil(l / (g.c * 0.5)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (sample(g, s, ax + (bx - ax) * t, ay + (by - ay) * t) < -slack) return false;
    }
    return true;
  }

  // ---------- clearing ----------

  private clear(r: Region, levels: number[], o: { stepover: number; pattern: 'offset' | 'zigzag'; climb: boolean; entry: 'helix' | 'ramp' | 'plunge'; rampAngle: number; tol: number; materialTop: number }) {
    const g = r.grid;
    let zPrev = o.materialTop;
    for (const z of levels) {
      this.tick();
      const m = this.mask(r, z);
      if (!m.some((v) => v)) { zPrev = z; continue; }
      const s = signedDistance(g, m);
      const finish = this.boundary(r, z, o.tol).filter((l) => l.closed);
      if (!o.climb) for (const l of finish) reverse2(l.pts);
      const rings: { pts: number[]; level: number; comp: number }[] = [];
      const label = components(g, m);
      const compOf = (pts: number[]) => {
        // A point just to the left of the loop (inside the region).
        for (let i = 0; i + 3 < pts.length; i += 2) {
          const dx = pts[i + 2] - pts[i], dy = pts[i + 3] - pts[i + 1];
          const l = Math.hypot(dx, dy);
          if (l < 1e-9) continue;
          const sgn = o.climb ? 1 : -1;
          const x = (pts[i] + pts[i + 2]) / 2 - (dy / l) * g.c * 0.75 * sgn, y = (pts[i + 1] + pts[i + 3]) / 2 + (dx / l) * g.c * 0.75 * sgn;
          const ii = Math.round((x - g.x0) / g.c), jj = Math.round((y - g.y0) / g.c);
          if (ii >= 0 && jj >= 0 && ii < g.nx && jj < g.ny && label[jj * g.nx + ii]) return label[jj * g.nx + ii];
        }
        return 0;
      };
      for (const l of finish) rings.push({ pts: l.pts, level: 0, comp: compOf(l.pts) });
      if (o.pattern === 'offset') {
        for (let k = 1; ; k++) {
          const lv = k * o.stepover;
          const ls = contours(g, s, lv).filter((l) => l.closed && polyLength(l.pts, 2, true) > g.c * 2);
          if (!ls.length) break;
          for (const l of ls) {
            const pts = simplify(l.pts, Math.min(g.c * 0.25, 0.02), 2, true);
            if (!o.climb) reverse2(pts);
            rings.push({ pts, level: k, comp: compOf(pts) });
          }
          if (k > 100000) break;
        }
        this.offsetPasses(g, s, label, rings, z, zPrev, o);
      } else {
        this.zigzagPasses(g, s, z, zPrev, o);
        // Then the walls.
        for (const ring of rings) {
          const pts = this.startNear(ring.pts, this.b.x, this.b.y);
          this.enter(pts[0], pts[1], zPrev, z);
          this.loop(pts, z);
        }
      }
      zPrev = z;
    }
  }

  private offsetPasses(g: GridSpec, s: Float64Array, label: Int32Array, rings: { pts: number[]; level: number; comp: number }[], z: number, zPrev: number, o: { stepover: number; climb: boolean; entry: 'helix' | 'ramp' | 'plunge'; rampAngle: number }) {
    const b = this.b;
    const comps = new Map<number, typeof rings>();
    for (const r of rings) {
      const list = comps.get(r.comp) ?? [];
      list.push(r);
      comps.set(r.comp, list);
    }
    const left = new Set(comps.keys());
    while (left.size) {
      // The component nearest to the tool.
      let next = -1, bd = Infinity;
      for (const c of left) {
        const rs = comps.get(c)!;
        for (const r of rs) {
          const d = Number.isNaN(b.x) ? 0 : (r.pts[0] - b.x) ** 2 + (r.pts[1] - b.y) ** 2;
          if (d < bd) { bd = d; next = c; }
        }
      }
      left.delete(next);
      const rs = comps.get(next)!;
      const maxLevel = Math.max(...rs.map((r) => r.level));
      let first = true;
      for (let lv = maxLevel; lv >= 0; lv--) {
        const pending = rs.filter((r) => r.level === lv);
        while (pending.length) {
          // Nearest loop of this level.
          let bi = 0, bdist = Infinity;
          pending.forEach((r, i) => {
            for (let k = 0; k < r.pts.length; k += 2) {
              const d = Number.isNaN(b.x) ? 0 : (r.pts[k] - b.x) ** 2 + (r.pts[k + 1] - b.y) ** 2;
              if (d < bdist) { bdist = d; bi = i; }
            }
          });
          const ring = pending.splice(bi, 1)[0];
          const pts = Number.isNaN(b.x) ? ring.pts : this.startNear(ring.pts, b.x, b.y);
          if (first) {
            first = false;
            this.entryInto(g, s, label, next, pts, z, zPrev, o);
          } else if (Math.sqrt(bdist) <= o.stepover * 1.6 + g.c && b.z === z && this.insideAlong(g, s, b.x, b.y, pts[0], pts[1], g.c * 0.25)) {
            b.feed(pts[0], pts[1], z);
            this.loop(pts, z);
          } else {
            this.enter(pts[0], pts[1], zPrev, z);
            this.loop(pts, z);
          }
        }
      }
    }
  }

  /** Into the material at the first pass of a region: a helix at its deepest point, a ramp or a plunge. */
  private entryInto(g: GridSpec, s: Float64Array, label: Int32Array, comp: number, pts: number[], z: number, zPrev: number, o: { climb: boolean; entry: 'helix' | 'ramp' | 'plunge'; rampAngle: number }) {
    const b = this.b;
    const zFrom = Math.min(zPrev + 0.5, b.retract);
    // Outside the stock: no material to enter.
    const st = this.part.frame.stock;
    const outside = (x: number, y: number) => x < st.min[0] - this.R || x > st.max[0] + this.R || y < st.min[1] - this.R || y > st.max[1] + this.R;
    if (outside(pts[0], pts[1])) {
      this.enter(pts[0], pts[1], zPrev, z);
      this.loop(pts, z);
      return;
    }
    if (o.entry === 'helix') {
      // The deepest point of the region.
      let best = -1, bv = -Infinity;
      for (let k = 0; k < s.length; k++) if (label[k] === comp && s[k] > bv) { bv = s[k]; best = k; }
      const rh = Math.min(bv * 0.9, this.R * 0.9);
      if (best >= 0 && rh >= this.R * 0.15) {
        const cx = g.x0 + (best % g.nx) * g.c, cy = g.y0 + Math.floor(best / g.nx) * g.c;
        const pitch = 2 * Math.PI * rh * Math.tan((clamp(o.rampAngle, 0.5, 45) * Math.PI) / 180);
        b.rapidTo(cx + rh, cy, b.retract);
        b.hop(b.retract, cx + rh, cy, Math.max(zFrom, z));
        this.helix(cx, cy, rh, Math.max(zFrom, z), z, pitch, o.climb);
        const start = this.startNear(pts, b.x, b.y);
        b.feed(start[0], start[1], z);
        this.loop(start, z);
        return;
      }
    }
    if (o.entry !== 'plunge' && polyLength(pts, 2, true) > this.R) {
      b.rapidTo(pts[0], pts[1], b.retract);
      b.hop(b.retract, pts[0], pts[1], Math.max(zFrom, z));
      this.rampLoop(pts, Math.max(zFrom, z), z, o.rampAngle);
      return;
    }
    this.enter(pts[0], pts[1], zPrev, z);
    this.loop(pts, z);
  }

  private zigzagPasses(g: GridSpec, s: Float64Array, z: number, zPrev: number, o: { stepover: number; entry: 'helix' | 'ramp' | 'plunge'; rampAngle: number }) {
    const b = this.b;
    const y0 = g.y0, y1 = g.y0 + (g.ny - 1) * g.c;
    let row = 0, prevEnd: [number, number] | null = null;
    for (let y = y0 + o.stepover * 0.5; y <= y1; y += o.stepover, row++) {
      // Runs along the row where the region is.
      const runs: [number, number][] = [];
      let start: number | null = null;
      const step = g.c * 0.5;
      const x1 = g.x0 + (g.nx - 1) * g.c;
      for (let x = g.x0; x <= x1 + 1e-9; x += step) {
        const v = sample(g, s, x, y);
        if (v >= 0 && start === null) start = x;
        if ((v < 0 || x + step > x1 + 1e-9) && start !== null) {
          const end = v < 0 ? x - step : x;
          if (end - start > g.c) runs.push([start, end]);
          start = null;
        }
      }
      if (row % 2) runs.reverse();
      for (const [ra, rb] of runs) {
        const [xa, xb] = row % 2 ? [rb, ra] : [ra, rb];
        if (prevEnd && b.z === z && Math.abs(prevEnd[1] - y) <= o.stepover * 1.01 + 1e-9 && this.insideAlong(g, s, prevEnd[0], prevEnd[1], xa, y, g.c * 0.25)) {
          b.feed(xa, y, z);
        } else if (o.entry !== 'plunge' && Math.abs(xb - xa) > this.R) {
          // Ramp back and forth along the start of the run.
          const zFrom = Math.max(Math.min(zPrev + 0.5, b.retract), z);
          b.rapidTo(xa, y, b.retract);
          b.hop(b.retract, xa, y, zFrom);
          const slope = Math.tan((clamp(o.rampAngle, 0.5, 89) * Math.PI) / 180);
          const len = Math.min(Math.abs(xb - xa), Math.max(this.R * 2, 1));
          const dir = Math.sign(xb - xa);
          let zc = zFrom, fwd = true, guard = 0;
          while (zc > z + 1e-9 && guard++ < 1000) {
            const nz = Math.max(z, zc - len * slope);
            const frac = (zc - nz) / (len * slope);
            const x = fwd ? xa + dir * len * frac : xa + dir * len * (1 - frac);
            b.plunge(x, y, nz);
            zc = nz;
            fwd = !fwd;
          }
          b.feed(xa, y, z);
        } else {
          this.enter(xa, y, zPrev, z);
        }
        b.feed(xb, y, z);
        prevEnd = [xb, y];
      }
    }
  }

  // ---------- operations ----------

  face(op: FaceOp) {
    const b = this.b;
    const st = this.part.frame.stock;
    const R = this.R;
    const zEnd = this.partTop + (op.leave ?? 0);
    const levels = stepLevels(this.stockTop, zEnd, op.stepdown);
    const a = (op.angle * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    // Stock corners in the pass frame (u along the passes, v across).
    const corners = [[st.min[0], st.min[1]], [st.max[0], st.min[1]], [st.max[0], st.max[1]], [st.min[0], st.max[1]]];
    const us = corners.map(([x, y]) => x * ca + y * sa), vs = corners.map(([x, y]) => -x * sa + y * ca);
    const u0 = Math.min(...us) - R - 2, u1 = Math.max(...us) + R + 2;
    const v0 = Math.min(...vs), v1 = Math.max(...vs);
    const lo = v0 + 0.4 * R, hi = v1 - 0.4 * R;
    const n = hi > lo ? Math.ceil((hi - lo) / Math.max(op.stepover, 0.01)) + 1 : 1;
    const vAt = (i: number) => (n === 1 ? (v0 + v1) / 2 : lo + ((hi - lo) * i) / (n - 1));
    const xy = (u: number, v: number): [number, number] => [u * ca - v * sa, u * sa + v * ca];
    this.steps = levels.length;
    for (const z of levels) {
      this.tick();
      for (let i = 0; i < n; i++) {
        const v = vAt(i);
        const [ua, ub] = i % 2 ? [u1, u0] : [u0, u1];
        const [xa, ya] = xy(ua, v), [xb, yb] = xy(ub, v);
        if (i === 0) {
          // Off the stock: straight down.
          b.rapidTo(xa, ya, b.retract);
          b.plunge(xa, ya, z);
        } else b.feed(xa, ya, z);
        b.feed(xb, yb, z);
      }
      b.rapidTo(b.x, b.y, b.retract);
    }
  }

  contour(op: ContourOp) {
    const b = this.b;
    const R = this.R;
    const pb = this.part.frame.part;
    const lead = Math.max(0, op.lead ?? 0);
    const margin = R + op.leave + lead * 2 + 3;
    const cutter = cutterOf(this.tool, op.leave);
    const bottom = this.partBottom - Math.max(0, op.breakthrough);
    const levels = stepLevels(this.stockTop, bottom, op.stepdown);
    this.steps = levels.length + 1;
    const r = this.region(pb.min[0] - margin, pb.min[1] - margin, pb.max[0] + margin, pb.max[1] + margin, cutter, 0, clamp(R / 6, 0.05, 0.4));
    this.tick();
    const climb = op.direction !== 'conventional';
    const tabTop = this.partBottom + Math.max(0, op.tabs?.height ?? 0);
    const tabs = (op.tabs?.count ?? 0) > 0;
    let zPrev = this.stockTop;
    for (const z of levels) {
      this.tick();
      const all = this.boundary(r, z, 0.005).filter((l) => l.closed);
      // Loops round the part (clockwise, the part on the right), outermost only.
      const around = all.filter((l) => area(l.pts) < 0);
      const outer = around.filter((l) => !around.some((o) => o !== l && Math.abs(area(o.pts)) > Math.abs(area(l.pts)) && pointInPolygon(o.pts, l.pts[0], l.pts[1])));
      const pending = outer.map((l) => (climb ? l.pts : reverse2(l.pts.slice())));
      while (pending.length) {
        let bi = 0, bd = Infinity;
        pending.forEach((p, i) => { const d = Number.isNaN(b.x) ? 0 : (p[0] - b.x) ** 2 + (p[1] - b.y) ** 2; if (d < bd) { bd = d; bi = i; } });
        let pts = pending.splice(bi, 1)[0];
        pts = Number.isNaN(b.x) ? pts : this.startNear(pts, b.x, b.y);
        pts = startOnStraight(pts);
        const withTabs = tabs && z < tabTop - 1e-6;
        this.contourPass(pts, z, zPrev, lead, climb, op.rampAngle, withTabs ? { ...op.tabs, top: tabTop } : null);
      }
      zPrev = z;
    }
  }

  private contourPass(pts: number[], z: number, zPrev: number, lead: number, climb: boolean, rampAngle: number, tabs: { count: number; width: number; top: number } | null) {
    const b = this.b;
    const n = pts.length / 2;
    const x0 = pts[0], y0 = pts[1];
    const tx = pts[2] - x0, ty = pts[3] - y0;
    const tl = Math.hypot(tx, ty) || 1;
    const T = [tx / tl, ty / tl];
    // Air is on the left when climbing (the part on the right), on the right otherwise.
    const side = climb ? 1 : -1;
    const N = [-T[1] * side, T[0] * side];
    const zStart = Math.min(zPrev, this.stockTop) + 0.5;
    const arc = (cx: number, cy: number, from: number, sweep: number, zz: number, kind: 'feed' | 'plunge') => {
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const a = from + (sweep * i) / steps;
        const px = cx + lead * Math.cos(a), py = cy + lead * Math.sin(a);
        if (kind === 'feed') b.feed(px, py, zz); else b.plunge(px, py, zz);
      }
    };
    // Lead-in: a quarter arc from the air side, tangent at the start.
    if (lead > 1e-6) {
      const cx = x0 + N[0] * lead, cy = y0 + N[1] * lead;
      const aStart = Math.atan2(-T[1], -T[0]);
      const sx = cx + lead * Math.cos(aStart), sy = cy + lead * Math.sin(aStart);
      b.rapidTo(sx, sy, b.retract);
      b.hop(b.retract, sx, sy, zStart);
      b.plunge(sx, sy, zStart);
      const aEnd = Math.atan2(-N[1], -N[0]);
      let sweep = aEnd - aStart;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      arc(cx, cy, aStart, sweep, zStart, 'feed');
    } else {
      b.rapidTo(x0, y0, b.retract);
      b.hop(b.retract, x0, y0, zStart);
    }
    // Ramp down along the loop, then once round at depth.
    if (!tabs) this.rampLoop(pts, zStart, z, rampAngle);
    else {
      this.rampLoop(pts, zStart, Math.max(z, tabs.top), rampAngle);
      // Lifted over the tabs on the last levels.
      const len = polyLength(pts, 2, true);
      const span = tabs.width + this.R * 2;
      const centers = Array.from({ length: tabs.count }, (_, i) => ((i + 0.5) * len) / tabs.count);
      const inTab = (s: number) => centers.some((c) => Math.abs(s - c) < span / 2);
      const zAt = (s: number) => (inTab(s) ? Math.max(z, tabs.top) : z);
      let s = 0;
      b.plunge(x0, y0, zAt(0));
      for (let i = 1; i <= n; i++) {
        const a = (i - 1) % n, c = i % n;
        const ax = pts[a * 2], ay = pts[a * 2 + 1], cx = pts[c * 2], cy = pts[c * 2 + 1];
        const l = Math.hypot(cx - ax, cy - ay);
        // Split the segment where it enters or leaves a tab.
        const cuts = [0, 1];
        for (const ct of centers) for (const e of [ct - span / 2, ct + span / 2]) { const t = (e - s) / (l || 1); if (t > 0 && t < 1) cuts.push(t); }
        cuts.sort((p, q) => p - q);
        for (let k = 1; k < cuts.length; k++) {
          const t0 = cuts[k - 1], t1 = cuts[k];
          const zz = zAt(s + l * (t0 + t1) / 2);
          const px = ax + (cx - ax) * t0, py = ay + (cy - ay) * t0;
          if (Math.abs(b.z - zz) > 1e-9) b.plunge(px, py, zz);
          b.feed(ax + (cx - ax) * t1, ay + (cy - ay) * t1, zz);
        }
        s += l;
      }
    }
    // Lead-out: a quarter arc back to the air side.
    if (lead > 1e-6) {
      const ex = b.x, ey = b.y;
      const cx = ex + N[0] * lead, cy = ey + N[1] * lead;
      const aStart = Math.atan2(-N[1], -N[0]);
      const aEnd = Math.atan2(T[1], T[0]);
      let sweep = aEnd - aStart;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      arc(cx, cy, aStart, sweep, b.z, 'feed');
    }
    b.rapid(b.x, b.y, b.retract);
  }

  pocket(op: PocketOp) {
    const floors = this.input.floors ?? [];
    if (!floors.length) throw new CamError('Pick the floor faces of the pockets.');
    const R = this.R;
    // Group the floors by height.
    const groups = new Map<number, Float64Array[]>();
    for (const t of floors) {
      let zs = 0, n = 0, flat = true;
      for (let i = 0; i < t.length; i += 9) {
        const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2], vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        if (l > 1e-12 && Math.abs(nz) / l < 0.999) flat = false;
        zs += t[i + 2] + t[i + 5] + t[i + 8];
        n += 3;
      }
      if (!flat || !n) { this.b.warnings.push('A picked face is not flat and facing the tool; it was skipped.'); continue; }
      const z = Math.round((zs / n) * 1e4) / 1e4;
      const key = [...groups.keys()].find((k) => Math.abs(k - z) < 1e-3) ?? z;
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    const order = [...groups.keys()].sort((a, c) => c - a);
    this.steps = order.reduce((s, z) => s + stepLevels(this.stockTop, z + op.floorLeave, op.stepdown).length + 1, 0);
    for (const zf of order) {
      const tris = groups.get(zf)!;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const t of tris) for (let i = 0; i < t.length; i += 3) { x0 = Math.min(x0, t[i]); x1 = Math.max(x1, t[i]); y0 = Math.min(y0, t[i + 1]); y1 = Math.max(y1, t[i + 1]); }
      const m = R + 2;
      const r = this.region(x0 - m, y0 - m, x1 + m, y1 + m, cutterOf(this.tool, op.leave), 0);
      this.tick();
      // Near the floor: the tool must reach over it.
      const g = r.grid;
      const on = new Uint8Array(g.nx * g.ny);
      for (const t of tris) rasterTriangles(g, t, on);
      const d2 = edt(g, (k) => !!on[k]);
      const dist = new Float64Array(d2.length);
      for (let k = 0; k < d2.length; k++) dist[k] = Math.sqrt(d2[k]) * g.c;
      const reach = R * 0.98;
      r.limit = dist.map((d) => reach - d);
      r.limitAt = (x, y) => reach - sample(g, dist, x, y);
      const levels = stepLevels(this.stockTop, zf + op.floorLeave, op.stepdown);
      this.clear(r, levels, { stepover: op.stepover, pattern: op.pattern, climb: op.direction !== 'conventional', entry: op.entry, rampAngle: op.rampAngle, tol: 0.005, materialTop: this.stockTop });
    }
  }

  rough(op: RoughOp) {
    const st = this.part.frame.stock;
    const R = this.R;
    const m = R + 2;
    const cutter = cutterOf(this.tool, op.leave);
    const flats = flatHeights(this.part.tris, this.partBottom, this.stockTop).map((h) => h + op.floorLeave);
    const levels = stepLevels(this.stockTop, this.partBottom + op.floorLeave, op.stepdown, flats);
    this.steps = levels.length + 1;
    const r = this.region(st.min[0] - m, st.min[1] - m, st.max[0] + m, st.max[1] + m, cutter, op.floorLeave);
    this.tick();
    if (st.min[2] >= this.partBottom - 1e-6) this.b.warnings.push('The roughing goes down to the bottom of the part, which is the bottom of the stock. Leave stock below the part (Setup: stock below) to keep it held.');
    // The tool stays within the stock (plus most of its radius, to cut its edges).
    const gx = R * 0.9;
    const lim = (x: number, y: number) => Math.min(x - (st.min[0] - gx), st.max[0] + gx - x, y - (st.min[1] - gx), st.max[1] + gx - y);
    const g = r.grid;
    r.limit = new Float64Array(g.nx * g.ny);
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) r.limit[j * g.nx + i] = lim(g.x0 + i * g.c, g.y0 + j * g.c);
    r.limitAt = lim;
    this.clear(r, levels, { stepover: op.stepover, pattern: op.pattern, climb: op.direction !== 'conventional', entry: op.entry, rampAngle: op.rampAngle, tol: 0.01, materialTop: this.stockTop });
  }

  /** Holes that open toward the tool, from the cylinders. */
  private holes(picked: boolean, diameter: number | null) {
    const cyl = (this.input.cylinders ?? []).filter((c) => Math.abs(Math.abs(c.d[2]) - 1) < 1e-3 && (!picked || c.picked));
    // Merge faces of the same hole (split cylinders).
    const holes: { x: number; y: number; r: number; top: number; bottom: number }[] = [];
    for (const c of cyl) {
      let top = -Infinity, bottom = Infinity;
      for (let i = 2; i < c.tris.length; i += 3) { top = Math.max(top, c.tris[i]); bottom = Math.min(bottom, c.tris[i]); }
      if (!Number.isFinite(top)) continue;
      const h = holes.find((o) => Math.hypot(o.x - c.p[0], o.y - c.p[1]) < 1e-3 && Math.abs(o.r - c.radius) < 1e-3);
      if (h) { h.top = Math.max(h.top, top); h.bottom = Math.min(h.bottom, bottom); } else holes.push({ x: c.p[0], y: c.p[1], r: c.radius, top, bottom });
    }
    const pin = new DropCutter(this.part.index, makeCutter('flat', 1e-3, 0, 0));
    const out: { x: number; y: number; r: number; top: number; bottom: number; through: boolean }[] = [];
    for (const h of holes) {
      if (diameter != null && Math.abs(2 * h.r - diameter) > Math.max(0.05, diameter * 0.01)) continue;
      // A hole, not a boss: nothing at its centre down to its bottom.
      const centre = pin.drop(h.x, h.y);
      if (centre > h.bottom + 1e-3) continue;
      // Reachable from above: a cutter nearly as wide goes down to the bottom.
      const wide = new DropCutter(this.part.index, makeCutter('flat', h.r * 0.95, 0, 0)).drop(h.x, h.y);
      if (wide > h.bottom + 1e-3) continue;
      const point = h.r / Math.tan((59 * Math.PI) / 180);
      out.push({ ...h, through: centre < h.bottom - point - 1e-2 });
    }
    return nearestOrder(out);
  }

  drill(op: DrillOp) {
    const b = this.b;
    const anyPicked = (this.input.cylinders ?? []).some((c) => c.picked);
    const holes = this.holes(anyPicked, anyPicked ? null : this.tool.diameter);
    if (!holes.length) {
      b.warnings.push(anyPicked ? 'None of the picked faces is a hole that opens toward the tool.' : `No hole of the tool's diameter (${this.tool.diameter} mm) opens toward the tool. Pick the holes to drill.`);
      return;
    }
    const tip = this.tool.type === 'drill' || this.tool.type === 'chamfer' ? this.R / Math.tan(((this.tool.tipAngle ?? 118) / 2) * Math.PI / 180) : 0;
    this.steps = holes.length;
    for (const h of holes) {
      this.tick();
      if (Math.abs(2 * h.r - this.tool.diameter) > Math.max(0.05, h.r * 0.02)) b.warnings.push(`A hole of ${(2 * h.r).toFixed(3)} mm is drilled with a ${this.tool.diameter} mm tool.`);
      const z = h.through ? h.bottom - Math.max(0, op.breakthrough) - (op.tipThrough ? tip : 0) : h.bottom;
      b.cycle(h.x, h.y, { cycle: op.cycle, r: h.top + this.input.setup.retract, z, peck: op.cycle === 'drill' ? 0 : Math.max(0.05, op.peck), dwell: Math.max(0, op.dwell) });
    }
  }

  bore(op: BoreOp) {
    const b = this.b;
    const anyPicked = (this.input.cylinders ?? []).some((c) => c.picked);
    const holes = this.holes(anyPicked, null).filter((h) => h.r - op.leave > this.R * 1.05);
    if (!holes.length) { b.warnings.push(anyPicked ? 'No picked hole is larger than the tool.' : 'Pick the holes to bore; they must be larger than the tool.'); return; }
    if (!anyPicked) b.warnings.push('No holes picked: every hole larger than the tool is bored.');
    this.steps = holes.length;
    const climb = op.direction !== 'conventional';
    for (const h of holes) {
      this.tick();
      const rh = h.r - op.leave - this.R;
      const z = h.through ? h.bottom - Math.max(0, op.breakthrough) : h.bottom;
      const zFrom = h.top + 0.5;
      b.rapidTo(h.x + rh, h.y, h.top + this.input.setup.retract);
      b.rapid(h.x + rh, h.y, zFrom + 0.5);
      this.helix(h.x, h.y, rh, zFrom, z, Math.max(0.05, op.pitch), climb);
      // Away from the wall and out through the middle.
      b.feed(h.x, h.y, z);
      b.rapid(h.x, h.y, h.top + this.input.setup.retract);
    }
  }

  parallel(op: ParallelOp) {
    const R = this.R;
    const cutter = cutterOf(this.tool, op.leave);
    const dc = new DropCutter(this.part.index, cutter);
    const pb = this.part.frame.part;
    const st = this.part.frame.stock;
    const box = op.boundary === 'stock' ? { x0: st.min[0], y0: st.min[1], x1: st.max[0], y1: st.max[1] } : { x0: pb.min[0] - R, y0: pb.min[1] - R, x1: pb.max[0] + R, y1: pb.max[1] + R };
    const floor = this.partBottom;
    const a = (op.angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const cs = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]];
    const us = cs.map(([x, y]) => x * ca + y * sa), vs = cs.map(([x, y]) => -x * sa + y * ca);
    const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
    const xy = (u: number, v: number): [number, number] => [u * ca - v * sa, u * sa + v * ca];
    const inBox = (x: number, y: number) => x >= box.x0 - 1e-9 && x <= box.x1 + 1e-9 && y >= box.y0 - 1e-9 && y <= box.y1 + 1e-9;
    const ds = clamp(Math.min(op.stepover, R / 4), 0.05, 0.25);
    const step = Math.max(op.stepover, 0.01);
    const nLines = Math.max(1, Math.floor((v1 - v0) / step) + 1);
    const vStart = v0 + ((v1 - v0) - (nLines - 1) * step) / 2;
    this.steps = nLines;
    const zAt = (x: number, y: number) => {
      const z = dc.drop(x, y);
      if (z <= NO_CONTACT / 2) return op.boundary === 'stock' ? floor + op.leave : null;
      return z + op.leave;
    };
    const runs: number[][] = [];
    for (let li = 0; li < nLines; li++) {
      this.tick();
      const v = vStart + li * step;
      const nu = Math.max(1, Math.ceil((u1 - u0) / ds));
      let cur: number[] = [];
      const lineRuns: number[][] = [];
      for (let k = 0; k <= nu; k++) {
        const u = u0 + ((u1 - u0) * k) / nu;
        const [x, y] = xy(u, v);
        const z = inBox(x, y) ? zAt(x, y) : null;
        if (z === null) { if (cur.length >= 6) lineRuns.push(cur); cur = []; continue; }
        cur.push(x, y, z);
      }
      if (cur.length >= 6) lineRuns.push(cur);
      if (li % 2) { lineRuns.reverse(); for (const r of lineRuns) reverse3(r); }
      for (const r of lineRuns) runs.push(simplify(r, Math.max(op.tolerance, 1e-4), 3));
    }
    this.linkRuns(runs, dc, op.leave, op.stepover, ds);
  }

  /** Cuts 3D runs in order, staying down over short gaps (following the surface) and lifting over long ones. */
  private linkRuns(runs: number[][], dc: DropCutter, lift: number, stepover: number, ds: number) {
    const b = this.b;
    for (const r of runs) {
      const x = r[0], y = r[1], z = r[2];
      const gap = Number.isNaN(b.x) ? Infinity : Math.hypot(x - b.x, y - b.y);
      if (gap <= stepover * 2 + ds && b.z < b.retract) {
        // Follow the surface across.
        const n = Math.max(1, Math.ceil(gap / ds));
        const px = b.x, py = b.y;
        for (let k = 1; k < n; k++) {
          const qx = px + ((x - px) * k) / n, qy = py + ((y - py) * k) / n;
          const qz = dc.drop(qx, qy);
          b.feed(qx, qy, Math.max(qz + lift, Math.min(b.z, z)));
        }
        b.feed(x, y, z);
      } else {
        b.rapidTo(x, y, b.retract);
        b.hop(b.retract, x, y, Math.min(b.retract, z + 1));
        b.plunge(x, y, z);
      }
      for (let i = 3; i < r.length; i += 3) b.feed(r[i], r[i + 1], r[i + 2]);
    }
  }

  waterline(op: WaterlineOp) {
    const b = this.b;
    const R = this.R;
    const pb = this.part.frame.part;
    const m = R + op.leave + 3;
    const cutter = cutterOf(this.tool, op.leave);
    const topZ = this.partTop + op.leave;
    const levels = stepLevels(topZ, this.partBottom + op.leave + 1e-3, op.stepdown);
    this.steps = levels.length + 1;
    const r = this.region(pb.min[0] - m, pb.min[1] - m, pb.max[0] + m, pb.max[1] + m, cutter, op.leave, clamp(R / 6, 0.05, 0.4));
    this.tick();
    const climb = op.direction !== 'conventional';
    for (const z of levels) {
      this.tick();
      const loops = this.boundary(r, z, Math.max(op.tolerance, 1e-4)).filter((l) => l.closed);
      const pending = loops.map((l) => (climb ? l.pts : reverse2(l.pts.slice())));
      while (pending.length) {
        let bi = 0, bd = Infinity;
        pending.forEach((p, i) => { for (let k = 0; k < p.length; k += 2) { const d = Number.isNaN(b.x) ? 0 : (p[k] - b.x) ** 2 + (p[k + 1] - b.y) ** 2; if (d < bd) { bd = d; bi = i; } } });
        const raw = pending.splice(bi, 1)[0];
        const pts = Number.isNaN(b.x) ? raw : this.startNear(raw, b.x, b.y);
        b.rapidTo(pts[0], pts[1], b.retract);
        b.hop(b.retract, pts[0], pts[1], Math.min(b.retract, z + 1));
        b.plunge(pts[0], pts[1], z);
        this.loop(pts, z);
        b.rapid(b.x, b.y, Math.min(b.retract, z + 1));
      }
    }
  }
}

/** Reverses a 2D point list in place (keeping its first point first). */
function reverse2(pts: number[]): number[] {
  const n = pts.length / 2;
  const out: number[] = [pts[0], pts[1]];
  for (let i = n - 1; i >= 1; i--) out.push(pts[i * 2], pts[i * 2 + 1]);
  for (let i = 0; i < pts.length; i++) pts[i] = out[i];
  return pts;
}

function reverse3(pts: number[]) {
  const n = pts.length / 3;
  for (let i = 0, j = n - 1; i < j; i++, j--) for (let k = 0; k < 3; k++) { const t = pts[i * 3 + k]; pts[i * 3 + k] = pts[j * 3 + k]; pts[j * 3 + k] = t; }
}

/** Starts a closed loop in the middle of its longest segment (leads and tabs sit better there than on a corner). */
function startOnStraight(pts: number[]): number[] {
  const n = pts.length / 2;
  let best = 0, bl = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const l = Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
    if (l > bl) { bl = l; best = i; }
  }
  const j = (best + 1) % n;
  const mx = (pts[best * 2] + pts[j * 2]) / 2, my = (pts[best * 2 + 1] + pts[j * 2 + 1]) / 2;
  const out = [mx, my];
  for (let k = 1; k <= n; k++) { const q = (best + k) % n; out.push(pts[q * 2], pts[q * 2 + 1]); }
  return out;
}

/** 4-connected components of a node mask (labels from 1; 0 outside). */
function components(g: GridSpec, m: Uint8Array): Int32Array {
  const label = new Int32Array(m.length);
  let next = 0;
  const stack: number[] = [];
  for (let k = 0; k < m.length; k++) {
    if (!m[k] || label[k]) continue;
    next++;
    label[k] = next;
    stack.push(k);
    while (stack.length) {
      const p = stack.pop()!;
      const i = p % g.nx, j = (p - i) / g.nx;
      const nb = [i > 0 ? p - 1 : -1, i < g.nx - 1 ? p + 1 : -1, j > 0 ? p - g.nx : -1, j < g.ny - 1 ? p + g.nx : -1];
      for (const q of nb) if (q >= 0 && m[q] && !label[q]) { label[q] = next; stack.push(q); }
    }
  }
  return label;
}

/** Sets the nodes covered by the triangles (projected on XY). */
function rasterTriangles(g: GridSpec, t: Float64Array, out: Uint8Array) {
  for (let o = 0; o + 8 < t.length; o += 9) {
    const ax = t[o], ay = t[o + 1], bx = t[o + 3], by = t[o + 4], cx = t[o + 6], cy = t[o + 7];
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - g.x0) / g.c)), i1 = Math.min(g.nx - 1, Math.floor((Math.max(ax, bx, cx) - g.x0) / g.c));
    const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - g.y0) / g.c)), j1 = Math.min(g.ny - 1, Math.floor((Math.max(ay, by, cy) - g.y0) / g.c));
    const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(d) < 1e-14) continue;
    for (let j = j0; j <= j1; j++) {
      const y = g.y0 + j * g.c;
      for (let i = i0; i <= i1; i++) {
        const x = g.x0 + i * g.c;
        const w1 = ((bx - x) * (cy - y) - (cx - x) * (by - y)) / d;
        const w2 = ((cx - x) * (ay - y) - (ax - x) * (cy - y)) / d;
        const w3 = 1 - w1 - w2;
        if (w1 >= -1e-9 && w2 >= -1e-9 && w3 >= -1e-9) out[j * g.nx + i] = 1;
      }
    }
  }
}

/** Heights of the part's flat areas facing the tool, between two heights. */
export function flatHeights(tris: Float64Array, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let o = 0; o + 8 < tris.length; o += 9) {
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12 || Math.abs(nz) / l < 0.99999) continue;
    const z = (tris[o + 2] + tris[o + 5] + tris[o + 8]) / 3;
    if (z <= lo + 1e-6 || z >= hi - 1e-6) continue;
    if (out.every((h) => Math.abs(h - z) > 0.005)) out.push(z);
  }
  return out;
}

function nearestOrder<T extends { x: number; y: number }>(items: T[]): T[] {
  const left = items.slice();
  const out: T[] = [];
  let x = 0, y = 0;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((h, i) => { const d = (h.x - x) ** 2 + (h.y - y) ** 2; if (d < bd) { bd = d; bi = i; } });
    const h = left.splice(bi, 1)[0];
    out.push(h);
    x = h.x; y = h.y;
  }
  return out;
}

/** Was generation stopped (a newer request replaced it)? */
export const isCancelled = (e: unknown) => e instanceof Cancelled;
