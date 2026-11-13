import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { App } from '../src/app.js';
import { LiveInput } from '../src/input/live.js';
import { channelActions } from '../src/rack/actions.js';
import { createChannel, createProject } from '../src/model/project.js';
import * as E from '../src/model/edits.js';

const module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
let Processor;
beforeAll(async () => {
  vi.stubGlobal('sampleRate', 48000); vi.stubGlobal('currentTime', 0);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null, postMessage: vi.fn() }; });
  vi.stubGlobal('registerProcessor', (_name, ctor) => { Processor = ctor; });
  await import('../src/engine/worklet.js');
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ''; });
function setup({ initialized = true, type = 'synth' } = {}) {
  vi.useFakeTimers();
  const p = createProject(), ch = createChannel({ type, mixer: 1 }); p.channels = [ch];
  const app = new App(document.createElement('div'), { project: p, storage: { getItem: () => null, setItem() {} } });
  app.notify = vi.fn();
  const processor = new Processor();
  const send = data => processor.port.onmessage({ data });
  const initialize = () => send({ type: 'init', module });
  if (initialized) initialize();
  app.engine.node = { port: { postMessage: send } };
  app.engine.start = vi.fn().mockResolvedValue(true);
  app.store.load(p); app.store.selectChannels([ch.id]);
  const live = new LiveInput(app, null), actions = channelActions(app);
  const peak = () => {
    let peak = 0;
    for (let i = 0; i < 32; i++) {
      const l = new Float32Array(128), r = new Float32Array(128);
      expect(processor.process([], [[l, r]])).toBe(true);
      for (const v of l) peak = Math.max(peak, Math.abs(v));
    }
    expect(processor.failed).toBe(false);
    return peak;
  };
  return { app, ch, live, actions, peak, processor, initialize };
}
it('does not move an unrendered live note into a newly added channel after deletion', async () => {
  const { app, ch, live, actions, peak } = setup();
  live.noteOn(60, .8, 'midi');
  const originalSlot = app.engine._slots.get(ch.id);
  await actions.remove([ch.id]);
  const replacement = app.addChannel({ type: 'synth', name: 'Replacement' });
  expect(app.engine._slots.get(replacement)).toBe(originalSlot);
  live.noteOff(60, 'midi');
  expect(peak()).toBe(0);
});
it.each([false, true])('discards the old instrument voice on type change (already rendered %s)', started => {
  const { app, ch, live, actions, peak } = setup();
  live.noteOn(60, .8, 'midi');
  if (started) expect(peak()).toBeGreaterThan(.01);
  actions.changeType([ch.id], 'drum');
  expect(peak()).toBe(0);
  live.noteOff(60, 'midi'); live.noteOn(60, .8, 'midi');
  expect(peak()).toBeGreaterThan(.01);
});
it('does not revive a queued live note when undo restores a deleted channel', async () => {
  const { app, ch, live, actions, peak } = setup();
  live.noteOn(60, .8, 'midi');
  await actions.remove([ch.id]); app.store.undo();
  expect(peak()).toBe(0);
  live.noteOff(60, 'midi'); live.noteOn(60, .8, 'midi');
  expect(peak()).toBeGreaterThan(.01);
});

it('drops deleted-channel notes even when all messages precede worklet initialization', async () => {
  const { app, ch, live, actions, peak, initialize } = setup({ initialized: false });
  live.noteOn(60, .8, 'midi'); await actions.remove([ch.id]);
  app.addChannel({ type: 'synth' }); live.noteOff(60, 'midi'); initialize();
  expect(peak()).toBe(0);
  live.noteOn(60, .8, 'midi'); expect(peak()).toBeGreaterThan(.01);
});
it("preserves another channel's queued live note when the first channel is deleted", async () => {
  const a = setup(), b = setup();
  const secondA = a.app.addChannel({ type: 'synth' }), secondB = b.app.addChannel({ type: 'synth' });
  a.app.engine.noteOn(a.ch.id, 60, .8); a.app.engine.noteOn(secondA, 67, .8);
  b.app.engine.noteOn(secondB, 67, .8);
  await a.actions.remove([a.ch.id]);
  const expected = b.peak(); expect(expected).toBeGreaterThan(.01);
  expect(a.peak()).toBeCloseTo(expected, 7);
});
it.each(['same instrument', 'volume edit'])('preserves queued notes through a %s', action => {
  const { app, ch, live, actions, peak } = setup(); live.noteOn(60, .8, 'midi');
  if (action === 'same instrument') actions.changeType([ch.id], 'synth');
  else app.store.apply('Volume', p => E.updateChannel(p, ch.id, { volume: .5 }));
  expect(peak()).toBeGreaterThan(.01);
});
it('does not remove queued transport clicks when replacing slot zero', () => {
  const a = setup(), b = setup();
  expect(a.app.engine._slots.get(a.ch.id)).toBe(0);
  a.processor.core.click(true, 0); b.processor.core.click(true, 0);
  a.actions.changeType([a.ch.id], 'drum');
  const expected = b.peak(); expect(expected).toBeGreaterThan(.01);
  expect(a.peak()).toBe(expected);
});
it('keeps a global hard release when a different instrument is replaced', () => {
  const { app, ch, actions, peak, processor } = setup();
  const second = app.addChannel({ type: 'synth' }); app.engine.noteOn(second, 67, .8);
  expect(peak()).toBeGreaterThan(.01);
  processor.core.allOff(undefined, true); actions.changeType([ch.id], 'drum');
  expect(peak()).toBe(0);
});
it('does not carry an old scheduled release into the replacement instrument', () => {
  const a = setup({ type: 'drum' }), b = setup({ type: 'drum' });
  a.processor.core.noteOff(0, 0x8000003c, 64);
  a.actions.changeType([a.ch.id], 'synth'); b.actions.changeType([b.ch.id], 'synth');
  a.live.noteOn(60, .8, 'midi'); b.live.noteOn(60, .8, 'midi');
  const expected = b.peak(); expect(expected).toBeGreaterThan(.01);
  expect(a.peak()).toBe(expected);
});
