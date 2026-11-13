import { describe, it, expect, vi, afterEach } from 'vitest';

// Encoding runs in a worker in the app; here it resolves at once.
const exports = vi.hoisted(() => []);
vi.mock('../src/export/export.js', () => ({
  exportAudio: async (...args) => {
    exports.push(args);
    return new Blob([new Uint8Array(64)]);
  },
  isCancelled: (err) => err?.name === 'AbortError' || err?.message === 'Cancelled',
  cancelledError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
}));

const { saveDocument, optionsForSave } = await import('../src/export/save.js');
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

  it('lands a later save last when an earlier upload to the file is slower', async () => {
    const calls = [];
    window.puter = {
      auth: { isSignedIn: () => true },
      fs: { write: (path, blob) => new Promise((done) => calls.push({ blob, done })) },
    };
    const doc = AudioFile.blank({ name: 'Song.wav', sampleRate: 8000, channels: 1, seconds: 0.1 });
    doc.source = { type: 'puter', path: '/u/AudioStudio/Song.wav' };
    doc.apply('Edit', { ...doc.state, meta: { title: 'x' } });
    const app = fakeApp();
    // Save; its upload is slow (Cancel hides its dialog), the file is edited and saved again.
    const first = saveDocument(app, doc);
    await wait(10);
    doc.apply('Edit', { ...doc.state, meta: { title: 'y' } });
    const second = saveDocument(app, doc);
    await wait(10);
    const landed = [];
    const finish = (i) => {
      landed.push(i);
      calls[i].done({ uid: 'u1' });
    };
    if (calls.length > 1) finish(1);
    finish(0);
    await wait(10);
    if (calls.length > 1 && landed.length < 2) finish(1);
    await Promise.all([first, second]);
    // The file holds the newest save, which is the state marked saved.
    expect(calls).toHaveLength(2);
    expect(landed.at(-1)).toBe(1);
    expect(exports.at(-1)[0].meta).toEqual({ title: 'y' });
    expect(doc.dirty).toBe(false);
  });

  for (const [file, proposed] of [
    ['Clip.mp4', 'Clip.m4a'],
    ['Stream.aac', 'Stream.m4a'],
  ]) {
    it(`never rewrites ${file} as an M4A in place: Save asks where to save`, async () => {
      const write = vi.fn(async () => ({ uid: 'u1' }));
      window.puter = {
        auth: { isSignedIn: () => true, getUser: async () => ({ username: 'u' }) },
        fs: { write, stat: async () => ({}) },
      };
      const doc = AudioFile.blank({ name: file, sampleRate: 8000, channels: 1, seconds: 0.1 });
      doc.source = { type: 'puter', path: `/u/Videos/${file}` };
      doc.apply('Edit', { ...doc.state, meta: { title: 'x' } });
      const saving = saveDocument(fakeApp(), doc);
      await wait(20);
      const dialog = document.querySelector('.io-export-dialog');
      expect(dialog).toBeTruthy();
      expect(dialog.querySelector('.io-name').value).toBe(proposed);
      [...dialog.querySelectorAll('.dialog-foot .btn')]
        .find((b) => b.textContent === 'Cancel')
        .click();
      expect(await saving).toBe(false);
      expect(write).not.toHaveBeenCalled();
      expect(doc.dirty).toBe(true);
    });
  }
});

describe('saving a WAV file opened with production sound chunks', () => {
  it('hands the iXML and other kept chunks of the opened file to the encoder', async () => {
    const { WavWriter } = await import('../src/export/pcm.js');
    const { audioFileFromBlob } = await import('../src/storage/files.js');
    const { encodeDoc } = await import('../src/export/save.js');
    const ixml = new TextEncoder().encode('<BWFXML><TAKE>3</TAKE></BWFXML>');
    const chunks = [{ id: 'iXML', bytes: ixml }];
    const w = new WavWriter({ sampleRate: 8000, channels: 1, bitDepth: 16, frames: 10, chunks });
    w.write([new Float32Array(10)], 10);
    const doc = await audioFileFromBlob(w.finish(), 'Take.wav');
    expect(doc.info.wavChunks).toMatchObject({ sampleRate: 8000, channels: 1, frames: 10 });
    expect(doc.info.wavChunks.list.map((c) => c.id)).toEqual(['iXML']);
    await encodeDoc(doc, { format: 'wav' });
    expect(exports.at(-1)[0].chunks).toBe(doc.info.wavChunks);
  });
});

