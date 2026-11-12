// Histograms and the analysis behind Auto Tone/Contrast/Color and Equalize.
// Counted pixels: alpha > 0 and, with a selection, coverage >= 128 (a pixel is
// "in" the selection when at least half selected).
import type { Mask8, RGBA8 } from '../types';
import { luma8 } from './color-math';
import { defaultParams, type LevelsChannel, type LevelsParams } from './model';

export type HistogramChannel = 'r' | 'g' | 'b' | 'luminosity' | 'rgb';
export type Histograms = { r: Uint32Array; g: Uint32Array; b: Uint32Array; luminosity: Uint32Array; rgb: Uint32Array };
export type HistogramStats = { mean: number; stdDev: number; median: number; pixels: number };

const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const counted = (src: RGBA8, sel: Uint8Array | undefined, p: number) => src.data[p * 4 + 3] > 0 && (!sel || sel[p] >= 128);

// All channels in one pass. `rgb` sums the three channel histograms.
export function histograms(src: RGBA8, selection?: Mask8): Histograms {
  const r = new Uint32Array(256),
    g = new Uint32Array(256),
    b = new Uint32Array(256),
    l = new Uint32Array(256),
    rgb = new Uint32Array(256);
  const d = src.data,
    sel = selection?.data,
    n = src.width * src.height;
  // One 32-bit read per pixel (about 1.5x faster on large images).
  if (littleEndian && d.byteOffset % 4 === 0 && d.length >= n * 4) {
    const words = new Uint32Array(d.buffer, d.byteOffset, n);
    for (let p = 0; p < n; p++) {
      const w = words[p];
      if (w >>> 24 === 0 || (sel && sel[p] < 128)) continue;
      const R = w & 255,
        G = (w >>> 8) & 255,
        B = (w >>> 16) & 255;
      r[R]++;
      g[G]++;
      b[B]++;
      // luma8, inlined.
      l[(13933 * R + 46871 * G + 4732 * B + 32768) >> 16]++;
    }
  } else
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      if (d[i + 3] === 0 || (sel && sel[p] < 128)) continue;
      const R = d[i],
        G = d[i + 1],
        B = d[i + 2];
      r[R]++;
      g[G]++;
      b[B]++;
      l[luma8(R, G, B)]++;
    }
  for (let v = 0; v < 256; v++) rgb[v] = r[v] + g[v] + b[v];
  return { r, g, b, luminosity: l, rgb };
}

export function histogram(src: RGBA8, channel: HistogramChannel = 'luminosity', selection?: Mask8): Uint32Array {
  if (channel === 'rgb' || channel === 'luminosity') return histograms(src, selection)[channel];
  const h = new Uint32Array(256);
  const off = channel === 'r' ? 0 : channel === 'g' ? 1 : 2;
  const d = src.data,
    sel = selection?.data,
    n = src.width * src.height;
  for (let p = 0; p < n; p++) if (counted(src, sel, p)) h[d[p * 4 + off]]++;
  return h;
}

// Mean, standard deviation (population), median (lowest level whose
// cumulative count reaches half) and pixel count. For the summed `rgb`
// histogram pass samplesPerPixel = 3 so `pixels` counts pixels.
export function stats(hist: ArrayLike<number>, samplesPerPixel = 1): HistogramStats {
  let total = 0,
    sum = 0,
    sq = 0;
  for (let v = 0; v < hist.length; v++) {
    const c = hist[v];
    total += c;
    sum += c * v;
    sq += c * v * v;
  }
  if (!total) return { mean: 0, stdDev: 0, median: 0, pixels: 0 };
  const mean = sum / total;
  let median = 0;
  for (let v = 0, acc = 0; v < hist.length; v++) {
    acc += hist[v];
    if (acc * 2 >= total) {
      median = v;
      break;
    }
  }
  return { mean, stdDev: Math.sqrt(Math.max(0, sq / total - mean * mean)), median, pixels: total / samplesPerPixel };
}

// Fraction of samples at or below `level` (Histogram panel percentile).
export function percentile(hist: ArrayLike<number>, level: number): number {
  let total = 0,
    below = 0;
  for (let v = 0; v < hist.length; v++) {
    total += hist[v];
    if (v <= level) below += hist[v];
  }
  return total ? below / total : 0;
}

