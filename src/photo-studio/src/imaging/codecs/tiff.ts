// TIFF reader and writer written from the TIFF 6.0 specification (Aldus 1992),
// the TIFF Technical Notes (Deflate, predictor 3 floating point,
// 16/24-bit floats) and the BigTIFF proposal (64-bit offsets, version 43).
import { deflate, inflate, inflateRaw } from 'pako';
import { checkCancelled, type Progress, type RGBA8 } from '../types';
import { ByteWriter, CodecError, checkSize, rethrowAsCodecError, latin1String, type SizeLimits } from './bytes';
import { lzwDecode, lzwEncode } from './lzw';

export type TiffSampleFormat = 'uint' | 'int' | 'float';
export type TiffColorModel = 'gray' | 'bilevel' | 'rgb' | 'palette' | 'cmyk';
export type TiffAlpha = 'associated' | 'unassociated' | 'unspecified';
export type TiffResolution = { x: number; y: number; unit: 'none' | 'inch' | 'cm' };

export type TiffPage = {
  width: number;
  height: number;
  bitsPerSample: number;
  sampleFormat: TiffSampleFormat;
  // Raw PhotometricInterpretation code (0 WhiteIsZero, 1 BlackIsZero, 2 RGB,
  // 3 palette, 4 transparency mask, 5 separated/CMYK).
  photometric: number;
  colorModel: TiffColorModel;
  // SamplesPerPixel as stored, including extra samples.
  channels: number;
  alpha?: TiffAlpha;
  compression: number;
  predictor: number;
  planar: boolean;
  tiled: boolean;
  // Always present: 8-bit straight-alpha RGBA. Float data is clamped to [0, 1]
  // with no transfer function applied.
  rgba8: RGBA8;
  // 16-bit integer sources: straight-alpha RGBA16, 4 values per pixel.
  data16?: Uint16Array;
  // Float sources (raw values, not clamped) and 32-bit integer sources
  // (normalized to [0, 1]): straight-alpha RGBA, 4 values per pixel.
  dataF32?: Float32Array;
  icc?: Uint8Array;
  resolution?: TiffResolution;
  // EXIF/TIFF orientation 1-8 as stored; the pixels are not rotated.
  orientation?: number;
  // CMYK sources: the raw ink planes, planar (C plane, then M, Y, K), each
  // width*height samples, 0 = no ink. The RGB conversion is a naive one.
  cmyk?: Uint8Array | Uint16Array;
  // Some editors store their layers in tag 37724 (ImageSourceData). They are not
  // decoded; the flattened image above is what other readers see too.
  hasImageSourceData: boolean;
  // Tag 34377: an image resource block (editor metadata) is present.
  hasImageResources: boolean;
  xmp?: string;
  subfileType: number;
};
export type TiffDecodeResult = {
  pages: TiffPage[];
  littleEndian: boolean;
  bigTiff: boolean;
  // Pages after the first that could not be decoded are skipped with a note.
  warnings: string[];
};
export type TiffDecodeOptions = {
  firstPageOnly?: boolean;
  // Reported per strip/tile of the page being decoded; cancellation throws
  // CancelledError (also for later pages).
  progress?: Progress;
  // Pages beyond these sizes are refused before their pixels are decoded.
  limits?: SizeLimits;
};

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4, 0, 0, 8, 8, 8];
type Entry = { tag: number; type: number; count: number; offset: number };

class Reader {
  view: DataView;
  constructor(public bytes: Uint8Array, public le: boolean, public big: boolean) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u16(o: number) {
    return this.view.getUint16(o, this.le);
  }
  u32(o: number) {
    return this.view.getUint32(o, this.le);
  }
  u64(o: number) {
    const lo = this.view.getUint32(o + (this.le ? 0 : 4), this.le);
    const hi = this.view.getUint32(o + (this.le ? 4 : 0), this.le);
    return hi * 4294967296 + lo;
  }
  offset(o: number) {
    return this.big ? this.u64(o) : this.u32(o);
  }
  value(type: number, o: number): number {
    const v = this.view;
    switch (type) {
      case 1:
      case 2:
      case 7:
        return v.getUint8(o);
      case 6:
        return v.getInt8(o);
      case 3:
        return v.getUint16(o, this.le);
      case 8:
        return v.getInt16(o, this.le);
      case 4:
      case 13:
        return v.getUint32(o, this.le);
      case 9:
        return v.getInt32(o, this.le);
      case 5: {
        const d = v.getUint32(o + 4, this.le);
        return d ? v.getUint32(o, this.le) / d : 0;
      }
      case 10: {
        const d = v.getInt32(o + 4, this.le);
        return d ? v.getInt32(o, this.le) / d : 0;
      }
      case 11:
        return v.getFloat32(o, this.le);
      case 12:
        return v.getFloat64(o, this.le);
      case 16:
      case 18:
        return this.u64(o);
      case 17: {
        const n = this.u64(o);
        return n >= 2 ** 63 ? n - 2 ** 64 : n;
      }
    }
    return 0;
  }
}

