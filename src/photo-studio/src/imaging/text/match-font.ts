// Match Font: find installed or bundled fonts that look like text in an
// image. Pure functions (no DOM): candidates are drawn by an injected
// renderer, so the browser uses canvas text and tests a font-file rasterizer.
//
// Pipeline, applied the same way to the user's crop and to every candidate:
//  1. Gray levels (composited over white), Otsu threshold, ink polarity from
//     the crop's border (dark text on light or light text on dark).
//  2. Skew from the angle whose row projection of the ink is sharpest, then
//     rotation upright; small text is enlarged so features stay stable.
//  3. Lines split at empty rows; glyphs are connected components merged when
//     they share columns (dots of i and j, accents, colons).
//  4. Per glyph: histogram of oriented gradients and zoned coverage of the
//     size-normalized bitmap, height relative to the line, aspect ratio and
//     descent below the baseline. Per line: stroke thickness relative to the
//     line height (2 × ink area / boundary length) and slant (the shear that
//     makes vertical strokes sharpest).
//  5. Distance: glyphs compared in order when the user typed the text and the
//     counts agree, otherwise each sample glyph against its nearest candidate
//     glyph; plus stroke, slant and width terms. Lower is closer.
import type { Mask8, RGBA8 } from '../types';

export type FontCandidate = { family: string; weight: number; italic: boolean };
/** Draws `text` (lines separated by \n) dark on light at `px` pixels per em. */
export type FontRenderer = (text: string, font: FontCandidate, px: number) => RGBA8 | Promise<RGBA8>;

export type GlyphFeature = {
  hog: Float32Array;
  zones: Float32Array;
  relHeight: number;
  aspect: number;
  descent: number;
};
export type TextSample = {
  glyphs: GlyphFeature[];
  lines: number;
  // Line height used for normalizing (a tall glyph height), in pixels.
  ref: number;
  // Stroke thickness relative to `ref`.
  stroke: number;
  // Horizontal shear of vertical strokes (positive leans right).
  slant: number;
  // Average glyph advance (ink extent of the lines / glyph count) relative to `ref`.
  width: number;
  // Skew that was removed, in radians.
  skew: number;
  polarity: 'dark' | 'light';
};
export type FontMatch = FontCandidate & { distance: number; similarity: number };

// Reference text for candidates when the user did not type what the image says.
export const REFERENCE_TEXT = 'abcdefghijklmnopqrstuvwxyz\nABCDEFGHIJKLMNOPQRSTUVWXYZ\n0123456789&?!';

// ---------------------------------------------------------------- binarizing

/** Luminance 0–255, transparent pixels counted as white. */
export function grayscale(img: RGBA8): Mask8 {
  const n = img.width * img.height, out = new Uint8Array(n), d = img.data;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255;
    const y = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    out[i] = Math.round(y * a + 255 * (1 - a));
  }
  return { width: img.width, height: img.height, data: out };
}

/** Otsu's threshold: values <= t form the dark class. */
export function otsuThreshold(g: Mask8): number {
  const hist = new Float64Array(256);
  for (const v of g.data) hist[v]++;
  const total = g.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let w0 = 0, sum0 = 0, best = -1, t = 127;
  for (let i = 0; i < 255; i++) {
    w0 += hist[i];
    if (!w0) continue;
    const w1 = total - w0;
    if (!w1) break;
    sum0 += i * hist[i];
    const m0 = sum0 / w0, m1 = (sum - sum0) / w1;
    const between = w0 * w1 * (m0 - m1) * (m0 - m1);
    if (between > best) {
      best = between;
      t = i;
    }
  }
  return t;
}

export type Binarized = { ink: Mask8; polarity: 'dark' | 'light'; threshold: number };
/** Ink mask (255 = ink). The background is the class covering most of the
 * border; when the border is mixed, the smaller class is the ink. */
