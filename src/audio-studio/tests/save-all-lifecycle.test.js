import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { installCoreCommands } from '../src/commands/core.js';

// Keep the real Save All command, save flow, upload queue, and close dialog.
// Only the export worker and external Puter upload are substituted.
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
function addFile(app, name, dirty) {
  const doc = AudioFile.blank({ name, sampleRate: 8000, channels: 1, seconds: 0.004 });
  doc.source = { type: 'puter', path: `/u/${name}` };
  if (dirty) doc.apply('Edit metadata', { ...doc.state, meta: { title: 'Unsaved' } });
  return app.addDocument(doc);
}

it.each(['close queued', 'close original', 'cancel close', 'normal'])('Save All respects document lifecycle: %s', async (action) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  const first = addFile(app, 'First.wav', true);
  const queued = addFile(app, 'Queued.wav', true);
  const original = addFile(app, 'Original.wav', false);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const write = vi.fn(async (path) => {
    if (path === first.source.path) await wait;
    return {};
  });
  window.puter = { auth: { isSignedIn: () => true }, fs: { write } };
  const saving = app.commands.run('file.saveAll');
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1), { interval: 1 });
  expect(app.active === first).toBe(true);
  if (action === 'close queued' || action === 'cancel close') {
    const closing = app.closeDocument(queued);
    const value = action === 'close queued' ? 'discard' : 'null';
    const button = document.querySelector(`.dialog-foot button[data-value="${value}"]`);
    expect(button).not.toBeNull();
    button.click();
    expect(await closing).toBe(action === 'close queued');
  } else if (action === 'close original') {
    expect(await app.closeDocument(original)).toBe(true);
  }
  release();
  await saving;
  expect(write.mock.calls.map(([path]) => path)).toEqual(action === 'close queued' ? ['/u/First.wav'] : ['/u/First.wav', '/u/Queued.wav']);
  expect(first.dirty).toBe(false);
  expect(queued.dirty).toBe(action === 'close queued');
  expect(app.documents.includes(queued)).toBe(action !== 'close queued');
  expect(app.documents.includes(original)).toBe(action !== 'close original');
  expect(app.active === null || app.documents.includes(app.active)).toBe(true);
  if (action !== 'close original') expect(app.active === original).toBe(true);
  expect(app.notify).not.toHaveBeenCalled();
});
