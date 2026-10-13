// Encoders that generate JBIG2 and CCITT fixtures for the decoder tests.
import { MQ_STATES } from '../src/features/interop/codec/mq.js';
import { CCITT_TABLES } from '../src/features/interop/codec/ccitt.js';

// ---------------------------------------------------------------- MQ encoder (T.800 C.2)

export class MQEncoder {
  constructor() {
    this.a = 0x8000;
    this.c = 0;
    this.ct = 12;
    this.buf = [0]; // buf[0] is the byte before the output
    this.bp = 0;
  }

  encode(cxs, cx, d) {
    const s = cxs[cx];
    let i = s >> 1;
    let mps = s & 1;
    const [qe, nmps, nlps, sw] = MQ_STATES[i];
    if (d === mps) {
      this.a -= qe;
      if ((this.a & 0x8000) === 0) {
        if (this.a < qe) this.a = qe;
        else this.c += qe;
        i = nmps;
        this.renorm();
      } else this.c += qe;
    } else {
      this.a -= qe;
      if (this.a < qe) this.c += qe;
      else this.a = qe;
      if (sw) mps = 1 - mps;
      i = nlps;
      this.renorm();
    }
    cxs[cx] = (i << 1) | mps;
  }

  renorm() {
    do {
      this.a <<= 1;
      this.c *= 2;
      this.ct--;
      if (this.ct === 0) this.byteOut();
    } while ((this.a & 0x8000) === 0);
  }

  byteOut() {
    const B = this.buf[this.bp];
    if (B === 0xff) {
      this.buf[++this.bp] = Math.floor(this.c / 2 ** 20) & 0xff;
      this.c %= 2 ** 20;
      this.ct = 7;
    } else if (this.c < 0x8000000) {
      this.buf[++this.bp] = Math.floor(this.c / 2 ** 19) & 0xff;
      this.c %= 2 ** 19;
      this.ct = 8;
    } else {
      this.buf[this.bp] = B + 1;
      if (B + 1 === 0xff) {
        this.c %= 0x8000000;
        this.buf[++this.bp] = Math.floor(this.c / 2 ** 20) & 0xff;
        this.c %= 2 ** 20;
        this.ct = 7;
      } else {
        this.buf[++this.bp] = Math.floor(this.c / 2 ** 19) & 0xff;
        this.c %= 2 ** 19;
        this.ct = 8;
      }
    }
  }

  /** Terminate and return the bytes (ending with the 0xFF 0xAC marker). */
  finish() {
    const temp = this.c + this.a;
    this.c = Math.floor(this.c / 0x10000) * 0x10000 + 0xffff;
    if (this.c >= temp) this.c -= 0x8000;
    this.c *= 2 ** this.ct;
    this.byteOut();
    this.c *= 2 ** this.ct;
    this.byteOut();
    const out = this.buf.slice(1, this.bp + 1);
    if (out[out.length - 1] !== 0xff) out.push(0xff);
    out.push(0xac);
    return out;
  }
}

// ---------------------------------------------------------------- JBIG2

/** A bitmap { w, h, d (1 = black) } from rows of '#' and '.'. */
export function bitmapFrom(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const d = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => (d[y * w + x] = c === '#' ? 1 : 0)));
  return { w, h, d };
}

/** A pseudo-random bitmap with blobs and lines. */
export function randomBitmap(w, h, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const d = new Uint8Array(w * h);
  for (let k = 0; k < (w * h) / 40; k++) {
    const x0 = Math.floor(rnd() * w);
    const y0 = Math.floor(rnd() * h);
    const bw = 1 + Math.floor(rnd() * 9);
    const bh = 1 + Math.floor(rnd() * 5);
    for (let y = y0; y < Math.min(h, y0 + bh); y++) for (let x = x0; x < Math.min(w, x0 + bw); x++) d[y * w + x] = 1;
  }
  for (let y = 0; y < h; y++) d[y * w + ((y * 3) % w)] = 1;
  return { w, h, d };
}

