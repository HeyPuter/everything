// Style Transfer (creative looks), all procedural and deterministic:
// - Painterly: edge-aware abstraction, then brush strokes laid in two passes
//   (large, then small where detail differs), each stroke following the local
//   edge direction from the structure tensor (after Hertzmann, "Painterly
//   Rendering with Curved Brush Strokes of Multiple Sizes", SIGGRAPH 1998).
// - Ink: extended difference-of-Gaussians lines (Winnemöller, Kyprianidis
//   and Olsen, "XDoG", Computers & Graphics 2012) with a light ink wash.
// - Pencil: soft XDoG lines over diagonal hatching whose density follows tone.
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
    for (const st of strokes) {
      const i0 = st.y * w + st.x, t = theta[i0];
      const len = size * (1.6 + 1.6 * st.k), ux = Math.cos(t), uy = Math.sin(t);
      const col = [ref[0][i0], ref[1][i0], ref[2][i0]];
      const ax = st.x - (ux * len) / 2, ay = st.y - (uy * len) / 2;
      const x0 = Math.max(0, Math.floor(Math.min(ax, ax + ux * len) - half - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, ax + ux * len) + half + 1));
      const y0 = Math.max(0, Math.floor(Math.min(ay, ay + uy * len) - half - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, ay + uy * len) + half + 1));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x - ax, py = y - ay;
          const along = clamp(px * ux + py * uy, 0, len);
          const dx = px - ux * along, dy = py - uy * along, dist = Math.hypot(dx, dy);
          const cov = smoothstep(half + 0.7, half - 0.7, dist) * 0.92;
          if (cov <= 0) continue;
          // Bristle streaks: brightness varies across the stroke.
          const across = dx * -uy + dy * ux;
          const bristle = (hash01(seed + 3, Math.round(across * 2 + half * 2), st.x * 31 + st.y) - 0.5) * 0.06;
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

/** XDoG edge image in [0, 1] (1 = paper, 0 = ink). */
export function xdog(Y: Plane, w: number, h: number, sigma: number, phi: number, eps: number, p = 20): Plane {
  const g1 = gaussian(Y, w, h, sigma), g2 = gaussian(Y, w, h, sigma * 1.6);
  const out = new Float32Array(Y.length);
  for (let i = 0; i < out.length; i++) {
    const u = ((1 + p) * g1[i] - p * g2[i]) / 255;
    out[i] = u >= eps ? 1 : clamp(1 + Math.tanh(phi * (u - eps)), 0, 1);
  }
  return out;
}

function ink(img: RGBA8, s: number): RGBA8 {
  const { width: w, height: h, data: d } = img, n = w * h;
  const Y = lumaOf(img);
  const sm = gaussian(Y, w, h, Math.max(0.5, s * 0.15));
  const lines = xdog(sm, w, h, Math.max(0.6, s * 0.18), 18, 0.42);
  const wash = gaussian(Y, w, h, Math.max(1, s * 0.6));
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(d.length) };
  const inkC = [26, 26, 34];
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // Light wash in three tones under the lines.
    const t = wash[i] / 255, tone = t > 0.66 ? 1 : t > 0.33 ? 0.82 : 0.6;
    const v = lines[i] * tone;
    for (let c = 0; c < 3; c++) out.data[j + c] = inkC[c] + (PAPER[c] - inkC[c]) * v;
    out.data[j + 3] = d[j + 3];
  }
  return out;
}

function pencil(img: RGBA8, s: number, seed: number): RGBA8 {
  const { width: w, height: h, data: d } = img, n = w * h;
  const Y = lumaOf(img);
  const lines = xdog(gaussian(Y, w, h, Math.max(0.4, s * 0.1)), w, h, Math.max(0.5, s * 0.12), 6, 0.5);
  const tone = gaussian(Y, w, h, Math.max(1, s * 0.5));
  // Diagonal hatching: noise averaged along a 45° line.
  const L = Math.max(2, Math.round(s * 2.5));
  const noise = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) noise[y * w + x] = hash01(seed, x, y);
  const out: RGBA8 = { width: w, height: h, data: new Uint8ClampedArray(d.length) };
  const lead = [58, 58, 62];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let sum = 0, c = 0;
      for (let k = -L; k <= L; k += 1) {
        const xx = x + k, yy = y - k;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        sum += noise[yy * w + xx];
        c++;
      }
      const streak = (sum / Math.max(1, c) - 0.5) * Math.sqrt(c) * 0.9 + 0.5;
      const dark = 1 - tone[i] / 255;
      const hatch = streak < dark * 0.95 ? 0.35 + 0.65 * (1 - dark) : 1;
      const paper = 0.97 + 0.03 * hash01(seed + 5, x >> 1, y >> 1);
      const v = Math.min(lines[i], hatch) * paper;
      const j = i * 4;
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
