// Selection mask algebra, morphology, outlines and shape rasterization. Masks are
// coverage in [0, 255]; operations that take two masks require equal sizes.
import { mask8, type IRect, type Mask8, type RGBA8 } from '../types';
import { boxMean, gaussianBlurF32 } from './filters';

export type Point = [number, number];

function same(a: Mask8, b: Mask8) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Mask sizes differ.');
}
const div255 = (v: number) => (v + 1 + ((v + 1) >> 8)) >> 8;

export function union(a: Mask8, b: Mask8): Mask8 {
  same(a, b);
  const o = mask8(a.width, a.height);
  for (let i = 0; i < o.data.length; i++) o.data[i] = a.data[i] > b.data[i] ? a.data[i] : b.data[i];
  return o;
}
export function subtract(a: Mask8, b: Mask8): Mask8 {
  same(a, b);
  const o = mask8(a.width, a.height);
  for (let i = 0; i < o.data.length; i++) o.data[i] = div255(a.data[i] * (255 - b.data[i]));
  return o;
}
// Product, so intersecting two feathered selections stays soft like the sources.
export function intersect(a: Mask8, b: Mask8): Mask8 {
  same(a, b);
  const o = mask8(a.width, a.height);
  for (let i = 0; i < o.data.length; i++) o.data[i] = div255(a.data[i] * b.data[i]);
  return o;
}
export function invert(a: Mask8): Mask8 {
  const o = mask8(a.width, a.height);
  for (let i = 0; i < o.data.length; i++) o.data[i] = 255 - a.data[i];
  return o;
}

function toFloat(m: Mask8) {
  const f = new Float32Array(m.data.length);
  for (let i = 0; i < f.length; i++) f[i] = m.data[i];
  return f;
}
function fromFloat(f: Float32Array, w: number, h: number): Mask8 {
  const o = mask8(w, h);
  for (let i = 0; i < f.length; i++) o.data[i] = f[i] <= 0 ? 0 : f[i] >= 255 ? 255 : Math.round(f[i]);
  return o;
}

// Gaussian feather. `radius` is the visible softening distance on each side of
// the edge; the Gaussian uses sigma = radius / 2 so ~95% of the ramp falls within it.
export function feather(m: Mask8, radius: number): Mask8 {
  if (!(radius > 0)) return { width: m.width, height: m.height, data: new Uint8Array(m.data) };
  return fromFloat(gaussianBlurF32(toFloat(m), m.width, m.height, radius / 2), m.width, m.height);
}

// Exact squared Euclidean distance transform (Felzenszwalb and Huttenlocher 2012,
// "Distance Transforms of Sampled Functions"). `feature[i] != 0` marks distance-zero
// pixels. Returns squared distances to the nearest feature pixel (1e20 if none).
export function edtSquared(feature: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e20, n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const out = new Float32Array(w * h);
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const t = q - v[k];
      d[q] = t * t + f[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = feature[y * w + x] ? 0 : INF;
    pass(h);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) f[x] = out[o + x];
    pass(w);
    for (let x = 0; x < w; x++) out[o + x] = d[x];
  }
  return out;
}

export type MorphOptions = { threshold?: number; antiAlias?: boolean };

// Grow by `r` pixels: a pixel becomes selected when its Euclidean distance to the
// selection (coverage >= threshold) is <= r. Anti-aliasing adds a one-pixel ramp
// beyond r. Existing soft coverage is kept (max).
export function expand(m: Mask8, r: number, opts: MorphOptions = {}): Mask8 {
  const { threshold = 128, antiAlias = true } = opts, { width: w, height: h } = m;
  const feat = new Uint8Array(w * h);
  for (let i = 0; i < feat.length; i++) feat[i] = m.data[i] >= threshold ? 1 : 0;
  const d2 = edtSquared(feat, w, h), o = mask8(w, h);
  for (let i = 0; i < d2.length; i++) {
    const d = Math.sqrt(d2[i]);
    const v = antiAlias ? Math.round(255 * Math.min(1, Math.max(0, r + 1 - d))) : d <= r ? 255 : 0;
    o.data[i] = v > m.data[i] ? v : m.data[i];
  }
  return o;
}
// Shrink by `r`: a pixel stays selected when its distance to the nearest
// unselected pixel is > r. Exactly the complement of expanding the complement;
// the canvas edge does not count as unselected.
export function contract(m: Mask8, r: number, opts: MorphOptions = {}): Mask8 {
  const { threshold = 128, antiAlias = true } = opts, { width: w, height: h } = m;
  const feat = new Uint8Array(w * h);
  for (let i = 0; i < feat.length; i++) feat[i] = m.data[i] >= threshold ? 0 : 1;
  const d2 = edtSquared(feat, w, h), o = mask8(w, h);
  for (let i = 0; i < d2.length; i++) {
    const d = Math.sqrt(d2[i]);
    const v = antiAlias ? Math.round(255 * Math.min(1, Math.max(0, d - r))) : d > r ? 255 : 0;
    o.data[i] = v < m.data[i] ? v : m.data[i];
  }
  return o;
}

