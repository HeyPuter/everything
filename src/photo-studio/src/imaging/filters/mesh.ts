// Mesh warps: a grid of control points in destination space deforms the
// source rectangle. A (3k+1) x (3l+1) grid is a set of bicubic Bezier patches
// sharing edges (4 x 4 is the classic single-patch warp); other grids are
// interpolated with a Catmull-Rom surface through the points or bilinearly.
//
// Rendering tessellates the surface into small triangles, scan-converts them to
// build an inverse map (destination pixel -> source point) and then samples
// the source once per pixel, so any fold-overs simply draw last-wins.
import type { IRect, Progress, RGBA8 } from '../types';
import { checkCancelled, rgba8 } from '../types';
import { resize } from './resample';
import { type Interp, samplerFor } from './sampling';

export type MeshGrid = {
  cols: number;
  rows: number;
  // Interleaved x, y per point, row-major (row 0 is the top edge of the source).
  points: Float64Array;
  mode?: 'bezier' | 'smooth' | 'bilinear';
  // Bezier grids: where each patch starts and ends across the source (0..1,
  // one more entry than patches). Uneven patches come from splitting a warp;
  // omitted means evenly spaced.
  uKnots?: number[];
  vKnots?: number[];
};
/** Patch boundaries of a Bezier grid along u (columns) or v (rows). */
export function meshKnots(g: MeshGrid, axis: 'u' | 'v'): number[] {
  const k = axis === 'u' ? g.uKnots : g.vKnots;
  if (k) return k;
  const n = ((axis === 'u' ? g.cols : g.rows) - 1) / 3;
  return Array.from({ length: n + 1 }, (_, i) => i / n);
}
// Patch index and local parameter of t on a knot vector.
function span(k: number[] | undefined, n: number, t: number): [number, number] {
  if (!k) {
    const i = Math.min(n - 1, Math.max(0, Math.floor(t * n)));
    return [i, t * n - i];
  }
  let i = 0;
  while (i < n - 1 && t >= k[i + 1]) i++;
  return [i, (t - k[i]) / (k[i + 1] - k[i])];
}
export type MeshWarpResult = { image: RGBA8; rect: IRect };

// A regular grid over `rect` (identity warp).
export function identityGrid(rect: IRect, cols = 4, rows = 4, mode?: MeshGrid['mode']): MeshGrid {
  const points = new Float64Array(cols * rows * 2);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      points[(j * cols + i) * 2] = rect.x + (rect.width * i) / (cols - 1);
      points[(j * cols + i) * 2 + 1] = rect.y + (rect.height * j) / (rows - 1);
    }
  return { cols, rows, points, mode };
}

function gridMode(g: MeshGrid): 'bezier' | 'smooth' | 'bilinear' {
  if (g.mode) return g.mode;
  return (g.cols - 1) % 3 === 0 && (g.rows - 1) % 3 === 0 ? 'bezier' : 'smooth';
}

