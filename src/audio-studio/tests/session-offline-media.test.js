import { posix } from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { unzipStore } from '../src/lib/zip.js';
import { parseWav } from '../src/audio/wav.js';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { confirmSessionSave } from './helpers/session-save.js';
import { sessionFromText, prepareSessionZip, installSessionStorage } from '../src/multitrack/storage.js';
import { openFiles, OPENERS, EXTRA_ACCEPT } from '../src/storage/files.js';

let openers, accepts;
beforeEach(() => {
  localStorage.clear(); vi.stubGlobal('Blob', NodeBlob);
  openers = new Map(OPENERS); accepts = EXTRA_ACCEPT.slice(); installSessionStorage();
});
afterEach(() => {
  OPENERS.clear(); for (const [key, value] of openers) OPENERS.set(key, value);
  EXTRA_ACCEPT.splice(0, EXTRA_ACCEPT.length, ...accepts);
  delete window.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren();
});
function setup() {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const stored = new Map();
  const writes = [];
  window.puter = { auth: { isSignedIn: () => true }, fs: {
    read: vi.fn(async (path) => stored.get(path)),
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(path, blob); writes.push(path); return { path }; },
  } };
  return { app, stored, writes };
}
it.each(['missing', 'read failure', 'decode failure'].flatMap((failure) => ['save', 'saveAs', 'saveCopy'].map((command) => [failure, command])))('retains cloud media after a temporary %s and %s', async (failure, command) => {
  const { app, stored, writes } = setup();
  const path = '/u/Song.asesx';
  const source = { type: 'puter', path };
  const original = app.addDocument(new Session({ name: 'Song.asesx', sampleRate: 8000, tracks: 1, source }));
  const channels = [Channel.fromSamples(new Float32Array(32).fill(0.25)), Channel.fromSamples(new Float32Array(32).fill(-0.5))];
  const id = original.addSource({ name: 'Take.wav', channels });
  original.apply('Clip', addClips(original.state, [createClip({ sourceId: id, trackId: original.state.tracks[0].id, length: 32 })]));
  await app.commands.run('file.save');
  const text = await stored.get(path).text();
  const first = JSON.parse(text).sources[0];
  expect(first.file).toMatch(/Take-[0-9a-f]+\.wav$/);
  await app.closeDocument(original);
  const offline = await sessionFromText(app, text, 'Song.asesx', source, async () => {
    if (failure === 'read failure') throw new Error('Temporary connection failure');
    return failure === 'decode failure' ? new Blob(['broken']) : null;
  });
  app.addDocument(offline);
  expect(app.notify).toHaveBeenCalledTimes(1);
  expect(offline.pool.get(id).offline).toBe(true);
  expect.soft(offline.sourceLength(id)).toBe(32);
  offline.apply('Tempo', { ...offline.state, tempo: 125 });
  const before = writes.length;
  const destination = command === 'save' ? path : '/u/Exports/Copy.asesx';
  const saving = app.commands.run(`file.${command}`);
  if (command !== 'save') await confirmSessionSave('Copy.asesx', { folder: '/u/Exports' });
  await saving;
  expect(writes.slice(before)).toEqual([destination]);
  const saved = JSON.parse(await stored.get(destination).text());
  expect.soft(saved.sources[0]).toEqual({ ...first, file: posix.relative(posix.dirname(destination), `/u/${first.file}`) });
  expect(offline.dirty).toBe(command === 'saveCopy');
  const reader = new App();
  reader.syncGraph = vi.fn(); reader.notify = vi.fn();
  const [reopened] = await openFiles(reader, [{ name: posix.basename(destination), path: destination }]);
  expect.soft(reopened.pool.get(id).offline).toBe(false);
  expect.soft(reopened.pool.get(id).channels.map((c) => [...c.toArray()])).toEqual(channels.map((c) => [...c.toArray()]));
  expect(reopened.state.tempo).toBe(125);
  expect(stored.has(`/u/${first.file}`)).toBe(true);
  expect(window.puter.fs.read).toHaveBeenCalledWith(`/u/${first.file}`);
  expect(reader.notify).not.toHaveBeenCalled();
  // A later ordinary save, and Undo/Redo around that save, retain the reference.
  await app.commands.run('file.save');
  await app.commands.run('edit.undo');
  expect(offline.state.tempo).toBe(120);
  expect(offline.dirty).toBe(true);
  await app.commands.run('edit.redo');
  expect(offline.dirty).toBe(false);
  const latest = JSON.parse(await stored.get(offline.source.path).text());
  expect(posix.resolve(posix.dirname(offline.source.path), latest.sources[0].file)).toBe(`/u/${first.file}`);
});

it('keeps missing local media names and bounds through ZIP export, trimming, and Undo', async () => {
  const { app } = setup();
  const session = new Session({ name: 'Song.asesx', sampleRate: 8000, tracks: 1 });
  const id = session.addSource({ name: 'Display name.wav', channels: [Channel.silence(32), Channel.silence(32)] });
  session.apply('Clip', addClips(session.state, [createClip({ sourceId: id, trackId: session.state.tracks[0].id, length: 32 })]));
  const zip = await prepareSessionZip(session);
  const files = unzipStore(await zip.blob.arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(files.get('Song.asesx')));
  // A media filename need not match its display name.
  manifest.sources[0].file = 'Original_Media/revision.wav';
  const offline = await sessionFromText(app, JSON.stringify(manifest), 'Renamed.asesx', { type: 'local' }, async () => null);
  app.addDocument(offline);
  const original = offline.state;
  offline.selectClips([original.clips[0].id]);
  offline.setSelection(4, 24);
  await app.commands.run('edit.trimToSelection');
  expect.soft(offline.state.clips[0]).toMatchObject({ start: 4, offset: 4, length: 20 });
  await app.commands.run('edit.undo');
  expect(offline.state).toBe(original);
  const exported = await prepareSessionZip(offline);
  const entries = unzipStore(await exported.blob.arrayBuffer());
  const saved = JSON.parse(new TextDecoder().decode(entries.get('Renamed.asesx')));
  expect.soft(saved.sources).toEqual(manifest.sources);
  expect(entries.size).toBe(1);
  const restored = await sessionFromText(app, JSON.stringify(saved), 'Renamed.asesx', { type: 'local' }, async () => null);
  expect.soft(restored.sourceLength(id)).toBe(32);
  expect(restored.state.clips).toEqual(original.clips);
  // A later online source with the missing file's name must not replace it
  // inside the archive, even when it comes first in the pool.
  offline.rename('Original.asesx');
  const online = offline.addSource({ name: 'revision.wav', channels: [Channel.fromSamples(new Float32Array(32).fill(0.5))] });
  const missing = offline.pool.get(id);
  offline.pool.delete(id); offline.pool.set(id, missing);
  offline.apply('Insert', addClips(offline.state, [createClip({ sourceId: online, trackId: original.tracks[0].id, start: 32, length: 32 })]));
  const mixed = await prepareSessionZip(offline);
  const mixedFiles = unzipStore(await mixed.blob.arrayBuffer());
  const mixedManifest = JSON.parse(new TextDecoder().decode(mixedFiles.get('Original.asesx')));
  const available = mixedManifest.sources.find((s) => s.id === online);
  expect(mixedManifest.sources.find((s) => s.id === id)).toEqual(manifest.sources[0]);
  expect(available.file).not.toBe(manifest.sources[0].file);
  expect(mixedFiles.has(manifest.sources[0].file)).toBe(false);
  expect([...parseWav(mixedFiles.get(available.file).slice().buffer).channels[0]]).toEqual(Array(32).fill(0.5));
});
