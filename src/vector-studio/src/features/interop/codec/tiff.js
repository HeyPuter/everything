/**
 * TIFF decoding and encoding.
 *
 * Decoding: strips and tiles; no compression, LZW, Deflate and PackBits
 * (with the horizontal predictor); 1-16 bit samples and 32-bit floats;
 * bilevel, grayscale, palette, RGB, CMYK and YCbCr (uncompressed) images;
 * associated and unassociated alpha. The first image of the file is read.
 *
 * Encoding: 8-bit RGB(A), CMYK or grayscale, uncompressed, LZW or Deflate,
 * either byte order, with the resolution recorded.
 */
import { inflate, deflateZlib } from './zlib.js';
import { lzw as lzwDecode } from '../pdf/filters.js';
import { cmykEngine } from '../../../lib/color.js';

export function isTIFF(b) {
  return b.length > 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42));
}

function packBits(src, expected) {
  const out = new Uint8Array(expected);
  let o = 0;
  for (let i = 0; i < src.length && o < expected; ) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) {
      for (let k = 0; k <= n && o < expected; k++) out[o++] = src[i++];
    } else if (n !== -128) {
      const v = src[i++];
      for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = v;
    }
  }
  return out;
}

/** Decode the first image: { width, height, data: Uint8ClampedArray (RGBA), ppi }. */
export function decodeTIFF(bytes) {
  if (!isTIFF(bytes)) throw new Error('Not a TIFF file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[0] === 0x49;
  const u16 = (p) => dv.getUint16(p, le);
  const u32 = (p) => dv.getUint32(p, le);
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = new Map();
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    const tag = u16(p);
    const type = u16(p + 2);
    const count = u32(p + 4);
    const size = (SIZES[type] || 1) * count;
    const at = size <= 4 ? p + 8 : u32(p + 8);
    const vals = [];
    for (let k = 0; k < Math.min(count, 1 << 20); k++) {
      const q = at + k * (SIZES[type] || 1);
      if (q >= bytes.length) break;
      if (type === 3 || type === 8) vals.push(u16(q));
      else if (type === 4 || type === 9 || type === 13) vals.push(u32(q));
      else if (type === 5 || type === 10) vals.push(u32(q) / (u32(q + 4) || 1));
      else if (type === 11) vals.push(dv.getFloat32(q, le));
      else if (type === 16) vals.push(Number(dv.getBigUint64(q, le)));
      else vals.push(bytes[q]);
    }
    tags.set(tag, vals);
  }
  const one = (t, d) => (tags.has(t) ? tags.get(t)[0] : d);
  const width = one(256, 0);
  const height = one(257, 0);
  if (!width || !height) throw new Error('The TIFF image has no size');
  const spp = one(277, 1);
  const bps = tags.get(258) || [1];
  const bits = bps[0] || 1;
  const comp = one(259, 1);
  const photo = one(262, spp >= 3 ? 2 : 1);
  const planar = one(284, 1);
  const predictor = one(317, 1);
  const fmt = one(339, 1);
  const extra = tags.get(338) || [];
  const fillOrder = one(266, 1);
  const tiled = tags.has(322);
  const tw = tiled ? one(322, width) : width;
  const th = tiled ? one(323, height) : one(278, height);
  const offsets = tags.get(tiled ? 324 : 273) || [];
  const counts = tags.get(tiled ? 325 : 279) || [];
  const bytesPerSample = Math.ceil(bits / 8);
  if (comp === 7 || comp === 6) throw new Error('JPEG-compressed TIFF images are not supported. Save the TIFF with LZW, ZIP or no compression.');
  if (![1, 5, 8, 32946, 32773].includes(comp)) throw new Error('This TIFF compression is not supported.');
  // Samples: one plane (chunky) or one per channel (planar).
  const planes = planar === 2 ? spp : 1;
  const sppPlane = planar === 2 ? 1 : spp;
  const rowBytes = Math.ceil((tw * sppPlane * bits) / 8);
  const across = Math.ceil(width / tw);
  const down = Math.ceil(height / th);
  // Unpacked samples as numbers 0..1 per pixel and channel.
  const samples = new Float32Array(width * height * spp);
  const max = 2 ** bits - 1;
  for (let plane = 0; plane < planes; plane++) {
    for (let ty = 0; ty < down; ty++) {
      for (let tx = 0; tx < across; tx++) {
        const idx = plane * across * down + ty * across + tx;
        const off = offsets[idx];
        const cnt = counts[idx] ?? bytes.length - off;
        if (off === undefined || off >= bytes.length) continue;
        let raw = bytes.subarray(off, Math.min(bytes.length, off + cnt));
        if (fillOrder === 2) raw = raw.map((v) => parseInt(v.toString(2).padStart(8, '0').split('').reverse().join(''), 2));
        const rows = tiled ? th : Math.min(th, height - ty * th);
        const expected = rowBytes * rows;
        let data;
        if (comp === 1) data = raw;
        else if (comp === 5) data = lzwDecode(raw, 1);
        else if (comp === 8 || comp === 32946) data = inflate(raw);
        else data = packBits(raw, expected);
        if (predictor === 2) {
          const ch = sppPlane;
          if (bits === 8) {
            for (let r = 0; r < rows; r++) for (let i = ch; i < rowBytes; i++) data[r * rowBytes + i] = (data[r * rowBytes + i] + data[r * rowBytes + i - ch]) & 255;
          } else if (bits === 16) {
            for (let r = 0; r < rows; r++) {
              for (let i = ch; i < tw * ch; i++) {
                const p = r * rowBytes + i * 2;
                const q = p - ch * 2;
                const get = (x) => (le ? data[x] | (data[x + 1] << 8) : (data[x] << 8) | data[x + 1]);
                const v = (get(p) + get(q)) & 0xffff;
                if (le) {
                  data[p] = v & 255;
                  data[p + 1] = v >> 8;
                } else {
                  data[p] = v >> 8;
                  data[p + 1] = v & 255;
                }
              }
            }
          }
        }
        const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let r = 0; r < rows; r++) {
          const y = ty * th + r;
          if (y >= height) break;
          for (let c = 0; c < tw; c++) {
            const x = tx * tw + c;
            if (x >= width) break;
            for (let s = 0; s < sppPlane; s++) {
              const si = c * sppPlane + s;
              let v;
              if (fmt === 3 && bits === 32) {
                const p = r * rowBytes + si * 4;
                v = p + 4 <= data.length ? ddv.getFloat32(p, le) : 0;
              } else if (bits === 8) v = (data[r * rowBytes + si] ?? 0) / 255;
              else if (bits === 16) {
                const p = r * rowBytes + si * 2;
                v = p + 2 <= data.length ? ddv.getUint16(p, le) / 65535 : 0;
              } else if (bits === 32) {
                const p = r * rowBytes + si * 4;
                v = p + 4 <= data.length ? ddv.getUint32(p, le) / 4294967295 : 0;
              } else {
                const bit = r * rowBytes * 8 + si * bits;
                const byte = data[bit >> 3] ?? 0;
                v = ((byte >> (8 - bits - (bit & 7))) & max) / max;
              }
              samples[(y * width + x) * spp + (planar === 2 ? plane : s)] = v;
            }
          }
        }
      }
    }
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const map = tags.get(320);
  const color = spp - extra.length;
  const alphaIndex = extra.length ? color : -1;
  const associated = extra[0] === 1;
  for (let i = 0; i < width * height; i++) {
    const s = i * spp;
    let r;
    let g;
    let b;
    const a = alphaIndex >= 0 ? samples[s + alphaIndex] : 1;
    if (photo === 0 || photo === 1) {
      let v = samples[s];
      if (photo === 0) v = 1 - v;
      r = g = b = v;
    } else if (photo === 3 && map) {
      const idx = Math.round(samples[s] * max);
      const nc = map.length / 3;
      r = (map[idx] ?? 0) / 65535;
      g = (map[nc + idx] ?? 0) / 65535;
      b = (map[2 * nc + idx] ?? 0) / 65535;
    } else if (photo === 5) {
      const rgb = cmykEngine.toRgb({ c: samples[s] * 100, m: samples[s + 1] * 100, y: samples[s + 2] * 100, k: (samples[s + 3] ?? 0) * 100 });
      r = rgb.r / 255;
      g = rgb.g / 255;
      b = rgb.b / 255;
    } else if (photo === 6) {
      const Y = samples[s] * 255;
      const cb = samples[s + 1] * 255 - 128;
      const cr = samples[s + 2] * 255 - 128;
      r = (Y + 1.402 * cr) / 255;
      g = (Y - 0.344136 * cb - 0.714136 * cr) / 255;
      b = (Y + 1.772 * cb) / 255;
    } else {
      r = samples[s];
      g = samples[s + 1] ?? r;
      b = samples[s + 2] ?? r;
    }
    if (associated && a > 0 && a < 1) {
      r /= a;
      g /= a;
      b /= a;
    }
    out[i * 4] = Math.round(r * 255);
    out[i * 4 + 1] = Math.round(g * 255);
    out[i * 4 + 2] = Math.round(b * 255);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  const res = one(282, 0);
  const unit = one(296, 2);
  const ppi = res ? (unit === 3 ? res * 2.54 : res) : 0;
  return { width, height, data: out, ppi };
}

// ---------------------------------------------------------------- encoding

/** TIFF LZW (MSB-first codes, early change). */
export function lzwEncode(data) {
  const out = [];
  let buf = 0;
  let nbits = 0;
  let width = 9;
  const emit = (code) => {
    buf = (buf << width) | code;
    nbits += width;
    while (nbits >= 8) {
      out.push((buf >>> (nbits - 8)) & 255);
      nbits -= 8;
    }
    buf &= (1 << nbits) - 1;
  };
  let dict = new Map();
  let next = 258;
  emit(256);
  let prefix = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (prefix < 0) {
      prefix = c;
      continue;
    }
    const key = prefix * 256 + c;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    dict.set(key, next++);
    if (next >= 1 << width && width < 12) width++;
    if (next >= 4094) {
      emit(256);
      dict = new Map();
      next = 258;
      width = 9;
    }
    prefix = c;
  }
  if (prefix >= 0) {
    emit(prefix);
    next++;
    if (next >= 1 << width && width < 12) width++;
  }
  emit(257);
  if (nbits > 0) out.push((buf << (8 - nbits)) & 255);
  return Uint8Array.from(out);
}

