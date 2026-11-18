// Indexed color conversion: palette construction (exact, web, uniform,
// adaptive and perceptual median cut, custom), forced colors, transparency
// and dithering (error diffusion, ordered pattern, seeded noise).
// Median cut after Heckbert (1982), splitting the box with the largest
// squared error at the cut that minimizes the error of both halves.
import type { RGBA8 } from '../imaging/types';

export type PaletteKind = 'exact' | 'web' | 'uniform' | 'adaptive' | 'perceptual' | 'custom';
export type DitherKind = 'none' | 'diffusion' | 'pattern' | 'noise';
export type ForcedColors = 'none' | 'blackwhite' | 'primaries' | 'web' | [number, number, number][];
export type IndexedOptions = {
  palette?: PaletteKind;
  colors?: number;
  dither?: DitherKind;
  // Percent, 0-100.
  ditherAmount?: number;
  forced?: ForcedColors;
  customPalette?: [number, number, number][];
  // Keep pixels with alpha < 128 transparent (a reserved palette entry);
  // otherwise composite over the matte.
  transparency?: boolean;
  matte?: [number, number, number];
  seed?: number;
};
export type IndexedResult = {
  width: number;
  height: number;
  indices: Uint8Array;
  // RGB triplets.
  palette: Uint8Array;
  colors: number;
  // -1 when no transparent entry is used.
  transparentIndex: number;
};

const webColors = () => {
  const out: number[][] = [];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) out.push([r * 51, g * 51, b * 51]);
  return out;
};
function forcedList(f: ForcedColors | undefined): number[][] {
  if (!f || f === 'none') return [];
  if (f === 'blackwhite') return [[0, 0, 0], [255, 255, 255]];
  if (f === 'primaries')
    return [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255], [255, 0, 255], [255, 255, 0]];
  if (f === 'web') return webColors();
  return f.map((c) => [...c]);
}

// Fast sRGB-ish CIELAB for perceptual splitting (D65, no adaptation needed
// since only relative distances matter).
const lin = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
function labOf(r: number, g: number, b: number, out: number[]) {
  const R = lin[Math.round(r)] ?? 0,
    G = lin[Math.round(g)] ?? 0,
    B = lin[Math.round(b)] ?? 0;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047),
    y = f(0.2126 * R + 0.7152 * G + 0.0722 * B),
    z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  out[0] = 116 * y - 16;
  out[1] = 500 * (x - y);
  out[2] = 200 * (y - z);
}

// Color bins for median cut: one per distinct color when the image has few
// enough of them (so palettes can split down to single colors and keep every
// color of a simple graphic), else a 5 bits per channel histogram.
const EXACT_BINS = 32768;
type Bins = { n: number; cnt: Float64Array; sr: Float64Array; sg: Float64Array; sb: Float64Array };
function colorBins(px: Uint8ClampedArray, mask: Uint8Array | null): Bins {
  // One pass over distinct colors; gives up once there are too many.
  const ids = new Map<number, number>();
  let cnt = new Float64Array(EXACT_BINS),
    sr = new Float64Array(EXACT_BINS),
    sg = new Float64Array(EXACT_BINS),
    sb = new Float64Array(EXACT_BINS);
  let lastKey = -1,
    last = -1,
    exact = true;
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    if (mask && !mask[p]) continue;
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    if (k !== lastKey) {
      let id = ids.get(k);
      if (id === undefined) {
        if (ids.size >= EXACT_BINS) {
          exact = false;
          break;
        }
        ids.set(k, (id = ids.size));
      }
      lastKey = k;
      last = id;
    }
    cnt[last]++;
    sr[last] += px[i];
    sg[last] += px[i + 1];
    sb[last] += px[i + 2];
  }
  if (exact) return { n: ids.size, cnt, sr, sg, sb };
  cnt = new Float64Array(32768);
  sr = new Float64Array(32768);
  sg = new Float64Array(32768);
  sb = new Float64Array(32768);
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    if (mask && !mask[p]) continue;
    const k = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
    cnt[k]++;
    sr[k] += px[i];
    sg[k] += px[i + 1];
    sb[k] += px[i + 2];
  }
  return { n: 32768, cnt, sr, sg, sb };
}

