// Colour space conversions for the Convert Colorspace node and the Hue Correct node: RGB
// primaries → matrices (computed from chromaticities with Bradford white point adaptation),
// transfer functions, and a CPU version of every per-pixel operation for the unit tests. The
// GLSL versions below mirror them.
import { defaultCurves, evalPeriodicCurve, readCurve, type CurvePoint } from '../../nodes/curves';
import { rgbToHsv, hsvToRgb } from './colorops';
import type { SocketValue } from '../../data/types';

type M3 = number[]; // row-major 3×3
type XY = [number, number];

const D65: XY = [0.3127, 0.329];
const D60: XY = [0.32168, 0.33767];
const E: XY = [1 / 3, 1 / 3];

interface Primaries {
  r: XY;
  g: XY;
  b: XY;
  w: XY;
}
const REC709: Primaries = { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], w: D65 };
const REC2020: Primaries = { r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046], w: D65 };
const AP1: Primaries = { r: [0.713, 0.293], g: [0.165, 0.83], b: [0.128, 0.044], w: D60 };
const AP0: Primaries = { r: [0.7347, 0.2653], g: [0, 1], b: [0.0001, -0.077], w: D60 };
const P3D65: Primaries = { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], w: D65 };
const ADOBE: Primaries = { r: [0.64, 0.33], g: [0.21, 0.71], b: [0.15, 0.06], w: D65 };

