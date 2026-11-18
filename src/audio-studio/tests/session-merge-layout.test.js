import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { addClips, createClip, updateClips, moveClips, duplicateTrack } from '../src/model/session-edits.js';
import { serializeSession, parseSession } from '../src/model/session-io.js';
import { ChunkStore, renderBlock, createScratch } from '../src/engine/mixcore.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
function render(graph, sources, { start = 0, end = 64 } = {}) {
  const store = new ChunkStore(); for (const [id, channels] of sources) store.put(id, 0, channels.map((c) => c.toArray()));
  const out = [new Float32Array(end - start), new Float32Array(end - start)]; renderBlock(graph, store, start, end - start, out, createScratch(128)); return out;
}
vi.mock('../src/engine/offline.js', () => ({ renderGraph: async (graph, sources, options) => render(graph, sources, options) }));
afterEach(() => document.body.replaceChildren());
function setup(autoCrossfade, shapes, rate = 8000) {
  localStorage.clear();
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn(); installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) }); app.prefs.set('panLaw', 'balance');
  const doc = app.addDocument(new Session({ sampleRate: rate, tracks: 1, autoCrossfade }));
  const trackId = doc.state.tracks[0].id;
  const clips = shapes.map((shape, index) => {
    const pcm = Float32Array.from({ length: 64 }, (_, i) => (index % 2 ? -1 : 1) * (i + 1) / (128 * (index + 1)));
    const sourceId = doc.addSource({ channels: [Channel.fromSamples(pcm)] });
    return createClip({ sourceId, trackId, ...shape });
  });
  doc.apply('Audio', addClips(doc.state, clips));
  const read = (state = doc.state, clipIds = null) => { const { graph, sources } = buildSessionGraph(state, doc.pool, { panLaw: { mode: 'balance' }, clipIds }); return render(graph, sources); };
  const merge = async (ids = clips.slice(0, 2).map((c) => c.id)) => { doc.selectClips(ids); await app.commands.run('clip.merge'); expect(app.notify).not.toHaveBeenCalled(); return doc.clipSelection[0]; };
  return { app, doc, clips, read, merge };
}
function sameAudio(actual, expected) {
  for (let c = 0; c < 2; c++) for (let i = 0; i < 64; i++) expect(actual[c][i], `channel ${c}, frame ${i}`).toBeCloseTo(expected[c][i], 6);
}
const shapes = {
  behind: [{ length: 16 }, { start: 16, length: 16 }, { start: 8, length: 8, z: 10 }],
  straddled: [{ length: 16 }, { start: 16, length: 16, z: 20 }, { start: 8, length: 8, z: 10 }],
  crossfade: [{ length: 16 }, { start: 16, length: 16 }, { start: 8, length: 16, z: 10 }],
  gap: [{ length: 8 }, { start: 24, length: 8, z: 20 }, { start: 12, length: 8, z: 10 }],
  tied: [{ length: 24, fadeOut: { curve: 1 } }, { start: 8, length: 24, fadeIn: { curve: -1 } }, { start: 8, length: 24, fadeIn: { curve: 0.5 } }],
  multiple: [{ length: 16 }, { start: 24, length: 16, z: 20 }, { start: 8, length: 24, z: 10 }, { start: 12, length: 24, z: -10 }],
  muted: [{ length: 16, mute: true }, { start: 16, length: 16, z: 20, mute: true }, { start: 8, length: 16, z: 10 }],
};
it.each([8000, 16000].flatMap((rate) => [false, true].flatMap((auto) => Object.keys(shapes).map((name) => [rate, auto, name]))))(
  'preserves %i Hz merge playback and saved overlaps (auto %s, %s)', async (rate, auto, name) => {
    const { app, doc, clips, read, merge } = setup(auto, shapes[name], rate);
    const before = doc.state, audio = read();
    const merged = await merge();
    expect(doc.state.clips).toHaveLength(clips.length - 1); expect(merged.sourceId).not.toBe(clips[0].sourceId);
    sameAudio(read(), audio);
    const after = doc.state;
    await app.commands.run('edit.undo'); expect(doc.state).toBe(before); sameAudio(read(), audio);
    await app.commands.run('edit.redo'); expect(doc.state).toBe(after); sameAudio(read(), audio);
    const saved = serializeSession(doc), opened = parseSession(saved.text);
    const savedPool = new Map(saved.media.map((m) => [m.id, { channels: m.channels }]));
    const savedGraph = buildSessionGraph(opened.state, savedPool, { panLaw: { mode: 'balance' } });
    sameAudio(render(savedGraph.graph, savedGraph.sources), audio);
    // The saved render contains only selected audio, not the neighbors' media.
    const selectedAudio = read(before, new Set(clips.slice(0, 2).map((c) => c.id)));
    const data = doc.pool.get(merged.sourceId).channels.map((c) => c.toArray());
    for (let c = 0; c < 2; c++) for (let i = 0; i < merged.length; i++) expect(data[c][i]).toBeCloseTo(selectedAudio[c][merged.start + i], 6);
  });
