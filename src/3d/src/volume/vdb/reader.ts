// OpenVDB (.vdb) file reader. Parses the sparse 5-4-3 trees of the grids in a file and turns
// each into a dense `VolumeGrid` covering the bounding box of its active voxels.
//
// File layout (all little-endian):
//   header   magic " BDV\0\0\0\0", format version (u32), library version (2 × u32),
//            "has grid offsets" (u8), [format 220-221: "is compressed" (u8)], 36-byte UUID
//   metadata file-level metadata map
//   grids    grid count (i32), then per grid a descriptor (unique name, type name, instance
//            parent name, 3 × i64 stream positions) followed by the grid itself:
//            compression flags (u32, format ≥ 222), metadata map, transform, tree topology
//            (root → 32³ internal → 16³ internal → 8³ leaf masks and tile values), then the
//            leaf value buffers in the same depth-first order.
import { unzlibSync } from 'three/examples/jsm/libs/fflate.module.js';
import type { GridClass, GridDataType, VolumeGrid } from '../types';
import { bloscDecompress } from './blosc';

export interface ReadVdbOptions {
  /** largest dense voxel count per grid before it is downsampled (default 256³) */
  maxVoxels?: number;
}

export interface ReadVdbResult {
  grids: VolumeGrid[];
  warnings: string[];
}

const DEFAULT_MAX_VOXELS = 256 * 256 * 256;
const MIN_VERSION = 220;
const NEWEST_KNOWN_VERSION = 225;

// format versions where the layout changed
const V_GRID_INSTANCING = 216;
const V_BOOL_LEAF_OPTIMIZATION = 217;
const V_NODE_MASK_COMPRESSION = 222;

// compression flags
const COMPRESS_ZIP = 0x1;
const COMPRESS_ACTIVE_MASK = 0x2;
const COMPRESS_BLOSC = 0x4;

// per-node "compressed values" metadata byte
const NO_MASK_OR_INACTIVE_VALS = 0;
const NO_MASK_AND_MINUS_BG = 1;
const NO_MASK_AND_ONE_INACTIVE_VAL = 2;
const MASK_AND_NO_INACTIVE_VALS = 3;
const MASK_AND_ONE_INACTIVE_VAL = 4;
const MASK_AND_TWO_INACTIVE_VALS = 5;
const NO_MASK_AND_ALL_VALS = 6;

const MAGIC = [0x20, 0x42, 0x44, 0x56, 0, 0, 0, 0];

// ---------------------------------------------------------------------------------------------
// value types

const Kind = { Float: 0, Double: 1, Int32: 2, Int64: 3, Bool: 4, Mask: 5, Vec3F: 6, Vec3D: 7, Vec3I: 8 } as const;
type Kind = (typeof Kind)[keyof typeof Kind];

interface ValueType {
  kind: Kind;
  dataType: GridDataType;
  channels: number;
  /** bytes per value at full precision */
  size: number;
  /** bytes per value when saved as half floats (0: never half) */
  halfSize: number;
}

const VALUE_TYPES: Record<string, ValueType> = {
  float: { kind: Kind.Float, dataType: 'FLOAT', channels: 1, size: 4, halfSize: 2 },
  double: { kind: Kind.Double, dataType: 'FLOAT', channels: 1, size: 8, halfSize: 2 },
  int32: { kind: Kind.Int32, dataType: 'INT', channels: 1, size: 4, halfSize: 0 },
  int64: { kind: Kind.Int64, dataType: 'INT', channels: 1, size: 8, halfSize: 0 },
  bool: { kind: Kind.Bool, dataType: 'BOOLEAN', channels: 1, size: 1, halfSize: 0 },
  mask: { kind: Kind.Mask, dataType: 'MASK', channels: 1, size: 1, halfSize: 0 },
  vec3s: { kind: Kind.Vec3F, dataType: 'VECTOR_FLOAT', channels: 3, size: 12, halfSize: 6 },
  vec3f: { kind: Kind.Vec3F, dataType: 'VECTOR_FLOAT', channels: 3, size: 12, halfSize: 6 },
  vec3d: { kind: Kind.Vec3D, dataType: 'VECTOR_FLOAT', channels: 3, size: 24, halfSize: 6 },
  vec3i: { kind: Kind.Vec3I, dataType: 'VECTOR_FLOAT', channels: 3, size: 12, halfSize: 0 },
};

let halfTable: Float32Array | null = null;
function halfToFloatTable(): Float32Array {
  if (halfTable) return halfTable;
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    if (e === 0) t[h] = s * m * 2 ** -24;
    else if (e === 31) t[h] = m ? NaN : s * Infinity;
    else t[h] = s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return (halfTable = t);
}

