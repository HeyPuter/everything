// ICC profile model and parser for LUT-based and matrix/TRC profiles, written
// from ICC.1:2022 (v4.4) and ICC.1:2001-04 (v2.4). Supported tags: lut8Type
// (mft1), lut16Type (mft2), lutAtoBType (mAB), lutBtoAType (mBA) with curv/para
// curves, matrices and CLUTs of any grid size and 8/16-bit precision; rXYZ..
// colorants with rTRC.. or kTRC shapers; wtpt, bkpt, chad, desc, cprt, gamt.
// Device classes scnr, mntr, prtr, spac (and abst) with RGB, CMYK, Gray, Lab,
// XYZ or n-color data and an XYZ or Lab PCS.
//
// Values travel between pipeline stages normalized to [0, 1] (the encoded
// integer divided by its maximum), exactly as the ICC processing model
// describes. The PCS side is converted to floating-point D50 XYZ (Y = 1 for
// the PCS white) at the edge of each profile so profiles with different PCS
// encodings (v4 Lab, legacy 16-bit Lab, u1Fixed15 XYZ) connect directly.
import { curveValue, type Curve } from './profile';
import {
  D50,
  decodeLab,
  encodeLab,
  labToXYZ,
  mat3Inv,
  xyzToLab,
  XYZ_SCALE,
  type LabEncoding,
  type Vec3,
} from './color-math';

export type DeviceClass = 'scnr' | 'mntr' | 'prtr' | 'spac' | 'abst' | 'link' | 'nmcl';
export type Intent = 'perceptual' | 'relative' | 'saturation' | 'absolute';
export const INTENTS: Intent[] = ['perceptual', 'relative', 'saturation', 'absolute'];

// Grid nodes: the first input channel varies slowest, outputs are interleaved.
export type Clut = { grid: number[]; inputs: number; outputs: number; data: Float32Array; precision: 1 | 2 };
export type Lut16Tag = {
  type: 'lut8' | 'lut16';
  inputs: number;
  outputs: number;
  // Applied only when the input space is XYZ (ICC.1 10.10/10.11).
  matrix: number[];
  inCurves: Float32Array[];
  clut: Clut;
  outCurves: Float32Array[];
};
export type LutABTag = {
  type: 'mAB' | 'mBA';
  inputs: number;
  outputs: number;
  A?: Curve[];
  clut?: Clut;
  M?: Curve[];
  // 3x3 row-major followed by the 3 offsets.
  matrix?: number[];
  B: Curve[];
};
export type LutTag = Lut16Tag | LutABTag;

export type Profile = {
  name: string;
  copyright?: string;
  // Major.minor, for example 2.1 or 4.3.
  version: number;
  deviceClass: DeviceClass;
  // 'RGB', 'CMYK', 'GRAY', 'Lab', 'XYZ', 'CMY' or 'nCLR' (n = 2..15).
  colorSpace: string;
  channels: number;
  pcs: 'XYZ' | 'Lab';
  renderingIntent: number;
  // wtpt as stored (already adapted to D50 for v4 display profiles).
  mediaWhite: Vec3;
  mediaBlack?: Vec3;
  chad?: number[];
  matrix?: number[];
  // Three curves for RGB matrix/TRC profiles, one for Gray.
  trc?: Curve[];
  a2b: (LutTag | undefined)[];
  b2a: (LutTag | undefined)[];
  gamut?: LutTag;
  // Original bytes when parsed (embedding a document's own profile verbatim).
  bytes?: Uint8Array;
  // Stable identity for transform caches.
  key: string;
};
export class IccError extends Error {}

const SPACES: Record<string, [string, number]> = {
  'RGB ': ['RGB', 3],
  CMYK: ['CMYK', 4],
  GRAY: ['GRAY', 1],
  'Lab ': ['Lab', 3],
  'XYZ ': ['XYZ', 3],
  'CMY ': ['CMY', 3],
  'HSV ': ['HSV', 3],
  'HLS ': ['HLS', 3],
  'YCbr': ['YCbr', 3],
  'Luv ': ['Luv', 3],
  'Yxy ': ['Yxy', 3],
};
export function spaceInfo(sig: string): [string, number] | undefined {
  if (SPACES[sig]) return SPACES[sig];
  const m = /^([2-9A-F])CLR$/.exec(sig);
  if (m) {
    const n = parseInt(m[1], 16);
    return [`${n}CLR`, n];
  }
  return undefined;
}

