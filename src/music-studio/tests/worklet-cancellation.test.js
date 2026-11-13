import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { compileChannel, compileMixer, compileSequence } from '../src/engine/compile.js';
import { createChannel, createClip, createProject } from '../src/model/project.js';

const RATE = 48000;
const module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
let Processor;
beforeAll(async () => {
  vi.stubGlobal('sampleRate', RATE); vi.stubGlobal('currentTime', 0);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null, postMessage: vi.fn() }; });
  vi.stubGlobal('registerProcessor', (_name, constructor) => { Processor = constructor; });
  await import('../src/engine/worklet.js');
});
afterAll(() => vi.unstubAllGlobals());
function setup() {
  const p = createProject(); p.bpm = 120;
  const ch = createChannel({ type: 'audio', sample: 's', mixer: 1 }); p.channels = [ch];
  p.clips = [createClip({ kind: 'audio', ref: ch.id, len: 192 })];
  const processor = new Processor();
  const send = (data) => processor.port.onmessage({ data });
  const configure = () => {
    send({ type: 'mixer', mixer: compileMixer(p) });
    send({ type: 'channel', cfg: compileChannel(p, ch, 0, () => 0) });
    send({ type: 'sample', index: 0, channels: [new Float32Array(RATE).fill(0.5)], rate: RATE });
    send({ type: 'seq', seq: compileSequence(p, { mode: 'song', slotOf: () => 0 }) });
  };
  const peak = () => {
    let peak = 0;
    for (let i = 0; i < 16; i++) {
      const l = new Float32Array(128), r = new Float32Array(128);
      expect(processor.process([], [[l, r]])).toBe(true);
      for (const v of l) peak = Math.max(peak, Math.abs(v));
    }
    expect(processor.failed).toBe(false);
    return peak;
  };
  return { send, configure, peak };
}
it.each(['ready', 'initializing'])('cancels worklet play/stop messages before audio rendering (%s)', (state) => {
  const { send, configure, peak } = setup();
  if (state === 'ready') send({ type: 'init', module });
  configure(); send({ type: 'play', tick: 48 }); send({ type: 'stop' });
  if (state === 'initializing') send({ type: 'init', module });
  expect(peak()).toBe(0);
  send({ type: 'play', tick: 48 }); expect(peak()).toBeGreaterThan(0.01);
});
it('cancels an unrendered worklet preview on the all-off message', () => {
  const { send, configure, peak } = setup(); send({ type: 'init', module }); configure();
  send({ type: 'play', tick: 48 }); send({ type: 'allOff', hard: true });
  expect(peak()).toBe(0);
});
