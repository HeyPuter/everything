import fs from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { parseWav } from '../src/audio/wav.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrack } from '../src/features/multitrack.js';
import { sessionFromText } from '../src/multitrack/storage.js';
import { confirmSessionSave } from './helpers/session-save.js';

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
});
afterEach(() => { delete window.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });
const samples = (session, id) => [...session.pool.get(id).channels[0].toArray()];

it.each([
  [8000, 16000, 'before', 'new', 8000], [8000, 16000, 'after', 'new', 8000],
  [16000, 8000, 'before', 'new', 16000], [16000, 8000, 'after', 'new', 16000],
  [8000, 16000, 'before', 'new', 32000], [16000, 8000, 'after', 'new', 32000],
  [8000, 16000, 'before', 'loaded', 8000], [16000, 8000, 'after', 'loaded', 16000],
])('preserves %s to %s Hz history with edits %s reinsertion (%s session, %s Hz waveform)', async (from, to, editAt, origin, waveRate) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.prefs.set('autosave', false);
  installCoreCommands(app);
  installMultitrack(app);
  const stored = new Map();
  window.puter = { auth: { isSignedIn: () => true }, fs: {
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(path, blob); return { path }; },
  } };
  const originalPcm = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 64);
  let wave = app.addDocument(new AudioFile({ name: 'Take.wav', sampleRate: waveRate, channels: [Channel.fromSamples(originalPcm)] }));
  let target = app.addDocument(new Session({ name: 'Target.asesx', sampleRate: from, tracks: 1, source: { type: 'puter', path: '/u/Target.asesx' } }));
  await app.commands.run('mt.insertFiles', { docs: [wave] });
  await app.commands.run('file.save');
  if (origin === 'loaded') {
    await app.closeDocument(target);
    await app.closeDocument(wave);
    target = await sessionFromText(app, await stored.get('/u/Target.asesx').text(), 'Target.asesx', { type: 'puter', path: '/u/Target.asesx' }, (src) => stored.get(`/u/${src.file}`));
    app.addDocument(target);
    wave = app.documents.find((d) => d.id === target.pool.get(target.state.clips[0].sourceId).docId);
  }
  const original = target.state;
  const oldId = original.clips[0].sourceId;
  const writer = app.addDocument(new Session({ name: 'Other.asesx', sampleRate: to, tracks: 1, source: { type: 'puter', path: '/u/Other.asesx' } }));
  const otherId = writer.addSource({ name: 'Other.wav', channels: [Channel.fromSamples(new Float32Array(32).fill(-0.5))] });
  writer.apply('Insert', addClips(writer.state, [createClip({ sourceId: otherId, trackId: writer.state.tracks[0].id, length: 32 })]));
  const copying = app.commands.run('file.saveCopy');
  await confirmSessionSave('Target.asesx', { replace: true });
  await copying;
  app.activate(target);
  const reverting = app.commands.run('file.revert');
  await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Revert')).toBe(true), { interval: 1 });
  [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Revert').click();
  await reverting;
  expect(target.sampleRate).toBe(to);
  // Imported saved media must carry its own rate even while the receiving
  // session still had the old rate when the independent source was created.
  const replacement = target.state.clips[0];
  await app.commands.run('clip.editSource', { id: replacement.id });
  const replacementWave = app.active;
  await app.commands.run('fx.invert');
  await vi.waitFor(() => expect(target.pool.get(replacement.sourceId).stateRef).toBe(replacementWave.state), { interval: 1 });
  expect.soft(samples(target, replacement.sourceId)).toEqual(Array(32).fill(0.5));
  app.activate(target);
  const invert = async () => {
    app.activate(wave);
    await app.commands.run('fx.invert');
    await vi.waitFor(() => expect([...target.pool.values()].filter((s) => s.docId === wave.id).every((s) => s.stateRef === wave.state)).toBe(true), { interval: 1 });
    app.activate(target);
  };
  if (editAt === 'before') await invert();
  const ids = await app.commands.run('mt.insertFiles', { docs: [wave] });
  const added = target.state.clips.find((c) => c.id === ids[0]);
  expect.soft(added.sourceId).not.toBe(oldId);
  expect.soft(added.length).toBe(32 * to / waveRate);
  if (editAt === 'after') await invert();
  const editedPcm = Float32Array.from(originalPcm, (v) => -v);
  const processor = await dsp();
  const atRate = (rate) => waveRate === rate ? [...editedPcm] : [...processor.resample(editedPcm, waveRate, rate)];
  const converted = atRate(to);
  expect.soft(samples(target, oldId)).toEqual(atRate(from));
  expect.soft(samples(target, added.sourceId)).toEqual(converted);
  const editedIndex = target.history.index;
  for (let i = 0; target.state !== original && i < 10; i++) await app.commands.run('edit.undo');
  expect(target.state).toBe(original);
  expect(target.sampleRate).toBe(from);
  expect.soft(samples(target, oldId)).toEqual(atRate(from));
  expect(target.dirty).toBe(true);
  for (let i = 0; target.history.index < editedIndex && i < 10; i++) await app.commands.run('edit.redo');
  expect(target.sampleRate).toBe(to);
  expect.soft(samples(target, added.sourceId)).toEqual(converted);
  const size = target.pool.size;
  const repeated = await app.commands.run('mt.insertFiles', { docs: [wave] });
  expect(target.state.clips.find((c) => c.id === repeated[0]).sourceId).toBe(added.sourceId);
  expect(target.pool.size).toBe(size);
  await app.commands.run('file.save');
  const saved = JSON.parse(await stored.get('/u/Target.asesx').text());
  const media = saved.sources.find((s) => s.id === added.sourceId);
  const wav = parseWav(await stored.get(`/u/${media.file}`).arrayBuffer());
  expect(wav.sampleRate).toBe(to);
  expect.soft([...wav.channels[0]]).toEqual(converted);
  expect(target.dirty).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
});
