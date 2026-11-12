// PNG writer for 8- and 16-bit images and a 16-bit reader, from the PNG
// specification (ISO/IEC 15948, W3C PNG 3rd edition). Browsers decode PNG to
// 8 bits per channel, so 16-bit files are read here to keep their precision.
import { deflate } from 'pako';
import { inflateLimited } from '../../imaging/codecs/inflate';
import { buildPng, readPngChunks, type NewChunk } from '../../imaging/codecs/png-chunks';

export type PngImage = {
  width: number;
  height: number;
  // Interleaved samples; `channels` per pixel (1 gray, 2 gray+alpha, 3 RGB, 4 RGBA).
  data: Uint8Array | Uint8ClampedArray | Uint16Array;
  channels: 1 | 2 | 3 | 4;
};
const colorTypes = { 1: 0, 2: 4, 3: 2, 4: 6 } as const;

// Paeth predictor, PNG specification section 9.4.
function paeth(a: number, b: number, c: number) {
  const p = a + b - c,
    pa = Math.abs(p - a),
    pb = Math.abs(p - b),
    pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encode a PNG. `level` 0-9 is the zlib effort; filters are chosen per row
 * with the minimum-sum-of-absolute-differences heuristic. */
export function encodePng(img: PngImage, opts: { level?: number; chunks?: NewChunk[] } = {}): Uint8Array {
  const { width, height, channels, data } = img;
  const sixteen = data instanceof Uint16Array;
  const bpp = channels * (sixteen ? 2 : 1);
  const stride = width * bpp;
  if (data.length < width * height * channels) throw new Error('PNG pixel data is too short.');
  const raw = new Uint8Array((stride + 1) * height);
  let prev = new Uint8Array(stride),
    cur = new Uint8Array(stride);
  const level = opts.level ?? 6;
  const tmp = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const o = y * width * channels;
    if (sixteen)
      for (let i = 0; i < width * channels; i++) {
        const v = data[o + i];
        cur[i * 2] = v >> 8;
        cur[i * 2 + 1] = v & 255;
      }
    else cur.set(data.subarray(o, o + stride));
    const rowStart = y * (stride + 1);
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    // Level 0 stores; filtering would only cost time there.
    if (level === 0) {
      raw[rowStart] = 0;
      row.set(cur);
    } else {
      // Choose the filter with the smallest sum of absolute signed residuals.
      let best = 0,
        bestSum = 0;
      for (let i = 0; i < stride; i++) bestSum += cur[i] < 128 ? cur[i] : 256 - cur[i];
      row.set(cur);
      for (let f = 1; f < 5; f++) {
        let sum = 0;
        if (f === 1) {
          for (let i = 0; i < bpp; i++) tmp[i] = cur[i];
          for (let i = bpp; i < stride; i++) tmp[i] = (cur[i] - cur[i - bpp]) & 255;
        } else if (f === 2) {
          for (let i = 0; i < stride; i++) tmp[i] = (cur[i] - prev[i]) & 255;
        } else if (f === 3) {
          for (let i = 0; i < bpp; i++) tmp[i] = (cur[i] - (prev[i] >> 1)) & 255;
          for (let i = bpp; i < stride; i++) tmp[i] = (cur[i] - ((cur[i - bpp] + prev[i]) >> 1)) & 255;
        } else {
          for (let i = 0; i < bpp; i++) tmp[i] = (cur[i] - prev[i]) & 255;
          for (let i = bpp; i < stride; i++) tmp[i] = (cur[i] - paeth(cur[i - bpp], prev[i], prev[i - bpp])) & 255;
        }
        for (let i = 0; i < stride; i++) {
          const v = tmp[i];
          sum += v < 128 ? v : 256 - v;
        }
        if (sum < bestSum) {
          bestSum = sum;
          best = f;
          row.set(tmp);
        }
      }
      raw[rowStart] = best;
    }
    [prev, cur] = [cur, prev];
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = sixteen ? 16 : 8;
  ihdr[9] = colorTypes[channels];
  const idat = deflate(raw, { level: Math.max(0, Math.min(9, level)) as 0 });
  return buildPng([{ type: 'IHDR', data: ihdr }, ...(opts.chunks ?? []), { type: 'IDAT', data: idat }, { type: 'IEND', data: new Uint8Array() }]);
}

export type Png16 = { width: number; height: number; data16: Uint16Array };

/** Decode a 16-bit PNG into straight RGBA16; null for other bit depths. */
export function decodePng16(png: Uint8Array): Png16 | null {
  const chunks = readPngChunks(png);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13 || ihdr.data[8] !== 16) return null;
  const dv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, 13);
  const width = dv.getUint32(0),
    height = dv.getUint32(4),
    colorType = ihdr.data[9],
    interlaced = ihdr.data[12] === 1;
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error('Invalid 16-bit PNG color type.');
  if (!width || !height || width > 8192 || height > 8192 || width * height > 24_000_000)
    throw new Error('This image exceeds the 24 megapixel or 8192 pixel limit.');
  const idat = chunks.filter((c) => c.type === 'IDAT');
  let total = 0;
  for (const c of idat) total += c.data.length;
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    z.set(c.data, o);
    o += c.data.length;
  }
  const passes = interlaced
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  // Inflate only the rows the image needs: Deflate can expand a thousandfold.
  let expected = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx),
      ph = Math.ceil((height - y0) / dy);
    if (pw > 0 && ph > 0) expected += (pw * channels * 2 + 1) * ph;
  }
  const raw = inflateLimited(z, expected);
  if (!raw) throw new Error('The PNG image data is damaged.');
  // tRNS for gray/RGB names one fully transparent 16-bit color.
  const trns = chunks.find((c) => c.type === 'tRNS')?.data;
  const key = trns && (colorType === 0 ? trns.length >= 2 : colorType === 2 ? trns.length >= 6 : false)
    ? Array.from({ length: colorType === 0 ? 1 : 3 }, (_, i) => (trns[i * 2] << 8) | trns[i * 2 + 1])
    : undefined;
  const out = new Uint16Array(width * height * 4);
  const bpp = channels * 2;
  let pos = 0;
  // Adam7 passes (x0, y0, dx, dy); a non-interlaced image is one full pass.
  // Rows are unfiltered in place (a loop per filter type), then unpacked.
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx),
      ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = pw * bpp;
    let prev = -1;
    for (let py = 0; py < ph; py++) {
      if (pos + 1 + stride > raw.length) throw new Error('The PNG image data is truncated.');
      const filter = raw[pos++];
      if (filter > 4) throw new Error('Invalid PNG row filter.');
      unfilter(raw, pos, prev, stride, bpp, filter);
      const y = y0 + py * dy;
      let d = (y * width + x0) * 4;
      const step = dx * 4,
        end = pos + stride;
      if (channels === 4)
        for (let s = pos; s < end; s += 8, d += step) {
          out[d] = (raw[s] << 8) | raw[s + 1];
          out[d + 1] = (raw[s + 2] << 8) | raw[s + 3];
          out[d + 2] = (raw[s + 4] << 8) | raw[s + 5];
          out[d + 3] = (raw[s + 6] << 8) | raw[s + 7];
        }
      else if (channels === 3)
        for (let s = pos; s < end; s += 6, d += step) {
          const r = (raw[s] << 8) | raw[s + 1],
            g = (raw[s + 2] << 8) | raw[s + 3],
            b = (raw[s + 4] << 8) | raw[s + 5];
          out[d] = r;
          out[d + 1] = g;
          out[d + 2] = b;
          out[d + 3] = key && key[0] === r && key[1] === g && key[2] === b ? 0 : 65535;
        }
      else
        for (let s = pos; s < end; s += bpp, d += step) {
          const g = (raw[s] << 8) | raw[s + 1];
          out[d] = out[d + 1] = out[d + 2] = g;
          out[d + 3] = channels === 2 ? (raw[s + 2] << 8) | raw[s + 3] : key && key[0] === g ? 0 : 65535;
        }
      prev = pos;
      pos = end;
    }
  }
  return { width, height, data16: out };
}

