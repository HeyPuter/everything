/**
 * DWG file containers: how the header, classes, object map and objects are
 * laid out in the file.
 *
 *   R13 - R2000   sections at absolute file offsets, listed in the file header
 *   R2004, R2010+ pages of LZ77-compressed data, described by an encrypted
 *                 header, a page map and a section map
 *   R2007         see r2007.js
 *
 * readContainer() returns { ver, maint, codepage, sections } where sections
 * maps names ('header', 'classes', 'handles', 'objects') to Uint8Arrays.
 * For R13 - R2000 the object map holds absolute file offsets, so 'objects'
 * is the whole file.
 */
import { R13, R14, R2000, R2004, R2007, R2010, R2013, R2018 } from './bits.js';
import { readR2007 } from './r2007.js';

export const VERSIONS = {
  AC1012: R13,
  AC1014: R14,
  AC1015: R2000,
  AC1018: R2004,
  AC1021: R2007,
  AC1024: R2010,
  AC1027: R2013,
  AC1032: R2018,
};

export const RELEASE = {
  AC1012: 'R13',
  AC1014: 'R14',
  AC1015: '2000',
  AC1018: '2004',
  AC1021: '2007',
  AC1024: '2010',
  AC1027: '2013',
  AC1032: '2018',
  AC1009: 'R11/R12',
  AC1006: 'R10',
  AC1004: 'R9',
  AC1003: '2.60',
  AC1002: '2.50',
  AC1001: '2.22',
  'AC2.10': '2.10',
};

/** Version string of a DWG file ('AC1015'...), or null when it is not one. */
export function dwgVersion(bytes) {
  if (!bytes || bytes.length < 6) return null;
  let s = '';
  for (let i = 0; i < 6; i++) s += String.fromCharCode(bytes[i]);
  if (/^AC(10\d\d|2\.\d\d|1\.\d\d)$/.test(s) || /^MC0\.0/.test(s)) return s;
  return null;
}

function u16(u8, p) {
  return u8[p] | (u8[p + 1] << 8);
}

function u32(u8, p) {
  return (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0;
}

function u64(u8, p) {
  return u32(u8, p) + u32(u8, p + 4) * 4294967296;
}

export function readContainer(u8) {
  const vs = dwgVersion(u8);
  if (!vs) throw new Error('Not a DWG file.');
  const ver = VERSIONS[vs];
  if (!ver) {
    const rel = RELEASE[vs];
    if (vs > 'AC1032' && /^AC10\d\d$/.test(vs)) {
      throw new Error(`This DWG file uses a newer format (${vs}) than this app can read. Save it as DWG 2018 or DXF and try again.`);
    }
    throw new Error(`DWG files from AutoCAD ${rel || vs} are not supported. Save the drawing as DWG R13 or later, or as DXF, and try again.`);
  }
  const maint = u8[0x0b];
  const codepage = u16(u8, 0x13);
  // R2004+: bit 0 of the security flags marks a password-protected drawing
  if (ver >= R2004 && u8.length > 0x1c && u32(u8, 0x18) & 1) {
    throw new Error('This DWG file is password protected. Remove the password in the program that saved it, then try again.');
  }
  let sections;
  if (ver <= R2000) sections = readR13(u8);
  else if (ver === R2007) sections = readR2007(u8);
  else sections = readR2004(u8);
  return { ver, version: vs, maint, codepage, sections };
}

/* ------------------------------------------------------------------ */
/* R13 - R2000                                                         */
/* ------------------------------------------------------------------ */

function readR13(u8) {
  const n = u32(u8, 0x15);
  if (n > 16) throw new Error('Damaged DWG file header.');
  const loc = {};
  for (let i = 0; i < n; i++) {
    const p = 0x19 + i * 9;
    loc[u8[p]] = { addr: u32(u8, p + 1), size: u32(u8, p + 5) };
  }
  const slice = (id) => {
    const s = loc[id];
    if (!s || s.addr >= u8.length) return null;
    return u8.subarray(s.addr, Math.min(u8.length, s.addr + s.size));
  };
  const header = slice(0);
  const classes = slice(1);
  const handles = slice(2);
  if (!header || !handles) throw new Error('Damaged DWG file: section locators are missing.');
  return { header, classes, handles, objects: u8, objectsBase: 0 };
}

/* ------------------------------------------------------------------ */
/* R2004 and R2010+                                                    */
/* ------------------------------------------------------------------ */

/** XOR pattern of the R2004 file header (a linear congruential sequence). */
export function headerMask(n) {
  const out = new Uint8Array(n);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 0x343fd) + 0x269ec3) >>> 0;
    out[i] = (seed >>> 16) & 0xff;
  }
  return out;
}

