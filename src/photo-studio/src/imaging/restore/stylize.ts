// Style Transfer (creative looks), all procedural and deterministic:
// - Painterly: edge-aware abstraction, then brush strokes laid in two passes
//   (large, then small where detail differs), each stroke following the local
//   edge direction from the structure tensor (after Hertzmann, "Painterly
//   Rendering with Curved Brush Strokes of Multiple Sizes", SIGGRAPH 1998).
// - Ink: difference-of-Gaussians lines (Winnemöller, Olsen and Gooch,
//   "Real-time video abstraction", SIGGRAPH 2006) over a soft ink wash.
// - Pencil: soft difference-of-Gaussians lines over diagonal hatching whose
//   density follows tone, cross-hatched in the darkest areas.
// - Watercolor: abstraction with a wobbling boundary, darkened pigment at
//   region edges and paper granulation (after Bousseau et al., "Interactive
//   watercolor rendering with temporal coherence and abstraction", NPAR 2006).
// - Print: four rotated amplitude-modulated dot screens (cyan, magenta,
//   yellow, black) printed subtractively on paper.
import { guidedFilterGray } from '../segment/filters';
import type { Progress, RGBA8 } from '../types';
import { checkCancelled } from '../types';
import { clamp, gaussian, hash01, lumaOf, smoothstep, type Plane } from './util';

export type ClassicStyle = 'painterly' | 'ink' | 'pencil' | 'watercolor' | 'print';
export type StyleOptions = {
  style: ClassicStyle;
  // Brush, line or dot size in document pixels, and pixels of `img` per document pixel.
  brush: number;
  scale: number;
  seed?: number;
};

const PAPER = [247, 243, 234];

function abstraction(img: RGBA8, r: number, passes: number): Plane[] {
  const { width: w, height: h, data: d } = img, n = w * h;
  const Y = lumaOf(img);
  for (let i = 0; i < n; i++) Y[i] /= 255;
  const ch = [0, 1, 2].map((c) => {
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) p[i] = d[i * 4 + c] / 255;
    return p;
  });
  let guide = Y;
  for (let k = 0; k < passes; k++) {
    for (let c = 0; c < 3; c++) ch[c] = guidedFilterGray(guide, ch[c], w, h, Math.max(1, Math.round(r)), 0.004);
    guide = new Float32Array(n);
    for (let i = 0; i < n; i++) guide[i] = 0.299 * ch[0][i] + 0.587 * ch[1][i] + 0.114 * ch[2][i];
  }
  return ch;
}

/** Edge tangent direction (radians) from the smoothed structure tensor. */
function tangents(Y: Plane, w: number, h: number, sigma: number): Plane {
  const n = w * h, jxx = new Float32Array(n), jyy = new Float32Array(n), jxy = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xm = x > 0 ? i - 1 : i, xp = x < w - 1 ? i + 1 : i, ym = y > 0 ? i - w : i, yp = y < h - 1 ? i + w : i;
      const gx = Y[xp] - Y[xm], gy = Y[yp] - Y[ym];
      jxx[i] = gx * gx;
      jyy[i] = gy * gy;
      jxy[i] = gx * gy;
    }
  const a = gaussian(jxx, w, h, sigma), b = gaussian(jyy, w, h, sigma), c = gaussian(jxy, w, h, sigma);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.5 * Math.atan2(2 * c[i], a[i] - b[i]) + Math.PI / 2;
  return out;
}

