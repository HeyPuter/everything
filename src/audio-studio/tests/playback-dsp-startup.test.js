import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { wasmBytes } from './fx-wasm.js';
import { Emitter } from '../src/lib/emitter.js';
import { Session } from '../src/model/session.js';
import * as S from '../src/model/session-edits.js';
import { SessionRecorder } from '../src/multitrack/recorder.js';

const mock = vi.hoisted(() => ({ bytes: vi.fn() }));
vi.mock('../src/audio/dsp.js', async (original) => ({ ...(await original()), dspBytes: mock.bytes }));
let Processor;
const engines = [];
beforeAll(async () => {
  globalThis.sampleRate = 48000;
  globalThis.currentTime = 0;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {} }; } };
  globalThis.registerProcessor = (_, cls) => { Processor = cls; };
  await import('../src/engine/mixer-worklet.js');
});
beforeEach(() => {
  mock.bytes.mockReset().mockResolvedValue(wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength));
  vi.stubGlobal('AudioContext', class {
    constructor({ sampleRate = 48000 } = {}) { Object.assign(this, { sampleRate, currentTime: 0, state: 'running', destination: {}, audioWorklet: { addModule: async () => {} } }); }
    async close() { this.state = 'closed'; }
  });
  vi.stubGlobal('AudioWorkletNode', class {
    constructor() {
      this.processor = new Processor();
      this.port = { postMessage: (m) => this.processor.onMessage(structuredClone(m)) };
      this.processor.port.postMessage = (m) => queueMicrotask(() => this.port.onmessage?.({ data: m }));
    }
    connect() {}
    disconnect() {}
  });
});
afterEach(() => {
  for (const e of engines.splice(0)) e.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(enabled = true) {
  const e = new Engine();
  engines.push(e);
  e.setGraph({ rate: 48000, tracks: [{ id: 'file', gain: 1, pan: 0, clips: [], fx: [{ key: 'amplify', kind: 1, params: [-40, -40, 1], enabled }] }], master: { gain: 1 } }, new Map());
  return e;
}

it('refuses dry playback when enabled effects cannot load, then retries successfully', async () => {
  mock.bytes.mockRejectedValue(new Error('Download failed'));
  const e = setup();
  await expect(e.play()).rejects.toThrow(/effect/i);
  expect(e.playing).toBe(false);
  mock.bytes.mockResolvedValue(wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength));
  await e.play();
  expect(e.playing).toBe(true);
  const p = e.node.processor;
  expect(p.host).toBeTruthy();
  const buf = [new Float32Array(128).fill(1), new Float32Array(128).fill(1)];
  for (let i = 0; i < 40; i++) p.host.run(p.graph.tracks[0].fx, buf.map((b) => b.fill(1)), 128);
  expect(buf[0][127]).toBeCloseTo(0.01, 3);
});

it.each([false, true])('waits for worklet compilation before playing enabled effects (cancel: %s)', async (cancel) => {
  const instantiate = WebAssembly.instantiate.bind(WebAssembly);
  let release;
  vi.spyOn(WebAssembly, 'instantiate').mockImplementationOnce((...args) => new Promise((resolve, reject) => { release = () => instantiate(...args).then(resolve, reject); }));
  const e = setup();
  const controller = new AbortController();
  const playing = e.play({ signal: controller.signal });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const beganEarly = e.playing;
  if (cancel) controller.abort();
  await release();
  await playing;
  expect(beganEarly).toBe(false);
  expect(e.playing).toBe(!cancel);
});

it('keeps plain playback available when bypassed effects cannot load', async () => {
  mock.bytes.mockRejectedValue(new Error('Download failed'));
  const e = setup(false);
  await e.play();
  expect(e.playing).toBe(true);
});

it.each(['clip', 'master'])('does not omit enabled %s effects after a failed download', async (where) => {
  mock.bytes.mockRejectedValue(new Error('Download failed'));
  const e = setup();
  const fx = e.graph.tracks[0].fx;
  e.graph.tracks[0].fx = [];
  if (where === 'master') e.graph.master.fx = fx;
  else e.graph.tracks[0].clips = [{ id: 'c', source: 'audio', channels: 1, start: 0, offset: 0, length: 128, fx }];
  await expect(e.play()).rejects.toThrow(/effect/i);
  expect(e.playing).toBe(false);
});

it('fetches fresh DSP bytes after a corrupt module fails in the worklet', async () => {
  const { dspBytes } = await vi.importActual('../src/audio/dsp.js');
  mock.bytes.mockImplementation(dspBytes);
  const fetch = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))
    .mockResolvedValueOnce(new Response(wasmBytes));
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const e = setup();
  await expect(e.play()).rejects.toThrow(/effect/i);
  await e.play();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(e.playing).toBe(true);
  expect(e.node.processor.host).toBeTruthy();
});

