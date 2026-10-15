// Brush math shared by Sculpt Curves mode and Particle Edit mode. Strands are runs of points
// (positions xyz, offsets per strand, the first point is the root). Brushes act in screen space
// through a Projector: points are projected, moved in the view plane at their own depth and
// projected back. Everything here is pure (no app state) so it can be unit tested.
import { Matrix4 } from 'three';

export interface Projector {
  /** object space → [screen x px, screen y px, depth (NDC z)] */
  toScreen(x: number, y: number, z: number, out: Float64Array): void;
  /** screen position at a depth → object space */
  fromScreen(sx: number, sy: number, depth: number, out: Float64Array): void;
}

/** Projector from a column-major object → clip matrix and a viewport size in px. */
export function makeProjector(m: ArrayLike<number>, width: number, height: number): Projector {
  const inv = new Matrix4().fromArray(Array.from(m)).invert().elements;
  return {
    toScreen(x, y, z, out) {
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15] || 1e-9;
      out[0] = ((cx / cw + 1) / 2) * width;
      out[1] = ((1 - cy / cw) / 2) * height;
      out[2] = cz / cw;
    },
    fromScreen(sx, sy, depth, out) {
      const nx = (sx / width) * 2 - 1,
        ny = 1 - (sy / height) * 2,
        nz = depth;
      const x = inv[0] * nx + inv[4] * ny + inv[8] * nz + inv[12];
      const y = inv[1] * nx + inv[5] * ny + inv[9] * nz + inv[13];
      const z = inv[2] * nx + inv[6] * ny + inv[10] * nz + inv[14];
      const w = inv[3] * nx + inv[7] * ny + inv[11] * nz + inv[15] || 1e-9;
      out[0] = x / w;
      out[1] = y / w;
      out[2] = z / w;
    },
  };
}

/** A projector that sees the strands mirrored across object axes (symmetry passes). */
export function mirroredProjector(p: Projector, axes: [boolean, boolean, boolean]): Projector {
  const sx = axes[0] ? -1 : 1,
    sy = axes[1] ? -1 : 1,
    sz = axes[2] ? -1 : 1;
  return {
    toScreen: (x, y, z, out) => p.toScreen(x * sx, y * sy, z * sz, out),
    fromScreen: (a, b, d, out) => {
      p.fromScreen(a, b, d, out);
      out[0] *= sx;
      out[1] *= sy;
      out[2] *= sz;
    },
  };
}

/** Mirror combinations for the enabled symmetry axes (the identity first). */
export function symmetryPasses(x: boolean, y: boolean, z: boolean): [boolean, boolean, boolean][] {
  const out: [boolean, boolean, boolean][] = [];
  for (let i = 0; i < 8; i++) {
    const m: [boolean, boolean, boolean] = [!!(i & 1), !!(i & 2), !!(i & 4)];
    if ((m[0] && !x) || (m[1] && !y) || (m[2] && !z)) continue;
    out.push(m);
  }
  return out;
}

export type Falloff = 'SMOOTH' | 'SPHERE' | 'ROOT' | 'SHARP' | 'LINEAR' | 'CONSTANT';

/** Brush falloff for a normalized distance t (0 at the centre, 1 at the rim). */
export function falloff(t: number, kind: Falloff = 'SMOOTH'): number {
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  const u = 1 - t;
  switch (kind) {
    case 'SPHERE':
      return Math.sqrt(1 - t * t);
    case 'ROOT':
      return Math.sqrt(u);
    case 'SHARP':
      return u * u;
    case 'LINEAR':
      return u;
    case 'CONSTANT':
      return 1;
    default:
      return u * u * (3 - 2 * u);
  }
}

export interface Strands {
  positions: Float32Array;
  offsets: ArrayLike<number>;
}

export interface BrushParams {
  x: number;
  y: number;
  radius: number;
  strength: number;
  falloff?: Falloff;
  /** soft mask per point (selection), 1 when missing */
  mask?: ArrayLike<number> | null;
}

const S = new Float64Array(3),
  T = new Float64Array(3);