function readIfd(r: Reader, at: number): { entries: Map<number, Entry>; next: number } {
  const big = r.big;
  const n = big ? r.u64(at) : r.u16(at);
  const entrySize = big ? 20 : 12;
  const inline = big ? 8 : 4;
  let p = at + (big ? 8 : 2);
  if (p + n * entrySize > r.bytes.length) throw new CodecError('TIFF directory runs past the end of the file.');
  const entries = new Map<number, Entry>();
  for (let i = 0; i < n; i++, p += entrySize) {
    const tag = r.u16(p);
    const type = r.u16(p + 2);
    const count = big ? r.u64(p + 4) : r.u32(p + 4);
    const size = (TYPE_SIZE[type] ?? 0) * count;
    const valuePos = p + (big ? 12 : 8);
    const offset = size <= inline ? valuePos : r.offset(valuePos);
    if (!TYPE_SIZE[type] || offset + size > r.bytes.length) continue;
    entries.set(tag, { tag, type, count, offset });
  }
  return { entries, next: r.offset(p) };
}

function values(r: Reader, e: Entry | undefined): number[] {
  if (!e) return [];
  const size = TYPE_SIZE[e.type];
  const out = new Array<number>(e.count);
  for (let i = 0; i < e.count; i++) out[i] = r.value(e.type, e.offset + i * size);
  return out;
}
function rawBytes(r: Reader, e: Entry): Uint8Array {
  return r.bytes.slice(e.offset, e.offset + TYPE_SIZE[e.type] * e.count);
}

export function decodeTiff(bytes: Uint8Array, opts: TiffDecodeOptions = {}): TiffDecodeResult {
  try {
    return decodeTiffImpl(bytes, opts);
  } catch (e) {
    rethrowAsCodecError(e, 'TIFF');
  }
}
function decodeTiffImpl(bytes: Uint8Array, opts: TiffDecodeOptions = {}): TiffDecodeResult {
  if (bytes.length < 8) throw new CodecError('Not a TIFF file.');
  const order = bytes[0] === 0x49 && bytes[1] === 0x49 ? true : bytes[0] === 0x4d && bytes[1] === 0x4d ? false : null;
  if (order === null) throw new CodecError('Not a TIFF file.');
  const probe = new Reader(bytes, order, false);
  const version = probe.u16(2);
  let r: Reader;
  let ifdAt: number;
  if (version === 42) {
    r = probe;
    ifdAt = r.u32(4);
  } else if (version === 43) {
    if (probe.u16(4) !== 8) throw new CodecError('Unsupported BigTIFF offset size.');
    r = new Reader(bytes, order, true);
    ifdAt = r.u64(8);
  } else throw new CodecError('Not a TIFF file.');
  const pages: TiffPage[] = [];
  const warnings: string[] = [];
  const seen = new Set<number>();
  while (ifdAt && ifdAt < bytes.length && !seen.has(ifdAt)) {
    seen.add(ifdAt);
    const { entries, next } = readIfd(r, ifdAt);
    try {
      pages.push(decodePage(r, entries, opts.progress, opts.limits));
    } catch (err) {
      if (!pages.length || (err as Error).name === 'CancelledError') throw err;
      warnings.push(`Page ${pages.length + warnings.length + 1}: ${(err as Error).message}`);
    }
    if (opts.firstPageOnly) break;
    ifdAt = next;
  }
  if (!pages.length) throw new CodecError('The TIFF file contains no images.');
  return { pages, littleEndian: order, bigTiff: r.big, warnings };
}

function packBitsDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0;
  let o = 0;
  while (i < src.length && o < expected) {
    const n = src[i++];
    if (n < 128) {
      const len = Math.min(n + 1, expected - o, src.length - i);
      out.set(src.subarray(i, i + len), o);
      i += n + 1;
      o += len;
    } else if (n > 128) {
      const len = Math.min(257 - n, expected - o);
      out.fill(src[i++], o, o + len);
      o += len;
    }
  }
  return out;
}

