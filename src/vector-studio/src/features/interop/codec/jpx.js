/**
 * JPEG 2000 decoding (ITU-T T.800 part 1): JP2 files and raw codestreams,
 * any number of tiles and components (with subsampling), all five
 * progression orders, precincts, quality layers, the code-block coding
 * styles (arithmetic bypass, reset, termination on each pass, vertically
 * causal contexts, segmentation symbols), reversible 5/3 and irreversible
 * 9/7 wavelets, no / derived / expounded quantization, the reversible and
 * irreversible component transforms, ROI max-shift, and JP2 color
 * specification, palettes and channel definitions.
 *
 *   decodeJPX(bytes) -> { width, height, comps, data: Uint8Array (8-bit, interleaved),
 *                         colorSpace: 'gray'|'rgb'|'cmyk'|null, alpha: boolean }
 *
 * Packed packet headers (PPM/PPT) are read; progression order changes
 * (POC), component registration and part 2 extensions are ignored.
 */
import { MQDecoder } from './mq.js';

export class JPXError extends Error {}

const u16 = (d, p) => (d[p] << 8) | d[p + 1];
const u32 = (d, p) => ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]) >>> 0;
const ceilDiv = (a, b) => Math.ceil(a / b);

// ---------------------------------------------------------------- JP2 boxes

function readBoxes(d, start, end) {
  const boxes = [];
  let p = start;
  while (p + 8 <= end) {
    let len = u32(d, p);
    const type = String.fromCharCode(d[p + 4], d[p + 5], d[p + 6], d[p + 7]);
    let header = 8;
    if (len === 1) {
      len = u32(d, p + 8) * 2 ** 32 + u32(d, p + 12);
      header = 16;
    } else if (len === 0) len = end - p;
    if (len < header) break;
    boxes.push({ type, start: p + header, end: Math.min(end, p + len) });
    p += len;
  }
  return boxes;
}

/** JP2 header information: { colorSpace, palette, cmap, cdef }. */
function readJP2(d) {
  const info = { colorSpace: null, palette: null, cmap: null, cdef: null, codestream: null };
  const walk = (start, end) => {
    for (const b of readBoxes(d, start, end)) {
      if (b.type === 'jp2h') walk(b.start, b.end);
      else if (b.type === 'jp2c' && !info.codestream) info.codestream = [b.start, b.end];
      else if (b.type === 'colr' && !info.colorSpace) {
        const meth = d[b.start];
        if (meth === 1) {
          const cs = u32(d, b.start + 3);
          info.colorSpace = { 16: 'rgb', 17: 'gray', 18: 'sycc', 12: 'cmyk', 20: 'rgb', 21: 'rgb', 22: 'rgb' }[cs] || null;
        } else info.colorSpace = 'icc';
      } else if (b.type === 'pclr') {
        const ne = u16(d, b.start);
        const npc = d[b.start + 2];
        const depths = [];
        for (let i = 0; i < npc; i++) depths.push(d[b.start + 3 + i]);
        let p = b.start + 3 + npc;
        const entries = [];
        for (let e = 0; e < ne; e++) {
          const row = [];
          for (let i = 0; i < npc; i++) {
            const bits = (depths[i] & 0x7f) + 1;
            const bytes = Math.ceil(bits / 8);
            let v = 0;
            for (let k = 0; k < bytes; k++) v = v * 256 + d[p++];
            row.push(v / (2 ** bits - 1));
          }
          entries.push(row);
        }
        info.palette = { entries, npc };
      } else if (b.type === 'cmap') {
        const out = [];
        for (let p = b.start; p + 4 <= b.end; p += 4) out.push({ cmp: u16(d, p), mtyp: d[p + 2], pcol: d[p + 3] });
        info.cmap = out;
      } else if (b.type === 'cdef') {
        const n = u16(d, b.start);
        const out = [];
        for (let i = 0; i < n; i++) out.push({ cn: u16(d, b.start + 2 + i * 6), typ: u16(d, b.start + 4 + i * 6), asoc: u16(d, b.start + 6 + i * 6) });
        info.cdef = out;
      }
    }
  };
  walk(0, d.length);
  return info;
}

// ---------------------------------------------------------------- codestream headers

function readCodingStyle(d, p, end, base = null) {
  const out = base ? { ...base } : {};
  out.levels = d[p];
  out.xcb = (d[p + 1] & 15) + 2;
  out.ycb = (d[p + 2] & 15) + 2;
  out.cbStyle = d[p + 3];
  out.reversible = d[p + 4] === 1;
  out.precincts = [];
  if (out.userPrecincts) {
    for (let r = 0; r <= out.levels; r++) {
      const v = d[p + 5 + r] ?? 0xff;
      out.precincts.push([v & 15, v >> 4]);
    }
  } else for (let r = 0; r <= out.levels; r++) out.precincts.push([15, 15]);
  return out;
}

function readQuant(d, p, end) {
  const s = d[p];
  const guard = s >> 5;
  const style = s & 31;
  const steps = [];
  p++;
  if (style === 0) for (; p < end; p++) steps.push({ exp: d[p] >> 3, mant: 0 });
  else
    for (; p + 1 < end; p += 2) {
      const v = u16(d, p);
      steps.push({ exp: v >> 11, mant: v & 0x7ff });
    }
  return { guard, style, steps };
}

function readCOD(d, p, end) {
  const scod = d[p];
  const cs = {
    userPrecincts: Boolean(scod & 1),
    sop: Boolean(scod & 2),
    eph: Boolean(scod & 4),
    order: d[p + 1],
    layers: u16(d, p + 2),
    mct: d[p + 4],
  };
  return readCodingStyle(d, p + 5, end, cs);
}

