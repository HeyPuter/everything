import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { wavHeader } from '../src/audio/wav.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';

const gate = vi.hoisted(() => ({ wait: null, calls: 0 }));
vi.mock('../src/audio/dsp.js', async (original) => {
  const actual = await original();
  return { ...actual, dsp: async () => { gate.calls++; if (gate.wait) await gate.wait; return actual.dsp(); } };
});
let resample;
beforeEach(async () => {
  gate.wait = null;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  const native = await dsp();
  resample = vi.spyOn(native, 'resample');
  gate.calls = 0;
  localStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

function wavFile(name, rate, frames, value) {
  const header = wavHeader({ sampleRate: rate, channels: 1, bitDepth: 32, float: true, frames });
  const buffer = new ArrayBuffer(header.byteLength + frames * 4);
  new Uint8Array(buffer).set(new Uint8Array(header));
  const data = new DataView(buffer);
  for (let i = 0; i < frames; i++) data.setFloat32(header.byteLength + i * 4, value, true);
  const file = new File([buffer], name, { type: 'audio/wav' });
  file.arrayBuffer = async () => buffer;
  return file;
}

it.each(['paste', 'mixPaste', 'appendCurrent', 'appendNew'].flatMap((command) => [24000, 8000].map((rate) => [command, rate])))('conforms %s audio to %i Hz after the destination changes during DSP loading', async (command, targetRate) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  app.prefs.set('markersWithClipboard', true);
  app.prefs.set('mixPasteSettings', { type: 'insert', crossfade: false });
  let doc = app.addDocument(new AudioFile({ name: 'Target.wav', sampleRate: 16000, channels: [Channel.silence(64)] }));
  doc.setCursor(64);
  app.clipboard = { type: 'audio', sampleRate: 8000, channels: [Channel.fromSamples(new Float32Array(80).fill(0.25))], markers: [{ id: 'clip-marker', name: 'Copied cue', start: 8, duration: 16 }] };
  let release;
  gate.wait = new Promise((resolve) => { release = resolve; });
  const append = command.startsWith('append');
  const pasting = app.commands.run(`${append ? 'file' : 'edit'}.${command}`);
  if (append) {
    const input = document.querySelector('input[type=file]');
    const files = [wavFile('Source.wav', 8000, 80, 0.25)];
    if (command === 'appendNew') files.unshift(wavFile('Append target.wav', 16000, 64, 0));
    Object.defineProperty(input, 'files', { value: files });
    input.dispatchEvent(new Event('change'));
  }
  if (command === 'mixPaste') document.querySelector('.dialog-foot .btn.primary').click();
  await vi.waitFor(() => expect(gate.calls).toBeGreaterThan(0), { interval: 1 });

  if (command === 'appendNew') {
    doc = app.documents.find((d) => d.name === 'Append target.wav');
    app.activate(doc);
  }

  // This dialog remains available while the pending Paste waits for DSP.
  const changing = app.commands.run('edit.interpretRate');
  const dialog = document.querySelector('.dialog');
  dialog.querySelector('input').value = String(targetRate);
  dialog.querySelector('.dialog-foot .btn.primary').click();
  await changing;
  expect(doc.sampleRate).toBe(targetRate);
  const beforePaste = doc.state;
  // A clipboard switch must not replace the source already chosen for Paste.
  app.clipboard = { type: 'audio', sampleRate: 24000, channels: [Channel.silence(7)] };
  release();
  await pasting;
  const frames = targetRate / 100; // 10 ms of source audio at the new rate
  expect(doc.length).toBe(64 + frames);
  if (!append) expect(doc.selection).toMatchObject({ start: 64, end: 64 + frames });
  expect(doc.state.channels[0].toArray(64 + frames / 2, 65 + frames / 2)[0]).toBeCloseTo(0.25, 3);
  if (command === 'paste') expect(doc.state.markers.at(-1)).toMatchObject({ name: 'Copied cue', start: 64 + targetRate / 1000, duration: targetRate / 500 });
  expect(resample.mock.calls.map((args) => args.slice(1, 3))).toEqual(targetRate === 8000 ? [] : [[8000, targetRate]]);
  expect(app.notify).not.toHaveBeenCalled();
  doc.history.undo();
  expect(doc.state === beforePaste).toBe(true);
});
