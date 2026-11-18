import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installSpectral } from '../src/spectral/install.js';
import { WaveformView } from '../src/editor/waveform-view.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';

const failure = vi.hoisted(() => ({ error: null }));
vi.mock('../src/audio/dsp.js', async (original) => {
  const actual = await original();
  return { ...actual, dsp: () => failure.error ? Promise.reject(failure.error) : actual.dsp() };
});
const extensions = WaveformView.extensions.length;
let view;
beforeEach(async () => {
  failure.error = null;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  view?.destroy();
  WaveformView.extensions.length = extensions;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('reports a failed healing gesture without a rejected promise, preserves audio, and retries with native DSP', async () => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  failure.error = new Error('DSP download failed');
  installSpectral(app);
  app.prefs.set('spectralDisplay', true);
  app.prefs.set('spectralLog', false);
  const samples = new Float32Array(16384);
  samples[4096] = 1;
  const doc = app.addDocument(new AudioFile({ name: 'Click.wav', sampleRate: 48000, channels: [Channel.fromSamples(samples)] }));
  doc.setView(0, 16384);
  view = new WaveformView(app, doc);
  document.body.append(view.el);
  view.width = 600;
  const layer = view.layers.find((layer) => layer.id === 'spectral');
  layer.layout({ y: 100, width: 600, height: 200, dpr: 1 });
  app.setTool('heal');
  const heal = layer.svc.heal.bind(layer.svc);
  let outcome;
  vi.spyOn(layer.svc, 'heal').mockImplementation((...args) => {
    const pending = heal(...args);
    // Observe the real service's result without letting the baseline rejection
    // escape the test runner. The production pointer handler ignores this promise.
    outcome = pending.then((value) => ({ value }), (error) => ({ error }));
    return pending;
  });
  const gesture = async () => {
    const at = (x) => ({ clientX: x, clientY: 200, shiftKey: false });
    expect(layer.pointer(at(145), 'down')).toBe(true);
    layer.pointer(at(155), 'move');
    layer.pointer(at(155), 'up');
    return outcome;
  };
  const before = doc.state;
  const result = await gesture();
  expect(layer.svc.heal).toHaveBeenCalledTimes(1);
  expect(result.error).toBeUndefined();
  expect(app.notify).toHaveBeenCalledExactlyOnceWith('Spot healing could not be applied: DSP download failed', { error: true });
  expect(result).toEqual({ value: false });
  expect(doc.state === before).toBe(true);
  expect(doc.dirty).toBe(false);

  failure.error = null;
  const retry = await gesture();
  expect(retry.error).toBeUndefined();
  expect(doc.history.undoLabel).toBe('Spot Healing Brush');
  expect(doc.state.channels[0].toArray(4096, 4097)[0]).toBeLessThan(0.99);
  expect(app.notify).toHaveBeenCalledTimes(1);
  doc.history.undo();
  expect(doc.state === before).toBe(true);
});