let parseCounter = 0;
export function parseIcc(bytes: Uint8Array): Profile {
  const fail = (message: string): never => {
    throw new IccError(message);
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 132 || sig(36) !== 'acsp') fail('Invalid ICC profile header.');
  const size = view.getUint32(0),
    major = bytes[8];
  if (size < 132 || size > bytes.length) fail('Invalid ICC profile length.');
  if (major !== 2 && major !== 4) fail(`Unsupported ICC profile version ${major}.`);
  const version = major + (bytes[9] >> 4) / 10;
  const deviceClass = sig(12) as DeviceClass;
  if (!['scnr', 'mntr', 'prtr', 'spac', 'abst'].includes(deviceClass))
    fail(`Unsupported ICC device class ${deviceClass}.`);
  const space = spaceInfo(sig(16)) ?? fail(`Unsupported ICC color space ${sig(16)}.`);
  const pcsSig = sig(20);
  if (pcsSig !== 'XYZ ' && pcsSig !== 'Lab ') fail('ICC PCS must be XYZ or Lab.');
  const count = view.getUint32(128),
    tableEnd = 132 + count * 12;
  if (tableEnd > size) fail('Invalid ICC tag table.');
  const tags = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < count; i++) {
    const at = 132 + i * 12;
    const offset = view.getUint32(at + 4),
      length = view.getUint32(at + 8);
    if (offset < tableEnd || length < 8 || offset + length > size) fail('Invalid ICC tag boundary.');
    if (!tags.has(sig(at))) tags.set(sig(at), { offset, length });
  }
  const typeAt = (name: string) => sig(tags.get(name)!.offset);
  const xyzTag = (name: string): Vec3 | undefined => {
    const t = tags.get(name);
    if (!t) return undefined;
    if (t.length < 20 || sig(t.offset) !== 'XYZ ') fail(`Invalid ICC ${name} tag.`);
    return [0, 1, 2].map((i) => view.getInt32(t.offset + 8 + i * 4) / 65536) as Vec3;
  };
  // Names are read defensively: counts and lengths in a damaged tag must
  // neither run past it nor loop over billions of records.
  const MAX_TEXT = 1024;
  const latin1 = (from: number, to: number) => {
    let s = '';
    for (let i = from; i < Math.min(to, from + MAX_TEXT); i++) s += String.fromCharCode(bytes[i]);
    return s;
  };
  const text = (name: string): string | undefined => {
    const t = tags.get(name);
    if (!t) return undefined;
    const type = typeAt(name),
      o = t.offset;
    if (type === 'desc') {
      if (t.length < 12) return undefined;
      const n = view.getUint32(o + 8);
      if (12 + n > t.length) return undefined;
      return latin1(o + 12, o + 12 + n).replace(/\0[\s\S]*$/, '');
    }
    if (type === 'text') return latin1(o + 8, o + t.length).replace(/\0[\s\S]*$/, '');
    if (type === 'mluc') {
      if (t.length < 16) return undefined;
      const recSize = view.getUint32(o + 12);
      if (recSize < 12) return undefined;
      const records = Math.min(view.getUint32(o + 8), Math.floor((t.length - 16) / recSize));
      if (records < 1) return undefined;
      // Prefer English, otherwise the first record.
      let pick = 0;
      for (let i = 0; i < records; i++) if (sig(o + 16 + i * recSize).startsWith('en')) { pick = i; break; }
      const r = o + 16 + pick * recSize;
      const len = view.getUint32(r + 4),
        off = view.getUint32(r + 8);
      if (off + len > t.length) return undefined;
      let s = '';
      for (let i = 0; i + 1 < Math.min(len, MAX_TEXT * 2); i += 2) s += String.fromCharCode(view.getUint16(o + off + i));
      return s.replace(/\0[\s\S]*$/, '');
    }
    return undefined;
  };

  const lutTag = (name: string, direction: 'A2B' | 'B2A' | 'gamut'): LutTag | undefined => {
    const t = tags.get(name);
    if (!t) return undefined;
    const pcsChannels = 3;
    const ins = direction === 'A2B' ? space[1] : pcsChannels;
    const outs = direction === 'A2B' ? pcsChannels : direction === 'gamut' ? 1 : space[1];
    const tag = parseLutTag(view, t.offset, t.length);
    if (tag.inputs !== ins || tag.outputs !== outs) fail(`ICC ${name} has the wrong channel counts.`);
    return tag;
  };

  const chadTag = tags.get('chad');
  let chad: number[] | undefined;
  if (chadTag) {
    if (chadTag.length < 44 || sig(chadTag.offset) !== 'sf32') fail('Invalid ICC chad tag.');
    chad = Array.from({ length: 9 }, (_, i) => view.getInt32(chadTag.offset + 8 + i * 4) / 65536);
  }
  const profile: Profile = {
    name: text('desc') ?? 'Untitled profile',
    copyright: text('cprt'),
    version,
    deviceClass,
    colorSpace: space[0],
    channels: space[1],
    pcs: pcsSig === 'XYZ ' ? 'XYZ' : 'Lab',
    renderingIntent: view.getUint32(64) & 0xffff,
    mediaWhite: xyzTag('wtpt') ?? [...D50],
    mediaBlack: xyzTag('bkpt'),
    chad,
    a2b: [0, 1, 2].map((i) => lutTag(`A2B${i}`, 'A2B')),
    b2a: [0, 1, 2].map((i) => lutTag(`B2A${i}`, 'B2A')),
    gamut: lutTag('gamt', 'gamut'),
    bytes: bytes.slice(0, size),
    key: `icc:${++parseCounter}`,
  };
  const curveTag = (name: string) => {
    const t = tags.get(name) ?? fail(`Missing ICC ${name} tag.`);
    return parseCurveAt(view, t.offset, t.length).curve;
  };
  if (space[0] === 'RGB' && ['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'].every((n) => tags.has(n))) {
    const cols = ['rXYZ', 'gXYZ', 'bXYZ'].map((n) => xyzTag(n)!);
    profile.matrix = Array.from({ length: 9 }, (_, i) => cols[i % 3][Math.floor(i / 3)]);
    try {
      mat3Inv(profile.matrix);
    } catch {
      fail('Singular ICC RGB colorant matrix.');
    }
    profile.trc = ['rTRC', 'gTRC', 'bTRC'].map(curveTag);
  } else if (space[0] === 'GRAY' && tags.has('kTRC')) profile.trc = [curveTag('kTRC')];
  const usable =
    profile.a2b.some(Boolean) || profile.trc || (space[0] === 'Lab' || space[0] === 'XYZ');
  if (!usable) fail('ICC profile has no device-to-PCS transform this CMM supports.');
  return profile;
}

