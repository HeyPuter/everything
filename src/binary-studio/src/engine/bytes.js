/** Little-endian readers over an ArrayBuffer-backed view. */

export function viewOf(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new TypeError('expected ArrayBuffer or Uint8Array');
}

export function u8(buf, off) {
  if (off < 0 || off >= buf.length) throw new RangeError(`u8 out of range @${off}`);
  return buf[off];
}

export function u16(buf, off) {
  if (off < 0 || off + 1 >= buf.length) throw new RangeError(`u16 out of range @${off}`);
  return buf[off] | (buf[off + 1] << 8);
}

export function u32(buf, off) {
  if (off < 0 || off + 3 >= buf.length) throw new RangeError(`u32 out of range @${off}`);
  return (
    (buf[off] |
      (buf[off + 1] << 8) |
      (buf[off + 2] << 16) |
      (buf[off + 3] << 24)) >>>
    0
  );
}

export function u64(buf, off) {
  const lo = u32(buf, off);
  const hi = u32(buf, off + 4);
  // Prefer Number when safe; otherwise return a BigInt for callers that need it.
  if (hi === 0) return lo;
  const n = BigInt(lo) + (BigInt(hi) << 32n);
  if (n <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(n);
  return n;
}

export function asciiZ(buf, off, max = 256) {
  let end = off;
  const lim = Math.min(buf.length, off + max);
  while (end < lim && buf[end] !== 0) end += 1;
  return String.fromCharCode(...buf.subarray(off, end));
}

export function hexBytes(buf, off, len) {
  const parts = [];
  const end = Math.min(buf.length, off + len);
  for (let i = off; i < end; i += 1) {
    parts.push(buf[i].toString(16).padStart(2, '0'));
  }
  return parts.join(' ');
}

export function formatAddr(n, width = 8) {
  const v = typeof n === 'bigint' ? n : BigInt(n >>> 0);
  return '0x' + v.toString(16).padStart(width, '0');
}
