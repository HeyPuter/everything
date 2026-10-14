import { describe, it, expect } from 'vitest';
import { biquad, biquadDb, eqResponseDb, eqCurve, eqFilters, logFreqs, bandActive, EQ_BANDS } from '../src/effects/ui/eq-math.js';
import { compressorOut, compressorReduction, limiterOut } from '../src/effects/ui/dynamics-math.js';
import { divisionMs, delayTimeMs, describeDelay } from '../src/effects/ui/tempo.js';
import { defaultEffectParams, DIVISIONS } from '../src/effects/catalog.js';

const flat = () => defaultEffectParams('eq');

describe('EQ response', () => {
  it('is flat at the defaults', () => {
    const p = flat();
    expect(eqFilters(p)).toHaveLength(0);
    for (const f of [20, 100, 1000, 10000, 20000]) expect(eqResponseDb(p, f)).toBeCloseTo(0, 9);
  });

  it('gives the bell gain at its centre frequency', () => {
    const p = { ...flat(), m1_freq: 1000, m1_gain: 6, m1_q: 1 };
    expect(eqResponseDb(p, 1000)).toBeCloseTo(6, 2);
    expect(eqResponseDb(p, 100)).toBeLessThan(0.5);
    const cut = { ...flat(), m2_freq: 3000, m2_gain: -9, m2_q: 4 };
    expect(eqResponseDb(cut, 3000)).toBeCloseTo(-9, 2);
  });

  it('narrower Q means a narrower bell', () => {
    const wide = { ...flat(), m1_freq: 1000, m1_gain: 12, m1_q: 0.5 };
    const narrow = { ...wide, m1_q: 8 };
    expect(eqResponseDb(narrow, 1500)).toBeLessThan(eqResponseDb(wide, 1500));
  });

  it('shelves reach their gain far from the corner and half of it at the corner', () => {
    const p = { ...flat(), low_freq: 200, low_gain: 12 };
    expect(eqResponseDb(p, 20)).toBeCloseTo(12, 0);
    expect(eqResponseDb(p, 200)).toBeCloseTo(6, 1);
    expect(eqResponseDb(p, 10000)).toBeCloseTo(0, 1);
    const h = { ...flat(), high_freq: 4000, high_gain: -8 };
    expect(eqResponseDb(h, 18000)).toBeCloseTo(-8, 0);
    expect(eqResponseDb(h, 4000)).toBeCloseTo(-4, 1);
  });

  it('cuts are 2nd-order Butterworth: -3 dB at the corner, 12 dB per octave', () => {
    const p = { ...flat(), hp_freq: 200 };
    expect(eqResponseDb(p, 200)).toBeCloseTo(-3.01, 1);
    expect(eqResponseDb(p, 25)).toBeLessThan(-30);
    expect(eqResponseDb(p, 5000)).toBeCloseTo(0, 1);
    const lp = { ...flat(), lp_freq: 2000 };
    expect(eqResponseDb(lp, 2000)).toBeCloseTo(-3.01, 0);
    const slope = eqResponseDb(lp, 8000) - eqResponseDb(lp, 16000);
    expect(slope).toBeGreaterThan(10);
  });

  it('adds the output gain and bypasses the cuts at their extremes', () => {
    const p = { ...flat(), output: -4 };
    expect(eqResponseDb(p, 1000)).toBeCloseTo(-4, 9);
    expect(bandActive(EQ_BANDS[0], { hp_freq: 20 })).toBe(false);
    expect(bandActive(EQ_BANDS[5], { lp_freq: 20000 })).toBe(false);
    expect(bandActive(EQ_BANDS[5], { lp_freq: 12000 })).toBe(true);
  });

  it('computes a curve over log-spaced frequencies', () => {
    const f = logFreqs(5, 20, 20000);
    expect(f[0]).toBeCloseTo(20, 3);
    expect(f[4]).toBeCloseTo(20000, 0);
    expect(f[2]).toBeCloseTo(Math.sqrt(20 * 20000), 0);
    const curve = eqCurve({ ...flat(), m1_freq: 632, m1_gain: 6 }, f);
    expect(curve[2]).toBeCloseTo(6, 0);
  });

  it('normalizes coefficients and has unit DC gain for a bell', () => {
    const c = biquad('peak', 1000, 6, 1);
    expect(biquadDb(c, 1)).toBeCloseTo(0, 3);
    expect(biquad('nope', 1000)).toEqual({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 });
  });
});

describe('compressor curve', () => {
  const p = { threshold: -20, ratio: 4, knee: 0, makeup: 0 };

  it('is unity below the threshold and divides above it', () => {
    expect(compressorOut(-40, p)).toBe(-40);
    expect(compressorOut(-20, p)).toBe(-20);
    expect(compressorOut(0, p)).toBe(-15);
    expect(compressorReduction(0, p)).toBe(15);
  });

  it('soft knee is continuous and below the hard curve at the threshold', () => {
    const soft = { ...p, knee: 10 };
    expect(compressorOut(-25, soft)).toBeCloseTo(-25, 9);
    expect(compressorOut(-15, soft)).toBeCloseTo(-20 + 5 / 4, 9);
    expect(compressorOut(-20, soft)).toBeLessThan(-20);
    for (let x = -30; x < -10; x += 0.5) {
      expect(compressorOut(x + 0.5, soft)).toBeGreaterThan(compressorOut(x, soft));
    }
  });

  it('adds makeup gain, and ratio 1 is a straight line', () => {
    expect(compressorOut(-10, { ...p, makeup: 6 })).toBe(-20 + 10 / 4 + 6);
    expect(compressorOut(-3, { ...p, ratio: 1, knee: 6 })).toBeCloseTo(-3, 9);
  });

  it('limiter caps at the ceiling', () => {
    expect(limiterOut(-10, { input: 6, ceiling: -1 })).toBe(-4);
    expect(limiterOut(-3, { input: 6, ceiling: -1 })).toBe(-1);
  });
});

describe('delay timing', () => {
  it('converts synced divisions at the tempo', () => {
    const quarter = DIVISIONS.indexOf('1/4');
    expect(divisionMs(quarter, 120)).toBe(500);
    expect(divisionMs(DIVISIONS.indexOf('1/8 dotted'), 120)).toBe(375);
    expect(delayTimeMs({ sync: 1, division: quarter, time: 99 }, 60)).toBe(1000);
    expect(delayTimeMs({ sync: 0, division: quarter, time: 99 }, 60)).toBe(99);
    expect(describeDelay({ sync: 1, division: quarter }, 120)).toBe('1/4 = 500 ms at 120 BPM');
    expect(describeDelay({ sync: 0, time: 1500 }, 120)).toBe('1.50 s (free)');
  });
});
