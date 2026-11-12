// Plugin delay compensation: tracks, buses, sends and the master with latent
// effects (lookahead limiters, FFT effects) line up with the timeline.
import { describe, it, expect } from 'vitest';
import { ChunkStore, renderBlock, createScratch, compensateLatency, CHUNK } from '../src/engine/mixcore.js';
import { FxHost } from '../src/engine/fxhost.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import * as S from '../src/model/session-edits.js';
import { Channel } from '../src/audio/channel.js';
import { wasmBytes } from './fx-wasm.js';
import '../src/effects/index.js';

const IMPULSE = 5000;

/** Renders `total` frames in `block`-sized blocks; returns the left channel. */
function render(graph, store, runFx, block = 128, total = 12000) {
  const scratch = createScratch(block);
  const L = new Float32Array(total);
  for (let at = 0; at < total; at += block) {
    const n = Math.min(block, total - at);
    const out = [new Float32Array(n), new Float32Array(n)];
    renderBlock(graph, store, at, n, out, scratch, { runFx });
    L.set(out[0], at);
  }
  return L;
}

/** Frames where the signal has a peak (above 30% of the loudest). */
function peaks(L) {
  let max = 0;
  for (const v of L) max = Math.max(max, Math.abs(v));
  const at = [];
  for (let i = 0; i < L.length; i++) if (max && Math.abs(L[i]) > max * 0.3 && (!at.length || i - at[at.length - 1] > 50)) at.push(i);
  return at;
}

describe('latency compensation in the mix core', () => {
  // A fake effect chain [{ lat }] that delays its input by `lat` frames.
  const rings = new Map();
  const runFx = (chain, buf, frames) => {
    for (const slot of chain) {
      let r = rings.get(slot);
      if (!r) rings.set(slot, (r = { data: buf.map(() => new Float32Array(slot.lat)), pos: 0 }));
      let pos = r.pos;
      for (let c = 0; c < buf.length; c++) {
        pos = r.pos;
        for (let i = 0; i < frames; i++) {
          const v = r.data[c][pos];
          r.data[c][pos] = buf[c][i];
          buf[c][i] = v;
          if (++pos === slot.lat) pos = 0;
        }
      }
      r.pos = pos;
    }
  };
  const store = new ChunkStore();
  const data = new Float32Array(CHUNK);
  data[IMPULSE] = 0.5;
  store.put('k', 0, [data]);
  const clip = { id: 'c', source: 'k', channels: 1, start: 0, offset: 0, length: CHUNK, gain: 1, fadeIn: 0, fadeOut: 0 };
  const track = (id, o = {}) => ({ id, gain: 1, pan: 0, clips: [{ ...clip }], fx: [], ...o });
  const graphOf = (soloId, masterLat = 0) => {
    rings.clear();
    const tracks = [
      track('plain'),
      track('latent', { fx: [{ lat: 300 }], latency: 300 }),
      track('toBus', { output: 'bus' }),
      track('sends', { sends: [{ target: 'rev', gain: 1, pan: 0 }] }),
      { id: 'bus', bus: true, gain: 1, pan: 0, clips: [], fx: [{ lat: 120 }], latency: 120 },
      { id: 'rev', bus: true, gain: 1, pan: 0, clips: [], fx: [{ lat: 700 }], latency: 700 },
    ];
    for (const t of tracks) if (!t.bus) t.mute = t.id !== soloId;
    const master = { gain: 1, ...(masterLat ? { fx: [{ lat: masterLat }], latency: masterLat } : {}) };
    return compensateLatency({ rate: 48000, tracks, master });
  };

  it('lines up a latent track, a track through a latent bus and both paths of a send', () => {
    for (const block of [128, 8192]) {
      for (const id of ['plain', 'latent', 'toBus']) expect(peaks(render(graphOf(id), store, runFx, block))).toEqual([IMPULSE]);
      // The direct path and the copy sent through the 700-frame bus arrive together (one peak of twice the level).
      const sent = render(graphOf('sends'), store, runFx, block);
      expect(peaks(sent)).toEqual([IMPULSE]);
      expect(sent[IMPULSE]).toBeCloseTo(1, 5);
    }
  });

  it('includes the master chain, and leaves graphs without latency untouched', () => {
    for (const id of ['plain', 'latent', 'sends']) expect(peaks(render(graphOf(id, 64), store, runFx))).toEqual([IMPULSE]);
    const plain = { rate: 48000, tracks: [track('a')], master: { gain: 1 } };
    const clips = plain.tracks[0].clips;
    compensateLatency(plain);
    expect(plain.tracks[0].clips).toBe(clips);
    expect(plain.tracks[0].envShift).toBeUndefined();
  });

  it('reads track automation where the compensated audio is', () => {
    // A track feeding the 120-frame-latent bus runs 120 frames ahead: automation
    // that silences it from the impulse on must silence the impulse.
    const g = graphOf('toBus');
    g.tracks[2].volumeEnv = [{ t: 0, v: 1 }, { t: IMPULSE - 1, v: 1 }, { t: IMPULSE, v: 0 }];
    expect(g.tracks[2].envShift).toBe(120);
    expect(peaks(render(g, store, runFx))).toEqual([]);
    g.tracks[2].volumeEnv = [{ t: 0, v: 1 }, { t: IMPULSE, v: 1 }, { t: IMPULSE + 1, v: 0 }];
    rings.clear();
    expect(peaks(render(g, store, runFx))).toEqual([IMPULSE]);
  });
});

