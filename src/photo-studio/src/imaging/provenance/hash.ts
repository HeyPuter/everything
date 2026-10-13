// SHA-256 of an image's pixel data, independent of the metadata around it,
// so attaching or editing metadata keeps the hash while any change to the
// image does not. Methods (recorded next to the hash):
// - png-samples-v1: IHDR fields (13 bytes), PLTE and tRNS for palette images,
//   then the unfiltered scanlines of the inflated IDAT stream without their
//   filter-type bytes (PNG 3rd ed. §7, §9); recompressing keeps the hash.
// - png-idat-v1: the concatenated compressed IDAT data (interlaced files).
// - jpeg-scan-v1: every segment except APP0-APP15 and COM, plus the
//   entropy-coded data through EOI (T.81 annex B).
// - webp-bitstream-v1: fourcc and payload of each ALPH, VP8, VP8L and ANMF chunk.
// - tiff-samples-v1: width, height and channel count (u32 LE) followed by the
//   decoded samples of the first page (16-bit or float data when present,
//   otherwise 8-bit RGBA).
import { inflate } from 'pako';
import { CodecError, concatBytes } from '../codecs/bytes';
import { readPngChunks } from '../codecs/png-chunks';
import { decodeTiff } from '../codecs/tiff';
import { readWebpChunks } from '../codecs/webp-anim';
import type { ProvenanceFormat } from './containers';

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
}
export const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function paeth(a: number, b: number, c: number) {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function pngData(png: Uint8Array): { method: string; data: Uint8Array } {
  const chunks = readPngChunks(png);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length !== 13) throw new CodecError('PNG has no IHDR chunk.');
  const idat = concatBytes(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const dv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, 13);
  const width = dv.getUint32(0),
    height = dv.getUint32(4),
    depth = ihdr.data[8],
    color = ihdr.data[9];
  if (ihdr.data[12] !== 0) return { method: 'png-idat-v1', data: idat };
  const channels = CHANNELS[color];
  if (!channels) throw new CodecError('Unsupported PNG color type.');
  const bpp = Math.max(1, (channels * depth) >> 3),
    row = Math.ceil((width * channels * depth) / 8);
  const raw = inflate(idat);
  if (raw.length < height * (row + 1)) throw new CodecError('PNG image data is truncated.');
  const extra = color === 3 ? chunks.filter((c) => c.type === 'PLTE' || c.type === 'tRNS').map((c) => c.data) : [];
  const out = new Uint8Array(height * row);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (row + 1)];
    const src = raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1));
    const o = y * row;
    for (let i = 0; i < row; i++) {
      const a = i >= bpp ? out[o + i - bpp] : 0,
        b = y ? out[o - row + i] : 0,
        c = y && i >= bpp ? out[o - row + i - bpp] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : -1;
      if (pred < 0) throw new CodecError('Unknown PNG filter type.');
      out[o + i] = (src[i] + pred) & 255;
    }
  }
  return { method: 'png-samples-v1', data: concatBytes([ihdr.data, ...extra, out]) };
}
function jpegData(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let p = 2;
  while (p < b.length) {
    if (b[p] !== 0xff) throw new CodecError('Corrupt JPEG marker structure.');
    while (b[p] === 0xff && p < b.length) p++;
    const m = b[p],
      at = p - 1;
    p++;
    if (m === 0xd9) return concatBytes([...parts, b.subarray(at, p)]);
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      parts.push(b.subarray(at, p));
      continue;
    }
    if (p + 2 > b.length) throw new CodecError('JPEG segment is truncated.');
    const end = p + ((b[p] << 8) | b[p + 1]);
    if (end > b.length) throw new CodecError('JPEG segment is truncated.');
    if (m === 0xda) {
      // Scans and everything between them run to the end-of-image marker.
      let q = end;
      while (q + 1 < b.length && !(b[q] === 0xff && b[q + 1] === 0xd9)) q++;
      if (q + 1 >= b.length) throw new CodecError('JPEG has no end-of-image marker.');
      return concatBytes([...parts, b.subarray(at, q + 2)]);
    }
    if (!((m >= 0xe0 && m <= 0xef) || m === 0xfe)) parts.push(b.subarray(at, end));
    p = end;
  }
  throw new CodecError('JPEG has no image data.');
}
function webpData(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const c of readWebpChunks(b))
    if (['ALPH', 'VP8 ', 'VP8L', 'ANMF'].includes(c.fourcc)) parts.push(new TextEncoder().encode(c.fourcc), c.data);
  if (!parts.length) throw new CodecError('The WebP file has no image data.');
  return concatBytes(parts);
}
function tiffData(b: Uint8Array): Uint8Array {
  const page = decodeTiff(b, { firstPageOnly: true }).pages[0];
  if (!page) throw new CodecError('The TIFF file has no image.');
  const samples = page.data16 ?? page.dataF32 ?? page.rgba8.data;
  const head = new Uint8Array(12);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, page.width, true);
  dv.setUint32(4, page.height, true);
  dv.setUint32(8, page.channels, true);
  return concatBytes([head, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

export type PixelHash = { hash: string; method: string };
/** "sha256:<hex>" of the image data and the method used. */
export async function pixelHash(bytes: Uint8Array, format: ProvenanceFormat): Promise<PixelHash> {
  let method: string, data: Uint8Array;
  if (format === 'png') ({ method, data } = pngData(bytes));
  else if (format === 'jpeg') [method, data] = ['jpeg-scan-v1', jpegData(bytes)];
  else if (format === 'webp') [method, data] = ['webp-bitstream-v1', webpData(bytes)];
  else [method, data] = ['tiff-samples-v1', tiffData(bytes)];
  return { hash: `sha256:${hex(await sha256(data))}`, method };
}