/**
 * Encode RGBA pixels. opts: { mode: 'rgb'|'cmyk'|'gray', alpha (keep
 * transparency), compression: 'none'|'lzw'|'deflate', byteOrder: 'II'|'MM', ppi }
 */
export async function encodeTIFF({ width, height, data }, opts = {}) {
  const mode = opts.mode || 'rgb';
  const alpha = Boolean(opts.alpha) && mode !== 'cmyk';
  const le = (opts.byteOrder || 'II') === 'II';
  const comp = opts.compression || 'lzw';
  const color = mode === 'gray' ? 1 : mode === 'cmyk' ? 4 : 3;
  const spp = color + (alpha ? 1 : 0);
  const rowBytes = width * spp;
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(65536 / rowBytes) || 1));
  const strips = [];
  for (let y0 = 0; y0 < height; y0 += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - y0);
    const raw = new Uint8Array(rows * rowBytes);
    for (let r = 0; r < rows; r++) {
      for (let x = 0; x < width; x++) {
        const s = ((y0 + r) * width + x) * 4;
        const o = r * rowBytes + x * spp;
        let R = data[s];
        let G = data[s + 1];
        let B = data[s + 2];
        const A = data[s + 3];
        if (!alpha && A < 255) {
          // Flatten on white.
          R = Math.round(R * (A / 255) + 255 * (1 - A / 255));
          G = Math.round(G * (A / 255) + 255 * (1 - A / 255));
          B = Math.round(B * (A / 255) + 255 * (1 - A / 255));
        }
        if (mode === 'gray') raw[o] = Math.round(0.299 * R + 0.587 * G + 0.114 * B);
        else if (mode === 'cmyk') {
          const c = cmykEngine.toCmyk({ r: R, g: G, b: B });
          raw[o] = Math.round((c.c / 100) * 255);
          raw[o + 1] = Math.round((c.m / 100) * 255);
          raw[o + 2] = Math.round((c.y / 100) * 255);
          raw[o + 3] = Math.round((c.k / 100) * 255);
        } else {
          raw[o] = R;
          raw[o + 1] = G;
          raw[o + 2] = B;
        }
        if (alpha) raw[o + color] = A;
      }
    }
    let enc = raw;
    if (comp === 'lzw') enc = lzwEncode(raw);
    else if (comp === 'deflate') enc = await deflateZlib(raw);
    strips.push(enc);
  }
  const entries = [];
  const extraData = [];
  const tag = (t, type, values) => entries.push({ t, type, values });
  tag(254, 4, [0]);
  tag(256, 4, [width]);
  tag(257, 4, [height]);
  tag(258, 3, new Array(spp).fill(8));
  tag(259, 3, [comp === 'lzw' ? 5 : comp === 'deflate' ? 8 : 1]);
  tag(262, 3, [mode === 'gray' ? 1 : mode === 'cmyk' ? 5 : 2]);
  tag(273, 4, strips.map(() => 0));
  tag(277, 3, [spp]);
  tag(278, 4, [rowsPerStrip]);
  tag(279, 4, strips.map((s) => s.length));
  const ppi = opts.ppi || 72;
  tag(282, 5, [ppi]);
  tag(283, 5, [ppi]);
  tag(284, 3, [1]);
  tag(296, 3, [2]);
  tag(305, 2, 'Vector Studio');
  if (alpha) tag(338, 3, [2]);
  entries.sort((a, b) => a.t - b.t);
  // Layout: header, strips, extra tag data, IFD.
  let size = 8;
  const stripOffsets = [];
  for (const s of strips) {
    stripOffsets.push(size);
    size += s.length + (s.length & 1);
  }
  const SIZE = { 2: 1, 3: 2, 4: 4, 5: 8 };
  const external = [];
  for (const e of entries) {
    if (e.t === 273) e.values = stripOffsets;
    const count = e.type === 2 ? e.values.length + 1 : e.values.length;
    e.count = count;
    const bytesNeeded = count * SIZE[e.type];
    if (bytesNeeded > 4) {
      e.offset = size;
      external.push(e);
      size += bytesNeeded + (bytesNeeded & 1);
    }
  }
  const ifdAt = size;
  size += 2 + entries.length * 12 + 4;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = out[1] = le ? 0x49 : 0x4d;
  dv.setUint16(2, 42, le);
  dv.setUint32(4, ifdAt, le);
  strips.forEach((s, i) => out.set(s, stripOffsets[i]));
  const writeValues = (e, at) => {
    if (e.type === 2) {
      for (let i = 0; i < e.values.length; i++) out[at + i] = e.values.charCodeAt(i);
      out[at + e.values.length] = 0;
      return;
    }
    e.values.forEach((v, i) => {
      if (e.type === 3) dv.setUint16(at + i * 2, v, le);
      else if (e.type === 4) dv.setUint32(at + i * 4, v, le);
      else if (e.type === 5) {
        dv.setUint32(at + i * 8, Math.round(v * 1000), le);
        dv.setUint32(at + i * 8 + 4, 1000, le);
      }
    });
  };
  for (const e of external) writeValues(e, e.offset);
  dv.setUint16(ifdAt, entries.length, le);
  entries.forEach((e, i) => {
    const p = ifdAt + 2 + i * 12;
    dv.setUint16(p, e.t, le);
    dv.setUint16(p + 2, e.type, le);
    dv.setUint32(p + 4, e.count, le);
    if (e.offset !== undefined) dv.setUint32(p + 8, e.offset, le);
    else writeValues(e, p + 8);
  });
  dv.setUint32(ifdAt + 2 + entries.length * 12, 0, le);
  return out;
}
