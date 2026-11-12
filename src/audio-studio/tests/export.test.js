import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runExport, mapChannels } from '../src/export/pipeline.js';
import { parseWav } from '../src/audio/wav.js';
import { parseAiff, readExtended, writeExtended } from '../src/audio/aiff.js';
import { parseMp3Header } from '../src/export/mp3.js';
import { muxOggOpus, oggCrc } from '../src/export/ogg.js';
import { muxM4a } from '../src/export/mp4.js';
import { readTags, parseVorbisComment } from '../src/audio/meta.js';
import { Quantizer } from '../src/audio/quantize.js';
import { conformOptions } from '../src/export/formats.js';
import { crc8Flac, crc16Flac } from './helpers/flac-crc.js';

let dsp;
beforeAll(() => {
  const bytes = fs.readFileSync(path.resolve(__dirname, '../src/audio/dsp.wasm'));
  dsp = { x: new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports };
});

const tone = (n, f = 440, rate = 44100, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / rate) * amp);
const meta = { title: 'Song', artist: 'Band', album: 'Album', year: '2026', genre: 'Rock', comment: 'Notes' };

async function exportFrom(channels, rate, options, extra = {}) {
  const blob = await runExport({
    options: { dither: 'none', settings: {}, ...options },
    sourceRate: rate,
    frames: channels[0].length,
    read: (at, n) => channels.map((c) => c.subarray(at, at + n)),
    dsp,
    meta,
    ...extra,
  });
  return new Uint8Array(await blob.arrayBuffer());
}

