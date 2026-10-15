// Per-pixel sequencer math (CPU implementation, unit tested). The GPU compositor
// (gpu.ts) implements the same formulas in GLSL. Values are display-referred sRGB in 0..1, the
// sequencer's working space; RGBA tuples are premultiplied unless named "straight".
// Expected values are in tests/unit/sequencer.test.ts.
import type { BlendType, ColorBalanceData } from './types';

export type RGBA = [number, number, number, number];
export type RGB = [number, number, number];

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function rgbToHsv(r: number, g: number, b: number): RGB {
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-12) {
    if (mx === r) h = (g - b) / d;
    else if (mx === g) h = 2 + (b - r) / d;
    else h = 4 + (r - g) / d;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, mx > 0 ? d / mx : 0, mx];
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s),
    q = v * (1 - f * s),
    t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

/** Separable blend of one channel (straight values). */
export function blendChannel(mode: BlendType, b: number, t: number): number {
  switch (mode) {
    case 'DARKEN':
      return Math.min(b, t);
    case 'LIGHTEN':
      return Math.max(b, t);
    case 'MULTIPLY':
      return b * t;
    case 'SCREEN':
      return 1 - (1 - b) * (1 - t);
    case 'ADD':
      return b + t;
    case 'SUBTRACT':
      return b - t;
    case 'BURN':
      return t <= 0 ? 0 : clamp01(1 - (1 - b) / t);
    case 'LINEAR_BURN':
      return Math.max(0, b + t - 1);
    case 'DODGE':
      return t >= 1 ? (b > 0 ? 1 : 0) : clamp01(b / (1 - t));
    case 'OVERLAY':
      return b <= 0.5 ? 2 * b * t : 1 - 2 * (1 - b) * (1 - t);
    case 'SOFT_LIGHT': {
      const scr = 1 - (1 - t) * (1 - b);
      return (1 - b) * t * b + b * scr;
    }
    case 'HARD_LIGHT':
      return t > 0.5 ? 1 - (1 - b) * (1 - (2 * t - 1)) : b * 2 * t;
    case 'VIVID_LIGHT':
      return t > 0.5 ? blendChannel('DODGE', b, 2 * (t - 0.5)) : blendChannel('BURN', b, 2 * t);
    case 'LINEAR_LIGHT':
      return b + 2 * t - 1;
    case 'PIN_LIGHT':
      return t > 0.5 ? Math.max(b, 2 * t - 1) : Math.min(b, 2 * t);
    case 'DIFFERENCE':
      return Math.abs(b - t);
    case 'EXCLUSION':
      return b + t - 2 * b * t;
    default:
      return t;
  }
}

/** Blend function B(bottom, top) on straight colours (separable and HSV modes). */
export function blendColor(mode: BlendType, b: RGB, t: RGB): RGB {
  switch (mode) {
    case 'HUE':
    case 'SATURATION':
    case 'COLOR':
    case 'VALUE': {
      const hb = rgbToHsv(b[0], b[1], b[2]);
      const ht = rgbToHsv(t[0], t[1], t[2]);
      if (mode === 'HUE') return ht[1] > 0 ? hsvToRgb(ht[0], hb[1], hb[2]) : [...b];
      if (mode === 'SATURATION') return hb[1] > 0 ? hsvToRgb(hb[0], ht[1], hb[2]) : [...b];
      if (mode === 'COLOR') return ht[1] > 0 ? hsvToRgb(ht[0], ht[1], hb[2]) : [...b];
      return hsvToRgb(hb[0], hb[1], ht[2]);
    }
  }
  return [blendChannel(mode, b[0], t[0]), blendChannel(mode, b[1], t[1]), blendChannel(mode, b[2], t[2])];
}

/** Modes that mix opacity (the others keep the alpha of the image underneath). */
export const ALPHA_MODES = new Set<BlendType>(['REPLACE', 'CROSS', 'ALPHA_OVER', 'ALPHA_UNDER', 'GAMMA_CROSS']);

