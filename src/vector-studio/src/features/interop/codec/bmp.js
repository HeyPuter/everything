/**
 * BMP and device-independent bitmaps (DIB, also found in metafile
 * previews): 1/4/8-bit palettes, 16/24/32-bit color with bit fields and
 * alpha, RLE4/RLE8 compression, top-down and bottom-up rows.
 */

export function isBMP(b) {
  return b.length > 26 && b[0] === 0x42 && b[1] === 0x4d;
}

/** Decode a .bmp file: { width, height, data (RGBA), ppi }. */
export function decodeBMP(bytes) {
  if (!isBMP(bytes)) throw new Error('Not a BMP file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pixelOffset = dv.getUint32(10, true);
  return decodeDIB(bytes, 14, pixelOffset);
}

/** Decode a DIB starting with its info header at `p`; pixels at `pixelOffset` (default: after the palette). */
export function decodeDIB(bytes, p = 0, pixelOffset = -1) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hsize = dv.getUint32(p, true);
  let width;
  let height;
  let bpp;
  let compression = 0;
  let colors = 0;
  let ppm = 0;
  let masks = null;
  if (hsize === 12) {
    width = dv.getUint16(p + 4, true);
    height = dv.getInt16(p + 6, true);
    bpp = dv.getUint16(p + 10, true);
  } else {
    width = dv.getInt32(p + 4, true);
    height = dv.getInt32(p + 8, true);
    bpp = dv.getUint16(p + 14, true);
    compression = dv.getUint32(p + 16, true);
    ppm = dv.getInt32(p + 24, true);
    colors = dv.getUint32(p + 32, true);
    if (compression === 3 || compression === 6) {
      // Bit fields follow a 40-byte header, or are inside V4/V5 headers.
      const mp = p + 40;
      masks = [dv.getUint32(mp, true), dv.getUint32(mp + 4, true), dv.getUint32(mp + 8, true), hsize >= 56 || compression === 6 ? dv.getUint32(mp + 12, true) : 0];
    }
  }
  const topDown = height < 0;
  height = Math.abs(height);
  if (!width || !height || width > 30000 || height > 30000) throw new Error('The bitmap size is not valid.');
  const palEntry = hsize === 12 ? 3 : 4;
  const palCount = bpp <= 8 ? colors || 1 << bpp : 0;
  let palStart = p + hsize;
  if ((compression === 3 || compression === 6) && hsize === 40) palStart += compression === 6 ? 16 : 12;
  const palette = [];
  for (let i = 0; i < palCount; i++) {
    const q = palStart + i * palEntry;
    palette.push([bytes[q + 2] ?? 0, bytes[q + 1] ?? 0, bytes[q] ?? 0]);
  }
  if (pixelOffset < 0) pixelOffset = palStart + palCount * palEntry;
  const out = new Uint8ClampedArray(width * height * 4);
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const row = topDown ? y : height - 1 - y;
    const o = (row * width + x) * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  };
  if (compression === 1 || compression === 2) {
    // RLE8 / RLE4: rows from the bottom.
    let x = 0;
    let y = 0;
    let i = pixelOffset;
    const four = compression === 2;
    const pal = (idx) => palette[idx] || [0, 0, 0];
    while (i < bytes.length && y < height) {
      const n = bytes[i++];
      const v = bytes[i++];
      if (n > 0) {
        for (let k = 0; k < n; k++) {
          const idx = four ? (k % 2 ? v & 15 : v >> 4) : v;
          put(x++, y, ...pal(idx));
        }
      } else if (v === 0) {
        x = 0;
        y++;
      } else if (v === 1) break;
      else if (v === 2) {
        x += bytes[i++];
        y += bytes[i++];
      } else {
        for (let k = 0; k < v; k++) {
          const byte = four ? bytes[i + (k >> 1)] : bytes[i + k];
          const idx = four ? (k % 2 ? byte & 15 : byte >> 4) : byte;
          put(x++, y, ...pal(idx));
        }
        const used = four ? Math.ceil(v / 2) : v;
        i += used + (used & 1);
      }
    }
    // RLE images read bottom-up with put()'s flip; transparent where nothing was written stays clear.
    return { width, height, data: out, ppi: ppm ? ppm * 0.0254 : 0 };
  }
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const shiftOf = (m) => {
    if (!m) return [0, 0];
    let s = 0;
    while (!((m >>> s) & 1)) s++;
    let len = 0;
    while ((m >>> (s + len)) & 1) len++;
    return [s, len];
  };
  let fields = masks;
  if (!fields && bpp === 16) fields = [0x7c00, 0x03e0, 0x001f, 0];
  const shifts = fields ? fields.map(shiftOf) : null;
  const scaled = (v, i) => {
    const [s, len] = shifts[i];
    if (!len) return i === 3 ? 255 : 0;
    const x = (v >>> s) & ((1 << len) - 1);
    return Math.round((x * 255) / ((1 << len) - 1));
  };
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = pixelOffset + y * stride;
    for (let x = 0; x < width; x++) {
      if (bpp <= 8) {
        const bit = x * bpp;
        const byte = bytes[row + (bit >> 3)] ?? 0;
        const idx = (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        put(x, y, ...(palette[idx] || [0, 0, 0]));
      } else if (bpp === 24) {
        const q = row + x * 3;
        put(x, y, bytes[q + 2], bytes[q + 1], bytes[q]);
      } else if (bpp === 16) {
        const v = bytes[row + x * 2] | (bytes[row + x * 2 + 1] << 8);
        put(x, y, scaled(v, 0), scaled(v, 1), scaled(v, 2), fields[3] ? scaled(v, 3) : 255);
      } else if (bpp === 32) {
        const q = row + x * 4;
        const v = (bytes[q] | (bytes[q + 1] << 8) | (bytes[q + 2] << 16) | (bytes[q + 3] << 24)) >>> 0;
        if (shifts) put(x, y, scaled(v, 0), scaled(v, 1), scaled(v, 2), fields[3] ? scaled(v, 3) : 255);
        else {
          put(x, y, bytes[q + 2], bytes[q + 1], bytes[q], bytes[q + 3]);
          if (bytes[q + 3]) anyAlpha = true;
        }
      }
    }
  }
  // 32-bit BI_RGB files usually leave the fourth byte zero: treat them as opaque.
  if (bpp === 32 && !shifts && !anyAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { width, height, data: out, ppi: ppm ? ppm * 0.0254 : 0 };
}