describe('Save As when the file exists and Replace is declined', () => {
  afterEach(() => {
    delete window.puter;
    document.body.replaceChildren();
  });

  it('reopens the dialog with the folder, format and sample type chosen before', async () => {
    const write = vi.fn(async () => ({ uid: 'u1' }));
    window.puter = {
      auth: { isSignedIn: () => true, getUser: async () => ({ username: 'u' }) },
      fs: { write, stat: async () => ({}) },
      ui: { showDirectoryPicker: async () => ({ path: '/u/Other' }) },
    };
    const { Prefs } = await import('../src/lib/prefs.js');
    const app = { ...fakeApp(), prefs: new Prefs(null) };
    const doc = AudioFile.blank({ name: 'Song.wav', sampleRate: 44100, channels: 2, seconds: 0.1 });
    doc.source = { type: 'puter', path: '/u/Music/Song.wav' };
    const saving = saveDocument(app, doc, { saveAs: true });
    await wait(20);
    const $ = (sel) => document.querySelector(sel);
    const button = (root, text) => [...root.querySelectorAll('.btn')].find((b) => b.textContent === text);
    const change = (el, value) => {
      el.value = String(value);
      el.dispatchEvent(new Event('change'));
    };
    button($('.io-export-dialog'), 'Browse...').click();
    await wait(10);
    change($('.io-export-dialog select[aria-label="Format"]'), 'mp3');
    change($('.io-export-dialog select[aria-label="Bitrate (CBR)"]'), 128);
    button($('.io-export-dialog'), 'Change...').click();
    change($('.io-export-dialog select[aria-label="Channels"]'), 1);
    button($('.io-export-dialog'), 'OK').click();
    $('.io-export-dialog .dialog-foot .btn.primary').click();
    await wait(20);
    // "Song.mp3" exists in /u/Other: decline Replace.
    expect($('.dialog-backdrop .dialog-title')?.textContent).toBe('Replace File?');
    button(document, 'Cancel').click();
    await wait(20);
    const dialog = $('.io-export-dialog');
    expect(dialog.querySelector('.io-name').value).toBe('Song.mp3');
    expect(dialog.querySelector('.io-path').textContent).toBe('/u/Other');
    expect(dialog.querySelector('select[aria-label="Format"]').value).toBe('mp3');
    expect(dialog.querySelector('select[aria-label="Bitrate (CBR)"]').value).toBe('128');
    expect(dialog.querySelector('.io-summary').textContent).toContain('Mono');
    button(dialog.querySelector('.dialog-foot'), 'Cancel').click();
    expect(await saving).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('Save after the document changed sample type', () => {
  afterEach(() => {
    delete window.puter;
    document.body.replaceChildren();
  });

  it("writes the document's new channel count, keeping the other saved choices", async () => {
    const { convertChannels } = await import('../src/model/edits.js');
    const { Prefs } = await import('../src/lib/prefs.js');
    window.puter = {
      auth: { isSignedIn: () => true, getUser: async () => ({ username: 'u' }) },
      fs: {
        write: async () => ({ uid: 'u1' }),
        stat: async () => Promise.reject({ code: 'subject_does_not_exist' }),
      },
    };
    const app = { ...fakeApp(), prefs: new Prefs(null) };
    const doc = AudioFile.blank({ name: 'Mono.wav', sampleRate: 44100, channels: 1, seconds: 0.1 });
    // Save As 16-bit WAV with noise-shaped dither.
    const saving = saveDocument(app, doc, { saveAs: true });
    await wait(20);
    const change = (el, value) => {
      el.value = String(value);
      el.dispatchEvent(new Event('change'));
    };
    const button = (text) =>
      [...document.querySelectorAll('.io-export-dialog .btn')].find((b) => b.textContent === text);
    button('Change...').click();
    change(document.querySelector('select[aria-label="Bit depth"]'), 16);
    change(document.querySelector('select[aria-label="Dither"]'), 'shaped');
    button('OK').click();
    document.querySelector('.io-export-dialog .dialog-foot .btn.primary').click();
    expect(await saving).toBe(true);
    expect(exports.at(-1)[1]).toMatchObject({ channels: 1, sampleRate: 44100, bitDepth: 16 });
    // Edit > Convert Sample Type to stereo, then Save.
    doc.apply('Convert', convertChannels(doc.state, 2));
    expect(await saveDocument(app, doc)).toBe(true);
    const saved = { channels: 2, sampleRate: 44100, bitDepth: 16, dither: 'shaped' };
    expect(exports.at(-1)[1]).toMatchObject(saved);
    // A rate and channel count chosen in Save As hold while the document keeps its own.
    const from = { sampleRate: 44100, channels: 2 };
    doc.info.exportOptions = { ...doc.info.exportOptions, sampleRate: 48000, channels: 1, from };
    expect(optionsForSave(doc, 'wav')).toMatchObject({ sampleRate: 48000, channels: 1 });
  });
});
