// CPU-side helpers for color ramps and curve mappings (evaluation + LUT baking), and
// colour helpers shared by the compiler and the UI. Independent implementations.
//
// Storage in NodeData.props (flat arrays so they fit SocketValue):
//   color_ramp:        [pos, r, g, b, a, pos, r, g, b, a, …]
//   ramp_interpolation 'LINEAR' | 'EASE' | 'CARDINAL' | 'B_SPLINE' | 'CONSTANT'
//   ramp_color_mode    'RGB' | 'HSV' | 'HSL'
//   ramp_hue_interpolation 'NEAR' | 'FAR' | 'CW' | 'CCW'
//   curve_<name>:      [x, y, handle, x, y, handle, …]  handle 0 = auto, 1 = vector, 2 = auto clamped
//   curve_extend       'HORIZONTAL' | 'EXTRAPOLATED'
//   black_level / white_level (RGB curves): [r, g, b]
import type { SocketValue } from '../data/types';

export interface RampStop {
  pos: number;
  color: [number, number, number, number];
}

export interface Ramp {
  stops: RampStop[];
  interpolation: string;
  colorMode: string;
  hueInterpolation: string;
}

export function defaultRamp(): Record<string, SocketValue> {
  return {
    color_ramp: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
    ramp_interpolation: 'LINEAR',
    ramp_color_mode: 'RGB',
    ramp_hue_interpolation: 'NEAR',
  };
}

export function readRamp(props: Record<string, SocketValue>): Ramp {
  const flat = (props.color_ramp as number[] | undefined) ?? (defaultRamp().color_ramp as number[]);
  const stops: RampStop[] = [];
  for (let i = 0; i + 4 < flat.length; i += 5)
    stops.push({
      pos: flat[i],
      color: [flat[i + 1], flat[i + 2], flat[i + 3], flat[i + 4]],
    });
  return {
    stops,
    interpolation: (props.ramp_interpolation as string) ?? 'LINEAR',
    colorMode: (props.ramp_color_mode as string) ?? 'RGB',
    hueInterpolation: (props.ramp_hue_interpolation as string) ?? 'NEAR',
  };
}

export function writeRamp(props: Record<string, SocketValue>, stops: RampStop[]) {
  props.color_ramp = stops.flatMap((s) => [s.pos, ...s.color]);
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export function rgbToHsvA(c: number[]): number[] {
  const [r, g, b] = c;
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, mx > 0 ? d / mx : 0, mx, c[3] ?? 1];
}

export function hsvToRgbA(c: number[]): number[] {
  const [h, s, v] = c;
  const hh = (((h % 1) + 1) % 1) * 6;
  const i = Math.floor(hh),
    f = hh - i;
  const p = v * (1 - s),
    q = v * (1 - s * f),
    t = v * (1 - s * (1 - f));
  const rgb = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6];
  return [...rgb, c[3] ?? 1];
}

export function rgbToHslA(c: number[]): number[] {
  const [r, g, b] = c;
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0,
    s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l, c[3] ?? 1];
}

export function hslToRgbA(c: number[]): number[] {
  const [h, s, l] = c;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return s === 0 ? [l, l, l, c[3] ?? 1] : [f(h + 1 / 3), f(h), f(h - 1 / 3), c[3] ?? 1];
}

function lerpHue(a: number, b: number, t: number, mode: string) {
  let d = b - a;
  if (mode === 'NEAR') {
    if (d > 0.5) d -= 1;
    else if (d < -0.5) d += 1;
  } else if (mode === 'FAR') {
    if (d > 0 && d < 0.5) d -= 1;
    else if (d < 0 && d > -0.5) d += 1;
  } else if (mode === 'CW') {
    if (d > 0) d -= 1;
  } else if (mode === 'CCW') {
    if (d < 0) d += 1;
  }
  return (((a + d * t) % 1) + 1) % 1;
}

