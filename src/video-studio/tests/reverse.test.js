import { describe, it, expect, vi } from 'vitest';

// reverse.js pulls in mediabunny (WebCodecs), which has no meaning under node.
// The functions under test are pure, so stand in for the library.
vi.mock('mediabunny', () => ({
  __esModule: true,
  Input: class {}, BlobSource: class {}, Output: class {}, BufferTarget: class {},
  VideoSampleSink: class {}, AudioSampleSink: class {}, EncodedPacketSink: class {},
  Mp4OutputFormat: class {}, WebMOutputFormat: class {},
  VideoSampleSource: class {}, AudioSampleSource: class {},
  VideoSample: class {}, AudioSample: class {},
  ALL_FORMATS: {}, QUALITY_HIGH: 1,
  canEncodeVideo: () => Promise.resolve(false), canEncodeAudio: () => Promise.resolve(false),
}));

import { keySpans, reverseSlices, decodeRuns, sliceBudget, audioCandidates } from '../src/media/reverse.js';

const span = (start, end, frames) => ({ start, end, frames });

describe('keySpans', () => {
  it('groups frames into spans that start at a key packet', () => {
    const packets = [
      { timestamp: 0, key: true },
      { timestamp: 1, key: false },
      { timestamp: 2, key: false },
      { timestamp: 3, key: true },
      { timestamp: 4, key: false },
    ];
    const spans = keySpans(packets, 5);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ start: 0, end: 3 });
    expect(spans[0].frames).toEqual([0, 1, 2]);
    // The last span runs to the end of the file.
    expect(spans[1]).toMatchObject({ start: 3, end: 5 });
    expect(spans[1].frames).toEqual([3, 4]);
  });
});

describe('reverseSlices', () => {
  it('splits frame times into slices of n, last slice first', () => {
    expect(reverseSlices([0, 1, 2, 3, 4], 2)).toEqual([[3, 4], [1, 2], [0]]);
  });
});

describe('decodeRuns', () => {
  it('merges consecutive spans that fit within the limit into one run', () => {
    const runs = decodeRuns([span(0, 1, [0]), span(1, 2, [1]), span(2, 3, [2])], 24);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ start: 0, end: 3 });
    expect(runs[0].frames).toEqual([0, 1, 2]);
  });

  // Intra-only files (common from video generators) make every frame its own
  // span. Without merging, each frame would cost its own decode session.
  it('merges intra-only single-frame spans into far fewer runs', () => {
    const allIntra = Array.from({ length: 300 }, (_, i) => span(i, i + 1, [i]));
    const runs = decodeRuns(allIntra, 24);
    expect(runs).toHaveLength(Math.ceil(300 / 24));
    expect(runs.length).toBeLessThan(20);
    for (const r of runs) expect(r.frames.length).toBeLessThanOrEqual(24);
    // No frame is lost or duplicated.
    expect(runs.reduce((n, r) => n + r.frames.length, 0)).toBe(300);
  });

  it('keeps a span longer than the limit on its own so memory stays bounded', () => {
    const big = span(0, 100, Array.from({ length: 100 }, (_, i) => i));
    const small = span(100, 101, [100]);
    const runs = decodeRuns([big, small], 24);
    expect(runs).toHaveLength(2);
    expect(runs[0].frames).toHaveLength(100);
    expect(runs[1].frames).toEqual([100]);
  });

  it('gives smaller videos more frames per run than 4K ones, within limits', () => {
    // A memory budget, so the run length follows the frame size.
    expect(sliceBudget(1280, 720)).toBeGreaterThan(sliceBudget(1920, 1080));
    // And it never goes below the floor or above the ceiling.
    expect(sliceBudget(3840, 2160)).toBe(12);
    expect(sliceBudget(320, 240)).toBe(240);
  });

  it('starts a new run when the next span would overflow the limit', () => {
    const a = span(0, 20, Array.from({ length: 20 }, (_, i) => i));
    const b = span(20, 30, Array.from({ length: 10 }, (_, i) => 20 + i));
    const runs = decodeRuns([a, b], 24);
    expect(runs).toHaveLength(2);
    expect(runs[0].frames).toHaveLength(20);
    expect(runs[1].frames).toHaveLength(10);
  });
});

describe('audioCandidates', () => {
  // 32 kHz stereo is what a lot of generated footage carries, and it is exactly
  // what AAC refuses, so the fallback has to exist and has to be reachable.
  it('offers the file\'s own settings first, then rates encoders accept', () => {
    const list = audioCandidates(32000, 2);
    expect(list[0]).toEqual({ sampleRate: 32000, numberOfChannels: 2 });
    expect(list).toContainEqual({ sampleRate: 48000, numberOfChannels: 2 });
    expect(list).toContainEqual({ sampleRate: 44100, numberOfChannels: 2 });
  });

  it('changes the rate before it gives up channels', () => {
    // Resampling is near-lossless; dropping to mono is not.
    const list = audioCandidates(32000, 6);
    const at = (r, c) => list.findIndex((x) => x.sampleRate === r && x.numberOfChannels === c);
    expect(at(32000, 6)).toBe(0);
    expect(at(48000, 6)).toBeLessThan(at(32000, 2));
    expect(at(44100, 6)).toBeLessThan(at(32000, 1));
  });

  it('never offers a rate or channel count it was not given', () => {
    for (const c of audioCandidates(0, 0)) {
      expect(c.sampleRate).toBeGreaterThan(0);
      expect(c.numberOfChannels).toBeGreaterThan(0);
    }
  });

  it('does not repeat a setting', () => {
    const list = audioCandidates(48000, 2);
    const keys = list.map((c) => `${c.sampleRate}/${c.numberOfChannels}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