export function binarize(g: Mask8): Binarized {
  const t = otsuThreshold(g);
  const { width: w, height: h, data } = g;
  let dark = 0, border = 0;
  const visit = (i: number) => {
    border++;
    if (data[i] <= t) dark++;
  };
  for (let x = 0; x < w; x++) {
    visit(x);
    if (h > 1) visit((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    visit(y * w);
    if (w > 1) visit(y * w + w - 1);
  }
  let polarity: 'dark' | 'light';
  const f = border ? dark / border : 0;
  if (f < 0.35) polarity = 'dark';
  else if (f > 0.65) polarity = 'light';
  else {
    let all = 0;
    for (const v of data) if (v <= t) all++;
    polarity = all <= data.length / 2 ? 'dark' : 'light';
  }
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = (polarity === 'dark' ? data[i] <= t : data[i] > t) ? 255 : 0;
  return { ink: { width: w, height: h, data: ink }, polarity, threshold: t };
}

// ---------------------------------------------------------------- geometry

function inkPoints(m: Mask8, max = 24000): Float64Array {
  let count = 0;
  for (const v of m.data) if (v) count++;
  const step = Math.max(1, Math.ceil(count / max));
  const pts = new Float64Array(Math.ceil(count / step) * 2);
  let k = 0, seen = 0;
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++)
      if (m.data[y * m.width + x] && seen++ % step === 0) {
        pts[k++] = x;
        pts[k++] = y;
      }
  return pts.subarray(0, k);
}

// Sum of squared histogram counts of `value(x, y)` over the points: large when
// the points concentrate in a few bins (sharp projection).
let binScratch = new Float64Array(0);
function sharpness(pts: Float64Array, value: (x: number, y: number) => number): number {
  const n = pts.length >> 1;
  const v = new Int32Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const b = Math.round(value(pts[i * 2], pts[i * 2 + 1]));
    v[i] = b;
    if (b < lo) lo = b;
    if (b > hi) hi = b;
  }
  if (!n) return 0;
  const size = hi - lo + 1;
  if (binScratch.length < size) binScratch = new Float64Array(size);
  const bins = binScratch;
  bins.fill(0, 0, size);
  for (let i = 0; i < n; i++) bins[v[i] - lo]++;
  let s = 0;
  for (let i = 0; i < size; i++) s += bins[i] * bins[i];
  return s;
}

/** Angle (radians) of the text baseline in image coordinates (y down);
 * positive when the text runs down to the right. Searched within ±maxDeg. */
export function estimateSkew(ink: Mask8, maxDeg = 20): number {
  const pts = inkPoints(ink);
  if (pts.length < 20) return 0;
  const score = (a: number) => {
    const s = Math.sin(a), c = Math.cos(a);
    return sharpness(pts, (x, y) => y * c - x * s);
  };
  let best = 0, bestScore = score(0);
  const deg = Math.PI / 180;
  for (let d = -maxDeg; d <= maxDeg; d += 1) {
    const v = score(d * deg);
    if (v > bestScore) {
      bestScore = v;
      best = d * deg;
    }
  }
  for (let d = -1; d <= 1; d += 0.1) {
    const a = best + d * deg, v = score(a);
    if (v > bestScore) {
      bestScore = v;
      best = a;
    }
  }
  return Math.abs(best) < 0.05 * deg ? 0 : best;
}

/** Rotate a mask by -angle (undoing a skew of `angle`), bilinear, on a
 * canvas large enough for the result. */
export function rotateMask(m: Mask8, angle: number): Mask8 {
  if (!angle) return m;
  const c = Math.cos(angle), s = Math.sin(angle);
  const W = Math.ceil(Math.abs(m.width * c) + Math.abs(m.height * s));
  const H = Math.ceil(Math.abs(m.width * s) + Math.abs(m.height * c));
  const out = new Uint8Array(W * H);
  const cx = m.width / 2, cy = m.height / 2, ox = W / 2, oy = H / 2;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= m.width || y >= m.height ? 0 : m.data[y * m.width + x]);
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      // Output point rotated forward by `angle` gives the source point.
      const dx = u + 0.5 - ox, dy = v + 0.5 - oy;
      const x = dx * c - dy * s + cx - 0.5, y = dx * s + dy * c + cy - 0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const val = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
      out[v * W + u] = val >= 128 ? 255 : 0;
    }
  return { width: W, height: H, data: out };
}

/** Rotate an image by `angle` (radians, positive = clockwise on screen) onto a
 * white canvas; used to make skewed test samples. */
