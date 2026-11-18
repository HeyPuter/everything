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
