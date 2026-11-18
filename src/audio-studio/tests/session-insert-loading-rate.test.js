import fs from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { placementOptions } from '../src/multitrack/insert.js';
import { announce } from '../src/lib/dom.js';
import { encodeWav, parseWav } from '../src/audio/wav.js';
import { confirmSessionSave } from './helpers/session-save.js';

vi.mock('../src/lib/dom.js', async (original) => ({ ...(await original()), announce: vi.fn() }));
let processor, options;
beforeEach(async () => {
  localStorage.clear(); vi.stubGlobal('Blob', NodeBlob);
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm')); processor = await dsp();
  options = { ...placementOptions }; placementOptions.sameTrack = true; announce.mockClear();
});
afterEach(() => { Object.assign(placementOptions, options); delete window.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });
const button = (name) => [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === name);

it.each([[8000, 16000], [16000, 8000]].flatMap(([from, next]) => [0, 1].flatMap((held) => ['changed', 'same', 'undone', 'closed', 'failed-read'].map((change) => [from, next, held, change]))))('handles %s to %s Hz while reading file %s when the change is %s', async (from, next, held, change) => {
  const to = change === 'same' ? from : next;
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn();
  installCoreCommands(app); app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const stored = new Map();
  window.puter = { auth: { isSignedIn: () => true }, fs: {
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(path, blob); return { path }; },
  } };
  const target = app.addDocument(new Session({ name: 'Target.asesx', sampleRate: from, tracks: 1, source: { type: 'puter', path: '/u/Target.asesx' } }));
  await app.commands.run('file.save');
  const writer = app.addDocument(new Session({ name: 'Other.asesx', sampleRate: to, tracks: 1, source: { type: 'puter', path: '/u/Other.asesx' } }));
  const otherId = writer.addSource({ name: 'Other.wav', channels: [Channel.silence(32)] });
  writer.apply('Clip', addClips(writer.state, [createClip({ sourceId: otherId, trackId: writer.state.tracks[0].id, length: 32 })]));
  const copying = app.commands.run('file.saveCopy'); await confirmSessionSave('Target.asesx', { replace: true }); await copying;
  app.activate(target); target.cursor = 64;
  const pcm = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 64);
  const rates = [from, 32000];
  let waiting = false, release;
  const wait = new Promise((resolve) => { release = resolve; });
  const items = rates.map((sampleRate, i) => ({ name: `Input${i}.wav`, path: `/u/Input${i}.wav`, read: async () => {
    if (i === held) { waiting = true; await wait; }
    if (change === 'failed-read') throw new Error('Read failed');
    return encodeWav({ sampleRate, channels: [Channel.fromSamples(pcm)], bitDepth: 32, float: true });
  } }));
  window.puter.ui = { showOpenFilePicker: async () => items };
  const pending = app.commands.run('mt.insertFiles');
  try {
    await vi.waitFor(() => expect(waiting).toBe(true), { interval: 1 });
    const reverting = app.commands.run('file.revert');
    await vi.waitFor(() => expect(button('Revert')).toBeDefined(), { interval: 1 });
    button('Revert').click(); await reverting;
    if (change === 'undone') await app.commands.run('edit.undo');
    const before = target.state, history = target.history.entries.slice(), dirty = target.dirty;
    const previous = new Set(before.clips.map((c) => c.id));
    if (change === 'closed') expect(await app.closeDocument(target)).toBe(true);
    app.activate(writer); release(); await pending;
    const docs = items.map((item) => app.documents.find((d) => d.source?.path === item.path));
    if (change === 'failed-read') {
      expect(docs).toEqual([undefined, undefined]); expect(target.state).toBe(before); expect(target.history.entries).toEqual(history);
      expect(announce).not.toHaveBeenCalled(); expect(app.notify).toHaveBeenCalledTimes(2);
      expect(app.notify.mock.calls.every(([message]) => message.includes('Read failed'))).toBe(true);
      return;
    }
    for (const [i, doc] of docs.entries()) {
      expect(doc.sampleRate).toBe(rates[i]); expect([...doc.state.channels[0].toArray()]).toEqual([...pcm]);
    }
    if (change === 'closed') {
      expect(target.state).toBe(before); expect(target.history.entries).toEqual(history); expect(target.dirty).toBe(dirty);
      expect(app.documents).not.toContain(target); expect(app.active).toBe(writer);
      expect(announce).not.toHaveBeenCalled(); expect(app.notify).not.toHaveBeenCalled();
      return;
    }
    let ids = target.state.clips.filter((c) => !previous.has(c.id)).map((c) => c.id);
    if (change === 'changed') {
      // These positions were captured at the old rate; accepting them would
      // place the first clip at 64 / to seconds instead of 64 / from seconds.
      expect.soft(ids.map((id) => target.state.clips.find((c) => c.id === id).start / target.sampleRate)).toEqual([]);
      expect(target.state).toBe(before); expect(target.history.entries).toEqual(history); expect(target.dirty).toBe(dirty);
      expect(app.active).toBe(writer); expect(announce).not.toHaveBeenCalled();
      expect(app.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('sample rate changed'), { error: true });
      app.activate(target); target.cursor = 64;
      ids = await app.commands.run('mt.insertFiles', { docs });
    } else expect(app.notify).not.toHaveBeenCalled();
    expect(ids).toHaveLength(2);
    let start = 64;
    for (const [i, id] of ids.entries()) {
      const clip = target.state.clips.find((c) => c.id === id), src = target.pool.get(clip.sourceId);
      const expected = rates[i] === target.sampleRate ? [...pcm] : [...processor.resample(pcm, rates[i], target.sampleRate)];
      expect(clip).toMatchObject({ start, offset: 0, length: expected.length });
      expect(src.channelRate).toBe(target.sampleRate); expect([...src.channels[0].toArray()]).toEqual(expected);
      start += expected.length;
    }
    const inserted = target.state; app.activate(target);
    await app.commands.run('edit.undo'); expect(target.state).toBe(before);
    await app.commands.run('edit.redo'); expect(target.state).toBe(inserted);
    await app.commands.run('file.save');
    const manifest = JSON.parse(await stored.get('/u/Target.asesx').text());
    for (const id of ids) {
      const clip = target.state.clips.find((c) => c.id === id), source = manifest.sources.find((s) => s.id === clip.sourceId);
      const wav = parseWav(await stored.get(`/u/${source.file}`).arrayBuffer());
      expect(wav.sampleRate).toBe(target.sampleRate); expect([...wav.channels[0]]).toEqual([...target.pool.get(clip.sourceId).channels[0].toArray()]);
    }
    expect(target.dirty).toBe(false);
  } finally { release(); await pending; }
});
