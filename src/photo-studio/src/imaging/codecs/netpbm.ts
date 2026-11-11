// Netpbm PBM/PGM/PPM (plain P1-P3 and raw P4-P6) and PAM (P7), from the
// netpbm format documentation (pbm(5), pgm(5), ppm(5), pam(5)).
import type { RGBA8 } from '../types';
import { ByteWriter, CodecError, checkSize, rethrowAsCodecError, type SizeLimits } from './bytes';

export type NetpbmFormat = 'pbm' | 'pgm' | 'ppm' | 'pam';
export type NetpbmDecodeResult = {
  format: NetpbmFormat;
  ascii: boolean;
  width: number;
  height: number;
  channels: number;
  maxval: number;
  tupleType?: string;
  rgba8: RGBA8;
  // maxval > 255: straight RGBA16 scaled to 0-65535.
  data16?: Uint16Array;
};

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;

export function decodeNetpbm(bytes: Uint8Array, limits?: SizeLimits): NetpbmDecodeResult {
  try {
    return decodeNetpbmImpl(bytes, limits);
  } catch (e) {
    rethrowAsCodecError(e, 'Netpbm');
  }
}
function decodeNetpbmImpl(bytes: Uint8Array, limits?: SizeLimits): NetpbmDecodeResult {
  if (bytes.length < 3 || bytes[0] !== 0x50 || bytes[1] < 0x31 || bytes[1] > 0x37) throw new CodecError('Not a Netpbm file.');
  const kind = bytes[1] - 0x30;
  let p = 2;
  const skip = () => {
    for (;;) {
      while (p < bytes.length && isSpace(bytes[p])) p++;
      if (bytes[p] !== 0x23) return;
      while (p < bytes.length && bytes[p] !== 10 && bytes[p] !== 13) p++;
    }
  };
  const int = () => {
    skip();
    let v = 0;
    const start = p;
    while (p < bytes.length && bytes[p] >= 0x30 && bytes[p] <= 0x39) v = v * 10 + bytes[p++] - 0x30;
    if (p === start) throw new CodecError('Malformed Netpbm header.');
    return v;
  };
  let width: number, height: number, channels: number, maxval: number;
  let tupleType: string | undefined;
  let format: NetpbmFormat;
  if (kind === 7) {
    format = 'pam';
    const fields: Record<string, string> = {};
    let line = '';
    const types: string[] = [];
    while (p < bytes.length) {
      const c = bytes[p++];
      if (c !== 10) {
        line += String.fromCharCode(c);
        continue;
      }
      const t = line.trim();
      line = '';
      if (!t || t[0] === '#') continue;
      if (t === 'ENDHDR') break;
      const sp = t.search(/\s/);
      const key = sp < 0 ? t : t.slice(0, sp);
      const val = sp < 0 ? '' : t.slice(sp + 1).trim();
      if (key === 'TUPLTYPE') types.push(val);
      else fields[key] = val;
    }
    width = +fields.WIDTH;
    height = +fields.HEIGHT;
    channels = +fields.DEPTH;
    maxval = +fields.MAXVAL;
    tupleType = types.join(' ') || undefined;
    if (!(width > 0 && height > 0 && channels >= 1 && channels <= 4 && maxval >= 1 && maxval <= 65535)) throw new CodecError('Unsupported PAM header.');
  } else {
    format = kind === 1 || kind === 4 ? 'pbm' : kind === 2 || kind === 5 ? 'pgm' : 'ppm';
    width = int();
    height = int();
    maxval = format === 'pbm' ? 1 : int();
    channels = format === 'ppm' ? 3 : 1;
    if (!(width > 0 && height > 0 && maxval >= 1 && maxval <= 65535)) throw new CodecError('Unsupported Netpbm header.');
    // Exactly one whitespace byte separates the header from raw data.
    if (kind >= 4) p++;
  }
  if (width * height > 2 ** 28) throw new CodecError('Netpbm image is too large.');
  checkSize(width, height, limits);
  const ascii = kind <= 3;
  const n = width * height * channels;
  const samples = maxval > 255 ? new Uint16Array(n) : new Uint8Array(n);
  if (kind === 1) {
    // Plain PBM bits need no separators between them.
    for (let i = 0; i < n && p < bytes.length; ) {
      const c = bytes[p++];
      if (c === 0x23) while (p < bytes.length && bytes[p] !== 10) p++;
      else if (c === 0x30 || c === 0x31) samples[i++] = c === 0x31 ? 0 : 1; // 1 = black
    }
  } else if (ascii) {
    for (let i = 0; i < n; i++) {
      skip();
      if (p >= bytes.length) break;
      samples[i] = Math.min(maxval, int());
    }
  } else if (kind === 4) {
    const stride = (width + 7) >> 3;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) samples[y * width + x] = (bytes[p + y * stride + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 1;
  } else if (maxval > 255) {
    for (let i = 0; i < n && p + 1 < bytes.length; i++, p += 2) samples[i] = (bytes[p] << 8) | bytes[p + 1];
  } else samples.set(bytes.subarray(p, p + n));

  // PBM was normalized above so that 1 means white, like PAM BLACKANDWHITE.
  const pixels = width * height;
  const hasAlpha = channels === 2 || channels === 4;
  const color = channels >= 3;
  const deep = maxval > 255;
  const outMax = deep ? 65535 : 255;
  const dst = deep ? new Uint16Array(pixels * 4) : new Uint8ClampedArray(pixels * 4);
  const scale = outMax / maxval;
  for (let i = 0, s = 0, o = 0; i < pixels; i++, s += channels, o += 4) {
    const r = Math.round(samples[s] * scale);
    dst[o] = r;
    dst[o + 1] = color ? Math.round(samples[s + 1] * scale) : r;
    dst[o + 2] = color ? Math.round(samples[s + 2] * scale) : r;
    dst[o + 3] = hasAlpha ? Math.round(samples[s + channels - 1] * scale) : outMax;
  }
  let rgba: Uint8ClampedArray;
  if (deep) {
    rgba = new Uint8ClampedArray(pixels * 4);
    for (let i = 0; i < dst.length; i++) rgba[i] = ((dst[i] + 128) / 257) | 0;
  } else rgba = dst as Uint8ClampedArray;
  const res: NetpbmDecodeResult = { format, ascii, width, height, channels, maxval, rgba8: { width, height, data: rgba } };
  if (tupleType) res.tupleType = tupleType;
  if (deep) res.data16 = dst as Uint16Array;
  return res;
}

export type NetpbmEncodeImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array | Uint16Array;
  channels: 1 | 2 | 3 | 4;
};
export type NetpbmEncodeOptions = {
  // Default: pgm for gray, ppm for RGB, pam when there is alpha.
  format?: NetpbmFormat;
  // Plain (text) P1-P3 instead of raw P4-P6. Ignored for PAM.
  ascii?: boolean;
  // PBM: luminance below this (after compositing on white) is black. Default 128.
  threshold?: number;
};