describe('WAV export', () => {
  for (const bitDepth of [8, 16, 24, 32]) {
    it(`round-trips ${bitDepth}-bit stereo with markers and RIFF INFO`, async () => {
      const L = tone(70001);
      const R = tone(70001, 1000);
      const bytes = await exportFrom([L, R], 44100, { format: 'wav', sampleRate: 44100, channels: 2, bitDepth }, { markers: [{ start: 10, duration: 0, name: 'A' }, { start: 500, duration: 100, name: 'B' }] });
      const r = parseWav(bytes.buffer);
      expect(r.sampleRate).toBe(44100);
      expect(r.bitDepth).toBe(bitDepth);
      expect(r.channels[1].length).toBe(70001);
      const tol = bitDepth === 8 ? 1 / 100 : bitDepth === 16 ? 1 / 30000 : 1e-6;
      for (const i of [0, 1, 777, 70000]) expect(Math.abs(r.channels[1][i] - R[i])).toBeLessThanOrEqual(tol);
      expect(r.markers.map((m) => [m.start, m.duration, m.name])).toEqual([
        [10, 0, 'A'],
        [500, 100, 'B'],
      ]);
      expect(r.meta).toEqual(meta);
    });
  }

  it('writes WAVE_FORMAT_EXTENSIBLE for more than two channels', async () => {
    const chans = [0, 1, 2, 3, 4, 5].map((c) => tone(1000, 100 * (c + 1)));
    const bytes = await exportFrom(chans, 48000, { format: 'wav', sampleRate: 48000, channels: 6, bitDepth: 24 });
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint16(20, true)).toBe(0xfffe);
    const r = parseWav(bytes.buffer);
    expect(r.channels.length).toBe(6);
    expect(Math.abs(r.channels[5][123] - chans[5][123])).toBeLessThan(1e-6);
  });

  it('saves every channel of a multitrack recorder file with more than eight', async () => {
    const chans = Array.from({ length: 10 }, (_, c) => tone(500, 100 * (c + 1)));
    const options = conformOptions('wav', { format: 'wav', sampleRate: 48000, channels: 10, bitDepth: 24 });
    expect(options.options.channels).toBe(10);
    expect(options.notes).toEqual([]);
    const bytes = await exportFrom(chans, 48000, options.options);
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint32(40, true)).toBe(0); // no speaker positions claimed
    const r = parseWav(bytes.buffer);
    expect(r.channels.length).toBe(10);
    expect(Math.abs(r.channels[9][123] - chans[9][123])).toBeLessThan(1e-6);
    const ten = { channels: 10, sampleRate: 48000, bitDepth: 16 };
    const aiff = await exportFrom(chans, 48000, conformOptions('aiff', ten).options);
    expect(parseAiff(aiff.buffer).channels.length).toBe(10);
    // FLAC holds at most eight.
    expect(conformOptions('flac', ten).options.channels).toBe(8);
  });

  it('keeps iXML, axml, inst and smpl chunks of an opened file while they still hold', async () => {
    const enc = new TextEncoder();
    // An odd length, so the chunk is padded.
    const ixml = enc.encode('<BWFXML><SCENE>12A</SCENE><TAKE>3</TAKE></BWFXML>');
    const smpl = new Uint8Array(36 + 24).fill(1);
    const list = [
      { id: 'iXML', bytes: ixml },
      { id: 'axml', bytes: enc.encode('<ebuCoreMain/>') },
      { id: 'inst', bytes: Uint8Array.of(60, 0, 0, 0, 127, 0, 127) },
      { id: 'smpl', bytes: smpl },
    ];
    const src = [tone(1000), tone(1000, 300)];
    const chunks = { sampleRate: 44100, channels: 2, frames: 1000, list };
    const save = async (channels, options, frames = 1000) => {
      const opts = { format: 'wav', bitDepth: 24, ...options };
      const out = await exportFrom(channels, 44100, opts, { chunks, markers: [] });
      expect(out.length % 2).toBe(0);
      const r = parseWav(out.buffer);
      expect(r.channels[0].length).toBe(frames);
      return r.chunks.map((c) => [c.id, c.bytes.length]);
    };
    const all = list.map((c) => [c.id, c.bytes.length]);
    // An untouched sample type keeps them all, byte for byte.
    expect(await save(src, { sampleRate: 44100, channels: 2 })).toEqual(all);
    const same = { format: 'wav', sampleRate: 44100, channels: 2, bitDepth: 16 };
    const kept = parseWav((await exportFrom(src, 44100, same, { chunks })).buffer).chunks;
    expect(Array.from(kept[0].bytes)).toEqual(Array.from(ixml));
    // A changed length drops the loop points; a mono mixdown drops the track descriptions.
    const shorter = await save([tone(900), tone(900)], { sampleRate: 44100, channels: 2 }, 900);
    expect(shorter).toEqual(all.filter(([id]) => id !== 'smpl'));
    const mono = await save(src, { sampleRate: 44100, channels: 1 });
    expect(mono).toEqual([
      ['inst', 7],
      ['smpl', 60],
    ]);
    // Rate conversion keeps only the instrument data; "no metadata" keeps nothing.
    expect(await save(src, { sampleRate: 48000, channels: 2 }, 1088)).toEqual([['inst', 7]]);
    expect(await save(src, { sampleRate: 44100, channels: 2, meta: false })).toEqual([]);
  });

  it('16-bit integer values survive without dither exactly', async () => {
    const x = Float32Array.from({ length: 1000 }, (_, i) => ((i * 37) % 65536 - 32768) / 32768);
    const r = parseWav((await exportFrom([x], 8000, { format: 'wav', sampleRate: 8000, channels: 1, bitDepth: 16 })).buffer);
    for (let i = 0; i < 1000; i++) expect(r.channels[0][i]).toBe(x[i]);
  });
});

