// Color Transfer: give an image the color look of a reference by matching
// L*a*b* statistics (Reinhard, Ashikhmin, Gooch and Shirley, "Color Transfer
// between Images", IEEE CG&A 2001), separately for shadows, midtones and
// highlights so, for example, cool shadows and warm highlights of the
// reference both carry over. Bands overlap smoothly by luminance; each band's
// mapping can be weighted, and luminance can be kept. The mapping depends on
// color only, so it is baked into a 3D table and applied trilinearly.
import type { RGBA8 } from '../types';
import { clamp, labToRgb8, labToRgb8Fit, rgb8ToLab } from './util';

export type BandStats = { mean: [number, number, number]; std: [number, number, number]; weight: number };
export type TransferStats = { all: BandStats; bands: [BandStats, BandStats, BandStats] };

/** Shadow, midtone and highlight weights of a luminance (L* 0..100); they sum to 1. */
export function bandWeights(L: number): [number, number, number] {
  const s = 1 - clamp((L - 20) / 30, 0, 1), hi = clamp((L - 55) / 30, 0, 1);
  const sh = s * s * (3 - 2 * s), hh = hi * hi * (3 - 2 * hi);
  return [sh, Math.max(0, 1 - sh - hh), hh];
}

/** Per-band L*a*b* means and deviations, sampled on a grid of about 200 000 pixels. */
export function transferStats(img: RGBA8): TransferStats {
  const { width: w, height: h, data: d } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 200_000)));
  const acc = Array.from({ length: 4 }, () => ({ s: [0, 0, 0], q: [0, 0, 0], w: 0 }));
  const lab = [0, 0, 0];
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const j = (y * w + x) * 4;
      if (d[j + 3] < 128) continue;
      rgb8ToLab(d[j], d[j + 1], d[j + 2], lab);
      const bw = bandWeights(lab[0]);
      for (let b = 0; b < 4; b++) {
        const wt = b === 3 ? 1 : bw[b];
        if (!wt) continue;
        const a = acc[b];
        a.w += wt;
        for (let k = 0; k < 3; k++) {
          a.s[k] += lab[k] * wt;
          a.q[k] += lab[k] * lab[k] * wt;
        }
      }
    }
  const fin = (a: (typeof acc)[number]): BandStats => {
    if (a.w <= 0) return { mean: [50, 0, 0], std: [20, 8, 8], weight: 0 };
    const mean = a.s.map((s) => s / a.w) as [number, number, number];
    const std = a.q.map((q, k) => Math.sqrt(Math.max(0, q / a.w - mean[k] * mean[k]))) as [number, number, number];
    return { mean, std, weight: a.w };
  };
  const all = fin(acc[3]);
  const total = Math.max(1e-9, acc[3].w);
  // Bands with few pixels borrow the overall statistics.
  const bands = [0, 1, 2].map((b) => {
    const st = fin(acc[b]);
    const share = st.weight / total;
    if (share >= 0.03) return st;
    return { ...all, weight: st.weight };
  }) as [BandStats, BandStats, BandStats];
  return { all, bands };
}

/** Validate statistics that came from saved settings. */
export function cleanStats(v: unknown): TransferStats | undefined {
  const band = (b: unknown): BandStats | undefined => {
    const o = b as Partial<BandStats> | null;
    if (!o || !Array.isArray(o.mean) || !Array.isArray(o.std) || o.mean.length !== 3 || o.std.length !== 3) return undefined;
    if (![...o.mean, ...o.std].every((x) => typeof x === 'number' && Number.isFinite(x))) return undefined;
    return { mean: [o.mean[0], o.mean[1], o.mean[2]], std: [Math.max(0, o.std[0]), Math.max(0, o.std[1]), Math.max(0, o.std[2])], weight: typeof o.weight === 'number' && Number.isFinite(o.weight) ? o.weight : 1 };
  };
  const o = v as { all?: unknown; bands?: unknown } | null;
  if (!o || !Array.isArray(o.bands) || o.bands.length !== 3) return undefined;
  const all = band(o.all), bands = o.bands.map(band);
  if (!all || bands.some((b) => !b)) return undefined;
  return { all, bands: bands as [BandStats, BandStats, BandStats] };
}

