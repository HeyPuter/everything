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
