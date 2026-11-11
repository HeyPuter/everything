import { describe, it, expect, vi, afterEach } from 'vitest';
import { exists, isNotFound } from '../src/storage/puter.js';
import { outputWriter } from '../src/batch/export-settings.js';

const downloads = vi.hoisted(() => []);
vi.mock('../src/storage/files.js', async (orig) => ({
  ...(await orig()),
  downloadBlob: (blob, name) => downloads.push([name, blob.size]),
}));

const notFound = [
  Object.assign(new Error('Item does not exist'), { code: 'subject_does_not_exist', status: 404 }),
  { code: 'subject_does_not_exist' },
  { error: { code: 'subject_does_not_exist', message: 'Not found' } },
  { status: 404 },
];

function fakePuter(stat) {
  window.puter = {
    auth: { isSignedIn: () => true, getUser: async () => ({ username: 'u' }) },
    fs: { stat: vi.fn(stat), write: vi.fn(async () => ({})) },
  };
  return window.puter;
}

describe('Puter file checks', () => {
  afterEach(() => delete window.puter);

  it('answers false only when Puter says the file does not exist', async () => {
    for (const err of notFound) {
      expect(isNotFound(err)).toBe(true);
      fakePuter(async () => Promise.reject(err));
      expect(await exists('/u/AudioStudio/a.wav')).toBe(false);
    }
    fakePuter(async () => ({ name: 'a.wav' }));
    expect(await exists('/u/AudioStudio/a.wav')).toBe(true);
    fakePuter(async () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(exists('/u/AudioStudio/a.wav')).rejects.toThrow(
      'Could not check whether "a.wav" already exists in Puter (Failed to fetch). Nothing was written.',
    );
    fakePuter(async () =>
      Promise.reject({ error: { code: 'internal_error', message: 'Server error' } }),
    );
    await expect(exists('/u/AudioStudio/a.wav')).rejects.toThrow('(Server error)');
  });

  it('batch output does not overwrite a file it could not check', async () => {
    const p = fakePuter(async () => Promise.reject(new TypeError('Failed to fetch')));
    const app = { notify: vi.fn() };
    const out = await outputWriter(app, { location: 'puter', dir: '/u/Out', collision: 'rename' });
    await expect(out.write('Take.wav', new Blob(['x']))).rejects.toThrow(
      'Could not check whether "Take.wav"',
    );
    expect(p.fs.write).not.toHaveBeenCalled();
    // A missing name is free: written as is.
    p.fs.stat.mockImplementation(async () => Promise.reject({ code: 'subject_does_not_exist' }));
    expect(await out.write('Take.wav', new Blob(['x']))).toBe('Take.wav');
    expect(p.fs.write).toHaveBeenCalledTimes(1);
  });

  it('batch downloads files separately when they are too large for one ZIP', async () => {
    downloads.length = 0;
    const app = { notify: vi.fn() };
    const out = await outputWriter(app, { location: 'download' });
    // 3 GB of output reported by the Blobs' sizes (no data is read before the check).
    for (const name of ['a.wav', 'b.wav'])
      await out.write(name, {
        size: 1.5 * 2 ** 30,
        arrayBuffer: () => Promise.reject(new Error('read')),
      });
    await out.write('c.wav', {
      size: 2 ** 30,
      arrayBuffer: () => Promise.reject(new Error('read')),
    });
    await out.finish('Batch Process.zip');
    expect(downloads.map((d) => d[0])).toEqual(['a.wav', 'b.wav', 'c.wav']);
    expect(app.notify.mock.calls[0][0]).toMatch(/more than 4 GB.*downloaded separately/);
    // Small batches still come as one ZIP.
    downloads.length = 0;
    const small = await outputWriter(app, { location: 'download' });
    await small.write('a.wav', new Blob(['x']));
    await small.write('b.wav', new Blob(['y']));
    await small.finish('Batch Process.zip');
    expect(downloads.map((d) => d[0])).toEqual(['Batch Process.zip']);
  });
});
