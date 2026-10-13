/**
 * Colorimetry helpers for the color engine: 3x3 matrices, CIE XYZ and
 * L*a*b*, chromatic adaptation (Bradford) and RGB primaries.
 *
 * XYZ values are relative to a white of Y = 1. The profile connection
 * space (PCS) is CIE XYZ or L*a*b* under the D50 illuminant.
 */

export const D50 = Object.freeze([0.9642, 1, 0.8249]);
export const D65 = Object.freeze([0.95047, 1, 1.08883]);

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0);

export function mul3(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

export function mat3(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return out;
}

export function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det || !Number.isFinite(det)) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export const xyToXYZ = ([x, y]) => [x / y, 1, (1 - x - y) / y];

const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
const BRADFORD_INV = inv3(BRADFORD);

/** Bradford matrix adapting colors seen under white `from` to white `to` (XYZ). */
export function adaptation(from, to) {
  const a = mul3(BRADFORD, from);
  const b = mul3(BRADFORD, to);
  const d = [b[0] / a[0], 0, 0, 0, b[1] / a[1], 0, 0, 0, b[2] / a[2]];
  return mat3(BRADFORD_INV, mat3(d, BRADFORD));
}

/**
 * Linear RGB -> XYZ (PCS, D50-adapted) for primaries [[x, y] x3] and a
 * white point [x, y]: the colorant columns a matrix/curve profile stores.
 */
export function rgbToPcsMatrix(primaries, white) {
  const [r, g, b] = primaries.map(xyToXYZ);
  const P = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const W = xyToXYZ(white);
  const S = mul3(inv3(P), W);
  const M = [P[0] * S[0], P[1] * S[1], P[2] * S[2], P[3] * S[0], P[4] * S[1], P[5] * S[2], P[6] * S[0], P[7] * S[1], P[8] * S[2]];
  return mat3(adaptation(W, D50), M);
}

const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fi = (t) => (t > 6 / 29 ? t * t * t : (116 * t - 16) / (24389 / 27));

export function xyzToLab(xyz, white = D50) {
  const fx = f(xyz[0] / white[0]);
  const fy = f(xyz[1] / white[1]);
  const fz = f(xyz[2] / white[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToXyz(lab, white = D50) {
  const fy = (lab[0] + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  return [white[0] * fi(fx), white[1] * fi(fy), white[2] * fi(fz)];
}

/** CIE76 color difference. */
export function deltaE(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** The sRGB transfer curve. */
export const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const srgbEncode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);

/** sRGB (encoded, 0..1) <-> PCS XYZ (D50). */
export const SRGB_PRIMARIES = [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]];
export const D65_XY = [0.3127, 0.329];
const SRGB_TO_PCS = rgbToPcsMatrix(SRGB_PRIMARIES, D65_XY);
const PCS_TO_SRGB = inv3(SRGB_TO_PCS);

export function srgbToPcs(rgb) {
  return mul3(SRGB_TO_PCS, [srgbDecode(clamp01(rgb[0])), srgbDecode(clamp01(rgb[1])), srgbDecode(clamp01(rgb[2]))]);
}

export function pcsToSrgb(xyz, clip = true) {
  const lin = mul3(PCS_TO_SRGB, xyz);
  return clip ? lin.map((v) => clamp01(srgbEncode(clamp01(v)))) : lin.map((v) => Math.sign(v) * srgbEncode(Math.abs(v)));
}
