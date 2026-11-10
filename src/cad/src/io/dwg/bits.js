/**
 * Bit-level reading and writing of DWG data (R13 and later), following the
 * Open Design Specification for .dwg files. Values are packed MSB first and
 * multi-byte raw values are little-endian.
 *
 * Version numbers are the digits of the file's version string: 1012 (R13),
 * 1014 (R14), 1015 (R2000), 1018 (R2004), 1021 (R2007), 1024 (R2010),
 * 1027 (R2013) and 1032 (R2018).
 */

export const R13 = 1012;
export const R14 = 1014;
export const R2000 = 1015;
export const R2004 = 1018;
export const R2007 = 1021;
export const R2010 = 1024;
export const R2013 = 1027;
export const R2018 = 1032;

const F64 = new Float64Array(1);
const F64B = new Uint8Array(F64.buffer);

/* ------------------------------------------------------------------ */
/* CRC                                                                 */
/* ------------------------------------------------------------------ */

const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
  CRC16[i] = c;
}

/** The 16-bit CRC DWG uses for sections and objects. */
export function crc16(u8, start, end, seed) {
  let c = seed & 0xffff;
  for (let i = start; i < end; i++) c = (c >>> 8) ^ CRC16[(c ^ u8[i]) & 0xff];
  return c;
}

const CRC32 = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  CRC32[i] = c >>> 0;
}

/** Standard CRC-32 (used by the R2004 file header). */
export function crc32(u8, start, end, seed = 0) {
  let c = ~seed >>> 0;
  for (let i = start; i < end; i++) c = (c >>> 8) ^ CRC32[(c ^ u8[i]) & 0xff];
  return ~c >>> 0;
}

/* ------------------------------------------------------------------ */
/* Text encodings                                                      */
/* ------------------------------------------------------------------ */

/** $DWGCODEPAGE names by the number stored in DWG files. */
export const CODEPAGES = [
  '', 'US_ASCII', 'ISO8859-1', 'ISO8859-2', 'ISO8859-3', 'ISO8859-4', 'ISO8859-5', 'ISO8859-6', 'ISO8859-7',
  'ISO8859-8', 'ISO8859-9', 'DOS437', 'DOS850', 'DOS852', 'DOS855', 'DOS857', 'DOS860', 'DOS861', 'DOS863',
  'DOS864', 'DOS865', 'DOS869', 'DOS932', 'MACINTOSH', 'BIG5', 'KSC5601', 'JOHAB', 'DOS866', 'ANSI_1250',
  'ANSI_1251', 'ANSI_1252', 'GB2312', 'ANSI_1253', 'ANSI_1254', 'ANSI_1255', 'ANSI_1256', 'ANSI_1257',
  'ANSI_874', 'ANSI_932', 'ANSI_936', 'ANSI_949', 'ANSI_950', 'ANSI_1361', 'ANSI_1200', 'ANSI_1258',
];

const LABELS = {
  'ISO8859-1': 'iso-8859-1', 'ISO8859-2': 'iso-8859-2', 'ISO8859-3': 'iso-8859-3', 'ISO8859-4': 'iso-8859-4',
  'ISO8859-5': 'iso-8859-5', 'ISO8859-6': 'iso-8859-6', 'ISO8859-7': 'iso-8859-7', 'ISO8859-8': 'iso-8859-8',
  'ISO8859-9': 'iso-8859-9', DOS866: 'ibm866', DOS932: 'shift_jis', MACINTOSH: 'macintosh', BIG5: 'big5',
  KSC5601: 'euc-kr', JOHAB: 'euc-kr', GB2312: 'gbk', ANSI_874: 'windows-874', ANSI_932: 'shift_jis',
  ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5', ANSI_1361: 'euc-kr',
};

/** A TextDecoder for a DWG codepage number (windows-1252 when unknown). */
export function codepageDecoder(cp) {
  const name = CODEPAGES[cp] || 'ANSI_1252';
  let label = LABELS[name];
  if (!label && /^ANSI_125\d$/.test(name)) label = 'windows-' + name.slice(5);
  try {
    return new TextDecoder(label || 'windows-1252');
  } catch {
    return new TextDecoder('windows-1252');
  }
}

const W1252 = new Map();
{
  const d = new TextDecoder('windows-1252');
  for (let b = 0x80; b < 0x100; b++) {
    const ch = d.decode(new Uint8Array([b]));
    if (ch.length === 1 && !W1252.has(ch.charCodeAt(0))) W1252.set(ch.charCodeAt(0), b);
  }
}