const px = (bm, x, y) => (x >= 0 && x < bm.w && y >= 0 && y < bm.h ? bm.d[y * bm.w + x] : 0);

/** Generic region context (6.2.5.3) for templates 0-3 with adaptive pixels `at`. */
export function genericContext(bm, x, y, t, at) {
  const g = (dx, dy) => px(bm, x + dx, y + dy);
  if (t === 0) return g(-1, 0) | (g(-2, 0) << 1) | (g(-3, 0) << 2) | (g(-4, 0) << 3) | (g(at[0], at[1]) << 4) | (g(2, -1) << 5) | (g(1, -1) << 6) | (g(0, -1) << 7) | (g(-1, -1) << 8) | (g(-2, -1) << 9) | (g(at[2], at[3]) << 10) | (g(at[4], at[5]) << 11) | (g(1, -2) << 12) | (g(0, -2) << 13) | (g(-1, -2) << 14) | (g(at[6], at[7]) << 15);
  if (t === 1) return g(-1, 0) | (g(-2, 0) << 1) | (g(-3, 0) << 2) | (g(at[0], at[1]) << 3) | (g(2, -1) << 4) | (g(1, -1) << 5) | (g(0, -1) << 6) | (g(-1, -1) << 7) | (g(-2, -1) << 8) | (g(2, -2) << 9) | (g(1, -2) << 10) | (g(0, -2) << 11) | (g(-1, -2) << 12);
  if (t === 2) return g(-1, 0) | (g(-2, 0) << 1) | (g(at[0], at[1]) << 2) | (g(1, -1) << 3) | (g(0, -1) << 4) | (g(-1, -1) << 5) | (g(-2, -1) << 6) | (g(1, -2) << 7) | (g(0, -2) << 8) | (g(-1, -2) << 9);
  return g(-1, 0) | (g(-2, 0) << 1) | (g(-3, 0) << 2) | (g(-4, 0) << 3) | (g(at[0], at[1]) << 4) | (g(1, -1) << 5) | (g(0, -1) << 6) | (g(-1, -1) << 7) | (g(-2, -1) << 8) | (g(-3, -1) << 9);
}

export const DEFAULT_AT = [[3, -1, -3, -1, 2, -2, -2, -2], [3, -1], [2, -1], [2, -1]];
const SLTP = [0x9b25, 0x0795, 0x00e5, 0x0195];

/** Encode a generic region (arithmetic) into enc with contexts cx. */
export function encodeGeneric(enc, cx, bm, t, at, tpgdon = false) {
  let ltp = 0;
  for (let y = 0; y < bm.h; y++) {
    if (tpgdon) {
      const same = y > 0 && bm.d.subarray(y * bm.w, (y + 1) * bm.w).every((v, x) => v === bm.d[(y - 1) * bm.w + x]);
      const lt = same ? 1 : 0;
      enc.encode(cx, SLTP[t], lt ^ ltp);
      ltp = lt;
      if (lt) continue;
    }
    for (let x = 0; x < bm.w; x++) enc.encode(cx, genericContext(bm, x, y, t, at), bm.d[y * bm.w + x]);
  }
}

/** Refinement context (6.3.5.3). */
export function refinementContext(bm, ref, x, y, t, dx, dy, at) {
  const g = (ax, ay) => px(bm, x + ax, y + ay);
  const r = (ax, ay) => px(ref, x - dx + ax, y - dy + ay);
  if (t === 0) return g(-1, 0) | (g(1, -1) << 1) | (g(0, -1) << 2) | (g(at[0], at[1]) << 3) | (r(1, 1) << 4) | (r(0, 1) << 5) | (r(-1, 1) << 6) | (r(1, 0) << 7) | (r(0, 0) << 8) | (r(-1, 0) << 9) | (r(1, -1) << 10) | (r(0, -1) << 11) | (r(at[2], at[3]) << 12);
  return g(-1, 0) | (g(1, -1) << 1) | (g(0, -1) << 2) | (g(-1, -1) << 3) | (r(1, 1) << 4) | (r(0, 1) << 5) | (r(1, 0) << 6) | (r(0, 0) << 7) | (r(-1, 0) << 8) | (r(0, -1) << 9);
}