function painterly(img: RGBA8, s: number, seed: number, progress?: Progress): RGBA8 {
  const { width: w, height: h, data: d } = img, n = w * h;
  const abs = abstraction(img, s * 0.6, 2);
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = 0.299 * abs[0][i] + 0.587 * abs[1][i] + 0.114 * abs[2][i];
  const theta = tangents(Y, w, h, Math.max(1, s * 0.8));
  // The canvas starts as a soft underpainting.
  const canvas = abs.map((p) => gaussian(p, w, h, s * 0.8));
  const sizes = s >= 3 ? [s, s * 0.5] : [s];
  for (let pass = 0; pass < sizes.length; pass++) {
    checkCancelled(progress);
    const size = sizes[pass], grid = Math.max(1, size * 0.85);
    const ref = pass === 0 ? abs.map((p) => gaussian(p, w, h, size * 0.35)) : abs;
    const strokes: { x: number; y: number; k: number }[] = [];
    for (let gy = grid / 2; gy < h; gy += grid)
      for (let gx = grid / 2; gx < w; gx += grid) {
        const jx = (hash01(seed + pass, gx | 0, gy | 0) - 0.5) * grid, jy = (hash01(seed + pass + 7, gx | 0, gy | 0) - 0.5) * grid;
        const x = clamp(Math.round(gx + jx), 0, w - 1), y = clamp(Math.round(gy + jy), 0, h - 1);
        if (pass > 0) {
          // Fine strokes only where the canvas still differs from the detail.
          const i = y * w + x;
          const err = Math.abs(canvas[0][i] - ref[0][i]) + Math.abs(canvas[1][i] - ref[1][i]) + Math.abs(canvas[2][i] - ref[2][i]);
          if (err < 0.06) continue;
        }
        strokes.push({ x, y, k: hash01(seed + 31, x, y + pass * 7919) });
      }
    strokes.sort((p, q) => p.k - q.k);
    const half = Math.max(0.6, size / 2);
    const bristles = new Float32Array(Math.ceil(half * 4) + 4);
    for (const st of strokes) {
      const i0 = st.y * w + st.x, t = theta[i0];
      const len = size * (1.6 + 1.6 * st.k), ux = Math.cos(t), uy = Math.sin(t);
      const col = [ref[0][i0], ref[1][i0], ref[2][i0]];
      const ax = st.x - (ux * len) / 2, ay = st.y - (uy * len) / 2;
      const x0 = Math.max(0, Math.floor(Math.min(ax, ax + ux * len) - half - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, ax + ux * len) + half + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, ay + uy * len) - half - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, ay + uy * len) + half + 1));
      // Bristle streaks: brightness varies across the stroke.
      const nb = Math.ceil(half * 4) + 4;
      for (let k = 0; k < nb; k++) bristles[k] = (hash01(seed + 3, k, st.x * 31 + st.y) - 0.5) * 0.06;
      const outer = (half + 0.7) * (half + 0.7);
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x - ax, py = y - ay;
          const along = clamp(px * ux + py * uy, 0, len);
          const dx = px - ux * along, dy = py - uy * along, d2 = dx * dx + dy * dy;
          if (d2 >= outer) continue;
          const cov = smoothstep(half + 0.7, half - 0.7, Math.sqrt(d2)) * 0.92;
          const across = dx * -uy + dy * ux;
          const bristle = bristles[clamp(Math.round(across * 2 + half * 2) + 1, 0, nb - 1)];
          const i = y * w + x;
          for (let c = 0; c < 3; c++) canvas[c][i] += (col[c] + bristle - canvas[c][i]) * cov;
        }
    }
  }
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(d.length) };
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out.data[j] = canvas[0][i] * 255;
    out.data[j + 1] = canvas[1][i] * 255;
    out.data[j + 2] = canvas[2][i] * 255;
    out.data[j + 3] = d[j + 3];
  }
  return out;
}

/** Difference-of-Gaussians lines (Winnemöller, Olsen and Gooch, "Real-time
 * video abstraction", SIGGRAPH 2006): 1 on paper, falling toward 0 on the
 * darker side of edges; flat areas stay paper whatever their tone. */
function dogLines(Y: Plane, w: number, h: number, sigma: number, tau: number, phi: number): Plane {
  const g1 = gaussian(Y, w, h, sigma), g2 = gaussian(Y, w, h, sigma * 1.6);
  const out = new Float32Array(Y.length);
  for (let i = 0; i < out.length; i++) {
    const d = (g1[i] - tau * g2[i]) / 255;
    out[i] = d > 0 ? 1 : Math.max(0, 1 + Math.tanh(phi * d));
  }
  return out;
}

/** Lines of the darkest channel response, so edges between colors of equal
 * brightness are drawn too. */
function colorLines(img: RGBA8, pre: number, sigma: number, tau: number, phi: number): Plane {
  const { width: w, height: h, data: d } = img, n = w * h;
  let out: Plane | undefined;
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = d[i * 4 + c];
    const l = dogLines(gaussian(ch, w, h, pre), w, h, sigma, tau, phi);
    if (!out) out = l;
    else for (let i = 0; i < n; i++) if (l[i] < out[i]) out[i] = l[i];
  }
  return out!;
}

