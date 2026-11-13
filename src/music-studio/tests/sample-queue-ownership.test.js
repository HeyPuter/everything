import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { App } from '../src/app.js';
import { LiveInput } from '../src/input/live.js';
import { Library } from '../src/storage/library.js';
import { ProjectFiles } from '../src/storage/files.js';
import { memoryDB } from '../src/storage/idb.js';
import { createChannel, createProject } from '../src/model/project.js';
import { encodeWav, decodeWavSamples } from '../src/io/wav.js';
import * as E from '../src/model/edits.js';

const RATE = 48000;
const module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
const sample = gain => ({ channels: [Float32Array.from({ length: RATE }, (_, i) => Math.sin(i * .03) * gain)], rate: RATE });
const wav = gain => new Blob([encodeWav(sample(gain), { bits: 16, dither: false })], { type: 'audio/wav' });
const decode = buffer => decodeWavSamples(Uint8Array.from(new Uint8Array(buffer)).buffer);
let Processor;
beforeAll(async () => {
  vi.stubGlobal('sampleRate', RATE); vi.stubGlobal('currentTime', 0);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null, postMessage: vi.fn() }; });
  vi.stubGlobal('registerProcessor', (_name, ctor) => { Processor = ctor; });
  vi.stubGlobal('OfflineAudioContext', class {
    async decodeAudioData(buffer) {
      const d = decode(buffer);
      return { numberOfChannels: d.channels.length, sampleRate: d.rate, getChannelData: i => d.channels[i] };
    }
  });
  await import('../src/engine/worklet.js');
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = ''; });
function setup(type = 'sampler', initialized = true) {
  vi.useFakeTimers();
  const p = createProject(), ch = createChannel({ type, mixer: 1 }); p.channels = [ch];
  const app = new App(document.createElement('div'), { project: p, storage: { getItem: () => null, setItem() {} } });
  app.notify = vi.fn();
  const processor = new Processor(), send = data => processor.port.onmessage({ data });
  const initialize = () => send({ type: 'init', module }); if (initialized) initialize();
  app.engine.node = { port: { postMessage: send } }; app.engine.start = vi.fn().mockResolvedValue(true);
  app.store.load(p); app.store.selectChannels([ch.id]);
  const lib = new Library({ db: memoryDB(), puter: { isSignedIn: () => false }, decode });
  const files = new ProjectFiles(app, lib), live = new LiveInput(app, null);
  const load = gain => files.importAudio(wav(gain), { name: 'tone.wav', channel: ch.id });
  const peak = () => {
    let peak = 0;
    for (let i = 0; i < 32; i++) {
      const l = new Float32Array(128), r = new Float32Array(128);
      expect(processor.process([], [[l, r]])).toBe(true);
      for (const v of l) peak = Math.max(peak, Math.abs(v));
    }
    expect(processor.failed).toBe(false); return peak;
  };
  return { app, ch, load, live, peak, processor, initialize };
}
it.each(['sampler', 'audio'])('does not play a queued %s note using a newly imported replacement sample', async type => {
  const { load, live, peak } = setup(type);
  await load(.1); live.noteOn(60, .8, 'midi'); await load(.5);
  expect(peak()).toBe(0);
  live.noteOff(60, 'midi'); live.noteOn(60, .8, 'midi');
  expect(peak()).toBeGreaterThan(.01);
});
it.each(['sampler', 'audio'])('does not revive a queued %s note after sample bytes are replaced at the same ID', async type => {
  const { app, load, live, peak } = setup(type);
  const imported = await load(.1); live.noteOn(60, .8, 'midi');
  app.samples.set(imported.sampleId, sample(.5));
  expect(peak()).toBe(0);
});
it.each(['sampler', 'audio'])('does not revive a queued %s note after sample removal and reload', async type => {
  const { app, load, live, peak } = setup(type);
  const imported = await load(.1); live.noteOn(60, .8, 'midi');
  app.samples.delete(imported.sampleId); app.samples.set(imported.sampleId, sample(.5));
  expect(peak()).toBe(0);
});

it.each(['sampler', 'audio'])('preserves a queued %s note waiting for the first sample arrival', type => {
  const { app, ch, live, peak } = setup(type);
  app.store.apply('Assign sample', p => E.updateChannel(p, ch.id, { sample: 'pending' }));
  live.noteOn(60, .8, 'midi'); app.samples.set('pending', sample(.5));
  expect(peak()).toBeGreaterThan(.01);
});
it.each(['sampler', 'audio'])('keeps rendered %s replacement behavior silent until a fresh note', async type => {
  const { load, live, peak } = setup(type);
  await load(.1); live.noteOn(60, .8, 'midi'); expect(peak()).toBeGreaterThan(.001);
  await load(.5); expect(peak()).toBe(0);
  live.noteOff(60, 'midi'); live.noteOn(60, .8, 'midi'); expect(peak()).toBeGreaterThan(.01);
});
it('cancels old-sample notes queued before worklet initialization', async () => {
  const { load, live, peak, initialize } = setup('sampler', false);
  await load(.1); live.noteOn(60, .8, 'midi'); await load(.5); initialize();
  expect(peak()).toBe(0);
  live.noteOff(60, 'midi'); live.noteOn(60, .8, 'midi'); expect(peak()).toBeGreaterThan(.01);
});
it('preserves queued notes on a different sample when bytes are replaced', async () => {
  const { app, load, live, peak } = setup(); const imported = await load(.1);
  app.samples.set('other', sample(.3)); app.addChannel({ type: 'sampler', sample: 'other' });
  live.noteOn(67, .8, 'midi'); app.samples.set(imported.sampleId, sample(.5));
  expect(peak()).toBeGreaterThan(.01);
});
it('cancels every channel using replaced sample bytes, then accepts fresh notes', async () => {
  const { app, ch, load, live, peak } = setup(); const imported = await load(.1);
  live.noteOn(60, .8, 'midi'); const second = app.addChannel({ type: 'sampler', sample: imported.sampleId });
  app.engine.noteOn(second, 67, .8); app.samples.set(imported.sampleId, sample(.5));
  expect(peak()).toBe(0);
  app.engine.noteOn(ch.id, 62, .8); app.engine.noteOn(second, 69, .8);
  expect(peak()).toBeGreaterThan(.01);
});
it('preserves queued notes through unchanged sample assignment and volume edits', async () => {
  const { app, ch, load, live, peak, processor } = setup(); const imported = await load(.1);
  live.noteOn(60, .8, 'midi');
  processor.core.x.ch_set_sample(app.engine._slots.get(ch.id), app.engine._sampleIndex.get(imported.sampleId));
  app.store.apply('Volume', p => E.updateChannel(p, ch.id, { volume: .5 }));
  expect(peak()).toBeGreaterThan(.001);
});
it('preserves transport clicks when sample replacement clears slot zero', async () => {
  const a = setup(), b = setup(); const imported = await a.load(.1);
  a.processor.core.click(true, 0); b.processor.core.click(true, 0);
  a.app.samples.set(imported.sampleId, sample(.5));
  const expected = b.peak(); expect(expected).toBeGreaterThan(.01); expect(a.peak()).toBe(expected);
});
