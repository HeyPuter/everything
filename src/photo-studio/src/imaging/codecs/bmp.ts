// Windows bitmap (BMP/DIB) reader and writer, written from the Win32
// BITMAPINFOHEADER / BITMAPV4HEADER / BITMAPV5HEADER documentation and the
// OS/2 BITMAPCOREHEADER layout. ICO/CUR entries reuse `decodeDib`.
import type { RGBA8 } from '../types';
import { ByteWriter, CodecError, checkSize, rethrowAsCodecError, type SizeLimits } from './bytes';

export type BmpDecodeResult = {
  width: number;
  height: number;
  bitsPerPixel: number;
  // 0 RGB, 1 RLE8, 2 RLE4, 3 BITFIELDS, 6 ALPHABITFIELDS.
  compression: number;
  headerSize: number;
  topDown: boolean;
  // True when the alpha channel carries information (alpha mask, a 32-bit
  // fourth byte that is not all zero, RLE gaps or an icon AND mask).
  hasAlpha: boolean;
  rgba8: RGBA8;
  // Pixels per inch, when the header records a density.
  dpi?: { x: number; y: number };
  // Embedded ICC profile of a BITMAPV5HEADER (CSType 'MBED').
  icc?: Uint8Array;
};

export function decodeBmp(bytes: Uint8Array, limits?: SizeLimits): BmpDecodeResult {
  try {
    return decodeBmpImpl(bytes, limits);
  } catch (e) {
    rethrowAsCodecError(e, 'BMP');
  }
}
function decodeBmpImpl(bytes: Uint8Array, limits?: SizeLimits): BmpDecodeResult {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new CodecError('Not a BMP file.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return decodeDib(bytes, 14, { pixelOffset: dv.getUint32(10, true), limits });
}

const ctz = (m: number) => {
  let s = 0;
  while (s < 32 && !((m >>> s) & 1)) s++;
  return s;
};
// Lookup table from a masked field value to 8 bits.
function maskLut(mask: number): { shift: number; lut: Uint8Array } | null {
  if (!mask) return null;
  const shift = ctz(mask);
  let bits = 0;
  while (bits + shift < 32 && (mask >>> (shift + bits)) & 1) bits++;
  const n = Math.min(bits, 16);
  const lut = new Uint8Array(1 << n);
  const max = (1 << n) - 1;
  for (let v = 0; v <= max; v++) lut[v] = Math.round((v * 255) / max);
  return { shift: shift + (bits - n), lut };
}

export function decodeDib(bytes: Uint8Array, at: number, opts: { pixelOffset?: number; icon?: boolean; limits?: SizeLimits } = {}): BmpDecodeResult {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (at + 12 > bytes.length) throw new CodecError('Bitmap header is truncated.');
  const hs = dv.getUint32(at, true);
  let width: number, rawHeight: number, bpp: number, compression: number;
  let clrUsed = 0;
  let paletteEntry = 4;
  let xppm = 0;
  let yppm = 0;
  let masks = [0, 0, 0, 0];
  let afterHeader = at + hs;
  if (hs === 12) {
    width = dv.getUint16(at + 4, true);
    rawHeight = dv.getInt16(at + 6, true);
    bpp = dv.getUint16(at + 10, true);
    compression = 0;
    paletteEntry = 3;
  } else if (hs >= 16 && at + Math.min(hs, 40) <= bytes.length) {
    width = dv.getInt32(at + 4, true);
    rawHeight = dv.getInt32(at + 8, true);
    bpp = dv.getUint16(at + 14, true);
    compression = hs >= 20 ? dv.getUint32(at + 16, true) : 0;
    if (hs >= 32) {
      xppm = dv.getInt32(at + 24, true);
      yppm = dv.getInt32(at + 28, true);
    }
    if (hs >= 36) clrUsed = dv.getUint32(at + 32, true);
    if (hs === 64 && (compression === 3 || compression === 4))
      throw new CodecError('OS/2 Huffman and RLE24 bitmaps are not supported.');
    if (compression === 3 || compression === 6) {
      if (hs >= 52) {
        masks = [dv.getUint32(at + 40, true), dv.getUint32(at + 44, true), dv.getUint32(at + 48, true), hs >= 56 ? dv.getUint32(at + 52, true) : 0];
      } else {
        // BITMAPINFOHEADER followed by separate mask DWORDs.
        const n = compression === 6 ? 4 : 3;
        for (let i = 0; i < n; i++) masks[i] = dv.getUint32(afterHeader + i * 4, true);
        afterHeader += n * 4;
      }
    } else if (hs >= 56 && dv.getUint32(at + 52, true) && bpp === 32 && compression === 0) {
      // Some writers fill the V4/V5 alpha mask for BI_RGB 32-bit images.
      masks = [0xff0000, 0xff00, 0xff, dv.getUint32(at + 52, true)];
      compression = 3;
    }
  } else throw new CodecError('Unsupported bitmap header.');
  if (compression === 4 || compression === 5) throw new CodecError('JPEG and PNG compressed bitmaps are not supported.');
  if (![1, 2, 4, 8, 16, 24, 32].includes(bpp)) throw new CodecError(`${bpp}-bit bitmaps are not supported.`);
  if (compression > 3 && compression !== 6) throw new CodecError(`Bitmap compression ${compression} is not supported.`);
  const topDown = rawHeight < 0;
  let height = Math.abs(rawHeight);
  if (opts.icon) height >>= 1;
  if (width <= 0 || height <= 0 || width * height > 2 ** 28) throw new CodecError('Bitmap dimensions are invalid.');
  checkSize(width, height, opts.limits);

  const palette = new Uint8Array(1024);
  let paletteSize = 0;
  if (bpp <= 8) {
    paletteSize = clrUsed && clrUsed <= 1 << bpp ? clrUsed : 1 << bpp;
    for (let i = 0; i < paletteSize; i++) {
      const p = afterHeader + i * paletteEntry;
      if (p + 3 > bytes.length) break;
      palette[i * 4] = bytes[p + 2];
      palette[i * 4 + 1] = bytes[p + 1];
      palette[i * 4 + 2] = bytes[p];
      palette[i * 4 + 3] = 255;
    }
  }
  const dataAt = opts.pixelOffset ?? afterHeader + paletteSize * paletteEntry;
  const out = new Uint8ClampedArray(width * height * 4);
  let hasAlpha = false;
  const rowOf = (y: number) => (topDown ? y : height - 1 - y);

  if (compression === 1 || compression === 2) {
    hasAlpha = decodeRle(bytes, dataAt, compression === 2, width, height, palette, out, topDown);
  } else {
    const stride = (((width * bpp + 31) >>> 5) << 2) >>> 0;
    if (dataAt + stride * (height - 1) > bytes.length) throw new CodecError('Bitmap pixel data is truncated.');
    const avail = (o: number) => o < bytes.length;
    if (bpp <= 8) {
      const perByte = 8 / bpp;
      const mask = (1 << bpp) - 1;
      for (let y = 0; y < height; y++) {
        const src = dataAt + y * stride;
        let o = rowOf(y) * width * 4;
        for (let x = 0; x < width; x++, o += 4) {
          const b = bytes[src + ((x / perByte) | 0)] ?? 0;
          const idx = bpp === 8 ? b : (b >> (8 - bpp * ((x % perByte) + 1))) & mask;
          out[o] = palette[idx * 4];
          out[o + 1] = palette[idx * 4 + 1];
          out[o + 2] = palette[idx * 4 + 2];
          out[o + 3] = 255;
        }
      }
    } else if (bpp === 24) {
      for (let y = 0; y < height; y++) {
        let s = dataAt + y * stride;
        let o = rowOf(y) * width * 4;
        for (let x = 0; x < width; x++, s += 3, o += 4) {
          out[o] = bytes[s + 2];
          out[o + 1] = bytes[s + 1];
          out[o + 2] = bytes[s];
          out[o + 3] = 255;
        }
      }
    } else {
      if (compression === 0) masks = bpp === 16 ? [0x7c00, 0x3e0, 0x1f, 0] : [0xff0000, 0xff00, 0xff, 0];
      const [mr, mg, mb, ma] = masks.map(maskLut);
      const byte4 = bpp === 32 && compression === 0;
      let anyAlpha = false;
      for (let y = 0; y < height; y++) {
        let s = dataAt + y * stride;
        let o = rowOf(y) * width * 4;
        for (let x = 0; x < width; x++, o += 4) {
          let px: number;
          if (bpp === 16) {
            px = avail(s + 1) ? bytes[s] | (bytes[s + 1] << 8) : 0;
            s += 2;
          } else {
            px = avail(s + 3) ? (bytes[s] | (bytes[s + 1] << 8) | (bytes[s + 2] << 16) | (bytes[s + 3] << 24)) >>> 0 : 0;
            s += 4;
          }
          out[o] = mr ? mr.lut[(px >>> mr.shift) & (mr.lut.length - 1)] : 0;
          out[o + 1] = mg ? mg.lut[(px >>> mg.shift) & (mg.lut.length - 1)] : 0;
          out[o + 2] = mb ? mb.lut[(px >>> mb.shift) & (mb.lut.length - 1)] : 0;
          if (ma) out[o + 3] = ma.lut[(px >>> ma.shift) & (ma.lut.length - 1)];
          else if (byte4) {
            out[o + 3] = px >>> 24;
            if (px >>> 24) anyAlpha = true;
          } else out[o + 3] = 255;
        }
      }
      if (ma) hasAlpha = true;
      else if (byte4) {
        // BI_RGB 32-bit: the fourth byte is alpha only if someone wrote it.
        if (anyAlpha) hasAlpha = true;
        else for (let i = 3; i < out.length; i += 4) out[i] = 255;
      }
    }
    if (opts.icon && !hasAlpha) {
      // AND mask: 1 bpp, rows padded to 32 bits, same orientation as the image.
      const maskAt = dataAt + stride * height;
      const mstride = ((width + 31) >>> 5) << 2;
      if (maskAt + mstride * height <= bytes.length) {
        for (let y = 0; y < height; y++) {
          const src = maskAt + y * mstride;
          let o = rowOf(y) * width * 4 + 3;
          for (let x = 0; x < width; x++, o += 4)
            if ((bytes[src + (x >> 3)] >> (7 - (x & 7))) & 1) {
              out[o] = 0;
              hasAlpha = true;
            }
        }
      }
    }
  }
  const res: BmpDecodeResult = { width, height, bitsPerPixel: bpp, compression, headerSize: hs, topDown, hasAlpha, rgba8: { width, height, data: out } };
  if (hs >= 124 && dv.getUint32(at + 56, true) === 0x4d424544) {
    const po = at + dv.getUint32(at + 112, true);
    const ps = dv.getUint32(at + 116, true);
    if (ps && po + ps <= bytes.length) res.icc = bytes.slice(po, po + ps);
  }
  if (xppm > 0 && yppm > 0) res.dpi = { x: Math.round(xppm * 0.254) / 10, y: Math.round(yppm * 0.254) / 10 };
  return res;
}

// RLE8/RLE4 per the BITMAPINFOHEADER documentation. Pixels the stream skips
// (delta moves, early end of line or bitmap) stay transparent, as browsers do.
function decodeRle(bytes: Uint8Array, at: number, four: boolean, width: number, height: number, palette: Uint8Array, out: Uint8ClampedArray, topDown: boolean): boolean {
  let x = 0;
  let y = 0;
  let p = at;
  let written = 0;
  const put = (idx: number) => {
    if (x < width && y < height) {
      const o = ((topDown ? y : height - 1 - y) * width + x) * 4;
      out[o] = palette[idx * 4];
      out[o + 1] = palette[idx * 4 + 1];
      out[o + 2] = palette[idx * 4 + 2];
      out[o + 3] = 255;
      written++;
    }
    x++;
  };
  while (p + 1 < bytes.length && y < height) {
    const n = bytes[p++];
    const v = bytes[p++];
    if (n > 0) {
      for (let i = 0; i < n; i++) put(four ? (i & 1 ? v & 15 : v >> 4) : v);
    } else if (v === 0) {
      x = 0;
      y++;
    } else if (v === 1) break;
    else if (v === 2) {
      x += bytes[p++] ?? 0;
      y += bytes[p++] ?? 0;
    } else {
      // Absolute run of v pixels, padded to a 16-bit boundary.
      const len = four ? (v + 1) >> 1 : v;
      for (let i = 0; i < v; i++) {
        const b = bytes[p + (four ? i >> 1 : i)] ?? 0;
        put(four ? (i & 1 ? b & 15 : b >> 4) : b);
      }
      p += len + (len & 1);
    }
  }
  return written < width * height;
}

export type BmpEncodeOptions = {
  // 24: BITMAPINFOHEADER, no alpha. 32: BITMAPV4HEADER with an alpha mask.
  bits?: 24 | 32;
  dpi?: number;
};

export function encodeBmp(img: RGBA8, opts: BmpEncodeOptions = {}): Uint8Array {
  const bits = opts.bits ?? 32;
  const { width, height, data } = img;
  const headerSize = bits === 32 ? 108 : 40;
  const stride = (((width * bits + 31) >>> 5) << 2) >>> 0;
  const imageSize = stride * height;
  const offset = 14 + headerSize;
  const w = new ByteWriter(offset + imageSize);
  const ppm = opts.dpi ? Math.round(opts.dpi / 0.0254) : 2835;
  w.ascii('BM');
  w.u32le(offset + imageSize);
  w.u32le(0);
  w.u32le(offset);
  w.u32le(headerSize);
  w.u32le(width);
  w.u32le(height); // positive: bottom-up, the most widely supported order
  w.u16le(1);
  w.u16le(bits);
  w.u32le(bits === 32 ? 3 : 0);
  w.u32le(imageSize);
  w.u32le(ppm);
  w.u32le(ppm);
  w.u32le(0);
  w.u32le(0);
  if (bits === 32) {
    w.u32le(0x00ff0000);
    w.u32le(0x0000ff00);
    w.u32le(0x000000ff);
    w.u32le(0xff000000);
    w.ascii('BGRs'); // LCS_sRGB, stored little-endian as 'sRGB'
    w.pad(36 + 12);
  }
  const buf = w.buf;
  let o = w.length;
  const pad = stride - width * (bits >> 3);
  for (let y = height - 1; y >= 0; y--) {
    let s = y * width * 4;
    for (let x = 0; x < width; x++, s += 4) {
      buf[o++] = data[s + 2];
      buf[o++] = data[s + 1];
      buf[o++] = data[s];
      if (bits === 32) buf[o++] = data[s + 3];
    }
    for (let i = 0; i < pad; i++) buf[o++] = 0;
  }
  w.length = o;
  return w.result();
}
