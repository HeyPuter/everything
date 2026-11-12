// Integration: the spectral feature installed on the app, with a waveform view.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setDspBytes, dsp } from '../src/audio/dsp.js';
import { App } from '../src/app.js';
import { installCore } from '../src/features/core.js';
import { installSpectralAnalysis } from '../src/features/spectral-analysis.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { WaveformView } from '../src/editor/waveform-view.js';
import { gainRange } from '../src/model/edits.js';

const RATE = 48000;
const tone = (f, a, n) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / RATE));
function level(x, f, a, b) {
  let s = 0;
  let c = 0;
  for (let i = a; i < b; i++) {
    const ph = (2 * Math.PI * f * i) / RATE;
    s += x[i] * Math.sin(ph);
    c += x[i] * Math.cos(ph);
  }
  return (2 * Math.hypot(s, c)) / (b - a);
}

let app;
let doc;

beforeAll(async () => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = () => null;
  setDspBytes(fs.readFileSync(path.resolve(process.cwd(), 'src/audio/dsp.wasm')));
  await dsp();
  localStorage.clear();
  app = new App();
  installCore(app);
  installSpectralAnalysis(app);
  const n = RATE;
  const x = tone(1000, 0.4, n).map((v, i) => v + 0.4 * Math.sin((2 * Math.PI * 6000 * i) / RATE));
  doc = new AudioFile({ name: 't.wav', sampleRate: RATE, channels: [Channel.fromSamples(x)] });
  app.addDocument(doc);
  const view = new WaveformView(app, doc);
  document.body.append(view.el);
  await dsp();
});

