// Removes embedded location from raster images served on public links whose map is hidden.
// JPEG keeps its EXIF block (orientation) with the GPS directory emptied; XMP, IPTC and text chunks are dropped.

const TYPE_SIZES = Object.freeze({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 });
const GPS_TAG = 0x8825;
const ascii = (bytes, at, text) => [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));
const fail = () => { throw new RangeError('unreadable_image'); };

function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** A copy of an APP1 Exif segment whose GPS directory has no entries and whose GPS values are zeroed. */
function emptyGps(segment) {
  const out = segment.slice();
  const tiff = 10;
  const little = ascii(out, tiff, 'II');
  if (!little && !ascii(out, tiff, 'MM')) fail();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const size = out.length - tiff;
  const inside = (offset, length, min = 0) => { if (offset < min || offset + length > size) fail(); };
  const u16 = (offset) => { inside(offset, 2); return view.getUint16(tiff + offset, little); };
  const u32 = (offset) => { inside(offset, 4); return view.getUint32(tiff + offset, little); };
  // Never inside the 8-byte TIFF header.
  const zero = (offset, length) => { inside(offset, length, 8); out.fill(0, tiff + offset, tiff + offset + length); };
  const ifd0 = u32(4);
  const count = u16(ifd0);
  for (let n = 0; n < count; n++) {
    const entry = ifd0 + 2 + n * 12;
    if (u16(entry) !== GPS_TAG) continue;
    const gps = u32(entry + 8);
    const items = u16(gps);
    for (let k = 0; k < items; k++) {
      const field = gps + 2 + k * 12;
      const bytes = (TYPE_SIZES[u16(field + 2)] ?? 1) * u32(field + 4);
      if (bytes > 4) zero(u32(field + 8), bytes);
    }
    // An empty directory (count 0, no next) stays valid for readers that follow the pointer.
    zero(gps, 2 + items * 12 + 4);
  }
  return out;
}

/** End of the entropy-coded data that starts at `at`: the next marker that is not a stuffed byte or a restart. */
function scanEnd(input, at) {
  for (let i = at; i + 1 < input.length; i++) {
    if (input[i] !== 0xff) continue;
    const next = input[i + 1];
    if (next !== 0x00 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) return i;
  }
  return fail();
}

/**
 * Segments are copied except APPn blocks other than JFIF, Exif (GPS emptied), ICC profiles and Adobe colour info, and
 * comments. The file ends at EOI, so trailers (MPF images, motion photos, vendor data) are dropped.
 */
function stripJpeg(input) {
  if (input[0] !== 0xff || input[1] !== 0xd8) fail();
  const parts = [input.subarray(0, 2)];
  let at = 2;
  while (at + 1 < input.length) {
    if (input[at] !== 0xff) fail();
    const marker = input[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd9) { parts.push(input.subarray(at, at + 2)); return concat(parts); }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(input.subarray(at, at + 2)); at += 2; continue; }
    if (at + 4 > input.length) fail();
    const length = (input[at + 2] << 8) | input[at + 3];
    if (length < 2 || at + 2 + length > input.length) fail();
    const segment = input.subarray(at, at + 2 + length);
    at += 2 + length;
    if (marker === 0xda) {
      // Start of scan: the header, then image data up to the next marker (more scans follow in progressive files).
      const end = scanEnd(input, at);
      parts.push(segment, input.subarray(at, end));
      at = end;
      continue;
    }
    if (marker === 0xe1) { if (ascii(segment, 4, 'Exif\0\0')) parts.push(emptyGps(segment)); continue; }
    if (marker === 0xe2) { if (ascii(segment, 4, 'ICC_PROFILE\0')) parts.push(segment); continue; }
    if ((marker >= 0xe0 && marker <= 0xef && marker !== 0xe0 && marker !== 0xee) || marker === 0xfe) continue;
    parts.push(segment);
  }
  return fail();
}

/** GIF without application (XMP and other metadata) and comment extensions; the NETSCAPE loop block stays. */
function stripGif(input) {
  if (!ascii(input, 0, 'GIF87a') && !ascii(input, 0, 'GIF89a')) fail();
  const table = (flags) => (flags & 0x80 ? 3 * (2 ** ((flags & 0x07) + 1)) : 0);
  const blocks = (from) => {
    let i = from;
    while (i < input.length && input[i] !== 0) i += input[i] + 1;
    if (i >= input.length) fail();
    return i + 1;
  };
  let at = 13 + table(input[10]);
  if (at > input.length) fail();
  const parts = [input.subarray(0, at)];
  while (at < input.length) {
    const kind = input[at];
    if (kind === 0x3b) { parts.push(input.subarray(at, at + 1)); return concat(parts); }
    if (kind === 0x2c) {
      const end = blocks(at + 10 + table(input[at + 9]) + 1);
      parts.push(input.subarray(at, end));
      at = end;
    } else if (kind === 0x21) {
      const label = input[at + 1];
      const end = blocks(at + 2);
      const loop = label === 0xff && ascii(input, at + 3, 'NETSCAPE2.0');
      if ((label !== 0xff && label !== 0xfe) || loop) parts.push(input.subarray(at, end));
      at = end;
    } else fail();
  }
  return fail();
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt']);
function stripPng(input) {
  if (input.length < 8 || !ascii(input, 1, 'PNG')) fail();
  const parts = [input.subarray(0, 8)];
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let at = 8;
  while (at + 12 <= input.length) {
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > input.length) fail();
    const type = String.fromCharCode(...input.subarray(at + 4, at + 8));
    if (!PNG_DROP.has(type)) parts.push(input.subarray(at, end));
    at = end;
    if (type === 'IEND') return concat(parts);
  }
  return fail();
}

function stripWebp(input) {
  if (!ascii(input, 0, 'RIFF') || !ascii(input, 8, 'WEBP')) fail();
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const parts = [];
  let at = 12;
  while (at + 8 <= input.length) {
    const type = String.fromCharCode(...input.subarray(at, at + 4));
    const length = view.getUint32(at + 4, true);
    const end = at + 8 + length + (length % 2);
    if (at + 8 + length > input.length) fail();
    if (type === 'VP8X') {
      const chunk = input.slice(at, Math.min(end, input.length));
      chunk[8] &= ~0x0c; // EXIF and XMP flags
      parts.push(chunk);
    } else if (type !== 'EXIF' && type !== 'XMP ') parts.push(input.subarray(at, Math.min(end, input.length)));
    at = end;
  }
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(input.subarray(0, 12));
  out.set(body, 12);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

/** Image bytes without embedded location, or null when the image cannot be parsed safely. */
export function stripLocation(bytes, mime) {
  try {
    if (mime === 'image/jpeg') return stripJpeg(bytes);
    if (mime === 'image/png') return stripPng(bytes);
    if (mime === 'image/webp') return stripWebp(bytes);
    if (mime === 'image/gif') return stripGif(bytes);
  } catch { /* unreadable */ }
  return null;
}

const STRIPPABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
/** Types that can embed a location this module cannot strip (HEIC, AVIF, video). */
export const keepsLocation = (mime) => typeof mime === 'string' && /^(image|video)\//i.test(mime) && !STRIPPABLE.has(mime.toLowerCase());