export function rotateGray(g: Mask8, angle: number): Mask8 {
  const c = Math.cos(angle), s = Math.sin(angle);
  const W = Math.ceil(Math.abs(g.width * c) + Math.abs(g.height * s));
  const H = Math.ceil(Math.abs(g.width * s) + Math.abs(g.height * c));
  const out = new Uint8Array(W * H).fill(255);
  const cx = g.width / 2, cy = g.height / 2, ox = W / 2, oy = H / 2;
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const dx = u + 0.5 - ox, dy = v + 0.5 - oy;
      // Inverse of a clockwise rotation by `angle`.
      const x = Math.floor(dx * c + dy * s + cx), y = Math.floor(-dx * s + dy * c + cy);
      if (x >= 0 && y >= 0 && x < g.width && y < g.height) out[v * W + u] = g.data[y * g.width + x];
    }
  return { width: W, height: H, data: out };
}

function cropToInk(m: Mask8): Mask8 | null {
  let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1;
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++)
      if (m.data[y * m.width + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(m.data.subarray((y + y0) * m.width + x0, (y + y0) * m.width + x0 + w), y * w);
  return { width: w, height: h, data: out };
}

/** Enlarge a gray image by an integer factor (bilinear). */
function upscale(g: Mask8, k: number): Mask8 {
  if (k <= 1) return g;
  const W = g.width * k, H = g.height * k, out = new Uint8Array(W * H);
  const at = (x: number, y: number) => g.data[Math.min(g.height - 1, Math.max(0, y)) * g.width + Math.min(g.width - 1, Math.max(0, x))];
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const x = (u + 0.5) / k - 0.5, y = (v + 0.5) / k - 0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      out[v * W + u] = Math.round((at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy);
    }
  return { width: W, height: H, data: out };
}

// ---------------------------------------------------------------- segmenting

export type Box = { x: number; y: number; width: number; height: number; area: number };
type Component = Box & { pixels: number[] };

/** Rows of text: runs of rows containing ink; very short runs (detached dots
 * or accents) join the nearest line. Returns [top, bottom) pairs. */
export function splitLines(ink: Mask8): [number, number][] {
  const rows = new Uint32Array(ink.height);
  for (let y = 0; y < ink.height; y++) for (let x = 0; x < ink.width; x++) if (ink.data[y * ink.width + x]) rows[y]++;
  const runs: [number, number][] = [];
  let start = -1;
  for (let y = 0; y <= ink.height; y++) {
    const on = y < ink.height && rows[y] > 0;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      runs.push([start, y]);
      start = -1;
    }
  }
  if (runs.length < 2) return runs;
  const tallest = Math.max(...runs.map(([a, b]) => b - a));
  const lines = runs.filter(([a, b]) => b - a >= tallest * 0.3);
  for (const r of runs) {
    if (lines.includes(r)) continue;
    // Attach to the closest line (dots sit above, descender bits below).
    let best = lines[0], gap = Infinity;
    for (const l of lines) {
      const d = r[1] <= l[0] ? l[0] - r[1] : r[0] - l[1];
      if (d < gap) {
        gap = d;
        best = l;
      }
    }
    best[0] = Math.min(best[0], r[0]);
    best[1] = Math.max(best[1], r[1]);
  }
  return lines.sort((a, b) => a[0] - b[0]);
}

function components(ink: Mask8, top: number, bottom: number): Component[] {
  const w = ink.width, seen = new Uint8Array(w * (bottom - top)), out: Component[] = [];
  const stack: number[] = [];
  for (let y = top; y < bottom; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!ink.data[i] || seen[i - top * w]) continue;
      seen[i - top * w] = 1;
      stack.push(i);
      const pixels: number[] = [];
      let x0 = x, x1 = x, y0 = y, y1 = y;
      while (stack.length) {
        const p = stack.pop()!;
        pixels.push(p);
        const px = p % w, py = (p - px) / w;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || nx >= w || ny < top || ny >= bottom) continue;
            const q = ny * w + nx;
            if (ink.data[q] && !seen[q - top * w]) {
              seen[q - top * w] = 1;
              stack.push(q);
            }
          }
      }
      out.push({ x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, area: pixels.length, pixels });
    }
  return out;
}