/** Encode a string as windows-1252 bytes; other characters become \U+XXXX. */
export function encode1252(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (W1252.has(c)) out.push(W1252.get(c));
    else {
      const esc = '\\U+' + c.toString(16).toUpperCase().padStart(4, '0');
      for (let k = 0; k < esc.length; k++) out.push(esc.charCodeAt(k));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Reader                                                              */
/* ------------------------------------------------------------------ */

export class BitReader {
  /**
   * @param {Uint8Array} u8
   * @param {number} ver version number (see top of file)
   * @param {number} [pos] start position in bits
   * @param {number} [end] end position in bits
   */
  constructor(u8, ver, pos = 0, end = u8.length * 8) {
    this.u8 = u8;
    this.ver = ver;
    this.pos = pos;
    this.end = Math.min(end, u8.length * 8);
    this.decoder = null;
  }

  /** A reader over the same bytes at another position. */
  fork(pos = this.pos, end = this.end) {
    const r = new BitReader(this.u8, this.ver, pos, end);
    r.decoder = this.decoder;
    return r;
  }

  get remaining() {
    return this.end - this.pos;
  }

  overrun(n) {
    throw new RangeError(`DWG data ends early (need ${n} bits at ${this.pos} of ${this.end})`);
  }

  B() {
    const p = this.pos;
    if (p >= this.end) this.overrun(1);
    this.pos = p + 1;
    return (this.u8[p >> 3] >> (7 - (p & 7))) & 1;
  }

  BB() {
    return (this.B() << 1) | this.B();
  }

  /** 1 to 3 bits: stops at the first 0 bit. */
  B3() {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.B();
      v = (v << 1) | b;
      if (!b) break;
    }
    return v;
  }

  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.B();
    return v;
  }

  RC() {
    const p = this.pos;
    if (p + 8 > this.end) this.overrun(8);
    this.pos = p + 8;
    const i = p >> 3;
    const s = p & 7;
    if (s === 0) return this.u8[i];
    return ((this.u8[i] << s) | (this.u8[i + 1] >> (8 - s))) & 0xff;
  }

  RS() {
    return this.RC() | (this.RC() << 8);
  }

  RSs() {
    return (this.RS() << 16) >> 16;
  }

  RL() {
    return (this.RS() | (this.RS() << 16)) >>> 0;
  }

  RLs() {
    return this.RS() | (this.RS() << 16);
  }

  RLL() {
    const lo = this.RL();
    return lo + this.RL() * 4294967296;
  }

  RD() {
    for (let i = 0; i < 8; i++) F64B[i] = this.RC();
    return F64[0];
  }

  bytes(n) {
    if (this.pos + n * 8 > this.end) this.overrun(n * 8);
    const out = new Uint8Array(n);
    if ((this.pos & 7) === 0) {
      out.set(this.u8.subarray(this.pos >> 3, (this.pos >> 3) + n));
      this.pos += n * 8;
    } else for (let i = 0; i < n; i++) out[i] = this.RC();
    return out;
  }

  BS() {
    switch (this.BB()) {
      case 0:
        return this.RS();
      case 1:
        return this.RC();
      case 2:
        return 0;
      default:
        return 256;
    }
  }

  /** A bitshort read as a signed value. */
  BSs() {
    return (this.BS() << 16) >> 16;
  }

  BL() {
    switch (this.BB()) {
      case 0:
        return this.RLs();
      case 1:
        return this.RC();
      case 2:
        return 0;
      default:
        throw new RangeError('Invalid bitlong');
    }
  }

  BLL() {
    const n = this.bits(3);
    let v = 0;
    let m = 1;
    for (let i = 0; i < n; i++) {
      v += this.RC() * m;
      m *= 256;
    }
    return v;
  }

  BD() {
    switch (this.BB()) {
      case 0:
        return this.RD();
      case 1:
        return 1;
      case 2:
        return 0;
      default:
        throw new RangeError('Invalid bitdouble');
    }
  }

  /** Bitdouble with a default value. */
  DD(def) {
    switch (this.BB()) {
      case 0:
        return def;
      case 1:
        F64[0] = def;
        for (let i = 0; i < 4; i++) F64B[i] = this.RC();
        return F64[0];
      case 2:
        F64[0] = def;
        F64B[4] = this.RC();
        F64B[5] = this.RC();
        for (let i = 0; i < 4; i++) F64B[i] = this.RC();
        return F64[0];
      default:
        return this.RD();
    }
  }

  RD2() {
    return [this.RD(), this.RD()];
  }

  RD3() {
    return [this.RD(), this.RD(), this.RD()];
  }

  BD2() {
    return [this.BD(), this.BD()];
  }

  BD3() {
    return [this.BD(), this.BD(), this.BD()];
  }

  DD2(d) {
    return [this.DD(d[0]), this.DD(d[1])];
  }

  /** Extrusion: R2000+ stores (0,0,1) as one bit. */
  BE() {
    if (this.ver >= R2000 && this.B()) return [0, 0, 1];
    return this.BD3();
  }

  /** Thickness: R2000+ stores 0 as one bit. */
  BT() {
    if (this.ver >= R2000 && this.B()) return 0;
    return this.BD();
  }

  /** Signed modular char. */
  MC() {
    let v = 0;
    let m = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.RC();
      if (b & 0x80) {
        v += (b & 0x7f) * m;
        m *= 128;
      } else {
        v += (b & 0x3f) * m;
        return b & 0x40 ? -v : v;
      }
    }
    throw new RangeError('Invalid modular char');
  }

  /** Unsigned modular char. */
  UMC() {
    let v = 0;
    let m = 1;
    for (let i = 0; i < 10; i++) {
      const b = this.RC();
      v += (b & 0x7f) * m;
      if (!(b & 0x80)) return v;
      m *= 128;
    }
    throw new RangeError('Invalid modular char');
  }

  /** Modular short (object sizes). */
  MS() {
    let v = 0;
    let m = 1;
    for (let i = 0; i < 4; i++) {
      const w = this.RS();
      v += (w & 0x7fff) * m;
      if (!(w & 0x8000)) return v;
      m *= 32768;
    }
    throw new RangeError('Invalid modular short');
  }

  /** Handle reference: { code, value }. */
  H() {
    const b = this.RC();
    const n = b & 15;
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + this.RC();
    return { code: b >> 4, value: v };
  }

  /** Handle reference resolved against the handle of the object holding it. */
  HR(ref) {
    const h = this.H();
    switch (h.code) {
      case 6:
        return ref + 1;
      case 8:
        return ref - 1;
      case 0xa:
        return ref + h.value;
      case 0xc:
        return ref - h.value;
      default:
        return h.value;
    }
  }

  /** 8-bit codepage string with a bitshort length. */
  TV() {
    const n = this.BS();
    if (!n) return '';
    const b = this.bytes(n);
    let e = n;
    while (e > 0 && b[e - 1] === 0) e--;
    return (this.decoder || (this.decoder = codepageDecoder(30))).decode(b.subarray(0, e));
  }

  /** UTF-16 string with a bitshort length (R2007+). */
  TU() {
    const n = this.BS();
    if (n > this.remaining / 16) this.overrun(n * 16);
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = this.RS();
      if (c === 0) {
        this.pos += (n - i - 1) * 16;
        break;
      }
      s += String.fromCharCode(c);
    }
    return s;
  }

  /** Text in the version's string format. */
  T() {
    return this.ver >= R2007 ? this.TU() : this.TV();
  }

  /** Color (CMC): returns { index, rgb, name } with rgb null for indexed colors. */
  CMC() {
    const index = this.BS();
    if (this.ver < R2004) return { index, rgb: null, name: '' };
    const rgb = this.BL() >>> 0;
    const flags = this.RC();
    let name = '';
    if (flags & 1) name = this.T();
    if (flags & 2) this.T();
    return cmcColor(index, rgb, name);
  }

  /** Entity color (ENC, R2004+). Returns { index, rgb, alpha, book }. */
  ENC() {
    if (this.ver < R2004) {
      const c = this.CMC();
      return { index: c.index, rgb: null, alpha: null, book: false };
    }
    const v = this.BS();
    const flags = v >> 8;
    let index = v & 0x1ff;
    let rgb = null;
    let alpha = null;
    if (flags & 0x80) {
      const raw = this.BL() >>> 0;
      const m = raw >>> 24;
      if (m === 0xc2) rgb = raw & 0xffffff;
      else if (m === 0xc3) index = raw & 0xff;
      else if (m === 0xc0) index = 256;
      else if (m === 0xc1) index = 0;
    }
    if (flags & 0x20) alpha = this.BL() >>> 0;
    return { index, rgb, alpha, book: (flags & 0x40) !== 0 };
  }

  /** Object type: BS, or R2010+ the 2-bit coded form. */
  OT() {
    if (this.ver < R2010) return this.BS();
    switch (this.BB()) {
      case 0:
        return this.RC();
      case 1:
        return this.RC() + 0x1f0;
      default:
        return this.RS();
    }
  }

  align() {
    this.pos = (this.pos + 7) & ~7;
  }
}

