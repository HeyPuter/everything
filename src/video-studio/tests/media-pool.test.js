// The preview's pool of media elements and decoded images.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MediaPool } from '../src/engine/media-pool.js';

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a file that could not be read', () => {
  it('is read again after a pause instead of leaving its clip without picture and sound', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    let calls = 0;
    const urlFor = () => (++calls === 1 ? Promise.reject(new Error('network')) : Promise.resolve('blob:ok'));
    const onReady = vi.fn();
    const pool = new MediaPool({ library: {}, onReady, urlFor });
    const asset = { id: 'a1' };
    const clip = { id: 'c1' };
    pool.beginFrame();
    const first = pool.claim(clip, asset, 'video', 0);
    await flush();
    expect(first.el.getAttribute('src')).toBe(null);
    // Not before the pause is over.
    pool.beginFrame();
    expect(pool.claim(clip, asset, 'video', 0)).toBe(first);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(2000);
    // The pool asks for a redraw when the file may be read again...
    expect(onReady).toHaveBeenCalled();
    pool.beginFrame();
    const second = pool.claim(clip, asset, 'video', 0);
    await flush();
    // ...and the clip gets a fresh element that reads the file.
    expect(second).not.toBe(first);
    expect(calls).toBe(2);
    expect(second.el.getAttribute('src')).toBe('blob:ok');
    expect(pool.elements).toEqual([second]);
    pool.dispose();
  });

  it('retries a picture that failed to load, later', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const library = { mediaBlob: () => (++calls === 1 ? Promise.reject(new Error('network')) : Promise.resolve(new Blob(['x']))) };
    const bmp = { width: 2, height: 2, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(bmp)));
    const pool = new MediaPool({ library, onReady: () => {} });
    const asset = { id: 'img' };
    expect(pool.image(asset)).toBe(null);
    await flush();
    expect(pool.image(asset)).toBe(null);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(pool.image(asset)).toBe(null);
    await flush();
    expect(calls).toBe(2);
    expect(pool.image(asset)).toBe(bmp);
    pool.dispose();
    vi.unstubAllGlobals();
  });

  it('asks for no redraw once the pool is gone', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const onReady = vi.fn();
    const pool = new MediaPool({ library: {}, onReady, urlFor: () => Promise.reject(new Error('network')) });
    pool.beginFrame();
    pool.claim({ id: 'c' }, { id: 'a' }, 'video', 0);
    await flush();
    pool.dispose();
    vi.advanceTimersByTime(120_000);
    expect(onReady).not.toHaveBeenCalled();
  });
});