// Lowest and highest levels after discarding `lowClip`/`highClip` percent of
// samples from each end.
export function clipRange(hist: ArrayLike<number>, lowClip: number, highClip: number): [number, number] {
  let total = 0;
  for (let v = 0; v < 256; v++) total += hist[v];
  if (!total) return [0, 255];
  const lowLimit = (total * Math.max(0, lowClip)) / 100,
    highLimit = (total * Math.max(0, highClip)) / 100;
  let lo = 0,
    acc = 0;
  for (; lo < 255; lo++) {
    acc += hist[lo];
    if (acc > lowLimit) break;
  }
  let hi = 255;
  acc = 0;
  for (; hi > 0; hi--) {
    acc += hist[hi];
    if (acc > highLimit) break;
  }
  return [lo, hi];
}

export type AutoMode = 'tone' | 'contrast' | 'color';
export type AutoOptions = { shadowClip?: number; highlightClip?: number; snapNeutral?: boolean; selection?: Mask8 };

const stretch = (lo: number, hi: number): LevelsChannel =>
  hi > lo ? { inBlack: lo, inWhite: hi, gamma: 1, outBlack: 0, outWhite: 255 } : { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };

// Levels settings for the three automatic corrections:
// - contrast: one black/white point from all channels together (keeps color);
// - tone: independent black/white points per channel;
// - color: per-channel points plus per-channel gammas that pull the average
//   midtone to neutral gray.
export function autoLevels(src: RGBA8, mode: AutoMode, opts: AutoOptions = {}): LevelsParams {
  const lowClip = opts.shadowClip ?? 0.1,
    highClip = opts.highlightClip ?? 0.1;
  const h = histograms(src, opts.selection);
  const params = defaultParams('levels');
  if (mode === 'contrast') {
    const [lo, hi] = clipRange(h.rgb, lowClip, highClip);
    params.rgb = stretch(lo, hi);
    return params;
  }
  for (const k of ['r', 'g', 'b'] as const) {
    const [lo, hi] = clipRange(h[k], lowClip, highClip);
    params[k] = stretch(lo, hi);
  }
  if (mode === 'color' && opts.snapNeutral !== false) {
    // Mean of each normalized channel over midtone pixels.
    const d = src.data,
      sel = opts.selection?.data,
      n = src.width * src.height;
    const ch = [params.r, params.g, params.b];
    const sums = [0, 0, 0];
    let count = 0;
    const t = [0, 0, 0];
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      if (d[i + 3] === 0 || (sel && sel[p] < 128)) continue;
      for (let k = 0; k < 3; k++) {
        const c = ch[k];
        t[k] = Math.min(1, Math.max(0, (d[i + k] - c.inBlack) / (c.inWhite - c.inBlack)));
      }
      const l = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
      if (l < 0.25 || l > 0.75) continue;
      sums[0] += t[0];
      sums[1] += t[1];
      sums[2] += t[2];
      count++;
    }
    if (count) {
      const means = sums.map((s) => Math.min(0.99, Math.max(0.01, s / count)));
      const target = (means[0] + means[1] + means[2]) / 3;
      // t^(1/gamma) = target  =>  gamma = ln(t) / ln(target).
      ch.forEach((c, k) => (c.gamma = Math.min(2, Math.max(0.5, Math.log(means[k]) / Math.log(target)))));
    }
  }
  return params;
}

// Histogram equalization map (one table for all channels so hues hold).
export function equalizeMap(hist: ArrayLike<number>): Uint8Array {
  const map = new Uint8Array(256);
  let total = 0;
  for (let v = 0; v < 256; v++) total += hist[v];
  let first = 0;
  while (first < 256 && !hist[first]) first++;
  if (first >= 256) {
    for (let v = 0; v < 256; v++) map[v] = v;
    return map;
  }
  const base = hist[first];
  const span = total - base;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    map[v] = span > 0 ? Math.round((Math.max(0, acc - base) / span) * 255) : v;
  }
  return map;
}
