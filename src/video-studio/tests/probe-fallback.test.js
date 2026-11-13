import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probe } from '../src/media/probe.js';

// Exercise the browser-element fallback when the demuxer cannot read a file.
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  Input: class {
    getPrimaryVideoTrack() { return Promise.reject(new Error('unrecognized container')); }
    getPrimaryAudioTrack() { return Promise.resolve(null); }
    dispose() { this.disposed = true; }
  },
}));

let elements;
beforeEach(() => {
  elements = [];
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((name, ...args) => {
    const el = create(name, ...args);
    if (name === 'video' || name === 'audio') elements.push(el);
    return el;
  });
});
afterEach(() => vi.restoreAllMocks());

async function start() {
  const job = probe(new File(['media'], 'clip.webm', { type: 'video/webm' }));
  await vi.waitFor(() => expect(elements).toHaveLength(1));
  return { job, el: elements[0] };
}

describe('fallback media duration', () => {
  it.each(['success', 'error'])('unloads the temporary media element after %s', async (outcome) => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const { job, el } = await start();
    const url = el.src;
    const result = job.catch((error) => error);
    if (outcome === 'success') {
      Object.defineProperty(el, 'duration', { configurable: true, value: 2 });
      el.dispatchEvent(new Event('loadedmetadata'));
    } else el.dispatchEvent(new Event('error'));
    await result;
    expect(el.hasAttribute('src')).toBe(false);
    expect(el.load).toHaveBeenCalled();
    expect(el.onloadedmetadata).toBeNull();
    expect(el.onerror).toBeNull();
    expect(el.ontimeupdate).toBeNull();
    expect(revoke).toHaveBeenCalledWith(url);
  });

  it('rejects an error while seeking for an initially unknown duration', async () => {
    const { job, el } = await start();
    let error;
    job.catch((err) => { error = err; });
    Object.defineProperty(el, 'duration', { configurable: true, value: Infinity });
    el.dispatchEvent(new Event('loadedmetadata'));
    await vi.waitFor(() => expect(el.ontimeupdate).toBeTypeOf('function'));
    try {
      el.dispatchEvent(new Event('error'));
      await vi.waitFor(() => expect(error?.message).toBe('This file type is not supported by your browser.'), { timeout: 150 });
    } finally {
      // Settle the pre-fix hung promise too, so a failed regression leaves no work behind.
      el.dispatchEvent(new Event('timeupdate'));
      await job.catch(() => {});
    }
  });

  it.each([false, true])('reads a valid duration (seek needed: %s)', async (seek) => {
    const { job, el } = await start();
    Object.defineProperty(el, 'duration', { configurable: true, value: seek ? Infinity : 2 });
    el.dispatchEvent(new Event('loadedmetadata'));
    if (seek) {
      await vi.waitFor(() => expect(el.ontimeupdate).toBeTypeOf('function'));
      Object.defineProperty(el, 'duration', { configurable: true, value: 2 });
      el.dispatchEvent(new Event('timeupdate'));
    }
    expect(await job).toMatchObject({ kind: 'video', duration: 2_000_000, decodable: false });
  });
});
