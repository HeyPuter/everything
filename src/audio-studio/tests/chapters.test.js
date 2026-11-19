import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chapterTime, parseChapterTime, vorbisChapterEntries, readChapters, chplBox, chaptersFromChpl, id3ChapterFrames } from '../src/audio/chapters.js';
import { muxOggOpus } from '../src/export/ogg.js';
import { muxM4a } from '../src/export/mp4.js';
import { runExport } from '../src/export/pipeline.js';
import { readTags, id3v2Tag } from '../src/audio/meta.js';
import { formatNote } from '../src/export/dialog.js';
import { FORMATS } from '../src/export/formats.js';

let dsp;
beforeAll(() => {
  const bytes = fs.readFileSync(path.resolve(__dirname, '../src/audio/dsp.wasm'));
  dsp = { x: new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports };
});

const join = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.buffer;
};
const markers = [{ name: 'Verse', start: 96000 }, { name: 'Intro', start: 0 }, { name: 'Chorus ünd', start: 216000, duration: 48000 }];
const expected = [{ name: 'Intro', seconds: 0 }, { name: 'Verse', seconds: 2 }, { name: 'Chorus ünd', seconds: 4.5 }];

describe('chapters', () => {
  it('formats and reads chapter times', () => {
    expect(chapterTime(3723.4567)).toBe('01:02:03.457');
    expect(parseChapterTime('01:02:03.457')).toBeCloseTo(3723.457, 6);
    expect(parseChapterTime('2:05')).toBe(125);
    expect(parseChapterTime('x')).toBeNaN();
    expect(vorbisChapterEntries(markers, 48000).slice(0, 4)).toEqual(['CHAPTER001=00:00:00.000', 'CHAPTER001NAME=Intro', 'CHAPTER002=00:00:02.000', 'CHAPTER002NAME=Verse']);
  });

  it('round-trips through Ogg Opus comments, keeping the other tags', () => {
    const packets = Array.from({ length: 10 }, () => ({ data: new Uint8Array(50), samples: 960 }));
    const pages = muxOggOpus({ channels: 2, packets, totalSamples: 9000, meta: { title: 'Song' }, chapters: vorbisChapterEntries(markers, 48000) });
    const buf = join(pages);
    expect(readChapters(buf)).toEqual(expected);
    expect(readTags(buf).title).toBe('Song');
  });

  it('round-trips through an M4A chapter list', () => {
    const parts = muxM4a({ sampleRate: 48000, channels: 2, packets: [new Uint8Array(20), new Uint8Array(20)], totalFrames: 2048, meta: { title: 'Song' }, markers });
    const buf = join(parts);
    expect(readChapters(buf).map((c) => [c.name, Math.round(c.seconds * 1000)])).toEqual(expected.map((c) => [c.name, c.seconds * 1000]));
    expect(readTags(buf).title).toBe('Song');
    expect(chplBox([], 48000)).toBe(null);
    // With chapters the movie time scale is 1000, where readers that scale chapter times by it
    // (time / 10000 / time scale) and readers that take 100 ns units agree.
    const bytes = new Uint8Array(buf);
    const at = String.fromCharCode(...bytes).indexOf('mvhd');
    const dv = new DataView(buf);
    expect(dv.getUint32(at + 16)).toBe(1000);
    expect(dv.getUint32(at + 20)).toBe(Math.round((2048 * 1000) / 48000));
    const chpl = chplBox(markers, 48000);
    const verse = Number(new DataView(chpl.buffer).getBigUint64(17 + 9 + 'Intro'.length));
    expect(verse / 10000 / 1000).toBe(2);
    expect(verse / 1e7).toBe(2);
    expect(chaptersFromChpl(chplBox(markers, 48000).subarray(8))).toHaveLength(3);
  });

  it('writes FLAC exports with chapters', async () => {
    const ch = [new Float32Array(48000 * 5)];
    const blob = await runExport({ options: { format: 'flac', sampleRate: 48000, channels: 1, bitDepth: 16, dither: 'none', settings: { level: 0 } }, sourceRate: 48000, frames: ch[0].length, read: (at, n) => ch.map((c) => c.subarray(at, at + n)), markers, dsp });
    expect(readChapters(await blob.arrayBuffer())).toEqual(expected);
  });

  it('round-trips through ID3 chapter frames, keeping the other tags', () => {
    const tag = id3v2Tag({ title: 'Episode 3' }, { extraFrames: id3ChapterFrames(markers, 48000, 48000 * 6) });
    const buf = tag.slice().buffer;
    expect(readChapters(buf)).toEqual(expected);
    expect(readTags(buf).title).toBe('Episode 3');
    // The table of contents lists the chapters in order.
    expect(new TextDecoder().decode(tag)).toContain('CTOC');
    expect(id3ChapterFrames([], 48000, 100)).toEqual([]);
  });

  it('explains what MP3 cannot do and suggests a smaller format the browser has', () => {
    expect(formatNote('wav', FORMATS)).toBe('');
    expect(formatNote('mp3', FORMATS)).toContain('Ogg Opus');
    expect(formatNote('mp3', FORMATS.filter((f) => f.id !== 'opus'))).toContain('AAC');
    expect(formatNote('mp3', FORMATS.filter((f) => !f.webcodecs))).not.toContain('choose');
  });
});
