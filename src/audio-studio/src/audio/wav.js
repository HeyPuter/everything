// WAV (RIFF/RF64) reading and writing. Supports 8/16/24/32-bit PCM, 32/64-bit
// float, WAVE_FORMAT_EXTENSIBLE, cue points with labels and range lengths
// (cue + LIST/adtl labl/ltxt), which round-trip markers with other editors,
// mu-law/A-law and LIST/INFO metadata (title, artist, ...).

import { parseRiffInfo, parseBext, parseCart, decodeText } from './meta.js';
import { parseXmp } from './xmp.js';
import { ulaw, alaw } from './aiff.js';

const ascii = (dv, o, n) => {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(o + i));
  return s;
};

/** Most channels a file may have to be opened (more means a damaged header). */
export const MAX_CHANNELS = 1024;

export function isWav(buffer) {
  if (buffer.byteLength < 12) return false;
  const dv = new DataView(buffer);
  const riff = ascii(dv, 0, 4);
  // BW64 (ITU-R BS.2088, broadcast/ADM files) is laid out like RF64.
  return (riff === 'RIFF' || riff === 'RF64' || riff === 'BW64') && ascii(dv, 8, 4) === 'WAVE';
}

/** Whether a well-formed chunk header (printable id, size within the file) starts at `o`. */
function isChunkAt(dv, o) {
  if (o + 8 > dv.byteLength) return o >= dv.byteLength;
  for (let i = 0; i < 4; i++) {
    const c = dv.getUint8(o + i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return o + 8 + dv.getUint32(o + 4, true) <= dv.byteLength;
}

/** @returns {{ sampleRate, channels: Float32Array[], bitDepth, float, markers: object[] }} */
export function parseWav(buffer) {
  const dv = new DataView(buffer);
  if (!isWav(buffer)) throw new Error('Not a WAV file');
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  let ds64Data = null;
  const cues = new Map();
  const labels = new Map();
  const lengths = new Map();
  const notes = new Map();
  let meta = {};
  let fmtBad = false;
  let o = 12;
  while (o + 8 <= buffer.byteLength) {
    const id = ascii(dv, o, 4);
    let size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'ds64' && body + 16 <= buffer.byteLength) ds64Data = Number(dv.getBigUint64(body + 8, true));
    if (id === 'fmt ') {
      // A format chunk too short for its fields (or cut off) leaves `fmt` unset.
      if (size < 16 || body + 16 > buffer.byteLength) fmtBad = true;
      else {
        let format = dv.getUint16(body, true);
        const channels = dv.getUint16(body + 2, true);
        const sampleRate = dv.getUint32(body + 4, true);
        const byteRate = dv.getUint32(body + 8, true);
        const blockAlign = dv.getUint16(body + 12, true);
        const bits = dv.getUint16(body + 14, true);
        const sub = format === 0xfffe && size >= 40 && body + 26 <= buffer.byteLength;
        if (sub) format = dv.getUint16(body + 24, true);
        fmt = { format, channels, sampleRate, bits, byteRate, blockAlign };
      }
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size === 0xffffffff && ds64Data != null ? ds64Data : size;
      // A recorder stopped before it finished the header (power loss, crash) leaves
      // size 0 with the audio running to the end of the file.
      if (dataSize === 0 && !isChunkAt(dv, body)) dataSize = buffer.byteLength - body;
      if (dataOffset + dataSize > buffer.byteLength) dataSize = buffer.byteLength - dataOffset;
      size = dataSize;
    } else if (id === 'cue ' && body + 4 <= buffer.byteLength) {
      // A damaged or truncated cue list never blocks opening the audio: read
      // only the points that lie inside both the chunk and the file.
      const end = Math.min(body + size, buffer.byteLength);
      const n = dv.getUint32(body, true);
      for (let i = 0, p = body + 4; i < n && p + 24 <= end; i++, p += 24) {
        cues.set(dv.getUint32(p, true), dv.getUint32(p + 20, true));
      }
    } else if (id === 'LIST' && body + 4 <= buffer.byteLength && ascii(dv, body, 4) === 'INFO') {
      meta = { ...meta, ...parseRiffInfo(new Uint8Array(buffer, body, Math.min(size, buffer.byteLength - body))) };
    } else if (id === '_PMX') {
      // XMP packet: fills fields the other chunks did not set.
      meta = { ...parseXmp(new TextDecoder().decode(new Uint8Array(buffer, body, Math.max(0, Math.min(size, buffer.byteLength - body))))), ...meta };
    } else if (id === 'bext' || id === 'cart') {
      const bytes = new Uint8Array(buffer, body, Math.max(0, Math.min(size, buffer.byteLength - body)));
      // INFO wins for the shared title and artist; the cart chunk fills them in only when missing.
      meta = { ...(id === 'bext' ? parseBext(bytes) : parseCart(bytes)), ...meta };
    } else if (id === 'LIST' && body + 4 <= buffer.byteLength && ascii(dv, body, 4) === 'adtl') {
      let q = body + 4;
      const end = Math.min(body + size, buffer.byteLength);
      while (q + 12 <= end) {
        const sid = ascii(dv, q, 4);
        const ssize = dv.getUint32(q + 4, true);
        const cueId = dv.getUint32(q + 8, true);
        if (q + 8 + ssize > end) break;
        if (sid === 'labl' || sid === 'note') {
          const text = decodeText(new Uint8Array(buffer, q + 12, Math.max(0, ssize - 4))).replace(/\0+$/, '');
          (sid === 'labl' ? labels : notes).set(cueId, text);
        } else if (sid === 'ltxt' && ssize >= 8) {
          lengths.set(cueId, dv.getUint32(q + 12, true));
        }
        q += 8 + ssize + (ssize & 1);
      }
    }
    o = body + size + (size & 1);
  }
  if (!fmt && fmtBad) throw new Error('The WAV file header is damaged or cut off.');
  if (!fmt || dataOffset < 0) throw new Error('The WAV file has no audio data.');
  const { format, channels: nch, sampleRate, bits } = fmt;
  if (!nch || !sampleRate || !bits) throw new Error('The WAV file header is damaged.');
  const isFloat = format === 3;
  const law = format === 6 ? alaw : format === 7 ? ulaw : null;
  if (format !== 1 && format !== 3 && !law) throw new Error('This WAV encoding is not supported.');
  // Samples sit in whole bytes: 20-bit audio is stored (left-justified) in 3 bytes, 12-bit in 2.
  // Integer math keeps `frames` a small integer; Math.ceil hands back a double, which made the
  // first (cold) decode of a long file ~20% slower.
  const bytes = (bits + 7) >> 3;
  const container = bytes * 8;
  // A damaged channel count disagrees with both the block size and the byte rate (which a
  // valid header derives from it); without this a corrupt file opened with thousands of channels.
  const consistent = fmt.blockAlign === bytes * nch || fmt.byteRate === sampleRate * bytes * nch;
  if (nch > MAX_CHANNELS || !consistent) throw new Error('The WAV file header is damaged.');
  const frames = Math.floor(dataSize / (bytes * nch));
  const channels = Array.from({ length: nch }, () => new Float32Array(frames));
  const src = new Uint8Array(buffer, dataOffset, frames * bytes * nch);
  const view = new DataView(buffer, dataOffset);
  if (law) {
    for (let i = 0, p = 0; i < frames; i++) for (let c = 0; c < nch; c++, p++) channels[c][i] = law(src[p]);
  } else if (isFloat && bits === 32) {
    // NaN and infinite samples (left by faulty software) read as silence: one would turn a
    // whole file silent in Normalize and every other effect that measures or filters it.
    for (let i = 0, p = 0; i < frames; i++)
      for (let c = 0; c < nch; c++, p += 4) {
        const v = view.getFloat32(p, true);
        channels[c][i] = v - v === 0 ? v : 0;
      }
  } else if (isFloat && bits === 64) {
    for (let i = 0, p = 0; i < frames; i++)
      for (let c = 0; c < nch; c++, p += 8) {
        const v = view.getFloat64(p, true);
        channels[c][i] = v - v === 0 && v < 3e38 && v > -3e38 ? v : 0;
      }
  } else if (container === 16) {
    for (let i = 0, p = 0; i < frames; i++) for (let c = 0; c < nch; c++, p += 2) channels[c][i] = view.getInt16(p, true) / 32768;
  } else if (container === 24) {
    for (let i = 0, p = 0; i < frames; i++)
      for (let c = 0; c < nch; c++, p += 3) {
        const v = src[p] | (src[p + 1] << 8) | (src[p + 2] << 16);
        channels[c][i] = ((v << 8) >> 8) / 8388608;
      }
  } else if (container === 32) {
    for (let i = 0, p = 0; i < frames; i++) for (let c = 0; c < nch; c++, p += 4) channels[c][i] = view.getInt32(p, true) / 2147483648;
  } else if (container === 8) {
    for (let i = 0, p = 0; i < frames; i++) for (let c = 0; c < nch; c++, p++) channels[c][i] = (src[p] - 128) / 128;
  } else throw new Error(`${bits}-bit WAV files are not supported.`);
  const markers = [...cues].map(([id, position]) => ({
    start: position,
    duration: lengths.get(id) || 0,
    name: labels.get(id) || '',
    description: notes.get(id) || '',
    type: 'cue',
  }));
  return { sampleRate, channels, bitDepth: law ? 16 : container, float: isFloat, markers, meta };
}

/**
 * Encodes channels (Channel objects or Float32Arrays) as a WAV Blob.
 * @param {{ sampleRate, channels, bitDepth?: 16|24|32, float?: boolean, markers?: object[] }} o
 */
export function encodeWav({ sampleRate, channels, bitDepth = 16, float = bitDepth === 32, markers = [], dither = bitDepth < 24 }) {
  const nch = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytes = bitDepth / 8;
  const dataSize = frames * nch * bytes;
  const parts = [];
  const header = new DataView(new ArrayBuffer(36 + 8));
  const w4 = (dv, o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  // Marker chunks.
  const cueChunk = markers.length ? buildCue(markers) : null;
  const total = 4 + 24 + 8 + dataSize + (dataSize & 1) + (cueChunk ? cueChunk.byteLength : 0);
  w4(header, 0, 'RIFF');
  header.setUint32(4, Math.min(0xffffffff, total), true);
  w4(header, 8, 'WAVE');
  w4(header, 12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, float ? 3 : 1, true);
  header.setUint16(22, nch, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * nch * bytes, true);
  header.setUint16(32, nch * bytes, true);
  header.setUint16(34, bitDepth, true);
  w4(header, 36, 'data');
  header.setUint32(40, dataSize, true);
  parts.push(header.buffer);
  const CH = 65536;
  const tmp = Array.from({ length: nch }, () => new Float32Array(CH));
  let seed = 22222;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let at = 0; at < frames; at += CH) {
    const n = Math.min(CH, frames - at);
    for (let c = 0; c < nch; c++) {
      const ch = channels[c];
      if (ch.read) ch.read(at, tmp[c], 0, n);
      else tmp[c].set(ch.subarray(at, at + n));
    }
    const buf = new ArrayBuffer(n * nch * bytes);
    const dv = new DataView(buf);
    let p = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        let v = tmp[c][i];
        if (float) {
          dv.setFloat32(p, v, true);
          p += 4;
          continue;
        }
        if (dither) v += (rand() - rand()) / (bitDepth === 16 ? 32768 : 8388608);
        v = Math.max(-1, Math.min(1, v));
        // Full scale is 2^(bits-1) both ways (as parseWav and the export writers use), so
        // integer samples read from a file are written back unchanged; +1.0 clips to the top code.
        if (bitDepth === 16) {
          dv.setInt16(p, Math.min(32767, Math.round(v * 32768)), true);
          p += 2;
        } else if (bitDepth === 24) {
          const s = Math.min(8388607, Math.round(v * 8388608));
          dv.setUint8(p, s & 255);
          dv.setUint8(p + 1, (s >> 8) & 255);
          dv.setUint8(p + 2, (s >> 16) & 255);
          p += 3;
        } else if (bitDepth === 8) {
          dv.setUint8(p, Math.min(255, Math.round(v * 128 + 128)));
          p += 1;
        } else {
          dv.setInt32(p, Math.min(2147483647, Math.round(v * 2147483648)), true);
          p += 4;
        }
      }
    }
    parts.push(buf);
  }
  if (dataSize & 1) parts.push(new Uint8Array(1));
  if (cueChunk) parts.push(cueChunk);
  return new Blob(parts, { type: 'audio/wav' });
}