function mixColors(a: number[], b: number[], t: number, mode: string, hue: string): number[] {
  if (mode === 'RGB') return a.map((x, i) => x + (b[i] - x) * t);
  const to = mode === 'HSV' ? rgbToHsvA : rgbToHslA;
  const from = mode === 'HSV' ? hsvToRgbA : hslToRgbA;
  const A = to(a),
    B = to(b);
  // keep hue of a grey stop from distorting the blend
  if (A[1] === 0) A[0] = B[0];
  if (B[1] === 0) B[0] = A[0];
  return from([lerpHue(A[0], B[0], t, hue), A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t, A[3] + (B[3] - A[3]) * t]);
}

/** Evaluate a color ramp at t. */
export function evalRamp(ramp: Ramp, t: number): number[] {
  const s = [...ramp.stops].sort((a, b) => a.pos - b.pos);
  if (!s.length) return [0, 0, 0, 1];
  if (t <= s[0].pos) return [...s[0].color];
  if (t >= s[s.length - 1].pos) return [...s[s.length - 1].color];
  let i = 0;
  while (i < s.length - 1 && t > s[i + 1].pos) i++;
  const a = s[i],
    b = s[i + 1];
  if (ramp.interpolation === 'CONSTANT') return t >= b.pos ? [...b.color] : [...a.color];
  const span = b.pos - a.pos;
  let f = span > 0 ? (t - a.pos) / span : 0;
  if (ramp.interpolation === 'EASE') f = smooth(f);
  if (ramp.interpolation === 'CARDINAL' || ramp.interpolation === 'B_SPLINE') {
    const p0 = s[Math.max(0, i - 1)].color,
      p3 = s[Math.min(s.length - 1, i + 2)].color;
    const p1 = a.color,
      p2 = b.color;
    const f2 = f * f,
      f3 = f2 * f;
    if (ramp.interpolation === 'CARDINAL') {
      // Catmull-Rom spline through the stops
      return p1.map((_, k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * f + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * f2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * f3));
    }
    // uniform cubic B-spline (approximating)
    const w0 = (1 - f) ** 3 / 6,
      w1 = (3 * f3 - 6 * f2 + 4) / 6,
      w2 = (-3 * f3 + 3 * f2 + 3 * f + 1) / 6,
      w3 = f3 / 6;
    return p1.map((_, k) => w0 * p0[k] + w1 * p1[k] + w2 * p2[k] + w3 * p3[k]);
  }
  return mixColors(a.color, b.color, f, ramp.colorMode, ramp.hueInterpolation);
}

/** Bake a ramp into an RGBA float table of `n` samples over [0, 1]. */
export function bakeRamp(ramp: Ramp, n = 256): Float32Array {
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) out.set(evalRamp(ramp, i / (n - 1)), i * 4);
  return out;
}

// ---------------------------------------------------------------------------
// Curve mapping

export interface CurvePoint {
  x: number;
  y: number;
  /** 0 auto, 1 vector, 2 auto clamped */
  handle: number;
}

export type CurveKind = 'RGB' | 'VECTOR' | 'FLOAT' | 'HUE';

export const CURVE_NAMES: Record<CurveKind, string[]> = {
  RGB: ['c', 'r', 'g', 'b'],
  VECTOR: ['x', 'y', 'z'],
  FLOAT: ['v'],
  HUE: ['h', 's', 'v'],
};
export const CURVE_RANGE: Record<CurveKind, [number, number, number, number]> = { RGB: [0, 0, 1, 1], VECTOR: [-1, -1, 1, 1], FLOAT: [0, 0, 1, 1], HUE: [0, 0, 1, 1] };

export function defaultCurves(kind: CurveKind): Record<string, SocketValue> {
  const out: Record<string, SocketValue> = {
    curve_kind: kind,
    curve_extend: 'HORIZONTAL',
    curve_active: 0,
  };
  const [x0, y0, x1, y1] = CURVE_RANGE[kind];
  // hue curves: flat at 0.5 (no change), eight points around the hue circle
  const flatHue: number[] = [];
  for (let i = 0; i < 8; i++) flatHue.push(i / 8, 0.5, 0);
  CURVE_NAMES[kind].forEach((n, i) => (out[`curve_${i}`] = kind === 'HUE' ? [...flatHue] : [x0, y0, 0, x1, y1, 0]));
  void CURVE_NAMES[kind];
  if (kind === 'RGB') {
    out.black_level = [0, 0, 0];
    out.white_level = [1, 1, 1];
  }
  return out;
}

