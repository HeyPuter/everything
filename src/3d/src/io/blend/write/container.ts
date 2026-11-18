// .blend container writer: file header, blocks ("BHead" + payload), the SDNA catalogue that describes
// every struct stored, and the end marker. Writes the classic 12-byte header (64-bit pointers, little
// endian) of the 4.2 LTS layout, which every later version reads and upgrades.
// Struct layouts and defaults come from dna.gen.ts; a reader matches fields by name and type, so a
// struct only has to describe itself correctly, not be laid out like the reading program's own.
import { DNA_DEFAULTS, DNA_FILE_VERSION, DNA_STRUCTS, DNA_TYPES } from './dna.gen';

const PTR = 8;

interface Field {
  type: string;
  /** declared name: "*next", "loc[3]", "(*func)()" */
  raw: string;
  /** name without pointer stars and array dimensions */
  base: string;
  pointer: boolean;
  dims: number[];
  count: number;
  offset: number;
  /** size of one element */
  elem: number;
  size: number;
  /** struct layout of an embedded (non-pointer) struct field */
  struct: Layout | null;
}

export interface Layout {
  type: string;
  index: number;
  size: number;
  fields: Field[];
  byName: Map<string, Field>;
}

function parseDecl(decl: string) {
  const sp = decl.indexOf(' ');
  const type = decl.slice(0, sp);
  const raw = decl.slice(sp + 1);
  let s = raw;
  let pointer = false;
  if (s.startsWith('(*')) {
    pointer = true;
    s = s.slice(2, s.indexOf(')'));
  }
  while (s.startsWith('*')) {
    pointer = true;
    s = s.slice(1);
  }
  const dims: number[] = [];
  const br = s.indexOf('[');
  const base = br >= 0 ? s.slice(0, br) : s;
  for (const m of s.matchAll(/\[(\d+)\]/g)) dims.push(+m[1]);
  return { type, raw, base, pointer, dims, count: dims.reduce((a, b) => a * b, 1) };
}

/** The SDNA catalogue: names, types and struct layouts, shared by every writer. */
class Catalogue {
  readonly types: string[] = [];
  readonly typeSize = new Map<string, number>();
  readonly typeIndex = new Map<string, number>();
  readonly names: string[] = [];
  readonly nameIndex = new Map<string, number>();
  readonly layouts = new Map<string, Layout>();
  readonly order: Layout[] = [];
  private dna: Uint8Array | null = null;

  constructor() {
    for (const [t, size] of DNA_TYPES) {
      this.typeIndex.set(t, this.types.length);
      this.types.push(t);
      this.typeSize.set(t, size);
    }
    for (const type of Object.keys(DNA_STRUCTS)) this.layout(type);
  }

  layout(type: string): Layout {
    const have = this.layouts.get(type);
    if (have) return have;
    const decls = DNA_STRUCTS[type];
    if (decls === undefined) throw new Error(`.blend writer: no layout for struct ${type}`);
    const fields: Field[] = [];
    let offset = 0;
    for (const d of decls ? decls.split(';') : []) {
      const p = parseDecl(d);
      const struct = !p.pointer && DNA_STRUCTS[p.type] !== undefined ? this.layout(p.type) : null;
      const elem = p.pointer ? PTR : struct ? struct.size : this.typeSize.get(p.type)!;
      if (elem === undefined) throw new Error(`.blend writer: unknown type ${p.type}`);
      fields.push({ ...p, offset, elem, size: elem * p.count, struct });
      offset += elem * p.count;
      if (!this.nameIndex.has(p.raw)) {
        this.nameIndex.set(p.raw, this.names.length);
        this.names.push(p.raw);
      }
    }
    if (offset !== this.typeSize.get(type)) throw new Error(`.blend writer: struct ${type} is ${offset} bytes, its type says ${this.typeSize.get(type)}`);
    const l: Layout = { type, index: this.order.length, size: offset, fields, byName: new Map(fields.map((f) => [f.base, f])) };
    this.layouts.set(type, l);
    this.order.push(l);
    return l;
  }

