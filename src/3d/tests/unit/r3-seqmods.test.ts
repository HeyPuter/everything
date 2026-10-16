// @vitest-environment happy-dom
// Strip modifier helpers: stack editing, equalizer bands, pitch shifting and tone mapping.
import { describe, it, expect } from 'vitest';
import { duplicateModifier, moveModifierTo, equalizerBands, uniqueModifierName } from '../../src/sequencer/modops';
import { pitchShift, pitchRatio, tonemapUniforms, MODIFIER_KINDS, modifierAddItems } from '../../src/sequencer/modextra';
import { newModifier } from '../../src/sequencer/strips';
import type { Strip, StripModifier } from '../../src/sequencer/types';

const mod = (name: string): StripModifier => ({ name, type: 'CURVES', mute: false, show_expanded: true });

describe('modifier stack', () => {
  it('duplicates after the original with a unique name and moves to an index', () => {
    const list = [mod('A'), mod('B'), mod('C')];
    const c = duplicateModifier(list, 'A')!;
    expect(list.map((m) => m.name)).toEqual(['A', 'A.001', 'B', 'C']);
    expect(c).not.toBe(list[0]);
    expect(uniqueModifierName(list, 'A')).toBe('A.002');
    expect(moveModifierTo(list, 'C', 0)).toBe(true);
    expect(list.map((m) => m.name)).toEqual(['C', 'A', 'A.001', 'B']);
    expect(moveModifierTo(list, 'C', 99)).toBe(true);
    expect(list[3].name).toBe('C');
    expect(moveModifierTo(list, 'C', 3)).toBe(false);
  });
  it('spreads equalizer bands with shelves at the ends', () => {
    const b = equalizerBands(5);
    expect(b.map((x) => x.type)).toEqual(['LOWSHELF', 'PEAKING', 'PEAKING', 'PEAKING', 'HIGHSHELF']);
    for (let i = 1; i < b.length; i++) expect(b[i].frequency).toBeGreaterThan(b[i - 1].frequency);
  });
  it('lists sound modifiers for sound strips and image modifiers otherwise', () => {
    expect(modifierAddItems({ type: 'SOUND' } as Strip).map((i) => i.label)).toEqual(['Equalizer', 'Pitch', 'Echo']);
    expect(modifierAddItems({ type: 'MOVIE' } as Strip).map((i) => i.label)).toContain('Hue Correct');
    for (const k of MODIFIER_KINDS) if (k.type !== 'COMPOSITOR') expect(newModifier(k.type, 'x').type).toBe(k.type);
  });
});

describe('sound modifiers', () => {
  it('pitch ratios from semitones and cents', () => {
    expect(pitchRatio({ ...mod('p'), type: 'PITCH', semitones: 12, cents: 0 })).toBeCloseTo(2);
    expect(pitchRatio({ ...mod('p'), type: 'PITCH', semitones: 0, cents: -100 })).toBeCloseTo(Math.pow(2, -1 / 12));
    expect(pitchRatio({ ...mod('p'), type: 'PITCH', pitch_mode: 'RATIO', ratio: 1.5 })).toBe(1.5);
  });
  it('shifts the frequency of a tone keeping its length', () => {
    const rate = 8000,
      n = 8000;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 220 * i) / rate);
    const y = pitchShift(x, 2, rate);
    expect(y.length).toBe(n);
    // count zero crossings in the middle (avoid the tail)
    const crossings = (a: Float32Array) => {
      let c = 0;
      for (let i = 1000; i < 6000; i++) if (a[i - 1] < 0 && a[i] >= 0) c++;
      return c;
    };
    expect(crossings(y) / crossings(x)).toBeGreaterThan(1.8);
    expect(crossings(y) / crossings(x)).toBeLessThan(2.2);
  });
});

describe('tone map parameters', () => {
  it('simple tone mapping scales by key over the log-average luminance', () => {
    const st = { mean: [0.5, 0.5, 0.5], lav: 0.5, logAv: Math.log(0.5), lmin: 0.1, lmax: 2 };
    const u = tonemapUniforms({ ...mod('t'), type: 'TONEMAP', tonemap_type: 'RH_SIMPLE', key: 0.18, offset: 1, gamma: 2 }, st);
    expect(u.op).toBe(2);
    expect(u.A[0]).toBeCloseTo(0.36);
    expect(u.A[2]).toBeCloseTo(0.5);
    const r = tonemapUniforms({ ...mod('t'), type: 'TONEMAP', tonemap_type: 'RD_PHOTORECEPTOR', intensity: 0, tm_contrast: 0.5, adaptation: 1, correction: 0 }, st);
    expect(r.op).toBe(3);
    expect(r.A[1]).toBe(0.5);
    expect(r.B[0]).toBe(0.5);
  });
});
