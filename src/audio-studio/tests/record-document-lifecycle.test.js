import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { engine } from '../src/engine/engine.js';
import { AudioFile } from '../src/model/audio-file.js';
import { createRecorder } from '../src/record/recorder.js';

const apps = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    const stop = app.recorder.stop();
    await vi.advanceTimersByTimeAsync(120);
    await stop;
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

async function setup() {
  vi.useFakeTimers();
  localStorage.clear();
  engine.state = 'stopped';
  vi.spyOn(engine, 'openInput').mockResolvedValue(undefined);
  vi.spyOn(engine, 'closeInput').mockImplementation(() => {});
  vi.spyOn(engine, 'setRecording').mockImplementation(() => {});
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.recorder = createRecorder(app);
  apps.push(app);
  const doc = AudioFile.blank({ name: 'Take.wav', sampleRate: 48000, channels: 1 });
  app.addDocument(doc);
  await app.recorder.start({ doc });
  engine.emit('record-data', [new Float32Array(32).fill(0.25)]);
  return { app, doc };
}

it.each(['Cancel', 'Save'])('finishes a take before asking to close its document, including the final capture block (%s)', async (answer) => {
  const { app, doc } = await setup();
  let saved;
  app.commands.register({ id: 'file.save', run: () => { saved = doc.state; doc.markSaved(); return true; } });
  const closing = app.closeDocument(doc);
  engine.emit('record-data', [new Float32Array(32).fill(0.5)]);
  await vi.advanceTimersByTimeAsync(120);
  const button = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === answer);
  expect(button).toBeTruthy();
  button.click();
  expect(await closing).toBe(answer === 'Save');
  expect(app.documents.includes(doc)).toBe(answer === 'Cancel');
  expect(app.recorder.active).toBe(false);
  expect(doc.dirty).toBe(answer === 'Cancel');
  if (answer === 'Save') expect(saved.channels[0].length).toBe(64);
  expect(doc.length).toBe(64);
  expect([...doc.state.channels[0].toArray(31, 33)]).toEqual([0.25, 0.5]);
});

it('stops capture when switching documents and keeps the take in its original file', async () => {
  const { app, doc } = await setup();
  const other = AudioFile.blank({ name: 'Other.wav' });
  app.addDocument(other);
  engine.emit('record-data', [new Float32Array(32).fill(0.5)]);
  await vi.advanceTimersByTimeAsync(120);
  expect(app.recorder.active).toBe(false);
  expect(engine.setRecording).toHaveBeenLastCalledWith(false);
  expect(app.active).toBe(other);
  expect(other.length).toBe(0);
  expect(doc.length).toBe(64);
  expect(doc.dirty).toBe(true);
});

it('does not stop a take when an unrelated background file closes', async () => {
  const { app } = await setup();
  const other = AudioFile.blank({ name: 'Other.wav' });
  app.addDocument(other, { activate: false });
  expect(await app.closeDocument(other)).toBe(true);
  expect(app.recorder.active).toBe(true);
  expect(engine.setRecording).toHaveBeenLastCalledWith(true);
});
