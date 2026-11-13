import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportProject } from '../src/engine/exporter.js';
import { fixture, clip, onMain } from './helpers.js';

afterEach(() => vi.unstubAllGlobals());

function temporaryStorage({ writeError } = {}) {
  const chunks = [];
  let closed = false;
  let name;
  const writable = new WritableStream({
    write(data) {
      if (writeError) throw writeError;
      chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
    },
    close() { closed = true; },
  });
  // FileSystemWritableFileStream's convenience write method releases its lock.
  writable.write = async (data) => {
    const writer = writable.getWriter();
    try { await writer.write(data); } finally { writer.releaseLock(); }
  };
  const dir = {
    async *keys() {},
    getFileHandle: vi.fn(async (key) => {
      name = key;
      return {
        createWritable: async () => writable,
        getFile: async () => {
          expect(closed).toBe(true);
          return new Blob(chunks);
        },
      };
    }),
    removeEntry: vi.fn(async () => {}),
  };
  const getDirectory = vi.fn(async () => ({ getDirectoryHandle: async () => dir }));
  vi.stubGlobal('navigator', { storage: { getDirectory } });
  return { getDirectory, dir, chunks, name: () => name };
}

function silentProject() {
  const p = fixture();
  onMain(p, clip('image', 0, 0.01));
  return p;
}

describe('WAV temporary storage', () => {
  it('streams PCM to a requested file, matching memory output, and releases it afterwards', async () => {
    const storage = temporaryStorage();
    const p = silentProject();
    const memory = await exportProject(p, {}, { audioFormat: 'wav' }, { kind: 'audio', target: 'memory' });
    const file = await exportProject(p, {}, { audioFormat: 'wav' }, { kind: 'audio', target: 'file' });
    expect(storage.getDirectory).toHaveBeenCalledTimes(1);
    expect(storage.chunks).toHaveLength(2); // RIFF header and one PCM chunk
    expect(await file.blob.arrayBuffer()).toEqual(await memory.blob.arrayBuffer());
    expect(file.blob.size).toBe(44 + 480 * 4);
    expect(storage.dir.removeEntry).not.toHaveBeenCalled();
    await file.release();
    expect(storage.dir.removeEntry).toHaveBeenCalledWith(storage.name());
  });

  it('discards its temporary file when audio cannot be read', async () => {
    const storage = temporaryStorage();
    const p = fixture();
    onMain(p, clip('video', 0, 0.01));
    await expect(exportProject(p, { mediaBlob: async () => { throw new Error('Offline'); } }, { audioFormat: 'wav' }, { kind: 'audio', target: 'file' })).rejects.toThrow('Offline');
    expect(storage.getDirectory).toHaveBeenCalledTimes(1);
    expect(storage.dir.removeEntry).toHaveBeenCalledWith(storage.name());
  });

  it('automatically selects a file for a large WAV before reading audio', async () => {
    const storage = temporaryStorage();
    const p = fixture();
    onMain(p, clip('video', 0, 3600));
    // Stop at the first source read; the test allocates only the 44-byte header.
    await expect(exportProject(p, { mediaBlob: async () => { throw new Error('Stop before mixing'); } }, { audioFormat: 'wav' }, { kind: 'audio' })).rejects.toThrow('Stop before mixing');
    expect(storage.getDirectory).toHaveBeenCalledTimes(1);
    expect(storage.chunks).toHaveLength(1);
    expect(storage.chunks[0].length).toBe(44);
    expect(storage.dir.removeEntry).toHaveBeenCalledWith(storage.name());
  });

  it('keeps the memory fallback when temporary storage is unavailable', async () => {
    const storage = temporaryStorage();
    storage.getDirectory.mockRejectedValue(new Error('Storage unavailable'));
    const result = await exportProject(silentProject(), {}, { audioFormat: 'wav' }, { kind: 'audio', target: 'file' });
    expect(result.blob.size).toBe(44 + 480 * 4);
    const bytes = await result.blob.arrayBuffer();
    await result.release();
    expect(await result.blob.arrayBuffer()).toEqual(bytes);
    expect(storage.dir.getFileHandle).not.toHaveBeenCalled();
  });

  it('reports disk write failures and discards the temporary file', async () => {
    const storage = temporaryStorage({ writeError: new Error('Disk is full') });
    await expect(exportProject(silentProject(), {}, { audioFormat: 'wav' }, { kind: 'audio', target: 'file' })).rejects.toThrow('Disk is full');
    expect(storage.dir.removeEntry).toHaveBeenCalledWith(storage.name());
  });
});