function inv3(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
function mul3(a: M3, b: M3): M3 {
  const o: M3 = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
}
const xyz = (p: XY): [number, number, number] => [p[0] / p[1], 1, (1 - p[0] - p[1]) / p[1]];

/** RGB → XYZ matrix of a set of primaries (relative to their own white point). */
function rgbToXyz(p: Primaries): M3 {
  const [rx, ry, rz] = xyz(p.r),
    [gx, gy, gz] = xyz(p.g),
    [bx, by, bz] = xyz(p.b);
  const m: M3 = [rx, gx, bx, ry, gy, by, rz, gz, bz];
  const w = xyz(p.w);
  const s = inv3(m);
  const S = [s[0] * w[0] + s[1] * w[1] + s[2] * w[2], s[3] * w[0] + s[4] * w[1] + s[5] * w[2], s[6] * w[0] + s[7] * w[1] + s[8] * w[2]];
  return [m[0] * S[0], m[1] * S[1], m[2] * S[2], m[3] * S[0], m[4] * S[1], m[5] * S[2], m[6] * S[0], m[7] * S[1], m[8] * S[2]];
}

const BRADFORD: M3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
/** Chromatic adaptation (XYZ → XYZ) from white `a` to white `b`. */
function adapt(a: XY, b: XY): M3 {
  if (a[0] === b[0] && a[1] === b[1]) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const wa = xyz(a),
    wb = xyz(b);
  const ca = [0, 1, 2].map((r) => BRADFORD[r * 3] * wa[0] + BRADFORD[r * 3 + 1] * wa[1] + BRADFORD[r * 3 + 2] * wa[2]);
  const cb = [0, 1, 2].map((r) => BRADFORD[r * 3] * wb[0] + BRADFORD[r * 3 + 1] * wb[1] + BRADFORD[r * 3 + 2] * wb[2]);
  const D: M3 = [cb[0] / ca[0], 0, 0, 0, cb[1] / ca[1], 0, 0, 0, cb[2] / ca[2]];
  return mul3(inv3(BRADFORD), mul3(D, BRADFORD));
}

/** Linear RGB in `p` → linear Rec.709 (scene linear). */
function toRec709(p: Primaries | 'XYZ_D65' | 'XYZ_E'): M3 {
  const fromXyz = inv3(rgbToXyz(REC709));
  if (p === 'XYZ_D65') return fromXyz;
  if (p === 'XYZ_E') return mul3(fromXyz, adapt(E, D65));
  return mul3(fromXyz, mul3(adapt(p.w, D65), rgbToXyz(p)));
}

export type Transfer = 'LINEAR' | 'SRGB' | 'G18' | 'G22' | 'G24' | 'BT1886' | 'ACESCC' | 'ACESCCT';

export interface ColorSpaceDef {
  primaries: Primaries | 'XYZ_D65' | 'XYZ_E' | null;
  transfer: Transfer;
}

/** Supported spaces by identifier (null primaries = data, passed through). */
export const COLOR_SPACES: Record<string, ColorSpaceDef> = {
  scene_linear: { primaries: REC709, transfer: 'LINEAR' },
  'Linear Rec.709': { primaries: REC709, transfer: 'LINEAR' },
  'Non-Color': { primaries: null, transfer: 'LINEAR' },
  sRGB: { primaries: REC709, transfer: 'SRGB' },
  'Gamma 1.8 Encoded Rec.709': { primaries: REC709, transfer: 'G18' },
  'Gamma 2.2 Encoded Rec.709': { primaries: REC709, transfer: 'G22' },
  'Gamma 2.4 Encoded Rec.709': { primaries: REC709, transfer: 'G24' },
  'Rec.1886': { primaries: REC709, transfer: 'BT1886' },
  'Linear Rec.2020': { primaries: REC2020, transfer: 'LINEAR' },
  'Rec.2020': { primaries: REC2020, transfer: 'BT1886' },
  ACEScg: { primaries: AP1, transfer: 'LINEAR' },
  'ACES2065-1': { primaries: AP0, transfer: 'LINEAR' },
  ACEScc: { primaries: AP1, transfer: 'ACESCC' },
  ACEScct: { primaries: AP1, transfer: 'ACESCCT' },
  'sRGB Encoded AP1': { primaries: AP1, transfer: 'SRGB' },
  'Gamma 2.2 Encoded AP1': { primaries: AP1, transfer: 'G22' },
  'Linear DCI-P3 D65': { primaries: P3D65, transfer: 'LINEAR' },
  'Display P3': { primaries: P3D65, transfer: 'SRGB' },
  'sRGB Encoded P3-D65': { primaries: P3D65, transfer: 'SRGB' },
  'Linear Adobe RGB': { primaries: ADOBE, transfer: 'LINEAR' },
  'Gamma 2.2 Encoded AdobeRGB': { primaries: ADOBE, transfer: 'G22' },
  'Linear CIE-XYZ D65': { primaries: 'XYZ_D65', transfer: 'LINEAR' },
  'Linear CIE-XYZ E': { primaries: 'XYZ_E', transfer: 'LINEAR' },
};

export const TRANSFER_INDEX: Record<Transfer, number> = { LINEAR: 0, SRGB: 1, G18: 2, G22: 3, G24: 4, BT1886: 5, ACESCC: 6, ACESCCT: 7 };

/** Encoded value → linear. */
export function decode(t: Transfer, x: number): number {
  switch (t) {
    case 'SRGB':
      return x < 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    case 'G18':
      return x > 0 ? Math.pow(x, 1.8) : x;
    case 'G22':
      return x > 0 ? Math.pow(x, 2.2) : x;
    case 'G24':
      return x > 0 ? Math.pow(x, 2.4) : x;
    case 'BT1886':
      return Math.pow(Math.max(x, 0), 2.4);
    case 'ACESCC':
      if (x < (9.72 - 15) / 17.52) return (Math.pow(2, x * 17.52 - 9.72) - Math.pow(2, -16)) * 2;
      return Math.min(Math.pow(2, x * 17.52 - 9.72), 65504);
    case 'ACESCCT':
      if (x <= 0.155251141552511) return (x - 0.0729055341958355) / 10.5402377416545;
      return Math.min(Math.pow(2, x * 17.52 - 9.72), 65504);
    default:
      return x;
  }
}

/** Linear → encoded value. */
export function encode(t: Transfer, x: number): number {
  switch (t) {
    case 'SRGB':
      return x < 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    case 'G18':
      return x > 0 ? Math.pow(x, 1 / 1.8) : x;
    case 'G22':
      return x > 0 ? Math.pow(x, 1 / 2.2) : x;
    case 'G24':
      return x > 0 ? Math.pow(x, 1 / 2.4) : x;
    case 'BT1886':
      return Math.pow(Math.max(x, 0), 1 / 2.4);
    case 'ACESCC':
      if (x <= 0) return (Math.log2(Math.pow(2, -16)) + 9.72) / 17.52;
      if (x < Math.pow(2, -15)) return (Math.log2(Math.pow(2, -16) + x * 0.5) + 9.72) / 17.52;
      return (Math.log2(x) + 9.72) / 17.52;
    case 'ACESCCT':
      if (x <= 0.0078125) return 10.5402377416545 * x + 0.0729055341958355;
      return (Math.log2(x) + 9.72) / 17.52;
    default:
      return x;
  }
}

/** Row-major matrix taking linear RGB of `from` to linear RGB of `to` (identity when either is data). */
export function conversionMatrix(from: string, to: string): M3 {
  const a = COLOR_SPACES[from],
    b = COLOR_SPACES[to];
  if (!a?.primaries || !b?.primaries) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return mul3(inv3(toRec709(b.primaries)), toRec709(a.primaries));
}

export function convertColorSpace(c: number[], from: string, to: string): number[] {
  const a = COLOR_SPACES[from],
    b = COLOR_SPACES[to];
  if (!a || !b || from === to || !a.primaries || !b.primaries) return [...c];
  const m = conversionMatrix(from, to);
  const l = [decode(a.transfer, c[0]), decode(a.transfer, c[1]), decode(a.transfer, c[2])];
  const o = [0, 1, 2].map((r) => m[r * 3] * l[0] + m[r * 3 + 1] * l[1] + m[r * 3 + 2] * l[2]);
  return [encode(b.transfer, o[0]), encode(b.transfer, o[1]), encode(b.transfer, o[2]), c[3]];
}

export const COLORSPACE_GLSL = /* glsl */ `
float cmpDecodeTf(int t, float x) {
  if (t == 1) return x < 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4);
  if (t == 2) return x > 0.0 ? pow(x, 1.8) : x;
  if (t == 3) return x > 0.0 ? pow(x, 2.2) : x;
  if (t == 4) return x > 0.0 ? pow(x, 2.4) : x;
  if (t == 5) return pow(max(x, 0.0), 2.4);
  if (t == 6) return x < (9.72 - 15.0) / 17.52 ? (exp2(x * 17.52 - 9.72) - exp2(-16.0)) * 2.0 : min(exp2(x * 17.52 - 9.72), 65504.0);
  if (t == 7) return x <= 0.155251141552511 ? (x - 0.0729055341958355) / 10.5402377416545 : min(exp2(x * 17.52 - 9.72), 65504.0);
  return x;
}
float cmpEncodeTf(int t, float x) {
  if (t == 1) return x < 0.0031308 ? x * 12.92 : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
  if (t == 2) return x > 0.0 ? pow(x, 1.0 / 1.8) : x;
  if (t == 3) return x > 0.0 ? pow(x, 1.0 / 2.2) : x;
  if (t == 4) return x > 0.0 ? pow(x, 1.0 / 2.4) : x;
  if (t == 5) return pow(max(x, 0.0), 1.0 / 2.4);
  if (t == 6) return x <= 0.0 ? (-16.0 + 9.72) / 17.52 : (x < exp2(-15.0) ? (log2(exp2(-16.0) + x * 0.5) + 9.72) / 17.52 : (log2(x) + 9.72) / 17.52);
  if (t == 7) return x <= 0.0078125 ? 10.5402377416545 * x + 0.0729055341958355 : (log2(x) + 9.72) / 17.52;
  return x;
}
vec3 cmpConvertSpace(vec3 c, int from, mat3 m, int to) {
  vec3 l = vec3(cmpDecodeTf(from, c.r), cmpDecodeTf(from, c.g), cmpDecodeTf(from, c.b));
  vec3 o = m * l;
  return vec3(cmpEncodeTf(to, o.r), cmpEncodeTf(to, o.g), cmpEncodeTf(to, o.b));
}
`;

// ---------------------------------------------------------------------------
// Hue Correct

/** Curve evaluated periodically over hue (the last point continues into the first one). */
export function hueCurveEval(pts: CurvePoint[], h: number): number {
  return evalPeriodicCurve(pts, h);
}

/** Default Hue Correct curves: eight flat points per channel. */
export function defaultHueCurves(): Record<string, SocketValue> {
  return defaultCurves('HUE');
}

/** Hue Correct of one RGBA pixel. */
export function hueCorrect(props: Record<string, SocketValue>, c: number[], fac: number): number[] {
  const [h, s, v] = rgbToHsv(c[0], c[1], c[2]);
  const hc = hueCurveEval(readCurve(props, 0), h),
    sc = hueCurveEval(readCurve(props, 1), h),
    vc = hueCurveEval(readCurve(props, 2), h);
  let nh = h + (hc - 0.5);
  nh -= Math.floor(nh);
  const ns = Math.min(1, Math.max(0, s * sc * 2));
  const nv = v * vc * 2;
  const r = hsvToRgb(nh, ns, nv);
  return [c[0] + (r[0] - c[0]) * fac, c[1] + (r[1] - c[1]) * fac, c[2] + (r[2] - c[2]) * fac, c[3]];
}

/** Bake the three periodic hue curves into an RGBA LUT (n samples over hue 0..1). */
export function bakeHueCurves(props: Record<string, SocketValue>, n = 256): Float32Array {
  const curves = [0, 1, 2].map((i) => readCurve(props, i));
  const data = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const h = i / (n - 1);
    data[i * 4] = hueCurveEval(curves[0], h);
    data[i * 4 + 1] = hueCurveEval(curves[1], h);
    data[i * 4 + 2] = hueCurveEval(curves[2], h);
    data[i * 4 + 3] = 1;
  }
  return data;
}
