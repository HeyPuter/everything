/**
 * PNG encoding for decoded pixels (TIFF, BMP, PSD and PDF images become
 * PNG assets, which every renderer and exporter understands), and a small
 * raster container: { width, height, data: Uint8ClampedArray RGBA }.
 */
import { crc32, deflateZlib, zlibStored } from './zlib.js';

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** True when every pixel is opaque. */
export function isOpaque(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
}

/** Scanlines with the Sub filter on every row (a good, cheap default for photos and flat art). */
function filtered(data, width, height, channels) {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 1;
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        const v = data[row + x * 4 + c];
        const left = x ? data[row + (x - 1) * 4 + c] : 0;
        raw[o + 1 + x * channels + c] = (v - left) & 255;
      }
    }
  }
  return raw;
}

function pngBytes(width, height, channels, idat, ppi) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (ppi > 0) {
    const phys = new Uint8Array(9);
    const ppm = Math.round(ppi / 0.0254);
    new DataView(phys.buffer).setUint32(0, ppm);
    new DataView(phys.buffer).setUint32(4, ppm);
    phys[8] = 1;
    parts.push(chunk('pHYs', phys));
  }
  parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
  return concat(parts);
}

/** PNG bytes for RGBA pixels (RGB when fully opaque). */
export async function encodePNG({ width, height, data }, { ppi = 0 } = {}) {
  const channels = isOpaque(data) ? 3 : 4;
  return pngBytes(width, height, channels, await deflateZlib(filtered(data, width, height, channels)), ppi);
}

/** Synchronous PNG (stored blocks: larger, for tests and thumbnails). */
export function encodePNGSync({ width, height, data }) {
  const channels = isOpaque(data) ? 3 : 4;
  return pngBytes(width, height, channels, zlibStored(filtered(data, width, height, channels)), 0);
}