describe('latency compensation in sessions', () => {
  const RATE = 48000;
  const limiter = (enabled = true) => ({ id: 'lim', effect: 'hardLimiter', values: { ceiling: -0.1, inputBoost: 0, lookahead: 5, release: 80, link: true }, enabled });

  function session() {
    let state = S.createSessionState({ sampleRate: RATE, tracks: 2 });
    const data = new Float32Array(RATE);
    data[IMPULSE] = 0.5;
    const pool = new Map([['src', { channels: [Channel.fromSamples(data)] }]]);
    const [a, b] = state.tracks;
    state = S.addClips(state, [a, b].map((t, i) => S.createClip({ trackId: t.id, sourceId: 'src', name: `c${i}`, start: 0, length: RATE })));
    return { state, pool, a, b };
  }

  /** Renders the session through the real effects, with only track `id` audible. */
  function renderSolo(state, pool, id) {
    for (const t of state.tracks) if (t.type === 'audio') state = S.updateTrack(state, t.id, { mute: t.id !== id });
    const { graph, sources } = buildSessionGraph(state, pool);
    const host = new FxHost(new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}), RATE);
    for (const t of graph.tracks) t.fx = host.sync(t.fx);
    graph.master.fx = host.sync(graph.master.fx);
    const store = new ChunkStore();
    for (const [key, ch] of sources) store.put(key, 0, ch.map((c) => c.toArray(0, Math.min(CHUNK, c.length))));
    return { graph, L: render(graph, store, (chain, buf, f) => host.run(chain, buf, f), 128, 12000) };
  }

  it('plays a track with a lookahead limiter in time with the others, and a bypassed one without delay', () => {
    const { state, pool, a, b } = session();
    const st = S.updateTrack(state, b.id, { fx: [limiter()] });
    const latent = renderSolo(st, pool, b.id);
    expect(latent.graph.tracks.find((t) => t.id === b.id).latency).toBeGreaterThan(200); // 5 ms lookahead
    expect(peaks(latent.L)).toEqual([IMPULSE]);
    expect(peaks(renderSolo(st, pool, a.id).L)).toEqual([IMPULSE]);
    // Switched off (or the rack powered off), the limiter adds no delay and nothing is moved.
    for (const off of [S.updateTrack(state, b.id, { fx: [limiter(false)] }), S.updateTrack(st, b.id, { fxPower: false })]) {
      const r = renderSolo(off, pool, b.id);
      expect(r.graph.tracks.find((t) => t.id === b.id).latency).toBeUndefined();
      expect(peaks(r.L)).toEqual([IMPULSE]);
    }
  });
});