function bern(t: number, out: Float64Array) {
  const s = 1 - t;
  out[0] = s * s * s;
  out[1] = 3 * s * s * t;
  out[2] = 3 * s * t * t;
  out[3] = t * t * t;
}
function catmull(t: number, out: Float64Array) {
  const t2 = t * t,
    t3 = t2 * t;
  out[0] = 0.5 * (-t3 + 2 * t2 - t);
  out[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  out[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  out[3] = 0.5 * (t3 - t2);
}

const BU = new Float64Array(4),
  BV = new Float64Array(4);
// Evaluates the surface at (u, v) in [0, 1]^2 (slightly outside extrapolates).
export function evalMesh(g: MeshGrid, u: number, v: number, out: Float64Array = new Float64Array(2)): Float64Array {
  const mode = gridMode(g),
    P = g.points,
    C = g.cols,
    R = g.rows;
  const bu = BU,
    bv = BV;
  let x = 0,
    y = 0;
  if (mode === 'bezier') {
    const [iu, fu] = span(g.uKnots, (C - 1) / 3, u),
      [iv, fv] = span(g.vKnots, (R - 1) / 3, v);
    bern(fu, bu);
    bern(fv, bv);
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const k = ((iv * 3 + j) * C + iu * 3 + i) * 2,
          w = bu[i] * bv[j];
        x += w * P[k];
        y += w * P[k + 1];
      }
  } else if (mode === 'smooth') {
    const iu = Math.min(C - 2, Math.max(0, Math.floor(u * (C - 1)))),
      iv = Math.min(R - 2, Math.max(0, Math.floor(v * (R - 1))));
    catmull(u * (C - 1) - iu, bu);
    catmull(v * (R - 1) - iv, bv);
    // Missing neighbours at the border are linearly extrapolated.
    for (let j = 0; j < 4; j++) {
      const rj = iv + j - 1;
      for (let i = 0; i < 4; i++) {
        const ci = iu + i - 1,
          w = bu[i] * bv[j];
        const cc = ci < 0 ? 0 : ci >= C ? C - 1 : ci,
          rr = rj < 0 ? 0 : rj >= R ? R - 1 : rj;
        let px = P[(rr * C + cc) * 2],
          py = P[(rr * C + cc) * 2 + 1];
        if (cc !== ci) {
          const n = (rr * C + (ci < 0 ? 1 : C - 2)) * 2;
          px = 2 * px - P[n];
          py = 2 * py - P[n + 1];
        }
        if (rr !== rj) {
          const n = ((rj < 0 ? 1 : R - 2) * C + cc) * 2;
          px += P[(rr * C + cc) * 2] - P[n];
          py += P[(rr * C + cc) * 2 + 1] - P[n + 1];
        }
        x += w * px;
        y += w * py;
      }
    }
  } else {
    const iu = Math.min(C - 2, Math.max(0, Math.floor(u * (C - 1)))),
      iv = Math.min(R - 2, Math.max(0, Math.floor(v * (R - 1))));
    const fu = u * (C - 1) - iu,
      fv = v * (R - 1) - iv;
    const k00 = (iv * C + iu) * 2,
      k10 = k00 + 2,
      k01 = k00 + C * 2,
      k11 = k01 + 2;
    x = (P[k00] * (1 - fu) + P[k10] * fu) * (1 - fv) + (P[k01] * (1 - fu) + P[k11] * fu) * fv;
    y = (P[k00 + 1] * (1 - fu) + P[k10 + 1] * fu) * (1 - fv) + (P[k01 + 1] * (1 - fu) + P[k11 + 1] * fu) * fv;
  }
  out[0] = x;
  out[1] = y;
  return out;
}

// `draft` skips prefiltering for previews redrawn while the pointer moves.
export type MeshWarpOptions = { progress?: Progress; clip?: IRect; draft?: boolean };

export function meshWarp(
  src: RGBA8,
  grid: MeshGrid,
  method: Interp = 'bilinear',
  opts: MeshWarpOptions = {},
): MeshWarpResult {
  const sw = src.width,
    sh = src.height;
  // Tessellation density: about one segment per 4 destination pixels.
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const P = grid.points;
  for (let k = 0; k < P.length; k += 2) {
    minX = Math.min(minX, P[k]);
    maxX = Math.max(maxX, P[k]);
    minY = Math.min(minY, P[k + 1]);
    maxY = Math.max(maxY, P[k + 1]);
  }
  const extent = Math.max(maxX - minX, maxY - minY, 1);
  const nu = Math.max(8, Math.min(512, Math.ceil(extent / 4))),
    nv = nu;
  // Extend one source pixel past every edge so bilinear sampling of the
  // transparent border produces antialiased edges.
  const eu = 1 / sw,
    ev = 1 / sh;
  const NU = nu + 3,
    NV = nv + 3;
  const vx = new Float64Array(NU * NV),
    vy = new Float64Array(NU * NV),
    us = new Float64Array(NU),
    vs = new Float64Array(NV);
  for (let i = 0; i < NU; i++) us[i] = i === 0 ? -eu : i === NU - 1 ? 1 + eu : (i - 1) / nu;
  for (let j = 0; j < NV; j++) vs[j] = j === 0 ? -ev : j === NV - 1 ? 1 + ev : (j - 1) / nv;
  // NU = nu + 3 nodes: -eu, 0 .. 1 (nu + 1 nodes), 1 + eu.
  const t = new Float64Array(2);
  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity;
  for (let j = 0; j < NV; j++)
    for (let i = 0; i < NU; i++) {
      evalMesh(grid, us[i], vs[j], t);
      vx[j * NU + i] = t[0];
      vy[j * NU + i] = t[1];
      if (i > 0 && i < NU - 1 && j > 0 && j < NV - 1) {
        if (t[0] < bx0) bx0 = t[0];
        if (t[0] > bx1) bx1 = t[0];
        if (t[1] < by0) by0 = t[1];
        if (t[1] > by1) by1 = t[1];
      }
    }
  let rect: IRect = {
    x: Math.floor(bx0 + 1e-7),
    y: Math.floor(by0 + 1e-7),
    width: Math.ceil(bx1 - 1e-7) - Math.floor(bx0 + 1e-7),
    height: Math.ceil(by1 - 1e-7) - Math.floor(by0 + 1e-7),
  };
  if (opts.clip) {
    const c = opts.clip,
      x0 = Math.max(rect.x, c.x),
      y0 = Math.max(rect.y, c.y),
      x1 = Math.min(rect.x + rect.width, c.x + c.width),
      y1 = Math.min(rect.y + rect.height, c.y + c.height);
    rect = { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }
  const W = Math.max(0, rect.width),
    H = Math.max(0, rect.height);
  const mapX = new Float32Array(W * H).fill(NaN),
    mapY = new Float32Array(W * H);
  // Scan-convert each triangle, interpolating source coordinates.
  const tri = (
    a: number,
    b: number,
    c: number,
    sa: number,
    sb: number,
    sc: number,
    ta: number,
    tb: number,
    tc: number,
  ) => {
    const ax = vx[a] - rect.x,
      ay = vy[a] - rect.y,
      bx = vx[b] - rect.x,
      by = vy[b] - rect.y,
      cx = vx[c] - rect.x,
      cy = vy[c] - rect.y;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) return;
    const inv = 1 / area;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5)),
      x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx) - 0.5)),
      y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5)),
      y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy) - 0.5));
    const eps = -1e-9;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv,
          w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < eps || w1 < eps || w2 < eps) continue;
        const k = y * W + x;
        mapX[k] = (w0 * sa + w1 * sb + w2 * sc) * sw;
        mapY[k] = (w0 * ta + w1 * tb + w2 * tc) * sh;
      }
    }
  };
  for (let j = 0; j < NV - 1; j++) {
    checkCancelled(opts.progress);
    for (let i = 0; i < NU - 1; i++) {
      const a = j * NU + i,
        b = a + 1,
        c = a + NU,
        d = c + 1;
      tri(a, b, d, us[i], us[i + 1], us[i + 1], vs[j], vs[j], vs[j + 1]);
      tri(a, d, c, us[i], us[i + 1], us[i], vs[j], vs[j + 1], vs[j + 1]);
    }
  }
  // A warp that reduces the source (a frame scaled down, then warped) reads
  // a prefiltered copy, as transformImage does, instead of aliasing.
  let source = src,
    kx = 1,
    ky = 1;
  if (method !== 'nearest' && !opts.draft) {
    const [fx, fy] = meshReduction(vx, vy, us, vs, NU, NV, sw, sh);
    if (fx >= 2 || fy >= 2) {
      const w = fx >= 2 ? Math.max(1, Math.round(sw / Math.min(fx, sw))) : sw,
        h = fy >= 2 ? Math.max(1, Math.round(sh / Math.min(fy, sh))) : sh;
      source = resize(src, w, h, 'bilinear');
      kx = w / sw;
      ky = h / sh;
    }
  }
  const image = rgba8(W, H),
    od = image.data,
    sampler = samplerFor(method),
    px = new Float32Array(4);
  const row = (y: number) => {
    for (let x = 0, k = y * W; x < W; x++, k++) {
      const mx = mapX[k];
      if (!(mx === mx)) continue;
      sampler(source, mx * kx, mapY[k] * ky, 'transparent', px, 0);
      od[k * 4] = px[0];
      od[k * 4 + 1] = px[1];
      od[k * 4 + 2] = px[2];
      od[k * 4 + 3] = px[3];
    }
  };
  for (let y = 0; y < H; y++) {
    if ((y & 31) === 0) {
      checkCancelled(opts.progress);
      opts.progress?.report?.(y / H);
    }
    row(y);
  }
  opts.progress?.report?.(1);
  return { image, rect };
}

