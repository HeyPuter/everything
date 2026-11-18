import { setImmediate } from 'node:timers/promises';
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
  window.puter = { auth: { isSignedIn: () => true }, fs: { write: async (path, blob) => { saved.set(path, blob); writes.push(path); return {}; } } };
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

it.each(['save', 'saveAs'])('keeps the latest %s output when an earlier encode finishes late', async (command) => {
  const { app, doc, saved } = setup();
  const first = app.commands.run('file.save');
  await ready(0);
  expect(document.querySelector('.io-progress-dialog')).toBeNull();
  await app.commands.run('fx.invert');
  const latest = doc.state;
  const second = app.commands.run(`file.${command}`);
  if (command === 'saveAs') {
    await vi.waitFor(() => expect(document.querySelector('.io-export-dialog')).not.toBeNull(), { interval: 1 });
    document.querySelector('.io-export-dialog .dialog-foot button[data-value="ok"]').click();
  }
  await ready(1);
  await setImmediate();
  encoding.jobs[0].finish();
  await Promise.all([first, second]);
  expect(doc.state === latest).toBe(true);
  expect(doc.savedState === latest).toBe(true);
  expect(doc.dirty).toBe(false);
  expect(await samples(saved)).toEqual(Array(32).fill(-0.25));
  expect(app.notify).not.toHaveBeenCalled();
});

it('allows the later save after the first encode fails', async () => {
  const { app, doc, saved } = setup();
  encoding.fail = 0;
  const first = app.commands.run('file.save');
  await ready(0);
  await app.commands.run('fx.invert');
  const second = app.commands.run('file.save');
  await ready(1);
  encoding.jobs[0].finish();
  await Promise.all([first, second]);
  expect(await samples(saved)).toEqual(Array(32).fill(-0.25));
  expect(doc.dirty).toBe(false);
  expect(app.notify).toHaveBeenCalledOnce();
});

it('does not let a failed middle encode release a newer save past the oldest one', async () => {
  const { app, doc, saved } = setup();
  const first = app.commands.run('file.save');
  await ready(0);
  await app.commands.run('fx.invert');
  encoding.fail = 1;
  await app.commands.run('file.save');
  expect(app.notify).toHaveBeenCalledOnce();
  const latest = doc.state;
  const third = app.commands.run('file.save');
  await ready(2);
  await setImmediate();
  encoding.jobs[0].finish();
  await Promise.all([first, third]);
  expect(await samples(saved)).toEqual(Array(32).fill(-0.25));
  expect(doc.savedState === latest).toBe(true);
});

it('saves a different path while the first encode is pending', async () => {
  const { app, saved } = setup();
  const first = app.commands.run('file.save');
  await ready(0);
  const other = addDoc(app, 'Other.wav');
  await app.commands.run('file.save');
  expect(await samples(saved, '/u/Other.wav')).toEqual(Array(32).fill(0.25));
  expect(other.dirty).toBe(false);
  encoding.jobs[0].finish();
  await first;
  expect(await samples(saved)).toEqual(Array(32).fill(0.25));
});

it('releases the next upload when the earlier encode is cancelled from its progress dialog', async () => {
  const { app, doc, saved, writes } = setup();
  const first = app.commands.run('file.save');
  await ready(0);
  await app.commands.run('fx.invert');
  const second = app.commands.run('file.save');
  await ready(1);
  await vi.advanceTimersByTimeAsync(250);
  const cancel = document.querySelector('.io-progress-dialog .dialog-foot button[data-value="cancel"]');
  expect(cancel).not.toBeNull();
  cancel.click();
  expect(await first).toBe(false);
  expect(await second).toBe(true);
  expect(encoding.jobs[0].terminated).toBe(true);
  expect(writes).toEqual(['/u/Source.wav']);
  expect(await samples(saved)).toEqual(Array(32).fill(-0.25));
  expect(doc.dirty).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
});
