/**
 * JBIG2 decoding (ITU-T T.88) for embedded streams as PDF stores them
 * (segments without the file header, with optional global segments):
 * generic regions (arithmetic templates 0-3 with typical prediction, and
 * MMR), generic refinement regions, symbol dictionaries and text regions
 * (arithmetic and Huffman coded, with refinement and aggregation), pattern
 * dictionaries and halftone regions, custom Huffman tables and striped
 * pages.
 *
 *   decodeJBIG2(bytes, globals?) -> { width, height, data: Uint8Array }
 *
 * `data` is one byte per pixel, 1 for black.
 */
import { MQDecoder } from './mq.js';
import { decodeCCITT } from './ccitt.js';

export class JBIG2Error extends Error {}

// ---------------------------------------------------------------- bitmaps

class Bitmap {
  constructor(w, h, fill = 0) {
    this.w = w;
    this.h = h;
    this.d = new Uint8Array(Math.max(0, w * h));
    if (fill) this.d.fill(1);
  }

  get(x, y) {
    return x >= 0 && x < this.w && y >= 0 && y < this.h ? this.d[y * this.w + x] : 0;
  }

  /** Combine `src` at (x, y) with operator 0 OR, 1 AND, 2 XOR, 3 XNOR, 4 REPLACE. */
  compose(src, x, y, op) {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.w, x + src.w);
    const y1 = Math.min(this.h, y + src.h);
    for (let yy = y0; yy < y1; yy++) {
      const so = (yy - y) * src.w - x;
      const dO = yy * this.w;
      for (let xx = x0; xx < x1; xx++) {
        const s = src.d[so + xx];
        const i = dO + xx;
        const t = this.d[i];
        this.d[i] = op === 0 ? t | s : op === 1 ? t & s : op === 2 ? t ^ s : op === 3 ? 1 - (t ^ s) : s;
      }
    }
  }

  grow(h, fill) {
    if (h <= this.h) return;
    const d = new Uint8Array(this.w * h);
    if (fill) d.fill(1);
    d.set(this.d);
    this.d = d;
    this.h = h;
  }

  sub(x, w) {
    const out = new Bitmap(w, this.h);
    for (let y = 0; y < this.h; y++) out.d.set(this.d.subarray(y * this.w + x, y * this.w + x + w), y * w);
    return out;
  }
}

// ---------------------------------------------------------------- arithmetic decoding

/** Arithmetic decoding state for one region or dictionary: the MQ decoder and its context sets. */
class ArithState {
  constructor(data, start, end) {
    this.mq = new MQDecoder(data, start, end);
    this.ia = new Map();
  }

  contexts(name, size) {
    let c = this.ia.get(name);
    if (!c) {
      c = new Uint8Array(size);
      this.ia.set(name, c);
    }
    return c;
  }

  /** Integer decoding (Annex A.2); null for OOB. */
  int(name) {
    const cx = this.contexts(name, 512);
    const mq = this.mq;
    let prev = 1;
    const bit = () => {
      const d = mq.decode(cx, prev);
      prev = prev < 256 ? (prev << 1) | d : (((prev << 1) | d) & 511) | 256;
      return d;
    };
    const bits = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 2 + bit();
      return v;
    };
    const s = bit();
    let v;
    if (!bit()) v = bits(2);
    else if (!bit()) v = bits(4) + 4;
    else if (!bit()) v = bits(6) + 20;
    else if (!bit()) v = bits(8) + 84;
    else if (!bit()) v = bits(12) + 340;
    else v = bits(32) + 4436;
    if (s && v === 0) return null;
    return s ? -v : v;
  }

  /** Symbol ID decoding (Annex A.3). */
  id(codeLen) {
    const cx = this.contexts(`IAID${codeLen}`, 1 << (codeLen + 1));
    let prev = 1;
    for (let i = 0; i < codeLen; i++) prev = (prev << 1) | this.mq.decode(cx, prev);
    return prev - (1 << codeLen);
  }
}

// ---------------------------------------------------------------- generic regions

const SLTP = [0x9b25, 0x0795, 0x00e5, 0x0195];
const DEFAULT_AT = [[3, -1, -3, -1, 2, -2, -2, -2], [3, -1], [2, -1], [2, -1]];

/** Generic region decoding with the arithmetic coder (6.2.5). */
function genericArith(st, w, h, template, tpgdon, at, cxName = 'GB') {
  const bm = new Bitmap(w, h);
  const cx = st.contexts(cxName, 1 << 16);
  const mq = st.mq;
  const d = bm.d;
  const ctx = genericContextFn(bm, template, at);
  // The default adaptive pixels allow a faster context that reads the rows directly.
  const fast = template === 0 && at[0] === 3 && at[1] === -1 && at[2] === -3 && at[3] === -1 && at[4] === 2 && at[5] === -2 && at[6] === -2 && at[7] === -2;
  let ltp = 0;
  for (let y = 0; y < h; y++) {
    if (tpgdon) {
      ltp ^= mq.decode(cx, SLTP[template]);
      if (ltp) {
        if (y > 0) d.copyWithin(y * w, (y - 1) * w, y * w);
        continue;
      }
    }
    const o = y * w;
    if (!fast) {
      for (let x = 0; x < w; x++) d[o + x] = mq.decode(cx, ctx(x, y));
      continue;
    }
    const r1 = o - w;
    const r2 = o - 2 * w;
    const has1 = y >= 1;
    const has2 = y >= 2;
    const a = (row, ok, xx) => (ok && xx >= 0 && xx < w ? d[row + xx] : 0);
    for (let x = 0; x < w; x++) {
      const c =
        (x > 0 ? d[o + x - 1] : 0) |
        ((x > 1 ? d[o + x - 2] : 0) << 1) |
        ((x > 2 ? d[o + x - 3] : 0) << 2) |
        ((x > 3 ? d[o + x - 4] : 0) << 3) |
        (a(r1, has1, x + 3) << 4) |
        (a(r1, has1, x + 2) << 5) |
        (a(r1, has1, x + 1) << 6) |
        (a(r1, has1, x) << 7) |
        (a(r1, has1, x - 1) << 8) |
        (a(r1, has1, x - 2) << 9) |
        (a(r1, has1, x - 3) << 10) |
        (a(r2, has2, x + 2) << 11) |
        (a(r2, has2, x + 1) << 12) |
        (a(r2, has2, x) << 13) |
        (a(r2, has2, x - 1) << 14) |
        (a(r2, has2, x - 2) << 15);
      d[o + x] = mq.decode(cx, c);
    }
  }
  return bm;
}

