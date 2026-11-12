import { describe, it, expect } from 'vitest';
import { encodeWav, parseWav } from '../src/audio/wav.js';
import { Channel } from '../src/audio/channel.js';
import { sniffSampleRate, decodeAudio, fixPositiveScale } from '../src/audio/decode.js';

const tone = (n) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.5);

describe('wav', () => {
  for (const bitDepth of [16, 24, 32]) {
    it(`round-trips ${bitDepth}-bit audio with markers`, async () => {
      const ch = [Channel.fromSamples(tone(1000)), Channel.fromSamples(tone(1000).map((v) => -v))];
      const blob = encodeWav({ sampleRate: 44100, channels: ch, bitDepth, dither: false, markers: [{ start: 100, duration: 0, name: 'Intro' }, { start: 300, duration: 50, name: 'Verse' }] });
      const r = parseWav(await blob.arrayBuffer());
      expect(r.sampleRate).toBe(44100);
      expect(r.channels.length).toBe(2);
      expect(r.channels[0].length).toBe(1000);
      const tol = bitDepth === 16 ? 1e-4 : 1e-6;
      expect(Math.abs(r.channels[1][123] - -tone(1000)[123])).toBeLessThan(tol);
      expect(r.markers.map((m) => [m.start, m.duration, m.name])).toEqual([
        [100, 0, 'Intro'],
        [300, 50, 'Verse'],
      ]);
    });
  }
  for (const bitDepth of [8, 16, 24]) {
    it(`writes ${bitDepth}-bit samples read from a file back unchanged`, async () => {
      const full = 2 ** (bitDepth - 1);
      // Every code near both ends of the range, plus a spread across it.
      const codes = [];
      for (let k = -full; k < -full + 40; k++) codes.push(k);
      for (let k = full - 40; k < full; k++) codes.push(k);
      for (let k = -full; k < full; k += Math.max(1, Math.floor(full / 500))) codes.push(k);
      const samples = Float32Array.from(codes, (k) => k / full);
      const blob = encodeWav({ sampleRate: 8000, channels: [samples], bitDepth, dither: false });
      const r = parseWav(await blob.arrayBuffer());
      expect(Array.from(r.channels[0], (v) => Math.round(v * full))).toEqual(codes);
      // Full scale and beyond clip to the top code instead of wrapping.
      const peaks = Float32Array.of(1, 1.5, -1.5);
      const loud = encodeWav({ sampleRate: 8000, channels: [peaks], bitDepth, dither: false });
      const back = parseWav(await loud.arrayBuffer()).channels[0];
      expect(Array.from(back, (v) => Math.round(v * full))).toEqual([full - 1, full - 1, -full]);
    });
  }
  it('keeps marker descriptions through a save and reopen', async () => {
    const markers = [
      { start: 10, duration: 0, name: 'Intro', description: 'Count-in, café take' },
      { start: 40, duration: 20, name: 'Verse', description: '' },
      { start: 80, duration: 0, name: 'Odd', description: 'abc' },
    ];
    const blob = encodeWav({
      sampleRate: 8000,
      channels: [tone(100)],
      bitDepth: 16,
      dither: false,
      markers,
    });
    const r = parseWav(await blob.arrayBuffer());
    expect(r.markers.map((m) => [m.start, m.duration, m.name, m.description])).toEqual(
      markers.map((m) => [m.start, m.duration, m.name, m.description]),
    );
  });
  it('opens the audio of a file whose cue list or labels are cut off or damaged', async () => {
    const blob = encodeWav({ sampleRate: 8000, channels: [tone(64)], bitDepth: 16, dither: false, markers: [{ start: 10, name: 'A' }, { start: 20, name: 'B' }] });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // A download cut off inside the cue chunk that follows the audio.
    const cut = parseWav(bytes.slice(0, 44 + 128 + 46).buffer);
    expect(cut.channels[0].length).toBe(64);
    expect(cut.markers.length).toBe(1);
    // A cue count larger than the chunk and a label whose size runs past the file.
    const bad = bytes.slice();
    const dv = new DataView(bad.buffer);
    dv.setUint32(44 + 128 + 8, 1000, true);
    const labl = bad.findIndex((_, i) => String.fromCharCode(...bad.subarray(i, i + 4)) === 'labl');
    dv.setUint32(labl + 4, 4000, true);
    const r = parseWav(bad.buffer);
    expect(r.channels[0].length).toBe(64);
    expect(r.markers.map((m) => m.start)).toEqual([10, 20]);
  });
  it('reads 20-bit samples stored in 3-byte containers', async () => {
    const blob = encodeWav({ sampleRate: 48000, channels: [Float32Array.of(0.5, -0.25, 0)], bitDepth: 24, dither: false });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    new DataView(bytes.buffer).setUint16(34, 20, true); // bits per sample: 20, block align stays 3
    const r = parseWav(bytes.buffer);
    expect(Array.from(r.channels[0])).toEqual([0.5, -0.25, 0]);
    expect(r.bitDepth).toBe(24);
  });
  it('recovers the audio of a recording whose data size was never written', async () => {
    const samples = tone(1000);
    const blob = encodeWav({ sampleRate: 44100, channels: [samples], bitDepth: 16, dither: false });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    new DataView(bytes.buffer).setUint32(40, 0, true);
    const r = parseWav(bytes.buffer);
    expect(r.channels[0].length).toBe(1000);
    expect(r.channels[0][123]).toBeCloseTo(samples[123], 4);
    // An empty data chunk followed by another chunk stays empty.
    const empty = encodeWav({ sampleRate: 44100, channels: [new Float32Array(0)], bitDepth: 16, markers: [{ start: 0, name: 'A' }] });
    expect(parseWav(await empty.arrayBuffer()).channels[0].length).toBe(0);
  });
  it('reads BW64 files like RF64', async () => {
    const blob = encodeWav({ sampleRate: 48000, channels: [Float32Array.of(0.5, -0.5)], bitDepth: 16, dither: false });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    bytes.set([0x42, 0x57, 0x36, 0x34]); // "BW64"
    expect(Array.from(parseWav(bytes.buffer).channels[0])).toEqual([0.5, -0.5]);
  });
  it('rejects non-WAV data', () => {
    expect(() => parseWav(new ArrayBuffer(64))).toThrow();
  });
  it('sniffs FLAC and MP3 sample rates', () => {
    const flac = new Uint8Array(42);
    flac.set([0x66, 0x4c, 0x61, 0x43]);
    // 44100 = 0xAC44 -> 20 bits at bytes 18..20
    flac[18] = 0x0a;
    flac[19] = 0xc4;
    flac[20] = 0x40;
    expect(sniffSampleRate(flac.buffer)).toBe(44100);
    const mp3 = new Uint8Array(16);
    mp3.set([0xff, 0xfb, 0x94, 0x00]); // MPEG1 layer III, 48 kHz index 1
    expect(sniffSampleRate(mp3.buffer)).toBe(48000);
  });
  it('opens a FLAC file behind an ID3v2 tag at its own rate and bit depth', async () => {
    // ID3v2 tag (300 bytes of frames), then fLaC + STREAMINFO: 44.1 kHz, 24-bit.
    const tag = 300;
    const bytes = new Uint8Array(10 + tag + 42 + 64);
    bytes.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, (tag >> 7) & 0x7f, tag & 0x7f]);
    const f = 10 + tag;
    bytes.set([0x66, 0x4c, 0x61, 0x43], f);
    bytes[f + 18] = 0x0a;
    bytes[f + 19] = 0xc4;
    bytes[f + 20] = 0x40 | (1 << 1) | 1; // channels - 1 = 1, top bit of (bits - 1) = 1
    bytes[f + 21] = 0x70; // low 4 bits of (bits - 1) = 7 -> 24-bit
    expect(sniffSampleRate(bytes.buffer)).toBe(44100);
    let rate = 0;
    const prev = globalThis.OfflineAudioContext;
    globalThis.OfflineAudioContext = class {
      constructor(c, n, r) {
        rate = r;
      }
      async decodeAudioData() {
        const data = new Float32Array(4);
        return { sampleRate: rate, length: 4, numberOfChannels: 1, getChannelData: () => data };
      }
    };
    try {
      const r = await decodeAudio(bytes.buffer.slice(0), 'Song.flac');
      expect(r.sampleRate).toBe(44100);
      expect(r.bitDepth).toBe(24);
      expect(r.format).toBe('flac');
    } finally {
      globalThis.OfflineAudioContext = prev;
    }
  });
  it('puts 16-bit FLAC samples a browser divided by 32767 back on the 1/32768 grid', async () => {
    const codes = [];
    for (let k = -32768; k < 32768; k += 7) codes.push(k);
    codes.push(32767, 1, -1, 0);
    // Chromium's decoder: positives / 32767, negatives / 32768.
    const chromium = Float32Array.from(codes, (k) => (k > 0 ? k / 32767 : k / 32768));
    expect(fixPositiveScale([chromium])).toBe(true);
    expect(Array.from(chromium, (v) => v * 32768)).toEqual(codes);
    // A decoder that already divides by 32768 is left alone, as is anything off both grids.
    const exact = Float32Array.from(codes, (k) => k / 32768);
    expect(fixPositiveScale([exact])).toBe(false);
    expect(Array.from(exact, (v) => v * 32768)).toEqual(codes);
    const lossy = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 3) * 0.7);
    const copy = lossy.slice();
    expect(fixPositiveScale([lossy])).toBe(false);
    expect(lossy).toEqual(copy);
  });
  it('sniffs the rate of MP3s behind large cover art and of M4As with the movie box at the end', () => {
    // A 2 MB ID3v2 tag (embedded artwork), then a 44.1 kHz MPEG-1 Layer III frame.
    const tag = 2 << 20;
    const mp3 = new Uint8Array(10 + tag + 16);
    mp3.set([0x49, 0x44, 0x33, 3, 0, 0, (tag >> 21) & 0x7f, (tag >> 14) & 0x7f, (tag >> 7) & 0x7f, tag & 0x7f]);
    mp3.set([0xff, 0xfb, 0x90, 0x00], 10 + tag);
    expect(sniffSampleRate(mp3.buffer)).toBe(44100);
    // ftyp, a 2 MB mdat, then moov holding a 44.1 kHz mp4a sample entry.
    const box = (type, size) => {
      const b = new Uint8Array(size);
      new DataView(b.buffer).setUint32(0, size);
      b.set([...type].map((c) => c.charCodeAt(0)), 4);
      return b;
    };
    const moov = box('moov', 80);
    moov.set([0x6d, 0x70, 0x34, 0x61], 20);
    new DataView(moov.buffer).setUint16(20 + 28, 44100);
    const parts = [box('ftyp', 24), box('mdat', 2 << 20), moov];
    const m4a = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (m4a.set(p, at), at + p.length), 0);
    expect(sniffSampleRate(m4a.buffer)).toBe(44100);
  });
});