const COMPRESSION_NAMES: Record<number, string> = {
  2: 'CCITT modified Huffman',
  3: 'CCITT Group 3 fax',
  4: 'CCITT Group 4 fax',
  6: 'old-style JPEG',
  7: 'JPEG',
  34712: 'JPEG 2000',
  34892: 'lossy JPEG',
  50000: 'Zstandard',
  50001: 'WebP',
};

function decompress(compression: number, src: Uint8Array, expected: number): Uint8Array {
  let out: Uint8Array;
  switch (compression) {
    case 1:
      out = src.slice(0, expected);
      break;
    case 32773:
      return packBitsDecode(src, expected);
    case 5: {
      out = new Uint8Array(expected);
      if (src.length >= 2 && src[0] === 0 && src[1] & 1) {
        // Pre-5.0 libtiff "compat" LZW (LSB-first) is not supported.
        throw new CodecError('Old-style TIFF LZW is not supported.');
      }
      lzwDecode(src, out, 'tiff');
      return out;
    }
    case 8:
    case 32946:
      out = zlibInflate(src);
      break;
    default:
      throw new CodecError(`TIFF ${COMPRESSION_NAMES[compression] ?? `compression ${compression}`} is not supported.`);
  }
  if (out.length >= expected) return out;
  const padded = new Uint8Array(expected);
  padded.set(out);
  return padded;
}

// zlib stream (compression 8), falling back to a raw Deflate stream.
function zlibInflate(src: Uint8Array): Uint8Array {
  let out: Uint8Array | undefined;
  try {
    out = inflate(src);
  } catch {
    out = undefined;
  }
  if (!out) {
    try {
      out = inflateRaw(src);
    } catch {
      out = undefined;
    }
  }
  if (!out) throw new CodecError('TIFF Deflate data is corrupt.');
  return out;
}

function reverseBits(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) {
    let v = b[i];
    v = ((v & 0xf0) >> 4) | ((v & 0x0f) << 4);
    v = ((v & 0xcc) >> 2) | ((v & 0x33) << 2);
    out[i] = ((v & 0xaa) >> 1) | ((v & 0x55) << 1);
  }
  return out;
}

// 24-bit float (TIFF Technical Note 3): 1 sign, 7 exponent (bias 63), 16 mantissa bits.
function fp24(v: number): number {
  const sign = v & 0x800000 ? -1 : 1;
  const e = (v >> 16) & 0x7f;
  const m = v & 0xffff;
  if (e === 0x7f) return m ? NaN : sign * Infinity;
  if (e === 0) return sign * m * 2 ** -78;
  return sign * (1 + m / 65536) * 2 ** (e - 63);
}
function half(v: number): number {
  const sign = v & 0x8000 ? -1 : 1;
  const e = (v >> 10) & 0x1f;
  const m = v & 0x3ff;
  if (e === 0x1f) return m ? NaN : sign * Infinity;
  if (e === 0) return sign * m * 2 ** -24;
  return sign * (1 + m / 1024) * 2 ** (e - 15);
}

type SampleBuffer = Uint8Array | Uint16Array | Uint32Array | Float32Array;

