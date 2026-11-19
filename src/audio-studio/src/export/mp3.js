// MP3 writer: lamejs (LGPL-3.0, loaded on demand in the export worker) for
// the audio frames, plus an ID3v2.3 tag written here.

import { ByteSink } from './sink.js';
import { Quantizer } from '../audio/quantize.js';
import { id3v2Tag } from '../audio/meta.js';
import { id3ChapterFrames } from '../audio/chapters.js';

/** MPEG-1 Layer III rates, then MPEG-2 and MPEG-2.5. */
export const MP3_RATES = [32000, 44100, 48000, 16000, 22050, 24000, 8000, 11025, 12000];
export const MP3_BITRATES = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
/** MPEG-2/2.5 (rates below 32 kHz) top out at 160 kbps. */
export function mp3Bitrates(rate) {
  return rate >= 32000 ? MP3_BITRATES : MP3_BITRATES.filter((b) => b <= 160 && b >= 8);
}

export class Mp3Writer {
  constructor({ sampleRate, channels, dither = 'none', meta = {}, markers = [], frames = 0, settings = {} }) {
    this.rate = sampleRate;
    this.nch = Math.min(2, channels);
    const allowed = mp3Bitrates(sampleRate);
    const want = settings.bitrate ?? 192;
    this.kbps = allowed.reduce((best, b) => (Math.abs(b - want) < Math.abs(best - want) ? b : best), allowed[0]);
    this.quantizer = new Quantizer(16, this.nch, dither);
    this.sink = new ByteSink();
    // Markers travel as ID3 chapters (CHAP), which podcast players show.
    this.tag = id3v2Tag(meta, { padding: 256, extraFrames: id3ChapterFrames(markers, sampleRate, frames) });
    this.samples = 0;
    this.size = 1152 * 8;
    this.pcm = Array.from({ length: this.nch }, () => new Int16Array(this.size));
    this.tmp = new Int32Array(this.size);
  }

  async init() {
    const { Mp3Encoder } = await import('@breezystack/lamejs');
    this.encoder = new Mp3Encoder(this.nch, this.rate, this.kbps);
  }

  write(planar, n) {
    this.samples += n;
    for (let at = 0; at < n; at += this.size) {
      const take = Math.min(this.size, n - at);
      for (let c = 0; c < this.nch; c++) {
        this.quantizer.convert(c, planar[c].subarray(at, at + take), take, this.tmp, 0, 1);
        const dst = this.pcm[c];
        for (let i = 0; i < take; i++) dst[i] = this.tmp[i];
      }
      const left = this.pcm[0].subarray(0, take);
      const right = this.nch > 1 ? this.pcm[1].subarray(0, take) : left;
      const out = this.encoder.encodeBuffer(left, right);
      if (out.length) this.sink.push(new Uint8Array(out.buffer, out.byteOffset, out.length));
    }
  }

  finish() {
    const out = this.encoder.flush();
    if (out.length) this.sink.push(new Uint8Array(out.buffer, out.byteOffset, out.length));
    const chunks = this.sink.take();
    const audio = concat(chunks);
    const info = infoFrame(audio, this.samples);
    return new Blob([this.tag, info, audio].filter(Boolean), { type: 'audio/mpeg' });
  }
}

/** Parses an MPEG audio frame header at `o`; null when it is not one. */
export function parseMp3Header(b, o) {
  if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[o + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (b[o + 1] >> 1) & 3; // 1 = Layer III
  const brIdx = b[o + 2] >> 4;
  const srIdx = (b[o + 2] >> 2) & 3;
  const padding = (b[o + 2] >> 1) & 1;
  const mode = b[o + 3] >> 6;
  if (version === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const v1 = version === 3;
  const bitrates = v1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const rate = [44100, 48000, 32000][srIdx] / (v1 ? 1 : version === 2 ? 2 : 4);
  const bitrate = bitrates[brIdx];
  const samples = v1 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrate * 1000) / rate) + padding;
  return { version: v1 ? 1 : version === 2 ? 2 : 2.5, bitrate, sampleRate: rate, channels: mode === 3 ? 1 : 2, length, samples };
}

function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.byteLength;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c instanceof Uint8Array ? c : new Uint8Array(c), at);
    at += c.byteLength;
  }
  return out;
}

/** LAME's encoder delay in samples; decoders add their own 529-sample delay. */
export const ENCODER_DELAY = 576;

/**
 * Builds a silent "Info" frame (Xing header plus LAME extension) that records
 * the frame count, byte count and the encoder delay and padding, so decoders
 * trim the encoder's leading and trailing silence and the export keeps the
 * source's exact length. Returns null when `audio` holds no MPEG frames.
 */
export function infoFrame(audio, totalSamples) {
  const first = parseMp3Header(audio, 0);
  if (!first) return null;
  let frames = 0;
  for (let o = 0; o + 4 <= audio.length; ) {
    const hdr = parseMp3Header(audio, o);
    if (!hdr) break;
    frames++;
    o += hdr.length;
  }
  const v1 = first.version === 1;
  // A bitrate large enough to hold the tag (the Info frame may differ from the stream's).
  const brIdx = v1 ? 9 : 8; // 128 kbps (MPEG-1) or 64 kbps (MPEG-2/2.5)
  const header = [audio[0], audio[1] | 1, (brIdx << 4) | (audio[2] & 0x0c), audio[3]];
  const hdr = parseMp3Header(Uint8Array.from(header), 0);
  const frame = new Uint8Array(hdr.length);
  frame.set(header);
  const mono = first.channels === 1;
  const sideInfo = v1 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const t = 4 + sideInfo;
  const dv = new DataView(frame.buffer);
  const ascii = (o, str) => [...str].forEach((ch, i) => (frame[o + i] = ch.charCodeAt(0)));
  ascii(t, 'Info');
  dv.setUint32(t + 4, 0x0f);
  dv.setUint32(t + 8, frames); // audio frames, not counting this one
  dv.setUint32(t + 12, audio.length + frame.length);
  for (let i = 0; i < 100; i++) frame[t + 16 + i] = Math.round((i / 100) * 255);
  dv.setUint32(t + 116, 0);
  ascii(t + 120, 'LAME3.100');
  frame[t + 129] = 0x01; // tag revision 0, CBR
  const perFrame = first.samples;
  const padding = Math.max(0, Math.min(4095, frames * perFrame - ENCODER_DELAY - totalSamples));
  frame[t + 141] = ENCODER_DELAY >> 4;
  frame[t + 142] = ((ENCODER_DELAY & 0x0f) << 4) | (padding >> 8);
  frame[t + 143] = padding & 0xff;
  dv.setUint32(t + 148, audio.length + frame.length);
  return frame;
}
