import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { Blob as NodeBlob } from 'node:buffer';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { createMarker } from '../src/model/markers.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installIo } from '../src/features/io.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { parseWav } from '../src/audio/wav.js';

// Keep exportAudio's source reads, marker offsets and worker protocol; encode
// the tiny PCM fixture with the real WAV writer instead of starting a worker.
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
const gate = vi.hoisted(() => ({ wait: null, calls: 0 }));
vi.mock('../src/audio/dsp.js', async (original) => {
  const actual = await original();
  return { ...actual, dsp: async () => { gate.calls++; if (gate.wait) await gate.wait; return actual.dsp(); } };
});
beforeEach(async () => {
  gate.wait = null;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
  gate.calls = 0;
  localStorage.clear();
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  delete window.puter;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(['saveAs', 'saveCopy', 'exportFile'].flatMap((command) => ['dialog', 'path check'].flatMap((phase) => [16, 160].map((frames) => [command, phase, frames]))).concat([['saveAs', 'upload', 16], ['saveAs', 'upload', 160]]))('%s saves the whole file after a pending %s edit (%i source frames)', async (command, phase, frames) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.prefs.set('autosave', false);
  app.prefs.set('exportFolder', '/u/Exports');
  installCoreCommands(app);
  installIo(app); // Use the production override, not core's temporary-file command.
  const samples = new Float32Array(128);
  samples.fill(0.25, 64, 96);
  samples.fill(0.75, 96);
  const marker = createMarker({ start: 112, duration: 8, name: 'Tail', type: 'range' });
  const doc = app.addDocument(new AudioFile({ name: 'Source.wav', sampleRate: 8000, channels: [Channel.fromSamples(samples)], markers: [marker], meta: { title: 'Original title' }, info: { bitDepth: 32 } }));
  doc.setSelection(64, 96);
  const original = doc.state;
  app.clipboard = { type: 'audio', sampleRate: 16000, channels: [Channel.fromSamples(new Float32Array(frames).fill(0.5))] };
  let releasePaste;
  gate.wait = new Promise((resolve) => { releasePaste = resolve; });
  let releasePath;
  const pathWait = new Promise((resolve) => { releasePath = resolve; });
  let checkingPath = false;
  const writes = [];
  window.puter = {
    auth: { isSignedIn: () => true },
    fs: {
      stat: async () => {
        checkingPath = true;
        if (phase === 'path check') await pathWait;
        throw Object.assign(new Error('Missing'), { code: 'subject_does_not_exist' });
      },
      write: async (path, blob) => { writes.push({ path, blob }); if (phase === 'upload') await pathWait; return {}; },
    },
  };
  const pasting = app.commands.run('edit.paste');
  await vi.waitFor(() => expect(gate.calls).toBeGreaterThan(0), { interval: 1 });
  const exporting = app.commands.run(`file.${command}`);
  await vi.waitFor(() => expect(document.querySelector('.io-export-dialog')).not.toBeNull(), { interval: 1 });
  const save = () => document.querySelector('.io-export-dialog .dialog-foot button[data-value="ok"]').click();
  if (phase !== 'dialog') {
    save();
    await vi.waitFor(() => expect(phase === 'upload' ? writes.length === 1 : checkingPath).toBe(true), { interval: 1 });
  }
  releasePaste();
  await pasting;
  const pasted = doc.state;
  const length = 96 + frames / 2;
  expect(doc.length).toBe(length);
  if (phase === 'dialog') save();
  releasePath();
  expect(await exporting).toBe(true);
  expect(writes.map(({ path }) => path)).toEqual(['/u/Exports/Source.wav']);
  expect(doc.dirty).toBe(command !== 'saveAs' || phase === 'upload');
  expect(doc.savedState === pasted).toBe(command === 'saveAs' && phase !== 'upload');
  const wav = parseWav(await writes[0].blob.arrayBuffer());
  const encoded = phase === 'upload' ? original : pasted;
  expect(wav.channels[0].length).toBe(encoded.channels[0].length);
  expect([...wav.channels[0]]).toEqual([...encoded.channels[0].toArray()]);
  expect(wav.sampleRate).toBe(8000);
  expect(wav.markers).toMatchObject([{ start: encoded.channels[0].length - 16, duration: 8, name: 'Tail' }]);
  expect(wav.meta.title).toBe('Original title');
  expect(doc.state === pasted).toBe(true);
  expect(doc.name).toBe('Source.wav');
  expect(doc.history.undoLabel).toBe('Paste');
  doc.history.undo();
  expect(doc.state === original).toBe(true);
  expect(app.notify).not.toHaveBeenCalled();
});