// Majority vote in a (2r+1) square: removes specks and rounds jagged corners.
export function smooth(m: Mask8, r: number): Mask8 {
  const { width: w, height: h } = m;
  if (r < 1) return { width: w, height: h, data: new Uint8Array(m.data) };
  const avg = boxMean(toFloat(m), w, h, Math.round(r)), o = mask8(w, h);
  // A narrow ramp around 50% keeps the result anti-aliased instead of stair-stepped.
  for (let i = 0; i < avg.length; i++) o.data[i] = Math.round(255 * Math.min(1, Math.max(0, (avg[i] - 127.5) / 64 + 0.5)));
  return o;
}

// A band of `width` pixels straddling the selection edge, softened by one pixel.
export function border(m: Mask8, width: number): Mask8 {
  const outer = expand(m, Math.ceil(width / 2)), inner = contract(m, Math.floor(width / 2));
  return feather(subtract(outer, inner), 2);
}

export function boundingBox(m: Mask8, threshold = 1): IRect | null {
  const { width: w, height: h, data } = m, n = w * h;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  const visit = (i: number) => {
    const y = (i / w) | 0, x = i - y * w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  if (threshold <= 1) {
    // Masks are mostly empty: skip zero words four pixels at a time.
    let i = 0;
    while (i < n && (data.byteOffset + i) & 3) if (data[i++]) visit(i - 1);
    const words = new Uint32Array(data.buffer, data.byteOffset + i, (n - i) >> 2);
    for (let k = 0; k < words.length; k++)
      if (words[k]) for (let j = i + k * 4, e = j + 4; j < e; j++) if (data[j]) visit(j);
    for (let j = i + words.length * 4; j < n; j++) if (data[j]) visit(j);
  } else
    for (let i = 0; i < n; i++) if (data[i] >= threshold) visit(i);
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

// Colors present in the selection, quantized to 5 bits per channel and dilated by
// the tolerance (per-channel, matching the magic wand's max-channel metric).
// Colors are premultiplied by alpha, and the selected alphas form a second set,
// so transparent pixels never match opaque ones whatever color they hide.
function colorSet(img: RGBA8, m: Mask8, tolerance: number) {
  const N = 32, set = new Uint8Array(N * N * N), alphas = new Uint8Array(256), d = img.data;
  for (let i = 0; i < m.data.length; i++)
    if (m.data[i] >= 128) {
      set[key(d, i)] = 1;
      alphas[d[i * 4 + 3]] = 1;
    }
  const r = Math.ceil(tolerance / 8);
  if (r > 0) {
    const tmp = new Uint8Array(set.length);
    const strides = [1024, 32, 1];
    for (const s of strides) {
      tmp.set(set);
      for (let i = 0; i < set.length; i++) {
        if (!tmp[i]) continue;
        const c = Math.floor(i / s) % N;
        for (let k = Math.max(0, c - r); k <= Math.min(N - 1, c + r); k++) set[i + (k - c) * s] = 1;
      }
    }
  }
  const t = Math.max(0, Math.round(tolerance));
  const seen = alphas.slice();
  for (let a = 0; a < 256; a++)
    if (seen[a]) alphas.fill(1, Math.max(0, a - t), Math.min(256, a + t + 1));
  return (i: number) => set[key(d, i)] === 1 && alphas[d[i * 4 + 3]] === 1;
}
const key = (d: Uint8ClampedArray, i: number) => {
  const a = d[i * 4 + 3];
  if (a === 255) return ((d[i * 4] >> 3) << 10) | ((d[i * 4 + 1] >> 3) << 5) | (d[i * 4 + 2] >> 3);
  const pm = (c: number) => ((c * a + 127) / 255) >> 3;
  return (pm(d[i * 4]) << 10) | (pm(d[i * 4 + 1]) << 5) | pm(d[i * 4 + 2]);
};

// Grow: add pixels connected to the selection whose color is within `tolerance`
// of a selected color.
export function grow(img: RGBA8, m: Mask8, tolerance = 32): Mask8 {
  const { width: w, height: h } = m, matches = colorSet(img, m, tolerance), o = mask8(w, h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  for (let i = 0; i < m.data.length; i++)
    if (m.data[i] >= 128) {
      o.data[i] = 255;
      stack[sp++] = i;
    } else o.data[i] = m.data[i];
  const visited = new Uint8Array(w * h);
  const n = w * h;
  while (sp) {
    const i = stack[--sp], x = i % w;
    for (let k = 0; k < 4; k++) {
      const j = k === 0 ? (x > 0 ? i - 1 : -1) : k === 1 ? (x < w - 1 ? i + 1 : -1) : k === 2 ? i - w : i + w;
      if (j >= 0 && j < n && !visited[j] && o.data[j] < 255 && matches(j)) {
        visited[j] = 1;
        o.data[j] = 255;
        stack[sp++] = j;
      }
    }
  }
  return o;
}
// Similar: like grow but across the whole image regardless of connectivity.
export function similar(img: RGBA8, m: Mask8, tolerance = 32): Mask8 {
  const matches = colorSet(img, m, tolerance), o = mask8(m.width, m.height);
  for (let i = 0; i < o.data.length; i++) o.data[i] = matches(i) ? 255 : m.data[i];
  return o;
}

// ---------------------------------------------------------------------------
// Outlines: marching squares over pixel centers with linear interpolation.
// Outer boundaries wind clockwise on screen (positive shoelace area with y down,
// selected side on the right of travel); holes wind the other way.

// Segment table: for each 4-bit case (TL=1, TR=2, BR=4, BL=8) the directed edge
// pairs [from, to] with edges T=0, R=1, B=2, L=3. Saddles are resolved below.
const SEG: number[][] = [
  [], [0, 3], [1, 0], [1, 3], [2, 1], [], [2, 0], [2, 3],
  [3, 2], [0, 2], [], [1, 2], [3, 1], [0, 1], [3, 0], [],
];

export function maskToOutline(m: Mask8, threshold = 128): Point[][] {
  const { width: w, height: h, data } = m;
  // Padded sample grid: P x Q samples, outer ring is zero so contours close.
  const P = w + 2, Q = h + 2;
  const val = (i: number, j: number) => (i <= 0 || j <= 0 || i > w || j > h ? 0 : data[(j - 1) * w + (i - 1)]);
  const NH = (P - 1) * Q; // horizontal edges (i,j)-(i+1,j)
  const next = new Int32Array(NH + P * (Q - 1)).fill(-1);
  const edgeId = (ci: number, cj: number, e: number) =>
    e === 0 ? cj * (P - 1) + ci : e === 2 ? (cj + 1) * (P - 1) + ci : e === 3 ? NH + cj * P + ci : NH + cj * P + ci + 1;
  let starts = 0;
  // Inside flags on the padded grid, so uniform cells are skipped with byte reads.
  const inside = new Uint8Array(P * Q);
  for (let y = 0; y < h; y++) for (let x = 0, o = y * w, q = (y + 1) * P + 1; x < w; x++) inside[q + x] = data[o + x] >= threshold ? 1 : 0;
  for (let cj = 0; cj < Q - 1; cj++) {
    const r0 = cj * P, r1 = r0 + P;
    for (let ci = 0; ci < P - 1; ci++) {
      const k = inside[r0 + ci] | (inside[r0 + ci + 1] << 1) | (inside[r1 + ci + 1] << 2) | (inside[r1 + ci] << 3);
      if (k === 0 || k === 15) continue;
      const a = val(ci, cj), b = val(ci + 1, cj), c = val(ci + 1, cj + 1), d = val(ci, cj + 1);
      let segs = SEG[k];
      if (k === 5 || k === 10) {
        const centerIn = (a + b + c + d) / 4 >= threshold;
        segs = k === 5 ? (centerIn ? [0, 1, 2, 3] : [0, 3, 2, 1]) : centerIn ? [3, 0, 1, 2] : [1, 0, 3, 2];
      }
      for (let s = 0; s < segs.length; s += 2) {
        next[edgeId(ci, cj, segs[s])] = edgeId(ci, cj, segs[s + 1]);
        starts++;
      }
    }
  }
  const point = (e: number): Point => {
    let i0: number, j0: number, i1: number, j1: number;
    if (e < NH) {
      j0 = j1 = Math.floor(e / (P - 1));
      i0 = e - j0 * (P - 1);
      i1 = i0 + 1;
    } else {
      const q = e - NH;
      j0 = Math.floor(q / P);
      i0 = i1 = q - j0 * P;
      j1 = j0 + 1;
    }
    const v0 = val(i0, j0), v1 = val(i1, j1);
    const t = v1 === v0 ? 0.5 : Math.min(1, Math.max(0, (threshold - 0.5 - v0) / (v1 - v0)));
    // Sample (i, j) of the padded grid sits at pixel center (i - 0.5, j - 0.5).
    return [i0 + (i1 - i0) * t - 0.5, j0 + (j1 - j0) * t - 0.5];
  };
  const out: Point[][] = [];
  if (!starts) return out;
  for (let e0 = 0; e0 < next.length; e0++) {
    if (next[e0] < 0) continue;
    const poly: Point[] = [];
    let e = e0;
    while (next[e] >= 0) {
      poly.push(point(e));
      const n = next[e];
      next[e] = -1;
      e = n;
    }
    out.push(dropCollinear(poly));
  }
  return out;
}

function dropCollinear(p: Point[]): Point[] {
  if (p.length < 4) return p;
  const o: Point[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-9) o.push(b);
  }
  return o.length >= 3 ? o : p;
}

export function polygonArea(p: Point[]) {
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return s / 2;
}

// ---------------------------------------------------------------------------
// Rasterization with exact area coverage (signed-area accumulation as in
// Raph Levien's font-rs), clipped to the canvas.

export type RasterOptions = { antiAlias?: boolean; feather?: number; fillRule?: 'nonzero' | 'evenodd' };

class Accumulator {
  readonly stride: number;
  readonly a: Float32Array;
  constructor(readonly w: number, readonly h: number) {
    this.stride = w + 2;
    this.a = new Float32Array(this.stride * h + 2);
  }
  // Split at x = 0 and x = w so clamping each piece keeps the coverage exact
  // (pieces left of the canvas become vertical runs on its left edge).
  line(x0: number, y0: number, x1: number, y1: number) {
    const w = this.w, cuts = [0];
    if (x0 !== x1)
      for (const X of [0, w]) {
        const t = (X - x0) / (x1 - x0);
        if (t > 0 && t < 1) cuts.push(t);
      }
    cuts.push(1);
    cuts.sort((p, q) => p - q);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const ta = cuts[k], tb = cuts[k + 1];
      const ax = x0 + (x1 - x0) * ta, ay = y0 + (y1 - y0) * ta, bx = x0 + (x1 - x0) * tb, by = y0 + (y1 - y0) * tb;
      this.seg(Math.min(Math.max(ax, 0), w), ay, Math.min(Math.max(bx, 0), w), by);
    }
  }
  private seg(px0: number, py0: number, px1: number, py1: number) {
    if (Math.abs(py0 - py1) <= 1e-12) return;
    let dir = 1;
    if (py0 > py1) {
      dir = -1;
      [px0, py0, px1, py1] = [px1, py1, px0, py0];
    }
    const dxdy = (px1 - px0) / (py1 - py0), a = this.a, S = this.stride;
    let x = px0;
    if (py0 < 0) x -= py0 * dxdy;
    const yStart = Math.max(0, Math.floor(py0)), yEnd = Math.min(this.h, Math.ceil(py1));
    for (let y = yStart; y < yEnd; y++) {
      const ls = y * S;
      const dy = Math.min(y + 1, py1) - Math.max(y, py0);
      const xnext = x + dxdy * dy, d = dy * dir;
      const x0 = x < xnext ? x : xnext, x1 = x < xnext ? xnext : x;
      const x0f = Math.floor(x0), x0i = x0f, x1c = Math.ceil(x1), x1i = x1c;
      if (x1i <= x0i + 1) {
        const xmf = 0.5 * (x + xnext) - x0f;
        a[ls + x0i] += d - d * xmf;
        a[ls + x0i + 1] += d * xmf;
      } else {
        const s = 1 / (x1 - x0), fr = x0 - x0f, a0 = 0.5 * s * (1 - fr) * (1 - fr);
        const x1f = x1 - x1c + 1, am = 0.5 * s * x1f * x1f;
        a[ls + x0i] += d * a0;
        if (x1i === x0i + 2) a[ls + x0i + 1] += d * (1 - a0 - am);
        else {
          const a1 = s * (1.5 - fr);
          a[ls + x0i + 1] += d * (a1 - a0);
          for (let xi = x0i + 2; xi < x1i - 1; xi++) a[ls + xi] += d * s;
          const a2 = a1 + (x1i - x0i - 3) * s;
          a[ls + x1i - 1] += d * (1 - a2 - am);
        }
        a[ls + x1i] += d * am;
      }
      x = xnext;
    }
  }
  resolve(opts: RasterOptions): Mask8 {
    const { w, h, a, stride } = this, o = mask8(w, h), aa = opts.antiAlias !== false, eo = opts.fillRule === 'evenodd';
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = 0; x < w; x++) {
        acc += a[y * stride + x];
        let c = Math.abs(acc);
        c = eo ? 1 - Math.abs((c % 2) - 1) : Math.min(1, c);
        o.data[y * w + x] = aa ? Math.round(c * 255) : c >= 0.5 ? 255 : 0;
      }
    }
    return opts.feather ? feather(o, opts.feather) : o;
  }
}

