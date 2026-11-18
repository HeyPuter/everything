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
  it.each(['forget', 'dispose'])('ignores an in-flight frame after %s', async action => {
    const onFrame = vi.fn();
    const fs = new FrameSource({ onFrame, blobFor: async () => new Blob(['x']) });
    const asset = { id: 'a' };
    fs.request(asset, 0);
    await flush();
    onFrame.mockClear();
    let release;
    fs.entries.get(asset.id).sink.getCanvas = () => new Promise(resolve => { release = resolve; });
    fs.request(asset, 1);
    await flush();
    fs[action](asset.id);
    release({ canvas: {}, timestamp: 1 });
    await flush();
    expect(onFrame).not.toHaveBeenCalled();
    expect(fs.any(asset)).toBeNull();
    fs.dispose();
  });

  it.each(['forget', 'dispose'])('closes an in-flight frame pair after %s', async action => {
    const onFrame = vi.fn();
    const fs = new FrameSource({ onFrame, blobFor: async () => new Blob(['x']) });
    const asset = { id: 'a' };
    fs.request(asset, 0);
    await flush();
    onFrame.mockClear();
    let release;
    const iterator = {
      next: vi.fn(() => new Promise(resolve => { release = resolve; })),
      return: vi.fn(async () => ({ done: true })),
    };
    fs.entries.get(asset.id).pairSink.canvases = () => iterator;
    fs.pair(asset, 1);
    await flush();
    fs[action](asset.id);
    release({ done: false, value: { canvas: {}, timestamp: 1 } });
    await flush();
    expect(iterator.next).toHaveBeenCalledTimes(1);
    expect(iterator.return).toHaveBeenCalledTimes(1);
    expect(onFrame).not.toHaveBeenCalled();
    fs.dispose();
  });

  it('ignores frame requests after disposal', async () => {
    const blobFor = vi.fn(async () => new Blob(['x']));
    const fs = new FrameSource({ blobFor });
    fs.dispose();
    fs.request({ id: 'a' }, 0);
    expect(fs.pair({ id: 'b' }, 0)).toBeNull();
    await flush();
    expect(blobFor).not.toHaveBeenCalled();
    expect(fs.entries.size).toBe(0);
  });

  it('does not retry a forgotten file whose pending read failed', async () => {
    vi.useFakeTimers();
    let rejectRead;
    const onFrame = vi.fn();
    const fs = new FrameSource({ onFrame, blobFor: () => new Promise((_, reject) => { rejectRead = reject; }) });
    fs.request({ id: 'a' }, 0);
    fs.forget('a');
    rejectRead(new Error('network'));
    await flush();
    vi.advanceTimersByTime(2000);
    expect(onFrame).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    fs.dispose();
  });

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
