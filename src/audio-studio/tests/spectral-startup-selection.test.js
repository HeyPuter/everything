import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installSpectral } from '../src/spectral/install.js';
import { WaveformView } from '../src/editor/waveform-view.js';
import { healSpectral } from '../src/spectral/process.js';
import { timeSelection } from '../src/spectral/mask.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';

const gate = vi.hoisted(() => ({ wait: null, calls: 0 }));
vi.mock('../src/audio/dsp.js', async (original) => {
  const actual = await original();
  return { ...actual, dsp: async () => { gate.calls++; if (gate.wait) await gate.wait; return actual.dsp(); } };
});
let native;
const extensions = WaveformView.extensions.length;
beforeEach(async () => {
  gate.wait = null;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  native = await dsp();
  gate.calls = 0;
  localStorage.clear();
});
afterEach(() => { WaveformView.extensions.length = extensions; document.body.replaceChildren(); });

it.each(['time', 'spectral'])('heals the original %s selection and channels if they change during DSP startup', async (mode) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  let release;
  gate.wait = new Promise((resolve) => { release = resolve; });
  installSpectral(app);
  app.prefs.set('spectralDisplay', mode === 'spectral');
  const samples = new Float32Array(16384);
  samples[4096] = samples[12288] = 1;
  const doc = app.addDocument(new AudioFile({ name: 'Clicks.wav', sampleRate: 48000, channels: [Channel.fromSamples(samples), Channel.fromSamples(samples.slice())] }));
  const selection = timeSelection(3840, 4352, 24000, [true, false]);
  if (mode === 'spectral') app.spectral.set(doc, selection);
  else doc.setSelection(3840, 4352, { channels: [true, false] });
  const before = doc.state;
  const expected = healSpectral(before, selection, native);
  expect(Math.abs(expected.channels[0].toArray(4096, 4097)[0] - 1)).toBeGreaterThan(0.05);
  const healing = app.commands.run('fx.autoHeal');
  expect(gate.calls).toBe(2); // Background initialization and this pending command.
  expect(doc.state === before).toBe(true);
  if (mode === 'spectral') app.spectral.set(doc, timeSelection(12032, 12544, 24000, [false, true]));
  else doc.setSelection(12032, 12544, { channels: [false, true] });
  release();
  await healing;
  const actual = doc.state.channels[0].toArray();
  const wanted = expected.channels[0].toArray();
  expect(actual.every((sample, i) => sample === wanted[i])).toBe(true);
  expect(doc.state.channels[1] === before.channels[1]).toBe(true);
  expect(doc.selection).toEqual({ start: 12032, end: 12544, channels: [false, true] });
  expect(app.notify).not.toHaveBeenCalled();
  doc.history.undo();
  expect(doc.state === before).toBe(true);
});
