import { afterEach, describe, it, expect, vi } from 'vitest';
import * as P from '../src/lib/puter.js';
afterEach(() => vi.unstubAllGlobals());
describe('Puter file storage', () => {
  it('stores real PDF blobs, deduplicates new names, and overwrites only explicit paths', async () => {
    const write = vi.fn().mockResolvedValue({ path: 'PDF Editor/a.pdf' });
    vi.stubGlobal('puter', { fs: { write } });
    await P.saveFile('a', new Uint8Array([37, 80, 68, 70]));
    expect(write.mock.calls[0][0]).toBe('PDF Editor/a.pdf');
    expect(write.mock.calls[0][1]).toBeInstanceOf(Blob);
    expect(write.mock.calls[0][1].type).toBe('application/pdf');
    expect(write.mock.calls[0][2]).toEqual({
      overwrite: false,
      dedupeName: true,
      createMissingParents: true,
    });
    await P.saveFile('a', new Uint8Array([1]), '/user/a.pdf');
    expect(write.mock.calls[1][2]).toMatchObject({ overwrite: true, dedupeName: false });
  });
  it('turns a closed sign-in dialog into a quiet cancel and other SDK objects into errors', async () => {
    const signIn = vi
      .fn()
      .mockRejectedValueOnce({
        error: 'auth_window_closed',
        msg: 'Authentication window was closed',
      })
      .mockRejectedValueOnce({ error: 'server', msg: 'Puter is down' })
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('puter', { auth: { signIn, getUser: async () => ({ username: 'u' }) } });
    const cancelled = await P.signIn().catch((e) => e);
    expect(cancelled).toBeInstanceOf(Error);
    expect(P.isSignInCancelled(cancelled)).toBe(true);
    const failed = await P.signIn().catch((e) => e);
    expect(failed.message).toBe('Puter is down');
    expect(P.isSignInCancelled(failed)).toBe(false);
    await expect(P.signIn()).rejects.toThrow('offline');
  });
  it('never signs out from the Puter app environment', async () => {
    const signOut = vi.fn();
    vi.stubGlobal('puter', { env: 'app', auth: { signOut } });
    await P.signOut();
    expect(signOut).not.toHaveBeenCalled();
  });
  it('distinguishes a missing library from permission errors', async () => {
    const readdir = vi.fn().mockRejectedValue({ code: 'subject_does_not_exist' });
    vi.stubGlobal('puter', { fs: { readdir } });
    expect(await P.listFiles()).toEqual([]);
    readdir.mockRejectedValue(new Error('Permission denied'));
    await expect(P.listFiles()).rejects.toThrow('Permission denied');
  });
  it('filters directories and non-PDF files', async () => {
    vi.stubGlobal('puter', {
      fs: {
        readdir: async () => [
          { name: 'a.PDF' },
          { name: 'b.pdf', is_dir: true },
          { name: 'c.txt' },
        ],
      },
    });
    expect(await P.listFiles()).toEqual([{ name: 'a.PDF', path: 'PDF Editor/a.PDF' }]);
  });
});
describe('Puter session', () => {
  it('treats the desktop as signed in without asking, and a missing SDK as signed out', async () => {
    vi.stubGlobal('puter', { env: 'app', auth: { isSignedIn: () => false } });
    expect(await P.isSignedIn()).toBe(true);
    vi.stubGlobal('puter', { env: 'web', auth: { isSignedIn: () => false } });
    expect(await P.isSignedIn()).toBe(false);
    vi.stubGlobal('puter', { env: 'web', auth: { isSignedIn: async () => true } });
    expect(await P.isSignedIn()).toBe(true);
    vi.stubGlobal('puter', undefined);
    expect(await P.isSignedIn()).toBe(false);
  });
  it('hands the SDK a handler for the sign-ins it performs on its own', () => {
    const sdk = { env: 'web' };
    vi.stubGlobal('puter', sdk);
    const handler = () => {};
    P.onAuth(handler);
    expect(sdk.onAuth).toBe(handler);
    vi.stubGlobal('puter', undefined);
    expect(() => P.onAuth(handler)).not.toThrow();
  });
});

