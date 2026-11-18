// Projective transforms (affine and perspective) by inverse mapping, the
// homography solver behind perspective crop, and quad rectification.
import type { IRect, Progress, RGBA8 } from '../types';
import { checkCancelled, rgba8 } from '../types';
import { resize } from './resample';
import { type EdgeMode, type Interp, type Sampler, samplerFor } from './sampling';

export { warpImage, buildMapGrid, type CoordMap, type MapGrid, type WarpOptions } from './sampling';

// Row-major 3x3: [a b c; d e f; g h i] maps (x, y) to ((ax+by+c)/w, (dx+ey+f)/w), w = gx+hy+i.
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type Point = { x: number; y: number };

export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}
export function mat3Invert(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det || !Number.isFinite(det)) return null;
  const s = 1 / det;
  return [
    A * s,
    -(b * i - c * h) * s,
    (b * f - c * e) * s,
    B * s,
    (a * i - c * g) * s,
    -(a * f - c * d) * s,
    C * s,
    -(a * h - b * g) * s,
    (a * e - b * d) * s,
  ];
}
export function applyMat3(m: Mat3, x: number, y: number): Point {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
}

// Solves the 8x8 direct linear system for the homography H with H * src[k] ~ dst[k]
// (h33 = 1), Gaussian elimination with partial pivoting. Points are normalized
// first (Hartley 1997) so large pixel coordinates stay well conditioned.
export function homography(src: Point[], dst: Point[]): Mat3 {
  if (src.length !== 4 || dst.length !== 4) throw new Error('homography needs four point pairs');
  const norm = (p: Point[]): Mat3 => {
    const cx = (p[0].x + p[1].x + p[2].x + p[3].x) / 4,
      cy = (p[0].y + p[1].y + p[2].y + p[3].y) / 4;
    let d = 0;
    for (const q of p) d += Math.hypot(q.x - cx, q.y - cy);
    const s = d > 0 ? (4 * Math.SQRT2) / d : 1;
    return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
  };
  const Ts = norm(src),
    Td = norm(dst);
  const ps = src.map((p) => applyMat3(Ts, p.x, p.y)),
    pd = dst.map((p) => applyMat3(Td, p.x, p.y));
  const M: number[][] = [];
  for (let k = 0; k < 4; k++) {
    const { x, y } = ps[k],
      { x: u, y: v } = pd[k];
    M.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    M.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('degenerate point configuration');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k < 9; k++) M[r][k] -= f * M[c][k];
    }
  }
  const h = M.map((row, i) => row[8] / row[i]);
  const Hn: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const H = mat3Multiply(mat3Invert(Td)!, mat3Multiply(Hn, Ts));
  const s = H[8] || 1;
  return H.map((v) => v / s) as Mat3;
}

export function transformedBounds(m: Mat3, width: number, height: number): IRect {
  const pts = [applyMat3(m, 0, 0), applyMat3(m, width, 0), applyMat3(m, width, height), applyMat3(m, 0, height)];
  const xs = pts.map((p) => p.x),
    ys = pts.map((p) => p.y);
  const x = Math.floor(Math.min(...xs)),
    y = Math.floor(Math.min(...ys));
  return { x, y, width: Math.ceil(Math.max(...xs)) - x, height: Math.ceil(Math.max(...ys)) - y };
}

// Source pixels per destination pixel at a destination point, per source
// axis: how fast the source x and y coordinates change across one output
// pixel. A reduction of one axis only leaves the other at about 1.
function inverseScales(inv: Mat3, x: number, y: number): [number, number] {
  const p = applyMat3(inv, x, y),
    px = applyMat3(inv, x + 1, y),
    py = applyMat3(inv, x, y + 1);
  return [Math.hypot(px.x - p.x, py.x - p.x), Math.hypot(px.y - p.y, py.y - p.y)];
}

function projectiveRow(
  source: RGBA8,
  od: Uint8ClampedArray,
  y: number,
  W: number,
  x0: number,
  Y: number,
  inv: Mat3,
  sampler: Sampler,
  edge: EdgeMode,
  px: Float32Array,
) {
  const [a, b, c, d, e, f, g, h, i] = inv;
  let o = y * W * 4;
  for (let x = 0; x < W; x++, o += 4) {
    const X = x0 + x + 0.5;
    const w = g * X + h * Y + i;
    // Points behind the projection plane have no source.
    if (w <= 0) continue;
    sampler(source, (a * X + b * Y + c) / w, (d * X + e * Y + f) / w, edge, px, 0);
    od[o] = px[0];
    od[o + 1] = px[1];
    od[o + 2] = px[2];
    od[o + 3] = px[3];
  }
}

export type TransformOptions = { edge?: EdgeMode; progress?: Progress };

// Renders `src` transformed by the forward matrix `m` (source pixels to
// destination pixels) into the destination rectangle `outRect`. Strong
// reductions are prefiltered by resizing the source first so they do not alias.
export function transformImage(
  src: RGBA8,
  m: Mat3,
  outRect: IRect,
  method: Interp = 'bilinear',
  opts: TransformOptions = {},
): RGBA8 {
  const W = Math.max(0, Math.round(outRect.width)),
    H = Math.max(0, Math.round(outRect.height));
  const out = rgba8(W, H);
  let inv = mat3Invert(m);
  if (!inv || !W || !H) return out;
  let source = src;
  if (method !== 'nearest') {
    const r = outRect;
    const corners = [
      inverseScales(inv, r.x, r.y),
      inverseScales(inv, r.x + W, r.y),
      inverseScales(inv, r.x, r.y + H),
      inverseScales(inv, r.x + W, r.y + H),
    ];
    // Prefilter each axis by its own reduction: shrinking only the width
    // must not blur the height.
    const fx = Math.min(...corners.map((c) => c[0])),
      fy = Math.min(...corners.map((c) => c[1]));
    if (fx >= 2 || fy >= 2) {
      const sw = fx >= 2 ? Math.max(1, Math.round(src.width / Math.min(fx, src.width))) : src.width,
        sh = fy >= 2 ? Math.max(1, Math.round(src.height / Math.min(fy, src.height))) : src.height;
      source = resize(src, sw, sh, 'bilinear');
      inv = mat3Multiply([sw / src.width, 0, 0, 0, sh / src.height, 0, 0, 0, 1], inv);
    }
  }
  const sampler = samplerFor(method),
    edge = opts.edge ?? 'transparent',
    od = out.data,
    px = new Float32Array(4);
  for (let y = 0; y < H; y++) {
    if ((y & 31) === 0) {
      checkCancelled(opts.progress);
      opts.progress?.report?.(y / H);
    }
    projectiveRow(source, od, y, W, outRect.x, outRect.y + y + 0.5, inv, sampler, edge, px);
  }
  opts.progress?.report?.(1);
  return out;
}

// Perspective crop: maps the quadrilateral `quad` (top-left, top-right,
// bottom-right, bottom-left, in source pixels) onto an outW x outH rectangle.
export function rectifyQuad(
  src: RGBA8,
  quad: Point[],
  outW: number,
  outH: number,
  method: Interp = 'bicubic',
  opts: TransformOptions = {},
): RGBA8 {
  const m = homography(quad, [
    { x: 0, y: 0 },
    { x: outW, y: 0 },
    { x: outW, y: outH },
    { x: 0, y: outH },
  ]);
  return transformImage(src, m, { x: 0, y: 0, width: outW, height: outH }, method, { edge: 'clamp', ...opts });
}
