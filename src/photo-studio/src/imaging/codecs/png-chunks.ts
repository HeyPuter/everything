// PNG chunk surgery (PNG specification, ISO/IEC 15948 / W3C PNG 3rd ed.):
// browsers encode PNG pixels but drop color profiles and resolution, so
// exports re-insert iCCP, sRGB, pHYs and text chunks into the encoded file.
import { deflate } from 'pako';
import { inflateLimited } from './inflate';

// Compressed profiles and text are capped: Deflate can expand a thousandfold.
const maxInflatedChunk = 16 * 1024 * 1024;
const inflateChunk = (z: Uint8Array) => {
  const out = inflateLimited(z, maxInflatedChunk + 1);
  if (!out || out.length > maxInflatedChunk) throw new CodecError('Compressed PNG chunk is damaged or too large.');
  return out;
};
import { ByteWriter, CodecError, asciiAt, crc32, latin1Bytes, latin1String } from './bytes';

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export type PngChunk = { type: string; data: Uint8Array; offset: number; crcValid: boolean };
export type NewChunk = { type: string; data: Uint8Array };

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v);
}

export function readPngChunks(png: Uint8Array): PngChunk[] {
  if (!isPng(png)) throw new CodecError('Not a PNG file.');
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: PngChunk[] = [];
  let p = 8;
  while (p + 12 <= png.length) {
    const len = dv.getUint32(p);
    const type = asciiAt(png, p + 4, 4);
    if (p + 12 + len > png.length) throw new CodecError(`PNG chunk ${type} is truncated.`);
    const crc = dv.getUint32(p + 8 + len);
    chunks.push({ type, data: png.subarray(p + 8, p + 8 + len), offset: p, crcValid: crc32(png, p + 4, p + 8 + len) === crc });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

export function verifyPngCrcs(png: Uint8Array): boolean {
  return readPngChunks(png).every((c) => c.crcValid);
}

export function writePngChunk(w: ByteWriter, type: string, data: Uint8Array) {
  w.u32be(data.length);
  const start = w.length;
  w.ascii(type);
  w.bytes(data);
  w.u32be(crc32(w.buf, start, w.length));
}

export function buildPng(chunks: NewChunk[]): Uint8Array {
  let size = 8;
  for (const c of chunks) size += 12 + c.data.length;
  const w = new ByteWriter(size);
  w.bytes(PNG_SIGNATURE);
  for (const c of chunks) writePngChunk(w, c.type, c.data);
  return w.result();
}

export type PngInfo = { width: number; height: number; bitDepth: number; colorType: number; interlaced: boolean };
export function readPngInfo(png: Uint8Array): PngInfo {
  const ihdr = readPngChunks(png).find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) throw new CodecError('PNG has no IHDR chunk.');
  const dv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, 13);
  return { width: dv.getUint32(0), height: dv.getUint32(4), bitDepth: ihdr.data[8], colorType: ihdr.data[9], interlaced: ihdr.data[12] === 1 };
}

// Chunks that must precede PLTE and IDAT go right after IHDR.
const EARLY = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'sBIT', 'cICP', 'mDCv', 'cLLi']);
const UNIQUE = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'sBIT', 'pHYs', 'tIME', 'cICP', 'eXIf', 'oFFs', 'sCAL']);
const TEXT = new Set(['tEXt', 'zTXt', 'iTXt']);
const textKey = (c: { type: string; data: Uint8Array }) => {
  const z = c.data.indexOf(0);
  return latin1String(c.data.subarray(0, z < 0 ? c.data.length : z));
};

// Inserts chunks, replacing existing chunks of the same unique type (and text
// chunks with the same keyword). iCCP and sRGB exclude each other.
export function insertPngChunks(png: Uint8Array, add: NewChunk[]): Uint8Array {
  const chunks = readPngChunks(png);
  if (chunks[0]?.type !== 'IHDR') throw new CodecError('PNG does not start with IHDR.');
  const addTypes = new Set(add.map((c) => c.type));
  if (addTypes.has('iCCP')) addTypes.add('sRGB');
  else if (addTypes.has('sRGB')) addTypes.add('iCCP');
  const addKeys = new Set(add.filter((c) => TEXT.has(c.type)).map(textKey));
  const kept = chunks.filter((c) => !((UNIQUE.has(c.type) && addTypes.has(c.type)) || (TEXT.has(c.type) && addKeys.has(textKey(c)))));
  const early = add.filter((c) => EARLY.has(c.type));
  const late = add.filter((c) => !EARLY.has(c.type));
  const out: NewChunk[] = [];
  let placedLate = false;
  for (const c of kept) {
    if (c.type === 'IDAT' && !placedLate) {
      out.push(...late);
      placedLate = true;
    }
    if (c.type === 'IEND' && !placedLate) {
      out.push(...late);
      placedLate = true;
    }
    out.push({ type: c.type, data: c.data });
    if (c.type === 'IHDR') out.push(...early);
  }
  if (!placedLate) out.push(...late);
  if (out[out.length - 1].type !== 'IEND') out.push({ type: 'IEND', data: new Uint8Array(0) });
  return buildPng(out);
}

export function removePngChunks(png: Uint8Array, types: string[]): Uint8Array {
  const drop = new Set(types);
  return buildPng(readPngChunks(png).filter((c) => !drop.has(c.type)));
}

