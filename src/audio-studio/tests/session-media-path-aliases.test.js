import { posix } from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { installSessionStorage } from '../src/multitrack/storage.js';
import { openFiles, OPENERS, EXTRA_ACCEPT } from '../src/storage/files.js';
import { confirmSessionSave } from './helpers/session-save.js';

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
// Puter supports absolute, home-relative, and app-relative paths:
// https://docs.puter.com/Events/subjects/
const canonical = (path) => posix.normalize(path.startsWith('~/') ? `/u${path.slice(1)}` : path.startsWith('/') ? path : `/u/AppData/audio-studio/${path}`);
const cases = ['~', '/u', '/shared'].flatMap((origin) => ['~', '/u'].flatMap((destination) => ['saveAs', 'saveCopy'].map((command) => [origin, destination, command, 'ready'])));
cases.push(['~', '/u', 'saveAs', 'unavailable'], ['/u', '~', 'saveCopy', 'unavailable']);
cases.push(['/u', '~', 'saveAs', 'delayed']);
it.each(cases)('preserves offline audio from %s through %s/%s with home lookup %s', async (origin, destination, command, lookup) => {
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn();
  installCoreCommands(app); app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const stored = new Map(), writes = [];
  let unavailable = false;
  window.puter = { env: 'app', auth: { isSignedIn: () => true, getUser: vi.fn(async () => ({ username: 'u' })) }, fs: {
    read: vi.fn(async (path) => { if (unavailable && path.endsWith('.wav')) throw new Error('Temporary read failure'); return stored.get(canonical(path)); }),
    stat: async (path) => { if (stored.has(canonical(path))) return { path: canonical(path) }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(canonical(path), blob); writes.push(path); return { path: canonical(path) }; },
  } };
  const originalPath = `${origin}/Song.asesx`;
  const original = app.addDocument(new Session({ name: 'Song.asesx', sampleRate: 8000, tracks: 1, source: { type: 'puter', path: originalPath } }));
  const sourceId = original.addSource({ name: 'Take.wav', channels: [Channel.fromSamples(new Float32Array(32).fill(0.25))] });
  original.apply('Clip', addClips(original.state, [createClip({ sourceId, trackId: original.state.tracks[0].id, length: 32 })]));
  await app.commands.run('file.save');
  const first = JSON.parse(await stored.get(canonical(originalPath)).text()).sources[0];
  const mediaPath = canonical(`${origin}/${first.file}`);
  const originalBytes = stored.get(mediaPath);
  await app.closeDocument(original);
  unavailable = true;
  const [offline] = await openFiles(app, [{ name: 'Song.asesx', path: originalPath }]);
  expect(offline.pool.get(sourceId).offline).toBe(true);
  unavailable = false;
  offline.apply('Tempo', { ...offline.state, tempo: 125 });
  // History can retain unused offline sources; they must not add lookups or
  // block a save whose actual clips use one path style.
  offline.addSource({ name: 'Unused.wav', channels: [], offline: true, path: origin === '~' ? '/shared/Unused.wav' : '~/Unused.wav' });
  const before = writes.length;
  app.notify.mockClear();
  const save = async () => {
    const saving = app.commands.run(`file.${command}`);
    await confirmSessionSave('Copy.asesx', { folder: `${destination}/Exports` }); await saving;
  };
  if (lookup === 'unavailable') {
    window.puter.auth.getUser.mockRejectedValueOnce(new Error('Account lookup unavailable'));
    await save();
    expect(writes.slice(before)).toEqual([]);
    expect(offline.source.path).toBe(originalPath);
    expect(offline.dirty).toBe(true);
    expect(app.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('home folder'), { error: true });
    app.notify.mockClear();
  }
  if (lookup === 'delayed') {
    let release, entered = false;
    const wait = new Promise((resolve) => { release = resolve; });
    window.puter.auth.getUser.mockImplementationOnce(async () => { entered = true; await wait; return { username: 'u' }; });
    const saving = save();
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { interval: 1 });
      offline.apply('Tempo', { ...offline.state, tempo: 126 });
    } finally { release(); await saving; }
  } else await save();
  const target = `${destination}/Exports/Copy.asesx`;
  const saved = JSON.parse(await stored.get(canonical(target)).text());
  expect(saved.sources).toHaveLength(1);
  expect.soft(saved.sources[0].file).toBe(posix.relative('/u/Exports', mediaPath));
  expect(writes.slice(before)).toEqual([target]);
  expect(stored.get(mediaPath)).toBe(originalBytes);
  const reader = new App(); reader.syncGraph = vi.fn(); reader.notify = vi.fn();
  const [reopened] = await openFiles(reader, [{ name: 'Copy.asesx', path: target }]);
  expect.soft(reopened.pool.get(sourceId).offline).toBe(false);
  expect.soft(reopened.pool.get(sourceId).channels.map((c) => [...c.toArray()])).toEqual([Array(32).fill(0.25)]);
  expect.soft(reader.notify).not.toHaveBeenCalled();
  expect(reopened.state.tempo).toBe(lookup === 'delayed' ? 126 : 125);
  expect(offline.dirty).toBe(command === 'saveCopy');
  expect(app.notify).not.toHaveBeenCalled();
  expect(window.puter.auth.getUser).toHaveBeenCalledTimes((origin === '~') !== (destination === '~') ? (lookup === 'unavailable' ? 2 : 1) : 0);
  await app.commands.run('file.save');
  const again = JSON.parse(await stored.get(canonical(offline.source.path)).text());
  expect(canonical(`${posix.dirname(offline.source.path)}/${again.sources[0].file}`)).toBe(mediaPath);
});