/** Interpret a CMC's index and raw RGB word. */
function cmcColor(index, raw, name) {
  const m = raw >>> 24;
  if (m === 0xc2) return { index, rgb: raw & 0xffffff, name };
  if (m === 0xc3) return { index: raw & 0xff, rgb: null, name };
  if (m === 0xc0) return { index: 256, rgb: null, name };
  if (m === 0xc1) return { index: 0, rgb: null, name };
  return { index, rgb: null, name };
}

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

export class BitWriter {
  constructor(ver, size = 1024) {
    this.ver = ver;
    this.u8 = new Uint8Array(size);
    this.pos = 0;
  }

  ensure(bits) {
    const need = (this.pos + bits + 7) >> 3;
    if (need <= this.u8.length) return;
    let n = this.u8.length * 2;
    while (n < need) n *= 2;
    const u = new Uint8Array(n);
    u.set(this.u8);
    this.u8 = u;
  }

  /** Bytes written so far (the last byte zero-padded). */
  bytes() {
    return this.u8.slice(0, (this.pos + 7) >> 3);
  }

  get byteLength() {
    return (this.pos + 7) >> 3;
  }

  B(v) {
    this.ensure(1);
    const p = this.pos++;
    if (v) this.u8[p >> 3] |= 0x80 >> (p & 7);
    else this.u8[p >> 3] &= ~(0x80 >> (p & 7));
  }

