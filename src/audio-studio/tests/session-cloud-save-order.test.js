import { setImmediate } from 'node:timers/promises';
import fs from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { encodeWav, parseWav } from '../src/audio/wav.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { serializeSession } from '../src/model/session-io.js';
import { sessionFromText } from '../src/multitrack/storage.js';
import { linkSource } from '../src/multitrack/insert.js';
import { confirmSessionSave, sessionSaveForm } from './helpers/session-save.js';

beforeEach(async () => {
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
  localStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete window.puter;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function setup() {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  return app;
}
function session(app, name = 'Song') {
  const doc = app.addDocument(new Session({ name: `${name}.asesx`, sampleRate: 8000, tracks: 1, source: { type: 'puter', path: `/u/${name}.asesx` } }));
  const clips = [0.25, -0.5].map((value) => {
    const sourceId = doc.addSource({ name: 'Take.wav', channels: [Channel.fromSamples(new Float32Array(32).fill(value))] });
    return createClip({ trackId: doc.state.tracks[0].id, sourceId, start: 0, length: 32 });
  });
  doc.apply('Insert', addClips(doc.state, clips));
  return { doc, clips };
}
function storage(outcome = 'saved') {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const stored = new Map();
  const calls = [];
  const write = vi.fn(async (path, blob) => {
    calls.push(path);
    if (calls.length === 1) {
      await wait;
      if (outcome === 'failed') throw new Error('Upload failed');
    }
    stored.set(path, blob);
    return {};
  });
  window.puter = { auth: { isSignedIn: () => true }, fs: { write, stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; } } };
  return { release, stored, calls };
}

it.each(['saved', 'failed'])('keeps the latest cloud save after an older upload is %s', async (outcome) => {
  const app = setup();
  const { doc, clips } = session(app);
  const cloud = storage(outcome);
  const first = app.commands.run('file.save');
  await vi.waitFor(() => expect(cloud.calls).toHaveLength(1), { interval: 1 });
  doc.selectClips([clips[0].id]);
  await app.commands.run('edit.delete');
  const latest = doc.state;
  expect(latest.clips.map((clip) => clip.id)).toEqual([clips[1].id]);
  const second = app.commands.run('file.save');
  // All SDK operations except the gated first upload resolve immediately.
  // Let their microtasks drain without assuming how many awaits save performs.
  await setImmediate();
  cloud.release();
  await Promise.all([first, second]);
  const manifest = JSON.parse(await cloud.stored.get('/u/Song.asesx').text());
  expect(manifest.session.clips.map((clip) => clip.id)).toEqual([clips[1].id]);
  const media = manifest.sources.find((src) => src.id === clips[1].sourceId);
  const wav = parseWav(await cloud.stored.get(`/u/${media.file}`).arrayBuffer());
  expect([...wav.channels[0]]).toEqual(Array(32).fill(-0.5));
  expect(doc.state === latest).toBe(true);
  expect(doc.savedState === latest).toBe(true);
  expect(doc.dirty).toBe(false);
  expect(app.notify).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
  // The cache must describe the last writer: an unchanged save skips its media.
  const before = cloud.calls.length;
  await app.commands.run('file.save');
  expect(cloud.calls.slice(before)).toEqual(['/u/Song.asesx']);
});

it('lets an unrelated session save while another session upload is pending', async () => {
  const app = setup();
  const firstDoc = session(app, 'First').doc;
  const cloud = storage();
  const first = app.commands.run('file.save');
  await vi.waitFor(() => expect(cloud.calls).toHaveLength(1), { interval: 1 });
  const otherDoc = session(app, 'Other').doc;
  const second = app.commands.run('file.save');
  await second;
  expect(cloud.stored.has('/u/Other.asesx')).toBe(true);
  expect(otherDoc.dirty).toBe(false);
  cloud.release();
  await first;
  expect(cloud.stored.has('/u/First.asesx')).toBe(true);
  expect(firstDoc.dirty).toBe(false);
  expect(app.active === otherDoc).toBe(true);
});

it('preserves the saved session media when a replacement manifest upload fails', async () => {
  const app = setup();
  const { doc, clips } = session(app);
  const cloud = storage();
  cloud.release();
  await app.commands.run('file.save');
  const original = doc.state;
  const manifestBlob = cloud.stored.get('/u/Song.asesx');
  const manifest = JSON.parse(await manifestBlob.text());
  const firstMedia = manifest.sources.find((src) => src.id === clips[0].sourceId);
  const firstPath = `/u/${firstMedia.file}`;
  expect([...parseWav(await cloud.stored.get(firstPath).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(0.25));
  doc.selectClips([clips[0].id]);
  await app.commands.run('edit.delete');
  const latest = doc.state;
  const write = window.puter.fs.write;
  window.puter.fs.write = async (path, blob) => {
    if (path === '/u/Song.asesx') throw new Error('Manifest upload failed');
    return write(path, blob);
  };
  await app.commands.run('file.save');
  expect(cloud.stored.get('/u/Song.asesx') === manifestBlob).toBe(true);
  expect.soft([...parseWav(await cloud.stored.get(firstPath).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(0.25));
  expect(doc.savedState === original).toBe(true);
  expect(doc.state === latest).toBe(true);
  expect(doc.dirty).toBe(true);
  expect(app.notify).toHaveBeenCalledOnce();
  window.puter.fs.write = write;
  await app.commands.run('file.save');
  const next = JSON.parse(await cloud.stored.get('/u/Song.asesx').text());
  expect(next.session.clips.map((clip) => clip.id)).toEqual([clips[1].id]);
  const media = next.sources.find((src) => src.id === clips[1].sourceId);
  expect([...parseWav(await cloud.stored.get(`/u/${media.file}`).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(-0.5));
  expect(doc.dirty).toBe(false);
  await app.commands.run('edit.undo');
  expect(doc.state === original).toBe(true);
  expect(doc.dirty).toBe(true);
});

it.each(['saved', 'media failure', 'manifest failure'])('preserves old media after editing a reopened source: %s', async (outcome) => {
  const originalApp = setup();
  const { doc, clips } = session(originalApp);
  const cloud = storage();
  cloud.release();
  // Seed an existing session with the human-readable filenames used by older saves.
  const initial = serializeSession(doc);
  for (const m of initial.media) cloud.stored.set(`/u/${m.file}`, encodeWav({ sampleRate: m.sampleRate, channels: m.channels, bitDepth: 32, float: true }));
  cloud.stored.set('/u/Song.asesx', new NodeBlob([initial.text]));
  const app = setup();
  const reopened = await sessionFromText(app, initial.text, doc.name, doc.source, (src) => cloud.stored.get(`/u/${src.file}`));
  app.addDocument(reopened);
  await app.commands.run('file.save');
  expect(cloud.calls).toEqual(['/u/Song.asesx']);
  const previousManifest = cloud.stored.get('/u/Song.asesx');
  const firstPath = `/u/${initial.media[0].file}`;
  const previousMedia = cloud.stored.get(firstPath);
  const wave = app.documents.find((d) => d.id === reopened.pool.get(clips[0].sourceId).docId);
  app.activate(wave);
  await app.commands.run('fx.invert');
  await linkSource(reopened, wave);
  app.activate(reopened);
  reopened.selectClips([clips[1].id]);
  await app.commands.run('edit.delete');
  const latest = reopened.state;
  const write = window.puter.fs.write;
  window.puter.fs.write = async (path, blob) => {
    if (outcome === 'manifest failure' && path === '/u/Song.asesx') throw new Error('Manifest upload failed');
    const result = await write(path, blob);
    if (outcome === 'media failure' && path.endsWith('.wav')) throw new Error('Media upload failed after writing');
    return result;
  };
  await app.commands.run('file.save');
  expect.soft(cloud.stored.get(firstPath) === previousMedia).toBe(true);
  expect.soft([...parseWav(await cloud.stored.get(firstPath).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(0.25));
  expect(reopened.dirty).toBe(outcome !== 'saved');
  expect(app.notify).toHaveBeenCalledTimes(outcome === 'saved' ? 0 : 1);
  if (outcome !== 'saved') {
    expect(cloud.stored.get('/u/Song.asesx') === previousManifest).toBe(true);
    const recoveryApp = setup();
    const recovery = await sessionFromText(recoveryApp, await previousManifest.text(), doc.name, doc.source, (src) => cloud.stored.get(`/u/${src.file}`));
    expect.soft([...recovery.pool.get(clips[0].sourceId).channels[0].toArray()]).toEqual(Array(32).fill(0.25));
    expect(recovery.state.clips).toHaveLength(2);
    expect(recoveryApp.notify).not.toHaveBeenCalled();
  }
  window.puter.fs.write = write;
  await app.commands.run('file.save');
  const next = JSON.parse(await cloud.stored.get('/u/Song.asesx').text());
  expect(next.session.clips.map((clip) => clip.id)).toEqual([clips[0].id]);
  const nextPath = `/u/${next.sources[0].file}`;
  expect([...parseWav(await cloud.stored.get(nextPath).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(-0.25));
  expect(reopened.state === latest).toBe(true);
  expect(reopened.dirty).toBe(false);
  const before = cloud.calls.length;
  await app.commands.run('file.save');
  expect(cloud.calls.slice(before)).toEqual(['/u/Song.asesx']);
});

it.each(['saveAs', 'saveCopy'])('keeps destination media independent when using %s', async (command) => {
  const app = setup();
  const { doc, clips } = session(app);
  const cloud = storage();
  cloud.release();
  await app.commands.run('file.save');
  const oldManifest = cloud.stored.get('/u/Song.asesx');
  const oldState = doc.savedState;
  doc.selectClips([clips[0].id]);
  await app.commands.run('edit.delete');
  const current = doc.state;
  const saving = app.commands.run(`file.${command}`);
  await confirmSessionSave('Other.asesx');
  await saving;
  const exported = JSON.parse(await cloud.stored.get('/u/Other.asesx').text());
  expect(exported.session.clips.map((clip) => clip.id)).toEqual([clips[1].id]);
  expect([...parseWav(await cloud.stored.get(`/u/${exported.sources[0].file}`).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(-0.5));
  expect(cloud.stored.get('/u/Song.asesx') === oldManifest).toBe(true);
  const original = JSON.parse(await oldManifest.text());
  expect([...parseWav(await cloud.stored.get(`/u/${original.sources[0].file}`).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(0.25));
  expect(doc.savedState === (command === 'saveAs' ? current : oldState)).toBe(true);
  expect(doc.dirty).toBe(command === 'saveCopy');
  const destination = command === 'saveAs' ? '/u/Other.asesx' : '/u/Song.asesx';
  expect(doc.source.path).toBe(destination);
  const before = cloud.calls.length;
  await app.commands.run('file.save');
  expect(cloud.calls.slice(before)).toEqual([destination]);
  expect(doc.dirty).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
});

it.each(['saveAs', 'saveCopy'])('releases queued saves after cancelling the %s dialog', async (command) => {
  const app = setup();
  const { doc, clips } = session(app);
  const cloud = storage();
  cloud.release();
  const state = doc.state;
  let firstDone = false;
  let result;
  const first = app.commands.run(`file.${command}`).then((value) => { firstDone = true; result = value; });
  const form = await sessionSaveForm();
  form.querySelector('.dialog-foot button[data-value="null"]').click();
  let nextDone = false;
  const next = app.commands.run('file.save').then(() => { nextDone = true; });
  // Every remaining SDK call resolves immediately; drain the queued save work.
  await setImmediate();
  expect.soft(firstDone).toBe(true);
  expect(nextDone).toBe(true);
  await Promise.all([first, next]);
  expect(result).toBe(false);
  expect(doc.state === state).toBe(true);
  expect(doc.dirty).toBe(false);
  expect(doc.source.path).toBe('/u/Song.asesx');
  const manifest = JSON.parse(await cloud.stored.get('/u/Song.asesx').text());
  expect(manifest.session.clips.map((clip) => clip.id)).toEqual(clips.map((clip) => clip.id));
  for (const [i, src] of manifest.sources.entries()) {
    expect([...parseWav(await cloud.stored.get(`/u/${src.file}`).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(i ? -0.5 : 0.25));
  }
  expect(app.notify).not.toHaveBeenCalled();
});

it.each([['saveAs', 'media'], ['saveAs', 'manifest'], ['saveCopy', 'media'], ['saveCopy', 'manifest']])('keeps an existing destination intact when %s fails during %s upload', async (command, failure) => {
  const app = setup();
  const { doc, clips } = session(app);
  const cloud = storage();
  cloud.release();
  await app.commands.run('file.save');
  // A second valid saved session references the already written media.
  const previous = cloud.stored.get('/u/Song.asesx');
  cloud.stored.set('/u/Existing.asesx', previous);
  const previousState = doc.savedState;
  doc.selectClips([clips[0].id]);
  await app.commands.run('edit.delete');
  const latest = doc.state;
  window.puter.ui = { showSaveFilePicker: vi.fn(async (content) => {
    // The SDK saves its supplied content before resolving with the FSItem.
    cloud.stored.set('/u/Existing.asesx', content);
    return { path: '/u/Existing.asesx', name: 'Existing.asesx' };
  }) };
  const write = window.puter.fs.write;
  window.puter.fs.write = async (path, blob) => {
    if ((failure === 'manifest' && path === '/u/Existing.asesx') || (failure === 'media' && path.endsWith('.wav'))) throw new Error('Upload failed');
    return write(path, blob);
  };
  const saving = app.commands.run(`file.${command}`);
  await confirmSessionSave('Existing.asesx', { replace: true });
  await saving;
  expect(window.puter.ui.showSaveFilePicker).not.toHaveBeenCalled();
  expect.soft(cloud.stored.get('/u/Existing.asesx') === previous).toBe(true);
  const manifest = JSON.parse(await cloud.stored.get('/u/Existing.asesx').text());
  expect.soft(manifest.session.clips.map((clip) => clip.id)).toEqual(clips.map((clip) => clip.id));
  expect.soft(manifest.sources.every((src) => cloud.stored.has(`/u/${src.file}`))).toBe(true);
  expect(doc.state === latest).toBe(true);
  expect(doc.savedState === previousState).toBe(true);
  expect(doc.source.path).toBe('/u/Song.asesx');
  expect(doc.dirty).toBe(true);
  expect(app.notify).toHaveBeenCalledOnce();
  window.puter.fs.write = write;
  await app.commands.run('file.save');
  expect(doc.dirty).toBe(false);
});
