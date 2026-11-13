import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { App } from '../src/app.js';
import { LiveInput } from '../src/input/live.js';
import { channelActions } from '../src/rack/actions.js';
import { createChannel, createClip, createNote, createProject } from '../src/model/project.js';
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
  const peak = (blocks = 32) => {
    let peak = 0;
    for (let i = 0; i < blocks; i++) {
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

it("does not schedule the deleted channel's pattern into its reused slot before the throttled sequence update", async () => {
  const { app, ch, actions, peak, processor } = setup();
  app.store.apply('Add note', p => ({ ...p, patterns: [{ ...p.patterns[0], notes: { [ch.id]: [createNote({ key: 60, pos: 0, len: 24 })] } }] }));
  await app.engine.play();
  const removing = actions.remove([ch.id]);
  [...document.querySelectorAll('.dialog button')].find(b => b.textContent === 'Delete').click();
  await removing;
  app.addChannel({ type: 'synth' });
  expect(processor.seq.seq.notes.count).toBe(1);
  expect(app.engine._seqTimer).not.toBeNull();
  expect(peak(1)).toBe(0);
});

async function removeConfirmed(actions, id) {
  const removing = actions.remove([id]);
  const button = [...document.querySelectorAll('.dialog button')].find(b => b.textContent === 'Delete');
  button?.click();
  await removing;
}
function addNotes(app, notes) {
  app.store.apply('Add notes', p => ({ ...p, patterns: [{ ...p.patterns[0], notes }] }));
}
it('allows new live notes on the reused slot while the sequence update is pending', async () => {
  const { app, ch, actions, live, peak } = setup();
  addNotes(app, { [ch.id]: [createNote({ pos: 0, len: 24 })] }); await app.engine.play();
  await removeConfirmed(actions, ch.id); app.addChannel({ type: 'synth' });
  live.noteOn(67, .8, 'midi'); expect(peak()).toBeGreaterThan(.01);
});
it('allows newly compiled pattern notes on a reused slot', async () => {
  const { app, ch, actions, peak } = setup();
  addNotes(app, { [ch.id]: [createNote({ pos: 0, len: 24 })] }); await app.engine.play();
  await removeConfirmed(actions, ch.id); const replacement = app.addChannel({ type: 'synth' });
  expect(peak(1)).toBe(0);
  addNotes(app, { [replacement]: [createNote({ pos: 1, len: 24 })] });
  vi.advanceTimersByTime(30);
  expect(peak()).toBeGreaterThan(.01);
});
it("keeps another channel's old sequence playing during the throttle window", async () => {
  const a = setup(), b = setup();
  const secondA = a.app.addChannel({ type: 'synth' }), secondB = b.app.addChannel({ type: 'synth' });
  addNotes(a.app, { [a.ch.id]: [createNote({ key: 60 })], [secondA]: [createNote({ key: 67 })] });
  addNotes(b.app, { [secondB]: [createNote({ key: 67 })] });
  await a.app.engine.play(); await b.app.engine.play();
  await removeConfirmed(a.actions, a.ch.id); a.app.addChannel({ type: 'synth' });
  const expected = b.peak(); expect(expected).toBeGreaterThan(.01);
  expect(a.peak()).toBeCloseTo(expected, 7);
});
it("does not apply the removed channel's automation to new live notes on its slot", async () => {
  const { app, ch, actions, live, peak, processor } = setup();
  app.store.apply('Automation', p => ({ ...p, clips: [createClip({ kind: 'auto', ref: 'a', len: 384 })], automation: { a: { id: 'a', target: { kind: 'channel', id: ch.id, param: 'volume' }, points: [{ t: 0, v: 0 }] } } }));
  app.engine.mode = 'song'; await app.engine.play();
  expect(processor.seq.lanes).toHaveLength(1);
  await actions.remove([ch.id]); app.addChannel({ type: 'synth' });
  live.noteOn(60, .8, 'midi'); expect(peak()).toBeGreaterThan(.01);
  expect(processor.seq.lanes).toHaveLength(0);
});
it.each([96, 383.99])('does not resume or wrap deleted audio into a replacement at tick %s', async tick => {
  const { app, ch, actions, peak } = setup({ type: 'audio' });
  app.samples.set('s', { channels: [new Float32Array(48000 * 3).fill(.2)], rate: 48000 });
  app.store.apply('Audio clip', p => ({ ...E.updateChannel(p, ch.id, { sample: 's' }), clips: [createClip({ kind: 'audio', ref: ch.id, len: 384 })] }));
  app.engine.mode = 'song'; app.engine.seek(48); await app.engine.play();
  await removeConfirmed(actions, ch.id);
  const replacement = app.addChannel({ type: 'audio', sample: 's' });
  app.engine.seek(tick); expect(peak(8)).toBe(0);
  app.store.apply('Replacement clip', p => ({ ...p, clips: [createClip({ kind: 'audio', ref: replacement, len: 384 })] }));
  vi.advanceTimersByTime(30);
  expect(peak()).toBeGreaterThan(.01);
});
it('resumes restored audio after undo and a fresh sequence update', async () => {
  const { app, ch, actions, peak } = setup({ type: 'audio' });
  app.samples.set('s', { channels: [new Float32Array(48000 * 3).fill(.2)], rate: 48000 });
  app.store.apply('Audio clip', p => ({ ...E.updateChannel(p, ch.id, { sample: 's' }), clips: [createClip({ kind: 'audio', ref: ch.id, len: 384 })] }));
  app.engine.mode = 'song'; app.engine.seek(48); await app.engine.play();
  expect(peak(8)).toBeGreaterThan(.01);
  await removeConfirmed(actions, ch.id); app.store.undo();
  expect(peak(1)).toBe(0);
  vi.advanceTimersByTime(30);
  expect(peak()).toBeGreaterThan(.01);
});
