/**
 * PDF images: image XObjects and inline images decoded to RGBA pixels
 * (any bit depth, color space and Decode array; stencil masks painted with
 * the fill color; color-key masks, explicit masks and soft masks as
 * alpha), or passed through as JPEG data when the browser can show them
 * directly. JPEG 2000, CCITT and JBIG2 data are reported as unsupported.
 */
import { PDFDict, PDFStream, Name } from './primitives.js';
import { decodeStream } from './filters.js';
import { parseColorSpace, defaultDecode, DEVICE_SPACES } from './colors.js';

const ABBREV = { W: 'Width', H: 'Height', BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', IM: 'ImageMask', F: 'Filter', DP: 'DecodeParms', I: 'Interpolate' };
const CS_ABBREV = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK', I: 'Indexed' };

/** Expand inline-image abbreviations into a regular image dictionary. */
export function inlineImageDict(dict) {
  const out = new PDFDict(dict.xref);
  for (const k of dict.keys()) {
    let v = dict.getRaw(k);
    if (v instanceof Name && CS_ABBREV[v.name] && (k === 'CS' || k === 'ColorSpace')) v = Name.get(CS_ABBREV[v.name]);
    if (Array.isArray(v) && (k === 'CS' || k === 'ColorSpace')) v = v.map((x) => (x instanceof Name && CS_ABBREV[x.name] ? Name.get(CS_ABBREV[x.name]) : x));
    if (v instanceof Name && (k === 'F' || k === 'Filter')) v = Name.get({ AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode', CCF: 'CCITTFaxDecode', DCT: 'DCTDecode' }[v.name] || v.name);
    out.set(ABBREV[k] || k, v);
  }
  return out;
}

/** Bits to sample values (0..2^bpc-1) for `count` samples per row. */
function readSamples(data, width, height, comps, bpc) {
  const n = width * comps;
  const out = new Uint16Array(n * height);
  const rowBytes = Math.ceil((n * bpc) / 8);
  if (bpc === 8) {
    for (let y = 0; y < height; y++) {
      const src = y * rowBytes;
      const dst = y * n;
      for (let i = 0; i < n; i++) out[dst + i] = data[src + i] ?? 0;
    }
    return out;
  }
  if (bpc === 16) {
    for (let y = 0; y < height; y++) {
      const src = y * rowBytes;
      const dst = y * n;
      for (let i = 0; i < n; i++) out[dst + i] = ((data[src + i * 2] ?? 0) << 8) | (data[src + i * 2 + 1] ?? 0);
    }
    return out;
  }
  const mask = (1 << bpc) - 1;
  for (let y = 0; y < height; y++) {
    let bit = y * rowBytes * 8;
    const dst = y * n;
    for (let i = 0; i < n; i++, bit += bpc) {
      const byte = data[bit >> 3] ?? 0;
      out[dst + i] = (byte >> (8 - bpc - (bit & 7))) & mask;
    }
  }
  return out;
}

/** 1-bit (or n-bit) mask image -> alpha (0/255) array of its own size, painted where the sample is 0 (after Decode). */
function stencilAlpha(dict, data) {
  const w = dict.num('Width', 0);
  const h = dict.num('Height', 0);
  const bpc = dict.num('BitsPerComponent', 1) || 1;
  const decode = dict.array('Decode');
  const invert = decode && decode[0] === 1;
  const s = readSamples(data, w, h, 1, bpc);
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) {
    const painted = s[i] === 0;
    a[i] = (invert ? !painted : painted) ? 255 : 0;
  }
  return { w, h, a };
}

function resample(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return src;
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    for (let x = 0; x < dw; x++) out[y * dw + x] = src[sy * sw + Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw))];
  }
  return out;
}

