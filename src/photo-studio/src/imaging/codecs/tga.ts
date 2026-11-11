// Truevision TGA reader and writer from the "Truevision TGA File Format
// Specification, version 2.0" (1989): color-mapped, true-color and grayscale
// images, raw or run-length encoded, any origin corner.
import type { RGBA8 } from '../types';
import { ByteWriter, CodecError, checkSize, rethrowAsCodecError, asciiAt, type SizeLimits } from './bytes';

export type TgaDecodeResult = {
  width: number;
  height: number;
  bitsPerPixel: number;
  // 1/9 color-mapped, 2/10 true-color, 3/11 grayscale (9-11 are RLE).
  imageType: number;
  rle: boolean;
  origin: 'bottom-left' | 'top-left' | 'bottom-right' | 'top-right';
  hasAlpha: boolean;
  rgba8: RGBA8;
  id?: string;
};

export function decodeTga(bytes: Uint8Array, limits?: SizeLimits): TgaDecodeResult {
  try {
    return decodeTgaImpl(bytes, limits);
  } catch (e) {
    rethrowAsCodecError(e, 'TGA');
  }
}
function decodeTgaImpl(bytes: Uint8Array, limits?: SizeLimits): TgaDecodeResult {
  if (bytes.length < 18) throw new CodecError('Not a TGA file.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLength = bytes[0];
  const cmapType = bytes[1];
  const imageType = bytes[2];
  const cmapFirst = dv.getUint16(3, true);
  const cmapLength = dv.getUint16(5, true);
  const cmapDepth = bytes[7];
  const width = dv.getUint16(12, true);
  const height = dv.getUint16(14, true);
  const depth = bytes[16];
  const desc = bytes[17];
  const base = imageType & 7;
  const rle = imageType >= 9;
  if (![1, 2, 3].includes(base) || (imageType > 3 && imageType < 9) || imageType > 11 || cmapType > 1)
    throw new CodecError('Not a supported TGA image type.');
  if (!width || !height) throw new CodecError('TGA has no dimensions.');
  checkSize(width, height, limits);
  const validDepth = base === 1 ? depth === 8 || depth === 16 : base === 3 ? depth === 8 || depth === 16 : [15, 16, 24, 32].includes(depth);
  if (!validDepth) throw new CodecError(`${depth}-bit TGA images of type ${imageType} are not supported.`);
  let p = 18;
  const id = idLength ? asciiAt(bytes, p, idLength).replace(/\0+$/, '') : undefined;
  p += idLength;
  // Color map, expanded to RGBA.
  let cmap: Uint8Array | null = null;
  if (cmapType === 1) {
    const eb = Math.ceil(cmapDepth / 8);
    if (base === 1) {
      cmap = new Uint8Array((cmapFirst + cmapLength) * 4);
      for (let i = 0; i < cmapLength; i++) readPixel(bytes, p + i * eb, cmapDepth, cmap, (cmapFirst + i) * 4);
    }
    p += cmapLength * eb;
  }
  if (base === 1 && !cmap) throw new CodecError('Color-mapped TGA has no color map.');
  const bpp = Math.ceil(depth / 8);
  const n = width * height;
  // Decode the pixel stream (raw or RLE) into one packed buffer first.
  let raw: Uint8Array;
  if (!rle) raw = bytes.subarray(p, p + n * bpp);
  else {
    raw = new Uint8Array(n * bpp);
    let o = 0;
    const end = n * bpp;
    while (o < end && p < bytes.length) {
      const h = bytes[p++];
      const count = (h & 127) + 1;
      if (h & 128) {
        for (let k = 0; k < count && o < end; k++) for (let b = 0; b < bpp; b++) raw[o++] = bytes[p + b];
        p += bpp;
      } else {
        const len = Math.min(count * bpp, end - o);
        raw.set(bytes.subarray(p, p + len), o);
        o += len;
        p += count * bpp;
      }
    }
  }
  if (raw.length < n * bpp) {
    const padded = new Uint8Array(n * bpp);
    padded.set(raw);
    raw = padded;
  }
  const alphaBits = desc & 15;
  const right = !!(desc & 0x10);
  const top = !!(desc & 0x20);
  const out = new Uint8ClampedArray(n * 4);
  const px = new Uint8Array(4);
  for (let i = 0; i < n; i++) {
    const sx = i % width;
    const sy = (i / width) | 0;
    const x = right ? width - 1 - sx : sx;
    const y = top ? sy : height - 1 - sy;
    const o = (y * width + x) * 4;
    const s = i * bpp;
    if (base === 1) {
      const idx = depth === 8 ? raw[s] : raw[s] | (raw[s + 1] << 8);
      const c = idx * 4;
      out[o] = cmap![c];
      out[o + 1] = cmap![c + 1];
      out[o + 2] = cmap![c + 2];
      out[o + 3] = cmap![c + 3];
    } else if (base === 3) {
      out[o] = out[o + 1] = out[o + 2] = raw[s];
      out[o + 3] = depth === 16 ? raw[s + 1] : 255;
    } else {
      readPixel(raw, s, depth, px, 0);
      out[o] = px[0];
      out[o + 1] = px[1];
      out[o + 2] = px[2];
      out[o + 3] = px[3];
    }
  }
  // Alpha: TGA 2.0 files say in the extension area whether the fourth channel
  // is alpha; older files rely on the descriptor's attribute bit count.
  let hasAlpha = (depth === 32 || depth === 16 || (base === 1 && (cmapDepth === 32 || cmapDepth === 16))) && (base !== 3 || depth === 16);
  let premultiplied = false;
  const attr = extensionAttributes(bytes, dv);
  if (attr !== undefined) {
    if (attr <= 2) hasAlpha = false;
    else if (attr === 4) premultiplied = true;
  } else if (hasAlpha && alphaBits === 0 && base !== 3) {
    // No declared alpha: keep the fourth byte only if someone wrote it.
    let any = false;
    for (let i = 3; i < out.length && !any; i += 4) if (out[i]) any = true;
    hasAlpha = any && depth === 32;
  }
  if (!hasAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  else if (premultiplied)
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3];
      if (a && a < 255) {
        out[i] = (out[i] * 255) / a;
        out[i + 1] = (out[i + 1] * 255) / a;
        out[i + 2] = (out[i + 2] * 255) / a;
      }
    }
  return {
    width,
    height,
    bitsPerPixel: depth,
    imageType,
    rle,
    origin: `${top ? 'top' : 'bottom'}-${right ? 'right' : 'left'}`,
    hasAlpha,
    rgba8: { width, height, data: out },
    ...(id ? { id } : {}),
  };
}

