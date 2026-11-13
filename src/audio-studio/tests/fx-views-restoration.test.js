import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import '../src/effects/catalog.js';
import '../src/effects/views/index.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { getEffect, slotSpec } from '../src/effects/registry.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { packNoisePrint, curveGainAt, serializeNoisePrint, parseNoisePrint, FLAT_CURVE } from '../src/effects/defs/restoration.js';
import { printLevels } from '../src/effects/views/noise-print.js';
import { fakeApp, filled } from './fx-helpers.js';

const print = () => ({ id: 77, rate: 48000, fftSize: 512, frames: 10, seconds: 1, channels: [new Float32Array(257).fill(1e-6), new Float32Array(257).fill(4e-6)] });

describe('noise print threshold curve', () => {
  it('interpolates the adjustment on a log-frequency axis', () => {
    const c = [{ f: 100, g: 0 }, { f: 1000, g: 10 }];
    expect(curveGainAt(c, 50)).toBe(0);
    expect(curveGainAt(c, Math.sqrt(100 * 1000))).toBeCloseTo(5);
    expect(curveGainAt(c, 5000)).toBe(10);
    expect(curveGainAt([], 300)).toBe(0);
  });
  it('scales the packed print power per bin and caches by curve', () => {
    const p = print();
    const flat = packNoisePrint(p);
    expect(packNoisePrint(p, FLAT_CURVE)).toBe(flat);
    const up = packNoisePrint(p, [{ f: 20, g: 10 }, { f: 20000, g: 10 }]);
    expect(up).not.toBe(flat);
    expect(up[4 + 100] / p.channels[0][100]).toBeCloseTo(10, 4);
    expect(up[4 + 257 + 100] / p.channels[1][100]).toBeCloseTo(10, 4);
    expect(up.slice(0, 4)).toEqual(flat.slice(0, 4));
  });
  it('changes the data id only when the curve bends', () => {
    const def = getEffect('noiseReduction');
    const doc = { noisePrint: print(), sampleRate: 48000 };
    const a = slotSpec(def, { curve: FLAT_CURVE }, { doc }).data[0].id;
    const b = slotSpec(def, { curve: [{ f: 20, g: 0 }, { f: 2000, g: -6 }, { f: 20000, g: 0 }] }, { doc }).data[0].id;
    expect(a).toBe('np77');
    expect(b).not.toBe(a);
  });
  it('saves and loads a print, and rejects other files', () => {
    const p = print();
    const back = parseNoisePrint(JSON.stringify(serializeNoisePrint(p)));
    expect(back.fftSize).toBe(512);
    expect(back.channels[1][3]).toBeCloseTo(4e-6, 10);
    expect(back.id).not.toBe(p.id);
    expect(() => parseNoisePrint('{"type":"other"}')).toThrow(/not a noise print/);
    expect(() => parseNoisePrint({ ...serializeNoisePrint(p), channels: [[1, 2]] })).toThrow();
  });
  it('smooths the print levels the threshold follows', () => {
    const p = print();
    p.channels[0][50] = 1e-2;
    const { raw, smooth } = printLevels(p, 0);
    expect(raw[50]).toBeCloseTo(-20);
    expect(smooth[50]).toBeLessThan(raw[50]);
    expect(smooth[200]).toBeCloseTo(-60, 0);
  });
});