export function encodeRefinement(enc, cx, bm, ref, t, dx, dy, at) {
  for (let y = 0; y < bm.h; y++) for (let x = 0; x < bm.w; x++) enc.encode(cx, refinementContext(bm, ref, x, y, t, dx, dy, at), bm.d[y * bm.w + x]);
}

/** Integer arithmetic coding (A.2): v, or null for OOB. */
export function encodeInt(enc, cx, v) {
  let prev = 1;
  const bit = (d) => {
    enc.encode(cx, prev, d);
    prev = prev < 256 ? (prev << 1) | d : (((prev << 1) | d) & 511) | 256;
  };
  const bits = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bit(Math.floor(val / 2 ** i) & 1);
  };
  if (v === null) {
    bit(1);
    bit(0);
    bits(0, 2);
    return;
  }
  bit(v < 0 ? 1 : 0);
  const m = Math.abs(v);
  if (m < 4) {
    bit(0);
    bits(m, 2);
  } else if (m < 20) {
    bit(1), bit(0);
    bits(m - 4, 4);
  } else if (m < 84) {
    bit(1), bit(1), bit(0);
    bits(m - 20, 6);
  } else if (m < 340) {
    bit(1), bit(1), bit(1), bit(0);
    bits(m - 84, 8);
  } else if (m < 4436) {
    bit(1), bit(1), bit(1), bit(1), bit(0);
    bits(m - 340, 12);
  } else {
    bit(1), bit(1), bit(1), bit(1), bit(1);
    bits(m - 4436, 32);
  }
}

export function encodeId(enc, cx, id, len) {
  let prev = 1;
  for (let i = len - 1; i >= 0; i--) {
    const d = (id >> i) & 1;
    enc.encode(cx, prev, d);
    prev = (prev << 1) | d;
  }
}

/** Integer coding contexts by name. */
export class IntCoder {
  constructor(enc) {
    this.enc = enc;
    this.cx = new Map();
  }

  ctx(name, size = 512) {
    if (!this.cx.has(name)) this.cx.set(name, new Uint8Array(size));
    return this.cx.get(name);
  }

  int(name, v) {
    encodeInt(this.enc, this.ctx(name), v);
  }

  id(len, v) {
    encodeId(this.enc, this.ctx(`IAID${len}`, 1 << (len + 1)), v, len);
  }
}

const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const be16 = (v) => [(v >>> 8) & 255, v & 255];
const s8 = (v) => v & 255;

/** A segment: header + data. refs: referred segment numbers. */
export function segment(number, type, data, { refs = [], page = 1 } = {}) {
  const head = [...be32(number), type & 63, (refs.length << 5) & 0xe0, ...refs.map((r) => r & 255), page, ...be32(data.length)];
  return [...head, ...data];
}

export const pageInfo = (w, h, { defPixel = 0, op = 0 } = {}) => [...be32(w), ...be32(h), 0, 0, 0, 0, 0, 0, 0, 0, (defPixel << 2) | (op << 3), 0, 0];
const regionInfo = (w, h, x, y, op = 0) => [...be32(w), ...be32(h), ...be32(x), ...be32(y), op];

/** An immediate generic region segment (arithmetic). */
export function genericSegment(number, bm, { x = 0, y = 0, template = 0, tpgdon = false, at = DEFAULT_AT[template], op = 0 } = {}) {
  const enc = new MQEncoder();
  encodeGeneric(enc, new Uint8Array(1 << 16), bm, template, at, tpgdon);
  const data = [...regionInfo(bm.w, bm.h, x, y, op), (template << 1) | (tpgdon ? 8 : 0), ...at.map(s8), ...enc.finish()];
  return segment(number, 38, data);
}

