import { describe, it, expect } from 'vitest';
import { encodeWav, readWavHeader, decodeWavSamples, sniffAudio, audioExtension, isAudioName } from '../src/io/wav.js';
import { readMidi, writeMidi, isMidi } from '../src/io/midi.js';
import { importMidi, projectToMidi, drumKindForNote, presetForProgram } from '../src/io/midi-project.js';
import { zipBytes, unzipStore, crc32 } from '../src/io/zip.js';
import { safeFileName } from '../src/io/download.js';
import { createProject, createChannel, createNote, createPattern } from '../src/model/project.js';
import { demoProject } from '../src/model/demo.js';
import { PPQ } from '../src/model/time.js';

const bytes = (buf, from, n) => [...new Uint8Array(buf, from, n)];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const le16 = (v) => [v & 255, (v >> 8) & 255];

describe('wav writer', () => {
  it('writes an exact 16-bit PCM header', () => {
    const buf = encodeWav({ channels: [new Float32Array(3), new Float32Array(3)], rate: 44100 }, { bits: 16, dither: false });
    expect(buf.byteLength).toBe(44 + 12);
    expect(bytes(buf, 0, 44)).toEqual([
      ...ascii('RIFF'), ...le32(36 + 12), ...ascii('WAVE'),
      ...ascii('fmt '), ...le32(16), ...le16(1), ...le16(2), ...le32(44100), ...le32(44100 * 4), ...le16(4), ...le16(16),
      ...ascii('data'), ...le32(12),
    ]);
  });

  it('quantizes 16-bit samples, interleaved, with clipping', () => {
    const l = Float32Array.from([0, 1, -1, 2]);
    const r = Float32Array.from([0.5, -0.5, 0.25, -2]);
    const buf = encodeWav({ channels: [l, r], rate: 48000 }, { bits: 16, dither: false });
    const dv = new DataView(buf, 44);
    const got = Array.from({ length: 8 }, (_, i) => dv.getInt16(i * 2, true));
    expect(got).toEqual([0, 16384, 32767, -16383, -32767, 8192, 32767, -32768]);
  });

  it('adds TPDF dither within one LSB either way at 16 bits', () => {
    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const n = 2000;
    const buf = encodeWav({ channels: [new Float32Array(n).fill(0.1)], rate: 44100 }, { bits: 16, random });
    const dv = new DataView(buf, 44);
    const exact = 0.1 * 32767;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = dv.getInt16(i * 2, true);
      expect(Math.abs(v - exact)).toBeLessThanOrEqual(1.5);
      sum += v;
    }
    expect(Math.abs(sum / n - exact)).toBeLessThan(0.1);
  });

  it('writes 24-bit PCM little endian', () => {
    const buf = encodeWav({ channels: [Float32Array.from([0.5, -0.5, 1])], rate: 96000 }, { bits: 24 });
    const h = readWavHeader(buf);
    expect(h).toMatchObject({ format: 1, channels: 1, rate: 96000, bits: 24, frames: 3, dataOffset: 44 });
    expect(bytes(buf, 32, 4)).toEqual([...le16(3), ...le16(24)]);
    expect(bytes(buf, 44, 9)).toEqual([0x00, 0x00, 0x40, 0x01, 0x00, 0xc0, 0xff, 0xff, 0x7f]);
  });

  it('writes 32-bit float with the extended fmt chunk and a fact chunk', () => {
    const buf = encodeWav({ channels: [Float32Array.from([0.25, -1.5])], rate: 44100 }, { bits: 32 });
    expect(bytes(buf, 12, 38)).toEqual([
      ...ascii('fmt '), ...le32(18), ...le16(3), ...le16(1), ...le32(44100), ...le32(44100 * 4), ...le16(4), ...le16(32), ...le16(0),
      ...ascii('fact'), ...le32(4), ...le32(2),
    ]);
    const h = readWavHeader(buf);
    expect(h).toMatchObject({ format: 3, bits: 32, frames: 2, dataOffset: 58 });
    expect([...decodeWavSamples(buf).channels[0]]).toEqual([0.25, -1.5]);
  });

  it('round trips 24-bit samples closely', () => {
    const src = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i / 5) * 0.9);
    const out = decodeWavSamples(encodeWav({ channels: [src, src], rate: 44100 }, { bits: 24 }));
    for (let i = 0; i < src.length; i++) expect(Math.abs(out.channels[1][i] - src[i])).toBeLessThan(2e-7);
  });

  it('sniffs formats and picks extensions', () => {
    const wav = new Uint8Array(encodeWav({ channels: [new Float32Array(4)], rate: 8000 }));
    expect(sniffAudio(wav)).toBe('wav');
    expect(sniffAudio(new Uint8Array([...ascii('FORM'), 0, 0, 0, 0, ...ascii('AIFF')]))).toBe('aiff');
    expect(sniffAudio(new Uint8Array([...ascii('ID3'), 3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('mp3');
    expect(sniffAudio(new Uint8Array(12))).toBe(null);
    expect(audioExtension('Loop.WAV')).toBe('wav');
    expect(audioExtension('mystery', wav)).toBe('wav');
    expect(isAudioName('a.flac')).toBe(true);
    expect(isAudioName('a.txt')).toBe(false);
  });
});

describe('midi reader', () => {
  // A hand-built format 0 file at 480 PPQ with running status and a velocity-0 note off.
  const track = [
    0x00, 0xff, 0x03, 0x04, ...ascii('Keys'),
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 500000 us per quarter = 120 BPM
    0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08, // 3/4
    0x00, 0xc0, 0x21, // program 33 (bass family)
    0x00, 0x90, 0x3c, 0x64, // C4 on
    0x00, 0x40, 0x50, // E4 on (running status)
    0x83, 0x60, 0x3c, 0x00, // 480 ticks later: C4 off as note on with velocity 0
    0x00, 0x40, 0x00, // E4 off, running status
    0x00, 0x80, 0x43, 0x40, // stray note off: ignored
    0x00, 0xff, 0x2f, 0x00,
  ];
  const file = new Uint8Array([...ascii('MThd'), 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, ...ascii('MTrk'), ...[0, 0, 0, track.length], ...track]);

  it('parses running status, tempo, signature and notes', () => {
    expect(isMidi(file)).toBe(true);
    const m = readMidi(file.buffer);
    expect(m.format).toBe(0);
    expect(m.ppq).toBe(480);
    expect(m.tempos).toEqual([{ tick: 0, bpm: 120 }]);
    expect(m.sigs).toEqual([{ tick: 0, num: 3, den: 4 }]);
    expect(m.tracks[0].name).toBe('Keys');
    expect(m.tracks[0].programs).toEqual({ 0: 33 });
    expect(m.tracks[0].notes).toEqual([
      { ch: 0, key: 60, tick: 0, len: 480, vel: 100 },
      { ch: 0, key: 64, tick: 0, len: 480, vel: 80 },
    ]);
  });

  it('converts to the app PPQ on import, with tempo and signature', () => {
    const r = importMidi(createProject(), readMidi(file));
    expect(r.project.bpm).toBe(120);
    expect(r.project.sig).toEqual([3, 4]);
    expect(r.channelIds).toHaveLength(1);
    const ch = r.project.channels[0];
    expect(ch.type).toBe('synth');
    expect(ch.name).toBe('Keys');
    const pat = r.project.patterns.find((p) => p.id === r.patternIds[0]);
    expect(pat.notes[ch.id].map((n) => [n.key, n.pos, n.len])).toEqual([[60, 0, PPQ], [64, 0, PPQ]]);
    expect(r.project.clips).toHaveLength(1);
    expect(r.project.tracks[0].name).toBe('Keys');
    expect(ch.mixer).toBe(1);
  });

  it('skips sysex events exactly (a GM reset before the first note)', () => {
    const t = [
      0x00, 0xf0, 0x05, 0x7e, 0x7f, 0x09, 0x01, 0xf7, // GM System On
      0x00, 0x90, 0x3c, 0x64,
      0x83, 0x60, 0x80, 0x3c, 0x40,
      0x00, 0x90, 0x40, 0x64,
      0x83, 0x60, 0x80, 0x40, 0x40,
      0x00, 0xff, 0x2f, 0x00,
    ];
    const f = new Uint8Array([...ascii('MThd'), 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, ...ascii('MTrk'), 0, 0, 0, t.length, ...t]);
    expect(readMidi(f).tracks[0].notes.map((n) => [n.key, n.tick, n.len])).toEqual([[60, 0, 480], [64, 480, 480]]);
  });

  it('writes large tracks and uses the tempo in effect at the start', () => {
    const notes = Array.from({ length: 40000 }, (_, i) => ({ key: 60 + (i % 12), tick: i * 10, len: 5, vel: 100 }));
    const out = writeMidi({ ppq: 96, bpm: 140, tracks: [{ name: 'Big', channel: 0, notes }] });
    const m = readMidi(out);
    expect(m.tracks[1].notes).toHaveLength(40000);
    // A tempo change after the start does not become the project tempo.
    expect(importMidi(createProject(), { ...m, tempos: [{ tick: 960, bpm: 200 }] }).project.bpm).toBe(120);
    expect(importMidi(createProject(), m).project.bpm).toBe(140);
    const many = writeMidi({ tracks: Array.from({ length: 300 }, () => ({ channel: 0, notes: [] })) });
    expect((many[10] << 8) | many[11]).toBe(301);
  });

  it('exports the song with playlist track solo as playback applies it', () => {
    const p = demoProject();
    const soloed = { ...p, tracks: p.tracks.map((t, i) => (i === p.clips[0].track ? { ...t, solo: true } : t)) };
    const all = projectToMidi(p).tracks.reduce((n, t) => n + t.notes.length, 0);
    const solo = projectToMidi(soloed).tracks.reduce((n, t) => n + t.notes.length, 0);
    expect(solo).toBeGreaterThan(0);
    expect(solo).toBeLessThan(all);
  });

  it('rejects files that are not MIDI', () => {
    expect(() => readMidi(new Uint8Array(20).buffer)).toThrow(/not a Standard MIDI File/);
  });

  it('maps General MIDI drums and programs', () => {
    expect(drumKindForNote(36)).toBe(0);
    expect(drumKindForNote(42)).toBe(3);
    expect(drumKindForNote(46)).toBe(4);
    expect(drumKindForNote(49)).toBe(7);
    expect(presetForProgram(33)).toBe('Sub Bass');
    expect(presetForProgram(0)).toBe('Soft Keys');
  });
});

describe('midi round trip', () => {
  it('writes and reads back a pattern with drums and synths', () => {
    const p = demoProject();
    const pat = p.patterns[0];
    const out = projectToMidi(p, { mode: 'pattern', patternId: pat.id });
    const data = writeMidi(out);
    const m = readMidi(data.buffer);
    expect(m.format).toBe(1);
    expect(m.ppq).toBe(PPQ);
    expect(m.tempos[0].bpm).toBeCloseTo(124, 3);
    const total = Object.values(pat.notes).reduce((s, l) => s + l.length, 0);
    expect(m.tracks.slice(1).reduce((s, t) => s + t.notes.length, 0)).toBe(total);
    expect(m.tracks.slice(1).every((t) => t.notes.every((n) => n.ch === 9))).toBe(true);

    // Importing it back gives drum channels and the same hits.
    const back = importMidi(createProject(), m);
    const kinds = back.project.channels.map((c) => c.params.kind).sort();
    expect(kinds).toEqual([0, 2, 3, 4]);
    const drums = back.project.patterns.find((x) => x.name === 'Drums');
    expect(Object.values(drums.notes).reduce((s, l) => s + l.length, 0)).toBe(total);
  });

  it('exports the song with clip offsets and keeps melodic notes exact', () => {
    const p = createProject();
    const ch = createChannel({ type: 'synth', name: 'Lead' });
    const pat = { ...createPattern(0), notes: { [ch.id]: [createNote({ key: 62, pos: 0, len: 48, vel: 1 }), createNote({ key: 65, pos: 96, len: 96, vel: 0.5 })] } };
    p.channels = [ch];
    p.patterns = [pat];
    p.clips = [
      { id: 'a', kind: 'pattern', track: 0, start: 384, len: 384, offset: 0, ref: pat.id, mute: false },
      { id: 'b', kind: 'pattern', track: 1, start: 1536, len: 96, offset: 96, ref: pat.id, mute: false },
    ];
    const m = readMidi(writeMidi(projectToMidi(p, { mode: 'song' })));
    const notes = m.tracks[1].notes.map((n) => [n.key, n.tick, n.len, n.vel]);
    expect(notes).toEqual([[62, 384, 48, 127], [65, 480, 96, 64], [65, 1536, 96, 64]]);
    expect(m.tracks[1].notes[0].ch).toBe(0);
    expect(m.tracks[1].name).toBe('Lead');
  });
});

describe('zip writer', () => {
  it('stores files that read back byte for byte', () => {
    const a = new TextEncoder().encode('hello');
    const b = new Uint8Array([0, 1, 2, 3, 255]);
    const z = zipBytes([{ name: 'a.txt', data: a }, { name: 'stems/b.bin', data: b }]);
    expect([...z.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const files = unzipStore(z.buffer);
    expect(new TextDecoder().decode(files.get('a.txt'))).toBe('hello');
    expect([...files.get('stems/b.bin')]).toEqual([0, 1, 2, 3, 255]);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('makes safe file names', () => {
    expect(safeFileName('a/b:c*?')).toBe('a-b-c-');
    expect(safeFileName('  ')).toBe('Untitled');
  });
});
