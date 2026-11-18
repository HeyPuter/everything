import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { videoPool } from '../src/model/session-video.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { INSERT_HOOKS, insertDocs } from '../src/multitrack/insert.js';
import { insertVideoHook, setVideoOfDoc } from '../src/video/media.js';
import { prepareSessionZip } from '../src/multitrack/storage.js';
import { unzipStore } from '../src/lib/zip.js';
import { confirmSessionSave } from './helpers/session-save.js';

let hooks;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  hooks = INSERT_HOOKS.length;
  INSERT_HOOKS.push(insertVideoHook);
});
afterEach(() => {
  INSERT_HOOKS.length = hooks;
  delete window.puter;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function setup() {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.prefs.set('autosave', false);
  installCoreCommands(app);
  app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
  const doc = app.addDocument(new Session({ name: 'Film.asesx', sampleRate: 8000, tracks: 1, source: { type: 'puter', path: '/u/Film.asesx' } }));
  const stored = new Map();
  const writes = [];
  window.puter = { auth: { isSignedIn: () => true }, fs: { stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; }, write: async (path, blob) => { stored.set(path, blob); writes.push(path); return {}; } } };
  return { app, doc, stored, writes };
}
async function insert(app, doc, bytes, path = null) {
  const audio = new AudioFile({ name: 'Scene.webm', sampleRate: 8000, channels: [Channel.fromSamples(new Float32Array(32).fill(0.25))] });
  const blob = new Blob([new Uint8Array(bytes)], { type: 'video/webm' });
  setVideoOfDoc(audio, { blob, name: 'Scene.webm', mime: blob.type, width: 320, height: 180, duration: 0.004, fps: 25, path });
  const replacing = Boolean(doc.state.video);
  const pending = insertDocs(app, doc, [audio], { at: 0 });
  if (replacing) {
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull(), { interval: 1 });
    [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Replace').click();
  }
  await pending;
  return { blob, id: doc.state.video.sourceId, state: doc.state };
}
const videoPath = (manifest) => manifest.video.path || `/u/${manifest.video.file}`;
const bytesAt = async (stored, path) => [...new Uint8Array(await stored.get(path).arrayBuffer())];

it.each(['saved', 'video failure', 'manifest failure'])('preserves an earlier same-named video when replacement save is %s', async (outcome) => {
  const { app, doc, stored, writes } = setup();
  const first = await insert(app, doc, [1, 2, 3, 4]);
  await app.commands.run('file.save');
  const previousManifest = stored.get('/u/Film.asesx');
  const firstPath = videoPath(JSON.parse(await previousManifest.text()));
  expect(await bytesAt(stored, firstPath)).toEqual([1, 2, 3, 4]);
  const second = await insert(app, doc, [5, 6, 7, 8]);
  const write = window.puter.fs.write;
  window.puter.fs.write = async (path, blob) => {
    if (outcome === 'manifest failure' && path === '/u/Film.asesx') throw new Error('Manifest failed');
    const result = await write(path, blob);
    if (outcome === 'video failure' && path.endsWith('.webm')) throw new Error('Video failed after writing');
    return result;
  };
  await app.commands.run('file.save');
  expect.soft(await bytesAt(stored, firstPath)).toEqual([1, 2, 3, 4]);
  expect(doc.state === second.state).toBe(true);
  expect(doc.dirty).toBe(outcome !== 'saved');
  expect(app.notify).toHaveBeenCalledTimes(outcome === 'saved' ? 0 : 1);
  if (outcome !== 'saved') expect(stored.get('/u/Film.asesx') === previousManifest).toBe(true);
  window.puter.fs.write = write;
  await app.commands.run('file.save');
  const latest = JSON.parse(await stored.get('/u/Film.asesx').text());
  expect(await bytesAt(stored, videoPath(latest))).toEqual([5, 6, 7, 8]);
  expect(latest.video.id).toBe(second.id);
  expect(doc.dirty).toBe(false);
  await app.commands.run('edit.undo');
  expect(doc.state === first.state).toBe(true);
  await app.commands.run('file.save');
  const undone = JSON.parse(await stored.get('/u/Film.asesx').text());
  expect(undone.video.id).toBe(first.id);
  expect.soft(await bytesAt(stored, videoPath(undone))).toEqual([1, 2, 3, 4]);
  expect(videoPool(doc).get(first.id).path).toBe(firstPath);
  await app.commands.run('edit.redo');
  expect(doc.state === second.state).toBe(true);
  await app.commands.run('file.save');
  const redone = JSON.parse(await stored.get('/u/Film.asesx').text());
  expect(await bytesAt(stored, videoPath(redone))).toEqual([5, 6, 7, 8]);
  const before = writes.length;
  await app.commands.run('file.save');
  expect(writes.slice(before)).toEqual(['/u/Film.asesx']);
});

it.each(['saveAs', 'saveCopy'])('keeps a local video and its ZIP intact through %s', async (command) => {
  const { app, doc, stored } = setup();
  const video = await insert(app, doc, [1, 2, 3, 4]);
  const savedState = doc.savedState;
  const existingPath = '/u/Other_Media/Scene.webm';
  stored.set(existingPath, new Blob([new Uint8Array([9, 9, 9, 9])]));
  const saving = app.commands.run(`file.${command}`);
  await confirmSessionSave('Other.asesx');
  await saving;
  const exported = JSON.parse(await stored.get('/u/Other.asesx').text());
  const exportedPath = videoPath(exported);
  expect(await bytesAt(stored, exportedPath)).toEqual([1, 2, 3, 4]);
  expect(await bytesAt(stored, existingPath)).toEqual([9, 9, 9, 9]);
  expect(doc.source.path).toBe(command === 'saveAs' ? '/u/Other.asesx' : '/u/Film.asesx');
  expect(doc.savedState === (command === 'saveAs' ? video.state : savedState)).toBe(true);
  expect(videoPool(doc).get(video.id).path).toBe(command === 'saveAs' ? exportedPath : null);
  const zip = await prepareSessionZip(doc);
  const files = unzipStore(await zip.blob.arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(files.get(zip.fileName.replace(/\.zip$/, '.asesx'))));
  expect(manifest.video.file).toBe(`${doc.name.replace(/\.asesx$/, '')}_Media/Scene.webm`);
  expect([...files.get(manifest.video.file)]).toEqual([1, 2, 3, 4]);
  await app.commands.run('file.save');
  const current = JSON.parse(await stored.get(doc.source.path).text());
  expect(await bytesAt(stored, videoPath(current))).toEqual([1, 2, 3, 4]);
  expect(await bytesAt(stored, exportedPath)).toEqual([1, 2, 3, 4]);
  expect(app.notify).not.toHaveBeenCalled();
});

it('keeps an existing cloud video as a reference without uploading it again', async () => {
  const { app, doc, stored, writes } = setup();
  const path = '/u/Videos/Scene.webm';
  const video = await insert(app, doc, [1, 2, 3, 4], path);
  stored.set(path, video.blob);
  await app.commands.run('file.save');
  const saved = JSON.parse(await stored.get('/u/Film.asesx').text());
  expect(saved.video.path).toBe(path);
  expect(saved.video.file).toBeUndefined();
  expect(writes.some((p) => p.endsWith('.webm'))).toBe(false);
  expect(await bytesAt(stored, path)).toEqual([1, 2, 3, 4]);
  expect(doc.dirty).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
});

it('keeps both videos when Undo runs during a replacement upload', async () => {
  const { app, doc, stored } = setup();
  const first = await insert(app, doc, [1, 2, 3, 4]);
  await app.commands.run('file.save');
  const firstPath = videoPool(doc).get(first.id).path;
  const second = await insert(app, doc, [5, 6, 7, 8]);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let uploading = false;
  const write = window.puter.fs.write;
  window.puter.fs.write = async (path, blob) => {
    if (path.endsWith('.webm')) { uploading = true; await wait; }
    return write(path, blob);
  };
  const saving = app.commands.run('file.save');
  await vi.waitFor(() => expect(uploading).toBe(true), { interval: 1 });
  await app.commands.run('edit.undo');
  release();
  await saving;
  expect(doc.state === first.state).toBe(true);
  expect(doc.savedState === second.state).toBe(true);
  expect(doc.dirty).toBe(true);
  expect(await bytesAt(stored, firstPath)).toEqual([1, 2, 3, 4]);
  expect(await bytesAt(stored, videoPool(doc).get(second.id).path)).toEqual([5, 6, 7, 8]);
  await app.commands.run('file.save');
  const current = JSON.parse(await stored.get('/u/Film.asesx').text());
  expect(current.video.id).toBe(first.id);
  expect(await bytesAt(stored, videoPath(current))).toEqual([1, 2, 3, 4]);
  expect(doc.dirty).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
});
