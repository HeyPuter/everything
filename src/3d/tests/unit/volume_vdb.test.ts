import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { zlibSync } from 'three/examples/jsm/libs/fflate.module.js';
import { readVdb } from '../../src/volume/vdb/reader';
import { bloscDecompress, blosclzDecodeBlock, readBloscHeader } from '../../src/volume/vdb/blosc';
import { lz4DecodeBlock } from '../../src/volume/vdb/lz4';
import type { VolumeGrid } from '../../src/volume/types';

const FIXTURES = path.resolve(__dirname, '../fixtures/volume');
const load = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));

interface Expectation {
  file: string;
  grids: {
    name: string;
    type: string;
    class: string;
    background: number | number[];
    bbox_min: number[];
    bbox_max: number[];
    active_voxels: number;
    index_to_world: { ijk: number[]; xyz: number[] }[];
    samples: { ijk: number[]; value: number | number[]; active: boolean }[];
  }[];
}

const TYPE_MAP: Record<string, string> = {
  float: 'FLOAT',
  double: 'FLOAT',
  int32: 'INT',
  int64: 'INT',
  bool: 'BOOLEAN',
  vec3s: 'VECTOR_FLOAT',
  vec3d: 'VECTOR_FLOAT',
};
const CLASS_MAP: Record<string, string> = { 'fog volume': 'FOG_VOLUME', 'level set': 'LEVEL_SET', unknown: 'UNKNOWN' };

const channels = (g: VolumeGrid) => (g.data_type === 'VECTOR_FLOAT' ? 3 : 1);

function voxel(g: VolumeGrid, i: number, j: number, k: number): number[] {
  const ch = channels(g);
  const idx = ((k * g.dims[1] + j) * g.dims[0] + i) * ch;
  return Array.from(g.values.subarray(idx, idx + ch));
}

