/**
 * Raster formats browsers do not decode (TIFF, PSD) or that are better
 * stored as PNG (BMP): decoded in JavaScript and re-encoded as PNG.
 */
import { isTIFF, decodeTIFF } from './tiff.js';
import { isBMP, decodeBMP } from './bmp.js';
import { isPSD, decodePSD } from './psd.js';
import { encodePNG } from './png.js';

/** 'tiff' | 'bmp' | 'psd' | null from the leading bytes. */
export function rasterKind(bytes) {
  if (isTIFF(bytes)) return 'tiff';
  if (isPSD(bytes)) return 'psd';
  if (isBMP(bytes)) return 'bmp';
  return null;
}

/** Decode to { width, height, data (RGBA), ppi }, or null for other formats. */
export function decodeRaster(bytes) {
  const kind = rasterKind(bytes);
  if (kind === 'tiff') return decodeTIFF(bytes);
  if (kind === 'psd') return decodePSD(bytes);
  if (kind === 'bmp') return decodeBMP(bytes);
  return null;
}

/** PNG bytes for a TIFF/PSD/BMP file ({ mime, bytes, width, height, ppi }), or null. */
export async function rasterToPNG(bytes) {
  const img = decodeRaster(bytes);
  if (!img) return null;
  return { mime: 'image/png', bytes: await encodePNG(img, { ppi: img.ppi }), width: img.width, height: img.height, ppi: img.ppi };
}
