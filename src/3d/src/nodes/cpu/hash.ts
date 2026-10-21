// Integer and float hashing used by the procedural textures (CPU side). Lattice coordinates and the
// bit patterns of float inputs go through Bob Jenkins' public-domain lookup3 mix (`geonodes/jhash.ts`),
// so patterns are stable and identical in geometry nodes and materials.
import { jhash1, jhash2, jhash3, jhash4 } from '../../geonodes/jhash';

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Bit pattern of a 32-bit float. */
export function fbits(x: number): number {
  f32[0] = x;
  return u32[0];
}

/** Unsigned hash → [0, 1] (inclusive). */
export const u01 = (h: number) => h / 4294967295;

export const hashU1 = (x: number) => jhash1(x >>> 0);
export const hashU2 = (x: number, y: number) => jhash2(x >>> 0, y >>> 0);
export const hashU3 = (x: number, y: number, z: number) => jhash3(x >>> 0, y >>> 0, z >>> 0);
export const hashU4 = (x: number, y: number, z: number, w: number) => jhash4(x >>> 0, y >>> 0, z >>> 0, w >>> 0);

/** Hashes of float arguments to [0, 1]. */
export const hf1 = (a: number) => u01(jhash1(fbits(a)));
export const hf2 = (a: number, b: number) => u01(jhash2(fbits(a), fbits(b)));
export const hf3 = (a: number, b: number, c: number) => u01(jhash3(fbits(a), fbits(b), fbits(c)));
export const hf4 = (a: number, b: number, c: number, d: number) => u01(jhash4(fbits(a), fbits(b), fbits(c), fbits(d)));

/** Three decorrelated [0, 1] values per float position (color outputs, cell jitter). */
export function hf1to3(a: number, out: number[] = [0, 0, 0]) {
  out[0] = hf1(a);
  out[1] = hf2(a, 1);
  out[2] = hf2(a, 2);
  return out;
}
export function hf2to3(a: number, b: number, out: number[] = [0, 0, 0]) {
  out[0] = hf2(a, b);
  out[1] = hf3(a, b, 1);
  out[2] = hf3(a, b, 2);
  return out;
}
export function hf3to3(a: number, b: number, c: number, out: number[] = [0, 0, 0]) {
  out[0] = hf3(a, b, c);
  out[1] = hf4(a, b, c, 1);
  out[2] = hf4(a, b, c, 2);
  return out;
}
export function hf4to3(a: number, b: number, c: number, d: number, out: number[] = [0, 0, 0]) {
  out[0] = hf4(a, b, c, d);
  out[1] = hf4(c, a, d, b);
  out[2] = hf4(d, c, b, a);
  return out;
}
/** Two values per 2D position. */
export function hf2to2(a: number, b: number, out: number[] = [0, 0]) {
  out[0] = hf2(a, b);
  out[1] = hf3(a, b, 1);
  return out;
}
/** Offset in [100, 200) used to decorrelate noise evaluations (seeded per channel). */
export const offset1 = (seed: number) => 100 + hf1(seed) * 100;
export const offsetN = (seed: number, i: number) => 100 + hf2(seed, i) * 100;

// ---------------------------------------------------------------------------
// Signed-integer PCG hashes of 2–4 lattice coordinates (cellular textures). Arithmetic shifts on
// signed 32-bit values; results map to [0, 1] through the low 31 bits.

const LCG_A = 1664525,
  LCG_C = 1013904223;
const P31 = 0x7fffffff;

function pcg2(x: number, y: number, out: number[]) {
  let a = (Math.imul(x | 0, LCG_A) + LCG_C) | 0,
    b = (Math.imul(y | 0, LCG_A) + LCG_C) | 0;
  a = (a + Math.imul(b, LCG_A)) | 0;
  b = (b + Math.imul(a, LCG_A)) | 0;
  a ^= a >> 16;
  b ^= b >> 16;
  a = (a + Math.imul(b, LCG_A)) | 0;
  b = (b + Math.imul(a, LCG_A)) | 0;
  out[0] = (a & P31) / P31;
  out[1] = (b & P31) / P31;
  return out;
}

function pcg3(x: number, y: number, z: number, out: number[]) {
  let a = (Math.imul(x | 0, LCG_A) + LCG_C) | 0,
    b = (Math.imul(y | 0, LCG_A) + LCG_C) | 0,
    c = (Math.imul(z | 0, LCG_A) + LCG_C) | 0;
  a = (a + Math.imul(b, c)) | 0;
  b = (b + Math.imul(c, a)) | 0;
  c = (c + Math.imul(a, b)) | 0;
  a ^= a >> 16;
  b ^= b >> 16;
  c ^= c >> 16;
  a = (a + Math.imul(b, c)) | 0;
  b = (b + Math.imul(c, a)) | 0;
  c = (c + Math.imul(a, b)) | 0;
  out[0] = (a & P31) / P31;
  out[1] = (b & P31) / P31;
  out[2] = (c & P31) / P31;
  return out;
}

function pcg4(x: number, y: number, z: number, w: number, out: number[]) {
  let a = (Math.imul(x | 0, LCG_A) + LCG_C) | 0,
    b = (Math.imul(y | 0, LCG_A) + LCG_C) | 0,
    c = (Math.imul(z | 0, LCG_A) + LCG_C) | 0,
    d = (Math.imul(w | 0, LCG_A) + LCG_C) | 0;
  a = (a + Math.imul(b, d)) | 0;
  b = (b + Math.imul(c, a)) | 0;
  c = (c + Math.imul(a, b)) | 0;
  d = (d + Math.imul(b, c)) | 0;
  a ^= a >> 16;
  b ^= b >> 16;
  c ^= c >> 16;
  d ^= d >> 16;
  a = (a + Math.imul(b, d)) | 0;
  b = (b + Math.imul(c, a)) | 0;
  c = (c + Math.imul(a, b)) | 0;
  d = (d + Math.imul(b, c)) | 0;
  out[0] = (a & P31) / P31;
  out[1] = (b & P31) / P31;
  out[2] = (c & P31) / P31;
  out[3] = (d & P31) / P31;
  return out;
}

/** Cell jitter in [0, 1]^n of integer cell `c` (n = 2–4). */
export function cellHash(c: ArrayLike<number>, n: number, out: number[]) {
  if (n === 2) return pcg2(c[0], c[1], out);
  if (n === 3) return pcg3(c[0], c[1], c[2], out);
  return pcg4(c[0], c[1], c[2], c[3], out);
}
const tmp4 = [0, 0, 0, 0];
/** Cell color of integer cell `c` (n = 2–4). */
export function cellColorHash(c: ArrayLike<number>, n: number, out: number[]) {
  if (n === 2) return pcg3(c[0], c[1], 0, out);
  if (n === 3) return pcg3(c[0], c[1], c[2], out);
  pcg4(c[0], c[1], c[2], c[3], tmp4);
  out[0] = tmp4[0];
  out[1] = tmp4[1];
  out[2] = tmp4[2];
  return out;
}
