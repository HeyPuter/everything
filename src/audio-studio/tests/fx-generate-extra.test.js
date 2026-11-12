import { describe, it, expect } from 'vitest';
import { generateTones, generateNoise, waveSample, sweepValue, wavePreview, noiseSpectrum, dbToGain } from '../src/effects/generate.js';
import { TONES_DEF, NOISE_DEF, renderTones, renderNoise, toneOptions, generatorContext } from '../src/effects/generate-ui.js';
import { tonesBody, noiseBody } from '../src/effects/generate-views.js';
import { normalizeValues } from '../src/effects/params.js';
import { fft } from '../src/multitrack/align.js';

const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const crossingsIn = (a, from, to) => {
  let n = 0;
  for (let i = Math.max(1, from); i < to; i++) if (a[i - 1] < 0 && a[i] >= 0) n++;
  return n;
};

describe('tone generator: sweeps, partials and shapes', () => {
  it('sweeps the base frequency from start to end', () => {
    const rate = 8000;
    const t = generateTones({ rate, frames: rate * 2, base: 100, sweep: { base: 1000, curve: 'linear' }, volumeDb: 0 });
    const first = crossingsIn(t, 0, rate / 10);
    const last = crossingsIn(t, t.length - rate / 10, t.length);
    expect(first).toBeLessThan(20);
    expect(last).toBeGreaterThan(80);
  });
  it('interpolates geometrically for logarithmic sweeps', () => {
    expect(sweepValue(100, 10000, 0.5, 'log')).toBeCloseTo(1000);
    expect(sweepValue(100, 10000, 0.5, 'linear')).toBeCloseTo(5050);
    expect(sweepValue(5, 5, 0.3, 'log')).toBe(5);
  });
  it('places partials at their multipliers', () => {
    const rate = 8000;
    const t = generateTones({ rate, frames: rate, base: 100, components: [0, 1], multipliers: [1, 3.5], volumeDb: 0 });
    expect(crossingsIn(t, 0, rate)).toBeGreaterThanOrEqual(349);
    expect(crossingsIn(t, 0, rate)).toBeLessThanOrEqual(351);
  });
  it('symmetry sets the square duty cycle and leaves 50 % unchanged', () => {
    expect(waveSample('square', 0.2, 0, 0.25)).toBe(1);
    expect(waveSample('square', 0.3, 0, 0.25)).toBe(-1);
    for (const p of [0.1, 0.3, 0.6, 0.9]) {
      expect(waveSample('triangle', p, 0, 0.5)).toBeCloseTo(waveSample('triangle', p));
      expect(waveSample('sine', p, 0, 0.5)).toBeCloseTo(Math.sin(2 * Math.PI * p));
    }
    // A skewed triangle still spans -1..1.
    const tri = Array.from({ length: 200 }, (_, i) => waveSample('triangle', i / 200, 0, 0.2));
    expect(Math.max(...tri)).toBeCloseTo(1, 1);
    expect(Math.min(...tri)).toBeCloseTo(-1, 1);
  });
  it('previews the combined waveform normalised to 1', () => {
    const w = wavePreview({ components: [1, 0.5], waveform: 'sine' }, 128, 2);
    expect(peak(w)).toBeCloseTo(1);
    expect(w).toHaveLength(128);
  });
});

describe('Generate Tones reach', () => {
  it('modulates at audio rates and depths, and goes down to -120 dB', () => {
    const r = (id) => {
      const p = TONES_DEF.params.find((q) => q.id === id);
      return [p.min, p.max];
    };
    expect(r('modulateBy')).toEqual([0, 20000]);
    expect(r('modFreq')).toEqual([0.1, 20000]);
    expect(r('volume')).toEqual([-120, 0]);
    expect(r('base')[0]).toBe(1);
    // FM at 1 kHz rate and 5 kHz depth on a 1 kHz carrier: finite, at the volume, with sidebands.
    const x = generateTones({ rate: 48000, frames: 48000, base: 1000, modulateBy: 5000, modFreq: 1000, volumeDb: -6 });
    expect(x.every(Number.isFinite)).toBe(true);
    expect(Math.max(...x.map(Math.abs))).toBeCloseTo(dbToGain(-6), 2);
    const quiet = generateTones({ rate: 48000, frames: 4800, base: 1000, volumeDb: -120 });
    expect(Math.max(...quiet.map(Math.abs))).toBeCloseTo(1e-6, 7);
  });
});

describe('Generate Tones settings', () => {
  it('maps enabled components with dB amplitudes and multipliers', () => {
    const v = normalizeValues(TONES_DEF, { on1: true, amp1: 0, on2: true, amp2: -6, mul2: 2.5, on3: false });
    const o = toneOptions(v, 48000, 100);
    expect(o.components[0]).toBe(1);
    expect(o.components[1]).toBeCloseTo(dbToGain(-6));
    expect(o.components[2]).toBe(0);
    expect(o.multipliers[1]).toBe(2.5);
    expect(o.sweep).toBeNull();
    expect(toneOptions({ ...v, sweep: true }, 48000, 100).sweep).toMatchObject({ base: v.endBase, curve: 'log' });
  });
  it('renders a phase-shifted right channel only when asked', () => {
    const v = normalizeValues(TONES_DEF, { base: 1000, duration: 0.01, startPhase: 0 });
    expect(renderTones(v, 48000, 2)).toHaveLength(1);
    const [l, r] = renderTones({ ...v, phaseOffset: 90 }, 48000, 2);
    expect(l[0]).toBeCloseTo(0);
    expect(r[0]).toBeCloseTo(dbToGain(v.volume), 3);
  });
  it('every preset normalises to valid values', () => {
    for (const p of TONES_DEF.presets) expect(Object.keys(normalizeValues(TONES_DEF, p.values))).toHaveLength(TONES_DEF.params.length);
    for (const p of NOISE_DEF.presets) expect(normalizeValues(NOISE_DEF, p.values).color).toBeTruthy();
  });
});

