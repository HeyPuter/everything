// Sky replacement building blocks: procedurally generated skies (vertical
// gradients with layered noise clouds and an optional sun glow), placement
// of a sky image over the canvas, sky color adjustments and the mask edge
// controls. All pure and deterministic.
import { mask8, rgba8, type Mask8, type RGBA8 } from '../types';
import { contract, expand } from '../segment/mask-ops';
import { gaussianPlane } from '../filters/common';
import { resize } from '../filters/resample';

type RGB = [number, number, number];
export type SkyPreset = {
  id: string;
  label: string;
  // Gradient from the top of the sky to the horizon.
  zenith: RGB;
  horizon: RGB;
  // Cloud cover 0..1, softness, base color and shading.
  clouds: number;
  cloudScale: number;
  cloudLight: RGB;
  cloudShade: RGB;
  // Optional sun glow position (fractions of the sky image) and color.
  sun?: { x: number; y: number; color: RGB; size: number };
};

export const SKY_PRESETS: SkyPreset[] = [
  { id: 'clear', label: 'Clear Blue', zenith: [38, 92, 178], horizon: [170, 205, 235], clouds: 0.05, cloudScale: 1, cloudLight: [255, 255, 255], cloudShade: [200, 210, 225] },
  { id: 'fair', label: 'Fair Weather Clouds', zenith: [52, 110, 190], horizon: [180, 210, 236], clouds: 0.42, cloudScale: 1.1, cloudLight: [255, 255, 255], cloudShade: [168, 180, 202] },
  { id: 'scattered', label: 'Scattered Clouds', zenith: [44, 104, 196], horizon: [190, 216, 240], clouds: 0.3, cloudScale: 0.45, cloudLight: [250, 252, 255], cloudShade: [205, 214, 232] },
  { id: 'sunset', label: 'Warm Sunset', zenith: [62, 70, 140], horizon: [252, 168, 92], clouds: 0.35, cloudScale: 0.9, cloudLight: [255, 196, 150], cloudShade: [120, 80, 110], sun: { x: 0.62, y: 0.92, color: [255, 214, 140], size: 0.35 } },
  { id: 'dusk', label: 'Blue Hour', zenith: [18, 28, 70], horizon: [120, 120, 170], clouds: 0.2, cloudScale: 0.8, cloudLight: [150, 140, 190], cloudShade: [50, 50, 90] },
  { id: 'storm', label: 'Dramatic Storm', zenith: [52, 60, 72], horizon: [150, 158, 166], clouds: 0.72, cloudScale: 1.6, cloudLight: [176, 182, 192], cloudShade: [44, 50, 62] },
  { id: 'overcast', label: 'Soft Overcast', zenith: [150, 158, 170], horizon: [214, 218, 222], clouds: 0.62, cloudScale: 2, cloudLight: [236, 238, 242], cloudShade: [168, 174, 184] },
];