// Curves are 4-byte aligned when packed in mAB/mBA tags.
export function parseCurveAt(view: DataView, at: number, limit: number): { curve: Curve; size: number } {
  const fail = (m: string): never => {
    throw new IccError(m);
  };
  const type = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (limit < 12) fail('Truncated ICC curve.');
  if (type === 'curv') {
    const n = view.getUint32(at + 8);
    if (12 + n * 2 > limit) fail('Truncated ICC curve samples.');
    const size = (12 + n * 2 + 3) & ~3;
    if (n === 0) return { curve: { kind: 'parametric', type: 0, parameters: [1] }, size };
    if (n === 1) {
      const g = view.getUint16(at + 12) / 256;
      if (g <= 0) fail('Invalid ICC curve gamma.');
      return { curve: { kind: 'parametric', type: 0, parameters: [g] }, size };
    }
    const values = Array.from({ length: n }, (_, i) => view.getUint16(at + 12 + i * 2) / 65535);
    return { curve: { kind: 'table', values }, size };
  }
  if (type === 'para') {
    const fn = view.getUint16(at + 8),
      len = [1, 3, 4, 5, 7][fn];
    if (!len || 12 + len * 4 > limit) fail('Invalid ICC parametric curve.');
    const parameters = Array.from({ length: len }, (_, i) => view.getInt32(at + 12 + i * 4) / 65536);
    if (parameters[0] <= 0 || (fn > 0 && parameters[1] === 0)) fail('Undefined ICC parametric curve.');
    return { curve: { kind: 'parametric', type: fn, parameters }, size: (12 + len * 4 + 3) & ~3 };
  }
  return fail(`Unsupported ICC curve type ${type}.`);
}

