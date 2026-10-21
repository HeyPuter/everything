// .blend container reader: file header, block headers ("BHead") and the embedded
// SDNA catalogue that describes every struct layout stored in the file.
// Written from the publicly documented container layout; struct layouts are never
// hard-coded — they are derived at runtime from the file's own DNA1 block.

export class BlendError extends Error {}

export interface BlendHeader {
  pointerSize: 4 | 8;
  littleEndian: boolean;
  /** e.g. 502 for 5.2 */
  version: number;
  /** 0 for the classic 12-byte header, ≥1 for the newer variable-length header */
  formatVersion: number;
  headerSize: number;
  /** block headers use 64-bit lengths/counts (newer header) */
  largeBHead: boolean;
}

export interface BHead {
  code: string;
  sdna: number;
  /** address key of the block in the writing session (see addrKey) */
  addr: AddrKey;
  len: number;
  count: number;
  /** offset of the block payload within the file buffer */
  offset: number;
}

/** Pointer address key: a JS number when it fits exactly, otherwise a string. */
export type AddrKey = number | string;
export function addrKey(lo: number, hi: number): AddrKey {
  if (hi === 0 && lo === 0) return 0;
  if (hi < 0x200000) return hi * 4294967296 + lo;
  return `${hi.toString(16)}:${lo.toString(16)}`;
}

/** Safety limits (guard against corrupt files asking for huge allocations). */
export const LIMITS = {
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxDecompressedBytes: 1536 * 1024 * 1024,
  maxBlocks: 20_000_000,
};

export type Compression = 'none' | 'gzip' | 'zstd';

