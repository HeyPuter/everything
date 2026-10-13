// Skin Smoothing: skin detection plus edge-preserving frequency separation.
//
// Detection uses the elliptical skin-color cluster in the CbCr plane
// described by Hsu, Abdel-Mottaleb and Jain ("Face Detection in Color
// Images", IEEE PAMI 2002), made soft and widened by a tolerance, then keeps
// only sizeable connected regions (faces, necks, arms) at a working size and
// snaps the mask to image edges with a guided filter (He, Sun and Tang 2013).
//
// Smoothing splits the image into three bands: a base from a self-guided
// edge-preserving filter, a fine band (pores, fine texture) below a small
// Gaussian scale, and the mid band between them (blotches, uneven tone).
// The mid band is attenuated by Smoothness and the fine band kept by Detail,
// so skin looks even without the plastic look of a plain blur.
import { guidedFilterGray } from '../segment/filters';
import type { Mask8, RGBA8 } from '../types';
import { clamp, clamp255, fitSize, gaussian, labelComponents, lumaOf, maskToPlane, planeToMask, resizePlane, resizeRGBA, smoothstep, type Plane } from './util';

export type SkinOptions = {
  // 0..100: how far from the typical skin cluster colors still count.
  tolerance: number;
};

// Ellipse parameters of the skin cluster (published values for Cb, Cr offset by 128).
const CX = 109.38, CY = 152.02, THETA = 2.53, ECX = 1.6, ECY = 2.41, A = 25.39, B = 14.03;
const COS = Math.cos(THETA), SIN = Math.sin(THETA);

/** Per-pixel skin likelihood in [0, 1] from color alone. */
export function skinLikelihood(img: RGBA8, tolerance = 50): Plane {
  const n = img.width * img.height, d = img.data, out = new Float32Array(n);
  const grow = 0.75 + (tolerance / 100) * 0.9;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (d[j + 3] < 8) continue;
    const r = d[j], g = d[j + 1], b = d[j + 2];
    const Y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const x = COS * (cb - CX) + SIN * (cr - CY), y = -SIN * (cb - CX) + COS * (cr - CY);
    const e = Math.sqrt(((x - ECX) * (x - ECX)) / (A * A) + ((y - ECY) * (y - ECY)) / (B * B));
    let p = 1 - smoothstep(grow * 0.85, grow * 1.35, e);
    // Very dark and blown-out pixels carry no reliable color.
    p *= smoothstep(30, 65, Y) * (1 - smoothstep(245, 254, Y));
    // Skin is warm: red above green above blue (with slack for shadows).
    if (!(r > b && r >= g * 0.92)) p *= 0.25;
    // Hue: skin is about as red as it is yellow; beige and khaki surfaces lean yellow.
    const yellow = 128 - cb, red = cr - 128;
    if (yellow > 2) p *= smoothstep(0.72 - tolerance / 500, 0.92 - tolerance / 500, red / yellow);
    out[i] = p;
  }
  return out;
}

/** Soft skin mask: likely skin colors in sizeable regions, aligned to edges.
 * Computed at a working size so previews and full renders agree. */
export function skinMask(img: RGBA8, o: SkinOptions): Mask8 {
  const { width: W, height: H } = img;
  const [w, h] = fitSize(W, H, 360);
  const small = resizeRGBA(img, w, h);
  const p = skinLikelihood(small, o.tolerance);
  // Regions: keep connected areas above a size threshold (drops skin-colored
  // specks in backgrounds); a region's score is its mean likelihood.
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = p[i] > 0.35 ? 1 : 0;
  const { labels, sizes, boxes } = labelComponents(bin, w, h);
  const minArea = Math.max(6, w * h * 0.0015);
  // Regions spanning the frame from side to side are walls, floors or
  // ground rather than people.
  const weight = sizes.map((s, k) => {
    if (s < minArea) return 0.15;
    const [x0, , x1] = boxes[k];
    return x0 <= 1 && x1 >= w - 2 ? 0.3 : 1;
  });
  const region = new Float32Array(w * h);
  for (let i = 0; i < region.length; i++) {
    const l = labels[i];
    region[i] = p[i] * (l >= 0 ? weight[l] : 0.15);
  }
  // Fill small holes (pores, specular highlights) but not eyes or mouths.
  const closed = gaussian(region, w, h, Math.max(0.8, Math.min(w, h) * 0.004));
  for (let i = 0; i < region.length; i++) region[i] = Math.max(region[i], Math.min(1, closed[i] * 1.15) * (closed[i] > 0.6 ? 1 : 0));
  const I = lumaOf(small);
  for (let i = 0; i < I.length; i++) I[i] /= 255;
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.012));
  const refined = guidedFilterGray(I, region, w, h, r, 2e-3);
  const up = resizePlane(refined, w, h, W, H);
  for (let i = 0; i < up.length; i++) up[i] = clamp((up[i] - 0.12) * 1.35, 0, 1);
  // Transparent pixels are never skin.
  for (let i = 0; i < up.length; i++) if (img.data[i * 4 + 3] === 0) up[i] = 0;
  return planeToMask(up, W, H);
}