function ink(img: RGBA8, s: number): RGBA8 {
  const { width: w, height: h, data: d } = img, n = w * h;
  const Y = gaussian(lumaOf(img), w, h, Math.max(0.8, s * 0.2));
  const lines = colorLines(img, Math.max(0.8, s * 0.2), Math.max(0.9, s * 0.2), 0.97, 60);
  const wash = gaussian(Y, w, h, Math.max(1, s * 0.8));
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(d.length) };
  const inkC = [26, 26, 34];
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // A soft two-tone wash under the lines: light areas stay paper.
    const t = wash[i] / 255;
    const tone = 1 - 0.3 * (1 - smoothstep(0.3, 0.55, t)) - 0.22 * (1 - smoothstep(0.08, 0.28, t));
    const v = lines[i] * tone;
    for (let c = 0; c < 3; c++) out.data[j + c] = inkC[c] + (PAPER[c] - inkC[c]) * v;
    out.data[j + 3] = d[j + 3];
  }
  return out;
}

/** Average of a plane along 45° lines over 2L + 1 pixels (prefix sums along
 * each diagonal, so the cost does not depend on L). `rising` is the "/" direction. */
function diagonalMean(p: Plane, w: number, h: number, L: number, rising: boolean): Plane {
  const out = new Float32Array(p.length);
  const cum = new Float64Array(Math.max(w, h) + 1);
  for (let c = 0; c < w + h - 1; c++) {
    // Cells of diagonal c, in order of x.
    const x0 = rising ? Math.max(0, c - h + 1) : Math.max(0, c - (h - 1)), x1 = rising ? Math.min(w - 1, c) : Math.min(w - 1, c - (h - 1) + h - 1);
    const at = (x: number) => (rising ? (c - x) * w + x : (x - (c - (h - 1))) * w + x);
    const m = x1 - x0 + 1;
    cum[0] = 0;
    for (let k = 0; k < m; k++) cum[k + 1] = cum[k] + p[at(x0 + k)];
    for (let k = 0; k < m; k++) {
      const lo = Math.max(0, k - L), hi = Math.min(m - 1, k + L);
      out[at(x0 + k)] = (cum[hi + 1] - cum[lo]) / (hi - lo + 1);
    }
  }
  return out;
}

function pencil(img: RGBA8, s: number, seed: number): RGBA8 {
  const { width: w, height: h, data: d } = img, n = w * h;
  const Y = gaussian(lumaOf(img), w, h, Math.max(0.6, s * 0.12));
  const lines = colorLines(img, Math.max(0.6, s * 0.12), Math.max(0.7, s * 0.16), 0.975, 22);
  const tone = gaussian(Y, w, h, Math.max(1, s * 0.5));
  // Hatching: noise streaked along the diagonals; strokes are a little wider
  // than a pixel so they read as graphite rather than grain.
  const noise = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) noise[y * w + x] = hash01(seed, x, y);
  const wide = gaussian(noise, w, h, Math.max(0.5, s * 0.08));
  const L = Math.max(3, Math.round(s * 2.5));
  const hatchA = diagonalMean(wide, w, h, L, true), hatchB = diagonalMean(wide, w, h, L, false);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += hatchA[i];
  mean /= n;
  let dev = 0;
  for (let i = 0; i < n; i += 7) dev += (hatchA[i] - mean) ** 2;
  const sd = Math.sqrt(dev / Math.ceil(n / 7)) || 1;
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(d.length) };
  const lead = [62, 62, 68];
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const dark = 1 - tone[i] / 255;
    // Stroke coverage grows with darkness; the darkest areas get cross-hatching.
    const za = (hatchA[i] - mean) / sd, zb = (hatchB[i] - mean) / sd;
    const density = smoothstep(0.28, 0.9, dark), cross = smoothstep(0.6, 0.95, dark);
    const a = za > 2.4 - 3.2 * density ? 0.55 + 0.45 * (1 - density) : 1;
    const b = zb > 2.4 - 3.2 * cross ? 0.6 : 1;
    const x = i % w, y = (i - x) / w;
    const paper = 0.97 + 0.03 * hash01(seed + 5, x >> 1, y >> 1);
    const v = Math.min(lines[i], a * b) * paper;
    for (let k = 0; k < 3; k++) out.data[j + k] = lead[k] + (PAPER[k] - lead[k]) * v;
    out.data[j + 3] = d[j + 3];
  }
  return out;
}

