import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import '../src/effects/catalog.js';
import '../src/effects/views/index.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { getEffect, slotSpec } from '../src/effects/registry.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { normalizeValues } from '../src/effects/params.js';
import { bendRange } from '../src/effects/defs/time-pitch.js';
import { clockText, parseClock, noteName } from '../src/effects/views/time-pitch.js';
import { dsp } from '../src/audio/dsp.js';
import { fakeApp, filled } from './fx-helpers.js';

function setup(seconds = 2) {
  const app = fakeApp();
  const doc = new AudioFile({ name: 'a.wav', sampleRate: 8000, channels: [Channel.fromSamples(filled(8000 * seconds, 0.1))] });
  app.active = doc;
  return { app, doc };
}

describe('time and pitch helpers', () => {
  it('formats and reads clock times', () => {
    expect(clockText(12)).toBe('0:12.000');
    expect(clockText(3725.5)).toBe('1:02:05.500');
    expect(parseClock('1:02.5')).toBeCloseTo(62.5);
    expect(parseClock('90s')).toBe(90);
    expect(parseClock('abc')).toBeNaN();
  });
  it('turns a tempo change into a pitch bend range', () => {
    expect(bendRange({ rangeMode: 0, range: 7 })).toBe(7);
    expect(bendRange({ rangeMode: 1, bpmRange: 90, tempo: 90 })).toBeCloseTo(12);
    expect(noteName(69)).toBe('A4');
    expect(noteName(60)).toBe('C4');
  });
  it('bends further with a spline envelope only where the curve eases', async () => {
    const d = await dsp();
    const def = getEffect('pitchBender');
    const x = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 5));
    const env = [{ t: 0, v: 0 }, { t: 0.5, v: 12 }, { t: 1, v: 12 }];
    const [lin] = await def.run({ channels: [x], rate: 8000, values: normalizeValues(def, { envelope: env, range: 12 }), dsp: d });
    const [spl] = await def.run({ channels: [x], rate: 8000, values: normalizeValues(def, { envelope: env, range: 12, spline: true }), dsp: d });
    // Varispeed: the higher the pitch, the shorter the result. Both end shorter than the input, and differ.
    expect(lin.length).toBeLessThan(16000);
    expect(spl.length).toBeLessThan(16000);
    expect(Math.abs(lin.length - spl.length)).toBeGreaterThan(10);
  });
});

