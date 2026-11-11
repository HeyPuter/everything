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
