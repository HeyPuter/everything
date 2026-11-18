import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Emitter } from '../src/lib/emitter.js';
import { Session } from '../src/model/session.js';
import * as S from '../src/model/session-edits.js';
import { SessionRecorder } from '../src/multitrack/recorder.js';
import { installIo } from '../src/features/io.js';

const apps = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    const stop = app.multitrack.recorder.stop();
    await vi.advanceTimersByTimeAsync(150);
    await stop;
  }
  delete window.puter;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  localStorage.clear();
  let close;
  const exit = vi.fn();
  window.puter = { env: 'app', ui: { onWindowClose: (handler) => { close = handler; } }, exit };
  const app = new App();
  app.prefs.set('autosave', false);
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.engine = Object.assign(new Emitter(), {
    rate: 48000, outputLatencyFrames: 0, openInput: vi.fn(async () => {}),
    closeInput: vi.fn(), setRecording: vi.fn(), play: vi.fn(async () => {}), stop: vi.fn(),
  });
  installIo(app);
  app.multitrack = { recorder: new SessionRecorder(app) };
  apps.push(app);
  const doc = new Session({ name: 'Session.asesx', sampleRate: 48000, tracks: 1 });
  doc.apply('Arm', S.updateTrack(doc.state, doc.state.tracks[0].id, { arm: true }));
  doc.markSaved();
  app.addDocument(doc);
  return { app, doc, recorder: app.multitrack.recorder, close: () => close(), exit };
}

it('finishes multitrack capture before deciding which documents need a close prompt', async () => {
  const { app, doc, recorder, close, exit } = setup();
  await recorder.start(doc);
  app.engine.emit('record-data', [new Float32Array(128).fill(0.25)]);
  const closing = close();
  app.engine.emit('record-data', [new Float32Array(64).fill(0.5)]);
  await vi.advanceTimersByTimeAsync(150);
  const cancel = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Cancel');
  cancel?.click();
  await closing;
  expect(exit).not.toHaveBeenCalled();
  expect(recorder.active).toBe(false);
  expect(doc.state.clips).toHaveLength(1);
  const file = app.documents.find((d) => d.kind === 'audio');
  expect(file.length).toBe(192);
  expect(file.dirty).toBe(true);
});

it('cancels multitrack input permission before exiting the window', async () => {
  const { app, doc, recorder, close, exit } = setup();
  let ready;
  app.engine.openInput.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
  const starting = recorder.start(doc);
  await close();
  ready();
  await starting;
  expect(exit).toHaveBeenCalledOnce();
  expect(app.engine.play).not.toHaveBeenCalled();
  expect(recorder.active).toBe(false);
});

it('waits for both the finished session and its new take to be saved before exiting', async () => {
  const { app, doc, recorder, close, exit } = setup();
  const saved = [];
  app.commands.register({ id: 'file.save', run: () => { saved.push(app.active.kind); app.active.markSaved(); return true; } });
  await recorder.start(doc);
  app.engine.emit('record-data', [new Float32Array(128).fill(0.25)]);
  const closing = close();
  await vi.advanceTimersByTimeAsync(150);
  for (let i = 0; i < 2; i++) {
    const save = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Save');
    expect(exit).not.toHaveBeenCalled();
    expect(save).toBeTruthy();
    save.click();
    await vi.advanceTimersByTimeAsync(0);
  }
  await closing;
  expect(saved).toEqual(['session', 'audio']);
  expect(exit).toHaveBeenCalledOnce();
});