  /** The DNA1 block payload. */
  bytes(): Uint8Array {
    if (this.dna) return this.dna;
    const enc = new TextEncoder();
    const parts: number[] = [];
    const tag = (t: string) => parts.push(...enc.encode(t));
    const i32 = (v: number) => parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
    const u16 = (v: number) => parts.push(v & 255, (v >> 8) & 255);
    const align = () => {
      while (parts.length % 4) parts.push(0);
    };
    const strings = (list: string[]) => {
      for (const s of list) parts.push(...enc.encode(s), 0);
      align();
    };
    tag('SDNA');
    tag('NAME');
    i32(this.names.length);
    strings(this.names);
    tag('TYPE');
    i32(this.types.length);
    strings(this.types);
    tag('TLEN');
    for (const t of this.types) u16(this.typeSize.get(t)! & 0xffff);
    align();
    tag('STRC');
    i32(this.order.length);
    for (const l of this.order) {
      u16(this.typeIndex.get(l.type)!);
      u16(l.fields.length);
      for (const f of l.fields) {
        u16(this.typeIndex.get(f.type)!);
        u16(this.nameIndex.get(f.raw)!);
      }
    }
    this.dna = new Uint8Array(parts);
    return this.dna;
  }
}

let catalogue: Catalogue | null = null;
export const dna = () => (catalogue ??= new Catalogue());

/** A pointer value as stored in the file: an address key unique within the file (0 = null). */
export type Addr = number;

const PRIM: Record<string, (dv: DataView, o: number, v: number) => void> = {
  char: (dv, o, v) => dv.setInt8(o, v),
  uchar: (dv, o, v) => dv.setUint8(o, v),
  int8_t: (dv, o, v) => dv.setInt8(o, v),
  uint8_t: (dv, o, v) => dv.setUint8(o, v),
  short: (dv, o, v) => dv.setInt16(o, v, true),
  ushort: (dv, o, v) => dv.setUint16(o, v, true),
  int: (dv, o, v) => dv.setInt32(o, v, true),
  uint: (dv, o, v) => dv.setUint32(o, v, true),
  int32_t: (dv, o, v) => dv.setInt32(o, v, true),
  uint32_t: (dv, o, v) => dv.setUint32(o, v, true),
  float: (dv, o, v) => dv.setFloat32(o, v, true),
  double: (dv, o, v) => dv.setFloat64(o, v, true),
  int64_t: (dv, o, v) => dv.setBigInt64(o, BigInt(Math.trunc(v)), true),
  uint64_t: (dv, o, v) => dv.setBigUint64(o, BigInt(Math.trunc(v)), true),
  long: (dv, o, v) => dv.setInt32(o, v, true),
  ulong: (dv, o, v) => dv.setUint32(o, v, true),
};

/**
 * One struct instance being filled in, laid out as the catalogue describes it. Starts from the
 * defaults of a new data-block of its kind (when it is a top-level struct with defaults).
 * Paths: "loc", "r.xsch" (embedded structs), "id.name".
 */
export class Struct {
  readonly bytes: Uint8Array;
  private readonly dv: DataView;
  constructor(
    readonly layout: Layout,
    buffer?: Uint8Array,
    private readonly base = 0,
  ) {
    this.bytes = buffer ?? new Uint8Array(layout.size);
    this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    if (!buffer) {
      const d = DNA_DEFAULTS[layout.type];
      if (d) for (const [k, v] of Object.entries(d)) this.set(k, v);
    }
  }

  private resolve(path: string): { f: Field; off: number } {
    let layout = this.layout;
    let off = this.base;
    const parts = path.split('.');
    for (let i = 0; ; i++) {
      const f = layout.byName.get(parts[i]);
      if (!f) throw new Error(`.blend writer: ${layout.type} has no field "${parts[i]}" (${path})`);
      if (i === parts.length - 1) return { f, off: off + f.offset };
      if (!f.struct) throw new Error(`.blend writer: ${layout.type}.${parts[i]} is not a struct (${path})`);
      layout = f.struct;
      off += f.offset;
    }
  }

