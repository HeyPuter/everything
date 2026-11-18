import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { loudnessPanel } from '../src/analysis/loudness.js';
import { loudnessMeter } from '../src/analysis/dsp-ext.js';
import { parseWav } from '../src/audio/wav.js';
import { testDsp } from './wasm-helper.js';

const scan = vi.hoisted(() => ({ wait: null, waiting: false, count: 0 }));
// Same streaming meter/gain/limiter behavior as the analysis worker, with a
// gate on delivery of its first measurement. All DSP uses the native WASM.
vi.mock('../src/analysis/pool.js', async () => {
  const { loudnessMeter, limiter } = await import('../src/analysis/dsp-ext.js');
  const { testDsp } = await import('./wasm-helper.js');
  return { analysisPool: () => ({ session: async (kind, params) => {
    if (kind === 'loudness') scan.count++;
    const d = testDsp();
    const meter = loudnessMeter(d, params.rate, params.channels);
    const lim = kind === 'limit' && params.limit ? limiter(d, params.rate, params.channels, params) : null;
    return {
      push: async (channels) => {
        if (lim) lim.process(channels);
        else if (kind === 'limit') for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= params.gain;
        meter.push(channels);
        return kind === 'limit' ? channels : null;
      },
      close: async () => {
        let result;
        try { result = { loudness: meter.result(), latency: lim?.latency || 0 }; }
        finally { meter.free(); lim?.free(); }
        if (kind === 'loudness' && scan.wait) {
          const wait = scan.wait;
          scan.wait = null;
          scan.waiting = true;
          await wait;
        }
        return result;
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
    cancelledError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
  };
});
beforeEach(() => {
  localStorage.clear();
  scan.wait = null;
  scan.waiting = false;
  scan.count = 0;
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  delete window.puter;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
const RATE = 8000;
function integrated(samples) {
  const meter = loudnessMeter(testDsp(), RATE, 1);
  try { meter.push([samples]); return meter.result().integrated; }
  finally { meter.free(); }
}

it.each(['Scan', 'Run', 'Export'].flatMap((mode) => ['close current', 'close next', 'remove next'].map((change) => ({ mode, change }))))('$mode keeps the remaining queue correct after $change', async ({ mode, change }) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.prefs.set('matchLoudness', { export: mode === 'Export', target: -23 });
  app.prefs.set('matchLoudnessExport', { format: 'wav', bitDepth: 32, dither: 'none', collision: 'overwrite', location: 'puter' });
  const samples = Float32Array.from({ length: RATE * 2 }, (_, i) => 0.05 * Math.sin(2 * Math.PI * 440 * i / RATE));
  const docs = ['First.wav', 'Second.wav', 'Third.wav'].map((name) => app.addDocument(new AudioFile({ name, sampleRate: RATE, channels: [Channel.fromSamples(samples)] })));
  const original = docs.map((doc) => doc.state);
  const saved = [];
  window.puter = { auth: { isSignedIn: () => true, getUser: async () => ({ username: 'u' }) }, fs: { write: async (path, blob) => { saved.push({ name: path.split('/').pop(), blob }); return {}; } } };
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
  const run = [...panel.el.querySelectorAll('button')].find((button) => button.textContent === mode);
  let release;
  scan.wait = new Promise((resolve) => { release = resolve; });
  run.click();
  await vi.waitFor(() => expect(scan.waiting).toBe(true), { interval: 1 });
  if (change === 'remove next') {
    const row = panel.el.querySelectorAll('tbody tr')[1];
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  } else expect(await app.closeDocument(docs[change === 'close current' ? 0 : 1])).toBe(true);
  release();
  await Promise.all(pending);
  if (mode === 'Scan') expect(scan.count).toBe(change === 'close current' ? 3 : 2);
  const remaining = change === 'close current' ? [1, 2] : [2];
  for (const index of remaining) {
    const row = [...panel.el.querySelectorAll('tbody tr')].find((r) => r.firstChild.textContent === docs[index].name);
    expect(row).toBeTruthy();
    if (mode === 'Scan') expect(row.lastChild.textContent).toBe('Scanned');
    else if (mode === 'Run') {
      expect(docs[index].state === original[index]).toBe(false);
      expect(integrated(docs[index].state.channels[0].toArray())).toBeCloseTo(-23, 1);
      docs[index].history.undo();
      expect(docs[index].state === original[index]).toBe(true);
    } else {
      const upload = saved.find((s) => s.name === docs[index].name.replace('.wav', ' (matched).wav'));
      expect(upload).toBeTruthy();
      const wav = parseWav(await upload.blob.arrayBuffer());
      expect(wav.channels[0].length).toBe(samples.length);
      expect(integrated(wav.channels[0])).toBeCloseTo(-23, 1);
      expect(docs[index].state === original[index]).toBe(true);
    }
  }
  if (change !== 'close current') {
    expect(docs[1].state === original[1]).toBe(true);
    expect(saved.some((s) => s.name.startsWith('Second'))).toBe(false);
  }
  expect(run.disabled).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
});