export function readCurve(props: Record<string, SocketValue>, index: number): CurvePoint[] {
  const flat = (props[`curve_${index}`] as number[] | undefined) ?? [0, 0, 0, 1, 1, 0];
  const pts: CurvePoint[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) pts.push({ x: flat[i], y: flat[i + 1], handle: flat[i + 2] });
  return pts.sort((a, b) => a.x - b.x);
}

export function writeCurve(props: Record<string, SocketValue>, index: number, pts: CurvePoint[]) {
  props[`curve_${index}`] = [...pts].sort((a, b) => a.x - b.x).flatMap((p) => [p.x, p.y, p.handle]);
}

/** Tangent (slope) at each point for piecewise cubic Hermite interpolation. */
function slopes(p: CurvePoint[]): number[] {
  const n = p.length;
  const m = new Array(n).fill(0);
  const sec = (i: number) => {
    const dx = p[i + 1].x - p[i].x;
    return dx > 1e-9 ? (p[i + 1].y - p[i].y) / dx : 0;
  };
  for (let i = 0; i < n; i++) {
    if (n === 1) break;
    if (i === 0) m[i] = sec(0);
    else if (i === n - 1) m[i] = sec(n - 2);
    else {
      const a = sec(i - 1),
        b = sec(i);
      const dxa = p[i].x - p[i - 1].x,
        dxb = p[i + 1].x - p[i].x;
      m[i] = (a * dxb + b * dxa) / Math.max(1e-9, dxa + dxb);
      if (p[i].handle === 2 && a * b <= 0) m[i] = 0; // clamped extremum
      if (p[i].handle === 2) {
        const lim = 3 * Math.min(Math.abs(a), Math.abs(b));
        if (Math.abs(m[i]) > lim) m[i] = Math.sign(m[i]) * lim;
      }
    }
  }
  // end points with a single neighbour: ease into the curve like an auto handle
  if (n > 2) {
    m[0] = (3 * sec(0) - m[1]) / 2;
    m[n - 1] = (3 * sec(n - 2) - m[n - 2]) / 2;
  }
  return m;
}

/** Curve evaluated periodically over [0, 1) (hue curves: the last point continues into the first). */
export function evalPeriodicCurve(pts: CurvePoint[], x: number): number {
  if (!pts.length) return 0.5;
  const ext = [...pts.map((p) => ({ ...p, x: p.x - 1 })), ...pts, ...pts.map((p) => ({ ...p, x: p.x + 1 }))];
  return evalCurve(ext, x, 'HORIZONTAL');
}

/** Evaluate a curve at x (points sorted by x). */
export function evalCurve(pts: CurvePoint[], x: number, extend = 'HORIZONTAL'): number {
  const n = pts.length;
  if (!n) return x;
  if (n === 1) return pts[0].y;
  const m = slopes(pts);
  if (x <= pts[0].x) {
    if (extend === 'EXTRAPOLATED') return pts[0].y + (x - pts[0].x) * (pts[0].handle === 1 ? (pts[1].y - pts[0].y) / Math.max(1e-9, pts[1].x - pts[0].x) : m[0]);
    return pts[0].y;
  }
  if (x >= pts[n - 1].x) {
    if (extend === 'EXTRAPOLATED') return pts[n - 1].y + (x - pts[n - 1].x) * (pts[n - 1].handle === 1 ? (pts[n - 1].y - pts[n - 2].y) / Math.max(1e-9, pts[n - 1].x - pts[n - 2].x) : m[n - 1]);
    return pts[n - 1].y;
  }
  let i = 0;
  while (i < n - 2 && x > pts[i + 1].x) i++;
  const a = pts[i],
    b = pts[i + 1];
  const h = b.x - a.x;
  if (h <= 1e-9) return b.y;
  const t = (x - a.x) / h;
  if (a.handle === 1 && b.handle === 1) return a.y + (b.y - a.y) * t;
  const lin = (b.y - a.y) / h;
  const ma = a.handle === 1 ? lin : m[i],
    mb = b.handle === 1 ? lin : m[i + 1];
  const t2 = t * t,
    t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a.y + (t3 - 2 * t2 + t) * h * ma + (-2 * t3 + 3 * t2) * b.y + (t3 - t2) * h * mb;
}