/** Glyph boxes of one line, left to right. Components sharing most of their
 * columns merge (i, j, accents, colons); specks are dropped. */
export function segmentLine(ink: Mask8, top: number, bottom: number): Component[] {
  let comps = components(ink, top, bottom);
  if (!comps.length) return [];
  const areas = comps.map((c) => c.area).sort((a, b) => a - b);
  const median = areas[areas.length >> 1];
  comps = comps.filter((c) => c.area >= Math.max(2, median * 0.02));
  comps.sort((a, b) => a.x - b.x);
  const merged: Component[] = [];
  for (const c of comps) {
    const prev = merged.find((m) => {
      const overlap = Math.min(m.x + m.width, c.x + c.width) - Math.max(m.x, c.x);
      return overlap > 0.5 * Math.min(m.width, c.width) && (m.width < c.width * 0.6 || c.width < m.width * 0.6 || m.y + m.height <= c.y || c.y + c.height <= m.y);
    });
    if (!prev) {
      merged.push({ ...c, pixels: c.pixels.slice() });
      continue;
    }
    const x0 = Math.min(prev.x, c.x), y0 = Math.min(prev.y, c.y);
    prev.width = Math.max(prev.x + prev.width, c.x + c.width) - x0;
    prev.height = Math.max(prev.y + prev.height, c.y + c.height) - y0;
    prev.x = x0;
    prev.y = y0;
    prev.area += c.area;
    for (const p of c.pixels) prev.pixels.push(p);
  }
  return merged.sort((a, b) => a.x - b.x);
}

// ---------------------------------------------------------------- features

const N = 32; // normalized glyph size
const CELLS = 4;
const BINS = 9;

function normalizedGlyph(ink: Mask8, c: Component): Float32Array {
  // The glyph's own pixels only (a neighbor's serif can reach into its box).
  const box = new Uint8Array(c.width * c.height);
  for (const p of c.pixels) {
    const x = (p % ink.width) - c.x, y = Math.floor(p / ink.width) - c.y;
    box[y * c.width + x] = 1;
  }
  const s = (N - 4) / Math.max(c.width, c.height);
  const ox = (N - c.width * s) / 2, oy = (N - c.height * s) / 2;
  const out = new Float32Array(N * N);
  // Area sampling: 3 × 3 subsamples per output pixel.
  for (let v = 0; v < N; v++)
    for (let u = 0; u < N; u++) {
      let acc = 0;
      for (let j = 0; j < 3; j++)
        for (let i = 0; i < 3; i++) {
          const x = Math.floor((u + (i + 0.5) / 3 - ox) / s), y = Math.floor((v + (j + 0.5) / 3 - oy) / s);
          if (x >= 0 && y >= 0 && x < c.width && y < c.height) acc += box[y * c.width + x];
        }
      out[v * N + u] = acc / 9;
    }
  return out;
}

function normalize(v: Float32Array) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}

/** Histogram of oriented gradients (unsigned, 9 bins) over a 4 × 4 grid. */
export function hogDescriptor(img: Float32Array, n = N): Float32Array {
  const out = new Float32Array(CELLS * CELLS * BINS), cell = n / CELLS;
  const at = (x: number, y: number) => img[Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const gx = at(x + 1, y) - at(x - 1, y), gy = at(x, y + 1) - at(x, y - 1);
      const mag = Math.hypot(gx, gy);
      if (!mag) continue;
      let a = Math.atan2(gy, gx);
      if (a < 0) a += Math.PI;
      const f = (a / Math.PI) * BINS;
      const b0 = Math.floor(f) % BINS, b1 = (b0 + 1) % BINS, w1 = f - Math.floor(f);
      const cx = Math.min(CELLS - 1, Math.floor(x / cell)), cy = Math.min(CELLS - 1, Math.floor(y / cell));
      const o = (cy * CELLS + cx) * BINS;
      out[o + b0] += mag * (1 - w1);
      out[o + b1] += mag * w1;
    }
  return normalize(out);
}

function zoneDescriptor(img: Float32Array, n = N, zones = 6): Float32Array {
  const out = new Float32Array(zones * zones);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[Math.floor((y * zones) / n) * zones + Math.floor((x * zones) / n)] += img[y * n + x];
  return normalize(out);
}

