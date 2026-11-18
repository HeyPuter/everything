import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { installEffectCommands } from '../src/effects/commands.js';
import { installSpectral } from '../src/spectral/install.js';
import { WaveformView } from '../src/editor/waveform-view.js';
import { applyFavorite } from '../src/effects/favorites.js';
import { setDspBytes, dsp } from '../src/audio/dsp.js';

const failure = vi.hoisted(() => ({ error: null }));
vi.mock('../src/audio/dsp.js', async (original) => {
  const actual = await original();
  return { ...actual, dsp: () => failure.error ? Promise.reject(failure.error) : actual.dsp() };
});
const extensions = WaveformView.extensions.length;
beforeEach(async () => {
  failure.error = null;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
  localStorage.clear();
});
afterEach(() => {
  WaveformView.extensions.length = extensions;
  vi.restoreAllMocks();
});
function setup(samples = 5000) {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installEffectCommands(app);
  installSpectral(app);
  const doc = app.addDocument(new AudioFile({ name: 'Test.wav', sampleRate: 1000, channels: [Channel.fromSamples(new Float32Array(samples).fill(0.25))] }));
  doc.setSelection(0, doc.length);
  return { app, doc };
}
const heal = { type: 'command', command: 'fx.autoHeal', select: { start: 0, end: 1000, length: 1000, rate: 1000, mode: 'relative' } };
const fav = (sequence) => ({ name: 'Heal then fade', action: sequence ? { type: 'sequence', steps: [heal, { type: 'command', command: 'fx.fadeOut' }] } : heal });

it.each([false, true])('reports failed healing without continuing after its selection limit is exceeded (sequence=%s)', async (sequence) => {
  const { app, doc } = setup();
  const before = doc.state;
  const result = await applyFavorite(app, fav(sequence));
  expect(app.notify).toHaveBeenCalledTimes(1);
  expect(app.notify.mock.calls[0][0]).toMatch(/up to 4 seconds/);
  expect(doc.state === before).toBe(true);
  expect(result).toBe(false);
});

it.each([false, true])('reports failed healing without continuing after DSP loading fails (sequence=%s)', async (sequence) => {
  failure.error = new Error('DSP download failed');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { app, doc } = setup(1000);
  const before = doc.state;
  const result = await applyFavorite(app, fav(sequence));
  expect(app.notify).toHaveBeenCalledExactlyOnceWith('DSP download failed', { error: true });
  expect(errors).toHaveBeenCalledTimes(1);
  expect(doc.state === before).toBe(true);
  expect(result).toBe(false);
  failure.error = null;
  expect(await applyFavorite(app, fav(sequence))).toBe(true);
  expect(doc.history.undoLabel).toBe(sequence ? 'Fade Out' : 'Auto Heal');
  expect(app.notify).toHaveBeenCalledTimes(1);
});

it('continues after successful void commands and legitimate no-op normalization of silence', async () => {
  const { app, doc } = setup(32);
  doc.apply('Silence', { ...doc.state, channels: [Channel.silence(32)] });
  const favorite = { name: 'Silent stereo', action: { type: 'sequence', steps: [
    { type: 'command', command: 'fx.normalizePeak' },
    { type: 'command', command: 'fx.toStereo' },
    { type: 'command', command: 'fx.fadeOut' },
  ] } };
  expect(await applyFavorite(app, favorite)).toBe(true);
  expect(doc.channelCount).toBe(2);
  expect(doc.history.undoLabel).toBe('Fade Out');
  expect(app.notify).toHaveBeenCalledExactlyOnceWith('The selection is silent, so there is nothing to normalize.');
});

it('keeps completed edits and their Undo history when a later step fails', async () => {
  const { app, doc } = setup();
  const before = doc.state;
  const favorite = fav(true);
  favorite.action.steps.unshift({ type: 'command', command: 'fx.fadeIn' });
  expect(await applyFavorite(app, favorite)).toBe(false);
  expect(doc.history.undoLabel).toBe('Fade In');
  expect(doc.state.channels[0].toArray(0, 1)[0]).toBe(0);
  expect(doc.state.channels[0].toArray(doc.length - 1, doc.length)[0]).toBeCloseTo(0.25);
  doc.history.undo();
  expect(doc.state === before).toBe(true);
});