function apply(m: number[], p: number[]): number[] {
  return [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
}

function checkFixture(name: string) {
  const exp: Expectation = JSON.parse(fs.readFileSync(path.join(FIXTURES, name + '.json'), 'utf8'));
  const { grids, warnings } = readVdb(load(exp.file));
  expect(warnings).toEqual([]);
  expect(grids.map((g) => g.name)).toEqual(exp.grids.map((g) => g.name));
  for (const e of exp.grids) {
    const g = grids.find((x) => x.name === e.name)!;
    expect(g.data_type).toBe(TYPE_MAP[e.type]);
    expect(g.grid_class).toBe(CLASS_MAP[e.class]);
    const bg = Array.isArray(e.background) ? e.background[0] : e.background;
    expect(g.background).toBeCloseTo(bg, 5);
    expect(g.dims).toEqual([0, 1, 2].map((a) => e.bbox_max[a] - e.bbox_min[a] + 1));
    expect(g.values.length).toBe(g.dims[0] * g.dims[1] * g.dims[2] * channels(g));
    // index → object mapping matches the file's transform
    for (const p of e.index_to_world) {
      const local = p.ijk.map((v, a) => v - e.bbox_min[a]);
      const xyz = apply(g.transform, local);
      for (let a = 0; a < 3; a++) expect(xyz[a]).toBeCloseTo(p.xyz[a], 5);
    }
    // sample voxels
    for (const s of e.samples) {
      const local = s.ijk.map((v, a) => v - e.bbox_min[a]);
      const inside = local.every((v, a) => v >= 0 && v < g.dims[a]);
      if (!inside) {
        expect(s.active).toBe(false);
        continue;
      }
      const got = voxel(g, local[0], local[1], local[2]);
      const want = s.active || g.grid_class === 'LEVEL_SET' ? s.value : e.background;
      const wantArr = Array.isArray(want) ? want : [want];
      expect(got.length).toBe(wantArr.length);
      for (let c = 0; c < got.length; c++) expect(got[c]).toBeCloseTo(wantArr[c], 4);
    }
  }
  return { exp, grids };
}

// ---------------------------------------------------------------------------------------------
// fixtures written by the reference OpenVDB library

describe('readVdb: library-written fixtures', () => {
  it('reads a blosc-compressed fog volume with internal-node tiles and a scale+translate map', () => {
    const { exp, grids } = checkFixture('sphere_float_blosc');
    const g = grids[0];
    // every active voxel is > 0 and the background is 0, so non-zero voxels == active voxels
    let nonZero = 0;
    for (const v of g.values) if (v !== 0) nonZero++;
    expect(nonZero).toBe(exp.grids[0].active_voxels);
    // voxel size 0.25 on the diagonal
    expect(g.transform[0]).toBeCloseTo(0.25);
    expect(g.transform[5]).toBeCloseTo(0.25);
    expect(g.transform[10]).toBeCloseTo(0.25);
  });

  it('reads half-float storage for scalar and vector grids', () => {
    checkFixture('box_half');
  });

  it('reads vector grids (single and double precision) with an affine transform', () => {
    const { grids } = checkFixture('field_vec3');
    expect(grids[0].data_type).toBe('VECTOR_FLOAT');
    expect(grids[1].data_type).toBe('VECTOR_FLOAT');
    // rotated: off-diagonal terms present
    expect(Math.abs(grids[0].transform[1])).toBeGreaterThan(0.1);
  });

  it('reads int32, bool, double and int64 grids from one file', () => {
    const { grids } = checkFixture('labels_int_bool');
    expect(grids.map((g) => g.data_type)).toEqual(['INT', 'BOOLEAN', 'FLOAT', 'INT']);
  });

  it('reads a narrow-band level set including its inside/outside values', () => {
    const { grids } = checkFixture('sdf_sphere');
    const g = grids[0];
    expect(g.grid_class).toBe('LEVEL_SET');
    let neg = 0;
    for (const v of g.values) if (v < 0) neg++;
    expect(neg).toBeGreaterThan(1000);
  });

  it('expands root and internal tiles and downsamples by box filtering to the voxel limit', () => {
    const exp: Expectation = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'tiles_float.json'), 'utf8'));
    const e = exp.grids[0];
    const size = [0, 1, 2].map((a) => e.bbox_max[a] - e.bbox_min[a] + 1);
    const maxVoxels = 32 * 32 * 32;
    const { grids, warnings } = readVdb(load('tiles_float.vdb'), { maxVoxels });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/downsampled by a factor of (\d+)/);
    const f = Number(/factor of (\d+)/.exec(warnings[0])![1]);
    const g = grids[0];
    expect(g.dims).toEqual(size.map((s) => Math.ceil(s / f)));
    expect(g.dims[0] * g.dims[1] * g.dims[2]).toBeLessThanOrEqual(maxVoxels);
    // the box filter preserves the total: Σ cell value × cell voxel count = Σ voxel values
    let total = 0;
    for (let z = 0; z < g.dims[2]; z++)
      for (let y = 0; y < g.dims[1]; y++)
        for (let x = 0; x < g.dims[0]; x++) {
          const n = [x, y, z].map((c, a) => Math.min(size[a], (c + 1) * f) - c * f);
          total += voxel(g, x, y, z)[0] * n[0] * n[1] * n[2];
        }
    const expected = 4096 ** 3 * 2 + 128 ** 3 * 3 + 7;
    expect(Math.abs(total - expected) / expected).toBeLessThan(1e-4);
    // a cell well inside the root tile has the tile value
    const c = [Math.floor((2000 - e.bbox_min[0]) / f), Math.floor(2000 / f), Math.floor(2000 / f)];
    expect(voxel(g, c[0], c[1], c[2])[0]).toBeCloseTo(2, 5);
    // transform: voxel size scaled by the factor; cell centres at the block centres
    expect(g.transform[0]).toBeCloseTo(f);
    const centre = apply(g.transform, [0, 0, 0]);
    expect(centre[0]).toBeCloseTo(e.bbox_min[0] + (f - 1) / 2);
  });

  it('downsampling averages exactly the full-resolution blocks', () => {
    const full = readVdb(load('sphere_float_blosc.vdb')).grids[0];
    const n = full.dims[0] * full.dims[1] * full.dims[2];
    const { grids, warnings } = readVdb(load('sphere_float_blosc.vdb'), { maxVoxels: Math.floor(n / 4) });
    const g = grids[0];
    expect(warnings[0]).toMatch(/factor of 2/);
    for (const [x, y, z] of [
      [0, 0, 0],
      [5, 5, 5],
      [10, 3, 9],
      [g.dims[0] - 1, g.dims[1] - 1, g.dims[2] - 1],
    ]) {
      let sum = 0;
      let cnt = 0;
      for (let dz = 0; dz < 2; dz++)
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const X = 2 * x + dx;
            const Y = 2 * y + dy;
            const Z = 2 * z + dz;
            if (X >= full.dims[0] || Y >= full.dims[1] || Z >= full.dims[2]) continue;
            sum += voxel(full, X, Y, Z)[0];
            cnt++;
          }
      expect(voxel(g, x, y, z)[0]).toBeCloseTo(sum / cnt, 5);
    }
  });

  it('rejects data that is not a .vdb file', () => {
    expect(() => readVdb(new TextEncoder().encode('hello world, not a volume'))).toThrow(/not an OpenVDB/);
    expect(() => readVdb(new Uint8Array(0))).toThrow(/not an OpenVDB/);
  });

  it('rejects unsupported old format versions and truncated headers', () => {
    const b = load('sphere_float_blosc.vdb').slice();
    new DataView(b.buffer).setUint32(8, 210, true);
    expect(() => readVdb(b)).toThrow(/format version 210/);
    expect(() => readVdb(load('sphere_float_blosc.vdb').slice(0, 30))).toThrow(/could not be read/);
  });

  it('turns a truncated grid into a warning instead of a crash', () => {
    const b = load('sphere_float_blosc.vdb');
    const { grids, warnings } = readVdb(b.slice(0, b.length - 500));
    expect(grids.length).toBe(0);
    expect(warnings.join(' ')).toMatch(/density.*skipped/);
  });
});

