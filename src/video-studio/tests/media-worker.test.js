import { describe, it, expect, vi, beforeAll } from 'vitest';

// Fake decoded audio: 1 s blocks of a constant level per block, at the given timestamps.
let blocks = [];
vi.mock('mediabunny', () => {
  class Input {
    async getPrimaryAudioTrack() {
      return { canDecode: async () => true };
    }
    dispose() {}
  }
  class AudioSampleSink {
    async *samples() {
      for (const { t, v } of blocks) {
        const n = 100;
        yield {
          numberOfFrames: n, numberOfChannels: 1, sampleRate: 100, timestamp: t, duration: n / 100,
          copyTo: (plane) => plane.fill(v, 0, n),
          close() {},
        };
      }
    }
  }
  return { Input, BlobSource: class {}, ALL_FORMATS: [], CanvasSink: class {}, AudioSampleSink };
});
vi.mock('../src/media/dsp.js', async (orig) => ({ ...(await orig()), loadDsp: async () => {} }));

async function peaksFor(list) {
  blocks = list;
  const post = vi.spyOn(self, 'postMessage').mockImplementation(() => {});
  await self.onmessage({ data: { id: 1, op: 'peaks', blob: new Blob([]), rate: 10 } });
  const msg = post.mock.calls[0][0];
  post.mockRestore();
  return msg;
}

describe('waveform peaks worker', () => {
  beforeAll(async () => {
    await import('../src/workers/media-worker.js');
  });

  it('places blocks at their timestamps', async () => {
    const { ok, result } = await peaksFor([{ t: 0, v: 0.5 }, { t: 1, v: 0.25 }]);
    expect(ok).toBe(true);
    expect(result.data.length).toBe(40);
    expect(result.data[1]).toBeCloseTo(0.5);
    expect(result.data[21]).toBeCloseTo(0.25);
  });

  it('drops audio before zero (AAC priming) instead of failing', async () => {
    // AAC files start with a priming packet stamped slightly before zero.
    const { ok, result } = await peaksFor([{ t: -0.2, v: 0.5 }, { t: 0.8, v: 0.25 }]);
    expect(ok).toBe(true);
    expect(result.duration).toBeCloseTo(1.8);
    expect(result.data.length).toBe(36);
    expect(result.data[1]).toBeCloseTo(0.5);
    expect(result.data[2 * 7 + 1]).toBeCloseTo(0.5);
    expect(result.data[2 * 8 + 1]).toBeCloseTo(0.25);
  });
});