// ---------------------------------------------------------------- tag trees and bit reading

class TagTree {
  constructor(w, h) {
    this.levels = [];
    do {
      this.levels.push({ w, h, value: new Int32Array(w * h).fill(-1), low: new Int32Array(w * h) });
      w = ceilDiv(w, 2);
      h = ceilDiv(h, 2);
    } while (this.levels.length < 32 && (this.levels[this.levels.length - 1].w > 1 || this.levels[this.levels.length - 1].h > 1));
  }

  /**
   * Decode with threshold t: returns the leaf value when it is below t,
   * else t (meaning "at least t").
   */
  decode(bits, x, y, t) {
    const path = [];
    for (let k = 0; k < this.levels.length; k++) path.push([x >> k, y >> k]);
    let low = 0;
    for (let k = this.levels.length - 1; k >= 0; k--) {
      const L = this.levels[k];
      const i = path[k][1] * L.w + path[k][0];
      if (L.low[i] < low) L.low[i] = low;
      while (L.value[i] < 0 && L.low[i] < t) {
        if (bits.bit()) L.value[i] = L.low[i];
        else L.low[i]++;
      }
      low = L.value[i] >= 0 ? L.value[i] : L.low[i];
      if (L.value[i] < 0) return t;
    }
    return this.levels[0].value[path[0][1] * this.levels[0].w + path[0][0]];
  }
}

/** Packet header bits with bit stuffing after 0xFF bytes. */
class HeaderBits {
  constructor(d, p, end) {
    this.d = d;
    this.p = p;
    this.end = end;
    this.buf = 0;
    this.n = 0;
    this.prevFF = false;
  }

  bit() {
    if (this.n === 0) {
      const b = this.p < this.end ? this.d[this.p] : 0;
      this.p++;
      this.n = this.prevFF ? 7 : 8;
      this.buf = b;
      this.prevFF = b === 0xff;
    }
    this.n--;
    return (this.buf >> this.n) & 1;
  }

  bits(k) {
    let v = 0;
    for (let i = 0; i < k; i++) v = (v << 1) | this.bit();
    return v;
  }

  /** Byte position after the header (a 0xFF last byte is followed by a stuffed 0 byte). */
  align() {
    this.n = 0;
    if (this.prevFF) {
      this.p++;
      this.prevFF = false;
    }
    return this.p;
  }
}

// ---------------------------------------------------------------- tile structure

const BANDS = [['HL', 1, 0], ['LH', 0, 1], ['HH', 1, 1]];

function buildTileComponent(tile, c, siz, cs, quant) {
  const comp = siz.comps[c];
  const tcx0 = ceilDiv(tile.x0, comp.dx);
  const tcy0 = ceilDiv(tile.y0, comp.dy);
  const tcx1 = ceilDiv(tile.x1, comp.dx);
  const tcy1 = ceilDiv(tile.y1, comp.dy);
  const NL = cs.levels;
  const resolutions = [];
  for (let r = 0; r <= NL; r++) {
    const s = 2 ** (NL - r);
    const res = { r, x0: ceilDiv(tcx0, s), y0: ceilDiv(tcy0, s), x1: ceilDiv(tcx1, s), y1: ceilDiv(tcy1, s), bands: [] };
    const [PPx, PPy] = cs.precincts[r] || [15, 15];
    res.PPx = PPx;
    res.PPy = PPy;
    const px0 = Math.floor(res.x0 / 2 ** PPx);
    const py0 = Math.floor(res.y0 / 2 ** PPy);
    res.pw = res.x1 > res.x0 ? ceilDiv(res.x1, 2 ** PPx) - px0 : 0;
    res.ph = res.y1 > res.y0 ? ceilDiv(res.y1, 2 ** PPy) - py0 : 0;
    res.px0 = px0;
    res.py0 = py0;
    const types = r === 0 ? [['LL', 0, 0]] : BANDS;
    const xcbP = r === 0 ? PPx : PPx - 1;
    const ycbP = r === 0 ? PPy : PPy - 1;
    const xcb = Math.min(cs.xcb, xcbP);
    const ycb = Math.min(cs.ycb, ycbP);
    for (const [type, xob, yob] of types) {
      const nb = r === 0 ? NL : NL - r + 1;
      const sb = 2 ** nb;
      const band = {
        type,
        x0: r === 0 ? res.x0 : ceilDiv(tcx0 - (sb / 2) * xob, sb),
        y0: r === 0 ? res.y0 : ceilDiv(tcy0 - (sb / 2) * yob, sb),
        x1: r === 0 ? res.x1 : ceilDiv(tcx1 - (sb / 2) * xob, sb),
        y1: r === 0 ? res.y1 : ceilDiv(tcy1 - (sb / 2) * yob, sb),
        nb,
        precincts: [],
      };
      // Quantization: one step per band in order (LL, then HL, LH, HH per level), or derived from the first.
      const bandIndex = r === 0 ? 0 : 3 * (r - 1) + 1 + BANDS.findIndex((b) => b[0] === type);
      let step;
      if (quant.style === 1) {
        const s0 = quant.steps[0] || { exp: 0, mant: 0 };
        step = { exp: s0.exp - NL + nb, mant: s0.mant };
        if (r === 0) step = { exp: s0.exp, mant: s0.mant };
      } else step = quant.steps[bandIndex] || quant.steps[quant.steps.length - 1] || { exp: 0, mant: 0 };
      const gain = type === 'LL' ? 0 : type === 'HH' ? 2 : 1;
      band.Mb = quant.guard + step.exp - 1;
      band.delta = quant.style === 0 ? 1 : 2 ** (comp.bits + gain - step.exp) * (1 + step.mant / 2048);
      band.w = Math.max(0, band.x1 - band.x0);
      band.h = Math.max(0, band.y1 - band.y0);
      band.coeffs = new Float32Array(band.w * band.h);
      // Precincts in band coordinates and their code-blocks.
      for (let py = 0; py < res.ph; py++) {
        for (let px = 0; px < res.pw; px++) {
          const bx0 = Math.max(band.x0, (px0 + px) * 2 ** xcbP);
          const by0 = Math.max(band.y0, (py0 + py) * 2 ** ycbP);
          const bx1 = Math.min(band.x1, (px0 + px + 1) * 2 ** xcbP);
          const by1 = Math.min(band.y1, (py0 + py + 1) * 2 ** ycbP);
          const prec = { blocks: [], cw: 0, ch: 0 };
          if (bx1 > bx0 && by1 > by0) {
            const cx0 = Math.floor(bx0 / 2 ** xcb);
            const cy0 = Math.floor(by0 / 2 ** ycb);
            const cx1 = ceilDiv(bx1, 2 ** xcb);
            const cy1 = ceilDiv(by1, 2 ** ycb);
            prec.cw = cx1 - cx0;
            prec.ch = cy1 - cy0;
            for (let j = cy0; j < cy1; j++) {
              for (let i = cx0; i < cx1; i++) {
                const x0 = Math.max(bx0, i * 2 ** xcb);
                const y0 = Math.max(by0, j * 2 ** ycb);
                const x1 = Math.min(bx1, (i + 1) * 2 ** xcb);
                const y1 = Math.min(by1, (j + 1) * 2 ** ycb);
                prec.blocks.push({ x0, y0, x1, y1, included: false, zero: 0, lblock: 3, passes: 0, segments: [] });
              }
            }
            prec.incl = new TagTree(prec.cw, prec.ch);
            prec.zbp = new TagTree(prec.cw, prec.ch);
          }
          band.precincts.push(prec);
        }
      }
      res.bands.push(band);
    }
    resolutions.push(res);
  }
  return { c, x0: tcx0, y0: tcy0, x1: tcx1, y1: tcy1, resolutions, cs, comp, quant };
}