describe('noise reduction dialog', () => {
  function setup() {
    const app = fakeApp();
    const doc = new AudioFile({ name: 'a.wav', sampleRate: 48000, channels: [Channel.fromSamples(filled(48000, 0.1)), Channel.fromSamples(filled(48000, 0.1))] });
    app.active = doc;
    app.commands.register({ id: 'fx.captureNoisePrint', label: 'Capture', run: () => {
      doc.noisePrint = print();
      doc.emit('change', { kind: 'noisePrint' });
    } });
    return { app, doc };
  }
  it('captures a print from the dialog and adjusts the threshold with the keyboard', async () => {
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('noiseReduction'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    expect(dlg.querySelector('.nr-status').textContent).toBe('Noise print: none');
    [...dlg.querySelectorAll('.btn')].find((b) => b.textContent === 'Capture Noise Print').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(dlg.querySelector('.nr-status').textContent).toMatch(/1\.00 s, 2 channels, FFT 512/);
    const handle = dlg.querySelector('.nr-graph .fx-point');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
    // Advanced settings sit in a collapsed section; the main controls are visible.
    expect(dlg.querySelector('details.fx-disclosure').textContent).toMatch(/FFT Size/);
    dlg.querySelector('.btn.primary').click();
    const values = await p;
    expect(values.curve[0].g).toBe(5);
  });
  it('selects the entire file', async () => {
    const { app, doc } = setup();
    doc.setSelection(100, 200);
    const p = openEffectDialog(app, getEffect('noiseReduction'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    [...dlg.querySelectorAll('.btn')].find((b) => b.textContent === 'Select Entire File').click();
    expect(doc.selection).toMatchObject({ start: 0, end: 48000 });
    dlg.querySelector('.dialog-head .icon-btn').click();
    await p;
  });
});

describe('dehummer view', () => {
  it('draws a handle on the base notch that moves the frequency', async () => {
    const app = fakeApp();
    const doc = new AudioFile({ name: 'a.wav', sampleRate: 48000, channels: [Channel.fromSamples(filled(4800, 0.1))] });
    app.active = doc;
    const p = openEffectDialog(app, getEffect('dehummer'), { doc, values: { frequency: 60 } });
    const dlg = document.querySelector('.fx-dialog');
    const handle = dlg.querySelector('.fx-response .fx-handle');
    expect(handle.getAttribute('aria-valuetext')).toMatch(/60 Hz/);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    dlg.querySelector('.btn.primary').click();
    expect((await p).frequency).toBeLessThan(60);
  });

  it('draws the Output Hum Only curve the processor applies', async () => {
    const { instance } = await import('./fx-wasm.js');
    const { paramArray } = await import('../src/effects/registry.js');
    const def = getEffect('dehummer');
    const rate = 48000;
    const values = { frequency: 117, q: 38, gain: -32, harmonics: 16, slope: 78, humOnly: true };
    const freqs = [500, 961, 1500, 2400];
    const drawn = def.response(values, Float32Array.from(freqs), rate);
    const x = instance();
    freqs.forEach((f, k) => {
      const h = x.fx_new(def.kind, rate, 1);
      paramArray(def, values).forEach((v, i) => x.fx_set(h, i, v));
      x.fx_reset(h);
      const n = rate;
      const buf = x.mem_alloc(n * 4);
      const io = new Float32Array(x.memory.buffer, buf, n);
      for (let i = 0; i < n; i++) io[i] = 0.25 * Math.sin((2 * Math.PI * f * i) / rate);
      x.fx_process(h, buf, n);
      const y = new Float32Array(x.memory.buffer, buf, n);
      let e = 0;
      for (let i = n / 2; i < n; i++) e += y[i] * y[i];
      const measured = 10 * Math.log10(e / (n / 2) / (0.25 * 0.25 * 0.5));
      expect(Math.abs(measured - drawn[k]), `${f} Hz`).toBeLessThan(0.5);
      x.mem_free(buf, n * 4);
      x.fx_free(h);
    });
  });
});

describe('automatic phase correction', () => {
  it('shifts a channel by hand while the automatic shift is off', async () => {
    await import('./fx-wasm.js');
    const { dsp } = await import('../src/audio/dsp.js');
    const { paramArray } = await import('../src/effects/registry.js');
    const { normalizeValues } = await import('../src/effects/params.js');
    const d = await dsp();
    const def = getEffect('autoPhaseCorrection');
    const n = 24000;
    const x = Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.05) + 0.5 * Math.sin(i * 0.31));
    const v = normalizeValues(def, { globalShift: false, rightShift: 10 / 48000 * 1e6 });
    const [l, r] = d.runEffect(def.kind, 48000, [x, x], paramArray(def, v));
    // The right channel now trails the left by 10 frames.
    let err = 0;
    for (let i = 12000; i < 20000; i++) err = Math.max(err, Math.abs(r[i] - l[i - 10]));
    expect(err).toBeLessThan(0.05);
  });
  it('greys out the manual shifts while the automatic shift is on', async () => {
    const app = fakeApp();
    const doc = new AudioFile({ name: 'a.wav', sampleRate: 48000, channels: [Channel.fromSamples(filled(4800, 0.1)), Channel.fromSamples(filled(4800, 0.1))] });
    app.active = doc;
    const p = openEffectDialog(app, getEffect('autoPhaseCorrection'), { doc, values: { globalShift: true } });
    const dlg = document.querySelector('.fx-dialog');
    const left = [...dlg.querySelectorAll('input[type=range]')].find((s) => s.getAttribute('aria-label') === 'Left Channel Shift');
    expect(left.disabled).toBe(true);
    dlg.querySelector('.dialog-head .icon-btn').click();
    await p;
  });
});

describe('denoise and dereverb', () => {
  it('denoise can output what it removes, dereverb can make up its level', async () => {
    await import('./fx-wasm.js');
    const { dsp } = await import('../src/audio/dsp.js');
    const { paramArray } = await import('../src/effects/registry.js');
    const { normalizeValues } = await import('../src/effects/params.js');
    const d = await dsp();
    const x = Float32Array.from({ length: 24000 }, (_, i) => 0.2 * Math.sin(i * 1.7) * Math.sin(i * 0.013) + 0.05 * Math.sin(i * 2.9));
    const dn = getEffect('denoise');
    const run = (def, v) => d.runEffect(def.kind, 48000, [x], paramArray(def, normalizeValues(def, v)))[0];
    const kept = run(dn, { amount: 80 });
    const removed = run(dn, { amount: 80, noiseOnly: true });
    let err = 0;
    for (let i = 12000; i < 24000; i++) err = Math.max(err, Math.abs(kept[i] + removed[i] - x[i]));
    expect(err).toBeLessThan(1e-3);
    const dr = getEffect('dereverb');
    const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    expect(rms(run(dr, { amount: 100, decay: 3000, autoGain: true }).subarray(12000))).toBeGreaterThan(rms(run(dr, { amount: 100, decay: 3000 }).subarray(12000)));
  });
});

describe('hiss reduction noise floor', () => {
  it('turns a captured spectrum into floor points and reads them back', async () => {
    const { floorPoints, floorAt } = await import('../src/effects/defs/restoration.js');
    const spec = new Float32Array(2049).fill(1e-6);
    const pts = floorPoints(spec, 4096, 48000);
    expect(pts[0].f).toBe(1);
    expect(pts.length).toBe(24);
    expect(pts.at(-1).f).toBe(24000);
    pts.forEach((p) => expect(p.g).toBeCloseTo(-60, 1));
    const c = [{ f: 1, g: -60 }, { f: 101, g: -80 }, { f: 10100, g: -100 }];
    expect(floorAt(c, 51)).toBeCloseTo(-70);
    expect(floorAt(c, 1010)).toBeCloseTo(-90);
    expect(floorAt(c, 20000)).toBe(-100);
    expect(floorAt([], 100)).toBe(-140);
  });
  it('sends each channel floor as a data block, empty while tracking', () => {
    const def = getEffect('hissReduction');
    const auto = slotSpec(def, {}).data;
    expect(auto.map((d) => d.slot)).toEqual([0, 1]);
    expect(auto[0].values.length).toBe(1);
    const spec = slotSpec(def, { floorLeft: [{ f: 1, g: -70 }, { f: 24000, g: -90 }] }).data;
    expect(Array.from(spec[0].values)).toEqual([1, -70, 24000, -90]);
    expect(spec[0].id).not.toBe(auto[0].id);
    expect(spec[1].id).toBe(auto[1].id);
  });
  it('captures the floor in the dialog, edits it and returns to tracking', async () => {
    const app = fakeApp();
    let seed = 1;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.02;
    const doc = new AudioFile({ name: 'a.wav', sampleRate: 48000, channels: [Channel.fromSamples(filled(48000, rnd)), Channel.fromSamples(filled(48000, () => rnd() * 0.1))] });
    app.active = doc;
    const p = openEffectDialog(app, getEffect('hissReduction'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    expect(dlg.querySelector('.nr-status').textContent).toMatch(/automatically/);
    expect(dlg.querySelector('.hr-graph .fx-point')).toBeNull();
    [...dlg.querySelectorAll('.btn')].find((b) => b.textContent === 'Capture Noise Floor').click();
    for (let i = 0; i < 20 && !dlg.querySelector('.hr-graph .fx-point'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(dlg.querySelector('.nr-status').textContent).toMatch(/captured/);
    const handle = dlg.querySelector('.hr-graph .fx-point');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    // The log scale shows the same points.
    const scale = [...dlg.querySelectorAll('select')].find((s) => s.getAttribute('aria-label') === 'Graph scale');
    scale.value = '1';
    scale.dispatchEvent(new Event('change'));
    expect(dlg.querySelectorAll('.hr-graph .fx-point').length).toBe(24);
    dlg.querySelector('.btn.primary').click();
    const values = await p;
    expect(values.floorLeft.length).toBe(24);
    // The quieter right channel reads about 20 dB lower.
    expect(values.floorLeft[12].g - values.floorRight[12].g).toBeGreaterThan(15);
    expect(values.floorScale).toBe(1);
  });
});
