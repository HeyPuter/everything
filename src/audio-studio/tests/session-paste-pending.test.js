import fs from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { placementOptions } from '../src/multitrack/insert.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { parseWav } from '../src/audio/wav.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import { ChunkStore, renderBlock, createScratch } from '../src/engine/mixcore.js';
import { confirmSessionSave } from './helpers/session-save.js';
const gate = vi.hoisted(() => ({ wait: null, calls: 0 }));
vi.mock('../src/audio/dsp.js', async (original) => {
  const actual = await original();
  return { ...actual, dsp: async () => { gate.calls++; if (gate.wait) await gate.wait; return actual.dsp(); } };
});
let processor, options;
beforeEach(async () => {
  localStorage.clear(); vi.stubGlobal('Blob', NodeBlob); gate.wait = null;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm')); processor = await dsp(); gate.calls = 0;
  options = { ...placementOptions }; placementOptions.avoidOverlap = false;
});
afterEach(() => { Object.assign(placementOptions, options); delete window.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });
const button = (name) => [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === name);
const actions = ['rename', 'move', 'hide', 'delete', 'overlap', 'front', 'switch', 'close', 'cancel-close', 'unchanged', 'rate', 'same-revert', 'undone', 'master'];
it.each([8000, 16000].flatMap((rate) => actions.map((action) => [rate, action])))('preserves %i Hz session state during waveform Paste: %s', async (rate, action) => {
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn(); installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const stored = new Map();
  window.puter = { auth: { isSignedIn: () => true }, fs: {
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(path, blob); return { path }; },
  } };
  const doc = app.addDocument(new Session({ name: 'Target.asesx', sampleRate: rate, tracks: 2, source: { type: 'puter', path: '/u/Target.asesx' } }));
  const other = app.addDocument(new AudioFile({ name: 'Other.wav', sampleRate: rate, channels: [Channel.silence(8)] }), { activate: false });
  if (['rate', 'same-revert', 'undone'].includes(action)) {
    await app.commands.run('file.save');
    app.addDocument(new Session({ name: 'Writer.asesx', sampleRate: action === 'same-revert' ? rate : 24000 - rate, tracks: 1, source: { type: 'puter', path: '/u/Writer.asesx' } }));
    const copying = app.commands.run('file.saveCopy'); await confirmSessionSave('Target.asesx', { replace: true }); await copying; app.activate(doc);
  }
  const originalTrack = doc.state.tracks[0].id; doc.selectTrack(action === 'master' ? doc.state.master.id : originalTrack); doc.setCursor(8);
  const pcm = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 64), sourceRate = 24000 - rate;
  const clipboard = { type: 'audio', sampleRate: sourceRate, channels: [Channel.fromSamples(pcm)] }; app.clipboard = clipboard;
  placementOptions.avoidOverlap = action === 'overlap';
  let release; gate.wait = new Promise((resolve) => { release = resolve; });
  const pending = app.commands.run('edit.paste');
  try {
    await vi.waitFor(() => expect(gate.calls).toBeGreaterThan(0), { interval: 1 });
    if (action === 'rename' || action === 'cancel-close') await app.commands.run('mt.renameTrack', { id: originalTrack, name: 'Keep this name' });
    if (action === 'move') await app.commands.run('mt.moveTrackDown');
    if (action === 'hide') await app.commands.run('mt.hideTrack');
    if (action === 'delete') await app.commands.run('mt.deleteTrack', { id: originalTrack });
    if (action === 'overlap' || action === 'front') await app.commands.run('mt.insertFiles', { docs: [other] });
    if (action === 'close') expect(await app.closeDocument(doc)).toBe(true);
    if (action === 'cancel-close') {
      const closing = app.closeDocument(doc);
      await vi.waitFor(() => expect(document.querySelector('button[data-value="null"]')).not.toBeNull(), { interval: 1 });
      document.querySelector('button[data-value="null"]').click(); expect(await closing).toBe(false);
    }
    if (['rate', 'same-revert', 'undone'].includes(action)) {
      const reverting = app.commands.run('file.revert'); await vi.waitFor(() => expect(button('Revert')).toBeDefined(), { interval: 1 }); button('Revert').click(); await reverting;
      if (action === 'undone') await app.commands.run('edit.undo');
    }
    if (action === 'switch' || action === 'close' || action === 'rate') app.activate(other);
    const active = app.active, before = doc.state, history = doc.history.entries.slice(), docs = app.documents.slice(), poolSize = doc.pool.size;
    // A later clipboard/cursor/selection change must not redirect the pending Paste.
    app.clipboard = { type: 'audio', sampleRate: rate, channels: [Channel.silence(3)] }; doc.setCursor(96); doc.selectTrack(doc.state.tracks.at(-1).id);
    release(); await pending; gate.wait = null;
    expect.soft(app.active).toBe(active);
    if (action === 'close' || action === 'rate') {
      expect.soft(doc.state).toBe(before); expect.soft(doc.history.entries).toEqual(history); expect.soft(doc.pool.size).toBe(poolSize); expect.soft(app.documents).toEqual(docs);
      if (action === 'close') return;
      expect(app.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('sample rate changed'), { error: true });
      app.activate(doc); doc.setCursor(8); app.clipboard = clipboard; await app.commands.run('edit.paste');
    } else expect(app.notify).not.toHaveBeenCalled();
    const pasted = doc.clipSelection[0], expected = sourceRate === doc.sampleRate ? pcm : processor.resample(pcm, sourceRate, doc.sampleRate);
    const source = doc.pool.get(pasted.sourceId), file = app.documents.find((d) => d.id === source.docId);
    expect(pasted).toMatchObject({ start: 8, length: expected.length, offset: 0 });
    expect([...source.channels[0].toArray()]).toEqual([...expected]); expect(file.sampleRate).toBe(doc.sampleRate);
    expect.soft(doc.state.tracks.filter((t) => before.tracks.some((b) => b.id === t.id))).toEqual(before.tracks);
    for (const c of before.clips) expect.soft(doc.state.clips.find((x) => x.id === c.id)).toEqual(c);
    if (['rename', 'move', 'switch', 'unchanged', 'cancel-close', 'undone', 'master'].includes(action)) expect.soft(pasted.trackId).toBe(originalTrack);
    if (action === 'hide' || action === 'delete') expect.soft(pasted.trackId).not.toBe(originalTrack);
    if (action === 'overlap') expect.soft(pasted.trackId).not.toBe(before.clips[0].trackId);
    if (action === 'front') { expect.soft(pasted.trackId).toBe(before.clips[0].trackId); expect.soft(pasted.z).toBeGreaterThan(before.clips[0].z); }
    const { graph, sources } = buildSessionGraph(doc.state, doc.pool, { panLaw: { mode: 'balance' } });
    const store = new ChunkStore(); for (const [id, channels] of sources) store.put(id, 0, channels.map((c) => c.toArray()));
    const end = 8 + expected.length, output = [new Float32Array(end), new Float32Array(end)]; renderBlock(graph, store, 0, end, output, createScratch(128));
    for (const channel of output) for (let i = 0; i < end; i++) expect(channel[i]).toBeCloseTo(i < 8 ? 0 : expected[i - 8], 6);
    const pastedState = doc.state; app.activate(doc); await app.commands.run('edit.undo'); expect(doc.state).toBe(before); await app.commands.run('edit.redo'); expect(doc.state).toBe(pastedState);
    await app.commands.run('file.save');
    const manifest = JSON.parse(await stored.get('/u/Target.asesx').text()), savedSource = manifest.sources.find((s) => s.id === pasted.sourceId);
    const wav = parseWav(await stored.get(`/u/${savedSource.file}`).arrayBuffer());
    expect(wav.sampleRate).toBe(doc.sampleRate); expect([...wav.channels[0]]).toEqual([...expected]); expect(doc.dirty).toBe(false);
  } finally { release(); await pending; gate.wait = null; }
});