function decodePage(r: Reader, ifd: Map<number, Entry>, progress?: Progress, limits?: SizeLimits): TiffPage {
  const num = (tag: number, def: number) => {
    const e = ifd.get(tag);
    return e ? r.value(e.type, e.offset) : def;
  };
  const width = num(256, 0);
  const height = num(257, 0);
  if (!width || !height) throw new CodecError('TIFF page has no dimensions.');
  if (width * height > 2 ** 28) throw new CodecError('TIFF page is too large.');
  checkSize(width, height, limits);
  const spp = num(277, 1);
  const bpsList = values(r, ifd.get(258));
  const bits = bpsList[0] ?? 1;
  if (bpsList.some((b) => b !== bits)) throw new CodecError('TIFF pages with mixed sample sizes are not supported.');
  const compression = num(259, 1);
  const extras = values(r, ifd.get(338));
  let photometric = num(262, -1);
  if (photometric < 0) photometric = spp - extras.length >= 3 ? 2 : 1;
  const planar = num(284, 1) === 2 && spp > 1;
  const predictor = num(317, 1);
  const fmtCode = num(339, 1);
  const sampleFormat: TiffSampleFormat = fmtCode === 3 ? 'float' : fmtCode === 2 ? 'int' : 'uint';
  const fillOrder = num(266, 1);
  const tiled = ifd.has(322);

  if (photometric === 6) throw new CodecError('TIFF YCbCr images are not supported.');
  if (photometric === 8 || photometric === 9 || photometric === 10)
    throw new CodecError('TIFF CIE L*a*b* images are not supported.');
  if (photometric > 5) throw new CodecError(`TIFF photometric interpretation ${photometric} is not supported.`);
  const isFloat = sampleFormat === 'float';
  if (isFloat ? ![16, 24, 32, 64].includes(bits) : ![1, 2, 4, 8, 16, 32].includes(bits))
    throw new CodecError(`TIFF ${bits}-bit ${sampleFormat} samples are not supported.`);

  let cw: number, ch: number, offsets: number[], counts: number[];
  if (tiled) {
    cw = num(322, 0);
    ch = num(323, 0);
    offsets = values(r, ifd.get(324));
    counts = values(r, ifd.get(325));
    if (!cw || !ch) throw new CodecError('TIFF tile size is missing.');
  } else {
    cw = width;
    ch = Math.min(num(278, height), height) || height;
    offsets = values(r, ifd.get(273));
    counts = values(r, ifd.get(279));
  }
  const across = Math.ceil(width / cw);
  const down = Math.ceil(height / ch);
  const planes = planar ? spp : 1;
  const spc = planar ? 1 : spp;
  if (offsets.length < across * down * planes) throw new CodecError('TIFF strip or tile offsets are missing.');
  const rowBytes = Math.ceil((cw * spc * bits) / 8);
  const bytesPerSample = bits >> 3;

  const total = width * height * spp;
  const kind = isFloat ? 'f32' : bits <= 8 ? 'u8' : bits === 16 ? 'u16' : 'u32';
  const S: SampleBuffer =
    kind === 'f32' ? new Float32Array(total) : kind === 'u8' ? new Uint8Array(total) : kind === 'u16' ? new Uint16Array(total) : new Uint32Array(total);
  const rowN = cw * spc;
  const row: SampleBuffer =
    kind === 'f32' ? new Float32Array(rowN) : kind === 'u8' ? new Uint8Array(rowN) : kind === 'u16' ? new Uint16Array(rowN) : new Uint32Array(rowN);
  const le = r.le;
  const signFlip = sampleFormat === 'int' ? 2 ** (bits - 1) : 0;
  const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

  for (let p = 0; p < planes; p++) {
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) {
        const index = p * across * down + ty * across + tx;
        if (progress) {
          checkCancelled(progress);
          progress.report?.(index / (across * down * planes));
        }
        const y0 = ty * ch;
        const x0 = tx * cw;
        const rows = tiled ? ch : Math.min(ch, height - y0);
        const expected = rowBytes * rows;
        const off = offsets[index];
        let count = counts[index];
        if (count === undefined) count = compression === 1 ? expected : r.bytes.length - off;
        let raw = r.bytes.subarray(off, Math.min(r.bytes.length, off + count));
        if (fillOrder === 2) raw = reverseBits(raw);
        const R = decompress(compression, raw, expected);
        const dv = kind === 'u8' ? null : view(R);
        const validRows = Math.min(rows, height - y0);
        const validW = Math.min(cw, width - x0);
        for (let yy = 0; yy < validRows; yy++) {
          const ro = yy * rowBytes;
          // Unpack one row of samples into `row`.
          if (kind === 'u8') {
            const out = row as Uint8Array;
            if (bits === 8) out.set(R.subarray(ro, ro + rowN));
            else {
              const perByte = 8 / bits;
              const mask = (1 << bits) - 1;
              for (let i = 0; i < rowN; i++) {
                const b = R[ro + ((i / perByte) | 0)];
                out[i] = (b >> (8 - bits * ((i % perByte) + 1))) & mask;
              }
            }
            if (predictor === 2 && bits === 8) for (let i = spc; i < rowN; i++) out[i] += out[i - spc];
            if (signFlip) for (let i = 0; i < rowN; i++) out[i] ^= 0x80;
          } else if (kind === 'u16') {
            const out = row as Uint16Array;
            for (let i = 0; i < rowN; i++) out[i] = dv!.getUint16(ro + i * 2, le);
            if (predictor === 2) for (let i = spc; i < rowN; i++) out[i] += out[i - spc];
            if (signFlip) for (let i = 0; i < rowN; i++) out[i] ^= 0x8000;
          } else if (kind === 'u32') {
            const out = row as Uint32Array;
            for (let i = 0; i < rowN; i++) out[i] = dv!.getUint32(ro + i * 4, le);
            if (predictor === 2) for (let i = spc; i < rowN; i++) out[i] += out[i - spc];
            if (signFlip) for (let i = 0; i < rowN; i++) out[i] ^= 0x80000000;
          } else {
            const out = row as Float32Array;
            if (predictor === 3) {
              // Floating-point predictor (TIFF Technical Note 3): bytes were split into
              // planes, most significant first, then byte-differenced with a
              // stride of one pixel.
              const cc = rowN * bytesPerSample;
              for (let i = ro + spc, e = ro + cc; i < e; i++) R[i] = (R[i] + R[i - spc]) & 0xff;
              for (let i = 0; i < rowN; i++) {
                let v = 0;
                for (let b = 0; b < bytesPerSample; b++) v = v * 256 + R[ro + b * rowN + i];
                out[i] = floatFromBits(v, bytesPerSample, R, ro, rowN, i);
              }
            } else if (bytesPerSample === 4) {
              for (let i = 0; i < rowN; i++) out[i] = dv!.getFloat32(ro + i * 4, le);
            } else if (bytesPerSample === 8) {
              for (let i = 0; i < rowN; i++) out[i] = dv!.getFloat64(ro + i * 8, le);
            } else if (bytesPerSample === 2) {
              for (let i = 0; i < rowN; i++) out[i] = half(dv!.getUint16(ro + i * 2, le));
            } else {
              for (let i = 0; i < rowN; i++) {
                const o = ro + i * 3;
                out[i] = fp24(le ? R[o] | (R[o + 1] << 8) | (R[o + 2] << 16) : (R[o] << 16) | (R[o + 1] << 8) | R[o + 2]);
              }
            }
          }
          const y = y0 + yy;
          if (!planar) S.set(row.subarray(0, validW * spp) as never, (y * width + x0) * spp);
          else for (let x = 0, o = (y * width + x0) * spp + p; x < validW; x++, o += spp) S[o] = row[x];
        }
      }
    }
  }

  // Interpretation.
  let colorModel: TiffColorModel;
  let colorChannels: number;
  if (photometric === 2) {
    colorModel = 'rgb';
    colorChannels = 3;
  } else if (photometric === 3) {
    colorModel = 'palette';
    colorChannels = 1;
  } else if (photometric === 5) {
    if (num(332, 1) !== 1 || spp - extras.length < 4) throw new CodecError('Only CMYK separated TIFF images are supported.');
    colorModel = 'cmyk';
    colorChannels = 4;
  } else {
    colorModel = bits === 1 ? 'bilevel' : 'gray';
    colorChannels = 1;
  }
  if (spp < colorChannels) throw new CodecError('TIFF page has too few samples for its color model.');
  const alphaIndex = spp > colorChannels ? colorChannels : -1;
  const alpha: TiffAlpha | undefined =
    alphaIndex < 0 ? undefined : extras[0] === 1 ? 'associated' : extras[0] === 2 ? 'unassociated' : 'unspecified';
  const associated = alpha === 'associated';
  const pixels = width * height;
  const inMax = isFloat ? 1 : 2 ** bits - 1;
  const colorMap = photometric === 3 ? values(r, ifd.get(320)) : [];
  if (photometric === 3 && colorMap.length < 3 * 2 ** bits) throw new CodecError('TIFF palette is missing.');

  const fastRGBA = kind === 'u8' && bits === 8 && photometric === 2 && !associated && spp === 4;
  // 8-bit RGBA samples already are the output: share the buffer.
  const rgba8 = fastRGBA ? new Uint8ClampedArray(S.buffer) : new Uint8ClampedArray(pixels * 4);
  let data16: Uint16Array | undefined;
  let dataF32: Float32Array | undefined;
  if (fastRGBA) {
    // Nothing to convert.
  } else if (kind === 'u8' && bits === 8 && photometric === 2 && !associated && spp === 3) {
    const s = S as Uint8Array;
    for (let i = 0, j = 0; i < pixels * 4; i += 4, j += 3) {
      rgba8[i] = s[j];
      rgba8[i + 1] = s[j + 1];
      rgba8[i + 2] = s[j + 2];
      rgba8[i + 3] = 255;
    }
  } else {
    // Generic conversion at native precision into `dst`, scaled to outMax.
    const outMax = kind === 'u16' ? 65535 : kind === 'u8' ? 255 : 1;
    const dst: Uint8ClampedArray | Uint16Array | Float32Array =
      kind === 'u8' ? rgba8 : kind === 'u16' ? (data16 = new Uint16Array(pixels * 4)) : (dataF32 = new Float32Array(pixels * 4));
    const norm = outMax / inMax;
    const round = kind === 'u16';
    const mapScale = outMax / 65535;
    const mapN = 2 ** bits;
    const whiteIsZero = photometric === 0;
    for (let i = 0, s = 0, o = 0; i < pixels; i++, s += spp, o += 4) {
      let rr: number, gg: number, bb: number;
      if (colorChannels === 3) {
        rr = S[s] * norm;
        gg = S[s + 1] * norm;
        bb = S[s + 2] * norm;
      } else if (colorModel === 'palette') {
        const idx = S[s];
        rr = colorMap[idx] * mapScale;
        gg = colorMap[mapN + idx] * mapScale;
        bb = colorMap[2 * mapN + idx] * mapScale;
      } else if (colorChannels === 4) {
        const k = 1 - S[s + 3] / inMax;
        rr = outMax * (1 - S[s] / inMax) * k;
        gg = outMax * (1 - S[s + 1] / inMax) * k;
        bb = outMax * (1 - S[s + 2] / inMax) * k;
      } else {
        const g = whiteIsZero ? inMax - S[s] : S[s];
        rr = gg = bb = g * norm;
      }
      let a = alphaIndex >= 0 ? S[s + alphaIndex] * norm : outMax;
      if (associated && a > 0 && a !== outMax) {
        const f = outMax / a;
        rr *= f;
        gg *= f;
        bb *= f;
        if (!isFloat) {
          if (rr > outMax) rr = outMax;
          if (gg > outMax) gg = outMax;
          if (bb > outMax) bb = outMax;
        }
      }
      if (round) {
        rr = Math.round(rr);
        gg = Math.round(gg);
        bb = Math.round(bb);
        a = Math.round(a);
      }
      dst[o] = rr;
      dst[o + 1] = gg;
      dst[o + 2] = bb;
      dst[o + 3] = a;
    }
    if (data16) for (let i = 0; i < data16.length; i++) rgba8[i] = ((data16[i] + 128) / 257) | 0;
    else if (dataF32) for (let i = 0; i < dataF32.length; i++) rgba8[i] = dataF32[i] * 255;
  }

  let cmyk: Uint8Array | Uint16Array | undefined;
  if (colorModel === 'cmyk' && (kind === 'u8' || kind === 'u16')) {
    cmyk = kind === 'u8' ? new Uint8Array(pixels * 4) : new Uint16Array(pixels * 4);
    for (let c = 0; c < 4; c++)
      for (let i = 0, s = c, o = c * pixels; i < pixels; i++, s += spp, o++) cmyk[o] = S[s];
  }

  const page: TiffPage = {
    width,
    height,
    bitsPerSample: bits,
    sampleFormat,
    photometric,
    colorModel,
    channels: spp,
    compression,
    predictor,
    planar,
    tiled,
    rgba8: { width, height, data: rgba8 },
    hasImageSourceData: ifd.has(37724),
    hasImageResources: ifd.has(34377),
    subfileType: num(254, 0),
  };
  if (alpha) page.alpha = alpha;
  if (data16) page.data16 = data16;
  if (dataF32) page.dataF32 = dataF32;
  if (cmyk) page.cmyk = cmyk;
  const icc = ifd.get(34675);
  if (icc) page.icc = rawBytes(r, icc);
  if (ifd.has(282) || ifd.has(283)) {
    const unit = num(296, 2);
    const x = num(282, 0);
    page.resolution = { x, y: num(283, x), unit: unit === 3 ? 'cm' : unit === 1 ? 'none' : 'inch' };
  }
  if (ifd.has(274)) page.orientation = num(274, 1);
  const xmp = ifd.get(700);
  if (xmp) page.xmp = new TextDecoder().decode(rawBytes(r, xmp));
  return page;
}

