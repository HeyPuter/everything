import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { createMarker } from '../src/model/markers.js';
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
const cases = [8000, 16000].flatMap((rate) => ['All', 'Time', 'Clips'].flatMap((scope) => ['changed', 'same', 'undone', 'unchanged'].map((action) => [rate, scope, action])));
for (const rate of [8000, 16000]) {
  for (const scope of ['All', 'Time', 'Clips']) cases.push([rate, scope, 'changed', true]);
  for (const action of ['markers', 'preference', 'disabled']) cases.push([rate, 'All', action]);
}
it.each(cases.map(([rate, scope, action, exporting = false]) => [rate, scope, action, exporting]))('keeps the %i Hz %s mixdown snapshot during %s (export %s)', async (rate, scope, action, exporting) => {
  localStorage.clear(); vi.stubGlobal('Blob', NodeBlob); gate.called = false;
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn(); installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  app.prefs.set('panLaw', 'balance'); app.prefs.set('markersInMixdowns', action !== 'disabled');
  const stored = new Map(); window.puter = { ui: { showDirectoryPicker: async () => ({ path: '/u' }) }, auth: { isSignedIn: () => true }, fs: {
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(path, blob); return { path }; },
  } };
  const doc = app.addDocument(new Session({ name: 'Target.asesx', sampleRate: rate, masterChannels: rate === 8000 ? 2 : 1, tracks: 1, source: { type: 'puter', path: '/u/Target.asesx' } }));
  const pcm = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 64);
  const sourceId = doc.addSource({ name: 'Audio.wav', channels: [Channel.fromSamples(pcm)] });
  const clips = [createClip({ sourceId, trackId: doc.state.tracks[0].id, length: 8 }), createClip({ sourceId, trackId: doc.state.tracks[0].id, start: 8, offset: 8, length: 24 })];
  doc.apply('Audio', { ...addClips(doc.state, clips), markers: [createMarker({ name: 'Original cue', start: 12 }), createMarker({ name: 'Original range', start: 18, duration: 8 })] });
  const original = doc.state;
  await app.commands.run('file.save');
  app.addDocument(new Session({ name: 'Writer.asesx', sampleRate: action === 'same' ? rate : 24000 - rate, masterChannels: rate === 8000 ? 1 : 2, tracks: 1, source: { type: 'puter', path: '/u/Writer.asesx' } }));
  const copying = app.commands.run('file.saveCopy'); await confirmSessionSave('Target.asesx', { replace: true }); await copying; app.activate(doc);
  doc.setSelection(8, 24); doc.selectClips([clips[1].id]);
  let release; gate.wait = new Promise(resolve => { release = resolve; });
  // The export dialog comes first; the render of the snapshot taken when the command ran follows OK.
  const fillAndSave = async () => {
    await vi.waitFor(() => expect(document.querySelector('.io-export-dialog')).not.toBeNull(), { interval: 1 });
    const form = document.querySelector('.io-export-dialog');
    const name = form.querySelector('[aria-label="File name"]'); name.value = 'Mix.wav'; name.dispatchEvent(new Event('input', { bubbles: true }));
    [...form.querySelectorAll('button')].find((b) => b.textContent === 'Browse...').click();
    await vi.waitFor(() => expect(form.querySelector('.io-path').textContent).toBe('/u'), { interval: 1 });
    form.querySelector('.dialog-foot button[data-value="ok"]').click();
  };
  const mixing = app.commands.run(exporting ? `export.mixdown${scope === 'All' ? 'Session' : scope}` : `mt.mixdown${scope}`);
  if (exporting) await fillAndSave();
  try {
    await vi.waitFor(() => expect(gate.called).toBe(true), { interval: 1 });
    if (['changed', 'same', 'undone'].includes(action)) {
      const reverting = app.commands.run('file.revert'); await vi.waitFor(() => expect(button('Revert')).toBeDefined(), { interval: 1 }); button('Revert').click(); await reverting;
      expect(doc.sampleRate).toBe(action === 'same' ? rate : 24000 - rate);
      if (action === 'undone') await app.commands.run('edit.undo');
    }
    if (action === 'markers') await app.commands.run('marker.deleteAll');
    // Later selections and preferences must not change the already-running job.
    doc.setSelection(0, 4); doc.selectClips([]);
    if (['changed', 'same', 'preference'].includes(action)) app.prefs.set('markersInMixdowns', false);
    if (action === 'disabled') app.prefs.set('markersInMixdowns', true);
  } finally { release(); }
  const before = doc.state, history = doc.history.entries.slice();
  let file;
  await mixing;
  if (!exporting) file = app.active;
  const start = scope === 'All' ? 0 : 8, end = scope === 'Time' ? 24 : 32;
  const expected = gate.output.slice(0, original.master.channels);
  const markers = action === 'disabled' ? [] : [{ name: 'Original cue', start: 12 - start, duration: 0 }, { name: 'Original range', start: 18 - start, duration: Math.min(26, end) - 18 }];
  if (file) {
    expect(file.kind).toBe('audio'); expect(file.length).toBe(end - start);
    expect.soft(file.sampleRate).toBe(rate); expect.soft(file.channelCount).toBe(original.master.channels);
    expect.soft(file.state.channels.map((c) => [...c.toArray()])).toEqual(expected.map((c) => [...c]));
    expect.soft(file.state.markers).toMatchObject(markers);
  }
  const saving = exporting ? mixing : app.commands.run('file.saveAs');
  if (!exporting) await fillAndSave();
  await saving;
  const wav = parseWav(await stored.get('/u/Mix.wav').arrayBuffer());
  expect.soft(wav.sampleRate).toBe(rate); expect.soft(wav.channels.map((c) => [...c])).toEqual(expected.map((c) => [...c]));
  expect.soft(wav.markers).toMatchObject(markers); if (file) expect(file.dirty).toBe(false);
  expect(doc.state).toBe(before); expect(doc.history.entries).toEqual(history);
  if (exporting) expect(app.active).toBe(doc);
});