/** Decode `count` values from `raw` into `out` (channels interleaved). */
function decodeValues(raw: Uint8Array, count: number, type: ValueType, half: boolean, out: Float32Array) {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const n = count * type.channels;
  if (half) {
    const table = halfToFloatTable();
    for (let i = 0; i < n; i++) out[i] = table[dv.getUint16(i * 2, true)];
    return;
  }
  switch (type.kind) {
    case Kind.Float:
    case Kind.Vec3F:
      for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
      break;
    case Kind.Double:
    case Kind.Vec3D:
      for (let i = 0; i < n; i++) out[i] = dv.getFloat64(i * 8, true);
      break;
    case Kind.Int32:
    case Kind.Vec3I:
      for (let i = 0; i < n; i++) out[i] = dv.getInt32(i * 4, true);
      break;
    case Kind.Int64:
      for (let i = 0; i < n; i++) out[i] = Number(dv.getBigInt64(i * 8, true));
      break;
    case Kind.Bool:
    case Kind.Mask:
      for (let i = 0; i < n; i++) out[i] = raw[i] ? 1 : 0;
      break;
  }
}

// ---------------------------------------------------------------------------------------------
// byte reader

class ByteReader {
  readonly dv: DataView;
  pos = 0;
  constructor(readonly bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(n: number) {
    if (n < 0 || this.pos + n > this.bytes.length) throw new Error('the file is truncated or corrupt');
  }
  u8() {
    this.need(1);
    return this.bytes[this.pos++];
  }
  i32() {
    this.need(4);
    const v = this.dv.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i64() {
    this.need(8);
    const v = Number(this.dv.getBigInt64(this.pos, true));
    this.pos += 8;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.dv.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  sub(n: number) {
    this.need(n);
    const s = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  str() {
    const n = this.u32();
    return new TextDecoder().decode(this.sub(n));
  }
  vec3d(): [number, number, number] {
    return [this.f64(), this.f64(), this.f64()];
  }
}

type MetaValue = string | number | boolean | number[] | null;

function readMetaMap(r: ByteReader): Map<string, MetaValue> {
  const out = new Map<string, MetaValue>();
  const count = r.i32();
  if (count < 0 || count > 1e6) throw new Error('corrupt metadata');
  for (let i = 0; i < count; i++) {
    const name = r.str();
    const type = r.str();
    const size = r.u32();
    const body = r.sub(size);
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let value: MetaValue = null;
    try {
      switch (type) {
        case 'string':
          value = new TextDecoder().decode(body);
          break;
        case 'bool':
          value = body[0] !== 0;
          break;
        case 'int32':
          value = dv.getInt32(0, true);
          break;
        case 'int64':
          value = Number(dv.getBigInt64(0, true));
          break;
        case 'float':
          value = dv.getFloat32(0, true);
          break;
        case 'double':
          value = dv.getFloat64(0, true);
          break;
        case 'vec3i':
          value = [dv.getInt32(0, true), dv.getInt32(4, true), dv.getInt32(8, true)];
          break;
        case 'vec3s':
          value = [dv.getFloat32(0, true), dv.getFloat32(4, true), dv.getFloat32(8, true)];
          break;
        case 'vec3d':
          value = [dv.getFloat64(0, true), dv.getFloat64(8, true), dv.getFloat64(16, true)];
          break;
      }
    } catch {
      value = null;
    }
    out.set(name, value);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// transforms (column-major 4×4, index space → object space)

interface ParsedTransform {
  matrix: number[];
  warning?: string;
}

const scaleTranslate = (s: number[], t: number[]) => [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, t[0], t[1], t[2], 1];

function readMat4d(r: ByteReader): number[] {
  // stored row-major for row vectors (translation in the last row), which is exactly the
  // column-major layout of the equivalent column-vector matrix
  const m: number[] = [];
  for (let i = 0; i < 16; i++) m.push(r.f64());
  return m;
}

function mul4(a: number[], b: number[]): number[] {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let rr = 0; rr < 4; rr++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
      o[c * 4 + rr] = s;
    }
  return o;
}

function readTransform(r: ByteReader, version: number): ParsedTransform {
  const type = r.str();
  switch (type) {
    case 'UniformScaleMap':
    case 'ScaleMap': {
      const scale = r.vec3d();
      r.sub(4 * 24); // voxel size, inverse scale, inverse squared scale, inverse twice scale
      return { matrix: scaleTranslate(scale, [0, 0, 0]) };
    }
    case 'UniformScaleTranslateMap':
    case 'ScaleTranslateMap': {
      const translation = r.vec3d();
      const scale = r.vec3d();
      r.sub(4 * 24);
      return { matrix: scaleTranslate(scale, translation) };
    }
    case 'TranslationMap':
      return { matrix: scaleTranslate([1, 1, 1], r.vec3d()) };
    case 'AffineMap':
    case 'UnitaryMap':
      return { matrix: readMat4d(r) };
    case 'NonlinearFrustumMap': {
      let min: number[];
      let max: number[];
      if (version < 221) {
        min = [r.i32(), r.i32(), r.i32()];
        max = [r.i32(), r.i32(), r.i32()];
      } else {
        min = r.vec3d();
        max = r.vec3d();
      }
      r.f64(); // taper
      const depth = r.f64();
      const second = readTransform(r, version);
      // approximate the frustum by its untapered box: index bbox → [-0.5, 0.5]² × [0, depth]
      const ext = [max[0] - min[0] || 1, max[1] - min[1] || 1, max[2] - min[2] || 1];
      const s = [1 / ext[0], 1 / ext[1], depth / ext[2]];
      const box = scaleTranslate(s, [-min[0] * s[0] - 0.5, -min[1] * s[1] - 0.5, -min[2] * s[2]]);
      return {
        matrix: mul4(second.matrix, box),
        warning: 'uses a frustum transform, which is approximated by a box',
      };
    }
    default:
      throw new Error(`its transform type "${type}" is not supported`);
  }
}

// ---------------------------------------------------------------------------------------------
// tree parsing

interface GridContext {
  r: ByteReader;
  version: number;
  compression: number;
  type: ValueType;
  half: boolean;
  /** background value, one entry per channel */
  background: Float32Array;
  /** scratch buffer for decoded values */
  scratch: Float32Array;
}

/** Count of set bits in a node mask stored at `bytes[off .. off + n)`. */
function popcount(bytes: Uint8Array, off: number, n: number): number {
  let c = 0;
  for (let i = 0; i < n; i++) {
    let b = bytes[off + i];
    b = b - ((b >> 1) & 0x55);
    b = (b & 0x33) + ((b >> 2) & 0x33);
    c += (b + (b >> 4)) & 0x0f;
  }
  return c;
}

const bitOn = (bytes: Uint8Array, off: number, i: number) => (bytes[off + (i >> 3)] >> (i & 7)) & 1;

/** Read a value at full precision (root tiles, background, inactive values). */
function readFullValue(c: GridContext, out: Float32Array, outOff: number) {
  const raw = c.r.sub(c.type.size);
  const tmp = new Float32Array(c.type.channels);
  decodeValues(raw, 1, c.type, false, tmp);
  out.set(tmp, outOff);
}

/** Read a (possibly compressed) block of `nbytes` bytes. */
function readData(c: GridContext, nbytes: number): Uint8Array {
  const { r, compression } = c;
  if (compression & (COMPRESS_BLOSC | COMPRESS_ZIP)) {
    const size = r.i64();
    if (size <= 0) {
      const raw = r.sub(-size);
      if (raw.length < nbytes) throw new Error('a stored value block is too short');
      return raw;
    }
    const packed = r.sub(size);
    let out: Uint8Array;
    if (compression & COMPRESS_BLOSC) {
      out = bloscDecompress(packed);
    } else {
      out = unzlibSync(packed, { out: new Uint8Array(nbytes) });
    }
    if (out.length < nbytes) throw new Error('a compressed value block decoded to the wrong size');
    return out;
  }
  return r.sub(nbytes);
}

/**
 * Read the values of one node (`count` entries) into `dest` (count × channels floats),
 * restoring inactive values that were left out by mask compression. `maskOff` points at the
 * node's value mask inside the file bytes.
 */
function readCompressedValues(c: GridContext, count: number, maskOff: number, dest: Float32Array) {
  const { r, type, background } = c;
  const ch = type.channels;
  const bytes = r.bytes;
  const maskCompressed = (c.compression & COMPRESS_ACTIVE_MASK) !== 0;
  let meta = NO_MASK_AND_ALL_VALS;
  if (c.version >= V_NODE_MASK_COMPRESSION) meta = r.u8();
  if (meta > NO_MASK_AND_ALL_VALS) throw new Error('corrupt node value encoding');
  const inactive0 = new Float32Array(ch);
  const inactive1 = new Float32Array(background);
  for (let k = 0; k < ch; k++) inactive0[k] = meta === NO_MASK_OR_INACTIVE_VALS ? background[k] : -background[k];
  if (
    meta === NO_MASK_AND_ONE_INACTIVE_VAL ||
    meta === MASK_AND_ONE_INACTIVE_VAL ||
    meta === MASK_AND_TWO_INACTIVE_VALS
  ) {
    readFullValue(c, inactive0, 0);
    if (meta === MASK_AND_TWO_INACTIVE_VALS) readFullValue(c, inactive1, 0);
  }
  let selOff = -1;
  if (meta === MASK_AND_NO_INACTIVE_VALS || meta === MASK_AND_ONE_INACTIVE_VAL || meta === MASK_AND_TWO_INACTIVE_VALS) {
    selOff = r.pos;
    r.sub(count >> 3);
  }
  const compact = maskCompressed && meta !== NO_MASK_AND_ALL_VALS && c.version >= V_NODE_MASK_COMPRESSION;
  const stored = compact ? popcount(bytes, maskOff, count >> 3) : count;
  const half = c.half && type.halfSize > 0;
  // half-float blocks with no values are omitted entirely (no size prefix either)
  const raw =
    half && stored === 0 ? new Uint8Array(0) : readData(c, stored * (half ? type.halfSize : type.size));
  if (!compact) {
    decodeValues(raw, stored, type, half, dest);
    return;
  }
  if (c.scratch.length < stored * ch) c.scratch = new Float32Array(stored * ch);
  const tmp = c.scratch;
  decodeValues(raw, stored, type, half, tmp);
  let t = 0;
  for (let i = 0; i < count; i++) {
    if (bitOn(bytes, maskOff, i)) {
      for (let k = 0; k < ch; k++) dest[i * ch + k] = tmp[t++];
    } else {
      const v = selOff >= 0 && bitOn(bytes, selOff, i) ? inactive1 : inactive0;
      for (let k = 0; k < ch; k++) dest[i * ch + k] = v[k];
    }
  }
}

interface Topology {
  /** leaf origins (x, y, z per leaf) */
  leafOrigins: number[];
  /** byte offset of each leaf's value mask in the file */
  leafMasks: number[];
  /** tiles: origin x, y, z, edge length */
  tileBoxes: number[];
  tileValues: number[];
  tileActive: boolean[];
}

function readInternalTopology(c: GridContext, topo: Topology, ox: number, oy: number, oz: number, level: 1 | 2, keepInactive: boolean) {
  const { r, type } = c;
  const log2 = level === 2 ? 5 : 4;
  const childLog2 = level === 2 ? 7 : 3;
  const n = 1 << (3 * log2);
  const maskBytes = n >> 3;
  const bytes = r.bytes;
  const childOff = r.pos;
  r.sub(maskBytes);
  const valueOff = r.pos;
  r.sub(maskBytes);
  const ch = type.channels;
  const values = new Float32Array(n * ch);
  if (c.version >= V_NODE_MASK_COMPRESSION) {
    readCompressedValues(c, n, valueOff, values);
  } else {
    // older files store only the values of non-child entries
    const stored = n - popcount(bytes, childOff, maskBytes);
    const tmp = new Float32Array(stored * ch);
    readCompressedValues(c, stored, valueOff, tmp);
    for (let i = 0, t = 0; i < n; i++) {
      if (bitOn(bytes, childOff, i)) continue;
      for (let k = 0; k < ch; k++) values[i * ch + k] = tmp[t++];
    }
  }
  const tileSize = 1 << childLog2;
  const bg = c.background;
  for (let i = 0; i < n; i++) {
    if (bitOn(bytes, childOff, i)) continue;
    const active = bitOn(bytes, valueOff, i) === 1;
    if (!active) {
      if (!keepInactive) continue;
      let same = true;
      for (let k = 0; k < ch; k++) if (values[i * ch + k] !== bg[k]) same = false;
      if (same) continue;
    }
    const x = ox + ((i >> (2 * log2)) << childLog2);
    const y = oy + (((i >> log2) & ((1 << log2) - 1)) << childLog2);
    const z = oz + ((i & ((1 << log2) - 1)) << childLog2);
    topo.tileBoxes.push(x, y, z, tileSize);
    for (let k = 0; k < ch; k++) topo.tileValues.push(values[i * ch + k]);
    topo.tileActive.push(active);
  }
  for (let i = 0; i < n; i++) {
    if (!bitOn(bytes, childOff, i)) continue;
    const x = ox + ((i >> (2 * log2)) << childLog2);
    const y = oy + (((i >> log2) & ((1 << log2) - 1)) << childLog2);
    const z = oz + ((i & ((1 << log2) - 1)) << childLog2);
    if (level === 2) {
      readInternalTopology(c, topo, x, y, z, 1, keepInactive);
    } else {
      // leaf topology: the 8³ value mask (for mask grids, the mask is also the data)
      topo.leafOrigins.push(x, y, z);
      topo.leafMasks.push(r.pos);
      r.sub(64);
    }
  }
}

function readTopology(c: GridContext, keepInactive: boolean): Topology {
  const { r, type } = c;
  const topo: Topology = { leafOrigins: [], leafMasks: [], tileBoxes: [], tileValues: [], tileActive: [] };
  const bufferCount = r.i32();
  if (bufferCount !== 1) throw new Error('trees with multiple value buffers are not supported');
  readFullValue(c, c.background, 0);
  const numTiles = r.u32();
  const numChildren = r.u32();
  const ch = type.channels;
  const value = new Float32Array(ch);
  for (let i = 0; i < numTiles; i++) {
    const x = r.i32();
    const y = r.i32();
    const z = r.i32();
    readFullValue(c, value, 0);
    const active = r.u8() !== 0;
    if (!active && !keepInactive) continue;
    topo.tileBoxes.push(x, y, z, 4096);
    for (let k = 0; k < ch; k++) topo.tileValues.push(value[k]);
    topo.tileActive.push(active);
  }
  for (let i = 0; i < numChildren; i++) {
    const x = r.i32();
    const y = r.i32();
    const z = r.i32();
    readInternalTopology(c, topo, x, y, z, 2, keepInactive);
  }
  return topo;
}

// ---------------------------------------------------------------------------------------------
// dense output (with optional box-filter downsampling)

class DenseBuilder {
  readonly dims: [number, number, number];
  readonly values: Float32Array;
  private readonly weights: Float32Array | null;
  constructor(
    readonly min: [number, number, number],
    readonly size: [number, number, number],
    readonly factor: number,
    readonly channels: number,
    readonly background: Float32Array,
  ) {
    const f = factor;
    this.dims = [Math.ceil(size[0] / f), Math.ceil(size[1] / f), Math.ceil(size[2] / f)];
    const cells = this.dims[0] * this.dims[1] * this.dims[2];
    this.values = new Float32Array(cells * channels);
    if (f === 1) {
      if (channels === 1) this.values.fill(background[0]);
      else for (let i = 0; i < cells; i++) for (let k = 0; k < channels; k++) this.values[i * channels + k] = background[k];
      this.weights = null;
    } else {
      this.weights = new Float32Array(cells);
    }
  }

  /** Write one voxel (index-space coordinates); ignored outside the box. */
  voxel(x: number, y: number, z: number, src: Float32Array, off: number) {
    const lx = x - this.min[0];
    const ly = y - this.min[1];
    const lz = z - this.min[2];
    const [sx, sy, sz] = this.size;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= sx || ly >= sy || lz >= sz) return;
    const ch = this.channels;
    const [dx, dy] = this.dims;
    if (!this.weights) {
      const idx = ((lz * dy + ly) * dx + lx) * ch;
      for (let k = 0; k < ch; k++) this.values[idx + k] = src[off + k];
      return;
    }
    const f = this.factor;
    const cell = (Math.floor(lz / f) * dy + Math.floor(ly / f)) * dx + Math.floor(lx / f);
    for (let k = 0; k < ch; k++) this.values[cell * ch + k] += src[off + k];
    this.weights[cell] += 1;
  }

  /** Fill a cube of edge `s` at (x, y, z), clipped to the box. */
  box(x: number, y: number, z: number, s: number, src: Float32Array, off: number) {
    const lo = [x - this.min[0], y - this.min[1], z - this.min[2]];
    const a0 = [0, 0, 0];
    const a1 = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      a0[a] = Math.max(0, lo[a]);
      a1[a] = Math.min(this.size[a], lo[a] + s); // exclusive
      if (a1[a] <= a0[a]) return;
    }
    const ch = this.channels;
    const [dx, dy] = this.dims;
    if (!this.weights) {
      for (let zz = a0[2]; zz < a1[2]; zz++)
        for (let yy = a0[1]; yy < a1[1]; yy++) {
          let idx = ((zz * dy + yy) * dx + a0[0]) * ch;
          if (ch === 1) {
            this.values.fill(src[off], idx, idx + (a1[0] - a0[0]));
          } else {
            for (let xx = a0[0]; xx < a1[0]; xx++, idx += ch) for (let k = 0; k < ch; k++) this.values[idx + k] = src[off + k];
          }
        }
      return;
    }
    const f = this.factor;
    // per-axis overlap of the box with each output cell
    const ranges: { c0: number; w: number[] }[] = [];
    for (let a = 0; a < 3; a++) {
      const c0 = Math.floor(a0[a] / f);
      const c1 = Math.floor((a1[a] - 1) / f);
      const w: number[] = [];
      for (let cc = c0; cc <= c1; cc++) w.push(Math.min(a1[a], (cc + 1) * f) - Math.max(a0[a], cc * f));
      ranges.push({ c0, w });
    }
    const [rx, ry, rz] = ranges;
    for (let iz = 0; iz < rz.w.length; iz++)
      for (let iy = 0; iy < ry.w.length; iy++) {
        const wzy = rz.w[iz] * ry.w[iy];
        const rowCell = ((rz.c0 + iz) * dy + ry.c0 + iy) * dx + rx.c0;
        for (let ix = 0; ix < rx.w.length; ix++) {
          const cell = rowCell + ix;
          const wt = wzy * rx.w[ix];
          for (let k = 0; k < ch; k++) this.values[cell * ch + k] += src[off + k] * wt;
          this.weights[cell] += wt;
        }
      }
  }

  finish(): Float32Array {
    const w = this.weights;
    if (!w) return this.values;
    const f = this.factor;
    const ch = this.channels;
    const [dx, dy, dz] = this.dims;
    const ext = (a: number, cc: number) => Math.min(this.size[a], (cc + 1) * f) - cc * f;
    for (let z = 0; z < dz; z++) {
      const ez = ext(2, z);
      for (let y = 0; y < dy; y++) {
        const ezy = ez * ext(1, y);
        for (let x = 0; x < dx; x++) {
          const cell = (z * dy + y) * dx + x;
          const total = ezy * ext(0, x);
          const empty = total - w[cell];
          for (let k = 0; k < ch; k++) {
            const i = cell * ch + k;
            this.values[i] = (this.values[i] + empty * this.background[k]) / total;
          }
        }
      }
    }
    return this.values;
  }
}

function chooseFactor(size: [number, number, number], maxVoxels: number): number {
  const total = size[0] * size[1] * size[2];
  if (total <= maxVoxels) return 1;
  let f = Math.max(2, Math.floor(Math.cbrt(total / maxVoxels)));
  while (Math.ceil(size[0] / f) * Math.ceil(size[1] / f) * Math.ceil(size[2] / f) > maxVoxels) f++;
  return f;
}

// ---------------------------------------------------------------------------------------------
// grids

interface GridDescriptor {
  name: string;
  typeName: string;
  half: boolean;
  instanceParent: string;
  gridPos: number;
  blockPos: number;
  endPos: number;
}

function readDescriptor(r: ByteReader, version: number): GridDescriptor {
  let name = r.str();
  const sep = name.indexOf('\x1e');
  if (sep >= 0) name = name.slice(0, sep);
  let typeName = r.str();
  let half = false;
  if (typeName.endsWith('_HalfFloat')) {
    half = true;
    typeName = typeName.slice(0, -'_HalfFloat'.length);
  }
  const instanceParent = version >= V_GRID_INSTANCING ? r.str() : '';
  return { name, typeName, half, instanceParent, gridPos: r.i64(), blockPos: r.i64(), endPos: r.i64() };
}

/** Value type of a grid type name like "Tree_float_5_4_3", or an explanation why not. */
function valueTypeOf(typeName: string): ValueType | string {
  const m = /^Tree_([A-Za-z0-9]+)_(\d+(?:_\d+)*)$/.exec(typeName);
  if (!m) return `its type "${typeName}" is not a supported grid type`;
  const token = m[1];
  if (token.startsWith('ptdataidx') || token.startsWith('ptidx')) return 'point grids are not supported';
  const t = VALUE_TYPES[token];
  if (!t) return `its value type "${token}" is not supported`;
  if (m[2] !== '5_4_3') return `its tree configuration (${m[2].replace(/_/g, '-')}) is not supported`;
  return t;
}

function gridClassOf(meta: Map<string, MetaValue>): GridClass {
  const c = meta.get('class');
  if (c === 'level set') return 'LEVEL_SET';
  if (c === 'fog volume') return 'FOG_VOLUME';
  return 'UNKNOWN';
}

function readGrid(
  r: ByteReader,
  desc: GridDescriptor,
  type: ValueType,
  version: number,
  headerCompression: number,
  maxVoxels: number,
  warnings: string[],
): VolumeGrid | null {
  const compression = version >= V_NODE_MASK_COMPRESSION ? r.u32() : headerCompression;
  const meta = readMetaMap(r);
  const half = desc.half || meta.get('is_saved_as_half_float') === true;
  const gridClass = gridClassOf(meta);
  const ch = type.channels;
  const c: GridContext = {
    r,
    version,
    compression,
    type,
    half,
    background: new Float32Array(ch),
    scratch: new Float32Array(512 * ch),
  };
  // level sets keep their inside/outside sign in inactive values, so write those too
  const keepInactive = gridClass === 'LEVEL_SET' && type.dataType === 'FLOAT';

  let transform: ParsedTransform;
  let topo: Topology;
  if (version >= V_GRID_INSTANCING) {
    transform = readTransform(r, version);
    if (desc.instanceParent) {
      warnings.push(`Grid "${desc.name}" was skipped: it is an instance of grid "${desc.instanceParent}", which is not supported.`);
      return null;
    }
    topo = readTopology(c, keepInactive);
  } else {
    topo = readTopology(c, keepInactive);
    transform = readTransform(r, version);
  }
  if (transform.warning) warnings.push(`Grid "${desc.name}" ${transform.warning}.`);
  if (desc.blockPos > 0 && r.pos !== desc.blockPos) r.pos = desc.blockPos;

  const bytes = r.bytes;
  const { leafOrigins, leafMasks, tileBoxes, tileValues, tileActive } = topo;
  const nLeaves = leafMasks.length;

  // bounding box of the active voxels
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let l = 0; l < nLeaves; l++) {
    const off = leafMasks[l];
    const ox = leafOrigins[l * 3];
    const oy = leafOrigins[l * 3 + 1];
    const oz = leafOrigins[l * 3 + 2];
    for (let b = 0; b < 64; b++) {
      const v = bytes[off + b];
      if (!v) continue;
      const x = ox + (b >> 3);
      const y = oy + (b & 7);
      const z0 = oz + (31 - Math.clz32(v & -v));
      const z1 = oz + (31 - Math.clz32(v));
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z0 < minZ) minZ = z0;
      if (z1 > maxZ) maxZ = z1;
    }
  }
  for (let t = 0; t < tileActive.length; t++) {
    if (!tileActive[t]) continue;
    const x = tileBoxes[t * 4];
    const y = tileBoxes[t * 4 + 1];
    const z = tileBoxes[t * 4 + 2];
    const s = tileBoxes[t * 4 + 3];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x + s - 1);
    maxY = Math.max(maxY, y + s - 1);
    maxZ = Math.max(maxZ, z + s - 1);
  }
  const empty = minX > maxX;
  if (empty) {
    warnings.push(`Grid "${desc.name}" has no active voxels.`);
    minX = minY = minZ = 0;
    maxX = maxY = maxZ = 0;
  }
  const size: [number, number, number] = [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1];
  const factor = chooseFactor(size, Math.max(1, maxVoxels));
  if (factor > 1) {
    warnings.push(
      `Grid "${desc.name}" (${size.join('×')} voxels) was downsampled by a factor of ${factor} to fit the voxel limit.`,
    );
  }
  const dense = new DenseBuilder([minX, minY, minZ], size, factor, ch, c.background);

