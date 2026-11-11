// Effect processing correctness: the WASM glue (FxHost parameters, offline
// effect chains) checked numerically against the built DSP module.
import { describe, it, expect, vi } from 'vitest';
import { wasmBytes } from './fx-wasm.js';
import { FxHost, processorParam } from '../src/engine/fxhost.js';
import { getEffect, slotSpec, defaults, effectTail } from '../src/effects/index.js';
import { applyChain } from '../src/engine/offline.js';
import { renderEffect } from '../src/effects/apply.js';
import { Channel } from '../src/audio/channel.js';

// The offline render worker, run in this thread: the real applyChain path.
vi.mock('../src/engine/offline-worker.js?worker', async () => {
  const saved = self.onmessage;
  await import('../src/engine/offline-worker.js');
  const handler = self.onmessage;
  self.onmessage = saved;
  class InlineWorker {
    constructor() {
      self.postMessage = (m) => queueMicrotask(() => this.onmessage?.({ data: m }));
    }
    postMessage(m) {
      queueMicrotask(() => handler({ data: m }));
    }
    terminate() {}
  }
  return { default: InlineWorker };
});

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

describe('applying effects to files with more than two channels', () => {
  const RATE = 48000;
  const sixChannels = (n) =>
    Array.from({ length: 6 }, (_, c) => sine(n, 200 * (c + 1), RATE, 0.05 * (c + 1)));

  it('processes every channel of a 5.1 file with its own audio', async () => {
    const n = 20000;
    const src = sixChannels(n);
    const state = {
      sampleRate: RATE,
      channels: src.map((a) => Channel.fromSamples(a)),
      markers: [],
    };
    const def = getEffect('amplify');
    const { state: next } = await renderEffect({
      def,
      values: { left: 6, right: 6 },
      state,
      start: 0,
      end: n,
      applyChain,
    });
    const g = 10 ** (6 / 20);
    expect(next.channels).toHaveLength(6);
    next.channels.forEach((c, k) => {
      const out = c.toArray(0, n);
      for (const i of [1000, 5000, 19000]) expect(out[i]).toBeCloseTo(src[k][i] * g, 4);
    });
  });

  it('keeps the tail and latency handling per channel', async () => {
    const n = 4096;
    const src = sixChannels(n);
    const outs = await applyChain(
      src.map((a) => Channel.fromSamples(a)),
      RATE,
      [slotSpec(getEffect('amplify'), { left: 0, right: 0 })],
      { tail: 100, latency: 0 },
    );
    expect(outs).toHaveLength(6);
    outs.forEach((o, k) => {
      expect(o.length).toBe(n + 100);
      expect(o[3000]).toBeCloseTo(src[k][3000], 5);
    });
  });
});

describe('Normalize', () => {
  it('brings the written channels to the target when normalizing equally', async () => {
    const n = 1000;
    const l = sine(n, 440, 48000, 0.25);
    const r = sine(n, 440, 48000, 0.5);
    const state = {
      sampleRate: 48000,
      channels: [Channel.fromSamples(l), Channel.fromSamples(r)],
      markers: [],
    };
    const def = getEffect('normalize');
    const peak = (c) => c.toArray(0, n).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const values = { ...defaults(def), unit: 1, targetPercent: 100, equal: true };
    const left = await renderEffect({ def, values, state, start: 0, end: n, mask: [true, false] });
    expect(peak(left.state.channels[0])).toBeCloseTo(1, 4);
    expect(peak(left.state.channels[1])).toBeCloseTo(0.5, 4);
    // Both channels: one gain keeps their balance.
    const both = await renderEffect({ def, values, state, start: 0, end: n });
    expect(peak(both.state.channels[0])).toBeCloseTo(0.5, 4);
    expect(peak(both.state.channels[1])).toBeCloseTo(1, 4);
  });
});