function median(values: number[]) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** Shear s (x' = x + s·(y − baseline)) that makes vertical strokes sharpest. */
function estimateSlant(pts: Float64Array): number {
  let best = 0, bestScore = -1;
  for (let s = -0.5; s <= 0.5001; s += 0.025) {
    const v = sharpness(pts, (x, y) => x + s * y);
    if (v > bestScore) {
      bestScore = v;
      best = s;
    }
  }
  // Leaning right in y-down coordinates is undone by a positive shear.
  return Math.round(best * 1000) / 1000;
}

export type AnalyzeOptions = { deskew?: boolean; maxGlyphs?: number };
/** Measure text in an image (the whole image is the text area). Returns null
 * when no ink is found. */
export function analyzeText(img: RGBA8 | Mask8, opts: AnalyzeOptions = {}): TextSample | null {
  let gray = 'data' in img && img.data instanceof Uint8ClampedArray ? grayscale(img as RGBA8) : (img as Mask8);
  const first = binarize(gray);
  // Small text: enlarge before measuring, so thin strokes survive thresholding.
  const tight = cropToInk(first.ink);
  if (!tight) return null;
  const k = tight.height < 40 ? Math.min(4, Math.ceil(40 / Math.max(1, tight.height))) : 1;
  let ink = first.ink;
  if (k > 1) {
    gray = upscale(gray, k);
    const t = first.threshold;
    ink = { width: gray.width, height: gray.height, data: new Uint8Array(gray.data.length) };
    for (let i = 0; i < gray.data.length; i++) ink.data[i] = (first.polarity === 'dark' ? gray.data[i] <= t : gray.data[i] > t) ? 255 : 0;
  }
  const skew = opts.deskew === false ? 0 : estimateSkew(ink);
  const upright = cropToInk(rotateMask(ink, skew));
  if (!upright) return null;
  const lines = splitLines(upright);
  const glyphs: GlyphFeature[] = [];
  const all: { c: Component; line: number }[] = [];
  lines.forEach(([a, b], li) => {
    for (const c of segmentLine(upright, a, b)) all.push({ c, line: li });
  });
  if (!all.length) return null;
  const maxGlyphs = opts.maxGlyphs ?? 80;
  const used = all.slice(0, maxGlyphs);
  // Normalizing height: a tall glyph (ascenders and capitals), robust to outliers.
  const heights = used.map((g) => g.c.height).sort((a, b) => a - b);
  const ref = Math.max(1, heights[Math.min(heights.length - 1, Math.floor(heights.length * 0.85))]);
  // Baseline per line: the most common glyph bottom.
  const baselines = lines.map((_, li) => median(used.filter((g) => g.line === li).map((g) => g.c.y + g.c.height)));
  let area = 0, boundary = 0;
  const w = upright.width;
  for (const { c, line } of used) {
    const img = normalizedGlyph(upright, c);
    glyphs.push({
      hog: hogDescriptor(img),
      zones: zoneDescriptor(img),
      relHeight: c.height / ref,
      aspect: Math.log(c.width / c.height),
      descent: Math.max(0, c.y + c.height - baselines[line]) / ref,
    });
    for (const p of c.pixels) {
      area++;
      const x = p % w;
      if (x === 0 || x === w - 1 || p < w || p >= upright.data.length - w || !upright.data[p - 1] || !upright.data[p + 1] || !upright.data[p - w] || !upright.data[p + w]) boundary++;
    }
  }
  const extent = lines.reduce((s, _line, li) => {
    const row = used.filter((g) => g.line === li).map((g) => g.c);
    return row.length ? s + (Math.max(...row.map((c) => c.x + c.width)) - Math.min(...row.map((c) => c.x))) : s;
  }, 0);
  return {
    glyphs,
    lines: lines.length,
    ref: ref / k,
    stroke: (2 * area) / Math.max(1, boundary) / ref,
    slant: estimateSlant(inkPoints(upright, 12000)),
    width: extent / used.length / ref,
    skew,
    polarity: first.polarity,
  };
}

// ---------------------------------------------------------------- comparing

function euclid(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}
export function glyphDistance(a: GlyphFeature, b: GlyphFeature): number {
  return euclid(a.hog, b.hog) + 0.6 * euclid(a.zones, b.zones) + 1.5 * Math.abs(a.relHeight - b.relHeight) + 0.4 * Math.abs(a.aspect - b.aspect) + 1.2 * Math.abs(a.descent - b.descent);
}

/** Distance between a sample and a candidate rendering (0 = identical).
 * `sameText` says the candidate shows the same characters as the sample. */
export function sampleDistance(sample: TextSample, cand: TextSample, sameText: boolean): number {
  let glyph = 0;
  const ordered = sameText && sample.glyphs.length === cand.glyphs.length;
  if (ordered) {
    for (let i = 0; i < sample.glyphs.length; i++) glyph += glyphDistance(sample.glyphs[i], cand.glyphs[i]);
  } else {
    for (const g of sample.glyphs) {
      let best = Infinity;
      for (const c of cand.glyphs) best = Math.min(best, glyphDistance(g, c));
      glyph += best;
    }
  }
  glyph /= Math.max(1, sample.glyphs.length);
  const stroke = Math.abs(Math.log(Math.max(1e-3, sample.stroke) / Math.max(1e-3, cand.stroke)));
  const slant = Math.abs(sample.slant - cand.slant);
  const width = sameText ? Math.abs(Math.log(Math.max(1e-3, sample.width) / Math.max(1e-3, cand.width))) : 0;
  return glyph + 1.2 * stroke + 1.5 * slant + 0.8 * width;
}

/** 0–1 likeness shown to the user (1 = identical). */
// Renderings of the same font differ a little (size, anti-aliasing), so the
// first 0.3 of distance still counts as identical.
export const similarity = (distance: number) => Math.exp(-Math.max(0, distance - 0.3));

/** Pixels per em for candidates, so their glyphs come out about the size of
 * the sample's (capitals and ascenders are about 0.7 em). */
export const candidateSize = (sample: TextSample) => Math.max(16, Math.min(160, Math.round(sample.ref / 0.7)));

export type RankOptions = {
  // What the image says; candidates then render exactly this text.
  text?: string;
  onProgress?: (done: number, total: number) => void;
  // Called between candidates (yield to the UI, check for cancellation).
  pause?: () => Promise<void>;
};
/** Rank fonts by how closely they reproduce the sample. */
export async function rankFonts(sample: TextSample, candidates: FontCandidate[], render: FontRenderer, opts: RankOptions = {}): Promise<FontMatch[]> {
  const text = opts.text?.trim() ? opts.text.trim() : REFERENCE_TEXT;
  const sameText = !!opts.text?.trim();
  const px = candidateSize(sample);
  const out: FontMatch[] = [];
  for (let i = 0; i < candidates.length; i++) {
    await opts.pause?.();
    const f = candidates[i];
    const img = await render(text, f, px);
    const cand = analyzeText(img, { deskew: false, maxGlyphs: 120 });
    if (cand) {
      const distance = sampleDistance(sample, cand, sameText);
      out.push({ ...f, distance, similarity: similarity(distance) });
    }
    opts.onProgress?.(i + 1, candidates.length);
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/** Move the families an outside opinion prefers to the top, in its order,
 * keeping the measured order otherwise. */
export function rerank(matches: FontMatch[], preferred: string[]): FontMatch[] {
  const order = preferred.map((p) => p.toLowerCase());
  const rank = (m: FontMatch) => {
    const k = order.indexOf(m.family.toLowerCase());
    return k < 0 ? order.length : k;
  };
  return matches
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map(({ m }) => m);
}

/** Variants worth trying for a family: weights it offers near the common
 * ones, upright and (when it has one) italic. */
export function variantsOf(family: string, weights: number[], italic: boolean): FontCandidate[] {
  const want = [300, 400, 500, 700, 900];
  const ws = weights.length ? [...new Set(want.map((w) => weights.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a))))] : [400];
  const out: FontCandidate[] = [];
  for (const w of ws) {
    out.push({ family, weight: w, italic: false });
    if (italic) out.push({ family, weight: w, italic: true });
  }
  return out;
}