  // tiles
  for (let t = 0; t < tileActive.length; t++) {
    dense.box(tileBoxes[t * 4], tileBoxes[t * 4 + 1], tileBoxes[t * 4 + 2], tileBoxes[t * 4 + 3], new Float32Array(tileValues.slice(t * ch, t * ch + ch)), 0);
  }

  // leaf buffers, in the same order as the topology
  {
    const leafValues = new Float32Array(512 * ch);
    for (let l = 0; l < nLeaves; l++) {
      const ox = leafOrigins[l * 3];
      const oy = leafOrigins[l * 3 + 1];
      const oz = leafOrigins[l * 3 + 2];
      const maskOff = leafMasks[l];
      if (type.kind === Kind.Mask) {
        // the mask is the data; followed by the origin
        r.sub(64);
        r.sub(12);
        leafValues.fill(1);
      } else if (type.kind === Kind.Bool) {
        r.sub(64); // value mask (same as in the topology)
        if (version >= V_BOOL_LEAF_OPTIMIZATION) {
          r.sub(12); // origin
          const dataOff = r.pos;
          r.sub(64);
          for (let i = 0; i < 512; i++) leafValues[i] = bitOn(bytes, dataOff, i);
        } else {
          throw new Error('boolean grids from this file version are not supported');
        }
      } else {
        r.sub(64); // value mask (same as in the topology)
        if (version < V_NODE_MASK_COMPRESSION) {
          r.sub(12); // origin
          const numBuffers = r.u8();
          if (numBuffers !== 1) throw new Error('leaf nodes with multiple buffers are not supported');
        }
        readCompressedValues(c, 512, maskOff, leafValues);
      }
      // scatter into the dense grid
      for (let b = 0; b < 64; b++) {
        const m = keepInactive ? 0xff : bytes[maskOff + b];
        if (!m) continue;
        const x = ox + (b >> 3);
        const y = oy + (b & 7);
        for (let z = 0; z < 8; z++) {
          if (!((m >> z) & 1)) continue;
          dense.voxel(x, y, oz + z, leafValues, ((b << 3) | z) * ch);
        }
      }
    }
  }

