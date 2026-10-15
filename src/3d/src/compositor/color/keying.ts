// Keying (matte) operations, CPU + GLSL mirrors. Every keyer computes a matte, combines it with
// the input alpha (min) and premultiplies the image by it.
import { rgbToHsv, rgbToYcc, rgbToYuv, luma, type RGBA, type RGB } from './colorops';

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

export function applyMatte(c: RGBA, matte: number): { image: RGBA; matte: number } {
  const m = Math.min(matte, c[3]);
  return { image: [c[0] * m, c[1] * m, c[2] * m, c[3] * m], matte: m };
}

export function lumaKey(c: RGBA, min: number, max: number) {
  return applyMatte(c, clamp((luma(c) - min) / Math.max(max - min, 1e-6), 0, 1));
}

function falloffMatte(d: number, tolerance: number, falloff: number) {
  if (d < tolerance) return 0;
  if (d < tolerance + falloff) return (d - tolerance) / Math.max(falloff, 1e-6);
  return 1;
}

export function distanceKey(c: RGBA, key: ArrayLike<number>, tolerance: number, falloff: number, space: 'RGB' | 'YCC') {
  let d: number;
  if (space === 'YCC') {
    const a = rgbToYcc(c[0], c[1], c[2], 'ITUBT709'),
      b = rgbToYcc(key[0], key[1], key[2], 'ITUBT709');
    d = Math.hypot(a[1] - b[1], a[2] - b[2]);
  } else d = Math.hypot(c[0] - key[0], c[1] - key[1], c[2] - key[2]);
  return applyMatte(c, falloffMatte(d, tolerance, falloff));
}

export function differenceKey(a: RGBA, b: RGBA, tolerance: number, falloff: number) {
  const d = (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
  return applyMatte(a, d <= tolerance ? 0 : falloffMatte(d, tolerance, falloff));
}

export function colorKey(c: RGBA, key: ArrayLike<number>, ht: number, st: number, vt: number) {
  const h = rgbToHsv(c[0], c[1], c[2]),
    k = rgbToHsv(key[0], key[1], key[2]);
  let dh = Math.abs(h[0] - k[0]);
  dh = Math.min(dh, 1 - dh);
  const inside = dh < ht && Math.abs(h[1] - k[1]) < st && Math.abs(h[2] - k[2]) < vt;
  return applyMatte(c, inside ? 0 : 1);
}

export function chromaKey(c: RGBA, key: ArrayLike<number>, minAngle: number, maxAngle: number, falloff: number) {
  const toXZ = (v: ArrayLike<number>): [number, number] => {
    const y = rgbToYcc(v[0], v[1], v[2], 'ITUBT709');
    return [y[1] * 2 - 1, y[2] * 2 - 1];
  };
  const [kx, kz] = toXZ(key);
  const [x, z] = toXZ(c);
  const theta = Math.atan2(kz, kx);
  const xa = x * Math.cos(theta) + z * Math.sin(theta);
  const za = z * Math.cos(theta) - x * Math.sin(theta);
  const kfg = xa - Math.abs(za) / Math.tan(maxAngle / 2);
  let matte = 1;
  if (kfg > 0) {
    matte = 1 - kfg / Math.max(falloff, 1e-6);
    if (Math.abs(Math.atan2(za, xa)) < minAngle / 2) matte = 0;
  }
  return applyMatte(c, clamp(matte, 0, 1));
}

export type ChannelSpace = 'RGB' | 'HSV' | 'YUV' | 'YCbCr';

function channels(c: RGBA, space: ChannelSpace): RGB {
  switch (space) {
    case 'HSV':
      return rgbToHsv(c[0], c[1], c[2]);
    case 'YUV':
      return rgbToYuv(c[0], c[1], c[2]);
    case 'YCbCr':
      return rgbToYcc(c[0], c[1], c[2], 'ITUBT709');
    default:
      return [c[0], c[1], c[2]];
  }
}

/** Channel Key: `key`/`limit` are channel indices (limit −1 = maximum of the other two). */
export function channelKey(c: RGBA, space: ChannelSpace, key: number, limit: number, min: number, max: number) {
  const ch = channels(c, space);
  const others = [0, 1, 2].filter((i) => i !== key);
  const lim = limit < 0 ? Math.max(ch[others[0]], ch[others[1]]) : ch[limit];
  const a = 1 - (ch[key] - lim);
  let matte: number;
  if (a > max) matte = 1;
  else if (a < min) matte = 0;
  else matte = (a - min) / Math.max(max - min, 1e-6);
  return applyMatte(c, matte);
}

/** Color Spill: reduce the spill channel by its excess over the limit channel(s). */
export function colorSpill(c: RGBA, fac: number, spill: number, limitMethod: 'Single' | 'Average', limit: number, limitStrength: number, strength: RGB | null): RGBA {
  const others = [0, 1, 2].filter((i) => i !== spill);
  const lim = limitMethod === 'Single' ? c[limit] : (c[others[0]] + c[others[1]]) / 2;
  const map = fac * (c[spill] - limitStrength * lim);
  if (!(map > 0)) return [...c];
  const mul: RGB = strength ? [-strength[0], -strength[1], -strength[2]] : [spill === 0 ? -1 : 0, spill === 1 ? -1 : 0, spill === 2 ? -1 : 0];
  return [c[0] + mul[0] * map, c[1] + mul[1] * map, c[2] + mul[2] * map, c[3]];
}

export const KEYING_GLSL = {
  cmp_keying: {
    deps: ['cmp_hsv', 'cmp_ycc'],
    code: /* glsl */ `
vec4 cmp_matte(vec4 c, float m, out float matte) { matte = min(m, c.a); return c * matte; }
float cmp_falloff(float d, float tol, float fall) { return d < tol ? 0.0 : (d < tol + fall ? (d - tol) / max(fall, 1e-6) : 1.0); }
float cmp_chroma(vec3 c, vec3 key, float minA, float maxA, float fall) {
  vec3 yc = cmp_rgb2ycc(c, 1), yk = cmp_rgb2ycc(key, 1);
  float x = yc.y * 2.0 - 1.0, z = yc.z * 2.0 - 1.0;
  float th = atan(yk.z * 2.0 - 1.0, yk.y * 2.0 - 1.0);
  float xa = x * cos(th) + z * sin(th), za = z * cos(th) - x * sin(th);
  float kfg = xa - abs(za) / tan(maxA * 0.5);
  float m = 1.0;
  if (kfg > 0.0) { m = 1.0 - kfg / max(fall, 1e-6); if (abs(atan(za, xa)) < minA * 0.5) m = 0.0; }
  return clamp(m, 0.0, 1.0);
}
vec3 cmp_key_channels(vec3 c, int space) {
  if (space == 1) return cmp_rgb2hsv(c);
  if (space == 2) return cmp_rgb2yuv(c);
  if (space == 3) return cmp_rgb2ycc(c, 1);
  return c;
}
`,
  },
};
