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
import { installMultitrackCommands } from '../src/multitrack/commands.js';
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
const cases = [8000, 16000].flatMap((rate) => ['Track', 'Time', 'Clips', 'ClipsInTime'].flatMap((scope) => ['changed', 'same', 'undone', 'unchanged'].map((action) => [rate, scope, action])));
for (const rate of [8000, 16000]) for (const scope of ['Track', 'Clips']) for (const action of ['close', 'cancel-close', 'switch', 'rename']) cases.push([rate, scope, action]);
it.each(cases)('keeps %i Hz %s bounce audio safe during %s', async (rate, scope, action) => {
  localStorage.clear(); vi.stubGlobal('Blob', NodeBlob); gate.called = false;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm')); const processor = await dsp();
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn(); installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) }); app.prefs.set('panLaw', 'balance');
  const stored = new Map(); window.puter = { ui: { showDirectoryPicker: async () => ({ path: '/u' }) }, auth: { isSignedIn: () => true }, fs: {
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(path, blob); return { path }; },
  } };
  const doc = app.addDocument(new Session({ name: 'Target.asesx', sampleRate: rate, tracks: 1, source: { type: 'puter', path: '/u/Target.asesx' } }));
  const other = app.addDocument(new AudioFile({ name: 'Other.wav', sampleRate: rate, channels: [Channel.silence(8)] }), { activate: false });
  const pcm = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 64), trackId = doc.state.tracks[0].id;
  const sourceId = doc.addSource({ name: 'Audio.wav', channels: [Channel.fromSamples(pcm)] });
  doc.apply('Audio', addClips(doc.state, [createClip({ sourceId, trackId, start: 8, length: 16 }), createClip({ sourceId, trackId, start: 24, offset: 16, length: 16 })]));
  await app.commands.run('file.save');
  if (['changed', 'same', 'undone'].includes(action)) {
    app.addDocument(new Session({ name: 'Writer.asesx', sampleRate: action === 'same' ? rate : 24000 - rate, tracks: 1, source: { type: 'puter', path: '/u/Writer.asesx' } }));
    const copying = app.commands.run('file.saveCopy'); await confirmSessionSave('Target.asesx', { replace: true }); await copying; app.activate(doc);
  }
  doc.selectClips(doc.state.clips.map((c) => c.id)); doc.setSelection(12, 28);
  const docs = app.documents.slice();
  let release; gate.wait = new Promise((resolve) => { release = resolve; });
  const pending = app.commands.run(`mt.bounce${scope}`);
  try {
    await vi.waitFor(() => expect(gate.called).toBe(true), { interval: 1 });
    if (['changed', 'same', 'undone'].includes(action)) {
      const reverting = app.commands.run('file.revert'); await vi.waitFor(() => expect(button('Revert')).toBeDefined(), { interval: 1 }); button('Revert').click(); await reverting;
      expect(doc.sampleRate).toBe(action === 'same' ? rate : 24000 - rate);
      if (action === 'undone') await app.commands.run('edit.undo');
    }
    if (action === 'rename' || action === 'cancel-close') await app.commands.run('mt.renameTrack', { id: trackId, name: 'Keep this name' });
    if (action === 'close') expect(await app.closeDocument(doc)).toBe(true);
    if (action === 'cancel-close') {
      const closing = app.closeDocument(doc);
      await vi.waitFor(() => expect(document.querySelector('button[data-value="null"]')).not.toBeNull(), { interval: 1 });
      document.querySelector('button[data-value="null"]').click(); expect(await closing).toBe(false);
    }
    if (['changed', 'close', 'switch'].includes(action)) app.activate(other);
    const before = doc.state, history = doc.history.entries.slice(), pool = doc.pool.size, active = app.active;
    doc.setSelection(0, 4); doc.selectClips([]);
    release(); await pending;
    expect(app.active).toBe(active);
    if (action === 'close') {
      expect(doc.state).toBe(before); expect(doc.history.entries).toEqual(history); expect(doc.pool.size).toBe(pool); expect(app.documents.every((d) => docs.includes(d))).toBe(true); return;
    }
    const file = app.documents.find((d) => !docs.includes(d)); expect(file.kind).toBe('audio');
    const start = scope === 'Track' ? 0 : scope === 'Clips' ? 8 : 12, end = scope === 'Track' || scope === 'Clips' ? 40 : 28;
    const expected = Float32Array.from({ length: end - start }, (_, i) => start + i < 8 ? 0 : pcm[start + i - 8]);
    expect.soft(file.sampleRate).toBe(rate); expect(file.length).toBe(expected.length);
    for (const c of file.state.channels) expect([...c.toArray()]).toEqual([...expected]);
    if (action === 'changed') {
      expect.soft(doc.state).toBe(before); expect.soft(doc.history.entries).toEqual(history); expect.soft(doc.pool.size).toBe(pool);
      expect(app.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('sample rate changed'), { error: true });
    } else expect(app.notify).not.toHaveBeenCalled();
    // Save the retained render through the real WAV writer before reinserting it.
    app.activate(file); const saving = app.commands.run('file.saveAs');
    await vi.waitFor(() => expect(document.querySelector('.io-export-dialog')).not.toBeNull(), { interval: 1 });
    const form = document.querySelector('.io-export-dialog'), name = form.querySelector('[aria-label="File name"]');
    name.value = 'Bounce.wav'; name.dispatchEvent(new Event('input', { bubbles: true }));
    [...form.querySelectorAll('button')].find((b) => b.textContent === 'Browse...').click();
    await vi.waitFor(() => expect(form.querySelector('.io-path').textContent).toBe('/u'), { interval: 1 });
    form.querySelector('.dialog-foot button[data-value="ok"]').click(); await saving;
    const wav = parseWav(await stored.get('/u/Bounce.wav').arrayBuffer()); expect(wav.sampleRate).toBe(rate);
    for (const c of wav.channels) expect([...c]).toEqual([...expected]); expect(file.dirty).toBe(false);
    app.activate(doc);
    let expectedStart = start, insertedPcm = expected;
    if (action === 'changed') {
      doc.setCursor(12); await app.commands.run('mt.insertFiles', { docs: [file] }); expectedStart = 12;
      insertedPcm = processor.resample(expected, rate, doc.sampleRate);
    }
    const clip = doc.clipSelection[0], source = doc.pool.get(clip.sourceId);
    expect(clip).toMatchObject({ start: expectedStart, length: insertedPcm.length });
    expect(doc.state.tracks.some((t) => t.id === clip.trackId)).toBe(true);
    for (const c of source.channels) expect([...c.toArray()]).toEqual([...insertedPcm]);
    for (const t of before.tracks) expect(doc.state.tracks.find((x) => x.id === t.id)).toEqual(t);
    for (const c of before.clips) expect(doc.state.clips.find((x) => x.id === c.id)).toEqual(c);
    const { graph, sources } = buildSessionGraph(doc.state, doc.pool, { clipIds: new Set([clip.id]), panLaw: { mode: 'balance' } });
    const store = new ChunkStore(); for (const [id, channels] of sources) store.put(id, 0, channels.map((c) => c.toArray()));
    const output = [new Float32Array(insertedPcm.length), new Float32Array(insertedPcm.length)]; renderBlock(graph, store, expectedStart, insertedPcm.length, output, createScratch(128));
    for (const channel of output) for (let i = 0; i < insertedPcm.length; i++) expect(channel[i]).toBeCloseTo(insertedPcm[i], 6);
    const bounced = doc.state; await app.commands.run('edit.undo'); expect(doc.state).toBe(before); await app.commands.run('edit.redo'); expect(doc.state).toBe(bounced);
    await app.commands.run('file.save');
    const manifest = JSON.parse(await stored.get('/u/Target.asesx').text()), saved = manifest.sources.find((s) => s.id === clip.sourceId);
    const savedWav = parseWav(await stored.get(`/u/${saved.file}`).arrayBuffer()); expect(savedWav.sampleRate).toBe(doc.sampleRate);
    for (const c of savedWav.channels) expect([...c]).toEqual([...insertedPcm]); expect(doc.dirty).toBe(false);
  } finally { release(); await pending; }
});