  // transform: grid map · translate(bbox origin + cell centre offset) · scale(factor)
  const M = transform.matrix;
  const o = [minX + (factor - 1) / 2, minY + (factor - 1) / 2, minZ + (factor - 1) / 2];
  const out = M.slice();
  for (let col = 0; col < 3; col++) for (let row = 0; row < 4; row++) out[col * 4 + row] = M[col * 4 + row] * factor;
  for (let row = 0; row < 4; row++) out[12 + row] = M[row] * o[0] + M[4 + row] * o[1] + M[8 + row] * o[2] + M[12 + row];

  return {
    name: desc.name,
    data_type: type.dataType,
    grid_class: gridClass,
    dims: dense.dims,
    transform: out,
    values: dense.finish(),
    background: c.background[0],
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * Read an OpenVDB file. Each supported grid becomes a dense grid over the bounding box of its
 * active voxels (downsampled when larger than `maxVoxels`); unsupported grids are skipped with
 * a warning. Throws when the data is not a readable .vdb file.
 */
export function readVdb(bytes: Uint8Array, opts: ReadVdbOptions = {}): ReadVdbResult {
  const maxVoxels = opts.maxVoxels ?? DEFAULT_MAX_VOXELS;
  const warnings: string[] = [];
  const grids: VolumeGrid[] = [];
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new Error('This is not an OpenVDB (.vdb) volume file.');
  }
  const r = new ByteReader(bytes);
  r.pos = 8;
  let version: number;
  let hasOffsets = true;
  let headerCompression = COMPRESS_ZIP | COMPRESS_ACTIVE_MASK;
  try {
    version = r.u32();
    if (version < MIN_VERSION) {
      throw new Error(
        `This .vdb file uses format version ${version}, which is too old to be imported (version ${MIN_VERSION} or newer is needed). Re-saving it with current OpenVDB tools should fix this.`,
      );
    }
    if (version > NEWEST_KNOWN_VERSION) {
      warnings.push(`The file uses format version ${version}, which is newer than this importer knows; it may not load correctly.`);
    }
    r.u32(); // library major version
    r.u32(); // library minor version
    hasOffsets = r.u8() !== 0;
    if (version < V_NODE_MASK_COMPRESSION) headerCompression = r.u8() ? COMPRESS_ZIP : 0;
    r.sub(36); // UUID
    readMetaMap(r); // file-level metadata
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('This .vdb')) throw e;
    throw new Error(`This .vdb file could not be read: ${(e as Error).message}.`);
  }