function readPixel(b: Uint8Array, s: number, depth: number, out: Uint8Array | Uint8ClampedArray, o: number) {
  if (depth === 24 || depth === 32) {
    out[o] = b[s + 2];
    out[o + 1] = b[s + 1];
    out[o + 2] = b[s];
    out[o + 3] = depth === 32 ? b[s + 3] : 255;
  } else if (depth === 15 || depth === 16) {
    const v = b[s] | (b[s + 1] << 8);
    out[o] = (((v >> 10) & 31) * 255 + 15) / 31;
    out[o + 1] = (((v >> 5) & 31) * 255 + 15) / 31;
    out[o + 2] = ((v & 31) * 255 + 15) / 31;
    out[o + 3] = depth === 16 && v & 0x8000 ? 255 : depth === 16 ? 0 : 255;
  } else {
    out[o] = out[o + 1] = out[o + 2] = b[s];
    out[o + 3] = 255;
  }
}

function extensionAttributes(bytes: Uint8Array, dv: DataView): number | undefined {
  if (bytes.length < 44 || asciiAt(bytes, bytes.length - 18, 16) !== 'TRUEVISION-XFILE') return undefined;
  const ext = dv.getUint32(bytes.length - 26, true);
  if (!ext || ext + 495 > bytes.length || dv.getUint16(ext, true) < 495) return undefined;
  return bytes[ext + 494];
}

export type TgaEncodeOptions = {
  bits?: 24 | 32;
  rle?: boolean;
  origin?: 'top-left' | 'bottom-left';
};

export function encodeTga(img: RGBA8, opts: TgaEncodeOptions = {}): Uint8Array {
  const { width, height, data } = img;
  if (!width || !height || width > 65535 || height > 65535) throw new CodecError('TGA dimensions must be 1-65535.');
  const bits = opts.bits ?? 32;
  const bpp = bits >> 3;
  const top = (opts.origin ?? 'top-left') === 'top-left';
  const w = new ByteWriter(18 + width * height * (bpp + 1) + 26);
  w.u8(0);
  w.u8(0);
  w.u8(opts.rle ? 10 : 2);
  w.pad(5);
  w.u16le(0);
  w.u16le(0);
  w.u16le(width);
  w.u16le(height);
  w.u8(bits);
  w.u8((bits === 32 ? 8 : 0) | (top ? 0x20 : 0));
  const row = new Uint8Array(width * bpp);
  for (let r = 0; r < height; r++) {
    const y = top ? r : height - 1 - r;
    for (let x = 0, s = y * width * 4, o = 0; x < width; x++, s += 4) {
      row[o++] = data[s + 2];
      row[o++] = data[s + 1];
      row[o++] = data[s];
      if (bpp === 4) row[o++] = data[s + 3];
    }
    if (!opts.rle) {
      w.bytes(row);
      continue;
    }
    // Packets stay within a scanline, as TGA 2.0 recommends.
    const same = (a: number, b: number) => {
      for (let k = 0; k < bpp; k++) if (row[a * bpp + k] !== row[b * bpp + k]) return false;
      return true;
    };
    let x = 0;
    while (x < width) {
      let run = 1;
      while (x + run < width && run < 128 && same(x, x + run)) run++;
      if (run > 1) {
        w.u8(0x80 | (run - 1));
        w.bytes(row.subarray(x * bpp, x * bpp + bpp));
        x += run;
      } else {
        let lit = 1;
        while (x + lit < width && lit < 128 && !(x + lit + 1 < width && same(x + lit, x + lit + 1))) lit++;
        w.u8(lit - 1);
        w.bytes(row.subarray(x * bpp, (x + lit) * bpp));
        x += lit;
      }
    }
  }
  // TGA 2.0 footer without extension or developer areas.
  w.u32le(0);
  w.u32le(0);
  w.ascii('TRUEVISION-XFILE.');
  w.u8(0);
  return w.result();
}
