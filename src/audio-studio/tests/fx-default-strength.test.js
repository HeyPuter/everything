// Effects at their default settings do an audible job on typical material:
// measured on synthesized voice-like speech, noise and music.
import { describe, it, expect } from 'vitest';
import './fx-wasm.js';
import { speech, runFx, band, segRms, dbOf } from './helpers/fx-signals.js';

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
