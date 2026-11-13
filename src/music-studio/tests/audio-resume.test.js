import { afterEach, expect, it, vi } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';

const settle = () => new Promise((resolve) => setTimeout(resolve));
const engines = [];
afterEach(() => {
  for (const engine of engines.splice(0)) {
    if (engine._resumeHook) {
      document.removeEventListener('pointerdown', engine._resumeHook, true);
      document.removeEventListener('keydown', engine._resumeHook, true);
    }
    clearTimeout(engine._seqTimer);
  }
  vi.unstubAllGlobals();
});

async function setup() {
  let ctx;
  vi.stubGlobal('AudioContext', class {
    constructor() { ctx = this; }
    state = 'suspended';
    sampleRate = 48000;
    currentTime = 0;
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => {}) };
    resume = vi.fn(() => new Promise(() => {}));
    close = vi.fn(async () => {});
  });
  vi.stubGlobal('AudioWorkletNode', class {
    port = { postMessage: vi.fn(), close: vi.fn() };
    connect = vi.fn();
    disconnect = vi.fn();
  });
  // The control-thread test only needs a compilable module; no DSP runs here.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, headers: { get: () => null },
    arrayBuffer: async () => Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]).buffer,
  })));
  const engine = new Engine(new Store(newProject()), { get: () => undefined });
  engines.push(engine);
  expect(await engine.start()).toBe(true);
  expect(ctx.resume).toHaveBeenCalledOnce();
  return { engine, ctx };
}

it.each(['rejects', 'stays pending'])('retries audio on a later gesture when the first resume %s', async (outcome) => {
  const { engine, ctx } = await setup();
  ctx.resume.mockImplementationOnce(() => outcome === 'rejects'
    ? Promise.reject(new Error('Audio device temporarily unavailable'))
    : new Promise(() => {}));
  document.dispatchEvent(new Event('pointerdown'));
  await settle();
  expect(ctx.resume).toHaveBeenCalledTimes(2);
  expect(ctx.state).toBe('suspended');
  ctx.resume.mockImplementationOnce(async () => { ctx.state = 'running'; });
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
  await settle();
  expect(ctx.resume).toHaveBeenCalledTimes(3);
  expect(ctx.state).toBe('running');
  expect(engine.node).not.toBe(null);
  document.dispatchEvent(new Event('pointerdown'));
  await settle();
  expect(ctx.resume).toHaveBeenCalledTimes(3);
});

it('stops retrying if audio resumes independently before the next gesture', async () => {
  const { ctx } = await setup();
  ctx.state = 'running';
  document.dispatchEvent(new Event('pointerdown'));
  await settle();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
  expect(ctx.resume).toHaveBeenCalledOnce();
});

it('keeps the replacement context retry available when an old resume later succeeds', async () => {
  const { engine, ctx } = await setup();
  let finishOld;
  ctx.resume.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  document.dispatchEvent(new Event('pointerdown'));
  await engine.restart();
  const current = engine.ctx;
  expect(current).not.toBe(ctx);
  expect(current.resume).toHaveBeenCalledOnce();
  ctx.state = 'running';
  finishOld();
  await settle();
  current.resume.mockImplementationOnce(async () => { current.state = 'running'; });
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
  await settle();
  expect(current.resume).toHaveBeenCalledTimes(2);
  expect(current.state).toBe('running');
});