/** Decompress the R2004 LZ77 variant. */
export function decompress2004(src, start, end, outSize) {
  const out = new Uint8Array(outSize);
  let o = 0;
  let i = start;
  const rc = () => {
    if (i >= end) throw new RangeError('Compressed DWG data ends early');
    return src[i++];
  };
  let opcode = 0;
  const literalLength = () => {
    const b = rc();
    opcode = 0;
    if (b >= 0x01 && b <= 0x0f) return b + 3;
    if (b === 0) {
      let total = 0x0f;
      let x;
      while ((x = rc()) === 0) total += 0xff;
      return total + x + 3;
    }
    opcode = b;
    return 0;
  };
  const longOffset = () => {
    let total = 0;
    let b = rc();
    if (b === 0) {
      total = 0xff;
      while ((b = rc()) === 0) total += 0xff;
    }
    return total + b;
  };
  const copyLit = (n) => {
    if (o + n > outSize || i + n > end) throw new RangeError('Compressed DWG data is damaged');
    out.set(src.subarray(i, i + n), o);
    o += n;
    i += n;
  };
  copyLit(literalLength());
  while (i < end) {
    if (opcode === 0) opcode = rc();
    let n;
    let off;
    let lit;
    if (opcode >= 0x40) {
      n = (opcode >> 4) - 1;
      const b2 = rc();
      off = (b2 << 2) | ((opcode & 0x0c) >> 2);
      lit = opcode & 3;
    } else if (opcode >= 0x21) {
      n = opcode - 0x1e;
      const b1 = rc();
      const b2 = rc();
      off = (b1 >> 2) | (b2 << 6);
      lit = b1 & 3;
    } else if (opcode === 0x20) {
      n = longOffset() + 0x21;
      const b1 = rc();
      const b2 = rc();
      off = (b1 >> 2) | (b2 << 6);
      lit = b1 & 3;
    } else if (opcode >= 0x12) {
      n = (opcode & 0x0f) + 2;
      const b1 = rc();
      const b2 = rc();
      off = ((b1 >> 2) | (b2 << 6)) + 0x3fff;
      lit = b1 & 3;
    } else if (opcode === 0x10) {
      n = longOffset() + 9;
      const b1 = rc();
      const b2 = rc();
      off = ((b1 >> 2) | (b2 << 6)) + 0x3fff;
      lit = b1 & 3;
    } else if (opcode === 0x11) break;
    else throw new RangeError(`Invalid DWG compression opcode ${opcode}`);
    let s = o - off - 1;
    if (s < 0 || o + n > outSize) throw new RangeError('Compressed DWG data is damaged');
    for (let k = 0; k < n; k++) out[o++] = out[s++];
    if (lit) opcode = 0;
    else lit = literalLength();
    copyLit(lit);
  }
  return out;
}

/**
 * Compress with the R2004 LZ77 variant. Only literal runs are written,
 * which every reader accepts; inputs shorter than 4 bytes are zero-padded
 * (the section sizes say how much of the output is data).
 */
export function compress2004(data) {
  let n = data.length;
  if (n < 4) {
    const p = new Uint8Array(4);
    p.set(data);
    data = p;
    n = 4;
  }
  const head = [];
  if (n <= 18) head.push(n - 3);
  else {
    // 0x00, then (n - 18) as runs of 0x00 (255 each) and a final non-zero byte
    head.push(0);
    let rest = n - 18;
    while (rest > 255) {
      head.push(0);
      rest -= 255;
    }
    head.push(rest);
  }
  const out = new Uint8Array(head.length + n + 1);
  out.set(head, 0);
  out.set(data, head.length);
  out[out.length - 1] = 0x11;
  return out;
}

/** The R2004 page checksum (Adler-32 like, modulo 0xFFF1). */
export function checksum2004(seed, u8, start, end) {
  let s1 = seed & 0xffff;
  let s2 = (seed >>> 16) & 0xffff;
  let i = start;
  while (i < end) {
    const n = Math.min(0x15b0, end - i);
    for (let k = 0; k < n; k++) {
      s1 += u8[i++];
      s2 += s1;
    }
    s1 %= 0xfff1;
    s2 %= 0xfff1;
  }
  return ((s2 << 16) | (s1 & 0xffff)) >>> 0;
}

