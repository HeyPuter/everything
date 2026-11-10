/**
 * The DWG 2007 (AC1021) container. Its file header and pages are
 * Reed-Solomon encoded (interleaved (255, 239) and (255, 251) blocks; the
 * parity bytes are only skipped here) and compressed with an LZ variant of
 * its own whose literal runs are stored with their 4-byte units reversed.
 */

const DATA_BYTES = 0xfb; // data bytes per RS block of data pages
const SYS_BYTES = 0xef; // data bytes per RS block of system pages and the header

function u64(u8, p) {
  const lo = (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0;
  const hi = (u8[p + 4] | (u8[p + 5] << 8) | (u8[p + 6] << 16) | (u8[p + 7] << 24)) | 0;
  return lo + hi * 4294967296;
}

/** Undo the interleaving of `count` RS blocks of `k` data bytes each. */
export function deinterleave(src, start, count, k) {
  const out = new Uint8Array(count * k);
  for (let b = 0; b < count; b++) {
    for (let j = 0; j < k; j++) {
      const s = start + j * count + b;
      out[b * k + j] = s < src.length ? src[s] : 0;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Decompression                                                       */
/* ------------------------------------------------------------------ */

// How the remainder of a literal run (length % 32) is split into units of
// 1, 4 and 8 bytes, in source order. The units are written in reverse order
// (the last source unit first); bytes inside a unit keep their order.
const UNITS = [
  [],
  [1],
  [1, 1],
  [1, 1, 1],
  [4],
  [4, 1],
  [1, 4, 1],
  [1, 4, 1, 1],
  [8],
  [8, 1],
  [1, 8, 1],
  [1, 8, 1, 1],
  [8, 4],
  [8, 4, 1],
  [1, 8, 4, 1],
  [1, 8, 4, 1, 1],
  [8, 8],
  [8, 1, 8],
  [1, 8, 8, 1],
  [8, 8, 1, 1, 1],
  [8, 8, 4],
  [8, 8, 4, 1],
  [8, 8, 4, 1, 1],
  [8, 8, 4, 1, 1, 1],
  [8, 8, 8],
  [8, 8, 1, 8],
  [8, 8, 1, 8, 1],
  [8, 8, 1, 8, 1, 1],
  [8, 8, 8, 4],
  [8, 8, 8, 4, 1],
  [8, 8, 8, 4, 1, 1],
  [1, 1, 8, 8, 8, 4, 1],
];

/** Copy a literal run: the units of the source in reverse order. */
function copyLiteral(dst, d, src, s, len) {
  while (len >= 32) {
    // four 8-byte units, reversed
    for (let u = 0; u < 4; u++) dst.set(src.subarray(s + (3 - u) * 8, s + (4 - u) * 8), d + u * 8);
    s += 32;
    d += 32;
    len -= 32;
  }
  const units = UNITS[len];
  let e = s + len;
  let o = d;
  // walking the source from its end yields the units in output order
  for (let k = units.length - 1; k >= 0; k--) {
    const n = units[k];
    e -= n;
    for (let j = 0; j < n; j++) dst[o++] = src[e + j];
  }
}

export function decompress2007(src, start, srcLen, outSize) {
  const dst = new Uint8Array(outSize);
  let s = start;
  const end = start + srcLen;
  let d = 0;
  let length = 0;
  let offset = 0;
  const next = () => {
    if (s >= src.length) throw new RangeError('Compressed DWG data ends early');
    return src[s++];
  };
  let opcode = next();
  if ((opcode & 0xf0) === 0x20) {
    s += 2;
    length = next() & 0x07;
    if (length === 0) throw new RangeError('Invalid DWG 2007 compressed data');
  }
  const literalLength = (op) => {
    let n = op + 8;
    if (n === 0x17) {
      let x = next();
      n += x;
      if (x === 0xff) {
        do {
          x = next();
          x |= next() << 8;
          n += x;
        } while (x === 0xffff);
      }
    }
    return n;
  };
  const instructions = () => {
    switch (opcode >> 4) {
      case 0: {
        length = (opcode & 0xf) + 0x13;
        offset = next();
        opcode = next();
        length = ((opcode >> 3) & 0x10) + length;
        offset = ((opcode & 0x78) << 5) + 1 + offset;
        break;
      }
      case 1: {
        length = (opcode & 0xf) + 3;
        offset = next();
        opcode = next();
        offset = ((opcode & 0xf8) << 5) + 1 + offset;
        break;
      }
      case 2: {
        offset = next();
        offset = ((next() << 8) & 0xff00) | offset;
        length = opcode & 7;
        if ((opcode & 8) === 0) {
          opcode = next();
          length = (opcode & 0xf8) + length;
        } else {
          offset++;
          length = (next() << 3) + length;
          opcode = next();
          length = ((opcode & 0xf8) << 8) + length + 0x100;
        }
        break;
      }
      default: {
        length = opcode >> 4;
        offset = opcode & 15;
        opcode = next();
        offset = ((opcode & 0xf8) << 1) + offset + 1;
        break;
      }
    }
  };
  while (s < end) {
    if (length === 0) length = literalLength(opcode);
    if (d + length > outSize || s + length > src.length) throw new RangeError('DWG 2007 compressed data is damaged');
    copyLiteral(dst, d, src, s, length);
    d += length;
    s += length;
    length = 0;
    if (s >= end) break;
    opcode = next();
    instructions();
    for (;;) {
      if (offset > d || d + length > outSize) throw new RangeError('DWG 2007 compressed data is damaged');
      for (let k = 0; k < length; k++) dst[d + k] = dst[d - offset + k];
      d += length;
      length = opcode & 7;
      if (length !== 0 || s >= end) break;
      opcode = next();
      if (opcode >> 4 === 0) break;
      if (opcode >> 4 === 0x0f) opcode &= 0xf;
      instructions();
    }
  }
  return dst;
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

export function systemPage(u8, addr, compSize, uncompSize, factor) {
  const pesize = ((compSize + 7) & ~7) * factor;
  const blocks = Math.ceil(pesize / SYS_BYTES);
  const data = deinterleave(u8, addr, blocks, SYS_BYTES);
  if (compSize < uncompSize) return decompress2007(data, 0, compSize, uncompSize);
  return data.subarray(0, uncompSize);
}

export function readHeaderData(u8) {
  const raw = deinterleave(u8, 0x80, 3, SYS_BYTES);
  const compLen = raw[24] | (raw[25] << 8) | (raw[26] << 16) | (raw[27] << 24);
  if (compLen === 0) throw new Error('Damaged DWG 2007 file header.');
  if (compLen < 0) return raw.slice(32, 32 + -compLen);
  return decompress2007(raw, 32, compLen, 0x110);
}

export function readR2007(u8) {
  const h = readHeaderData(u8);
  const f = (k) => u64(h, k);
  const pagesMapOffset = f(0x38);
  const pagesMapComp = f(0x50);
  const pagesMapUncomp = f(0x58);
  const pagesMapFactor = f(0x18);
  const sectionsMapId = f(0xc0);
  const sectionsMapComp = f(0xb0);
  const sectionsMapUncomp = f(0xc8);
  const sectionsMapFactor = f(0xd8);

  const pm = systemPage(u8, 0x480 + pagesMapOffset, pagesMapComp, pagesMapUncomp, pagesMapFactor || 1);
  const pages = new Map();
  let off = 0;
  for (let p = 0; p + 16 <= pm.length; p += 16) {
    const size = u64(pm, p);
    const id = u64(pm, p + 8);
    if (size <= 0) break;
    pages.set(Math.abs(id), { offset: off, size });
    off += size;
  }

  const smPage = pages.get(sectionsMapId);
  if (!smPage) throw new Error('Damaged DWG 2007 file: section map is missing.');
  const sm = systemPage(u8, 0x480 + smPage.offset, sectionsMapComp, sectionsMapUncomp, sectionsMapFactor || 1);
  const sections = {};
  let p = 0;
  while (p + 64 <= sm.length) {
    const dataSize = u64(sm, p);
    const maxSize = u64(sm, p + 8);
    const encrypted = u64(sm, p + 16);
    const nameLen = u64(sm, p + 32);
    const encoded = u64(sm, p + 48);
    const numPages = u64(sm, p + 56);
    p += 64;
    let name = '';
    for (let k = 0; k + 1 < nameLen; k += 2) {
      const c = sm[p + k] | (sm[p + k + 1] << 8);
      if (!c) break;
      name += String.fromCharCode(c);
    }
    p += nameLen;
    const list = [];
    for (let k = 0; k < numPages && p + 56 <= sm.length; k++) {
      list.push({
        offset: u64(sm, p),
        size: u64(sm, p + 8),
        id: u64(sm, p + 16),
        uncomp: u64(sm, p + 24),
        comp: u64(sm, p + 32),
      });
      p += 56;
    }
    if (name) sections[name] = { dataSize, maxSize, encrypted, encoded, pages: list };
  }

  const load = (name) => {
    const s = sections[name];
    if (!s || s.encrypted === 1) return null;
    let total = s.dataSize;
    for (const pg of s.pages) total = Math.max(total, pg.offset + pg.uncomp);
    const buf = new Uint8Array(total);
    for (const pg of s.pages) {
      const loc = pages.get(pg.id);
      if (!loc) continue;
      const addr = 0x480 + loc.offset;
      let data;
      let start = addr;
      if (s.encoded === 4) {
        const pesize = (pg.comp + 7) & ~7;
        const blocks = Math.ceil(pesize / DATA_BYTES);
        data = deinterleave(u8, addr, blocks, DATA_BYTES);
        start = 0;
      } else data = u8;
      const out = pg.comp < pg.uncomp ? decompress2007(data, start, pg.comp, pg.uncomp) : data.subarray(start, start + pg.uncomp);
      buf.set(out.subarray(0, Math.min(out.length, total - pg.offset)), pg.offset);
    }
    return buf.subarray(0, s.dataSize || total);
  };

  const header = load('AcDb:Header');
  const handles = load('AcDb:Handles');
  const objects = load('AcDb:AcDbObjects');
  if (!header || !handles || !objects) throw new Error('Damaged DWG 2007 file: required sections are missing.');
  return { header, classes: load('AcDb:Classes'), handles, objects, objectsBase: 0 };
}
