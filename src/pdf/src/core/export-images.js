/**
 * Pictures for document export. PDF.js decodes every image a page paints; this module turns
 * those decoded pixels into PNG files, or, for plain DCT (JPEG) images, hands over the PDF's
 * original JPEG bytes unchanged so photos keep their size and quality.
 *
 *   encodePng({ width, height, data, kind })      -> Promise<Uint8Array>   (kind: PDF.js ImageKind)
 *   createImageSource(pdf, page, bytes)            -> { resolve(objId) -> Promise<Picture|null> }
 *
 * A Picture is { key, mime: 'image/png' | 'image/jpeg', extension, bytes, width, height }.
 */
import { PDFDocument, PDFName, PDFRawStream, PDFRef, PDFArray } from 'pdf-lib';
import { crc32 } from '../lib/crc32.js';
import { zlibDeflate } from './ooxml-zip.js';

/** PDF.js ImageKind values (pdfjs-dist 6.x). */
export const IMAGE_KIND = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 };
const MAX_PIXELS = 40e6;

function chunk(type, body) {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Rows filtered with whichever of None/Sub/Up gives the smallest absolute sum per row. */
function filterRows(pixels, stride, height, bpp) {
  const out = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
    let sub = 0,
      up = 0,
      none = 0;
    for (let i = 0; i < stride; i++) {
      const v = row[i];
      none += v < 128 ? v : 256 - v;
      const s = (v - (i >= bpp ? row[i - bpp] : 0)) & 0xff;
      sub += s < 128 ? s : 256 - s;
      const u = (v - (prev ? prev[i] : 0)) & 0xff;
      up += u < 128 ? u : 256 - u;
    }
    const filter = sub < none && sub <= up ? 1 : up < none ? 2 : 0;
    const at = y * (stride + 1);
    out[at] = filter;
    if (filter === 0) out.set(row, at + 1);
    else if (filter === 1)
      for (let i = 0; i < stride; i++) out[at + 1 + i] = row[i] - (i >= bpp ? row[i - bpp] : 0);
    else for (let i = 0; i < stride; i++) out[at + 1 + i] = row[i] - (prev ? prev[i] : 0);
  }
  return out;
}

/** A PNG file of decoded PDF.js image data (1-bit gray, RGB, or RGBA). */
export async function encodePng({ width, height, data, kind }) {
  if (!(width > 0 && height > 0) || width * height > MAX_PIXELS) throw new Error('Bad image size');
  let colorType, depth, bpp, stride, pixels;
  if (kind === IMAGE_KIND.GRAYSCALE_1BPP) {
    // PDF.js packs 1-bit rows MSB first with 1 = white, exactly PNG's 1-bit grayscale.
    colorType = 0;
    depth = 1;
    bpp = 1;
    stride = (width + 7) >> 3;
    pixels = data;
  } else if (kind === IMAGE_KIND.RGB_24BPP) {
    colorType = 2;
    depth = 8;
    bpp = 3;
    stride = width * 3;
    pixels = data;
  } else {
    let opaque = true;
    for (let i = 3; i < width * height * 4; i += 4)
      if (data[i] !== 255) {
        opaque = false;
        break;
      }
    depth = 8;
    if (opaque) {
      colorType = 2;
      bpp = 3;
      stride = width * 3;
      pixels = new Uint8Array(width * height * 3);
      for (let i = 0, j = 0; j < pixels.length; i += 4, j += 3) {
        pixels[j] = data[i];
        pixels[j + 1] = data[i + 1];
        pixels[j + 2] = data[i + 2];
      }
    } else {
      colorType = 6;
      bpp = 4;
      stride = width * 4;
      pixels = data;
    }
  }
  pixels =
    pixels instanceof Uint8Array
      ? pixels
      : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length);
  if (pixels.length < stride * height) throw new Error('Short image data');
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = depth;
  header[9] = colorType;
  const idat = await zlibDeflate(filterRows(pixels, stride, height, bpp));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * The affine map of a `pictureOrientation` (export-layout.js) from a width × height picture's
 * pixel grid to the turned picture's, as canvas transform terms, and the turned size.
 */
function turn({ across, down }, width, height) {
  const sideways = across[0] === 0;
  return {
    width: sideways ? height : width,
    height: sideways ? width : height,
    matrix: [
      across[0],
      across[1],
      down[0],
      down[1],
      (across[0] < 0 ? width : 0) + (down[0] < 0 ? height : 0),
      (across[1] < 0 ? width : 0) + (down[1] < 0 ? height : 0),
    ],
  };
}

/** Decoded PDF.js pixels turned as the page shows them, as RGBA. */
function turnedPixels({ width, height, data, kind }, orientation) {
  const { matrix: t, ...size } = turn(orientation, width, height);
  const out = new Uint8ClampedArray(size.width * size.height * 4);
  const stride = (width + 7) >> 3;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      // The pixel's centre lands on the turned pixel's centre.
      const X = Math.floor(t[0] * (x + 0.5) + t[2] * (y + 0.5) + t[4]),
        Y = Math.floor(t[1] * (x + 0.5) + t[3] * (y + 0.5) + t[5]);
      const at = (Y * size.width + X) * 4;
      if (kind === IMAGE_KIND.GRAYSCALE_1BPP) {
        const value = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        out[at] = out[at + 1] = out[at + 2] = value;
        out[at + 3] = 255;
      } else if (kind === IMAGE_KIND.RGB_24BPP) {
        const from = (y * width + x) * 3;
        out.set(data.subarray(from, from + 3), at);
        out[at + 3] = 255;
      } else {
        const from = (y * width + x) * 4;
        out.set(data.subarray(from, from + 4), at);
      }
    }
  return { ...size, data: out, kind: IMAGE_KIND.RGBA_32BPP };
}

