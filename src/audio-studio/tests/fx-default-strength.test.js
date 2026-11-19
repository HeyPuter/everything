// Effects at their default settings do an audible job on typical material:
// measured on synthesized voice-like speech, noise and music.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import { speech, runFx, band, segRms, dbOf, gaussNoise, filter, biquad, rms, spectralPeakiness, sine, peak, RATE } from './helpers/fx-signals.js';
import { getEffect, slotSpec } from '../src/effects/index.js';
import { Channel } from '../src/audio/channel.js';
import { lastValues } from '../src/effects/presets.js';
import { normalizeValues } from '../src/effects/params.js';
import { memoryPrefs } from './fx-helpers.js';
import { captureNoisePrint, detectHum } from '../src/effects/defs/restoration.js';
import { dsp } from '../src/audio/dsp.js';

describe('DeEsser defaults', () => {
  for (const [vowelDb, sibilantDb] of [
    [-18, -26],
    [-30, -40],
    [-14, -20],
    [-12, -28],
  ]) {
    it(`take sibilants down by 3..6 dB and leave vowels alone (vowels ${vowelDb} dBFS, sibilants ${sibilantDb} dBFS)`, async () => {
      const sp = speech({ vowelDb, sibilantDb });
      const [y] = await runFx('deesser', {}, [sp.x]);
      const before = dbOf(segRms(band(sp.x, 5000, 10000), sp.sibilants));
      const after = dbOf(segRms(band(y, 5000, 10000), sp.sibilants));
      expect(before - after).toBeGreaterThan(3);
      expect(before - after).toBeLessThan(6);
      // Vowels: level and their upper range (presence, air) unchanged.
      expect(Math.abs(dbOf(segRms(y, sp.vowels)) - vowelDb)).toBeLessThan(0.1);
      const hf = (s) => dbOf(segRms(band(s, 2000, 20000), sp.vowels));
      expect(hf(sp.x) - hf(y)).toBeLessThan(0.5);
    });
  }
});

describe('Noise Reduction defaults', () => {
  for (const colour of ['white', 'low-pass']) {
    it(`take a steady ${colour} noise floor down by 12..22 dB without musical residue or speech damage`, async () => {
      const d = await dsp();
      const n = RATE * 6;
      let nz = gaussNoise(n + RATE, 0.01, 5);
      if (colour !== 'white') {
        nz = filter(nz, biquad('lp', 400, 0.7));
        const g = 0.01 / rms(nz);
        nz = nz.map((v) => v * g);
      }
      // The print comes from a separate stretch of the same noise.
      const print = await captureNoisePrint(d, [nz.subarray(n, n + RATE)], RATE);
      const sp = speech({ seconds: 6, pause: 1.2 });
      const x = sp.x.map((v, i) => v + nz[i]);
      const [y] = await runFx('noiseReduction', {}, [x], { extra: { noisePrint: print } });
      // Pauses, from half a second after the speech (the gain has settled).
      const quiet = sp.pauses.filter(([a, b]) => b - a > RATE).map(([a, b]) => [a + RATE / 2, b - 2400]);
      const removed = dbOf(segRms(x, quiet)) - dbOf(segRms(y, quiet));
      expect(removed).toBeGreaterThan(12);
      expect(removed).toBeLessThan(22);
      // What is left is a steady, quieter floor (no tonal blips coming and going).
      expect(spectralPeakiness(y, quiet)).toBeLessThan(2.3);
      // Speech: level kept, and the vowels end up closer to the clean voice than the noisy input was.
      expect(Math.abs(dbOf(segRms(y, sp.vowels)) - dbOf(segRms(sp.x, sp.vowels)))).toBeLessThan(0.3);
      const err = (s) => dbOf(segRms(s.map((v, i) => v - sp.x[i]), sp.vowels));
      expect(err(y)).toBeLessThan(err(x));
    });
  }
});