/** Packets of a tile in progression order: [{ l, r, c, p }]. */
function packetOrder(tile, comps, layers, order, siz) {
  const list = [];
  for (let c = 0; c < comps.length; c++) {
    const tc = comps[c];
    const NL = tc.cs.levels;
    for (const res of tc.resolutions) {
      for (let py = 0; py < res.ph; py++) {
        for (let px = 0; px < res.pw; px++) {
          const p = py * res.pw + px;
          // Precinct position on the reference grid (the first row/column starts at the tile edge).
          const sx = siz.comps[c].dx * 2 ** (res.PPx + NL - res.r);
          const sy = siz.comps[c].dy * 2 ** (res.PPy + NL - res.r);
          const gx = px === 0 ? tile.x0 : (res.px0 + px) * sx;
          const gy = py === 0 ? tile.y0 : (res.py0 + py) * sy;
          for (let l = 0; l < layers; l++) list.push({ l, r: res.r, c, p, gx, gy });
        }
      }
    }
  }
  const keys = {
    0: (k) => [k.l, k.r, k.c, k.p],
    1: (k) => [k.r, k.l, k.c, k.p],
    2: (k) => [k.r, k.gy, k.gx, k.c, k.l],
    3: (k) => [k.gy, k.gx, k.c, k.r, k.l],
    4: (k) => [k.c, k.gy, k.gx, k.r, k.l],
  };
  const key = keys[order] || keys[0];
  return list
    .map((k) => ({ k, key: key(k) }))
    .sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
      return 0;
    })
    .map((x) => x.k);
}

// ---------------------------------------------------------------- packets

/** Is a pass (0-based within the code-block) the last of a codeword segment? */
function terminates(k, style) {
  if (style & 4) return true;
  if (style & 1) return k === 9 || (k > 9 && (k - 10) % 3 !== 0);
  return false;
}

function passCount(bits) {
  if (!bits.bit()) return 1;
  if (!bits.bit()) return 2;
  const two = bits.bits(2);
  if (two < 3) return 3 + two;
  const five = bits.bits(5);
  if (five < 31) return 6 + five;
  return 37 + bits.bits(7);
}

/** A packet header: the code-block contributions it announces. */
function readHeader(bits, tc, r, precIndex, layer, cs) {
  const res = tc.resolutions[r];
  const contributions = [];
  if (!bits.bit()) return contributions;
  for (const band of res.bands) {
    const prec = band.precincts[precIndex];
    if (!prec || !prec.blocks.length) continue;
    for (let bi = 0; bi < prec.blocks.length; bi++) {
      const cb = prec.blocks[bi];
      const bx = bi % prec.cw;
      const by = Math.floor(bi / prec.cw);
      let inc;
      if (!cb.included) inc = prec.incl.decode(bits, bx, by, layer + 1) <= layer;
      else inc = bits.bit() === 1;
      if (!inc) continue;
      if (!cb.included) {
        // Missing most significant bitplanes: the smallest z the tree confirms.
        let z = 0;
        while (z < 64 && prec.zbp.decode(bits, bx, by, z + 1) > z) z++;
        cb.zero = z;
        cb.included = true;
      }
      const n = passCount(bits);
      while (bits.bit()) cb.lblock++;
      // Split the new passes into codeword segments; each gets its own length.
      let k = cb.passes;
      const last = cb.passes + n;
      while (k < last) {
        let e = k;
        while (e < last - 1 && !terminates(e, cs.cbStyle)) e++;
        const count = e - k + 1;
        const len = bits.bits(cb.lblock + Math.floor(Math.log2(count)));
        contributions.push({ cb, passes: count, len, ends: terminates(e, cs.cbStyle) });
        k = e + 1;
      }
      cb.passes = last;
    }
  }
  return contributions;
}

