// Soft proofing and gamut warnings. The proof transform simulates a print
// condition on the display: document -> proof device (with the chosen intent)
// -> display. "Simulate paper color" renders the proof device ICC-absolute
// (paper white and real black ink); "simulate black ink" keeps relative
// colorimetry but disables black point compensation so the print's black
// shows as the dark gray it is. Both bake into one 3D LUT for the compositor.
import type { Mask8, RGBA8 } from '../imaging/types';
import { mask8 } from '../imaging/types';
import { deltaE2000 } from './delta-e';
import { decodeLab } from './color-math';
import type { Intent, Profile } from './icc-lut';
import { builtinProfile } from './builtin-profiles';
import { bakeLut3D, chainTransforms, createTransform, type ColorTransform, type Lut3D } from './transform';

export type ProofOptions = {
  intent?: Intent;
  simulatePaper?: boolean;
  simulateBlackInk?: boolean;
  bpc?: boolean;
  lutSize?: number;
};

export function createProofTransform(
  docProfile: Profile,
  proofProfile: Profile,
  displayProfile: Profile,
  opts: ProofOptions = {},
): { transform: ColorTransform; lut: Lut3D } {
  const intent = opts.intent ?? 'relative';
  const toProof = createTransform(docProfile, proofProfile, intent, { bpc: opts.bpc ?? true });
  const paper = !!opts.simulatePaper;
  const ink = paper || !!opts.simulateBlackInk;
  const toDisplay = createTransform(proofProfile, displayProfile, paper ? 'absolute' : 'relative', { bpc: !ink });
  const transform = chainTransforms(toProof, toDisplay);
  return { transform, lut: bakeLut3D(transform, opts.lutSize ?? 33) };
}

const errorCache = new Map<string, Lut3D>();

// Round-trip error of each document color through the proof device, baked
// as a 3D LUT of CIEDE2000 values (channel 0). With black point compensation
// the round trip is document -> device -> document, both compensated, as
// conversions with that setting do: colors they produce pass, and blacks the
// device prints as its own black are not flagged.
export function gamutErrorLut(docProfile: Profile, proofProfile: Profile, size = 33, bpc = false): Lut3D {
  const key = `${docProfile.key}>${proofProfile.key}|${size}|${bpc}`;
  const hit = errorCache.get(key);
  if (hit) return hit;
  const lab = builtinProfile('lab-d50');
  const direct = createTransform(docProfile, lab, 'relative');
  const viaProof = bpc
    ? chainTransforms(
        createTransform(docProfile, proofProfile, 'relative', { bpc: true }),
        createTransform(proofProfile, docProfile, 'relative', { bpc: true }),
        direct,
      )
    : chainTransforms(createTransform(docProfile, proofProfile, 'relative'), createTransform(proofProfile, lab, 'relative'));
  const n = size,
    total = n * n * n;
  const input = new Float32Array(total * 3);
  for (let b = 0, i = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++, i += 3) {
        input[i] = r / (n - 1);
        input[i + 1] = g / (n - 1);
        input[i + 2] = b / (n - 1);
      }
  const a = new Float32Array(total * 3),
    p = new Float32Array(total * 3);
  direct.apply(input, a, total);
  viaProof.apply(input, p, total);
  const data = new Float32Array(total * 4);
  const la = [0, 0, 0],
    lp = [0, 0, 0];
  for (let i = 0; i < total; i++) {
    decodeLab(a.subarray(i * 3, i * 3 + 3), 'v4', la);
    decodeLab(p.subarray(i * 3, i * 3 + 3), 'v4', lp);
    data[i * 4] = deltaE2000(la, lp);
  }
  const lut = { size: n, outChannels: 1, data };
  errorCache.set(key, lut);
  if (errorCache.size > 8) errorCache.delete(errorCache.keys().next().value!);
  return lut;
}

// 255 where a pixel's color would move by more than `threshold` (CIEDE2000)
// when printed on the proof device with relative colorimetric rendering
// (with or without black point compensation). Fully transparent pixels are
// never flagged.
export function gamutWarning(img: RGBA8, docProfile: Profile, proofProfile: Profile, threshold = 2, bpc = false): Mask8 {
  const lut = gamutErrorLut(docProfile, proofProfile, 33, bpc);
  const out = mask8(img.width, img.height);
  const n = lut.size,
    d = lut.data,
    m = n - 1;
  const idx = new Int32Array(256),
    fr = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const p = (v * m) / 255,
      i = Math.min(Math.floor(p), m - 1);
    idx[v] = i;
    fr[v] = p - i;
  }
  const sr = 4,
    sg = 4 * n,
    sb = 4 * n * n;
  const src = img.data;
  for (let p = 0, i = 0; p < out.data.length; p++, i += 4) {
    if (src[i + 3] === 0) continue;
    const r = src[i],
      g = src[i + 1],
      b = src[i + 2];
    const base = idx[r] * sr + idx[g] * sg + idx[b] * sb;
    const x = fr[r],
      y = fr[g],
      z = fr[b];
    // Trilinear on channel 0 only (cheaper than full tetrahedral for one value).
    const c00 = d[base] + (d[base + sr] - d[base]) * x,
      c10 = d[base + sg] + (d[base + sg + sr] - d[base + sg]) * x,
      c01 = d[base + sb] + (d[base + sb + sr] - d[base + sb]) * x,
      c11 = d[base + sb + sg] + (d[base + sb + sg + sr] - d[base + sb + sg]) * x;
    const c0 = c00 + (c10 - c00) * y,
      c1 = c01 + (c11 - c01) * y;
    if (c0 + (c1 - c0) * z > threshold) out.data[p] = 255;
  }
  return out;
}