describe('AIFF export', () => {
  for (const bitDepth of [8, 16, 24, 32]) {
    it(`round-trips ${bitDepth}-bit audio, markers and text chunks`, async () => {
      const L = tone(9999);
      const bytes = await exportFrom([L, L.map((v) => -v)], 22050, { format: 'aiff', sampleRate: 22050, channels: 2, bitDepth }, { markers: [{ start: 42, duration: 0, name: 'Cue' }] });
      const head = String.fromCharCode(...bytes.subarray(8, 12));
      expect(head).toBe(bitDepth === 32 ? 'AIFC' : 'AIFF');
      const r = parseAiff(bytes.buffer);
      expect(r.sampleRate).toBe(22050);
      expect(r.channels[0].length).toBe(9999);
      const tol = bitDepth === 8 ? 1 / 100 : bitDepth === 16 ? 1 / 30000 : 1e-6;
      expect(Math.abs(r.channels[1][4321] - -L[4321])).toBeLessThanOrEqual(tol);
      expect(r.markers.map((m) => [m.start, m.name])).toEqual([[42, 'Cue']]);
      expect(r.meta).toEqual(meta);
    });
  }

  it('reads NaN and infinite 32-bit float samples as silence', async () => {
    const src = Float32Array.of(0.5, NaN, Infinity, -Infinity, -0.25);
    const bytes = await exportFrom([src], 48000, { format: 'aiff', sampleRate: 48000, channels: 1, bitDepth: 32 });
    expect(Array.from(parseAiff(bytes.buffer).channels[0])).toEqual([0.5, 0, 0, 0, -0.25]);
  });

  it('rejects damaged channel counts and sample sizes but opens cut-off files', async () => {
    const src = tone(1000);
    const bytes = await exportFrom([src, src], 44100, { format: 'aiff', sampleRate: 44100, channels: 2, bitDepth: 16 });
    const comm = findBox(bytes, 'COMM') + 12; // findBox returns the offset 4 bytes before the id
    const dv = new DataView(bytes.buffer);
    expect(dv.getInt16(comm)).toBe(2);
    const bad = bytes.slice();
    new DataView(bad.buffer).setInt16(comm, 227);
    expect(() => parseAiff(bad.buffer)).toThrow('The AIFF file header is damaged.');
    const bits = bytes.slice();
    new DataView(bits.buffer).setInt16(comm + 6, 1000);
    expect(() => parseAiff(bits.buffer)).toThrow('The AIFF file header is damaged.');
    expect(parseAiff(bytes.slice(0, bytes.length - 1000).buffer).channels[1].length).toBeLessThan(1000);
  });

  it('encodes 80-bit extended sample rates exactly', () => {
    const dv = new DataView(new ArrayBuffer(10));
    for (const rate of [8000, 11025, 22050, 44100, 48000, 96000, 192000, 384000, 7]) {
      writeExtended(dv, 0, rate);
      expect(readExtended(dv, 0)).toBe(rate);
    }
  });
});

describe('FLAC export', () => {
  it('produces a valid stream header, Vorbis comments and CRC-checked frames', async () => {
    const L = tone(10000);
    const bytes = await exportFrom([L, tone(10000, 660)], 44100, { format: 'flac', sampleRate: 44100, channels: 2, bitDepth: 16, settings: { level: 5 } });
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('fLaC');
    // STREAMINFO
    expect(bytes[4] & 0x7f).toBe(0);
    const si = bytes.subarray(8, 42);
    const rate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
    const channels = ((si[12] >> 1) & 7) + 1;
    const bps = (((si[12] & 1) << 4) | (si[13] >> 4)) + 1;
    const total = (si[13] & 15) * 2 ** 32 + ((si[14] << 24) | (si[15] << 16) | (si[16] << 8) | si[17]) >>> 0;
    expect([rate, channels, bps, total]).toEqual([44100, 2, 16, 10000]);
    expect(readTags(bytes.buffer)).toEqual(meta);
    // Walk metadata blocks to the first frame.
    let o = 4;
    for (;;) {
      const last = bytes[o] & 0x80;
      o += 4 + ((bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]);
      if (last) break;
    }
    expect(bytes[o]).toBe(0xff);
    expect(bytes[o + 1] & 0xfe).toBe(0xf8);
    // Header CRC-8 covers sync to the frame number (one byte for frame 0) and block size/rate codes.
    expect(crc8Flac(bytes.subarray(o, o + 5))).toBe(bytes[o + 5]);
    // The last two bytes of the file are the CRC-16 of the last frame; find its start by sync search.
    let lastFrame = bytes.length - 3;
    while (lastFrame > o && !(bytes[lastFrame] === 0xff && (bytes[lastFrame + 1] & 0xfe) === 0xf8 && crc8Flac(bytes.subarray(lastFrame, lastFrame + 7)) === bytes[lastFrame + 7])) lastFrame--;
    const crc = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
    expect(crc16Flac(bytes.subarray(lastFrame, bytes.length - 2))).toBe(crc);
    expect(bytes.length).toBeLessThan(10000 * 4 * 0.75);
  });

  it('converts 32-bit float requests to 24-bit', async () => {
    const bytes = await exportFrom([tone(5000)], 48000, { format: 'flac', sampleRate: 48000, channels: 1, bitDepth: 32 });
    const si = bytes.subarray(8, 42);
    expect((((si[12] & 1) << 4) | (si[13] >> 4)) + 1).toBe(24);
  });
});