/** Segment lengths: entry i is the length from point i-1 to i (0 for roots). */
export function segmentLengths(s: Strands): Float32Array {
  const P = s.positions;
  const out = new Float32Array(P.length / 3);
  for (let c = 0; c + 1 < s.offsets.length; c++)
    for (let i = s.offsets[c] + 1; i < s.offsets[c + 1]; i++) out[i] = Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 1] - P[i * 3 - 2], P[i * 3 + 2] - P[i * 3 - 1]);
  return out;
}

/** Give the points of a strand back their segment lengths, walking from the root. */
export function restoreLengths(P: Float32Array, a: number, b: number, lengths: ArrayLike<number>) {
  for (let i = a + 1; i < b; i++) {
    let dx = P[i * 3] - P[i * 3 - 3],
      dy = P[i * 3 + 1] - P[i * 3 - 2],
      dz = P[i * 3 + 2] - P[i * 3 - 1];
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-12) {
      dx = 0;
      dy = 0;
      dz = 1;
    } else {
      dx /= l;
      dy /= l;
      dz /= l;
    }
    P[i * 3] = P[i * 3 - 3] + dx * lengths[i];
    P[i * 3 + 1] = P[i * 3 - 2] + dy * lengths[i];
    P[i * 3 + 2] = P[i * 3 - 1] + dz * lengths[i];
  }
}

function weightAt(p: Projector, P: Float32Array, i: number, b: BrushParams): number {
  p.toScreen(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], S);
  if (S[2] < -1 || S[2] > 1) return 0;
  const d = Math.hypot(S[0] - b.x, S[1] - b.y);
  if (d >= b.radius) return 0;
  return falloff(d / b.radius, b.falloff) * b.strength * (b.mask ? b.mask[i] : 1);
}

/** Move a point in the view plane by (dx, dy) px at its own depth. */
function moveScreen(p: Projector, P: Float32Array, i: number, dx: number, dy: number) {
  p.toScreen(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], S);
  p.fromScreen(S[0] + dx, S[1] + dy, S[2], T);
  P[i * 3] = T[0];
  P[i * 3 + 1] = T[1];
  P[i * 3 + 2] = T[2];
}

/**
 * Comb: points near the brush follow the pointer motion (dx, dy); roots stay, segment lengths are
 * restored. Returns the strands that changed.
 */
export function combDab(s: Strands, p: Projector, b: BrushParams, dx: number, dy: number, lengths: ArrayLike<number>): number[] {
  const P = s.positions;
  const changed: number[] = [];
  if (!dx && !dy) return changed;
  for (let c = 0; c + 1 < s.offsets.length; c++) {
    const a = s.offsets[c],
      e = s.offsets[c + 1];
    let any = false;
    for (let i = a + 1; i < e; i++) {
      const w = weightAt(p, P, i, b);
      if (w <= 0) continue;
      moveScreen(p, P, i, dx * w, dy * w);
      any = true;
    }
    if (any) {
      restoreLengths(P, a, e, lengths);
      changed.push(c);
    }
  }
  return changed;
}

/** Squared distance from (px, py) to the segment a-b in 2D. */
export function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax,
    vy = by - ay;
  const l = vx * vx + vy * vy;
  let t = l > 0 ? ((px - ax) * vx + (py - ay) * vy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + vx * t - px,
    y = ay + vy * t - py;
  return x * x + y * y;
}

/** Delete: strands with a point or segment under the brush (masked strands are kept). */
export function deleteHits(s: Strands, p: Projector, b: BrushParams): Uint8Array {
  const P = s.positions;
  const nc = s.offsets.length - 1;
  const out = new Uint8Array(Math.max(0, nc));
  const r2 = b.radius * b.radius;
  for (let c = 0; c < nc; c++) {
    const a = s.offsets[c],
      e = s.offsets[c + 1];
    let px = NaN,
      py = NaN;
    for (let i = a; i < e; i++) {
      if (b.mask && !(b.mask[i] > 0)) {
        px = NaN;
        continue;
      }
      p.toScreen(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], S);
      const x = S[0],
        y = S[1];
      const d = Number.isNaN(px) ? (x - b.x) ** 2 + (y - b.y) ** 2 : segDist2(b.x, b.y, px, py, x, y);
      if (d < r2) {
        out[c] = 1;
        break;
      }
      px = x;
      py = y;
    }
  }
  return out;
}

