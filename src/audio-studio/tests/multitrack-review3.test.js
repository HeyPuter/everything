// Regression tests for multitrack fixes from the third review.
import { describe, it, expect, vi } from 'vitest';
import { Session } from '../src/model/session.js';
import * as S from '../src/model/session-edits.js';
import { Channel } from '../src/audio/channel.js';
import { parseWav, encodeWav } from '../src/audio/wav.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import { ChunkStore, renderBlock, createScratch, CHUNK } from '../src/engine/mixcore.js';

// Offline renders run through mixcore on the main thread (no worker in jsdom).
function renderNow(graph, sources, { start = 0, end }) {
  const store = new ChunkStore();
  for (const [key, chans] of sources) {
    const n = chans[0].length;
    for (let i = 0; i * CHUNK < n; i++) {
      store.put(
        key,
        i,
        chans.map((c) => c.toArray(i * CHUNK, Math.min(n, (i + 1) * CHUNK))),
      );
    }
  }
  const out = [new Float32Array(end - start), new Float32Array(end - start)];
  const scratch = createScratch(128);
  const block = [new Float32Array(128), new Float32Array(128)];
  for (let at = start; at < end; at += 128) {
    const n = Math.min(128, end - at);
    renderBlock(graph, store, at, n, block, scratch);
    for (let c = 0; c < 2; c++) out[c].set(block[c].subarray(0, n), at - start);
  }
  return out;
}

vi.mock('../src/engine/offline.js', () => ({
  renderGraph: async (graph, sources, o) => renderNow(graph, sources, o),
}));

async function appWithSession() {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const { installMultitrack } = await import('../src/features/multitrack.js');
  const app = new App();
  installCore(app);
  installMultitrack(app);
  app.syncGraph = () => {};
  const doc = new Session({ name: 'Test.asesx', sampleRate: 8000, tracks: 2 });
  app.addDocument(doc);
  return { app, doc };
}

const dc = (doc, v) =>
  doc.addSource({
    name: `dc${v}.wav`,
    channels: [Channel.fromSamples(new Float32Array(8000).fill(v))],
  });

const puterFiles = vi.hoisted(() => new Map());
vi.mock('../src/storage/puter.js', async (orig) => ({
  ...(await orig()),
  sdk: () => ({}),
  isSignedIn: () => true,
  writeFile: async (path, blob) => puterFiles.set(path, new Uint8Array(await blob.arrayBuffer())),
}));

const picked = vi.hoisted(() => []);
vi.mock('../src/storage/files.js', async (orig) => ({
  ...(await orig()),
  pickLocalFiles: async () => picked.splice(0),
}));

const { saveSession } = await import('../src/multitrack/storage.js');

describe('saving sessions to Puter', () => {
  it('rewrites a media file that came to hold another source after an undo', async () => {
    puterFiles.clear();
    const app = { setStatus() {}, prefs: { get: () => [], set() {} } };
    const doc = new Session({
      name: 'Song.asesx',
      sampleRate: 8000,
      tracks: 2,
      source: { type: 'puter', path: '/u/Song.asesx' },
    });
    // Two sources with one name: their media files are "Take.wav" and "Take 2.wav".
    const a = doc.addSource({
      name: 'Take.wav',
      channels: [Channel.fromSamples(new Float32Array(100).fill(0.25))],
    });
    const b = doc.addSource({
      name: 'Take.wav',
      channels: [Channel.fromSamples(new Float32Array(100).fill(-0.5))],
    });
    const t = doc.state.tracks;
    const ca = S.createClip({ trackId: t[0].id, sourceId: a, start: 0, length: 100 });
    const cb = S.createClip({ trackId: t[1].id, sourceId: b, start: 0, length: 100 });
    doc.apply('Insert', S.addClips(doc.state, [ca, cb]));
    await saveSession(app, doc);
    // Without A's clip, B is saved as "Take.wav", over A's audio.
    doc.apply('Delete', S.removeClips(doc.state, [ca.id]));
    await saveSession(app, doc);
    // A comes back: its file must hold its own audio again.
    doc.history.undo();
    await saveSession(app, doc);
    const saved = JSON.parse(new TextDecoder().decode(puterFiles.get('/u/Song.asesx')));
    const first = (id) =>
      parseWav(puterFiles.get(`/u/${saved.sources.find((s) => s.id === id).file}`).buffer)
        .channels[0][0];
    expect(first(a)).toBeCloseTo(0.25);
    expect(first(b)).toBeCloseTo(-0.5);
    // Nothing changed since: the next save writes no media.
    const writes = puterFiles.size;
    puterFiles.clear();
    await saveSession(app, doc);
    expect([...puterFiles.keys()]).toEqual(['/u/Song.asesx']);
    expect(writes).toBe(3);
  });
});