describe('MP3 export', () => {
  it('writes an ID3v2 tag and a chain of valid MPEG-1 Layer III frames', async () => {
    const L = tone(44100);
    const bytes = await exportFrom([L, L], 44100, { format: 'mp3', sampleRate: 44100, channels: 2, settings: { bitrate: 128 } });
    expect(String.fromCharCode(...bytes.subarray(0, 3))).toBe('ID3');
    expect(readTags(bytes.buffer)).toEqual(meta);
    const tagSize = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
    let o = tagSize;
    let frames = 0;
    while (o + 4 < bytes.length) {
      const h = parseMp3Header(bytes, o);
      expect(h).not.toBeNull();
      expect(h.sampleRate).toBe(44100);
      expect(h.bitrate).toBe(128);
      expect(h.version).toBe(1);
      o += h.length;
      frames++;
    }
    expect(o).toBe(bytes.length);
    // One second plus encoder delay and padding.
    expect(frames).toBeGreaterThanOrEqual(39);
    expect(frames).toBeLessThan(44);
  });

  it('reads an ID3v1 tag at the end when the file has no ID3v2 tag, and fills gaps with it', async () => {
    const opts = { format: 'mp3', sampleRate: 44100, channels: 1 };
    const mp3 = await exportFrom([tone(4000)], 44100, opts, { meta: {} });
    const v1 = new Uint8Array(128);
    const put = (at, text) => v1.set(new TextEncoder().encode(text), at);
    put(0, 'TAG');
    put(3, 'Old Title');
    put(33, 'Old Artist   ');
    put(63, 'Album');
    put(93, '1999');
    put(97, 'Caf');
    v1[100] = 0xe9; // é in ISO-8859-1
    v1[126] = 7; // ID3v1.1 track number
    v1[127] = 255;
    const file = new Uint8Array(mp3.length + 128);
    file.set(mp3);
    file.set(v1, mp3.length);
    const old = { title: 'Old Title', artist: 'Old Artist', album: 'Album', year: '1999' };
    expect(readTags(file.buffer)).toEqual({ ...old, comment: 'Café', track: '7' });
    // Behind an ID3v2 tag the v2 fields win.
    const tagged = await exportFrom([tone(4000)], 44100, opts, { meta: { title: 'New' } });
    const both = new Uint8Array(tagged.length + 128);
    both.set(tagged);
    both.set(v1, tagged.length);
    expect(readTags(both.buffer)).toMatchObject({ title: 'New', artist: 'Old Artist', track: '7' });
  });

  it('picks MPEG-2 frames for low sample rates and mono', async () => {
    const bytes = await exportFrom([tone(22050, 300, 22050)], 22050, { format: 'mp3', sampleRate: 22050, channels: 1, settings: { bitrate: 64 } }, { meta: {} });
    const h = parseMp3Header(bytes, 0);
    expect(h).toMatchObject({ version: 2, sampleRate: 22050, bitrate: 64, channels: 1 });
  });
});

