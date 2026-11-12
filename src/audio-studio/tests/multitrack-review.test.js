// Regression tests for multitrack fixes from the second adversarial review.
import { describe, it, expect, vi } from 'vitest';
import { Session } from '../src/model/session.js';
import * as S from '../src/model/session-edits.js';
import { Channel } from '../src/audio/channel.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import { ChunkStore, renderBlock, createScratch, CHUNK } from '../src/engine/mixcore.js';

// Offline renders run through mixcore on the main thread (no worker in jsdom).
function renderNow(graph, sources, { start = 0, end }) {
  const store = new ChunkStore();
  for (const [key, chans] of sources) {
    const n = chans[0].length;
    for (let i = 0; i * CHUNK < n; i++)
      store.put(
        key,
        i,
        chans.map((c) => c.toArray(i * CHUNK, Math.min(n, (i + 1) * CHUNK))),
      );
  }
  const nch = graph.surround ? 6 : 2;
  const out = Array.from({ length: nch }, () => new Float32Array(end - start));
  const scratch = createScratch(128);
  const block = Array.from({ length: nch }, () => new Float32Array(128));
  for (let at = start; at < end; at += 128) {
    const n = Math.min(128, end - at);
    renderBlock(graph, store, at, n, block, scratch);
    for (let c = 0; c < nch; c++) out[c].set(block[c].subarray(0, n), at - start);
  }
  return out;
}

vi.mock('../src/engine/offline.js', () => ({
  renderGraph: async (graph, sources, o) => renderNow(graph, sources, o),
}));

const RATE = 48000;

async function appWithSession({ tracks = 3 } = {}) {
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
  const doc = new Session({ name: 'Test.asesx', sampleRate: RATE, tracks });
  app.addDocument(doc);
  return { app, doc };
}

/** Renders a track of a session state as heard (through the track, before the master). */
function renderState(state, pool, panLaw, end) {
  const { graph, sources } = buildSessionGraph(state, pool, { panLaw });
  return renderNow(graph, sources, { start: 0, end });
}

describe('merging clips', () => {
  it('sounds the same after the merge with track EQ, polarity and an equal-power pan law', async () => {
    const { app, doc } = await appWithSession();
    app.prefs.set('panLaw', 'equalPower');
    app.prefs.set('panLawDb', -3);
    const ramp = new Float32Array(RATE).map((_, i) => 0.5 * Math.sin(i / 7));
    const src = doc.addSource({
      name: 'tone.wav',
      channels: [Channel.fromSamples(ramp), Channel.fromSamples(ramp)],
    });
    const t = doc.state.tracks[0];
    const a = S.createClip({ trackId: t.id, sourceId: src, start: 0, length: 4000, gain: -2 });
    const b = S.createClip({
      trackId: t.id,
      sourceId: src,
      start: 4000,
      offset: 4000,
      length: 4000,
      fadeOut: { length: 1000, curve: 0 },
    });
    let st = S.addClips(doc.state, [a, b]);
    st = S.updateTrack(st, t.id, { invert: true, pan: 30, eq: { on: true, values: {} } });
    doc.apply('Setup', st);
    const law = { mode: 'equalPower', centerDb: -3 };
    const before = renderState(doc.state, doc.pool, law, 8000);
    doc.selectClips([a.id, b.id]);
    await app.commands.run('clip.merge');
    expect(doc.state.clips.length).toBe(1);
    // The merged clip carries the clips' own sound, not the track's EQ (which still runs on the track).
    const merged = doc.state.clips[0];
    const after = renderState(doc.state, doc.pool, law, 8000);
    for (const i of [100, 2500, 4100, 7500]) {
      expect(after[0][i]).toBeCloseTo(before[0][i], 5);
      expect(after[1][i]).toBeCloseTo(before[1][i], 5);
    }
    expect(merged.length).toBe(8000);
  });
});
