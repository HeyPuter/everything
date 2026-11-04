import { it, expect, vi, afterEach } from 'vitest';

vi.mock('../src/collab/auth.js', async (importOriginal) => ({ ...await importOriginal(), authorize: async () => ({ 'puter-auth': 'restricted', 'x-documents-proof': '{}' }) }));
const { call } = await import('../src/collab/api.js');

afterEach(() => { vi.useRealTimers(); });

/**
 * A change carrying a picture is megabytes: on a slow connection its upload takes longer than a small request's
 * 30 seconds. Cut off at 30 s it failed, was sent again and failed again, and everything queued behind it waited.
 */
it('gives a large change time to upload before giving up on it', async () => {
  vi.useFakeTimers();
  let signal;
  const puter = { workers: { exec: (url, init) => { signal = init.signal; return new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    setTimeout(() => resolve(new Response(JSON.stringify({ seq: 1 }))), 90_000);
  }); } } };
  const update = 'A'.repeat(4_000_000);
  const result = call(puter, 'https://documents-abc.puter.work', { op: 'commit', room: 'room1', update });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  await expect(result).resolves.toEqual({ seq: 1 });
});

it('still gives up on a small request that does not answer', async () => {
  vi.useFakeTimers();
  const puter = { workers: { exec: (url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); }) } };
  const result = call(puter, 'https://documents-abc.puter.work', { op: 'sync', room: 'room1' });
  const settled = expect(result).rejects.toThrow(/Could not reach/);
  await vi.advanceTimersByTimeAsync(31_000);
  await settled;
});
