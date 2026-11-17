// Sound that starts late in a file, or has a hole in it, keeps its place when it is decoded.
import { describe, it, expect } from 'vitest';
import { decodeClipSound } from '../src/media/audio-analysis.js';
import { extractClipAudio } from '../src/media/extract-audio.js';

const rate = 48000;
const tone = (seconds, level) => new Float32Array(Math.round(seconds * rate)).fill(level);
// 0.5 s of nothing, half a second of sound, a one second hole, then one more second.
const chunks = [
  { timestamp: 0.5, sampleRate: rate, channels: [tone(0.5, 0.1)] },
  { timestamp: 2.0, sampleRate: rate, channels: [tone(1, 0.2)] },
];
const open = async () => ({ sampleRate: rate, async *read() { yield* chunks; }, close() {} });
const clip = { in: 0, duration: 3e6, speed: 1, name: 'talk' };

describe('decoded sound with gaps', () => {
  it('is as long as the clip, with each part where it plays', async () => {
    const snd = await decodeClipSound(open, {}, clip);
    const mono = snd.channels[0];
    expect(mono.length).toBe(3 * rate);
    expect(mono[Math.round(0.25 * rate)]).toBe(0);
    expect(mono[Math.round(0.75 * rate)]).toBeCloseTo(0.1);
    expect(mono[Math.round(1.5 * rate)]).toBe(0);
    expect(mono[Math.round(2.5 * rate)]).toBeCloseTo(0.2);
  });

  it('is extracted to a file of the clip\'s length', async () => {
    const out = await extractClipAudio(open, { name: 'talk.mp4' }, clip);
    expect(out.seconds).toBeCloseTo(3, 3);
  });

  it('adds nothing between chunks that follow each other', async () => {
    const whole = [
      { timestamp: 0, sampleRate: rate, channels: [tone(1, 0.1)] },
      { timestamp: 1, sampleRate: rate, channels: [tone(1, 0.1)] },
    ];
    const src = async () => ({ sampleRate: rate, async *read() { yield* whole; }, close() {} });
    const snd = await decodeClipSound(src, {}, { ...clip, duration: 2e6 });
    expect(snd.channels[0].length).toBe(2 * rate);
  });
});