export function detectCompression(b: Uint8Array): Compression {
  if (b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return 'zstd';
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  return 'none';
}

const ascii = (b: Uint8Array, start: number, end: number) => {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
};

export function parseHeader(b: Uint8Array): BlendHeader {
  if (b.length < 12 || ascii(b, 0, 7) !== 'BLENDER') throw new BlendError('Not a .blend file (missing its file signature)');
  const c7 = String.fromCharCode(b[7]);
  if (c7 === '_' || c7 === '-') {
    // classic: BLENDER + ptr('_' 4 / '-' 8) + endian('v' little / 'V' big) + 3-digit version
    const endian = String.fromCharCode(b[8]);
    const ver = ascii(b, 9, 12);
    if ((endian !== 'v' && endian !== 'V') || !/^\d{3}$/.test(ver)) throw new BlendError('Invalid .blend header');
    return { pointerSize: c7 === '_' ? 4 : 8, littleEndian: endian === 'v', version: +ver, formatVersion: 0, headerSize: 12, largeBHead: false };
  }
  // newer: BLENDER + 2-digit header size + '-' + 2-digit format version + endian + 4-digit version
  const sizeStr = ascii(b, 7, 9);
  if (!/^\d\d$/.test(sizeStr)) throw new BlendError('Unrecognized .blend header');
  const headerSize = +sizeStr;
  if (headerSize < 17 || b.length < headerSize) throw new BlendError('Truncated .blend header');
  if (String.fromCharCode(b[9]) !== '-') throw new BlendError('Unrecognized .blend header');
  const fmt = ascii(b, 10, 12);
  const endian = String.fromCharCode(b[12]);
  const ver = ascii(b, 13, 17);
  if (!/^\d\d$/.test(fmt) || (endian !== 'v' && endian !== 'V') || !/^\d{4}$/.test(ver)) throw new BlendError('Unrecognized .blend header');
  const formatVersion = +fmt;
  if (formatVersion !== 1) throw new BlendError(`Unsupported .blend file format version ${formatVersion}`);
  return { pointerSize: 8, littleEndian: endian === 'v', version: +ver, formatVersion, headerSize, largeBHead: true };
}

export function readBHeads(b: Uint8Array, h: BlendHeader): BHead[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = h.littleEndian;
  const out: BHead[] = [];
  let p = h.headerSize;
  const u32 = (o: number) => dv.getUint32(o, le);
  const u64 = (o: number) => {
    const lo = dv.getUint32(o + (le ? 0 : 4), le),
      hi = dv.getUint32(o + (le ? 4 : 0), le);
    return { lo, hi };
  };
  const i64num = (o: number) => {
    const { lo, hi } = u64(o);
    if (hi >= 0x200000) throw new BlendError('Corrupt block header (size out of range)');
    return hi * 4294967296 + lo;
  };
  const headSize = h.largeBHead ? 32 : h.pointerSize === 8 ? 24 : 20;
  for (;;) {
    if (p + 4 > b.length) throw new BlendError('Truncated file: missing ENDB block');
    const code = ascii(b, p, p + 4).replace(/\0+$/, '');
    if (code === 'ENDB') break;
    if (p + headSize > b.length) throw new BlendError('Truncated file: incomplete block header');
    let len: number, sdna: number, count: number, addr: AddrKey;
    if (h.largeBHead) {
      sdna = u32(p + 4);
      const a = u64(p + 8);
      addr = addrKey(a.lo, a.hi);
      len = i64num(p + 16);
      count = i64num(p + 24);
    } else {
      len = dv.getInt32(p + 4, le);
      if (h.pointerSize === 8) {
        const a = u64(p + 8);
        addr = addrKey(a.lo, a.hi);
        sdna = u32(p + 16);
        count = dv.getInt32(p + 20, le);
      } else {
        addr = addrKey(u32(p + 8), 0);
        sdna = u32(p + 12);
        count = dv.getInt32(p + 16, le);
      }
    }
    const offset = p + headSize;
    if (len < 0 || count < 0 || offset + len > b.length) throw new BlendError(`Truncated or corrupt file: block "${code}" extends past end of file`);
    out.push({ code, sdna, addr, len, count, offset });
    if (out.length > LIMITS.maxBlocks) throw new BlendError('Too many blocks');
    p = offset + len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SDNA

export interface SdnaName {
  raw: string;
  /** field name without pointer stars, array brackets or function-pointer decoration */
  base: string;
  pointer: boolean;
  /** pointer-to-pointer etc */
  pointerDepth: number;
  funcPointer: boolean;
  dims: number[];
  /** product of array dims (1 when not an array) */
  arrayLen: number;
}

export interface SdnaField {
  name: string;
  type: string;
  typeIndex: number;
  /** struct index when the field is an embedded struct (not a pointer) */
  structIndex: number;
  nameInfo: SdnaName;
  offset: number;
  size: number;
  /** size of a single element */
  elemSize: number;
}

export interface SdnaStruct {
  index: number;
  type: string;
  size: number;
  fields: SdnaField[];
  byName: Map<string, SdnaField>;
}

export interface Sdna {
  names: SdnaName[];
  types: string[];
  typeSizes: number[];
  structs: SdnaStruct[];
  structByType: Map<string, SdnaStruct>;
  /** type index → struct index */
  structOfType: Map<number, number>;
  pointerSize: number;
}

export function parseName(raw: string): SdnaName {
  let s = raw;
  let funcPointer = false;
  if (s.startsWith('(*')) {
    funcPointer = true;
    const close = s.indexOf(')');
    s = s.slice(2, close < 0 ? undefined : close);
  }
  let pointerDepth = 0;
  while (s.startsWith('*')) {
    pointerDepth++;
    s = s.slice(1);
  }
  const dims: number[] = [];
  const br = s.indexOf('[');
  let base = s;
  if (br >= 0) {
    base = s.slice(0, br);
    const re = /\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) dims.push(+m[1]);
  }
  const arrayLen = dims.reduce((a, b) => a * b, 1);
  return { raw, base, pointer: funcPointer || pointerDepth > 0, pointerDepth: funcPointer ? 1 : pointerDepth, funcPointer, dims, arrayLen };
}

export function parseSdna(b: Uint8Array, block: BHead, h: BlendHeader): Sdna {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = h.littleEndian;
  const end = block.offset + block.len;
  let p = block.offset;
  const need = (n: number) => {
    if (p + n > end) throw new BlendError('Corrupt SDNA block');
  };
  const tag = (t: string) => {
    need(4);
    if (ascii(b, p, p + 4) !== t) throw new BlendError(`Corrupt SDNA block (expected ${t})`);
    p += 4;
  };
  const i32 = () => {
    need(4);
    const v = dv.getInt32(p, le);
    p += 4;
    return v;
  };
  const align4 = () => {
    p = block.offset + ((p - block.offset + 3) & ~3);
  };
  const cstrings = (n: number) => {
    if (n < 0 || n > 1_000_000) throw new BlendError('Corrupt SDNA block (bad count)');
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      let q = p;
      while (q < end && b[q] !== 0) q++;
      if (q >= end) throw new BlendError('Corrupt SDNA block (unterminated string)');
      out.push(ascii(b, p, q));
      p = q + 1;
    }
    align4();
    return out;
  };
  tag('SDNA');
  tag('NAME');
  const names = cstrings(i32()).map(parseName);
  tag('TYPE');
  const types = cstrings(i32());
  tag('TLEN');
  need(types.length * 2);
  const typeSizes = types.map((_, i) => dv.getUint16(p + i * 2, le));
  p += types.length * 2;
  align4();
  tag('STRC');
  const nStructs = i32();
  if (nStructs < 0 || nStructs > 100_000) throw new BlendError('Corrupt SDNA block (bad struct count)');
  const raw: { type: number; fields: [number, number][] }[] = [];
  for (let i = 0; i < nStructs; i++) {
    need(4);
    const type = dv.getUint16(p, le),
      nf = dv.getUint16(p + 2, le);
    p += 4;
    need(nf * 4);
    const fields: [number, number][] = [];
    for (let k = 0; k < nf; k++) fields.push([dv.getUint16(p + k * 4, le), dv.getUint16(p + k * 4 + 2, le)]);
    p += nf * 4;
    if (type >= types.length) throw new BlendError('Corrupt SDNA block (bad struct type)');
    raw.push({ type, fields });
  }
  const structOfType = new Map<number, number>();
  raw.forEach((s, i) => structOfType.set(s.type, i));
  const sizes = typeSizes.slice();
  // Some newer files store sizes of very large structs in a separate table; if TLEN overflowed
  // the struct size is recomputed from its fields below.
  const structs: SdnaStruct[] = [];
  const computing = new Set<number>();
  const build = (i: number): SdnaStruct => {
    if (structs[i]) return structs[i];
    if (computing.has(i)) throw new BlendError('Corrupt SDNA block (recursive struct)');
    computing.add(i);
    const r = raw[i];
    let off = 0;
    const fields: SdnaField[] = [];
    for (const [ti, ni] of r.fields) {
      if (ti >= types.length || ni >= names.length) throw new BlendError('Corrupt SDNA block (bad field)');
      const nameInfo = names[ni];
      const si = structOfType.get(ti);
      let elem: number;
      if (nameInfo.pointer) elem = h.pointerSize;
      else if (si !== undefined) elem = build(si).size;
      else elem = sizes[ti];
      const size = elem * nameInfo.arrayLen;
      fields.push({ name: nameInfo.base, type: types[ti], typeIndex: ti, structIndex: !nameInfo.pointer && si !== undefined ? si : -1, nameInfo, offset: off, size, elemSize: elem });
      off += size;
    }
    const size = sizes[r.type] === (off & 0xffff) ? off : sizes[r.type] || off;
    const byName = new Map<string, SdnaField>();
    for (const f of fields) if (!byName.has(f.name)) byName.set(f.name, f);
    const st: SdnaStruct = { index: i, type: types[r.type], size, fields, byName };
    structs[i] = st;
    computing.delete(i);
    return st;
  };
  for (let i = 0; i < raw.length; i++) build(i);
  const structByType = new Map<string, SdnaStruct>();
  for (const s of structs) structByType.set(s.type, s);
  return { names, types, typeSizes: sizes, structs, structByType, structOfType, pointerSize: h.pointerSize };
}
