import { describe, it, expect } from 'vitest';
import { parseMarkerText, parseDelimited } from '../src/storage/markers-io.js';
import { conformOptions, defaultOptions, estimateSize, withExtension, sanitizeFileName, exportMarkers, formatForName, describeSampleType, describeSettings, usesDither } from '../src/export/formats.js';
import { id3v2Tag, parseId3v2, riffInfoChunk, parseRiffInfo, vorbisComment, parseVorbisComment, cleanMeta, readTags } from '../src/audio/meta.js';
import { probeAudio, probeSource, describeProbe } from '../src/storage/probe.js';
import { WavWriter, AiffWriter } from '../src/export/pcm.js';
import { parseAiff } from '../src/audio/aiff.js';
import { decodeAudio, sniffSampleRate } from '../src/audio/decode.js';
import { muxOggOpus } from '../src/export/ogg.js';
import { sortItems, filterItems, crumbs } from '../src/panels/media-browser.js';
import { withMetaField } from '../src/panels/metadata.js';
import { initialState } from '../src/export/dialog.js';
import { AudioFile } from '../src/model/audio-file.js';

const rate = 48000;

describe('marker import', () => {
  it('reads the tab-separated, quoted text that Export Markers writes', () => {
    const text = [
      ['Name', 'Start', 'Duration', 'Time Format', 'Type', 'Description'],
      ['Intro', '0:01.500', '0:00.000', 'decimal', 'cue', ''],
      ['Verse "A"', '0:10.000', '0:05.250', 'decimal', 'cd', 'first, verse'],
    ]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join('\t'))
      .join('\n');
    expect(parseMarkerText(text, rate)).toEqual([
      { start: 72000, duration: 0, name: 'Intro', type: 'cue', description: '' },
      { start: 480000, duration: 252000, name: 'Verse "A"', type: 'cd', description: 'first, verse' },
    ]);
  });

  it('reads comma CSV, other time formats and headerless lists', () => {
    const csv = 'Name,Start,Duration,Time Format,Type,Description\r\nA,48000,0,samples,Cart Timer,\r\nB,00:00:02:15,00:00:00:00,smpte30,Subclip,x\r\n';
    expect(parseMarkerText(csv, rate).map((m) => [m.name, m.start, m.type])).toEqual([
      ['A', 48000, 'cart'],
      ['B', 120000, 'subclip'],
    ]);
    expect(parseMarkerText('One\t1.0\nTwo\t2.5\n', rate).map((m) => [m.name, m.start, m.duration])).toEqual([
      ['One', 48000, 0],
      ['Two', 120000, 0],
    ]);
  });

  it('skips unreadable rows and rejects files without markers', () => {
    expect(parseMarkerText('Name\tStart\nok\t1\nbad\tsoon\n', rate)).toHaveLength(1);
    expect(() => parseMarkerText('', rate)).toThrow();
    expect(() => parseMarkerText('Name\tStart\nx\ty\n', rate)).toThrow(/No markers/);
    expect(parseDelimited('a,"b,""c"""\n', ',')).toEqual([['a', 'b,"c"']]);
  });
});

