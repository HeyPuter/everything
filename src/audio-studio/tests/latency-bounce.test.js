// Bounces and merged clips get the same latency compensation as playback and
// mixdowns, for the graph they actually render (without the master, or one
// track without its output routing).
import { describe, it, expect, vi } from 'vitest';
import { Session } from '../src/model/session.js';
import * as S from '../src/model/session-edits.js';
import { Channel } from '../src/audio/channel.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import { ChunkStore, renderBlock, createScratch, CHUNK } from '../src/engine/mixcore.js';
import { FxHost } from '../src/engine/fxhost.js';
import { wasmBytes } from './fx-wasm.js';
import '../src/effects/index.js';

const RATE = 48000;
const IMPULSE = 6000;

// Offline renders run through mixcore and the real effects on the main thread (no worker in jsdom).
function renderNow(graph, sources, { start = 0, end }) {
  const host = new FxHost(new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}), RATE);
  for (const t of graph.tracks) t.fx = host.sync(t.fx);
  if (graph.master) graph.master.fx = host.sync(graph.master.fx);
  const store = new ChunkStore();
  for (const [key, chans] of sources) {
    const n = chans[0].length;
    for (let i = 0; i * CHUNK < n; i++) store.put(key, i, chans.map((c) => c.toArray(i * CHUNK, Math.min(n, (i + 1) * CHUNK))));
  }
  const nch = graph.surround ? 6 : 2;
  const out = Array.from({ length: nch }, () => new Float32Array(end - start));
  const scratch = createScratch(128);
  const block = Array.from({ length: nch }, () => new Float32Array(128));
  const runFx = (chain, buf, f) => host.run(chain, buf, f);
  for (let at = start; at < end; at += 128) {
    const n = Math.min(128, end - at);
    renderBlock(graph, store, at, n, block, scratch, { runFx });
    for (let c = 0; c < nch; c++) out[c].set(block[c].subarray(0, n), at - start);
  }
  return out;
}

vi.mock('../src/engine/offline.js', () => ({
  renderGraph: async (graph, sources, o) => renderNow(graph, sources, o),
}));

const limiter = (lookahead = 5) => ({ id: `lim${lookahead}`, effect: 'hardLimiter', values: { ceiling: -0.1, inputBoost: 0, lookahead, release: 80, link: true }, enabled: true });

/** Frame of the loudest sample. */
function peakAt(L) {
  let at = -1;
  let max = 0;
  for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > max) [max, at] = [Math.abs(L[i]), i];
  return at;
}

async function appWithSession() {
  HTMLCanvasElement.prototype.getContext = () => null;
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  }
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const { installMultitrack } = await import('../src/features/multitrack.js');
  const app = new App();
  installCore(app);
  installMultitrack(app);
  app.syncGraph = () => {};
  const doc = new Session({ name: 'Latency.asesx', sampleRate: RATE, tracks: 2 });
  app.addDocument(doc);
  const data = new Float32Array(RATE);
  data[IMPULSE] = 0.5;
  const src = doc.addSource({ name: 'click.wav', channels: [Channel.fromSamples(data)] });
  // Track 1 plays through a bus with a 5 ms limiter; the master has a 10 ms limiter.
  const bus = S.createTrack({ type: 'bus', name: 'Bus', channels: 2 });
  const [t] = doc.state.tracks;
  const c1 = S.createClip({ trackId: t.id, sourceId: src, name: 'a', start: 0, length: RATE / 2 });
  const c2 = S.createClip({ trackId: t.id, sourceId: src, name: 'b', start: RATE / 2, length: RATE / 4, offset: 0 });
  let st = S.addTrack(S.addClips(doc.state, [c1, c2]), bus);
  st = S.updateTrack(st, bus.id, { fx: [limiter(5)] });
  st = S.updateTrack(st, t.id, { output: bus.id, fx: [limiter(3)] });
  st = S.updateTrack(st, st.master.id, { fx: [limiter(10)] });
  doc.apply('Setup', st);
  return { app, doc, t, c1, c2 };
}

