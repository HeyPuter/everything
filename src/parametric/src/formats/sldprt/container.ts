// SolidWorks part files are containers of named streams. Two layouts exist:
// SolidWorks 2015 and later write a proprietary chunk container, and earlier
// versions write an OLE2 compound document. Either way the solid itself is a
// Parasolid transmit stored zlib-compressed in a few of those streams.
//
// The layouts were worked out by the sldprt-format-research and solid-diff
// projects (both MIT); see public/licenses/THIRD_PARTY_NOTICES.txt.

import { inflate } from './inflate';

export type ContainerKind = 'modern' | 'ole2';

const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const CHUNK_MARKER = [0x14, 0x00, 0x06, 0x00, 0x08, 0x00];
const SECTION_GUID = [0x23, 0x1d, 0xd5, 0x71, 0xda, 0x81, 0x48, 0xa2, 0xa8, 0x58, 0x98, 0xb2, 0x1b, 0x89, 0xef, 0x99];
const MAX_STREAM = 256 * 1024 * 1024;

export class SolidWorksError extends Error {}

const startsWith = (b: Uint8Array, magic: number[], at = 0) => magic.every((x, i) => b[at + i] === x);

function indexOf(b: Uint8Array, pat: number[], from = 0, to = b.length): number {
  const last = Math.min(to, b.length) - pat.length;
  const first = pat[0];
  outer: for (let i = from; i <= last; i++) {
    if (b[i] !== first) continue;
    for (let j = 1; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

export function containerKind(b: Uint8Array): ContainerKind | null {
  if (b.length >= 512 && startsWith(b, OLE2_MAGIC)) return 'ole2';
  if (b.length >= 32 && !(b[0] === 0x50 && b[1] === 0x4b) && indexOf(b, CHUNK_MARKER, 0, 64) >= 4) return 'modern';
  return null;
}

/** Every named stream of the file, decompressed where the container compresses them. */
export async function readStreams(b: Uint8Array): Promise<{ kind: ContainerKind; streams: Map<string, Uint8Array> }> {
  const kind = containerKind(b);
  if (kind === 'ole2') return { kind, streams: readOle2(b) };
  if (kind === 'modern') return { kind, streams: await readModern(b) };
  throw new SolidWorksError('This is not a SolidWorks part file.');
}

// ---- SolidWorks 2015+ chunk container ----
//
// Streams follow one another, each behind a 30-byte header laid out like a ZIP
// local file header: +4 the marker 14 00 06 00 08 00, +14 CRC-32, +18
// compressed size, +22 inflated size, +26 name length, +30 the name with every
// byte rotated by (file byte 7 & 7) bits, then raw DEFLATE data. Headers are
// found by scanning for the marker; false hits decode to unprintable names.

async function readModern(b: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const rot = b[7] & 7;
  const streams = new Map<string, Uint8Array>();
  let pos = 0;
  for (;;) {
    const m = indexOf(b, CHUNK_MARKER, pos);
    if (m < 0) break;
    pos = m + 1;
    const si = m - 4;
    if (si < 0 || si + 30 > b.length) continue;
    const crc = dv.getUint32(si + 14, true);
    const csz = dv.getUint32(si + 18, true);
    const nsz = dv.getUint32(si + 26, true);
    if (nsz === 0 || nsz > 1024 || csz === 0 || csz > MAX_STREAM) continue;
    const nameAt = si + 30, dataAt = nameAt + nsz, end = dataAt + csz;
    if (end > b.length) continue;
    let name = '';
    let printable = true;
    for (let i = 0; i < nsz; i++) {
      const c = ((b[nameAt + i] << rot) | (b[nameAt + i] >>> (8 - rot))) & 0xff;
      if (c < 0x20 || c >= 0x7f) { printable = false; break; }
      name += String.fromCharCode(c);
    }
    if (!printable || crc < 65536) continue;
    const data = await inflate(b.subarray(dataAt, end), 'deflate-raw', MAX_STREAM);
    if (!data) continue;
    if (!streams.has(name)) streams.set(name, data);
    pos = end;
  }
  return streams;
}

// ---- OLE2 compound document (SolidWorks 2014 and earlier) ----

const END = 0xfffffffe, FREE = 0xffffffff;

function readOle2(b: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u32 = (o: number) => { if (o + 4 > b.length) throw new SolidWorksError('The file is truncated.'); return dv.getUint32(o, true); };
  const u16 = (o: number) => dv.getUint16(o, true);
  const shift = u16(30);
  if (shift !== 9 && shift !== 12) throw new SolidWorksError('Unsupported OLE2 sector size.');
  const ss = 1 << shift;
  const nSectors = Math.floor(b.length / ss) - 1;
  const sector = (i: number) => {
    if (!Number.isInteger(i) || i < 0 || i >= nSectors) throw new SolidWorksError('The file is damaged (bad sector).');
    return b.subarray((i + 1) * ss, (i + 2) * ss);
  };
  const words = (s: Uint8Array) => {
    const v = new DataView(s.buffer, s.byteOffset, s.byteLength);
    return Array.from({ length: s.length >> 2 }, (_, i) => v.getUint32(i * 4, true));
  };
  // FAT sector list: 109 entries in the header, then the DIFAT chain.
  const fatIds: number[] = [];
  for (let i = 0; i < 109; i++) { const id = u32(76 + i * 4); if (id !== FREE) fatIds.push(id); }
  let next = u32(68);
  for (let n = u32(72), guard = 0; n > 0 && next !== END && guard < nSectors; n--, guard++) {
    const w = words(sector(next));
    fatIds.push(...w.slice(0, -1).filter((x) => x !== FREE));
    next = w[w.length - 1];
  }
  const fat: number[] = [];
  for (const id of fatIds) fat.push(...words(sector(id)));
  const chain = (start: number, table: number[], get: (i: number) => Uint8Array, unit: number, size?: number) => {
    const parts: Uint8Array[] = [];
    const seen = new Set<number>();
    let total = 0;
    for (let i = start; i !== END && i !== FREE; i = table[i]) {
      if (seen.has(i) || i >= table.length || total > MAX_STREAM) throw new SolidWorksError('The file is damaged (bad sector chain).');
      seen.add(i);
      parts.push(get(i));
      total += unit;
      if (size !== undefined && total >= size) break;
    }
    const out = new Uint8Array(size ?? total);
    let at = 0;
    for (const p of parts) { const n = Math.min(p.length, out.length - at); out.set(p.subarray(0, n), at); at += n; }
    return out;
  };
  const dir = chain(u32(48), fat, sector, ss);
  interface Entry { name: string; type: number; start: number; size: number }
  const entries: Entry[] = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const v = new DataView(dir.buffer, dir.byteOffset + o, 128);
    const type = v.getUint8(66);
    if (!type) continue;
    const len = Math.min(v.getUint16(64, true), 64);
    let name = '';
    for (let k = 0; k + 2 < len; k += 2) name += String.fromCharCode(v.getUint16(k, true));
    entries.push({ name, type, start: v.getUint32(116, true), size: v.getUint32(120, true) });
  }
  const root = entries.find((e) => e.type === 5);
  const cutoff = u32(56);
  let mini: Uint8Array | null = null, miniFat: number[] | null = null;
  const streams = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (e.type !== 2 || e.size > MAX_STREAM) continue;
    try {
      let data: Uint8Array;
      if (e.size >= cutoff) data = chain(e.start, fat, sector, ss, e.size);
      else {
        if (!root) continue;
        mini ??= chain(root.start, fat, sector, ss, root.size);
        miniFat ??= words(chain(u32(60), fat, sector, ss));
        const m = mini;
        data = chain(e.start, miniFat, (i) => m.subarray(i * 64, (i + 1) * 64), 64, e.size);
      }
      if (!streams.has(e.name)) streams.set(e.name, data);
    } catch { /* skip a damaged stream; the solid may live elsewhere */ }
  }
  return streams;
}

// ---- Parasolid transmits inside streams ----
//
// Geometry streams hold sections framed as: u32 size, a fixed 16-byte GUID,
// u32 inflated size, u32 compressed size, then a zlib member. A partition
// stream has a "(partition)" section and a "(deltas)" section; newer files
// keep imported and multibody solids in Config-N-FeatureBodies/LocalBodies.

export interface Transmit {
  stream: string;
  /** 'partition', 'deltas' or 'part' (a plain transmit). */
  kind: string;
  data: Uint8Array;
}

export async function findTransmits(streams: Map<string, Uint8Array>): Promise<Transmit[]> {
  const out: Transmit[] = [];
  for (const [name, s] of streams) {
    for (let g = indexOf(s, SECTION_GUID); g >= 0; g = indexOf(s, SECTION_GUID, g + 16)) {
      const at = g + 24;
      if (at + 2 > s.length || s[at] !== 0x78) continue;
      const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
      const csz = g + 24 <= s.length ? dv.getUint32(g + 20, true) : 0;
      const end = csz > 0 && at + csz <= s.length ? at + csz : s.length;
      const data = await inflate(s.subarray(at, end), 'deflate');
      if (!data || data[0] !== 0x50 || data[1] !== 0x53) continue; // 'PS'
      const head = new TextDecoder('latin1').decode(data.subarray(0, 120));
      const m = /TRANSMIT FILE (?:\((\w+)\) )?created/.exec(head);
      if (!m) continue;
      out.push({ stream: name, kind: m[1] ?? 'part', data });
    }
  }
  return out;
}
