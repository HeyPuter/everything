import { posix } from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { sessionFromText, installSessionStorage } from '../src/multitrack/storage.js';
import { SessionBackupStore, installSessionBackup } from '../src/storage/session-backup.js';
import { openFiles, OPENERS, EXTRA_ACCEPT } from '../src/storage/files.js';
import { MemDir } from './helpers/mem-opfs.js';
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
it.each(['original', 'moved', 'moving'].flatMap((phase) => ['saveAs', 'saveCopy'].map((command) => [phase, command])))('recovers offline references when the session is %s before %s', async (phase, command) => {
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn();
  installCoreCommands(app); app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const stored = new Map(), writes = [];
  window.puter = { auth: { isSignedIn: () => true }, fs: {
    read: vi.fn(async (path) => stored.get(path)),
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(path, blob); writes.push(path); return { path }; },
  } };
  const originalPath = '/u/Song.asesx';
  const source = { type: 'puter', path: originalPath };
  const original = app.addDocument(new Session({ name: 'Song.asesx', sampleRate: 8000, tracks: 1, source }));
  const ids = [];
  for (const [i, value] of [0.25, -0.5].entries()) {
    const sourceId = original.addSource({ name: `Take ${i}.wav`, channels: [Channel.fromSamples(new Float32Array(32).fill(value))] });
    ids.push(sourceId);
    original.apply('Clip', addClips(original.state, [createClip({ sourceId, trackId: original.state.tracks[0].id, start: i * 32, length: 32 })]));
  }
  await app.commands.run('file.save');
  const text = await stored.get(originalPath).text();
  const first = JSON.parse(text).sources[0];
  const missingPath = `/u/${first.file}`;
  await app.closeDocument(original);
  const offline = await sessionFromText(app, text, 'Song.asesx', source, async (src) => src.id === ids[0] ? null : stored.get(`/u/${src.file}`));
  app.addDocument(offline);
  offline.apply('Tempo', { ...offline.state, tempo: 125 });
  const move = async () => {
    const saving = app.commands.run('file.saveAs');
    await confirmSessionSave('Copy.asesx', { folder: '/u/Moved' }); await saving;
  };
  if (phase === 'moved') await move();
  const expectedPath = offline.source.path;
  const root = new MemDir();
  const store = new SessionBackupStore(async () => root);
  const ctl = installSessionBackup(app, { store, tab: 'test' });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let checking = false;
  const hasMedia = store.hasMedia.bind(store);
  if (phase === 'moving') store.hasMedia = async (key) => { checking = true; await gate; return hasMedia(key); };
  const backingUp = ctl.backup(offline);
  try {
    if (phase === 'moving') {
      await vi.waitFor(() => expect(checking).toBe(true), { interval: 1 });
      await move(); release();
    }
    const manifest = await backingUp;
    expect.soft(manifest.source.path).toBe(expectedPath);
    expect(manifest.media).toHaveLength(1);
    const [persisted] = await ctl.list();
    expect(persisted).toEqual(manifest);
    const restored = await ctl.restore(persisted);
    expect(restored.dirty).toBe(true);
    expect.soft(restored.pool.get(ids[0]).path).toBe(missingPath);
    expect(restored.sourceLength(ids[0])).toBe(32);
    expect([...restored.pool.get(ids[1]).channels[0].toArray()]).toEqual(Array(32).fill(-0.5));
    expect(app.documents.find((d) => d.id === restored.pool.get(ids[1]).docId).source.type).toBe('local');
    const before = writes.length;
    const destination = '/u/Recovered/Final.asesx';
    const saving = app.commands.run(`file.${command}`);
    await confirmSessionSave('Final.asesx', { folder: '/u/Recovered' }); await saving;
    const saved = JSON.parse(await stored.get(destination).text());
    expect.soft(posix.resolve('/u/Recovered', saved.sources.find((s) => s.id === ids[0]).file)).toBe(missingPath);
    // The available backup audio must be uploaded; it isn't an already-saved cloud source.
    expect(writes.slice(before).filter((p) => p.endsWith('.wav'))).toHaveLength(1);
    expect(writes.slice(before)).not.toContain(missingPath);
    const reader = new App(); reader.syncGraph = vi.fn(); reader.notify = vi.fn();
    const [reopened] = await openFiles(reader, [{ name: 'Final.asesx', path: destination }]);
    for (const [i, value] of [0.25, -0.5].entries()) {
      expect.soft(reopened.pool.get(ids[i]).offline).toBe(false);
      expect.soft(reopened.pool.get(ids[i]).channels.map((c) => [...c.toArray()])).toEqual([Array(32).fill(value)]);
    }
    expect(reopened.state.tempo).toBe(125);
    expect.soft(reader.notify).not.toHaveBeenCalled();
    expect(restored.dirty).toBe(command === 'saveCopy');
    // Recovery remains stable through another backup, including the new
    // association after Save As and the old association after Save a Copy.
    const repeated = await ctl.backup(restored);
    const again = await ctl.restore((await ctl.list()).find((m) => m.key === repeated.key));
    expect(again.source.path).toBe(restored.source.path);
    expect(again.pool.get(ids[0]).path).toBe(missingPath);
    expect(again.sourceLength(ids[0])).toBe(32);
    expect([...again.pool.get(ids[1]).channels[0].toArray()]).toEqual(Array(32).fill(-0.5));
    // An unreadable backup payload has no known cloud equivalent: its ZIP
    // filename must not turn into a fabricated path beside the cloud session.
    store.readMedia = async () => { throw new Error('Backup media unavailable'); };
    const damaged = await ctl.restore(persisted);
    expect(damaged.pool.get(ids[0]).path).toBe(missingPath);
    expect(damaged.pool.get(ids[1])).toMatchObject({ offline: true, path: null, frames: 32 });
    const damagedBackup = await ctl.backup(damaged);
    const damagedAgain = await ctl.restore((await ctl.list()).find((m) => m.key === damagedBackup.key));
    expect(damagedAgain.pool.get(ids[0]).path).toBe(missingPath);
    expect(damagedAgain.pool.get(ids[1])).toMatchObject({ offline: true, path: null, frames: 32 });
    const legacy = { ...persisted };
    delete legacy.offlinePaths;
    const older = await ctl.restore(legacy);
    expect(older.pool.get(ids[0]).path).toBe(missingPath);
    expect(older.pool.get(ids[1]).path).toBeNull();
  } finally { release(); await backingUp; ctl.destroy(); }
});
