// Procedural textures on the CPU: Wave, Gradient, Magic, Checker, Brick, White Noise and Gabor.
// Inputs are plain numbers; vectors are [x, y, z] (already scaled where the node scales them).
import { fbm } from './noise';
import { hf1, hf1to3, hf2, hf2to3, hf3, hf3to3, hf4, hf4to3 } from './hash';

const TAU = Math.PI * 2;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------------------
// Wave

export type WaveType = 'BANDS' | 'RINGS';
export type WaveDirection = 'X' | 'Y' | 'Z' | 'DIAGONAL' | 'SPHERICAL';
export type WaveProfile = 'SIN' | 'SAW' | 'TRI';

export function waveTexture(
  x: number,
  y: number,
  z: number,
  type: WaveType,
  bandsDir: WaveDirection,
  ringsDir: WaveDirection,
  profile: WaveProfile,
  distortion: number,
  detail: number,
  detailScale: number,
  detailRough: number,
  phase: number,
): number {
  // nudge coordinates off exact integers so band edges are stable
  x = (x + 0.000001) * 0.999999;
  y = (y + 0.000001) * 0.999999;
  z = (z + 0.000001) * 0.999999;
  let n: number;
  if (type === 'BANDS') {
    if (bandsDir === 'X') n = x * 20;
    else if (bandsDir === 'Y') n = y * 20;
    else if (bandsDir === 'Z') n = z * 20;
    else n = (x + y + z) * 10;
  } else {
    let rx = x,
      ry = y,
      rz = z;
    if (ringsDir === 'X') rx = 0;
    else if (ringsDir === 'Y') ry = 0;
    else if (ringsDir === 'Z') rz = 0;
    n = Math.sqrt(rx * rx + ry * ry + rz * rz) * 20;
  }
  n += phase;
  if (distortion !== 0) n += distortion * (fbm([x * detailScale, y * detailScale, z * detailScale], 3, Math.max(0, Math.min(15, detail)), Math.max(0, detailRough), 2, true) * 2 - 1);
  if (profile === 'SIN') return 0.5 + 0.5 * Math.sin(n - Math.PI / 2);
  n /= TAU;
  if (profile === 'SAW') return n - Math.floor(n);
  return Math.abs(n - Math.floor(n + 0.5)) * 2;
}

// ---------------------------------------------------------------------------
// Gradient

export type GradientType = 'LINEAR' | 'QUADRATIC' | 'EASING' | 'DIAGONAL' | 'SPHERICAL' | 'QUADRATIC_SPHERE' | 'RADIAL';

export function gradientTexture(x: number, y: number, z: number, type: GradientType): number {
  switch (type) {
    case 'QUADRATIC': {
      const r = Math.max(x, 0);
      return clamp01(r * r);
    }
    case 'EASING': {
      const r = clamp01(x);
      const t = r * r;
      return clamp01(3 * t - 2 * t * r);
    }
    case 'DIAGONAL':
      return clamp01((x + y) * 0.5);
    case 'RADIAL':
      return clamp01(Math.atan2(y, x) / TAU + 0.5);
    case 'QUADRATIC_SPHERE': {
      const r = Math.max(0.999999 - Math.sqrt(x * x + y * y + z * z), 0);
      return clamp01(r * r);
    }
    case 'SPHERICAL':
      return clamp01(Math.max(0.999999 - Math.sqrt(x * x + y * y + z * z), 0));
    default:
      return clamp01(x);
  }
}

// ---------------------------------------------------------------------------
// Magic (layered trigonometric turbulence)