/** Resample a polyline (xyz) to `n` points evenly spaced along its length. */
export function resamplePolyline(pts: ArrayLike<number>, n: number): Float32Array {
  const m = pts.length / 3;
  const out = new Float32Array(n * 3);
  if (m === 0) return out;
  if (m === 1 || n === 1) {
    for (let i = 0; i < n; i++) out.set([pts[0], pts[1], pts[2]], i * 3);
    return out;
  }
  const cum = new Float64Array(m);
  for (let i = 1; i < m; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
  const total = cum[m - 1];
  let seg = 1;
  for (let k = 0; k < n; k++) {
    const t = total > 0 ? (k / (n - 1)) * total : 0;
    while (seg < m - 1 && cum[seg] < t) seg++;
    const l = cum[seg] - cum[seg - 1];
    const f = l > 0 ? Math.min(1, Math.max(0, (t - cum[seg - 1]) / l)) : 0;
    for (let j = 0; j < 3; j++) out[k * 3 + j] = pts[(seg - 1) * 3 + j] * (1 - f) + pts[seg * 3 + j] * f;
  }
  return out;
}

/** Move the tip of a strand to `tip` and redistribute its points along the new path (snake). */
export function moveTipAndResample(P: Float32Array, a: number, e: number, tip: [number, number, number]) {
  const n = e - a;
  if (n < 2) return;
  const poly = new Float32Array((n + 1) * 3);
  poly.set(P.subarray(a * 3, e * 3));
  poly.set(tip, n * 3);
  // the old tip stays on the path so the strand bends where the pointer went
  P.set(resamplePolyline(poly, n), a * 3);
}

/** Snake Hook: strand tips under the brush are dragged by (dx, dy) and the strand follows. */
export function snakeHookDab(s: Strands, p: Projector, b: BrushParams, dx: number, dy: number): number[] {
  const P = s.positions;
  const changed: number[] = [];
  if (!dx && !dy) return changed;
  for (let c = 0; c + 1 < s.offsets.length; c++) {
    const a = s.offsets[c],
      e = s.offsets[c + 1];
    if (e - a < 2) continue;
    const t = e - 1;
    const w = weightAt(p, P, t, b);
    if (w <= 0) continue;
    p.toScreen(P[t * 3], P[t * 3 + 1], P[t * 3 + 2], S);
    p.fromScreen(S[0] + dx * w, S[1] + dy * w, S[2], T);
    moveTipAndResample(P, a, e, [T[0], T[1], T[2]]);
    changed.push(c);
  }
  return changed;
}

/** Strand weight: the strongest brush weight of its points. */
function strandWeight(p: Projector, P: Float32Array, a: number, e: number, b: BrushParams): number {
  let w = 0;
  for (let i = a; i < e; i++) w = Math.max(w, weightAt(p, P, i, b));
  return w;
}

/**
 * Grow / Shrink: strands under the brush get longer (factor > 1) or shorter. Uniform scaling
 * scales the strand around its root; otherwise the strand is extended along its tip direction
 * or trimmed, keeping its point count.
 */
export function growShrinkDab(s: Strands, p: Projector, b: BrushParams, grow: boolean, opts: { uniform?: boolean; minLength?: number; rate?: number } = {}): number[] {
  const P = s.positions;
  const changed: number[] = [];
  const rate = opts.rate ?? 0.05;
  for (let c = 0; c + 1 < s.offsets.length; c++) {
    const a = s.offsets[c],
      e = s.offsets[c + 1];
    if (e - a < 2) continue;
    const w = strandWeight(p, P, a, e, b);
    if (w <= 0) continue;
    const f = grow ? 1 + rate * w : 1 / (1 + rate * w);
    if (scaleStrand(P, a, e, f, !!opts.uniform, opts.minLength ?? 0)) changed.push(c);
  }
  return changed;
}

/** Scale the length of one strand by `f` (see growShrinkDab). */
export function scaleStrand(P: Float32Array, a: number, e: number, f: number, uniform: boolean, minLength = 0): boolean {
  let len = 0;
  for (let i = a + 1; i < e; i++) len += Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 1] - P[i * 3 - 2], P[i * 3 + 2] - P[i * 3 - 1]);
  if (len <= 0) return false;
  let target = len * f;
  if (f < 1) target = Math.max(target, Math.min(len, minLength));
  if (Math.abs(target - len) < 1e-9) return false;
  const k = target / len;
  if (uniform) {
    const rx = P[a * 3],
      ry = P[a * 3 + 1],
      rz = P[a * 3 + 2];
    for (let i = a + 1; i < e; i++) {
      P[i * 3] = rx + (P[i * 3] - rx) * k;
      P[i * 3 + 1] = ry + (P[i * 3 + 1] - ry) * k;
      P[i * 3 + 2] = rz + (P[i * 3 + 2] - rz) * k;
    }
    return true;
  }
  const n = e - a;
  if (k > 1) {
    // extend along the last segment, then spread the points over the longer path
    const t = e - 1;
    const dx = P[t * 3] - P[t * 3 - 3],
      dy = P[t * 3 + 1] - P[t * 3 - 2],
      dz = P[t * 3 + 2] - P[t * 3 - 1];
    const l = Math.hypot(dx, dy, dz) || 1;
    const ext = target - len;
    const poly = new Float32Array((n + 1) * 3);
    poly.set(P.subarray(a * 3, e * 3));
    poly.set([P[t * 3] + (dx / l) * ext, P[t * 3 + 1] + (dy / l) * ext, P[t * 3 + 2] + (dz / l) * ext], n * 3);
    P.set(resamplePolyline(poly, n), a * 3);
  } else P.set(trimPolyline(P.subarray(a * 3, e * 3), target, n), a * 3);
  return true;
}