/** Packet bodies: append each contribution's bytes to its code-block's segments. */
function readBodies(d, p, end, contributions) {
  for (const ct of contributions) {
    const data = d.subarray(Math.min(end, p), Math.min(end, p + ct.len));
    p += ct.len;
    const segs = ct.cb.segments;
    const lastSeg = segs[segs.length - 1];
    if (lastSeg && !lastSeg.closed) {
      lastSeg.chunks.push(data);
      lastSeg.passes += ct.passes;
      lastSeg.closed = ct.ends;
    } else segs.push({ chunks: [data], passes: ct.passes, closed: ct.ends });
  }
  return p;
}

/**
 * One packet at d[p]: header and bodies in the tile data, or (with `hb`)
 * the header from packed packet headers. Returns the position after it.
 */
function readPacket(d, p, end, tc, r, precIndex, layer, cs, hb = null) {
  if (cs.sop && d[p] === 0xff && d[p + 1] === 0x91) p += 6;
  let contributions;
  if (hb) {
    contributions = readHeader(hb, tc, r, precIndex, layer, cs);
    hb.align();
    if (cs.eph && hb.d[hb.p] === 0xff && hb.d[hb.p + 1] === 0x92) hb.p += 2;
  } else {
    const bits = new HeaderBits(d, p, end);
    contributions = readHeader(bits, tc, r, precIndex, layer, cs);
    p = bits.align();
    if (cs.eph && d[p] === 0xff && d[p + 1] === 0x92) p += 2;
  }
  return readBodies(d, p, end, contributions);
}

// ---------------------------------------------------------------- code-block decoding (tier 1)

const UNI = 18;
const RUN = 17;

function zcContext(h, v, dg, type) {
  if (type === 'HL') [h, v] = [v, h];
  if (type === 'HH') {
    const hv = h + v;
    if (dg >= 3) return 8;
    if (dg === 2) return hv >= 1 ? 7 : 6;
    if (dg === 1) return hv >= 2 ? 5 : hv === 1 ? 4 : 3;
    return hv >= 2 ? 2 : hv === 1 ? 1 : 0;
  }
  if (h === 2) return 8;
  if (h === 1) return v >= 1 ? 7 : dg >= 1 ? 6 : 5;
  if (v === 2) return 4;
  if (v === 1) return 3;
  return dg >= 2 ? 2 : dg === 1 ? 1 : 0;
}

function freshContexts() {
  const cx = new Uint8Array(19);
  cx[0] = 4 << 1;
  cx[RUN] = 3 << 1;
  cx[UNI] = 46 << 1;
  return cx;
}

/** Raw (bypass) bits with bit stuffing after 0xFF. */
class RawBits {
  constructor(d) {
    this.d = d;
    this.p = 0;
    this.n = 0;
    this.buf = 0;
    this.prevFF = false;
  }

  bit() {
    if (this.n === 0) {
      const b = this.p < this.d.length ? this.d[this.p] : 0xff;
      this.p++;
      this.n = this.prevFF ? 7 : 8;
      this.buf = b;
      this.prevFF = b === 0xff;
    }
    this.n--;
    return (this.buf >> this.n) & 1;
  }
}

const concat = (chunks) => {
  if (chunks.length === 1) return chunks[0];
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};

