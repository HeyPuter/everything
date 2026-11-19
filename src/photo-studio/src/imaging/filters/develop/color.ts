// Develop color stages, all on linear RGB:
// - hue bands: eight overlapping bands whose weights sum to one at every hue,
//   so a band slider fades smoothly into its neighbors;
// - the Color Mixer as a per-hue table of hue rotation, saturation and
//   luminance, weighted by how colorful a pixel is so grays stay put;
// - the gray mix that converts to black and white by color;
// - Color Grading as luminance-dependent channel gains (a table over the
//   perceptual luminance);
// - Calibration as a 3x3 matrix that rotates and saturates the primaries
//   while keeping neutrals neutral.
import type { ParamValues } from '../../types';
import { num } from '../sampling';
import { BANDS } from './params';

export const KR = 0.2126,
  KG = 0.7152,
  KB = 0.0722;

/** HSV hue of an RGB triple in degrees [0, 360); 0 for grays. */
export function hueOf(r: number, g: number, b: number): number {
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b,
    mn = r < g ? (r < b ? r : b) : g < b ? g : b,
    c = mx - mn;
  if (c <= 0) return 0;
  let h: number;
  if (mx === r) h = (g - b) / c;
  else if (mx === g) h = (b - r) / c + 2;
  else h = (r - g) / c + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
/** Weight of each band at `hue` (degrees). Neighboring bands cross-fade with
 * a smoothstep between their centers; the weights always sum to one. */
export function bandWeights(hue: number, out = new Float64Array(BANDS.length)): Float64Array {
  out.fill(0);
  const h = ((hue % 360) + 360) % 360;
  const n = BANDS.length;
  for (let k = 0; k < n; k++) {
    const a = BANDS[k].hue,
      b = k + 1 < n ? BANDS[k + 1].hue : 360;
    if (h >= a && h < b) {
      const t = smooth((h - a) / (b - a));
      out[k] = 1 - t;
      out[(k + 1) % n] += t;
      break;
    }
  }
  return out;
}

/** Rotation about the gray axis by `deg` degrees (row-major 3x3). */
export function hueRotation(deg: number): Float64Array {
  const t = (deg * Math.PI) / 180,
    c = Math.cos(t),
    s = Math.sin(t),
    k = 1 / Math.sqrt(3),
    o = (1 - c) / 3;
  return Float64Array.of(
    c + o,
    o - k * s,
    o + k * s,
    o + k * s,
    c + o,
    o - k * s,
    o - k * s,
    o + k * s,
    c + o,
  );
}

export type MixerTable = {
  // Per degree: hue rotation (degrees), saturation factor, luminance exponent (stops).
  hue: Float32Array;
  sat: Float32Array;
  lum: Float32Array;
  active: boolean;
};
// Largest hue rotation of one band at ±100.
const MAX_SHIFT = 30;

export function mixerTable(p: ParamValues): MixerTable {
  const hue = new Float32Array(361),
    sat = new Float32Array(361),
    lum = new Float32Array(361);
  const hv = BANDS.map((b) => num(p, `hue${b.id}`, 0) / 100),
    sv = BANDS.map((b) => num(p, `sat${b.id}`, 0) / 100),
    lv = BANDS.map((b) => num(p, `lum${b.id}`, 0) / 100);
  const active = [...hv, ...sv, ...lv].some((v) => v !== 0);
  const w = new Float64Array(BANDS.length);
  for (let d = 0; d <= 360; d++) {
    bandWeights(d, w);
    let a = 0,
      s = 0,
      l = 0;
    for (let k = 0; k < BANDS.length; k++) {
      a += w[k] * hv[k];
      s += w[k] * sv[k];
      l += w[k] * lv[k];
    }
    hue[d] = a * MAX_SHIFT;
    sat[d] = Math.max(0, 1 + s);
    lum[d] = l * 1.2;
  }
  return { hue, sat, lum, active };
}

/** How strongly a pixel counts as colored (0 gray .. 1 saturated). */
export function colorfulness(r: number, g: number, b: number): number {
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b,
    mn = r < g ? (r < b ? r : b) : g < b ? g : b;
  if (mx <= 1e-6) return 0;
  const s = (mx - mn) / mx;
  return s >= 0.4 ? 1 : smooth(s / 0.4);
}

/** Apply the mixer to one linear pixel in place (rgb is a 3-array). */
export function mixPixel(t: MixerTable, rgb: Float64Array | number[]) {
  const r = rgb[0],
    g = rgb[1],
    b = rgb[2];
  const c = colorfulness(r, g, b);
  if (c <= 0) return;
  const h = hueOf(r, g, b),
    i = h | 0,
    f = h - i;
  const dh = (t.hue[i] + (t.hue[i + 1] - t.hue[i]) * f) * c,
    sf = 1 + (t.sat[i] + (t.sat[i + 1] - t.sat[i]) * f - 1) * c,
    le = (t.lum[i] + (t.lum[i + 1] - t.lum[i]) * f) * c;
  const Y0 = KR * r + KG * g + KB * b;
  let R = r,
    G = g,
    B = b;
  if (dh !== 0) {
    // Rotation about the gray axis, written out (see hueRotation).
    const a = (dh * Math.PI) / 180,
      cs = Math.cos(a),
      ks = Math.sin(a) / Math.sqrt(3),
      o = ((1 - cs) / 3) * (r + g + b);
    R = cs * r + o + ks * (b - g);
    G = cs * g + o + ks * (r - b);
    B = cs * b + o + ks * (g - r);
    // Keep the luminance a rotation would change.
    const Y1 = KR * R + KG * G + KB * B;
    if (Y1 > 1e-7) {
      const k = Y0 / Y1;
      R *= k;
      G *= k;
      B *= k;
    }
  }
  if (sf !== 1) {
    R = Y0 + (R - Y0) * sf;
    G = Y0 + (G - Y0) * sf;
    B = Y0 + (B - Y0) * sf;
  }
  if (le !== 0) {
    const k = Math.pow(2, le);
    R *= k;
    G *= k;
    B *= k;
  }
  rgb[0] = R;
  rgb[1] = G;
  rgb[2] = B;
}

/** Gray-mix table: per degree, the stops by which that color brightens in
 * black and white. */
export function grayTable(p: ParamValues): { lum: Float32Array; active: boolean } {
  const lum = new Float32Array(361);
  const gv = BANDS.map((b) => num(p, `gray${b.id}`, 0) / 100);
  const w = new Float64Array(BANDS.length);
  for (let d = 0; d <= 360; d++) {
    bandWeights(d, w);
    let l = 0;
    for (let k = 0; k < BANDS.length; k++) l += w[k] * gv[k];
    lum[d] = l * 1.5;
  }
  return { lum, active: gv.some((v) => v !== 0) };
}
/** Black-and-white luminance of a linear pixel with the gray mix. */
export function grayOf(
  t: { lum: Float32Array; active: boolean },
  r: number,
  g: number,
  b: number,
): number {
  const Y = KR * r + KG * g + KB * b;
  if (!t.active) return Y;
  const c = colorfulness(r, g, b);
  if (c <= 0) return Y;
  const h = hueOf(r, g, b),
    i = h | 0,
    l = t.lum[i] + (t.lum[i + 1] - t.lum[i]) * (h - i);
  return Y * Math.pow(2, l * c);
}

/** Unit chroma direction of a hue: the hue's pure color minus its luminance,
 * scaled so its largest component is one. */
export function hueDirection(deg: number): [number, number, number] {
  const h = (((deg % 360) + 360) % 360) / 60,
    x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] =
    h < 1
      ? [1, x, 0]
      : h < 2
        ? [x, 1, 0]
        : h < 3
          ? [0, 1, x]
          : h < 4
            ? [0, x, 1]
            : h < 5
              ? [x, 0, 1]
              : [1, 0, x];
  const Y = KR * r + KG * g + KB * b;
  const v: [number, number, number] = [r - Y, g - Y, b - Y];
  const m = Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  return [v[0] / m, v[1] / m, v[2] / m];
}

