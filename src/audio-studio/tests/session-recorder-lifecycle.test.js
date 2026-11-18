import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/lib/emitter.js';
import { Session } from '../src/model/session.js';
import * as S from '../src/model/session-edits.js';
import { SessionRecorder } from '../src/multitrack/recorder.js';

function setup() {
  const engine = new Emitter();
  Object.assign(engine, {
    rate: 48000,
    outputLatencyFrames: 0,
    openInput: vi.fn(async () => {}),
    closeInput: vi.fn(),
    setRecording: vi.fn(),
    play: vi.fn(async () => {}),
    stop: vi.fn(),
  });
  const app = new Emitter();
  Object.assign(app, { engine, documents: [], notify: vi.fn(), uniqueName: (b, e) => b + e });
  app.addDocument = (doc) => app.documents.push(doc);
  app.activate = (doc) => (app.active = doc);
  const doc = new Session({ name: 'Recording.asesx', sampleRate: engine.rate, tracks: 1 });
  doc.apply('Arm', S.updateTrack(doc.state, doc.state.tracks[0].id, { arm: true }));
  app.active = doc;
  return { app, doc, engine, recorder: new SessionRecorder(app) };
}

afterEach(() => vi.useRealTimers());

describe('session recording lifecycle', () => {
  it.each([false, true])('asks before discarding a new session take (armed track deleted: %s)', async (deleted) => {
    const { App } = await import('../src/app.js');
    vi.useFakeTimers();
    const { app, doc, engine, recorder } = setup();
    await recorder.start(doc);
    engine.emit('record-data', [new Float32Array(128).fill(0.25)]);
    if (deleted) doc.apply('Delete armed track', S.removeTracks(doc.state, [doc.state.tracks[0].id]));
    const stopping = recorder.stop();
    await vi.advanceTimersByTimeAsync(150);
    await stopping;
    const file = app.documents[0];
    expect(file.length).toBe(128);
    const closing = App.prototype.closeDocument.call(app, file);
    const cancel = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Cancel');
    cancel?.click();
    expect(await closing).toBe(false);
    expect(app.documents).toContain(file);
    expect(file.dirty).toBe(true);
  });

  it('routes the Stop command to a session still waiting for input permission', async () => {
    const { CommandRegistry } = await import('../src/commands/registry.js');
    const { installCoreCommands } = await import('../src/commands/core.js');
    const { app, doc, engine, recorder } = setup();
    app.multitrack = { recorder };
    app.commands = new CommandRegistry(app);
    installCoreCommands(app);
    let ready;
    engine.openInput.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
    const starting = recorder.start(doc);
    expect(app.commands.isEnabled('transport.stop')).toBe(true);
    await app.commands.run('transport.stop');
    ready();
    await starting;
    expect(engine.play).not.toHaveBeenCalled();
    expect(recorder.active).toBe(false);
  });

  it('cancels a pending microphone request when Record is pressed again', async () => {
    const { app, doc, engine, recorder } = setup();
    const ready = [];
    engine.openInput.mockImplementation(() => new Promise((resolve) => ready.push(resolve)));
    const starting = recorder.toggle(doc);
    const cancelling = recorder.toggle(doc);
    for (const resolve of ready) resolve();
    await Promise.all([starting, cancelling]);
    expect(engine.openInput).toHaveBeenCalledOnce();
    expect(engine.play).not.toHaveBeenCalled();
    expect(engine.setRecording).not.toHaveBeenCalledWith(true);
    expect(recorder.active).toBe(false);
    expect(app.recording).toBeFalsy();
  });

  it('does not start a take for a session closed while permission is pending', async () => {
    const { doc, engine, recorder } = setup();
    let ready;
    engine.openInput.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
    const starting = recorder.start(doc);
    doc.emit('close');
    ready();
    await starting;
    expect(engine.play).not.toHaveBeenCalled();
    expect(recorder.active).toBe(false);
  });

  it('does not announce recording after a stopped take finishes initializing playback', async () => {
    vi.useFakeTimers();
    const { app, doc, engine, recorder } = setup();
    const states = [];
    app.on('transport', (state) => states.push(state));
    let ready;
    engine.play.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
    const starting = recorder.start(doc);
    await Promise.resolve();
    const stopping = recorder.stop();
    expect(engine.play.mock.calls[0][0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    await stopping;
    ready();
    await starting;
    expect(app.recording).toBe(false);
    expect(recorder.active).toBe(false);
    expect(states).not.toContain('recording');
  });

  it('keeps rapid Record clicks from reopening capture while the previous take flushes', async () => {
    vi.useFakeTimers();
    const { app, doc, engine, recorder } = setup();
    await recorder.toggle(doc);
    engine.emit('record-data', [new Float32Array(128).fill(0.25)]);
    const stopping = recorder.toggle(doc);
    expect(recorder.active).toBe(true);
    const again = recorder.toggle(doc);
    // The final worklet block still belongs to the original take.
    engine.emit('record-data', [new Float32Array(64).fill(0.5)]);
    await vi.advanceTimersByTimeAsync(150);
    await Promise.all([stopping, again]);
    expect(engine.openInput).toHaveBeenCalledTimes(1);
    expect(engine.closeInput).toHaveBeenCalledTimes(1);
    expect(recorder.active).toBe(false);
    expect(app.recording).toBe(false);
    expect(doc.state.clips).toHaveLength(1);
    expect(app.documents).toHaveLength(1);
    expect(app.documents[0].length).toBe(192);
    expect(app.documents[0].state.channels[0].toArray()[191]).toBe(0.5);
    // Once the previous take is committed, recording can start again.
    await recorder.toggle(doc);
    expect(engine.openInput).toHaveBeenCalledTimes(2);
    expect(recorder.active).toBe(true);
    const done = recorder.stop();
    await vi.advanceTimersByTimeAsync(150);
    await done;
    await recorder.stop();
    expect(engine.closeInput).toHaveBeenCalledTimes(2);
  });
});