describe('export option logic', () => {
  it('conforms rates, channels and bit depths to each format', () => {
    let r = conformOptions('mp3', { sampleRate: 96000, channels: 6, bitDepth: 24, settings: { bitrate: 500 } });
    expect(r.options).toMatchObject({ sampleRate: 48000, channels: 2, bitDepth: undefined, settings: { bitrate: 192 } });
    expect(r.notes.length).toBe(2);
    r = conformOptions('flac', { sampleRate: 44100, channels: 2, bitDepth: 32, settings: {} });
    expect(r.options.bitDepth).toBe(24);
    expect(r.options.settings.level).toBe(5);
    expect(conformOptions('opus', { sampleRate: 44100, channels: 1, settings: {} }).options.sampleRate).toBe(48000);
    expect(conformOptions('m4a', { sampleRate: 22050, channels: 2, settings: { bitrate: 128 } }).options).toMatchObject({ sampleRate: 44100, settings: { bitrate: 128 } });
    expect(conformOptions('wav', { sampleRate: 44100, channels: 2, bitDepth: 12 }).options.bitDepth).toBe(16);
    // MPEG-2 rates allow at most 160 kbps.
    expect(conformOptions('mp3', { sampleRate: 22050, channels: 1, settings: { bitrate: 320 } }).options.settings.bitrate).toBe(160);
  });

  it('describes and sizes options', () => {
    const o = defaultOptions({ sampleRate: 48000, channels: 2, bitDepth: 24 }, 'wav');
    expect(describeSampleType(o)).toBe('48000 Hz Stereo, 24-bit');
    expect(describeSettings(o)).toMatch(/Uncompressed/);
    expect(estimateSize(o, 48000)).toBe(44 + 48000 * 6);
    const mp3 = defaultOptions({ sampleRate: 44100, channels: 2 }, 'mp3');
    expect(describeSettings(mp3)).toBe('192 kbps CBR');
    expect(Math.round(estimateSize(mp3, 44100 * 60) / 1000)).toBe(1441);
    expect(estimateSize({ ...o, sampleRate: 24000 }, 48000, 48000)).toBe(44 + 24000 * 6);
    expect(usesDither(o)).toBe(true);
    expect(usesDither({ ...o, bitDepth: 32 })).toBe(false);
    expect(usesDither(defaultOptions({ sampleRate: 48000, channels: 2 }, 'opus'))).toBe(false);
  });

  it('handles names, extensions and markers', () => {
    expect(withExtension('Take 1.wav', 'flac')).toBe('Take 1.flac');
    expect(withExtension('v1.2 mix', 'mp3')).toBe('v1.2 mix.mp3');
    // A version number at the end is part of the name, not an extension.
    expect(withExtension('Mix 1.5', 'wav')).toBe('Mix 1.5.wav');
    expect(withExtension('Song.m4a', 'wav')).toBe('Song.wav');
    expect(initialState(AudioFile.blank({ name: 'Mix 1.5.wav', sampleRate: 44100, channels: 1, seconds: 1 }), { mode: 'saveAs', frames: 1 }).name).toBe('Mix 1.5.wav');
    expect(sanitizeFileName(' a/b:c*?.wav ')).toBe('a_b_c__.wav');
    expect(formatForName('X.AIFF')).toBe('aiff');
    expect(formatForName('x.ogg')).toBe(null);
    const m = exportMarkers([{ start: 100, duration: 50 }, { start: 400, duration: 0 }, { start: 10, duration: 0 }], 50, 300, 48000, 24000);
    expect(m.map((x) => [x.start, x.duration])).toEqual([[25, 25]]);
  });

  it('starts the dialog from the document: Save As keeps its format, Export uses the last one', () => {
    const doc = AudioFile.blank({ name: 'Interview.flac', sampleRate: 44100, channels: 1, seconds: 1 });
    doc.info.bitDepth = 24;
    const a = initialState(doc, { mode: 'saveAs', frames: doc.length, remembered: { format: 'mp3' } });
    expect(a.name).toBe('Interview.flac');
    expect(a.options).toMatchObject({ format: 'flac', sampleRate: 44100, channels: 1, bitDepth: 24 });
    const b = initialState(doc, { mode: 'export', frames: doc.length, remembered: { format: 'mp3', settings: { mp3: { bitrate: 320 } } } });
    expect(b.name).toBe('Interview.mp3');
    expect(b.options.settings.bitrate).toBe(320);
    const c = initialState(doc, { mode: 'selection', frames: 10 });
    expect(c.name).toBe('Interview Selection.flac');
  });
});

describe('metadata writers and readers', () => {
  const meta = { title: 'Ümlaut Song', artist: 'Band', album: 'LP', year: '1999', genre: 'Jazz', comment: 'Hi there' };
  it('round-trips ID3v2 with Latin-1 and UTF-16 text', () => {
    expect(parseId3v2(id3v2Tag(meta))).toEqual(meta);
    const wide = { title: 'Ночь', comment: '日本語' };
    expect(parseId3v2(id3v2Tag(wide))).toEqual(wide);
    expect(id3v2Tag({})).toBe(null);
  });
  it('round-trips RIFF INFO and Vorbis comments', () => {
    const chunk = riffInfoChunk(meta);
    expect(String.fromCharCode(...chunk.subarray(0, 4))).toBe('LIST');
    expect(parseRiffInfo(chunk.subarray(8))).toEqual(meta);
    expect(parseVorbisComment(vorbisComment(meta))).toEqual(meta);
    expect(cleanMeta({ title: '  ', foo: 'x', artist: ' A ' })).toEqual({ artist: 'A' });
  });
  it('edits one field of a document state', () => {
    const s = { channels: [], meta: { title: 'a' } };
    expect(withMetaField(s, 'title', 'a')).toBe(null);
    expect(withMetaField(s, 'artist', 'B').meta).toEqual({ title: 'a', artist: 'B' });
    expect(withMetaField(s, 'title', '').meta).toEqual({});
  });
});

