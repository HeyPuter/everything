/**
 * ICC profile reader (versions 2 and 4).
 *
 * parseProfile(bytes) returns the header fields and the tags the color
 * engine uses, decoded to plain numbers:
 *   XYZ            [[X, Y, Z], ...]
 *   curv / para    a curve { kind, eval(v) } on 0..1
 *   desc / mluc /
 *   text           text
 *   sf32           numbers (chromatic adaptation matrix)
 *   mft1 / mft2    { kind: 'lut', inputs, outputs, matrix, inCurves, clut, outCurves, bits }
 *   mAB / mBA      { kind: 'mAB' | 'mBA', inputs, outputs, A, clut, M, matrix, B }
 * Table values are normalized to 0..1 (a CLUT is a Float64Array, first
 * input channel varying slowest). Tags of other types are kept as
 * { kind: 'raw', type }. Shared tag data (several signatures pointing at
 * the same offset) is decoded once.
 */

export const COLOR_SPACE_CHANNELS = {
  'XYZ ': 3, 'Lab ': 3, 'Luv ': 3, YCbr: 3, 'Yxy ': 3, 'RGB ': 3, GRAY: 1, 'HSV ': 3, 'HLS ': 3, CMYK: 4, 'CMY ': 3,
  '2CLR': 2, '3CLR': 3, '4CLR': 4, '5CLR': 5, '6CLR': 6, '7CLR': 7, '8CLR': 8, '9CLR': 9, ACLR: 10, BCLR: 11, CCLR: 12, DCLR: 13, ECLR: 14, FCLR: 15,
};

export const CLASS_LABELS = { scnr: 'Input', mntr: 'Display', prtr: 'Output', link: 'Device Link', spac: 'Color Space', abst: 'Abstract', nmcl: 'Named Color' };

export class ICCError extends Error {}

const sig = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
const s15 = (dv, o) => dv.getInt32(o) / 65536;

/** A curve on 0..1. */
export function makeCurve(kind, data) {
  if (kind === 'identity') return { kind, eval: (v) => v };
  if (kind === 'gamma') {
    const g = data;
    return { kind, gamma: g, eval: (v) => (v <= 0 ? 0 : v ** g) };
  }
  if (kind === 'table') {
    const t = data;
    const n1 = t.length - 1;
    return {
      kind,
      table: t,
      eval: (v) => {
        if (!(v > 0)) return t[0];
        if (v >= 1) return t[n1];
        const p = v * n1;
        const i = Math.floor(p);
        return t[i] + (t[i + 1] - t[i]) * (p - i);
      },
    };
  }
  if (kind === 'para') {
    const { type, params: [g, a = 1, b = 0, c = 0, d = 0, e = 0, f = 0] } = data;
    const pw = (x) => (x <= 0 ? 0 : x ** g);
    const fns = [
      (x) => pw(x),
      (x) => (x >= -b / a ? pw(a * x + b) : 0),
      (x) => (x >= -b / a ? pw(a * x + b) + c : c),
      (x) => (x >= d ? pw(a * x + b) : c * x),
      (x) => (x >= d ? pw(a * x + b) + e : c * x + f),
    ];
    const fn = fns[type] || fns[0];
    return { kind, type, params: data.params, eval: (v) => fn(v) };
  }
  throw new ICCError(`Unknown curve kind ${kind}`);
}

/** Read a curv or para at offset o; returns { curve, size } (size in bytes, for curve sequences). */
function readCurve(dv, o, end) {
  const type = sig(dv, o);
  if (type === 'curv') {
    const n = dv.getUint32(o + 8);
    if (o + 12 + n * 2 > end) throw new ICCError('Curve out of range');
    let curve;
    if (n === 0) curve = makeCurve('identity');
    else if (n === 1) curve = makeCurve('gamma', dv.getUint16(o + 12) / 256);
    else {
      const t = new Float64Array(n);
      for (let i = 0; i < n; i++) t[i] = dv.getUint16(o + 12 + i * 2) / 65535;
      curve = makeCurve('table', t);
    }
    return { curve, size: 12 + n * 2 };
  }
  if (type === 'para') {
    const fnType = dv.getUint16(o + 8);
    const count = [1, 3, 4, 5, 7][fnType];
    if (count == null) throw new ICCError('Unknown parametric curve');
    if (o + 12 + count * 4 > end) throw new ICCError('Curve out of range');
    const params = [];
    for (let i = 0; i < count; i++) params.push(s15(dv, o + 12 + i * 4));
    return { curve: makeCurve('para', { type: fnType, params }), size: 12 + count * 4 };
  }
  throw new ICCError(`Not a curve: ${type}`);
}

function readCurves(dv, o, n, end) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const { curve, size } = readCurve(dv, o, end);
    out.push(curve);
    o += (size + 3) & ~3;
  }
  return out;
}

