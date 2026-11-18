import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Dsp } from '../src/audio/dsp.js';
import { wasmBytes } from './fx-wasm.js';
import { createRecorder } from '../src/record/recorder.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Emitter } from '../src/lib/emitter.js';

const mock = vi.hoisted(() => ({ dsp: vi.fn() }));
vi.mock('../src/audio/dsp.js', async (original) => ({ ...(await original()), dsp: mock.dsp }));
const processor = new Dsp(new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {}));
beforeEach(() => { vi.useFakeTimers(); mock.dsp.mockReset(); });
afterEach(() => vi.useRealTimers());

function setup() {
  const app = new Emitter();
  app.engine = Object.assign(new Emitter(), {
    rate: 48000, openInput: vi.fn(async () => {}), closeInput: vi.fn(), setRecording: vi.fn(),
  });
  app.prefs = { get: () => null };
  app.setStatus = vi.fn();
  app.meterInput = vi.fn();
  app.documents = [];
  app.addDocument = (doc) => app.documents.push(doc);
  app.uniqueName = (base, ext = '') => base + ext;
  app.notify = vi.fn();
  const doc = AudioFile.blank({ sampleRate: 24000, channels: 1 });
  return { app, doc, rec: createRecorder(app) };
}

it('keeps one take active until resampling and commit finish, including repeated Stop', async () => {
  let ready;
  mock.dsp.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
  const { app, doc, rec } = setup();
  await rec.start({ doc });
  app.engine.emit('record-data', [new Float32Array(480).fill(0.5)]);
  const first = rec.stop();
  await vi.advanceTimersByTimeAsync(120);
  const activeWhileConverting = rec.active;
  const repeated = rec.stop();
  await rec.start({ doc });
  ready(processor);
  const result = await first;
  const repeatedResult = await repeated;
  expect(activeWhileConverting).toBe(true);
  expect(app.engine.openInput).toHaveBeenCalledOnce();
  expect(repeatedResult).toBe(result);
  expect(result.frames).toBe(240);
  expect(doc.length).toBe(240);
  expect(rec.active).toBe(false);
  expect(app.recording).toBe(false);
  await rec.start({ doc });
  expect(app.engine.openInput).toHaveBeenCalledTimes(2);
  const next = rec.stop();
  await vi.advanceTimersByTimeAsync(120);
  await next;
});

it('releases finalization state if sample-rate conversion fails', async () => {
  mock.dsp.mockRejectedValue(new Error('DSP unavailable'));
  const { app, doc, rec } = setup();
  await rec.start({ doc });
  app.engine.emit('record-data', [new Float32Array(480).fill(0.5)]);
  const result = rec.stop();
  await vi.advanceTimersByTimeAsync(120);
  expect(await result).toMatchObject({ recovered: true, sampleRate: 48000, frames: 480 });
  expect(rec.active).toBe(false);
  expect(app.recording).toBe(false);
  await rec.start({ doc });
  expect(app.engine.openInput).toHaveBeenCalledTimes(2);
  const next = rec.stop();
  await vi.advanceTimersByTimeAsync(120);
  await next;
});

it.each([false, true])('preserves captured audio at its native rate when conversion fails (later edit: %s)', async (edited) => {
  mock.dsp.mockRejectedValue(new Error('DSP unavailable'));
  const { app, doc, rec } = setup();
  const original = doc.state;
  await rec.start({ doc });
  const samples = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 10) * 0.5);
  app.engine.emit('record-data', [samples]);
  await vi.advanceTimersByTimeAsync(120); // A live preview has already reached the document.
  if (edited) doc.apply('Rename marker', { ...doc.state, markers: [{ id: 'm', start: 0, name: 'Keep me', duration: 0 }] });
  const beforeStop = doc.state;
  const stopping = rec.stop();
  await vi.advanceTimersByTimeAsync(120);
  await stopping;
  expect(app.documents).toHaveLength(1);
  const recovered = app.documents[0];
  expect(recovered.sampleRate).toBe(48000);
  expect(recovered.length).toBe(480);
  expect(recovered.dirty).toBe(true);
  expect(recovered.state.channels[0].toArray()).toEqual(samples);
  expect(doc.state).toBe(edited ? beforeStop : original);
  expect(app.notify).toHaveBeenCalledWith(expect.stringContaining('Files panel'), { error: true });
  expect(rec.active).toBe(false);
});

it.each(['punch', 'external'])('recovers conversion failures for %s recording without an unhandled rejection', async (mode) => {
  mock.dsp.mockRejectedValue(new Error('DSP unavailable'));
  const { app, doc, rec } = setup();
  await rec.start(mode === 'punch' ? { doc, replace: [0, 240] } : { channels: 1, sampleRate: 24000 });
  const samples = new Float32Array(480).fill(0.5);
  app.engine.emit('record-data', [samples]);
  // Punch-out calls stop internally; external clients consume its result.
  const stopping = mode === 'external' ? rec.stop() : null;
  await vi.advanceTimersByTimeAsync(240);
  if (stopping) expect(await stopping).toMatchObject({ recovered: true, sampleRate: 48000 });
  expect(app.documents).toHaveLength(1);
  expect(app.documents[0].state.channels[0].toArray()).toEqual(samples);
  expect(app.documents[0].dirty).toBe(true);
  expect(rec.active).toBe(false);
});