// Fill one contour or several (holes by opposite winding, or by even-odd).
export function rasterizePolygon(points: Point[] | Point[][], w: number, h: number, antiAlias: boolean | RasterOptions = true): Mask8 {
  const opts = typeof antiAlias === 'boolean' ? { antiAlias } : antiAlias;
  const contours = (points.length && Array.isArray(points[0][0]) ? points : [points]) as Point[][];
  const acc = new Accumulator(w, h);
  for (const c of contours)
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) acc.line(c[j][0], c[j][1], c[i][0], c[i][1]);
  return acc.resolve(opts);
}

// Ellipse centred at (cx, cy) with radii rx, ry, optionally rotated (radians).
export function rasterizeEllipse(cx: number, cy: number, rx: number, ry: number, w: number, h: number, opts: RasterOptions & { angle?: number } = {}): Mask8 {
  // Chord error under 1/64 px keeps polygon coverage indistinguishable from the curve.
  const r = Math.max(rx, ry, 0.5), n = Math.max(16, Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - 1 / (64 * r)))));
  const ca = Math.cos(opts.angle ?? 0), sa = Math.sin(opts.angle ?? 0), pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n, ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    pts.push([cx + ex * ca - ey * sa, cy + ex * sa + ey * ca]);
  }
  return rasterizePolygon(pts, w, h, opts);
}

export function rasterizeRect(x: number, y: number, rw: number, rh: number, w: number, h: number, opts: RasterOptions = {}): Mask8 {
  const o = mask8(w, h), aa = opts.antiAlias !== false;
  const cov = (p: number, lo: number, hi: number) => (aa ? Math.max(0, Math.min(p + 1, hi) - Math.max(p, lo)) : p + 0.5 >= lo && p + 0.5 < hi ? 1 : 0);
  const cx = new Float32Array(w);
  for (let i = 0; i < w; i++) cx[i] = cov(i, x, x + rw);
  for (let j = 0; j < h; j++) {
    const cy = cov(j, y, y + rh);
    if (cy) for (let i = 0; i < w; i++) o.data[j * w + i] = Math.round(255 * cx[i] * cy);
  }
  return opts.feather ? feather(o, opts.feather) : o;
}