describe('bounded cloud reads', () => {
  it('rejects an oversized Blob before allocating its byte buffer', async () => {
    const arrayBuffer = vi.fn().mockResolvedValue(new Uint8Array([37, 80, 68, 70]).buffer);
    vi.stubGlobal('puter', {
      fs: { read: vi.fn().mockResolvedValue({ size: 100 * 1024 * 1024 + 1, arrayBuffer }) },
    });
    await expect(P.readFile('large.pdf', { maxBytes: 100 * 1024 * 1024 })).rejects.toThrow(
      'Choose a PDF smaller than 100 MB.',
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it('accepts a file at the limit and preserves its bytes', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const read = vi.fn().mockResolvedValue(new Blob([bytes]));
    vi.stubGlobal('puter', { fs: { read } });
    expect(await P.readFile('small.pdf', { maxBytes: bytes.length })).toEqual(bytes);
    expect(read).toHaveBeenCalledWith('small.pdf');
  });
  it('leaves ordinary library reads unrestricted', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    vi.stubGlobal('puter', {
      fs: {
        read: async () => ({ size: 100 * 1024 * 1024 + 1, arrayBuffer: async () => bytes.buffer }),
      },
    });
    expect(await P.readFile('large.pdf')).toEqual(bytes);
  });
});

it('does not request a cloud file when its read is already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const read = vi.fn();
  vi.stubGlobal('puter', { fs: { read } });
  await expect(P.readFile('old.pdf', { signal: controller.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(read).not.toHaveBeenCalled();
});
for (const phase of ['cloud', 'buffer'])
  for (const cancelled of [false, true])
    it(`${cancelled ? 'cancels' : 'completes'} a read waiting for its ${phase}`, async () => {
      const controller = new AbortController();
      const bytes = new Uint8Array([37, 80, 68, 70]);
      let release, entered;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const waiting = new Promise((resolve) => {
        entered = resolve;
      });
      const hold = async (value) => {
        entered();
        await gate;
        return value;
      };
      const arrayBuffer = vi.fn(async () =>
        phase === 'buffer' ? hold(bytes.buffer) : bytes.buffer,
      );
      const file = { size: bytes.length, arrayBuffer };
      vi.stubGlobal('puter', { fs: { read: async () => (phase === 'cloud' ? hold(file) : file) } });
      const result = P.readFile('old.pdf', {
        maxBytes: bytes.length,
        signal: controller.signal,
      }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waiting;
      if (cancelled) controller.abort();
      release();
      const settled = await result;
      if (cancelled) expect(settled.error).toMatchObject({ name: 'AbortError' });
      else expect(settled.value).toEqual(bytes);
      expect(arrayBuffer).toHaveBeenCalledTimes(cancelled && phase === 'cloud' ? 0 : 1);
    });
describe('Puter desktop files', () => {
  it('describes files with millisecond times, and tells a missing file from a failure', async () => {
    expect(P.fileInfo({ path: '/u/a.pdf', uid: 'x', size: '12', modified: 1700000000 })).toEqual({
      path: '/u/a.pdf',
      name: 'a.pdf',
      uid: 'x',
      size: 12,
      modified: 1700000000000,
      dir: false,
    });
    expect(P.fileInfo({ path: '/u/b', is_dir: true }).dir).toBe(true);
    expect(P.fileInfo(null)).toBeNull();
    const stat = vi
      .fn()
      .mockResolvedValueOnce({ path: '/u/a.pdf', modified: 1700000000000 })
      .mockRejectedValueOnce({ code: 'subject_does_not_exist' })
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('puter', { fs: { stat } });
    expect(P.canStat()).toBe(true);
    expect((await P.statFile('/u/a.pdf')).modified).toBe(1700000000000);
    expect(await P.statFile({ uid: 'x' })).toBeNull();
    await expect(P.statFile('/u/a.pdf')).rejects.toThrow('offline');
    expect(P.inTrash('/u/Trash/a.pdf')).toBe(true);
    expect(P.inTrash('/u/Documents/Trash notes.pdf')).toBe(false);
  });
  it('names and closes only a desktop window that can close again', () => {
    const setWindowTitle = vi.fn(),
      onWindowClose = vi.fn();
    vi.stubGlobal('puter', { env: 'web', ui: { setWindowTitle, onWindowClose } });
    P.setWindowTitle('a.pdf');
    expect(setWindowTitle).not.toHaveBeenCalled();
    vi.stubGlobal('puter', { env: 'app', ui: { setWindowTitle, onWindowClose } });
    expect(P.onWindowClose(() => {})).toBe(false);
    P.setWindowTitle('a.pdf');
    P.setWindowTitle('a.pdf');
    expect(setWindowTitle).toHaveBeenCalledTimes(1);
    vi.stubGlobal('puter', { env: 'app', ui: { onWindowClose }, exit: () => {} });
    expect(P.onWindowClose(() => {})).toBe(true);
    expect(onWindowClose).toHaveBeenCalledTimes(1);
  });
});
describe('lost connections', () => {
  // Chrome, Firefox, and Safari each word a request that never reached Puter their own way.
  const browserWords = [
    new TypeError('Failed to fetch'),
    new TypeError('NetworkError when attempting to fetch resource.'),
    new TypeError('Load failed'),
    { error: { message: 'Failed to fetch' } },
  ];
  it.each(browserWords)('says what could not be done and what to do: %s', async (failure) => {
    const fail = () => Promise.reject(failure);
    vi.stubGlobal('puter', {
      fs: { read: fail, write: fail, rename: fail, delete: fail },
      ui: { showSaveFilePicker: fail },
    });
    const advice = 'because the connection to Puter failed.';
    await expect(P.readFile('PDF Editor/a.pdf')).rejects.toThrow(
      `The PDF could not be read ${advice} Check your connection and try again.`,
    );
    await expect(P.readBlob('Pictures/a.png')).rejects.toThrow(
      `The file could not be read ${advice}`,
    );
    for (const save of [P.saveFile('a', new Uint8Array([1])), P.saveAs('a', new Uint8Array([1]))])
      await expect(save).rejects.toThrow(
        `The PDF could not be saved ${advice} Your changes are still here. Check your connection and try again.`,
      );
    await expect(P.renameFile('PDF Editor/a.pdf', 'b')).rejects.toThrow(
      `could not be renamed ${advice}`,
    );
    await expect(P.deleteFile('PDF Editor/a.pdf')).rejects.toThrow(
      `could not be deleted ${advice}`,
    );
  });
  it("keeps Puter's own reasons as they are", async () => {
    const refusal = { code: 'storage_limit_reached', message: 'Storage capacity limit reached.' };
    vi.stubGlobal('puter', { fs: { write: () => Promise.reject(refusal) } });
    await expect(P.saveFile('a', new Uint8Array([1]))).rejects.toBe(refusal);
  });
});
