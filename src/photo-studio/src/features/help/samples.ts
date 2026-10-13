// Procedurally generated sample images for the tutorials (and What's New
// "Try it" buttons that need a document). Everything is drawn from a seeded
// random generator, so the same sample always has the same pixels; nothing is
// downloaded. Pure functions on RGBA8 (no DOM), usable in tests.
import type { RGBA8 } from '../../imaging/types';

export type SampleId = 'meadow' | 'subject' | 'hazy-hills' | 'skin' | 'poster' | 'postcard';
export type SampleLayer = { name: string; image: RGBA8; background?: boolean };
export type Sample = { name: string; width: number; height: number; layers: SampleLayer[] };
export const SAMPLE_IDS: SampleId[] = ['meadow', 'subject', 'hazy-hills', 'skin', 'poster', 'postcard'];
export const SAMPLE_SIZE = { width: 960, height: 640 };

type RGB = [number, number, number];

/** Small, fast, seeded PRNG (mulberry32). */
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in 0..1 on a lattice of `cells` per unit. */
function valueNoise(seed: number, cells: number) {
  const rnd = random(seed);
  const n = cells + 2;
  const lattice = new Float32Array(n * n).map(() => rnd());
  const at = (x: number, y: number) => lattice[(y % n) * n + (x % n)];
  return (u: number, v: number) => {
    const x = Math.max(0, u) * cells,
      y = Math.max(0, v) * cells;
    const x0 = Math.floor(x),
      y0 = Math.floor(y);
    const fx = x - x0,
      fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx),
      sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Fill an image from a per-pixel function of normalized coordinates. */
function paint(width: number, height: number, f: (u: number, v: number, x: number, y: number) => RGB | [number, number, number, number]): RGBA8 {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = f((x + 0.5) / width, (y + 0.5) / height, x, y);
      const o = (y * width + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = c.length === 4 ? c[3] : 255;
    }
  return { width, height, data };
}

// A sky over rolling hills with a low sun: the layers tutorial paints on it.
function meadow(w: number, h: number): Sample {
  const grass = valueNoise(11, 24);
  const hillA = valueNoise(12, 3),
    hillB = valueNoise(13, 5);
  const aspect = w / h;
  const image = paint(w, h, (u, v) => {
    let c = mix([92, 152, 222], [214, 232, 246], v / 0.62);
    const d = Math.hypot((u - 0.72) * aspect, v - 0.26);
    c = mix(c, [255, 236, 170], 1 - smooth(0.07, 0.11, d));
    const far = 0.5 + 0.08 * hillA(u, 0.3) + 0.04 * Math.sin(u * 7);
    const near = 0.64 + 0.1 * hillB(u, 0.6) - 0.05 * Math.cos(u * 5);
    if (v > far) c = mix([110, 150, 120], [86, 128, 96], clamp01((v - far) * 8));
    if (v > near) c = mix([96, 160, 72], [58, 116, 44], clamp01((v - near) * 3) * 0.6 + grass(u * aspect, v) * 0.4);
    return c;
  });
  return { name: 'Meadow', width: w, height: h, layers: [{ name: 'Background', image, background: true }] };
}

// A round orange object in front of a striped wall, on a separate layer
// above a plain backdrop, so masking it reveals the backdrop.
function subject(w: number, h: number): Sample {
  const grain = valueNoise(21, 40);
  const aspect = w / h;
  const backdrop = paint(w, h, () => [58, 70, 96]);
  const photo = paint(w, h, (u, v) => {
    const stripe = Math.floor(u * 14) % 2 ? 0.06 : 0;
    let c: RGB = mix([196, 204, 196], [170, 180, 172], v * 0.8 + stripe + grain(u * aspect, v) * 0.08);
    // Shadow on the floor.
    const sd = Math.hypot((u - 0.53) * aspect * 0.7, (v - 0.84) * 2.6);
    c = mix(c, [120, 126, 120], (1 - smooth(0.15, 0.4, sd)) * 0.5);
    // The subject: a shaded sphere with a highlight.
    const dx = (u - 0.5) * aspect,
      dy = v - 0.52;
    const d = Math.hypot(dx, dy);
    if (d < 0.27) {
      const z = Math.sqrt(Math.max(0, 0.27 * 0.27 - d * d)) / 0.27;
      const light = clamp01(0.35 + 0.65 * (z * 0.75 - dx * 0.9 - dy * 1.1));
      c = mix([150, 52, 16], [250, 150, 60], light);
      c = mix(c, [255, 240, 220], (1 - smooth(0.02, 0.07, Math.hypot(dx + 0.09, dy + 0.1))) * 0.8);
      const edge = smooth(0.255, 0.27, d);
      c = mix(c, [196, 204, 196], edge * 0.4);
    }
    return c;
  });
  return { name: 'Subject', width: w, height: h, layers: [{ name: 'Backdrop', image: backdrop, background: true }, { name: 'Photo', image: photo }] };
}

// Low-contrast, slightly cold hills: an obvious candidate for adjustments.
function hazyHills(w: number, h: number): Sample {
  const n1 = valueNoise(31, 4),
    n2 = valueNoise(32, 6),
    n3 = valueNoise(33, 30);
  const image = paint(w, h, (u, v) => {
    let c = mix([150, 160, 172], [182, 188, 194], v / 0.5);
    const ridges: [number, RGB][] = [
      [0.42 + 0.1 * n1(u, 0.2), [132, 140, 148]],
      [0.55 + 0.1 * n2(u, 0.4), [118, 128, 130]],
      [0.7 + 0.08 * n1(u * 1.7, 0.7), [104, 116, 110]],
    ];
    for (const [top, col] of ridges) if (v > top) c = mix(col, [96, 104, 100], clamp01((v - top) * 2.5) * 0.4);
    const t = n3(u * 1.5, v) * 10 - 5;
    return [c[0] + t, c[1] + t, c[2] + t];
  });
  return { name: 'Hazy Hills', width: w, height: h, layers: [{ name: 'Background', image, background: true }] };
}

/** Centers of the blemishes in the skin sample (normalized), for tests and hints. */
export const SKIN_SPOTS: [number, number, number][] = [
  [0.38, 0.42, 0.018],
  [0.6, 0.36, 0.014],
  [0.52, 0.62, 0.02],
  [0.7, 0.58, 0.012],
];
// Close-up of skin-like texture with a few dark spots to heal.
function skin(w: number, h: number): Sample {
  const pores = valueNoise(41, 90),
    tone = valueNoise(42, 3);
  const aspect = w / h;
  const image = paint(w, h, (u, v) => {
    let c = mix([226, 172, 142], [196, 136, 108], clamp01(v * 0.7 + tone(u, v) * 0.4));
    const p = (pores(u * aspect, v) - 0.5) * 18;
    c = [c[0] + p, c[1] + p * 0.8, c[2] + p * 0.7];
    for (const [sx, sy, r] of SKIN_SPOTS) {
      const d = Math.hypot((u - sx) * aspect, v - sy);
      c = mix(c, [120, 70, 56], (1 - smooth(r * 0.55, r, d)) * 0.85);
    }
    return c;
  });
  return { name: 'Skin Close-up', width: w, height: h, layers: [{ name: 'Background', image, background: true }] };
}

// A plain poster backdrop that leaves room for a title and shapes.
function poster(w: number, h: number): Sample {
  const aspect = w / h;
  const image = paint(w, h, (u, v) => {
    let c = mix([34, 46, 84], [120, 62, 110], clamp01(u * 0.6 + v * 0.5));
    // A grid of soft dots.
    const gx = (u * aspect * 18) % 1,
      gy = (v * 18) % 1;
    const dot = Math.hypot(gx - 0.5, gy - 0.5);
    c = mix(c, [255, 255, 255], (1 - smooth(0.06, 0.12, dot)) * 0.12 * (1 - v));
    return c;
  });
  return { name: 'Poster', width: w, height: h, layers: [{ name: 'Background', image, background: true }] };
}

// Sunset over the sea with a horizon line: something worth exporting.
function postcard(w: number, h: number): Sample {
  const waves = valueNoise(61, 50);
  const aspect = w / h;
  const image = paint(w, h, (u, v) => {
    const horizon = 0.58;
    if (v < horizon) {
      let c = mix([46, 40, 104], [252, 150, 86], smooth(0, horizon, v));
      const d = Math.hypot((u - 0.5) * aspect, v - horizon + 0.02);
      c = mix(c, [255, 222, 140], 1 - smooth(0.08, 0.12, d));
      return c;
    }
    const t = (v - horizon) / (1 - horizon);
    let c = mix([210, 110, 80], [24, 40, 86], smooth(0, 0.8, t));
    const glint = (1 - smooth(0.02, 0.1 + t * 0.2, Math.abs(u - 0.5))) * (waves(u * aspect * 3, v * 6) > 0.55 ? 1 : 0.2);
    c = mix(c, [255, 214, 150], glint * (1 - t) * 0.8);
    return c;
  });
  return { name: 'Postcard', width: w, height: h, layers: [{ name: 'Background', image, background: true }] };
}

const generators: Record<SampleId, (w: number, h: number) => Sample> = {
  meadow,
  subject,
  'hazy-hills': hazyHills,
  skin,
  poster,
  postcard,
};
/** Build a sample at the given size (thumbnails use a small one). */
export function makeSample(id: SampleId, width = SAMPLE_SIZE.width, height = SAMPLE_SIZE.height): Sample {
  return generators[id](Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
}
/** One flattened image of a sample (top layer over the ones below; opaque samples only). */
export function flattenSample(s: Sample): RGBA8 {
  return s.layers.at(-1)!.image;
}
