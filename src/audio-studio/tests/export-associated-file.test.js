import fs from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { createMarker } from '../src/model/markers.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installIo } from '../src/features/io.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { parseWav } from '../src/audio/wav.js';

// Exercise the real export source reads and WAV encoding with a 32-frame fixture.
vi.mock('../src/export/export-worker.js?worker', async () => {
  const { WavWriter } = await import('../src/export/pcm.js');
  return { default: class {
    postMessage(message) {
      if (message.type === 'start') {
        this.job = message.job;
        queueMicrotask(() => this.onmessage({ data: { type: 'need', at: 0, n: this.job.frames } }));
      } else if (message.type === 'chunk') {
        const writer = new WavWriter({ ...this.job.options, frames: this.job.frames, markers: this.job.markers, meta: this.job.meta });
        writer.write(message.channels, this.job.frames);
        this.onmessage({ data: { type: 'done', blob: writer.finish() } });
      }
    }
    terminate() {}
  } };
});
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
async function setup() {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.prefs.set('autosave', false);
  app.prefs.set('exportFolder', '/u');
  installCoreCommands(app);
  installIo(app);
  const markers = [createMarker({ start: 2, duration: 10, name: 'Outside', type: 'range' }), createMarker({ start: 10, duration: 20, name: 'Inside', type: 'range' })];
  const samples = Float32Array.from({ length: 32 }, (_, i) => (i + 1) / 64);
  const doc = app.addDocument(new AudioFile({ name: 'Source.wav', sampleRate: 8000, channels: [Channel.fromSamples(samples)], markers, meta: { title: 'Original' }, info: { bitDepth: 32 }, source: { type: 'puter', path: '/u/Source.wav' } }));
  const stored = new Map();
  window.puter = { auth: { isSignedIn: () => true }, fs: {
    stat: async (path) => { if (stored.has(path)) return { path }; throw { code: 'subject_does_not_exist' }; },
    write: async (path, blob) => { stored.set(path, blob); return { path }; },
  } };
  await app.commands.run('file.save');
  return { app, doc, stored, samples: [...samples] };
}
async function exporting(app, command, name = 'Source.wav', { bitDepth } = {}) {
  const pending = app.commands.run(`file.${command}`);
  await vi.waitFor(() => expect(document.querySelector('.io-export-dialog')).not.toBeNull(), { interval: 1 });
  const form = document.querySelector('.io-export-dialog');
  const input = form.querySelector('[aria-label="File name"]');
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  if (bitDepth) {
    form.querySelector('[aria-label="Change sample type"]').click();
    const depth = form.querySelector('[aria-label="Bit depth"]');
    depth.value = String(bitDepth);
    depth.dispatchEvent(new Event('change', { bubbles: true }));
    [...form.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
  }
  form.querySelector('.dialog-foot button[data-value="ok"]').click();
  if (name === 'Source.wav') {
    await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Replace')).toBe(true), { interval: 1 });
    [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Replace').click();
  }
  return { pending };
}
const pcm = (state) => [...state.channels[0].toArray()];

it.each(['saveCopy', 'exportFile', 'saveSelectionAs'].flatMap((command) => ['saved', 'failed', 'undo during upload'].map((outcome) => [command, outcome])))('%s tracks the associated file when its upload is %s', async (command, outcome) => {
  const { app, doc, stored, samples } = await setup();
  const original = doc.state;
  const source = doc.source;
  await app.commands.run('fx.invert');
  const changed = doc.state;
  doc.setSelection(8, 24);
  let release;
  let uploading = false;
  const wait = new Promise((resolve) => { release = resolve; });
  const write = window.puter.fs.write;
  window.puter.fs.write = async (path, blob) => {
    uploading = true;
    await wait;
    if (outcome === 'failed') throw new Error('Upload failed');
    return write(path, blob);
  };
  const { pending } = await exporting(app, command);
  await vi.waitFor(() => expect(uploading).toBe(true), { interval: 1 });
  if (outcome === 'undo during upload') await app.commands.run('edit.undo');
  release();
  await pending;
  const partial = command === 'saveSelectionAs';
  const output = outcome === 'failed' ? samples : (partial ? samples.slice(8, 24) : samples).map((x) => -x);
  const disk = parseWav(await stored.get('/u/Source.wav').arrayBuffer());
  expect([...disk.channels[0]]).toEqual(output);
  expect.soft(pcm(doc.savedState)).toEqual(output);
  expect(doc.state === (outcome === 'undo during upload' ? original : changed)).toBe(true);
  expect.soft(doc.dirty).toBe(outcome !== 'saved' || partial);
  expect(doc.source).toBe(source);
  expect(doc.name).toBe('Source.wav');
  if (outcome !== 'undo during upload') await app.commands.run('edit.undo');
  expect.soft(doc.dirty).toBe(outcome !== 'failed');
  await app.commands.run('edit.redo');
  expect.soft(doc.dirty).toBe(outcome === 'failed' || partial);
  if (partial && outcome !== 'failed') {
    const reverting = app.commands.run('file.revert');
    await vi.waitFor(() => expect([...document.querySelectorAll('.dialog-foot button')].some((b) => b.textContent === 'Revert')).toBe(true), { interval: 1 });
    [...document.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Revert').click();
    await reverting;
    expect.soft(pcm(doc.state)).toEqual(output);
    expect.soft(doc.state.markers).toMatchObject([{ name: 'Inside', start: 2, duration: 14 }]);
    expect(doc.dirty).toBe(false);
    await app.commands.run('edit.undo');
    expect.soft(doc.state === changed).toBe(true);
    expect.soft(doc.dirty).toBe(true);
  }
  expect(app.notify).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
  window.puter.fs.write = write;
  await app.commands.run('file.save');
  expect(doc.dirty).toBe(false);
  expect([...parseWav(await stored.get('/u/Source.wav').arrayBuffer()).channels[0]]).toEqual(pcm(doc.state));
});

it.each(['saveCopy', 'exportFile', 'saveSelectionAs'])('%s to another destination preserves the associated file and saved state', async (command) => {
  const { app, doc, stored } = await setup();
  const original = doc.state;
  const originalBlob = stored.get('/u/Source.wav');
  const info = doc.info;
  await app.commands.run('fx.invert');
  doc.setSelection(8, 24);
  const { pending } = await exporting(app, command, 'Other.wav');
  await pending;
  expect(doc.savedState).toBe(original);
  expect(doc.info).toBe(info);
  expect(doc.dirty).toBe(true);
  expect(stored.get('/u/Source.wav')).toBe(originalBlob);
  expect(stored.has('/u/Other.wav')).toBe(true);
  await app.commands.run('edit.undo');
  expect(doc.dirty).toBe(false);
});

it('treats a selection covering the whole file as its written state', async () => {
  const { app, doc } = await setup();
  await app.commands.run('fx.invert');
  const changed = doc.state;
  doc.setSelection(0, doc.length);
  const { pending } = await exporting(app, 'saveSelectionAs');
  await pending;
  expect(doc.savedState).toBe(changed);
  expect(doc.dirty).toBe(false);
  await app.commands.run('edit.undo');
  expect(doc.dirty).toBe(true);
  await app.commands.run('edit.redo');
  expect(doc.dirty).toBe(false);
});

it('keeps export settings for later Save when Export replaces the associated file', async () => {
  const { app, doc, stored } = await setup();
  await app.commands.run('fx.invert');
  const { pending } = await exporting(app, 'exportFile', 'Source.wav', { bitDepth: 16 });
  await pending;
  expect(parseWav(await stored.get('/u/Source.wav').arrayBuffer()).bitDepth).toBe(16);
  expect(doc.info.exportOptions).toMatchObject({ format: 'wav', bitDepth: 16, from: { sampleRate: 8000, channels: 1 } });
  expect(doc.info.size).toBe(stored.get('/u/Source.wav').size);
  expect(doc.dirty).toBe(false);
  await app.commands.run('fx.invert');
  await app.commands.run('file.save');
  expect(parseWav(await stored.get('/u/Source.wav').arrayBuffer()).bitDepth).toBe(16);
});

it('does not change saved state when Save As moves the document during a pending copy', async () => {
  const { app, doc, stored } = await setup();
  await app.commands.run('fx.invert');
  const copied = doc.state;
  let release;
  let uploading = false;
  const wait = new Promise((resolve) => { release = resolve; });
  const write = window.puter.fs.write;
  window.puter.fs.write = async (path, blob) => {
    if (path === '/u/Source.wav') { uploading = true; await wait; }
    return write(path, blob);
  };
  const copy = await exporting(app, 'saveCopy');
  await vi.waitFor(() => expect(uploading).toBe(true), { interval: 1 });
  await app.commands.run('fx.invert');
  const latest = doc.state;
  const saveAs = await exporting(app, 'saveAs', 'New.wav');
  await saveAs.pending;
  const info = doc.info;
  release();
  await copy.pending;
  expect(doc.source.path).toBe('/u/New.wav');
  expect(doc.name).toBe('New.wav');
  expect(doc.savedState).toBe(latest);
  expect(doc.info).toBe(info);
  expect(doc.dirty).toBe(false);
  expect([...parseWav(await stored.get('/u/Source.wav').arrayBuffer()).channels[0]]).toEqual(pcm(copied));
  expect([...parseWav(await stored.get('/u/New.wav').arrayBuffer()).channels[0]]).toEqual(pcm(latest));
});
