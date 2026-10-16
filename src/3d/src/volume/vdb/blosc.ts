// Decoder for Blosc (version 1 format) compressed buffers, as written into OpenVDB files.
//
// A buffer starts with a 16-byte header:
//   0 format version, 1 codec format version, 2 flags, 3 element size in bytes,
//   4 uncompressed size (u32), 8 block size (u32), 12 total compressed size (u32)
// Flags: bit 0 byte-shuffle, bit 1 stored uncompressed, bit 2 bit-shuffle, bit 4 blocks were
// not split into per-byte streams, bits 5-7 codec (0 BloscLZ, 1 LZ4, 2 Snappy, 3 zlib, 4 Zstd).
// Unless stored uncompressed, the header is followed by one u32 start offset per block; each
// block holds one or more streams, each prefixed by its compressed size (a stream whose
// compressed size equals its decoded size is stored raw).
import { unzlibSync } from 'three/examples/jsm/libs/fflate.module.js';
import { decompress as zstdDecompress } from 'fzstd';
import { lz4DecodeBlock } from './lz4';

const FLAG_SHUFFLE = 0x1;
const FLAG_MEMCPY = 0x2;
const FLAG_BITSHUFFLE = 0x4;
const FLAG_DONT_SPLIT = 0x10;
const MAX_SPLITS = 16;
const MIN_SPLIT_ELEMENTS = 128;
const CODEC_NAMES = ['BloscLZ', 'LZ4', 'Snappy', 'zlib', 'Zstd'];

export interface BloscHeader {
  version: number;
  flags: number;
  typesize: number;
  /** decoded size in bytes */
  nbytes: number;
  blocksize: number;
  /** size of the whole compressed buffer, header included */
  cbytes: number;
  codec: number;
}

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

export function readBloscHeader(src: Uint8Array): BloscHeader {
  if (src.length < 16) throw new Error('Blosc: buffer is too short for a header');
  const flags = src[2];
  return {
    version: src[0],
    flags,
    typesize: src[3],
    nbytes: u32(src, 4),
    blocksize: u32(src, 8),
    cbytes: u32(src, 12),
    codec: flags >>> 5,
  };
}

/**
 * BloscLZ decoder (a FastLZ-style LZ77 format). Instructions: a control byte below 32 copies
 * `ctrl + 1` literal bytes; otherwise the top 3 bits give the match length (7 = extended by
 * following bytes) and the low 5 bits the high byte of the distance, followed by its low byte
 * (low byte 255 with high bits 31 means a 16-bit far distance follows).
 */
export function blosclzDecodeBlock(src: Uint8Array, dst: Uint8Array): number {
  const srcEnd = src.length;
  const dstEnd = dst.length;
  if (srcEnd === 0) return 0;
  let ip = 0;
  let op = 0;
  let ctrl = src[ip++] & 31;
  for (;;) {
    if (ctrl >= 32) {
      let len = (ctrl >>> 5) - 1;
      const hi = (ctrl & 31) << 8;
      if (len === 6) {
        let b: number;
        do {
          if (ip >= srcEnd) throw new Error('BloscLZ: truncated match length');
          b = src[ip++];
          len += b;
        } while (b === 255);
      }
      if (ip >= srcEnd) throw new Error('BloscLZ: truncated match distance');
      const lo = src[ip++];
      len += 3;
      let dist = hi + lo;
      if (lo === 255 && hi === 31 << 8) {
        if (ip + 2 > srcEnd) throw new Error('BloscLZ: truncated far distance');
        dist = ((src[ip] << 8) | src[ip + 1]) + 8191;
        ip += 2;
      }
      let ref = op - dist - 1;
      if (ref < 0) throw new Error('BloscLZ: match reaches before the start of the output');
      if (op + len > dstEnd) throw new Error('BloscLZ: output buffer too small');
      const end = op + len;
      while (op < end) dst[op++] = dst[ref++];
    } else {
      const n = ctrl + 1;
      if (ip + n > srcEnd) throw new Error('BloscLZ: literals run past the end of input');
      if (op + n > dstEnd) throw new Error('BloscLZ: output buffer too small');
      for (let i = 0; i < n; i++) dst[op + i] = src[ip + i];
      ip += n;
      op += n;
    }
    if (ip >= srcEnd) break;
    ctrl = src[ip++];
  }
  return op;
}

