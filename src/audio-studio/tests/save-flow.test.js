import { describe, it, expect, vi, afterEach } from 'vitest';

// Encoding runs in a worker in the app; here it resolves at once.
vi.mock('../src/export/export.js', () => ({
  exportAudio: async () => new Blob([new Uint8Array(64)]),
  isCancelled: (err) => err?.name === 'AbortError' || err?.message === 'Cancelled',
  cancelledError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
}));

const { saveDocument } = await import('../src/export/save.js');
const { AudioFile } = await import('../src/model/audio-file.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeApp() {
  return {
    setStatus: vi.fn(),
    notify: vi.fn(),
    prefs: { get: () => undefined, set: () => {} },
    emit: () => {},
  };
}

describe('saving to Puter', () => {
  afterEach(() => {
    delete window.puter;
    document.querySelectorAll('.dialog-backdrop').forEach((d) => d.remove());
  });

  it('does not mark a file saved when its upload fails after Cancel was pressed', async () => {
    let fail;
    window.puter = {
      auth: { isSignedIn: () => true },
      fs: { write: () => new Promise((_, reject) => (fail = reject)) },
    };
    const doc = AudioFile.blank({ name: 'Song.wav', sampleRate: 8000, channels: 1, seconds: 0.1 });
    doc.source = { type: 'puter', path: '/u/AudioStudio/Song.wav' };
    doc.apply('Edit', { ...doc.state, meta: { title: 'x' } });
    expect(doc.dirty).toBe(true);
    const app = fakeApp();
    const saving = saveDocument(app, doc).catch((err) => err);
    // The upload progress dialog appears after 600 ms; Cancel it, then the upload fails.
    await wait(700);
    const cancel = [...document.querySelectorAll('.io-progress-dialog .dialog-foot .btn')].find(
      (b) => b.textContent === 'Cancel',
    );
    expect(cancel).toBeTruthy();
    cancel.click();
    await wait(10);
    fail(new Error('Network error'));
    const result = await saving;
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('"Song.wav" could not be saved to Puter (Network error).');
    expect(doc.dirty).toBe(true);
  });

  it('says why a save failed when Puter rejects with a plain object', async () => {
    window.puter = {
      auth: { isSignedIn: () => true },
      fs: {
        write: async () => {
          const error = {
            code: 'storage_limit_reached',
            message: 'Storage capacity limit reached.',
          };
          throw { error };
        },
      },
    };
    const doc = AudioFile.blank({ name: 'Song.wav', sampleRate: 8000, channels: 1, seconds: 0.1 });
    doc.source = { type: 'puter', path: '/u/AudioStudio/Song.wav' };
    doc.apply('Edit', { ...doc.state, meta: { title: 'x' } });
    const err = await saveDocument(fakeApp(), doc).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const why = 'Storage capacity limit reached';
    expect(err.message).toBe(`"Song.wav" could not be saved to Puter (${why}).`);
    expect(err.code).toBe('storage_limit_reached');
    expect(doc.dirty).toBe(true);
  });

  it('marks the file saved when the upload completes, even after Cancel hid its dialog', async () => {
    let done;
    window.puter = {
      auth: { isSignedIn: () => true },
      fs: { write: () => new Promise((r) => (done = r)) },
    };
    const doc = AudioFile.blank({ name: 'Song.wav', sampleRate: 8000, channels: 1, seconds: 0.1 });
    doc.source = { type: 'puter', path: '/u/AudioStudio/Song.wav' };
    doc.apply('Edit', { ...doc.state, meta: { title: 'x' } });
    const saving = saveDocument(fakeApp(), doc);
    await wait(700);
    [...document.querySelectorAll('.io-progress-dialog .dialog-foot .btn')]
      .find((b) => b.textContent === 'Cancel')
      .click();
    done({ uid: 'u1' });
    expect(await saving).toBe(true);
    expect(doc.dirty).toBe(false);
  });

  it('never overwrites a video file with audio: Save on an opened .mp4 asks where to save', async () => {
    const write = vi.fn(async () => ({ uid: 'u1' }));
    window.puter = {
      auth: { isSignedIn: () => true, getUser: async () => ({ username: 'u' }) },
      fs: { write, stat: async () => ({}) },
    };
    const doc = AudioFile.blank({ name: 'Clip.mp4', sampleRate: 8000, channels: 1, seconds: 0.1 });
    doc.source = { type: 'puter', path: '/u/Videos/Clip.mp4' };
    doc.apply('Edit', { ...doc.state, meta: { title: 'x' } });
    const saving = saveDocument(fakeApp(), doc);
    await wait(20);
    const dialog = document.querySelector('.io-export-dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.querySelector('.io-name').value).toBe('Clip.m4a');
    [...dialog.querySelectorAll('.dialog-foot .btn')]
      .find((b) => b.textContent === 'Cancel')
      .click();
    expect(await saving).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(doc.dirty).toBe(true);
  });
});
