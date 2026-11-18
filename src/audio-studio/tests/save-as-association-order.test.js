import fs from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installIo } from '../src/features/io.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { parseWav } from '../src/audio/wav.js';

const encoding = vi.hoisted(() => ({ jobs: [], fail: -1 }));
vi.mock('../src/export/export-worker.js?worker', async () => {
  const { WavWriter } = await import('../src/export/pcm.js');
  return { default: class {
    constructor() { this.index = encoding.jobs.length; encoding.jobs.push(this); }
    postMessage(message) {
      if (message.type === 'start') {
        this.job = message.job;
        queueMicrotask(() => this.onmessage({ data: { type: 'need', at: 0, n: this.job.frames } }));
      } else if (message.type === 'chunk') {
        const writer = new WavWriter({ ...this.job.options, frames: this.job.frames });
        writer.write(message.channels, this.job.frames);
        const blob = writer.finish();
        this.finish = () => {
          this.delivered = true;
          this.onmessage({ data: this.index === encoding.fail ? { type: 'error', message: 'Encoding failed' } : { type: 'done', blob } });
        };
        if (this.index !== 0) this.finish();
      }
    }
    terminate() { this.terminated = true; }
  } };
});
beforeEach(async () => {
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
  localStorage.clear();
  encoding.jobs = [];
  encoding.fail = -1;
  vi.stubGlobal('Blob', NodeBlob);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // Keep the test inside the 250ms window before encoding progress becomes modal.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  delete window.puter;
  vi.useRealTimers();
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
  installIo(app);
  const doc = addDoc(app, 'Source.wav');
  const saved = new Map();
  const writes = [];
  window.puter = { auth: { isSignedIn: () => true }, fs: { stat: async () => { throw Object.assign(new Error('Missing'), { code: 'subject_does_not_exist' }); }, write: async (path, blob) => { saved.set(path, blob); writes.push(path); return { uid: path }; } } };
  return { app, doc, saved, writes };
}
function addDoc(app, name) {
  return app.addDocument(new AudioFile({ name, sampleRate: 8000, channels: [Channel.fromSamples(new Float32Array(32).fill(0.25))], info: { bitDepth: 32 }, source: { type: 'puter', path: `/u/${name}` } }));
}
async function ready(index) {
  await vi.waitFor(() => expect(typeof encoding.jobs[index]?.finish).toBe('function'), { interval: 1 });
}
async function samples(saved, path = '/u/Source.wav') {
  return [...parseWav(await saved.get(path).arrayBuffer()).channels[0]];
}

async function saveAs(app, name, cancel = false) {
  const pending = app.commands.run('file.saveAs');
  await vi.waitFor(() => expect(document.querySelector('.io-export-dialog')).not.toBeNull(), { interval: 1 });
  const dialog = document.querySelector('.io-export-dialog');
  const input = dialog.querySelector('[aria-label="File name"]');
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const button = cancel ? [...dialog.querySelectorAll('.dialog-foot button')].find((b) => b.textContent === 'Cancel') : dialog.querySelector('.dialog-foot button[data-value="ok"]');
  button.click();
  return { pending };
}

it.each(['saved', 'failed', 'cancelled'])('retains the newest successful Save As association when a newer request is %s', async (outcome) => {
  const { app, doc, saved, writes } = setup();
  const first = (await saveAs(app, 'Earlier.wav')).pending;
  await ready(0);
  expect(document.querySelector('.io-progress-dialog')).toBeNull();
  doc.setSelection(0, 16);
  await app.commands.run('edit.crop');
  await app.commands.run('fx.invert');
  const latest = doc.state;
  if (outcome === 'failed') encoding.fail = 1;
  const second = (await saveAs(app, 'Latest.wav', outcome === 'cancelled')).pending;
  await second;
  encoding.jobs[0].finish();
  await first;
  expect(await samples(saved, '/u/Earlier.wav')).toEqual(Array(32).fill(0.25));
  if (outcome === 'saved') {
    expect(await samples(saved, '/u/Latest.wav')).toEqual(Array(16).fill(-0.25));
    expect(doc.savedState === latest).toBe(true);
    expect(doc.dirty).toBe(false);
  } else {
    expect(saved.has('/u/Latest.wav')).toBe(false);
    expect(doc.dirty).toBe(true);
  }
  const expected = outcome === 'saved' ? 'Latest.wav' : 'Earlier.wav';
  expect(doc.source).toMatchObject({ type: 'puter', path: `/u/${expected}`, uid: `/u/${expected}` });
  expect(doc.name).toBe(expected);
  expect(doc.info.size).toBe(saved.get(`/u/${expected}`).size);
  expect(doc.state === latest).toBe(true);
  expect(app.notify).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
  // Save must keep writing the association selected by the successful Save As.
  await app.commands.run('file.save');
  expect(writes.at(-1)).toBe(`/u/${expected}`);
  expect(await samples(saved, `/u/${expected}`)).toEqual(Array(16).fill(-0.25));
  expect(doc.dirty).toBe(false);
});

it.each(['saved', 'failed'])('only cleans the current destination when a concurrent Save As is %s', async (outcome) => {
  const { app, doc, saved, writes } = setup();
  app.setStatus = vi.fn();
  const original = doc.state;
  const savingAs = (await saveAs(app, 'New.wav')).pending;
  await ready(0);
  await app.commands.run('fx.invert');
  const latest = doc.state;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let writing = false;
  const write = window.puter.fs.write;
  window.puter.fs.write = async (path, blob) => {
    if (path === '/u/Source.wav') { writing = true; await wait; }
    return write(path, blob);
  };
  const oldSave = app.commands.run('file.save');
  await vi.waitFor(() => expect(writing).toBe(true), { interval: 1 });
  if (outcome === 'failed') encoding.fail = 0;
  encoding.jobs[0].finish();
  await savingAs;
  const current = outcome === 'saved' ? 'New.wav' : 'Source.wav';
  expect(doc.source.path).toBe(`/u/${current}`);
  expect(doc.dirty).toBe(true);
  release();
  await oldSave;
  expect(await samples(saved, '/u/Source.wav')).toEqual(Array(32).fill(-0.25));
  if (outcome === 'saved') expect(await samples(saved, '/u/New.wav')).toEqual(Array(32).fill(0.25));
  else expect(saved.has('/u/New.wav')).toBe(false);
  expect.soft(doc.dirty).toBe(outcome === 'saved');
  expect.soft(app.setStatus).toHaveBeenLastCalledWith('Saved Source.wav');
  expect(doc.state === latest).toBe(true);
  expect(doc.source.path).toBe(`/u/${current}`);
  expect(app.notify).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
  await app.commands.run('file.save');
  expect(writes.at(-1)).toBe(`/u/${current}`);
  expect(await samples(saved, `/u/${current}`)).toEqual(Array(32).fill(-0.25));
  expect(doc.dirty).toBe(false);
  await app.commands.run('edit.undo');
  expect(doc.state === original).toBe(true);
  await app.commands.run('edit.redo');
  expect(doc.state === latest).toBe(true);
});

it.each(['saved', 'failed', 'cancelled'])('tracks the state written by a delayed Save As that is %s after Save completes', async (outcome) => {
  const { app, doc, saved, writes } = setup();
  const original = doc.state;
  const savingAs = (await saveAs(app, 'New.wav')).pending;
  await ready(0);
  await app.commands.run('fx.invert');
  const latest = doc.state;
  await app.commands.run('file.save');
  expect(doc.dirty).toBe(false);
  expect(await samples(saved, '/u/Source.wav')).toEqual(Array(32).fill(-0.25));
  if (outcome === 'cancelled') {
    await vi.advanceTimersByTimeAsync(250);
    document.querySelector('.io-progress-dialog .dialog-foot button[data-value="cancel"]').click();
  } else {
    if (outcome === 'failed') encoding.fail = 0;
    encoding.jobs[0].finish();
  }
  await savingAs;
  const current = outcome === 'saved' ? 'New.wav' : 'Source.wav';
  expect(doc.source.path).toBe(`/u/${current}`);
  if (outcome === 'saved') expect(await samples(saved, '/u/New.wav')).toEqual(Array(32).fill(0.25));
  else expect(saved.has('/u/New.wav')).toBe(false);
  expect.soft(doc.dirty).toBe(outcome === 'saved');
  expect.soft(doc.savedState === (outcome === 'saved' ? original : latest)).toBe(true);
  expect(doc.state === latest).toBe(true);
  expect(app.notify).toHaveBeenCalledTimes(outcome === 'failed' ? 1 : 0);
  await app.commands.run('edit.undo');
  expect(doc.state === original).toBe(true);
  expect.soft(doc.dirty).toBe(outcome !== 'saved');
  await app.commands.run('edit.redo');
  expect(doc.state === latest).toBe(true);
  expect.soft(doc.dirty).toBe(outcome === 'saved');
  await app.commands.run('file.save');
  expect(writes.at(-1)).toBe(`/u/${current}`);
  expect(await samples(saved, `/u/${current}`)).toEqual(Array(32).fill(-0.25));
  expect(doc.dirty).toBe(false);
});

it.each(['save', 'saveAs'])('tracks the encoded state when Undo returns to previously saved audio during %s', async (command) => {
  const { app, doc, saved } = setup();
  const original = doc.state;
  await app.commands.run('fx.invert');
  const encoded = doc.state;
  const pending = command === 'save' ? app.commands.run('file.save') : (await saveAs(app, 'New.wav')).pending;
  await ready(0);
  await app.commands.run('edit.undo');
  expect(doc.state === original).toBe(true);
  expect(doc.dirty).toBe(false);
  encoding.jobs[0].finish();
  await pending;
  const path = command === 'save' ? '/u/Source.wav' : '/u/New.wav';
  expect(doc.source.path).toBe(path);
  expect(await samples(saved, path)).toEqual(Array(32).fill(-0.25));
  expect.soft(doc.savedState === encoded).toBe(true);
  expect.soft(doc.dirty).toBe(true);
  await app.commands.run('edit.redo');
  expect(doc.state === encoded).toBe(true);
  expect.soft(doc.dirty).toBe(false);
  await app.commands.run('edit.undo');
  expect(doc.state === original).toBe(true);
  expect.soft(doc.dirty).toBe(true);
  await app.commands.run('file.save');
  expect(await samples(saved, path)).toEqual(Array(32).fill(0.25));
  expect(doc.dirty).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
});
