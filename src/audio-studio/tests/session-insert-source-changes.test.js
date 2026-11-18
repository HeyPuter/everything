import fs from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrack } from '../src/features/multitrack.js';
import { placementOptions, INSERT_HOOKS } from '../src/multitrack/insert.js';
import { insertVideoHook, linkVideo, setVideoOfDoc } from '../src/video/media.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { setVideoClip } from '../src/model/session-video.js';
import { buildSessionGraph } from '../src/model/session-graph.js';
import { ChunkStore, renderBlock, createScratch } from '../src/engine/mixcore.js';
import { parseWav } from '../src/audio/wav.js';
import { announce } from '../src/lib/dom.js';

const gate = vi.hoisted(() => ({ wait: null, calls: 0, holdAt: 1 }));
vi.mock('../src/audio/dsp.js', async (original) => {
  const actual = await original();
  return { ...actual, dsp: async () => { gate.calls++; if (gate.wait && gate.calls >= gate.holdAt) await gate.wait; return actual.dsp(); } };
});
vi.mock('../src/lib/dom.js', async (original) => ({ ...(await original()), announce: vi.fn() }));
let options, hooks, processor;
beforeEach(async () => {
  localStorage.clear(); vi.stubGlobal('Blob', NodeBlob);
  gate.wait = null; setDspBytes(fs.readFileSync('src/audio/dsp.wasm')); processor = await dsp(); gate.calls = 0; gate.holdAt = 1;
  options = { ...placementOptions }; hooks = INSERT_HOOKS.slice(); INSERT_HOOKS.splice(0, INSERT_HOOKS.length, insertVideoHook);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); announce.mockClear();
});
afterEach(async () => {
  await vi.runOnlyPendingTimersAsync(); vi.useRealTimers();
  Object.assign(placementOptions, options); INSERT_HOOKS.splice(0, INSERT_HOOKS.length, ...hooks);
  delete window.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren();
});
const button = (name) => [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === name);
const cases = ['conversion', 'video'].flatMap((phase) => [true, false].flatMap((sequential) => ['crop', 'grow', 'empty', 'all-empty', 'unchanged', 'undone'].map((edit) => [phase, sequential, edit, 'whole'])));
for (const phase of ['conversion', 'video']) for (const sequential of [true, false]) for (const range of ['partial', 'past-end']) cases.push([phase, sequential, 'crop', range]);
cases.push(['video-cancel', true, 'crop', 'whole']);
for (const phase of ['conversion', 'video']) for (const edit of ['crop', 'grow']) cases.push([phase, true, edit, 'whole', 16000]);
cases.push(['conversion', true, 'grow', 'whole', 8000, true]);
it.each(cases.map(([phase, sequential, edit, selection, firstRate = 8000, collision = false]) => [phase, sequential, edit, selection, firstRate, collision]))('refreshes clips during %s (sequential %s, edit %s, range %s, source rate %s, overlap %s)', async (phase, sequential, edit, selection, firstRate = 8000, collision = false) => {
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn(); installCoreCommands(app); installMultitrack(app);
  placementOptions.sameTrack = sequential; placementOptions.avoidOverlap = collision;
  gate.holdAt = firstRate === 8000 ? 1 : 2;
  const pcm = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 64);
  const make = (name, sampleRate) => app.addDocument(new AudioFile({ name, sampleRate, channels: [Channel.fromSamples(pcm)] }));
  const first = make('First.wav', firstRate), second = make('Second.wav', 16000);
  const target = app.addDocument(new Session({ name: 'Session.asesx', sampleRate: 8000, tracks: 1, source: { type: 'puter', path: '/u/Session.asesx' } }));
  const stored = new Map(); window.puter = { auth: { isSignedIn: () => true }, fs: { write: async (path, blob) => { stored.set(path, blob); return { path }; } } };
  if (phase.startsWith('video')) {
    const info = (name) => ({ name, blob: new Blob([name]), width: 16, height: 16, duration: 16 / 8000, fps: 25 });
    target.apply('Video', setVideoClip(target.state, { sourceId: linkVideo(target, info('Old.webm')), name: 'Old', length: 16 }));
    setVideoOfDoc(second, info('New.webm'));
  }
  let existing;
  if (collision) {
    const id = target.addSource({ name: 'Existing', channels: [Channel.silence(16)] });
    existing = createClip({ sourceId: id, trackId: target.state.tracks[0].id, start: 40, length: 16 });
    target.apply('Existing clip', addClips(target.state, [existing]));
  }
  const before = target.state, history = target.history.entries.slice();
  let release; const wait = new Promise((resolve) => { release = resolve; });
  if (phase === 'conversion') gate.wait = wait;
  const range = selection === 'whole' ? undefined : selection === 'partial' ? [8, 24] : [24, 32];
  const pending = app.multitrack.insertDocs(target, [first, second], { at: 8, range });
  try {
    await vi.waitFor(() => expect(phase === 'conversion' ? gate.calls >= gate.holdAt : Boolean(button('Replace'))).toBe(true), { interval: 1 });
    app.activate(first);
    if (edit === 'crop' || edit === 'undone') {
      first.setSelection(0, 16); await app.commands.run('edit.crop');
      if (edit === 'undone') await app.commands.run('edit.undo');
    } else if (edit === 'grow') await app.commands.run('edit.insertSilence', { seconds: 16 / 8000 });
    else if (edit === 'empty' || edit === 'all-empty') {
      first.setSelection(0, 32); await app.commands.run('edit.delete');
      if (edit === 'all-empty') { app.activate(second); second.setSelection(0, 32); await app.commands.run('edit.delete'); app.activate(first); }
    }
    const source = [...target.pool.values()].find((s) => s.docId === first.id);
    if (firstRate === 8000) await vi.waitFor(() => expect(target.sourceLength(source.id)).toBe(first.length), { interval: 1 });
    else expect(target.pool.get(source.id).stateRef).not.toBe(first.state);
    const waveStates = [first.state, second.state];
    release(); if (phase.startsWith('video')) button(phase === 'video-cancel' ? 'Cancel' : 'Replace').click();
    const ids = await pending;
    expect(app.active).toBe(first); expect([first.state, second.state]).toEqual(waveStates);
    expect(app.notify).not.toHaveBeenCalled();
    if (edit === 'all-empty') {
      expect(ids).toEqual([]); expect(target.state).toBe(before); expect(target.history.entries).toEqual(history);
      expect(announce).not.toHaveBeenCalled(); return;
    }
    const firstLength = edit === 'empty' ? 0 : selection === 'partial' ? 8 : selection === 'past-end' ? 1 : edit === 'crop' ? 16 * 8000 / firstRate : edit === 'grow' ? (32 + firstRate * 16 / 8000) * 8000 / firstRate : 32;
    const firstOffset = selection === 'partial' ? 8 : selection === 'past-end' ? 15 : 0;
    const secondStart = sequential ? 8 + firstLength : 8;
    const expected = [];
    if (firstLength) expected.push({ doc: first, start: 8, offset: firstOffset, length: firstLength, pcm: firstRate === 8000 ? [...first.state.channels[0].toArray()] : [...processor.resample(first.state.channels[0].toArray(), firstRate, 8000)] });
    expected.push({ doc: second, start: secondStart, offset: 0, length: 16, pcm: [...processor.resample(pcm, 16000, 8000)] });
    expect(ids).toHaveLength(expected.length);
    for (const [i, id] of ids.entries()) {
      const c = target.state.clips.find((c) => c.id === id), wanted = expected[i], src = target.pool.get(c.sourceId);
      expect.soft(c).toMatchObject({ start: wanted.start, offset: wanted.offset, length: wanted.length });
      expect([...src.channels[0].toArray()]).toEqual(wanted.pcm);
      expect(c.offset + c.length).toBeLessThanOrEqual(src.channels[0].length);
    }
    if (collision) {
      expect(target.state.clips.find((c) => c.id === existing.id)).toEqual(existing);
      for (const id of ids) expect(target.state.clips.find((c) => c.id === id).trackId).not.toBe(existing.trackId);
    }
    if (phase === 'video') expect.soft(target.state.video).toMatchObject({ name: 'New', start: secondStart, length: 16 });
    if (phase === 'video-cancel') expect(target.state.video).toEqual(before.video);
    // Mix the real playback graph to expose gaps and overlaps, using tiny buffers.
    const end = Math.max(...expected.map((p) => p.start + p.length));
    const samples = new Float32Array(end);
    for (const p of expected) for (let i = 0; i < p.length; i++) samples[p.start + i] += p.pcm[p.offset + i];
    const { graph, sources } = buildSessionGraph(target.state, target.pool, { panLaw: { mode: 'balance' } });
    const store = new ChunkStore(); for (const [id, channels] of sources) store.put(id, 0, channels.map((c) => c.toArray()));
    const output = [new Float32Array(end), new Float32Array(end)]; renderBlock(graph, store, 0, end, output, createScratch(128));
    for (const channel of output) for (let i = 0; i < end; i++) expect(channel[i]).toBeCloseTo(samples[i], 6);
    const inserted = target.state; app.activate(target);
    await app.commands.run('edit.undo'); expect(target.state).toBe(before);
    await app.commands.run('edit.redo'); expect(target.state).toBe(inserted);
    await app.commands.run('file.save');
    const manifest = JSON.parse(await stored.get('/u/Session.asesx').text());
    for (const [i, id] of ids.entries()) {
      const clip = target.state.clips.find((c) => c.id === id), src = manifest.sources.find((s) => s.id === clip.sourceId);
      const wav = parseWav(await stored.get(`/u/${src.file}`).arrayBuffer());
      expect(wav.sampleRate).toBe(8000); expect([...wav.channels[0]]).toEqual(expected[i].pcm);
    }
    expect(target.dirty).toBe(false);
  } finally { release(); button('Replace')?.click(); await pending; }
});
