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

describe('pasting and inserting with hidden tracks', () => {
  const dc = (doc) =>
    doc.addSource({
      name: 'dc.wav',
      channels: [Channel.fromSamples(new Float32Array(RATE).fill(0.25))],
    });

  it('pastes clips copied from two tracks onto shown tracks only', async () => {
    const { app, doc } = await appWithSession({ tracks: 4 });
    const [t0, t1, t2, t3] = doc.state.tracks.map((t) => t.id);
    const src = dc(doc);
    const a = S.createClip({ trackId: t0, sourceId: src, start: 0, length: 1000 });
    const b = S.createClip({ trackId: t2, sourceId: src, start: 0, length: 1000 });
    doc.apply('Add', S.addClips(doc.state, [a, b]));
    // Track 2 (between the two copied clips) is hidden: they sit on adjacent shown rows.
    doc.amendView((st) => S.updateTrack(st, t1, { hidden: true }));
    doc.selectClips([a.id, b.id]);
    await app.commands.run('edit.copy');
    doc.selectClips([]);
    doc.selectTrack(t2);
    doc.setCursor(RATE / 2);
    await app.commands.run('edit.paste');
    const pasted = doc.clipSelection;
    expect(pasted.length).toBe(2);
    // The top clip lands on the selected track, the other on the next shown track (not a hidden one).
    expect(pasted.map((c) => c.trackId).sort()).toEqual([t2, t3].sort());
  });

  it('pastes onto the next shown track when the one below is hidden', async () => {
    const { app, doc } = await appWithSession({ tracks: 3 });
    const [t0, t1, t2] = doc.state.tracks.map((t) => t.id);
    const src = dc(doc);
    const a = S.createClip({ trackId: t0, sourceId: src, start: 0, length: 1000 });
    const b = S.createClip({ trackId: t1, sourceId: src, start: 0, length: 1000 });
    doc.apply('Add', S.addClips(doc.state, [a, b]));
    doc.selectClips([a.id, b.id]);
    await app.commands.run('edit.copy');
    doc.amendView((st) => S.updateTrack(st, t1, { hidden: true }));
    doc.selectClips([]);
    doc.selectTrack(t0);
    doc.setCursor(RATE);
    await app.commands.run('edit.paste');
    const pasted = doc.clipSelection;
    expect(pasted.map((c) => c.trackId).sort()).toEqual([t0, t2].sort());
    expect(pasted.every((c) => !S.findTrack(doc.state, c.trackId).hidden)).toBe(true);
  });

  it('inserts several files onto shown tracks only', async () => {
    const { app, doc } = await appWithSession({ tracks: 3 });
    const [t0, t1, t2] = doc.state.tracks.map((t) => t.id);
    doc.amendView((st) => S.updateTrack(st, t1, { hidden: true }));
    doc.selectTrack(t0);
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { insertDocs } = await import('../src/multitrack/insert.js');
    const file = (name) =>
      new AudioFile({
        name,
        sampleRate: RATE,
        channels: [Channel.fromSamples(new Float32Array(1000).fill(0.1))],
      });
    const ids = await insertDocs(app, doc, [file('a.wav'), file('b.wav')], { at: 0 });
    const tracks = ids.map((id) => S.findClip(doc.state, id).trackId);
    expect(tracks).toEqual([t0, t2]);
  });
});