export function parseLutTag(view: DataView, at: number, length: number): LutTag {
  const fail = (m: string): never => {
    throw new IccError(m);
  };
  const type = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (type === 'mft1' || type === 'mft2') {
    const wide = type === 'mft2';
    const inputs = view.getUint8(at + 8),
      outputs = view.getUint8(at + 9),
      g = view.getUint8(at + 10);
    if (!inputs || !outputs || inputs > 15 || outputs > 15 || g < 2) fail('Invalid ICC lut header.');
    const matrix = Array.from({ length: 9 }, (_, i) => view.getInt32(at + 12 + i * 4) / 65536);
    let p = at + 48;
    const inN = wide ? view.getUint16(at + 48) : 256,
      outN = wide ? view.getUint16(at + 50) : 256;
    if (wide) p += 4;
    if (inN < 2 || outN < 2) fail('Invalid ICC lut table size.');
    const bytes = wide ? 2 : 1,
      max = wide ? 65535 : 255;
    const nodes = g ** inputs;
    const total = (inN * inputs + nodes * outputs + outN * outputs) * bytes;
    if (p - at + total > length) fail('Truncated ICC lut tag.');
    const read = (n: number) => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++, p += bytes) a[i] = (wide ? view.getUint16(p) : view.getUint8(p)) / max;
      return a;
    };
    const inCurves = Array.from({ length: inputs }, () => read(inN));
    const data = read(nodes * outputs);
    const outCurves = Array.from({ length: outputs }, () => read(outN));
    return {
      type: wide ? 'lut16' : 'lut8',
      inputs,
      outputs,
      matrix,
      inCurves,
      clut: { grid: new Array(inputs).fill(g), inputs, outputs, data, precision: bytes as 1 | 2 },
      outCurves,
    };
  }
  if (type === 'mAB ' || type === 'mBA ') {
    const ab = type === 'mAB ';
    const inputs = view.getUint8(at + 8),
      outputs = view.getUint8(at + 9);
    if (!inputs || !outputs || inputs > 15 || outputs > 15) fail('Invalid ICC lutAB header.');
    const [oB, oMat, oM, oClut, oA] = [12, 16, 20, 24, 28].map((d) => view.getUint32(at + d));
    const curves = (offset: number, n: number) => {
      const list: Curve[] = [];
      let p = at + offset;
      for (let i = 0; i < n; i++) {
        if (p + 12 > at + length) fail('Truncated ICC lutAB curves.');
        const c = parseCurveAt(view, p, at + length - p);
        list.push(c.curve);
        p += c.size;
      }
      return list;
    };
    // mAB: A(in) -> CLUT -> M(out) -> Matrix -> B(out).
    // mBA: B(in) -> Matrix -> M(in) -> CLUT -> A(out).
    const matrixSide = ab ? outputs : inputs;
    const tag: LutABTag = { type: ab ? 'mAB' : 'mBA', inputs, outputs, B: [] };
    if (!oB) fail('ICC lutAB tag lacks B curves.');
    tag.B = curves(oB, ab ? outputs : inputs);
    if (oMat) {
      if (matrixSide !== 3) fail('ICC lutAB matrix requires three channels.');
      if (oMat + 48 > length) fail('Truncated ICC lutAB matrix.');
      tag.matrix = Array.from({ length: 12 }, (_, i) => view.getInt32(at + oMat + i * 4) / 65536);
    }
    if (oM) tag.M = curves(oM, matrixSide);
    if (oClut) {
      const grid = Array.from({ length: inputs }, (_, i) => view.getUint8(at + oClut + i));
      const precision = view.getUint8(at + oClut + 16);
      if (precision !== 1 && precision !== 2) fail('Invalid ICC CLUT precision.');
      if (grid.some((n) => n < 1)) fail('Invalid ICC CLUT grid.');
      const n = grid.reduce((a, b) => a * b, 1) * outputs;
      const start = at + oClut + 20;
      if (oClut + 20 + n * precision > length) fail('Truncated ICC CLUT.');
      const data = new Float32Array(n);
      for (let i = 0; i < n; i++)
        data[i] = precision === 2 ? view.getUint16(start + i * 2) / 65535 : view.getUint8(start + i) / 255;
      tag.clut = { grid, inputs, outputs, data, precision: precision as 1 | 2 };
    }
    if (oA) tag.A = curves(oA, ab ? inputs : outputs);
    if (!tag.clut && inputs !== outputs) fail('ICC lutAB without CLUT must keep the channel count.');
    if ((tag.A && !tag.clut) || (tag.M && !tag.matrix)) fail('Invalid ICC lutAB element combination.');
    return tag;
  }
  return fail(`Unsupported ICC lut tag type ${type}.`);
}