describe('dialogs open with the defaults', () => {
  for (const id of ['deesser', 'noiseReduction', 'normalize', 'dehummer', 'hardLimiter', 'deleteSilence']) {
    it(id, () => {
      const def = getEffect(id);
      expect(lastValues(memoryPrefs(), def)).toEqual(normalizeValues(def, {}));
    });
  }
});

describe('Normalize defaults', () => {
  it('bring the peak to -1 dBFS', async () => {
    const x = sine(4800, 440, RATE, 0.1);
    const [y] = await runFx('normalize', {}, [x]);
    expect(dbOf(peak(y))).toBeCloseTo(-1, 3);
  });

  it('a saved full-scale preset still normalizes to 100 %', async () => {
    const x = sine(4800, 440, RATE, 0.1);
    const [y] = await runFx('normalize', { unit: 1, targetPercent: 100 }, [x]);
    expect(peak(y)).toBeCloseTo(1, 4);
  });
});

describe('Delete Silence defaults', () => {
  it('shorten pauses in speech to about 0.3 s instead of removing them', async () => {
    const sp = speech({ seconds: 8, pause: 1.2 });
    const [y] = await runFx('deleteSilence', {}, [sp.x]);
    // Quiet runs (under -50 dBFS) longer than 50 ms in the result.
    const gaps = [];
    let s = -1;
    for (let i = 0; i <= y.length; i++) {
      const q = i < y.length && Math.abs(y[i]) < 10 ** (-50 / 20);
      if (q && s < 0) s = i;
      if (!q && s >= 0) {
        if (i - s > RATE * 0.05) gaps.push((i - s) / RATE);
        s = -1;
      }
    }
    const long = sp.pauses.filter(([a, b]) => b - a > RATE).length;
    expect(gaps.filter((g) => g > 0.25 && g < 0.4)).toHaveLength(long);
    expect(y.length).toBeLessThan(sp.x.length - long * 0.8 * RATE);
  });
});

describe('Hard Limiter: Maximize to Ceiling', () => {
  const music = () => {
    // Quiet chords with a few louder hits: peak about -20 dBFS.
    const n = RATE * 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      x[i] = 0.03 * (Math.sin(2 * Math.PI * 220 * t) + 0.7 * Math.sin(2 * Math.PI * 330 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t));
      if (i % 24000 < 600) x[i] += 0.04 * Math.sin(2 * Math.PI * 1500 * t);
    }
    return x;
  };
  const render = async (values, x, range = null) => {
    const def = getEffect('hardLimiter');
    const state = { sampleRate: RATE, channels: [Channel.fromSamples(x), Channel.fromSamples(x)] };
    const spec = slotSpec(def, normalizeValues(def, values), { state, range, rate: RATE });
    return (await dsp()).runEffect(def.kind, RATE, [x, x], spec.params);
  };

  it('at the defaults leaves quiet material unchanged (no boost)', async () => {
    const x = music();
    const [y] = await render({}, x);
    expect(peak(y)).toBeCloseTo(peak(x), 4);
  });

  it('raises quiet material so its peak meets the ceiling, and never above it', async () => {
    const x = music();
    expect(dbOf(peak(x))).toBeLessThan(-12);
    const [y] = await render({ maximize: true, ceiling: -1 }, x);
    expect(dbOf(peak(y))).toBeGreaterThan(-1.3);
    expect(dbOf(peak(y))).toBeLessThanOrEqual(-1 + 1e-3);
    // Input Boost adds drive on top: louder, still under the ceiling.
    const [z] = await render({ maximize: true, ceiling: -1, inputBoost: 6 }, x);
    expect(rms(z)).toBeGreaterThan(rms(y) * 1.5);
    expect(dbOf(peak(z))).toBeLessThanOrEqual(-1 + 1e-3);
  });

  it('measures the range being processed', async () => {
    const x = music();
    const half = x.slice();
    for (let i = RATE; i < half.length; i++) half[i] *= 4; // second second 12 dB louder
    const def = getEffect('hardLimiter');
    const state = { sampleRate: RATE, channels: [Channel.fromSamples(half)] };
    const boost = (range) => slotSpec(def, normalizeValues(def, { maximize: true, ceiling: -1 }), { state, range }).params[1];
    expect(boost([0, RATE]) - boost([RATE, 2 * RATE])).toBeCloseTo(20 * Math.log10(4), 1);
    // Without a range: the document's selection, else the whole file.
    const doc = { state, selection: { start: 0, end: RATE } };
    expect(slotSpec(def, normalizeValues(def, { maximize: true, ceiling: -1 }), { doc }).params[1]).toBeCloseTo(boost([0, RATE]), 4);
    expect(boost(null)).toBeCloseTo(boost([RATE, 2 * RATE]), 4);
  });
});