/** Weights of the shadows, midtones and highlights wheels at perceptual
 * luminance L in [0, 1]. Balance moves the split between shadows and
 * highlights; Blending widens the overlap. They sum to one. */
export function gradeWeights(
  L: number,
  blending: number,
  balance: number,
): [number, number, number] {
  const pivot = 0.5 - 0.3 * balance,
    width = 0.12 + 0.55 * blending,
    lo = pivot - 0.18,
    hi = pivot + 0.18;
  const ramp = (x: number, c: number) => {
    const t = (x - (c - width / 2)) / width;
    return t <= 0 ? 0 : t >= 1 ? 1 : smooth(t);
  };
  const ws = 1 - ramp(L, lo),
    wh = ramp(L, hi),
    wm = Math.max(0, 1 - ws - wh);
  return [ws, wm, wh];
}

export type GradeTable = { gains: Float32Array; n: number; active: boolean };
/** Channel gains over perceptual luminance for Color Grading. */
export function gradeTable(p: ParamValues, n = 256): GradeTable {
  const wheels = ['Shadow', 'Midtone', 'Highlight', 'Global'].map((id) => ({
    dir: hueDirection(num(p, `grade${id}Hue`, 0)),
    sat: num(p, `grade${id}Sat`, 0) / 100,
    lum: num(p, `grade${id}Lum`, 0) / 100,
  }));
  const blending = num(p, 'gradeBlending', 50) / 100,
    balance = num(p, 'gradeBalance', 0) / 100;
  const active = wheels.some((w) => w.sat !== 0 || w.lum !== 0);
  const gains = new Float32Array((n + 1) * 3);
  for (let i = 0; i <= n; i++) {
    const [ws, wm, wh] = gradeWeights(i / n, blending, balance);
    const wt = [ws, wm, wh, 1];
    for (let c = 0; c < 3; c++) {
      let e = 0;
      for (let k = 0; k < 4; k++)
        e += wt[k] * (wheels[k].sat * 0.9 * wheels[k].dir[c] + wheels[k].lum * 0.8);
      gains[i * 3 + c] = Math.pow(2, e);
    }
  }
  return { gains, n, active };
}

/** Calibration matrix (row-major) on linear RGB, or null at defaults. Each
 * primary is rotated about the gray axis (±100 = ±30°) and its saturation
 * scaled; rows are then normalized so white maps to white. */
export function calibrationMatrix(p: ParamValues): Float64Array | null {
  const ids = ['Red', 'Green', 'Blue'];
  const hue = ids.map((id) => num(p, `cal${id}Hue`, 0) / 100),
    sat = ids.map((id) => num(p, `cal${id}Sat`, 0) / 100);
  if (hue.every((v) => v === 0) && sat.every((v) => v === 0)) return null;
  const cols: number[][] = [];
  for (let c = 0; c < 3; c++) {
    const e = [0, 0, 0];
    e[c] = 1;
    const m = hueRotation(hue[c] * 30);
    let v = [m[c], m[3 + c], m[6 + c]];
    const Y = KR * v[0] + KG * v[1] + KB * v[2];
    v = v.map((x) => Y + (x - Y) * (1 + sat[c] * 0.6));
    cols.push(v);
  }
  const M = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    const white = cols[0][r] + cols[1][r] + cols[2][r];
    for (let c = 0; c < 3; c++) M[r * 3 + c] = white > 1e-6 ? cols[c][r] / white : r === c ? 1 : 0;
  }
  return M;
}