// --- Evaluation -----------------------------------------------------------

// A stage transforms the leading channels of a scratch vector in place.
export type Stage = (v: Float64Array) => void;

export function tableValue(t: Float32Array, x: number): number {
  const last = t.length - 1;
  if (!(x > 0)) return t[0];
  if (x >= 1) return t[last];
  const p = x * last,
    i = p | 0;
  return t[i] + (t[i + 1] - t[i]) * (p - i);
}

// Tetrahedral interpolation for 3-input CLUTs (Kasson, Nin, Plouffe & Hafner
// 1995), multilinear for 1-2 inputs, and tetrahedral-within-multilinear for
// more (each corner of the leading dimensions is a 3D tetrahedral lookup).
export function clutEvaluator(clut: Clut): (inp: ArrayLike<number>, out: Float64Array) => void {
  const { grid, inputs: n, outputs: m, data } = clut;
  const stride = new Array<number>(n);
  stride[n - 1] = m;
  for (let d = n - 2; d >= 0; d--) stride[d] = stride[d + 1] * grid[d + 1];
  const base = new Int32Array(n),
    frac = new Float64Array(n),
    step = new Int32Array(n);
  const locate = (inp: ArrayLike<number>) => {
    for (let d = 0; d < n; d++) {
      const g = grid[d];
      let x = inp[d];
      x = x > 0 ? (x < 1 ? x : 1) : 0;
      if (g === 1) {
        base[d] = 0;
        frac[d] = 0;
        step[d] = 0;
        continue;
      }
      const p = x * (g - 1);
      let i = p | 0;
      if (i >= g - 1) i = g - 2;
      base[d] = i * stride[d];
      frac[d] = p - i;
      step[d] = stride[d];
    }
  };
  const tetra = (b: number, d0: number, out: Float64Array, w: number) => {
    const fx = frac[d0],
      fy = frac[d0 + 1],
      fz = frac[d0 + 2];
    const sx = step[d0],
      sy = step[d0 + 1],
      sz = step[d0 + 2];
    let a: number, bb: number, c: number, wa: number, wb: number, wc: number;
    // Walk the cube diagonal along the largest fractional axis first.
    if (fx >= fy) {
      if (fy >= fz) { a = sx; bb = sx + sy; c = sx + sy + sz; wa = fx; wb = fy; wc = fz; }
      else if (fx >= fz) { a = sx; bb = sx + sz; c = sx + sy + sz; wa = fx; wb = fz; wc = fy; }
      else { a = sz; bb = sx + sz; c = sx + sy + sz; wa = fz; wb = fx; wc = fy; }
    } else {
      if (fz >= fy) { a = sz; bb = sy + sz; c = sx + sy + sz; wa = fz; wb = fy; wc = fx; }
      else if (fz >= fx) { a = sy; bb = sy + sz; c = sx + sy + sz; wa = fy; wb = fz; wc = fx; }
      else { a = sy; bb = sx + sy; c = sx + sy + sz; wa = fy; wb = fx; wc = fz; }
    }
    for (let k = 0; k < m; k++) {
      const v0 = data[b + k],
        va = data[b + a + k],
        vb = data[b + bb + k],
        vc = data[b + c + k];
      out[k] += w * (v0 + wa * (va - v0) + wb * (vb - va) + wc * (vc - vb));
    }
  };
  if (n === 3)
    return (inp, out) => {
      locate(inp);
      for (let k = 0; k < m; k++) out[k] = 0;
      tetra(base[0] + base[1] + base[2], 0, out, 1);
    };
  if (n > 3) {
    const lead = n - 3,
      corners = 1 << lead;
    return (inp, out) => {
      locate(inp);
      for (let k = 0; k < m; k++) out[k] = 0;
      const tail = base[lead] + base[lead + 1] + base[lead + 2];
      for (let c = 0; c < corners; c++) {
        let w = 1,
          b = tail;
        for (let d = 0; d < lead; d++) {
          const bit = (c >> (lead - 1 - d)) & 1;
          w *= bit ? frac[d] : 1 - frac[d];
          b += base[d] + (bit ? step[d] : 0);
        }
        if (w > 0) tetra(b, lead, out, w);
      }
    };
  }
  const corners = 1 << n;
  return (inp, out) => {
    locate(inp);
    for (let k = 0; k < m; k++) out[k] = 0;
    for (let c = 0; c < corners; c++) {
      let w = 1,
        b = 0;
      for (let d = 0; d < n; d++) {
        const bit = (c >> (n - 1 - d)) & 1;
        w *= bit ? frac[d] : 1 - frac[d];
        b += base[d] + (bit ? step[d] : 0);
      }
      if (w > 0) for (let k = 0; k < m; k++) out[k] += w * data[b + k];
    }
  };
}