describe('merging clips', () => {
  it('keeps the merged audio in front of a clip the merged clips were in front of', async () => {
    const { app, doc } = await appWithSession();
    const t = doc.state.tracks[0].id;
    // A bed clip that was moved (so it is above unmoved clips), and two clips moved onto it after.
    const bed = S.createClip({ trackId: t, sourceId: dc(doc, 0.1), start: 0, length: 8000, z: 1 });
    const loud = dc(doc, 0.5);
    const a = S.createClip({ trackId: t, sourceId: loud, start: 2000, length: 2000, z: 2 });
    const b = S.createClip({ trackId: t, sourceId: loud, start: 4000, length: 2000, z: 3 });
    doc.apply('Setup', S.addClips(doc.state, [bed, a, b]));
    const heard = () => {
      const { graph, sources } = buildSessionGraph(doc.state, doc.pool);
      return renderNow(graph, sources, { start: 0, end: 8000 })[0];
    };
    const before = heard();
    doc.selectClips([a.id, b.id]);
    await app.commands.run('clip.merge');
    expect(doc.state.clips.length).toBe(2);
    const after = heard();
    for (const i of [1000, 2500, 4500, 5900, 7000]) expect(after[i]).toBeCloseTo(before[i], 5);
  });
});

describe('bouncing', () => {
  it('leaves no bounce file behind when the session closes while it renders', async () => {
    const { app, doc } = await appWithSession();
    const t = doc.state.tracks[0].id;
    doc.apply(
      'Add',
      S.addClips(doc.state, [
        S.createClip({ trackId: t, sourceId: dc(doc, 0.5), start: 0, length: 4000 }),
      ]),
    );
    doc.selectTrack(t);
    const before = app.documents.length;
    const bouncing = app.commands.run('mt.bounceTrack');
    await app.closeDocument(doc, { force: true });
    await bouncing;
    expect(app.documents.length).toBe(before - 1);
    expect(app.documents.some((d) => /Bounce/.test(d.name))).toBe(false);
  });
});

describe('linking missing media', () => {
  it('marks the session unsaved, so closing it asks to keep the link', async () => {
    const { app, doc } = await appWithSession();
    const t = doc.state.tracks[0].id;
    doc.addSource({ id: 'gone', name: 'Take.wav', channels: [], offline: true });
    doc.apply(
      'Add',
      S.addClips(doc.state, [
        S.createClip({ trackId: t, sourceId: 'gone', start: 0, length: 4000 }),
      ]),
    );
    doc.markSaved();
    const wav = encodeWav({
      sampleRate: 8000,
      channels: [new Float32Array(4000).fill(0.5)],
      bitDepth: 16,
    });
    picked.push(new File([wav], 'Take.wav', { type: 'audio/wav' }));
    const { installMoreCommands } = await import('../src/multitrack/more-commands.js');
    installMoreCommands(app);
    await app.commands.run('clip.linkMedia');
    expect(doc.pool.get('gone').offline).toBe(false);
    expect(doc.dirty).toBe(true);
  });
});

describe('send destinations', () => {
  it('stop offering a bus once that bus sends back to this one', async () => {
    const { app, doc } = await appWithSession();
    const { SendControls } = await import('../src/multitrack/send-eq.js');
    const a = S.createTrack({ type: 'bus', name: 'Bus A' });
    const b = S.createTrack({ type: 'bus', name: 'Bus B' });
    doc.apply('Buses', S.addTrack(S.addTrack(doc.state, a), b));
    const ctl = new SendControls(app, doc, a.id);
    const offered = () => [...ctl.target.options].map((o) => o.textContent);
    ctl.update(S.findTrack(doc.state, a.id));
    expect(offered()).toEqual(['None', 'Bus B']);
    // Bus B now sends to Bus A: sending A to B would make a loop.
    doc.apply('Send', S.setSend(doc.state, b.id, 0, { target: a.id }));
    ctl.update(S.findTrack(doc.state, a.id));
    expect(offered()).toEqual(['None']);
  });
});

describe('moving tracks', () => {
  it('Move Track Up and Down step over hidden tracks', async () => {
    const { app, doc } = await appWithSession();
    doc.apply('Add', S.addTrack(doc.state, S.createTrack({ name: 'Track 3' })));
    const [t1, t2, t3] = doc.state.tracks.map((t) => t.id);
    doc.amendView((st) => S.updateTrack(st, t2, { hidden: true }));
    const shown = () => doc.state.tracks.filter((t) => !t.hidden).map((t) => t.id);
    doc.selectTrack(t3);
    await app.commands.run('mt.moveTrackUp');
    expect(shown()).toEqual([t3, t1]);
    expect(app.commands.isEnabled('mt.moveTrackUp')).toBe(false);
    await app.commands.run('mt.moveTrackDown');
    expect(shown()).toEqual([t1, t3]);
    expect(app.commands.isEnabled('mt.moveTrackDown')).toBe(false);
  });
});