/** The smallest reduction (source pixels per destination pixel) of each
 * source axis over the interior cells of a tessellated mesh. */
function meshReduction(
  vx: Float64Array,
  vy: Float64Array,
  us: Float64Array,
  vs: Float64Array,
  NU: number,
  NV: number,
  sw: number,
  sh: number,
): [number, number] {
  let fx = Infinity,
    fy = Infinity;
  for (let j = 1; j < NV - 2; j++)
    for (let i = 1; i < NU - 2; i++) {
      const k = j * NU + i,
        su = (us[i + 1] - us[i]) * sw,
        sv = (vs[j + 1] - vs[j]) * sh;
      // Destination movement per source pixel along x (a, c) and y (b, d).
      const a = (vx[k + 1] - vx[k]) / su,
        c = (vy[k + 1] - vy[k]) / su,
        b = (vx[k + NU] - vx[k]) / sv,
        d = (vy[k + NU] - vy[k]) / sv;
      const det = Math.abs(a * d - b * c);
      if (!(det > 1e-12)) continue;
      // Rows of the inverse Jacobian: how fast source x and y change.
      fx = Math.min(fx, Math.hypot(b, d) / det);
      fy = Math.min(fy, Math.hypot(a, c) / det);
    }
  return [fx === Infinity ? 1 : fx, fy === Infinity ? 1 : fy];
}