/** Decode a code-block's coefficients into the band (quantization indices times the step). */
function decodeBlock(cb, band, cs, roiShift) {
  const w = cb.x1 - cb.x0;
  const h = cb.y1 - cb.y0;
  if (w <= 0 || h <= 0 || !cb.segments.length) return;
  const style = cs.cbStyle;
  const causal = Boolean(style & 8);
  const n = w * h;
  const mag = new Float64Array(n);
  const neg = new Uint8Array(n);
  // State bits: 1 significant, 2 visited this bitplane, 4 refined before.
  const st = new Uint8Array(n);
  // The lowest bitplane known for each coefficient (for mid-point reconstruction).
  const lp = new Int8Array(n);
  const W = w;
  let plane = band.Mb + roiShift - 1 - cb.zero;
  let cx = freshContexts();
  const sig = (x, y) => (x >= 0 && x < w && y >= 0 && y < h ? st[y * W + x] & 1 : 0);
  const sgn = (x, y) => (x >= 0 && x < w && y >= 0 && y < h && st[y * W + x] & 1 ? (neg[y * W + x] ? -1 : 1) : 0);
  /** Significance counts around (x, y); below-stripe neighbors are ignored in causal mode. */
  const counts = (x, y) => {
    const below = !(causal && (y & 3) === 3);
    const hh = sig(x - 1, y) + sig(x + 1, y);
    const vv = sig(x, y - 1) + (below ? sig(x, y + 1) : 0);
    const dd = sig(x - 1, y - 1) + sig(x + 1, y - 1) + (below ? sig(x - 1, y + 1) + sig(x + 1, y + 1) : 0);
    return [hh, vv, dd];
  };
  const signBit = (dec, x, y) => {
    const below = !(causal && (y & 3) === 3);
    const H = Math.max(-1, Math.min(1, sgn(x - 1, y) + sgn(x + 1, y)));
    const V = Math.max(-1, Math.min(1, sgn(x, y - 1) + (below ? sgn(x, y + 1) : 0)));
    let ctx;
    let xr = 0;
    if (H === 1) ctx = V === 1 ? 13 : V === 0 ? 12 : 11;
    else if (H === 0) {
      ctx = V === 0 ? 9 : 10;
      xr = V === -1 ? 1 : 0;
    } else {
      ctx = V === -1 ? 13 : V === 0 ? 12 : 11;
      xr = 1;
    }
    return dec(ctx) ^ xr;
  };
  let passIndex = 0;
  let kind = 2; // 0 significance, 1 refinement, 2 cleanup; the first pass is a cleanup pass
  for (const seg of cb.segments) {
    const data = concat(seg.chunks);
    const raw = (style & 1) && passIndex >= 10 && kind !== 2;
    let dec;
    if (raw) {
      const rb = new RawBits(data);
      dec = () => rb.bit();
    } else {
      const mq = new MQDecoder(data, 0, data.length);
      dec = (ctx) => mq.decode(cx, ctx);
    }
    for (let s = 0; s < seg.passes; s++) {
      if (plane < 0) break;
      const bitv = 2 ** plane;
      if (kind === 0) {
        for (let y0 = 0; y0 < h; y0 += 4) {
          for (let x = 0; x < w; x++) {
            for (let y = y0; y < Math.min(h, y0 + 4); y++) {
              const i = y * W + x;
              if (st[i] & 1) continue;
              const [hh, vv, dd] = counts(x, y);
              if (!hh && !vv && !dd) continue;
              const ctx = zcContext(hh, vv, dd, band.type);
              st[i] |= 2;
              if (dec(ctx)) {
                neg[i] = raw ? dec() : signBit(dec, x, y);
                mag[i] += bitv;
                st[i] |= 1;
                lp[i] = plane;
              }
            }
          }
        }
      } else if (kind === 1) {
        for (let y0 = 0; y0 < h; y0 += 4) {
          for (let x = 0; x < w; x++) {
            for (let y = y0; y < Math.min(h, y0 + 4); y++) {
              const i = y * W + x;
              if (!(st[i] & 1) || st[i] & 2) continue;
              let ctx = 16;
              if (!(st[i] & 4)) {
                const [hh, vv, dd] = counts(x, y);
                ctx = hh + vv + dd ? 15 : 14;
              }
              if (dec(ctx)) mag[i] += bitv;
              st[i] |= 4;
              lp[i] = plane;
            }
          }
        }
      } else {
        for (let y0 = 0; y0 < h; y0 += 4) {
          const full = y0 + 4 <= h;
          for (let x = 0; x < w; x++) {
            let y = y0;
            if (full) {
              // Run mode: four insignificant, unvisited coefficients without significant neighbors.
              let run = true;
              for (let k = 0; k < 4 && run; k++) {
                const i = (y0 + k) * W + x;
                if (st[i] & 3) run = false;
                else {
                  const [hh, vv, dd] = counts(x, y0 + k);
                  if (hh || vv || dd) run = false;
                }
              }
              if (run) {
                if (!dec(RUN)) continue;
                const pos = (dec(UNI) << 1) | dec(UNI);
                y = y0 + pos;
                const i = y * W + x;
                neg[i] = signBit(dec, x, y);
                mag[i] += bitv;
                st[i] |= 1;
                lp[i] = plane;
                y++;
              }
            }
            for (; y < Math.min(h, y0 + 4); y++) {
              const i = y * W + x;
              if (st[i] & 3) continue;
              const [hh, vv, dd] = counts(x, y);
              if (dec(zcContext(hh, vv, dd, band.type))) {
                neg[i] = signBit(dec, x, y);
                mag[i] += bitv;
                st[i] |= 1;
                lp[i] = plane;
              }
            }
          }
        }
        if (style & 32) for (let k = 0; k < 4; k++) dec(UNI);
        // A new bitplane: clear the visited flags.
        for (let i = 0; i < n; i++) st[i] &= ~2;
        plane--;
      }
      passIndex++;
      kind = (kind + 1) % 3;
      if (style & 2) cx = freshContexts();
    }
  }
  // Reconstruction: the middle of each coefficient's remaining uncertainty, times the step.
  const exact = band.reversibleBand;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * W + x;
      let m = mag[i];
      if (!m) continue;
      if (roiShift && m >= 2 ** roiShift) m /= 2 ** roiShift;
      const l = lp[i];
      const half = l > 0 ? 2 ** (l - 1) : exact ? 0 : 0.5;
      const v = (m + half) * band.delta;
      band.coeffs[(cb.y0 - band.y0 + y) * band.w + (cb.x0 - band.x0 + x)] = neg[i] ? -v : v;
    }
  }
}

// ---------------------------------------------------------------- wavelets

/** Inverse 1-D transform of `buf[off .. off + n)` whose first sample has coordinate i0. */
function idwt1D(buf, off, n, i0, reversible, ext) {
  if (n === 1) {
    if (i0 & 1) buf[off] = reversible ? Math.floor(buf[off] / 2) : buf[off] / 2;
    return;
  }
  // Extended copy: E[k] for coordinates i0 - E .. i0 + n + E (symmetric).
  const E = 4;
  for (let k = 0; k < n; k++) ext[E + k] = buf[off + k];
  for (let k = 1; k <= E; k++) {
    ext[E - k] = ext[E + reflect(-k, n)];
    ext[E + n - 1 + k] = ext[E + reflect(n - 1 + k, n)];
  }
  // Coordinate parity: index j in ext is coordinate i0 - E + j.
  const par = (j) => (i0 - E + j) & 1;
  if (reversible) {
    for (let j = 1; j < n + 2 * E - 1; j++) if (!par(j)) ext[j] -= Math.floor((ext[j - 1] + ext[j + 1] + 2) / 4);
    for (let j = 1; j < n + 2 * E - 1; j++) if (par(j)) ext[j] += Math.floor((ext[j - 1] + ext[j + 1]) / 2);
  } else {
    const K = 1.230174104914001;
    const a = -1.586134342059924;
    const b = -0.052980118572961;
    const g = 0.882911075530934;
    const dl = 0.443506852043971;
    const N = n + 2 * E;
    for (let j = 0; j < N; j++) ext[j] = par(j) ? ext[j] / K : ext[j] * K;
    for (let j = 1; j < N - 1; j++) if (!par(j)) ext[j] -= dl * (ext[j - 1] + ext[j + 1]);
    for (let j = 1; j < N - 1; j++) if (par(j)) ext[j] -= g * (ext[j - 1] + ext[j + 1]);
    for (let j = 1; j < N - 1; j++) if (!par(j)) ext[j] -= b * (ext[j - 1] + ext[j + 1]);
    for (let j = 1; j < N - 1; j++) if (par(j)) ext[j] -= a * (ext[j - 1] + ext[j + 1]);
  }
  for (let k = 0; k < n; k++) buf[off + k] = ext[E + k];
}