describe('spectral feature', () => {
  it('registers commands, panels and the tool provider', () => {
    for (const id of ['view.spectral', 'view.spectralPitch', 'view.specLog', 'view.specLinear', 'view.zoomInFreq', 'fx.autoHeal', 'fx.matchLoudness', 'spectral.brushLarger']) {
      expect(app.commands.get(id), id).toBeTruthy();
    }
    for (const id of ['frequency', 'amplitude', 'phase', 'loudness']) expect(app.panels.has(id)).toBe(true);
    expect(app.toolAvailable('brush')).toBe(false);
    expect(app.toolAvailable('time')).toBe(true);
  });

  it('makes spectral tools available only with the display on', () => {
    app.commands.run('view.spectral');
    expect(app.prefs.get('spectralDisplay')).toBe(true);
    expect(app.toolAvailable('marquee')).toBe(true);
    expect(app.commands.isEnabled('tool.heal')).toBe(true);
    app.setTool('lasso');
    app.commands.run('view.spectral');
    expect(app.toolAvailable('marquee')).toBe(false);
    expect(app.tool).toBe('time');
    app.prefs.set('spectralDisplay', true);
  });

  it('deletes only the selected time-frequency region', async () => {
    app.spectral.set(doc, { channels: [true], shapes: [{ type: 'rect', t0: 12000, t1: 36000, f0: 700, f1: 1400 }] });
    expect(doc.selection.start).toBe(12000);
    expect(app.commands.isEnabled('edit.delete')).toBe(true);
    await app.commands.run('edit.delete');
    expect(doc.history.undoLabel).toBe('Delete');
    expect(doc.length).toBe(RATE);
    const y = doc.state.channels[0].toArray();
    expect(level(y, 1000, 16000, 32000)).toBeLessThan(0.005);
    expect(level(y, 6000, 16000, 32000)).toBeCloseTo(0.4, 2);
    doc.history.undo();
  });

  it('restricts other edits (effects, the HUD) to the spectral selection', () => {
    app.spectral.set(doc, { channels: [true], shapes: [{ type: 'rect', t0: 0, t1: RATE, f0: 4000, f1: 8000 }] });
    doc.apply('Amplify', gainRange(doc.state, 0, doc.length, 0.5));
    const y = doc.state.channels[0].toArray();
    expect(level(y, 6000, 8000, 40000)).toBeCloseTo(0.2, 2);
    expect(level(y, 1000, 8000, 40000)).toBeCloseTo(0.4, 2);
    doc.history.undo();
  });

  it('clears the spectral selection when the time selection changes', () => {
    app.spectral.set(doc, { channels: [true], shapes: [{ type: 'rect', t0: 100, t1: 2000, f0: 100, f1: 200 }] });
    expect(app.spectral.selection(doc)).toBeTruthy();
    doc.setSelection(0, 50);
    expect(app.spectral.selection(doc)).toBe(null);
  });

  it('auto heals a short time selection as one undo step', async () => {
    doc.setSelection(20000, 21000);
    await app.commands.run('fx.autoHeal');
    expect(doc.history.undoLabel).toBe('Auto Heal');
    doc.history.undo();
    // Longer than the limit (4 s): nothing changes.
    const long = new AudioFile({ name: 'long.wav', sampleRate: RATE, channels: [Channel.silence(RATE * 5)] });
    app.addDocument(long);
    long.setSelection(0, RATE * 5);
    const before = long.state;
    await app.commands.run('fx.autoHeal');
    // Compare identity without diffing sample arrays.
    expect(long.state === before).toBe(true);
    app.activate(doc);
  });

  it('adjusts the brush with the bracket commands', async () => {
    app.setTool('brush');
    const size = JSON.parse(JSON.stringify(app.prefs.get('spectralSettings') || {})).brushSize ?? 24;
    await app.commands.run('spectral.brushLarger');
    expect(app.prefs.get('spectralSettings').brushSize).toBe(Math.round(size * 1.25));
    await app.commands.run('spectral.opacityDown');
    expect(app.prefs.get('spectralSettings').brushOpacity).toBeCloseTo(0.9);
    app.setTool('time');
  });

  it('repairs Diagnostics results in full while a spectral selection exists', async () => {
    await import('../src/effects/index.js');
    const { diagnosticsPanel } = await import('../src/diagnostics/panel.js');
    const { setDiagnosticsWorker } = await import('../src/diagnostics/scan.js');
    setDiagnosticsWorker(null);
    const x = tone(330, 0.3, RATE);
    for (const at of [10000, 30000]) {
      x[at] += 0.6;
      x[at + 1] -= 0.4;
      x[at + 2] += 0.3;
    }
    const clicky = new AudioFile({ name: 'clicks.wav', sampleRate: RATE, channels: [Channel.fromSamples(x)] });
    app.addDocument(clicky);
    const view = new WaveformView(app, clicky);
    document.body.append(view.el);
    // A spectral selection away from the clicks (a high band, early on).
    app.spectral.set(clicky, { channels: [true], shapes: [{ type: 'rect', t0: 1000, t1: 3000, f0: 15000, f1: 20000 }] });
    const p = diagnosticsPanel(app);
    p.select('declicker');
    const button = (re) => [...p.el.querySelectorAll('button')].find((b) => re.test(b.textContent));
    button(/^Scan File$/).click();
    await expect.poll(() => button(/^Repair All$/)?.disabled, { timeout: 5000 }).toBe(false);
    button(/^Repair All$/).click();
    await expect.poll(() => p.el.querySelector('.diag-caption').textContent, { timeout: 5000 }).toMatch(/done/);
    const y = clicky.state.channels[0].toArray();
    for (const at of [10000, 30000]) expect(Math.abs(y[at] - 0.3 * Math.sin((2 * Math.PI * 330 * at) / RATE))).toBeLessThan(0.1);
    view.el.remove();
    app.activate(doc);
  });

  it('does not analyse pitch after the display is hidden', async () => {
    const view = new WaveformView(app, doc);
    document.body.append(view.el);
    const layer = view.layers.find((l) => l.id === 'spectral');
    const failures = [];
    const onFail = (err) => failures.push(err);
    process.on('unhandledRejection', onFail);
    try {
      app.prefs.set('spectralPitch', true);
      layer.layout({ y: 100, width: 600, height: 200, dpr: 1 });
      layer.draw({});
      // Hidden before the pitch analysis (120 ms after a draw) starts.
      app.prefs.set('spectralDisplay', false);
      await new Promise((r) => setTimeout(r, 250));
      expect(failures).toEqual([]);
    } finally {
      process.off('unhandledRejection', onFail);
      app.prefs.set('spectralPitch', false);
      app.prefs.set('spectralDisplay', true);
      view.destroy();
      view.el.remove();
    }
  });

  it('draws again after the display is hidden and shown or the file is switched away and back', async () => {
    // A stand-in WebGL2 context per canvas; losing it (as dispose does) is permanent for that canvas.
    const contexts = new WeakMap();
    const fakeGl = () => {
      let lost = false;
      return new Proxy(
        {},
        {
          get(t, k) {
            if (k === 'getExtension') {
              return (name) => (name === 'WEBGL_lose_context' ? { loseContext: () => (lost = true) } : null);
            }
            if (k === 'isContextLost') return () => lost;
            if (k === 'getParameter') return () => 4096;
            if (k === 'getShaderParameter' || k === 'getProgramParameter') return () => (lost ? null : true);
            if (k === 'getUniformLocation') return () => (lost ? null : {});
            if (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k)) return 1;
            return () => (lost ? null : {});
          },
        },
      );
    };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) {
      if (type !== 'webgl2') return null;
      if (!contexts.has(this)) contexts.set(this, fakeGl());
      return contexts.get(this);
    };
    const view = new WaveformView(app, doc);
    document.body.append(view.el);
    try {
      const layer = view.layers.find((l) => l.id === 'spectral');
      const draw = () => {
        layer.layout({ y: 100, width: 600, height: 200, dpr: 1 });
        layer.draw({});
        return layer.renderer?.available === true;
      };
      expect(draw()).toBe(true);
      app.prefs.set('spectralDisplay', false);
      app.prefs.set('spectralDisplay', true);
      expect(draw()).toBe(true);
      expect(view.el.contains(layer.canvas)).toBe(true);
      layer.release();
      expect(draw()).toBe(true);
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
      view.destroy();
      view.el.remove();
    }
  });

  it('keeps a marquee drag on its lane, clamped to the top and bottom frequencies', async () => {
    const stereo = new AudioFile({
      name: 's.wav',
      sampleRate: RATE,
      channels: [Channel.fromSamples(tone(1000, 0.4, RATE)), Channel.fromSamples(tone(1000, 0.4, RATE))],
    });
    app.addDocument(stereo);
    const view = new WaveformView(app, stereo);
    document.body.append(view.el);
    try {
      view.width = 600;
      const layer = view.layers.find((l) => l.id === 'spectral');
      layer.layout({ y: 100, width: 600, height: 201, dpr: 1 });
      const [left] = layer.lanes();
      const band = layer.scale();
      app.setTool('marquee');
      const at = (x, y) => ({ clientX: x, clientY: y, shiftKey: false });
      expect(layer.pointer(at(100, (left.top + left.bottom) / 2), 'down')).toBe(true);
      // Down into the right channel's lane: the bottom of the left lane, not a frequency of the right one.
      layer.pointer(at(300, left.bottom + 60), 'move');
      layer.pointer(at(300, left.bottom + 60), 'up');
      let shape = app.spectral.selection(stereo).shapes[0];
      expect(shape.f0).toBeCloseTo(band.lo, 3);
      // Up past the top of the spectrogram (into the waveform): the highest frequency.
      layer.pointer(at(100, (left.top + left.bottom) / 2), 'down');
      layer.pointer(at(300, 40), 'move');
      layer.pointer(at(300, 40), 'up');
      shape = app.spectral.selection(stereo).shapes[0];
      expect(shape.f1).toBeCloseTo(band.hi, 3);
    } finally {
      app.setTool('time');
      view.destroy();
      view.el.remove();
      app.activate(doc);
    }
  });

  it('zooms the frequency axis', async () => {
    const { docState } = await import('../src/spectral/state.js');
    app.prefs.set('spectralLog', false);
    await app.commands.run('view.zoomInFreq');
    const st = docState(doc);
    expect(st.hi).toBeLessThan(RATE / 2);
    expect(st.hi - st.lo).toBeCloseTo(RATE / 2 * 0.6, 0);
    await app.commands.run('view.zoomFullFreq');
    expect(st.lo).toBe(0);
    expect(st.hi).toBe(null);
  });
});