const clampUnit = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);

function curvesStage(curves: Curve[]): Stage | null {
  const identity = (c: Curve) => c.kind === 'parametric' && c.type === 0 && c.parameters[0] === 1;
  if (curves.every(identity)) return (v) => {
    for (let i = 0; i < curves.length; i++) v[i] = clampUnit(v[i]);
  };
  const fns = curves.map(compileCurve);
  return (v) => {
    for (let i = 0; i < fns.length; i++) v[i] = fns[i](clampUnit(v[i]));
  };
}

// Fast evaluators for ICC curves: tables interpolate directly and parametric
// curves fall back to the shared reference implementation.
export function compileCurve(c: Curve): (x: number) => number {
  if (c.kind === 'table') {
    const t = Float32Array.from(c.values);
    return (x) => tableValue(t, x);
  }
  if (c.kind === 'parametric' && c.type === 0) {
    const g = c.parameters[0];
    return g === 1 ? (x) => x : (x) => (x > 0 ? x ** g : 0);
  }
  return (x) => curveValue(c, x);
}
export function compileInverseCurve(c: Curve): (x: number) => number {
  if (c.kind === 'parametric' && c.type === 0) {
    const g = 1 / c.parameters[0];
    return g === 1 ? (x) => x : (x) => (x > 0 ? (x < 1 ? x ** g : 1) : 0);
  }
  return (x) => curveValue(c, x, true);
}

