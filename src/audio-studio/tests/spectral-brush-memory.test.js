import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installSpectral } from '../src/spectral/install.js';
import { WaveformView } from '../src/editor/waveform-view.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';

const extensions = WaveformView.extensions.length;
let view;
beforeEach(async () => {
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

it.each(['click', 'stroke'])('bounds a healing %s on a zoomed-out long file before allocating its mask', async (kind) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  installSpectral(app);
  await dsp();
  app.prefs.set('spectralDisplay', true);
  app.prefs.set('spectralLog', false);
  const rate = 48000;
  const centre = rate * 1800;
  // An hour-long timeline costs only one shared silence block plus piece metadata.
  const channel = Channel.silence(rate * 3600).write(centre, Float32Array.of(1));
  const doc = app.addDocument(new AudioFile({ name: 'Long.wav', sampleRate: rate, channels: [channel] }));
  view = new WaveformView(app, doc);
  document.body.append(view.el);
  view.width = 600;
  const layer = view.layers.find((layer) => layer.id === 'spectral');
  const layout = () => { view.width = 600; layer.layout({ y: 100, width: 600, height: 200, dpr: 1 }); };
  layout();
  app.setTool('heal');
  const heal = layer.svc.heal.bind(layer.svc);
  let pending;
  vi.spyOn(layer.svc, 'heal').mockImplementation((...args) => (pending = heal(...args)));
  const gesture = (start, end = start) => {
    const at = (x) => ({ clientX: x, clientY: 200, shiftKey: false });
    expect(layer.pointer(at(start), 'down')).toBe(true);
    if (end !== start) layer.pointer(at(end), 'move');
    layer.pointer(at(end), 'up');
    return pending;
  };

  const oversized = [];
  const NativeFloat32Array = globalThis.Float32Array;
  vi.stubGlobal('Float32Array', new Proxy(NativeFloat32Array, {
    construct(target, args) {
      if (typeof args[0] === 'number' && args[0] > 1_000_000) {
        oversized.push(args[0]);
        // Fail BEFORE allocating: the baseline must never allocate its large mask.
        throw new RangeError('Test allocation guard');
      }
      return Reflect.construct(target, args);
    },
  }));
  const before = doc.state;
  expect(await (kind === 'click' ? gesture(300) : gesture(100, 500))).toBe(false);
  expect(oversized).toEqual([]);
  expect(app.notify).toHaveBeenCalledExactlyOnceWith('Spot healing works on selections up to 4 seconds. Zoom in or use a smaller brush.', { error: true });
  expect(doc.state === before).toBe(true);
  expect(doc.dirty).toBe(false);

  // Zooming in makes the same brush safe; native processing remains available.
  doc.setView(centre - 8192, centre + 8192);
  layout();
  await gesture(300, 310);
  expect(oversized).toEqual([]);
  expect(app.notify).toHaveBeenCalledTimes(1);
  expect(doc.history.undoLabel).toBe('Spot Healing Brush');
  expect(doc.state.channels[0].toArray(centre, centre + 1)[0]).toBeLessThan(0.99);
  doc.history.undo();
  expect(doc.state === before).toBe(true);
});
