import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { batchPanel } from '../src/batch/panel.js';
import { parseWav } from '../src/audio/wav.js';

const encoding = vi.hoisted(() => ({ count: 0, reading: false, wait: null }));
vi.mock('../src/export/export.js', async () => {
  const { WavWriter } = await import('../src/export/pcm.js');
  return {
    exportAudio: async (source, options) => {
      encoding.count++;
      const frames = source.channels[0].length;
      const writer = new WavWriter({ ...options, frames });
      writer.write(source.channels.map((ch) => ch.toArray()), frames);
      const blob = writer.finish();
      if (encoding.wait) {
        const read = blob.arrayBuffer.bind(blob);
        blob.arrayBuffer = async () => { encoding.reading = true; await encoding.wait; return read(); };
      }
      return blob;
    },
    isCancelled: (err) => err?.name === 'AbortError' || err?.message === 'Cancelled',
    cancelledError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
  };
});
let downloads;
beforeEach(() => {
  localStorage.clear();
  encoding.count = 0;
  encoding.reading = false;
  encoding.wait = null;
  downloads = [];
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob) { downloads.push(blob); return 'blob:batch-test'; }
    static revokeObjectURL() {}
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => {
  delete window.puter;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function setup(location, count = 1) {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.prefs.set('batchExport', { format: 'wav', bitDepth: 32, dither: 'none', collision: 'overwrite', location });
  for (let i = 0; i < count; i++) app.addDocument(new AudioFile({ name: `File ${i + 1}.wav`, sampleRate: 8000, channels: [Channel.fromSamples(new Float32Array(32).fill(0.25))] }));
  const panel = batchPanel(app);
  document.body.append(panel.el);
  panel.el.querySelector('[aria-label="Add Open Files"]').click();
  return { app, panel, run: panel.el.querySelector('.batch-run'), cancel: panel.el.querySelector('.batch-cancel') };
}

it.each(['repeat', 'cancel'])('owns a pending destination lookup through %s and allows retry', async (action) => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const getUser = vi.fn(async () => { await wait; return { username: 'u' }; });
  const writes = [];
  window.puter = { auth: { isSignedIn: () => true, getUser }, fs: { write: async (path, blob) => { writes.push({ path, blob }); return {}; } } };
  const { app, panel, run, cancel } = setup('puter');
  const first = panel.api.run();
  await vi.waitFor(() => expect(getUser).toHaveBeenCalledOnce(), { interval: 1 });
  expect.soft(run.disabled).toBe(true);
  expect.soft(cancel.hidden).toBe(false);
  let repeated;
  if (action === 'repeat') repeated = panel.api.run();
  else cancel.click();
  release();
  await Promise.all([first, repeated]);
  expect.soft(getUser).toHaveBeenCalledOnce();
  expect(writes).toHaveLength(action === 'repeat' ? 1 : 0);
  expect(run.disabled).toBe(false);
  expect(run.hidden).toBe(false);
  expect(cancel.hidden).toBe(true);
  await panel.api.run();
  expect(writes).toHaveLength(action === 'repeat' ? 2 : 1);
  const wav = parseWav(await writes.at(-1).blob.arrayBuffer());
  expect([...wav.channels[0]]).toEqual(Array(32).fill(0.25));
  expect(panel.api.items[0].status).toBe('done');
  expect(app.notify).not.toHaveBeenCalled();
});

it('stays busy through ZIP assembly and prevents overlapping downloads', async () => {
  let release;
  encoding.wait = new Promise((resolve) => { release = resolve; });
  const { app, panel, run } = setup('download', 2);
  const first = panel.api.run();
  await vi.waitFor(() => expect(encoding.reading).toBe(true), { interval: 1 });
  panel.show(); // Reopening the panel refreshes controls while its ZIP is pending.
  expect.soft(run.disabled).toBe(true);
  const repeated = panel.api.run();
  release();
  await Promise.all([first, repeated]);
  expect(encoding.count).toBe(2);
  expect(downloads).toHaveLength(1);
  expect(run.disabled).toBe(false);
  expect(run.hidden).toBe(false);
  expect(panel.api.items.map((item) => item.status)).toEqual(['done', 'done']);
  expect(app.notify).not.toHaveBeenCalled();
});

it('releases startup controls when sign-in is declined and can retry', async () => {
  let signedIn = false;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const signIn = vi.fn(async () => { await wait; });
  const write = vi.fn(async () => ({}));
  window.puter = { auth: { isSignedIn: () => signedIn, signIn, getUser: async () => ({ username: 'u' }) }, fs: { write } };
  const { app, panel, run, cancel } = setup('puter');
  const first = panel.api.run();
  await vi.waitFor(() => expect(signIn).toHaveBeenCalledOnce(), { interval: 1 });
  release();
  await first;
  expect(write).not.toHaveBeenCalled();
  expect(run.disabled).toBe(false);
  expect(run.hidden).toBe(false);
  expect(cancel.hidden).toBe(true);
  signedIn = true;
  await panel.api.run();
  expect(write).toHaveBeenCalledOnce();
  expect(panel.api.items[0].status).toBe('done');
  expect(app.notify).not.toHaveBeenCalled();
});

it('keeps a document closed during destination setup out of the batch', async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const getUser = vi.fn(async () => { await wait; return { username: 'u' }; });
  const write = vi.fn(async () => ({}));
  window.puter = { auth: { isSignedIn: () => true, getUser }, fs: { write } };
  const { app, panel, run, cancel } = setup('puter');
  const first = panel.api.run();
  await vi.waitFor(() => expect(getUser).toHaveBeenCalledOnce(), { interval: 1 });
  expect(await app.closeDocument(app.active)).toBe(true);
  release();
  await first;
  expect(write).not.toHaveBeenCalled();
  expect(panel.api.items).toHaveLength(0);
  expect(run.disabled).toBe(true); // Empty list, not a stuck in-progress run.
  expect(run.hidden).toBe(false);
  expect(cancel.hidden).toBe(true);
});