const f32Scratch = new DataView(new ArrayBuffer(8));
function floatFromBits(v: number, size: number, R: Uint8Array, ro: number, rowN: number, i: number): number {
  if (size === 4) {
    f32Scratch.setUint32(0, v);
    return f32Scratch.getFloat32(0);
  }
  if (size === 2) return half(v);
  if (size === 3) return fp24(v);
  for (let b = 0; b < 8; b++) f32Scratch.setUint8(b, R[ro + b * rowN + i]);
  return f32Scratch.getFloat64(0);
}

// --- Writer ---------------------------------------------------------------

export type TiffEncodeImage = {
  width: number;
  height: number;
  // 8-bit, 16-bit or 32-bit float samples, interleaved, straight alpha.
  data: Uint8ClampedArray | Uint8Array | Uint16Array | Float32Array;
  channels: 1 | 2 | 3 | 4;
};
export type TiffEncodeOptions = {
  compression: 'none' | 'lzw' | 'deflate';
  // Horizontal differencing (predictor 2) for integers, predictor 3 for floats.
  predictor?: boolean;
  icc?: Uint8Array;
  dpi?: number;
  // Deflate level 1-9 (default 6).
  level?: number;
  rowsPerStrip?: number;
  progress?: Progress;
};

type OutTag = { tag: number; type: number; values: number[] | Uint8Array };

