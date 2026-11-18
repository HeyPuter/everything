import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { addVideoSource, setVideoClip, videoPool } from '../src/model/session-video.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { parseWav } from '../src/audio/wav.js';
import { confirmSessionSave } from './helpers/session-save.js';

beforeEach(() => { localStorage.clear(); vi.stubGlobal('Blob', NodeBlob); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { delete window.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });
function setup() {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const stored = new Map();
  const writes = [];
  window.puter = { auth: { isSignedIn: () => true }, fs: {
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(path, blob); writes.push(path); return { path }; },
  } };
  return { app, stored, writes };
}
function session(app, name, value, bytes) {
  const doc = app.addDocument(new Session({ name: `${name}.asesx`, sampleRate: 8000, tracks: 1, source: { type: 'puter', path: `/u/${name}.asesx` } }));
  // Source ids belong to their files: two independently loaded sessions can
  // use the same ids for different audio and video.
  const sourceId = doc.addSource({ id: 'shared-audio', name: 'Take.wav', channels: [Channel.fromSamples(new Float32Array(32).fill(value))] });
  const clip = createClip({ id: 'shared-clip', trackId: doc.state.tracks[0].id, sourceId, start: 0, length: 32 });
  const videoId = addVideoSource(doc, { id: 'shared-video', name: 'Scene.webm', mime: 'video/webm', blob: new Blob([new Uint8Array(bytes)], { type: 'video/webm' }), duration: 0.004, width: 16, height: 16 });
  doc.apply('Insert', setVideoClip(addClips(doc.state, [clip]), { sourceId: videoId, length: 32 }));
  return doc;
}
const pcm = (doc, state = doc.state) => [...doc.pool.get(state.clips[0].sourceId).channels[0].toArray()];
const videoBytes = async (doc, state = doc.state) => [...new Uint8Array(await videoPool(doc).get(state.video.sourceId).blob.arrayBuffer())];
async function revert(app) {
  const pending = app.commands.run('file.revert');
  await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Revert')).toBe(true), { interval: 1 });
  [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Revert').click();
  await pending;
}

it.each(['saveAs', 'saveCopy'].flatMap((command) => ['saved', 'failed'].map((outcome) => [command, outcome])))('%s updates another open session’s saved media only when %s', async (command, outcome) => {
  const { app, stored } = setup();
  const target = session(app, 'Target', 0.25, [1, 2, 3, 4]);
  await app.commands.run('file.save');
  const original = target.state;
  const originalPool = target.pool.get('shared-audio');
  const originalVideo = videoPool(target).get('shared-video');
  const writer = session(app, 'Other', -0.5, [5, 6, 7, 8]);
  const write = window.puter.fs.write;
  if (outcome === 'failed') window.puter.fs.write = async (path, blob) => { if (path === '/u/Target.asesx') throw new Error('Manifest failed'); return write(path, blob); };
  const pending = app.commands.run(`file.${command}`);
  await confirmSessionSave('Target.asesx', { replace: true });
  await pending;
  window.puter.fs.write = write;
  const disk = JSON.parse(await stored.get('/u/Target.asesx').text());
  const expected = outcome === 'saved' ? -0.5 : 0.25;
  expect([...parseWav(await stored.get(`/u/${disk.sources[0].file}`).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(expected));
  expect(target.state).toBe(original);
  expect(target.pool.get('shared-audio')).toBe(originalPool);
  expect(videoPool(target).get('shared-video')).toBe(originalVideo);
  expect(pcm(target)).toEqual(Array(32).fill(0.25));
  expect(await videoBytes(target)).toEqual([1, 2, 3, 4]);
  expect.soft(target.dirty).toBe(outcome === 'saved');
  expect.soft(pcm(target, target.savedState)).toEqual(Array(32).fill(expected));
  expect.soft(await videoBytes(target, target.savedState)).toEqual(outcome === 'saved' ? [5, 6, 7, 8] : [1, 2, 3, 4]);
  expect(app.active).toBe(writer);
  expect(app.notify).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
  if (outcome === 'failed') return;
  app.activate(target);
  // Enable the real Revert command even on the failing baseline.
  target.apply('Tempo', { ...target.state, tempo: 123 });
  const edited = target.state;
  await revert(app);
  expect.soft(pcm(target)).toEqual(Array(32).fill(-0.5));
  expect.soft(await videoBytes(target)).toEqual([5, 6, 7, 8]);
  expect(target.dirty).toBe(false);
  await app.commands.run('edit.undo');
  expect.soft(target.state).toBe(edited);
  expect(pcm(target)).toEqual(Array(32).fill(0.25));
  expect(await videoBytes(target)).toEqual([1, 2, 3, 4]);
  expect.soft(target.dirty).toBe(true);
  await app.commands.run('edit.redo');
  await app.commands.run('file.save');
  const resaved = JSON.parse(await stored.get('/u/Target.asesx').text());
  expect.soft([...parseWav(await stored.get(`/u/${resaved.sources[0].file}`).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(-0.5));
  expect(target.dirty).toBe(false);
});

it.each(['edited', 'moved', 'closed'])('preserves a destination session that is %s during upload', async (action) => {
  const { app } = setup();
  const target = session(app, 'Target', 0.25, [1, 2, 3, 4]);
  await app.commands.run('file.save');
  const original = target.state;
  const poolSize = target.pool.size;
  const videoSize = videoPool(target).size;
  session(app, 'Other', -0.5, [5, 6, 7, 8]);
  let release;
  let uploading = false;
  const wait = new Promise((resolve) => { release = resolve; });
  const write = window.puter.fs.write;
  window.puter.fs.write = async (path, blob) => {
    if (path === '/u/Target.asesx') { uploading = true; await wait; }
    return write(path, blob);
  };
  const pending = app.commands.run('file.saveCopy');
  await confirmSessionSave('Target.asesx', { replace: true });
  await vi.waitFor(() => expect(uploading).toBe(true), { interval: 1 });
  app.activate(target);
  if (action === 'edited') target.apply('Tempo', { ...target.state, tempo: 123 });
  else if (action === 'moved') {
    const moving = app.commands.run('file.saveAs');
    await confirmSessionSave('Moved.asesx');
    await moving;
  } else await app.closeDocument(target);
  const current = target.state;
  const active = app.active;
  release();
  await pending;
  expect(app.active).toBe(active);
  expect(target.state).toBe(current);
  expect(pcm(target)).toEqual(Array(32).fill(0.25));
  expect(await videoBytes(target)).toEqual([1, 2, 3, 4]);
  expect(target.dirty).toBe(action === 'edited');
  expect(target.source.path).toBe(action === 'moved' ? '/u/Moved.asesx' : '/u/Target.asesx');
  expect(app.documents.includes(target)).toBe(action !== 'closed');
  if (action === 'edited') {
    expect(pcm(target, target.savedState)).toEqual(Array(32).fill(-0.5));
    await app.commands.run('edit.undo');
    expect(target.state).toBe(original);
    expect(target.dirty).toBe(true);
  } else {
    expect(target.savedState).toBe(original);
    expect(target.pool.size).toBe(poolSize);
    expect(videoPool(target).size).toBe(videoSize);
  }
  expect(app.notify).not.toHaveBeenCalled();
});

it.each(['saveAs', 'saveCopy'])('retains auxiliary and offline sources through %s, Revert, repeated writes, and Save', async (command) => {
  const { app, stored, writes } = setup();
  const target = session(app, 'Target', 0.25, [1, 2, 3, 4]);
  await app.commands.run('file.save');
  const writer = session(app, 'Other', -0.5, [5, 6, 7, 8]);
  writer.apply('Rate', { ...writer.state, sampleRate: 16000 });
  for (const [id, value] of [['stretch-original', 0.125], ['remix-original', 0.25], ['duration-original', 0.375]]) {
    writer.addSource({ id, name: `${id}.wav`, channels: [Channel.fromSamples(new Float32Array(32).fill(value))], sampleRate: 16000 });
    // A colliding old source must not be overwritten, even if it isn't in the current timeline.
    target.addSource({ id, name: `${id}.wav`, channels: [Channel.fromSamples(new Float32Array(32).fill(-value))] });
  }
  const offline = writer.addSource({ id: 'offline', name: 'Offline.wav', channels: [], offline: true });
  Object.assign(writer.pool.get(offline), { frames: 100, channelCount: 1 });
  const clip = writer.state.clips[0];
  writer.apply('Original media', { ...writer.state, clips: [
    { ...clip, stretch: { sourceId: 'stretch-original', mode: 'rendered', ratio: 2 }, soundAssistant: { duration: { on: true, orig: { sourceId: 'duration-original', offset: 0, length: 32 } } } },
    createClip({ ...clip, id: 'remixed', start: 32, remix: { sourceId: 'remix-original', offset: 0, length: 32, segments: [[0, 32]], target: 32, xfade: 0 } }),
    createClip({ ...clip, id: 'offline-clip', sourceId: offline, start: 64 }),
  ] });
  // Persist the video once so repeated copies reuse an existing cloud reference.
  await app.commands.run('file.save');
  const writing = app.commands.run(`file.${command}`);
  await confirmSessionSave('Target.asesx', { replace: true });
  await writing;
  app.activate(target);
  await revert(app);
  expect(target.sampleRate).toBe(16000);
  expect(pcm(target)).toEqual(Array(32).fill(-0.5));
  const [stretched, remixed, missing] = target.state.clips;
  for (const [id, value] of [[stretched.stretch.sourceId, 0.125], [remixed.remix.sourceId, 0.25], [stretched.soundAssistant.duration.orig.sourceId, 0.375]]) {
    expect([...target.pool.get(id).channels[0].toArray()]).toEqual(Array(32).fill(value));
    expect(target.pool.get(id).sampleRate).toBe(16000);
  }
  expect(target.pool.get(missing.sourceId)).toMatchObject({ offline: true, channels: [], frames: 100, channelCount: 1 });
  expect([...target.pool.get('stretch-original').channels[0].toArray()]).toEqual(Array(32).fill(-0.125));
  expect(await videoBytes(target)).toEqual([5, 6, 7, 8]);
  const restored = target.state;
  const poolSize = target.pool.size;
  const videoSize = videoPool(target).size;
  app.activate(writer);
  const before = writes.length;
  const repeated = app.commands.run(`file.${command}`);
  await confirmSessionSave('Target.asesx', { replace: true });
  await repeated;
  expect(writes.slice(before)).toEqual(['/u/Target.asesx']);
  expect(target.savedState).toBe(restored);
  expect(target.dirty).toBe(false);
  expect(target.pool.size).toBe(poolSize);
  expect(videoPool(target).size).toBe(videoSize);
  app.activate(target);
  const beforeSave = writes.length;
  await app.commands.run('file.save');
  expect(writes.slice(beforeSave)).toEqual(['/u/Target.asesx']);
  const disk = JSON.parse(await stored.get('/u/Target.asesx').text());
  expect(disk.session.sampleRate).toBe(16000);
  const mapped = new Map(disk.sources.map((src) => [src.id, src]));
  for (const c of disk.session.clips) {
    expect(mapped.has(c.sourceId)).toBe(true);
    if (c.stretch) expect(mapped.has(c.stretch.sourceId)).toBe(true);
    if (c.remix) expect(mapped.has(c.remix.sourceId)).toBe(true);
    if (c.soundAssistant?.duration?.orig) expect(mapped.has(c.soundAssistant.duration.orig.sourceId)).toBe(true);
  }
  const audio = mapped.get(disk.session.clips[0].sourceId);
  expect(parseWav(await stored.get(`/u/${audio.file}`).arrayBuffer()).sampleRate).toBe(16000);
  expect(target.dirty).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
});

it('keeps edited imported media intact when the original writer saves again', async () => {
  const { app } = setup();
  const target = session(app, 'Target', 0.25, [1, 2, 3, 4]);
  await app.commands.run('file.save');
  const writer = session(app, 'Other', -0.5, [5, 6, 7, 8]);
  const first = app.commands.run('file.saveAs');
  await confirmSessionSave('Target.asesx', { replace: true });
  await first;
  app.activate(target);
  await revert(app);
  const importedId = target.state.clips[0].sourceId;
  target.updateSource(importedId, { channels: [Channel.fromSamples(new Float32Array(32).fill(0.75))], docId: 'edited-waveform' });
  target.apply('Tempo', { ...target.state, tempo: 123 });
  const edited = target.state;
  app.activate(writer);
  await app.commands.run('file.save');
  expect(target.state).toBe(edited);
  expect(pcm(target)).toEqual(Array(32).fill(0.75));
  expect(pcm(target, target.savedState)).toEqual(Array(32).fill(-0.5));
  expect(target.savedState.clips[0].sourceId).not.toBe(importedId);
  expect(target.dirty).toBe(true);
  app.activate(target);
  await revert(app);
  expect(pcm(target)).toEqual(Array(32).fill(-0.5));
  await app.commands.run('edit.undo');
  expect(target.state).toBe(edited);
  expect(pcm(target)).toEqual(Array(32).fill(0.75));
  expect(target.dirty).toBe(true);
});

it('reverts to a replacement without video while Undo retains the original video', async () => {
  const { app } = setup();
  const target = session(app, 'Target', 0.25, [1, 2, 3, 4]);
  await app.commands.run('file.save');
  const original = target.state;
  const writer = session(app, 'Other', -0.5, [5, 6, 7, 8]);
  writer.apply('Remove video', setVideoClip(writer.state, null));
  const copying = app.commands.run('file.saveCopy');
  await confirmSessionSave('Target.asesx', { replace: true });
  await copying;
  expect(target.state).toBe(original);
  expect(target.savedState.video).toBeUndefined();
  app.activate(target);
  await revert(app);
  expect(target.state.video).toBeUndefined();
  expect(pcm(target)).toEqual(Array(32).fill(-0.5));
  expect(target.dirty).toBe(false);
  await app.commands.run('edit.undo');
  expect(target.state).toBe(original);
  expect(await videoBytes(target)).toEqual([1, 2, 3, 4]);
  expect(target.dirty).toBe(true);
});

it.each(['save', 'saveAs', 'saveCopy'].flatMap((command) => ['saved', 'failed'].map((outcome) => [command, outcome])))('orders %s from another tab after an older destination write is %s', async (command, outcome) => {
  const { app, stored } = setup();
  const first = session(app, 'Target', 0.25, [1, 2, 3, 4]);
  await app.commands.run('file.save');
  const second = session(app, 'Other', -0.5, [5, 6, 7, 8]);
  if (command === 'save') {
    const associating = app.commands.run('file.saveAs');
    await confirmSessionSave('Target.asesx', { replace: true });
    await associating;
  }
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const write = window.puter.fs.write;
  let attempts = 0;
  window.puter.fs.write = async (path, blob) => {
    if (path === '/u/Target.asesx' && ++attempts === 1) {
      await wait;
      if (outcome === 'failed') throw new Error('Older save failed');
    }
    return write(path, blob);
  };
  app.activate(first);
  const older = app.commands.run('file.save');
  await vi.waitFor(() => expect(attempts).toBe(1), { interval: 1 });
  app.activate(second);
  const newer = app.commands.run(`file.${command}`);
  if (command !== 'save') await confirmSessionSave('Target.asesx', { replace: true });
  // Another destination remains independent while the shared path is held.
  const third = session(app, 'Third', 0.75, [9, 10, 11, 12]);
  await app.commands.run('file.save');
  expect(stored.has('/u/Third.asesx')).toBe(true);
  expect(third.dirty).toBe(false);
  expect.soft(attempts).toBe(1);
  release();
  await Promise.all([older, newer]);
  expect(attempts).toBe(2);
  const disk = JSON.parse(await stored.get('/u/Target.asesx').text());
  expect.soft([...parseWav(await stored.get(`/u/${disk.sources[0].file}`).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(-0.5));
  const video = stored.get(disk.video.path || `/u/${disk.video.file}`);
  expect.soft([...new Uint8Array(await video.arrayBuffer())]).toEqual([5, 6, 7, 8]);
  expect.soft(second.dirty).toBe(command === 'saveCopy');
  expect.soft(first.dirty).toBe(true);
  expect.soft(pcm(first, first.savedState)).toEqual(Array(32).fill(-0.5));
  expect(app.active).toBe(third);
  expect(app.notify).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
});

it.each(['stretcher', 'remixer'].flatMap((kind) => ['saved', 'failed'].map((outcome) => [kind, outcome])))('reserves the destination while an earlier %s is %s', async (kind, outcome) => {
  const { app, stored } = setup();
  const first = session(app, 'Target', 0.25, [1, 2, 3, 4]);
  await app.commands.run('file.save');
  const second = session(app, 'Other', -0.5, [5, 6, 7, 8]);
  const associating = app.commands.run('file.saveAs');
  await confirmSessionSave('Target.asesx', { replace: true });
  await associating;
  let release, fail;
  const wait = new Promise((resolve, reject) => { release = resolve; fail = reject; });
  first[kind] = { busy: true, whenIdle: vi.fn(() => wait) };
  const write = window.puter.fs.write;
  let attempts = 0;
  window.puter.fs.write = async (path, blob) => {
    if (path === '/u/Target.asesx') attempts++;
    return write(path, blob);
  };
  app.activate(first);
  const older = app.commands.run('file.save');
  await vi.waitFor(() => expect(first[kind].whenIdle).toHaveBeenCalledOnce(), { interval: 1 });
  app.activate(second);
  const newer = app.commands.run('file.save');
  session(app, 'Third', 0.75, [9, 10, 11, 12]);
  await app.commands.run('file.save');
  expect(stored.has('/u/Third.asesx')).toBe(true);
  expect.soft(attempts).toBe(0);
  first[kind].busy = false;
  if (outcome === 'failed') fail(new Error('Media preparation failed'));
  else release();
  await Promise.all([older, newer]);
  expect(attempts).toBe(outcome === 'failed' ? 1 : 2);
  const disk = JSON.parse(await stored.get('/u/Target.asesx').text());
  expect.soft([...parseWav(await stored.get(`/u/${disk.sources[0].file}`).arrayBuffer()).channels[0]]).toEqual(Array(32).fill(-0.5));
  expect.soft(second.dirty).toBe(false);
  expect(app.notify).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
});