function reflect(k, n) {
  if (n === 1) return 0;
  const period = 2 * (n - 1);
  k = ((k % period) + period) % period;
  return k < n ? k : period - k;
}

/** Reconstruct a tile-component's samples from its bands. */
function reconstruct(tc) {
  const res0 = tc.resolutions[0];
  let w = res0.x1 - res0.x0;
  let h = res0.y1 - res0.y0;
  let img = Float64Array.from(res0.bands[0].coeffs);
  const reversible = tc.cs.reversible;
  for (let r = 1; r < tc.resolutions.length; r++) {
    const res = tc.resolutions[r];
    const W = res.x1 - res.x0;
    const Hh = res.y1 - res.y0;
    const out = new Float64Array(W * Hh);
    const [HL, LH, HH] = res.bands;
    const lx0 = ceilDiv(res.x0, 2);
    const ly0 = ceilDiv(res.y0, 2);
    // Interleave: even coordinates take low-pass samples, odd ones high-pass.
    for (let y = 0; y < Hh; y++) {
      const gy = res.y0 + y;
      for (let x = 0; x < W; x++) {
        const gx = res.x0 + x;
        let v = 0;
        if (!(gy & 1)) {
          if (!(gx & 1)) v = img[(Math.floor(gy / 2) - ly0) * w + (Math.floor(gx / 2) - lx0)] ?? 0;
          else v = HL.coeffs[(Math.floor(gy / 2) - HL.y0) * HL.w + (Math.floor(gx / 2) - HL.x0)] ?? 0;
        } else if (!(gx & 1)) v = LH.coeffs[(Math.floor(gy / 2) - LH.y0) * LH.w + (Math.floor(gx / 2) - LH.x0)] ?? 0;
        else v = HH.coeffs[(Math.floor(gy / 2) - HH.y0) * HH.w + (Math.floor(gx / 2) - HH.x0)] ?? 0;
        out[y * W + x] = v;
      }
    }
    const ext = new Float64Array(Math.max(W, Hh) + 16);
    if (W > 0) for (let y = 0; y < Hh; y++) idwt1D(out, y * W, W, res.x0, reversible, ext);
    if (Hh > 0) {
      const col = new Float64Array(Hh);
      for (let x = 0; x < W; x++) {
        for (let y = 0; y < Hh; y++) col[y] = out[y * W + x];
        idwt1D(col, 0, Hh, res.y0, reversible, ext);
        for (let y = 0; y < Hh; y++) out[y * W + x] = col[y];
      }
    }
    img = out;
    w = W;
    h = Hh;
  }
  return { w, h, data: img };
}

// ---------------------------------------------------------------- main

