import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { AudioFile } from '../src/model/audio-file.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import { parseWav } from '../src/audio/wav.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { ChunkStore, renderBlock, createScratch } from '../src/engine/mixcore.js';
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
function rendered(state, pool) {
  const { graph, sources } = buildSessionGraph(state, pool, { panLaw: { mode: 'balance' } });
  const store = new ChunkStore(); for (const [id, channels] of sources) store.put(id, 0, channels.map((c) => c.toArray()));
  const out = [new Float32Array(64), new Float32Array(64)]; renderBlock(graph, store, 0, 64, out, createScratch(128)); return out;
}
const cases = [8000, 16000].flatMap((rate) => [
  ...['delete', 'mute', 'back', 'insert', 'rename', 'farDelete', 'otherDelete', 'unchanged', 'undoDelete', 'farFront'].map((action) => [rate, false, action]),
  ...['delete', 'mute', 'autoOff', 'curve'].map((action) => [rate, true, action]),
]);
it.each(cases)('preserves audible %i Hz merge overlaps (crossfade %s, action %s)', async (rate, crossfade, action) => {
  localStorage.clear(); vi.stubGlobal('Blob', NodeBlob); gate.called = false;
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn(); installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) }); app.prefs.set('panLaw', 'balance');
  const stored = new Map(); window.puter = { ui: { showDirectoryPicker: async () => ({ path: '/u' }) }, auth: { isSignedIn: () => true }, fs: {
    write: async (path, blob) => { stored.set(path, blob); return { path }; },
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
  } };
  const wave = app.addDocument(new AudioFile({ name: 'Cover.wav', sampleRate: rate, channels: [Channel.fromSamples(new Float32Array(8).fill(-0.25))] }));
  const doc = app.addDocument(new Session({ name: 'Session.asesx', sampleRate: rate, tracks: 2, autoCrossfade: crossfade, source: { type: 'puter', path: '/u/Session.asesx' } }));
  const pcm = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 64), trackId = doc.state.tracks[0].id;
  const sourceId = doc.addSource({ name: 'Audio.wav', channels: [Channel.fromSamples(pcm)] });
  const coverSource = doc.addSource({ name: 'Cover.wav', channels: [Channel.fromSamples(new Float32Array(32).fill(-0.25))] });
  const first = createClip({ sourceId, trackId, length: 16 }), second = createClip({ sourceId, trackId, start: 16, offset: 16, length: 16 });
  const cover = createClip({ sourceId: coverSource, trackId, name: 'Cover', start: 8, length: crossfade ? 16 : 8, z: 10 });
  const far = createClip({ sourceId: coverSource, trackId, start: 48, length: 8 });
  const other = createClip({ sourceId: coverSource, trackId: doc.state.tracks[1].id, start: 8, length: 8 });
  doc.apply('Audio', addClips(doc.state, [first, second, ...(action === 'insert' ? [] : [cover]), far, other]));
  const selectedIds = [first.id, second.id]; doc.selectClips(selectedIds);
  const docs = app.documents.slice(); let release; gate.wait = new Promise((resolve) => { release = resolve; });
  const pending = app.commands.run('clip.merge');
  try {
    await vi.waitFor(() => expect(gate.called).toBe(true), { interval: 1 });
    doc.selectClips([action === 'farDelete' || action === 'farFront' ? far.id : action === 'otherDelete' ? other.id : cover.id]);
    if (['delete', 'undoDelete', 'farDelete', 'otherDelete'].includes(action)) { await app.commands.run('edit.delete'); if (action === 'undoDelete') await app.commands.run('edit.undo'); }
    if (action === 'mute') await app.commands.run('clip.mute');
    if (action === 'back') await app.commands.run('clip.sendToBack');
    if (action === 'farFront') await app.commands.run('clip.bringToFront');
    if (action === 'insert') { doc.selectTrack(trackId); doc.setCursor(8); await app.commands.run('mt.insertFiles', { docs: [wave] }); }
    if (action === 'autoOff') await app.commands.run('clip.autoCrossfade');
    if (action === 'curve') await app.commands.run('clip.fadeInCosine');
    if (action === 'rename') {
      const naming = app.commands.run('clip.rename'); document.querySelector('.dialog input').value = 'Renamed cover'; button('OK').click(); await naming;
    }
    const before = doc.state, history = doc.history.entries.slice(), pool = doc.pool.size, audio = rendered(doc.state, doc.pool);
    app.activate(wave); release(); await pending;
    expect(app.active).toBe(wave);
    const file = app.documents.find((d) => !docs.includes(d)); expect(file.kind).toBe('audio'); expect(file.sampleRate).toBe(rate);
    const savedRender = gate.output.map((c) => [...c]); expect(file.state.channels.map((c) => [...c.toArray()])).toEqual(savedRender);
    const stopped = ['delete', 'mute', 'back', 'insert', 'autoOff', 'curve'].includes(action);
    if (stopped) {
      expect.soft(doc.state).toBe(before); expect.soft(doc.history.entries).toEqual(history); expect.soft(doc.pool.size).toBe(pool);
      expect.soft(app.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Merge stopped'), { error: true });
    } else expect(app.notify).not.toHaveBeenCalled();
    const heard = rendered(doc.state, doc.pool);
    for (let c = 0; c < 2; c++) for (let i = 0; i < 64; i++) expect.soft(heard[c][i]).toBeCloseTo(audio[c][i], 6);
    app.activate(doc);
    if (!stopped || action === 'delete' || action === 'mute') {
      if (stopped) { app.notify.mockClear(); doc.selectClips(selectedIds); await app.commands.run('clip.merge'); expect(app.notify).not.toHaveBeenCalled(); }
      const after = doc.state, merged = doc.clipSelection[0]; expect(merged).toMatchObject({ trackId, start: 0, length: 32 });
      const retryAudio = rendered(doc.state, doc.pool);
      for (let c = 0; c < 2; c++) for (let i = 0; i < 64; i++) expect(retryAudio[c][i]).toBeCloseTo(audio[c][i], 6);
      await app.commands.run('edit.undo'); expect(doc.state).toBe(before); await app.commands.run('edit.redo'); expect(doc.state).toBe(after);
      await app.commands.run('file.save');
      const manifest = JSON.parse(await stored.get('/u/Session.asesx').text()), saved = manifest.sources.find((s) => s.id === merged.sourceId);
      const wav = parseWav(await stored.get(`/u/${saved.file}`).arrayBuffer()); expect(wav.sampleRate).toBe(rate);
      expect(wav.channels.map((c) => [...c])).toEqual(doc.pool.get(merged.sourceId).channels.map((c) => [...c.toArray()])); expect(doc.dirty).toBe(false);
    }
    app.activate(file); const saving = app.commands.run('file.saveAs');
    await vi.waitFor(() => expect(document.querySelector('.io-export-dialog')).not.toBeNull(), { interval: 1 });
    const form = document.querySelector('.io-export-dialog'), name = form.querySelector('[aria-label="File name"]'); name.value = 'Rendered.wav'; name.dispatchEvent(new Event('input', { bubbles: true }));
    [...form.querySelectorAll('button')].find((b) => b.textContent === 'Browse...').click(); await vi.waitFor(() => expect(form.querySelector('.io-path').textContent).toBe('/u'), { interval: 1 });
    form.querySelector('.dialog-foot button[data-value="ok"]').click(); await saving;
    const wav = parseWav(await stored.get('/u/Rendered.wav').arrayBuffer()); expect(wav.sampleRate).toBe(rate); expect(wav.channels.map((c) => [...c])).toEqual(savedRender);
  } finally { release(); await pending; }
});