function decodeStream(codec: number, src: Uint8Array, dst: Uint8Array): number {
  switch (codec) {
    case 0:
      return blosclzDecodeBlock(src, dst);
    case 1:
      return lz4DecodeBlock(src, dst);
    case 3: {
      const out = unzlibSync(src, { out: dst });
      if (out.buffer !== dst.buffer || out.byteOffset !== dst.byteOffset) dst.set(out.subarray(0, dst.length));
      return out.length;
    }
    case 4: {
      const out = zstdDecompress(src);
      dst.set(out.subarray(0, dst.length));
      return out.length;
    }
    default:
      throw new Error(`Blosc: the ${CODEC_NAMES[codec] ?? `#${codec}`} codec is not supported`);
  }
}

/** Undo Blosc's byte shuffle (bytes grouped by their position within each element). */
function unshuffle(src: Uint8Array, dst: Uint8Array, dstOffset: number, typesize: number, size: number) {
  const n = Math.floor(size / typesize);
  for (let j = 0; j < typesize; j++) {
    const s = j * n;
    let d = dstOffset + j;
    for (let i = 0; i < n; i++, d += typesize) dst[d] = src[s + i];
  }
  for (let i = n * typesize; i < size; i++) dst[dstOffset + i] = src[i];
}

/** Decompress a complete Blosc buffer. */
export function bloscDecompress(src: Uint8Array): Uint8Array {
  const h = readBloscHeader(src);
  if (h.version === 0) throw new Error('Blosc: not a Blosc buffer');
  if ((h.flags & (FLAG_SHUFFLE | FLAG_BITSHUFFLE)) === (FLAG_SHUFFLE | FLAG_BITSHUFFLE)) {
    throw new Error('Blosc: the extended (version 2) header is not supported');
  }
  const out = new Uint8Array(h.nbytes);
  if (h.nbytes === 0) return out;
  if (h.flags & FLAG_MEMCPY) {
    if (16 + h.nbytes > src.length) throw new Error('Blosc: truncated uncompressed buffer');
    out.set(src.subarray(16, 16 + h.nbytes));
    return out;
  }
  if (h.flags & FLAG_BITSHUFFLE && h.typesize > 1) throw new Error('Blosc: the bit-shuffle filter is not supported');
  if (h.blocksize === 0) throw new Error('Blosc: invalid block size');
  const typesize = Math.max(1, h.typesize);
  const shuffle = (h.flags & FLAG_SHUFFLE) !== 0 && typesize > 1;
  const dontSplit = (h.flags & FLAG_DONT_SPLIT) !== 0;
  const nblocks = Math.ceil(h.nbytes / h.blocksize);
  const leftover = h.nbytes % h.blocksize;
  if (16 + 4 * nblocks > src.length) throw new Error('Blosc: truncated block table');
  const tmp = shuffle ? new Uint8Array(h.blocksize) : null;
  for (let b = 0; b < nblocks; b++) {
    const isLeftover = b === nblocks - 1 && leftover > 0;
    const bsize = isLeftover ? leftover : h.blocksize;
    const outOffset = b * h.blocksize;
    const nsplits =
      !dontSplit && typesize <= MAX_SPLITS && Math.floor(bsize / typesize) >= MIN_SPLIT_ELEMENTS && !isLeftover
        ? typesize
        : 1;
    const neblock = Math.floor(bsize / nsplits);
    const target = tmp ? tmp : out.subarray(outOffset, outOffset + bsize);
    let p = i32(src, 16 + 4 * b);
    let t = 0;
    for (let j = 0; j < nsplits; j++) {
      if (p + 4 > src.length) throw new Error('Blosc: truncated block');
      const cbytes = i32(src, p);
      p += 4;
      if (cbytes < 0 || p + cbytes > src.length) throw new Error('Blosc: corrupt stream size');
      const dst = target.subarray(t, t + neblock);
      if (cbytes === neblock) {
        dst.set(src.subarray(p, p + cbytes));
      } else {
        const n = decodeStream(h.codec, src.subarray(p, p + cbytes), dst);
        if (n !== neblock) throw new Error('Blosc: decoded size does not match the header');
      }
      p += cbytes;
      t += neblock;
    }
    if (tmp) unshuffle(tmp, out, outOffset, typesize, bsize);
  }
  return out;
}