/** MMR-coded bitmap (T.6 without end-of-block requirements); 1 = black. */
function genericMMR(data, start, end, w, h) {
  const r = decodeCCITT(data.subarray(start, end), { K: -1, columns: w, rows: h, blackIs1: true, endOfBlock: true });
  const bm = new Bitmap(w, h);
  const rb = (w + 7) >> 3;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bm.d[y * w + x] = (r.data[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1;
  bm.consumed = r.consumed;
  return bm;
}

// ---------------------------------------------------------------- refinement

/** Generic refinement region decoding (6.3.5). */
function refinement(st, w, h, template, ref, dx, dy, tpgron, at) {
  const bm = new Bitmap(w, h);
  const cx = st.contexts('GR', 1 << 13);
  const mq = st.mq;
  const d = bm.d;
  const g = (x, y) => (x >= 0 && x < w && y >= 0 && y < h ? d[y * w + x] : 0);
  const r = (x, y) => ref.get(x - dx, y - dy);
  const [g1x, g1y, g2x, g2y] = at;
  const ctx = (x, y) => {
    if (template === 0) {
      return g(x - 1, y) | (g(x + 1, y - 1) << 1) | (g(x, y - 1) << 2) | (g(x + g1x, y + g1y) << 3) | (r(x + 1, y + 1) << 4) | (r(x, y + 1) << 5) | (r(x - 1, y + 1) << 6) | (r(x + 1, y) << 7) | (r(x, y) << 8) | (r(x - 1, y) << 9) | (r(x + 1, y - 1) << 10) | (r(x, y - 1) << 11) | (r(x + g2x, y + g2y) << 12);
    }
    return g(x - 1, y) | (g(x + 1, y - 1) << 1) | (g(x, y - 1) << 2) | (g(x - 1, y - 1) << 3) | (r(x + 1, y + 1) << 4) | (r(x, y + 1) << 5) | (r(x + 1, y) << 6) | (r(x, y) << 7) | (r(x - 1, y) << 8) | (r(x, y - 1) << 9);
  };
  let ltp = 0;
  for (let y = 0; y < h; y++) {
    if (tpgron) ltp ^= mq.decode(cx, template === 0 ? 0x0010 : 0x0008);
    for (let x = 0; x < w; x++) {
      if (ltp) {
        // Typical prediction: a pixel whose 3x3 reference neighborhood is uniform takes its value.
        const v = r(x, y);
        let uniform = true;
        for (let yy = -1; yy <= 1 && uniform; yy++) for (let xx = -1; xx <= 1 && uniform; xx++) uniform = r(x + xx, y + yy) === v;
        if (uniform) {
          d[y * w + x] = v;
          continue;
        }
      }
      d[y * w + x] = mq.decode(cx, ctx(x, y));
    }
  }
  return bm;
}

// ---------------------------------------------------------------- Huffman tables

/** Standard tables B.1-B.15: lines [prefLen, rangeLen, rangeLow], then 'L' (lower), 'U' (upper) and 'O' (OOB) lines. */
const STANDARD = {
  1: [[1, 4, 0], [2, 8, 16], [3, 16, 272], ['U', 3, 65808]],
  2: [[1, 0, 0], [2, 0, 1], [3, 0, 2], [4, 3, 3], [5, 6, 11], ['U', 6, 75], ['O', 6]],
  3: [[8, 8, -256], [1, 0, 0], [2, 0, 1], [3, 0, 2], [4, 3, 3], [5, 6, 11], ['L', 8, -257], ['U', 7, 75], ['O', 6]],
  4: [[1, 0, 1], [2, 0, 2], [3, 0, 3], [4, 3, 4], [5, 6, 12], ['U', 5, 76]],
  5: [[7, 8, -255], [1, 0, 1], [2, 0, 2], [3, 0, 3], [4, 3, 4], [5, 6, 12], ['L', 7, -256], ['U', 6, 76]],
  6: [[5, 10, -2048], [4, 9, -1024], [4, 8, -512], [4, 7, -256], [5, 6, -128], [5, 5, -64], [4, 5, -32], [2, 7, 0], [3, 7, 128], [3, 8, 256], [4, 9, 512], [4, 10, 1024], ['L', 6, -2049], ['U', 6, 2048]],
  7: [[4, 9, -1024], [3, 8, -512], [4, 7, -256], [5, 6, -128], [5, 5, -64], [4, 5, -32], [4, 5, 0], [5, 5, 32], [5, 6, 64], [4, 7, 128], [3, 8, 256], [3, 9, 512], [3, 10, 1024], ['L', 5, -1025], ['U', 5, 2048]],
  8: [[8, 3, -15], [9, 1, -7], [8, 1, -5], [9, 0, -3], [7, 0, -2], [4, 0, -1], [2, 1, 0], [5, 0, 2], [6, 0, 3], [3, 4, 4], [6, 1, 20], [4, 4, 22], [4, 5, 38], [5, 6, 70], [5, 7, 134], [6, 7, 262], [7, 8, 390], [6, 10, 646], ['L', 9, -16], ['U', 9, 1670], ['O', 2]],
  9: [[8, 4, -31], [9, 2, -15], [8, 2, -11], [9, 1, -7], [7, 1, -5], [4, 1, -3], [3, 1, -1], [3, 1, 1], [5, 1, 3], [6, 1, 5], [3, 5, 7], [6, 2, 39], [4, 5, 43], [4, 6, 75], [5, 7, 139], [5, 8, 267], [6, 8, 523], [7, 9, 779], [6, 11, 1291], ['L', 9, -32], ['U', 9, 3339], ['O', 2]],
  10: [[7, 4, -21], [8, 0, -5], [7, 0, -4], [5, 0, -3], [2, 2, -2], [5, 0, 2], [6, 0, 3], [7, 0, 4], [8, 0, 5], [2, 6, 6], [5, 5, 70], [6, 5, 102], [6, 6, 134], [6, 7, 198], [6, 8, 326], [6, 9, 582], [6, 10, 1094], [7, 11, 2118], ['L', 8, -22], ['U', 8, 4166], ['O', 2]],
  11: [[1, 0, 1], [2, 1, 2], [4, 0, 4], [4, 1, 5], [5, 1, 7], [5, 2, 9], [6, 2, 13], [7, 2, 17], [7, 3, 21], [7, 4, 29], [7, 5, 45], [7, 6, 77], ['U', 7, 141]],
  12: [[1, 0, 1], [2, 0, 2], [3, 1, 3], [5, 0, 5], [5, 1, 6], [6, 1, 8], [7, 0, 10], [7, 1, 11], [7, 2, 13], [7, 3, 17], [7, 4, 25], [8, 5, 41], ['U', 8, 73]],
  13: [[1, 0, 1], [3, 0, 2], [4, 0, 3], [5, 0, 4], [4, 1, 5], [3, 3, 7], [6, 1, 15], [6, 2, 17], [6, 3, 21], [6, 4, 29], [6, 5, 45], [7, 6, 77], ['U', 7, 141]],
  14: [[3, 0, -2], [3, 0, -1], [1, 0, 0], [3, 0, 1], [3, 0, 2]],
  15: [[7, 4, -24], [6, 2, -8], [5, 1, -4], [4, 0, -2], [3, 0, -1], [1, 0, 0], [3, 0, 1], [4, 0, 2], [5, 1, 3], [6, 2, 5], [7, 4, 9], ['L', 7, -25], ['U', 7, 25]],
};

/** A Huffman table from lines { prefLen, rangeLen, rangeLow, kind: ''|'L'|'U'|'O' } with canonical codes (B.3). */
export function huffmanTable(lines) {
  const maxLen = Math.max(0, ...lines.map((l) => l.prefLen));
  const count = new Array(maxLen + 1).fill(0);
  for (const l of lines) if (l.prefLen) count[l.prefLen]++;
  const first = new Array(maxLen + 2).fill(0);
  count[0] = 0;
  for (let len = 1; len <= maxLen; len++) first[len] = (first[len - 1] + count[len - 1]) << 1;
  const next = first.slice();
  // Codes keyed by length then code.
  const byLen = new Map();
  for (const l of lines) {
    if (!l.prefLen) continue;
    const code = next[l.prefLen]++;
    if (!byLen.has(l.prefLen)) byLen.set(l.prefLen, new Map());
    byLen.get(l.prefLen).set(code, l);
  }
  return { byLen, maxLen };
}

const standardCache = new Map();
function standardTable(n) {
  let t = standardCache.get(n);
  if (!t) {
    const lines = STANDARD[n].map((l) => (typeof l[0] === 'string' ? { kind: l[0], prefLen: l[1], rangeLen: l[0] === 'O' ? 0 : 32, rangeLow: l[2] ?? 0 } : { kind: '', prefLen: l[0], rangeLen: l[1], rangeLow: l[2] }));
    t = huffmanTable(lines);
    standardCache.set(n, t);
  }
  return t;
}

/** MSB-first bit reader for Huffman-coded data. */
class Bits {
  constructor(data, start, end) {
    this.data = data;
    this.pos = start * 8;
    this.end = end * 8;
  }

  bit() {
    if (this.pos >= this.end) throw new JBIG2Error('Unexpected end of data');
    const b = (this.data[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }

  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  align() {
    this.pos = (this.pos + 7) & ~7;
  }

  get byte() {
    return this.pos >> 3;
  }

  /** A value from a Huffman table; null for OOB. */
  huff(t) {
    let code = 0;
    for (let len = 1; len <= t.maxLen; len++) {
      code = (code << 1) | this.bit();
      const l = t.byLen.get(len)?.get(code);
      if (!l) continue;
      if (l.kind === 'O') return null;
      const off = l.rangeLen ? this.bits(l.rangeLen) : 0;
      return l.kind === 'L' ? l.rangeLow - off : l.rangeLow + off;
    }
    throw new JBIG2Error('Bad Huffman code');
  }
}

/** A custom table segment (7.4.13). */
function readTableSegment(data, start, end) {
  const flags = data[start];
  const oob = flags & 1;
  const ps = ((flags >> 1) & 7) + 1;
  const rs = ((flags >> 4) & 7) + 1;
  const low = i32(data, start + 1);
  const high = i32(data, start + 5);
  const b = new Bits(data, start + 9, end);
  const lines = [];
  let cur = low;
  while (cur < high) {
    const prefLen = b.bits(ps);
    const rangeLen = b.bits(rs);
    lines.push({ kind: '', prefLen, rangeLen, rangeLow: cur });
    cur += 2 ** rangeLen;
  }
  lines.push({ kind: 'L', prefLen: b.bits(ps), rangeLen: 32, rangeLow: low - 1 });
  lines.push({ kind: 'U', prefLen: b.bits(ps), rangeLen: 32, rangeLow: high });
  if (oob) lines.push({ kind: 'O', prefLen: b.bits(ps), rangeLen: 0, rangeLow: 0 });
  return huffmanTable(lines);
}

// ---------------------------------------------------------------- byte helpers

const u32 = (d, p) => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
const i32 = (d, p) => (d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
const u16 = (d, p) => (d[p] << 8) | d[p + 1];
const i8 = (v) => (v > 127 ? v - 256 : v);

function readAT(data, p, n) {
  const at = [];
  for (let i = 0; i < n; i++) at.push(i8(data[p + i]));
  return at;
}

// ---------------------------------------------------------------- symbol dictionaries

/** Symbol dictionary decoding (6.5). Returns the exported symbols. */
function symbolDictionary(data, p, end, inputSymbols, tables) {
  const flags = u16(data, p);
  p += 2;
  const huff = flags & 1;
  const refAgg = (flags >> 1) & 1;
  const hDH = (flags >> 2) & 3;
  const hDW = (flags >> 4) & 3;
  const hBM = (flags >> 6) & 1;
  const hAgg = (flags >> 7) & 1;
  const template = (flags >> 10) & 3;
  const rTemplate = (flags >> 12) & 1;
  let at = [];
  if (!huff) {
    at = readAT(data, p, template === 0 ? 8 : 2);
    p += template === 0 ? 8 : 2;
  }
  let rat = [-1, -1, -1, -1];
  if (refAgg && rTemplate === 0) {
    rat = readAT(data, p, 4);
    p += 4;
  }
  const numEx = u32(data, p);
  const numNew = u32(data, p + 4);
  p += 8;
  const custom = [...tables];
  const pick = (sel, std) => (sel === 3 ? custom.shift() : standardTable(std[sel]));
  const all = [...inputSymbols];
  const newSyms = [];
  const symCodeLen = Math.max(0, Math.ceil(Math.log2(inputSymbols.length + numNew)));
  let st = null;
  let bits = null;
  let tDH;
  let tDW;
  let tBM;
  let tAgg;
  if (huff) {
    tDH = pick(hDH, [4, 5, 0, 3]);
    tDW = pick(hDW, [2, 3, 0, 3]);
    tBM = hBM ? custom.shift() : standardTable(1);
    tAgg = hAgg ? custom.shift() : standardTable(1);
    bits = new Bits(data, p, end);
  } else st = new ArithState(data, p, end);
  const decInt = (name, table) => (huff ? bits.huff(table) : st.int(name));
  let height = 0;
  while (newSyms.length < numNew) {
    const dh = decInt('IADH', tDH);
    height += dh;
    let width = 0;
    let total = 0;
    const classStart = newSyms.length;
    const widths = [];
    for (;;) {
      const dw = decInt('IADW', tDW);
      if (dw === null) break;
      if (newSyms.length >= numNew) throw new JBIG2Error('Too many symbols');
      width += dw;
      total += width;
      if (huff && !refAgg) {
        widths.push(width);
        newSyms.push(null);
        continue;
      }
      let sym;
      if (!refAgg) sym = genericArith(st, width, height, template, false, at.length ? at : DEFAULT_AT[template]);
      else {
        const nInst = huff ? bits.huff(tAgg) : st.int('IAAI');
        if (nInst === 1) {
          let id;
          let rdx;
          let rdy;
          if (huff) {
            id = bits.bits(symCodeLen);
            rdx = bits.huff(standardTable(15));
            rdy = bits.huff(standardTable(15));
            const size = bits.huff(standardTable(1));
            bits.align();
            const sub = new ArithState(data, bits.byte, bits.byte + size);
            sym = refinement(sub, width, height, rTemplate, all[id], rdx, rdy, false, rat);
            bits.pos += size * 8;
          } else {
            id = st.id(symCodeLen);
            rdx = st.int('IARDX');
            rdy = st.int('IARDY');
            sym = refinement(st, width, height, rTemplate, all[id], rdx, rdy, false, rat);
          }
        } else {
          // Aggregation: a text region made of earlier symbols.
          sym = textRegionCore({ st, bits, huff, w: width, h: height, numInstances: nInst, strips: 1, symbols: all, symCodeLen, defPixel: 0, combOp: 0, transposed: 0, refCorner: 1, dsOffset: 0, refine: 1, rTemplate, rat, tables: huff ? aggregationTables() : null, data });
        }
      }
      newSyms.push(sym);
      all.push(sym);
    }
    if (huff && !refAgg) {
      // The height class as one collective bitmap.
      const size = bits.huff(tBM);
      bits.align();
      let collective;
      if (size === 0) {
        collective = new Bitmap(total, height);
        const rb = (total + 7) >> 3;
        const at0 = bits.byte;
        for (let y = 0; y < height; y++) for (let x = 0; x < total; x++) collective.d[y * total + x] = (data[at0 + y * rb + (x >> 3)] >> (7 - (x & 7))) & 1;
        bits.pos += rb * height * 8;
      } else {
        collective = genericMMR(data, bits.byte, bits.byte + size, total, height);
        bits.pos += size * 8;
      }
      let x = 0;
      for (let k = 0; k < widths.length; k++) {
        const sym = collective.sub(x, widths[k]);
        x += widths[k];
        newSyms[classStart + k] = sym;
        all.push(sym);
      }
    }
  }
  // Exported symbols: alternating runs of excluded and included symbols.
  const exported = [];
  const flagsAll = [];
  let on = false;
  while (flagsAll.length < inputSymbols.length + numNew) {
    const run = huff ? bits.huff(standardTable(1)) : st.int('IAEX');
    if (run === null || run < 0) break;
    for (let i = 0; i < run && flagsAll.length < inputSymbols.length + numNew; i++) flagsAll.push(on);
    on = !on;
  }
  const source = [...inputSymbols, ...newSyms];
  flagsAll.forEach((f, i) => f && exported.push(source[i]));
  if (exported.length !== numEx && exported.length < numEx) while (exported.length < numEx) exported.push(new Bitmap(1, 1));
  return exported;
}

function aggregationTables() {
  return { fs: standardTable(6), ds: standardTable(8), dt: standardTable(11), rdw: standardTable(15), rdh: standardTable(15), rdx: standardTable(15), rdy: standardTable(15), rsize: standardTable(1), ids: null };
}

// ---------------------------------------------------------------- text regions

/**
 * Text region decoding (6.4). o: { st | bits+huff, w, h, numInstances,
 * strips, symbols, symCodeLen, defPixel, combOp, transposed, refCorner,
 * dsOffset, refine, rTemplate, rat, tables (Huffman), symbolCodes (Huffman ID table) }
 */
function textRegionCore(o) {
  const { st, bits, huff, w, h, strips, symbols, symCodeLen, combOp, transposed, refCorner, dsOffset, refine, rTemplate, rat, tables } = o;
  const region = new Bitmap(w, h, o.defPixel);
  const dec = (name, table) => (huff ? bits.huff(table) : st.int(name));
  let stripT = -dec('IADT', tables?.dt) * strips;
  let firstS = 0;
  let n = 0;
  while (n < o.numInstances) {
    stripT += dec('IADT', tables?.dt) * strips;
    let curS = null;
    for (;;) {
      if (curS === null) {
        firstS += dec('IAFS', tables?.fs);
        curS = firstS;
      } else {
        const ids = dec('IADS', tables?.ds);
        if (ids === null) break;
        curS += ids + dsOffset;
      }
      const curT = strips === 1 ? 0 : huff ? bits.bits(Math.log2(strips)) : st.int('IAIT');
      const t = stripT + curT;
      let id;
      if (huff) id = o.symbolCodes ? bits.huff(o.symbolCodes) : bits.bits(symCodeLen);
      else id = st.id(symCodeLen);
      const ri = refine ? (huff ? bits.bit() : st.int('IARI')) : 0;
      let sym = symbols[id];
      if (!sym) throw new JBIG2Error('Unknown symbol');
      if (ri) {
        const rdw = dec('IARDW', tables?.rdw);
        const rdh = dec('IARDH', tables?.rdh);
        const rdx = dec('IARDX', tables?.rdx);
        const rdy = dec('IARDY', tables?.rdy);
        const gw = sym.w + rdw;
        const gh = sym.h + rdh;
        const dx = Math.floor(rdw / 2) + rdx;
        const dy = Math.floor(rdh / 2) + rdy;
        if (huff) {
          const size = bits.huff(tables.rsize);
          bits.align();
          const sub = new ArithState(o.data, bits.byte, bits.byte + size);
          sym = refinement(sub, gw, gh, rTemplate, sym, dx, dy, false, rat);
          bits.pos += size * 8;
        } else sym = refinement(st, gw, gh, rTemplate, sym, dx, dy, false, rat);
      }
      const wi = sym.w;
      const hi = sym.h;
      // REFCORNER: 0 bottom-left, 1 top-left, 2 bottom-right, 3 top-right.
      if (!transposed && (refCorner === 2 || refCorner === 3)) curS += wi - 1;
      else if (transposed && (refCorner === 0 || refCorner === 2)) curS += hi - 1;
      const s = curS;
      let x;
      let y;
      if (!transposed) {
        x = refCorner === 2 || refCorner === 3 ? s - wi + 1 : s;
        y = refCorner === 0 || refCorner === 2 ? t - hi + 1 : t;
      } else {
        x = refCorner === 2 || refCorner === 3 ? t - wi + 1 : t;
        y = refCorner === 0 || refCorner === 2 ? s - hi + 1 : s;
      }
      region.compose(sym, x, y, combOp);
      if (!transposed && (refCorner === 0 || refCorner === 1)) curS += wi - 1;
      else if (transposed && (refCorner === 1 || refCorner === 3)) curS += hi - 1;
      n++;
      // Every strip ends with an out-of-band delta, the last one too.
      if (n > o.numInstances) throw new JBIG2Error('Too many symbol instances');
    }
  }
  return region;
}

/** Huffman table of symbol ID codes stored in a text region segment (7.4.3.1.7). */
function symbolIdTable(bits, numSyms) {
  const runLines = [];
  for (let i = 0; i < 35; i++) runLines.push({ kind: '', prefLen: bits.bits(4), rangeLen: 0, rangeLow: i });
  const runTable = huffmanTable(runLines);
  const lens = [];
  while (lens.length < numSyms) {
    const code = bits.huff(runTable);
    if (code < 32) lens.push(code);
    else if (code === 32) {
      const prev = lens[lens.length - 1] ?? 0;
      const r = bits.bits(2) + 3;
      for (let i = 0; i < r; i++) lens.push(prev);
    } else if (code === 33) {
      const r = bits.bits(3) + 3;
      for (let i = 0; i < r; i++) lens.push(0);
    } else {
      const r = bits.bits(7) + 11;
      for (let i = 0; i < r; i++) lens.push(0);
    }
  }
  bits.align();
  return huffmanTable(lens.slice(0, numSyms).map((prefLen, i) => ({ kind: '', prefLen, rangeLen: 0, rangeLow: i })));
}

function textRegionSegment(data, p, end, info, symbols, tables) {
  const flags = u16(data, p);
  p += 2;
  const huff = flags & 1;
  const refine = (flags >> 1) & 1;
  const logStrips = (flags >> 2) & 3;
  const refCorner = (flags >> 4) & 3;
  const transposed = (flags >> 6) & 1;
  const combOp = (flags >> 7) & 3;
  const defPixel = (flags >> 9) & 1;
  let dsOffset = (flags >> 10) & 31;
  if (dsOffset > 15) dsOffset -= 32;
  const rTemplate = (flags >> 15) & 1;
  let hflags = 0;
  if (huff) {
    hflags = u16(data, p);
    p += 2;
  }
  let rat = [-1, -1, -1, -1];
  if (refine && rTemplate === 0) {
    rat = readAT(data, p, 4);
    p += 4;
  }
  const numInstances = u32(data, p);
  p += 4;
  const symCodeLen = Math.max(0, Math.ceil(Math.log2(symbols.length)));
  const common = { w: info.w, h: info.h, numInstances, strips: 1 << logStrips, symbols, symCodeLen, defPixel, combOp, transposed, refCorner, dsOffset, refine, rTemplate, rat, data };
  if (!huff) return textRegionCore({ ...common, st: new ArithState(data, p, end), huff: false });
  const custom = [...tables];
  const pick = (sel, std) => (sel === 3 ? custom.shift() : standardTable(std[sel]));
  const t = {
    fs: pick(hflags & 3, [6, 7, 0, 3]),
    ds: pick((hflags >> 2) & 3, [8, 9, 10, 3]),
    dt: pick((hflags >> 4) & 3, [11, 12, 13, 3]),
    rdw: pick((hflags >> 6) & 3, [14, 15, 0, 3]),
    rdh: pick((hflags >> 8) & 3, [14, 15, 0, 3]),
    rdx: pick((hflags >> 10) & 3, [14, 15, 0, 3]),
    rdy: pick((hflags >> 12) & 3, [14, 15, 0, 3]),
    rsize: (hflags >> 14) & 1 ? custom.shift() : standardTable(1),
  };
  const bits = new Bits(data, p, end);
  const symbolCodes = symbolIdTable(bits, symbols.length);
  return textRegionCore({ ...common, bits, huff: true, tables: t, symbolCodes });
}

// ---------------------------------------------------------------- patterns and halftones

function patternDictionary(data, p, end) {
  const flags = data[p];
  const mmr = flags & 1;
  const template = (flags >> 1) & 3;
  const pw = data[p + 1];
  const ph = data[p + 2];
  const grayMax = u32(data, p + 3);
  p += 7;
  const w = (grayMax + 1) * pw;
  let all;
  if (mmr) all = genericMMR(data, p, end, w, ph);
  else {
    const at = template === 0 ? [-pw, 0, -3, -1, 2, -2, -2, -2] : [-pw, 0];
    all = genericArith(new ArithState(data, p, end), w, ph, template, false, at);
  }
  const out = [];
  for (let g = 0; g <= grayMax; g++) out.push(all.sub(g * pw, pw));
  return out;
}

function halftoneRegion(data, p, end, info, patterns) {
  const flags = data[p];
  const mmr = flags & 1;
  const template = (flags >> 1) & 3;
  const skipOn = (flags >> 3) & 1;
  const combOp = (flags >> 4) & 7;
  const defPixel = (flags >> 7) & 1;
  const gw = u32(data, p + 1);
  const gh = u32(data, p + 5);
  const gx = i32(data, p + 9);
  const gy = i32(data, p + 13);
  const rx = u16(data, p + 17);
  const ry = u16(data, p + 19);
  p += 21;
  const region = new Bitmap(info.w, info.h, defPixel);
  if (!patterns.length) return region;
  const pw = patterns[0].w;
  const ph = patterns[0].h;
  let skip = null;
  if (skipOn) {
    skip = new Bitmap(gw, gh);
    for (let mg = 0; mg < gh; mg++) {
      for (let ng = 0; ng < gw; ng++) {
        const x = (gx + mg * ry + ng * rx) >> 8;
        const y = (gy + mg * rx - ng * ry) >> 8;
        if (x + pw <= 0 || x >= info.w || y + ph <= 0 || y >= info.h) skip.d[mg * gw + ng] = 1;
      }
    }
  }
  const bpp = Math.max(1, Math.ceil(Math.log2(patterns.length)));
  // Gray-scale image decoding (Annex C): bit planes, Gray-coded.
  const planes = new Array(bpp);
  const st = mmr ? null : new ArithState(data, p, end);
  let pos = p;
  const at = template === 0 ? [template <= 1 ? 3 : 2, -1, -3, -1, 2, -2, -2, -2] : [template <= 1 ? 3 : 2, -1];
  for (let j = bpp - 1; j >= 0; j--) {
    let plane;
    if (mmr) {
      plane = genericMMR(data, pos, end, gw, gh);
      pos += plane.consumed;
    } else plane = genericArithSkip(st, gw, gh, template, at, skip);
    if (j < bpp - 1) for (let i = 0; i < plane.d.length; i++) plane.d[i] ^= planes[j + 1].d[i];
    planes[j] = plane;
  }
  for (let mg = 0; mg < gh; mg++) {
    for (let ng = 0; ng < gw; ng++) {
      if (skip && skip.d[mg * gw + ng]) continue;
      let v = 0;
      for (let j = bpp - 1; j >= 0; j--) v = (v << 1) | planes[j].d[mg * gw + ng];
      const pat = patterns[Math.min(patterns.length - 1, v)];
      const x = (gx + mg * ry + ng * rx) >> 8;
      const y = (gy + mg * rx - ng * ry) >> 8;
      region.compose(pat, x, y, combOp);
    }
  }
  return region;
}

/** Generic region with a skip bitmap (pixels marked there are 0 and not decoded). */
function genericArithSkip(st, w, h, template, at, skip) {
  if (!skip) return genericArith(st, w, h, template, false, at);
  // Skipped pixels are not coded and stay 0.
  const bm = new Bitmap(w, h);
  const cx = st.contexts('GB', 1 << 16);
  const tmp = genericContextFn(bm, template, at);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!skip.d[y * w + x]) bm.d[y * w + x] = st.mq.decode(cx, tmp(x, y));
  return bm;
}

function genericContextFn(bm, template, at) {
  const g = (x, y) => bm.get(x, y);
  const [a1x, a1y, a2x, a2y, a3x, a3y, a4x, a4y] = at;
  if (template === 0) return (x, y) => g(x - 1, y) | (g(x - 2, y) << 1) | (g(x - 3, y) << 2) | (g(x - 4, y) << 3) | (g(x + a1x, y + a1y) << 4) | (g(x + 2, y - 1) << 5) | (g(x + 1, y - 1) << 6) | (g(x, y - 1) << 7) | (g(x - 1, y - 1) << 8) | (g(x - 2, y - 1) << 9) | (g(x + a2x, y + a2y) << 10) | (g(x + a3x, y + a3y) << 11) | (g(x + 1, y - 2) << 12) | (g(x, y - 2) << 13) | (g(x - 1, y - 2) << 14) | (g(x + a4x, y + a4y) << 15);
  if (template === 1) return (x, y) => g(x - 1, y) | (g(x - 2, y) << 1) | (g(x - 3, y) << 2) | (g(x + a1x, y + a1y) << 3) | (g(x + 2, y - 1) << 4) | (g(x + 1, y - 1) << 5) | (g(x, y - 1) << 6) | (g(x - 1, y - 1) << 7) | (g(x - 2, y - 1) << 8) | (g(x + 2, y - 2) << 9) | (g(x + 1, y - 2) << 10) | (g(x, y - 2) << 11) | (g(x - 1, y - 2) << 12);
  if (template === 2) return (x, y) => g(x - 1, y) | (g(x - 2, y) << 1) | (g(x + a1x, y + a1y) << 2) | (g(x + 1, y - 1) << 3) | (g(x, y - 1) << 4) | (g(x - 1, y - 1) << 5) | (g(x - 2, y - 1) << 6) | (g(x + 1, y - 2) << 7) | (g(x, y - 2) << 8) | (g(x - 1, y - 2) << 9);
  return (x, y) => g(x - 1, y) | (g(x - 2, y) << 1) | (g(x - 3, y) << 2) | (g(x - 4, y) << 3) | (g(x + a1x, y + a1y) << 4) | (g(x + 1, y - 1) << 5) | (g(x, y - 1) << 6) | (g(x - 1, y - 1) << 7) | (g(x - 2, y - 1) << 8) | (g(x - 3, y - 1) << 9);
}

// ---------------------------------------------------------------- segments

/** Segment headers (7.2) of a sequential stream. */
function readSegments(data) {
  const segs = [];
  let p = 0;
  while (p + 11 <= data.length) {
    const number = u32(data, p);
    const flags = data[p + 4];
    const type = flags & 63;
    const pageLong = flags & 64;
    p += 5;
    let count = data[p] >> 5;
    let refBytes = 1;
    if (count === 7) {
      count = u32(data, p) & 0x1fffffff;
      refBytes = 4 + Math.ceil((count + 1) / 8);
    }
    p += refBytes;
    const refSize = number <= 256 ? 1 : number <= 65536 ? 2 : 4;
    const refs = [];
    for (let i = 0; i < count; i++) {
      refs.push(refSize === 1 ? data[p] : refSize === 2 ? u16(data, p) : u32(data, p));
      p += refSize;
    }
    p += pageLong ? 4 : 1;
    let length = u32(data, p);
    p += 4;
    const start = p;
    if (length === 0xffffffff) {
      // Unknown length (immediate generic region): find the end marker and the row count after it.
      const mmr = data[start + 17] & 1;
      let q = start + 18;
      for (; q + 6 <= data.length; q++) {
        if (mmr ? data[q] === 0 && data[q + 1] === 0 : data[q] === 0xff && data[q + 1] === 0xac) break;
      }
      length = Math.min(data.length, q + 6) - start;
    }
    const end = Math.min(data.length, start + length);
    segs.push({ number, type, refs, start, end });
    p = end;
    if (type === 51) break;
  }
  return segs;
}

function regionInfo(data, p) {
  return { w: u32(data, p), h: u32(data, p + 4), x: u32(data, p + 8), y: u32(data, p + 12), op: data[p + 16] & 7 };
}

/** Decode a JBIG2 stream (and its global segments) to the page bitmap. */
export function decodeJBIG2(bytes, globals = null) {
  const parts = [];
  if (globals?.length) parts.push(...readSegments(globals).map((s) => ({ ...s, data: globals })));
  parts.push(...readSegments(bytes).map((s) => ({ ...s, data: bytes })));
  const results = new Map(); // segment number -> { symbols | patterns | table | bitmap }
  let page = null;
  let pageDefault = 0;
  let pageOp = 0;
  let unknownHeight = false;
  let stripeEnd = 0;
  const refsOf = (seg, key) => seg.refs.map((n) => results.get(n)).filter((r) => r && r[key]);
  const place = (bm, info, external) => {
    if (!page) return;
    if (unknownHeight && info.y + bm.h > page.h) page.grow(info.y + bm.h, pageDefault);
    page.compose(bm, info.x, info.y, external ?? pageOp);
  };
  for (const seg of parts) {
    const { data, type } = seg;
    let p = seg.start;
    try {
      switch (type) {
        case 48: {
          const w = u32(data, p);
          let h = u32(data, p + 4);
          const flags = data[p + 16];
          pageDefault = (flags >> 2) & 1;
          pageOp = (flags >> 3) & 3;
          const striping = u16(data, p + 17);
          unknownHeight = h === 0xffffffff;
          if (unknownHeight) h = striping & 0x8000 ? 0 : 0;
          page = new Bitmap(w, h, pageDefault);
          break;
        }
        case 50:
          stripeEnd = u32(data, p);
          if (page && unknownHeight) page.grow(stripeEnd + 1, pageDefault);
          break;
        case 53:
          results.set(seg.number, { table: readTableSegment(data, p, seg.end) });
          break;
        case 0: {
          const input = refsOf(seg, 'symbols').flatMap((r) => r.symbols);
          const tables = refsOf(seg, 'table').map((r) => r.table);
          results.set(seg.number, { symbols: symbolDictionary(data, p, seg.end, input, tables) });
          break;
        }
        case 16:
          results.set(seg.number, { patterns: patternDictionary(data, p, seg.end) });
          break;
        case 4:
        case 6:
        case 7: {
          const info = regionInfo(data, p);
          const symbols = refsOf(seg, 'symbols').flatMap((r) => r.symbols);
          const tables = refsOf(seg, 'table').map((r) => r.table);
          const bm = textRegionSegment(data, p + 17, seg.end, info, symbols, tables);
          if (type === 4) results.set(seg.number, { bitmap: bm, info });
          else place(bm, info, info.op);
          break;
        }
        case 20:
        case 22:
        case 23: {
          const info = regionInfo(data, p);
          const patterns = refsOf(seg, 'patterns').flatMap((r) => r.patterns);
          const bm = halftoneRegion(data, p + 17, seg.end, info, patterns);
          if (type === 20) results.set(seg.number, { bitmap: bm, info });
          else place(bm, info, info.op);
          break;
        }
        case 36:
        case 38:
        case 39: {
          const info = regionInfo(data, p);
          p += 17;
          const flags = data[p++];
          const mmr = flags & 1;
          const template = (flags >> 1) & 3;
          const tpgdon = (flags >> 3) & 1;
          let bm;
          let h = info.h;
          if (h === 0xffffffff) h = u32(data, seg.end - 4);
          if (mmr) bm = genericMMR(data, p, seg.end, info.w, h);
          else {
            const n = template === 0 ? 8 : 2;
            const at = readAT(data, p, n);
            p += n;
            bm = genericArith(new ArithState(data, p, seg.end), info.w, h, template, tpgdon, at);
          }
          if (type === 36) results.set(seg.number, { bitmap: bm, info });
          else place(bm, { ...info, h }, info.op);
          break;
        }
        case 40:
        case 42:
        case 43: {
          const info = regionInfo(data, p);
          p += 17;
          const flags = data[p++];
          const template = flags & 1;
          const tpgron = (flags >> 1) & 1;
          let at = [-1, -1, -1, -1];
          if (template === 0) {
            at = readAT(data, p, 4);
            p += 4;
          }
          // The reference: a referred intermediate region, else the page area under this region.
          const refd = refsOf(seg, 'bitmap')[0];
          let ref;
          if (refd) ref = refd.bitmap;
          else if (page) {
            ref = new Bitmap(info.w, info.h);
            for (let y = 0; y < info.h; y++) for (let x = 0; x < info.w; x++) ref.d[y * info.w + x] = page.get(info.x + x, info.y + y);
          } else ref = new Bitmap(info.w, info.h);
          const bm = refinement(new ArithState(data, p, seg.end), info.w, info.h, template, ref, 0, 0, tpgron, at);
          if (type === 40) results.set(seg.number, { bitmap: bm, info });
          else place(bm, info, info.op);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      if (!(err instanceof JBIG2Error) && !(err instanceof RangeError) && !(err instanceof TypeError)) throw err;
      // A damaged segment: keep what was decoded.
    }
    if (type === 49 || type === 51) break;
  }
  if (!page) throw new JBIG2Error('No page information');
  return { width: page.w, height: page.h, data: page.d };
}
