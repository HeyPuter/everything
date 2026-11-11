import { describe, it, expect, vi } from 'vitest';

// A 30 fps file whose container stores times in whole milliseconds (WebM, MKV): frame i at round(i / 30, 3).
const FPS = 30;
const N = 60;
const ts = (i) => Math.round((i / FPS) * 1000) / 1000;
const frameAt = (sec) => {
  let k = 0;
  while (k + 1 < N && ts(k + 1) <= sec) k++;
  return k;
};

vi.mock('mediabunny', () => {
  const canvas = (i) => ({ canvas: { frame: i }, timestamp: ts(i) });
  const sample = (i) => ({ timestamp: ts(i), frame: i, displayWidth: 16, displayHeight: 16, close() {}, toVideoFrame: () => ({ frame: i, close() {} }) });
  return {
    ALL_FORMATS: [],
    BlobSource: class {},
    Input: class {
      async getPrimaryVideoTrack() {
        return { canDecode: async () => true, getFirstTimestamp: async () => 0 };
      }
      dispose() {}
    },
    CanvasSink: class {
      async getCanvas(sec) {
        return canvas(frameAt(sec));
      }
      async *canvases(sec) {
        for (let i = frameAt(sec); i < N; i++) yield canvas(i);
      }
      async *canvasesAtTimestamps(times) {
        for (const t of times) yield canvas(frameAt(t));
      }
    },
    VideoSampleSink: class {
      async *samples(sec) {
        for (let i = frameAt(sec); i < N; i++) yield sample(i);
      }
    },
  };
});

const { ClipFrames } = await import('../src/engine/exporter.js');
const { FrameSource } = await import('../src/engine/frame-source.js');

// The timeline asks for frame i at its whole-microsecond time.
const asked = (i) => Math.round((i * 1e6) / FPS) / 1e6;

describe('frames from files with millisecond timestamps', () => {
  it('exports every frame once, without repeats or skips', async () => {
    const frames = new ClipFrames({ id: 'c' }, { getFirstTimestamp: async () => 0 });
    const got = [];
    for (let i = 0; i < N; i++) got.push((await frames.at(asked(i))).source.frame);
    await frames.close();
    expect(got).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it('shows the same frames in the paused preview', async () => {
    const fs = new FrameSource({ library: null, blobFor: async () => new Blob(), onFrame: () => {} });
    const asset = { id: 'a', height: 16 };
    const got = [];
    for (let i = 0; i < N; i++) {
      fs.request(asset, asked(i));
      await vi.waitFor(() => expect(fs.get(asset, asked(i), 1e-4)).toBeTruthy());
      got.push(fs.get(asset, asked(i), 1e-4).canvas.frame);
      fs.pair(asset, asked(i));
      await vi.waitFor(() => expect(fs.pair(asset, asked(i))).toBeTruthy());
      expect(fs.pair(asset, asked(i)).a.canvas.frame).toBe(i);
    }
    fs.dispose();
    expect(got).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  it('reads the same frames for tracking, flicker and color analysis', async () => {
    // Analysis canvases: a 2x2 frame whose pixels hold the frame number.
    globalThis.OffscreenCanvas = class {
      getContext() {
        let f = 0;
        return { drawImage: (c) => (f = c.frame), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(f) }) };
      }
    };
    try {
      const { grayFrames } = await import('../src/media/tracker.js');
      const { rgbaFrames } = await import('../src/media/frame-sampler.js');
      const times = Array.from({ length: N }, (_, i) => Math.round((i * 1e6) / FPS));
      const want = times.map((_, i) => i);
      const gray = [];
      for await (const { frame } of grayFrames(new Blob(), times, { tw: 2, th: 2 })) gray.push(Math.round(frame[0] * 255));
      expect(gray).toEqual(want);
      const rgba = [];
      for await (const { data } of rgbaFrames(new Blob(), times, { width: 2, height: 2 })) rgba.push(data[0]);
      expect(rgba).toEqual(want);
    } finally {
      delete globalThis.OffscreenCanvas;
    }
  });
});

