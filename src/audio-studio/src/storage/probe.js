// Reads duration and format details from the first (and, when needed, last)
// bytes of an audio file, so the Media Browser can list durations without
// downloading whole files.

import { readExtended } from '../audio/aiff.js';
import { id3v2Size } from '../audio/meta.js';
import { parseMp3Header } from '../export/mp3.js';

export const HEAD_BYTES = 65536;
export const TAIL_BYTES = 65536;

const str = (b, o, n) => {
  let s = '';
  for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]);
  return s;
};

/**
 * @param {Uint8Array} head first bytes of the file
 * @param {number} size total file size
 * @param {Uint8Array} [tail] last bytes (Ogg and MP4 with the index at the end)
 * @returns {{ format, duration?, sampleRate?, channels?, bitDepth?, needTail?, skip? }}
 *   `skip`: an ID3v2 tag (cover art) fills the head; probe again with the
 *   bytes from that offset and `size - skip` (see probeSource).
 */
export function probeAudio(head, size, tail = null) {
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const id = str(head, 0, 4);
  if ((id === 'RIFF' || id === 'RF64' || id === 'BW64') && str(head, 8, 4) === 'WAVE') {
    let o = 12;
    let fmt = null;
    let ds64 = null;
    while (o + 8 <= head.length) {
      const cid = str(head, o, 4);
      const csize = dv.getUint32(o + 4, true);
      if (cid === 'ds64' && o + 24 <= head.length) ds64 = Number(dv.getBigUint64(o + 16, true));
      if (cid === 'fmt ' && o + 24 <= head.length) fmt = { channels: dv.getUint16(o + 10, true), sampleRate: dv.getUint32(o + 12, true), blockAlign: dv.getUint16(o + 20, true), bits: dv.getUint16(o + 22, true) };
      if (cid === 'data') {
        if (!fmt) break;
        let bytes = csize === 0xffffffff && ds64 != null ? ds64 : Math.min(csize, size - o - 8);
        // A recording cut off before its header was finished: size 0 with the audio running
        // to the end of the file (as parseWav reads it), unless another chunk follows.
        if (csize === 0 && !/^[\x20-\x7e]{4}$/.test(str(head, o + 8, 4))) bytes = size - o - 8;
        return { format: 'WAV', sampleRate: fmt.sampleRate, channels: fmt.channels, bitDepth: fmt.bits, duration: bytes / (fmt.blockAlign || 1) / fmt.sampleRate };
      }
      o += 8 + csize + (csize & 1);
    }
    return fmt ? { format: 'WAV', sampleRate: fmt.sampleRate, channels: fmt.channels, bitDepth: fmt.bits } : { format: 'WAV' };
  }
  if (id === 'FORM' && (str(head, 8, 4) === 'AIFF' || str(head, 8, 4) === 'AIFC')) {
    let o = 12;
    while (o + 26 <= head.length) {
      const cid = str(head, o, 4);
      const csize = dv.getUint32(o + 4);
      if (cid === 'COMM') {
        const channels = dv.getInt16(o + 8);
        const frames = dv.getUint32(o + 10);
        const bits = dv.getInt16(o + 14);
        const rate = readExtended(dv, o + 16);
        return { format: 'AIFF', sampleRate: Math.round(rate), channels, bitDepth: bits, duration: rate ? frames / rate : undefined };
      }
      o += 8 + csize + (csize & 1);
    }
    return { format: 'AIFF' };
  }
  if (id === 'fLaC' && head.length >= 26) {
    const s = head.subarray(8, 42);
    const rate = (s[10] << 12) | (s[11] << 4) | (s[12] >> 4);
    const channels = ((s[12] >> 1) & 7) + 1;
    const bits = (((s[12] & 1) << 4) | (s[13] >> 4)) + 1;
    const total = (s[13] & 15) * 2 ** 32 + (((s[14] << 24) | (s[15] << 16) | (s[16] << 8) | s[17]) >>> 0);
    return { format: 'FLAC', sampleRate: rate, channels, bitDepth: bits, duration: rate && total ? total / rate : undefined };
  }
  if (id === 'OggS') {
    const codec = str(head, 28, 8);
    const opus = codec.startsWith('OpusHead');
    const vorbis = codec.slice(1, 7) === 'vorbis';
    const channels = opus ? head[37] : vorbis ? head[39] : undefined;
    const preSkip = opus ? head[38] | (head[39] << 8) : 0;
    const rate = opus ? 48000 : vorbis ? dv.getUint32(40, true) : undefined;
    const info = { format: opus ? 'Opus' : vorbis ? 'Vorbis' : 'Ogg', sampleRate: opus ? (dv.getUint32(40, true) || 48000) : rate, channels };
    if (!tail) return { ...info, needTail: size > head.length };
    const src = size <= head.length ? head : tail;
    for (let i = src.length - 27; i >= 0; i--) {
      if (src[i] === 0x4f && src[i + 1] === 0x67 && src[i + 2] === 0x67 && src[i + 3] === 0x53) {
        const granule = Number(new DataView(src.buffer, src.byteOffset + i + 6, 8).getBigInt64(0, true));
        if (granule > 0 && rate) return { ...info, duration: (granule - preSkip) / rate };
      }
    }
    return info;
  }
  if (str(head, 4, 4) === 'ftyp') {
    const found = mvhd(head) || (tail && mvhd(tail));
    const brand = str(head, 8, 4).trim();
    const format = brand === 'M4A' || brand === 'M4B' ? 'AAC' : brand === 'qt' ? 'MOV' : 'MP4';
    if (found) return { format, duration: found };
    return { format, needTail: !tail && size > head.length };
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { format: str(head, 0, 64).includes('webm') ? 'WebM' : 'Matroska' };
  // MPEG audio (after an optional ID3v2 tag), or FLAC that a tagger put behind one.
  const tag = id3v2Size(head);
  const flacAt = tag && tag + 42 <= head.length && str(head, tag, 4) === 'fLaC';
  if (flacAt) return probeAudio(head.subarray(tag), size - tag);
  if (tag && tag + 4096 > head.length && size > head.length) return { format: 'MP3', skip: tag };
  for (let i = tag; i + 4 < Math.min(head.length, tag + 8192); i++) {
    const h = parseMp3Header(head, i);
    if (!h) continue;
    const next = parseMp3Header(head, i + h.length);
    if (!next && i + h.length + 4 < head.length) continue;
    // Xing/Info (VBR) or VBRI headers carry the frame count.
    const sideInfo = h.version === 1 ? (h.channels === 1 ? 17 : 32) : h.channels === 1 ? 9 : 17;
    const x = i + 4 + sideInfo;
    let frames = 0;
    if ((str(head, x, 4) === 'Xing' || str(head, x, 4) === 'Info') && x + 12 <= head.length) {
      const flags = new DataView(head.buffer, head.byteOffset + x + 4).getUint32(0);
      if (flags & 1) frames = new DataView(head.buffer, head.byteOffset + x + 8).getUint32(0);
    } else if (str(head, i + 36, 4) === 'VBRI' && i + 54 <= head.length) {
      frames = new DataView(head.buffer, head.byteOffset + i + 50).getUint32(0);
    }
    const duration = frames ? (frames * h.samples) / h.sampleRate : ((size - i) * 8) / (h.bitrate * 1000);
    return { format: 'MP3', sampleRate: h.sampleRate, channels: h.channels, duration };
  }
  return { format: '' };
}

/**
 * Probes a file through `read(offset, count)` (resolving a Uint8Array):
 * the head, then the tail or the audio after a large ID3v2 tag when needed.
 */
export async function probeSource(read, size) {
  const head = await read(0, Math.min(HEAD_BYTES, size || HEAD_BYTES));
  let p = probeAudio(head, size);
  if (p.needTail && size > HEAD_BYTES) p = probeAudio(head, size, await read(Math.max(0, size - TAIL_BYTES), Math.min(TAIL_BYTES, size)));
  else if (p.skip) {
    const rest = probeAudio(await read(p.skip, Math.min(HEAD_BYTES, size - p.skip)), size - p.skip);
    p = rest.format === 'MP3' || rest.format === 'FLAC' ? rest : { format: 'MP3' };
  }
  return p;
}

function mvhd(b) {
  for (let i = 0; i + 32 < b.length; i++) {
    if (b[i + 4] !== 0x6d || b[i + 5] !== 0x76 || b[i + 6] !== 0x68 || b[i + 7] !== 0x64) continue;
    const dv = new DataView(b.buffer, b.byteOffset + i + 8);
    const v = dv.getUint8(0);
    if (v === 1 && i + 8 + 32 <= b.length) {
      const scale = dv.getUint32(20);
      const dur = Number(dv.getBigUint64(24));
      return scale ? dur / scale : 0;
    }
    const scale = dv.getUint32(12);
    const dur = dv.getUint32(16);
    return scale ? dur / scale : 0;
  }
  return 0;
}

/** "WAV 48 kHz 24-bit Stereo" */
export function describeProbe(p) {
  if (!p?.format) return '';
  const parts = [p.format];
  if (p.sampleRate) parts.push(`${(p.sampleRate / 1000).toFixed(p.sampleRate % 1000 ? 1 : 0)} kHz`);
  if (p.bitDepth && /WAV|AIFF|FLAC/.test(p.format)) parts.push(`${p.bitDepth}-bit`);
  if (p.channels) parts.push(p.channels === 1 ? 'Mono' : p.channels === 2 ? 'Stereo' : `${p.channels} ch`);
  return parts.join(' ');
}