// iCCP: Latin-1 profile name (1-79 bytes), NUL, method 0, zlib stream.
export function makeIccpChunk(profile: Uint8Array, name = 'ICC Profile'): NewChunk {
  const n = latin1Bytes(name.replace(/[^\x20-\x7e\xa1-\xff]/g, '').trim().slice(0, 79) || 'ICC Profile');
  const z = deflate(profile, { level: 9 });
  const data = new Uint8Array(n.length + 2 + z.length);
  data.set(n);
  data.set(z, n.length + 2);
  return { type: 'iCCP', data };
}
export function readPngIcc(png: Uint8Array): { name: string; profile: Uint8Array } | undefined {
  const c = readPngChunks(png).find((k) => k.type === 'iCCP');
  if (!c) return undefined;
  const z = c.data.indexOf(0);
  if (z < 1 || c.data[z + 1] !== 0) return undefined;
  try {
    return { name: latin1String(c.data.subarray(0, z)), profile: inflateChunk(c.data.subarray(z + 2)) };
  } catch {
    return undefined; // corrupt zlib stream
  }
}

// pHYs in pixels per metre (unit 1).
export function makePhysChunk(dpiX: number, dpiY = dpiX): NewChunk {
  const data = new Uint8Array(9);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, Math.round(dpiX / 0.0254));
  dv.setUint32(4, Math.round(dpiY / 0.0254));
  data[8] = 1;
  return { type: 'pHYs', data };
}
export function readPngDpi(png: Uint8Array): { x: number; y: number } | undefined {
  const c = readPngChunks(png).find((k) => k.type === 'pHYs');
  if (!c || c.data.length < 9 || c.data[8] !== 1) return undefined;
  const dv = new DataView(c.data.buffer, c.data.byteOffset, 9);
  return { x: Math.round(dv.getUint32(0) * 0.254) / 10, y: Math.round(dv.getUint32(4) * 0.254) / 10 };
}

// sRGB rendering intent: 0 perceptual, 1 relative, 2 saturation, 3 absolute.
export function makeSrgbChunk(intent = 0): NewChunk {
  return { type: 'sRGB', data: new Uint8Array([intent & 3]) };
}

const keyword = (k: string) => k.replace(/[^\x20-\x7e\xa1-\xff]/g, '').trim().slice(0, 79) || 'Comment';
// tEXt when the text is Latin-1, otherwise iTXt (UTF-8).
export function makeTextChunk(key: string, text: string): NewChunk {
  if (/^[\x00-\xff]*$/.test(text) && !text.includes('\0')) {
    const k = latin1Bytes(keyword(key));
    const t = latin1Bytes(text);
    const data = new Uint8Array(k.length + 1 + t.length);
    data.set(k);
    data.set(t, k.length + 1);
    return { type: 'tEXt', data };
  }
  return makeItxtChunk(key, text);
}
export function makeItxtChunk(key: string, text: string, opts: { language?: string; translatedKey?: string; compress?: boolean } = {}): NewChunk {
  const enc = new TextEncoder();
  const k = latin1Bytes(keyword(key));
  const lang = latin1Bytes(opts.language ?? '');
  const tk = enc.encode(opts.translatedKey ?? '');
  const body = opts.compress ? deflate(enc.encode(text)) : enc.encode(text);
  const w = new ByteWriter(k.length + lang.length + tk.length + body.length + 5);
  w.bytes(k);
  w.u8(0);
  w.u8(opts.compress ? 1 : 0);
  w.u8(0);
  w.bytes(lang);
  w.u8(0);
  w.bytes(tk);
  w.u8(0);
  w.bytes(body);
  return { type: 'iTXt', data: w.result() };
}
export function readPngText(png: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of readPngChunks(png)) {
    if (!TEXT.has(c.type)) continue;
    const d = c.data;
    const z = d.indexOf(0);
    if (z < 0) continue;
    const key = latin1String(d.subarray(0, z));
    try {
      if (c.type === 'tEXt') out[key] = latin1String(d.subarray(z + 1));
      else if (c.type === 'zTXt') out[key] = latin1String(inflateChunk(d.subarray(z + 2)));
      else {
        const compressed = d[z + 1] === 1;
        const l = d.indexOf(0, z + 3);
        const t = d.indexOf(0, l + 1);
        if (l < 0 || t < 0) continue;
        const body = d.subarray(t + 1);
        out[key] = new TextDecoder().decode(compressed ? inflateChunk(body) : body);
      }
    } catch {
      // Skip a corrupt compressed text chunk rather than failing the read.
    }
  }
  return out;
}

export type PngMetadata = {
  icc?: Uint8Array;
  iccName?: string;
  // Writes sRGB instead of iCCP (ignored when an ICC profile is given).
  srgbIntent?: number;
  dpi?: number;
  text?: Record<string, string>;
};
export function embedPngMetadata(png: Uint8Array, meta: PngMetadata): Uint8Array {
  const add: NewChunk[] = [];
  if (meta.icc?.length) add.push(makeIccpChunk(meta.icc, meta.iccName));
  else if (meta.srgbIntent !== undefined) add.push(makeSrgbChunk(meta.srgbIntent));
  if (meta.dpi && meta.dpi > 0) add.push(makePhysChunk(meta.dpi));
  for (const [k, v] of Object.entries(meta.text ?? {})) add.push(makeTextChunk(k, v));
  return add.length ? insertPngChunks(png, add) : png;
}