describe('noise generator: spatial style and DC offset', () => {
  it('delays the right channel by the requested time', () => {
    const rate = 48000;
    const [l, r] = generateNoise({ frames: 2000, channels: 2, rate, style: 'spatial', delayUs: 500, seed: 4 });
    // 500 microseconds at 48 kHz is 24 frames.
    for (let i = 24; i < 200; i++) expect(r[i]).toBeCloseTo(l[i - 24], 5);
    expect(r[0]).not.toBe(0);
  });
  it('adds a DC offset without exceeding the volume', () => {
    const [x] = generateNoise({ frames: 20000, color: 'white', volumeDb: 0, dcOffset: 0.5, seed: 2 });
    const mean = x.reduce((s, v) => s + v, 0) / x.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(peak(x)).toBeLessThanOrEqual(1.0001);
  });
  it('renders from dialog values', () => {
    const v = normalizeValues(NOISE_DEF, { style: 'mono', duration: 0.01 });
    const outs = renderNoise(v, 8000, 2, 3);
    expect(outs).toHaveLength(2);
    expect(outs[0]).toEqual(outs[1]);
  });
  it('measures a falling spectrum for brown noise and a flat one for white', () => {
    const white = noiseSpectrum({ color: 'white', rate: 48000, bins: 40, frames: 8 }, fft);
    const brown = noiseSpectrum({ color: 'brown', rate: 48000, bins: 40, frames: 8 }, fft);
    const slope = (s) => s.db[s.db.length - 2] - s.db[Math.floor(s.db.length / 2)];
    expect(Math.abs(slope(white))).toBeLessThan(6);
    expect(slope(brown)).toBeLessThan(-10);
    expect(Math.max(...white.db)).toBe(0);
  });
  it('keeps brown and grey noise the same colour at 8, 48 and 192 kHz', () => {
    for (const color of ['brown', 'grey']) {
      // Level at 100 Hz over the level at 1 kHz, with about 23 Hz resolution at every rate.
      const tilt = (rate) => {
        const size = 2 ** Math.ceil(Math.log2(rate / 24));
        const s = noiseSpectrum({ color, rate, bins: 120, size, frames: 24 }, fft);
        const at = (f) => s.db[s.freqs.findIndex((x) => x >= f)];
        return at(100) - at(1000);
      };
      const ref = tilt(48000);
      expect(ref, color).toBeGreaterThan(10);
      for (const rate of [8000, 192000]) {
        expect(Math.abs(tilt(rate) - ref), `${color} ${rate}`).toBeLessThan(3);
      }
    }
  });
});

describe('generator dialog bodies', () => {
  it('tones body binds components, sweep tabs and volume to the values', () => {
    const ctx = generatorContext(TONES_DEF, {});
    const el = tonesBody(ctx);
    const tabs = el.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[1].disabled).toBe(true);
    ctx.set('sweep', true);
    expect(tabs[1].disabled).toBe(false);
    const checks = el.querySelectorAll('.gen-comp input[type="checkbox"]');
    expect(checks).toHaveLength(5);
    checks[2].checked = true;
    checks[2].dispatchEvent(new Event('change'));
    expect(ctx.values.on3).toBe(true);
    ctx.set('mul2', 4);
    expect(el.querySelectorAll('.gen-comp-freq')[1].textContent).toBe('1.76 kHz');
  });
  it('noise body shows the delay only for the spatial style', () => {
    const ctx = generatorContext(NOISE_DEF, {});
    const el = noiseBody(ctx);
    const delayRow = [...el.querySelectorAll('.fx-label')].find((l) => l.textContent.replace(/:$/, '') === 'Delay').closest('.fx-controls');
    expect(delayRow.hidden).toBe(true);
    ctx.set('style', 'spatial');
    expect(delayRow.hidden).toBe(false);
  });
});

describe('speech delivery', () => {
  it('speeds up speech without changing its level, and scales the volume', async () => {
    await import('./fx-wasm.js');
    const { dsp } = await import('../src/audio/dsp.js');
    const { shapeSpeech } = await import('../src/effects/generate-ui.js');
    const d = await dsp();
    const rate = 16000;
    const x = Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / rate));
    const [fast] = await shapeSpeech(d, [x], rate, { speed: 200, volume: 100 });
    expect(fast.length).toBeGreaterThan(rate * 0.45);
    expect(fast.length).toBeLessThan(rate * 0.55);
    const [quiet] = await shapeSpeech(d, [x], rate, { speed: 100, volume: 50 });
    expect(quiet.length).toBe(rate);
    expect(peak(quiet)).toBeCloseTo(0.25, 3);
  });
});
