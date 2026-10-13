// Colorize: hint colors spread over the image along regions of similar
// luminance and stop at strong edges, keeping the original luminance.
//
// This is the formulation of Levin, Lischinski and Weiss, "Colorization using
// Optimization" (SIGGRAPH 2004): each pixel's chroma should equal a weighted
// average of its neighbors' chroma, with weights that fall off with the
// luminance difference relative to the local variance; hint pixels are fixed.
// Two additions make it practical in an editor:
// - the chroma is solved together with a confidence (normalized convolution),
//   and a small leak toward "no color" lets the influence of a hint fade
//   across strong edges instead of eventually filling the whole image;
//   pixels without confidence keep their original color, and colors are
//   shown at full strength wherever the confidence is clearly above zero;
// - the system is solved coarse to fine (Gauss-Seidel sweeps on a pyramid,
//   each level starting from the upsampled coarser solution), at a working
//   size, and the result is upsampled with a luminance-guided filter.
// With an AI color suggestion, the suggestion replaces "no color" as the
// prior, so hints refine it locally.
import { guidedFilterGray } from '../segment/filters';
import type { Mask8, RGBA8 } from '../types';
import { clamp, fitSize, labToRgb8Fit, resizePlane, resizeRGBA, rgb8ToLab, type Plane } from './util';

export type Hint = { x: number; y: number; color: string; radius: number };
export type ColorizeOptions = {
  hints: Hint[];
  // 0..200: chroma multiplier in percent.
  saturation: number;
  // 0..100: how far colors travel through areas of similar tone.
  spread: number;
  // Pixels of `img` per document pixel (hint radii are in document pixels).
  scale: number;
  // Optional color suggestion (same size as `img`) used where no hint reaches.
  prior?: RGBA8;
  workSize?: number;
};

export function hexLab(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0x808080;
  const out = [0, 0, 0];
  rgb8ToLab((v >> 16) & 255, (v >> 8) & 255, v & 255, out);
  return out as [number, number, number];
}

type Level = { w: number; h: number; L: Plane; wts: Float32Array; sum: Float32Array };
const NB = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

function makeLevel(L: Plane, w: number, h: number): Level {
  const n = w * h, wts = new Float32Array(n * 8), sum = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, v = L[i];
      // Local variance over the 3x3 window sets the falloff (with a floor).
      let m = 0, m2 = 0, c = 0;
      for (const [dx, dy] of NB) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const u = L[yy * w + xx];
        m += u;
        m2 += u * u;
        c++;
      }
      m = (m + v) / (c + 1);
      // The cap keeps a large step (a strong edge) from widening its own
      // falloff: windows straddling it have a huge variance.
      const variance = Math.min(60, Math.max(4, ((m2 + v * v) / (c + 1) - m * m) * 0.6));
      const inv = 1 / (2 * variance);
      let s = 0;
      for (let k = 0; k < 8; k++) {
        const xx = x + NB[k][0], yy = y + NB[k][1];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const d = L[yy * w + xx] - v, wt = Math.exp(-d * d * inv) * (k === 1 || k === 3 || k === 4 || k === 6 ? 1 : 0.7);
        wts[i * 8 + k] = wt;
        s += wt;
      }
      sum[i] = s;
    }
  return { w, h, L, wts, sum };
}

/** Solve for chroma times confidence (Na, Nb) and confidence C. */
function solve(levels: Level[], fixed: (lv: number) => { mask: Uint8Array; a: Plane; b: Plane }, prior: (lv: number) => { a: Plane; b: Plane; c: number } | null, leak: number) {
  let Na: Plane | null = null, Nb: Plane | null = null, C: Plane | null = null;
  for (let lv = levels.length - 1; lv >= 0; lv--) {
    const { w, h, wts, sum } = levels[lv], n = w * h;
    const f = fixed(lv), pr = prior(lv);
    // Same physical decay length at every level: a coarse pixel spans more.
    const lam = leak * 4 ** lv;
    if (!Na) {
      Na = new Float32Array(n);
      Nb = new Float32Array(n);
      C = new Float32Array(n);
      if (pr) for (let i = 0; i < n; i++) (Na[i] = pr.a[i] * pr.c), (Nb[i] = pr.b[i] * pr.c), (C[i] = pr.c);
    } else {
      const pw = levels[lv + 1].w, ph = levels[lv + 1].h;
      Na = resizePlane(Na, pw, ph, w, h);
      Nb = resizePlane(Nb!, pw, ph, w, h);
      C = resizePlane(C!, pw, ph, w, h);
    }
    for (let i = 0; i < n; i++)
      if (f.mask[i]) {
        Na[i] = f.a[i];
        Nb![i] = f.b[i];
        C![i] = 1;
      }
    const iters = lv === levels.length - 1 ? 300 : 40;
    const pa = pr?.a, pb = pr?.b, pc = pr ? pr.c : 0;
    for (let it = 0; it < iters; it++) {
      // Alternate sweep directions so information travels both ways.
      const fwd = (it & 1) === 0;
      for (let k = 0; k < n; k++) {
        const i = fwd ? k : n - 1 - k;
        if (f.mask[i]) continue;
        const x = i % w, y = (i - x) / w;
        let sa = 0, sb = 0, sc = 0;
        for (let j = 0; j < 8; j++) {
          const wt = wts[i * 8 + j];
          if (!wt) continue;
          const q = (y + NB[j][1]) * w + x + NB[j][0];
          sa += wt * Na[q];
          sb += wt * Nb![q];
          sc += wt * C![q];
        }
        const den = 1 / (sum[i] + lam);
        Na[i] = (sa + lam * (pa ? pa[i] * pc : 0)) * den;
        Nb![i] = (sb + lam * (pb ? pb[i] * pc : 0)) * den;
        C![i] = (sc + lam * pc) * den;
      }
    }
  }
  return { Na: Na!, Nb: Nb!, C: C! };
}