/** Typical size of the skin areas in pixels of `img` (square root of the
 * largest region), used to scale the smoothing radius to faces, not frames. */
export function skinScale(mask: Mask8): number {
  const { width: W, height: H } = mask;
  const [w, h] = fitSize(W, H, 200);
  const small = resizePlane(maskToPlane(mask), W, H, w, h);
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = small[i] > 0.5 ? 1 : 0;
  const { sizes } = labelComponents(bin, w, h);
  const big = sizes.length ? Math.max(...sizes) : 0;
  const k = W / w;
  // Without skin, fall back to a tenth of the image's shorter side.
  return big > 4 ? Math.sqrt(big) * k : Math.min(W, H) * 0.1;
}

export type SmoothOptions = {
  // 0..100: removal of blotches and uneven tone (mid frequencies).
  smoothness: number;
  // 0..100: how much fine texture (pores) is kept.
  detail: number;
  // 0..100: evening out of color blotches (redness, patchy tone).
  tone: number;
  // Size of the skin areas in pixels (sets the band split).
  scale: number;
};

/** Frequency-separation smoothing of the whole image (mix by a mask after). */
export function smoothSkin(img: RGBA8, o: SmoothOptions): RGBA8 {
  const { width: w, height: h, data: d } = img, n = w * h;
  const s = o.smoothness / 100, keep = o.detail / 100, tone = o.tone / 100;
  // Base radius: a fraction of the face size; fine band: pores and fine lines.
  const r = Math.max(1, Math.round(o.scale * (0.02 + 0.05 * s)));
  const sigmaF = Math.max(0.6, o.scale * 0.006);
  const eps = (0.02 + 0.08 * s) ** 2;
  const Y = lumaOf(img);
  for (let i = 0; i < n; i++) Y[i] /= 255;
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(d.length) };
  const toneBase = tone > 0 ? Math.max(1, Math.round(r * 1.5)) : 0;
  const bands: Plane[] = [];
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = d[i * 4 + c] / 255;
    // Base guided by luma, so edges of features (eyes, lips, hairline) stay.
    const base = guidedFilterGray(Y, ch, w, h, r, eps);
    const lowF = gaussian(ch, w, h, sigmaF);
    const res = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const fine = ch[i] - lowF[i], mid = lowF[i] - base[i];
      res[i] = base[i] + mid * (1 - s) + fine * keep;
    }
    bands.push(res);
  }
  if (toneBase) {
    // Tone: pull each pixel's chroma toward its smoothed neighborhood chroma
    // while keeping its own luminance.
    const Ys = new Float32Array(n);
    for (let i = 0; i < n; i++) Ys[i] = 0.299 * bands[0][i] + 0.587 * bands[1][i] + 0.114 * bands[2][i];
    const cb = new Float32Array(n), cr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      cb[i] = bands[2][i] - Ys[i];
      cr[i] = bands[0][i] - Ys[i];
    }
    const cbS = guidedFilterGray(Y, cb, w, h, toneBase, 0.01), crS = guidedFilterGray(Y, cr, w, h, toneBase, 0.01);
    for (let i = 0; i < n; i++) {
      const nb = cb[i] + (cbS[i] - cb[i]) * tone, nr = cr[i] + (crS[i] - cr[i]) * tone;
      // Recover R, G, B from luma and the two differences (Rec. 601 weights).
      const R = Ys[i] + nr, B = Ys[i] + nb, G = (Ys[i] - 0.299 * R - 0.114 * B) / 0.587;
      bands[0][i] = R;
      bands[1][i] = G;
      bands[2][i] = B;
    }
  }
  const o8 = out.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    o8[j] = clamp255(bands[0][i] * 255);
    o8[j + 1] = clamp255(bands[1][i] * 255);
    o8[j + 2] = clamp255(bands[2][i] * 255);
    o8[j + 3] = d[j + 3];
  }
  return out;
}

/** Local roughness: mean absolute high-pass of luma (a skin texture measure for tests). */
export function roughness(img: RGBA8, mask?: Mask8): number {
  const { width: w, height: h } = img;
  const Y = lumaOf(img), low = gaussian(Y, w, h, 2);
  let s = 0, c = 0;
  for (let i = 0; i < Y.length; i++) {
    const k = mask ? mask.data[i] / 255 : 1;
    s += Math.abs(Y[i] - low[i]) * k;
    c += k;
  }
  return c ? s / c : 0;
}
