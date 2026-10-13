/**
 * Stream filters: Flate, LZW, ASCIIHex, ASCII85 and RunLength decoding,
 * with PNG and TIFF predictors. Image codecs (DCT, JPX, CCITT, JBIG2) are
 * left encoded: `decodeStream` stops at the first of them and reports it
 * so the image code can pass JPEG data to the browser.
 */
import { inflate } from '../codec/zlib.js';
import { Name, PDFStream, PDFDict } from './primitives.js';

const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);

function asciiHex(b) {
  const out = new Uint8Array(Math.ceil(b.length / 2));
  let n = 0;
  let hi = -1;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 62) break;
    let v = -1;
    if (c >= 48 && c <= 57) v = c - 48;
    else if (c >= 65 && c <= 70) v = c - 55;
    else if (c >= 97 && c <= 102) v = c - 87;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out[n++] = (hi << 4) | v;
      hi = -1;
    }
  }
  if (hi >= 0) out[n++] = hi << 4;
  return out.slice(0, n);
}

export function ascii85(b) {
  const out = new Uint8Array(Math.ceil((b.length * 4) / 5) + 4);
  let n = 0;
  const group = [];
  let i = 0;
  if (b[0] === 60 && b[1] === 126) i = 2; // optional "<~"
  for (; i < b.length; i++) {
    const c = b[i];
    if (c === 126) break; // "~>"
    if (c === 122 && !group.length) {
      out[n++] = 0;
      out[n++] = 0;
      out[n++] = 0;
      out[n++] = 0;
      continue;
    }
    if (c < 33 || c > 117) continue;
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const d of group) v = v * 85 + d;
      out[n++] = (v >>> 24) & 255;
      out[n++] = (v >>> 16) & 255;
      out[n++] = (v >>> 8) & 255;
      out[n++] = v & 255;
      group.length = 0;
    }
  }
  if (group.length > 1) {
    const k = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const d of group) v = v * 85 + d;
    for (let j = 0; j < k - 1; j++) out[n++] = (v >>> (24 - 8 * j)) & 255;
  }
  return out.slice(0, n);
}

function runLength(b) {
  const out = [];
  let i = 0;
  while (i < b.length) {
    const len = b[i++];
    if (len === 128) break;
    if (len < 128) {
      for (let k = 0; k <= len && i < b.length; k++) out.push(b[i++]);
    } else {
      const v = b[i++];
      for (let k = 0; k < 257 - len; k++) out.push(v);
    }
  }
  return Uint8Array.from(out);
}

/** LZW (PDF/TIFF flavour: MSB-first codes, 258 = clear, 257 = end). */
export function lzw(b, earlyChange = 1) {
  let out = new Uint8Array(Math.max(1024, b.length * 3));
  let n = 0;
  const push = (v) => {
    if (n >= out.length) {
      const next = new Uint8Array(out.length * 2);
      next.set(out);
      out = next;
    }
    out[n++] = v;
  };
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    length[i] = 1;
  }
  let next = 258;
  let bits = 9;
  let prev = -1;
  let buf = 0;
  let nbits = 0;
  let pos = 0;
  const stack = new Uint8Array(4096);
  for (;;) {
    while (nbits < bits && pos < b.length) {
      buf = ((buf << 8) | b[pos++]) >>> 0;
      nbits += 8;
    }
    if (nbits < bits) break;
    const code = (buf >>> (nbits - bits)) & ((1 << bits) - 1);
    nbits -= bits;
    if (code === 256) {
      next = 258;
      bits = 9;
      prev = -1;
      continue;
    }
    if (code === 257) break;
    let cur = code;
    let first;
    if (code < next) {
      // Known code.
    } else if (code === next && prev >= 0) {
      cur = prev;
    } else break;
    let sp = 0;
    let c = cur;
    while (c >= 0 && sp < 4096) {
      stack[sp++] = suffix[c];
      c = prefix[c];
    }
    first = stack[sp - 1];
    for (let k = sp - 1; k >= 0; k--) push(stack[k]);
    if (code === next) push(first);
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      length[next] = length[prev] + 1;
      next++;
    }
    prev = code;
    if (next + earlyChange >= 1 << bits && bits < 12) bits++;
  }
  return out.slice(0, n);
}

/** Undo a PNG (>= 10) or TIFF (2) predictor. */
export function unpredict(data, parms) {
  if (!parms) return data;
  const predictor = parms.num('Predictor', 1);
  if (predictor <= 1) return data;
  const colors = parms.num('Colors', 1);
  const bpc = parms.num('BitsPerComponent', 8);
  const columns = parms.num('Columns', 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    const out = data.slice();
    if (bpc === 8) {
      for (let r = 0; r * rowBytes < out.length; r++) {
        const o = r * rowBytes;
        for (let i = bpp; i < rowBytes && o + i < out.length; i++) out[o + i] = (out[o + i] + out[o + i - bpp]) & 255;
      }
    } else if (bpc === 16) {
      for (let r = 0; r * rowBytes < out.length; r++) {
        const o = r * rowBytes;
        for (let i = 2 * colors; i + 1 < rowBytes && o + i + 1 < out.length; i += 2) {
          const v = ((out[o + i] << 8) | out[o + i + 1]) + ((out[o + i - 2 * colors] << 8) | out[o + i + 1 - 2 * colors]);
          out[o + i] = (v >> 8) & 255;
          out[o + i + 1] = v & 255;
        }
      }
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  let prev = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const src = r * (rowBytes + 1);
    const type = data[src];
    const row = out.subarray(r * rowBytes, (r + 1) * rowBytes);
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + 1 + i];
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (type) {
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: v = x;
      }
      row[i] = v & 255;
    }
    prev = row;
  }
  return out;
}

/** The stream's filters as [{ name, parms }]. */
export function filtersOf(dict) {
  let f = dict.get('Filter', 'F');
  let p = dict.get('DecodeParms', 'DP');
  if (!f) return [];
  if (!Array.isArray(f)) f = [f];
  if (!Array.isArray(p)) p = [p];
  const xref = dict.xref;
  return f.map((x, i) => {
    const name = x instanceof Name ? x.name : String(x);
    let parms = p[i];
    if (parms && xref && parms.num === undefined) parms = xref.fetch(parms);
    return { name, parms: parms instanceof PDFDict ? parms : null };
  });
}

/**
 * Decode a stream's data. Returns { bytes, image } where `image` is the
 * name of an image codec left to decode (DCTDecode...) or null.
 */
export function decodeStream(stream) {
  let data = stream.raw;
  for (const { name, parms } of filtersOf(stream.dict)) {
    if (IMAGE_FILTERS.has(name)) return { bytes: data, image: name === 'DCT' ? 'DCTDecode' : name === 'CCF' ? 'CCITTFaxDecode' : name, parms };
    switch (name) {
      case 'FlateDecode':
      case 'Fl':
        data = unpredict(inflate(data), parms);
        break;
      case 'LZWDecode':
      case 'LZW':
        data = unpredict(lzw(data, parms ? parms.num('EarlyChange', 1) : 1), parms);
        break;
      case 'ASCIIHexDecode':
      case 'AHx':
        data = asciiHex(data);
        break;
      case 'ASCII85Decode':
      case 'A85':
        data = ascii85(data);
        break;
      case 'RunLengthDecode':
      case 'RL':
        data = runLength(data);
        break;
      case 'Crypt':
        break;
      default:
        throw new Error(`Unsupported stream filter ${name}`);
    }
  }
  return { bytes: data, image: null };
}

PDFStream.decode = (stream) => {
  const r = decodeStream(stream);
  return r.bytes;
};