// ---------------------------------------------------------------------------------------------
// test-side encoders: LZ4 blocks, Blosc frames and a minimal .vdb writer for the cases the
// reference library cannot produce from its Python API (zip / uncompressed, old versions, ...)

function lz4Encode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  const table = new Map<number, number>();
  const end = src.length;
  let anchor = 0;
  let i = 0;
  const pushLen = (n: number) => {
    while (n >= 255) {
      out.push(255);
      n -= 255;
    }
    out.push(n);
  };
  const emit = (litEnd: number, offset: number, matchLen: number) => {
    const lit = litEnd - anchor;
    const ml = matchLen - 4;
    out.push((Math.min(lit, 15) << 4) | (matchLen ? Math.min(ml, 15) : 0));
    if (lit >= 15) pushLen(lit - 15);
    for (let k = anchor; k < litEnd; k++) out.push(src[k]);
    if (!matchLen) return;
    out.push(offset & 255, offset >> 8);
    if (ml >= 15) pushLen(ml - 15);
  };
  while (i + 12 < end) {
    const key = src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24);
    const cand = table.get(key);
    table.set(key, i);
    if (cand !== undefined && i - cand < 65536) {
      let len = 4;
      while (i + len < end - 5 && src[cand + len] === src[i + len]) len++;
      emit(i, i - cand, len);
      i += len;
      anchor = i;
    } else i++;
  }
  emit(end, 0, 0);
  return new Uint8Array(out);
}

/** BloscLZ encoder that only emits literals and byte runs (distance-0 matches). */
function blosclzEncodeRuns(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let lit: number[] = [];
  const flush = () => {
    for (let k = 0; k < lit.length; k += 32) {
      const part = lit.slice(k, k + 32);
      out.push(part.length - 1, ...part);
    }
    lit = [];
  };
  let i = 0;
  while (i < src.length) {
    let run = 1;
    while (i + run < src.length && src[i + run] === src[i]) run++;
    // a match needs a previous byte equal to the run value, and the stream must end in literals
    if (lit.length > 0 && lit[lit.length - 1] === src[i] && run >= 4 && i + run < src.length) {
      flush();
      if (run <= 8) out.push((run - 2) << 5, 0);
      else {
        out.push(0xe0);
        let rest = run - 9;
        while (rest >= 255) {
          out.push(255);
          rest -= 255;
        }
        out.push(rest, 0);
      }
      i += run;
    } else {
      lit.push(src[i]);
      i++;
    }
  }
  flush();
  return new Uint8Array(out);
}

function shuffleBytes(src: Uint8Array, ts: number): Uint8Array {
  const out = new Uint8Array(src.length);
  const n = Math.floor(src.length / ts);
  for (let j = 0; j < ts; j++) for (let i = 0; i < n; i++) out[j * n + i] = src[i * ts + j];
  out.set(src.subarray(n * ts), n * ts);
  return out;
}

type Codec = 'lz4' | 'zlib' | 'blosclz';
function bloscEncode(
  data: Uint8Array,
  o: { typesize: number; shuffle: boolean; codec: Codec | 'memcpy'; blocksize?: number; dontSplit?: boolean },
): Uint8Array {
  const header = new Uint8Array(16);
  const dv = new DataView(header.buffer);
  const codecCode = { lz4: 1, zlib: 3, 'blosclz': 0, memcpy: 1 }[o.codec];
  let flags = (o.shuffle ? 1 : 0) | (o.dontSplit ? 0x10 : 0) | (codecCode << 5);
  const blocksize = o.blocksize ?? Math.max(1, data.length);
  header[0] = 2;
  header[1] = 1;
  header[3] = o.typesize;
  dv.setUint32(4, data.length, true);
  dv.setUint32(8, blocksize, true);
  if (o.codec === 'memcpy') {
    header[2] = flags | 2;
    dv.setUint32(12, 16 + data.length, true);
    const out = new Uint8Array(16 + data.length);
    out.set(header);
    out.set(data, 16);
    return out;
  }
  header[2] = flags;
  const nblocks = Math.ceil(data.length / blocksize);
  const leftover = data.length % blocksize;
  const parts: number[] = [];
  const starts: number[] = [];
  let pos = 16 + 4 * nblocks;
  for (let b = 0; b < nblocks; b++) {
    const isLeft = b === nblocks - 1 && leftover > 0;
    const bsize = isLeft ? leftover : blocksize;
    let block = data.subarray(b * blocksize, b * blocksize + bsize);
    if (o.shuffle && o.typesize > 1) block = shuffleBytes(block, o.typesize);
    const nsplits = !o.dontSplit && o.typesize <= 16 && Math.floor(bsize / o.typesize) >= 128 && !isLeft ? o.typesize : 1;
    const ne = Math.floor(bsize / nsplits);
    starts.push(pos);
    for (let j = 0; j < nsplits; j++) {
      const part = block.subarray(j * ne, (j + 1) * ne);
      let enc: Uint8Array;
      if (o.codec === 'lz4') enc = lz4Encode(part);
      else if (o.codec === 'zlib') enc = zlibSync(part);
      else enc = blosclzEncodeRuns(part);
      if (enc.length >= ne) enc = part;
      const sz = [enc.length & 255, (enc.length >> 8) & 255, (enc.length >> 16) & 255, enc.length >>> 24];
      parts.push(...sz, ...enc);
      pos += 4 + enc.length;
    }
  }
  dv.setUint32(12, pos, true);
  const out = new Uint8Array(pos);
  out.set(header);
  const sdv = new DataView(out.buffer);
  starts.forEach((s, b) => sdv.setUint32(16 + 4 * b, s, true));
  out.set(parts, 16 + 4 * nblocks);
  return out;
}

