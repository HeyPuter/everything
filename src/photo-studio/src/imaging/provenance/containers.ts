// Where provenance lives inside image files.
// - XMP packet: PNG iTXt chunk with the keyword "Provenance"; JPEG APP1
//   segment whose identifier is our own "Photo Studio provenance\0"; WebP
//   'XMP ' chunk in the extended (VP8X) layout (WebP container spec); TIFF
//   tag 700 (TIFF 6.0 / XMP), written by appending a rewritten IFD0.
// - C2PA manifest store (C2PA technical specification, "Embedding manifests"):
//   PNG 'caBX' chunk right after IHDR; JPEG APP11 segments in the JPEG-1
//   packaging of ISO/IEC 19566-5 (CI "JP", box instance En, sequence Z, the
//   superbox LBox/TBox repeated in every segment).
import { CodecError, asciiAt, concatBytes } from '../codecs/bytes';
import { buildPng, insertPngChunks, isPng, makeItxtChunk, readPngChunks, readPngText } from '../codecs/png-chunks';
import { isJpeg, readJpegSegments } from '../codecs/jpeg-markers';
import { readWebpChunks } from '../codecs/webp-anim';

export type ProvenanceFormat = 'png' | 'jpeg' | 'webp' | 'tiff';
export function provenanceFormat(b: Uint8Array): ProvenanceFormat | undefined {
  if (isPng(b)) return 'png';
  if (isJpeg(b)) return 'jpeg';
  if (b.length >= 12 && asciiAt(b, 0, 4) === 'RIFF' && asciiAt(b, 8, 4) === 'WEBP') return 'webp';
  if (b.length >= 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42))) return 'tiff';
  return undefined;
}

export const PNG_XMP_KEYWORD = 'Provenance';
export const JPEG_XMP_ID = 'Photo Studio provenance\0';
const enc = new TextEncoder(),
  dec = new TextDecoder();

// ----- XMP -----
export function readXmpPacket(b: Uint8Array, format: ProvenanceFormat): string | undefined {
  switch (format) {
    case 'png':
      return readPngText(b)[PNG_XMP_KEYWORD];
    case 'jpeg': {
      const id = enc.encode(JPEG_XMP_ID);
      const s = readJpegSegments(b).segments.find((s) => s.marker === 0xe1 && id.every((v, i) => s.data[i] === v));
      return s && dec.decode(s.data.subarray(id.length));
    }
    case 'webp': {
      const c = readWebpChunks(b).find((c) => c.fourcc === 'XMP ');
      return c && dec.decode(c.data);
    }
    case 'tiff': {
      const ifd = readIfd0(b);
      const e = ifd.entries.find((e) => e.tag === 700);
      if (!e) return undefined;
      const size = (TYPE_SIZE[e.type] ?? 1) * e.count;
      const at = size <= 4 ? e.at + 8 : ifd.u32(e.at + 8);
      return at + size <= b.length ? dec.decode(b.subarray(at, at + size)) : undefined;
    }
  }
}

export function writeXmpPacket(b: Uint8Array, format: ProvenanceFormat, packet: string, size?: { width: number; height: number }): Uint8Array {
  const data = enc.encode(packet);
  switch (format) {
    case 'png':
      // insertPngChunks replaces a text chunk with the same keyword.
      return insertPngChunks(b, [makeItxtChunk(PNG_XMP_KEYWORD, packet)]);
    case 'jpeg': {
      const id = enc.encode(JPEG_XMP_ID);
      const body = concatBytes([id, data]);
      if (body.length + 2 > 0xffff) throw new CodecError('The provenance packet is too large for a JPEG segment.');
      const isOurs = (s: { marker: number; data: Uint8Array }) => s.marker === 0xe1 && id.every((v, i) => s.data[i] === v);
      return jpegRebuild(b, isOurs, [segment(0xe1, body)]).bytes;
    }
    case 'webp':
      return webpWithXmp(b, data, size);
    case 'tiff':
      return tiffWithXmp(b, data);
  }
}