/** Lab planes of an image. */
function labPlanes(img: RGBA8): [Plane, Plane, Plane] {
  const n = img.width * img.height, d = img.data;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), lab = [0, 0, 0];
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    rgb8ToLab(d[j], d[j + 1], d[j + 2], lab);
    L[i] = lab[0];
    A[i] = lab[1];
    B[i] = lab[2];
  }
  return [L, A, B];
}

export type ColorizeResult = { image: RGBA8; confidence: Mask8 };

/** Colorize `img` from hints (and an optional color suggestion). */
export function colorize(img: RGBA8, o: ColorizeOptions): ColorizeResult {
  const { width: W, height: H } = img;
  const sat = clamp(o.saturation / 100, 0, 2);
  const conf: Mask8 = { width: W, height: H, data: new Uint8Array(W * H) };
  if (!o.hints.length && !o.prior) return { image: { width: W, height: H, data: new Uint8ClampedArray(img.data) }, confidence: conf };
  const [w, h] = fitSize(W, H, o.workSize ?? 420);
  const small = resizeRGBA(img, w, h);
  const [L0] = labPlanes(small);
  const levels: Level[] = [makeLevel(L0, w, h)];
  while (Math.max(levels[levels.length - 1].w, levels[levels.length - 1].h) > 40) {
    const p = levels[levels.length - 1], nw = Math.max(1, Math.ceil(p.w / 2)), nh = Math.max(1, Math.ceil(p.h / 2));
    levels.push(makeLevel(resizePlane(p.L, p.w, p.h, nw, nh), nw, nh));
  }
  // Hint radii in document pixels, converted to working pixels.
  const docSide = Math.max(W, H) / Math.max(1e-6, o.scale);
  const hints = o.hints.map((hnt) => ({ ...hnt, lab: hexLab(hnt.color) }));
  const fixed = (lv: number) => {
    const { w: lw, h: lh } = levels[lv], n = lw * lh;
    const mask = new Uint8Array(n), a = new Float32Array(n), b = new Float32Array(n);
    for (const hnt of hints) {
      const r = Math.max(0.75, (hnt.radius * Math.max(lw, lh)) / docSide);
      const cx = hnt.x * lw, cy = hnt.y * lh;
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(lh - 1, Math.ceil(cy + r)); y++)
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(lw - 1, Math.ceil(cx + r)); x++) {
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
          const i = y * lw + x;
          mask[i] = 1;
          a[i] = hnt.lab[1];
          b[i] = hnt.lab[2];
        }
      // A hint always fixes at least the pixel it sits on.
      const i = Math.min(lh - 1, Math.floor(cy)) * lw + Math.min(lw - 1, Math.floor(cx));
      mask[i] = 1;
      a[i] = hnt.lab[1];
      b[i] = hnt.lab[2];
    }
    return { mask, a, b };
  };
  let priorAB: [Plane, Plane] | null = null;
  if (o.prior) {
    const [, pa, pb] = labPlanes(resizeRGBA(o.prior, w, h));
    priorAB = [pa, pb];
  }
  const prior = (lv: number) => {
    if (!priorAB) return null;
    const { w: lw, h: lh } = levels[lv];
    return { a: resizePlane(priorAB[0], w, h, lw, lh), b: resizePlane(priorAB[1], w, h, lw, lh), c: 1 };
  };
  // Spread 0..100 maps to a leak from strong (short reach) to tiny (long reach).
  const leak = 10 ** (-0.6 - 3.2 * clamp(o.spread / 100, 0, 1));
  const { Na, Nb, C } = solve(levels, fixed, prior, leak);
  // Upsample, then align to the full-resolution luminance with a guided filter.
  const [Lf, Af, Bf] = labPlanes(img);
  const up = (p: Plane) => resizePlane(p, w, h, W, H);
  const k = Math.max(1, W / w);
  const r = Math.max(1, Math.round(k * 1.5));
  const guide = new Float32Array(Lf.length);
  for (let i = 0; i < guide.length; i++) guide[i] = Lf[i] / 100;
  const ga = k > 1.2 ? guidedFilterGray(guide, up(Na), W, H, r, 1e-3) : up(Na);
  const gb = k > 1.2 ? guidedFilterGray(guide, up(Nb), W, H, r, 1e-3) : up(Nb);
  const gc = k > 1.2 ? guidedFilterGray(guide, up(C), W, H, r, 1e-3) : up(C);
  const out: RGBA8 = { width: W, height: H, data: new Uint8ClampedArray(img.data.length) };
  const rgb = [0, 0, 0];
  for (let i = 0, j = 0; i < Lf.length; i++, j += 4) {
    // Confidence falls off slowly inside a region (a point source in 2D) and
    // by orders of magnitude across a strong edge, so a low threshold gives
    // full color within regions and a clean stop at their boundaries.
    const cv = Math.max(1e-5, gc[i]), c = clamp(cv / 0.12, 0, 1);
    const a = sat * (ga[i] / cv) * c + (1 - c) * Af[i], b = sat * (gb[i] / cv) * c + (1 - c) * Bf[i];
    labToRgb8Fit(Lf[i], a, b, rgb);
    out.data[j] = rgb[0];
    out.data[j + 1] = rgb[1];
    out.data[j + 2] = rgb[2];
    out.data[j + 3] = img.data[j + 3];
    conf.data[i] = Math.round(c * 255);
  }
  return { image: out, confidence: conf };
}