class Bytes {
  arr: number[] = [];
  get pos() {
    return this.arr.length;
  }
  u8(v: number) {
    this.arr.push(v & 255);
  }
  raw(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.arr.push(b[i]);
  }
  private dv(n: number, f: (d: DataView) => void) {
    const d = new DataView(new ArrayBuffer(n));
    f(d);
    this.raw(new Uint8Array(d.buffer));
  }
  u32(v: number) {
    this.dv(4, (d) => d.setUint32(0, v, true));
  }
  i32(v: number) {
    this.dv(4, (d) => d.setInt32(0, v, true));
  }
  i64(v: number) {
    this.dv(8, (d) => d.setBigInt64(0, BigInt(v), true));
  }
  f32(v: number) {
    this.dv(4, (d) => d.setFloat32(0, v, true));
  }
  f64(v: number) {
    this.dv(8, (d) => d.setFloat64(0, v, true));
  }
  str(s: string) {
    const b = new TextEncoder().encode(s);
    this.u32(b.length);
    this.raw(b);
  }
  patchI64(at: number, v: number) {
    const d = new DataView(new ArrayBuffer(8));
    d.setBigInt64(0, BigInt(v), true);
    for (let i = 0; i < 8; i++) this.arr[at + i] = d.getUint8(i);
  }
  out() {
    return new Uint8Array(this.arr);
  }
}

type LeafMode = 'auto' | 'all' | 'minusbg' | 'one' | 'two';
interface SynthGrid {
  name: string;
  typeName?: string;
  cls?: string;
  background?: number;
  /** active voxels [x, y, z, value] */
  voxels?: number[][];
  /** inactive leaf voxels with a non-background value */
  inactive?: number[][];
  leafMode?: LeafMode;
  /** active tile in a 16³ internal node: [x, y, z, value] (x, y, z multiples of 8) */
  tile?: number[];
  instanceOf?: string;
  body?: Uint8Array;
  scale?: number;
  translate?: number[];
}
interface SynthFile {
  version?: number;
  compression: number; // 1 zip, 2 active mask, 4 blosc
  blosc?: Codec | 'memcpy';
  rawChunks?: boolean;
  hasOffsets?: boolean;
  grids: SynthGrid[];
}