function segment(marker: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 4);
  out.set([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 255]);
  out.set(data, 4);
  return out;
}
type Seg = { marker: number; offset: number; end: number; data: Uint8Array };
const standalone = (m: number) => m === 0xd8 || m === 0xd9 || m === 0x01 || (m >= 0xd0 && m <= 0xd7);
/** Header segments (through SOS) with their byte ranges. */
function jpegSegments(b: Uint8Array): { segs: Seg[]; scan: number } {
  const segs = readJpegSegments(b).segments.map((s) => ({ ...s, end: s.offset + (standalone(s.marker) ? 2 : 4 + s.data.length) }));
  const sos = segs.find((s) => s.marker === 0xda);
  if (!sos) throw new CodecError('JPEG has no image data.');
  return { segs, scan: sos.offset };
}
/** Drop segments matching `drop` and insert `add` after SOI and the leading
 * APP0-APP2 segments; returns the file and where `add` starts. */
function jpegRebuild(b: Uint8Array, drop: (s: Seg) => boolean, add: Uint8Array[]): { bytes: Uint8Array; at: number } {
  const { segs, scan } = jpegSegments(b);
  const kept = segs.slice(1).filter((s) => s.marker !== 0xda && !drop(s));
  let i = 0;
  while (i < kept.length && kept[i].marker >= 0xe0 && kept[i].marker <= 0xe2) i++;
  const lead = kept.slice(0, i).map((s) => b.subarray(s.offset, s.end));
  const at = 2 + lead.reduce((n, x) => n + x.length, 0);
  return { bytes: concatBytes([b.subarray(0, 2), ...lead, ...add, ...kept.slice(i).map((s) => b.subarray(s.offset, s.end)), b.subarray(scan)]), at };
}

// ----- WebP -----
function webpCanvas(chunks: { fourcc: string; data: Uint8Array }[]): { width: number; height: number; alpha: boolean } | undefined {
  const u24 = (d: Uint8Array, p: number) => d[p] | (d[p + 1] << 8) | (d[p + 2] << 16);
  const x = chunks.find((c) => c.fourcc === 'VP8X');
  if (x && x.data.length >= 10) return { width: u24(x.data, 4) + 1, height: u24(x.data, 7) + 1, alpha: !!(x.data[0] & 0x10) };
  const l = chunks.find((c) => c.fourcc === 'VP8L');
  if (l && l.data.length >= 5 && l.data[0] === 0x2f) {
    const v = l.data[1] | (l.data[2] << 8) | (l.data[3] << 16) | (l.data[4] << 24);
    return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1, alpha: !!((v >>> 28) & 1) };
  }
  const k = chunks.find((c) => c.fourcc === 'VP8 ');
  if (k && k.data.length >= 10 && k.data[3] === 0x9d && k.data[4] === 0x01 && k.data[5] === 0x2a)
    return { width: (k.data[6] | (k.data[7] << 8)) & 0x3fff, height: (k.data[8] | (k.data[9] << 8)) & 0x3fff, alpha: chunks.some((c) => c.fourcc === 'ALPH') };
  return undefined;
}
function riff(chunks: { fourcc: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const c of chunks) {
    const h = new Uint8Array(8);
    for (let i = 0; i < 4; i++) h[i] = c.fourcc.charCodeAt(i);
    new DataView(h.buffer).setUint32(4, c.data.length, true);
    parts.push(h, c.data);
    if (c.data.length & 1) parts.push(new Uint8Array(1));
  }
  const body = concatBytes(parts);
  const head = new Uint8Array(12);
  head.set(enc.encode('RIFF'));
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set(enc.encode('WEBP'), 8);
  return concatBytes([head, body]);
}
function webpWithXmp(b: Uint8Array, xmp: Uint8Array, size?: { width: number; height: number }): Uint8Array {
  const chunks = readWebpChunks(b).filter((c) => c.fourcc !== 'XMP ');
  let x = chunks.find((c) => c.fourcc === 'VP8X');
  if (!x) {
    const canvas = webpCanvas(chunks) ?? (size ? { ...size, alpha: false } : undefined);
    if (!canvas) throw new CodecError('Cannot read the WebP image size.');
    const d = new Uint8Array(10);
    const put = (p: number, v: number) => d.set([v & 255, (v >> 8) & 255, (v >> 16) & 255], p);
    d[0] = canvas.alpha || chunks.some((c) => c.fourcc === 'ALPH') ? 0x10 : 0;
    put(4, canvas.width - 1);
    put(7, canvas.height - 1);
    x = { fourcc: 'VP8X', data: d };
    chunks.unshift(x);
  } else x.data = x.data.slice();
  // Flags: ICC 0x20, alpha 0x10, EXIF 0x08, XMP 0x04, animation 0x02.
  x.data[0] |= 0x04;
  // XMP comes last (after EXIF) in the extended layout.
  return riff([...chunks, { fourcc: 'XMP ', data: xmp }]);
}

