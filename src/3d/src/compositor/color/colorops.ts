// Per-pixel colour operations of the compositor colour nodes. Every function exists twice: a
// TypeScript version (single values, unit tests against expected values) and the GLSL version in COLOR_GLSL used by the GPU passes. Both operate on
// premultiplied scene-linear RGBA (no un-premultiplication).

export type RGBA = [number, number, number, number];
export type RGB = [number, number, number];

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const mixf = (a: number, b: number, t: number) => a + (b - a) * t;
export const luma = (c: ArrayLike<number>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ---------------------------------------------------------------------------
// HSV / HSL (hue in [0, 1); conversions keep out-of-range values)

export function rgbToHsv(r: number, g: number, b: number): RGB {
  let k = 0;
  if (g < b) {
    [g, b] = [b, g];
    k = -1;
  }
  let minGB = b;
  if (r < g) {
    [r, g] = [g, r];
    k = -2 / 6 - k;
    minGB = Math.min(g, b);
  }
  const chroma = r - minGB;
  const h = Math.abs(k + (g - b) / (6 * chroma + 1e-20));
  const s = chroma / (r + 1e-20);
  return [h, s, r];
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  if (s === 0) return [v, v, v];
  const h6 = h === 1 ? 0 : h * 6;
  const i = Math.floor(h6);
  const f = h6 - i;
  const p = v * (1 - s),
    q = v * (1 - s * f),
    t = v * (1 - s * (1 - f));
  switch (i) {
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

export function rgbToHsl(r: number, g: number, b: number): RGB {
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b);
  const l = Math.min((mx + mn) / 2, 1);
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const nr = clamp(Math.abs(h * 6 - 3) - 1, 0, 1),
    ng = clamp(2 - Math.abs(h * 6 - 2), 0, 1),
    nb = clamp(2 - Math.abs(h * 6 - 4), 0, 1);
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  return [(nr - 0.5) * chroma + l, (ng - 0.5) * chroma + l, (nb - 0.5) * chroma + l];
}

// ---------------------------------------------------------------------------
// YCbCr (0..1 scaled 8-bit code values) and YUV (BT.709)

export type YccMode = 'ITUBT601' | 'ITUBT709' | 'JFIF';

export function rgbToYcc(r: number, g: number, b: number, mode: YccMode): RGB {
  let y: number, cb: number, cr: number;
  if (mode === 'ITUBT601') {
    y = 16 + 65.481 * r + 128.553 * g + 24.966 * b;
    cb = 128 - 37.797 * r - 74.203 * g + 112 * b;
    cr = 128 + 112 * r - 93.786 * g - 18.214 * b;
  } else if (mode === 'ITUBT709') {
    y = 16 + 46.559 * r + 156.629 * g + 15.812 * b;
    cb = 128 - 25.664 * r - 86.336 * g + 112 * b;
    cr = 128 + 112 * r - 101.73 * g - 10.27 * b;
  } else {
    y = 255 * (0.299 * r + 0.587 * g + 0.114 * b);
    cb = 128 + 255 * (-0.16874 * r - 0.33126 * g + 0.5 * b);
    cr = 128 + 255 * (0.5 * r - 0.41869 * g - 0.08131 * b);
  }
  return [y / 255, cb / 255, cr / 255];
}

export function yccToRgb(y: number, cb: number, cr: number, mode: YccMode): RGB {
  y *= 255;
  cb = cb * 255 - 128;
  cr = cr * 255 - 128;
  let r: number, g: number, b: number;
  if (mode === 'ITUBT601') {
    const yy = 1.164 * (y - 16);
    r = yy + 1.596 * cr;
    g = yy - 0.813 * cr - 0.392 * cb;
    b = yy + 2.017 * cb;
  } else if (mode === 'ITUBT709') {
    const yy = 1.164 * (y - 16);
    r = yy + 1.793 * cr;
    g = yy - 0.534 * cr - 0.213 * cb;
    b = yy + 2.115 * cb;
  } else {
    r = y + 1.402 * cr;
    g = y - 0.34414 * cb - 0.71414 * cr;
    b = y + 1.772 * cb;
  }
  return [r / 255, g / 255, b / 255];
}

export function rgbToYuv(r: number, g: number, b: number): RGB {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [y, -0.09991 * r - 0.33609 * g + 0.436 * b, 0.615 * r - 0.55861 * g - 0.05639 * b];
}

export function yuvToRgb(y: number, u: number, v: number): RGB {
  return [y + 1.28033 * v, y - 0.21482 * u - 0.38059 * v, y + 2.12798 * u];
}

export type ColorMode = 'RGB' | 'HSV' | 'HSL' | 'YCC' | 'YUV';

export function separateColor(c: RGBA, mode: ColorMode, ycc: YccMode = 'ITUBT709'): RGBA {
  const [r, g, b, a] = c;
  switch (mode) {
    case 'HSV':
      return [...rgbToHsv(r, g, b), a];
    case 'HSL':
      return [...rgbToHsl(r, g, b), a];
    case 'YCC':
      return [...rgbToYcc(r, g, b, ycc), a];
    case 'YUV':
      return [...rgbToYuv(r, g, b), a];
    default:
      return [r, g, b, a];
  }
}

export function combineColor(c: RGBA, mode: ColorMode, ycc: YccMode = 'ITUBT709'): RGBA {
  const [x, y, z, a] = c;
  switch (mode) {
    case 'HSV':
      return [...hsvToRgb(x, y, z), a];
    case 'HSL':
      return [...hslToRgb(x, y, z), a];
    case 'YCC':
      return [...yccToRgb(x, y, z, ycc), a];
    case 'YUV':
      return [...yuvToRgb(x, y, z), a];
    default:
      return [x, y, z, a];
  }
}

// ---------------------------------------------------------------------------
// Adjust nodes

/** Brightness/Contrast: both in percent (-100..100), applied to premultiplied RGB. */
export function brightContrast(c: RGBA, bright: number, contrast: number): RGBA {
  const { a, b } = brightContrastCoefficients(bright, contrast);
  return [c[0] * a + b, c[1] * a + b, c[2] * a + b, c[3]];
}

export function brightContrastCoefficients(bright: number, contrast: number) {
  const br = bright / 100;
  let d = contrast / 200;
  let a: number, b: number;
  if (contrast > 0) {
    a = 1 / Math.max(1e-6, 1 - 2 * d);
    b = a * (br - d);
  } else {
    d = -d;
    a = Math.max(0, 1 - 2 * d);
    b = a * (br + d);
  }
  return { a, b };
}

export function exposure(c: RGBA, ev: number): RGBA {
  const m = Math.pow(2, ev);
  return [c[0] * m, c[1] * m, c[2] * m, c[3]];
}

export function gamma(c: RGBA, g: number): RGBA {
  const f = (x: number) => (x > 0 ? Math.pow(x, g) : x);
  return [f(c[0]), f(c[1]), f(c[2]), c[3]];
}

export function invert(c: RGBA, fac: number, color: boolean, alpha: boolean): RGBA {
  return [color ? mixf(c[0], 1 - c[0], fac) : c[0], color ? mixf(c[1], 1 - c[1], fac) : c[1], color ? mixf(c[2], 1 - c[2], fac) : c[2], alpha ? mixf(c[3], 1 - c[3], fac) : c[3]];
}

export function hueSatVal(c: RGBA, hue: number, sat: number, val: number, fac: number): RGBA {
  const hsv = rgbToHsv(c[0], c[1], c[2]);
  let h = hsv[0] + hue - 0.5;
  h -= Math.floor(h);
  const rgb = hsvToRgb(h, hsv[1] * sat, hsv[2] * val);
  return [mixf(c[0], Math.max(0, rgb[0]), fac), mixf(c[1], Math.max(0, rgb[1]), fac), mixf(c[2], Math.max(0, rgb[2]), fac), c[3]];
}

/** Lift/Gamma/Gain with combined lift (additive), gamma and gain (multiplicative) per channel. */
export function liftGammaGain(c: RGBA, lift: RGB, gam: RGB, gain: RGB, fac: number): RGBA {
  const out: RGBA = [0, 0, 0, c[3]];
  for (let i = 0; i < 3; i++) {
    const x = ((c[i] - 1) * (1 - lift[i]) + 1) * gain[i];
    const g = Math.max(gam[i], 1e-6);
    out[i] = mixf(c[i], Math.pow(Math.max(x, 0), 1 / g), fac);
  }
  return out;
}

/** ASC-CDL offset/power/slope. */
export function offsetPowerSlope(c: RGBA, offset: RGB, power: RGB, slope: RGB, fac: number): RGBA {
  const out: RGBA = [0, 0, 0, c[3]];
  for (let i = 0; i < 3; i++) out[i] = mixf(c[i], Math.pow(Math.max(c[i] * slope[i] + offset[i], 0), power[i]), fac);
  return out;
}

/** Combine the base value and colour of a Color Balance parameter. */
export function balanceParams(kind: 'lift' | 'gamma' | 'gain' | 'offset' | 'power' | 'slope', base: number, color: ArrayLike<number>): RGB {
  const f = (i: number) => (kind === 'lift' ? base + color[i] - 1 : kind === 'offset' ? base + color[i] : base * color[i]);
  return [f(0), f(1), f(2)];
}

// ---------------------------------------------------------------------------
// White point (chromatic adaptation between two illuminants given as temperature + tint)

/** Planckian locus chromaticity (Kim et al. cubic spline approximation, 1667 K–25000 K). */
function planckXY(T: number): [number, number] {
  const x = T <= 4000 ? -0.2661239e9 / T ** 3 - 0.234358e6 / T ** 2 + 0.8776956e3 / T + 0.17991 : -3.0258469e9 / T ** 3 + 2.1070379e6 / T ** 2 + 0.2226347e3 / T + 0.24039;
  const y =
    T <= 2222
      ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : T <= 4000
        ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

const xyToUv = (x: number, y: number): [number, number] => {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (6 * y) / d];
};

/**
 * CIE 1931 xy of an illuminant given by a colour temperature and a tint: the Planckian point is
 * moved perpendicular to the locus in CIE 1960 uv by tint / 3000 (positive tint = magenta).
 * Bradford adaptation (expected values in the tests).
 */
export function illuminantXY(temperature: number, tint: number): [number, number] {
  const T = clamp(temperature, 1667, 25000);
  let [u, v] = xyToUv(...planckXY(T));
  const [u2, v2] = xyToUv(...planckXY(T * 1.001));
  const du = u2 - u,
    dv = v2 - v;
  const len = Math.hypot(du, dv) || 1;
  const k = tint / 3000;
  u += (dv / len) * k;
  v += (-du / len) * k;
  const dd = 2 * u - 8 * v + 4;
  return [(3 * u) / dd, (2 * v) / dd];
}

// Rec.709 ↔ XYZ (D65) and the Bradford cone response
const RGB2XYZ = [0.4123908, 0.3575843, 0.1804808, 0.212639, 0.7151687, 0.0721923, 0.0193308, 0.1191948, 0.9505322];
const XYZ2RGB = [3.2409699, -1.5373832, -0.4986108, -0.9692436, 1.8759675, 0.0415551, 0.0556301, -0.203977, 1.0569715];
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const BRADFORD_INV = [0.9869929, -0.1470543, 0.1599627, 0.4323053, 0.5183603, 0.0492912, -0.0085287, 0.0400428, 0.9684867];

function mul3(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
}
function mulv(m: number[], v: number[]): number[] {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** Row-major 3×3 matrix adapting colours seen under the input illuminant to the output illuminant. */
export function whitePointMatrix(inTemp: number, inTint: number, outTemp: number, outTint: number): number[] {
  const white = (t: number, n: number) => {
    const [x, y] = illuminantXY(t, n);
    return [x / y, 1, (1 - x - y) / y];
  };
  const src = mulv(BRADFORD, white(inTemp, inTint)),
    dst = mulv(BRADFORD, white(outTemp, outTint));
  const D = [dst[0] / src[0], 0, 0, 0, dst[1] / src[1], 0, 0, 0, dst[2] / src[2]];
  return mul3(XYZ2RGB, mul3(BRADFORD_INV, mul3(D, mul3(BRADFORD, RGB2XYZ))));
}

export function whitePoint(c: RGBA, m: number[], fac: number): RGBA {
  const o = mulv(m, [c[0], c[1], c[2]]);
  return [mixf(c[0], o[0], fac), mixf(c[1], o[1], fac), mixf(c[2], o[2], fac), c[3]];
}

// ---------------------------------------------------------------------------
// Mix (colour blending)

export const BLEND_MODES = [
  'MIX',
  'DARKEN',
  'MULTIPLY',
  'BURN',
  'LIGHTEN',
  'SCREEN',
  'DODGE',
  'ADD',
  'OVERLAY',
  'SOFT_LIGHT',
  'LINEAR_LIGHT',
  'DIFFERENCE',
  'EXCLUSION',
  'SUBTRACT',
  'DIVIDE',
  'HUE',
  'SATURATION',
  'COLOR',
  'VALUE',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

/** Blend B over A (RGB) with factor f; the alpha of A is kept except for MIX (alpha mixed). */
export function blend(mode: BlendMode, f: number, A: RGBA, B: RGBA): RGBA {
  const fm = 1 - f;
  const a = [A[0], A[1], A[2]],
    b = [B[0], B[1], B[2]];
  const r: number[] = [...a];
  const each = (fn: (x: number, y: number) => number) => {
    for (let i = 0; i < 3; i++) r[i] = fn(a[i], b[i]);
  };
  switch (mode) {
    case 'MIX':
      each((x, y) => fm * x + f * y);
      return [r[0], r[1], r[2], fm * A[3] + f * B[3]];
    case 'ADD':
      each((x, y) => x + f * y);
      break;
    case 'SUBTRACT':
      each((x, y) => x - f * y);
      break;
    case 'MULTIPLY':
      each((x, y) => x * (fm + f * y));
      break;
    case 'SCREEN':
      each((x, y) => 1 - (fm + f * (1 - y)) * (1 - x));
      break;
    case 'DIVIDE':
      each((x, y) => (y !== 0 ? fm * x + (f * x) / y : x));
      break;
    case 'DIFFERENCE':
      each((x, y) => fm * x + f * Math.abs(x - y));
      break;
    case 'EXCLUSION':
      each((x, y) => fm * x + f * (x + y - 2 * x * y));
      break;
    case 'DARKEN':
      each((x, y) => fm * x + f * Math.min(x, y));
      break;
    case 'LIGHTEN':
      each((x, y) => fm * x + f * Math.max(x, y));
      break;
    case 'OVERLAY':
      each((x, y) => (x < 0.5 ? x * (fm + 2 * f * y) : 1 - (fm + 2 * f * (1 - y)) * (1 - x)));
      break;
    case 'DODGE':
      each((x, y) => {
        if (x === 0) return x;
        const t = 1 - f * y;
        if (t <= 0) return 1;
        return Math.min(1, x / t);
      });
      break;
    case 'BURN':
      each((x, y) => {
        const t = fm + f * y;
        if (t <= 0) return 0;
        return clamp(1 - (1 - x) / t, 0, 1);
      });
      break;
    case 'SOFT_LIGHT':
      each((x, y) => {
        const scr = 1 - (1 - y) * (1 - x);
        return fm * x + f * ((1 - x) * y * x + x * scr);
      });
      break;
    case 'LINEAR_LIGHT':
      each((x, y) => x + f * (2 * y - 1));
      break;
    case 'HUE': {
      const hb = rgbToHsv(b[0], b[1], b[2]);
      if (hb[1] !== 0) {
        const ha = rgbToHsv(a[0], a[1], a[2]);
        const t = hsvToRgb(hb[0], ha[1], ha[2]);
        for (let i = 0; i < 3; i++) r[i] = fm * a[i] + f * t[i];
      }
      break;
    }
    case 'SATURATION': {
      const ha = rgbToHsv(a[0], a[1], a[2]);
      if (ha[1] !== 0) {
        const hb = rgbToHsv(b[0], b[1], b[2]);
        const t = hsvToRgb(ha[0], fm * ha[1] + f * hb[1], ha[2]);
        for (let i = 0; i < 3; i++) r[i] = t[i];
      }
      break;
    }
    case 'COLOR': {
      const hb = rgbToHsv(b[0], b[1], b[2]);
      if (hb[1] !== 0) {
        const ha = rgbToHsv(a[0], a[1], a[2]);
        const t = hsvToRgb(hb[0], hb[1], ha[2]);
        for (let i = 0; i < 3; i++) r[i] = fm * a[i] + f * t[i];
      }
      break;
    }
    case 'VALUE': {
      const ha = rgbToHsv(a[0], a[1], a[2]);
      const hb = rgbToHsv(b[0], b[1], b[2]);
      const t = hsvToRgb(ha[0], ha[1], fm * ha[2] + f * hb[2]);
      for (let i = 0; i < 3; i++) r[i] = t[i];
      break;
    }
  }
  return [r[0], r[1], r[2], A[3]];
}

export function mixColor(mode: BlendMode, fac: number, A: RGBA, B: RGBA, clampFactor: boolean, clampResult: boolean): RGBA {
  const f = clampFactor ? clamp(fac, 0, 1) : fac;
  const r = blend(mode, f, A, B);
  if (clampResult) for (let i = 0; i < 4; i++) r[i] = clamp(r[i], 0, 1);
  return r;
}

// ---------------------------------------------------------------------------
// Alpha

export type AlphaOverType = 'Over' | 'Disjoint Over' | 'Conjoint Over';

export function alphaOver(bg: RGBA, fg: RGBA, fac: number, type: AlphaOverType, straight: boolean): RGBA {
  const f: RGBA = straight ? [fg[0] * fg[3], fg[1] * fg[3], fg[2] * fg[3], fg[3]] : [...fg];
  let r: RGBA;
  if (type === 'Disjoint Over') {
    const k = bg[3] !== 0 ? clamp((1 - f[3]) / bg[3], 0, 1) : 0;
    r = [f[0] + bg[0] * k, f[1] + bg[1] * k, f[2] + bg[2] * k, f[3] + bg[3] * k];
  } else if (type === 'Conjoint Over') {
    if (f[3] >= bg[3]) r = [...f];
    else {
      const k = 1 - f[3] / bg[3];
      r = [f[0] + bg[0] * k, f[1] + bg[1] * k, f[2] + bg[2] * k, f[3] + bg[3] * k];
    }
  } else {
    const k = 1 - f[3];
    r = [f[0] + bg[0] * k, f[1] + bg[1] * k, f[2] + bg[2] * k, f[3] + bg[3] * k];
  }
  return [mixf(bg[0], r[0], fac), mixf(bg[1], r[1], fac), mixf(bg[2], r[2], fac), mixf(bg[3], r[3], fac)];
}

export function setAlpha(c: RGBA, alpha: number, type: 'Apply Mask' | 'Replace Alpha'): RGBA {
  return type === 'Replace Alpha' ? [c[0], c[1], c[2], alpha] : [c[0] * alpha, c[1] * alpha, c[2] * alpha, c[3] * alpha];
}

export function alphaConvert(c: RGBA, type: 'To Premultiplied' | 'To Straight'): RGBA {
  if (type === 'To Premultiplied') return [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
  return c[3] !== 0 ? [c[0] / c[3], c[1] / c[3], c[2] / c[3], c[3]] : [...c];
}

export function posterize(c: RGBA, steps: number): RGBA {
  const s = clamp(steps, 2, 1024);
  return [Math.floor(c[0] * s) / s, Math.floor(c[1] * s) / s, Math.floor(c[2] * s) / s, c[3]];
}

/** Depth combine of two premultiplied colours (the nearer one in front). */
export function zCombine(a: RGBA, za: number, b: RGBA, zb: number, useAlpha: boolean): { color: RGBA; depth: number } {
  const aFront = za < zb;
  const front = aFront ? a : b,
    back = aFront ? b : a;
  const depth = Math.min(za, zb);
  if (!useAlpha) return { color: [...front], depth };
  const t = front[3];
  return {
    color: [mixf(back[0], front[0], t), mixf(back[1], front[1], t), mixf(back[2], front[2], t), Math.max(front[3], back[3])],
    depth,
  };
}

// ---------------------------------------------------------------------------
// GLSL mirror (compositor GLSL library chunks)

export const COLOR_GLSL: Record<string, { code: string; deps?: string[] }> = {
  cmp_hsv: {
    code: /* glsl */ `
vec3 cmp_rgb2hsv(vec3 c) {
  float r = c.r, g = c.g, b = c.b, k = 0.0;
  if (g < b) { float t = g; g = b; b = t; k = -1.0; }
  float mingb = b;
  if (r < g) { float t = r; r = g; g = t; k = -2.0 / 6.0 - k; mingb = min(g, b); }
  float chroma = r - mingb;
  return vec3(abs(k + (g - b) / (6.0 * chroma + 1e-20)), chroma / (r + 1e-20), r);
}
vec3 cmp_hsv2rgb(vec3 hsv) {
  float h = hsv.x, s = hsv.y, v = hsv.z;
  if (s == 0.0) return vec3(v);
  float h6 = h == 1.0 ? 0.0 : h * 6.0;
  float i = floor(h6), f = h6 - i;
  float p = v * (1.0 - s), q = v * (1.0 - s * f), t = v * (1.0 - s * (1.0 - f));
  if (i == 0.0) return vec3(v, t, p);
  if (i == 1.0) return vec3(q, v, p);
  if (i == 2.0) return vec3(p, v, t);
  if (i == 3.0) return vec3(p, q, v);
  if (i == 4.0) return vec3(t, p, v);
  return vec3(v, p, q);
}
vec3 cmp_rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = min((mx + mn) * 0.5, 1.0);
  if (mx == mn) return vec3(0.0, 0.0, l);
  float d = mx - mn;
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h / 6.0, s, l);
}
vec3 cmp_hsl2rgb(vec3 c) {
  float h6 = c.x * 6.0;
  vec3 n = clamp(vec3(abs(h6 - 3.0) - 1.0, 2.0 - abs(h6 - 2.0), 2.0 - abs(h6 - 4.0)), 0.0, 1.0);
  float chroma = (1.0 - abs(2.0 * c.z - 1.0)) * c.y;
  return (n - 0.5) * chroma + c.z;
}
`,
  },
  cmp_ycc: {
    code: /* glsl */ `
vec3 cmp_rgb2ycc(vec3 c, int mode) {
  vec3 o;
  if (mode == 0) o = vec3(16.0 + dot(c, vec3(65.481, 128.553, 24.966)), 128.0 + dot(c, vec3(-37.797, -74.203, 112.0)), 128.0 + dot(c, vec3(112.0, -93.786, -18.214)));
  else if (mode == 1) o = vec3(16.0 + dot(c, vec3(46.559, 156.629, 15.812)), 128.0 + dot(c, vec3(-25.664, -86.336, 112.0)), 128.0 + dot(c, vec3(112.0, -101.73, -10.27)));
  else o = vec3(255.0 * dot(c, vec3(0.299, 0.587, 0.114)), 128.0 + 255.0 * dot(c, vec3(-0.16874, -0.33126, 0.5)), 128.0 + 255.0 * dot(c, vec3(0.5, -0.41869, -0.08131)));
  return o / 255.0;
}
vec3 cmp_ycc2rgb(vec3 c, int mode) {
  float y = c.x * 255.0, cb = c.y * 255.0 - 128.0, cr = c.z * 255.0 - 128.0;
  vec3 o;
  if (mode == 0) { float yy = 1.164 * (y - 16.0); o = vec3(yy + 1.596 * cr, yy - 0.813 * cr - 0.392 * cb, yy + 2.017 * cb); }
  else if (mode == 1) { float yy = 1.164 * (y - 16.0); o = vec3(yy + 1.793 * cr, yy - 0.534 * cr - 0.213 * cb, yy + 2.115 * cb); }
  else o = vec3(y + 1.402 * cr, y - 0.34414 * cb - 0.71414 * cr, y + 1.772 * cb);
  return o / 255.0;
}
vec3 cmp_rgb2yuv(vec3 c) {
  return vec3(dot(c, vec3(0.2126, 0.7152, 0.0722)), dot(c, vec3(-0.09991, -0.33609, 0.436)), dot(c, vec3(0.615, -0.55861, -0.05639)));
}
vec3 cmp_yuv2rgb(vec3 c) {
  return vec3(c.x + 1.28033 * c.z, c.x - 0.21482 * c.y - 0.38059 * c.z, c.x + 2.12798 * c.y);
}
`,
  },
  cmp_blend: {
    deps: ['cmp_hsv'],
    code: /* glsl */ `
float cmp_blend1(int m, float f, float x, float y) {
  float fm = 1.0 - f;
  if (m == 0) return fm * x + f * y;
  if (m == 1) return fm * x + f * min(x, y);
  if (m == 2) return x * (fm + f * y);
  if (m == 3) { float t = fm + f * y; return t <= 0.0 ? 0.0 : clamp(1.0 - (1.0 - x) / t, 0.0, 1.0); }
  if (m == 4) return fm * x + f * max(x, y);
  if (m == 5) return 1.0 - (fm + f * (1.0 - y)) * (1.0 - x);
  if (m == 6) { if (x == 0.0) return x; float t = 1.0 - f * y; return t <= 0.0 ? 1.0 : min(1.0, x / t); }
  if (m == 7) return x + f * y;
  if (m == 8) return x < 0.5 ? x * (fm + 2.0 * f * y) : 1.0 - (fm + 2.0 * f * (1.0 - y)) * (1.0 - x);
  if (m == 9) { float scr = 1.0 - (1.0 - y) * (1.0 - x); return fm * x + f * ((1.0 - x) * y * x + x * scr); }
  if (m == 10) return x + f * (2.0 * y - 1.0);
  if (m == 11) return fm * x + f * abs(x - y);
  if (m == 12) return fm * x + f * (x + y - 2.0 * x * y);
  if (m == 13) return x - f * y;
  if (m == 14) return y != 0.0 ? fm * x + f * x / y : x;
  return x;
}
vec4 cmp_blend(int m, float f, vec4 A, vec4 B) {
  float fm = 1.0 - f;
  vec3 a = A.rgb, b = B.rgb, r = a;
  if (m <= 14) {
    r = vec3(cmp_blend1(m, f, a.r, b.r), cmp_blend1(m, f, a.g, b.g), cmp_blend1(m, f, a.b, b.b));
    if (m == 0) return vec4(r, fm * A.a + f * B.a);
  } else if (m == 15) {
    vec3 hb = cmp_rgb2hsv(b);
    if (hb.y != 0.0) { vec3 ha = cmp_rgb2hsv(a); r = fm * a + f * cmp_hsv2rgb(vec3(hb.x, ha.y, ha.z)); }
  } else if (m == 16) {
    vec3 ha = cmp_rgb2hsv(a);
    if (ha.y != 0.0) { vec3 hb = cmp_rgb2hsv(b); r = cmp_hsv2rgb(vec3(ha.x, fm * ha.y + f * hb.y, ha.z)); }
  } else if (m == 17) {
    vec3 hb = cmp_rgb2hsv(b);
    if (hb.y != 0.0) { vec3 ha = cmp_rgb2hsv(a); r = fm * a + f * cmp_hsv2rgb(vec3(hb.x, hb.y, ha.z)); }
  } else if (m == 18) {
    vec3 ha = cmp_rgb2hsv(a), hb = cmp_rgb2hsv(b);
    r = cmp_hsv2rgb(vec3(ha.x, ha.y, fm * ha.z + f * hb.z));
  }
  return vec4(r, A.a);
}
`,
  },
  cmp_alpha: {
    code: /* glsl */ `
vec4 cmp_alpha_over(vec4 bg, vec4 fg, float fac, int type, bool straight) {
  vec4 f = straight ? vec4(fg.rgb * fg.a, fg.a) : fg;
  vec4 r;
  if (type == 1) { float k = bg.a != 0.0 ? clamp((1.0 - f.a) / bg.a, 0.0, 1.0) : 0.0; r = f + bg * k; }
  else if (type == 2) { r = f.a >= bg.a ? f : f + bg * (1.0 - f.a / bg.a); }
  else r = f + bg * (1.0 - f.a);
  return mix(bg, r, fac);
}
`,
  },
};

export const BLEND_INDEX: Record<string, number> = Object.fromEntries(BLEND_MODES.map((m, i) => [m, i]));
export const YCC_INDEX: Record<string, number> = {
  ITUBT601: 0,
  ITUBT709: 1,
  JFIF: 2,
};
