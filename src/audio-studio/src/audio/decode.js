// Decoding audio files into planar Float32 channels at their native sample
// rate. WAV is parsed directly. Other formats are decoded by the browser:
// decodeAudioData resamples to its context's rate, so the native rate is read
// from the file header first and the decode runs in an OfflineAudioContext at
// that rate.

import { isWav, parseWav } from './wav.js';
import { isAiff, parseAiff } from './aiff.js';
import { readTags } from './meta.js';

export const AUDIO_EXTENSIONS = ['wav', 'wave', 'bwf', 'rf64', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'mp4', 'm4v', 'webm', 'weba', 'mkv', 'aif', 'aiff', 'aifc', 'caf', 'mov'];
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mkv', 'mov'];
/** Formats browsers cannot decode at all: a clear message beats a decode failure. */
const UNSUPPORTED = { wma: 'Windows Media Audio', ape: "Monkey's Audio", wv: 'WavPack', ra: 'RealAudio', rm: 'RealMedia', mid: 'MIDI', midi: 'MIDI', amr: 'AMR', ac3: 'Dolby Digital', dts: 'DTS' };
export const AUDIO_ACCEPT = AUDIO_EXTENSIONS.map((e) => `.${e}`).join(',') + ',audio/*,video/mp4,video/webm';

export function extensionOf(name = '') {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function baseName(name = '') {
  return name.replace(/\.[a-z0-9]+$/i, '');
}

/** Best guess of the native sample rate from a compressed file's header, or 0. */
export function sniffSampleRate(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1 << 20));
  const str = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  // FLAC: "fLaC" then STREAMINFO; rate is 20 bits at byte 18 of the file.
  if (str(0, 4) === 'fLaC' && b.length > 21) return (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  // Ogg: Opus always decodes at 48 kHz; Vorbis stores the rate in its id header.
  if (str(0, 4) === 'OggS') {
    const head = str(28, 8);
    if (head.startsWith('OpusHead')) return 48000;
    if (head.slice(1, 7) === 'vorbis') return new DataView(buffer).getUint32(28 + 12, true);
  }
  // AIFF: COMM chunk holds an 80-bit extended float.
  if (str(0, 4) === 'FORM' && (str(8, 4) === 'AIFF' || str(8, 4) === 'AIFC')) {
    for (let o = 12; o + 26 < b.length; ) {
      const id = str(o, 4);
      const size = new DataView(buffer).getUint32(o + 4);
      if (id === 'COMM') {
        const dv = new DataView(buffer, o + 16, 10);
        const exp = (dv.getUint16(0) & 0x7fff) - 16383;
        const mant = dv.getUint32(2);
        return Math.round(mant * Math.pow(2, exp - 31));
      }
      o += 8 + size + (size & 1);
    }
  }
  // WebM/Matroska: Opus decodes at 48 kHz; otherwise read SamplingFrequency (0xB5, float).
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const text = new TextDecoder('latin1').decode(b.subarray(0, 65536));
    if (text.includes('A_OPUS')) return 48000;
    const dv = new DataView(buffer);
    for (let i = 0; i + 10 < Math.min(b.length, 65536); i++) {
      if (b[i] !== 0xb5) continue;
      const v = b[i + 1] === 0x88 ? dv.getFloat64(i + 2) : b[i + 1] === 0x84 ? dv.getFloat32(i + 2) : 0;
      if (v >= 8000 && v <= 192000 && Number.isInteger(v)) return v;
    }
    return 48000;
  }
  // MP4/M4A: the mp4a sample entry stores the rate as 16.16 fixed point.
  const mp4a = (v, from, to) => {
    for (let i = from; i + 36 < to; i++) {
      if (v[i] === 0x6d && v[i + 1] === 0x70 && v[i + 2] === 0x34 && v[i + 3] === 0x61) {
        const rate = (v[i + 28] << 8) | v[i + 29];
        if (rate >= 8000 && rate <= 192000) return rate;
      }
    }
    return 0;
  };
  const inHead = mp4a(b, 4, b.length);
  if (inHead) return inHead;
  const all = new Uint8Array(buffer);
  if (str(4, 4) === 'ftyp' && all.length > b.length) {
    // The movie box is often written after the media data, past the first megabyte.
    const moov = mp4Box(all, 'moov');
    if (moov) return mp4a(all, moov[0], moov[1]);
  }
  // MPEG audio: skip an ID3v2 tag (cover art can make it megabytes long), then read the first frame header.
  let o = 0;
  if (str(0, 3) === 'ID3' && b.length >= 10) o = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) + (b[5] & 0x10 ? 10 : 0);
  for (let i = o; i + 4 < all.length && i < o + 65536; i++) {
    if (all[i] === 0xff && (all[i + 1] & 0xe0) === 0xe0) {
      const version = (all[i + 1] >> 3) & 3;
      const layer = (all[i + 1] >> 1) & 3;
      const rateIdx = (all[i + 2] >> 2) & 3;
      if (version === 1 || layer === 0 || rateIdx === 3) continue;
      const base = [44100, 48000, 32000][rateIdx];
      return version === 3 ? base : version === 2 ? base / 2 : base / 4;
    }
  }
  return 0;
}

