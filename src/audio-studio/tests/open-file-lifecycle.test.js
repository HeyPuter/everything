import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { installCoreCommands } from '../src/commands/core.js';
import { wavHeader } from '../src/audio/wav.js';

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
function wavFile(name) {
  const header = wavHeader({ sampleRate: 8000, channels: 1, bitDepth: 32, float: true, frames: 32 });
  const buffer = new ArrayBuffer(header.byteLength + 32 * 4);
  new Uint8Array(buffer).set(new Uint8Array(header));
  const file = new File([buffer], name, { type: 'audio/wav' });
  file.arrayBuffer = async () => buffer;
  return file;
}

it.each([
  { close: true, fail: false, existing: false, background: false },
  { close: true, fail: false, existing: true, background: false },
  { close: true, fail: true, existing: false, background: false },
  { close: true, fail: true, existing: true, background: false },
  { close: false, fail: false, existing: true, background: false },
  { close: true, fail: false, existing: true, background: true },
])('keeps batch opening within live documents: %j', async ({ close, fail, existing, background }) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  installCoreCommands(app);
  const other = existing ? app.addDocument(AudioFile.blank({ name: 'Other.wav', sampleRate: 8000, channels: 1 })) : null;
  const firstFile = wavFile('First.wav');
  const lastFile = wavFile('Last.wav');
  const read = lastFile.arrayBuffer;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let reading = false;
  lastFile.arrayBuffer = async () => {
    reading = true;
    await wait;
    if (fail) throw new Error('Read failed');
    return read();
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const opening = app.commands.run(background ? 'file.importLocal' : 'file.openLocal');
  const input = document.querySelector('input[type=file]');
  Object.defineProperty(input, 'files', { value: [firstFile, lastFile] });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(reading).toBe(true), { interval: 1 });
  const first = app.documents.find((doc) => doc.name === 'First.wav');
  expect(Boolean(first)).toBe(true);
  expect(app.active === (background ? other : first)).toBe(true);
  if (close) expect(await app.closeDocument(first)).toBe(true);
  release();
  await opening;
  const last = app.documents.find((doc) => doc.name === 'Last.wav');
  expect(app.documents.includes(first)).toBe(!close);
  expect(Boolean(last)).toBe(!fail);
  const expected = background || fail ? other : close ? last : first;
  expect(app.active === expected).toBe(true);
  expect(app.active === null || app.documents.includes(app.active)).toBe(true);
  if (fail) expect(app.notify).toHaveBeenCalledExactlyOnceWith('"Last.wav" could not be opened. Read failed', { error: true });
  else expect(app.notify).not.toHaveBeenCalled();
});