describe('time and pitch views', () => {
  it('stretch and pitch sets the stretch from a typed new duration', async () => {
    const { app, doc } = setup(2);
    const p = openEffectDialog(app, getEffect('stretchPitch'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    expect(dlg.querySelector('.sp-durations').textContent).toContain('0:02.000');
    const hot = dlg.querySelector('.sp-durations .hot');
    hot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const input = dlg.querySelector('.sp-durations .hot-edit');
    input.value = '0:03';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const resample = [...dlg.querySelectorAll('.fx-check input')].find((i) => i.closest('label').textContent.includes('Resample'));
    resample.checked = true;
    resample.dispatchEvent(new Event('change'));
    dlg.querySelector('.btn.primary').click();
    const v = await p;
    expect(v.stretch).toBeCloseTo(150, 1);
    expect(v.algorithm).toBe(2);
  });
  it('stretch and pitch can lock the new duration instead of the stretch', async () => {
    const { app, doc } = setup(2);
    const p = openEffectDialog(app, getEffect('stretchPitch'), { doc, values: { stretch: 150 } });
    const dlg = document.querySelector('.fx-dialog');
    const lock = [...dlg.querySelectorAll('.fx-check input')].find((i) => i.closest('label').textContent.includes('New Duration'));
    lock.checked = true;
    lock.dispatchEvent(new Event('change'));
    dlg.querySelector('.btn.primary').click();
    const v = await p;
    expect(v.lockDuration).toBe(true);
    expect(v.targetDuration).toBeCloseTo(3, 3);
  });

  it('pitch shifter shows the ratio', async () => {
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('pitchShifter'), { doc, values: { semitones: 12 } });
    const dlg = document.querySelector('.fx-dialog');
    expect(dlg.querySelector('.sp-ratio').textContent).toContain('2.0000');
    // Typing a ratio sets the nearest semitones and cents.
    const hot = dlg.querySelector('.sp-ratio .hot');
    hot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const input = dlg.querySelector('.sp-ratio .hot-edit');
    input.value = '1.5';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    dlg.querySelector('.btn.primary').click();
    expect(await p).toMatchObject({ semitones: 7, cents: 2 });
  });
  it('pitch shifter switches to manual splicing settings', async () => {
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('pitchShifter'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    const sliders = () => [...dlg.querySelectorAll('input[type=range]')].filter((i) => /Splicing|Overlapping/.test(i.getAttribute('aria-label')));
    expect(sliders()).toHaveLength(2);
    expect(sliders().every((i) => i.disabled)).toBe(true);
    expect(dlg.textContent).toMatch(/Spectral frames of \d+ samples/);
    const auto = [...dlg.querySelectorAll('.fx-check input')].find((i) => i.closest('label').textContent.includes('Automatic'));
    auto.click();
    expect(sliders().every((i) => !i.disabled)).toBe(true);
    // Precision and formants belong to the spectral shifter.
    expect([...dlg.querySelectorAll('.fx-radios input')].every((i) => i.disabled)).toBe(true);
    dlg.querySelector('.btn.primary').click();
    expect((await p).autoSplice).toBe(false);
  });
  it('pitch shifter reports the latency the processor has', async () => {
    const { instance } = await import('./fx-wasm.js');
    const { paramArray, defaults } = await import('../src/effects/registry.js');
    const { effectLatency } = await import('../src/effects/index.js');
    const def = getEffect('pitchShifter');
    for (const extra of [{}, { autoSplice: false }, { autoSplice: false, splice: 37 }, { autoSplice: false, splice: 200 }, { precision: 2 }]) {
      const values = { ...defaults(def), ...extra };
      const x = instance();
      const h = x.fx_new(def.kind, 44100, 2);
      paramArray(def, values).forEach((v, i) => x.fx_set(h, i, v));
      expect(effectLatency(def, values, 44100)).toBe(x.fx_latency(h));
    }
  });
  it('pitch bender quality sets the resampling kernel', async () => {
    const d = await dsp();
    const def = getEffect('pitchBender');
    expect(def.params.find((q) => q.id === 'quality').options.map((o) => o.label)).toEqual(['Low', 'Medium', 'High', 'Very High', 'Near Perfect', 'Perfect']);
    // A tone near Nyquist, lowered a fifth: the short Low kernel smears it more than Perfect.
    const x = Float32Array.from({ length: 16000 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 3600 * i) / 8000));
    const env = [{ t: 0, v: -7 }, { t: 1, v: -7 }];
    const run = async (quality) => (await def.run({ channels: [x], rate: 8000, values: normalizeValues(def, { envelope: env, range: 12, quality }), dsp: d }))[0];
    const [low, perfect] = [await run(0), await run(5)];
    expect(low.length).toBe(perfect.length);
    const rms = (y) => {
      let e = 0;
      for (let i = 2000; i < y.length - 2000; i++) e += y[i] ** 2;
      return Math.sqrt(e / (y.length - 4000));
    };
    // The longer kernel keeps the tone's level; the short one rolls it off.
    expect(rms(perfect)).toBeCloseTo(0.3536, 1);
    expect(rms(low)).toBeLessThan(rms(perfect) * 0.9);
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('pitchBender'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    expect([...dlg.querySelectorAll('select')].some((s) => s.getAttribute('aria-label') === 'Quality' && s.value === '4')).toBe(true);
    dlg.querySelector('.dialog-head .icon-btn').click();
    await p;
  });
  it('pitch bender scales its graph to the tempo range', async () => {
    const { app, doc } = setup();
    const p = openEffectDialog(app, getEffect('pitchBender'), { doc, values: { range: 2 } });
    const dlg = document.querySelector('.fx-dialog');
    const tempo = [...dlg.querySelectorAll('.fx-radio input')].find((i) => i.value === '1');
    tempo.checked = true;
    tempo.dispatchEvent(new Event('change'));
    expect(dlg.querySelector('.pb-range:not([hidden])').textContent).toMatch(/semitones/);
    dlg.querySelector('.btn.primary').click();
    expect((await p).rangeMode).toBe(1);
  });
  it('automatic pitch correction meters the live correction', async () => {
    const { app, doc } = setup();
    expect(slotSpec(getEffect('automaticPitchCorrection'), {}).readout).toBe(true);
    const p = openEffectDialog(app, getEffect('automaticPitchCorrection'), { doc });
    const dlg = document.querySelector('.fx-dialog');
    app.engine.emit('fx-readout', [['preview:automaticPitchCorrection', Float32Array.from([-47, 452, 69])]]);
    expect(dlg.querySelector('.apc-text').textContent).toBe('Correction: -47.0 cents, A4 (452.0 Hz in)');
    expect(dlg.querySelector('.apc-meter').getAttribute('aria-valuenow')).toBe('-47');
    dlg.querySelector('.dialog-head .icon-btn').click();
    await p;
  });
});
