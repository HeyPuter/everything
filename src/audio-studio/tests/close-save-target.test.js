import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { installCoreCommands } from '../src/commands/core.js';
import { wavHeader } from '../src/audio/wav.js';

vi.mock('../src/export/export.js', () => ({
  exportAudio: async () => new Blob([new Uint8Array(64)]),
  isCancelled: (err) => err?.name === 'AbortError' || err?.message === 'Cancelled',
  cancelledError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
}));
beforeEach(() => localStorage.clear());
afterEach(() => {
  delete window.puter;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(['save', 'save failure', 'discard', 'cancel'])('Close keeps its target after another file finishes opening: %s', async (choice) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  const original = AudioFile.blank({ name: 'Original.wav', sampleRate: 8000, channels: 1, seconds: 0.004 });
  original.source = { type: 'puter', path: '/u/Original.wav' };
  original.apply('Edit metadata', { ...original.state, meta: { title: 'Unsaved' } });
  app.addDocument(original);
  const edited = original.state;
  const header = wavHeader({ sampleRate: 8000, channels: 1, bitDepth: 32, float: true, frames: 32 });
  const buffer = new ArrayBuffer(header.byteLength + 32 * 4);
  new Uint8Array(buffer).set(new Uint8Array(header));
  const blob = new Blob([buffer]);
  blob.arrayBuffer = async () => buffer;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const read = vi.fn(async () => { await wait; return blob; });
  const write = vi.fn(async (path) => {
    if (choice === 'save failure' && path === original.source.path) throw new Error('Upload failed');
    return {};
  });
  window.puter = {
    auth: { isSignedIn: () => true },
    ui: { showOpenFilePicker: async () => [{ name: 'Incoming.wav', path: '/u/Incoming.wav', read }] },
    fs: { write },
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const opening = app.commands.run('file.open');
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce(), { interval: 1 });
  const closing = app.commands.run('file.close');
  expect(document.querySelector('[role=dialog]').textContent).toContain('Original.wav');
  release();
  await opening;
  const incoming = app.documents.find((doc) => doc.name === 'Incoming.wav');
  expect(app.active === incoming).toBe(true);
  const incomingState = incoming.state;
  const value = choice.startsWith('save') ? 'save' : choice === 'cancel' ? 'null' : 'discard';
  document.querySelector(`.dialog-foot button[data-value="${value}"]`).click();
  const result = await closing;
  expect(write.mock.calls.map(([path]) => path)).toEqual(choice.startsWith('save') ? ['/u/Original.wav'] : []);
  const closed = choice === 'save' || choice === 'discard';
  expect(result).toBe(closed);
  expect(app.documents.includes(original)).toBe(!closed);
  expect(original.state === edited).toBe(true);
  expect(original.dirty).toBe(choice !== 'save');
  expect(app.documents.includes(incoming)).toBe(true);
  expect(incoming.state === incomingState).toBe(true);
  expect(incoming.dirty).toBe(false);
  if (choice === 'save failure') {
    expect(app.notify).toHaveBeenCalledOnce();
    expect(app.notify.mock.calls[0][0]).toContain('"Original.wav" could not be saved to Puter (Upload failed)');
  } else {
    expect(app.notify).not.toHaveBeenCalled();
    expect(app.active === incoming).toBe(true);
  }
});
