// Develop automatic settings, from a (reduced) copy of the source:
// - white balance from a picked color (the eyedropper) by inverting the
//   temperature/tint gain model, and Auto white balance from the average of
//   the image's least colorful pixels (gray world on likely neutrals);
// - Auto tone from the luminance histogram: exposure brings the median
//   toward middle tone, whites and blacks stretch the ends to the 0.3% / 99.7%
//   points, highlights and shadows recover crowded ends, contrast evens out a
//   flat or harsh spread.
import type { RGBA8 } from '../../types';
import { SRGB_TO_LINEAR } from '../sampling';
import { KB, KG, KR } from './color';
import { PERCEPTUAL } from './tone';

/** Channel gains of the white balance model (temperature, tint in -100..100),
 * normalized to keep luminance. */
export function wbGains(temperature: number, tint: number): [number, number, number] {
  const t = temperature / 100,
    u = tint / 100;
  const gr = Math.pow(2, 0.6 * t + 0.25 * u),
    gg = Math.pow(2, -0.5 * u),
    gb = Math.pow(2, -0.6 * t + 0.25 * u);
  const l = KR * gr + KG * gg + KB * gb;
  return [gr / l, gg / l, gb / l];
}

const clampS = (v: number) => Math.round(Math.max(-100, Math.min(100, v)));
/** Temperature and tint that make the linear color (r, g, b) neutral. */
export function whiteBalanceFor(
  r: number,
  g: number,
  b: number,
): { temperature: number; tint: number } {
  const e = 1e-4;
  const lr = Math.log2(Math.max(e, r)),
    lg = Math.log2(Math.max(e, g)),
    lb = Math.log2(Math.max(e, b));
  const T = (lb - lr) / 1.2,
    U = (lg - lr - 0.6 * T) / 0.75;
  return { temperature: clampS(100 * T), tint: clampS(100 * U) };
}
/** Mean linear color of the (2r+1)² pixels around (x, y), ignoring transparent ones. */
export function sampleLinear(
  img: RGBA8,
  x: number,
  y: number,
  r = 2,
): [number, number, number] | undefined {
  let sr = 0,
    sg = 0,
    sb = 0,
    n = 0;
  for (
    let j = Math.max(0, Math.round(y) - r);
    j <= Math.min(img.height - 1, Math.round(y) + r);
    j++
  )
    for (
      let i = Math.max(0, Math.round(x) - r);
      i <= Math.min(img.width - 1, Math.round(x) + r);
      i++
    ) {
      const k = (j * img.width + i) * 4;
      if (img.data[k + 3] < 128) continue;
      sr += SRGB_TO_LINEAR[img.data[k]];
      sg += SRGB_TO_LINEAR[img.data[k + 1]];
      sb += SRGB_TO_LINEAR[img.data[k + 2]];
      n++;
    }
  return n ? [sr / n, sg / n, sb / n] : undefined;
}

// Up to ~64k pixels on a regular grid.
function samples(img: RGBA8): number[] {
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 65536)));
  const out: number[] = [];
  for (let y = 0; y < img.height; y += step)
    for (let x = 0; x < img.width; x += step) {
      const k = (y * img.width + x) * 4;
      if (img.data[k + 3] >= 128) out.push(k);
    }
  return out;
}

/** Auto white balance: neutralize the average of the less colorful half of
 * the mid-tone pixels. */
export function autoWhiteBalance(img: RGBA8): { temperature: number; tint: number } {
  const d = img.data;
  const px: { r: number; g: number; b: number; c: number }[] = [];
  for (const k of samples(img)) {
    const r = SRGB_TO_LINEAR[d[k]],
      g = SRGB_TO_LINEAR[d[k + 1]],
      b = SRGB_TO_LINEAR[d[k + 2]];
    const Y = KR * r + KG * g + KB * b;
    if (Y < 0.02 || Math.max(r, g, b) > 0.97) continue;
    px.push({
      r,
      g,
      b,
      c: (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1e-6, Math.max(r, g, b)),
    });
  }
  if (px.length < 16) return { temperature: 0, tint: 0 };
  px.sort((a, b) => a.c - b.c);
  const half = px.slice(0, Math.max(16, px.length >> 1));
  let r = 0,
    g = 0,
    b = 0;
  for (const q of half) {
    r += q.r;
    g += q.g;
    b += q.b;
  }
  return whiteBalanceFor(r, g, b);
}

export type ToneSettings = {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
};

/** Auto tone for an image after white balance `gains`. */
export function autoTone(img: RGBA8, gains: [number, number, number] = [1, 1, 1]): ToneSettings {
  const d = img.data;
  const lum: number[] = [];
  for (const k of samples(img)) {
    const Y =
      KR * SRGB_TO_LINEAR[d[k]] * gains[0] +
      KG * SRGB_TO_LINEAR[d[k + 1]] * gains[1] +
      KB * SRGB_TO_LINEAR[d[k + 2]] * gains[2];
    lum.push(Y);
  }
  const zero: ToneSettings = {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
  };
  if (lum.length < 16) return zero;
  lum.sort((a, b) => a - b);
  const q = (f: number) =>
    lum[Math.min(lum.length - 1, Math.max(0, Math.round(f * (lum.length - 1))))];
  // Exposure: median toward a middle tone, damped and limited.
  const median = Math.max(1e-4, q(0.5)),
    target = 0.2;
  let exposure = Math.log2(target / median) * 0.75;
  exposure = Math.max(-2.5, Math.min(2.5, exposure));
  if (Math.abs(exposure) < 0.15) exposure = 0;
  const ev = Math.pow(2, exposure);
  // Perceptual values after exposure.
  const P = (Y: number) => Math.pow(Math.min(1, Y * ev), PERCEPTUAL);
  const lo = P(q(0.003)),
    hi = P(q(0.997)),
    p10 = P(q(0.1)),
    p90 = P(q(0.9));
  let mean = 0,
    sq = 0;
  for (const Y of lum) {
    const v = P(Y);
    mean += v;
    sq += v * v;
  }
  mean /= lum.length;
  const sd = Math.sqrt(Math.max(0, sq / lum.length - mean * mean));
  const whites = hi < 0.97 ? Math.min(60, (0.97 - hi) * 180) : 0;
  const blacks = lo > 0.04 ? -Math.min(60, (lo - 0.04) * 220) : 0;
  // Crowded ends: many pixels near white or black.
  const highlights = p90 > 0.86 ? -Math.min(70, (p90 - 0.86) * 450) : 0;
  const shadows = p10 < 0.12 ? Math.min(60, (0.12 - p10) * 400) : 0;
  const contrast = Math.max(-40, Math.min(40, (0.22 - sd) * 160));
  const r = (v: number) => Math.round(v);
  return {
    exposure: Math.round(exposure * 20) / 20,
    contrast: r(contrast),
    highlights: r(highlights),
    shadows: r(shadows),
    whites: r(whites),
    blacks: r(blacks),
  };
}
