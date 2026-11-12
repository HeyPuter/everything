// AIFF and AIFF-C reading: big- and little-endian (sowt) PCM of 8 to 32 bits,
// 32/64-bit float (fl32/fl64), mu-law and A-law, markers (MARK) and text
// chunks (NAME, AUTH, ANNO, ID3). Written exports use src/export/writers.

import { parseId3v2 } from './meta.js';

const str = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

export function isAiff(buffer) {
  if (buffer.byteLength < 12) return false;
  const b = new Uint8Array(buffer, 0, 12);
  const form = str(b, 8, 4);
  return str(b, 0, 4) === 'FORM' && (form === 'AIFF' || form === 'AIFC');
}

/** 80-bit IEEE 754 extended (big-endian) at `o`. */
export function readExtended(dv, o) {
  const se = dv.getUint16(o);
  const hi = dv.getUint32(o + 2);
  const lo = dv.getUint32(o + 6);
  if (!se && !hi && !lo) return 0;
  const sign = se & 0x8000 ? -1 : 1;
  const exp = (se & 0x7fff) - 16383;
  return sign * (hi * 2 ** (exp - 31) + lo * 2 ** (exp - 63));
}

/** Writes a positive number as an 80-bit extended float (exact for integers below 2^64). */
export function writeExtended(dv, o, value) {
  if (!value) {
    dv.setUint16(o, 0);
    dv.setUint32(o + 2, 0);
    dv.setUint32(o + 6, 0);
    return;
  }
  const exp = Math.floor(Math.log2(value));
  const mant = value / 2 ** exp; // [1, 2)
  const hiF = mant * 2 ** 31;
  const hi = Math.floor(hiF);
  const lo = Math.floor((hiF - hi) * 2 ** 32);
  dv.setUint16(o, exp + 16383);
  dv.setUint32(o + 2, hi >>> 0);
  dv.setUint32(o + 6, lo >>> 0);
}

export function ulaw(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 7;
  const mantissa = u & 0x0f;
  const v = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return (sign ? -v : v) / 32768;
}

export function alaw(a) {
  a ^= 0x55;
  const sign = a & 0x80;
  const exponent = (a >> 4) & 7;
  const mantissa = a & 0x0f;
  let v = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
  return (sign ? v : -v) / 32768;
}