/** The first `length` of a polyline, resampled to `n` points. */
export function trimPolyline(pts: ArrayLike<number>, length: number, n: number): Float32Array {
  const m = pts.length / 3;
  const out: number[] = [pts[0], pts[1], pts[2]];
  let acc = 0;
  for (let i = 1; i < m; i++) {
    const l = Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
    if (acc + l >= length) {
      const f = l > 0 ? (length - acc) / l : 0;
      out.push(pts[i * 3 - 3] + (pts[i * 3] - pts[i * 3 - 3]) * f, pts[i * 3 - 2] + (pts[i * 3 + 1] - pts[i * 3 - 2]) * f, pts[i * 3 - 1] + (pts[i * 3 + 2] - pts[i * 3 - 1]) * f);
      return resamplePolyline(out, n);
    }
    acc += l;
    out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
  }
  return resamplePolyline(out, n);
}

/** Pinch: points move toward the brush centre in the view plane (away with `invert`); lengths are kept. */
export function pinchDab(s: Strands, p: Projector, b: BrushParams, invert: boolean, lengths: ArrayLike<number>): number[] {
  const P = s.positions;
  const changed: number[] = [];
  const k = (invert ? -1 : 1) * 0.1;
  for (let c = 0; c + 1 < s.offsets.length; c++) {
    const a = s.offsets[c],
      e = s.offsets[c + 1];
    let any = false;
    for (let i = a + 1; i < e; i++) {
      const w = weightAt(p, P, i, b);
      if (w <= 0) continue;
      p.toScreen(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], S);
      moveScreen(p, P, i, (b.x - S[0]) * w * k, (b.y - S[1]) * w * k);
      any = true;
    }
    if (any) {
      restoreLengths(P, a, e, lengths);
      changed.push(c);
    }
  }
  return changed;
}

/**
 * Puff: strands under the brush rise toward their root normal (`normals`, xyz per strand);
 * `invert` lays them down along their current direction projected on the surface.
 */