/** An immediate generic region segment coded with MMR. */
export function genericMMRSegment(number, bm, { x = 0, y = 0 } = {}) {
  const rows = [];
  for (let yy = 0; yy < bm.h; yy++) rows.push(Array.from(bm.d.subarray(yy * bm.w, (yy + 1) * bm.w)));
  const data = [...regionInfo(bm.w, bm.h, x, y), 1, ...encodeG4(rows, bm.w, { eofb: true })];
  return segment(number, 38, data);
}

/** An immediate refinement region segment refining the page under it (template 0 or 1). */
export function refinementSegment(number, bm, ref, { x = 0, y = 0, template = 1, at = [-1, -1, -1, -1] } = {}) {
  const enc = new MQEncoder();
  encodeRefinement(enc, new Uint8Array(1 << 13), bm, ref, template, 0, 0, at);
  const data = [...regionInfo(bm.w, bm.h, x, y), template, ...(template === 0 ? at.map(s8) : []), ...enc.finish()];
  return segment(number, 42, data);
}

/** A symbol dictionary (arithmetic, generic-coded symbols grouped by height) exporting every symbol. */
export function symbolDictSegment(number, symbols, { template = 0, at = DEFAULT_AT[template] } = {}) {
  const enc = new MQEncoder();
  const ic = new IntCoder(enc);
  const gb = new Uint8Array(1 << 16);
  const order = symbols.map((s, i) => i).sort((a, b) => symbols[a].h - symbols[b].h || symbols[a].w - symbols[b].w);
  let height = 0;
  let k = 0;
  while (k < order.length) {
    const h = symbols[order[k]].h;
    ic.int('IADH', h - height);
    height = h;
    let width = 0;
    while (k < order.length && symbols[order[k]].h === h) {
      const s = symbols[order[k]];
      ic.int('IADW', s.w - width);
      width = s.w;
      encodeGeneric(enc, gb, s, template, at);
      k++;
    }
    ic.int('IADW', null);
  }
  ic.int('IAEX', 0);
  ic.int('IAEX', symbols.length);
  const flags = template << 10;
  const data = [...be16(flags), ...at.map(s8), ...be32(symbols.length), ...be32(symbols.length), ...enc.finish()];
  return { bytes: segment(number, 0, data), order };
}

/**
 * An immediate text region (arithmetic, one instance per strip, top-left
 * reference corner). instances: [{ id, x, y, refine?: { bitmap, dx, dy } }]
 * with ids into the dictionary's exported (sorted) order.
 */
export function textRegionSegment(number, w, h, symbols, instances, { dictRef, refineTemplate = 1 } = {}) {
  const enc = new MQEncoder();
  const ic = new IntCoder(enc);
  const codeLen = Math.max(0, Math.ceil(Math.log2(symbols.length)));
  const refine = instances.some((i) => i.refine);
  const gr = new Uint8Array(1 << 13);
  const sorted = [...instances].sort((a, b) => a.y - b.y || a.x - b.x);
  ic.int('IADT', 0);
  let stripT = 0;
  let firstS = 0;
  for (const inst of sorted) {
    ic.int('IADT', inst.y - stripT);
    stripT = inst.y;
    ic.int('IAFS', inst.x - firstS);
    firstS = inst.x;
    ic.id(codeLen, inst.id);
    if (refine) ic.int('IARI', inst.refine ? 1 : 0);
    if (inst.refine) {
      const sym = symbols[inst.id];
      const bm = inst.refine.bitmap;
      const rdw = bm.w - sym.w;
      const rdh = bm.h - sym.h;
      const rdx = inst.refine.dx - Math.floor(rdw / 2);
      const rdy = inst.refine.dy - Math.floor(rdh / 2);
      ic.int('IARDW', rdw);
      ic.int('IARDH', rdh);
      ic.int('IARDX', rdx);
      ic.int('IARDY', rdy);
      encodeRefinement(enc, gr, bm, sym, refineTemplate, inst.refine.dx, inst.refine.dy, [-1, -1, -1, -1]);
    }
    ic.int('IADS', null);
  }
  const flags = (refine ? 2 : 0) | (1 << 4) | ((refine ? refineTemplate : 0) << 15);
  const data = [...regionInfo(w, h, 0, 0), ...be16(flags), ...(refine && refineTemplate === 0 ? [255, 255, 255, 255] : []), ...be32(instances.length), ...enc.finish()];
  return segment(number, 6, data, { refs: [dictRef] });
}

