// Frame-by-frame renders (GIF export) load what the picture needs first.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inputLifecycle = vi.hoisted(() => ({ track: vi.fn(), dispose: vi.fn() }));
beforeEach(() => {
  inputLifecycle.dispose.mockClear();
  inputLifecycle.track.mockReset().mockResolvedValue({ getFirstTimestamp: async () => 0, canDecode: async () => true });
});

const seen = [];
const shown = []; // source frame drawn for each rendered frame
vi.mock('../src/engine/compositor.js', async () => {
  const { getLut } = await import('../src/engine/luts.js');
  return {
    Compositor: class {
      constructor(canvas, { resolve }) {
        this.resolve = resolve;
      }
      resize() {}
      render(layers) {
        seen.push(Boolean(getLut('lut1')));
        const media = layers.find((l) => l.kind === 'media');
        if (media) shown.push(this.resolve(media)?.source.frame);
        return true;
      }
      dispose() {}
    },
  };
});

// A 30 fps video file whose sample timestamps are exact multiples of 1/30 s.
vi.mock('mediabunny', async (orig) => {
  const real = await orig();
  const FPS = 30;
  const sample = (i) => ({ timestamp: i / FPS, displayWidth: 64, displayHeight: 36, toVideoFrame: () => ({ frame: i, close() {} }), close() {} });
  return {
    ...real,
    Input: class {
      async getPrimaryVideoTrack() {
        return inputLifecycle.track();
      }
      dispose() { inputLifecycle.dispose(); }
    },
    BlobSource: class {},
    VideoSampleSink: class {
      async *samples(from) {
        for (let i = Math.floor(from * FPS + 1e-9); i < 10 * FPS; i++) yield sample(i);
      }
    },
  };
});

import { renderFrames } from '../src/engine/exporter.js';
import { addClip, setSpeed } from '../src/model/timeline.js';
import { fixture, clip, onMain } from './helpers.js';

const CUBE = ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n');

describe('renderFrames', () => {
  it('loads the LUTs the project uses before the first frame', async () => {
    const p = fixture();
    addClip(p, clip('adjust', 0, 1, { grade: { lut: { id: 'lut1', amount: 100 } } }), { ripple: true, linkOverlays: true });
    const library = { readLut: vi.fn(async () => ({ text: CUBE, name: 'Teal' })) };
    for await (const f of renderFrames(p, library, { width: 64, height: 36, fps: 4 })) expect(f.canvas).toBeTruthy();
    expect(library.readLut).toHaveBeenCalledWith('lut1');
    expect(seen.length).toBe(4);
    expect(seen.every(Boolean)).toBe(true);
  });
});

describe('frame rendering responsiveness', () => {
  it('does not yield a frame when cancellation happens during media loading', async () => {
    const p = fixture();
    onMain(p, clip('video', 0, 0.01));
    const controller = new AbortController();
    const library = { mediaBlob: async () => { controller.abort(); return new Blob(['x']); } };
    const frames = renderFrames(p, library, { width: 64, height: 36, fps: 30, signal: controller.signal });
    try {
      await expect(frames.next()).rejects.toMatchObject({ name: 'AbortError' });
      expect(inputLifecycle.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await frames.return();
    }
  });

  it('lets a queued Cancel action interrupt a busy frame sequence', async () => {
    const p = fixture();
    onMain(p, clip('video', 0, 10));
    const controller = new AbortController();
    const before = seen.length;
    // Model a 20 ms frame without burning CPU; scheduler.yield gives queued
    // browser input a task boundary instead of another resolved microtask.
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (seen.length - before) * 20);
    vi.stubGlobal('scheduler', { yield: () => new Promise((resolve) => setTimeout(resolve, 0)) });
    const cancel = setTimeout(() => controller.abort(), 0);
    try {
      const render = async () => {
        for await (const frame of renderFrames(p, { mediaBlob: async () => new Blob(['x']) }, { width: 64, height: 36, fps: 30, signal: controller.signal })) void frame;
      };
      await expect(render()).rejects.toMatchObject({ name: 'AbortError' });
      expect(seen.length - before).toBeLessThan(300);
      expect(inputLifecycle.dispose).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(cancel);
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe('failed export media', () => {
  it.each(['missing track', 'track read failure', 'unsupported codec', 'decoder check failure'])('disposes the input after %s', async (failure) => {
    if (failure === 'missing track') inputLifecycle.track.mockResolvedValue(null);
    if (failure === 'track read failure') inputLifecycle.track.mockRejectedValue(new Error('Track read failed'));
    if (failure === 'unsupported codec') inputLifecycle.track.mockResolvedValue({ canDecode: async () => false });
    if (failure === 'decoder check failure') inputLifecycle.track.mockResolvedValue({ canDecode: async () => { throw new Error('Decoder check failed'); } });
    const p = fixture();
    onMain(p, clip('video', 0, 1));
    const frames = renderFrames(p, { mediaBlob: async () => new Blob(['x']) }, { width: 64, height: 36, fps: 4 });
    await expect(frames.next()).rejects.toThrow();
    expect(inputLifecycle.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('sped-up clips', () => {
  it('step through the source evenly at 3x (no frame repeated or skipped)', async () => {
    const p = fixture(); // 'vid' is 10 s
    const [c] = onMain(p, clip('video', 0, 10));
    setSpeed(p, c.id, 3);
    const library = { mediaBlob: async () => new Blob(['x']) };
    shown.length = 0;
    for await (const f of renderFrames(p, library, { width: 64, height: 36, fps: 30 })) void f;
    expect(inputLifecycle.dispose).toHaveBeenCalledTimes(1);
    expect(shown.length).toBe(100);
    expect(shown).toEqual(shown.map((_, i) => 3 * i));
  });
});
