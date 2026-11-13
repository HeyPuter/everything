// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { zipBlob, zipBytes, unzipStore } from '../src/io/zip.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('builds a ZIP Blob without allocating another archive-sized byte array', async () => {
  // Four MiB bounds this allocation check independently of project/audio size.
  const files = Array.from({ length: 8 }, (_, i) => ({ name: `${i}.wav`, data: new Uint8Array(512 * 1024).fill(i) }));
  const payloadBytes = files.reduce((n, f) => n + f.data.byteLength, 0);
  const ByteArray = Uint8Array;
  const allocations = [];
  vi.stubGlobal('Uint8Array', new Proxy(ByteArray, {
    construct(target, args) {
      if (typeof args[0] === 'number') allocations.push(args[0]);
      return Reflect.construct(target, args, target);
    },
  }));
  const blob = zipBlob(files);
  vi.unstubAllGlobals();
  expect(blob.type).toBe('application/zip');
  expect(blob.size).toBeGreaterThan(payloadBytes);
  expect(allocations.filter((n) => n >= payloadBytes)).toEqual([]);
  const unpacked = unzipStore(await blob.arrayBuffer());
  expect(unpacked.size).toBe(files.length);
  for (const { name, data } of files) expect(Buffer.compare(unpacked.get(name), data)).toBe(0);
});

it.each([
  { name: 'empty', files: [] },
  { name: 'Unicode names and empty files', files: [{ name: '音楽/Écho.wav', data: new Uint8Array([0, 1, 2, 255]) }, { name: 'empty.wav', data: new Uint8Array() }] },
])('keeps the Blob archive byte-identical to the byte writer: $name', async ({ files }) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-13T09:00:00Z'));
  const expected = zipBytes(files);
  const blob = zipBlob(files);
  expect(Buffer.compare(new Uint8Array(await blob.arrayBuffer()), expected)).toBe(0);
});
