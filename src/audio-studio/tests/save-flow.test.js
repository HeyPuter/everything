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
    expect(result.message).toBe('Network error');
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
});
