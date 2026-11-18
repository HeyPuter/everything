import fs from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { INSERT_HOOKS, placementOptions } from '../src/multitrack/insert.js';
import { insertVideoHook, linkVideo, setVideoOfDoc } from '../src/video/media.js';
import { announce } from '../src/lib/dom.js';
import { parseWav } from '../src/audio/wav.js';
import { setVideoClip, videoPool } from '../src/model/session-video.js';
import { confirmSessionSave } from './helpers/session-save.js';

const gate = vi.hoisted(() => ({ wait: null, calls: 0 }));
vi.mock('../src/audio/dsp.js', async (original) => {
  const actual = await original();
  return { ...actual, dsp: async () => { gate.calls++; if (gate.wait) await gate.wait; return actual.dsp(); } };
});
vi.mock('../src/lib/dom.js', async (original) => ({ ...(await original()), announce: vi.fn() }));
let hooks, options, processor;
beforeEach(async () => {
  localStorage.clear(); vi.stubGlobal('Blob', NodeBlob);
  gate.wait = null;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm')); processor = await dsp(); gate.calls = 0;
  hooks = INSERT_HOOKS.slice(); INSERT_HOOKS.splice(0, INSERT_HOOKS.length, insertVideoHook);
  options = { ...placementOptions }; placementOptions.sameTrack = true;
});
afterEach(() => {
  INSERT_HOOKS.splice(0, INSERT_HOOKS.length, ...hooks); Object.assign(placementOptions, options);
  delete window.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren();
});
const button = (name) => [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === name);
it.each([[8000, 16000], [16000, 8000]].flatMap(([from, next]) => ['conversion', 'video'].flatMap((phase) => ['changed', 'same', 'undone'].map((change) => [from, next, phase, change]))))('handles %s to %s Hz during %s when the rate change is %s', async (from, next, phase, change) => {
  const to = change === 'same' ? from : next;
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn();
  installCoreCommands(app); app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const stored = new Map();
  window.puter = { auth: { isSignedIn: () => true }, fs: {
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(path, blob); return { path }; },
  } };
  const pcm = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 64);
  const first = app.addDocument(new AudioFile({ name: 'First.wav', sampleRate: from, channels: [Channel.fromSamples(pcm)] }));
  const second = app.addDocument(new AudioFile({ name: 'Second.wav', sampleRate: 32000, channels: [Channel.fromSamples(pcm)] }));
  const target = app.addDocument(new Session({ name: 'Target.asesx', sampleRate: from, tracks: 1, source: { type: 'puter', path: '/u/Target.asesx' } }));
  if (phase === 'video') {
    const info = (name) => ({ name, blob: new Blob([name]), width: 16, height: 16, duration: 32 / from, fps: 25 });
    target.apply('Video', setVideoClip(target.state, { sourceId: linkVideo(target, info('Old.webm')), name: 'Old', length: 32 }));
    setVideoOfDoc(first, info('New.webm'));
  }
  await app.commands.run('file.save');
  const original = target.state;
  const writer = app.addDocument(new Session({ name: 'Other.asesx', sampleRate: to, tracks: 1, source: { type: 'puter', path: '/u/Other.asesx' } }));
  const otherId = writer.addSource({ name: 'Other.wav', channels: [Channel.silence(32)] });
  writer.apply('Clip', addClips(writer.state, [createClip({ sourceId: otherId, trackId: writer.state.tracks[0].id, length: 32 })]));
  // Record another session at Target's path, without changing its current state.
  const copying = app.commands.run('file.saveCopy'); await confirmSessionSave('Target.asesx', { replace: true }); await copying;
  app.activate(target); expect(target.state).toBe(original); target.cursor = 64;
  const waveStates = [first.state, second.state]; announce.mockClear();
  let release; const wait = new Promise((resolve) => { release = resolve; });
  if (phase === 'conversion') gate.wait = wait;
  const docs = phase === 'conversion' ? [first, second] : [first];
  const pending = app.commands.run('mt.insertFiles', { docs });
  try {
    await vi.waitFor(() => expect(phase === 'conversion' ? gate.calls > 0 : Boolean(button('Replace'))).toBe(true), { interval: 1 });
    const reverting = app.commands.run('file.revert');
    await vi.waitFor(() => expect(button('Revert')).toBeDefined(), { interval: 1 });
    button('Revert').click(); await reverting;
    expect(target.sampleRate).toBe(to);
    if (change === 'undone') await app.commands.run('edit.undo');
    const before = target.state;
    const history = target.history.entries.slice();
    const dirty = target.dirty;
    const videos = videoPool(target).size;
    app.activate(first);
    release(); if (phase === 'video') button('Replace').click();
    let ids = await pending;
    expect(app.active).toBe(first);
    expect([first.state, second.state]).toEqual(waveStates);
    if (change === 'changed') {
      expect(target.state).toBe(before);
      expect(target.history.entries).toEqual(history);
      expect(target.dirty).toBe(dirty);
      expect(videoPool(target).size).toBe(videos);
      expect(ids).toEqual([]);
      expect(announce).not.toHaveBeenCalled();
      expect(app.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('sample rate changed'), { error: true });
      app.activate(target); target.cursor = 64;
      ids = await app.commands.run('mt.insertFiles', { docs });
    } else expect(app.notify).not.toHaveBeenCalled();
    expect(ids).toHaveLength(docs.length);
    let start = 64;
    for (const [i, id] of ids.entries()) {
      const c = target.state.clips.find((c) => c.id === id);
      const src = target.pool.get(c.sourceId);
      const expected = docs[i].sampleRate === target.sampleRate ? [...pcm] : [...processor.resample(pcm, docs[i].sampleRate, target.sampleRate)];
      expect(src.channelRate).toBe(target.sampleRate);
      expect([...src.channels[0].toArray()]).toEqual(expected);
      expect(c).toMatchObject({ start, offset: 0, length: expected.length });
      start += expected.length;
    }
    if (phase === 'video') expect(target.state.video).toMatchObject({ name: 'New', start: 64, length: 32 * target.sampleRate / from });
    const inserted = target.state;
    app.activate(target);
    await app.commands.run('edit.undo'); expect(target.state).toBe(before);
    await app.commands.run('edit.redo'); expect(target.state).toBe(inserted);
    await app.commands.run('file.save');
    const saved = JSON.parse(await stored.get('/u/Target.asesx').text());
    for (const id of ids) {
      const clip = target.state.clips.find((c) => c.id === id);
      const source = saved.sources.find((s) => s.id === clip.sourceId);
      const wav = parseWav(await stored.get(`/u/${source.file}`).arrayBuffer());
      expect(wav.sampleRate).toBe(target.sampleRate);
      expect([...wav.channels[0]]).toEqual([...target.pool.get(clip.sourceId).channels[0].toArray()]);
    }
    expect(target.dirty).toBe(false);
  } finally {
    release(); button('Replace')?.click(); await pending;
  }
});