/** PNG bytes of a browser ImageBitmap, through an OffscreenCanvas. */
async function bitmapPng(bitmap, orientation) {
  if (typeof OffscreenCanvas !== 'function') return null;
  const { matrix, width, height } = orientation
    ? turn(orientation, bitmap.width, bitmap.height)
    : { matrix: [1, 0, 0, 1, 0, 0], width: bitmap.width, height: bitmap.height };
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.setTransform(...matrix);
  context.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * PNG bytes of decoded PDF.js image data, whether pixels (Node) or an ImageBitmap (browsers),
 * turned or mirrored as the page shows the picture when an orientation is given.
 */
export async function pictureBytes(object, orientation = null) {
  try {
    if (object?.data)
      return await encodePng(orientation ? turnedPixels(object, orientation) : object);
    if (object?.bitmap) return await bitmapPng(object.bitmap, orientation);
  } catch {
    /* undecodable picture */
  }
  return null;
}

/** Read a PDF.js page or document object, waiting a short while for late image data. */
function pdfjsObject(store, id, wait = 4000) {
  if (!store) return Promise.resolve(null);
  try {
    if (store.has(id)) return Promise.resolve(store.get(id));
  } catch {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), wait);
    try {
      store.get(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

const name = (dict, key) => {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFArray
    ? value.size() === 1
      ? value.lookup(0)?.toString()
      : 'array'
    : value?.toString();
};

/** The original JPEG bytes of a DCT image Office can show as is, or null. */
function passthroughJpeg(doc, ref) {
  const match = /^(\d+)R(\d*)$/.exec(ref || '');
  if (!doc || !match) return null;
  const stream = doc.context.lookup(PDFRef.of(+match[1], +(match[2] || 0)));
  if (!(stream instanceof PDFRawStream)) return null;
  const dict = stream.dict;
  if (name(dict, 'Filter') !== '/DCTDecode') return null;
  if (['SMask', 'Mask', 'Decode', 'DecodeParms'].some((key) => dict.has(PDFName.of(key))))
    return null;
  const space = dict.lookup(PDFName.of('ColorSpace'));
  let ok = false;
  if (!space) ok = true;
  else if (['/DeviceRGB', '/DeviceGray'].includes(space.toString())) ok = true;
  else if (space instanceof PDFArray && space.lookup(0)?.toString() === '/ICCBased') {
    const n = space.lookup(1)?.dict?.lookup(PDFName.of('N'))?.asNumber?.();
    ok = n === 1 || n === 3;
  }
  const bytes = stream.contents;
  if (!ok || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  return bytes;
}

/**
 * Resolves the images a PDF.js page paints into Pictures, caching by image object so a picture
 * drawn many times is stored once.
 */
export async function createImageSource(pdf, bytes) {
  let doc = null;
  if (bytes?.length) {
    try {
      doc = await PDFDocument.load(bytes, {
        ignoreEncryption: true,
        updateMetadata: false,
      });
      // Encrypted streams would need decrypting first; leave them to PDF.js's decoded pixels.
      if (doc.isEncrypted) doc = null;
    } catch {
      doc = null;
    }
  }
  const cache = new Map();
  return {
    /** `orientation` (see export-layout.js) turns the picture as the page shows it. */
    async resolve(page, id, orientation = null) {
      const store = id.startsWith('g_') ? page.commonObjs : page.objs;
      const object = await pdfjsObject(store, id);
      if (!object) return null;
      const base = object.ref || `${page._pageIndex ?? ''}:${id}`;
      const key = orientation ? `${base}~${orientation.across},${orientation.down}` : base;
      if (cache.has(key)) return cache.get(key);
      const sideways = orientation?.across[0] === 0;
      const result = (async () => {
        if (orientation) {
          const png = await pictureBytes(object, orientation);
          return png
            ? {
                key,
                mime: 'image/png',
                extension: 'png',
                bytes: png,
                width: sideways ? object.height : object.width,
                height: sideways ? object.width : object.height,
              }
            : null;
        }
        const jpeg = passthroughJpeg(doc, object.ref);
        if (jpeg)
          return {
            key,
            mime: 'image/jpeg',
            extension: 'jpeg',
            bytes: jpeg,
            width: object.width,
            height: object.height,
          };
        const png = await pictureBytes(object);
        return png
          ? {
              key,
              mime: 'image/png',
              extension: 'png',
              bytes: png,
              width: object.width,
              height: object.height,
            }
          : null;
      })();
      cache.set(key, result);
      return result;
    },
  };
}

/** Pixel size of PNG or JPEG bytes (for pictures handed over by `renderPage`). */
export function pictureSize(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) break;
      const marker = bytes[at + 1];
      const length = (bytes[at + 2] << 8) | bytes[at + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return {
          height: (bytes[at + 5] << 8) | bytes[at + 6],
          width: (bytes[at + 7] << 8) | bytes[at + 8],
        };
      at += 2 + length;
    }
  }
  return null;
}