describe('Stretch and Pitch on 5.1 files', () => {
  it('stretches every channel instead of silencing the ones after the first two', async () => {
    const rate = 48000;
    const n = rate / 2;
    const src = Array.from({ length: 6 }, (_, c) => sine(n, 300 + 100 * c, rate, 0.3));
    const state = {
      sampleRate: rate,
      channels: src.map((a) => Channel.fromSamples(a)),
      markers: [],
    };
    const def = getEffect('stretchPitch');
    for (const algorithm of [0, 1, 2]) {
      const values = { ...defaults(def), algorithm, stretch: 150 };
      const { state: next, length } = await renderEffect({ def, values, state, start: 0, end: n });
      expect(length).toBe(next.channels[0].length);
      next.channels.forEach((c) => {
        const out = c.toArray(0, length);
        expect(out.length).toBe(length);
        const mid = out.subarray(length / 4, (3 * length) / 4);
        const rms = Math.sqrt(mid.reduce((s, v) => s + v * v, 0) / mid.length);
        expect(rms).toBeGreaterThan(0.1);
      });
    }
  });
});

describe('Noise Reduction (process) on 5.1 files', () => {
  it('reduces the noise in every channel and keeps each aligned', async () => {
    const { captureNoisePrint } = await import('../src/effects/defs/restoration.js');
    const { dsp } = await import('../src/audio/dsp.js');
    const d = await dsp();
    const rate = 48000;
    const n = rate;
    let seed = 3;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.1;
    const hiss = () => Float32Array.from({ length: n }, rnd);
    const tones = Array.from({ length: 6 }, (_, c) => sine(n, 500 + 150 * c, rate, 0.3));
    const src = tones.map((t) => {
      const h = hiss();
      return t.map((v, i) => v + h[i]);
    });
    const print = await captureNoisePrint(d, Array.from({ length: 6 }, hiss), rate);
    const def = getEffect('noiseReduction');
    const outs = await def.process({
      channels: src,
      rate,
      values: { reduction: 100, reduceBy: 30 },
      doc: { noisePrint: print },
    });
    expect(outs).toHaveLength(6);
    outs.forEach((y, c) => {
      expect(y.length).toBe(n);
      let dot = 0;
      let tt = 0;
      let err = 0;
      let noise = 0;
      for (let i = n / 4; i < n - 8000; i++) {
        dot += y[i] * tones[c][i];
        tt += tones[c][i] ** 2;
        err += (y[i] - tones[c][i]) ** 2;
        noise += (src[c][i] - tones[c][i]) ** 2;
      }
      expect(dot / tt).toBeGreaterThan(0.9);
      expect(err).toBeLessThan(noise * 0.5);
    });
  });
});

describe('Doppler Shifter on 5.1 files', () => {
  it('hears the centre and LFE from the middle and the surrounds from their sides', async () => {
    const rate = 48000;
    const n = rate / 2;
    const x = sine(n, 700, rate, 0.3);
    const def = getEffect('dopplerShifter');
    const values = { ...defaults(def), path: 1, radius: 3, velocity: 6, distanceVolume: false };
    const six = await def.process({
      channels: Array.from({ length: 6 }, () => x.slice()),
      rate,
      values,
    });
    const [mono] = await def.process({ channels: [x.slice()], rate, values });
    const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
    expect(same(six[2], mono)).toBe(true);
    expect(same(six[3], mono)).toBe(true);
    expect(same(six[4], six[0])).toBe(true);
    expect(same(six[5], six[1])).toBe(true);
    expect(same(six[0], six[1])).toBe(false);
  });
});

describe('Phaser tail', () => {
  it('lasts until strong feedback has rung down', async () => {
    const rate = 48000;
    const n = rate / 2;
    let seed = 1;
    const x = Float32Array.from({ length: n }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 2 ** 32 - 0.5) * 0.5;
    });
    const def = getEffect('phaser');
    const values = {
      ...defaults(def),
      stages: 12,
      depth: 100,
      upperFreq: 300,
      feedback: -90,
      mix: 100,
    };
    const tail = effectTail(def, values, rate);
    const extra = rate;
    const [out] = await applyChain(
      [Channel.fromSamples(x)],
      rate,
      [slotSpec(def, values, { rate })],
      { tail: tail + extra },
    );
    const peak = (a, b) => out.subarray(a, b).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    // What the declared tail leaves out is below -60 dB.
    expect(20 * Math.log10(peak(n + tail, n + tail + extra) / peak(0, n))).toBeLessThan(-60);
  });
});

