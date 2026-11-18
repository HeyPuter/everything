import fs from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { serializeSession } from '../src/model/session-io.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrack } from '../src/features/multitrack.js';
import { sessionFromText } from '../src/multitrack/storage.js';
import { encodeWav, parseWav } from '../src/audio/wav.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { addVideoSource, setVideoClip } from '../src/model/session-video.js';
import { unzipStore } from '../src/lib/zip.js';

beforeEach(async () => {
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
  localStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { delete window.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });
async function setup() {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.prefs.set('autosave', false);
  installCoreCommands(app);
  installMultitrack(app);
  const template = new Session({ name: 'Song.asesx', sampleRate: 8000, tracks: 1 });
  const sourceId = template.addSource({ name: 'Take.wav', channels: [Channel.fromSamples(new Float32Array(32).fill(0.25))] });
  template.apply('Insert', addClips(template.state, [createClip({ sourceId, trackId: template.state.tracks[0].id, length: 32 })]));
  const data = serializeSession(template);
  const stored = new Map([['/u/Song.asesx', new Blob([data.text])]]);
  for (const m of data.media) stored.set(`/u/${m.file}`, encodeWav({ channels: m.channels, sampleRate: m.sampleRate, bitDepth: 32, float: true }));
  window.puter = { auth: { isSignedIn: () => true }, fs: { write: async (path, blob) => { stored.set(path, blob); return {}; } } };
  const doc = await sessionFromText(app, data.text, 'Song.asesx', { type: 'puter', path: '/u/Song.asesx' }, (src) => stored.get(`/u/${src.file}`));
  app.addDocument(doc);
  const wave = app.documents.find((d) => d.id === doc.pool.get(sourceId).docId);
  return { app, doc, wave, stored, sourceId };
}
const pcm = (doc) => [...doc.pool.get(doc.state.clips[0].sourceId).channels[0].toArray()];
async function diskPcm(stored) {
  const data = JSON.parse(await stored.get('/u/Song.asesx').text());
  return [...parseWav(await stored.get(`/u/${data.sources[0].file}`).arrayBuffer()).channels[0]];
}

it.each(['saved', 'failed'])('tracks linked waveform Undo during a session upload that is %s', async (outcome) => {
  const { app, doc, wave, stored } = await setup();
  app.activate(wave);
  await app.commands.run('fx.invert');
  await vi.waitFor(() => expect(pcm(doc)).toEqual(Array(32).fill(-0.25)), { interval: 1 });
  let release;
  let writing = false;
  const wait = new Promise((resolve) => { release = resolve; });
  const write = window.puter.fs.write;
  window.puter.fs.write = async (path, blob) => {
    if (path === '/u/Song.asesx') { writing = true; await wait; if (outcome === 'failed') throw new Error('Upload failed'); }
    return write(path, blob);
  };
  app.activate(doc);
  const saving = app.commands.run('file.save');
  await vi.waitFor(() => expect(writing).toBe(true), { interval: 1 });
  app.activate(wave);
  await app.commands.run('edit.undo');
  await vi.waitFor(() => expect(pcm(doc)).toEqual(Array(32).fill(0.25)), { interval: 1 });
  release();
  await saving;
  expect(await diskPcm(stored)).toEqual(Array(32).fill(outcome === 'saved' ? -0.25 : 0.25));
  expect(wave.dirty).toBe(false);
  expect.soft(doc.dirty).toBe(outcome === 'saved');
  expect(pcm(doc)).toEqual(Array(32).fill(0.25));
  if (outcome === 'saved') {
    const closing = app.closeDocument(doc);
    await vi.waitFor(() => expect(document.querySelector('.dialog-foot button[data-value="save"]')).not.toBeNull(), { interval: 1 });
    document.querySelector('.dialog-foot button[data-value="null"]').click();
    expect(await closing).toBe(false);
    expect(app.documents).toContain(doc);
  }
  window.puter.fs.write = write;
  app.activate(doc);
  await app.commands.run('file.save');
  expect(await diskPcm(stored)).toEqual(Array(32).fill(0.25));
  expect(doc.dirty).toBe(false);
  expect(app.notify).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
});

it('recognizes linked waveform Undo back to the initially loaded audio', async () => {
  const { app, doc, wave } = await setup();
  expect(doc.dirty).toBe(false);
  app.activate(wave);
  await app.commands.run('fx.invert');
  await vi.waitFor(() => expect(pcm(doc)).toEqual(Array(32).fill(-0.25)), { interval: 1 });
  expect(doc.dirty).toBe(true);
  await app.commands.run('edit.undo');
  await vi.waitFor(() => expect(pcm(doc)).toEqual(Array(32).fill(0.25)), { interval: 1 });
  expect(doc.dirty).toBe(false);
  expect(wave.dirty).toBe(false);
});

it('reverts saved source audio without changing the linked waveform or its history', async () => {
  const { app, doc, wave } = await setup();
  app.activate(wave);
  await app.commands.run('fx.invert');
  await vi.waitFor(() => expect(pcm(doc)).toEqual(Array(32).fill(-0.25)), { interval: 1 });
  app.activate(doc);
  await app.commands.run('file.save');
  app.activate(wave);
  await app.commands.run('edit.undo');
  await vi.waitFor(() => expect(pcm(doc)).toEqual(Array(32).fill(0.25)), { interval: 1 });
  const original = doc.state;
  const waveState = wave.state;
  expect(doc.dirty).toBe(true);
  app.activate(doc);
  const reverting = app.commands.run('file.revert');
  await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Revert')).toBe(true), { interval: 1 });
  [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Revert').click();
  await reverting;
  expect(pcm(doc)).toEqual(Array(32).fill(-0.25));
  expect(doc.dirty).toBe(false);
  expect(wave.state).toBe(waveState);
  expect(wave.dirty).toBe(false);
  await app.commands.run('edit.undo');
  expect(doc.state).toBe(original);
  expect(pcm(doc)).toEqual(Array(32).fill(0.25));
  expect(doc.dirty).toBe(true);
  await app.commands.run('edit.redo');
  expect(doc.dirty).toBe(false);
  app.activate(wave);
  await app.commands.run('edit.redo');
  await vi.waitFor(() => expect([...wave.state.channels[0].toArray()]).toEqual(Array(32).fill(-0.25)), { interval: 1 });
  // The restored snapshot is independent of further changes to its old link.
  expect(pcm(doc)).toEqual(Array(32).fill(-0.25));
  expect(doc.dirty).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
});

it.each(['save', 'saveCopy'])('local %s tracks the audio captured before asynchronous ZIP preparation', async (command) => {
  const { app, doc, wave } = await setup();
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'video/webm' });
  const videoId = addVideoSource(doc, { name: 'Scene.webm', blob, duration: 0.004 });
  doc.apply('Video', setVideoClip(doc.state, { sourceId: videoId, length: 32 }));
  await app.commands.run('file.save');
  delete window.puter;
  const downloads = [];
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(value) { downloads.push(value); return 'blob:session-linked-test'; }
    static revokeObjectURL() {}
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  app.activate(wave);
  await app.commands.run('fx.invert');
  await vi.waitFor(() => expect(pcm(doc)).toEqual(Array(32).fill(-0.25)), { interval: 1 });
  let release;
  let reading = false;
  const wait = new Promise((resolve) => { release = resolve; });
  const read = blob.arrayBuffer.bind(blob);
  vi.spyOn(blob, 'arrayBuffer').mockImplementation(async () => { const bytes = await read(); reading = true; await wait; return bytes; });
  app.activate(doc);
  const saving = app.commands.run(`file.${command}`);
  await vi.waitFor(() => expect(reading).toBe(true), { interval: 1 });
  app.activate(wave);
  await app.commands.run('edit.undo');
  await vi.waitFor(() => expect(pcm(doc)).toEqual(Array(32).fill(0.25)), { interval: 1 });
  release();
  await saving;
  const files = unzipStore(await downloads[0].arrayBuffer());
  const manifest = JSON.parse(new TextDecoder().decode(files.get('Song.asesx')));
  expect([...parseWav(files.get(manifest.sources[0].file).slice().buffer).channels[0]]).toEqual(Array(32).fill(-0.25));
  expect(pcm(doc)).toEqual(Array(32).fill(0.25));
  expect(doc.dirty).toBe(command === 'save');
  expect(wave.dirty).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
});
