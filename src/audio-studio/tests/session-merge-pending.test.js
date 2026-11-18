import fs from 'node:fs';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { AudioFile } from '../src/model/audio-file.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrack } from '../src/features/multitrack.js';
import { linkSource } from '../src/multitrack/insert.js';
import { Stretcher } from '../src/multitrack/stretch.js';
import { parseWav } from '../src/audio/wav.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { ChunkStore, renderBlock, createScratch } from '../src/engine/mixcore.js';
import { confirmSessionSave } from './helpers/session-save.js';
const gate = vi.hoisted(() => ({ wait: null, called: false, output: null }));
vi.mock('../src/engine/offline.js', () => ({ renderGraph: async (graph, sources, { start, end }) => {
  gate.called = true;
  await gate.wait;
  const store = new ChunkStore(); for (const [id, channels] of sources) store.put(id, 0, channels.map((c) => c.toArray()));
  const out = [new Float32Array(end - start), new Float32Array(end - start)];
  renderBlock(graph, store, start, end - start, out, createScratch(128)); gate.output = out; return out;
} }));
vi.mock('../src/export/export-worker.js?worker', async () => {
  const { WavWriter } = await import('../src/export/pcm.js');
  return { default: class {
    postMessage(message) {
      if (message.type === 'start') {
        this.job = message.job;
        queueMicrotask(() => this.onmessage({ data: { type: 'need', at: 0, n: this.job.frames } }));
      } else if (message.type === 'chunk') {
        const writer = new WavWriter({ ...this.job.options, frames: this.job.frames, markers: this.job.markers });
        writer.write(message.channels, this.job.frames);
        queueMicrotask(() => this.onmessage({ data: { type: 'done', blob: writer.finish() } }));
      }
    }
    terminate() {}
  } };
});
afterEach(() => { delete window.puter; vi.unstubAllGlobals(); document.body.replaceChildren(); });
const button = (name) => [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === name);
const actions = ['changed', 'same', 'undone', 'deleteTrack', 'deleteClip', 'mute', 'undoMute', 'source', 'undoSource', 'rename', 'hide', 'switch', 'close', 'cancel-close', 'unchanged', 'prepared', 'pendingSource', 'pendingUndoSource', 'pendingPreparedSource'];
it.each([8000, 16000].flatMap((rate) => actions.map((action) => [rate, action])))('preserves %i Hz merge inputs during %s', async (rate, action) => {
  localStorage.clear(); vi.stubGlobal('Blob', NodeBlob); gate.called = false;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm')); const processor = await dsp();
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn(); installCoreCommands(app); installMultitrack(app); app.prefs.set('panLaw', 'balance');
  const stored = new Map(); window.puter = { ui: { showDirectoryPicker: async () => ({ path: '/u' }) }, auth: { isSignedIn: () => true }, fs: {
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(path, blob); return { path }; },
  } };
  const delayed = action === 'pendingSource' || action === 'pendingUndoSource' || action === 'pendingPreparedSource';
  const raw = Float32Array.from({ length: delayed ? 64 : 32 }, (_, i) => (i + 1) / (delayed ? 128 : 64));
  const pcm = delayed ? processor.resample(raw, rate * 2, rate) : raw;
  const wave = app.addDocument(new AudioFile({ name: 'Audio.wav', sampleRate: delayed ? rate * 2 : rate, channels: [Channel.fromSamples(raw)] }));
  const doc = app.addDocument(new Session({ name: 'Target.asesx', sampleRate: rate, tracks: 1, source: { type: 'puter', path: '/u/Target.asesx' } }));
  const trackId = doc.state.tracks[0].id, sourceId = await linkSource(doc, wave);
  doc.apply('Audio', addClips(doc.state, [createClip({ sourceId, trackId, start: 8, length: 16 }), createClip({ sourceId, trackId, start: 24, offset: 16, length: 16 })]));
  await app.commands.run('file.save');
  if (['changed', 'same', 'undone'].includes(action)) {
    app.addDocument(new Session({ name: 'Writer.asesx', sampleRate: action === 'same' ? rate : 24000 - rate, tracks: 1, source: { type: 'puter', path: '/u/Writer.asesx' } }));
    const copying = app.commands.run('file.saveCopy'); await confirmSessionSave('Target.asesx', { replace: true }); await copying; app.activate(doc);
  }
  let finishPreparation;
  if ((action === 'prepared' || action === 'pendingPreparedSource')) {
    const prepared = new Promise((resolve) => { finishPreparation = resolve; });
    doc.stretcher = new Stretcher(app, doc, { render: async ({ channels }) => { await prepared; return channels.map((c) => c.map((n) => n / 2)); } });
    doc.stretcher.apply('Stretch', doc.state.clips.map((c) => c.id), { mode: 'rendered', ratio: 1, semitones: 1 });
  }
  const ids = doc.state.clips.map((c) => c.id); doc.selectClips(ids); doc.setSelection(0, 0);
  const docs = app.documents.slice(); let release; gate.wait = new Promise((resolve) => { release = resolve; });
  const pending = app.commands.run('clip.merge');
  try {
    if ((action === 'prepared' || action === 'pendingPreparedSource')) {
      expect(doc.stretcher.busy).toBe(true); expect(gate.called).toBe(false); finishPreparation();
    }
    await vi.waitFor(() => expect(gate.called).toBe(true), { interval: 1 });
    if ((action === 'prepared' || action === 'pendingPreparedSource')) expect(doc.stretcher.busy).toBe(false);
    if (['changed', 'same', 'undone'].includes(action)) {
      const reverting = app.commands.run('file.revert'); await vi.waitFor(() => expect(button('Revert')).toBeDefined(), { interval: 1 }); button('Revert').click(); await reverting;
      if (action === 'undone') await app.commands.run('edit.undo');
    }
    if (action === 'deleteTrack') await app.commands.run('mt.deleteTrack', { id: trackId });
    if (action === 'deleteClip') { doc.selectClips([ids[0]]); await app.commands.run('edit.delete'); }
    if (action === 'mute' || action === 'undoMute') { await app.commands.run('clip.mute'); if (action === 'undoMute') await app.commands.run('edit.undo'); }
    if (action === 'source' || action === 'undoSource' || delayed) {
      if (delayed) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      app.activate(wave); await app.commands.run('fx.invert'); if (action === 'undoSource' || action === 'pendingUndoSource') await app.commands.run('edit.undo');
      if (action === 'pendingSource' || action === 'pendingPreparedSource') expect(doc.pool.get(sourceId).stateRef).not.toBe(wave.state);
      else await vi.waitFor(() => expect(doc.pool.get(sourceId).stateRef).toBe(wave.state), { interval: 1 });
    }
    if (action === 'rename' || action === 'cancel-close') await app.commands.run('mt.renameTrack', { id: trackId, name: 'Keep this name' });
    if (action === 'hide') await app.commands.run('mt.hideTrack');
    if (action === 'close') expect(await app.closeDocument(doc)).toBe(true);
    if (action === 'cancel-close') {
      const closing = app.closeDocument(doc); await vi.waitFor(() => expect(document.querySelector('button[data-value="null"]')).not.toBeNull(), { interval: 1 });
      document.querySelector('button[data-value="null"]').click(); expect(await closing).toBe(false);
    }
    if (['changed', 'switch', 'close'].includes(action)) app.activate(wave);
    const before = doc.state, history = doc.history.entries.slice(), pool = doc.pool.size, active = app.active;
    doc.selectClips([]); doc.setSelection(1, 3); release(); await pending;
    expect.soft(app.active).toBe(active);
    if (action === 'close') {
      expect(doc.state).toBe(before); expect(doc.history.entries).toEqual(history); expect(doc.pool.size).toBe(pool); expect(app.documents.every((d) => docs.includes(d))).toBe(true); return;
    }
    const file = app.documents.find((d) => !docs.includes(d)); expect(file.kind).toBe('audio');
    const expected = (action === 'prepared' || action === 'pendingPreparedSource') ? pcm.map((n) => n / 2) : pcm;
    expect.soft(file.sampleRate).toBe(rate); expect(file.length).toBe(32);
    for (const c of file.state.channels) expect([...c.toArray()]).toEqual([...expected]);
    const stopped = ['changed', 'same', 'deleteTrack', 'deleteClip', 'mute', 'source', 'pendingSource', 'pendingPreparedSource'].includes(action);
    if (stopped) {
      expect.soft(doc.state).toBe(before); expect.soft(doc.history.entries).toEqual(history); expect.soft(doc.pool.size).toBe(pool);
      expect(app.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Merge stopped'), { error: true });
    } else {
      expect(app.notify).not.toHaveBeenCalled();
      const merged = doc.state.clips.find((c) => doc.pool.get(c.sourceId)?.docId === file.id); expect(merged).toMatchObject({ trackId, start: 8, offset: 0, length: 32 });
      expect(doc.state.clips.filter((c) => ids.includes(c.id))).toHaveLength(0);
      expect(doc.state.tracks).toEqual(before.tracks);
      const { graph, sources } = buildSessionGraph(doc.state, doc.pool, { panLaw: { mode: 'balance' } });
      const store = new ChunkStore(); for (const [id, channels] of sources) store.put(id, 0, channels.map((c) => c.toArray()));
      const output = [new Float32Array(32), new Float32Array(32)]; renderBlock(graph, store, 8, 32, output, createScratch(128));
      for (const channel of output) for (let i = 0; i < 32; i++) expect(channel[i]).toBeCloseTo(expected[i], 6);
      const mergedState = doc.state; app.activate(doc); await app.commands.run('edit.undo'); expect(doc.state).toBe(before); await app.commands.run('edit.redo'); expect(doc.state).toBe(mergedState);
      await app.commands.run('file.save');
      const manifest = JSON.parse(await stored.get('/u/Target.asesx').text()), saved = manifest.sources.find((s) => s.id === merged.sourceId);
      const savedWav = parseWav(await stored.get(`/u/${saved.file}`).arrayBuffer()); expect(savedWav.sampleRate).toBe(rate);
      for (const c of savedWav.channels) expect([...c]).toEqual([...expected]); expect(doc.dirty).toBe(false);
    }
    // Completed audio remains usable even when its original timeline is no longer valid.
    app.activate(file); const saving = app.commands.run('file.saveAs');
    await vi.waitFor(() => expect(document.querySelector('.io-export-dialog')).not.toBeNull(), { interval: 1 });
    const form = document.querySelector('.io-export-dialog'), name = form.querySelector('[aria-label="File name"]'); name.value = 'Merged.wav'; name.dispatchEvent(new Event('input', { bubbles: true }));
    [...form.querySelectorAll('button')].find((b) => b.textContent === 'Browse...').click(); await vi.waitFor(() => expect(form.querySelector('.io-path').textContent).toBe('/u'), { interval: 1 });
    form.querySelector('.dialog-foot button[data-value="ok"]').click(); await saving;
    const wav = parseWav(await stored.get('/u/Merged.wav').arrayBuffer()); expect(wav.sampleRate).toBe(rate);
    for (const c of wav.channels) expect([...c]).toEqual([...expected]); expect(file.dirty).toBe(false);
    if (action === 'mute' || action === 'source') {
      app.notify.mockClear(); app.activate(doc); doc.selectClips(ids); doc.setSelection(0, 0);
      await app.commands.run('clip.merge'); expect(app.notify).not.toHaveBeenCalled();
      const retry = doc.clipSelection[0], samples = action === 'mute' ? new Float32Array(32) : pcm.map((n) => -n);
      expect(doc.state.clips).toHaveLength(1); expect(retry).toMatchObject({ trackId, start: 8, length: 32 });
      for (const c of doc.pool.get(retry.sourceId).channels) expect([...c.toArray()]).toEqual([...samples]);
      const retried = doc.state; await app.commands.run('edit.undo'); expect(doc.state).toBe(before); await app.commands.run('edit.redo'); expect(doc.state).toBe(retried);
      await app.commands.run('file.save');
      const manifest = JSON.parse(await stored.get('/u/Target.asesx').text()), saved = manifest.sources.find((s) => s.id === retry.sourceId);
      const retryWav = parseWav(await stored.get(`/u/${saved.file}`).arrayBuffer()); expect(retryWav.sampleRate).toBe(rate);
      for (const c of retryWav.channels) expect([...c]).toEqual([...samples]); expect(doc.dirty).toBe(false);
    }
  } finally { finishPreparation?.(); release(); await pending; if (delayed) { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); } }
});
