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

describe('saving a session to Puter', () => {
  function fakePuter() {
    const writes = [];
    let release;
    const gate = { open: Promise.resolve() };
    window.puter = {
      env: 'web',
      auth: { isSignedIn: () => true },
      fs: {
        write: async (path, data) => {
          writes.push(path);
          await gate.open;
          return { path };
        },
      },
    };
    return {
      writes,
      hold: () => (gate.open = new Promise((r) => (release = r))),
      release: () => release(),
    };
  }

  it('keeps edits made while the media uploads unsaved, and writes changed media at the next save', async () => {
    const { app, doc } = await appWithSession();
    const p = fakePuter();
    try {
      const t = doc.state.tracks[0];
      const src = doc.addSource({
        name: 'a.wav',
        channels: [Channel.fromSamples(new Float32Array(100).fill(0.1))],
      });
      doc.apply(
        'Add',
        S.addClips(doc.state, [S.createClip({ trackId: t.id, sourceId: src, length: 100 })]),
      );
      doc.source = { type: 'puter', path: '/u/AudioStudio/Test.asesx' };
      p.hold();
      const saving = app.commands.run('file.save');
      await new Promise((r) => setTimeout(r, 0));
      // While the media file uploads: a clip edit and an edit of the source audio.
      doc.apply('Rename Track', S.updateTrack(doc.state, t.id, { name: 'Edited' }));
      doc.updateSource(src, { channels: [Channel.fromSamples(new Float32Array(100).fill(0.2))] });
      p.release();
      await saving;
      expect(doc.dirty).toBe(true);
      // The next save writes the changed media again.
      p.writes.length = 0;
      await app.commands.run('file.save');
      expect(p.writes.some((w) => w.endsWith('.wav'))).toBe(true);
      expect(doc.dirty).toBe(false);
    } finally {
      delete window.puter;
    }
  });
});

describe('sends picked out of order', () => {
  it('fills the sends before a picked one, so the session saves and opens again', async () => {
    const { serializeSession, parseSession } = await import('../src/model/session-io.js');
    const doc = new Session({
      name: 'R.asesx',
      tracks: 0,
      template: [{ name: 'A' }, { name: 'B', type: 'bus' }, { name: 'C', type: 'bus' }],
    });
    const [a, b, c] = doc.state.tracks;
    // The send selector shows S1..S8: editing S4 of a track without sends.
    let st = S.setSend(doc.state, a.id, 3, { target: b.id, level: -6 });
    const sends = st.tracks[0].sends;
    expect(sends.length).toBe(4);
    expect([0, 1, 2].every((i) => i in sends && sends[i].target === null)).toBe(true);
    expect(sends[3]).toMatchObject({ target: b.id, level: -6 });
    expect(S.wouldCycle(st, c.id, a.id)).toBe(false);
    doc.apply('Send', st);
    const back = parseSession(serializeSession(doc).text).state;
    expect(back.tracks[0].sends[3]).toMatchObject({ target: b.id, level: -6 });
    // Sessions saved with gaps (null entries) open too.
    const text = serializeSession(doc).text.replace(/"sends": \[/, '"sends": [null, ');
    const gaps = parseSession(text).state.tracks[0].sends;
    expect(gaps.length).toBe(5);
    expect(gaps[0].target).toBe(null);
    expect(gaps[4].target).toBe(b.id);
  });
});

describe('bouncing to a new track', () => {
  it('leaves the master out of the bounce, since the new track plays through it again', async () => {
    const { app, doc } = await appWithSession();
    const t = doc.state.tracks[0];
    const src = doc.addSource({
      name: 'dc.wav',
      channels: [Channel.fromSamples(new Float32Array(RATE).fill(0.5))],
    });
    const c = S.createClip({ trackId: t.id, sourceId: src, start: 0, length: 2000 });
    let st = S.addClips(doc.state, [c]);
    st = S.updateTrack(st, t.id, { volume: -6.0206 });
    st = S.updateTrack(st, st.master.id, { volume: -6.0206, invert: true });
    doc.apply('Setup', st);
    const heard = renderState(doc.state, doc.pool, null, 2000)[0][1000];
    for (const cmd of ['mt.bounceClips', 'mt.bounceTime']) {
      doc.selectClips([c.id]);
      doc.setSelection(0, 2000);
      await app.commands.run(cmd);
      const bounced = doc.clipSelection[0];
      expect(bounced.id).not.toBe(c.id);
      // The track's volume is in the bounce; the master's volume and polarity are not.
      expect(doc.pool.get(bounced.sourceId).channels[0].toArray(1000, 1001)[0]).toBeCloseTo(
        0.25,
        4,
      );
      // Played back with the original muted, the bounce sounds like the clip did.
      const only = S.updateClips(doc.state, [c.id], { mute: true });
      expect(renderState(only, doc.pool, null, 2000)[0][1000]).toBeCloseTo(heard, 4);
      doc.history.undo();
    }
  });
});
