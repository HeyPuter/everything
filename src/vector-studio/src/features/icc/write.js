/**
 * ICC profile writer (versions 2 and 4): the inverse of parse.js, used to
 * generate the built-in profiles (for embedding in PDF files and for
 * saving as .icc files) and to build profiles in tests.
 *
 * writeProfile({ version: 2 | 4, deviceClass, colorSpace, pcs, intent?,
 *   tags: [[signature, tag], ...] }) -> Uint8Array
 * Tags use the shapes parse.js returns:
 *   { kind: 'text', text }                         desc/cprt (desc + text in v2, mluc in v4)
 *   { kind: 'XYZ', values: [[X, Y, Z]] }
 *   { kind: 'curve', curve: { kind: 'identity' | 'gamma' | 'table' | 'para', ... } }
 *   { kind: 'sf32', values }
 *   { kind: 'lut', bits: 8 | 16, inputs, outputs, matrix?, inCurves, clut, outCurves }
 *   { kind: 'mAB' | 'mBA', inputs, outputs, A?, clut?, M?, matrix?, B }
 * Identical tag data is stored once and shared.
 */

class Buf {
  constructor() {
    this.bytes = [];
  }

  u8(v) {
    this.bytes.push(v & 255);
  }

  u16(v) {
    v = Math.max(0, Math.min(65535, Math.round(v)));
    this.bytes.push((v >> 8) & 255, v & 255);
  }

  u32(v) {
    v >>>= 0;
    this.bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  }

  s15(v) {
    this.u32(Math.round(v * 65536) | 0);
  }

  sig(s) {
    for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i) || 32);
  }

  zeros(n) {
    for (let i = 0; i < n; i++) this.bytes.push(0);
  }

  pad4() {
    while (this.bytes.length % 4) this.bytes.push(0);
  }

  get length() {
    return this.bytes.length;
  }

  out() {
    return Uint8Array.from(this.bytes);
  }
}

const u16of = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
const u8of = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

function writeCurve(b, c) {
  if (c.kind === 'para') {
    b.sig('para');
    b.u32(0);
    b.u16(c.type);
    b.u16(0);
    for (const p of c.params) b.s15(p);
    return;
  }
  b.sig('curv');
  b.u32(0);
  if (c.kind === 'identity') b.u32(0);
  else if (c.kind === 'gamma') {
    b.u32(1);
    b.u16(Math.round(c.gamma * 256));
  } else {
    b.u32(c.table.length);
    for (const v of c.table) b.u16(u16of(v));
  }
}

function writeCurves(b, curves) {
  for (const c of curves) {
    writeCurve(b, c);
    b.pad4();
  }
}

/** Sample a curve into n table entries. */
function curveTable(c, n) {
  if (c.kind === 'table' && c.table.length === n) return c.table;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = c.eval ? c.eval(i / (n - 1)) : i / (n - 1);
  return t;
}

function encodeTag(tag, version, sigName) {
  const b = new Buf();
  switch (tag.kind) {
    case 'text': {
      const text = String(tag.text || '');
      if (version >= 4) {
        b.sig('mluc');
        b.u32(0);
        b.u32(1);
        b.u32(12);
        b.sig('enUS');
        b.u32(text.length * 2);
        b.u32(28);
        for (const ch of text) b.u16(ch.charCodeAt(0));
      } else if (sigName === 'desc') {
        const ascii = text.replace(/[^\x20-\x7e]/g, '?');
        b.sig('desc');
        b.u32(0);
        b.u32(ascii.length + 1);
        for (const ch of ascii) b.u8(ch.charCodeAt(0));
        b.u8(0);
        b.u32(0);
        b.u32(0);
        b.u16(0);
        b.u8(0);
        b.zeros(67);
      } else {
        b.sig('text');
        b.u32(0);
        for (const ch of text.replace(/[^\x20-\x7e]/g, '?')) b.u8(ch.charCodeAt(0));
        b.u8(0);
      }
      break;
    }
    case 'XYZ':
      b.sig('XYZ ');
      b.u32(0);
      for (const v of tag.values) for (const x of v) b.s15(x);
      break;
    case 'curve':
      writeCurve(b, tag.curve);
      break;
    case 'sf32':
      b.sig('sf32');
      b.u32(0);
      for (const v of tag.values) b.s15(v);
      break;
    case 'lut': {
      const lut16 = tag.bits !== 8;
      b.sig(lut16 ? 'mft2' : 'mft1');
      b.u32(0);
      b.u8(tag.inputs);
      b.u8(tag.outputs);
      b.u8(tag.clut.grid[0]);
      b.u8(0);
      const m = tag.matrix || [1, 0, 0, 0, 1, 0, 0, 0, 1];
      for (const v of m) b.s15(v);
      const inN = lut16 ? Math.max(2, tag.inCurves[0]?.table?.length || 256) : 256;
      const outN = lut16 ? Math.max(2, tag.outCurves[0]?.table?.length || 256) : 256;
      if (lut16) {
        b.u16(inN);
        b.u16(outN);
      }
      const put = lut16 ? (v) => b.u16(u16of(v)) : (v) => b.u8(u8of(v));
      for (const c of tag.inCurves) for (const v of curveTable(c, inN)) put(v);
      for (const v of tag.clut.data) put(v);
      for (const c of tag.outCurves) for (const v of curveTable(c, outN)) put(v);
      break;
    }
    case 'mAB':
    case 'mBA': {
      b.sig(tag.kind === 'mAB' ? 'mAB ' : 'mBA ');
      b.u32(0);
      b.u8(tag.inputs);
      b.u8(tag.outputs);
      b.u16(0);
      const offsets = b.length;
      b.zeros(20);
      const at = {};
      const mark = (k) => {
        b.pad4();
        at[k] = b.length;
      };
      // Element order on disk: B, matrix, M, CLUT, A (any order is valid; offsets locate them).
      mark('B');
      writeCurves(b, tag.B);
      if (tag.matrix) {
        mark('matrix');
        for (const v of tag.matrix.m) b.s15(v);
        for (const v of tag.matrix.offset || [0, 0, 0]) b.s15(v);
      }
      if (tag.M) {
        mark('M');
        writeCurves(b, tag.M);
      }
      if (tag.clut) {
        mark('clut');
        for (let i = 0; i < 16; i++) b.u8(tag.clut.grid[i] || 0);
        const bytes = tag.clut.precision === 1 ? 1 : 2;
        b.u8(bytes);
        b.zeros(3);
        for (const v of tag.clut.data) (bytes === 1 ? b.u8(u8of(v)) : b.u16(u16of(v)));
      }
      if (tag.A) {
        mark('A');
        writeCurves(b, tag.A);
      }
      const put32 = (o, v) => {
        b.bytes[o] = (v >>> 24) & 255;
        b.bytes[o + 1] = (v >>> 16) & 255;
        b.bytes[o + 2] = (v >>> 8) & 255;
        b.bytes[o + 3] = v & 255;
      };
      put32(offsets, at.B || 0);
      put32(offsets + 4, at.matrix || 0);
      put32(offsets + 8, at.M || 0);
      put32(offsets + 12, at.clut || 0);
      put32(offsets + 16, at.A || 0);
      break;
    }
    default:
      throw new Error(`Cannot write tag kind ${tag.kind}`);
  }
  return b.out();
}

