import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { wavHeader } from '../src/audio/wav.js';
import { dsp, setDspBytes } from '../src/audio/dsp.js';
import { createRecorder } from '../src/record/recorder.js';
import { engine } from '../src/engine/engine.js';

const gate = vi.hoisted(() => ({ wait: null, calls: 0 }));
vi.mock('../src/audio/dsp.js', async (original) => {
  const actual = await original();
  return { ...actual, dsp: async () => { gate.calls++; if (gate.wait) await gate.wait; return actual.dsp(); } };
});
const apps = [];
beforeEach(async () => {
  gate.wait = null;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
  gate.calls = 0;
  localStorage.clear();
  engine.state = 'stopped';
  vi.spyOn(engine, 'openInput').mockResolvedValue(undefined);
  vi.spyOn(engine, 'closeInput').mockImplementation(() => {});
  vi.spyOn(engine, 'setRecording').mockImplementation(() => {});
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.recorder.stop();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
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

it.each(['appendCurrent', 'appendNew'].flatMap((command) => ['edit', 'capture', 'clean'].map((mode) => [command, mode])))('%s preserves source work during preparation (%s)', async (command, mode) => {
  const app = new App();
  apps.push(app);
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.recorder = createRecorder(app);
  installCoreCommands(app);
  let target = app.addDocument(new AudioFile({ name: 'Target.wav', sampleRate: 24000, channels: [Channel.silence(64)] }));
  let release;
  gate.wait = new Promise((resolve) => { release = resolve; });
  const appending = app.commands.run(`file.${command}`);
  const input = document.querySelector('input[type=file]');
  const files = [wavFile('Source.wav', 48000, 80, 0.25)];
  if (command === 'appendNew') files.unshift(wavFile('Append target.wav', 24000, 64, 0));
  Object.defineProperty(input, 'files', { value: files });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(gate.calls).toBeGreaterThan(0), { interval: 1 });
  const source = app.documents.find((doc) => doc.name === 'Source.wav');
  if (command === 'appendNew') target = app.documents.find((doc) => doc.name === 'Append target.wav');
  const original = source.state;
  if (mode !== 'clean') app.activate(source);
  if (mode === 'edit') await app.commands.run('fx.invert');
  if (mode === 'capture') {
    await app.recorder.start({ doc: source, at: source.length });
    engine.emit('record-data', [new Float32Array(8).fill(0.5)]);
    expect(source.dirty).toBe(false); // No live waveform update has occurred yet.
  }
  release();
  await appending;
  if (mode === 'capture') await app.recorder.stop();
  expect(app.documents.includes(source)).toBe(mode !== 'clean');
  expect(document.querySelector('[role=dialog]')).toBeNull();
  expect(target.length).toBe(104);
  expect(target.state.channels[0].toArray(84, 85)[0]).toBeCloseTo(0.25, 3);
  if (mode === 'edit') {
    expect(source.state.channels[0].toArray(0, 1)[0]).toBe(-0.25);
    expect(source.dirty).toBe(true);
  }
  if (mode === 'capture') {
    expect(source.length).toBe(88);
    expect([...source.state.channels[0].toArray(80)]).toEqual(Array(8).fill(0.5));
    expect(source.dirty).toBe(true);
  }
  if (mode !== 'clean') {
    source.history.undo();
    expect(source.state === original).toBe(true);
  }
});