describe('DeHummer Auto', () => {
  /** Hum at f0 with decaying harmonics, at `db` dBFS for the fundamental. */
  const hum = (n, f0, db = -40, harmonics = 5, rate = RATE) => {
    const x = new Float32Array(n);
    const a = 10 ** (db / 20);
    for (let h = 1; h <= harmonics; h++) for (let i = 0; i < n; i++) x[i] += (a / h) * Math.sin((2 * Math.PI * f0 * h * i) / rate + h);
    return x;
  };
  const withSpeech = (f0, db = -40) => {
    const sp = speech({ seconds: 6 });
    const hm = hum(sp.x.length, f0, db);
    return { sp, hm, x: sp.x.map((v, i) => v + hm[i]) };
  };

  for (const f0 of [50, 60, 59.8, 50.2]) {
    it(`finds a ${f0} Hz hum under speech`, () => {
      const { x } = withSpeech(f0);
      const r = detectHum([x], RATE);
      expect(r).not.toBeNull();
      expect(Math.abs(r.frequency - f0)).toBeLessThan(0.15);
    });
  }

  it('finds hum whose fundamental is weaker than its harmonics', () => {
    const n = RATE * 4;
    const x = hum(n, 50, -60, 1);
    const h2 = hum(n, 100, -38, 3);
    const r = detectHum([x.map((v, i) => v + h2[i] + 0.002 * Math.sin(i))], RATE);
    expect(Math.abs(r.frequency - 50)).toBeLessThan(0.15);
  });

  it('reports nothing on speech or noise without hum', () => {
    expect(detectHum([speech({ seconds: 6 }).x], RATE)).toBeNull();
    expect(detectHum([gaussNoise(RATE * 4, 0.05, 9)], RATE)).toBeNull();
  });

  it('is the default and removes 50 Hz hum that a fixed 60 Hz setting misses', async () => {
    const def = getEffect('dehummer');
    expect(normalizeValues(def, {}).auto).toBe(true);
    const { sp, hm, x } = withSpeech(50);
    const state = { sampleRate: RATE, channels: [Channel.fromSamples(x)] };
    const run = async (values) => {
      const spec = slotSpec(def, normalizeValues(def, values), { state, range: [0, x.length] });
      return (await dsp()).runEffect(def.kind, RATE, [x], spec.params)[0];
    };
    const residual = (y) => dbOf(segRms(y.map((v, i) => v - sp.x[i]), sp.pauses.slice(1)));
    const before = residual(x);
    expect(before - residual(await run({}))).toBeGreaterThan(15);
    expect(before - residual(await run({ auto: false, frequency: 60 }))).toBeLessThan(3);
    expect(dbOf(segRms(hm, sp.pauses.slice(1)))).toBeCloseTo(before, 0);
  });

  it('settings saved before Auto existed keep their fixed frequency', () => {
    const def = getEffect('dehummer');
    expect(normalizeValues(def, { frequency: 50, q: 30, gain: -40, harmonics: 6, slope: 75, humOnly: false }).auto).toBe(false);
    expect(normalizeValues(def, def.presets.find((p) => p.name === 'Mains 50 Hz').values).auto).toBe(false);
  });
});
