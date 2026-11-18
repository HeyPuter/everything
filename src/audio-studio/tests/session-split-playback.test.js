import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { addClips, createClip, setFade, updateClips } from '../src/model/session-edits.js';
import { serializeSession, parseSession } from '../src/model/session-io.js';
import { ChunkStore, renderBlock, createScratch } from '../src/engine/mixcore.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import { TrackControls } from '../src/multitrack/track-controls.js';
import { MultitrackView } from '../src/editor/multitrack-view.js';
const gate = vi.hoisted(() => ({ wait: null, called: false }));
vi.mock('../src/engine/offline.js', () => ({ renderGraph: async (graph, sources, { start, end }) => {
  gate.called = true; await gate.wait;
  const store = new ChunkStore(); for (const [id, channels] of sources) store.put(id, 0, channels.map((c) => c.toArray()));
  const out = Array.from({ length: graph.surround ? 6 : 2 }, () => new Float32Array(end - start));
  renderBlock(graph, store, start, end - start, out, createScratch(128)); return out;
} }));
afterEach(() => { gate.wait = null; gate.called = false; vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function setup({ rate = 8000, channels = 2, kind = 'fadeIn', curve = 2 } = {}) {
  localStorage.clear();
  const app = new App(); app.syncGraph = vi.fn(); installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) }); app.prefs.set('panLaw', 'balance');
  const doc = app.addDocument(new Session({ sampleRate: rate, tracks: 1, masterChannels: channels, autoCrossfade: false }));
  const trackId = doc.state.tracks[0].id;
  doc.apply('Track channels', { ...doc.state, tracks: doc.state.tracks.map((t) => ({ ...t, channels })) });
  const sourceId = doc.addSource({ channels: Array.from({ length: channels }, (_, c) => Channel.fromSamples(Float32Array.from({ length: kind === 'loopFade' ? 16 : 64 }, (_, i) => (i + 1) / (128 * (c + 1))))) });
  const fades = { fadeIn: { length: ['fadeIn', 'bothFades', 'loopFade'].includes(kind) ? 24 : 0, curve }, fadeOut: { length: ['fadeOut', 'bothFades'].includes(kind) ? 24 : 0, curve } };
  const first = createClip({ trackId, sourceId, start: 0, offset: 4, length: 32, loop: kind === 'loopFade', ...fades });
  const second = createClip({ trackId, sourceId, start: 16, length: 32, gain: -6 });
  doc.apply('Audio', addClips(doc.state, kind === 'overlapNoFade' ? [first, second] : [first]));
  const read = (state = doc.state) => {
    const { graph, sources } = buildSessionGraph(state, doc.pool, { panLaw: { mode: 'balance' } });
    const store = new ChunkStore(); for (const [id, channels] of sources) store.put(id, 0, channels.map((c) => c.toArray()));
    const out = Array.from({ length: channels }, () => new Float32Array(64)); renderBlock(graph, store, 0, 64, out, createScratch(128)); return out;
  };
  const split = async (at, ids = [first.id]) => { doc.selectClips(ids); doc.setCursor(at); await app.commands.run('clip.split'); };
  return { app, doc, first, read, split };
}
function sameAudio(actual, expected) {
  for (let c = 0; c < expected.length; c++) for (let i = 0; i < 64; i++) expect(actual[c][i], `channel ${c}, frame ${i}`).toBeCloseTo(expected[c][i], 6);
}
const kinds = ['plain', 'fadeIn', 'fadeOut', 'bothFades', 'loopFade', 'overlapNoFade'];
const cases = [8000, 16000].flatMap((rate) => [2, 6].flatMap((channels) => kinds.flatMap((kind) => [0, 2, -0.5, 0.5].flatMap((curve) => [8, 16, 24].map((at) => [rate, channels, kind, curve, at])))));
it.each(cases)('preserves %i Hz / %i channel %s playback when splitting curve %s at %i', async (rate, channels, kind, curve, at) => {
  const { app, doc, read, split } = setup({ rate, channels, kind, curve });
  const before = doc.state, audio = read(); await split(at);
  expect(doc.state.clips).toHaveLength(kind === 'overlapNoFade' ? 3 : 2);
  sameAudio(read(), audio);
  const after = doc.state;
  await app.commands.run('edit.undo'); expect(doc.state).toBe(before); sameAudio(read(), audio);
  await app.commands.run('edit.redo'); expect(doc.state).toBe(after);
  sameAudio(read(parseSession(serializeSession(doc).text).state), audio);
  await split(at / 2, doc.state.clips.map((c) => c.id));
  await split(at + (32 - at) / 2, doc.state.clips.map((c) => c.id));
  sameAudio(read(), audio);
});
it.each(['curve', 'none', 'properties', 'move', 'copy', 'delete', 'envelopes'])(
  'keeps split fade pieces editable through %s', async (action) => {
    const { app, doc, first, read, split } = setup();
    if (action === 'envelopes') doc.apply('Automation', updateClips(doc.state, [first.id], {
      volumeEnv: [{ t: 0, v: 0 }, { t: 8, v: 0 }, { t: 16, v: -6 }, { t: 24, v: -6 }, { t: 32, v: -3 }],
      panEnv: [{ t: 0, v: -40 }, { t: 32, v: 40 }],
    }));
    const audio = read(); await split(16); sameAudio(read(), audio);
    const right = doc.state.clips.find((c) => c.id !== first.id); doc.selectClips([right.id]);
    if (action === 'curve') await app.commands.run('clip.fadeInLinear');
    if (action === 'none') await app.commands.run('clip.fadeInNone');
    if (action === 'properties') doc.apply('Fade In', setFade(doc.state, [right.id], 'in', { length: 4, curve: 0.5 }));
    if (['curve', 'none', 'properties'].includes(action)) {
      const changed = doc.state.clips.find((c) => c.id === right.id);
      expect(changed.fadeIn).not.toHaveProperty('duration'); expect(changed.fadeIn).not.toHaveProperty('offset');
      const ordinary = { ...doc.state, clips: doc.state.clips.map((c) => c.id === right.id ? createClip({ ...c, fadeIn: { length: changed.fadeIn.length, curve: changed.fadeIn.curve } }) : c) };
      sameAudio(read(), read(ordinary));
    }
    if (action === 'delete') {
      await app.commands.run('edit.delete'); const expected = audio.map((c) => { const a = c.slice(); a.fill(0, 16); return a; });
      sameAudio(read(), expected);
    }
    if (action === 'move' || action === 'copy') {
      if (action === 'copy') await app.commands.run('edit.copy'); else await app.commands.run('edit.cut');
      doc.setCursor(40); await app.commands.run('edit.paste');
      const expected = audio.map((c) => { const a = c.slice(); if (action === 'move') a.fill(0, 16); a.set(c.subarray(16, 32), 40); return a; });
      sameAudio(read(), expected);
    }
  });