/** [start, end) of the first top-level MP4 box of `type`, or null. */
function mp4Box(bytes, type) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let o = 0; o + 8 <= bytes.length; ) {
    let size = dv.getUint32(o);
    let head = 8;
    if (size === 1 && o + 16 <= bytes.length) {
      size = Number(dv.getBigUint64(o + 8));
      head = 16;
    } else if (size === 0) size = bytes.length - o;
    if (size < head) return null;
    if (String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]) === type) return [o + head, Math.min(bytes.length, o + size)];
    o += size;
  }
  return null;
}

/**
 * @param {ArrayBuffer} buffer
 * @param {string} name
 * @returns {Promise<{ sampleRate, channels: Float32Array[], bitDepth, format, markers }>}
 */
export async function decodeAudio(buffer, name = '') {
  const ext = extensionOf(name);
  const label = name || 'This file';
  if (!buffer || buffer.byteLength === 0) throw new Error(`"${label}" is empty.`);
  if (isWav(buffer)) {
    const r = parseWav(buffer);
    return { ...r, format: 'wav' };
  }
  if (isAiff(buffer)) {
    const r = parseAiff(buffer);
    return { ...r, format: 'aiff' };
  }
  if (UNSUPPORTED[ext]) throw new Error(`"${label}" is ${UNSUPPORTED[ext]}, which browsers cannot decode. Convert it to WAV, FLAC or MP3 first.`);
  const rate = sniffSampleRate(buffer) || 48000;
  const meta = readTags(buffer);
  const isFlac = sniffFlac(buffer);
  const bitDepth = isFlac ? flacBits(buffer) : 16;
  const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('This browser cannot decode audio files.');
  let ctx;
  try {
    ctx = new Ctx(1, 1, rate);
  } catch {
    ctx = new Ctx(1, 1, 48000);
  }
  let audio;
  try {
    // decodeAudioData detaches the buffer: this is its last use, so no copy is made.
    audio = await ctx.decodeAudioData(buffer);
  } catch {
    if (VIDEO_EXTENSIONS.includes(ext)) throw new Error(`No audio could be read from "${label}". The video may have no audio track, or its audio codec is not supported by this browser (AAC, MP3, Opus and Vorbis are).`);
    throw new Error(`"${label}" could not be decoded. It may be damaged or in a format this browser does not support.`);
  }
  if (!audio.length) throw new Error(`"${label}" contains no audio.`);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  const format = isFlac ? 'flac' : ext === 'aif' || ext === 'aifc' ? 'aiff' : ext || 'audio';
  return { sampleRate: audio.sampleRate, channels, bitDepth, format, markers: [], meta };
}

function sniffFlac(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43;
}

function flacBits(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(26, buffer.byteLength));
  if (b.length < 26 || b[0] !== 0x66) return 16;
  return (((b[20] & 1) << 4) | (b[21] >> 4)) + 1;
}
