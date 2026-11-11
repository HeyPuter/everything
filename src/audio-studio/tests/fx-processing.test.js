// Effect processing correctness: the WASM glue (FxHost parameters, offline
// effect chains) checked numerically against the built DSP module.
import { describe, it, expect } from 'vitest';
import { wasmBytes } from './fx-wasm.js';
import { FxHost } from '../src/engine/fxhost.js';
import { getEffect, slotSpec, defaults } from '../src/effects/index.js';

const host = (rate) =>
  new FxHost(new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}), rate);

function sine(n, f, rate, amp = 0.5) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * f * i) / rate);
  return out;
}

describe('Multiband Compressor crossovers', () => {
  it('runs with crossovers at the top of their range at every sample rate', () => {
    const def = getEffect('multibandCompressor');
    for (const rate of [11025, 22050, 44100, 48000, 88200, 176400]) {
      for (const values of [
        { xover1: 20000 },
        { xover1: 16500, xover2: 18000, xover3: 19500 },
        { xover1: 20000, xover2: 20000, xover3: 20000 },
      ]) {
        const h = host(rate);
        const chain = h.sync([slotSpec(def, { ...defaults(def), ...values }, { rate })]);
        const buf = [sine(1024, 1000, rate), sine(1024, 1000, rate)];
        h.run(chain, buf, 1024);
        expect(buf[0].every(Number.isFinite)).toBe(true);
      }
    }
  });
});