function systemPage(u8, addr, type) {
  if (addr + 20 > u8.length) throw new Error('Damaged DWG file: system page is outside the file.');
  const t = u32(u8, addr);
  if (t !== type) throw new Error('Damaged DWG file: unexpected system page.');
  const dsize = u32(u8, addr + 4);
  const csize = u32(u8, addr + 8);
  const ctype = u32(u8, addr + 12);
  if (ctype === 2) return decompress2004(u8, addr + 20, Math.min(u8.length, addr + 20 + csize), dsize);
  return u8.slice(addr + 20, addr + 20 + dsize);
}

export const SECTION_NAMES = {
  header: 'AcDb:Header',
  classes: 'AcDb:Classes',
  handles: 'AcDb:Handles',
  objects: 'AcDb:AcDbObjects',
};

function readR2004(u8) {
  if (u8.length < 0x100) throw new Error('Damaged DWG file header.');
  const mask = headerMask(0x6c);
  const h = new Uint8Array(0x6c);
  for (let i = 0; i < 0x6c; i++) h[i] = u8[0x80 + i] ^ mask[i];
  let id = '';
  for (let i = 0; i < 11; i++) id += String.fromCharCode(h[i]);
  if (id !== 'AcFssFcAJMB') throw new Error('Damaged DWG file header.');
  const pageMapId = u32(h, 0x50);
  const pageMapAddr = u64(h, 0x54) + 0x100;
  const sectionMapId = u32(h, 0x5c);

  // page map: page number -> file address
  const pm = systemPage(u8, pageMapAddr, 0x41630e3b);
  const pages = new Map();
  let addr = 0x100;
  for (let p = 0; p + 8 <= pm.length; ) {
    const num = u32(pm, p) | 0;
    const size = u32(pm, p + 4);
    p += 8;
    if (num < 0) p += 16;
    else pages.set(num, { addr, size });
    addr += size;
  }
  void pageMapId;

  const smPage = pages.get(sectionMapId);
  if (!smPage) throw new Error('Damaged DWG file: section map is missing.');
  const sm = systemPage(u8, smPage.addr, 0x4163003b);
  const nDesc = u32(sm, 0);
  const out = {};
  let p = 20;
  for (let d = 0; d < nDesc && p + 96 <= sm.length; d++) {
    const size = u64(sm, p);
    const pageCount = u32(sm, p + 8);
    const maxSize = u32(sm, p + 12);
    const compressed = u32(sm, p + 20);
    const encrypted = u32(sm, p + 28);
    let name = '';
    for (let k = 0; k < 64 && sm[p + 32 + k]; k++) name += String.fromCharCode(sm[p + 32 + k]);
    p += 96;
    const list = [];
    for (let k = 0; k < pageCount && p + 16 <= sm.length; k++) {
      list.push({ num: u32(sm, p), size: u32(sm, p + 4), offset: u64(sm, p + 8) });
      p += 16;
    }
    out[name] = { size, maxSize, compressed, encrypted, pages: list };
  }

  const load = (name) => {
    const s = out[name];
    if (!s || s.encrypted === 1) return null;
    let total = s.size;
    for (const pg of s.pages) total = Math.max(total, pg.offset + s.maxSize);
    const buf = new Uint8Array(total);
    for (const pg of s.pages) {
      const loc = pages.get(pg.num);
      if (!loc) continue;
      const a = loc.addr;
      const sec = 0x4164536b ^ a;
      const word = (k) => (u32(u8, a + k * 4) ^ sec) >>> 0;
      const dataSize = word(2);
      const pageSize = word(3);
      const start = a + 32;
      if (s.compressed === 2) {
        const data = decompress2004(u8, start, Math.min(u8.length, start + dataSize), Math.min(s.maxSize, Math.max(pageSize, s.maxSize)));
        buf.set(data.subarray(0, Math.min(data.length, total - pg.offset)), pg.offset);
      } else {
        buf.set(u8.subarray(start, Math.min(u8.length, start + dataSize, start + total - pg.offset)), pg.offset);
      }
    }
    return buf.subarray(0, s.size || total);
  };

  const header = load(SECTION_NAMES.header);
  const handles = load(SECTION_NAMES.handles);
  const objects = load(SECTION_NAMES.objects);
  if (!header || !handles || !objects) throw new Error('Damaged DWG file: required sections are missing.');
  return { header, classes: load(SECTION_NAMES.classes), handles, objects, objectsBase: 0 };
}
