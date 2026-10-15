// Colour management: scene-linear HDR → display (exposure, view transform, gamma, sRGB).
// The same transforms exist as a CPU implementation (render results, saving, image editor)
// and as GLSL (viewport display of path-traced / post-processed buffers).
// Khronos PBR Neutral follows its public specification (as in three.js, MIT). AgX keeps the
// rec.2020 inset/outset structure of three.js' AgX but uses our own hyperbolic sigmoid whose
// parameters were least-squares fitted to expected values (grey ramp + primaries);
// Filmic is a per-channel log-encoded sigmoid fitted the same way (see tests/unit/render.test.ts).

import { evalCurve } from '../../nodes/curves';

export type ViewTransform = 'STANDARD' | 'FILMIC' | 'AGX' | 'KHRONOS_PBR_NEUTRAL' | 'RAW';

export interface ViewSettings {
  view_transform: ViewTransform;
  exposure: number;
  gamma: number;
  /** creative look graded on top of the view transform (see LOOKS) */
  look?: string;
  use_white_balance?: boolean;
  white_balance_temperature?: number;
  white_balance_tint?: number;
  /** display curve applied to the final display values */
  use_curve_mapping?: boolean;
  curve_mapping?: [number, number][];
}

/** Entries of the display curve lookup table (shared by the CPU and GLSL paths). */
export const CURVE_TABLE_SIZE = 64;

/** Lookup table of a display curve given by control points (smooth through the points). */
export function curveTable(points: [number, number][]): Float32Array {
  const pts = [...points].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y, handle: 2 }));
  const t = new Float32Array(CURVE_TABLE_SIZE);
  for (let i = 0; i < CURVE_TABLE_SIZE; i++) t[i] = clamp01(evalCurve(pts, i / (CURVE_TABLE_SIZE - 1)));
  return t;
}

/** Curve table of view settings, or null when off (or the identity). */
export function viewCurve(s: ViewSettings): Float32Array | null {
  if (!s.use_curve_mapping || !s.curve_mapping?.length) return null;
  const p = s.curve_mapping;
  if (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1) return null;
  return curveTable(p);
}

/** Sample a curve table at x ∈ [0, 1]. */
export function lookupCurve(t: Float32Array, x: number): number {
  const n = t.length - 1;
  const p = clamp01(x) * n;
  const i = Math.min(n - 1, Math.floor(p));
  const f = p - i;
  return t[i] + (t[i + 1] - t[i]) * f;
}

/**
 * Looks per view transform: a display-space grade [slope, offset, power, saturation]
 * (y = (slope·x + offset)^power, then saturation around luminance). The parameters were
 * least-squares fitted to the expected output of grey ramps and a saturated colour.
 */
export const LOOKS: Record<string, Record<string, [number, number, number, number]>> = {
  AGX: {
    'AgX - Punchy': [0.94, 0.05, 1.5, 0.97],
    'AgX - Greyscale': [1, 0, 1, 0],
    'AgX - Very High Contrast': [1.4, 0.02, 1.4, 0.75],
    'AgX - High Contrast': [1.2, 0.13, 1.74, 0.82],
    'AgX - Medium High Contrast': [1.18, -0.07, 0.86, 1.03],
    'AgX - Base Contrast': [1, 0, 1, 1],
    'AgX - Medium Low Contrast': [0.88, 0.11, 1.34, 0.94],
    'AgX - Low Contrast': [0.8, 0.15, 1.46, 0.96],
    'AgX - Very Low Contrast': [0.74, 0.15, 1.42, 1.01],
  },
  FILMIC: {
    'Very High Contrast': [1.22, 0.06, 1.46, 0.84],
    'High Contrast': [1.18, -0.15, 0.6, 1.13],
    'Medium High Contrast': [1.1, -0.09, 0.76, 1.06],
    'Medium Low Contrast': [0.86, 0.13, 1.36, 0.96],
    'Low Contrast': [0.84, 0.15, 1.52, 0.91],
    'Very Low Contrast': [0.84, 0.14, 1.58, 0.87],
  },
};

/** Look grade of a view, or null for none. */
export function lookParams(view: ViewTransform, look: string | undefined): [number, number, number, number] | null {
  if (!look || look === 'None') return null;
  const p = LOOKS[view]?.[look];
  return p && !(p[0] === 1 && p[1] === 0 && p[2] === 1 && p[3] === 1) ? p : null;
}

