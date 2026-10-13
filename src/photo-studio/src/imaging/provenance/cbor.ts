// CBOR (RFC 8949) encoder and decoder for the subset provenance manifests
// use: integers up to 2^53, byte and text strings, arrays, maps, tags,
// simple values and floats. Maps keep insertion order (no canonical
// sorting). Decoded maps are plain objects when every key is a text string
// and `Map`s otherwise (COSE headers use integer keys).
import { CodecError } from '../codecs/bytes';

/** A tagged value (major type 6), e.g. `new CborTag(18, [...])` for COSE_Sign1. */
export class CborTag {
  constructor(
    public tag: number,
    public value: unknown,
  ) {}
}
export type CborMap = Map<string | number, unknown>;

class Out {
  buf = new Uint8Array(256);
  n = 0;
  room(k: number) {
    if (this.n + k <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.n + k) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }
  byte(v: number) {
    this.room(1);
    this.buf[this.n++] = v;
  }
  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  // Initial byte with the shortest argument encoding (RFC 8949 §3).
  head(major: number, v: number) {
    const m = major << 5;
    if (v < 24) this.byte(m | v);
    else if (v < 0x100) this.bytes(Uint8Array.of(m | 24, v));
    else if (v < 0x10000) this.bytes(Uint8Array.of(m | 25, v >> 8, v & 255));
    else if (v < 0x100000000) this.bytes(Uint8Array.of(m | 26, v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255));
    else {
      const hi = Math.floor(v / 0x100000000),
        lo = v >>> 0;
      this.bytes(Uint8Array.of(m | 27, hi >>> 24, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, lo >>> 24, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255));
    }
  }
}

const utf8 = new TextEncoder();
function write(o: Out, v: unknown) {
  if (v === false) o.byte(0xf4);
  else if (v === true) o.byte(0xf5);
  else if (v === null) o.byte(0xf6);
  else if (v === undefined) o.byte(0xf7);
  else if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
      if (v >= 0) o.head(0, v);
      else o.head(1, -1 - v);
    } else {
      const b = new Uint8Array(9);
      b[0] = 0xfb;
      new DataView(b.buffer).setFloat64(1, v);
      o.bytes(b);
    }
  } else if (typeof v === 'string') {
    const b = utf8.encode(v);
    o.head(3, b.length);
    o.bytes(b);
  } else if (v instanceof Uint8Array) {
    o.head(2, v.length);
    o.bytes(v);
  } else if (Array.isArray(v)) {
    o.head(4, v.length);
    for (const x of v) write(o, x);
  } else if (v instanceof CborTag) {
    o.head(6, v.tag);
    write(o, v.value);
  } else if (v instanceof Map) {
    o.head(5, v.size);
    for (const [k, x] of v) {
      write(o, k);
      write(o, x);
    }
  } else if (typeof v === 'object') {
    // Plain objects: entries whose value is undefined are left out.
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    o.head(5, entries.length);
    for (const [k, x] of entries) {
      write(o, k);
      write(o, x);
    }
  } else throw new CodecError(`CBOR cannot encode a ${typeof v}.`);
}

export function encodeCbor(v: unknown): Uint8Array {
  const o = new Out();
  write(o, v);
  return o.buf.slice(0, o.n);
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_DEPTH = 64;
class In {
  p = 0;
  constructor(public b: Uint8Array) {}
  need(k: number) {
    if (this.p + k > this.b.length) throw new CodecError('CBOR data is truncated.');
  }
  u8() {
    this.need(1);
    return this.b[this.p++];
  }
  arg(info: number): number {
    if (info < 24) return info;
    const be = (k: number) => this.take(k).reduce((v, x) => v * 256 + x, 0);
    if (info === 24) return be(1);
    if (info === 25) return be(2);
    if (info === 26) return be(4);
    if (info === 27) {
      const v = be(8);
      if (v > Number.MAX_SAFE_INTEGER) throw new CodecError('CBOR integer is too large.');
      return v;
    }
    throw new CodecError('Indefinite-length or reserved CBOR item.');
  }
  take(n: number) {
    this.need(n);
    return this.b.subarray(this.p, (this.p += n));
  }
}

function half(h: number) {
  const e = (h >> 10) & 31,
    m = h & 1023,
    s = h & 0x8000 ? -1 : 1;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

function read(r: In, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new CodecError('CBOR data is nested too deeply.');
  const ib = r.u8();
  const major = ib >> 5,
    info = ib & 31;
  if (major === 7) {
    if (info === 20) return false;
    if (info === 21) return true;
    if (info === 22) return null;
    if (info === 23) return undefined;
    const float = (size: number) => {
      const dv = new DataView(r.take(size).slice().buffer);
      return size === 2 ? half(dv.getUint16(0)) : size === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
    };
    if (info === 25) return float(2);
    if (info === 26) return float(4);
    if (info === 27) return float(8);
    if (info < 24) return { simple: info };
    throw new CodecError('Unsupported CBOR simple value.');
  }
  const n = r.arg(info);
  switch (major) {
    case 0:
      return n;
    case 1:
      return -1 - n;
    case 2:
      return r.take(n).slice();
    case 3:
      try {
        return utf8Decoder.decode(r.take(n));
      } catch {
        throw new CodecError('CBOR text is not valid UTF-8.');
      }
    case 4: {
      if (n > r.b.length - r.p) throw new CodecError('CBOR array is truncated.');
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(read(r, depth + 1));
      return out;
    }
    case 5: {
      if (n * 2 > r.b.length - r.p) throw new CodecError('CBOR map is truncated.');
      const m: CborMap = new Map();
      for (let i = 0; i < n; i++) {
        const k = read(r, depth + 1);
        if (typeof k !== 'string' && typeof k !== 'number') throw new CodecError('Unsupported CBOR map key.');
        m.set(k, read(r, depth + 1));
      }
      return [...m.keys()].every((k) => typeof k === 'string') ? Object.fromEntries(m) : m;
    }
    default:
      return new CborTag(n, read(r, depth + 1));
  }
}

/** Decode one CBOR item; trailing bytes are an error unless `allowTrailing`. */
export function decodeCbor(bytes: Uint8Array, allowTrailing = false): unknown {
  const r = new In(bytes);
  const v = read(r, 0);
  if (!allowTrailing && r.p !== bytes.length) throw new CodecError('Unexpected bytes after the CBOR item.');
  return v;
}

/** Read a field of a decoded map (plain object or Map). */
export function cborGet(m: unknown, key: string | number): unknown {
  if (m instanceof Map) return m.get(key);
  if (m && typeof m === 'object' && !Array.isArray(m) && typeof key === 'string') return (m as Record<string, unknown>)[key];
  return undefined;
}