it('stops plain playback if an enabled effect is added while DSP is unavailable', async () => {
  mock.bytes.mockRejectedValue(new Error('Download failed'));
  const e = setup(false);
  const errors = [];
  e.on('engine-error', (message) => errors.push(message));
  await e.play();
  const graph = structuredClone(e.graph);
  graph.tracks[0].fx[0].enabled = true;
  e.setGraph(graph, new Map());
  expect(e.playing).toBe(false);
  expect(errors.some((message) => /effects/i.test(message))).toBe(true);
});

it('rejects startup if the worklet fails while compiling and replaces it on retry', async () => {
  const instantiate = WebAssembly.instantiate.bind(WebAssembly);
  let release;
  vi.spyOn(WebAssembly, 'instantiate').mockImplementationOnce((...args) => new Promise((resolve, reject) => { release = () => instantiate(...args).then(resolve, reject); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const e = setup();
  const playing = e.play().then(() => 'played', (err) => err);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const failedNode = e.node;
  failedNode.onprocessorerror(new Event('processorerror'));
  await release();
  const result = await playing;
  expect(result).toBeInstanceOf(Error);
  expect(e.playing).toBe(false);
  await e.play();
  expect(e.node === failedNode).toBe(false);
  expect(e.playing).toBe(true);
});

it('keeps refreshed DSP bytes cached if an older download fails afterward', async () => {
  const { dspBytes } = await vi.importActual('../src/audio/dsp.js');
  let fail;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
    .mockImplementation(async () => new Response(wasmBytes));
  vi.stubGlobal('fetch', fetch);
  const old = expect(dspBytes({ refresh: true })).rejects.toThrow('Old download failed');
  const fresh = await dspBytes({ refresh: true });
  fail(new Error('Old download failed'));
  await old;
  expect(await dspBytes()).toBe(fresh);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('reuses downloaded DSP bytes when playback changes sample rate', async () => {
  const { dspBytes } = await vi.importActual('../src/audio/dsp.js');
  const fetch = vi.fn(async () => new Response(wasmBytes));
  vi.stubGlobal('fetch', fetch);
  await dspBytes({ refresh: true });
  mock.bytes.mockImplementation(dspBytes);
  const e = setup();
  await e.play();
  e.setGraph({ ...e.graph, rate: 24000 }, new Map());
  await e.play();
  expect(e.playing).toBe(true);
  expect(fetch).toHaveBeenCalledOnce();
});

it('does not begin multitrack capture until effected playback is ready', async () => {
  const instantiate = WebAssembly.instantiate.bind(WebAssembly);
  let release;
  vi.spyOn(WebAssembly, 'instantiate').mockImplementationOnce((...args) => new Promise((resolve, reject) => { release = () => instantiate(...args).then(resolve, reject); }));
  const e = setup();
  vi.spyOn(e, 'openInput').mockResolvedValue(undefined);
  const capture = vi.spyOn(e, 'setRecording').mockImplementation(() => {});
  const doc = new Session({ name: 'Recording', sampleRate: 48000, tracks: 1 });
  doc.apply('Arm', S.updateTrack(doc.state, doc.state.tracks[0].id, { arm: true }));
  const app = Object.assign(new Emitter(), { engine: e, active: doc, notify: vi.fn() });
  const recorder = new SessionRecorder(app);
  const starting = recorder.start(doc);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const capturedEarly = capture.mock.calls.some(([on]) => on);
  await release();
  await starting;
  const capturedAfterReady = capture.mock.calls.some(([on]) => on);
  await recorder.stop();
  expect(capturedEarly).toBe(false);
  expect(capturedAfterReady).toBe(true);
});
