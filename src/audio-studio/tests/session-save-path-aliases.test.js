import { setImmediate } from 'node:timers/promises';
import { posix } from 'node:path';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { sessionFromText } from '../src/multitrack/storage.js';
import { Channel } from '../src/audio/channel.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { parseWav } from '../src/audio/wav.js';
import { confirmSessionSave } from './helpers/session-save.js';

beforeEach(() => { localStorage.clear(); vi.stubGlobal('Blob', NodeBlob); });
afterEach(() => { delete window.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });
const canonical = (path) => posix.normalize(path.replace(/^~(?=\/|$)/, '/u'));
const pcm = (doc, state = doc.state) => [...doc.pool.get(state.clips[0].sourceId).channels[0].toArray()];
function session(app, path, value) {
  const doc = app.addDocument(new Session({ name: posix.basename(path), sampleRate: 8000, tracks: 1, source: { type: 'puter', path } }));
  const sourceId = doc.addSource({ id: 'same-id', name: 'Take.wav', channels: [Channel.fromSamples(new Float32Array(32).fill(value))] });
  doc.apply('Clip', addClips(doc.state, [createClip({ sourceId, trackId: doc.state.tracks[0].id, length: 32 })]));
  return doc;
}
const pairs = [['~/Song.asesx', '/u/Song.asesx'], ['/u/Song.asesx', '~/Song.asesx'], ['/u/Folder/../Song.asesx', '/u/Song.asesx']];
it.each(pairs.flatMap(([first, second]) => ['upload', 'preparation', ...(first.includes('~') || second.includes('~') ? ['lookup'] : [])].flatMap((phase) => ['saved', 'failed'].map((outcome) => [first, second, phase, outcome]))))('orders %s and %s during %s when the older save is %s', async (firstPath, secondPath, phase, outcome) => {
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn();
  installCoreCommands(app); app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const stored = new Map(), writes = [];
  let gate = false, holdLookup = false, waiting = false, release;
  const wait = new Promise((resolve) => { release = resolve; });
  window.puter = { auth: { isSignedIn: () => true, getUser: async () => { if (holdLookup) { holdLookup = false; waiting = true; await wait; if (outcome === 'failed') throw new Error('Lookup failed'); } return { username: 'u' }; } }, fs: {
    write: async (path, blob) => {
      writes.push(path);
      if (gate && path === firstPath) { gate = false; waiting = true; await wait; if (outcome === 'failed') throw new Error('Upload failed'); }
      stored.set(canonical(path), blob); return { path: canonical(path) };
    },
  } };
  const first = session(app, firstPath, 0.25);
  await app.commands.run('file.save');
  const second = session(app, secondPath, -0.5);
  app.activate(first); first.apply('Tempo', { ...first.state, tempo: 125 });
  const firstState = first.state, secondState = second.state;
  gate = phase === 'upload';
  holdLookup = phase === 'lookup';
  if (phase === 'preparation') first.stretcher = { busy: true, whenIdle: async () => { first.stretcher.busy = false; waiting = true; await wait; if (outcome === 'failed') throw new Error('Preparation failed'); } };
  const savingFirst = app.commands.run('file.save');
  await vi.waitFor(() => expect(waiting).toBe(true), { interval: 1 });
  app.activate(second);
  const savingSecond = app.commands.run('file.save');
  try {
    await setImmediate();
    const independent = session(app, '/v/Song.asesx', 0.125);
    await app.commands.run('file.save');
    expect(independent.dirty).toBe(false);
    release(); await Promise.all([savingFirst, savingSecond]);
    const disk = JSON.parse(await stored.get('/u/Song.asesx').text());
    const media = parseWav(await stored.get(canonical(`/u/${disk.sources[0].file}`)).arrayBuffer());
    expect.soft([...media.channels[0]]).toEqual(Array(32).fill(-0.5));
    expect.soft(first.dirty).toBe(true);
    expect.soft(second.dirty).toBe(false);
    expect(first.state).toBe(firstState); expect(second.state).toBe(secondState);
    expect(pcm(first)).toEqual(Array(32).fill(0.25));
    expect.soft(pcm(first, first.savedState)).toEqual(Array(32).fill(-0.5));
    expect(pcm(second)).toEqual(Array(32).fill(-0.5));
    expect(app.active).toBe(independent);
    expect(app.notify).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
    app.activate(first);
    const reverting = app.commands.run('file.revert');
    await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Revert')).toBe(true), { interval: 1 });
    [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Revert').click(); await reverting;
    expect(pcm(first)).toEqual(Array(32).fill(-0.5));
    const before = writes.length;
    await app.commands.run('file.save');
    expect(writes.slice(before)).toEqual([firstPath]);
  } finally { release(); await Promise.all([savingFirst, savingSecond]); }
});

it.each(['saveAs', 'saveCopy'])('recognizes the associated file through an alias in %s and later saves', async (command) => {
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn();
  installCoreCommands(app); app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const stored = new Map(), writes = [];
  window.puter = { auth: { isSignedIn: () => true, getUser: async () => ({ username: 'u' }) }, fs: {
    stat: async (path) => { if (stored.has(canonical(path))) return { path: canonical(path) }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { writes.push(path); stored.set(canonical(path), blob); return { path: canonical(path) }; },
  } };
  const doc = session(app, '/u/Song.asesx', 0.25);
  await app.commands.run('file.save');
  doc.apply('Tempo', { ...doc.state, tempo: 125 });
  const before = writes.length;
  const saving = app.commands.run(`file.${command}`);
  await confirmSessionSave('Song.asesx', { folder: '~', replace: true }); await saving;
  expect(doc.dirty).toBe(false);
  expect(writes.slice(before)).toEqual(['~/Song.asesx']);
  expect(JSON.parse(await stored.get('/u/Song.asesx').text()).session.tempo).toBe(125);
  await app.commands.run('edit.undo'); expect(doc.dirty).toBe(true);
  await app.commands.run('edit.redo'); expect(doc.dirty).toBe(false);
  const again = writes.length;
  await app.commands.run('file.save');
  expect(writes.slice(again)).toEqual([doc.source.path]);
  expect(pcm(doc)).toEqual(Array(32).fill(0.25));
  expect(app.notify).not.toHaveBeenCalled();
});


it.each(pairs.slice(0, 2).flatMap(([first, second]) => ['available', 'unavailable', 'upload-failed'].map((lookup) => [first, second, lookup])))('finishes a committed save to %s when %s opens during upload and lookup is %s', async (firstPath, secondPath, lookup) => {
  const app = new App(); app.syncGraph = vi.fn(); app.notify = vi.fn();
  installCoreCommands(app); app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const stored = new Map(), writes = [];
  let gate = false, waiting = false, release, failLookup = false;
  const wait = new Promise((resolve) => { release = resolve; });
  window.puter = { auth: { isSignedIn: () => true, getUser: async () => {
    if (failLookup) throw new Error('Account lookup unavailable');
    return { username: 'u' };
  } }, fs: { write: async (path, blob) => {
    writes.push(path);
    if (gate && path === firstPath) { gate = false; waiting = true; await wait; if (lookup === 'upload-failed') throw new Error('Upload failed'); }
    stored.set(canonical(path), blob); return { path: canonical(path) };
  } } };
  const first = session(app, firstPath, 0.25);
  await app.commands.run('file.save');
  const originalText = await stored.get('/u/Song.asesx').text();
  const replacement = first.addSource({ name: 'New.wav', channels: [Channel.fromSamples(new Float32Array(32).fill(-0.5))] });
  first.apply('Replace audio', { ...first.state, clips: first.state.clips.map((c) => ({ ...c, sourceId: replacement })) });
  const firstState = first.state;
  gate = true;
  const saving = app.commands.run('file.save');
  await vi.waitFor(() => expect(waiting).toBe(true), { interval: 1 });
  try {
    const open = async (path) => app.addDocument(await sessionFromText(app, originalText, 'Song.asesx', { type: 'puter', path }, async (src) => stored.get(canonical(`/u/${src.file}`))));
    const alias = await open(secondPath), exact = await open(firstPath);
    const independent = session(app, firstPath.startsWith('~') ? '~/Else/Song.asesx' : '/v/Song.asesx', 0.125); independent.markSaved();
    const aliasState = alias.state, exactState = exact.state;
    expect(alias.dirty).toBe(false); expect(exact.dirty).toBe(false);
    failLookup = lookup === 'unavailable';
    release(); await saving;
    const disk = JSON.parse(await stored.get('/u/Song.asesx').text());
    if (lookup === 'upload-failed') {
      expect(await stored.get('/u/Song.asesx').text()).toBe(originalText);
      expect(first.dirty).toBe(true); expect(alias.dirty).toBe(false); expect(exact.dirty).toBe(false);
      expect(pcm(first, first.savedState)).toEqual(Array(32).fill(0.25));
      expect(first.state).toBe(firstState); expect(alias.state).toBe(aliasState); expect(exact.state).toBe(exactState);
      expect(app.notify).toHaveBeenCalledWith(expect.stringMatching(/could not be saved.*Upload failed/), { error: true });
      return;
    }
    expect([...parseWav(await stored.get(canonical(`/u/${disk.sources[0].file}`)).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(-0.5));
    expect.soft(first.dirty).toBe(false);
    expect.soft(alias.dirty).toBe(true);
    expect.soft(exact.dirty).toBe(true);
    expect(first.state).toBe(firstState); expect(alias.state).toBe(aliasState); expect(exact.state).toBe(exactState);
    expect(pcm(alias)).toEqual(Array(32).fill(0.25)); expect(pcm(exact)).toEqual(Array(32).fill(0.25));
    expect.soft(pcm(exact, exact.savedState)).toEqual(Array(32).fill(-0.5));
    expect(independent.dirty).toBe(false); expect(app.active).toBe(independent);
    app.activate(alias);
    if (failLookup) {
      expect(app.notify).toHaveBeenCalledWith(expect.stringMatching(/saved.*could not verify/i), { error: true });
      expect(app.commands.isEnabled('file.revert')).toBe(false);
      alias.revertToSaved(); expect(alias.state).toBe(aliasState);
      alias.apply('Tempo', { ...alias.state, tempo: 126 });
      await app.commands.run('edit.undo'); expect(alias.dirty).toBe(true);
      await app.commands.run('edit.redo'); expect(alias.dirty).toBe(true);
      failLookup = false;
      await app.commands.run('file.save');
      expect(alias.dirty).toBe(false); expect(first.dirty).toBe(true);
      expect(pcm(first, first.savedState)).toEqual(Array(32).fill(0.25));
      alias.apply('Tempo', { ...alias.state, tempo: 127 });
      expect(app.commands.isEnabled('file.revert')).toBe(true);
    } else {
      expect(app.notify).not.toHaveBeenCalled();
      const reverting = app.commands.run('file.revert');
      await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Revert')).toBe(true), { interval: 1 });
      [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Revert').click(); await reverting;
      expect(pcm(alias)).toEqual(Array(32).fill(-0.5));
      const before = writes.length;
      await app.commands.run('file.save');
      expect(writes.slice(before)).toEqual([secondPath]);
    }
  } finally { release(); await saving; }
});
