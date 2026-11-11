// Effect processor fixes in the Rust DSP (wasm/dsp), checked numerically
// against the built module.
import { describe, it, expect } from 'vitest';
import { instance } from './fx-wasm.js';

const RATE = 48000;

/** Deterministic noise. */
function noise(n, amp = 0.2, seed = 1) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out[i] = (seed / 2 ** 32 - 0.5) * 2 * amp;
  }
  return out;
}

/** Runs processor `kind` over mono `input` in 128-frame blocks with params [index, value]. */
function runMono(kind, params, input, rate = RATE, block = 128) {
  const x = instance();
  const h = x.fx_new(kind, rate, 1);
  for (const [i, v] of params) x.fx_set(h, i, v);
  x.fx_reset(h);
  const buf = x.mem_alloc(block * 4);
  const out = new Float32Array(input.length);
  for (let at = 0; at < input.length; at += block) {
    const n = Math.min(block, input.length - at);
    new Float32Array(x.memory.buffer, buf, n).set(input.subarray(at, at + n));
    x.fx_process(h, buf, n);
    out.set(new Float32Array(x.memory.buffer, buf, n), at);
  }
  return out;
}

/** Energy of x below `hz` (one-pole low-pass, both directions). */
function lowEnergy(x, hz, from = 0) {
  const a = Math.exp((-2 * Math.PI * hz) / RATE);
  let y = 0;
  let e = 0;
  for (let i = 0; i < x.length; i++) {
    y = x[i] + (y - x[i]) * a;
    if (i >= from) e += y * y;
  }
  return e;
}

describe('DeNoise and DeReverb processing focus', () => {
  for (const [name, kind] of [
    ['DeNoise', 132],
    ['DeReverb', 133],
  ]) {
    it(`${name} treats Low and high frequencies as its own focus`, () => {
      const x = noise(RATE);
      const out = (focus) =>
        runMono(
          kind,
          [
            [0, 80],
            [1, focus],
          ],
          x,
        );
      const high = out(3);
      const both = out(4);
      expect(both.some((v, i) => v !== high[i])).toBe(true);
      // Low and high reduces the lows much more than High frequencies does.
      expect(lowEnergy(both, 200, RATE / 2)).toBeLessThan(lowEnergy(high, 200, RATE / 2) * 0.9);
    });
  }
});

describe('Multiband Compressor crossovers', () => {
  it('takes crossovers at and beyond the ceiling at every sample rate', () => {
    for (const rate of [8000, 11025, 22050, 44100, 48000, 88200, 176400, 192000]) {
      for (const p of [
        [20000, 20000, 20000],
        [1e6, 0, 0],
        [16500, 18000, 19500],
      ]) {
        const x = instance();
        const h = x.fx_new(33, rate, 2);
        p.forEach((v, i) => x.fx_set(h, i, v));
        x.fx_reset(h);
        const buf = x.mem_alloc(256 * 4);
        new Float32Array(x.memory.buffer, buf, 256).fill(0.1);
        x.fx_process(h, buf, 128);
        expect(new Float32Array(x.memory.buffer, buf, 256).every(Number.isFinite)).toBe(true);
      }
    }
  });
});

describe('Chorus feedback', () => {
  it('rings down at high feedback with many voices, straight from the processor', () => {
    const x = instance();
    // voices, delay, delayRate, feedback, spread, depth, modRate, width, dry, wet, quality, average, binaural
    for (const [voices, fb, width] of [
      [8, 90, 100],
      [8, 45, 0],
      [2, 90, 0],
    ]) {
      const h = x.fx_new(70, RATE, 2);
      [voices, 12, 0.6, fb, 10, 2, 1.2, width, 70, 50, 1, 0, 0].forEach((v, i) =>
        x.fx_set(h, i, v),
      );
      x.fx_reset(h);
      const buf = x.mem_alloc(2 * 4096 * 4);
      const input = noise(2 * 4096, 0.3);
      let last = 0;
      for (let b = 0; b < 40; b++) {
        const v = new Float32Array(x.memory.buffer, buf, 2 * 4096);
        if (b < 12) v.set(input);
        else v.fill(0);
        x.fx_process(h, buf, 4096);
        last = new Float32Array(x.memory.buffer, buf, 2 * 4096).reduce(
          (m, s) => Math.max(m, Math.abs(s)),
          0,
        );
      }
      expect(last, `${voices} voices, ${fb} %, width ${width}`).toBeLessThan(0.01);
      x.fx_free(h);
    }
  });
});

describe('Phaser tail', () => {
  it('reports the ring-out of strong feedback, matching the definition', async () => {
    const { getEffect, defaults, slotSpec, effectTail } = await import('../src/effects/index.js');
    const def = getEffect('phaser');
    const x = instance();
    for (const extra of [
      {},
      { feedback: 85 },
      { stages: 12, depth: 100, upperFreq: 300, feedback: -90 },
    ]) {
      for (const rate of [8000, 44100, 192000]) {
        const values = { ...defaults(def), ...extra };
        const h = x.fx_new(72, rate, 2);
        slotSpec(def, values).params.forEach((v, i) => x.fx_set(h, i, v));
        const js = effectTail(def, values, rate);
        expect(Math.abs(x.fx_tail(h) - js), JSON.stringify(extra)).toBeLessThanOrEqual(
          Math.max(2, js * 1e-5),
        );
        x.fx_free(h);
      }
    }
  });
});

describe('Loudness channel weights', () => {
  it('weights the surrounds of 5.0, 5.1 and 7.1 audio by +1.5 dB and drops the LFE', async () => {
    const { dsp } = await import('../src/audio/dsp.js');
    const { loudnessMeter } = await import('../src/analysis/dsp-ext.js');
    const d = await dsp();
    const n = RATE * 10;
    const tone = Float32Array.from(
      { length: n },
      (_, i) => 0.1 * Math.sin((2 * Math.PI * 997 * i) / RATE),
    );
    const silent = new Float32Array(n);
    const read = (channels, index) => {
      const m = loudnessMeter(d, RATE, channels);
      m.push(Array.from({ length: channels }, (_, c) => (c === index ? tone : silent)));
      const r = m.result();
      m.free();
      return r.integrated;
    };
    const surround = -23.01 + 10 * Math.log10(1.41);
    expect(read(5, 0)).toBeCloseTo(-23.01, 1);
    expect(read(5, 3)).toBeCloseTo(surround, 1);
    expect(read(5, 4)).toBeCloseTo(surround, 1);
    expect(read(6, 4)).toBeCloseTo(surround, 1);
    expect(read(6, 3)).toBe(-Infinity);
    for (const i of [4, 5, 6, 7]) expect(read(8, i)).toBeCloseTo(surround, 1);
    expect(read(8, 2)).toBeCloseTo(-23.01, 1);
    expect(read(8, 3)).toBe(-Infinity);
  });
});
