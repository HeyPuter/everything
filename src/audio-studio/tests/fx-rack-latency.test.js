// The waveform editor's Effects Rack plays in time with the playhead: a rack
// with latent effects (lookahead limiters, FFT effects) is latency-compensated
// like the multitrack engine's track racks, at any wet/dry mix.
import { describe, it, expect } from 'vitest';
import { ChunkStore, renderBlock, createScratch, CHUNK } from '../src/engine/mixcore.js';
import { FxHost } from '../src/engine/fxhost.js';
import { createRack, fitSlots, makeSlot, decorateGraph } from '../src/effects/rack.js';
import { Channel } from '../src/audio/channel.js';
import { wasmBytes } from './fx-wasm.js';
import { AudioFile } from '../src/model/audio-file.js';
import { openEffectDialog } from '../src/effects/dialog.js';
import { getEffect } from '../src/effects/registry.js';
import { fakeApp } from './fx-helpers.js';
import '../src/effects/index.js';

const RATE = 48000;
const IMPULSE = 5000;
const LIMITER = { ceiling: -0.1, inputBoost: 0, lookahead: 5, release: 80, link: true };

/** The waveform editor's playback graph for a file holding one impulse (like audioFileGraph). */
function fileGraph(rack, preview = []) {
  const data = new Float32Array(RATE);
  data[IMPULSE] = 0.5;
  const channels = [Channel.fromSamples(data)];
  const clip = {
    id: 'file',
    source: 'k',
    channels: 1,
    start: 0,
    offset: 0,
    length: RATE,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
  };
  const graph = {
    rate: RATE,
    tracks: [{ id: 'file', gain: 1, pan: 0, mute: false, solo: false, clips: [clip], fx: preview }],
    master: { gain: 1 },
  };
  decorateGraph(graph, rack);
  const store = new ChunkStore();
  store.put('k', 0, [channels[0].toArray(0, Math.min(CHUNK, RATE))]);
  return { graph, store };
}

/** Renders the graph through the real effects; returns the left channel. */
function render({ graph, store }, total = 12000, block = 128) {
  const host = new FxHost(new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}), RATE);
  for (const t of graph.tracks) t.fx = host.sync(t.fx);
  const scratch = createScratch(block);
  const L = new Float32Array(total);
  for (let at = 0; at < total; at += block) {
    const n = Math.min(block, total - at);
    const out = [new Float32Array(n), new Float32Array(n)];
    renderBlock(graph, store, at, n, out, scratch, {
      runFx: (chain, buf, f) => host.run(chain, buf, f),
    });
    L.set(out[0], at);
  }
  return L;
}

/** Frames where the signal has a peak (above 30% of the loudest). */
function peaks(L) {
  let max = 0;
  for (const v of L) max = Math.max(max, Math.abs(v));
  const at = [];
  for (let i = 0; i < L.length; i++)
    if (max && Math.abs(L[i]) > max * 0.3 && (!at.length || i - at[at.length - 1] > 50)) at.push(i);
  return at;
}

const rackWith = (o = {}) => ({
  ...createRack(),
  slots: fitSlots([makeSlot('hardLimiter', LIMITER)]),
  ...o,
});

describe('waveform Effects Rack latency compensation', () => {
  it('plays a rack with a lookahead limiter in time with the playhead', () => {
    expect(peaks(render(fileGraph(rackWith())))).toEqual([IMPULSE]);
  });
  it('lines up the wet and dry parts with the playhead below 100% mix', () => {
    const L = render(fileGraph(rackWith({ mix: 0.5 })));
    expect(peaks(L)).toEqual([IMPULSE]);
    expect(Math.abs(L[IMPULSE])).toBeGreaterThan(0.4); // wet and dry add up in one peak
  });
  it('adds no delay with the limiter switched off or the rack powered off', () => {
    const off = { ...createRack(), slots: fitSlots([makeSlot('hardLimiter', LIMITER, false)]) };
    expect(peaks(render(fileGraph(off)))).toEqual([IMPULSE]);
    expect(peaks(render(fileGraph(rackWith({ power: false }))))).toEqual([IMPULSE]);
  });
});

describe('effect dialog preview latency compensation', () => {
  /** The preview slots an open Hard Limiter dialog plays through, with its power on or off. */
  function previewSlots(power = true) {
    const app = fakeApp();
    const doc = new AudioFile({
      name: 'a.wav',
      sampleRate: RATE,
      channels: [Channel.fromSamples(new Float32Array(RATE))],
    });
    app.addDocument(doc);
    openEffectDialog(app, getEffect('hardLimiter'), { doc, values: LIMITER });
    const dlg = document.querySelector('.fx-dialog');
    dlg.querySelector('.fx-play').click();
    if (!power) dlg.querySelector('.fx-power').click();
    const slots = app.previewFx;
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Close').click();
    return slots;
  }

  it('plays a previewed lookahead limiter in time with the playhead, alone and before the rack', () => {
    const slots = previewSlots();
    expect(slots[0].latency).toBeGreaterThan(200); // 5 ms lookahead
    expect(peaks(render(fileGraph(createRack(), slots)))).toEqual([IMPULSE]);
    expect(peaks(render(fileGraph(rackWith({ mix: 0.5 }), previewSlots())))).toEqual([IMPULSE]);
  });
  it('adds no delay with the previewed effect switched off', () => {
    const slots = previewSlots(false);
    expect(slots[0].enabled).toBe(false);
    expect(peaks(render(fileGraph(createRack(), slots)))).toEqual([IMPULSE]);
  });
});