export function puffDab(s: Strands, p: Projector, b: BrushParams, normals: ArrayLike<number>, lengths: ArrayLike<number>, invert = false): number[] {
  const P = s.positions;
  const changed: number[] = [];
  for (let c = 0; c + 1 < s.offsets.length; c++) {
    const a = s.offsets[c],
      e = s.offsets[c + 1];
    if (e - a < 2) continue;
    const w = strandWeight(p, P, a, e, b) * 0.2;
    if (w <= 0) continue;
    let nx = normals[c * 3],
      ny = normals[c * 3 + 1],
      nz = normals[c * 3 + 2];
    if (invert) {
      // flatten: the strand direction with its normal component removed
      let dx = P[(e - 1) * 3] - P[a * 3],
        dy = P[(e - 1) * 3 + 1] - P[a * 3 + 1],
        dz = P[(e - 1) * 3 + 2] - P[a * 3 + 2];
      const dn = dx * nx + dy * ny + dz * nz;
      dx -= nx * dn;
      dy -= ny * dn;
      dz -= nz * dn;
      const l = Math.hypot(dx, dy, dz);
      if (l < 1e-9) continue;
      nx = dx / l;
      ny = dy / l;
      nz = dz / l;
    }
    let arc = 0;
    for (let i = a + 1; i < e; i++) {
      arc += lengths[i];
      const tx = P[a * 3] + nx * arc,
        ty = P[a * 3 + 1] + ny * arc,
        tz = P[a * 3 + 2] + nz * arc;
      P[i * 3] += (tx - P[i * 3]) * w;
      P[i * 3 + 1] += (ty - P[i * 3 + 1]) * w;
      P[i * 3 + 2] += (tz - P[i * 3 + 2]) * w;
    }
    restoreLengths(P, a, e, lengths);
    changed.push(c);
  }
  return changed;
}

/** Smooth: interior points move toward the middle of their neighbours. */
export function smoothDab(s: Strands, p: Projector, b: BrushParams): number[] {
  const P = s.positions;
  const changed: number[] = [];
  for (let c = 0; c + 1 < s.offsets.length; c++) {
    const a = s.offsets[c],
      e = s.offsets[c + 1];
    if (e - a < 3) continue;
    const ws = new Float32Array(e - a);
    let any = false;
    for (let i = a + 1; i < e - 1; i++) {
      ws[i - a] = Math.min(1, weightAt(p, P, i, b));
      if (ws[i - a] > 0) any = true;
    }
    if (!any) continue;
    const src = P.slice(a * 3, e * 3);
    for (let i = a + 1; i < e - 1; i++) {
      const w = ws[i - a] * 0.5;
      if (w <= 0) continue;
      const j = i - a;
      for (let k = 0; k < 3; k++) {
        const mid = (src[(j - 1) * 3 + k] + src[(j + 1) * 3 + k]) / 2;
        P[i * 3 + k] = src[j * 3 + k] + (mid - src[j * 3 + k]) * w;
      }
    }
    changed.push(c);
  }
  return changed;
}

/**
 * Slide: strands whose root is under the brush move along with the pointer; `snap` puts a moved
 * root back on the surface (object space in/out). The strand is translated with its root.
 */
export function slideDab(s: Strands, p: Projector, b: BrushParams, dx: number, dy: number, snap: (x: number, y: number, z: number) => [number, number, number] | null): number[] {
  const P = s.positions;
  const changed: number[] = [];
  if (!dx && !dy) return changed;
  for (let c = 0; c + 1 < s.offsets.length; c++) {
    const a = s.offsets[c],
      e = s.offsets[c + 1];
    const w = weightAt(p, P, a, b);
    if (w <= 0) continue;
    p.toScreen(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], S);
    p.fromScreen(S[0] + dx * w, S[1] + dy * w, S[2], T);
    const r = snap(T[0], T[1], T[2]);
    if (!r) continue;
    const ox = r[0] - P[a * 3],
      oy = r[1] - P[a * 3 + 1],
      oz = r[2] - P[a * 3 + 2];
    for (let i = a; i < e; i++) {
      P[i * 3] += ox;
      P[i * 3 + 1] += oy;
      P[i * 3 + 2] += oz;
    }
    changed.push(c);
  }
  return changed;
}

