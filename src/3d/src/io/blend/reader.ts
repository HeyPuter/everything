// Generic struct reader on top of the container: resolves fields by name using the
// file's SDNA, follows pointers through the old-address map, walks ListBases and
// pointer arrays. Nothing here knows about specific DNA structs.
import { decompress as zstdDecompress } from 'fzstd';
import { BlendError, LIMITS, detectCompression, parseHeader, parseSdna, readBHeads, type AddrKey, type BHead, type BlendHeader, type Sdna, type SdnaField, type SdnaStruct, addrKey } from './container';

export { BlendError } from './container';

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new BlendError('Gzip-compressed .blend files are not supported in this browser');
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > LIMITS.maxDecompressedBytes) {
      void reader.cancel();
      throw new BlendError('Decompressed file is too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Decompress (if needed) to the raw .blend bytes. */
export async function decompressBlend(bytes: Uint8Array): Promise<{ bytes: Uint8Array; compression: 'none' | 'gzip' | 'zstd' }> {
  if (bytes.length > LIMITS.maxFileBytes) throw new BlendError('File is too large');
  const c = detectCompression(bytes);
  if (c === 'none') return { bytes, compression: c };
  try {
    if (c === 'gzip') return { bytes: await gunzip(bytes), compression: c };
    // zstd: a quick sanity check on the declared content size of the first frame is not
    // possible for seekable multi-frame streams; rely on the decoder's own bounds checks.
    const out = zstdDecompress(bytes);
    if (out.length > LIMITS.maxDecompressedBytes) throw new BlendError('Decompressed file is too large');
    return { bytes: out, compression: c };
  } catch (e) {
    if (e instanceof BlendError) throw e;
    throw new BlendError(`Corrupt ${c === 'gzip' ? 'gzip' : 'Zstandard'}-compressed .blend file (${e instanceof Error ? e.message : String(e)})`);
  }
}

type Prim = 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32' | 'f32' | 'f64' | 'i64' | 'u64';
const PRIM: Record<string, Prim> = {
  char: 'u8',
  uchar: 'u8',
  int8_t: 'i8',
  uint8_t: 'u8',
  bool: 'u8',
  short: 'i16',
  ushort: 'u16',
  int16_t: 'i16',
  uint16_t: 'u16',
  int: 'i32',
  int32_t: 'i32',
  uint: 'u32',
  uint32_t: 'u32',
  float: 'f32',
  double: 'f64',
  long: 'i32',
  ulong: 'u32',
  int64_t: 'i64',
  uint64_t: 'u64',
};
const PRIM_SIZE: Record<Prim, number> = { i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, f32: 4, f64: 8, i64: 8, u64: 8 };

export class BlendFile {
  readonly header: BlendHeader;
  readonly blocks: BHead[];
  readonly sdna: Sdna;
  readonly bytes: Uint8Array;
  readonly dv: DataView;
  readonly compression: 'none' | 'gzip' | 'zstd';
  /** address → block(s); 5.x files may reuse the same address in different IDs */
  private byAddr = new Map<AddrKey, BHead | BHead[]>();
  /** index of the owning ID block for every block (DATA blocks follow their ID) */
  readonly owner = new Map<BHead, number>();
  private sortedNumeric: BHead[] | null = null;
  readonly byCode = new Map<string, BHead[]>();

  constructor(bytes: Uint8Array, compression: 'none' | 'gzip' | 'zstd' = 'none') {
    this.bytes = bytes;
    this.compression = compression;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.header = parseHeader(bytes);
    this.blocks = readBHeads(bytes, this.header);
    const dna = this.blocks.find((b) => b.code === 'DNA1');
    if (!dna) throw new BlendError('Corrupt file: missing DNA1 (struct catalogue) block');
    this.sdna = parseSdna(bytes, dna, this.header);
    let cur = -1;
    const nonId = new Set(['DATA', 'REND', 'TEST', 'GLOB', 'DNA1', 'USER', 'ENDB']);
    this.blocks.forEach((b, i) => {
      if (!nonId.has(b.code)) cur = i;
      this.owner.set(b, cur);
    });
    for (const b of this.blocks) {
      if (b.addr !== 0) {
        const prev = this.byAddr.get(b.addr);
        if (!prev) this.byAddr.set(b.addr, b);
        else if (Array.isArray(prev)) prev.push(b);
        else this.byAddr.set(b.addr, [prev, b]);
      }
      let l = this.byCode.get(b.code);
      if (!l) this.byCode.set(b.code, (l = []));
      l.push(b);
    }
  }

  static async open(input: Uint8Array): Promise<BlendFile> {
    const { bytes, compression } = await decompressBlend(input);
    return new BlendFile(bytes, compression);
  }

  get littleEndian() {
    return this.header.littleEndian;
  }

  structOf(index: number): SdnaStruct | undefined {
    return this.sdna.structs[index];
  }
  structType(name: string): SdnaStruct | undefined {
    return this.sdna.structByType.get(name);
  }

  /** Block that starts at (or, as a fallback, contains) the address. */
  blockAt(addr: AddrKey, from?: BHead): { block: BHead; delta: number } | null {
    if (addr === 0) return null;
    const b = this.byAddr.get(addr);
    if (b) {
      if (!Array.isArray(b)) return { block: b, delta: 0 };
      // ambiguous address: prefer a block owned by the same ID as the referencing block,
      // then an ID block, then the first one written
      const own = from ? this.owner.get(from) : undefined;
      const same = own !== undefined ? b.find((x) => this.owner.get(x) === own) : undefined;
      return { block: same ?? b.find((x) => x.code !== 'DATA') ?? b[0], delta: 0 };
    }
    if (typeof addr !== 'number') return null;
    if (!this.sortedNumeric) this.sortedNumeric = this.blocks.filter((x) => typeof x.addr === 'number' && x.addr !== 0).sort((a, b) => (a.addr as number) - (b.addr as number));
    const arr = this.sortedNumeric;
    let lo = 0,
      hi = arr.length - 1,
      best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((arr[mid].addr as number) <= addr) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0) return null;
    const blk = arr[best];
    const delta = addr - (blk.addr as number);
    if (delta < blk.len) return { block: blk, delta };
    return null;
  }

  /** The struct stored at the start of a block (uses the block's SDNA index). */
  blockStruct(b: BHead, index = 0, as?: SdnaStruct): BStruct | null {
    const st = as ?? this.sdna.structs[b.sdna];
    if (!st || st.size === 0) return null;
    const off = b.offset + index * st.size;
    if (off + st.size > b.offset + b.len) return null;
    return new BStruct(this, st, off, b);
  }

  /** All structs of a block (count entries). */
  blockStructs(b: BHead, as?: SdnaStruct): BStruct[] {
    const st = as ?? this.sdna.structs[b.sdna];
    if (!st || st.size === 0) return [];
    const n = Math.min(b.count, Math.floor(b.len / st.size));
    const out: BStruct[] = [];
    for (let i = 0; i < n; i++) out.push(new BStruct(this, st, b.offset + i * st.size, b));
    return out;
  }

  /** Dereference an address to a struct. `typeHint` is used when the block's own type is unknown. */
  deref(addr: AddrKey, typeHint?: string, from?: BHead): BStruct | null {
    const hit = this.blockAt(addr, from);
    if (!hit) return null;
    const { block, delta } = hit;
    let st: SdnaStruct | undefined = this.sdna.structs[block.sdna];
    if (st && st.size === 0) st = undefined; // raw data
    const hint = typeHint ? this.sdna.structByType.get(typeHint) : undefined;
    if (hint && (!st || (st.type !== hint.type && hint.type !== 'ID' && typeHint !== 'void'))) {
      // the block is untyped raw data (or typed differently): trust the field's declared type
      if (!st || st.size * block.count !== block.len || delta % (st.size || 1) !== 0) st = hint;
    }
    if (!st || st.size === 0) return null;
    if (block.offset + delta + st.size > block.offset + block.len) return null;
    return new BStruct(this, st, block.offset + delta, block);
  }

  /** Up to `n` consecutive structs of a named type stored at `addr` (bounds-checked). */
  structsAt(addr: AddrKey, typeName: string, n: number, from?: BHead): BStruct[] {
    const st = this.sdna.structByType.get(typeName);
    const hit = addr === 0 ? null : this.blockAt(addr, from);
    if (!st || !hit || st.size === 0 || n <= 0) return [];
    const avail = Math.floor((hit.block.len - hit.delta) / st.size);
    const cnt = Math.min(n, avail);
    const out: BStruct[] = new Array(cnt);
    for (let i = 0; i < cnt; i++) out[i] = new BStruct(this, st, hit.block.offset + hit.delta + i * st.size, hit.block);
    return out;
  }

  /** Raw bytes of the block at `addr` (from the pointer to the end of the block). */
  rawAt(addr: AddrKey, from?: BHead): { offset: number; len: number; block: BHead } | null {
    const hit = this.blockAt(addr, from);
    if (!hit) return null;
    return { offset: hit.block.offset + hit.delta, len: hit.block.len - hit.delta, block: hit.block };
  }

  readPrim(p: Prim, off: number): number {
    const dv = this.dv,
      le = this.header.littleEndian;
    switch (p) {
      case 'i8':
        return dv.getInt8(off);
      case 'u8':
        return dv.getUint8(off);
      case 'i16':
        return dv.getInt16(off, le);
      case 'u16':
        return dv.getUint16(off, le);
      case 'i32':
        return dv.getInt32(off, le);
      case 'u32':
        return dv.getUint32(off, le);
      case 'f32':
        return dv.getFloat32(off, le);
      case 'f64':
        return dv.getFloat64(off, le);
      case 'i64':
        return Number(dv.getBigInt64(off, le));
      case 'u64':
        return Number(dv.getBigUint64(off, le));
    }
  }

  readPtr(off: number): AddrKey {
    const le = this.header.littleEndian;
    if (this.header.pointerSize === 4) return addrKey(this.dv.getUint32(off, le), 0);
    const lo = this.dv.getUint32(off + (le ? 0 : 4), le),
      hi = this.dv.getUint32(off + (le ? 4 : 0), le);
    return addrKey(lo, hi);
  }

  /** Typed array of `n` primitives read from the data at `addr` (bounds-checked). */
  array(addr: AddrKey, prim: Prim, n: number, from?: BHead): number[] | null {
    const r = this.rawAt(addr, from);
    if (!r || n <= 0) return null;
    const sz = PRIM_SIZE[prim];
    if (n * sz > r.len) n = Math.floor(r.len / sz);
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.readPrim(prim, r.offset + i * sz);
    return out;
  }

  float32(addr: AddrKey, n: number, from?: BHead): Float32Array | null {
    const r = this.rawAt(addr, from);
    if (!r || n <= 0) return null;
    if (n * 4 > r.len) return null;
    const out = new Float32Array(n);
    if (this.header.littleEndian && (this.bytes.byteOffset + r.offset) % 4 === 0) out.set(new Float32Array(this.bytes.buffer, this.bytes.byteOffset + r.offset, n));
    else for (let i = 0; i < n; i++) out[i] = this.dv.getFloat32(r.offset + i * 4, this.header.littleEndian);
    return out;
  }

  int32(addr: AddrKey, n: number, from?: BHead): Int32Array | null {
    const r = this.rawAt(addr, from);
    if (!r || n <= 0) return null;
    if (n * 4 > r.len) return null;
    const out = new Int32Array(n);
    if (this.header.littleEndian && (this.bytes.byteOffset + r.offset) % 4 === 0) out.set(new Int32Array(this.bytes.buffer, this.bytes.byteOffset + r.offset, n));
    else for (let i = 0; i < n; i++) out[i] = this.dv.getInt32(r.offset + i * 4, this.header.littleEndian);
    return out;
  }

  bytesAt(addr: AddrKey, n: number, from?: BHead): Uint8Array | null {
    const r = this.rawAt(addr, from);
    if (!r || n <= 0 || n > r.len) return null;
    return this.bytes.slice(r.offset, r.offset + n);
  }

  cstringAt(addr: AddrKey, max = 1 << 20, from?: BHead): string | null {
    const r = this.rawAt(addr, from);
    if (!r) return null;
    const end = r.offset + Math.min(r.len, max);
    let q = r.offset;
    while (q < end && this.bytes[q] !== 0) q++;
    return new TextDecoder().decode(this.bytes.subarray(r.offset, q));
  }

  /** ID data-blocks with a given two-letter code ('OB', 'ME', 'MA', …). */
  ids(code: string): BStruct[] {
    const out: BStruct[] = [];
    for (const b of this.byCode.get(code) ?? []) {
      const s = this.blockStruct(b);
      if (s) out.push(s);
    }
    return out;
  }
}

export class BStruct {
  constructor(
    readonly file: BlendFile,
    readonly st: SdnaStruct,
    readonly offset: number,
    readonly block: BHead,
  ) {}

  get type() {
    return this.st.type;
  }
  has(name: string) {
    return this.st.byName.has(name);
  }
  field(name: string): SdnaField | undefined {
    return this.st.byName.get(name);
  }

  /** Numeric field (or element `i` of a numeric array field). Missing fields return `def`. */
  num(name: string, def = 0, i = 0): number {
    const f = this.st.byName.get(name);
    if (!f || f.nameInfo.pointer || f.structIndex >= 0) return def;
    const p = PRIM[f.type];
    if (!p) return def;
    if (i >= f.nameInfo.arrayLen) return def;
    return this.file.readPrim(p, this.offset + f.offset + i * PRIM_SIZE[p]);
  }

  nums(name: string, n?: number): number[] {
    const f = this.st.byName.get(name);
    if (!f || f.nameInfo.pointer || f.structIndex >= 0) return [];
    const p = PRIM[f.type];
    if (!p) return [];
    const len = Math.min(n ?? f.nameInfo.arrayLen, f.nameInfo.arrayLen);
    const out: number[] = [];
    for (let i = 0; i < len; i++) out.push(this.file.readPrim(p, this.offset + f.offset + i * PRIM_SIZE[p]));
    return out;
  }

  /** Char array field as a UTF-8 string. */
  str(name: string): string {
    const f = this.st.byName.get(name);
    if (!f || f.nameInfo.pointer) return '';
    const start = this.offset + f.offset;
    let q = start;
    const end = start + f.size;
    while (q < end && this.file.bytes[q] !== 0) q++;
    return new TextDecoder().decode(this.file.bytes.subarray(start, q));
  }

  /** Raw pointer value (0 when null or missing). */
  ptr(name: string, i = 0): AddrKey {
    const f = this.st.byName.get(name);
    if (!f || !f.nameInfo.pointer || i >= f.nameInfo.arrayLen) return 0;
    return this.file.readPtr(this.offset + f.offset + i * this.file.header.pointerSize);
  }

  /** Follow a pointer field to a struct. */
  ref(name: string, i = 0): BStruct | null {
    const a = this.ptr(name, i);
    if (a === 0) return null;
    const f = this.st.byName.get(name)!;
    return this.file.deref(a, f.nameInfo.pointerDepth === 1 ? f.type : undefined, this.block);
  }

  /** Follow a char* field to a string. */
  cstr(name: string): string {
    const a = this.ptr(name);
    return a === 0 ? '' : this.file.cstringAt(a, undefined, this.block) ?? '';
  }

  /** Embedded (non-pointer) struct field. */
  sub(name: string, i = 0): BStruct | null {
    const f = this.st.byName.get(name);
    if (!f || f.structIndex < 0 || i >= f.nameInfo.arrayLen) return null;
    const st = this.file.sdna.structs[f.structIndex];
    return new BStruct(this.file, st, this.offset + f.offset + i * st.size, this.block);
  }

  /** Walk a ListBase field (first/last links). */
  list(name: string, limit = 1_000_000): BStruct[] {
    const lb = this.sub(name);
    if (!lb) return [];
    const out: BStruct[] = [];
    let a = lb.ptr('first');
    const seen = new Set<AddrKey>();
    let from = this.block;
    while (a !== 0 && !seen.has(a) && out.length < limit) {
      seen.add(a);
      const s = this.file.deref(a, undefined, from);
      if (!s) break;
      out.push(s);
      from = s.block;
      a = s.linkNext();
    }
    return out;
  }

  /** Dereference an address read from this struct (resolves ambiguity within the same ID). */
  at(addr: AddrKey, typeHint?: string): BStruct | null {
    return addr === 0 ? null : this.file.deref(addr, typeHint, this.block);
  }

  /** Structs referenced by a pointer array field (e.g. `ActionLayer **layer_array`). */
  refs(name: string, n: number): BStruct[] {
    const f = this.st.byName.get(name);
    const hint = f && f.nameInfo.pointerDepth === 2 ? f.type : undefined;
    const out: BStruct[] = [];
    for (const a of this.ptrArray(name, n)) {
      const s = this.at(a, hint);
      if (s) out.push(s);
    }
    return out;
  }

  /** `next` pointer of a list link, looking into an embedded first struct (e.g. ModifierData). */
  linkNext(): AddrKey {
    if (this.st.byName.has('next')) return this.ptr('next');
    const first = this.st.fields[0];
    if (first && first.structIndex >= 0 && first.offset === 0) return this.sub(first.name)!.linkNext();
    return 0;
  }

  /** Read an array of `n` pointers stored in the block a pointer field points at (e.g. `Material **mat`). */
  ptrArray(name: string, n: number): AddrKey[] {
    const a = this.ptr(name);
    if (a === 0 || n <= 0) return [];
    const r = this.file.rawAt(a, this.block);
    if (!r) return [];
    const ps = this.file.header.pointerSize;
    n = Math.min(n, Math.floor(r.len / ps));
    const out: AddrKey[] = [];
    for (let i = 0; i < n; i++) out.push(this.file.readPtr(r.offset + i * ps));
    return out;
  }

  /** Array of structs pointed to by a pointer field (e.g. `MDeformVert *dvert`, count from block or `n`). */
  refArray(name: string, n?: number): BStruct[] {
    const a = this.ptr(name);
    if (a === 0) return [];
    const f = this.st.byName.get(name)!;
    const hit = this.file.blockAt(a, this.block);
    if (!hit) return [];
    const st = this.file.sdna.structByType.get(f.type) ?? this.file.sdna.structs[hit.block.sdna];
    if (!st || st.size === 0) return [];
    const avail = Math.floor((hit.block.len - hit.delta) / st.size);
    const cnt = Math.min(n ?? avail, avail);
    const out: BStruct[] = [];
    for (let i = 0; i < cnt; i++) out.push(new BStruct(this.file, st, hit.block.offset + hit.delta + i * st.size, hit.block));
    return out;
  }

  /** ID name without the two-letter code prefix. */
  get idName(): string {
    const id = this.sub('id');
    const n = id ? id.str('name') : this.str('name');
    return n.length > 2 ? n.slice(2) : n;
  }

  /** Debug dump of the struct's scalar fields. */
  dump(depth = 0): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of this.st.fields) {
      if (f.nameInfo.pointer) out[f.nameInfo.raw] = this.ptr(f.name);
      else if (f.structIndex >= 0) out[f.nameInfo.raw] = depth > 0 ? this.sub(f.name)!.dump(depth - 1) : `<${f.type}>`;
      else if (f.type === 'char' && f.nameInfo.arrayLen > 1) out[f.nameInfo.raw] = this.str(f.name);
      else if (f.nameInfo.arrayLen > 1) out[f.nameInfo.raw] = this.nums(f.name);
      else out[f.nameInfo.raw] = this.num(f.name);
    }
    return out;
  }
}