// Hash-based gradient noise (2D), deterministic for a seed.
function hash(x: number, y: number, seed: number) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function gradNoise(x: number, y: number, seed: number) {
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const fx = x - x0,
    fy = y - y0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10),
    v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const g = (ix: number, iy: number, dx: number, dy: number) => {
    const a = hash(ix, iy, seed) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dy;
  };
  const n00 = g(x0, y0, fx, fy),
    n10 = g(x0 + 1, y0, fx - 1, fy),
    n01 = g(x0, y0 + 1, fx, fy - 1),
    n11 = g(x0 + 1, y0 + 1, fx - 1, fy - 1);
  return (n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v;
}
function fbm(x: number, y: number, seed: number, octaves = 5) {
  let s = 0,
    a = 0.5,
    f = 1;
  for (let o = 0; o < octaves; o++) {
    s += a * gradNoise(x * f, y * f, seed + o * 17);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Render a sky preset at the given size. Clouds flatten toward the horizon
 * (perspective) and are lit from above. */
export function renderSky(preset: SkyPreset, width: number, height: number, seed = 1): RGBA8 {
  // Render at most ~1.2 MP and upscale: clouds are soft, the result is smooth.
  const k = Math.min(1, Math.sqrt(1_200_000 / (width * height)));
  const w = Math.max(1, Math.round(width * k)),
    h = Math.max(1, Math.round(height * k));
  const img = rgba8(w, h);
  const d = img.data;
  const base = 3 / preset.cloudScale;
  const aspect = w / h;
  for (let y = 0; y < h; y++) {
    const t = y / Math.max(1, h - 1);
    // Clouds lie on a plane above the viewer: toward the horizon they get
    // smaller and flatter.
    const persp = 1 / (0.2 + 0.8 * (1 - t));
    const gy = Math.pow(t, 1.4);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const sx = (x / w) * base * aspect * 0.7 * Math.sqrt(persp),
        sy = t * base * persp;
      let r = mix(preset.zenith[0], preset.horizon[0], gy),
        g = mix(preset.zenith[1], preset.horizon[1], gy),
        b = mix(preset.zenith[2], preset.horizon[2], gy);
      if (preset.sun) {
        const dx = (x / w - preset.sun.x) * aspect,
          dy = y / h - preset.sun.y;
        const glow = Math.exp(-(dx * dx + dy * dy) / (preset.sun.size * preset.sun.size));
        r = mix(r, preset.sun.color[0], glow);
        g = mix(g, preset.sun.color[1], glow);
        b = mix(b, preset.sun.color[2], glow);
      }
      if (preset.clouds > 0.01) {
        // Gently domain-warped noise gives billowy, rounded shapes.
        const wx = fbm(sx + 3.1, sy + 7.3, seed + 101, 3),
          wy = fbm(sx - 1.7, sy + 4.2, seed + 211, 3);
        const density = (px: number, py: number) => 0.5 + 1.4 * fbm(px + 0.35 * wx, py + 0.35 * wy, seed, 5);
        const n = density(sx, sy);
        const lo = 1 - preset.clouds - 0.12;
        const cover = smooth(lo, lo + 0.32, n);
        if (cover > 0) {
          // Lit from above: brighter where density falls off upward.
          const above = density(sx, sy - 0.06);
          const light = Math.max(0, Math.min(1, 0.72 + (n - above) * 3 * (1.15 - preset.clouds) - 0.3 * smooth(lo + 0.2, lo + 0.6, n)));
          const cr = mix(preset.cloudShade[0], preset.cloudLight[0], light),
            cg = mix(preset.cloudShade[1], preset.cloudLight[1], light),
            cb = mix(preset.cloudShade[2], preset.cloudLight[2], light);
          r = mix(r, cr, cover);
          g = mix(g, cg, cover);
          b = mix(b, cb, cover);
        }
      }
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
      d[o + 3] = 255;
    }
  }
  return w === width && h === height ? img : resize(img, width, height, 'bilinear');
}

export type SkyPlacement = { scale: number; flip: boolean; offsetX: number; offsetY: number };

/** Cover a canvas with a sky image: scaled to the canvas width (times
 * `scale`), aligned to the top, shifted by offsets (fractions of the canvas),
 * optionally mirrored. Areas the sky does not reach repeat its edge. */
export function placeSky(sky: RGBA8, width: number, height: number, p: SkyPlacement, horizon = height): RGBA8 {
  const out = rgba8(width, height);
  // The sky must at least reach down to the horizon.
  const s = Math.max(width / sky.width, Math.max(1, horizon) / sky.height) * Math.max(0.1, p.scale);
  const sw = sky.width * s;
  const ox = (width - sw) / 2 + p.offsetX * width,
    oy = p.offsetY * height;
  const d = out.data,
    sd = sky.data;
  for (let y = 0; y < height; y++) {
    let v = (y - oy) / s;
    v = Math.max(0, Math.min(sky.height - 1, v));
    // Neighbors repeat the last row and column (also for 1-pixel skies).
    const iy = Math.min(Math.floor(v), Math.max(0, sky.height - 2)),
      fy = v - iy,
      iy1 = Math.min(iy + 1, sky.height - 1);
    for (let x = 0; x < width; x++) {
      let u = (x - ox) / s;
      if (p.flip) u = sky.width - 1 - u;
      u = Math.max(0, Math.min(sky.width - 1, u));
      const ix = Math.min(Math.floor(u), Math.max(0, sky.width - 2)),
        fx = u - ix,
        ix1 = Math.min(ix + 1, sky.width - 1);
      const i00 = (iy * sky.width + ix) * 4,
        i10 = (iy * sky.width + ix1) * 4,
        i01 = (iy1 * sky.width + ix) * 4,
        i11 = (iy1 * sky.width + ix1) * 4;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) d[o + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
      d[o + 3] = 255;
    }
  }
  return out;
}

/** Brightness (-100..100) and temperature (-100 cool .. 100 warm) of the sky. */
export function adjustSky(img: RGBA8, brightness: number, temperature: number): RGBA8 {
  const out = rgba8(img.width, img.height);
  const k = Math.pow(2, brightness / 100);
  const t = temperature / 100;
  const gain = [1 + 0.18 * t, 1 + 0.03 * t, 1 - 0.22 * t];
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out.data[i + c] = img.data[i + c] * k * gain[c];
    out.data[i + 3] = img.data[i + 3];
  }
  return out;
}