/** Parse the codestream main header and tile-parts. */
function parseCodestream(d, start, end) {
  if (u16(d, start) !== 0xff4f) throw new JPXError('Not a JPEG 2000 codestream');
  let p = start + 2;
  const siz = { comps: [] };
  let cod = null;
  const coc = new Map();
  let qcd = null;
  const qcc = new Map();
  const rgn = new Map();
  const ppm = [];
  const tiles = new Map();
  while (p + 4 <= end) {
    const marker = u16(d, p);
    if (marker === 0xffd9) break;
    if (marker === 0xff90) {
      // Tile-part.
      const len = u16(d, p + 2);
      const isot = u16(d, p + 4);
      let psot = u32(d, p + 6);
      const tpStart = p;
      if (psot === 0) psot = end - p;
      let q = p + 2 + len;
      const t = tiles.get(isot) || { index: isot, parts: [], cod: null, coc: new Map(), qcd: null, qcc: new Map(), rgn: new Map(), ppt: [] };
      while (q + 4 <= end) {
        const m = u16(d, q);
        if (m === 0xff93) {
          q += 2;
          break;
        }
        const l = u16(d, q + 2);
        const s = q + 4;
        const e = q + 2 + l;
        if (m === 0xff52) t.cod = readCOD(d, s, e);
        else if (m === 0xff53) {
          const big = siz.comps.length > 256;
          const ci = big ? u16(d, s) : d[s];
          const o = big ? 2 : 1;
          t.coc.set(ci, { userPrecincts: Boolean(d[s + o] & 1), at: s + o + 1, end: e });
        } else if (m === 0xff5c) t.qcd = readQuant(d, s, e);
        else if (m === 0xff5d) {
          const big = siz.comps.length > 256;
          t.qcc.set(big ? u16(d, s) : d[s], readQuant(d, s + (big ? 2 : 1), e));
        } else if (m === 0xff5e) {
          const big = siz.comps.length > 256;
          t.rgn.set(big ? u16(d, s) : d[s], d[s + (big ? 3 : 2)]);
        } else if (m === 0xff61) t.ppt.push({ z: d[s], data: d.subarray(s + 1, e) });
        q = e;
      }
      const dataEnd = Math.min(end, tpStart + psot);
      t.parts.push(d.subarray(q, dataEnd));
      tiles.set(isot, t);
      p = dataEnd;
      continue;
    }
    const len = u16(d, p + 2);
    const s = p + 4;
    const e = p + 2 + len;
    if (marker === 0xff51) {
      siz.w = u32(d, s + 2);
      siz.h = u32(d, s + 6);
      siz.x0 = u32(d, s + 10);
      siz.y0 = u32(d, s + 14);
      siz.tw = u32(d, s + 18);
      siz.th = u32(d, s + 22);
      siz.tx0 = u32(d, s + 26);
      siz.ty0 = u32(d, s + 30);
      const n = u16(d, s + 34);
      for (let i = 0; i < n; i++) {
        const ss = d[s + 36 + i * 3];
        siz.comps.push({ bits: (ss & 0x7f) + 1, signed: Boolean(ss & 0x80), dx: d[s + 37 + i * 3] || 1, dy: d[s + 38 + i * 3] || 1 });
      }
    } else if (marker === 0xff52) cod = readCOD(d, s, e);
    else if (marker === 0xff53) {
      const big = siz.comps.length > 256;
      const ci = big ? u16(d, s) : d[s];
      const o = big ? 2 : 1;
      coc.set(ci, { userPrecincts: Boolean(d[s + o] & 1), at: s + o + 1, end: e });
    } else if (marker === 0xff5c) qcd = readQuant(d, s, e);
    else if (marker === 0xff5d) {
      const big = siz.comps.length > 256;
      qcc.set(big ? u16(d, s) : d[s], readQuant(d, s + (big ? 2 : 1), e));
    } else if (marker === 0xff5e) {
      const big = siz.comps.length > 256;
      rgn.set(big ? u16(d, s) : d[s], d[s + (big ? 3 : 2)]);
    } else if (marker === 0xff60) ppm.push({ z: d[s], data: d.subarray(s + 1, e) });
    if (len < 2) break;
    p = e;
  }
  if (!siz.comps.length || !cod || !qcd) throw new JPXError('Missing codestream headers');
  return { siz, cod, coc, qcd, qcc, rgn, ppm, tiles, d };
}

/** Packed packet headers (PPM for the whole image or PPT per tile) split per tile. */
function packedHeaders(chunks) {
  const all = concat(chunks.sort((a, b) => a.z - b.z).map((c) => c.data));
  return all;
}

function decodeTile(cs0, t, tileIndex) {
  const { siz, d } = cs0;
  const tw = Math.ceil((siz.w - siz.tx0) / siz.tw);
  const tx = tileIndex % tw;
  const ty = Math.floor(tileIndex / tw);
  const tile = {
    x0: Math.max(siz.tx0 + tx * siz.tw, siz.x0),
    y0: Math.max(siz.ty0 + ty * siz.th, siz.y0),
    x1: Math.min(siz.tx0 + (tx + 1) * siz.tw, siz.w),
    y1: Math.min(siz.ty0 + (ty + 1) * siz.th, siz.h),
  };
  const cod = t.cod || cs0.cod;
  const comps = siz.comps.map((_, c) => {
    let cs = cod;
    const cc = t.coc.get(c) || (t.cod ? null : cs0.coc.get(c));
    if (cc) cs = readCodingStyle(d, cc.at, cc.end, { ...cod, userPrecincts: cc.userPrecincts });
    const quant = t.qcc.get(c) || (t.qcd ? null : cs0.qcc.get(c)) || t.qcd || cs0.qcd;
    const tc = buildTileComponent(tile, c, siz, cs, quant);
    tc.roi = t.rgn.get(c) ?? cs0.rgn.get(c) ?? 0;
    for (const res of tc.resolutions) for (const band of res.bands) band.reversibleBand = cs.reversible;
    return tc;
  });
  const data = concat(t.parts);
  const order = packetOrder(tile, comps, cod.layers, cod.order, siz);
  let p = 0;
  // Packet headers may be stored apart (PPT / PPM); then the tile data holds only bodies.
  let hb = null;
  if (t.ppt.length) {
    const hdr = packedHeaders(t.ppt);
    hb = new HeaderBits(hdr, 0, hdr.length);
  } else if (t.ppmHeaders) hb = new HeaderBits(t.ppmHeaders, 0, t.ppmHeaders.length);
  for (const pk of order) {
    if (p >= data.length && !hb) break;
    const tc = comps[pk.c];
    if (pk.r >= tc.resolutions.length) continue;
    try {
      p = readPacket(data, p, data.length, tc, pk.r, pk.p, pk.l, tc.cs, hb);
    } catch {
      break;
    }
  }
  for (const tc of comps) {
    for (const res of tc.resolutions) {
      for (const band of res.bands) {
        for (const prec of band.precincts) for (const cb of prec.blocks) decodeBlock(cb, band, tc.cs, tc.roi);
      }
    }
  }
  return { tile, comps: comps.map((tc) => ({ ...reconstruct(tc), x0: tc.x0, y0: tc.y0, tc })), mct: cod.mct, reversible: comps[0].cs.reversible };
}