function medianCut(px: Uint8ClampedArray, mask: Uint8Array | null, count: number, perceptual: boolean): number[][] {
  const { n: H, cnt, sr, sg, sb } = colorBins(px, mask);
  const bins: number[] = [];
  for (let k = 0; k < H; k++) if (cnt[k]) bins.push(k);
  if (!bins.length) return [];
  // Coordinates used for splitting: RGB means or CIELAB of the means.
  const coord = new Float64Array(H * 3);
  const tmp = [0, 0, 0];
  for (const k of bins) {
    const r = sr[k] / cnt[k],
      g = sg[k] / cnt[k],
      b = sb[k] / cnt[k];
    if (perceptual) {
      labOf(r, g, b, tmp);
      coord.set(tmp, k * 3);
    } else coord.set([r, g, b], k * 3);
  }
  // cut is NaN when the box cannot be split.
  type Box = { bins: number[]; sse: number; axis: number; cut: number };
  const analyze = (list: number[]): Box => {
    let best = { sse: 0, axis: 0, cut: NaN };
    let n = 0;
    const s = [0, 0, 0],
      q = [0, 0, 0];
    for (const k of list)
      for (let a = 0; a < 3; a++) {
        const v = coord[k * 3 + a];
        if (a === 0) n += cnt[k];
        s[a] += v * cnt[k];
        q[a] += v * v * cnt[k];
      }
    const sse = [0, 1, 2].reduce((t, a) => t + q[a] - (s[a] * s[a]) / n, 0);
    if (list.length < 2) return { bins: list, sse: 0, axis: 0, cut: NaN };
    // Best split: for each axis, scan sorted bins and minimize SSE along it.
    let gainBest = -1;
    for (let a = 0; a < 3; a++) {
      const sorted = [...list].sort((x, y) => coord[x * 3 + a] - coord[y * 3 + a]);
      let n1 = 0,
        s1 = 0,
        q1 = 0;
      for (let i = 0; i < sorted.length - 1; i++) {
        const k = sorted[i],
          v = coord[k * 3 + a];
        n1 += cnt[k];
        s1 += v * cnt[k];
        q1 += v * v * cnt[k];
        if (coord[sorted[i + 1] * 3 + a] === v) continue;
        const n2 = n - n1,
          s2 = s[a] - s1,
          q2 = q[a] - q1;
        const after = q1 - (s1 * s1) / n1 + q2 - (s2 * s2) / n2;
        const gain = q[a] - (s[a] * s[a]) / n - after;
        if (gain > gainBest) {
          gainBest = gain;
          best = { sse, axis: a, cut: coord[sorted[i + 1] * 3 + a] };
        }
      }
    }
    return { bins: list, sse: gainBest > 0 ? sse : 0, axis: best.axis, cut: best.cut };
  };
  const boxes: Box[] = [analyze(bins)];
  while (boxes.length < count) {
    let pick = -1;
    for (let i = 0; i < boxes.length; i++) if (!Number.isNaN(boxes[i].cut) && boxes[i].sse > 0 && (pick < 0 || boxes[i].sse > boxes[pick].sse)) pick = i;
    if (pick < 0) break;
    const box = boxes[pick];
    const lo = box.bins.filter((k) => coord[k * 3 + box.axis] < box.cut),
      hi = box.bins.filter((k) => coord[k * 3 + box.axis] >= box.cut);
    if (!lo.length || !hi.length) {
      box.cut = NaN;
      continue;
    }
    boxes.splice(pick, 1, analyze(lo), analyze(hi));
  }
  return boxes.map((b) => {
    let n = 0,
      r = 0,
      g = 0,
      bl = 0;
    for (const k of b.bins) {
      n += cnt[k];
      r += sr[k];
      g += sg[k];
      bl += sb[k];
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
}

// Ordered dither thresholds in (0, 1): the recursive Bayer construction
// M(2n) = [[4M, 4M + 2], [4M + 3, 4M + 1]].
export const BAYER8 = (() => {
  let m = [0],
    size = 1;
  while (size < 8) {
    const next = new Array<number>(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const v = 4 * m[y * size + x],
          w = size * 2;
        next[y * w + x] = v;
        next[y * w + x + size] = v + 2;
        next[(y + size) * w + x] = v + 3;
        next[(y + size) * w + x + size] = v + 1;
      }
    m = next;
    size *= 2;
  }
  return Float32Array.from(m, (v) => (v + 0.5) / 64);
})();

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function toIndexed(img: RGBA8, opts: IndexedOptions = {}): IndexedResult {
  const { width, height } = img;
  const px = width * height;
  const kind = opts.palette ?? 'adaptive';
  const total = Math.max(2, Math.min(256, Math.round(opts.colors ?? 256)));
  const matte = opts.matte ?? [255, 255, 255];
  const transparent = !!opts.transparency;
  // Composite (or mask out) partially transparent pixels.
  const rgb = new Uint8ClampedArray(px * 4);
  const opaque = new Uint8Array(px);
  let anyTransparent = false;
  for (let p = 0, i = 0; p < px; p++, i += 4) {
    const a = img.data[i + 3];
    if (transparent && a < 128) {
      anyTransparent = true;
      rgb.set(matte, i);
      continue;
    }
    opaque[p] = 1;
    const t = transparent ? 1 : a / 255;
    for (let c = 0; c < 3; c++) rgb[i + c] = img.data[i + c] * t + matte[c] * (1 - t);
    rgb[i + 3] = 255;
  }
  const slots = total - (anyTransparent ? 1 : 0);
  let palette: number[][] = forcedList(opts.forced).slice(0, slots);
  const remaining = slots - palette.length;
  let exactMap: Map<number, number> | null = null;
  const perceptual = kind === 'perceptual';
  // Local palettes (and Exact) keep every color of an image that has no more
  // colors than free slots, mapped exactly and without dithering.
  const local = kind === 'exact' || kind === 'adaptive' || kind === 'perceptual';
  if (remaining > 0) {
    if (local) {
      const seen = new Map<number, number>();
      for (let p = 0; p < px && seen.size <= remaining; p++)
        if (opaque[p]) {
          const k = (rgb[p * 4] << 16) | (rgb[p * 4 + 1] << 8) | rgb[p * 4 + 2];
          if (!seen.has(k)) seen.set(k, seen.size);
        }
      if (seen.size <= remaining) {
        const base = palette.length;
        for (const k of seen.keys()) palette.push([k >> 16, (k >> 8) & 255, k & 255]);
        exactMap = new Map();
        for (const [k, i] of seen) exactMap.set(k, base + i);
      } else palette.push(...medianCut(rgb, opaque, remaining, perceptual));
    } else if (kind === 'web') palette.push(...webColors().slice(0, remaining));
    else if (kind === 'uniform') {
      const levels = Math.max(2, Math.floor(Math.cbrt(remaining) + 1e-9));
      const cube: number[][] = [];
      for (let r = 0; r < levels; r++)
        for (let g = 0; g < levels; g++)
          for (let b = 0; b < levels; b++)
            cube.push([r, g, b].map((v) => Math.round((v * 255) / (levels - 1))));
      // Fewer than 8 free slots cannot hold a whole 2x2x2 cube: keep black and
      // white, then the primaries and secondaries.
      if (cube.length > remaining) palette.push(...[0, 7, 4, 2, 1, 6, 5, 3].slice(0, remaining).map((i) => cube[i]));
      else palette.push(...cube);
    } else if (kind === 'custom') palette.push(...(opts.customPalette ?? []).slice(0, remaining).map((c) => [...c]));
  }
  if (!palette.length) palette = [[...matte]];
  const n = palette.length;
  const transparentIndex = anyTransparent ? n : -1;
  const pal = new Uint8Array((n + (anyTransparent ? 1 : 0)) * 3);
  palette.forEach((c, i) => pal.set(c, i * 3));
  if (anyTransparent) pal.set(matte, n * 3);

  // Nearest entry, cached on a 7-bit-per-channel grid (cell centers).
  const wr = perceptual ? 2 : 1,
    wg = perceptual ? 4 : 1,
    wb = perceptual ? 3 : 1;
  const nearestExact = (r: number, g: number, b: number) => {
    let best = 0,
      bd = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = r - pal[i * 3],
        dg = g - pal[i * 3 + 1],
        db = b - pal[i * 3 + 2];
      const d = wr * dr * dr + wg * dg * dg + wb * db * db;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  const cache = new Int16Array(1 << 21).fill(-1);
  const nearest = (r: number, g: number, b: number) => {
    r = r < 0 ? 0 : r > 255 ? 255 : r;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    b = b < 0 ? 0 : b > 255 ? 255 : b;
    if (exactMap) {
      const e = exactMap.get((Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b));
      if (e !== undefined) return e;
    }
    const key = ((r >> 1) << 14) | ((g >> 1) << 7) | (b >> 1);
    let v = cache[key];
    if (v < 0) v = cache[key] = nearestExact((r >> 1) * 2 + 0.5, (g >> 1) * 2 + 0.5, (b >> 1) * 2 + 0.5);
    return v;
  };

  const indices = new Uint8Array(px);
  const dither = exactMap ? 'none' : (opts.dither ?? 'none');
  const amount = (opts.ditherAmount ?? 100) / 100;
  // Spacing of the palette, used to scale ordered and noise dither offsets.
  const spread = (255 / Math.max(1, Math.cbrt(n) - 1)) * amount;
  if (dither === 'diffusion') {
    // Floyd-Steinberg, serpentine scan.
    let cur = new Float32Array((width + 2) * 3),
      next = new Float32Array((width + 2) * 3);
    for (let y = 0; y < height; y++) {
      const ltr = (y & 1) === 0;
      for (let s = 0; s < width; s++) {
        const x = ltr ? s : width - 1 - s,
          p = y * width + x,
          i = p * 4;
        if (!opaque[p]) {
          indices[p] = transparentIndex;
          continue;
        }
        const e = (x + 1) * 3;
        const r = rgb[i] + cur[e],
          g = rgb[i + 1] + cur[e + 1],
          b = rgb[i + 2] + cur[e + 2];
        const k = nearest(r, g, b);
        indices[p] = k;
        const dir = ltr ? 1 : -1;
        for (let c = 0; c < 3; c++) {
          const v = ((c === 0 ? r : c === 1 ? g : b) - pal[k * 3 + c]) * amount;
          cur[e + dir * 3 + c] += (v * 7) / 16;
          next[e - dir * 3 + c] += (v * 3) / 16;
          next[e + c] += (v * 5) / 16;
          next[e + dir * 3 + c] += v / 16;
        }
      }
      [cur, next] = [next, cur];
      next.fill(0);
    }
  } else {
    const rand = mulberry32(opts.seed ?? 1);
    for (let y = 0, p = 0; y < height; y++)
      for (let x = 0; x < width; x++, p++) {
        if (!opaque[p]) {
          indices[p] = transparentIndex;
          continue;
        }
        const i = p * 4;
        let o0 = 0,
          o1 = 0,
          o2 = 0;
        if (dither === 'pattern') o0 = o1 = o2 = (BAYER8[(y & 7) * 8 + (x & 7)] - 0.5) * spread;
        else if (dither === 'noise') {
          o0 = (rand() - 0.5) * spread;
          o1 = (rand() - 0.5) * spread;
          o2 = (rand() - 0.5) * spread;
        }
        indices[p] = nearest(rgb[i] + o0, rgb[i + 1] + o1, rgb[i + 2] + o2);
      }
  }
  return { width, height, indices, palette: pal, colors: pal.length / 3, transparentIndex };
}

export function indexedToRGBA(res: IndexedResult): RGBA8 {
  const px = res.width * res.height;
  const data = new Uint8ClampedArray(px * 4);
  for (let p = 0; p < px; p++) {
    const k = res.indices[p];
    data[p * 4] = res.palette[k * 3];
    data[p * 4 + 1] = res.palette[k * 3 + 1];
    data[p * 4 + 2] = res.palette[k * 3 + 2];
    data[p * 4 + 3] = k === res.transparentIndex ? 0 : 255;
  }
  return { width: res.width, height: res.height, data };
}