/** @returns {{ sampleRate, channels: Float32Array[], bitDepth, float, markers, meta }} */
export function parseAiff(buffer) {
  if (!isAiff(buffer)) throw new Error('Not an AIFF file');
  const b = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const aifc = str(b, 8, 4) === 'AIFC';
  let comm = null;
  let ssnd = -1;
  let ssndSize = 0;
  let ssndDeclared = 0;
  const marks = [];
  const meta = {};
  let o = 12;
  while (o + 8 <= b.length) {
    const id = str(b, o, 4);
    let size = dv.getUint32(o + 4);
    const declared = size;
    const body = o + 8;
    if (body + size > b.length) size = b.length - body;
    if (id === 'COMM' && size >= 18) {
      comm = {
        channels: dv.getInt16(body),
        frames: dv.getUint32(body + 2),
        bits: dv.getInt16(body + 6),
        rate: readExtended(dv, body + 8),
        type: aifc && size >= 22 ? str(b, body + 18, 4) : 'NONE',
      };
    } else if (id === 'SSND') {
      const offset = dv.getUint32(body);
      ssnd = body + 8 + offset;
      ssndSize = Math.max(0, size - 8 - offset);
      ssndDeclared = Math.max(0, declared - 8 - offset);
    } else if (id === 'MARK' && size >= 2) {
      const n = dv.getUint16(body);
      let p = body + 2;
      for (let i = 0; i < n && p + 7 <= body + size; i++) {
        const markId = dv.getUint16(p);
        const position = dv.getUint32(p + 2);
        const len = b[p + 6];
        const name = new TextDecoder('latin1').decode(b.subarray(p + 7, p + 7 + len));
        marks.push({ id: markId, start: position, duration: 0, name, description: '', type: 'cue' });
        p += 7 + len + ((len + 1) & 1);
      }
    } else if (id === 'NAME' || id === 'AUTH' || id === 'ANNO') {
      const text = new TextDecoder().decode(b.subarray(body, body + size)).replace(/\0+$/, '').trim();
      const field = { NAME: 'title', AUTH: 'artist', ANNO: 'comment' }[id];
      if (text && !meta[field]) meta[field] = text;
    } else if (id === 'ID3 ' || id === 'id3 ') {
      const tags = parseId3v2(b.subarray(body, body + size));
      for (const [k, v] of Object.entries(tags)) if (!meta[k]) meta[k] = v;
    }
    o = body + size + (size & 1);
  }
  if (!comm || ssnd < 0) throw new Error('The AIFF file has no audio data.');
  const { channels: nch, bits, rate, type } = comm;
  // Corrupt fields would open thousands of channels, an absurd rate or garbage samples.
  const damaged = () => new Error('The AIFF file header is damaged.');
  if (nch < 1 || nch > 1024 || !(rate > 0 && rate < 2 ** 32)) throw damaged();
  const t = type.toLowerCase();
  let bytes;
  let read;
  let float = false;
  let depth = bits;
  if (t === 'none' || t === 'twos' || t === 'raw ' || t === 'in24' || t === 'in32' || t === 'sowt') {
    if (bits < 1 || bits > 32) throw damaged();
    const little = t === 'sowt';
    bytes = Math.ceil(bits / 8);
    if (t === 'in24') bytes = 3;
    if (t === 'in32') bytes = 4;
    depth = bytes * 8;
    const unsigned = t === 'raw ';
    const scale = 2 ** (bytes * 8 - 1);
    read = (p) => {
      let v = 0;
      if (little) for (let k = bytes - 1; k >= 0; k--) v = v * 256 + b[p + k];
      else for (let k = 0; k < bytes; k++) v = v * 256 + b[p + k];
      if (unsigned) return v / scale - 1;
      if (v >= scale) v -= scale * 2;
      return v / scale;
    };
  } else if (t === 'fl32') {
    bytes = 4;
    float = true;
    depth = 32;
    // NaN and infinite samples read as silence (see parseWav).
    read = (p) => {
      const v = dv.getFloat32(p);
      return v - v === 0 ? v : 0;
    };
  } else if (t === 'fl64') {
    bytes = 8;
    float = true;
    depth = 32;
    read = (p) => {
      const v = dv.getFloat64(p);
      return v - v === 0 && v < 3e38 && v > -3e38 ? v : 0;
    };
  } else if (t === 'ulaw' || t === 'alaw') {
    bytes = 1;
    depth = 16;
    read = t === 'ulaw' ? (p) => ulaw(b[p]) : (p) => alaw(b[p]);
  } else throw new Error(`AIFF-C compression "${type.trim()}" is not supported.`);
  // AIFF has no block size to check the channel count against, but a damaged count makes the
  // sound data the header announces far smaller than its frames need (a cut-off file does not).
  if (comm.frames > 0 && ssndDeclared * 2 < comm.frames * bytes * nch) throw damaged();
  const frames = Math.min(comm.frames, Math.floor(ssndSize / (bytes * nch)));
  const channels = Array.from({ length: nch }, () => new Float32Array(frames));
  const stride = bytes * nch;
  // Fast paths for the common layouts.
  if (!float && t !== 'sowt' && t !== 'raw ' && bytes === 2) {
    for (let i = 0, p = ssnd; i < frames; i++) for (let c = 0; c < nch; c++, p += 2) channels[c][i] = dv.getInt16(p) / 32768;
  } else if (!float && t !== 'sowt' && t !== 'raw ' && bytes === 3) {
    for (let i = 0, p = ssnd; i < frames; i++)
      for (let c = 0; c < nch; c++, p += 3) channels[c][i] = (((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8)) >> 8) / 8388608;
  } else {
    for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) channels[c][i] = read(ssnd + i * stride + c * bytes);
  }
  const markers = marks.filter((m) => m.start <= frames).sort((a, c) => a.start - c.start).map(({ id, ...m }) => m);
  return { sampleRate: Math.round(rate), channels, bitDepth: float ? 32 : depth, float, markers, meta };
}