function writeVdb(f: SynthFile): Uint8Array {
  const v = f.version ?? 224;
  const comp = v >= 222 ? f.compression : f.compression & 1;
  const b = new Bytes();
  b.raw([0x20, 0x42, 0x44, 0x56, 0, 0, 0, 0]);
  b.u32(v);
  b.u32(9);
  b.u32(0);
  b.u8(f.hasOffsets === false ? 0 : 1);
  if (v < 222) b.u8(comp & 1);
  b.raw(new TextEncoder().encode('00000000-0000-0000-0000-000000000000'));
  b.i32(0); // file metadata
  b.i32(f.grids.length);

  const data = (bytes: Uint8Array) => {
    if (comp & 4) {
      if (f.rawChunks) {
        b.i64(-bytes.length);
        b.raw(bytes);
        return;
      }
      const enc = bloscEncode(bytes, { typesize: 4, shuffle: true, codec: f.blosc ?? 'lz4' });
      b.i64(enc.length);
      b.raw(enc);
    } else if (comp & 1) {
      if (f.rawChunks) {
        b.i64(-bytes.length);
        b.raw(bytes);
        return;
      }
      const z = zlibSync(bytes);
      b.i64(z.length);
      b.raw(z);
    } else b.raw(bytes);
  };
  const f32s = (vals: number[]) => new Uint8Array(new Float32Array(vals).buffer);

  /** node values with the per-node metadata byte; `mask`: active bits */
  const nodeValues = (values: Float32Array, mask: Uint8Array, bg: number, mode: LeafMode) => {
    if (v < 222) return data(f32s(Array.from(values)));
    if (!(comp & 2)) mode = 'all';
    const active: number[] = [];
    for (let i = 0; i < values.length; i++) if ((mask[i >> 3] >> (i & 7)) & 1) active.push(values[i]);
    if (mode === 'all') {
      b.u8(6);
      return data(f32s(Array.from(values)));
    }
    if (mode === 'auto') b.u8(0);
    else if (mode === 'minusbg') b.u8(1);
    else if (mode === 'one') {
      b.u8(2);
      const inact = Array.from(values).find((x, i) => !((mask[i >> 3] >> (i & 7)) & 1)) ?? bg;
      b.f32(inact);
    } else {
      // two inactive values: -bg (selection bit 0) and +bg (selection bit 1)
      b.u8(5);
      b.f32(-bg);
      b.f32(bg);
      const sel = new Uint8Array(values.length / 8);
      for (let i = 0; i < values.length; i++) if (!((mask[i >> 3] >> (i & 7)) & 1) && values[i] === bg) sel[i >> 3] |= 1 << (i & 7);
      b.raw(sel);
    }
    data(f32s(active));
  };

  for (const g of f.grids) {
    b.str(g.name);
    b.str(g.typeName ?? 'Tree_float_5_4_3');
    if (v >= 216) b.str(g.instanceOf ?? '');
    const posAt = b.pos;
    b.i64(0);
    b.i64(0);
    b.i64(0);
    const gridPos = b.pos;
    let blockPos = 0;
    if (g.body) {
      b.raw(g.body);
    } else {
      if (v >= 222) b.u32(comp);
      const meta: [string, string, number[]][] = [];
      if (g.cls) meta.push(['class', 'string', Array.from(new TextEncoder().encode(g.cls))]);
      b.i32(meta.length);
      for (const [n, t, val] of meta) {
        b.str(n);
        b.str(t);
        b.u32(val.length);
        b.raw(val);
      }
      const s = g.scale ?? 1;
      const t = g.translate ?? [0, 0, 0];
      b.str('ScaleTranslateMap');
      for (const x of t) b.f64(x);
      for (let k = 0; k < 3; k++) b.f64(s);
      for (let k = 0; k < 3; k++) b.f64(s);
      for (let k = 0; k < 3; k++) b.f64(1 / s);
      for (let k = 0; k < 3; k++) b.f64(1 / (s * s));
      for (let k = 0; k < 3; k++) b.f64(1 / (2 * s));
      if (!g.instanceOf) {
        const bg = g.background ?? 0;
        // build the tree
        type Leaf = { o: number[]; mask: Uint8Array; values: Float32Array };
        const leaves = new Map<string, Leaf>();
        const leafOf = (x: number, y: number, z: number) => {
          const o = [x & ~7, y & ~7, z & ~7];
          const k = o.join();
          let l = leaves.get(k);
          if (!l) leaves.set(k, (l = { o, mask: new Uint8Array(64), values: new Float32Array(512).fill(bg) }));
          return l;
        };
        for (const [x, y, z, val] of g.voxels ?? []) {
          const l = leafOf(x, y, z);
          const i = ((x & 7) << 6) | ((y & 7) << 3) | (z & 7);
          l.mask[i >> 3] |= 1 << (i & 7);
          l.values[i] = val;
        }
        for (const [x, y, z, val] of g.inactive ?? []) leafOf(x, y, z).values[((x & 7) << 6) | ((y & 7) << 3) | (z & 7)] = val;
        const cmp = (a: number[], c: number[]) => a[0] - c[0] || a[1] - c[1] || a[2] - c[2];
        const n1 = new Map<string, { o: number[]; leaves: Leaf[]; tiles: number[][] }>();
        const node1Of = (x: number, y: number, z: number) => {
          const o = [x & ~127, y & ~127, z & ~127];
          let n = n1.get(o.join());
          if (!n) n1.set(o.join(), (n = { o, leaves: [], tiles: [] }));
          return n;
        };
        for (const l of leaves.values()) node1Of(l.o[0], l.o[1], l.o[2]).leaves.push(l);
        if (g.tile) node1Of(g.tile[0], g.tile[1], g.tile[2]).tiles.push(g.tile);
        const n2 = new Map<string, { o: number[]; kids: { o: number[]; leaves: Leaf[]; tiles: number[][] }[] }>();
        for (const n of n1.values()) {
          const o = [n.o[0] & ~4095, n.o[1] & ~4095, n.o[2] & ~4095];
          let m = n2.get(o.join());
          if (!m) n2.set(o.join(), (m = { o, kids: [] }));
          m.kids.push(n);
        }
        const idx = (o: number[], p: number[], log2: number, cl: number) =>
          (((p[0] - o[0]) >> cl) << (2 * log2)) | (((p[1] - o[1]) >> cl) << log2) | ((p[2] - o[2]) >> cl);
        const order: Leaf[] = [];
        const internal = (o: number[], log2: number, cl: number, kids: { o: number[] }[], tiles: number[][], onKid: (k: any) => void) => {
          const n = 1 << (3 * log2);
          const childMask = new Uint8Array(n / 8);
          const valueMask = new Uint8Array(n / 8);
          const vals = new Float32Array(n).fill(bg);
          const sorted = kids.slice().sort((a, c) => idx(o, a.o, log2, cl) - idx(o, c.o, log2, cl));
          for (const k of sorted) {
            const i = idx(o, k.o, log2, cl);
            childMask[i >> 3] |= 1 << (i & 7);
          }
          for (const t of tiles) {
            const i = idx(o, t, log2, cl);
            valueMask[i >> 3] |= 1 << (i & 7);
            vals[i] = t[3];
          }
          b.raw(childMask);
          b.raw(valueMask);
          if (v < 222) {
            const off: number[] = [];
            for (let i = 0; i < n; i++) if (!((childMask[i >> 3] >> (i & 7)) & 1)) off.push(vals[i]);
            data(f32s(off));
          } else nodeValues(vals, valueMask, bg, 'auto');
          for (const k of sorted) onKid(k);
        };
        b.i32(1);
        b.f32(bg);
        b.u32(0);
        const roots = [...n2.values()].sort((a, c) => cmp(a.o, c.o));
        b.u32(roots.length);
        for (const r of roots) {
          b.i32(r.o[0]);
          b.i32(r.o[1]);
          b.i32(r.o[2]);
          internal(r.o, 5, 7, r.kids, [], (k1) =>
            internal(k1.o, 4, 3, k1.leaves, k1.tiles, (leaf: Leaf) => {
              b.raw(leaf.mask);
              order.push(leaf);
            }),
          );
        }
        blockPos = b.pos;
        for (const leaf of order) {
          b.raw(leaf.mask);
          if (v < 222) {
            b.i32(leaf.o[0]);
            b.i32(leaf.o[1]);
            b.i32(leaf.o[2]);
            b.u8(1);
          }
          nodeValues(leaf.values, leaf.mask, bg, g.leafMode ?? 'auto');
        }
      }
    }
    const endPos = b.pos;
    if (f.hasOffsets !== false) {
      b.patchI64(posAt, gridPos);
      b.patchI64(posAt + 8, blockPos);
      b.patchI64(posAt + 16, endPos);
    }
  }
  return b.out();
}