it.each([false, true].flatMap((auto) => ['gain', 'source', 'rename', 'moveOwner', 'moveNeighbor', 'deleteOwner', 'muteOwner', 'repeat', 'mergeNeighbor', 'newCover'].map((action) => [auto, action])))(
  'keeps neighbors editable after merge (auto %s, %s)', async (auto, action) => {
    const { app, doc, clips, read, merge } = setup(auto, shapes.multiple);
    const before = doc.state; const merged = await merge();
    if (action === 'gain' || action === 'source' || action === 'rename') {
      const patch = action === 'gain' ? { gain: -12 } : action === 'source' ? { sourceId: clips[3].sourceId } : { name: 'Renamed' };
      doc.apply('Edit neighbor', updateClips(doc.state, [clips[2].id], patch));
      sameAudio(read(), read(updateClips(before, [clips[2].id], patch)));
    } else if (action === 'repeat' || action === 'mergeNeighbor') {
      const audio = read();
      if (action === 'repeat') {
        const extra = createClip({ ...clips[0], id: 'extra', start: 48, length: 8 });
        doc.apply('Add clip', addClips(doc.state, [extra]));
        const withExtra = read(); await merge([merged.id, extra.id]); sameAudio(read(), withExtra);
      } else { await merge([merged.id, clips[2].id]); sameAudio(read(), audio); }
      sameAudio(read(parseSession(serializeSession(doc).text).state), read());
    } else if (action === 'newCover') {
      const audio = read();
      const extra = createClip({ ...clips[0], id: 'extra', start: 4, length: 4, z: 100, fadeIn: { xf: false }, fadeOut: { xf: false } });
      doc.apply('Add clip', addClips(doc.state, [extra]));
      const only = read(doc.state, new Set([extra.id]));
      for (let c = 0; c < 2; c++) audio[c].set(only[c].subarray(4, 8), 4);
      sameAudio(read(), audio);
    } else {
      doc.selectClips([action === 'moveNeighbor' ? clips[2].id : merged.id]);
      if (action === 'deleteOwner') await app.commands.run('edit.delete');
      else if (action === 'muteOwner') await app.commands.run('clip.mute');
      else doc.apply('Move', updateClips(doc.state, [action === 'moveNeighbor' ? clips[2].id : merged.id], { start: 48 }));
      if (action !== 'moveNeighbor') sameAudio(read(), read({ ...doc.state, clips: doc.state.clips.map((c) => ({ ...c, mergeLayout: null })) }));
      else expect(read().every((c) => c.every(Number.isFinite))).toBe(true);
    }
  });

// Several overlapping layers, equal z values and merges of earlier merges.
it.each([...[...Array.from({ length: 64 }, (_, i) => i + 1), 244, 544].map((seed) => [seed, false]),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 244, 544].map((seed) => [seed, true]),
])('preserves successive merges of overlap arrangement %i (split %s)', async (seed, split) => {
  let n = seed;
  const random = (max) => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n % max; };
  const shapes = Array.from({ length: 6 }, () => ({ start: random(7) * 4, length: (random(6) + 1) * 4,
    z: random(3), gain: -random(6), fadeIn: { length: random(3), curve: random(3) / 2 - 0.5 },
    fadeOut: { length: random(3), curve: random(3) / 2 - 0.5 } }));
  const { app, doc, read, merge } = setup(seed % 2 === 0, shapes);
  for (const pair of [[0, 2], [1, 3], [0, 2], [0, 1]]) {
    const audio = read();
    const merged = await merge(pair.map((index) => doc.state.clips[index].id));
    sameAudio(read(), audio);
    if (split) {
      doc.setCursor(merged.start + Math.floor(merged.length / 2));
      await app.commands.run('clip.split');
      sameAudio(read(), audio);
    }
    sameAudio(read(parseSession(serializeSession(doc).text).state), audio);
  }
});
it('keeps the real fade menu usable for a merged clip’s unselected crossfade partner', async () => {
  const { app, doc, clips, read, merge } = setup(true, shapes.crossfade);
  await merge();
  doc.selectClips([clips[2].id]);
  const checked = (id) => app.commands.get(id).checked(app);
  expect(checked('clip.fadeInCrossfade')).toBe(true);
  expect(checked('clip.fadeInLinear')).toBe(true);
  const linear = read();
  await app.commands.run('clip.fadeInCosine');
  expect(checked('clip.fadeInCosine')).toBe(true);
  expect([...read()[0]]).not.toEqual([...linear[0]]);
  await app.commands.run('clip.fadeInNone');
  expect(checked('clip.fadeInNone')).toBe(true);
  expect(app.commands.get('clip.fadeInCrossfade').enabled(app)).toBe(true);
  await app.commands.run('clip.fadeInCrossfade');
  expect(checked('clip.fadeInCrossfade')).toBe(true);
  sameAudio(read(parseSession(serializeSession(doc).text).state), read());
});

