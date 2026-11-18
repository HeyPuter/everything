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
beforeEach(async () => {
  gate.wait = null;
  setDspBytes(fs.readFileSync('src/audio/dsp.wasm'));
  await dsp();
  gate.calls = 0;
  localStorage.clear();
});
afterEach(() => {
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

it.each(['appendCurrent', 'appendNew'].flatMap((command) => [['close', 'conversion'], ['switch', 'conversion'], ['close', 'opening']].map(([action, phase]) => [command, action, phase])))('%s handles destination %s during %s', async (command, action, phase) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  let target = app.addDocument(new AudioFile({ name: 'Target.wav', sampleRate: 24000, channels: [Channel.silence(64)] }));
  const other = app.addDocument(AudioFile.blank({ name: 'Other.wav', sampleRate: 24000, channels: 1 }), { activate: false });
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  if (phase === 'conversion') gate.wait = wait;
  const appending = app.commands.run(`file.${command}`);
  const input = document.querySelector('input[type=file]');
  const files = [wavFile('Source.wav', 48000, 80, 0.25)];
  let reading = false;
  if (phase === 'opening') {
    const read = files[0].arrayBuffer;
    files[0].arrayBuffer = async () => { reading = true; await wait; return read(); };
  }
  if (command === 'appendNew') files.unshift(wavFile('Append target.wav', 24000, 64, 0));
  Object.defineProperty(input, 'files', { value: files });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(phase === 'opening' ? reading : gate.calls > 0).toBe(true), { interval: 1 });
  if (command === 'appendNew') target = app.documents.find((doc) => doc.name === 'Append target.wav');
  const before = target.state;
  const untouched = other.state;
  if (action === 'close') expect(await app.closeDocument(target)).toBe(true);
  app.activate(other);
  release();
  const result = await appending;
  const source = app.documents.find((doc) => doc.name === 'Source.wav');
  expect(other.state === untouched).toBe(true);
  if (action === 'close') {
    expect.soft(target.state === before).toBe(true);
    expect(app.documents.includes(target)).toBe(false);
    expect.soft(app.active === other).toBe(true);
    expect.soft(Boolean(source)).toBe(true);
    expect.soft(source?.length).toBe(80);
    expect.soft(source?.state.channels[0].toArray(0, 1)[0]).toBe(0.25);
    expect(result).toBe(false);
    expect(app.notify).toHaveBeenCalledExactlyOnceWith('Append stopped because the destination file was closed. Imported files remain open.', { error: true });
  } else {
    expect(target.length).toBe(104);
    expect(target.state.channels[0].toArray(84, 85)[0]).toBeCloseTo(0.25, 3);
    expect(source).toBeUndefined();
    expect(app.notify).not.toHaveBeenCalled();
    expect(app.active === (command === 'appendNew' ? target : other)).toBe(true);
    target.history.undo();
    expect(target.state === before).toBe(true);
  }
});
