import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installSpectral } from '../src/spectral/install.js';
import { WaveformView } from '../src/editor/waveform-view.js';
import { timeSelection } from '../src/spectral/mask.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';

const gate = vi.hoisted(() => ({ wait: null, calls: 0 }));
vi.mock('../src/audio/dsp.js', async (original) => {
  const actual = await original();
  return { ...actual, dsp: async () => { gate.calls++; if (gate.wait) await gate.wait; return actual.dsp(); } };
});
const extensions = WaveformView.extensions.length;
const views = [];
beforeEach(async () => {
  gate.wait = null;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
  gate.calls = 0;
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  WaveformView.extensions.length = extensions;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
const cases = [
  ['heal', 'Auto Heal'], ['delete', 'Delete'], ['gain', 'Spectral Gain'], ['brush', 'Spot Healing Brush'],
];

it.each(cases)('does not apply stale %s coordinates to audio pasted during DSP loading', async (kind, label) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  let release;
  gate.wait = new Promise((resolve) => { release = resolve; });
  installSpectral(app);
  app.prefs.set('spectralDisplay', true);
  const original = new Float32Array(16384);
  original[4096] = 1;
  const doc = app.addDocument(new AudioFile({ name: 'Click.wav', sampleRate: 48000, channels: [Channel.fromSamples(original)] }));
  const view = new WaveformView(app, doc);
  views.push(view);
  document.body.append(view.el);
  const layer = view.layers.find((layer) => layer.id === 'spectral');
  const selection = timeSelection(3840, 4352, 24000, [true]);
  app.spectral.set(doc, selection);
  const run = () => kind === 'heal' ? app.commands.run('fx.autoHeal')
    : kind === 'delete' ? app.commands.run('edit.delete')
    : kind === 'gain' ? app.spectral.apply(doc, label, 0.5)
    : layer.svc.heal(doc, app.spectral.selection(doc));
  const pending = run();
  expect(gate.calls).toBeGreaterThanOrEqual(2);

  // Paste new audio at the front. The original target shifts to frame 12288;
  // a different click now occupies the old coordinates.
  app.spectral.clear(doc);
  doc.setSelection(0, 0);
  doc.setCursor(0);
  const prefix = new Float32Array(8192);
  prefix[4096] = 0.5;
  app.clipboard = { type: 'audio', sampleRate: 48000, channels: [Channel.fromSamples(prefix)] };
  await app.commands.run('edit.paste');
  const pasted = doc.state;
  expect(doc.length).toBe(24576);
  release();
  const result = await pending;
  expect(doc.state.channels[0].toArray(4096, 4097)[0]).toBe(0.5);
  expect(doc.state === pasted).toBe(true);
  expect(doc.history.undoLabel).toBe('Paste');
  expect(result).toBe(false);
  expect(app.notify).toHaveBeenCalledExactlyOnceWith(`${label} was not applied because the file changed while it was processing.`, { error: true });

  // A fresh operation at the shifted target is still usable and undoable.
  app.spectral.set(doc, timeSelection(12032, 12544, 24000, [true]));
  await run();
  expect(doc.history.undoLabel).toBe(label);
  expect(doc.state.channels[0].toArray(12288, 12289)[0]).toBeLessThan(0.99);
  expect(doc.state.channels[0].toArray(4096, 4097)[0]).toBe(0.5);
  doc.history.undo();
  expect(doc.state === pasted).toBe(true);
});