export function lutStages(tag: LutTag, inputIsXYZ: boolean): Stage[] {
  const stages: Stage[] = [];
  const clutStage = (clut: Clut): Stage => {
    const ev = clutEvaluator(clut),
      out = new Float64Array(clut.outputs);
    return (v) => {
      ev(v, out);
      for (let k = 0; k < clut.outputs; k++) v[k] = out[k];
    };
  };
  const matrixStage = (m: number[]): Stage => (v) => {
    const x = v[0],
      y = v[1],
      z = v[2];
    v[0] = m[0] * x + m[1] * y + m[2] * z + (m[9] ?? 0);
    v[1] = m[3] * x + m[4] * y + m[5] * z + (m[10] ?? 0);
    v[2] = m[6] * x + m[7] * y + m[8] * z + (m[11] ?? 0);
  };
  const push = (s: Stage | null) => s && stages.push(s);
  if (tag.type === 'lut8' || tag.type === 'lut16') {
    const identity = tag.matrix.every((n, i) => n === (i % 4 === 0 ? 1 : 0));
    if (inputIsXYZ && tag.inputs === 3 && !identity) push(matrixStage(tag.matrix));
    const tables = (ts: Float32Array[]): Stage => (v) => {
      for (let i = 0; i < ts.length; i++) v[i] = tableValue(ts[i], v[i]);
    };
    push(tables(tag.inCurves));
    push(clutStage(tag.clut));
    push(tables(tag.outCurves));
    return stages;
  }
  const ab = tag as LutABTag;
  if (ab.type === 'mAB') {
    if (ab.A) push(curvesStage(ab.A));
    if (ab.clut) push(clutStage(ab.clut));
    if (ab.M) push(curvesStage(ab.M));
    if (ab.matrix) push(matrixStage(ab.matrix));
    push(curvesStage(ab.B));
  } else {
    push(curvesStage(ab.B));
    if (ab.matrix) push(matrixStage(ab.matrix));
    if (ab.M) push(curvesStage(ab.M));
    if (ab.clut) push(clutStage(ab.clut));
    if (ab.A) push(curvesStage(ab.A));
  }
  return stages;
}

export const labEncodingOf = (tag: LutTag): LabEncoding => (tag.type === 'lut16' ? 'legacy' : 'v4');

// PCS edges: decode a tag's normalized PCS output to D50 XYZ, or encode XYZ
// into the normalized PCS input a tag expects.
export function pcsDecodeStage(pcs: 'XYZ' | 'Lab', enc: LabEncoding): Stage {
  if (pcs === 'XYZ')
    return (v) => {
      v[0] *= XYZ_SCALE;
      v[1] *= XYZ_SCALE;
      v[2] *= XYZ_SCALE;
    };
  const lab = new Float64Array(3);
  return (v) => {
    decodeLab(v, enc, lab);
    labToXYZ(lab, D50, v);
  };
}
export function pcsEncodeStage(pcs: 'XYZ' | 'Lab', enc: LabEncoding): Stage {
  if (pcs === 'XYZ')
    return (v) => {
      v[0] = clampUnit(v[0] / XYZ_SCALE);
      v[1] = clampUnit(v[1] / XYZ_SCALE);
      v[2] = clampUnit(v[2] / XYZ_SCALE);
    };
  const lab = new Float64Array(3);
  return (v) => {
    xyzToLab(v, D50, lab);
    encodeLab(lab, enc, v);
  };
}

export const intentIndex = (i: Intent) => INTENTS.indexOf(i);

// ICC tag selection: the requested intent's table, then the perceptual table
// (ICC.1 Table 25 fallback), then the matrix/TRC model. Absolute colorimetric
// uses the colorimetric table plus media white scaling done by the transform.
export function selectTag(list: (LutTag | undefined)[], intent: Intent): LutTag | undefined {
  const i = intent === 'absolute' ? 1 : intentIndex(intent);
  return list[i] ?? list[0] ?? list[1] ?? list[2];
}

export type Side = {
  channels: number;
  stages: Stage[];
  // Present when this side is a pure matrix/shaper, enabling fused fast paths.
  shaper?: { matrix: number[]; curves: Curve[] };
};