/** Pattern dictionary + halftone region (arithmetic, template 0) for a gray grid. */
export function halftoneSegments(first, patterns, grid, { gw, gh, cell }) {
  const pw = patterns[0].w;
  const ph = patterns[0].h;
  const all = { w: pw * patterns.length, h: ph, d: new Uint8Array(pw * patterns.length * ph) };
  patterns.forEach((p, g) => {
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) all.d[y * all.w + g * pw + x] = p.d[y * pw + x];
  });
  const enc = new MQEncoder();
  const at = [-pw, 0, -3, -1, 2, -2, -2, -2];
  encodeGeneric(enc, new Uint8Array(1 << 16), all, 0, at);
  const dict = segment(first, 16, [0, pw, ph, ...be32(patterns.length - 1), ...enc.finish()]);
  // Gray-coded bit planes, most significant first.
  const bpp = Math.ceil(Math.log2(patterns.length));
  const enc2 = new MQEncoder();
  const cx = new Uint8Array(1 << 16);
  const planes = [];
  for (let j = bpp - 1; j >= 0; j--) {
    const plane = { w: gw, h: gh, d: new Uint8Array(gw * gh) };
    for (let i = 0; i < gw * gh; i++) {
      const v = grid[i];
      const gray = v ^ (v >> 1);
      plane.d[i] = (gray >> j) & 1;
    }
    planes.push(plane);
    encodeGeneric(enc2, cx, plane, 0, [3, -1, -3, -1, 2, -2, -2, -2]);
  }
  const W = gw * cell;
  const H = gh * cell;
  const data = [...regionInfo(W, H, 0, 0), 0, ...be32(gw), ...be32(gh), ...be32(0), ...be32(0), ...be16(cell * 256), ...be16(0), ...enc2.finish()];
  return [...dict, ...segment(first + 1, 22, data, { refs: [first] })];
}

/** A complete embedded stream: page information, the segments and end of page. */
export function jbig2Stream(w, h, segments, opts = {}) {
  return new Uint8Array([...segment(0, 48, pageInfo(w, h, opts)), ...segments.flat(), ...segment(999, 49, [])]);
}

// ---------------------------------------------------------------- CCITT encoder

function codeMap(list) {
  const m = new Map();
  for (const [v, bits] of list) m.set(v, bits);
  return m;
}

/** Changing elements of a row (positions where the color differs from the pixel before; start color white). */
function changes(row, w) {
  const out = [];
  let c = 0;
  for (let x = 0; x < w; x++) {
    if (row[x] !== c) {
      out.push(x);
      c = row[x];
    }
  }
  return out;
}

function runBits(run, codes) {
  let s = '';
  while (run >= 2624) {
    s += codes.get(2560);
    run -= 2560;
  }
  if (run >= 64) {
    const mk = Math.floor(run / 64) * 64;
    s += codes.get(mk);
    run -= mk;
  }
  return s + codes.get(run);
}