// ----- TIFF (classic, 32-bit offsets) -----
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
type IfdEntry = { tag: number; type: number; count: number; at: number };
function readIfd0(b: Uint8Array) {
  const le = b[0] === 0x49;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (p: number) => dv.getUint16(p, le),
    u32 = (p: number) => dv.getUint32(p, le);
  if (b.length < 8 || u16(2) !== 42) throw new CodecError('Only classic TIFF files can carry provenance here.');
  const at = u32(4);
  if (at + 2 > b.length) throw new CodecError('TIFF IFD is out of range.');
  const n = u16(at);
  if (at + 2 + n * 12 + 4 > b.length) throw new CodecError('TIFF IFD is truncated.');
  const entries: IfdEntry[] = [];
  for (let i = 0; i < n; i++) {
    const p = at + 2 + i * 12;
    entries.push({ tag: u16(p), type: u16(p + 2), count: u32(p + 4), at: p });
  }
  return { le, at, entries, next: u32(at + 2 + n * 12), u16, u32 };
}
function tiffWithXmp(b: Uint8Array, xmp: Uint8Array): Uint8Array {
  const ifd = readIfd0(b);
  const entries = ifd.entries.filter((e) => e.tag !== 700);
  const pad = (n: number) => n + (n & 1);
  const xmpAt = pad(b.length),
    ifdAt = pad(xmpAt + xmp.length);
  const count = entries.length + 1;
  const out = new Uint8Array(ifdAt + 2 + count * 12 + 4);
  out.set(b);
  out.set(xmp, xmpAt);
  const dv = new DataView(out.buffer);
  const raw = [...entries.map((e) => ({ tag: e.tag, bytes: b.subarray(e.at, e.at + 12) })), { tag: 700, bytes: new Uint8Array(12) }].sort((a, c) => a.tag - c.tag);
  dv.setUint16(ifdAt, count, ifd.le);
  raw.forEach((e, i) => {
    const p = ifdAt + 2 + i * 12;
    if (e.tag !== 700) return out.set(e.bytes, p);
    dv.setUint16(p, 700, ifd.le);
    dv.setUint16(p + 2, 1, ifd.le); // BYTE
    dv.setUint32(p + 4, xmp.length, ifd.le);
    // Values of four bytes or fewer sit in the entry itself.
    if (xmp.length <= 4) out.set(xmp, p + 8);
    else dv.setUint32(p + 8, xmpAt, ifd.le);
  });
  dv.setUint32(ifdAt + 2 + count * 12, ifd.next, ifd.le);
  dv.setUint32(4, ifdAt, ifd.le);
  return out;
}

// ----- C2PA manifest store containers -----
export type StoreLocation = { store: Uint8Array; start: number; length: number };
export const supportsC2pa = (f: ProvenanceFormat) => f === 'png' || f === 'jpeg';