/** Undo a PNG row filter in place: the row starts at `at`, the previous row
 * of the same pass at `prev` (-1 for the first row, read as zeros). */
function unfilter(raw: Uint8Array, at: number, prev: number, stride: number, bpp: number, filter: number) {
  const end = at + stride;
  if (filter === 1) {
    for (let i = at + bpp; i < end; i++) raw[i] += raw[i - bpp];
  } else if (filter === 2) {
    if (prev >= 0) for (let i = at, j = prev; i < end; i++, j++) raw[i] += raw[j];
  } else if (filter === 3) {
    for (let i = at, j = prev; i < end; i++, j++) {
      const a = i - at >= bpp ? raw[i - bpp] : 0,
        b = prev >= 0 ? raw[j] : 0;
      raw[i] += (a + b) >> 1;
    }
  } else if (filter === 4) {
    for (let i = at, j = prev; i < end; i++, j++) {
      const left = i - at >= bpp;
      const a = left ? raw[i - bpp] : 0,
        b = prev >= 0 ? raw[j] : 0,
        c = left && prev >= 0 ? raw[j - bpp] : 0;
      raw[i] += paeth(a, b, c);
    }
  }
}

/** Reduce RGBA16 to RGBA8 with rounding. */
export function rgba16To8(data16: Uint16Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data16.length);
  for (let i = 0; i < data16.length; i++) out[i] = data16[i] / 257; // clamped arrays round to nearest
  return out;
}