/** Small float grid spanning two leaves, two internal nodes and two root children. */
const SAMPLE_VOXELS = [
  [0, 0, 0, 1.5],
  [7, 7, 7, -2.25],
  [8, 0, 3, 3],
  [3, 200, 1, 4.75],
  [-1, -1, -1, 0.125],
  [5000, 2, 2, 9],
];
function checkSample(g: VolumeGrid, voxels = SAMPLE_VOXELS, bg = 0) {
  const min = [0, 1, 2].map((a) => Math.min(...voxels.map((p) => p[a])));
  const max = [0, 1, 2].map((a) => Math.max(...voxels.map((p) => p[a])));
  expect(g.dims).toEqual([0, 1, 2].map((a) => max[a] - min[a] + 1));
  for (const [x, y, z, val] of voxels) expect(voxel(g, x - min[0], y - min[1], z - min[2])[0]).toBe(val);
  expect(voxel(g, 1 - min[0], 0 - min[1], 0 - min[2])[0]).toBe(bg);
}

describe('readVdb: compression modes and encodings (synthetic files)', () => {
  // keep the dense size small: the sample spans x = -1..5000
  const opts = { maxVoxels: 1e9 };
  const small = SAMPLE_VOXELS.slice(0, 5);

  it('reads uncompressed grids with and without active-mask compression', () => {
    for (const compression of [0, 2]) {
      const { grids, warnings } = readVdb(writeVdb({ compression, grids: [{ name: 'd', voxels: small }] }), opts);
      expect(warnings).toEqual([]);
      checkSample(grids[0], small);
    }
  });

  it('reads zip-compressed grids, including chunks stored raw (negative size prefix)', () => {
    for (const rawChunks of [false, true]) {
      const { grids } = readVdb(writeVdb({ compression: 3, rawChunks, grids: [{ name: 'd', voxels: small, background: 0.5 }] }));
      checkSample(grids[0], small, 0.5);
      expect(grids[0].background).toBe(0.5);
    }
  });

  it('reads blosc chunks: LZ4, BloscLZ, zlib codecs, uncompressed frames and raw chunks', () => {
    for (const blosc of ['lz4', 'blosclz', 'zlib', 'memcpy'] as const) {
      const { grids } = readVdb(writeVdb({ compression: 6, blosc, grids: [{ name: 'd', voxels: small }] }));
      checkSample(grids[0], small);
    }
    const { grids } = readVdb(writeVdb({ compression: 6, rawChunks: true, grids: [{ name: 'd', voxels: small }] }));
    checkSample(grids[0], small);
  });

  it('handles every per-node value encoding', () => {
    for (const leafMode of ['auto', 'all', 'minusbg', 'one', 'two'] as LeafMode[]) {
      const { grids } = readVdb(writeVdb({ compression: 2, grids: [{ name: 'd', voxels: small, background: 0, leafMode }] }));
      checkSample(grids[0], small);
    }
  });

  it('restores inactive values (selection mask) for level sets', () => {
    const voxels = [
      [0, 0, 0, 0.1],
      [0, 0, 4, -0.1],
    ];
    const inactive = [
      [0, 0, 1, -3],
      [0, 0, 2, -3],
    ];
    for (const leafMode of ['two', 'all'] as LeafMode[]) {
      const bytes = writeVdb({ compression: 6, grids: [{ name: 'sdf', cls: 'level set', background: 3, voxels, inactive, leafMode }] });
      const g = readVdb(bytes).grids[0];
      expect(g.grid_class).toBe('LEVEL_SET');
      expect(g.dims).toEqual([1, 1, 5]);
      expect(Array.from(g.values)).toEqual([0.1, -3, -3, 3, -0.1].map((x) => Math.fround(x)));
    }
  });

  it('expands active tiles of the 16³ internal nodes', () => {
    const { grids } = readVdb(writeVdb({ compression: 6, grids: [{ name: 't', voxels: [[0, 0, 0, 1]], tile: [16, 8, 0, 2.5] }] }));
    const g = grids[0];
    expect(g.dims).toEqual([24, 16, 8]);
    expect(voxel(g, 0, 0, 0)[0]).toBe(1);
    expect(voxel(g, 16, 8, 0)[0]).toBe(2.5);
    expect(voxel(g, 23, 15, 7)[0]).toBe(2.5);
    expect(voxel(g, 15, 8, 0)[0]).toBe(0);
  });

  it('reads the transform and spans multiple root children', () => {
    const { grids } = readVdb(
      writeVdb({ compression: 6, grids: [{ name: 'd', voxels: SAMPLE_VOXELS, scale: 0.5, translate: [1, 2, 3] }] }),
      { maxVoxels: 1e8 },
    );
    const g = grids[0];
    checkSample(g);
    // dense (0,0,0) is index (-1,-1,-1)
    expect(apply(g.transform, [0, 0, 0])).toEqual([0.5, 1.5, 2.5]);
    expect(g.transform[0]).toBe(0.5);
  });

  it('reads older format versions (221: header compression, no node metadata)', () => {
    for (const compression of [0, 1]) {
      const { grids, warnings } = readVdb(writeVdb({ version: 221, compression, grids: [{ name: 'd', voxels: small }] }));
      expect(warnings).toEqual([]);
      checkSample(grids[0], small);
    }
  });

  it('reads streams without grid offsets', () => {
    const { grids } = readVdb(
      writeVdb({ compression: 6, hasOffsets: false, grids: [{ name: 'a', voxels: small }, { name: 'b', voxels: [[1, 2, 3, 4]] }] }),
    );
    expect(grids.map((g) => g.name)).toEqual(['a', 'b']);
    checkSample(grids[0], small);
  });

  it('skips unsupported grids (points, instances, other tree layouts) with warnings', () => {
    const bytes = writeVdb({
      compression: 6,
      grids: [
        { name: 'points', typeName: 'Tree_ptdataidx32_5_4_3', body: new Uint8Array([1, 2, 3, 4, 5]) },
        { name: 'names', typeName: 'Tree_string_5_4_3', body: new Uint8Array(17) },
        { name: 'wide', typeName: 'Tree_float_5_5_3', body: new Uint8Array(3) },
        { name: 'density', voxels: small },
        { name: 'copy', instanceOf: 'density' },
      ],
    });
    const { grids, warnings } = readVdb(bytes);
    expect(grids.map((g) => g.name)).toEqual(['density']);
    checkSample(grids[0], small);
    expect(warnings.length).toBe(4);
    expect(warnings[0]).toMatch(/"points".*point grids/);
    expect(warnings[1]).toMatch(/"names".*string/);
    expect(warnings[2]).toMatch(/"wide".*5-5-3/);
    expect(warnings[3]).toMatch(/"copy".*instance/);
  });

  it('reports an unsupported blosc codec as a skipped grid', () => {
    // a constant 8³ block compresses, so its frame really goes through the codec
    const block: number[][] = [];
    for (let i = 0; i < 512; i++) block.push([i >> 6, (i >> 3) & 7, i & 7, 1]);
    const bytes = writeVdb({ compression: 6, grids: [{ name: 'd', voxels: block }, { name: 'e', voxels: block }] });
    expect(readVdb(bytes).grids.length).toBe(2);
    // mark the codec of every blosc frame as Snappy (code 2)
    const b = bytes.slice();
    for (let i = 0; i + 16 < b.length; i++) {
      if (b[i] === 2 && b[i + 1] === 1 && b[i + 3] === 4 && (b[i + 2] & 0xe0) === 0x20) b[i + 2] = (b[i + 2] & 0x1f) | (2 << 5);
    }
    const { grids, warnings } = readVdb(b);
    expect(grids.length).toBe(0);
    expect(warnings[0]).toMatch(/"d" was skipped.*Snappy/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('lz4DecodeBlock', () => {
  it('decodes hand-made sequences with literals, overlapping matches and long lengths', () => {
    // "abc" + match(offset 3, len 9) + "XY"
    const src = new Uint8Array([0x35, 97, 98, 99, 3, 0, 0x20, 88, 89]);
    const dst = new Uint8Array(14);
    expect(lz4DecodeBlock(src, dst)).toBe(14);
    expect(new TextDecoder().decode(dst)).toBe('abcabcabcabcXY');
    // run-length: "z" + match(offset 1, len 4 + 15 + 3)
    const rle = new Uint8Array([0x1f, 122, 1, 0, 3, 0x10, 33]);
    const out = new Uint8Array(1 + 22 + 1);
    expect(lz4DecodeBlock(rle, out)).toBe(24);
    expect(new TextDecoder().decode(out)).toBe('z'.repeat(23) + '!');
  });

  it('round-trips data from a simple encoder', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
    const data = new Uint8Array(20000);
    for (let i = 0; i < data.length; i++) data[i] = i % 300 < 150 ? rnd() & 7 : (i * 7) & 255;
    const enc = lz4Encode(data);
    expect(enc.length).toBeLessThan(data.length);
    const out = new Uint8Array(data.length);
    expect(lz4DecodeBlock(enc, out)).toBe(data.length);
    expect(out).toEqual(data);
  });

  it('rejects corrupt input', () => {
    expect(() => lz4DecodeBlock(new Uint8Array([0x00, 5, 0]), new Uint8Array(10))).toThrow(/offset/);
    expect(() => lz4DecodeBlock(new Uint8Array([0x50, 1, 2]), new Uint8Array(10))).toThrow();
    expect(() => lz4DecodeBlock(new Uint8Array([0x30, 1, 2, 3]), new Uint8Array(2))).toThrow(/too small/);
  });
});

describe('Blosc', () => {
  const floats = new Float32Array(3000);
  for (let i = 0; i < floats.length; i++) floats[i] = i >= 1000 && i < 2000 ? 0 : Math.sin(i / 50) * (i % 7 === 0 ? 0 : 1);
  const data = new Uint8Array(floats.buffer);

  it('reads the frame header', () => {
    const enc = bloscEncode(data, { typesize: 4, shuffle: true, codec: 'lz4' });
    const h = readBloscHeader(enc);
    expect(h.nbytes).toBe(data.length);
    expect(h.typesize).toBe(4);
    expect(h.codec).toBe(1);
    expect(h.cbytes).toBe(enc.length);
  });

  it('round-trips shuffled / unshuffled, split / unsplit, multi-block frames with every codec', () => {
    for (const codec of ['lz4', 'zlib', 'blosclz', 'memcpy'] as const)
      for (const shuffle of [true, false])
        for (const blocksize of [undefined, 4096, 1000])
          for (const dontSplit of [false, true]) {
            const enc = bloscEncode(data, { typesize: 4, shuffle, codec, blocksize, dontSplit });
            expect(bloscDecompress(enc)).toEqual(data);
          }
    // odd type size with a leftover tail
    const odd = data.subarray(0, 1001);
    expect(bloscDecompress(bloscEncode(odd, { typesize: 3, shuffle: true, codec: 'lz4', blocksize: 501 }))).toEqual(odd);
  });

  it('decodes BloscLZ matches (short, extended and run-length)', () => {
    // "abc", match len 9 at distance 3 (extended length byte), match len 4 repeating the last byte, "Z"
    const src = new Uint8Array([2, 97, 98, 99, 0xe0, 0, 2, 0x40, 0, 0, 90]);
    const dst = new Uint8Array(17);
    expect(blosclzDecodeBlock(src, dst)).toBe(17);
    expect(new TextDecoder().decode(dst)).toBe('abcabcabcabc' + 'cccc' + 'Z');
  });

  it('rejects unsupported codecs and filters', () => {
    const enc = bloscEncode(data, { typesize: 4, shuffle: true, codec: 'lz4' });
    const snappy = enc.slice();
    snappy[2] = (snappy[2] & 0x1f) | (2 << 5);
    expect(() => bloscDecompress(snappy)).toThrow(/Snappy/);
    const bits = enc.slice();
    bits[2] = (bits[2] & ~1) | 4;
    expect(() => bloscDecompress(bits)).toThrow(/bit-shuffle/);
  });
});
