// Synchronous PNG encoding of RGBA pixels, so exporters can run inside a script call (which
// cannot wait for the browser's asynchronous canvas encoders).
import { zlibSync } from 'three/examples/jsm/libs/fflate.module.js';
import { crc32 } from '../../render/final/zip';

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode 8-bit RGBA pixels (rows top to bottom) as a PNG file. */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  const w = Math.max(1, width | 0),
    h = Math.max(1, height | 0);
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    // "Sub" filter: each byte minus the one four bytes to the left (compresses smooth images well)
    raw[o] = 1;
    const src = y * stride;
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (rgba[src + x] - (x >= 4 ? rgba[src + x - 4] : 0)) & 0xff;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
