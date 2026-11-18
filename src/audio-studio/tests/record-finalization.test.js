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
  const result = expect(rec.stop()).rejects.toThrow('DSP unavailable');
  await vi.advanceTimersByTimeAsync(120);
  await result;
  expect(rec.active).toBe(false);
  expect(app.recording).toBe(false);
  await rec.start({ doc });
  expect(app.engine.openInput).toHaveBeenCalledTimes(2);
  const next = rec.stop();
  await vi.advanceTimersByTimeAsync(120);
  await next;
});