const APP11 = 0xeb;
type App11 = Seg & { en: number; z: number };
function app11(b: Uint8Array): App11[] {
  return jpegSegments(b).segs.flatMap((s) =>
    s.marker === APP11 && s.data.length >= 16 && s.data[0] === 0x4a && s.data[1] === 0x50 ? [{ ...s, en: (s.data[2] << 8) | s.data[3], z: new DataView(s.data.buffer, s.data.byteOffset).getUint32(4) }] : [],
  );
}
/** Instance numbers of APP11 JUMBF boxes that hold a C2PA manifest store. */
function c2paInstances(segs: App11[]): Set<number> {
  const uuid = enc.encode('c2pa');
  // First segment: CI En Z, then LBox TBox 'jumb', then 'jumd' header and its UUID.
  return new Set(segs.filter((s) => s.z === 1 && asciiAt(s.data, 12, 4) === 'jumb' && asciiAt(s.data, 20, 4) === 'jumd' && uuid.every((v, i) => s.data[24 + i] === v)).map((s) => s.en));
}

export function readStore(b: Uint8Array, format: ProvenanceFormat): StoreLocation | undefined {
  if (format === 'png') {
    const c = readPngChunks(b).find((c) => c.type === 'caBX');
    return c && { store: c.data, start: c.offset, length: c.data.length + 12 };
  }
  if (format !== 'jpeg') return undefined;
  const segs = app11(b);
  const [en] = c2paInstances(segs);
  if (en === undefined) return undefined;
  const mine = segs.filter((s) => s.en === en).sort((a, c) => a.z - c.z);
  // Each segment repeats the 8-byte box header; the first keeps it.
  const store = concatBytes(mine.map((s, i) => s.data.subarray(i === 0 ? 8 : 16)));
  const start = Math.min(...mine.map((s) => s.offset)),
    end = Math.max(...mine.map((s) => s.end));
  return { store, start, length: end - start };
}

export function stripStore(b: Uint8Array, format: ProvenanceFormat): Uint8Array {
  if (format === 'png') return buildPng(readPngChunks(b).filter((c) => c.type !== 'caBX'));
  if (format !== 'jpeg') return b;
  const ens = c2paInstances(app11(b));
  if (!ens.size) return b;
  return jpegRebuild(b, (s) => s.marker === APP11 && s.data.length >= 4 && s.data[0] === 0x4a && s.data[1] === 0x50 && ens.has((s.data[2] << 8) | s.data[3]), []).bytes;
}

/** Insert a store into a file without one; returns where it landed. */
export function insertStore(b: Uint8Array, format: ProvenanceFormat, store: Uint8Array): { bytes: Uint8Array; start: number; length: number } {
  if (format === 'png') {
    const chunks = readPngChunks(b);
    if (chunks[0]?.type !== 'IHDR') throw new CodecError('PNG does not start with IHDR.');
    const out = buildPng([chunks[0], { type: 'caBX', data: store }, ...chunks.slice(1)]);
    return { bytes: out, start: 8 + 12 + chunks[0].data.length, length: store.length + 12 };
  }
  if (format !== 'jpeg') throw new CodecError(`C2PA manifests are not written to ${format.toUpperCase()} files.`);
  if (store.length < 8) throw new CodecError('Manifest store is too short.');
  const used = new Set(app11(b).map((s) => s.en));
  let en = 1;
  while (used.has(en)) en++;
  const head = store.subarray(0, 8),
    payload = store.subarray(8);
  const MAX = 0xffff - 2 - 2 - 2 - 4 - 8;
  const segs: Uint8Array[] = [];
  for (let p = 0, z = 1; p < payload.length || z === 1; p += MAX, z++) {
    const chunk = payload.subarray(p, p + MAX);
    const d = new Uint8Array(16 + chunk.length);
    const dv = new DataView(d.buffer);
    d.set([0x4a, 0x50]);
    dv.setUint16(2, en);
    dv.setUint32(4, z);
    d.set(head, 8);
    d.set(chunk, 16);
    segs.push(segment(APP11, d));
  }
  const { bytes, at } = jpegRebuild(b, () => false, segs);
  return { bytes, start: at, length: segs.reduce((n, s) => n + s.length, 0) };
}