/** Gray values (0..255) of a soft-mask image of its own size. */
function softMaskGray(xref, smask) {
  const d = smask.dict;
  const w = d.num('Width', 0);
  const h = d.num('Height', 0);
  const r = decodeStream(smask);
  if (r.image || !w || !h) return null;
  const bpc = d.num('BitsPerComponent', 8) || 8;
  const s = readSamples(r.bytes, w, h, 1, bpc);
  const max = (1 << bpc) - 1;
  const decode = d.array('Decode') || [0, 1];
  const g = new Uint8Array(w * h);
  for (let i = 0; i < g.length; i++) {
    const v = decode[0] + (s[i] / max) * (decode[1] - decode[0]);
    g[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }
  return { w, h, g };
}

/**
 * Decode an image. `stream` is a PDFStream (XObject) or { dict, raw } for
 * inline images. fillRGB ([r,g,b] 0..1) paints stencil masks. Returns
 *   { kind: 'rgba', width, height, data: Uint8ClampedArray }
 *   { kind: 'jpeg', width, height, bytes, alpha?: { width, height, gray } }
 *   { kind: 'unsupported', width, height, codec }
 */
export function decodeImage(xref, stream, resources, { fillRGB = [0, 0, 0] } = {}) {
  const dict = stream.dict;
  const width = Math.max(0, Math.floor(dict.num('Width', 0)));
  const height = Math.max(0, Math.floor(dict.num('Height', 0)));
  if (!width || !height) return null;
  const r = decodeStream(stream instanceof PDFStream ? stream : Object.assign(new PDFStream(dict, stream.raw)));
  const imageMask = dict.get('ImageMask') === true;
  if (r.image === 'DCTDecode' && !imageMask) {
    const smask = dict.get('SMask');
    let alpha = null;
    if (smask instanceof PDFStream) {
      const m = softMaskGray(xref, smask);
      if (m) alpha = { width: m.w, height: m.h, gray: m.g };
    }
    const decode = dict.array('Decode');
    const inverted = decode && decode[0] === 1;
    return { kind: 'jpeg', width, height, bytes: r.bytes, alpha, inverted };
  }
  if (r.image) return { kind: 'unsupported', width, height, codec: r.image };
  const data = r.bytes;
  const out = new Uint8ClampedArray(width * height * 4);
  if (imageMask) {
    const { a } = stencilAlpha(dict, data);
    const cr = Math.round(fillRGB[0] * 255);
    const cg = Math.round(fillRGB[1] * 255);
    const cb = Math.round(fillRGB[2] * 255);
    for (let i = 0; i < width * height; i++) {
      out[i * 4] = cr;
      out[i * 4 + 1] = cg;
      out[i * 4 + 2] = cb;
      out[i * 4 + 3] = a[i];
    }
    return { kind: 'rgba', width, height, data: out, stencil: true };
  }
  const bpc = dict.num('BitsPerComponent', 8) || 8;
  const space = parseColorSpace(xref, dict.get('ColorSpace') || Name.get('DeviceGray'), resources);
  const n = space.n || 1;
  const samples = readSamples(data, width, height, n, bpc);
  const max = (1 << bpc) - 1;
  const decode = dict.array('Decode');
  const ranges = defaultDecode(space, bpc);
  const dec = new Array(n).fill(0).map((_, k) => (decode && decode.length >= 2 * (k + 1) ? [decode[2 * k], decode[2 * k + 1]] : ranges[k]));
  const fastRGB = space === DEVICE_SPACES.rgb && bpc === 8 && !decode;
  const fastGray = space === DEVICE_SPACES.gray && !decode;
  // Single-component spaces: a lookup table per sample value.
  let lut = null;
  if (n === 1 && !fastGray && max <= 4095) {
    lut = new Uint8Array((max + 1) * 3);
    for (let v = 0; v <= max; v++) {
      const comp = space.kind === 'indexed' ? dec[0][0] + (v * (dec[0][1] - dec[0][0])) / max : dec[0][0] + (v / max) * (dec[0][1] - dec[0][0]);
      const rgb = space.toRGB([comp]);
      lut[v * 3] = Math.round(rgb[0] * 255);
      lut[v * 3 + 1] = Math.round(rgb[1] * 255);
      lut[v * 3 + 2] = Math.round(rgb[2] * 255);
    }
  }
  const cache = new Map();
  const comps = new Array(n);
  for (let i = 0, p = 0; i < width * height; i++, p += n) {
    const o = i * 4;
    out[o + 3] = 255;
    if (fastRGB) {
      out[o] = samples[p];
      out[o + 1] = samples[p + 1];
      out[o + 2] = samples[p + 2];
    } else if (fastGray) {
      const v = Math.round((samples[p] / max) * 255);
      out[o] = out[o + 1] = out[o + 2] = v;
    } else if (lut) {
      const v = samples[p] * 3;
      out[o] = lut[v];
      out[o + 1] = lut[v + 1];
      out[o + 2] = lut[v + 2];
    } else {
      let key = 0;
      for (let k = 0; k < n; k++) key = key * (max + 1) + samples[p + k];
      let rgb = cache.get(key);
      if (!rgb) {
        for (let k = 0; k < n; k++) comps[k] = dec[k][0] + (samples[p + k] / max) * (dec[k][1] - dec[k][0]);
        const c = space.toRGB(comps);
        rgb = [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
        if (cache.size < 65536) cache.set(key, rgb);
      }
      out[o] = rgb[0];
      out[o + 1] = rgb[1];
      out[o + 2] = rgb[2];
    }
  }
  // Masks.
  const mask = dict.get('Mask');
  if (Array.isArray(mask) && mask.length >= 2 * n) {
    for (let i = 0, p = 0; i < width * height; i++, p += n) {
      let inside = true;
      for (let k = 0; k < n && inside; k++) inside = samples[p + k] >= mask[2 * k] && samples[p + k] <= mask[2 * k + 1];
      if (inside) out[i * 4 + 3] = 0;
    }
  } else if (mask instanceof PDFStream) {
    try {
      const mr = decodeStream(mask);
      if (!mr.image) {
        const { w, h, a } = stencilAlpha(mask.dict, mr.bytes);
        const al = resample(a, w, h, width, height);
        for (let i = 0; i < width * height; i++) out[i * 4 + 3] = Math.min(out[i * 4 + 3], al[i]);
      }
    } catch {
      /* ignore the mask */
    }
  }
  const smask = dict.get('SMask');
  if (smask instanceof PDFStream) {
    try {
      const m = softMaskGray(xref, smask);
      if (m) {
        const al = resample(m.g, m.w, m.h, width, height);
        for (let i = 0; i < width * height; i++) out[i * 4 + 3] = (out[i * 4 + 3] * al[i]) / 255;
      }
    } catch {
      /* ignore the soft mask */
    }
  }
  return { kind: 'rgba', width, height, data: out };
}