/** Encode rows (arrays of 0 white / 1 black) with T.6 (G4), or T.4 when k >= 0 (1-D lines, 2-D every line but each k-th). */
export function encodeCCITT(rows, w, { k = -1, eol = false, eofb = false, byteAlign = false } = {}) {
  const { WHITE, BLACK, EXTENDED, MODES } = CCITT_TABLES;
  const white = codeMap([...WHITE, ...EXTENDED]);
  const black = codeMap([...BLACK, ...EXTENDED]);
  const modes = codeMap(MODES);
  let bits = '';
  let ref = [];
  rows.forEach((row, y) => {
    if (byteAlign && k < 0) while (bits.length % 8) bits += '0';
    if (k >= 0 && eol) {
      if (byteAlign) while ((bits.length + 12) % 8) bits += '0';
      bits += '000000000001';
    }
    const cur = changes(row, w);
    const oneD = k === 0 || (k > 0 && y % k === 0);
    if (k > 0) bits += oneD ? '1' : '0';
    if (oneD) {
      let pos = 0;
      let color = 0;
      for (const c of [...cur, w]) {
        bits += runBits(c - pos, color ? black : white);
        pos = c;
        color ^= 1;
        if (c === w) break;
      }
    } else {
      const refx = [...ref, w, w];
      const curx = [...cur, w, w];
      let a0 = -1;
      let color = 0;
      let ai = 0;
      while (a0 < w) {
        while (ai < curx.length && curx[ai] <= a0) ai++;
        const a1 = curx[ai];
        const a2 = curx[ai + 1] ?? w;
        let bi = 0;
        while (refx[bi] <= a0 || (bi & 1) !== color) bi++;
        const b1 = refx[bi];
        const b2 = refx[bi + 1] ?? w;
        if (b2 < a1) {
          bits += modes.get('P');
          a0 = b2;
        } else if (Math.abs(a1 - b1) <= 3) {
          bits += modes.get(a1 - b1);
          a0 = a1;
          color ^= 1;
        } else {
          const start = a0 < 0 ? 0 : a0;
          bits += modes.get('H') + runBits(a1 - start, color ? black : white) + runBits(a2 - a1, color ? white : black);
          a0 = a2;
        }
      }
    }
    ref = cur;
  });
  if (eofb && k < 0) bits += '000000000001000000000001';
  if (eofb && k >= 0) for (let i = 0; i < 6; i++) bits += k > 0 ? '0000000000011' : '000000000001';
  while (bits.length % 8) bits += '0';
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return out;
}

export function encodeG4(rows, w, opts = {}) {
  return encodeCCITT(rows, w, { ...opts, k: -1 });
}

// ---------------------------------------------------------------- JBIG2 Huffman coding

// Standard tables used by the fixtures: [prefLen, rangeLen, rangeLow] lines, then 'U'/'L'/'O' lines.
const HUFF = {
  1: [[1, 4, 0], [2, 8, 16], [3, 16, 272], ['U', 3, 65808]],
  2: [[1, 0, 0], [2, 0, 1], [3, 0, 2], [4, 3, 3], [5, 6, 11], ['U', 6, 75], ['O', 6]],
  4: [[1, 0, 1], [2, 0, 2], [3, 0, 3], [4, 3, 4], [5, 6, 12], ['U', 5, 76]],
  6: [[5, 10, -2048], [4, 9, -1024], [4, 8, -512], [4, 7, -256], [5, 6, -128], [5, 5, -64], [4, 5, -32], [2, 7, 0], [3, 7, 128], [3, 8, 256], [4, 9, 512], [4, 10, 1024], ['L', 6, -2049], ['U', 6, 2048]],
  8: [[8, 3, -15], [9, 1, -7], [8, 1, -5], [9, 0, -3], [7, 0, -2], [4, 0, -1], [2, 1, 0], [5, 0, 2], [6, 0, 3], [3, 4, 4], [6, 1, 20], [4, 4, 22], [4, 5, 38], [5, 6, 70], [5, 7, 134], [6, 7, 262], [7, 8, 390], [6, 10, 646], ['L', 9, -16], ['U', 9, 1670], ['O', 2]],
  11: [[1, 0, 1], [2, 1, 2], [4, 0, 4], [4, 1, 5], [5, 1, 7], [5, 2, 9], [6, 2, 13], [7, 2, 17], [7, 3, 21], [7, 4, 29], [7, 5, 45], [7, 6, 77], ['U', 7, 141]],
};