/**
 * Selection paint: values of the elements under the brush move toward `value` (0 deselects).
 * With `perStrand` the selection is per strand (any point under the brush counts).
 */
export function selectionPaintDab(s: Strands, p: Projector, b: BrushParams, sel: Float32Array, value: number, perStrand: boolean): boolean {
  const P = s.positions;
  const bb = { ...b, mask: null };
  let changed = false;
  for (let c = 0; c + 1 < s.offsets.length; c++) {
    const a = s.offsets[c],
      e = s.offsets[c + 1];
    if (perStrand) {
      const w = Math.min(1, strandWeight(p, P, a, e, bb));
      if (w <= 0) continue;
      const nv = sel[c] + (value - sel[c]) * w;
      if (nv !== sel[c]) {
        sel[c] = nv;
        changed = true;
      }
      continue;
    }
    for (let i = a; i < e; i++) {
      const w = Math.min(1, weightAt(p, P, i, bb));
      if (w <= 0) continue;
      sel[i] += (value - sel[i]) * w;
      changed = true;
    }
  }
  return changed;
}

/** Roots (xyz per strand). */
export function rootsOf(s: Strands): Float32Array {
  const nc = s.offsets.length - 1;
  const out = new Float32Array(Math.max(0, nc) * 3);
  for (let c = 0; c < nc; c++) out.set(s.positions.subarray(s.offsets[c] * 3, s.offsets[c] * 3 + 3), c * 3);
  return out;
}

/** Spatial hash of points for minimum-distance queries. */
export class PointHash {
  private cells = new Map<string, number[]>();
  private pts: number[] = [];
  constructor(private cell: number) {}
  private key(x: number, y: number, z: number) {
    const c = this.cell;
    return `${Math.floor(x / c)},${Math.floor(y / c)},${Math.floor(z / c)}`;
  }
  add(x: number, y: number, z: number) {
    const i = this.pts.length / 3;
    this.pts.push(x, y, z);
    const k = this.key(x, y, z);
    const l = this.cells.get(k);
    if (l) l.push(i);
    else this.cells.set(k, [i]);
  }
  /** Whether a point lies within `r` (≤ cell size) of any stored point. */
  near(x: number, y: number, z: number, r: number): boolean {
    const c = this.cell;
    const cx = Math.floor(x / c),
      cy = Math.floor(y / c),
      cz = Math.floor(z / c);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) {
          const l = this.cells.get(`${cx + i},${cy + j},${cz + k}`);
          if (!l) continue;
          for (const q of l) if (Math.hypot(this.pts[q * 3] - x, this.pts[q * 3 + 1] - y, this.pts[q * 3 + 2] - z) < r) return true;
        }
    return false;
  }
}

/**
 * Density (remove): among the strands flagged in `candidates`, drop those whose root is closer
 * than `minDist` to a kept root. Strands outside the candidates are always kept and count as
 * neighbours. The visiting order is shuffled with `rand` so thinning is even.
 */
export function thinRoots(roots: ArrayLike<number>, candidates: ArrayLike<number>, minDist: number, rand: () => number): Uint8Array {
  const n = roots.length / 3;
  const out = new Uint8Array(n);
  if (minDist <= 0) return out;
  const hash = new PointHash(minDist);
  for (let c = 0; c < n; c++) if (!candidates[c]) hash.add(roots[c * 3], roots[c * 3 + 1], roots[c * 3 + 2]);
  const order: number[] = [];
  for (let c = 0; c < n; c++) if (candidates[c]) order.push(c);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const c of order) {
    const x = roots[c * 3],
      y = roots[c * 3 + 1],
      z = roots[c * 3 + 2];
    if (hash.near(x, y, z, minDist)) out[c] = 1;
    else hash.add(x, y, z);
  }
  return out;
}

