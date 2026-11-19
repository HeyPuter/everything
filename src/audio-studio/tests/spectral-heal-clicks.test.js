// Spot healing a click marked on a zoomed-in spectral display: the stroke is narrower
// than the analysis column spacing, and must still be healed.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setDspBytes, dsp } from '../src/audio/dsp.js';
import { healSpectral } from '../src/spectral/process.js';
import { Channel } from '../src/audio/channel.js';

let d;
beforeAll(async () => {
  setDspBytes(fs.readFileSync(path.resolve(process.cwd(), 'src/audio/dsp.wasm')));
  d = await dsp();
});

const RATE = 44100;
const roughness = (x, a, b) => {
  let m = 0;
  for (let i = a + 2; i < b; i++) m = Math.max(m, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]));
  return m;
};

describe('healing clicks', () => {
  const x = Float32Array.from({ length: RATE }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 330 * i) / RATE));
  const at = 13230; // between analysis column centres
  for (let j = 0; j < 6; j++) x[at + j] += j % 2 ? -0.8 : 0.9;
  const state = { sampleRate: RATE, channels: [Channel.fromSamples(x)], markers: [] };
  const window = (s) => s.channels[0].toArray(at - 400, at + 400);

  it('heals a click under a narrow rectangle', () => {
    const sel = { channels: [true], shapes: [{ type: 'rect', t0: at - 20, t1: at + 30, f0: 0, f1: RATE / 2 }] };
    const out = healSpectral(state, sel, d);
    expect(roughness(window(out), 0, 800)).toBeLessThan(roughness(window(state), 0, 800) / 3);
  });

  it('heals a click under a brush stroke with dots between column centres', () => {
    const dots = [100, 200, 400, 800, 1600, 3200, 6400, 12800, 20000].map((f) => [at + 3, f]);
    const sel = { channels: [true], shapes: [{ type: 'brush', log: true, rt: 120, rf: 0.7, opacity: 1, dots }] };
    const out = healSpectral(state, sel, d);
    expect(roughness(window(out), 0, 800)).toBeLessThan(roughness(window(state), 0, 800) / 3);
  });
});

describe('Shift+click with the healing brush', () => {
  it('heals a full-height column as wide as the brush, widened by a drag', async () => {
    const { columnShape } = await import('../src/spectral/layer.js');
    expect(columnShape(1000, 1000, 100, 22050)).toEqual({ type: 'rect', t0: 900, t1: 1100, f0: 0, f1: 22050 });
    expect(columnShape(1500, 1000, 100, 22050)).toMatchObject({ t0: 900, t1: 1600 });
    expect(columnShape(50, 50, 100, 22050).t0).toBe(0);
  });

  it('sends the column to the healing service on a Shift+click', async () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    };
    HTMLCanvasElement.prototype.getContext = () => null;
    localStorage.clear();
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { installSpectralAnalysis } = await import('../src/features/spectral-analysis.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { WaveformView } = await import('../src/editor/waveform-view.js');
    const app = new App();
    installCore(app);
    installSpectralAnalysis(app);
    const doc = new AudioFile({ name: 't.wav', sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(48000))] });
    app.addDocument(doc);
    app.prefs.set('spectralDisplay', true);
    const view = new WaveformView(app, doc);
    document.body.replaceChildren(view.el);
    const layer = view.layers.find((l) => l.id === 'spectral' && l.app === app);
    view.width = 600;
    layer.layout({ x: 0, y: 100, width: 600, height: 200, dpr: 1 });
    view.surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 300 });
    app.commands.run('tool.heal');
    const calls = [];
    layer.svc.heal = (d, sel) => calls.push(sel);
    const ev = { clientX: 300, clientY: 200, shiftKey: true };
    expect(layer.pointer(ev, 'down')).toBe(true);
    layer.pointer(ev, 'up');
    expect(calls).toHaveLength(1);
    const shape = calls[0].shapes[0];
    expect(shape.type).toBe('rect');
    expect([shape.f0, shape.f1]).toEqual([0, 24000]);
    expect(shape.t0).toBeLessThan(24000);
    expect(shape.t1).toBeGreaterThan(24000);
    view.destroy();
  });
});