/**
 * Bake the curves of a curve node into an RGBA float LUT (`n` samples per channel over the
 * clip range). RGB: channels r/g/b = channel∘combined with black/white levels; alpha unused.
 * VECTOR: x/y/z. FLOAT: r.
 */
export function bakeCurves(props: Record<string, SocketValue>, kind: CurveKind, n = 256): { data: Float32Array; min: number; max: number } {
  const [x0, , x1] = CURVE_RANGE[kind];
  const extend = (props.curve_extend as string) ?? 'HORIZONTAL';
  const data = new Float32Array(n * 4);
  const curves = CURVE_NAMES[kind].map((_, i) => readCurve(props, i));
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / (n - 1);
    if (kind === 'RGB') {
      const black = (props.black_level as number[]) ?? [0, 0, 0],
        white = (props.white_level as number[]) ?? [1, 1, 1];
      for (let c = 0; c < 3; c++) {
        const lv = (x - black[c]) / Math.max(1e-6, white[c] - black[c]);
        data[i * 4 + c] = evalCurve(curves[c + 1], evalCurve(curves[0], lv, extend), extend);
      }
      data[i * 4 + 3] = 1;
    } else if (kind === 'VECTOR') {
      for (let c = 0; c < 3; c++) data[i * 4 + c] = evalCurve(curves[c], x, extend);
      data[i * 4 + 3] = 1;
    } else {
      const v = evalCurve(curves[0], x, extend);
      data.set([v, v, v, 1], i * 4);
    }
  }
  return { data, min: x0, max: x1 };
}

// ---------------------------------------------------------------------------
// Physical colour helpers (CPU versions; GLSL versions in shader/glsl)

/** CIE 1931 colour matching approximation (multi-lobe Gaussian fit, Wyman et al. 2013). */
export function cieXYZ(lambdaNm: number): [number, number, number] {
  const g = (x: number, mu: number, s1: number, s2: number) => {
    const t = (x - mu) / (x < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  };
  const x = 1.056 * g(lambdaNm, 599.8, 37.9, 31.0) + 0.362 * g(lambdaNm, 442.0, 16.0, 26.7) - 0.065 * g(lambdaNm, 501.1, 20.4, 26.2);
  const y = 0.821 * g(lambdaNm, 568.8, 46.9, 40.5) + 0.286 * g(lambdaNm, 530.9, 16.3, 31.1);
  const z = 1.217 * g(lambdaNm, 437.0, 11.8, 36.0) + 0.681 * g(lambdaNm, 459.0, 26.0, 13.8);
  return [x, y, z];
}

export function xyzToLinearRec709(x: number, y: number, z: number): [number, number, number] {
  return [3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.969266 * x + 1.8760108 * y + 0.041556 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z];
}

/** Linear RGB colour of a wavelength (nm), normalised so the brightest primary is ~1. */
export function wavelengthToRgb(lambdaNm: number): [number, number, number] {
  const [x, y, z] = cieXYZ(lambdaNm);
  const c = xyzToLinearRec709(x, y, z);
  return c.map((v) => Math.max(0, v)) as [number, number, number];
}

/** Linear RGB colour of a black body at `kelvin`, normalised to unit luminance-ish brightness. */
export function blackbodyToRgb(kelvin: number): [number, number, number] {
  const T = Math.max(800, Math.min(12000, kelvin));
  let X = 0,
    Y = 0,
    Z = 0;
  for (let l = 380; l <= 780; l += 5) {
    const lm = l * 1e-9;
    const planck = 1 / (lm ** 5 * (Math.exp(0.014387769 / (lm * T)) - 1));
    const [x, y, z] = cieXYZ(l);
    X += x * planck;
    Y += y * planck;
    Z += z * planck;
  }
  const c = xyzToLinearRec709(X, Y, Z).map((v) => Math.max(0, v));
  const m = Math.max(c[0], c[1], c[2]) || 1;
  return [c[0] / m, c[1] / m, c[2] / m];
}