/** Smallest distance between any two of the given roots (Infinity for fewer than two). */
export function minRootDistance(roots: ArrayLike<number>, which: number[]): number {
  let best = Infinity;
  for (let i = 0; i < which.length; i++)
    for (let j = i + 1; j < which.length; j++) {
      const a = which[i] * 3,
        b = which[j] * 3;
      best = Math.min(best, Math.hypot(roots[a] - roots[b], roots[a + 1] - roots[b + 1], roots[a + 2] - roots[b + 2]));
    }
  return best;
}

export interface NeighbourStrand {
  root: [number, number, number];
  normal: [number, number, number];
  /** points (xyz) including the root */
  points: ArrayLike<number>;
  weight: number;
}

/**
 * Shape of a new strand at `root` with surface normal `normal`: straight along the normal by
 * default, or blended from neighbouring strands (their shapes are rotated from their own normal
 * to this one, resampled to the point count and averaged by weight).
 */
export function newStrandShape(
  root: [number, number, number],
  normal: [number, number, number],
  opts: { length: number; points: number; neighbours?: NeighbourStrand[]; interpolateLength?: boolean; interpolateShape?: boolean; interpolatePointCount?: boolean },
): Float32Array {
  const nb = (opts.neighbours ?? []).filter((n) => n.weight > 0 && n.points.length >= 6);
  const wsum = nb.reduce((s, n) => s + n.weight, 0);
  let count = Math.max(2, Math.round(opts.points));
  let length = opts.length;
  if (wsum > 0 && opts.interpolatePointCount) count = Math.max(2, Math.round(nb.reduce((s, n) => s + (n.points.length / 3) * n.weight, 0) / wsum));
  if (wsum > 0 && opts.interpolateLength) length = nb.reduce((s, n) => s + polylineLength(n.points) * n.weight, 0) / wsum;
  const out = new Float32Array(count * 3);
  if (wsum > 0 && opts.interpolateShape) {
    for (const n of nb) {
      const pts = resamplePolyline(n.points, count);
      const len = polylineLength(n.points) || 1;
      const q = rotationBetween(n.normal, normal);
      for (let k = 0; k < count; k++) {
        const ox = pts[k * 3] - n.root[0],
          oy = pts[k * 3 + 1] - n.root[1],
          oz = pts[k * 3 + 2] - n.root[2];
        const r = rotate(q, ox, oy, oz);
        const f = (n.weight / wsum) * (length / len);
        out[k * 3] += r[0] * f;
        out[k * 3 + 1] += r[1] * f;
        out[k * 3 + 2] += r[2] * f;
      }
    }
    for (let k = 0; k < count; k++) {
      out[k * 3] += root[0];
      out[k * 3 + 1] += root[1];
      out[k * 3 + 2] += root[2];
    }
    return out;
  }
  for (let k = 0; k < count; k++) {
    const t = (k / (count - 1)) * length;
    out[k * 3] = root[0] + normal[0] * t;
    out[k * 3 + 1] = root[1] + normal[1] * t;
    out[k * 3 + 2] = root[2] + normal[2] * t;
  }
  return out;
}

export function polylineLength(pts: ArrayLike<number>): number {
  let s = 0;
  for (let i = 3; i < pts.length; i += 3) s += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2], pts[i + 2] - pts[i - 1]);
  return s;
}

/** Quaternion [x, y, z, w] rotating unit vector a onto b. */
export function rotationBetween(a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number, number] {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    // opposite: rotate half a turn about any perpendicular axis
    let x = 0,
      y = -a[2],
      z = a[1];
    if (Math.hypot(x, y, z) < 1e-6) {
      x = a[2];
      y = 0;
      z = -a[0];
    }
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l, 0];
  }
  const cx = a[1] * b[2] - a[2] * b[1],
    cy = a[2] * b[0] - a[0] * b[2],
    cz = a[0] * b[1] - a[1] * b[0];
  const w = 1 + d;
  const l = Math.hypot(cx, cy, cz, w);
  return [cx / l, cy / l, cz / l, w / l];
}

export function rotate(q: [number, number, number, number], x: number, y: number, z: number): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const ix = qw * x + qy * z - qz * y,
    iy = qw * y + qz * x - qx * z,
    iz = qw * z + qx * y - qy * x,
    iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}
