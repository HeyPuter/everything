// Integer hashing for the Hash Value node (Bob Jenkins' public-domain lookup3 final mix), so hash
// values are stable across sessions and platforms.

const rot = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

function final(a: number, b: number, c: number): number {
  c = ((c ^ b) - rot(b, 14)) >>> 0;
  a = ((a ^ c) - rot(c, 11)) >>> 0;
  b = ((b ^ a) - rot(a, 25)) >>> 0;
  c = ((c ^ b) - rot(b, 16)) >>> 0;
  a = ((a ^ c) - rot(c, 4)) >>> 0;
  b = ((b ^ a) - rot(a, 14)) >>> 0;
  c = ((c ^ b) - rot(b, 24)) >>> 0;
  return c;
}

const seedOf = (n: number) => (0xdeadbeef + (n << 2) + 13) >>> 0;

export function jhash1(x: number): number {
  const s = seedOf(1);
  return final((s + x) >>> 0, s, s);
}

export function jhash2(x: number, y: number): number {
  const s = seedOf(2);
  return final((s + x) >>> 0, (s + y) >>> 0, s);
}

export function jhash3(x: number, y: number, z: number): number {
  const s = seedOf(3);
  return final((s + x) >>> 0, (s + y) >>> 0, (s + z) >>> 0);
}

export function jhash4(x: number, y: number, z: number, w: number): number {
  const s = seedOf(4);
  let a = (s + x) >>> 0,
    b = (s + y) >>> 0,
    c = (s + z) >>> 0;
  // intermediate mix of the first three words
  a = (((a - c) >>> 0) ^ rot(c, 4)) >>> 0;
  c = (c + b) >>> 0;
  b = (((b - a) >>> 0) ^ rot(a, 6)) >>> 0;
  a = (a + c) >>> 0;
  c = (((c - b) >>> 0) ^ rot(b, 8)) >>> 0;
  b = (b + a) >>> 0;
  a = (((a - c) >>> 0) ^ rot(c, 16)) >>> 0;
  c = (c + b) >>> 0;
  b = (((b - a) >>> 0) ^ rot(a, 19)) >>> 0;
  a = (a + c) >>> 0;
  c = (((c - b) >>> 0) ^ rot(b, 4)) >>> 0;
  b = (b + a) >>> 0;
  return final((a + w) >>> 0, b >>> 0, c >>> 0);
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** Bit pattern of a 32-bit float. */
export function bitsOf(x: number): number {
  f32[0] = x;
  return u32[0];
}

/** Hash of a string's UTF-8 bytes (multiply by 37 and add each byte). */
export function stringHash(s: string): number {
  let h = 0;
  for (const b of new TextEncoder().encode(s)) h = (Math.imul(h, 37) + b) >>> 0;
  return h;
}