describe('latency compensation in bounces and merges', () => {
  it('plays and mixes down the impulse on time (the reference)', async () => {
    const { doc } = await appWithSession();
    const { graph, sources } = buildSessionGraph(doc.state, doc.pool);
    expect(peakAt(renderNow(graph, sources, { end: RATE / 2 })[0])).toBe(IMPULSE);
  });

  it('bounces clips, a time selection and a track to audio that lands where it was heard', async () => {
    const { app, doc, t, c1 } = await appWithSession();
    for (const cmd of ['mt.bounceClips', 'mt.bounceTime', 'mt.bounceTrack']) {
      doc.selectClips([c1.id]);
      doc.selectTrack(t.id);
      doc.setSelection(0, RATE / 2);
      await app.commands.run(cmd);
      const bounced = doc.clipSelection[0];
      expect(bounced.id).not.toBe(c1.id);
      const audio = doc.pool.get(bounced.sourceId).channels[0].toArray();
      expect(bounced.start + peakAt(audio)).toBe(IMPULSE);
      doc.history.undo();
    }
  });

  it('merges clips without moving their audio', async () => {
    const { app, doc, t, c1, c2 } = await appWithSession();
    doc.selectClips([c1.id, c2.id]);
    await app.commands.run('clip.merge');
    const merged = doc.state.clips.find((c) => c.trackId === t.id && c.id !== c1.id && c.id !== c2.id);
    const audio = doc.pool.get(merged.sourceId).channels[0].toArray(0, RATE / 2);
    expect(merged.start + peakAt(audio)).toBe(IMPULSE);
  });
});

describe('latency compensation in 5.1 sessions', () => {
  it('compensates only the effects that run on six channels, and keeps stereo tracks in time', () => {
    let st = S.createSessionState({ sampleRate: RATE, tracks: 2, masterChannels: 6 });
    const [a, b] = st.tracks;
    st = S.updateTrack(st, a.id, { channels: 6 });
    const one = new Float32Array(RATE);
    one[IMPULSE] = 0.5;
    const six = Array.from({ length: 6 }, () => Channel.fromSamples(one.slice()));
    const pool = new Map([['six', { channels: six }], ['mono', { channels: [Channel.fromSamples(one)] }]]);
    st = S.addClips(st, [S.createClip({ trackId: a.id, sourceId: 'six', name: 's', start: 0, length: RATE }), S.createClip({ trackId: b.id, sourceId: 'mono', name: 'm', start: 0, length: RATE })]);
    // A stereo-only limiter does not run on the 5.1 track or the 5.1 master: no delay to make up.
    st = S.updateTrack(st, a.id, { fx: [limiter(5)] });
    st = S.updateTrack(st, b.id, { fx: [limiter(5)] });
    st = S.updateTrack(st, st.master.id, { fx: [limiter(10)] });
    const solo = (id) => st.tracks.reduce((s, t) => S.updateTrack(s, t.id, { mute: t.id !== id }), st);
    for (const id of [a.id, b.id]) {
      const { graph, sources } = buildSessionGraph(solo(id), pool);
      expect(graph.master.latency).toBeUndefined();
      expect(graph.tracks.find((t) => t.id === a.id).latency).toBeUndefined();
      expect(graph.tracks.find((t) => t.id === b.id).latency).toBeGreaterThan(200);
      const out = renderNow(graph, sources, { end: RATE / 4 });
      expect(peakAt(out[0])).toBe(IMPULSE);
    }
    // A surround-capable latent effect on the 5.1 track is compensated.
    const rev = { id: 'rev', effect: 'surroundReverb', values: {}, enabled: true };
    const { graph } = buildSessionGraph(S.updateTrack(st, a.id, { fx: [rev] }), pool);
    expect(graph.tracks.find((t) => t.id === a.id).latency).toBeGreaterThan(0);
  });
});
