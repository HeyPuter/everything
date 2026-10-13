/**
 * PSD and PSB files: the flattened composite image that the file stores
 * after its layers (raw or RLE), in bitmap, grayscale, indexed, RGB, CMYK,
 * Lab, duotone and multichannel modes at 1, 8, 16 and 32 bits. The
 * merged transparency is used when the file marks its first alpha channel
 * as the composite's transparency.
 */
import { cmykEngine } from '../../../lib/color.js';

export function isPSD(b) {
  return b.length > 26 && b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53;
}

function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const g = (t) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const X = 0.9642 * g(fx);
  const Y = g(fy);
  const Z = 0.8249 * g(fz);
  // D50 to sRGB (Bradford-adapted).
  const lin = [3.1339 * X - 1.6169 * Y - 0.4906 * Z, -0.9788 * X + 1.9161 * Y + 0.0335 * Z, 0.0719 * X - 0.229 * Y + 1.4052 * Z];
  return lin.map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, c)) * 255);
  });
}

/** Decode the composite image: { width, height, data (RGBA), ppi }. */
export function decodePSD(bytes) {
  if (!isPSD(bytes)) throw new Error('Not a PSD file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint16(4);
  const psb = version === 2;
  const channels = dv.getUint16(12);
  const height = dv.getUint32(14);
  const width = dv.getUint32(18);
  const depth = dv.getUint16(22);
  const mode = dv.getUint16(24);
  if (!width || !height || width * height > 2e8) throw new Error('The PSD image size is not valid.');
  let p = 26;
  const cmLen = dv.getUint32(p);
  const colorData = bytes.subarray(p + 4, p + 4 + cmLen);
  p += 4 + cmLen;
  // Image resources: resolution (1005).
  const resLen = dv.getUint32(p);
  let ppi = 0;
  {
    let q = p + 4;
    const end = q + resLen;
    while (q + 12 <= end) {
      if (dv.getUint32(q) !== 0x3842494d) break;
      const id = dv.getUint16(q + 4);
      const nameLen = bytes[q + 6];
      let r = q + 6 + 1 + nameLen;
      if ((nameLen + 1) % 2) r++;
      const size = dv.getUint32(r);
      if (id === 1005 && size >= 16) ppi = dv.getUint32(r + 4) / 65536;
      q = r + 4 + size + (size % 2);
    }
  }
  p += 4 + resLen;
  // Layer and mask information: only the merged-transparency flag is needed.
  const lmLen = psb ? Number(dv.getBigUint64(p)) : dv.getUint32(p);
  const lmStart = p + (psb ? 8 : 4);
  let mergedAlpha = false;
  if (lmLen >= 8) {
    const liLen = psb ? Number(dv.getBigUint64(lmStart)) : dv.getUint32(lmStart);
    if (liLen >= 2) mergedAlpha = dv.getInt16(lmStart + (psb ? 8 : 4)) < 0;
  }
  p = lmStart + lmLen;
  const compression = dv.getUint16(p);
  p += 2;
  const bpc = depth === 1 ? 1 : depth / 8;
  const rowBytes = depth === 1 ? Math.ceil(width / 8) : width * bpc;
  const planes = [];
  if (compression === 0) {
    for (let c = 0; c < channels; c++) {
      planes.push(bytes.subarray(p, p + rowBytes * height));
      p += rowBytes * height;
    }
  } else if (compression === 1) {
    const countSize = psb ? 4 : 2;
    const counts = [];
    for (let i = 0; i < channels * height; i++) counts.push(countSize === 4 ? dv.getUint32(p + i * 4) : dv.getUint16(p + i * 2));
    p += channels * height * countSize;
    let k = 0;
    for (let c = 0; c < channels; c++) {
      const plane = new Uint8Array(rowBytes * height);
      for (let y = 0; y < height; y++) {
        const end = p + counts[k++];
        let o = y * rowBytes;
        const rowEnd = o + rowBytes;
        while (p < end && o < rowEnd) {
          const n = (bytes[p++] << 24) >> 24;
          if (n >= 0) {
            for (let j = 0; j <= n && o < rowEnd; j++) plane[o++] = bytes[p++];
          } else if (n !== -128) {
            const v = bytes[p++];
            for (let j = 0; j < 1 - n && o < rowEnd; j++) plane[o++] = v;
          }
        }
        p = end;
      }
      planes.push(plane);
    }
  } else throw new Error('This PSD uses ZIP compression for its composite image, which is not supported. Save it with Maximize Compatibility.');
  const sample = (c, i) => {
    const pl = planes[c];
    if (!pl) return 0;
    if (depth === 8) return pl[i] / 255;
    if (depth === 16) return ((pl[i * 2] << 8) | pl[i * 2 + 1]) / 65535;
    if (depth === 32) return new DataView(pl.buffer, pl.byteOffset + i * 4, 4).getFloat32(0);
    // 1-bit: 1 is black.
    const x = i % width;
    const y = (i / width) | 0;
    return (pl[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 1;
  };
  const colorChannels = { 0: 1, 1: 1, 2: 1, 3: 3, 4: 4, 7: channels, 8: 1, 9: 3 }[mode] ?? 3;
  const alphaChannel = mergedAlpha && channels > colorChannels ? colorChannels : -1;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r;
    let g;
    let b;
    if (mode === 3) {
      r = sample(0, i) * 255;
      g = sample(1, i) * 255;
      b = sample(2, i) * 255;
    } else if (mode === 4) {
      // Stored inverted (0 = full ink).
      const rgb = cmykEngine.toRgb({ c: (1 - sample(0, i)) * 100, m: (1 - sample(1, i)) * 100, y: (1 - sample(2, i)) * 100, k: (1 - sample(3, i)) * 100 });
      r = rgb.r;
      g = rgb.g;
      b = rgb.b;
    } else if (mode === 2) {
      const idx = planes[0][i];
      r = colorData[idx];
      g = colorData[256 + idx];
      b = colorData[512 + idx];
    } else if (mode === 9) {
      [r, g, b] = labToRgb(sample(0, i) * 100, sample(1, i) * 255 - 128, sample(2, i) * 255 - 128);
    } else if (mode === 7) {
      // Multichannel: inks stored inverted; show as their darkening of white.
      let v = 1;
      for (let c = 0; c < Math.min(3, channels); c++) v *= sample(c, i);
      r = g = b = v * 255;
    } else {
      r = g = b = sample(0, i) * 255;
    }
    const o = i * 4;
    const a = alphaChannel >= 0 ? sample(alphaChannel, i) : 1;
    if (a > 0 && a < 1) {
      // The composite is matted with white: undo it.
      r = (r - 255 * (1 - a)) / a;
      g = (g - 255 * (1 - a)) / a;
      b = (b - 255 * (1 - a)) / a;
    }
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = Math.round(a * 255);
  }
  return { width, height, data: out, ppi };
}
