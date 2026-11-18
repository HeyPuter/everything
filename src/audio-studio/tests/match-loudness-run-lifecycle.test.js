import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { loudnessPanel } from '../src/analysis/loudness.js';
import { parseWav } from '../src/audio/wav.js';

// Use the native loudness meter in place of the analysis worker transport.
vi.mock('../src/analysis/pool.js', async () => {
  const { loudnessMeter } = await import('../src/analysis/dsp-ext.js');
  const { testDsp } = await import('./wasm-helper.js');
  return { analysisPool: () => ({ session: async (kind, params) => {
    if (kind !== 'loudness') throw new Error('The short fixture should not need matching');
    const meter = loudnessMeter(testDsp(), params.rate, params.channels);
    return {
      push: async (channels) => meter.push(channels),
      close: async () => {
        try { return { loudness: meter.result() }; } finally { meter.free(); }
      },
    };
  } }) };
});
vi.mock('../src/export/export.js', async () => {
  const { WavWriter } = await import('../src/export/pcm.js');
  return {
    exportAudio: async (source, options) => {
      const frames = source.channels[0].length;
      const writer = new WavWriter({ ...options, frames });
      writer.write(source.channels.map((ch) => ch.toArray()), frames);
      return writer.finish();
    },
    isCancelled: (err) => err?.name === 'AbortError',
  };
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  delete window.puter;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function setup() {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.prefs.set('matchLoudness', { export: true });
  app.prefs.set('matchLoudnessExport', { format: 'wav', bitDepth: 32, dither: 'none', collision: 'overwrite', location: 'puter' });
  const doc = app.addDocument(new AudioFile({ name: 'Voice.wav', sampleRate: 8000, channels: [Channel.fromSamples(new Float32Array(32).fill(0.25))] }));
  const pending = [];
  const addListener = HTMLElement.prototype.addEventListener;
  const listenerSpy = vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (type, listener, options) {
    return addListener.call(this, type, type === 'click' ? function (event) {
      const result = listener.call(this, event);
      if (result?.then) pending.push(result);
      return result;
    } : listener, options);
  });
  const panel = loudnessPanel(app);
  listenerSpy.mockRestore();
  document.body.append(panel.el);
  panel.el.querySelector('[aria-label="Add all open files"]').click();
  const run = panel.el.querySelector('.btn.primary');
  return { app, doc, panel, run, pending };
}
function gate() {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  return { wait, release };
}

it('prevents duplicate exports during destination setup and allows another run afterwards', async () => {
  const { wait, release } = gate();
  const getUser = vi.fn(async () => { await wait; return { username: 'u' }; });
  const saved = [];
  window.puter = { auth: { isSignedIn: () => true, getUser }, fs: { write: async (path, blob) => { saved.push({ path, blob }); return {}; } } };
  const { doc, panel, run, pending } = setup();
  const original = doc.state;
  run.click();
  await vi.waitFor(() => expect(getUser).toHaveBeenCalledOnce(), { interval: 1 });
  expect.soft(run.disabled).toBe(true);
  run.click();
  release();
  await Promise.all(pending);
  expect.soft(getUser).toHaveBeenCalledOnce();
  expect(saved).toHaveLength(1);
  expect(run.disabled).toBe(false);
  run.click();
  await Promise.all(pending);
  expect(saved).toHaveLength(2);
  const wav = parseWav(await saved.at(-1).blob.arrayBuffer());
  expect([...wav.channels[0]]).toEqual(Array(32).fill(0.25));
  expect(doc.state).toBe(original);
  expect(panel.el.querySelector('.analysis-caption').textContent).toMatch(/^Exported 1 matched file/);
});

it('restores controls and focus after declined sign-in, then allows retry', async () => {
  const { wait, release } = gate();
  let signedIn = false;
  const signIn = vi.fn(async () => { await wait; });
  const write = vi.fn(async () => ({}));
  window.puter = { auth: { isSignedIn: () => signedIn, signIn, getUser: async () => ({ username: 'u' }) }, fs: { write } };
  const { run, pending } = setup();
  run.focus();
  run.click();
  await vi.waitFor(() => expect(signIn).toHaveBeenCalledOnce(), { interval: 1 });
  expect.soft(run.disabled).toBe(true);
  // Browsers move focus off disabled controls; jsdom requires this explicitly.
  run.blur();
  release();
  await Promise.all(pending);
  expect(write).not.toHaveBeenCalled();
  expect(run.disabled).toBe(false);
  expect(document.activeElement === run).toBe(true);
  signedIn = true;
  run.click();
  await Promise.all(pending);
  expect(write).toHaveBeenCalledOnce();
});

it('does not export a file closed while destination setup is pending', async () => {
  const { wait, release } = gate();
  const getUser = vi.fn(async () => { await wait; return { username: 'u' }; });
  const write = vi.fn(async () => ({}));
  window.puter = { auth: { isSignedIn: () => true, getUser }, fs: { write } };
  const { app, doc, run, pending } = setup();
  run.click();
  await vi.waitFor(() => expect(getUser).toHaveBeenCalledOnce(), { interval: 1 });
  expect(await app.closeDocument(doc)).toBe(true);
  release();
  await Promise.all(pending);
  expect(write).not.toHaveBeenCalled();
  expect(run.disabled).toBe(true); // The queue is now empty.
});