export function encodeNetpbm(img: NetpbmEncodeImage, opts: NetpbmEncodeOptions = {}): Uint8Array {
  const { width, height, data, channels } = img;
  const deep = data instanceof Uint16Array;
  const max = deep ? 65535 : 255;
  const format = opts.format ?? (channels === 2 || channels === 4 ? 'pam' : channels === 3 ? 'ppm' : 'pgm');
  const ascii = !!opts.ascii && format !== 'pam';
  const pixels = width * height;
  const outCh = format === 'pam' ? channels : format === 'ppm' ? 3 : 1;
  const hasAlpha = channels === 2 || channels === 4;
  // Collect output samples.
  const samples = deep ? new Uint16Array(pixels * outCh) : new Uint8Array(pixels * outCh);
  for (let i = 0, s = 0, o = 0; i < pixels; i++, s += channels, o += outCh) {
    const r = data[s];
    const g = channels >= 3 ? data[s + 1] : r;
    const b = channels >= 3 ? data[s + 2] : r;
    if (format === 'pam') for (let c = 0; c < channels; c++) samples[o + c] = data[s + c];
    else if (format === 'ppm') {
      samples[o] = r;
      samples[o + 1] = g;
      samples[o + 2] = b;
    } else if (format === 'pgm') samples[o] = channels >= 3 ? Math.round(0.299 * r + 0.587 * g + 0.114 * b) : r;
    else {
      const a = hasAlpha ? data[s + channels - 1] / max : 1;
      const lum = ((channels >= 3 ? 0.299 * r + 0.587 * g + 0.114 * b : r) / max) * a + (1 - a);
      samples[o] = lum * 255 < (opts.threshold ?? 128) ? 1 : 0; // 1 = black
    }
  }
  const w = new ByteWriter(64 + samples.length * (ascii ? 4 : deep ? 2 : 1));
  if (format === 'pam') {
    const tuple = channels === 1 ? 'GRAYSCALE' : channels === 2 ? 'GRAYSCALE_ALPHA' : channels === 3 ? 'RGB' : 'RGB_ALPHA';
    w.ascii(`P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH ${channels}\nMAXVAL ${max}\nTUPLTYPE ${tuple}\nENDHDR\n`);
  } else {
    const magic = { pbm: 1, pgm: 2, ppm: 3 }[format] + (ascii ? 0 : 3);
    w.ascii(`P${magic}\n${width} ${height}\n${format === 'pbm' ? '' : `${max}\n`}`);
  }
  if (ascii) {
    // Plain formats: lines of at most 70 characters.
    let line = '';
    const perRow = width * outCh;
    for (let i = 0; i < samples.length; i++) {
      const tok = String(samples[i]);
      if (line.length + tok.length + 1 > 70 || (i % perRow === 0 && line)) {
        w.ascii(line + '\n');
        line = '';
      }
      line += line ? ' ' + tok : tok;
    }
    w.ascii(line + '\n');
  } else if (format === 'pbm') {
    const stride = (width + 7) >> 3;
    const row = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      row.fill(0);
      for (let x = 0; x < width; x++) if (samples[y * width + x]) row[x >> 3] |= 0x80 >> (x & 7);
      w.bytes(row);
    }
  } else if (deep) {
    for (let i = 0; i < samples.length; i++) w.u16be(samples[i]);
  } else w.bytes(samples);
  return w.result();
}