// Device -> D50 XYZ for a profile and intent.
export function deviceToXYZ(p: Profile, intent: Intent): Side {
  const tag = selectTag(p.a2b, intent);
  if (tag) {
    const stages = lutStages(tag, p.colorSpace === 'XYZ');
    stages.push(pcsDecodeStage(p.pcs, labEncodingOf(tag)));
    return { channels: p.channels, stages };
  }
  if (p.matrix && p.trc?.length === 3) {
    const m = p.matrix,
      fns = p.trc.map(compileCurve);
    return {
      channels: 3,
      shaper: { matrix: m, curves: p.trc },
      stages: [
        (v) => {
          const r = fns[0](v[0]),
            g = fns[1](v[1]),
            b = fns[2](v[2]);
          v[0] = m[0] * r + m[1] * g + m[2] * b;
          v[1] = m[3] * r + m[4] * g + m[5] * b;
          v[2] = m[6] * r + m[7] * g + m[8] * b;
        },
      ],
    };
  }
  if (p.colorSpace === 'GRAY' && p.trc) {
    const fn = compileCurve(p.trc[0]);
    if (p.pcs === 'Lab') {
      const lab = new Float64Array(3);
      return {
        channels: 1,
        stages: [
          (v) => {
            lab[0] = 100 * fn(clampUnit(v[0]));
            lab[1] = lab[2] = 0;
            labToXYZ(lab, D50, v);
          },
        ],
      };
    }
    return {
      channels: 1,
      stages: [
        (v) => {
          const y = fn(clampUnit(v[0]));
          v[0] = D50[0] * y;
          v[1] = y;
          v[2] = D50[2] * y;
        },
      ],
    };
  }
  if (p.colorSpace === 'Lab') return { channels: 3, stages: [pcsDecodeStage('Lab', 'v4')] };
  if (p.colorSpace === 'XYZ') return { channels: 3, stages: [pcsDecodeStage('XYZ', 'v4')] };
  throw new IccError(`Profile "${p.name}" has no device-to-PCS transform.`);
}

// D50 XYZ -> device for a profile and intent.
export function xyzToDevice(p: Profile, intent: Intent): Side {
  const tag = selectTag(p.b2a, intent);
  if (tag) {
    const stages: Stage[] = [pcsEncodeStage(p.pcs, labEncodingOf(tag))];
    stages.push(...lutStages(tag, p.pcs === 'XYZ'));
    return { channels: p.channels, stages };
  }
  if (p.matrix && p.trc?.length === 3) {
    const inv = mat3Inv(p.matrix),
      fns = p.trc.map(compileInverseCurve);
    return {
      channels: 3,
      shaper: { matrix: p.matrix, curves: p.trc },
      stages: [
        (v) => {
          const x = v[0],
            y = v[1],
            z = v[2];
          v[0] = fns[0](inv[0] * x + inv[1] * y + inv[2] * z);
          v[1] = fns[1](inv[3] * x + inv[4] * y + inv[5] * z);
          v[2] = fns[2](inv[6] * x + inv[7] * y + inv[8] * z);
        },
      ],
    };
  }
  if (p.colorSpace === 'GRAY' && p.trc) {
    const fn = compileInverseCurve(p.trc[0]);
    if (p.pcs === 'Lab') {
      const lab = new Float64Array(3);
      return {
        channels: 1,
        stages: [
          (v) => {
            xyzToLab(v, D50, lab);
            v[0] = fn(clampUnit(lab[0] / 100));
          },
        ],
      };
    }
    return { channels: 1, stages: [(v) => void (v[0] = fn(clampUnit(v[1])))] };
  }
  if (p.colorSpace === 'Lab') return { channels: 3, stages: [pcsEncodeStage('Lab', 'v4')] };
  if (p.colorSpace === 'XYZ') return { channels: 3, stages: [pcsEncodeStage('XYZ', 'v4')] };
  throw new IccError(`Profile "${p.name}" cannot be used as a destination (no B2A tag).`);
}

export function hasOutputDirection(p: Profile): boolean {
  return p.b2a.some(Boolean) || !!p.trc || p.colorSpace === 'Lab' || p.colorSpace === 'XYZ';
}
