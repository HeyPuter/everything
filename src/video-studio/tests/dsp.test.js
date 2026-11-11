// The wasm kernels and their JavaScript fallbacks must agree, so audio sounds
// the same whether or not WebAssembly is available.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let js; // module copy that never loads wasm (fallback paths)
let wasm; // module copy with the real dsp.wasm loaded

beforeAll(async () => {
  vi.resetModules();
  js = await import('../src/media/dsp.js');
  vi.resetModules();
  wasm = await import('../src/media/dsp.js');
  const bytes = fs.readFileSync(path.resolve(import.meta.dirname, '../src/media/dsp.wasm'));
  await wasm.loadDsp(bytes);
});

function random(n, seed, scale = 1) {
  let x = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = ((x / 4294967296) * 2 - 1) * scale;
  }
  return out;
}

function expectClose(a, b, tol = 1e-5) {
  expect(a.length).toBe(b.length);
  let worst = 0;
  let at = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (!(d <= worst)) {
      worst = d;
      at = i;
    }
  }
  expect(worst, `largest difference at ${at}: ${a[at]} vs ${b[at]}`).toBeLessThanOrEqual(tol);
}

describe('dsp module', () => {
  it('loads the wasm kernels in Node and keeps the fallback copy separate', () => {
    expect(wasm.dspReady()).toBe(true);
    expect(js.dspReady()).toBe(false);
  });
});

describe('peaks', () => {
  it.each([
    [10_000, 100],
    [1_000, 999],
    [37, 100], // more buckets than samples
    [4_096, 1],
  ])('agrees with the fallback for %i samples in %i buckets', (n, buckets) => {
    const data = random(n, n + buckets);
    const a = wasm.peaks(data, buckets);
    const b = js.peaks(data, buckets);
    expectClose(a, b, 0);
    expect(js.peaksJS(data, buckets)).toEqual(b);
  });

  it('gives (min, max) pairs per bucket', () => {
    const data = Float32Array.from([0.1, -0.5, 0.25, 0.9, -0.2, 0]);
    expect([...wasm.peaks(data, 2)]).toEqual([...Float32Array.from([-0.5, 0.25, -0.2, 0.9])]);
  });

  it('returns an empty result for zero buckets', () => {
    expect(wasm.peaks(random(10, 1), 0)).toHaveLength(0);
    expect(js.peaks(random(10, 1), 0)).toHaveLength(0);
  });
});

describe('levels', () => {
  it('agrees with the fallback on peak and RMS', () => {
    for (const n of [1, 255, 48_000]) {
      const data = random(n, n, 0.8);
      const a = wasm.levels(data);
      const b = js.levels(data);
      expect(a.peak).toBeCloseTo(b.peak, 6);
      expect(Math.abs(a.rms - b.rms)).toBeLessThanOrEqual(1e-5);
    }
  });

  it('measures a full-scale square wave as peak 1 and RMS 1, and silence as 0', () => {
    const square = Float32Array.from({ length: 1000 }, (_, i) => (i % 2 ? 1 : -1));
    expect(wasm.levels(square)).toEqual({ peak: 1, rms: 1 });
    expect(js.levels(new Float32Array(0))).toEqual({ peak: 0, rms: 0 });
    expect(wasm.levels(new Float32Array(16))).toEqual({ peak: 0, rms: 0 });
  });
});

describe('mixRamp', () => {
  it.each([[300], [4_096], [48_000]])('agrees with the fallback for %i samples', (n) => {
    const src = random(n, 7, 0.9);
    const base = random(n, 9, 0.5);
    const a = wasm.mixRamp(base.slice(), src, 0.2, 1.3);
    const b = js.mixRamp(base.slice(), src, 0.2, 1.3);
    expectClose(a, b);
  });

  it('ramps the gain linearly from the first to the last sample', () => {
    const ones = new Float32Array(1000).fill(1);
    const out = wasm.mixRamp(new Float32Array(1000), ones, 0, 1);
    expect(out[0]).toBe(0);
    expect(out[999]).toBeCloseTo(1, 5);
    expect(out[500]).toBeCloseTo(500 / 999, 5);
  });

  it('only mixes the overlapping length', () => {
    const dst = new Float32Array(300);
    js.mixRamp(dst, new Float32Array(10).fill(1), 1, 1);
    expect(dst[9]).toBe(1);
    expect(dst[10]).toBe(0);
  });
});