export function magicTexture(px: number, py: number, pz: number, depth: number, distortion: number, out: number[]) {
  let x = Math.sin((px + py + pz) * 5);
  let y = Math.cos((-px + py - pz) * 5);
  let z = -Math.cos((-px - py + pz) * 5);
  const d = distortion;
  if (depth > 0) {
    x *= d;
    y *= d;
    z *= d;
    y = -Math.cos(x - y + z) * d;
    if (depth > 1) {
      x = Math.cos(x - y - z) * d;
      if (depth > 2) {
        z = Math.sin(-x - y - z) * d;
        if (depth > 3) {
          x = -Math.cos(-x + y - z) * d;
          if (depth > 4) {
            y = -Math.sin(-x + y + z) * d;
            if (depth > 5) {
              y = -Math.cos(-x + y + z) * d;
              if (depth > 6) {
                x = Math.cos(x + y + z) * d;
                if (depth > 7) {
                  z = Math.sin(x + y - z) * d;
                  if (depth > 8) {
                    x = -Math.cos(-x - y + z) * d;
                    if (depth > 9) y = -Math.sin(x - y + z) * d;
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  if (d !== 0) {
    const s = d * 2;
    x /= s;
    y /= s;
    z /= s;
  }
  out[0] = 0.5 - x;
  out[1] = 0.5 - y;
  out[2] = 0.5 - z;
  return out;
}

// ---------------------------------------------------------------------------
// Checker

export function checkerTexture(x: number, y: number, z: number): number {
  x = (x + 0.000001) * 0.999999;
  y = (y + 0.000001) * 0.999999;
  z = (z + 0.000001) * 0.999999;
  const xi = Math.abs(Math.floor(x)) % 2,
    yi = Math.abs(Math.floor(y)) % 2,
    zi = Math.abs(Math.floor(z)) % 2;
  return (xi === yi) === (zi === 1) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Brick

/** Integer noise in [0, 1) for brick tints. */
function brickNoise(n: number): number {
  n = (n + 1013) & 0x7fffffff;
  n = (n >> 13) ^ n;
  const nn = (Math.imul(n, (Math.imul(Math.imul(n, n), 60493) + 19990303) | 0) + 1376312589) & 0x7fffffff;
  return (0.5 * nn) / 1073741824;
}

export interface BrickParams {
  mortarSize: number;
  mortarSmooth: number;
  bias: number;
  brickWidth: number;
  rowHeight: number;
  offset: number;
  offsetFrequency: number;
  squash: number;
  squashFrequency: number;
}

/** Returns [tint, mortar] at a scaled 2D point. */
export function brickTexture(x: number, y: number, b: BrickParams, out: number[]) {
  let bw = b.brickWidth;
  const rh = b.rowHeight;
  const row = Math.floor(y / rh);
  let offset = 0;
  if (b.offsetFrequency && b.squashFrequency) {
    bw *= row % b.squashFrequency ? 1 : b.squash;
    offset = row % b.offsetFrequency ? 0 : bw * b.offset;
  }
  const brick = Math.floor((x + offset) / bw);
  const lx = x + offset - bw * brick,
    ly = y - rh * row;
  const tint = clamp01(brickNoise(((row << 16) + (brick & 0xffff)) | 0) + b.bias);
  let md = Math.min(Math.min(lx, ly), Math.min(bw - lx, rh - ly));
  let mortar: number;
  if (md >= b.mortarSize) mortar = 0;
  else if (b.mortarSmooth === 0) mortar = 1;
  else {
    md = 1 - md / b.mortarSize;
    if (md < b.mortarSmooth) {
      const t = clamp01(md / b.mortarSmooth);
      mortar = t * t * (3 - 2 * t);
    } else mortar = 1;
  }
  out[0] = tint;
  out[1] = mortar;
  return out;
}

// ---------------------------------------------------------------------------
// White noise

/** Value and color of white noise in `n` (1–4) dimensions: writes [value, r, g, b]. */
export function whiteNoise(p: ArrayLike<number>, n: number, out: number[]) {
  const c = [0, 0, 0];
  switch (n) {
    case 1:
      out[0] = hf1(p[0]);
      hf1to3(p[0], c);
      break;
    case 2:
      out[0] = hf2(p[0], p[1]);
      hf2to3(p[0], p[1], c);
      break;
    case 3:
      out[0] = hf3(p[0], p[1], p[2]);
      hf3to3(p[0], p[1], p[2], c);
      break;
    default:
      out[0] = hf4(p[0], p[1], p[2], p[3]);
      hf4to3(p[0], p[1], p[2], p[3], c);
  }
  out[1] = c[0];
  out[2] = c[1];
  out[3] = c[2];
  return out;
}

// ---------------------------------------------------------------------------
// Gabor noise: sparse convolution of windowed, oriented sinusoid kernels, 8 impulses per cell.

const IMPULSES = 8;

function kernel2(px: number, py: number, freq: number, orient: number, out: number[]) {
  const d2 = px * px + py * py;
  const env = Math.exp(-Math.PI * d2) * (0.5 + 0.5 * Math.cos(Math.PI * d2));
  const a = TAU * (px * freq * Math.cos(orient) + py * freq * Math.sin(orient));
  out[0] += env * Math.cos(a);
  out[1] += env * Math.sin(a);
}

function gabor2(x: number, y: number, freq: number, isotropy: number, orient: number): [number, number] {
  const cx = Math.floor(x),
    cy = Math.floor(y);
  const lx = x - cx,
    ly = y - cy;
  const sum = [0, 0];
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i,
        gy = cy + j;
      const px = lx - i,
        py = ly - j;
      for (let k = 0; k < IMPULSES; k++) {
        const o = orient + (hf3(gx, gy, k * 3) - 0.5) * Math.PI * isotropy;
        const kx = hf3(gx, gy, k * 3 + 1),
          ky = hf3(k * 3 + 1, gx, gy);
        const rx = px - kx,
          ry = py - ky;
        if (rx * rx + ry * ry >= 1) continue;
        const w = hf3(gx, gy, k * 3 + 2) < 0.5 ? -1 : 1;
        const t = [0, 0];
        kernel2(rx, ry, freq, o, t);
        sum[0] += w * t[0];
        sum[1] += w * t[1];
      }
    }
  return [sum[0], sum[1]];
}

function orientation3(o: number[], isotropy: number, seed: number[]): number[] {
  if (isotropy === 0) return o;
  let incl = Math.acos(Math.max(-1, Math.min(1, o[2])));
  const lxy = Math.hypot(o[0], o[1]);
  let az = (o[1] < 0 ? -1 : o[1] > 0 ? 1 : 0) * Math.acos(lxy > 0 ? Math.max(-1, Math.min(1, o[0] / lxy)) : 1);
  const r0 = (hf4(seed[0], seed[1], seed[2], seed[3]) * 2 - 1) * Math.PI;
  const r1 = (hf4(seed[2], seed[0], seed[3], seed[1]) * 2 - 1) * Math.PI;
  incl += r0 * isotropy;
  az += r1 * isotropy;
  return [Math.sin(incl) * Math.cos(az), Math.sin(incl) * Math.sin(az), Math.cos(incl)];
}

function gabor3(x: number, y: number, z: number, freq: number, isotropy: number, orient: number[]): [number, number] {
  const cx = Math.floor(x),
    cy = Math.floor(y),
    cz = Math.floor(z);
  const lx = x - cx,
    ly = y - cy,
    lz = z - cz;
  const sum = [0, 0];
  const c3 = [0, 0, 0];
  for (let kk = -1; kk <= 1; kk++)
    for (let j = -1; j <= 1; j++)
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i,
          gy = cy + j,
          gz = cz + kk;
        const px = lx - i,
          py = ly - j,
          pz = lz - kk;
        for (let k = 0; k < IMPULSES; k++) {
          const o = orientation3(orient, isotropy, [gx, gy, gz, k * 3]);
          hf4to3(gx, gy, gz, k * 3 + 1, c3);
          const rx = px - c3[0],
            ry = py - c3[1],
            rz = pz - c3[2];
          const d2 = rx * rx + ry * ry + rz * rz;
          if (d2 >= 1) continue;
          const w = hf4(gx, gy, gz, k * 3 + 2) < 0.5 ? -1 : 1;
          const env = Math.exp(-Math.PI * d2) * (0.5 + 0.5 * Math.cos(Math.PI * d2));
          const a = TAU * freq * (rx * o[0] + ry * o[1] + rz * o[2]);
          sum[0] += w * env * Math.cos(a);
          sum[1] += w * env * Math.sin(a);
        }
      }
  return [sum[0], sum[1]];
}

/** Gabor texture: returns [value, phase, intensity]. `p` is unscaled. */
export function gaborTexture(p: ArrayLike<number>, dims: 2 | 3, scale: number, frequency: number, anisotropy: number, orient2: number, orient3: ArrayLike<number>, out: number[]) {
  const isotropy = 1 - clamp01(anisotropy);
  const freq = Math.max(0.001, frequency);
  let ph: [number, number];
  let std: number;
  if (dims === 2) {
    ph = gabor2(p[0] * scale, p[1] * scale, freq, isotropy, orient2);
    std = Math.sqrt(IMPULSES * 0.5 * 0.25);
  } else {
    const l = Math.hypot(orient3[0], orient3[1], orient3[2]);
    const o = l > 0 ? [orient3[0] / l, orient3[1] / l, orient3[2] / l] : [0, 0, 0];
    ph = gabor3(p[0] * scale, p[1] * scale, p[2] * scale, freq, isotropy, o);
    std = Math.sqrt(IMPULSES * 0.5 * (1 / (4 * Math.SQRT2)));
  }
  const norm = 6 * std;
  out[0] = (ph[1] / norm) * 0.5 + 0.5;
  out[1] = (Math.atan2(ph[1], ph[0]) + Math.PI) / TAU;
  out[2] = Math.hypot(ph[0], ph[1]) / norm;
  return out;
}
