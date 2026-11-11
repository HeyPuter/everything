// Exact WebCodecs frames for the preview (Mediabunny stood in by fakes).
import { describe, it, expect, afterEach, vi } from 'vitest';

const inputs = [];
let decodable = true;
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  Input: class {
    constructor() {
      this.dispose = vi.fn();
      inputs.push(this);
    }
    async getPrimaryVideoTrack() {
      return { canDecode: async () => decodable };
    }
  },
  CanvasSink: class {
    async getCanvas(sec) {
      return { canvas: { width: 4, height: 4 }, timestamp: sec };
    }
  },
}));

const { FrameSource } = await import('../src/engine/frame-source.js');

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  inputs.length = 0;
  decodable = true;
});

describe('preview frames from a file that could not be read', () => {
  it('are decoded once the file can be read again, after a pause', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const onFrame = vi.fn();
    const fs = new FrameSource({ onFrame, blobFor: () => (++reads === 1 ? Promise.reject(new Error('network')) : Promise.resolve(new Blob(['x']))) });
    const asset = { id: 'a', height: 720 };
    fs.request(asset, 1);
    await flush();
    expect(fs.get(asset, 1, 0.01)).toBe(null);
    // Not read again at once (scrubbing asks every frame).
    fs.request(asset, 1);
    await flush();
    expect(reads).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(onFrame).toHaveBeenCalled();
    fs.request(asset, 1);
    await flush();
    expect(reads).toBe(2);
    expect(fs.get(asset, 1, 0.01)).not.toBe(null);
    fs.dispose();
  });

  it('gives up on a file that cannot be decoded', async () => {
    vi.useFakeTimers();
    decodable = false;
    let reads = 0;
    const fs = new FrameSource({ blobFor: () => (reads++, Promise.resolve(new Blob(['x']))) });
    const asset = { id: 'a' };
    fs.request(asset, 1);
    await flush();
    vi.advanceTimersByTime(120_000);
    fs.request(asset, 1);
    await flush();
    expect(reads).toBe(1);
    expect(inputs[0].dispose).toHaveBeenCalled();
  });
});

describe('closing the frame source', () => {
  it('closes a decoder that was still opening', async () => {
    let release;
    const fs = new FrameSource({ blobFor: () => new Promise((r) => (release = r)) });
    fs.request({ id: 'a' }, 1);
    await flush();
    fs.dispose();
    release(new Blob(['x']));
    await flush();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].dispose).toHaveBeenCalled();
  });

  it('closes a forgotten decoder that was still opening', async () => {
    let release;
    const fs = new FrameSource({ blobFor: () => new Promise((r) => (release = r)) });
    fs.request({ id: 'a' }, 1);
    await flush();
    fs.forget('a');
    release(new Blob(['x']));
    await flush();
    expect(inputs[0].dispose).toHaveBeenCalled();
    fs.dispose();
  });
});
