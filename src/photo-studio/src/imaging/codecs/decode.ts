// One entry point for every format these codecs read. Formats the browser
// decodes natively (PNG, JPEG, WebP, AVIF, HEIC, SVG) and PSD/PSB return null
// so callers fall back to createImageBitmap or the PSD module.
import type { RGBA8 } from '../types';
import { CodecError, type SizeLimits } from './bytes';
import { decodeBmp } from './bmp';
import { decodeGif, type GifFrame } from './gif';
import { decodeIco, pickIcoEntry } from './ico';
import { decodeNetpbm } from './netpbm';
import { sniffImageFormat, type ImageFormat } from './sniff';
import { decodeTga } from './tga';
import { decodeTiff, type TiffPage } from './tiff';

export type DecodedImage = {
  format: ImageFormat;
  width: number;
  height: number;
  rgba8: RGBA8;
  // Straight RGBA16 for 16-bit TIFF and Netpbm sources.
  data16?: Uint16Array;
  // Straight RGBA float for float or 32-bit integer TIFF sources.
  dataF32?: Float32Array;
  icc?: Uint8Array;
  dpi?: { x: number; y: number };
  // EXIF/TIFF orientation as stored (pixels are not rotated; see applyOrientation).
  orientation?: number;
  // Extra content beyond the main image.
  tiffPages?: TiffPage[];
  gifFrames?: GifFrame[];
  // NETSCAPE2.0 repeat count of an animated GIF (see GifDecodeResult.loopCount).
  gifLoopCount?: number;
  // Later GIF frames were left out because they exceed the memory budget.
  gifTruncated?: boolean;
  // Things the user may want to know (CMYK converted, editor layers ignored, ...).
  notes: string[];
};

export type DecodeImageOptions = {
  decodePng?: (png: Uint8Array) => RGBA8;
  // Refuse images beyond these sizes from their headers, before decoding.
  limits?: SizeLimits;
  // Decode only the first page or frame of multi-page and animated files.
  firstOnly?: boolean;
};

export function decodeImage(bytes: Uint8Array, opts: DecodeImageOptions = {}): DecodedImage | null {
  const format = sniffImageFormat(bytes);
  const { limits, firstOnly } = opts;
  const base = (rgba8: RGBA8): DecodedImage => ({ format, width: rgba8.width, height: rgba8.height, rgba8, notes: [] });
  switch (format) {
    case 'tiff':
    case 'bigtiff': {
      const res = decodeTiff(bytes, { limits, firstPageOnly: firstOnly });
      const p = res.pages[0];
      const out = base(p.rgba8);
      if (p.data16) out.data16 = p.data16;
      if (p.dataF32) out.dataF32 = p.dataF32;
      if (p.icc) out.icc = p.icc;
      if (p.orientation) out.orientation = p.orientation;
      if (p.resolution && p.resolution.unit !== 'none') {
        const f = p.resolution.unit === 'cm' ? 2.54 : 1;
        out.dpi = { x: p.resolution.x * f, y: p.resolution.y * f };
      }
      if (res.pages.length > 1) out.tiffPages = res.pages;
      if (p.colorModel === 'cmyk') out.notes.push('CMYK image converted to RGB without color management.');
      if (p.hasImageSourceData) out.notes.push('Layer data stored by another editor was ignored; the flattened image was opened.');
      if (res.pages.length > 1) out.notes.push(`The file has ${res.pages.length} pages; the first was opened.`);
      out.notes.push(...res.warnings);
      return out;
    }
    case 'gif': {
      const res = decodeGif(bytes, { limits, maxFrames: firstOnly ? 1 : undefined });
      const out = base(res.frames[0].rgba);
      if (res.frames.length > 1) {
        out.gifFrames = res.frames;
        out.gifLoopCount = res.loopCount;
        if (res.truncated) out.gifTruncated = true;
        out.notes.push(`Animated GIF with ${res.frames.length} frames; the first was opened.`);
      }
      return out;
    }
    case 'bmp': {
      const res = decodeBmp(bytes, limits);
      const out = base(res.rgba8);
      if (res.dpi) out.dpi = res.dpi;
      if (res.icc) out.icc = res.icc;
      return out;
    }
    case 'ico':
    case 'cur': {
      const res = decodeIco(bytes, opts);
      const usable = { ...res, entries: res.entries.filter((e) => e.rgba) };
      if (!usable.entries.length) throw new CodecError('This icon only holds PNG images; decode them with decodeIco and the browser.');
      const best = pickIcoEntry(usable);
      const out = base(best.rgba!);
      if (res.entries.some((e) => !e.rgba && e.width > best.width)) out.notes.push('A larger PNG image in the icon was not decoded.');
      return out;
    }
    case 'tga':
      return base(decodeTga(bytes, limits).rgba8);
    case 'pnm': {
      const res = decodeNetpbm(bytes, limits);
      const out = base(res.rgba8);
      if (res.data16) out.data16 = res.data16;
      return out;
    }
    default:
      return null;
  }
}
