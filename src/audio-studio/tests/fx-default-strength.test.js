// Effects at their default settings do an audible job on typical material:
// measured on synthesized voice-like speech, noise and music.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import { speech, runFx, band, segRms, dbOf, gaussNoise, filter, biquad, rms, spectralPeakiness, sine, peak, RATE } from './helpers/fx-signals.js';
import { getEffect } from '../src/effects/index.js';
import { lastValues } from '../src/effects/presets.js';
import { normalizeValues } from '../src/effects/params.js';
import { memoryPrefs } from './fx-helpers.js';
import { captureNoisePrint } from '../src/effects/defs/restoration.js';
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