function watercolor(img: RGBA8, s: number, seed: number): RGBA8 {
  const { width: w, height: h, data: d } = img, n = w * h;
  const abs = abstraction(img, Math.max(1, s * 0.8), 3);
  // Wobble: displace lookups by smooth noise so region boundaries meander.
  const cell = Math.max(4, s * 3), amp = Math.max(0.5, s * 0.35);
  const smoothNoise = (x: number, y: number, k: number) => {
    const fx = x / cell, fy = y / cell, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const a = hash01(seed + k, x0, y0), b = hash01(seed + k, x0 + 1, y0), c = hash01(seed + k, x0, y0 + 1), e = hash01(seed + k, x0 + 1, y0 + 1);
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return (a + (b - a) * sx) * (1 - sy) + (c + (e - c) * sx) * sy - 0.5;
  };
  const wob = abs.map(() => new Float32Array(n));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = clamp(Math.round(x + smoothNoise(x, y, 1) * 2 * amp), 0, w - 1), sy = clamp(Math.round(y + smoothNoise(x, y, 2) * 2 * amp), 0, h - 1);
      const q = sy * w + sx, i = y * w + x;
      for (let c = 0; c < 3; c++) wob[c][i] = abs[c][q];
    }
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = 0.299 * wob[0][i] + 0.587 * wob[1][i] + 0.114 * wob[2][i];
  const blurY = gaussian(Y, w, h, Math.max(0.8, s * 0.25));
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(d.length) };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = blurY[Math.min(w - 1, x + 1) + y * w] - blurY[Math.max(0, x - 1) + y * w];
      const gy = blurY[x + Math.min(h - 1, y + 1) * w] - blurY[x + Math.max(0, y - 1) * w];
      const edge = smoothstep(0.02, 0.12, Math.hypot(gx, gy));
      const gran = 0.9 + 0.2 * (hash01(seed + 9, x, y) * 0.4 + smoothNoise(x * 3, y * 3, 4) + 0.3);
      const j = i * 4;
      for (let c = 0; c < 3; c++) {
        // Pigment density: transparent washes, darker at edges, grainy on paper.
        const pigment = clamp((1 - wob[c][i]) * 0.85 * (1 + 0.45 * edge) * gran, 0, 1);
        out.data[j + c] = (PAPER[c] / 255) * (1 - pigment) * 255;
      }
      out.data[j + 3] = d[j + 3];
    }
  return out;
}

function print(img: RGBA8, s: number): RGBA8 {
  const { width: w, height: h, data: d } = img;
  const cell = Math.max(2, s);
  const screens = [
    { angle: 15, color: [0, 158, 219] },
    { angle: 75, color: [222, 30, 125] },
    { angle: 0, color: [255, 222, 0] },
    { angle: 45, color: [35, 31, 32] },
  ].map((x) => ({ ...x, cos: Math.cos((x.angle * Math.PI) / 180), sin: Math.sin((x.angle * Math.PI) / 180) }));
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(d.length) };
  const aa = 1 / cell;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = i * 4;
      const c = 1 - d[j] / 255, m = 1 - d[j + 1] / 255, ye = 1 - d[j + 2] / 255;
      const k = Math.min(c, m, ye) * 0.85;
      const cov = [c - k, m - k, ye - k].map((v) => clamp(v / Math.max(0.15, 1 - k), 0, 1));
      cov.push(k);
      let r = PAPER[0], g = PAPER[1], b = PAPER[2];
      for (let q = 0; q < 4; q++) {
        const sc = screens[q];
        const u = (x * sc.cos + y * sc.sin) / cell, v = (-x * sc.sin + y * sc.cos) / cell;
        const du = u - Math.floor(u) - 0.5, dv = v - Math.floor(v) - 0.5;
        const dist = Math.hypot(du, dv), radius = Math.sqrt(cov[q] / Math.PI);
        const ink = smoothstep(radius + aa, radius - aa, dist);
        if (ink <= 0) continue;
        r *= 1 - ink * (1 - sc.color[0] / 255);
        g *= 1 - ink * (1 - sc.color[1] / 255);
        b *= 1 - ink * (1 - sc.color[2] / 255);
      }
      out.data[j] = r;
      out.data[j + 1] = g;
      out.data[j + 2] = b;
      out.data[j + 3] = d[j + 3];
    }
  return out;
}

/** Render a classic style (mix with the original by strength afterwards). */
export function stylize(img: RGBA8, o: StyleOptions, progress?: Progress): RGBA8 {
  const s = Math.max(1, o.brush * o.scale), seed = o.seed ?? 5;
  switch (o.style) {
    case 'painterly':
      return painterly(img, s, seed, progress);
    case 'ink':
      return ink(img, s);
    case 'pencil':
      return pencil(img, s, seed);
    case 'watercolor':
      return watercolor(img, s, seed);
    case 'print':
      return print(img, s);
  }
}