describe('resample', () => {
  it.each([
    [0, 1],
    [0.25, 0.5],
    [3.7, 1.37],
    [10.5, 2.0],
  ])('agrees with the fallback from position %f with step %f', (pos, step) => {
    const src = random(2_000, 3);
    expectClose(wasm.resample(src, pos, step, 1_500), js.resample(src, pos, step, 1_500));
  });

  it('is silent past the end of the source and before its start', () => {
    const src = Float32Array.from([1, 2, 3, 4]);
    for (const mod of [js, wasm]) {
      expect([...mod.resample(src, 2.5, 1, 4)]).toEqual([3.5, 4, 0, 0]);
      expect([...mod.resample(src, -2, 1, 4)]).toEqual([0, 0, 1, 2]);
    }
  });

  it('interpolates linearly between samples', () => {
    const src = Float32Array.from([0, 10]);
    expect([...wasm.resample(src, 0, 0.25, 4)]).toEqual([0, 2.5, 5, 7.5]);
  });
});

describe('softClip', () => {
  it('agrees with the fallback over a wide range of levels', () => {
    const data = random(10_000, 5, 3);
    expectClose(wasm.softClip(data.slice()), js.softClip(data.slice()));
  });

  it('leaves quiet samples alone and never exceeds full scale', () => {
    const quiet = random(1000, 2, 0.9);
    expect(js.softClip(quiet.slice())).toEqual(quiet);
    const loud = Float32Array.from({ length: 4001 }, (_, i) => -2 + i / 1000);
    for (const mod of [js, wasm]) {
      const out = mod.softClip(loud.slice());
      for (const v of out) expect(Math.abs(v)).toBeLessThanOrEqual(1);
      // Monotonic: louder input never comes out quieter.
      for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
    }
  });
});

describe('PeakLimiter', () => {
  const chunks = (amp, spikes = []) => [0, 1, 2].map((k) => [0, 1].map((c) => Float32Array.from({ length: 4800 }, (_, i) => {
    const at = k * 4800 + i;
    return (spikes.includes(at) ? 1.6 : amp) * Math.sin(at * 0.07 + c);
  })));

  it('passes sound under the threshold bit for bit', () => {
    const lim = new js.PeakLimiter(48000);
    const parts = chunks(0.89);
    const copy = parts.map((p) => p.map((ch) => ch.slice()));
    parts.forEach((p, k) => lim.process(p, parts[k + 1] || null));
    expect(parts).toEqual(copy);
  });

  it('keeps every sample under the threshold, also for peaks right after a chunk boundary', () => {
    const lim = new js.PeakLimiter(48000);
    const parts = chunks(0.5, [4801, 4803, 9700, 12000]);
    parts.forEach((p, k) => lim.process(p, parts[k + 1] || null));
    for (const p of parts) for (const ch of p) for (const v of ch) expect(Math.abs(v)).toBeLessThanOrEqual(0.9 + 1e-6);
    // Before the look-ahead reaches the first spike, the sound is untouched.
    expect(parts[0][0][4000]).toBe(Math.fround(0.5 * Math.sin(4000 * 0.07)));
    // And the gain comes all the way back: a second of quiet sound after it passes unchanged.
    const later = [0, 1].map(() => Float32Array.from({ length: 48000 }, (_, i) => 0.5 * Math.sin(i * 0.07)));
    lim.process(later, null);
    const quiet = [0, 1].map(() => Float32Array.from({ length: 4800 }, (_, i) => 0.5 * Math.sin(i * 0.07)));
    const copy = quiet.map((ch) => ch.slice());
    lim.process(quiet, null);
    expect(quiet).toEqual(copy);
  });
});
