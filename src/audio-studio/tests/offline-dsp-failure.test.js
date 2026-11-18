import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wasmBytes } from './fx-wasm.js';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { fakeApp } from './fx-helpers.js';
import { getEffect, defaults, slotSpec } from '../src/effects/index.js';
import { makeSlot, fitSlots } from '../src/effects/rack.js';
import { applyRack, rackFor, setRack } from '../src/effects/rack-panel.js';
import { applyChain, renderGraph } from '../src/engine/offline.js';

const mock = vi.hoisted(() => ({ module: vi.fn() }));
vi.mock('../src/audio/dsp.js', async (original) => ({ ...(await original()), dspModule: mock.module }));
vi.mock('../src/engine/offline-worker.js?worker', async () => {
  const saved = self.onmessage;
  await import('../src/engine/offline-worker.js');
  const handler = self.onmessage;
  self.onmessage = saved;
  return { default: class {
    constructor() { self.postMessage = (m) => queueMicrotask(() => this.onmessage?.({ data: m })); }
    postMessage(m) { queueMicrotask(() => handler({ data: m })); }
    terminate() {}
  } };
});

beforeEach(() => { mock.module.mockReset().mockRejectedValue(new Error('DSP download failed')); });

describe('offline rendering without DSP', () => {
  it('keeps the audio and effects rack intact when DSP loading fails, and allows retry', async () => {
    const app = fakeApp();
    const doc = new AudioFile({ name: 'Test.wav', sampleRate: 48000, channels: [Channel.fromSamples(new Float32Array(256).fill(0.5))] });
    app.active = doc;
    const slots = fitSlots([makeSlot('amplify', { left: -6, right: -6 })]);
    setRack(app, doc, { ...rackFor(doc), slots, process: 'file' });
    const before = doc.state;
    await expect(applyRack(app)).rejects.toThrow('DSP download failed');
    expect(doc.state).toBe(before);
    expect(rackFor(doc).slots).toBe(slots);
    mock.module.mockResolvedValue(new WebAssembly.Module(wasmBytes));
    expect(await applyRack(app)).toBe(true);
    expect(doc.state.channels[0].toArray()[128]).toBeCloseTo(0.5 * 10 ** (-6 / 20), 5);
    expect(rackFor(doc).slots.some(Boolean)).toBe(false);
  });

  it.each(['clip', 'master'])('does not silently omit enabled %s effects', async (where) => {
    const def = getEffect('amplify');
    const fx = [slotSpec(def, defaults(def), { key: 'effect', rate: 48000 })];
    const graph = { rate: 48000, tracks: [{ id: 't', gain: 1, pan: 0, clips: [{ id: 'c', source: 'audio', channels: 1, start: 0, offset: 0, length: 4, gain: 1, fadeIn: 0, fadeOut: 0, fx: where === 'clip' ? fx : [] }] }], master: { gain: 1, fx: where === 'master' ? fx : [] } };
    const sources = new Map([['audio', [Channel.fromSamples(new Float32Array(4).fill(0.5))]]]);
    await expect(renderGraph(graph, sources, { end: 4 })).rejects.toThrow('DSP download failed');
  });

  it.each([false, true])('still renders audio without active effects (bypassed slot: %s)', async (bypassed) => {
    const channels = [Channel.fromSamples(Float32Array.of(0.25, 0.5, -0.25, 0))];
    const def = getEffect('amplify');
    const specs = bypassed ? [{ ...slotSpec(def, defaults(def), { key: 'effect', rate: 48000 }), enabled: false }] : [];
    const out = await applyChain(channels, 48000, specs);
    expect([...out[0]]).toEqual([0.25, 0.5, -0.25, 0]);
  });
});
