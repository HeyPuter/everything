import { describe, it, expect, vi } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { ChunkStore, renderBlock, createScratch } from '../src/engine/mixcore.js';

/** An engine wired to a fake worklet port that records what it is sent. */
function fakeEngine() {
  const e = new Engine();
  const sent = [];
  e.ctx = { currentTime: 1, outputLatency: 0, baseLatency: 0, state: 'running' };
  e.requestedRate = 48000;
  e.node = { port: { postMessage: vi.fn((m) => sent.push(m)) } };
  return { e, sent };
}

describe('engine transport', () => {
  it('seeks and plays on whole frames, so the mixer never reads NaN samples', async () => {
    const { e, sent } = fakeEngine();
    e.state = 'playing';
    e.lastPos = { frame: 1000, time: 0.99 };
    // The interpolated position is fractional (the loudness meter reset seeks to it).
    expect(Number.isInteger(e.position)).toBe(false);
    e.seek(e.position);
    const seek = sent.find((m) => m.type === 'seek');
    expect(Number.isInteger(seek.frame)).toBe(true);
    await e.play({ from: 10.6, to: 99.2, loop: { start: 0.4, end: 50.5 } });
    const play = sent.find((m) => m.type === 'play');
    expect(play).toMatchObject({ from: 11, to: 99, loop: { start: 0, end: 51 } });
    // What the mixer renders from that seek is real audio.
    const store = new ChunkStore();
    store.put('a', 0, [new Float32Array(32768).fill(0.5)]);
    const graph = {
      rate: 48000,
      master: { gain: 1 },
      tracks: [
        {
          id: 1,
          gain: 1,
          pan: 0,
          clips: [
            { id: 'c', source: 'a', channels: 1, start: 0, offset: 0, length: 32768, gain: 1 },
          ],
        },
      ],
    };
    const out = [new Float32Array(128), new Float32Array(128)];
    renderBlock(graph, store, seek.frame, 128, out, createScratch());
    expect(out[0][0]).toBe(0.5);
    e.stop();
  });
});
