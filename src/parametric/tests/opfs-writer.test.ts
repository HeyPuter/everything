import { describe, expect, it } from 'vitest';

// The worker module sets self.onmessage when it loads.
(globalThis as unknown as { self: unknown }).self ??= globalThis;
const { writeAll } = await import('../src/platform/opfs-writer');

/** A file on a disk with room for `capacity` bytes. */
function file(contents: string, capacity: number) {
  let data = new TextEncoder().encode(contents);
  const quota = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
  return {
    get text() { return new TextDecoder().decode(data); },
    handle: {
      getSize: () => data.length,
      truncate(size: number) {
        if (size > capacity) throw quota();
        const next = new Uint8Array(size);
        next.set(data.subarray(0, size));
        data = next;
      },
      write(chunk: Uint8Array, { at }: { at: number }) {
        if (at + chunk.length > capacity) throw quota();
        if (at + chunk.length > data.length) this.truncate(at + chunk.length);
        data.set(chunk, at);
        return chunk.length;
      },
      flush() {},
      close() {},
    },
  };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe('browser storage writes from a worker', () => {
  it('replaces longer and shorter contents exactly', async () => {
    const f = file('the old contents', 1000);
    await writeAll(f.handle, bytes('new'));
    expect(f.text).toBe('new');
    await writeAll(f.handle, bytes('a longer new text than before'));
    expect(f.text).toBe('a longer new text than before');
  });

  it('keeps the old contents when the disk has no room for the new ones', async () => {
    const f = file('saved part', 20);
    await expect(writeAll(f.handle, bytes('a part too large for the room left'))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(f.text).toBe('saved part');
  });
});