  let gridCount: number;
  try {
    gridCount = r.i32();
  } catch {
    throw new Error('This .vdb file could not be read: the file is truncated or corrupt.');
  }
  if (gridCount < 0) throw new Error('This .vdb file could not be read: the file is corrupt.');

  for (let g = 0; g < gridCount; g++) {
    let desc: GridDescriptor;
    try {
      desc = readDescriptor(r, version);
    } catch (e) {
      warnings.push(`Stopped reading after ${g} of ${gridCount} grids: ${(e as Error).message}.`);
      break;
    }
    const type = valueTypeOf(desc.typeName);
    if (typeof type === 'string') {
      warnings.push(`Grid "${desc.name}" was skipped: ${type}.`);
      if (hasOffsets && desc.endPos > 0) {
        r.pos = desc.endPos;
        continue;
      }
      warnings.push(`The remaining grids could not be located and were not read.`);
      break;
    }
    try {
      if (hasOffsets && desc.gridPos > 0) r.pos = desc.gridPos;
      const grid = readGrid(r, desc, type, version, headerCompression, maxVoxels, warnings);
      if (grid) grids.push(grid);
    } catch (e) {
      warnings.push(`Grid "${desc.name}" was skipped: ${(e as Error).message}.`);
      if (!(hasOffsets && desc.endPos > 0)) {
        warnings.push(`The remaining grids could not be located and were not read.`);
        break;
      }
    }
    if (hasOffsets && desc.endPos > 0) r.pos = desc.endPos;
  }
  return { grids, warnings };
}
