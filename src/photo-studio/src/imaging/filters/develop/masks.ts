// Develop local adjustments: up to four masks, each a linear gradient, a
// radial gradient or brush strokes, with its own exposure, contrast,
// highlights, shadows, temperature, tint and saturation. Geometry is in
// coordinates normalized to the image (so previews of reduced copies match
// the full render); brush strokes are polylines whose points carry the brush
// radius (relative to the image's longer side) in `t`, negative for erasing.
//
// Masks are evaluated in the output frame (after geometry corrections) and
// applied in linear light after the global tone and color work.
import type { NormPath, ParamValues } from '../../types';
import { bool, num, str } from '../sampling';
import { wbGains } from './auto';
import { KB, KG, KR } from './color';
import { MASK_SLOTS, type MaskType } from './params';
import { PERCEPTUAL } from './tone';

export { MASK_ADJUST, MASK_SLOTS, maskKeys, maskSpecs } from './params';

export type Mask = {
  n: number;
  type: Exclude<MaskType, 'off'>;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  feather: number;
  amount: number;
  invert: boolean;
  strokes: NormPath[];
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  temperature: number;
  tint: number;
  saturation: number;
};

export function readMask(p: ParamValues, n: number): Mask | undefined {
  const k = (s: string) => `mask${n}${s}`;
  const type = str(p, k('Type'), 'off') as MaskType;
  if (type === 'off') return undefined;
  const strokes = Array.isArray(p[k('Strokes')]) ? (p[k('Strokes')] as NormPath[]) : [];
  return {
    n,
    type,
    ax: num(p, k('Ax'), 0.5),
    ay: num(p, k('Ay'), 0.3),
    bx: num(p, k('Bx'), 0.5),
    by: num(p, k('By'), 0.7),
    feather: num(p, k('Feather'), 50) / 100,
    amount: num(p, k('Amount'), 100) / 100,
    invert: bool(p, k('Invert'), false),
    strokes,
    exposure: num(p, k('Exposure'), 0),
    contrast: num(p, k('Contrast'), 0) / 100,
    highlights: num(p, k('Highlights'), 0) / 100,
    shadows: num(p, k('Shadows'), 0) / 100,
    temperature: num(p, k('Temperature'), 0),
    tint: num(p, k('Tint'), 0),
    saturation: num(p, k('Saturation'), 0) / 100,
  };
}
/** Masks that change something. */
export function activeMasks(p: ParamValues): Mask[] {
  const out: Mask[] = [];
  for (let n = 1; n <= MASK_SLOTS; n++) {
    const m = readMask(p, n);
    if (!m || m.amount <= 0) continue;
    if (
      !m.exposure &&
      !m.contrast &&
      !m.highlights &&
      !m.shadows &&
      !m.temperature &&
      !m.tint &&
      !m.saturation
    )
      continue;
    if (m.type === 'brush' && !m.strokes.length && !m.invert) continue;
    out.push(m);
  }
  return out;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Mask weights of row y of a w x h image (gradients only; brush masks use
 * `brushRaster`). */
export function gradientRow(m: Mask, y: number, w: number, h: number, out: Float32Array) {
  const v = (y + 0.5) / h;
  if (m.type === 'linear') {
    // Full effect at A, none at B, smooth in between.
    const dx = m.bx - m.ax,
      dy = m.by - m.ay,
      len2 = Math.max(1e-9, dx * dx + dy * dy);
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      out[x] = 1 - smooth(((u - m.ax) * dx + (v - m.ay) * dy) / len2);
    }
  } else {
    // Ellipse centered at A with radii |B - A| along x and y; feather
    // widens the soft edge inward.
    // A degenerate radius (settings given without an end point) is a quarter of the image.
    const rad = (d: number) => (Math.abs(d) < 0.005 ? 0.25 : Math.abs(d));
    const rx = rad(m.bx - m.ax),
      ry = rad(m.by - m.ay),
      inner = 1 - Math.max(0.02, m.feather);
    const dyn = (v - m.ay) / ry;
    for (let x = 0; x < w; x++) {
      const dxn = ((x + 0.5) / w - m.ax) / rx,
        d = Math.sqrt(dxn * dxn + dyn * dyn);
      out[x] = 1 - smooth((d - inner) / (1 - inner));
    }
  }
}

/** Brush strokes rasterized at w x h (0..255): soft round dabs along each
 * stroke, adding with their maximum, erasing where the radius is negative. */