describe('sample rate and channel conversion', () => {
  it('resamples 44.1 kHz to 48 kHz with the exact frame count', async () => {
    const n = 44100;
    const bytes = await exportFrom([tone(n, 1000)], 44100, { format: 'wav', sampleRate: 48000, channels: 1, bitDepth: 32 });
    const r = parseWav(bytes.buffer);
    expect(r.sampleRate).toBe(48000);
    expect(r.channels[0].length).toBe(48000);
    for (const j of [1000, 20000, 46000]) expect(Math.abs(r.channels[0][j] - Math.sin((2 * Math.PI * 1000 * j) / 48000) * 0.5)).toBeLessThan(0.01);
  });

  it('downmixes to mono by averaging and duplicates mono to stereo', () => {
    const [m] = mapChannels([Float32Array.of(1, 0.5), Float32Array.of(0, 0.5)], 1);
    expect([...m]).toEqual([0.5, 0.5]);
    const st = mapChannels([Float32Array.of(0.25)], 2);
    expect(st.length).toBe(2);
    expect(st[1][0]).toBe(0.25);
    expect(mapChannels([Float32Array.of(1), Float32Array.of(2), Float32Array.of(3)], 2).map((c) => c[0])).toEqual([1, 2]);
  });

  it('applies dither within one LSB and noise shaping keeps the mean', () => {
    const q = new Quantizer(16, 1, 'triangular');
    const src = new Float32Array(10000).fill(0.1);
    const out = new Int32Array(10000);
    q.convert(0, src, src.length, out);
    const ideal = 0.1 * 32768;
    let sum = 0;
    for (const v of out) {
      expect(Math.abs(v - ideal)).toBeLessThanOrEqual(1.5);
      sum += v;
    }
    expect(Math.abs(sum / out.length - ideal)).toBeLessThan(0.05);
    const s = new Quantizer(16, 1, 'shaped');
    s.convert(0, src, src.length, out);
    sum = 0;
    for (const v of out) sum += v;
    expect(Math.abs(sum / out.length - ideal)).toBeLessThan(0.05);
    // Samples already on the 16-bit grid pass through dither untouched.
    const grid = Float32Array.from({ length: 500 }, (_, i) => ((i * 131) % 65536 - 32768) / 32768);
    const g = new Int32Array(500);
    new Quantizer(16, 1, 'triangular').convert(0, grid, 500, g);
    for (let i = 0; i < 500; i++) expect(g[i]).toBe(Math.round(grid[i] * 32768));
    const clip = new Quantizer(8, 1, 'none');
    const o8 = new Int32Array(3);
    clip.convert(0, Float32Array.of(2, -2, NaN), 3, o8);
    expect([...o8]).toEqual([127, -128, 0]);
  });
});

describe('Ogg Opus muxer', () => {
  it('writes CRC-valid pages with OpusHead, OpusTags and end trimming', () => {
    const packets = Array.from({ length: 120 }, (_, i) => ({ data: new Uint8Array(100 + (i % 7)).fill(i), samples: 960 }));
    const pages = muxOggOpus({ channels: 2, preSkip: 312, inputRate: 44100, packets, totalSamples: 114000, meta });
    let seq = 0;
    for (const p of pages) {
      expect(String.fromCharCode(...p.subarray(0, 4))).toBe('OggS');
      const dv = new DataView(p.buffer, p.byteOffset);
      const crc = dv.getUint32(22, true);
      const copy = p.slice();
      new DataView(copy.buffer).setUint32(22, 0, true);
      expect(oggCrc(copy)).toBe(crc);
      expect(dv.getUint32(18, true)).toBe(seq++);
    }
    expect(pages[0][5]).toBe(0x02);
    expect(String.fromCharCode(...pages[0].subarray(28, 36))).toBe('OpusHead');
    const last = pages[pages.length - 1];
    expect(last[5] & 0x04).toBe(4);
    expect(Number(new DataView(last.buffer, last.byteOffset).getBigInt64(6, true))).toBe(312 + 114000);
    const file = new Uint8Array(pages.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of pages) {
      file.set(p, o);
      o += p.length;
    }
    expect(readTags(file.buffer)).toEqual(meta);
    // Every packet's bytes are present in order.
    let total = 0;
    for (const p of pages.slice(2)) total += p.subarray(27 + p[26]).length;
    expect(total).toBe(packets.reduce((s, p) => s + p.data.length, 0));
  });
});