const keyOf = (bytes) => {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619);
  return `${bytes.length}:${h >>> 0}`;
};

/** Build a profile. `date` defaults to now (fixed dates keep generated profiles byte-stable). */
export function writeProfile({ version = 2, deviceClass, colorSpace, pcs = 'XYZ ', intent = 0, tags, date = null, creator = 'vsTd' }) {
  const encoded = tags.map(([s, t]) => [s, encodeTag(t, version, s)]);
  const b = new Buf();
  b.zeros(128);
  b.u32(encoded.length);
  const tableAt = b.length;
  b.zeros(encoded.length * 12);
  const placed = new Map();
  const entries = [];
  for (const [s, bytes] of encoded) {
    const k = keyOf(bytes);
    let at = placed.get(k);
    if (!at || !sameBytes(b, at, bytes)) {
      b.pad4();
      at = { off: b.length, size: bytes.length };
      for (const x of bytes) b.u8(x);
      placed.set(k, at);
    }
    entries.push([s, at]);
  }
  b.pad4();
  const out = b.out();
  const dv = new DataView(out.buffer);
  const setSig = (o, s) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i) || 32;
  };
  dv.setUint32(0, out.length);
  dv.setUint32(8, version >= 4 ? 0x04300000 : 0x02100000);
  setSig(12, deviceClass);
  setSig(16, colorSpace);
  setSig(20, pcs);
  const d = date || new Date();
  [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].forEach((v, i) => dv.setUint16(24 + i * 2, v));
  setSig(36, 'acsp');
  dv.setUint32(64, intent);
  dv.setInt32(68, Math.round(0.9642 * 65536));
  dv.setInt32(72, 65536);
  dv.setInt32(76, Math.round(0.8249 * 65536));
  setSig(80, creator);
  entries.forEach(([s, at], i) => {
    const e = tableAt + i * 12;
    setSig(e, s);
    dv.setUint32(e + 4, at.off);
    dv.setUint32(e + 8, at.size);
  });
  return out;
}

function sameBytes(b, at, bytes) {
  if (at.size !== bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (b.bytes[at.off + i] !== bytes[i]) return false;
  return true;
}

/** A CLUT sampled from fn(inputs[]) -> outputs[] on a grid of n points per input. */
export function sampleClut(inputs, outputs, n, fn) {
  const grid = new Array(inputs).fill(n);
  const total = n ** inputs;
  const data = new Float64Array(total * outputs);
  const x = new Array(inputs).fill(0);
  for (let i = 0; i < total; i++) {
    let r = i;
    for (let k = inputs - 1; k >= 0; k--) {
      x[k] = (r % n) / (n - 1);
      r = Math.floor(r / n);
    }
    const y = fn(x);
    for (let o = 0; o < outputs; o++) data[i * outputs + o] = Math.max(0, Math.min(1, y[o]));
  }
  return { grid, inputs, outputs, data };
}

export const identityCurve = Object.freeze({ kind: 'identity', eval: (v) => v });