it.each(['duplicateTrack', 'moveTogether', 'copyTogether', 'clipboard', 'uniqueCopy'])('preserves merged overlaps through %s', async (action) => {
  const { app, doc, read, merge } = setup(true, shapes.crossfade);
  const merged = await merge();
  const audio = read();
  if (action === 'duplicateTrack') {
    doc.apply('Duplicate Track', duplicateTrack(doc.state, doc.state.tracks[0].id));
    sameAudio(read(), audio.map((c) => c.map((v) => v * 2)));
  } else if (action === 'moveTogether' || action === 'copyTogether') {
    const copy = action === 'copyTogether';
    doc.apply('Move', moveClips(doc.state, doc.state.clips.map((c) => c.id), 32, 0, { copy }));
    const expected = audio.map((c) => { const a = copy ? c.slice() : new Float32Array(64); a.set(c.subarray(0, 32), 32); return a; });
    sameAudio(read(), expected);
  } else if (action === 'clipboard') {
    doc.selectClips(doc.state.clips.map((c) => c.id));
    await app.commands.run('edit.copy');
    const destination = app.addDocument(new Session({ sampleRate: 8000, tracks: 1 }));
    await app.commands.run('edit.paste');
    const { graph, sources } = buildSessionGraph(destination.state, destination.pool, { panLaw: { mode: 'balance' } });
    sameAudio(render(graph, sources), audio);
  } else {
    doc.selectClips([merged.id]); await app.commands.run('clip.uniqueCopy');
    sameAudio(read(), audio);
  }
});

it('retains a muted merged arrangement across an unrelated later merge', async () => {
  const { app, doc, clips, read, merge } = setup(true, shapes.crossfade);
  const merged = await merge(); const audio = read();
  await app.commands.run('clip.mute');
  const far = [80, 88].map((start, i) => createClip({ ...clips[0], id: `far${i}`, start, length: 8 }));
  doc.apply('Add clips', addClips(doc.state, far));
  await merge(far.map((c) => c.id));
  doc.selectClips([merged.id]); await app.commands.run('clip.mute');
  sameAudio(read(), audio);
});
it.each([false, true].flatMap((auto) => [4, 12, 16, 20, 28].map((at) => [auto, at])))('keeps a split merged clip audible (auto %s, at %i)', async (auto, at) => {
  const { app, doc, read, merge } = setup(auto, shapes.crossfade);
  await merge(); const audio = read();
  doc.setCursor(at); await app.commands.run('clip.split');
  sameAudio(read(), audio);
});
it.each([false, true].flatMap((auto) => ['remergeLeft', 'remergeRight', 'remergeBoth', 'copyTrack'].map((action) => [auto, action])))(
  'preserves split merge pieces through %s / %s', async (auto, action) => {
    const { app, doc, read, merge } = setup(auto, shapes.multiple);
    const merged = await merge(); const original = read();
    doc.setCursor(12); await app.commands.run('clip.split'); sameAudio(read(), original);
    const left = doc.state.clips.find((c) => c.id === merged.id);
    const right = doc.state.clips.find((c) => c.sourceId === merged.sourceId && c.id !== left.id);
    if (action === 'copyTrack') {
      doc.apply('Duplicate Track', duplicateTrack(doc.state, merged.trackId));
      sameAudio(read(), original.map((c) => c.map((v) => v * 2)));
    } else {
      const extra = createClip({ ...left, id: 'extra', start: 48, length: 8, mergeLayout: null });
      doc.apply('Add clip', addClips(doc.state, [extra])); const audio = read();
      await merge(action === 'remergeBoth' ? [left.id, right.id] : [action === 'remergeLeft' ? left.id : right.id, extra.id]);
      sameAudio(read(), audio);
    }
    sameAudio(read(parseSession(serializeSession(doc).text).state), read());
  });
it.each(['delete', 'mute'])('a split merged piece stops masking neighboring audio after %s', async (action) => {
  const arrangement = [{ length: 16, z: 10 }, { start: 16, length: 16, z: 20 }, { start: 8, length: 16 }];
  const { app, doc, clips, read, merge } = setup(false, arrangement);
  const merged = await merge(), audio = read();
  doc.setCursor(12); await app.commands.run('clip.split'); sameAudio(read(), audio);
  doc.selectClips([merged.id]); await app.commands.run(action === 'delete' ? 'edit.delete' : 'clip.mute');
  const cover = read({ ...doc.state, clips: [clips[2]] });
  for (let c = 0; c < 2; c++) audio[c].set(cover[c].subarray(0, 12), 0);
  sameAudio(read(), audio);
});
it.each([4, 12, 16, 20, 28])('splitting an unselected neighbor preserves hard layers at %i', async (at) => {
  const arrangement = [{ length: 16 }, { start: 16, length: 16, z: 20 }, { start: 0, length: 32, z: 10 }];
  const { app, doc, clips, read, merge } = setup(false, arrangement);
  await merge(); const audio = read();
  doc.selectClips([clips[2].id]); doc.setCursor(at); await app.commands.run('clip.split');
  sameAudio(read(), audio);
});