/** Shift the sky mask edge (positive grows the sky) and soften it. */
export function skyMaskEdge(mask: Mask8, shift: number, fade: number): Mask8 {
  let m = mask;
  if (shift > 0) m = expand(m, shift);
  else if (shift < 0) m = contract(m, -shift);
  if (fade > 0) {
    const f = new Float32Array(m.data);
    gaussianPlane(f, new Float32Array(f.length), m.width, m.height, fade / 2);
    const o = mask8(m.width, m.height);
    for (let i = 0; i < f.length; i++) o.data[i] = Math.round(f[i]);
    m = o;
  }
  return m;
}

/** Lowest row (exclusive) that contains sky, for placing the sky image. */
export function skyHorizon(mask: Mask8): number {
  for (let y = mask.height - 1; y >= 0; y--) {
    const row = mask.data.subarray(y * mask.width, (y + 1) * mask.width);
    let n = 0;
    for (let x = 0; x < row.length; x++) if (row[x] > 127) n++;
    if (n > row.length * 0.02) return y + 1;
  }
  return Math.round(mask.height / 2);
}

/** Average color of the visible sky near the horizon (lights the foreground). */
export function skyLight(sky: RGBA8, mask: Mask8, horizon: number): RGB {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  const y0 = Math.max(0, Math.floor(horizon * 0.5));
  for (let y = y0; y < Math.min(horizon, sky.height); y++)
    for (let x = 0; x < sky.width; x += 2) {
      const i = y * sky.width + x;
      const w = mask.data[i] / 255;
      if (w <= 0) continue;
      r += sky.data[i * 4] * w;
      g += sky.data[i * 4 + 1] * w;
      b += sky.data[i * 4 + 2] * w;
      n += w;
    }
  if (!n) return [128, 128, 128];
  return [r / n, g / n, b / n];
}

/** Foreground mask for lighting: the inverse of the sky, strongest near the
 * horizon and fading toward the bottom. */
export function foregroundLightMask(skyMask: Mask8, horizon: number): Mask8 {
  const { width: w, height: h } = skyMask;
  const out = mask8(w, h);
  const span = Math.max(1, h - horizon);
  for (let y = 0; y < h; y++) {
    const t = y < horizon ? 1 : Math.max(0.15, 1 - (y - horizon) / span);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out.data[i] = Math.round((255 - skyMask.data[i]) * t);
    }
  }
  return out;
}
