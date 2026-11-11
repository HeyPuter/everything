// Effect processing correctness: the WASM glue (FxHost parameters, offline
// effect chains) checked numerically against the built DSP module.
import { describe, it, expect, vi } from 'vitest';
import { wasmBytes } from './fx-wasm.js';
import { FxHost } from '../src/engine/fxhost.js';
import { getEffect, slotSpec, defaults } from '../src/effects/index.js';
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