describe('file probing and decoding', () => {
  const tone = (n) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 10) * 0.5);
  async function bytesOf(Writer, opts) {
    const w = new Writer({ sampleRate: 22050, channels: 2, bitDepth: 16, dither: 'none', frames: 22050, meta: { title: 'P' }, ...opts });
    w.write([tone(22050), tone(22050)], 22050);
    return new Uint8Array(await w.finish().arrayBuffer());
  }
  it('reads durations from WAV, AIFF, MP3 and Ogg headers', async () => {
    const wav = await bytesOf(WavWriter);
    expect(probeAudio(wav.subarray(0, 4096), wav.length)).toMatchObject({ format: 'WAV', sampleRate: 22050, channels: 2, bitDepth: 16, duration: 1 });
    const aif = await bytesOf(AiffWriter, { bitDepth: 24 });
    expect(probeAudio(aif.subarray(0, 4096), aif.length)).toMatchObject({ format: 'AIFF', duration: 1, bitDepth: 24 });
    expect(describeProbe(probeAudio(aif, aif.length))).toBe('AIFF 22.1 kHz 24-bit Stereo');
    // MP3 CBR: 128 kbps frames -> duration from size.
    const frame = new Uint8Array(417);
    frame.set([0xff, 0xfb, 0x90, 0x00]);
    const mp3 = new Uint8Array(417 * 100);
    for (let i = 0; i < 100; i++) mp3.set(frame, i * 417);
    const p = probeAudio(mp3, mp3.length);
    expect(p.format).toBe('MP3');
    expect(p.duration).toBeCloseTo((417 * 100 * 8) / 128000, 3);
    // Behind 300 KB of ID3v2 cover art, past the probed head.
    const art = 300000;
    const tagged = new Uint8Array(10 + art + mp3.length);
    tagged.set([0x49, 0x44, 0x33, 3, 0, 0, (art >> 21) & 0x7f, (art >> 14) & 0x7f, (art >> 7) & 0x7f, art & 0x7f]);
    tagged.set(mp3, 10 + art);
    const read = async (at, n) => tagged.slice(at, at + n);
    expect(await probeSource(read, tagged.length)).toMatchObject({ format: 'MP3', sampleRate: 44100, duration: p.duration });
    expect(await probeSource(read, mp3.length + 10 + art)).not.toHaveProperty('skip');
    const pages = muxOggOpus({ channels: 2, packets: Array.from({ length: 50 }, () => ({ data: new Uint8Array(40), samples: 960 })), totalSamples: 48000 });
    const ogg = new Uint8Array(pages.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const pg of pages) {
      ogg.set(pg, o);
      o += pg.length;
    }
    const first = probeAudio(ogg.subarray(0, 100), ogg.length);
    expect(first).toMatchObject({ format: 'Opus', needTail: true });
    expect(probeAudio(ogg.subarray(0, 100), ogg.length, ogg).duration).toBeCloseTo(1, 5);
  });
  it('decodes AIFF natively with markers and metadata', async () => {
    const w = new AiffWriter({ sampleRate: 44100, channels: 1, bitDepth: 16, dither: 'none', frames: 100, markers: [{ start: 5, name: 'X' }], meta: { title: 'Name', album: 'Alb' } });
    w.write([new Float32Array(100).fill(0.25)], 100);
    const buf = await w.finish().arrayBuffer();
    const r = await decodeAudio(buf, 'x.aif');
    expect(r).toMatchObject({ format: 'aiff', sampleRate: 44100, bitDepth: 16, markers: [{ start: 5, name: 'X' }], meta: { title: 'Name', album: 'Alb' } });
    expect(r.channels[0][50]).toBe(0.25);
    expect(parseAiff(buf).channels.length).toBe(1);
    expect(readTags(buf)).toEqual({});
  });
  it('rejects empty and known-unsupported files with clear messages', async () => {
    await expect(decodeAudio(new ArrayBuffer(0), 'a.mp3')).rejects.toThrow(/empty/);
    await expect(decodeAudio(new ArrayBuffer(16), 'a.wma')).rejects.toThrow(/Windows Media Audio/);
  });
  it('sniffs the Opus rate from WebM', () => {
    const b = new Uint8Array(200);
    b.set([0x1a, 0x45, 0xdf, 0xa3]);
    b.set(Array.from('A_OPUS', (c) => c.charCodeAt(0)), 50);
    expect(sniffSampleRate(b.buffer)).toBe(48000);
  });
});

describe('media browser helpers', () => {
  const items = [
    { name: 'b.wav', is_dir: false },
    { name: 'Folder', is_dir: true },
    { name: 'a10.mp3', is_dir: false },
    { name: 'a2.mp3', is_dir: false },
    { name: 'notes.txt', is_dir: false },
  ];
  it('sorts folders first in natural order and filters audio', () => {
    expect(sortItems(items).map((i) => i.name)).toEqual(['Folder', 'a2.mp3', 'a10.mp3', 'b.wav', 'notes.txt']);
    expect(filterItems(items).map((i) => i.name)).toEqual(['b.wav', 'Folder', 'a10.mp3', 'a2.mp3']);
    expect(filterItems(items, { audioOnly: false, query: 'NO' }).map((i) => i.name)).toEqual(['notes.txt']);
  });
  it('splits paths into breadcrumbs', () => {
    expect(crumbs('/demo/AudioStudio/Takes')).toEqual([
      { name: 'demo', path: '/demo' },
      { name: 'AudioStudio', path: '/demo/AudioStudio' },
      { name: 'Takes', path: '/demo/AudioStudio/Takes' },
    ]);
  });
});