export type TransferOptions = {
  // 0..100.
  strength: number;
  preserveLuminance: boolean;
  // 0..100 per band.
  shadows: number;
  midtones: number;
  highlights: number;
};

/** The color mapping (input and output encoded 0..255). */
export function transferFunction(src: TransferStats, ref: TransferStats, o: TransferOptions) {
  const amt = [o.shadows / 100, o.midtones / 100, o.highlights / 100];
  const s = clamp(o.strength / 100, 0, 1);
  const ratio = (b: number, k: number) => clamp(src.bands[b].std[k] > 0.5 ? ref.bands[b].std[k] / src.bands[b].std[k] : 1, 0.35, 2.8);
  const R = [0, 1, 2].map((b) => [0, 1, 2].map((k) => ratio(b, k)));
  const lab = [0, 0, 0];
  return (r: number, g: number, b: number, out: number[]) => {
    rgb8ToLab(r, g, b, lab);
    const bw = bandWeights(lab[0]);
    let dL = 0, da = 0, db = 0;
    for (let k = 0; k < 3; k++) {
      const wt = bw[k] * amt[k];
      if (!wt) continue;
      const sb = src.bands[k], rb = ref.bands[k];
      dL += wt * ((lab[0] - sb.mean[0]) * R[k][0] + rb.mean[0] - lab[0]);
      da += wt * ((lab[1] - sb.mean[1]) * R[k][1] + rb.mean[1] - lab[1]);
      db += wt * ((lab[2] - sb.mean[2]) * R[k][2] + rb.mean[2] - lab[2]);
    }
    const L = o.preserveLuminance ? lab[0] : clamp(lab[0] + dL * s, 0, 100);
    (o.preserveLuminance ? labToRgb8Fit : labToRgb8)(L, lab[1] + da * s, lab[2] + db * s, out);
  };
}

/** Apply the transfer to an image. */
export function colorTransfer(img: RGBA8, ref: TransferStats, o: TransferOptions, src = transferStats(img)): RGBA8 {
  const f = transferFunction(src, ref, o);
  // 3D table over encoded RGB, 33 points per axis.
  const N = 33, step = 255 / (N - 1), lut = new Float32Array(N * N * N * 3), tmp = [0, 0, 0];
  for (let bi = 0; bi < N; bi++)
    for (let gi = 0; gi < N; gi++)
      for (let ri = 0; ri < N; ri++) {
        f(ri * step, gi * step, bi * step, tmp);
        const o3 = ((bi * N + gi) * N + ri) * 3;
        lut[o3] = tmp[0];
        lut[o3 + 1] = tmp[1];
        lut[o3 + 2] = tmp[2];
      }
  const d = img.data, out: RGBA8 = { width: img.width, height: img.height, data: new Uint8ClampedArray(d.length) };
  const o8 = out.data, inv = (N - 1) / 255;
  for (let j = 0; j < d.length; j += 4) {
    const fr = d[j] * inv, fg = d[j + 1] * inv, fb = d[j + 2] * inv;
    const r0 = Math.min(N - 2, fr | 0), g0 = Math.min(N - 2, fg | 0), b0 = Math.min(N - 2, fb | 0);
    const tr = fr - r0, tg = fg - g0, tb = fb - b0;
    for (let c = 0; c < 3; c++) {
      const at = (r: number, g: number, b: number) => lut[((b * N + g) * N + r) * 3 + c];
      const c00 = at(r0, g0, b0) * (1 - tr) + at(r0 + 1, g0, b0) * tr;
      const c10 = at(r0, g0 + 1, b0) * (1 - tr) + at(r0 + 1, g0 + 1, b0) * tr;
      const c01 = at(r0, g0, b0 + 1) * (1 - tr) + at(r0 + 1, g0, b0 + 1) * tr;
      const c11 = at(r0, g0 + 1, b0 + 1) * (1 - tr) + at(r0 + 1, g0 + 1, b0 + 1) * tr;
      o8[j + c] = (c00 * (1 - tg) + c10 * tg) * (1 - tb) + (c01 * (1 - tg) + c11 * tg) * tb;
    }
    o8[j + 3] = d[j + 3];
  }
  return out;
}