function readClut(dv, o, inputs, outputs, grid, bytes, end) {
  let total = outputs;
  for (const g of grid) {
    if (g < 2 && inputs > 0) throw new ICCError('Bad lookup table grid');
    total *= g;
  }
  if (o + total * bytes > end) throw new ICCError('Lookup table out of range');
  const data = new Float64Array(total);
  if (bytes === 1) for (let i = 0; i < total; i++) data[i] = dv.getUint8(o + i) / 255;
  else for (let i = 0; i < total; i++) data[i] = dv.getUint16(o + i * 2) / 65535;
  return { grid: grid.slice(), inputs, outputs, data };
}

function readText(dv, o, size, type) {
  if (type === 'text') {
    let s = '';
    for (let i = 8; i < size; i++) {
      const c = dv.getUint8(o + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  if (type === 'desc') {
    const n = dv.getUint32(o + 8);
    let s = '';
    for (let i = 0; i < n && 12 + i < size; i++) {
      const c = dv.getUint8(o + 12 + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  if (type === 'mluc') {
    const count = dv.getUint32(o + 8);
    const recSize = dv.getUint32(o + 12) || 12;
    let pick = null;
    for (let i = 0; i < count; i++) {
      const r = o + 16 + i * recSize;
      if (r + 12 > o + size) break;
      const lang = String.fromCharCode(dv.getUint8(r), dv.getUint8(r + 1));
      const rec = { lang, len: dv.getUint32(r + 4), off: dv.getUint32(r + 8) };
      if (!pick || (lang === 'en' && pick.lang !== 'en')) pick = rec;
    }
    if (!pick) return '';
    let s = '';
    for (let i = 0; i + 1 < pick.len && pick.off + i + 1 < size; i += 2) {
      const c = dv.getUint16(o + pick.off + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  return '';
}

function readLut(dv, o, end, type) {
  const inputs = dv.getUint8(o + 8);
  const outputs = dv.getUint8(o + 9);
  const gridPoints = dv.getUint8(o + 10);
  if (!inputs || !outputs || inputs > 15 || outputs > 15) throw new ICCError('Bad lookup table');
  const matrix = [];
  for (let i = 0; i < 9; i++) matrix.push(s15(dv, o + 12 + i * 4));
  const identity = matrix.every((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) < 1e-6);
  const lut16 = type === 'mft2';
  const inEntries = lut16 ? dv.getUint16(o + 48) : 256;
  const outEntries = lut16 ? dv.getUint16(o + 50) : 256;
  let p = o + (lut16 ? 52 : 48);
  const bytes = lut16 ? 2 : 1;
  const table = (n) => {
    if (p + n * bytes > end) throw new ICCError('Lookup table out of range');
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = lut16 ? dv.getUint16(p + i * 2) / 65535 : dv.getUint8(p + i) / 255;
    p += n * bytes;
    return makeCurve('table', t);
  };
  const inCurves = [];
  for (let i = 0; i < inputs; i++) inCurves.push(table(inEntries));
  const clut = readClut(dv, p, inputs, outputs, new Array(inputs).fill(gridPoints), bytes, end);
  p += clut.data.length * bytes;
  const outCurves = [];
  for (let i = 0; i < outputs; i++) outCurves.push(table(outEntries));
  return { kind: 'lut', bits: lut16 ? 16 : 8, inputs, outputs, matrix: identity ? null : matrix, inCurves, clut, outCurves };
}

function readLutAB(dv, o, end, type) {
  const inputs = dv.getUint8(o + 8);
  const outputs = dv.getUint8(o + 9);
  if (!inputs || !outputs || inputs > 15 || outputs > 15) throw new ICCError('Bad lookup table');
  const offB = dv.getUint32(o + 12);
  const offMatrix = dv.getUint32(o + 16);
  const offM = dv.getUint32(o + 20);
  const offClut = dv.getUint32(o + 24);
  const offA = dv.getUint32(o + 28);
  const atoB = type === 'mAB ';
  // A curves sit on the device side, B curves on the PCS side.
  const aCount = atoB ? inputs : outputs;
  const bCount = atoB ? outputs : inputs;
  if ((offM || offMatrix) && bCount !== 3) throw new ICCError('Bad lookup table');
  const out = { kind: atoB ? 'mAB' : 'mBA', inputs, outputs, A: null, clut: null, M: null, matrix: null, B: null };
  if (offB) out.B = readCurves(dv, o + offB, bCount, end);
  if (offM) out.M = readCurves(dv, o + offM, 3, end);
  if (offA) out.A = readCurves(dv, o + offA, aCount, end);
  if (offMatrix) {
    const m = [];
    for (let i = 0; i < 12; i++) m.push(s15(dv, o + offMatrix + i * 4));
    out.matrix = { m: m.slice(0, 9), offset: m.slice(9, 12) };
  }
  if (offClut) {
    // The table maps every input channel to every output channel in both directions.
    const c = o + offClut;
    const grid = [];
    for (let i = 0; i < inputs; i++) grid.push(dv.getUint8(c + i));
    const precision = dv.getUint8(c + 16);
    out.clut = readClut(dv, c + 20, inputs, outputs, grid, precision === 1 ? 1 : 2, end);
  }
  if (!out.B) throw new ICCError('Lookup table without B curves');
  return out;
}

function readTag(dv, o, size, total) {
  if (o < 128 || o + size > total || size < 8) throw new ICCError('Tag out of range');
  const type = sig(dv, o);
  const end = o + size;
  switch (type) {
    case 'XYZ ': {
      const values = [];
      for (let p = o + 8; p + 12 <= end; p += 12) values.push([s15(dv, p), s15(dv, p + 4), s15(dv, p + 8)]);
      return { kind: 'XYZ', values };
    }
    case 'curv':
    case 'para':
      return { kind: 'curve', curve: readCurve(dv, o, end).curve };
    case 'desc':
    case 'mluc':
    case 'text':
      return { kind: 'text', text: readText(dv, o, size, type).trim() };
    case 'sf32': {
      const values = [];
      for (let p = o + 8; p + 4 <= end; p += 4) values.push(s15(dv, p));
      return { kind: 'sf32', values };
    }
    case 'mft1':
    case 'mft2':
      return readLut(dv, o, end, type);
    case 'mAB ':
    case 'mBA ':
      return readLutAB(dv, o, end, type);
    default:
      return { kind: 'raw', type };
  }
}

/** Hex of the 16-byte profile ID (zeros when not computed). */
function profileIdHex(dv) {
  let s = '';
  for (let i = 84; i < 100; i++) s += dv.getUint8(i).toString(16).padStart(2, '0');
  return /^0+$/.test(s) ? '' : s;
}

/** Parse ICC profile bytes (Uint8Array or ArrayBuffer). Throws ICCError when the data is not a usable profile. */
export function parseProfile(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 132) throw new ICCError('This file is too small to be a color profile.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (sig(dv, 36) !== 'acsp') throw new ICCError('This file is not an ICC color profile.');
  const declared = dv.getUint32(0);
  const total = Math.min(bytes.length, declared || bytes.length);
  const major = dv.getUint8(8);
  const minor = dv.getUint8(9) >> 4;
  const bugfix = dv.getUint8(9) & 15;
  const colorSpace = sig(dv, 16);
  const pcs = sig(dv, 20);
  const p = {
    bytes: bytes.subarray(0, total),
    size: total,
    version: { major, minor, bugfix, text: `${major}.${minor}${bugfix ? `.${bugfix}` : ''}` },
    deviceClass: sig(dv, 12),
    colorSpace,
    pcs,
    channels: COLOR_SPACE_CHANNELS[colorSpace] || 0,
    intent: dv.getUint32(64) & 3,
    illuminant: [s15(dv, 68), s15(dv, 72), s15(dv, 76)],
    creator: sig(dv, 80),
    id: profileIdHex(dv),
    tags: new Map(),
  };
  if (!p.channels) throw new ICCError(`Unsupported color space “${colorSpace.trim()}”.`);
  const count = dv.getUint32(128);
  if (count > 1000 || 132 + count * 12 > total) throw new ICCError('The profile’s tag table is damaged.');
  const shared = new Map();
  for (let i = 0; i < count; i++) {
    const e = 132 + i * 12;
    const tag = sig(dv, e);
    const off = dv.getUint32(e + 4);
    const size = dv.getUint32(e + 8);
    const key = `${off}:${size}`;
    try {
      if (!shared.has(key)) shared.set(key, readTag(dv, off, size, total));
      p.tags.set(tag, shared.get(key));
    } catch (err) {
      // A damaged optional tag is skipped; required ones are checked by the engine.
      p.tags.set(tag, { kind: 'bad', error: String(err?.message || err) });
    }
  }
  const text = (t) => (p.tags.get(t)?.kind === 'text' ? p.tags.get(t).text : '');
  p.description = text('desc') || 'Unnamed profile';
  p.copyright = text('cprt');
  const xyz = (t) => (p.tags.get(t)?.kind === 'XYZ' ? p.tags.get(t).values[0] : null);
  p.whitePoint = xyz('wtpt');
  p.blackPoint = xyz('bkpt');
  return p;
}

/** Short summary for lists: { name, kind ('RGB' | 'CMYK' | 'Gray' | 'Lab' | ...), classLabel, version }. */
export function profileSummary(p) {
  const kind = { 'RGB ': 'RGB', CMYK: 'CMYK', GRAY: 'Gray', 'Lab ': 'Lab', 'XYZ ': 'XYZ', 'CMY ': 'CMY' }[p.colorSpace] || p.colorSpace.trim();
  return { name: p.description, kind, classLabel: CLASS_LABELS[p.deviceClass] || p.deviceClass, version: p.version.text };
}