export function brushRaster(m: Mask, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const long = Math.max(w, h);
  const hard = 1 - Math.max(0.05, m.feather);
  for (const stroke of m.strokes) {
    if (!stroke.length) continue;
    const erase = (stroke[0].t ?? 0.02) < 0;
    const dab = (cx: number, cy: number, r: number) => {
      const x0 = Math.max(0, Math.floor(cx - r)),
        x1 = Math.min(w - 1, Math.ceil(cx + r)),
        y0 = Math.max(0, Math.floor(cy - r)),
        y1 = Math.min(h - 1, Math.ceil(cy + r));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
          if (d >= 1) continue;
          const a = Math.round(255 * (1 - smooth((d - hard) / (1 - hard))));
          const i = y * w + x;
          if (erase) out[i] = Math.max(0, out[i] - a);
          else if (a > out[i]) out[i] = a;
        }
    };
    let prev: { x: number; y: number; r: number } | undefined;
    for (const p of stroke) {
      const r = Math.max(0.5, Math.abs(p.t ?? 0.02) * long);
      const cur = { x: p.x * w, y: p.y * h, r };
      if (!prev) dab(cur.x, cur.y, cur.r);
      else {
        // Dabs every quarter radius between points.
        const dist = Math.hypot(cur.x - prev.x, cur.y - prev.y),
          steps = Math.max(1, Math.ceil(dist / Math.max(0.5, Math.min(prev.r, cur.r) / 4)));
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          dab(
            prev.x + (cur.x - prev.x) * t,
            prev.y + (cur.y - prev.y) * t,
            prev.r + (cur.r - prev.r) * t,
          );
        }
      }
      prev = cur;
    }
  }
  return out;
}

/** Per-mask work for the pixel loop: weights per row and the adjustment. */
export type LocalMask = {
  m: Mask;
  raster?: Uint8Array;
  row: Float32Array;
  gains: Float32Array; // 65 steps of weight x RGB gain (exposure and white balance)
  tone: Float32Array | null; // perceptual luminance curve, 1024 steps
};
export function prepareMasks(p: ParamValues, w: number, h: number): LocalMask[] {
  return activeMasks(p).map((m) => {
    const gains = new Float32Array(65 * 3);
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      const g = wbGains(m.temperature * t, m.tint * t),
        e = Math.pow(2, m.exposure * t);
      gains[i * 3] = g[0] * e;
      gains[i * 3 + 1] = g[1] * e;
      gains[i * 3 + 2] = g[2] * e;
    }
    let tone: Float32Array | null = null;
    if (m.contrast || m.highlights || m.shadows) {
      tone = new Float32Array(1025);
      const gm = Math.pow(2, 0.8 * m.contrast),
        mid = Math.pow(0.18, PERCEPTUAL);
      let prev = 0;
      for (let i = 0; i <= 1024; i++) {
        const x = i / 1024;
        let y =
          x <= mid
            ? mid * Math.pow(x / mid, gm)
            : 1 - (1 - mid) * Math.pow((1 - x) / (1 - mid), gm);
        y += (m.shadows > 0 ? 1.6 : 0.95) * m.shadows * x * (1 - x) ** 3;
        y += (m.highlights > 0 ? 1.6 : 0.95) * m.highlights * x ** 3 * (1 - x);
        y = Math.max(prev, Math.min(1, Math.max(0, y)));
        tone[i] = prev = y;
      }
    }
    return {
      m,
      raster: m.type === 'brush' ? brushRaster(m, w, h) : undefined,
      row: new Float32Array(w),
      gains,
      tone,
    };
  });
}
/** Fill each mask's weights for row y (with invert and amount). */
export function maskRows(masks: LocalMask[], y: number, w: number, h: number) {
  for (const l of masks) {
    const { m, row } = l;
    if (l.raster) for (let x = 0, i = y * w; x < w; x++, i++) row[x] = l.raster[i] / 255;
    else gradientRow(m, y, w, h, row);
    if (m.invert || m.amount !== 1)
      for (let x = 0; x < w; x++) row[x] = (m.invert ? 1 - row[x] : row[x]) * m.amount;
  }
}
/** Apply one mask's adjustment with weight `wt` to a linear pixel in place. */
export function applyLocal(l: LocalMask, wt: number, rgb: Float64Array) {
  const gi = wt * 64,
    i = Math.min(63, gi | 0),
    f = gi - i,
    g = l.gains,
    o = i * 3;
  let r = rgb[0] * (g[o] + (g[o + 3] - g[o]) * f),
    gg = rgb[1] * (g[o + 1] + (g[o + 4] - g[o + 1]) * f),
    b = rgb[2] * (g[o + 2] + (g[o + 5] - g[o + 2]) * f);
  if (l.tone) {
    const Y = KR * r + KG * gg + KB * b;
    if (Y > 1e-7) {
      const L = Math.pow(Math.min(1, Y), PERCEPTUAL),
        ti = L * 1024,
        j = Math.min(1023, ti | 0),
        Lt = l.tone[j] + (l.tone[j + 1] - l.tone[j]) * (ti - j),
        L2 = L + (Lt - L) * wt,
        k = Math.pow(L2, 1 / PERCEPTUAL) / Math.min(1, Y);
      r *= k;
      gg *= k;
      b *= k;
    }
  }
  if (l.m.saturation) {
    const Y = KR * r + KG * gg + KB * b,
      s = Math.max(0, 1 + l.m.saturation * wt);
    r = Y + (r - Y) * s;
    gg = Y + (gg - Y) * s;
    b = Y + (b - Y) * s;
  }
  rgb[0] = r;
  rgb[1] = gg;
  rgb[2] = b;
}