/** cue chunk plus LIST/adtl labels and region lengths for markers (an ArrayBuffer). */
export function buildCue(markers) {
  const enc = new TextEncoder();
  const cue = new DataView(new ArrayBuffer(12 + markers.length * 24));
  const w4 = (dv, o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  w4(cue, 0, 'cue ');
  cue.setUint32(4, 4 + markers.length * 24, true);
  cue.setUint32(8, markers.length, true);
  markers.forEach((m, i) => {
    const p = 12 + i * 24;
    cue.setUint32(p, i + 1, true);
    cue.setUint32(p + 4, m.start, true);
    w4(cue, p + 8, 'data');
    cue.setUint32(p + 20, m.start, true);
  });
  const subs = [];
  markers.forEach((m, i) => {
    const text = enc.encode(`${m.name || ''}\0`);
    const size = 4 + text.length;
    const sub = new Uint8Array(8 + size + (size & 1));
    const dv = new DataView(sub.buffer);
    w4(dv, 0, 'labl');
    dv.setUint32(4, size, true);
    dv.setUint32(8, i + 1, true);
    sub.set(text, 12);
    subs.push(sub);
    if (m.description) {
      // Descriptions travel as "note" sub-chunks, which parseWav reads back.
      const note = enc.encode(`${m.description}\0`);
      const nsize = 4 + note.length;
      const nsub = new Uint8Array(8 + nsize + (nsize & 1));
      const ndv = new DataView(nsub.buffer);
      w4(ndv, 0, 'note');
      ndv.setUint32(4, nsize, true);
      ndv.setUint32(8, i + 1, true);
      nsub.set(note, 12);
      subs.push(nsub);
    }
    if (m.duration) {
      const lt = new Uint8Array(8 + 20);
      const ld = new DataView(lt.buffer);
      w4(ld, 0, 'ltxt');
      ld.setUint32(4, 20, true);
      ld.setUint32(8, i + 1, true);
      ld.setUint32(12, m.duration, true);
      w4(ld, 16, 'rgn ');
      subs.push(lt);
    }
  });
  const listSize = 4 + subs.reduce((s, b) => s + b.length, 0);
  const list = new Uint8Array(8 + listSize);
  const ldv = new DataView(list.buffer);
  w4(ldv, 0, 'LIST');
  ldv.setUint32(4, listSize, true);
  w4(ldv, 8, 'adtl');
  let o = 12;
  for (const s of subs) {
    list.set(s, o);
    o += s.length;
  }
  const out = new Uint8Array(cue.byteLength + list.length);
  out.set(new Uint8Array(cue.buffer), 0);
  out.set(list, cue.byteLength);
  return out.buffer;
}