// ---------------------------------------------------------------------------
// Preset warp shapes. Each style is a smooth map of the unit square; the 4 x 4
// Bezier control grid is fitted so the patch interpolates that map at the 16
// points u, v in {0, 1/3, 2/3, 1} (bend 0 gives the exact identity grid).

export type WarpStyle =
  | 'arc'
  | 'arc-lower'
  | 'arc-upper'
  | 'arch'
  | 'bulge'
  | 'shell-lower'
  | 'shell-upper'
  | 'flag'
  | 'wave'
  | 'fish'
  | 'rise'
  | 'fisheye'
  | 'inflate'
  | 'squeeze'
  | 'twist';
export const WARP_STYLES: { value: WarpStyle; label: string }[] = [
  { value: 'arc', label: 'Arc' },
  { value: 'arc-lower', label: 'Arc Lower' },
  { value: 'arc-upper', label: 'Arc Upper' },
  { value: 'arch', label: 'Arch' },
  { value: 'bulge', label: 'Bulge' },
  { value: 'shell-lower', label: 'Shell Lower' },
  { value: 'shell-upper', label: 'Shell Upper' },
  { value: 'flag', label: 'Flag' },
  { value: 'wave', label: 'Wave' },
  { value: 'fish', label: 'Fish' },
  { value: 'rise', label: 'Rise' },
  { value: 'fisheye', label: 'Fisheye' },
  { value: 'inflate', label: 'Inflate' },
  { value: 'squeeze', label: 'Squeeze' },
  { value: 'twist', label: 'Twist' },
];

