// Minimal MPEG-4 audio (M4A) muxer for AAC packets from WebCodecs: ftyp,
// moov (one sound track, all samples in one chunk, iTunes-style metadata)
// placed before mdat so files start playing while they download.

import { ascii, concatBytes } from './sink.js';
import { cleanMeta } from '../audio/meta.js';

function u32(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}
function u16(v) {
  return Uint8Array.of((v >> 8) & 255, v & 255);
}

export function box(type, ...payload) {
  const body = concatBytes(payload.flat().map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p))));
  return concatBytes([u32(8 + body.length), ascii(type), body]);
}

function fullBox(type, version, flags, ...payload) {
  return box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);
}

const MATRIX = concatBytes([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

/** MPEG-4 descriptor with a 4-byte length (accepted by every parser). */
function descriptor(tag, body) {
  const n = body.length;
  return concatBytes([Uint8Array.of(tag, 0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f), body]);
}

function esds(asc, bitrate, maxSize) {
  const decSpecific = descriptor(0x05, asc);
  const decConfig = descriptor(0x04, concatBytes([Uint8Array.of(0x40, 0x15), Uint8Array.of((maxSize >> 16) & 255, (maxSize >> 8) & 255, maxSize & 255), u32(bitrate), u32(bitrate), decSpecific]));
  const sl = descriptor(0x06, Uint8Array.of(0x02));
  const es = descriptor(0x03, concatBytes([u16(1), Uint8Array.of(0), decConfig, sl]));
  return fullBox('esds', 0, 0, es);
}

/** AudioSpecificConfig for AAC-LC when the encoder does not supply one. */
export function aacAudioSpecificConfig(sampleRate, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const idx = rates.indexOf(sampleRate);
  if (idx < 0) return Uint8Array.of(0x12, 0x10);
  return Uint8Array.of((2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3));
}

const ILST_KEYS = {
  title: '\xa9nam',
  artist: '\xa9ART',
  album: '\xa9alb',
  year: '\xa9day',
  genre: '\xa9gen',
  comment: '\xa9cmt',
  albumArtist: 'aART',
  composer: '\xa9wrt',
  copyright: 'cprt',
};

/**
 * iTunes gapless info ("iTunSMPB"): priming, padding and real length. Apple
 * decoders trim with it rather than the edit list, which alone leaves the
 * encoder's padding audible as silence at the end.
 */
function itunSmpb({ priming, padding, frames }, enc) {
  const hex = (v, n) => Math.max(0, Math.round(v)).toString(16).toUpperCase().padStart(n, '0');
  const text = ` 00000000 ${hex(priming, 8)} ${hex(padding, 8)} ${hex(frames, 16)}${' 00000000'.repeat(8)}`;
  return box('----', fullBox('mean', 0, 0, ascii('com.apple.iTunes')), fullBox('name', 0, 0, ascii('iTunSMPB')), box('data', u32(1), u32(0), enc.encode(text)));
}

function ilst(meta, gapless) {
  const m = cleanMeta(meta);
  const enc = new TextEncoder();
  const items = Object.entries(ILST_KEYS)
    .filter(([id]) => m[id])
    .map(([id, key]) => box(key, box('data', u32(1), u32(0), enc.encode(m[id]))));
  // Track number ("3" or "3/12") and tempo are binary atoms; the key has no
  // atom of its own and goes in the freeform "initialkey" item taggers use.
  const track = /^\s*(\d+)\s*(?:\/\s*(\d+))?/.exec(m.track || '');
  const u16n = (v) => u16(Math.min(65535, Number(v) || 0));
  if (track) {
    const value = [u16(0), u16n(track[1]), u16n(track[2]), u16(0)];
    items.push(box('trkn', box('data', u32(0), u32(0), ...value)));
  }
  if (/^\d+$/.test(m.bpm || '')) items.push(box('tmpo', box('data', u32(21), u32(0), u16n(m.bpm))));
  if (m.key) {
    const mean = fullBox('mean', 0, 0, ascii('com.apple.iTunes'));
    const name = fullBox('name', 0, 0, ascii('initialkey'));
    items.push(box('----', mean, name, box('data', u32(1), u32(0), enc.encode(m.key))));
  }
  if (gapless && (gapless.priming || gapless.padding)) items.push(itunSmpb(gapless, enc));
  if (!items.length) return null;
  const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('mdir'), ascii('appl'), u32(0), u32(0), Uint8Array.of(0));
  return box('udta', fullBox('meta', 0, 0, hdlr, box('ilst', ...items)));
}

/**
 * @param {{ sampleRate, channels, asc?: Uint8Array, packets: Uint8Array[], frameSamples?: number, totalFrames, bitrate, meta }} o
 * @returns {Uint8Array[]} file parts
 */
export function muxM4a({ sampleRate, channels, asc, packets, frameSamples = 1024, totalFrames, priming = 0, bitrate = 192000, meta = {} }) {
  const config = asc && asc.length ? asc : aacAudioSpecificConfig(sampleRate, channels);
  // Media time covers every packet; the edit list presents only the real
  // audio, skipping the encoder's priming samples at the start.
  const mediaDuration = packets.length * frameSamples;
  const duration = totalFrames ?? Math.max(0, mediaDuration - priming);
  const sizes = packets.map((p) => p.length);
  const maxSize = sizes.reduce((m, s) => Math.max(m, s), 0);
  const ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('M4A '), ascii('mp42'), ascii('isom'));
  const build = (chunkOffset) => {
    const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(duration), u32(0x00010000), u16(0x0100), new Uint8Array(10), MATRIX, new Uint8Array(24), u32(2));
    const tkhd = fullBox('tkhd', 0, 7, u32(0), u32(0), u32(1), u32(0), u32(duration), new Uint8Array(8), u16(0), u16(0), u16(0x0100), u16(0), MATRIX, u32(0), u32(0));
    const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(sampleRate), u32(mediaDuration), u16(0x55c4), u16(0));
    const edts = box('edts', fullBox('elst', 0, 0, u32(1), u32(duration), u32(priming), u32(0x00010000)));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('soun'), new Uint8Array(12), ascii('SoundHandler'), Uint8Array.of(0));
    const smhd = fullBox('smhd', 0, 0, u16(0), u16(0));
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const mp4a = box('mp4a', new Uint8Array(6), u16(1), new Uint8Array(8), u16(channels), u16(16), u16(0), u16(0), u32(Math.min(65535, sampleRate) * 65536), esds(config, bitrate, maxSize));
    const stsd = fullBox('stsd', 0, 0, u32(1), mp4a);
    const stts = fullBox('stts', 0, 0, u32(1), u32(packets.length), u32(frameSamples));
    const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(packets.length), u32(1));
    const stsz = fullBox('stsz', 0, 0, u32(0), u32(packets.length), ...sizes.map(u32));
    const stco = fullBox('stco', 0, 0, u32(1), u32(chunkOffset));
    const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
    const minf = box('minf', smhd, dinf, stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const trak = box('trak', tkhd, edts, mdia);
    const udta = ilst(meta, { priming, padding: mediaDuration - priming - duration, frames: duration });
    return box('moov', mvhd, trak, ...(udta ? [udta] : []));
  };
  const moovSize = build(0).length;
  const moov = build(ftyp.length + moovSize + 8);
  const dataSize = sizes.reduce((s, v) => s + v, 0);
  const mdatHead = concatBytes([u32(8 + dataSize), ascii('mdat')]);
  return [ftyp, moov, mdatHead, ...packets];
}
