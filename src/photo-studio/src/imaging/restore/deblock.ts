// JPEG Artifact Removal: block grid estimation, deblocking across 8x8 block
// boundaries, deringing near edges and chroma cleanup.
//
// - The grid phase is where luma steps between neighbors are largest on
//   average (block boundaries of a shifted or cropped JPEG need not start at 0).
//   The ratio of boundary steps to steps inside blocks measures blockiness
//   (in the spirit of Wang, Bovik and Evans, "Blind measurement of blocking
//   artifacts in images", ICIP 2000).
// - Deblocking removes the step at each boundary segment where the step is
//   small compared with a real edge, spreading the correction over the block
//   as a ramp (the "offset" idea of adaptive deblocking filters such as the
//   in-loop filters of video codecs, List et al., IEEE TCSVT 2003).
// - Deringing smooths flat pixels inside blocks that contain a strong edge
//   (mosquito noise) with a range-limited bilateral weight.
// - Chroma is guided-filtered by luma, removing 16x16 chroma blocks and bleed.
import { guidedFilterGray } from '../segment/filters';
import type { RGBA8 } from '../types';
import { fromYCC, toYCC, type Plane } from './util';

export type GridEstimate = { px: number; py: number; blockiness: number };

function boundaryProfile(Y: Plane, w: number, h: number, horizontal: boolean): Float64Array {
  const sums = new Float64Array(8), counts = new Float64Array(8);
  if (horizontal) {
    for (let y = 0; y < h; y++)
      for (let x = 1; x < w; x++) {
        const i = y * w + x;
        sums[x & 7] += Math.abs(Y[i] - Y[i - 1]);
        counts[x & 7]++;
      }
  } else {
    for (let y = 1; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        sums[y & 7] += Math.abs(Y[i] - Y[i - w]);
        counts[y & 7]++;
      }
  }
  for (let k = 0; k < 8; k++) sums[k] = counts[k] ? sums[k] / counts[k] : 0;
  return sums;
}

/** Block grid phase (the first column/row of a block) and blockiness ratio
 * (1 = no blocks; above about 1.15 blocks are usually visible). */
export function estimateGrid(Y: Plane, w: number, h: number): GridEstimate {
  if (w < 16 || h < 16) return { px: 0, py: 0, blockiness: 1 };
  const ph = boundaryProfile(Y, w, h, true), pv = boundaryProfile(Y, w, h, false);
  let px = 0, py = 0;
  for (let k = 1; k < 8; k++) {
    if (ph[k] > ph[px]) px = k;
    if (pv[k] > pv[py]) py = k;
  }
  const rest = (p: Float64Array, k: number) => {
    let s = 0;
    for (let j = 0; j < 8; j++) if (j !== k) s += p[j];
    return s / 7;
  };
  const bh = ph[px] / Math.max(1e-3, rest(ph, px)), bv = pv[py] / Math.max(1e-3, rest(pv, py));
  return { px, py, blockiness: (bh + bv) / 2 };
}
/** Blockiness of an image (see estimateGrid). */
export function blockiness(img: RGBA8): number {
  const [Y] = toYCC(img);
  return estimateGrid(Y, img.width, img.height).blockiness;
}

export type DeblockStrength = 'low' | 'medium' | 'high' | 'auto';
/** Numeric strength 0..1 for a setting (auto follows the measured blockiness). */
export function strengthValue(s: DeblockStrength, measured: number): number {
  if (s === 'low') return 0.35;
  if (s === 'medium') return 0.65;
  if (s === 'high') return 1;
  return Math.max(0.2, Math.min(1, (measured - 1.02) * 3.2));
}