export function encodeTiff(img: TiffEncodeImage, opts: TiffEncodeOptions): Uint8Array {
  const { width, height, channels, data } = img;
  if (!(width > 0 && height > 0)) throw new CodecError('Cannot write an empty TIFF.');
  if (data.length < width * height * channels) throw new CodecError('Pixel data is shorter than width × height × channels.');
  const float = data instanceof Float32Array;
  const bits = data instanceof Uint16Array ? 16 : float ? 32 : 8;
  const bps = bits >> 3;
  const rowSamples = width * channels;
  const rowBytes = rowSamples * bps;
  const predictor = opts.predictor && opts.compression !== 'none' ? (float ? 3 : 2) : 1;
  const rps = Math.max(1, Math.min(height, opts.rowsPerStrip ?? Math.floor(131072 / rowBytes)));
  const strips: Uint8Array[] = [];
  const level = Math.max(1, Math.min(9, opts.level ?? 6)) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  const u16 = bits === 16 ? (data as Uint16Array) : null;
  const f32bytes = float ? new Uint8Array(data.buffer, data.byteOffset, data.length * 4) : null;
  const littleEndianHost = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  for (let y0 = 0; y0 < height; y0 += rps) {
    if (opts.progress) {
      checkCancelled(opts.progress);
      opts.progress.report?.(y0 / height);
    }
    const rows = Math.min(rps, height - y0);
    const raw = new Uint8Array(rows * rowBytes);
    for (let yy = 0; yy < rows; yy++) {
      const si = (y0 + yy) * rowSamples;
      const ro = yy * rowBytes;
      if (bits === 8) {
        raw.set(data.subarray(si, si + rowSamples) as Uint8Array, ro);
        if (predictor === 2) for (let i = ro + rowBytes - 1; i >= ro + channels; i--) raw[i] = (raw[i] - raw[i - channels]) & 0xff;
      } else if (u16) {
        for (let i = 0; i < rowSamples; i++) {
          const v = predictor === 2 && i >= channels ? (u16[si + i] - u16[si + i - channels]) & 0xffff : u16[si + i];
          raw[ro + i * 2] = v & 0xff;
          raw[ro + i * 2 + 1] = v >> 8;
        }
      } else if (predictor === 3) {
        // Split into byte planes, most significant first, then difference.
        for (let i = 0; i < rowSamples; i++) {
          const fo = (si + i) * 4;
          for (let b = 0; b < 4; b++) raw[ro + b * rowSamples + i] = f32bytes![fo + (littleEndianHost ? 3 - b : b)];
        }
        for (let i = ro + rowBytes - 1; i >= ro + channels; i--) raw[i] = (raw[i] - raw[i - channels]) & 0xff;
      } else {
        for (let i = 0; i < rowSamples; i++) {
          const fo = (si + i) * 4;
          for (let b = 0; b < 4; b++) raw[ro + i * 4 + b] = f32bytes![fo + (littleEndianHost ? b : 3 - b)];
        }
      }
    }
    strips.push(opts.compression === 'lzw' ? lzwEncode(raw, 'tiff') : opts.compression === 'deflate' ? deflate(raw, { level }) : raw);
  }

  const alpha = channels === 2 || channels === 4;
  const tags: OutTag[] = [
    { tag: 254, type: 4, values: [0] },
    { tag: 256, type: 4, values: [width] },
    { tag: 257, type: 4, values: [height] },
    { tag: 258, type: 3, values: new Array(channels).fill(bits) },
    { tag: 259, type: 3, values: [opts.compression === 'lzw' ? 5 : opts.compression === 'deflate' ? 8 : 1] },
    { tag: 262, type: 3, values: [channels >= 3 ? 2 : 1] },
    { tag: 273, type: 4, values: [] },
    { tag: 277, type: 3, values: [channels] },
    { tag: 278, type: 4, values: [rps] },
    { tag: 279, type: 4, values: strips.map((s) => s.length) },
  ];
  if (opts.dpi && opts.dpi > 0) {
    const d = Math.round(opts.dpi * 10000);
    tags.push({ tag: 282, type: 5, values: [d, 10000] }, { tag: 283, type: 5, values: [d, 10000] });
  }
  tags.push({ tag: 284, type: 3, values: [1] });
  if (opts.dpi && opts.dpi > 0) tags.push({ tag: 296, type: 3, values: [2] });
  if (predictor > 1) tags.push({ tag: 317, type: 3, values: [predictor] });
  if (alpha) tags.push({ tag: 338, type: 3, values: [2] });
  tags.push({ tag: 339, type: 3, values: new Array(channels).fill(float ? 3 : 1) });
  if (opts.icc?.length) tags.push({ tag: 34675, type: 7, values: opts.icc });

  let dataSize = 0;
  for (const s of strips) dataSize += s.length + (s.length & 1);
  const w = new ByteWriter(8 + dataSize + 64 + tags.length * 12 + (opts.icc?.length ?? 0) + strips.length * 8 + 64);
  w.ascii('II');
  w.u16le(42);
  w.u32le(0);
  const stripOffsets: number[] = [];
  for (const s of strips) {
    stripOffsets.push(w.length);
    w.bytes(s);
    if (w.length & 1) w.u8(0);
  }
  tags.find((t) => t.tag === 273)!.values = stripOffsets;
  const ifdAt = w.length;
  let extraAt = ifdAt + 2 + tags.length * 12 + 4;
  const deferred: OutTag[] = [];
  w.u16le(tags.length);
  for (const t of tags) {
    const size = TYPE_SIZE[t.type] * (t.type === 5 ? t.values.length / 2 : t.values.length);
    w.u16le(t.tag);
    w.u16le(t.type);
    w.u32le(t.type === 5 ? t.values.length / 2 : t.values.length);
    if (size <= 4) {
      const start = w.length;
      writeValues(w, t);
      w.pad(4 - (w.length - start));
    } else {
      w.u32le(extraAt);
      deferred.push(t);
      extraAt += size + (size & 1);
    }
  }
  w.u32le(0);
  for (const t of deferred) {
    writeValues(w, t);
    if (w.length & 1) w.u8(0);
  }
  const out = w.result();
  new DataView(out.buffer).setUint32(4, ifdAt, true);
  return out;
}

function writeValues(w: ByteWriter, t: OutTag) {
  if (t.values instanceof Uint8Array) w.bytes(t.values);
  else if (t.type === 3) for (const v of t.values) w.u16le(v);
  else for (const v of t.values) w.u32le(v);
}

// Debug helper for tests and diagnostics: list the tags of every IFD.
export function listTiffTags(bytes: Uint8Array): Array<Record<number, number[] | string>> {
  const le = bytes[0] === 0x49;
  const probe = new Reader(bytes, le, false);
  const big = probe.u16(2) === 43;
  const r = big ? new Reader(bytes, le, true) : probe;
  let at = big ? r.u64(8) : r.u32(4);
  const out: Array<Record<number, number[] | string>> = [];
  const seen = new Set<number>();
  while (at && !seen.has(at)) {
    seen.add(at);
    const { entries, next } = readIfd(r, at);
    const rec: Record<number, number[] | string> = {};
    for (const e of entries.values())
      rec[e.tag] = e.type === 2 ? latin1String(rawBytes(r, e)).replace(/\0+$/, '') : e.count > 64 ? [e.count] : values(r, e);
    out.push(rec);
    at = next;
  }
  return out;
}
