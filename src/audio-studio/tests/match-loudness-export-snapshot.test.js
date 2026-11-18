import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { loudnessPanel } from '../src/analysis/loudness.js';
import { loudnessMeter } from '../src/analysis/dsp-ext.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installEffectCommands } from '../src/effects/commands.js';
import { parseWav } from '../src/audio/wav.js';
import { testDsp } from './wasm-helper.js';

const scan = vi.hoisted(() => ({ wait: null, waiting: false }));
// Same streaming meter/gain/limiter behavior as the analysis worker, with a
// gate on delivery of its first measurement. All DSP uses the native WASM.
vi.mock('../src/analysis/pool.js', async () => {
  const { loudnessMeter, limiter } = await import('../src/analysis/dsp-ext.js');
  const { testDsp } = await import('./wasm-helper.js');
  return { analysisPool: () => ({ session: async (kind, params) => {
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

it.each(['gain', 'skip'])('exports the measured audio when edited during a %s scan, and uses new edits next time', async (action) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  installEffectCommands(app);
  const samples = Float32Array.from({ length: RATE * 4 }, (_, i) => 0.05 * Math.sin(2 * Math.PI * 440 * i / RATE));
  const measured = integrated(samples);
  const target = action === 'skip' ? measured : -23;
  const gain = action === 'skip' ? 1 : Math.pow(10, (target - measured) / 20);
  app.prefs.set('matchLoudness', { export: true, target });
  app.prefs.set('matchLoudnessExport', { format: 'wav', bitDepth: 32, dither: 'none', collision: 'overwrite', location: 'puter' });
  const doc = app.addDocument(new AudioFile({ name: 'Voice.wav', sampleRate: RATE, channels: [Channel.fromSamples(samples)] }));
  const original = doc.state;
  const saved = [];
  window.puter = { auth: { isSignedIn: () => true, getUser: async () => ({ username: 'u' }) }, fs: { write: async (path, blob) => { saved.push(blob); return {}; } } };
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
  let release;
  scan.wait = new Promise((resolve) => { release = resolve; });
  run.click();
  await vi.waitFor(() => expect(scan.waiting).toBe(true), { interval: 1 });
  await app.commands.run('fx.normalizePeak', { peak: -6 });
  const normalized = doc.state;
  expect(normalized === original).toBe(false);
  release();
  await Promise.all(pending);
  expect(saved).toHaveLength(1);
  const first = parseWav(await saved[0].arrayBuffer()).channels[0];
  expect(first.length).toBe(samples.length);
  expect.soft(integrated(first)).toBeCloseTo(target, 1);
  // Bound failure output: compare the maximum sample error, not 32k entries.
  let error = 0;
  for (let i = 0; i < first.length; i++) error = Math.max(error, Math.abs(first[i] - Math.fround(samples[i] * gain)));
  expect(error).toBeLessThan(1e-6);
  expect(doc.state === normalized).toBe(true);
  expect(panel.el.querySelector('tbody').textContent).toContain('Changed since scan');

  // The next invocation must measure the new file, including its new duration.
  doc.setSelection(0, RATE * 2);
  await app.commands.run('edit.crop');
  const cropped = doc.state;
  run.click();
  await Promise.all(pending);
  expect(saved).toHaveLength(2);
  const second = parseWav(await saved[1].arrayBuffer()).channels[0];
  expect(second.length).toBe(RATE * 2);
  expect(integrated(second)).toBeCloseTo(target, 1);
  expect(doc.state === cropped).toBe(true);
  await app.commands.run('edit.undo');
  expect(doc.state === normalized).toBe(true);
  await app.commands.run('edit.undo');
  expect(doc.state === original).toBe(true);
  expect(app.notify).not.toHaveBeenCalled();
});
