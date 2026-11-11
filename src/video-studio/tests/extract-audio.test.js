import { describe, it, expect } from 'vitest';
import { extractedName, extractClipAudio } from '../src/media/extract-audio.js';
import { readWav } from '../src/media/wav.js';
import { makeClip } from '../src/model/project.js';
import { US } from '../src/lib/time.js';

const RATE = 8000;

/** A stub source: two seconds of stereo where each sample holds its own time. */
function opener({ silent = false } = {}) {
  const n = RATE * 2;
  const left = Float32Array.from({ length: n }, (_, i) => i / n);
  const right = Float32Array.from({ length: n }, (_, i) => -i / n);
  const chunk = 1000;
  return async () => (silent ? null : {
    sampleRate: RATE,
    async *read(start) {
      for (let at = Math.floor(start * RATE / chunk) * chunk; at < n; at += chunk) {
        yield { timestamp: at / RATE, sampleRate: RATE, channels: [left.subarray(at, at + chunk), right.subarray(at, at + chunk)] };
      }
    },
    close() {},
  });
}

const read = async (file) => readWav(await file.arrayBuffer());

describe('extract audio', () => {
  it('names the file after the clip', () => {
    expect(extractedName('Interview.mp4')).toBe('Interview audio.wav');
    expect(extractedName('take 2.final.mov')).toBe('take 2.final audio.wav');
    expect(extractedName('')).toBe('Clip audio.wav');
    expect(extractedName('x'.repeat(300)).length).toBe(100 + ' audio.wav'.length);
  });

  it('writes the source range the clip plays as a WAV file', async () => {
    const clip = makeClip('video', { assetId: 'a', in: 0.5 * US, duration: US, name: 'Talk.mp4' });
    const out = await extractClipAudio(opener(), { id: 'a', name: 'Talk.mp4' }, clip);
    expect(out.file.name).toBe('Talk audio.wav');
    expect(out.file.type).toBe('audio/wav');
    expect(out.seconds).toBeCloseTo(1, 3);
    const wav = await read(out.file);
    expect(wav.sampleRate).toBe(RATE);
    expect(wav.channels.length).toBe(2);
    expect(wav.channels[0].length).toBe(RATE);
    // First sample is the one at the in point (0.5 s of 2 s), within 16-bit rounding.
    expect(wav.channels[0][0]).toBeCloseTo(0.25, 3);
    expect(wav.channels[1][0]).toBeCloseTo(-0.25, 3);
    expect(wav.channels[0].at(-1)).toBeCloseTo((RATE * 1.5 - 1) / (RATE * 2), 3);
  });

  it('reads the source at normal speed for a sped-up clip', async () => {
    const clip = makeClip('video', { assetId: 'a', in: 0, duration: 0.5 * US, speed: 2 });
    const out = await extractClipAudio(opener(), { id: 'a', name: 'Fast.mp4' }, clip, { name: 'Fast.mp4' });
    expect(out.seconds).toBeCloseTo(1, 3);
  });

  it('writes long recordings piece by piece without losing or moving a sample', async () => {
    // 80 s of stereo at 8 kHz is more than one 2 MB piece of the file; samples ramp so any slip shows.
    const n = RATE * 80;
    const ramp = (i, c) => ((i % 20000) / 20000) * (c ? -0.5 : 0.5);
    const open = async () => ({
      sampleRate: RATE,
      async *read() {
        for (let at = 0; at < n; at += 999) {
          const len = Math.min(999, n - at);
          yield { timestamp: at / RATE, sampleRate: RATE, channels: [0, 1].map((c) => Float32Array.from({ length: len }, (_, k) => ramp(at + k, c))) };
        }
      },
      close() {},
    });
    const clip = makeClip('video', { assetId: 'a', in: 0.25 * US, duration: 79 * US });
    const out = await extractClipAudio(open, { id: 'a', name: 'Long.mp4' }, clip);
    const wav = await read(out.file);
    const first = 0.25 * RATE;
    expect(wav.channels[0].length).toBe(79 * RATE);
    expect(out.file.size).toBe(44 + 79 * RATE * 4);
    for (let i = 0; i < wav.channels[0].length; i += 997) {
      expect(wav.channels[0][i]).toBeCloseTo(ramp(first + i, 0), 3);
      expect(wav.channels[1][i]).toBeCloseTo(ramp(first + i, 1), 3);
    }
  });

  it('returns null without sound', async () => {
    const clip = makeClip('video', { assetId: 'a', duration: US });
    expect(await extractClipAudio(opener({ silent: true }), { id: 'a' }, clip)).toBe(null);
  });
});
