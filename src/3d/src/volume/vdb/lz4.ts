// LZ4 block-format decoder (no frame header). A block is a run of sequences; each starts with
// a token byte whose high nibble is the literal count and low nibble the match length minus 4
// (15 in either nibble means "more length bytes follow, each adding up to 255"). Literals are
// followed by a 2-byte little-endian back-reference offset, except in the last sequence.

/**
 * Decode one LZ4 block from `src` into `dst` (which must be large enough for the whole
 * output). Returns the number of bytes written. Throws on malformed input.
 */
export function lz4DecodeBlock(src: Uint8Array, dst: Uint8Array): number {
  const srcEnd = src.length;
  const dstEnd = dst.length;
  let ip = 0;
  let op = 0;
  if (srcEnd === 0) return 0;
  for (;;) {
    if (ip >= srcEnd) throw new Error('LZ4: unexpected end of input');
    const token = src[ip++];
    // literals
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b: number;
      do {
        if (ip >= srcEnd) throw new Error('LZ4: truncated literal length');
        b = src[ip++];
        litLen += b;
      } while (b === 255);
    }
    if (litLen > 0) {
      if (ip + litLen > srcEnd) throw new Error('LZ4: literals run past the end of input');
      if (op + litLen > dstEnd) throw new Error('LZ4: output buffer too small');
      if (litLen < 16) {
        for (let i = 0; i < litLen; i++) dst[op + i] = src[ip + i];
      } else {
        dst.set(src.subarray(ip, ip + litLen), op);
      }
      ip += litLen;
      op += litLen;
    }
    // the last sequence has no match part
    if (ip >= srcEnd) break;
    if (ip + 2 > srcEnd) throw new Error('LZ4: truncated match offset');
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error('LZ4: invalid match offset');
    let matchLen = token & 15;
    if (matchLen === 15) {
      let b: number;
      do {
        if (ip >= srcEnd) throw new Error('LZ4: truncated match length');
        b = src[ip++];
        matchLen += b;
      } while (b === 255);
    }
    matchLen += 4;
    if (op + matchLen > dstEnd) throw new Error('LZ4: output buffer too small');
    let ref = op - offset;
    if (offset >= matchLen) {
      // non-overlapping copy
      if (matchLen < 32) {
        for (let i = 0; i < matchLen; i++) dst[op + i] = dst[ref + i];
      } else {
        dst.copyWithin(op, ref, ref + matchLen);
      }
      op += matchLen;
    } else {
      // overlapping (run-length style) copy must go byte by byte
      const end = op + matchLen;
      while (op < end) dst[op++] = dst[ref++];
    }
  }
  return op;
}