  has(path: string) {
    try {
      this.resolve(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Numbers (arrays fill element by element), strings for char arrays. */
  set(path: string, value: number | boolean | string | ArrayLike<number>): this {
    const { f, off } = this.resolve(path);
    if (f.pointer) throw new Error(`.blend writer: ${path} is a pointer (use ptr)`);
    if (typeof value === 'string') {
      if (f.type !== 'char') throw new Error(`.blend writer: ${path} is not a string`);
      const enc = new TextEncoder().encode(value);
      const n = Math.min(enc.length, f.count - 1);
      this.bytes.fill(0, off, off + f.count);
      // never split a multi-byte character
      let cut = n;
      while (cut > 0 && cut < enc.length && (enc[cut] & 0xc0) === 0x80) cut--;
      this.bytes.set(enc.subarray(0, cut), off);
      return this;
    }
    const put = PRIM[f.type];
    if (!put) throw new Error(`.blend writer: cannot store ${f.type} (${path})`);
    if (typeof value === 'number' || typeof value === 'boolean') {
      put(this.dv, off, +value);
      return this;
    }
    const n = Math.min(value.length, f.count);
    for (let i = 0; i < n; i++) put(this.dv, off + i * f.elem, value[i]);
    return this;
  }

  /** Set bits of an integer field (or clear them). */
  flag(path: string, bits: number, on: boolean): this {
    const { f, off } = this.resolve(path);
    const size = f.elem;
    const get = size === 1 ? this.dv.getUint8(off) : size === 2 ? this.dv.getUint16(off, true) : this.dv.getUint32(off, true);
    const v = on ? get | bits : get & ~bits;
    if (size === 1) this.dv.setUint8(off, v & 255);
    else if (size === 2) this.dv.setUint16(off, v & 0xffff, true);
    else this.dv.setUint32(off, v >>> 0, true);
    return this;
  }

  get(path: string): number {
    const { f, off } = this.resolve(path);
    switch (f.type) {
      case 'char':
        return this.dv.getInt8(off);
      case 'uchar':
      case 'uint8_t':
        return this.dv.getUint8(off);
      case 'short':
        return this.dv.getInt16(off, true);
      case 'ushort':
        return this.dv.getUint16(off, true);
      case 'float':
        return this.dv.getFloat32(off, true);
      case 'double':
        return this.dv.getFloat64(off, true);
      default:
        return this.dv.getInt32(off, true);
    }
  }

  /** Store a pointer (an address from BlendWriter.addr, or 0). `i` indexes pointer arrays. */
  ptr(path: string, addr: Addr, i = 0): this {
    const { f, off } = this.resolve(path);
    if (!f.pointer) throw new Error(`.blend writer: ${path} is not a pointer`);
    this.dv.setBigUint64(off + i * PTR, BigInt(addr), true);
    return this;
  }

  /** A ListBase field: first and last element addresses. */
  list(path: string, first: Addr, last: Addr): this {
    return this.ptr(`${path}.first`, first).ptr(`${path}.last`, last);
  }

  /** An embedded struct field as a view into this one. */
  sub(path: string): Struct {
    const { f, off } = this.resolve(path);
    if (!f.struct) throw new Error(`.blend writer: ${path} is not an embedded struct`);
    return new Struct(f.struct, this.bytes, off);
  }
}

interface Block {
  code: string;
  sdna: number;
  addr: Addr;
  count: number;
  data: Uint8Array;
}

/** Collects the blocks of one file and writes it. */
export class BlendWriter {
  private readonly blocks: Block[] = [];
  private next = 0x10000;
  readonly dna = dna();

  /** A fresh, unique address for a block. */
  addr(): Addr {
    const a = this.next;
    this.next += 0x100;
    return a;
  }

  struct(type: string): Struct {
    return new Struct(this.dna.layout(type));
  }

  /** A block of structs of one type (an ID block when `code` is its two-letter code). */
  write(code: string, structs: Struct | Struct[], addr = this.addr()): Addr {
    const list = Array.isArray(structs) ? structs : [structs];
    if (!list.length) return 0;
    this.blocks.push(this.block(code, list, addr));
    return addr;
  }

  private block(code: string, list: Struct[], addr: Addr): Block {
    const layout = list[0].layout;
    const data = new Uint8Array(layout.size * list.length);
    list.forEach((s, i) => data.set(s.bytes, i * layout.size));
    return { code, sdna: layout.index, addr, count: list.length, data };
  }

  /**
   * Keeps the place of an ID block whose struct is completed after its data is written: a reader
   * gives every DATA block to the ID block before it, so the ID block has to come first.
   */
  reserve(): number {
    this.blocks.push(null as unknown as Block);
    return this.blocks.length - 1;
  }

  /** Writes the ID block into a place kept by reserve(). */
  fill(slot: number, code: string, st: Struct, addr: Addr): Addr {
    if (this.blocks[slot] !== null) throw new Error('.blend writer: slot already filled');
    this.blocks[slot] = this.block(code, [st], addr);
    return addr;
  }

  /** Array data typed by a (small) struct, e.g. vec3f positions: `count` elements of `type`. */
  array(type: string, data: Uint8Array, count: number, addr = this.addr()): Addr {
    if (!count) return 0;
    const layout = this.dna.layout(type);
    if (data.byteLength !== layout.size * count) throw new Error(`.blend writer: ${type}[${count}] needs ${layout.size * count} bytes, got ${data.byteLength}`);
    this.blocks.push({ code: 'DATA', sdna: layout.index, addr, count, data });
    return addr;
  }

  /** Untyped data (SDNA index 0): pointer arrays, strings, packed file contents. */
  raw(data: Uint8Array, addr = this.addr()): Addr {
    if (!data.byteLength) return 0;
    this.blocks.push({ code: 'DATA', sdna: 0, addr, count: 1, data });
    return addr;
  }

  /** A NUL-terminated string as untyped data. */
  cstring(s: string): Addr {
    const enc = new TextEncoder().encode(s);
    const b = new Uint8Array(enc.length + 1);
    b.set(enc);
    return this.raw(b);
  }

  /** An array of pointers as untyped data. */
  pointers(addrs: Addr[]): Addr {
    if (!addrs.length) return 0;
    const b = new Uint8Array(addrs.length * PTR);
    const dv = new DataView(b.buffer);
    addrs.forEach((a, i) => dv.setBigUint64(i * PTR, BigInt(a), true));
    return this.raw(b);
  }

  /** A block a reader that does not know `code` skips (four non-NUL characters: never an ID code). */
  extra(code: string, data: Uint8Array) {
    if (code.length !== 4 || code.includes('\0')) throw new Error('.blend writer: extra block codes have four characters');
    this.blocks.push({ code, sdna: 0, addr: this.addr(), count: 1, data });
  }

  finish(): Uint8Array {
    const dnaBytes = this.dna.bytes();
    if (this.blocks.some((b) => b === null)) throw new Error('.blend writer: a reserved ID block was never written');
    const all = [...this.blocks, { code: 'DNA1', sdna: 0, addr: 0, count: 1, data: dnaBytes }];
    let size = 12 + 24; // header + ENDB
    for (const b of all) size += 24 + ((b.data.byteLength + 3) & ~3);
    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    const ascii = (o: number, s: string, n: number) => {
      for (let i = 0; i < n; i++) out[o + i] = i < s.length ? s.charCodeAt(i) : 0;
    };
    ascii(0, `BLENDER-v${DNA_FILE_VERSION.version}`, 12);
    let p = 12;
    for (const b of all) {
      const len = (b.data.byteLength + 3) & ~3;
      ascii(p, b.code, 4);
      dv.setInt32(p + 4, len, true);
      dv.setBigUint64(p + 8, BigInt(b.addr), true);
      dv.setUint32(p + 16, b.sdna, true);
      dv.setInt32(p + 20, b.count, true);
      out.set(b.data, p + 24);
      p += 24 + len;
    }
    ascii(p, 'ENDB', 4);
    return out;
  }
}