describe('Chorus feedback', () => {
  const rate = 48000;
  const def = getEffect('chorus');

  it('rings down instead of growing without bound at high feedback', () => {
    for (const values of [
      { voices: 8, feedback: 90, width: 100 },
      { voices: 8, feedback: 45, width: 0 },
      { voices: 5, feedback: 90, width: 80, binaural: true },
    ]) {
      const h = host(rate);
      const chain = h.sync([slotSpec(def, { ...defaults(def), ...values }, { rate })]);
      let seed = 1;
      let last = 0;
      for (let b = 0; b < 24; b++) {
        const buf = [new Float32Array(8192), new Float32Array(8192)];
        if (b < 6) {
          for (const c of buf) {
            for (let i = 0; i < 8192; i++) {
              seed = (seed * 1664525 + 1013904223) >>> 0;
              c[i] = (seed / 2 ** 32 - 0.5) * 0.5;
            }
          }
        }
        h.run(chain, buf, 8192);
        last = buf.reduce((m, c) => c.reduce((n, v) => Math.max(n, Math.abs(v)), m), 0);
      }
      expect(last, JSON.stringify(values)).toBeLessThan(0.05);
    }
  });

  it('renders a tail as long as the loop rings', async () => {
    const values = { ...defaults(def), voices: 8, feedback: 45, width: 0 };
    const n = rate / 2;
    let seed = 1;
    const x = Float32Array.from({ length: n }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 2 ** 32 - 0.5) * 0.5;
    });
    const tail = effectTail(def, values, rate);
    const [out] = await applyChain(
      [Channel.fromSamples(x), Channel.fromSamples(x)],
      rate,
      [slotSpec(def, values, { rate })],
      { tail: tail + rate },
    );
    const peak = (a, b) => out.subarray(a, b).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(20 * Math.log10(peak(n + tail, n + tail + rate) / peak(0, n))).toBeLessThan(-60);
  });

  it('leaves the presets and gentle feedback alone', () => {
    for (const p of def.presets) {
      const spec = slotSpec(def, { ...defaults(def), ...p.values });
      expect(processorParam(def.kind, 3, spec.params, rate)).toBe(spec.params[3]);
    }
    const spec = slotSpec(def, { ...defaults(def), voices: 2, feedback: 90 });
    expect(processorParam(def.kind, 3, spec.params, rate)).toBe(90);
  });
});

describe('Fade and Gain Envelope editors', () => {
  it('draw the curve the process applies', async () => {
    const { paramControl } = await import('../src/effects/param-ui.js');
    const { renderEnvelope } = await import('../src/effects/defs/amplitude.js');
    const W = 200;
    const H = 112;
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    const getContext = HTMLCanvasElement.prototype.getContext;
    let drawn = [];
    let recording = false;
    const ctx = new Proxy(
      {},
      {
        get: (t, k) => {
          if (k === 'lineTo') return (x, y) => recording && drawn.push(y);
          if (k === 'stroke') return () => (recording = false);
          return k in t ? t[k] : () => {};
        },
        set: (t, k, v) => {
          if (k === 'lineWidth' && v === 2) recording = true;
          t[k] = v;
          return true;
        },
      },
    );
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => W,
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => H,
    });
    HTMLCanvasElement.prototype.getContext = () => ctx;
    try {
      for (const id of ['fadeEnvelope', 'gainEnvelope']) {
        const p = getEffect(id).params.find((q) => q.id === 'envelope');
        for (const curve of [0, 1]) {
          const values = {
            envelope: [
              { t: 0, v: 0 },
              { t: 0.5, v: 0.25 },
              { t: 1, v: 1 },
            ],
            curve,
          };
          const control = paramControl(
            p,
            () => values,
            () => {},
          );
          drawn = [];
          control.show(values, 'curve');
          await new Promise((r) => setTimeout(r, 50));
          const want = renderEnvelope(values.envelope, W, curve === 1);
          expect(drawn.length).toBe(W - 1);
          drawn.forEach((y, i) => {
            const v = p.min + ((H - 6 - y) / (H - 12)) * (p.max - p.min);
            expect(v).toBeCloseTo(want[i + 1], 4);
          });
        }
      }
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
      if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
      if (height) Object.defineProperty(HTMLElement.prototype, 'clientHeight', height);
    }
  });
});