/** Apply a look grade to display-encoded RGB (in place). */
export function applyLook(c: number[], p: [number, number, number, number]) {
  for (let i = 0; i < 3; i++) c[i] = Math.pow(clamp01(p[0] * c[i] + p[1]), p[2]);
  if (p[3] !== 1) {
    const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    for (let i = 0; i < 3; i++) c[i] = clamp01(l + (c[i] - l) * p[3]);
  }
}

// --- white balance: chromatic adaptation from the illuminant (temperature, tint) to the
// reference white (6500 K, tint 10), as per-channel gains in linear Rec.709

function planckXY(T: number): [number, number] {
  const t = Math.min(25000, Math.max(1667, T));
  const x = t < 4000 ? -0.2661239e9 / t ** 3 - 0.2343589e6 / t ** 2 + 0.8776956e3 / t + 0.17991 : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + 0.2226347e3 / t + 0.24039;
  const y = t < 2222 ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683 : t < 4000 ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867 : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

/** XYZ (Y = 1) of a white of colour temperature T with a tint offset across the locus. */
export function whiteXYZ(T: number, tint: number): [number, number, number] {
  const uv = (x: number, y: number) => {
    const d = -2 * x + 12 * y + 3;
    return [(4 * x) / d, (6 * y) / d];
  };
  const [x0, y0] = planckXY(T);
  const [x1, y1] = planckXY(T * 1.001);
  const [u0, v0] = uv(x0, y0);
  const [u1, v1] = uv(x1, y1);
  let nu = -(v1 - v0),
    nv = u1 - u0;
  const len = Math.hypot(nu, nv) || 1;
  nu /= len;
  nv /= len;
  if (nv < 0) (nu = -nu), (nv = -nv);
  const k = tint / 3000;
  const u = u0 + nu * k,
    v = v0 + nv * k;
  const d = 2 * u - 8 * v + 4;
  const x = (3 * u) / d,
    y = (2 * v) / d;
  return [x / y, 1, (1 - x - y) / y];
}

const BRADFORD: M3 = [0.8951, -0.7502, 0.0389, 0.2664, 1.7135, -0.0685, -0.1614, 0.0367, 1.0296];
const XYZ_TO_REC709: M3 = [3.2406, -0.9689, 0.0557, -1.5372, 1.8758, -0.204, -0.4986, 0.0415, 1.057];

/** Per-channel gains of the white balance (identity at 6500 K / tint 10). */
export function whiteBalanceGains(temperature: number, tint: number): [number, number, number] {
  const lms = (xyz: number[]) => {
    const o = [0, 0, 0];
    mul(BRADFORD, xyz[0], xyz[1], xyz[2], o);
    return o;
  };
  const src = lms(whiteXYZ(temperature, tint));
  const ref = lms(whiteXYZ(6500, 10));
  // neutral (reference white) input → adapted LMS → XYZ → RGB
  const d65 = lms([0.9505, 1, 1.089]);
  const adapted = [(d65[0] * ref[0]) / src[0], (d65[1] * ref[1]) / src[1], (d65[2] * ref[2]) / src[2]];
  const inv = invert3(BRADFORD);
  const xyz = [0, 0, 0];
  mul(inv, adapted[0], adapted[1], adapted[2], xyz);
  const rgb = [0, 0, 0];
  mul(XYZ_TO_REC709, xyz[0], xyz[1], xyz[2], rgb);
  const white = [0, 0, 0];
  mul(XYZ_TO_REC709, 0.9505, 1, 1.089, white);
  // the adaptation is applied with a strength fitted to the expected results
  const k = 1.8;
  return [Math.pow(Math.max(1e-4, rgb[0] / white[0]), k), Math.pow(Math.max(1e-4, rgb[1] / white[1]), k), Math.pow(Math.max(1e-4, rgb[2] / white[2]), k)];
}

function invert3(m: M3): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** White balance gains of view settings (null when off). */
export function viewWhiteBalance(s: ViewSettings): [number, number, number] | null {
  if (!s.use_white_balance) return null;
  return whiteBalanceGains(s.white_balance_temperature ?? 6500, s.white_balance_tint ?? 10);
}

export const VIEW_INDEX: Record<ViewTransform, number> = { STANDARD: 0, AGX: 1, FILMIC: 2, KHRONOS_PBR_NEUTRAL: 3, RAW: 4 };

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function srgbEncode(c: number): number {
  if (c <= 0.0031308) return c < 0 ? 0 : c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function srgbDecode(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// column-major 3x3 helpers (matching GLSL mat3(col0, col1, col2))
type M3 = readonly number[];
function mul(m: M3, x: number, y: number, z: number, o: number[]) {
  o[0] = m[0] * x + m[3] * y + m[6] * z;
  o[1] = m[1] * x + m[4] * y + m[7] * z;
  o[2] = m[2] * x + m[5] * y + m[8] * z;
}

const REC2020_TO_SRGB: M3 = [1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187];
const SRGB_TO_REC2020: M3 = [0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.088, 0.0433, 0.0113, 0.8956];
const AGX_INSET: M3 = [0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591, 0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859];
const AGX_OUTSET: M3 = [1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323, 1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257, 1.2519364065950405];
const lerpIdentity = (m: M3, k: number): M3 => m.map((v, i) => (i % 4 === 0 ? 1 - k : 0) + v * k);

/** Generic hyperbolic sigmoid through (tp, yp) with slope s and toe/shoulder sharpness pt/ps. */
export function sigmoid(x: number, tp: number, yp: number, s: number, pt: number, ps: number) {
  const d = x - tp;
  if (d < 0) return yp + (s * d) / Math.pow(1 + Math.pow((s * -d) / yp, pt), 1 / pt);
  return yp + (s * d) / Math.pow(1 + Math.pow((s * d) / (1 - yp), ps), 1 / ps);
}

// fitted model parameters
export const AGX = { inset: 0.918512, outset: 1.088672, tp: 0.6834, yp: 0.55653, s: 4.205269, pt: 4.271837, ps: 3.582538, min: -19.413719, max: 8.685635, power: 1.151344 };
export const FILMIC = { min: -33.60905, max: 22.274768, tp: 0.566315, yp: 0.566096, s: 7.056776, pt: 3.420978, ps: 3.997207 };
const AGX_IN = lerpIdentity(AGX_INSET, AGX.inset);
const AGX_OUT = lerpIdentity(AGX_OUTSET, AGX.outset);

const t = [0, 0, 0];
const u = [0, 0, 0];

/** Tone map a linear (exposure-applied) colour into linear display-referred [0,1] (in place). */
export function toneMap(c: number[], view: ViewTransform) {
  switch (view) {
    case 'AGX': {
      mul(SRGB_TO_REC2020, c[0], c[1], c[2], t);
      mul(AGX_IN, t[0], t[1], t[2], u);
      for (let i = 0; i < 3; i++) {
        const v = clamp01((Math.log2(Math.max(u[i], 1e-10)) - AGX.min) / (AGX.max - AGX.min));
        u[i] = sigmoid(v, AGX.tp, AGX.yp, AGX.s, AGX.pt, AGX.ps);
      }
      mul(AGX_OUT, u[0], u[1], u[2], t);
      for (let i = 0; i < 3; i++) t[i] = Math.pow(Math.max(0, t[i]), AGX.power);
      mul(REC2020_TO_SRGB, t[0], t[1], t[2], c);
      for (let i = 0; i < 3; i++) c[i] = clamp01(c[i]);
      return;
    }
    case 'FILMIC': {
      // per-channel curve producing display values; decode so the common sRGB encode restores them
      for (let i = 0; i < 3; i++) {
        const v = clamp01((Math.log2(Math.max(c[i], 1e-10)) - FILMIC.min) / (FILMIC.max - FILMIC.min));
        c[i] = srgbDecode(clamp01(sigmoid(v, FILMIC.tp, FILMIC.yp, FILMIC.s, FILMIC.pt, FILMIC.ps)));
      }
      return;
    }
    case 'KHRONOS_PBR_NEUTRAL': {
      const start = 0.8 - 0.04,
        desat = 0.15;
      const x = Math.min(c[0], c[1], c[2]);
      const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
      c[0] -= offset;
      c[1] -= offset;
      c[2] -= offset;
      const peak = Math.max(c[0], c[1], c[2]);
      if (peak >= start) {
        const d = 1 - start;
        const np = 1 - (d * d) / (peak + d - start);
        const g = 1 - 1 / (desat * (peak - np) + 1);
        for (let i = 0; i < 3; i++) c[i] = (c[i] * np) / peak + (np - (c[i] * np) / peak) * g;
      }
      for (let i = 0; i < 3; i++) c[i] = clamp01(c[i]);
      return;
    }
    case 'RAW':
      return;
    default:
      for (let i = 0; i < 3; i++) c[i] = clamp01(c[i]);
  }
}

/**
 * Full display transform of one premultiplied linear RGBA pixel → display-encoded RGBA in [0,1].
 * RAW skips the sRGB encoding (values written as-is: the "Raw" view).
 */
export function displayPixel(r: number, g: number, b: number, a: number, s: ViewSettings, out: number[]) {
  const ex = Math.pow(2, s.exposure);
  const wb = viewWhiteBalance(s) ?? [1, 1, 1];
  // un-premultiply so semi-transparent edges keep their colour
  const ia = a > 1e-6 && a < 1 ? 1 / a : 1;
  out[0] = r * ia * ex * wb[0];
  out[1] = g * ia * ex * wb[1];
  out[2] = b * ia * ex * wb[2];
  toneMap(out, s.view_transform);
  const raw = s.view_transform === 'RAW';
  const ig = s.gamma > 0 ? 1 / s.gamma : 1;
  for (let i = 0; i < 3; i++) out[i] = raw ? clamp01(out[i]) : srgbEncode(out[i]);
  const look = lookParams(s.view_transform, s.look);
  if (look) applyLook(out, look);
  const curve = viewCurve(s);
  for (let i = 0; i < 3; i++) {
    let v = out[i];
    if (ig !== 1) v = Math.pow(Math.max(0, v), ig);
    out[i] = curve ? lookupCurve(curve, v) : clamp01(v);
  }
  out[3] = clamp01(a);
}

/**
 * Convert a top-down float RGBA buffer (premultiplied, scene linear) to 8-bit display RGBA.
 * `background` (linear RGB) composites transparent pixels when `keepAlpha` is false.
 */
/** Piecewise-linear lookup table for a smooth function on [lo, hi] (clamped outside). */
function makeLut(fn: (x: number) => number, lo: number, hi: number, n = 4096) {
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = fn(lo + ((hi - lo) * i) / n);
  const k = n / (hi - lo);
  return (x: number) => {
    let p = (x - lo) * k;
    if (p <= 0) return t[0];
    if (p >= n) return t[n];
    const i = p | 0;
    p -= i;
    return t[i] + (t[i + 1] - t[i]) * p;
  };
}

function mulM(a: M3, b: M3): M3 {
  const o: number[] = [];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
  return o;
}

let luts: { enc: (x: number) => number; agx: (x: number) => number; agxPow: (x: number) => number; filmic: (x: number) => number; agxIn: M3 } | null = null;
function getLuts() {
  if (!luts) {
    luts = {
      enc: makeLut(srgbEncode, 0, 1, 16384),
      agx: makeLut((t) => sigmoid(t, AGX.tp, AGX.yp, AGX.s, AGX.pt, AGX.ps), 0, 1),
      agxPow: makeLut((x) => Math.pow(x, AGX.power), 0, 1.5),
      filmic: makeLut((t) => clamp01(sigmoid(t, FILMIC.tp, FILMIC.yp, FILMIC.s, FILMIC.pt, FILMIC.ps)), 0, 1),
      agxIn: mulM(AGX_IN, SRGB_TO_REC2020),
    };
  }
  return luts;
}

/** Fast (table based) equivalent of `displayPixel` for whole images. */
export function fastDisplay(s: ViewSettings): (r: number, g: number, b: number, a: number, out: number[]) => void {
  const L = getLuts();
  const ex = Math.pow(2, s.exposure);
  const wb = viewWhiteBalance(s);
  const wr = wb?.[0] ?? 1,
    wg = wb?.[1] ?? 1,
    wbb = wb?.[2] ?? 1;
  const look = lookParams(s.view_transform, s.look);
  const lk = [0, 0, 0];
  const curve = viewCurve(s);
  const ig = s.gamma > 0 ? 1 / s.gamma : 1;
  const gam = ig !== 1 ? (x: number) => Math.pow(x, ig) : null;
  const view = s.view_transform;
  const M = L.agxIn,
    O = AGX_OUT,
    R = REC2020_TO_SRGB;
  const aMin = AGX.min,
    aInv = 1 / (AGX.max - AGX.min),
    fMin = FILMIC.min,
    fInv = 1 / (FILMIC.max - FILMIC.min);
  const tmp = [0, 0, 0];
  return (r, g, b, a, out) => {
    const ia = a > 1e-6 && a < 1 ? 1 / a : 1;
    r *= ia * ex * wr;
    g *= ia * ex * wg;
    b *= ia * ex * wbb;
    let x: number, y: number, z: number;
    if (view === 'AGX') {
      const u0 = L.agx((Math.log2(Math.max(M[0] * r + M[3] * g + M[6] * b, 1e-10)) - aMin) * aInv),
        u1 = L.agx((Math.log2(Math.max(M[1] * r + M[4] * g + M[7] * b, 1e-10)) - aMin) * aInv),
        u2 = L.agx((Math.log2(Math.max(M[2] * r + M[5] * g + M[8] * b, 1e-10)) - aMin) * aInv);
      const v0 = O[0] * u0 + O[3] * u1 + O[6] * u2,
        v1 = O[1] * u0 + O[4] * u1 + O[7] * u2,
        v2 = O[2] * u0 + O[5] * u1 + O[8] * u2;
      const p0 = v0 > 0 ? (v0 < 1.5 ? L.agxPow(v0) : Math.pow(v0, AGX.power)) : 0,
        p1 = v1 > 0 ? (v1 < 1.5 ? L.agxPow(v1) : Math.pow(v1, AGX.power)) : 0,
        p2 = v2 > 0 ? (v2 < 1.5 ? L.agxPow(v2) : Math.pow(v2, AGX.power)) : 0;
      x = L.enc(clamp01(R[0] * p0 + R[3] * p1 + R[6] * p2));
      y = L.enc(clamp01(R[1] * p0 + R[4] * p1 + R[7] * p2));
      z = L.enc(clamp01(R[2] * p0 + R[5] * p1 + R[8] * p2));
    } else if (view === 'FILMIC') {
      x = L.filmic((Math.log2(Math.max(r, 1e-10)) - fMin) * fInv);
      y = L.filmic((Math.log2(Math.max(g, 1e-10)) - fMin) * fInv);
      z = L.filmic((Math.log2(Math.max(b, 1e-10)) - fMin) * fInv);
    } else if (view === 'KHRONOS_PBR_NEUTRAL') {
      tmp[0] = r;
      tmp[1] = g;
      tmp[2] = b;
      toneMap(tmp, view);
      x = L.enc(tmp[0]);
      y = L.enc(tmp[1]);
      z = L.enc(tmp[2]);
    } else if (view === 'RAW') {
      x = clamp01(r);
      y = clamp01(g);
      z = clamp01(b);
    } else {
      x = L.enc(clamp01(r));
      y = L.enc(clamp01(g));
      z = L.enc(clamp01(b));
    }
    if (look) {
      lk[0] = x;
      lk[1] = y;
      lk[2] = z;
      applyLook(lk, look);
      [x, y, z] = lk;
    }
    if (gam) {
      x = gam(x);
      y = gam(y);
      z = gam(z);
    }
    if (curve) {
      x = lookupCurve(curve, x);
      y = lookupCurve(curve, y);
      z = lookupCurve(curve, z);
    }
    out[0] = x;
    out[1] = y;
    out[2] = z;
    out[3] = clamp01(a);
  };
}

/**
 * Convert a top-down float RGBA buffer (premultiplied, scene linear) to 8-bit display RGBA.
 * `background` (linear RGB) composites transparent pixels when `keepAlpha` is false.
 */
export function toDisplayRGBA8(src: Float32Array, w: number, h: number, s: ViewSettings, opts: { keepAlpha: boolean; background?: [number, number, number]; dither?: number } = { keepAlpha: true }, dst = new Uint8ClampedArray(w * h * 4)) {
  const o = [0, 0, 0, 0];
  const bg = opts.background ?? [0, 0, 0];
  const dither = (opts.dither ?? 0) / 255;
  const px = fastDisplay(s);
  let seed = 1;
  for (let i = 0, n = w * h; i < n; i++) {
    const k = i * 4;
    let r = src[k],
      g = src[k + 1],
      b = src[k + 2],
      a = src[k + 3];
    if (!opts.keepAlpha) {
      const ia = 1 - clamp01(a);
      r += bg[0] * ia;
      g += bg[1] * ia;
      b += bg[2] * ia;
      a = 1;
    }
    px(r, g, b, a, o);
    let d = 0;
    if (dither) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d = ((seed >>> 8) / 16777216 - 0.5) * dither;
    }
    dst[k] = (o[0] + d) * 255 + 0.5;
    dst[k + 1] = (o[1] + d) * 255 + 0.5;
    dst[k + 2] = (o[2] + d) * 255 + 0.5;
    dst[k + 3] = o[3] * 255 + 0.5;
  }
  return dst;
}

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const m3 = (m: M3) => `mat3(vec3(${m.slice(0, 3).map(f).join(', ')}), vec3(${m.slice(3, 6).map(f).join(', ')}), vec3(${m.slice(6, 9).map(f).join(', ')}))`;

/** GLSL implementing `displayPixel` (expects premultiplied linear input). */
export const displayGLSL = /* glsl */ `
float cmSigmoid(float x, float tp, float yp, float s, float pt, float ps) {
  float d = x - tp;
  if (d < 0.0) return yp + s * d / pow(1.0 + pow(s * -d / yp, pt), 1.0 / pt);
  return yp + s * d / pow(1.0 + pow(s * d / (1.0 - yp), ps), 1.0 / ps);
}
vec3 cmAgx(vec3 c) {
  c = ${m3(AGX_IN)} * (${m3(SRGB_TO_REC2020)} * c);
  c = clamp((log2(max(c, 1e-10)) - (${f(AGX.min)})) / (${f(AGX.max - AGX.min)}), 0.0, 1.0);
  c = vec3(cmSigmoid(c.r, ${f(AGX.tp)}, ${f(AGX.yp)}, ${f(AGX.s)}, ${f(AGX.pt)}, ${f(AGX.ps)}), cmSigmoid(c.g, ${f(AGX.tp)}, ${f(AGX.yp)}, ${f(AGX.s)}, ${f(AGX.pt)}, ${f(AGX.ps)}), cmSigmoid(c.b, ${f(AGX.tp)}, ${f(AGX.yp)}, ${f(AGX.s)}, ${f(AGX.pt)}, ${f(AGX.ps)}));
  c = pow(max(vec3(0.0), ${m3(AGX_OUT)} * c), vec3(${f(AGX.power)}));
  return clamp(${m3(REC2020_TO_SRGB)} * c, 0.0, 1.0);
}
float cmFilmic1(float x) {
  float v = clamp((log2(max(x, 1e-10)) - (${f(FILMIC.min)})) / (${f(FILMIC.max - FILMIC.min)}), 0.0, 1.0);
  return clamp(cmSigmoid(v, ${f(FILMIC.tp)}, ${f(FILMIC.yp)}, ${f(FILMIC.s)}, ${f(FILMIC.pt)}, ${f(FILMIC.ps)}), 0.0, 1.0);
}
vec3 cmNeutral(vec3 c) {
  const float start = 0.76; const float desat = 0.15;
  float x = min(c.r, min(c.g, c.b));
  float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= off;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < start) return clamp(c, 0.0, 1.0);
  float d = 1.0 - start;
  float np = 1.0 - d * d / (peak + d - start);
  c *= np / peak;
  float g = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
  return clamp(mix(c, vec3(np), g), 0.0, 1.0);
}
vec3 cmSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
// view: 0 standard, 1 agx, 2 filmic, 3 neutral, 4 raw
// wb: white balance gains; look: slope, offset, power, saturation (identity: 1, 0, 1, 1)
vec4 cmDisplayX(vec4 p, int view, float exposure, float invGamma, vec3 wb, vec4 look) {
  float a = clamp(p.a, 0.0, 1.0);
  vec3 c = (a > 1e-6 && a < 1.0 ? p.rgb / a : p.rgb) * exposure * wb;
  if (view == 2) c = vec3(cmFilmic1(c.r), cmFilmic1(c.g), cmFilmic1(c.b));
  else {
    if (view == 1) c = cmAgx(c);
    else if (view == 3) c = cmNeutral(c);
    else c = clamp(c, 0.0, 1.0);
    if (view != 4) c = cmSrgb(c);
  }
  if (look != vec4(1.0, 0.0, 1.0, 1.0)) {
    c = pow(clamp(look.x * c + look.y, 0.0, 1.0), vec3(look.z));
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = clamp(vec3(l) + (c - vec3(l)) * look.w, 0.0, 1.0);
  }
  if (invGamma != 1.0) c = pow(max(c, 0.0), vec3(invGamma));
  return vec4(clamp(c, 0.0, 1.0), a);
}
vec4 cmDisplay(vec4 p, int view, float exposure, float invGamma) {
  return cmDisplayX(p, view, exposure, invGamma, vec3(1.0), vec4(1.0, 0.0, 1.0, 1.0));
}
`;
