/**
 * Synchronous DEFLATE decoding (RFC 1951) with zlib (RFC 1950) and gzip
 * wrappers, plus zlib encoding and Adler-32/CRC-32. The importers decode
 * streams while walking a file, so decoding has to be synchronous;
 * encoding uses CompressionStream where the platform has it and falls back
 * to stored blocks (always valid, just larger).
 *
 * Damaged input decodes as far as it can: the bytes produced before the
 * error are returned (many real-world files have truncated streams).
 */

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Canonical Huffman table: { counts[16], symbols[] } (decoded bit by bit, MSB-first codes). */
function huffman(lengths, n) {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  const d = new Uint8Array(30).fill(5);
  FIXED = { lit: huffman(l, 288), dist: huffman(d, 30) };
  return FIXED;
}

class Truncated extends Error {}

class Inflater {
  constructor(src, pos = 0) {
    this.src = src;
    this.pos = pos;
    this.bit = 0;
    this.nbits = 0;
    this.out = new Uint8Array(Math.max(1024, src.length * 4));
    this.len = 0;
  }

  need(n) {
    while (this.nbits < n) {
      if (this.pos >= this.src.length) throw new Truncated();
      this.bit |= this.src[this.pos++] << this.nbits;
      this.nbits += 8;
    }
  }

  bits(n) {
    if (!n) return 0;
    this.need(n);
    const v = this.bit & ((1 << n) - 1);
    this.bit >>>= n;
    this.nbits -= n;
    return v;
  }

  decode(t) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = t.counts[len];
      if (code - count < first) return t.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('Bad Huffman code');
  }

  grow(n) {
    if (this.len + n <= this.out.length) return;
    let size = this.out.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.out.subarray(0, this.len));
    this.out = next;
  }

  stored() {
    this.bit = 0;
    this.nbits = 0;
    if (this.pos + 4 > this.src.length) throw new Truncated();
    const len = this.src[this.pos] | (this.src[this.pos + 1] << 8);
    this.pos += 4;
    const n = Math.min(len, this.src.length - this.pos);
    this.grow(n);
    this.out.set(this.src.subarray(this.pos, this.pos + n), this.len);
    this.len += n;
    this.pos += n;
    if (n < len) throw new Truncated();
  }

  dynamicTables() {
    const hlit = this.bits(5) + 257;
    const hdist = this.bits(5) + 1;
    const hclen = this.bits(4) + 4;
    const cl = new Uint8Array(19);
    for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = this.bits(3);
    const clt = huffman(cl, 19);
    const lengths = new Uint8Array(hlit + hdist);
    for (let i = 0; i < hlit + hdist; ) {
      const sym = this.decode(clt);
      if (sym < 16) lengths[i++] = sym;
      else {
        let rep;
        let val = 0;
        if (sym === 16) {
          if (!i) throw new Error('Bad code lengths');
          val = lengths[i - 1];
          rep = 3 + this.bits(2);
        } else if (sym === 17) rep = 3 + this.bits(3);
        else rep = 11 + this.bits(7);
        while (rep-- && i < lengths.length) lengths[i++] = val;
      }
    }
    return { lit: huffman(lengths.subarray(0, hlit), hlit), dist: huffman(lengths.subarray(hlit), hdist) };
  }

  block({ lit, dist }) {
    for (;;) {
      const sym = this.decode(lit);
      if (sym < 256) {
        if (this.len >= this.out.length) this.grow(1);
        this.out[this.len++] = sym;
      } else if (sym === 256) return;
      else {
        const li = sym - 257;
        if (li >= 29) throw new Error('Bad length code');
        const len = LEN_BASE[li] + this.bits(LEN_EXTRA[li]);
        const di = this.decode(dist);
        if (di >= 30) throw new Error('Bad distance code');
        const d = DIST_BASE[di] + this.bits(DIST_EXTRA[di]);
        if (d > this.len) throw new Error('Bad distance');
        this.grow(len);
        const out = this.out;
        let o = this.len;
        for (let k = 0; k < len; k++, o++) out[o] = out[o - d];
        this.len = o;
      }
    }
  }

  run() {
    let last = 0;
    try {
      while (!last) {
        last = this.bits(1);
        const type = this.bits(2);
        if (type === 0) this.stored();
        else if (type === 1) this.block(fixedTables());
        else if (type === 2) this.block(this.dynamicTables());
        else throw new Error('Bad block type');
      }
    } catch (err) {
      if (!(err instanceof Truncated) && !this.len) throw err;
      this.damaged = true;
    }
    return this.out.slice(0, this.len);
  }
}

/** Decode raw DEFLATE data. */
export function inflateRaw(bytes) {
  return new Inflater(bytes).run();
}

/**
 * Decode a zlib stream (header optional: raw DEFLATE data is accepted too,
 * as some writers omit it).
 */
export function inflate(bytes) {
  if (bytes.length >= 2) {
    const cmf = bytes[0];
    const flg = bytes[1];
    if ((cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0) return new Inflater(bytes, flg & 0x20 ? 6 : 2).run();
  }
  return inflateRaw(bytes);
}

/** Decode a gzip member. */
export function gunzipSync(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Not gzip data');
  const flags = bytes[3];
  let p = 10;
  if (flags & 4) p += 2 + (bytes[p] | (bytes[p + 1] << 8));
  if (flags & 8) while (p < bytes.length && bytes[p++]);
  if (flags & 16) while (p < bytes.length && bytes[p++]);
  if (flags & 2) p += 2;
  return new Inflater(bytes, p).run();
}

export function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 3800);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

let CRC = null;
export function crc32(bytes, crc = 0) {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** zlib stream of stored (uncompressed) blocks. */
export function zlibStored(bytes) {
  const blocks = Math.max(1, Math.ceil(bytes.length / 65535));
  const out = new Uint8Array(2 + bytes.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const part = bytes.subarray(i * 65535, Math.min(bytes.length, (i + 1) * 65535));
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = part.length & 255;
    out[o++] = part.length >> 8;
    out[o++] = ~part.length & 255;
    out[o++] = (~part.length >> 8) & 255;
    out.set(part, o);
    o += part.length;
  }
  const ad = adler32(bytes);
  out.set([ad >>> 24, (ad >> 16) & 255, (ad >> 8) & 255, ad & 255], o);
  return out;
}

/** zlib-compress bytes: CompressionStream when available, stored blocks otherwise. */
export async function deflateZlib(bytes) {
  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('deflate');
      const writer = cs.writable.getWriter();
      writer.write(bytes);
      writer.close();
      return new Uint8Array(await new Response(cs.readable).arrayBuffer());
    } catch {
      // Fall back to stored blocks.
    }
  }
  return zlibStored(bytes);
}
