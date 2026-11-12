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

describe('DeNoise at low sample rates', () => {
  it('reports its latency at every rate and keeps speech at 8 kHz', async () => {
    const { getEffect, defaults, effectLatency } = await import('../src/effects/index.js');
    const def = getEffect('denoise');
    const x = instance();
    for (const rate of [8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000, 192000]) {
      const h = x.fx_new(132, rate, 2);
      expect(x.fx_latency(h), `${rate} Hz`).toBe(effectLatency(def, defaults(def), rate));
      x.fx_free(h);
    }
    // Voiced syllables (180 ms every 300 ms) over hiss at 8 kHz.
    const rate = 8000;
    const n = rate * 6;
    const hiss = noise(n, 0.01, 4);
    const voice = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const cyc = t % 0.3;
      const env = cyc < 0.18 ? Math.sin((Math.PI * cyc) / 0.18) ** 2 : 0;
      ph += (140 * (1 + 0.1 * Math.sin(2 * Math.PI * 0.7 * t))) / rate;
      let s = 0;
      for (let k = 1; k <= 12; k++) s += Math.sin(2 * Math.PI * k * ph) / k;
      voice[i] = 0.05 * env * s;
    }
    const lat = effectLatency(def, defaults(def), rate);
    const input = new Float32Array(n + lat);
    for (let i = 0; i < n; i++) input[i] = voice[i] + hiss[i];
    const y = runMono(132, [[0, 40]], input, rate);
    let dot = 0;
    let vv = 0;
    for (let i = n / 2; i < n; i++) {
      dot += y[i + lat] * voice[i];
      vv += voice[i] * voice[i];
    }
    expect(dot / vv).toBeGreaterThan(0.8);
  });
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

describe('Filters with poles very close to DC', () => {
  /** Steady-state gain (dB) of a mono effect slot at f, measured over whole cycles. */
  async function gainDb(id, values, rate, f) {
    const { getEffect, defaults, slotSpec } = await import('../src/effects/index.js');
    const def = getEffect(id);
    const spec = slotSpec(def, { ...defaults(def), ...values }, { rate });
    const x = instance();
    const h = x.fx_new(def.kind, rate, 1);
    spec.params.forEach((v, i) => x.fx_set(h, i, v));
    x.fx_reset(h);
    const N = 8192;
    const total = Math.round((rate * 4) / N) * N;
    const buf = x.mem_alloc(N * 4);
    let e = 0;
    let ein = 0;
    for (let at = 0; at < total; at += N) {
      const v = new Float32Array(x.memory.buffer, buf, N);
      for (let i = 0; i < N; i++) v[i] = 0.1 * Math.sin((2 * Math.PI * f * (at + i)) / rate);
      x.fx_process(h, buf, N);
      const o = new Float32Array(x.memory.buffer, buf, N);
      if (at < total / 2) continue;
      for (let i = 0; i < N; i++) {
        e += o[i] ** 2;
        ein += (0.1 * Math.sin((2 * Math.PI * f * (at + i)) / rate)) ** 2;
      }
    }
    return {
      got: 10 * Math.log10(e / ein),
      want: def.response({ ...defaults(def), ...values }, Float64Array.of(f), rate)[0],
    };
  }

  it('follow their design: a 10 Hz shelf at 192 kHz and a 60 Hz notch at 48 kHz', async () => {
    for (const ultraQuiet of [false, true]) {
      for (const f of [15, 30, 60]) {
        const { got, want } = await gainDb(
          'parametricEq',
          { lsOn: true, lsFreq: 10, lsGain: 12, ultraQuiet },
          192000,
          f,
        );
        expect(got, `${f} Hz`).toBeCloseTo(want, 1);
      }
    }
    const notch = {
      width: 1,
      band1On: true,
      band1Freq: 60,
      band1Gain: -30,
      band2On: false,
      ultraQuiet: false,
    };
    const { got, want } = await gainDb('notchFilter', notch, 48000, 60);
    expect(Math.abs(got - want)).toBeLessThan(0.5);
  });

  it('graphic equalizer low bands follow their sliders at 176.4 and 192 kHz', async () => {
    const { getEffect } = await import('../src/effects/index.js');
    for (const id of ['graphicEq20', 'graphicEq30']) {
      for (const name of ['Treble Cut', 'Bass Cut']) {
        const values = getEffect(id).presets.find((p) => p.name === name).values;
        for (const rate of [176400, 192000]) {
          for (const f of [25, 31.5, 63]) {
            const { got, want } = await gainDb(id, values, rate, f);
            expect(Math.abs(got - want), `${id} ${name} ${rate} Hz ${f} Hz`).toBeLessThan(0.3);
          }
        }
      }
    }
  });
});