/** Decode JPEG 2000 data (a JP2 file or a raw codestream). */
export function decodeJPX(bytes) {
  let start = 0;
  let end = bytes.length;
  let jp2 = null;
  if (u16(bytes, 0) !== 0xff4f) {
    jp2 = readJP2(bytes);
    if (!jp2.codestream) throw new JPXError('No codestream in the JPEG 2000 file');
    [start, end] = jp2.codestream;
  }
  const cs0 = parseCodestream(bytes, start, end);
  const { siz } = cs0;
  if (cs0.ppm.length) {
    // PPM: per tile-part, a 4-byte length then that tile's headers; collected by tile order of appearance.
    const all = packedHeaders(cs0.ppm);
    let q = 0;
    for (const [, t] of [...cs0.tiles].sort((a, b) => a[0] - b[0])) {
      const parts = [];
      for (let k = 0; k < t.parts.length && q + 4 <= all.length; k++) {
        const n = u32(all, q);
        parts.push(all.subarray(q + 4, q + 4 + n));
        q += 4 + n;
      }
      t.ppmHeaders = concat(parts.length ? parts : [new Uint8Array(0)]);
    }
  }
  const W = siz.w - siz.x0;
  const H = siz.h - siz.y0;
  const nc = siz.comps.length;
  const planes = siz.comps.map(() => new Float32Array(W * H));
  for (const [index, t] of cs0.tiles) {
    const dt = decodeTile(cs0, t, index);
    // Component transform.
    const cmp = dt.comps;
    if (dt.mct && nc >= 3) {
      const [a, b, c] = cmp;
      const n = Math.min(a.data.length, b.data.length, c.data.length);
      for (let i = 0; i < n; i++) {
        const y0 = a.data[i];
        const y1 = b.data[i];
        const y2 = c.data[i];
        if (dt.reversible) {
          const g = y0 - Math.floor((y2 + y1) / 4);
          a.data[i] = y2 + g;
          b.data[i] = g;
          c.data[i] = y1 + g;
        } else {
          a.data[i] = y0 + 1.402 * y2;
          b.data[i] = y0 - 0.34413 * y1 - 0.71414 * y2;
          c.data[i] = y0 + 1.772 * y1;
        }
      }
    }
    // DC shift and placement (upsampling subsampled components).
    cmp.forEach((tcd, c) => {
      const comp = siz.comps[c];
      const shift = comp.signed ? 0 : 2 ** (comp.bits - 1);
      const plane = planes[c];
      for (let y = dt.tile.y0; y < dt.tile.y1; y++) {
        const sy = Math.min(tcd.h - 1, Math.floor(y / comp.dy) - tcd.y0);
        if (sy < 0) continue;
        for (let x = dt.tile.x0; x < dt.tile.x1; x++) {
          const sx = Math.min(tcd.w - 1, Math.floor(x / comp.dx) - tcd.x0);
          if (sx < 0) continue;
          plane[(y - siz.y0) * W + (x - siz.x0)] = tcd.data[sy * tcd.w + sx] + shift;
        }
      }
    });
  }
  // To 8 bits.
  let channels = planes.map((pl, c) => {
    const comp = siz.comps[c];
    const max = 2 ** comp.bits - 1;
    const out = new Uint8Array(W * H);
    const off = comp.signed ? 2 ** (comp.bits - 1) : 0;
    for (let i = 0; i < out.length; i++) {
      const v = Math.round(pl[i] + off);
      out[i] = Math.round((Math.max(0, Math.min(max, v)) / max) * 255);
    }
    return out;
  });
  let colorSpace = null;
  let alpha = false;
  if (jp2) {
    if (jp2.palette && jp2.cmap) {
      const mapped = [];
      for (const m of jp2.cmap) {
        const src = channels[m.cmp];
        if (!src) continue;
        if (m.mtyp === 1) {
          const bits = siz.comps[m.cmp].bits;
          const max = 2 ** bits - 1;
          const out = new Uint8Array(W * H);
          for (let i = 0; i < out.length; i++) {
            const idx = Math.round((src[i] / 255) * max);
            const e = jp2.palette.entries[Math.min(jp2.palette.entries.length - 1, idx)];
            out[i] = Math.round((e?.[m.pcol] ?? 0) * 255);
          }
          mapped.push(out);
        } else mapped.push(src);
      }
      channels = mapped;
    }
    if (jp2.cdef) {
      const ordered = [];
      const colors = jp2.cdef.filter((c) => c.typ === 0).sort((a, b) => a.asoc - b.asoc);
      for (const c of colors) if (channels[c.cn]) ordered.push(channels[c.cn]);
      const op = jp2.cdef.find((c) => c.typ === 1 || c.typ === 2);
      if (op && channels[op.cn]) {
        ordered.push(channels[op.cn]);
        alpha = true;
      }
      if (ordered.length) channels = ordered;
    }
    colorSpace = jp2.colorSpace;
  }
  if (colorSpace === 'sycc' && channels.length >= 3) {
    const [Y, Cb, Cr] = channels;
    for (let i = 0; i < Y.length; i++) {
      const y = Y[i];
      const cb = Cb[i] - 128;
      const cr = Cr[i] - 128;
      Y[i] = clamp8(y + 1.402 * cr);
      Cb[i] = clamp8(y - 0.34413 * cb - 0.71414 * cr);
      Cr[i] = clamp8(y + 1.772 * cb);
    }
    colorSpace = 'rgb';
  }
  const colorCount = channels.length - (alpha ? 1 : 0);
  if (!colorSpace || colorSpace === 'icc') colorSpace = colorCount >= 4 ? 'cmyk' : colorCount >= 3 ? 'rgb' : 'gray';
  if (!alpha && ((colorSpace === 'rgb' && channels.length === 4) || (colorSpace === 'gray' && channels.length === 2))) alpha = true;
  const comps = channels.length;
  const data = new Uint8Array(W * H * comps);
  for (let c = 0; c < comps; c++) {
    const ch = channels[c];
    for (let i = 0; i < W * H; i++) data[i * comps + c] = ch[i];
  }
  return { width: W, height: H, comps, data, colorSpace, alpha };
}

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
