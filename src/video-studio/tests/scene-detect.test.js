import { describe, it, expect, vi, afterEach } from 'vitest';
import { US } from '../src/lib/time.js';

// A 30 fps "video" of solid colors; frame i shows shot k where cuts[k - 1] <= i < cuts[k].
const FPS = 30;
const FRAMES = 180;
const CUTS = [31, 77, 140];
const COLORS = [[200, 50, 50], [50, 170, 50], [50, 50, 200], [200, 200, 50]];
const frameAt = (sec) => Math.min(FRAMES - 1, Math.floor(sec * FPS + 1e-6));
const canvas = (i) => ({ canvas: { color: COLORS[CUTS.filter((c) => i >= c).length] }, timestamp: i / FPS });

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  Input: class {
    async getPrimaryVideoTrack() {
      return { canDecode: async () => true };
    }
    dispose() {}
  },
  CanvasSink: class {
    async *canvasesAtTimestamps(times) {
      for (const t of times) yield canvas(frameAt(t));
    }
    async *canvases(start, end) {
      for (let i = frameAt(start); i / FPS < end && i < FRAMES; i++) yield canvas(i);
    }
  },
}));

class FakeOffscreen {
  getContext() {
    let color = [0, 0, 0];
    return {
      drawImage: (c) => (color = c.color),
      getImageData: (x, y, w, h) => ({ data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, k) => (k % 4 === 3 ? 255 : color[k % 4])) }),
    };
  }
}

afterEach(() => {
  delete globalThis.OffscreenCanvas;
});

describe('scene detection in a video', () => {
  it('puts each cut on the first frame of the new shot, not on the next sample', async () => {
    globalThis.OffscreenCanvas = FakeOffscreen;
    const { detectScenes } = await import('../src/media/smart-edit.js');
    const want = CUTS.map((c) => Math.round((c / FPS) * US));
    expect(await detectScenes(new Blob(), 0, 6 * US, { fps: 5 })).toEqual(want);
    expect(await detectScenes(new Blob(), 0.5 * US, 6 * US, { fps: 2 })).toEqual(want);
  });
});