it('draws the same fade progress on both sides of a split', async () => {
  const { app, doc, split } = setup(); await split(16);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  doc.controls = new TrackControls(app, doc);
  const view = new MultitrackView(app, doc);
  try {
    document.body.replaceChildren(view.el); view.width = 640; view.height = 400; view.computeRows(); doc.setView(0, 64);
    app.prefs.set('clipVolumeEnvelopes', false); app.prefs.set('clipPanEnvelopes', false);
    let path = []; const curves = [];
    const context = new Proxy({
      beginPath: () => { path = []; }, moveTo: (x, y) => path.push([x, y]), lineTo: (x, y) => path.push([x, y]),
      stroke: () => { if (path.length === 33) curves.push(path.slice()); },
      measureText: () => ({ width: 0 }),
    }, { get: (obj, key) => obj[key] || (() => {}), set: (obj, key, value) => { obj[key] = value; return true; } });
    view.overlay.getContext = () => context;
    for (const key of Object.keys(view.dirty)) view.dirty[key] = key === 'overlay';
    view.frame(); expect(curves).toHaveLength(2);
    const rects = view.clipRects(doc.state), gain = (point, rect) => (rect.wy + rect.wh - point[1]) / rect.wh;
    expect(gain(curves[0][0], rects[0])).toBeCloseTo(0, 6);
    expect(gain(curves[0][32], rects[0])).toBeCloseTo(0.75, 6);
    expect(gain(curves[1][0], rects[1])).toBeCloseTo(0.75, 6);
    expect(gain(curves[1][32], rects[1])).toBeCloseTo(1, 6);
  } finally { view.destroy(); }
});

it('rejects a merge when an overlap change restores a different fade phase', async () => {
  const { app, doc, first, read, split } = setup(); await split(16);
  const right = doc.state.clips.find((c) => c.id !== first.id);
  const cover = createClip({ ...first, id: 'cover', start: 8, length: 16, fadeIn: { length: 0 }, fadeOut: { length: 0 } });
  const far = createClip({ ...first, id: 'far', start: 48, length: 8, fadeIn: { length: 0 }, fadeOut: { length: 0 } });
  doc.apply('Overlap', { ...addClips(doc.state, [cover, far]), autoCrossfade: true });
  doc.selectClips([right.id, far.id]); app.notify = vi.fn();
  let release; gate.wait = new Promise((resolve) => { release = resolve; });
  const pending = app.commands.run('clip.merge');
  try {
    await vi.waitFor(() => expect(gate.called).toBe(true), { interval: 1 });
    doc.selectClips([cover.id]); await app.commands.run('clip.mute');
    const before = doc.state, audio = read(), history = doc.history.entries.slice();
    release(); await pending;
    expect(doc.state).toBe(before); expect(doc.history.entries).toEqual(history);
    sameAudio(read(), audio);
    expect(app.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Merge stopped'), { error: true });
    expect(app.documents.filter((d) => d.kind === 'audio')).toHaveLength(1);
  } finally { release(); await pending; }
});
it.each(['in', 'out'].flatMap((dir) => [false, true].map((xf) => [dir, xf])))(
  'retains an explicit %s crossfade setting (%s) at the unchanged outer edge', async (dir, xf) => {
    const { app, doc, first, read, split } = setup({ kind: 'plain', curve: 0 });
    const second = createClip({ ...first, id: 'second', start: 16, offset: 0, length: 32, gain: -6 });
    const id = dir === 'in' ? second.id : first.id, key = dir === 'in' ? 'fadeIn' : 'fadeOut';
    doc.apply('Crossfade', { ...updateClips(addClips(doc.state, [second]), [id], { [key]: { length: 0, curve: 0, xf } }), autoCrossfade: !xf });
    const audio = read(); await split(dir === 'in' ? 40 : 8, [id]);
    sameAudio(read(), audio);
  });
