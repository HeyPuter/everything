import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { engine } from '../src/engine/engine.js';
import { Session } from '../src/model/session.js';
import { AudioFile } from '../src/model/audio-file.js';
import * as S from '../src/model/session-edits.js';
import { SessionRecorder } from '../src/multitrack/recorder.js';
import { setDspBytes } from '../src/audio/dsp.js';
import { wasmBytes } from './fx-wasm.js';

setDspBytes(wasmBytes);
const apps = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    const stop = app.multitrack.recorder.stop();
    await vi.advanceTimersByTimeAsync(150);
    await stop;
  }
  engine.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.assign(engine, { ctx: null, node: null, input: null, requestedRate: null });
});

function setup() {
  vi.useFakeTimers();
  localStorage.clear();
  Object.assign(engine, {
    rate: 48000, state: 'stopped', requestedRate: 48000,
    ctx: { currentTime: 0, sampleRate: 48000, state: 'running', baseLatency: 24 / 48000 },
    node: { port: { postMessage: vi.fn() } }, lastPos: { frame: 0, time: 0 },
  });
  vi.spyOn(engine, 'openInput').mockImplementation(async () => { engine.inputRequest++; engine.input = {}; });
  vi.spyOn(engine, 'closeInput').mockImplementation(() => { engine.input = null; });
  vi.spyOn(engine, 'setRecording').mockImplementation(() => {});
  vi.spyOn(engine, 'ensure').mockImplementation(async (rate) => {
    if (engine.rate !== rate) {
      engine.rate = rate;
      engine.ctx = { currentTime: 0, sampleRate: rate, state: 'running' };
      // A context change migrates the open input to a replacement capture node.
      if (engine.input) engine.input = {};
    }
    return engine.ctx;
  });
  const app = new App();
  app.syncGraph = () => engine.setGraph({ rate: app.active?.sampleRate || engine.rate, tracks: [], master: { gain: 1 } }, new Map());
  app.notify = vi.fn();
  app.multitrack = { recorder: new SessionRecorder(app) };
  apps.push(app);
  const doc = new Session({ name: 'Recording', sampleRate: 48000, tracks: 1 });
  doc.apply('Arm', S.updateTrack(doc.state, doc.state.tracks[0].id, { arm: true }));
  app.addDocument(doc);
  return { app, doc, recorder: app.multitrack.recorder };
}

it.each([{ rate: 48000 }, { rate: 24000 }, { rate: 24000, newInput: true }])('does not let an old take interrupt newer playback or input ($rate Hz, new input: $newInput)', async ({ rate, newInput: replaceInput }) => {
  const { app, doc, recorder } = setup();
  await recorder.start(doc);
  const transport = [];
  app.on('transport', (state) => transport.push({ state, busy: recorder.active }));
  engine.emit('record-data', [new Float32Array(480).fill(0.5)]);
  const other = AudioFile.blank({ name: 'Other.wav', sampleRate: rate, seconds: 0.01 });
  app.addDocument(other);
  await app.play();
  if (replaceInput) await engine.openInput();
  const newInput = engine.input;
  await vi.advanceTimersByTimeAsync(150);
  expect.soft(app.active?.id).toBe(other.id);
  expect.soft(engine.playing).toBe(true);
  expect.soft(app.playStart).toBe(0);
  expect.soft(engine.graph.rate).toBe(rate);
  const take = app.documents.find((d) => d !== doc && d !== other);
  expect(take.sampleRate).toBe(48000);
  expect.soft(take.length).toBe(456);
  expect(doc.state.clips).toHaveLength(1);
  expect(engine.input).toBe(replaceInput ? newInput : null);
  expect(recorder.active).toBe(false);
  expect(transport.at(-1)).toEqual({ state: 'playing', busy: false });
});
