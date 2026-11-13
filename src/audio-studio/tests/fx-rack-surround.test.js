// Effects Rack Apply on a 5.1 file: surround-capable slots (Surround Reverb)
// render on all six channels, as applying the effect from the menu does.
import { describe, it, expect, vi } from 'vitest';
import './fx-wasm.js';
import { getEffect, defaults } from '../src/effects/index.js';
import { applyChain } from '../src/engine/offline.js';
import { renderEffect } from '../src/effects/apply.js';
import { createRack, makeSlot, fitSlots, renderRack } from '../src/effects/rack.js';
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

const RATE = 8000;
const rms = (c) => {
  const a = c.toArray(0, c.length);
  return Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
};

describe('Effects Rack on a 5.1 file', () => {
  it('renders Surround Reverb on all six channels, like applying it alone', async () => {
    const n = RATE;
    // A click in the centre channel only.
    const channels = Array.from({ length: 6 }, (_, c) => {
      const a = new Float32Array(n);
      if (c === 2) a[100] = 1;
      return Channel.fromSamples(a);
    });
    const state = { sampleRate: RATE, channels, markers: [] };
    const def = getEffect('surroundReverb');
    const values = { ...defaults(def), mix: 100 };
    const alone = await renderEffect({ def, values, state, start: 0, end: n, applyChain });
    const rack = { ...createRack(), slots: fitSlots([makeSlot('surroundReverb', values)]) };
    // Rack Apply passes the file (its rate builds the impulse).
    const doc = { sampleRate: RATE };
    const racked = await renderRack({ rack, state, start: 0, end: n, applyChain, doc });
    const a = alone.state.channels.map(rms);
    const r = racked.channels.map(rms);
    // The centre feeds the room, so its reverb reaches the front pair.
    expect(a[0]).toBeGreaterThan(1e-4);
    // Through the rack, each channel used to run on its own: no reverb reached L and R.
    r.forEach((v, c) => expect(v).toBeCloseTo(a[c], 6));
  });
});