// Shape function in rect-local pixels; b in [-1, 1].
function shape(style: WarpStyle, b: number, u: number, v: number, W: number, H: number, out: Float64Array) {
  let X = u * W,
    Y = v * H;
  const c = 1 - (2 * u - 1) ** 2,
    px = 2 * u - 1,
    py = 2 * v - 1;
  switch (style) {
    case 'arc': {
      // Bend the rectangle onto an annulus sector spanning b * 180 degrees.
      const A = b * Math.PI;
      if (Math.abs(A) > 1e-9) {
        const r0 = W / A,
          th = (u - 0.5) * A,
          r = r0 + (0.5 - v) * H;
        X = W / 2 + r * Math.sin(th);
        Y = H / 2 + r0 - r * Math.cos(th);
      }
      break;
    }
    case 'arc-lower':
      Y += b * v * (H / 2) * c;
      break;
    case 'arc-upper':
      Y -= b * (1 - v) * (H / 2) * c;
      break;
    case 'arch':
      Y -= b * (H / 2) * c;
      break;
    case 'bulge':
      Y += b * py * (H / 4) * c;
      break;
    case 'shell-lower':
      Y -= b * v * (H / 2) * (1 - c);
      X = W / 2 + px * (W / 2) * (1 + 0.3 * b * v);
      break;
    case 'shell-upper':
      Y += b * (1 - v) * (H / 2) * (1 - c);
      X = W / 2 + px * (W / 2) * (1 + 0.3 * b * (1 - v));
      break;
    case 'flag':
      Y -= b * (H / 4) * Math.sin(2 * Math.PI * u);
      break;
    case 'wave':
      Y -= b * (H / 4) * Math.sin(2 * Math.PI * (u + 0.25 * v));
      break;
    case 'fish':
      Y += b * py * (H / 4) * Math.sin(2 * Math.PI * u);
      break;
    case 'rise':
      Y -= b * (H / 2) * Math.sin(Math.PI * (u - 0.5));
      break;
    case 'fisheye': {
      const s = 1 + 0.4 * b * (1 - (px * px + py * py) / 2);
      X = W / 2 + px * s * (W / 2);
      Y = H / 2 + py * s * (H / 2);
      break;
    }
    case 'inflate':
      X = W / 2 + px * (W / 2) * (1 + 0.5 * b * (1 - py * py));
      Y = H / 2 + py * (H / 2) * (1 + 0.5 * b * (1 - px * px));
      break;
    case 'squeeze':
      X = W / 2 + px * (W / 2) * (1 - 0.5 * b * (1 - py * py));
      Y = H / 2 + py * (H / 2) * (1 + 0.5 * b * (1 - px * px));
      break;
    case 'twist': {
      const rho = Math.min(1, Math.sqrt((px * px + py * py) / 2)),
        th = b * (Math.PI / 2) * (1 - rho) ** 2;
      const dx = X - W / 2,
        dy = Y - H / 2,
        cs = Math.cos(th),
        sn = Math.sin(th);
      X = W / 2 + dx * cs - dy * sn;
      Y = H / 2 + dx * sn + dy * cs;
      break;
    }
  }
  out[0] = X;
  out[1] = Y;
}

const BEZ_INV = (() => {
  // Rows: Bernstein basis evaluated at t = 0, 1/3, 2/3, 1; invert it once.
  const m: number[][] = [0, 1 / 3, 2 / 3, 1].map((t) => {
    const s = 1 - t;
    return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
  });
  const n = 4,
    a = m.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let k = 0; k < 2 * n; k++) a[c][k] /= d;
    for (let r = 0; r < n; r++)
      if (r !== c) {
        const f = a[r][c];
        for (let k = 0; k < 2 * n; k++) a[r][k] -= f * a[c][k];
      }
  }
  return a.map((r) => r.slice(n));
})();

// Returns the 4 x 4 Bezier control grid for a preset warp over `rect`.
// bend, horizontal and vertical are fractions in [-1, 1] (UI percent / 100).
export function warpPreset(
  style: WarpStyle,
  bend: number,
  horizontal: number,
  vertical: number,
  rect: IRect,
): MeshGrid {
  const W = rect.width,
    H = rect.height,
    F = new Float64Array(32),
    t = new Float64Array(2);
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 4; i++) {
      shape(style, bend, i / 3, j / 3, W, H, t);
      let X = t[0],
        Y = t[1];
      // Horizontal/vertical distortion: a perspective-like taper.
      const fx = 1 + 0.5 * vertical * ((2 * Y) / H - 1),
        fy = 1 + 0.5 * horizontal * ((2 * X) / W - 1);
      X = W / 2 + (X - W / 2) * fx;
      Y = H / 2 + (Y - H / 2) * fy;
      F[(j * 4 + i) * 2] = X;
      F[(j * 4 + i) * 2 + 1] = Y;
    }
  // P = Binv * F * Binv^T, separately for x and y.
  const points = new Float64Array(32);
  for (let c = 0; c < 2; c++)
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        let s = 0;
        for (let q = 0; q < 4; q++)
          for (let p = 0; p < 4; p++) s += BEZ_INV[j][q] * F[(q * 4 + p) * 2 + c] * BEZ_INV[i][p];
        points[(j * 4 + i) * 2 + c] = s + (c ? rect.y : rect.x);
      }
  return { cols: 4, rows: 4, points, mode: 'bezier' };
}