describe('M4A muxer', () => {
  it('writes consistent boxes, a sample table and iTunes metadata', () => {
    const packets = Array.from({ length: 50 }, (_, i) => new Uint8Array(200 + i).fill(i));
    const parts = muxM4a({ sampleRate: 48000, channels: 2, packets, totalFrames: 50 * 1024 - 300, bitrate: 128000, meta });
    const file = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      file.set(p, o);
      o += p.length;
    }
    const dv = new DataView(file.buffer);
    const boxes = [];
    for (let p = 0; p < file.length; ) {
      const size = dv.getUint32(p);
      boxes.push([String.fromCharCode(...file.subarray(p + 4, p + 8)), p, size]);
      p += size;
    }
    expect(boxes.map((b) => b[0])).toEqual(['ftyp', 'moov', 'mdat']);
    const mdat = boxes[2];
    expect(mdat[2]).toBe(8 + packets.reduce((s, p) => s + p.length, 0));
    // stco points at the first packet.
    const at = findBox(file, 'stco');
    expect(dv.getUint32(at + 16)).toBe(mdat[1] + 8);
    const stsz = findBox(file, 'stsz');
    expect(dv.getUint32(stsz + 16)).toBe(50);
    expect(dv.getUint32(stsz + 20)).toBe(200);
    expect(readTags(file.buffer)).toEqual(meta);
    // Files written with the movie box after a long media box keep their tags too.
    const [ftyp, moov] = parts;
    const late = new Uint8Array(ftyp.length + 8 + (6 << 20) + moov.length);
    late.set(ftyp);
    new DataView(late.buffer).setUint32(ftyp.length, 8 + (6 << 20));
    late.set([0x6d, 0x64, 0x61, 0x74], ftyp.length + 4);
    late.set(moov, late.length - moov.length);
    expect(readTags(late.buffer)).toEqual(meta);
  });

  it('keeps the album artist, composer, copyright, track, tempo and key', () => {
    const more = { ...meta, albumArtist: 'Various', composer: 'Écrivain', copyright: '2026 Label' };
    Object.assign(more, { track: '3/12', bpm: '128', key: 'F#m' });
    const tagsOf = (m) => {
      const o = { sampleRate: 48000, channels: 2, totalFrames: 1000, priming: 2112, bitrate: 128000 };
      const parts = muxM4a({ ...o, packets: [new Uint8Array(10)], meta: m });
      const file = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      parts.reduce((at, p) => (file.set(p, at), at + p.length), 0);
      return readTags(file.buffer);
    };
    expect(tagsOf(more)).toEqual(more);
    expect(tagsOf({ track: '7' })).toEqual({ track: '7' });
  });

  it('records priming, padding and length as iTunSMPB so Apple players trim the padding', () => {
    const packets = Array.from({ length: 74 }, () => new Uint8Array(100));
    const parts = muxM4a({ sampleRate: 48000, channels: 2, packets, totalFrames: 72000, priming: 2112, bitrate: 128000, meta: {} });
    const file = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    parts.reduce((at, p) => (file.set(p, at), at + p.length), 0);
    const text = new TextDecoder('latin1').decode(file);
    expect(text).toContain('iTunSMPB');
    // 2112 priming, 74 * 1024 - 2112 - 72000 = 1664 padding, 72000 frames.
    expect(text).toContain(' 00000000 00000840 00000680 0000000000011940 00000000');
    expect(readTags(file.buffer)).toEqual({});
  });
});

function findBox(bytes, type) {
  for (let i = 0; i + 8 < bytes.length; i++) if (String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]) === type) return i;
  return -1;
}

describe('metadata readers', () => {
  it('parses Vorbis comments with DESCRIPTION and long dates', () => {
    const enc = new TextEncoder();
    const items = ['TITLE=a', 'DESCRIPTION=d', 'DATE=2020-05-01'].map((s) => enc.encode(s));
    const parts = [4, 0, 0, 0, 0x41, 0x42, 0x43, 0x44, 3, 0, 0, 0];
    for (const it of items) parts.push(it.length, 0, 0, 0, ...it);
    expect(parseVorbisComment(Uint8Array.from(parts))).toEqual({ title: 'a', comment: 'd', year: '2020' });
  });
});