  BB(v) {
    this.B(v & 2);
    this.B(v & 1);
  }

  bits(v, n) {
    for (let i = n - 1; i >= 0; i--) this.B(Math.floor(v / 2 ** i) & 1);
  }

  B3(v) {
    // 0 -> 0, 2 -> 10, 6 -> 110, 7 -> 111
    if (v === 0) this.B(0);
    else if (v === 2) this.bits(2, 2);
    else if (v === 6) this.bits(6, 3);
    else this.bits(7, 3);
  }

  RC(v) {
    v &= 0xff;
    this.ensure(8);
    const p = this.pos;
    const i = p >> 3;
    const s = p & 7;
    if (s === 0) this.u8[i] = v;
    else {
      this.u8[i] = (this.u8[i] & (0xff << (8 - s))) | (v >> s);
      this.u8[i + 1] = (v << (8 - s)) & 0xff;
    }
    this.pos = p + 8;
  }

  RS(v) {
    this.RC(v);
    this.RC(v >> 8);
  }

  RL(v) {
    this.RS(v & 0xffff);
    this.RS((v >>> 16) & 0xffff);
  }

  RLL(v) {
    this.RL(v % 4294967296);
    this.RL(Math.floor(v / 4294967296));
  }

  RD(v) {
    F64[0] = v;
    for (let i = 0; i < 8; i++) this.RC(F64B[i]);
  }

  rawBytes(arr) {
    for (let i = 0; i < arr.length; i++) this.RC(arr[i]);
  }

  BS(v) {
    v &= 0xffff;
    if (v === 0) this.BB(2);
    else if (v === 256) this.BB(3);
    else if (v < 256) {
      this.BB(1);
      this.RC(v);
    } else {
      this.BB(0);
      this.RS(v);
    }
  }

  BL(v) {
    v |= 0;
    if (v === 0) this.BB(2);
    else if (v > 0 && v < 256) {
      this.BB(1);
      this.RC(v);
    } else {
      this.BB(0);
      this.RL(v >>> 0);
    }
  }

  BLL(v) {
    const b = [];
    while (v > 0) {
      b.push(v % 256);
      v = Math.floor(v / 256);
    }
    this.bits(b.length, 3);
    for (const x of b) this.RC(x);
  }

  BD(v) {
    v = +v || 0;
    if (v === 1) this.BB(1);
    else if (v === 0 && !Object.is(v, -0)) this.BB(2);
    else {
      this.BB(0);
      this.RD(v);
    }
  }

  DD(v, def) {
    v = +v || 0;
    if (v === def) this.BB(0);
    else {
      this.BB(3);
      this.RD(v);
    }
  }