/** Composite a strip (top) over the image below (bottom) with a blend mode and opacity `fac`. */
export function blendPixel(mode: BlendType, bottom: RGBA, top: RGBA, fac: number): RGBA {
  const [br, bg, bb, ba] = bottom;
  const [tr, tg, tb, ta] = top;
  switch (mode) {
    case 'REPLACE':
      return [tr * fac, tg * fac, tb * fac, ta * fac];
    case 'CROSS':
      return [br + (tr - br) * fac, bg + (tg - bg) * fac, bb + (tb - bb) * fac, ba + (ta - ba) * fac];
    case 'ALPHA_OVER': {
      const k = 1 - ta * fac;
      return [tr * fac + br * k, tg * fac + bg * k, tb * fac + bb * k, ta * fac + ba * k];
    }
    case 'ALPHA_UNDER': {
      const k = fac * (1 - ba);
      return [br + tr * k, bg + tg * k, bb + tb * k, ba + ta * k];
    }
    case 'GAMMA_CROSS':
      return gammaCross(bottom, top, fac);
  }
  if (ba <= 0) return [br, bg, bb, ba];
  const bs: RGB = [br / ba, bg / ba, bb / ba];
  const ts: RGB = ta > 0 ? [tr / ta, tg / ta, tb / ta] : [0, 0, 0];
  const f = fac * ta;
  const c = blendColor(mode, bs, ts);
  return [clamp01(bs[0] + (c[0] - bs[0]) * f) * ba, clamp01(bs[1] + (c[1] - bs[1]) * f) * ba, clamp01(bs[2] + (c[2] - bs[2]) * f) * ba, ba];
}

/** Cross-fade in a gamma 2 space (squares of mixed square roots), premultiplied in/out. */
export function gammaCross(a: RGBA, b: RGBA, fac: number): RGBA {
  const alpha = a[3] + (b[3] - a[3]) * fac;
  const out: RGBA = [0, 0, 0, alpha];
  for (let i = 0; i < 3; i++) {
    const sa = a[3] > 0 ? Math.sqrt(Math.max(0, a[i] / a[3])) : 0;
    const sb = b[3] > 0 ? Math.sqrt(Math.max(0, b[i] / b[3])) : 0;
    const v = sa + (sb - sa) * fac;
    out[i] = v * v * alpha;
  }
  return out;
}

/** Two-input effect strips (input 1, input 2, factor). */
export function effectPixel(type: string, in1: RGBA, in2: RGBA, fac: number): RGBA {
  switch (type) {
    case 'CROSS':
      return blendPixel('CROSS', in1, in2, fac);
    case 'GAMMA_CROSS':
      return gammaCross(in1, in2, fac);
    case 'ADD':
      return [in1[0] + in2[0] * fac, in1[1] + in2[1] * fac, in1[2] + in2[2] * fac, in1[3]].map(clamp01) as RGBA;
    case 'SUBTRACT':
      return [in1[0] - in2[0] * fac, in1[1] - in2[1] * fac, in1[2] - in2[2] * fac, in1[3]].map(clamp01) as RGBA;
    case 'MULTIPLY': {
      const s: RGB = in2[3] > 0 ? [in2[0] / in2[3], in2[1] / in2[3], in2[2] / in2[3]] : [0, 0, 0];
      return [in1[0] * (1 - fac + s[0] * fac), in1[1] * (1 - fac + s[1] * fac), in1[2] * (1 - fac + s[2] * fac), in1[3]];
    }
    case 'ALPHA_OVER':
      // input 1 over input 2
      return blendPixel('ALPHA_OVER', in2, in1, fac);
    case 'ALPHA_UNDER':
      // input 1 under input 2
      return blendPixel('ALPHA_OVER', in1, in2, fac);
  }
  return in1;
}

// ---------------------------------------------------------------------------
// wipe

/**
 * Wipe transition mask at pixel (x, y) (integer pixel coordinates, y up) of a W×H frame: 0 shows
 * input 1, 1 shows input 2. SINGLE starts at the top edge (angle 0), DOUBLE opens from the centre
 * line, IRIS from the centre point (direction IN reverses those), CLOCK sweeps from 3 o'clock —
 * counter-clockwise for OUT, clockwise for IN.
 */
