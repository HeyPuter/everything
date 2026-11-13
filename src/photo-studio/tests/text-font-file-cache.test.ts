import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

it('shares valid downloads and discards only the rejected face', async () => {
  const normal = new ArrayBuffer(8), italic = new ArrayBuffer(12), replacement = new ArrayBuffer(16);
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => normal })
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => italic })
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => replacement });
  vi.stubGlobal('fetch', fetch);
  const { loadFontFile, discardFontFile } = await import('../src/imaging/text/fonts');
  const a = loadFontFile('Inter'), b = loadFontFile('inter');
  expect(a).toBe(b);
  expect(await a).toBe(normal);
  expect(await loadFontFile('Inter', true)).toBe(italic);
  await discardFontFile('Inter', false, normal);
  expect(await loadFontFile('Inter', true)).toBe(italic);
  expect(await loadFontFile('Inter')).toBe(replacement);
  expect(await loadFontFile('Inter')).toBe(replacement);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('a delayed report about old bytes preserves a newer pending download', async () => {
  const old = new ArrayBuffer(8), fresh = new ArrayBuffer(8);
  let release!: (response: { ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }) => void;
  const pending = new Promise((resolve) => { release = resolve; });
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => old })
    .mockReturnValueOnce(pending);
  vi.stubGlobal('fetch', fetch);
  const { loadFontFile, discardFontFile } = await import('../src/imaging/text/fonts');
  await loadFontFile('Caveat');
  await discardFontFile('Caveat', false, old);
  const download = loadFontFile('Caveat');
  const stale = discardFontFile('Caveat', false, old);
  release({ ok: true, arrayBuffer: async () => fresh });
  await stale;
  expect(await download).toBe(fresh);
  expect(loadFontFile('Caveat')).toBe(download);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('unrelated rejected bytes and unknown families leave successful cache entries intact', async () => {
  const bytes = new ArrayBuffer(8);
  const fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => bytes });
  vi.stubGlobal('fetch', fetch);
  const { loadFontFile, discardFontFile } = await import('../src/imaging/text/fonts');
  const download = loadFontFile('Caveat');
  await download;
  await discardFontFile('Caveat', false, new ArrayBuffer(8));
  await discardFontFile('Unknown family', false, bytes);
  expect(loadFontFile('Caveat')).toBe(download);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('network failures remain retryable when a reader also discards old bytes', async () => {
  const bytes = new ArrayBuffer(8);
  const fetch = vi.fn()
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => bytes });
  vi.stubGlobal('fetch', fetch);
  const { loadFontFile, discardFontFile } = await import('../src/imaging/text/fonts');
  const download = loadFontFile('Caveat');
  const discarded = discardFontFile('Caveat', false, bytes);
  await expect(download).rejects.toThrow('Offline');
  await discarded;
  expect(await loadFontFile('Caveat')).toBe(bytes);
  expect(fetch).toHaveBeenCalledTimes(2);
});