  RD2(p) {
    this.RD(+p[0] || 0);
    this.RD(+p[1] || 0);
  }

  RD3(p) {
    this.RD(+p[0] || 0);
    this.RD(+p[1] || 0);
    this.RD(+p[2] || 0);
  }

  BD2(p) {
    this.BD(p[0]);
    this.BD(p[1]);
  }

  BD3(p) {
    this.BD(p[0]);
    this.BD(p[1]);
    this.BD(p[2]);
  }

  DD2(p, d) {
    this.DD(p[0], d[0]);
    this.DD(p[1], d[1]);
  }

  BE(p) {
    if (this.ver >= R2000) {
      const unit = !+p[0] && !+p[1] && +p[2] === 1;
      this.B(unit);
      if (unit) return;
    }
    this.BD3(p);
  }

  BT(v) {
    if (this.ver >= R2000) {
      this.B(!+v);
      if (!+v) return;
    }
    this.BD(v);
  }

  MC(v) {
    const neg = v < 0;
    v = Math.abs(v);
    for (;;) {
      if (v < 0x40) {
        this.RC(v | (neg ? 0x40 : 0));
        return;
      }
      this.RC((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
  }

  UMC(v) {
    for (;;) {
      if (v < 0x80) {
        this.RC(v);
        return;
      }
      this.RC((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
  }

  MS(v) {
    for (;;) {
      if (v < 0x8000) {
        this.RS(v);
        return;
      }
      this.RS((v & 0x7fff) | 0x8000);
      v = Math.floor(v / 32768);
    }
  }

  /** Handle with code and absolute value. */
  H(code, value) {
    const b = [];
    while (value > 0) {
      b.unshift(value % 256);
      value = Math.floor(value / 256);
    }
    this.RC((code << 4) | b.length);
    for (const x of b) this.RC(x);
  }

  TV(s) {
    const b = encode1252(String(s ?? ''));
    if (!b.length) {
      this.BS(0);
      return;
    }
    this.BS(b.length + 1);
    this.rawBytes(b);
    this.RC(0);
  }

  TU(s) {
    s = String(s ?? '');
    if (!s.length) {
      this.BS(0);
      return;
    }
    this.BS(s.length + 1);
    for (let i = 0; i < s.length; i++) this.RS(s.charCodeAt(i));
    this.RS(0);
  }

  T(s) {
    if (this.ver >= R2007) this.TU(s);
    else this.TV(s);
  }

  /** Color as index (0..256) or true color { rgb }. */
  CMC(index, rgb = null) {
    if (this.ver < R2004) {
      this.BS(index);
      return;
    }
    if (rgb !== null) {
      this.BS(0);
      this.BL(0xc2000000 | (rgb & 0xffffff));
    } else {
      this.BS(index);
      const m = index === 256 ? 0xc0 : index === 0 ? 0xc1 : 0xc3;
      this.BL((m << 24) | (m === 0xc3 ? index & 0xff : 0));
    }
    this.RC(0);
  }

  ENC(index, rgb = null, alpha = null) {
    if (this.ver < R2004) {
      this.BS(index);
      return;
    }
    let flags = 0;
    if (rgb !== null) flags |= 0x80;
    if (alpha !== null) flags |= 0x20;
    this.BS((flags << 8) | (index & 0x1ff));
    if (rgb !== null) this.BL(0xc2000000 | (rgb & 0xffffff));
    if (alpha !== null) this.BL(alpha);
  }

  OT(t) {
    if (this.ver < R2010) {
      this.BS(t);
      return;
    }
    if (t < 256) {
      this.BB(0);
      this.RC(t);
    } else if (t >= 0x1f0 && t < 0x1f0 + 256) {
      this.BB(1);
      this.RC(t - 0x1f0);
    } else {
      this.BB(2);
      this.RS(t);
    }
  }

  align() {
    while (this.pos & 7) this.B(0);
  }

  /** Append the bits of another writer. */
  append(w) {
    if ((this.pos & 7) === 0) {
      const n = w.byteLength;
      this.ensure(n * 8);
      this.u8.set(w.u8.subarray(0, n), this.pos >> 3);
      this.pos += w.pos;
      // clear the bits past the appended end
      return;
    }
    const full = w.pos >> 3;
    for (let i = 0; i < full; i++) this.RC(w.u8[i]);
    for (let p = full * 8; p < w.pos; p++) this.B((w.u8[p >> 3] >> (7 - (p & 7))) & 1);
  }
}