/** Canonical code strings for prefix lengths (in line order). */
function canonical(lens) {
  const max = Math.max(...lens);
  const count = new Array(max + 1).fill(0);
  for (const l of lens) if (l) count[l]++;
  const first = new Array(max + 2).fill(0);
  for (let l = 1; l <= max; l++) first[l] = (first[l - 1] + (l > 1 ? count[l - 1] : 0)) << 1;
  const next = first.slice();
  return lens.map((l) => (l ? (next[l]++).toString(2).padStart(l, '0') : null));
}

/** Bits for value v (or null for OOB) in standard table n. */
export function huffBits(n, v) {
  const lines = HUFF[n];
  const codes = canonical(lines.map((l) => (typeof l[0] === 'string' ? l[1] : l[0])));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (v === null) {
      if (l[0] === 'O') return codes[i];
      continue;
    }
    if (typeof l[0] !== 'string') {
      const [, rl, low] = l;
      if (v >= low && v < low + 2 ** rl) return codes[i] + (rl ? (v - low).toString(2).padStart(rl, '0') : '');
    } else if (l[0] === 'U' && v >= l[2]) return codes[i] + (v - l[2]).toString(2).padStart(32, '0');
    else if (l[0] === 'L' && v <= l[2]) return codes[i] + (l[2] - v).toString(2).padStart(32, '0');
  }
  throw new Error(`No code for ${v} in table ${n}`);
}

const bitBytes = (bits) => {
  while (bits.length % 8) bits += '0';
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return out;
};

/** A Huffman-coded symbol dictionary (uncompressed collective bitmaps per height class). */
export function symbolDictHuffmanSegment(number, symbols) {
  const order = symbols.map((s, i) => i).sort((a, b) => symbols[a].h - symbols[b].h || symbols[a].w - symbols[b].w);
  let bits = '';
  let height = 0;
  let k = 0;
  while (k < order.length) {
    const h = symbols[order[k]].h;
    bits += huffBits(4, h - height);
    height = h;
    let width = 0;
    const cls = [];
    while (k < order.length && symbols[order[k]].h === h) {
      const s = symbols[order[k]];
      bits += huffBits(2, s.w - width);
      width = s.w;
      cls.push(s);
      k++;
    }
    bits += huffBits(2, null);
    bits += huffBits(1, 0);
    while (bits.length % 8) bits += '0';
    const total = cls.reduce((a, s) => a + s.w, 0);
    for (let y = 0; y < h; y++) {
      let row = '';
      for (const s of cls) for (let x = 0; x < s.w; x++) row += s.d[y * s.w + x] ? '1' : '0';
      while (row.length % 8) row += '0';
      bits += row;
      void total;
    }
  }
  bits += huffBits(1, 0) + huffBits(1, symbols.length);
  const data = [...be16(1), ...be32(symbols.length), ...be32(symbols.length), ...bitBytes(bits)];
  return { bytes: segment(number, 0, data), order };
}

/** A Huffman-coded text region (one instance per strip, distinct rows, top-left corner). */
export function textRegionHuffmanSegment(number, w, h, symbols, instances, { dictRef }) {
  const n = symbols.length;
  const L = Math.max(1, Math.ceil(Math.log2(n)));
  let bits = '';
  // Run-code lengths: only code L is used (length 1).
  for (let i = 0; i < 35; i++) bits += (i === L ? 1 : 0).toString(2).padStart(4, '0');
  for (let i = 0; i < n; i++) bits += '0';
  while (bits.length % 8) bits += '0';
  const symCode = canonical(new Array(n).fill(L));
  const sorted = [...instances].sort((a, b) => a.y - b.y);
  bits += huffBits(11, 1);
  let stripT = -1;
  let firstS = 0;
  for (const inst of sorted) {
    bits += huffBits(11, inst.y - stripT);
    stripT = inst.y;
    bits += huffBits(6, inst.x - firstS);
    firstS = inst.x;
    bits += symCode[inst.id];
    bits += huffBits(8, null);
  }
  const flags = 1 | (1 << 4);
  const data = [...regionInfo(w, h, 0, 0), ...be16(flags), ...be16(0), ...be32(instances.length), ...bitBytes(bits)];
  return segment(number, 6, data, { refs: [dictRef] });
}
