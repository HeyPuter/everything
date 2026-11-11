// Small byte-level helpers shared by the codecs. Everything works on plain
// Uint8Arrays so the codecs run on the main thread, in workers and in Node.

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodecError';
  }
}

// Turns unexpected failures on malformed input (bounds errors, zlib errors
// thrown as strings) into CodecError so callers handle a single error type.
export function rethrowAsCodecError(e: unknown, what: string): never {
  if (e instanceof CodecError || (e instanceof Error && e.name === 'CancelledError')) throw e;
  const detail = e instanceof Error ? e.message : String(e);
  throw new CodecError(`The ${what} file is damaged or unsupported (${detail}).`);
}

// Size limits a caller can impose so an image too large to use is refused
// from its header, before any pixel memory is allocated.
export type SizeLimits = { maxSide?: number; maxPixels?: number };
export function checkSize(width: number, height: number, limits: SizeLimits | undefined) {
  if (!limits) return;
  const { maxSide = Infinity, maxPixels = Infinity } = limits;
  if (width > maxSide || height > maxSide || width * height > maxPixels)
    throw new CodecError(`This image is ${width} × ${height} pixels, beyond the ${maxSide < Infinity ? `${maxSide} pixel per side` : ''}${maxSide < Infinity && maxPixels < Infinity ? ' or ' : ''}${maxPixels < Infinity ? `${Math.round(maxPixels / 1e6)} megapixel` : ''} limit.`);
}

let crcTable: Uint32Array | undefined;
// CRC-32 (ISO 3309 / ITU-T V.42), as used by PNG and zlib.
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length, seed = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const t = crcTable;
  let c = ~seed >>> 0;
  for (let i = start; i < end; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// Growable little/big-endian byte sink for encoders.
export class ByteWriter {
  buf: Uint8Array;
  length = 0;
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(Math.max(16, capacity));
  }
  ensure(extra: number) {
    const need = this.length + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.length++] = v;
  }
  u16le(v: number) {
    this.ensure(2);
    this.buf[this.length++] = v & 0xff;
    this.buf[this.length++] = (v >>> 8) & 0xff;
  }
  u16be(v: number) {
    this.ensure(2);
    this.buf[this.length++] = (v >>> 8) & 0xff;
    this.buf[this.length++] = v & 0xff;
  }
  u32le(v: number) {
    this.ensure(4);
    const b = this.buf;
    let p = this.length;
    b[p++] = v & 0xff;
    b[p++] = (v >>> 8) & 0xff;
    b[p++] = (v >>> 16) & 0xff;
    b[p++] = (v >>> 24) & 0xff;
    this.length = p;
  }
  u32be(v: number) {
    this.ensure(4);
    const b = this.buf;
    let p = this.length;
    b[p++] = (v >>> 24) & 0xff;
    b[p++] = (v >>> 16) & 0xff;
    b[p++] = (v >>> 8) & 0xff;
    b[p++] = v & 0xff;
    this.length = p;
  }
  bytes(src: ArrayLike<number>) {
    this.ensure(src.length);
    this.buf.set(src, this.length);
    this.length += src.length;
  }
  ascii(s: string) {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.length++] = s.charCodeAt(i) & 0xff;
  }
  pad(n: number, value = 0) {
    this.ensure(n);
    this.buf.fill(value, this.length, this.length + n);
    this.length += n;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length && offset + i < bytes.length; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

export function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 256 ? c : 0x3f;
  }
  return out;
}
export function latin1String(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
  return s;
}

const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Own base64 so the SVG builder needs neither btoa nor Buffer.
export function base64Encode(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const n = bytes.length;
  let line = '';
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i];
    const b = i + 1 < n ? bytes[i + 1] : 0;
    const c = i + 2 < n ? bytes[i + 2] : 0;
    line +=
      b64[a >> 2] +
      b64[((a & 3) << 4) | (b >> 4)] +
      (i + 1 < n ? b64[((b & 15) << 2) | (c >> 6)] : '=') +
      (i + 2 < n ? b64[c & 63] : '=');
    if (line.length >= 16384) {
      chunks.push(line);
      line = '';
    }
  }
  chunks.push(line);
  return chunks.join('');
}