/** Remove the step at block boundaries along one direction, in place. */
function deblockPlane(P: Plane, w: number, h: number, phase: number, horizontal: boolean, threshold: number) {
  const along = horizontal ? h : w, across = horizontal ? w : h;
  const at = (a: number, b: number) => (horizontal ? a * w + b : b * w + a);
  for (let b = phase === 0 ? 8 : phase; b < across; b += 8) {
    if (b < 2 || b > across - 2) continue;
    for (let a0 = 0; a0 < along; a0 += 4) {
      const a1 = Math.min(along, a0 + 4);
      // Boundary step and the gradient expected from either side.
      let step = 0, grad = 0, act = 0, cnt = 0;
      for (let a = a0; a < a1; a++) {
        const p1 = P[at(a, b - 2)], p0 = P[at(a, b - 1)], q0 = P[at(a, b)], q1 = P[at(a, b + 1)];
        step += q0 - p0;
        grad += (p0 - p1 + q1 - q0) / 2;
        act += Math.abs(p0 - p1) + Math.abs(q1 - q0);
        cnt++;
      }
      step /= cnt;
      grad /= cnt;
      act /= cnt * 2;
      const offset = step - grad;
      // A real edge: large step or busy surroundings.
      if (Math.abs(offset) > threshold || act > threshold * 0.8) continue;
      const reach = Math.min(4, b, across - b);
      for (let a = a0; a < a1; a++)
        for (let k = 0; k < reach; k++) {
          const t = (offset / 2) * (1 - (k + 0.5) / reach);
          P[at(a, b - 1 - k)] += t;
          P[at(a, b + k)] -= t;
        }
    }
  }
}

/** Mosquito-noise reduction: in blocks with a strong edge, flat pixels are
 * averaged with similar neighbors (3x3 bilateral weights). */
function dering(P: Plane, w: number, h: number, px: number, py: number, edge: number, range: number): Plane {
  const out = new Float32Array(P);
  const inv = 1 / (2 * range * range);
  const x0 = px === 0 ? 0 : px - 8, y0 = py === 0 ? 0 : py - 8;
  for (let by = y0; by < h; by += 8)
    for (let bx = x0; bx < w; bx += 8) {
      const xa = Math.max(0, bx), ya = Math.max(0, by), xb = Math.min(w, bx + 8), yb = Math.min(h, by + 8);
      let mx = 0;
      for (let y = ya; y < yb; y++)
        for (let x = xa + 1; x < xb; x++) mx = Math.max(mx, Math.abs(P[y * w + x] - P[y * w + x - 1]), y > ya ? Math.abs(P[y * w + x] - P[(y - 1) * w + x]) : 0);
      if (mx < edge) continue;
      for (let y = ya; y < yb; y++)
        for (let x = xa; x < xb; x++) {
          const i = y * w + x, v = P[i];
          let s = 0, ws = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              const u = P[yy * w + xx], dd = u - v, wt = Math.exp(-dd * dd * inv);
              s += u * wt;
              ws += wt;
            }
          }
          out[i] = s / ws;
        }
    }
  return out;
}

export type DeblockOptions = { strength: DeblockStrength };
export type DeblockResult = { image: RGBA8; grid: GridEstimate; amount: number };

/** Remove JPEG blocking, ringing and chroma artifacts. */
export function removeJpegArtifacts(img: RGBA8, o: DeblockOptions): DeblockResult {
  const { width: w, height: h } = img;
  const [Y, Cb, Cr] = toYCC(img);
  const grid = estimateGrid(Y, w, h);
  const s = strengthValue(o.strength, grid.blockiness);
  // Boundary steps up to this size (luma units) count as artifacts.
  const thr = 3 + 15 * s;
  for (let pass = 0; pass < (s > 0.7 ? 2 : 1); pass++) {
    deblockPlane(Y, w, h, grid.px, true, thr);
    deblockPlane(Y, w, h, grid.py, false, thr);
  }
  const Yd = dering(Y, w, h, grid.px, grid.py, 18 + 20 * (1 - s), 3 + 6 * s);
  // Chroma: block steps are larger (subsampled 16x16 blocks), so deblock with
  // a higher threshold and then let luma guide a smoothing pass.
  for (const C of [Cb, Cr]) {
    deblockPlane(C, w, h, grid.px, true, thr * 1.5);
    deblockPlane(C, w, h, grid.py, false, thr * 1.5);
  }
  const Yn = new Float32Array(Yd.length);
  for (let i = 0; i < Yn.length; i++) Yn[i] = Yd[i] / 255;
  const r = Math.max(1, Math.round(1 + 2 * s));
  const cbS = guidedFilterGray(Yn, Cb, w, h, r, 0.004), crS = guidedFilterGray(Yn, Cr, w, h, r, 0.004);
  for (let i = 0; i < Cb.length; i++) {
    Cb[i] += (cbS[i] - Cb[i]) * s;
    Cr[i] += (crS[i] - Cr[i]) * s;
  }
  const out = fromYCC(Yd, Cb, Cr, img);
  return { image: out, grid, amount: s };
}