export function wipeMask(x: number, y: number, W: number, H: number, fac: number, type: 'SINGLE' | 'DOUBLE' | 'IRIS' | 'CLOCK', dir: 'OUT' | 'IN', angle: number, blur: number): number {
  const px = x - W / 2,
    py = y - H / 2;
  const inv = dir === 'IN';
  if (type === 'CLOCK') {
    // counter-clockwise angle from 3 o'clock in [0, 2π); clockwise sweeps use (0, 2π]
    let a = Math.atan2(py, px) - (inv ? -angle : angle);
    a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (inv) a = 2 * Math.PI - a;
    const s = a / (2 * Math.PI);
    const soft = blur * 0.5;
    return soft > 0 ? 1 - smooth(fac - soft, fac + soft, s) : s < fac ? 1 : 0;
  }
  const f = inv ? 1 - fac : fac;
  let s: number, range: number;
  const dx = -Math.sin(angle),
    dy = Math.cos(angle); // angle 0 → the line moves down from the top
  if (type === 'SINGLE') {
    const half = (Math.abs(dx) * W + Math.abs(dy) * H) / 2;
    s = (px * dx + py * dy + half) / (2 * half); // 0 at the far edge, 1 at the starting edge
    range = 1;
    const edge = 1 - f; // revealed where s > edge
    const soft = (blur * range) / 2;
    const m = soft > 0 ? smooth(edge - soft, edge + soft, s) : s > edge ? 1 : 0;
    return inv ? 1 - m : m;
  }
  if (type === 'DOUBLE') {
    const half = (Math.abs(dx) * W + Math.abs(dy) * H) / 2;
    s = Math.abs(px * dx + py * dy) / half; // 0 at the centre line
    const soft = blur / 2;
    const m = soft > 0 ? 1 - smooth(f - soft, f + soft, s) : s < f ? 1 : 0;
    return inv ? 1 - m : m;
  }
  // IRIS
  const rmax = Math.hypot(W / 2, H / 2);
  s = Math.hypot(px, py) / rmax;
  const soft = blur / 2;
  const m = soft > 0 ? 1 - smooth(f - soft, f + soft, s) : s < f ? 1 : 0;
  return inv ? 1 - m : m;
}

function smooth(a: number, b: number, x: number) {
  const t = clamp01((x - a) / (b - a || 1e-9));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// colour correction (straight colours)

export function colorBalance(c: RGB, cb: ColorBalanceData, multiply = 1): RGB {
  const out: RGB = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let v = c[i];
    if (cb.correction_method === 'OFFSET_POWER_SLOPE') {
      const slope = cb.invert_slope ? 1 / (cb.slope[i] || 1e-6) : cb.slope[i];
      const offset = cb.invert_offset ? -(cb.offset[i] - 1) : cb.offset[i] - 1;
      const power = cb.invert_power ? cb.power[i] : 1 / (cb.power[i] || 1e-6);
      v = Math.pow(Math.max(0, v * slope + offset), power);
    } else {
      const lift = cb.invert_lift ? 2 - cb.lift[i] : cb.lift[i];
      const gain = cb.invert_gain ? 1 / (cb.gain[i] || 1e-6) : cb.gain[i];
      const gamma = cb.invert_gamma ? cb.gamma[i] : 1 / (cb.gamma[i] || 1e-6);
      v = v + (lift - 1) * (1 - v);
      v = Math.pow(Math.max(0, v * gain), gamma);
    }
    out[i] = v * multiply;
  }
  return out;
}

/** Brightness/contrast modifier (bright and contrast in -100..100 style units). */
export function brightContrastParams(bright: number, contrast: number): [number, number] {
  const br = bright / 100;
  const delta = contrast / 200;
  if (contrast > 0) {
    const a = 1 / Math.max(1e-6, 1 - 2 * delta);
    return [a, a * (br - delta)];
  }
  const d = -delta;
  const a = Math.max(0, 1 - 2 * d);
  return [a, a * br + d];
}

export function brightContrast(c: RGB, bright: number, contrast: number): RGB {
  const [a, b] = brightContrastParams(bright, contrast);
  return [c[0] * a + b, c[1] * a + b, c[2] * a + b];
}

/** Strip colour adjustments: saturation (HSV) then multiply. */
export function stripColor(c: RGB, saturation: number, multiply: number): RGB {
  let o = c;
  if (saturation !== 1) {
    const [h, s, v] = rgbToHsv(c[0], c[1], c[2]);
    o = hsvToRgb(h, Math.max(0, s * saturation), v);
  }
  return [o[0] * multiply, o[1] * multiply, o[2] * multiply];
}

// ---------------------------------------------------------------------------
// glow

/** Glow highlight extraction for one straight colour (before blurring). */
export function glowSource(c: RGB, threshold: number, clamp: number, boost: number): RGB {
  const i = Math.max(c[0], c[1], c[2]);
  const k = Math.min(clamp, Math.max(0, i - threshold)) * boost;
  return [c[0] * k, c[1] * k, c[2] * k];
}
