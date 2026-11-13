import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaService } from '../src/media/media-service.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const video = { id: 'v', hash: 'video', kind: 'video', duration: 2_000_000 };
function workers() {
  const made = [];
  vi.stubGlobal('Worker', class {
    constructor() { made.push(this); }
    postMessage = vi.fn();
    terminate = vi.fn();
  });
  return made;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('media service disposal', () => {
  it('does not start decoding when a thumbnail read finishes after exit', async () => {
    vi.useFakeTimers();
    const made = workers();
    let finish;
    const service = new MediaService({ mediaBlob: () => new Promise((resolve) => { finish = resolve; }) });
    service.thumb(video, 0, 1);
    await vi.advanceTimersByTimeAsync(16);
    service.dispose();
    finish(new Blob(['video']));
    await flush();
    expect(made).toHaveLength(0);
    expect(service.pending.size).toBe(0);
    expect(service.queue).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles outstanding waveform requests and clears pending jobs on exit', async () => {
    const made = workers();
    const service = new MediaService({ mediaBlob: async () => new Blob(['audio']) });
    const changed = vi.fn();
    service.on('peaks', changed);
    let result;
    service.peaks(video).then((value) => { result = value; });
    await flush();
    expect(made[0].postMessage).toHaveBeenCalledTimes(1);
    service.dispose();
    await flush();
    expect(result).toMatchObject({ duration: 0 });
    expect(service.pending.size).toBe(0);
    expect(service.peakCache.size).toBe(0);
    expect(made[0].terminate).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it('closes an image bitmap that finishes decoding after exit', async () => {
    let finish;
    vi.stubGlobal('createImageBitmap', () => new Promise((resolve) => { finish = resolve; }));
    const service = new MediaService({ mediaBlob: async () => new Blob(['image']) });
    const changed = vi.fn();
    service.on('poster', changed);
    const poster = service.poster({ ...video, kind: 'image' });
    await flush();
    service.dispose();
    const bitmap = { close: vi.fn() };
    finish(bitmap);
    expect(await poster).toBeNull();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
  });

  it('caches normal thumbnail and waveform replies until disposal', async () => {
    vi.useFakeTimers();
    const made = workers();
    const service = new MediaService({ mediaBlob: async () => new Blob(['video']) });
    service.thumb(video, 0, 1);
    await vi.advanceTimersByTimeAsync(16);
    const worker = made[0];
    const { id } = worker.postMessage.mock.calls[0][0];
    const bitmap = { close: vi.fn() };
    worker.onmessage({ data: { id, partial: { index: 0, bitmap } } });
    worker.onmessage({ data: { id, ok: true } });
    await flush();
    expect(service.thumb(video, 0, 1)).toBe(bitmap);
    const peaks = service.peaks(video);
    await flush();
    const peaksId = worker.postMessage.mock.calls[1][0].id;
    const result = { rate: 100, data: new Float32Array([0, 1]), duration: 1 };
    worker.onmessage({ data: { id: peaksId, ok: true, result } });
    expect(await peaks).toBe(result);
    expect(service.peaksNow(video)).toBe(result);
    expect(service.pending.size).toBe(0);
    service.dispose();
    service.dispose();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    service.thumb(video, 0, 1);
    expect(await service.poster(video)).toBeNull();
    await service.peaks(video);
    expect(service.peakCache.size).toBe(0);
    expect(made).toHaveLength(1);
  });

  it('releases a partial video poster when its worker is terminated', async () => {
    const made = workers();
    const service = new MediaService({ mediaBlob: async () => new Blob(['video']) });
    const poster = service.poster(video);
    await flush();
    const bitmap = { close: vi.fn() };
    const { id } = made[0].postMessage.mock.calls[0][0];
    made[0].onmessage({ data: { id, partial: { bitmap } } });
    service.dispose();
    await flush();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(await poster).toBeNull();
  });
});

describe('media worker failures', () => {
  it.each(['error', 'messageerror'])('settles and retries waveform jobs after a worker %s', async (type) => {
    vi.useFakeTimers();
    const made = workers();
    const service = new MediaService({ mediaBlob: async () => new Blob(['audio']) });
    let result;
    service.peaks(video).then((value) => { result = value; });
    await flush();
    made[0][`on${type}`]?.({ message: 'Worker failed', preventDefault() {} });
    await flush();
    expect(result).toMatchObject({ duration: 0 });
    expect(service.pending.size).toBe(0);
    expect(made[0].terminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    const retry = service.peaks(video);
    await flush();
    expect(made).toHaveLength(2);
    const { id } = made[1].postMessage.mock.calls[0][0];
    const recovered = { rate: 100, data: new Float32Array([0, 1]), duration: 1 };
    made[1].onmessage({ data: { id, ok: true, result: recovered } });
    expect(await retry).toBe(recovered);
    service.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries thumbnail and poster jobs after failure and cancels retries on exit', async () => {
    vi.useFakeTimers();
    const made = workers();
    const service = new MediaService({ mediaBlob: async () => new Blob(['video']) });
    service.thumb(video, 0, 1);
    const firstPoster = service.poster(video);
    await vi.advanceTimersByTimeAsync(16);
    made[0].onerror?.({ message: 'Worker failed' });
    await flush();
    expect(await firstPoster).toBeNull();
    expect(service.busy).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.thumb(video, 0, 1)).toBeNull();
    const poster = service.poster(video);
    await vi.advanceTimersByTimeAsync(16);
    expect(made).toHaveLength(2);
    const worker = made[1];
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    const bitmap = { close: vi.fn() };
    const thumbBitmap = { close: vi.fn() };
    for (const [message] of worker.postMessage.mock.calls) {
      const image = message.height === 240 ? bitmap : thumbBitmap;
      worker.onmessage({ data: { id: message.id, partial: { index: 0, bitmap: image } } });
      worker.onmessage({ data: { id: message.id, ok: true } });
    }
    expect(await poster).toBe(bitmap);
    expect(service.thumb(video, 0, 1)).toBe(thumbBitmap);
    // A later failure queues a retry, which exiting must cancel.
    service.peaks(video);
    await flush();
    worker.onerror({ message: 'Worker failed again' });
    await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    service.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(made).toHaveLength(2);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(thumbBitmap.close).toHaveBeenCalledTimes(1);
  });

  it.each(['construct', 'post'])('removes requests whose worker dispatch fails during %s', async (where) => {
    vi.stubGlobal('Worker', class {
      constructor() { if (where === 'construct') throw new Error('Cannot start worker'); }
      postMessage() { throw new Error('Cannot send request'); }
      terminate() {}
    });
    const service = new MediaService({ mediaBlob: async () => new Blob(['audio']) });
    const result = await service.peaks(video);
    expect(result.duration).toBe(0);
    expect(service.pending.size).toBe(0);
    service.dispose();
  });
});
