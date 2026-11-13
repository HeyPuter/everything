import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Core, BLOCK } from '../src/engine/core.js';
import { Sequencer } from '../src/engine/sequencer.js';
import { compileChannel, compileMixer, compileSequence } from '../src/engine/compile.js';
import { createChannel, createClip, createProject } from '../src/model/project.js';

const module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
function setup(rate = 48000, bpm = 120) {
  const p = createProject(); p.bpm = bpm;
  const ch = createChannel({ type: 'audio', sample: 's', mixer: 1 }); p.channels = [ch];
  p.clips = [createClip({ kind: 'audio', ref: ch.id, len: 384 })];
  const core = new Core(new WebAssembly.Instance(module, {}), rate);
  core.x.set_click_gain(0);
  core.setMixer(compileMixer(p)); core.loadSample(0, [new Float32Array(rate * 3).fill(0.5)], rate);
  core.setChannel(compileChannel(p, ch, 0, () => 0));
  const seq = new Sequencer(core, rate, { loop: false });
  const compile = (p) => compileSequence(p, { mode: 'song', slotOf: () => 0 });
  seq.setSequence(compile(p));
  return { p, core, seq, compile };
}
function render(seq, frames) {
  let peak = 0;
  while (frames > 0) {
    const n = Math.min(BLOCK, frames), out = seq.block(n);
    for (const v of out.l.subarray(0, n)) peak = Math.max(peak, Math.abs(v));
    frames -= n;
  }
  return peak;
}
it.each([[48000, 120], [44100, 127], [96000, 137]])('does not resume audio in the final count-in frame at %s Hz / %s bpm', (rate, bpm) => {
  const { seq, core } = setup(rate, bpm);
  const start = vi.spyOn(core, 'audioOn');
  seq.play(48, { countIn: true });
  const countFrames = Math.ceil(240 / bpm * rate - 1e-6);
  expect(render(seq, countFrames)).toBe(0);
  expect(seq.counting).toBe(false); expect(seq.pos).toBe(48);
  expect(start).not.toHaveBeenCalled();
  expect(render(seq, 128)).toBeGreaterThan(0.01);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0][4]).toBe(0);
});

it.each(['stop', 'remove clip'])('cancels deferred count-in resume after %s', (action) => {
  const { seq, p, compile, core } = setup(); seq.play(48, { countIn: true });
  render(seq, 96000);
  const start = vi.spyOn(core, 'audioOn');
  if (action === 'stop') seq.stop();
  else seq.setSequence(compile({ ...p, clips: [] }));
  expect(render(seq, 2048)).toBe(0); expect(start).not.toHaveBeenCalled();
});
it.each(['seek', 'play', 'edit', 'stop and restart'])('resumes only once after %s at the count-in boundary', (action) => {
  const { seq, p, compile, core } = setup(); seq.play(48, { countIn: true });
  render(seq, 96000);
  const start = vi.spyOn(core, 'audioOn');
  if (action === 'seek') seq.seek(96);
  else if (action === 'play') seq.play(96);
  else if (action === 'edit') seq.setSequence(compile({ ...p, clips: [{ ...p.clips[0], len: 288 }] }));
  else { seq.stop(); seq.play(96); }
  expect(render(seq, 2048)).toBeGreaterThan(0.1);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0][2]).toBeCloseTo(action === 'edit' ? 0.25 : 0.5, 8);
});
it('keeps a new count-in silent after replacing the deferred start', () => {
  const { seq, core } = setup(); seq.play(48, { countIn: true }); render(seq, 96000);
  const start = vi.spyOn(core, 'audioOn');
  seq.play(96, { countIn: true });
  expect(render(seq, 96000)).toBe(0); expect(start).not.toHaveBeenCalled();
  expect(render(seq, 2048)).toBeGreaterThan(0.1); expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0][2]).toBeCloseTo(0.5, 8);
});
it('retains the correct frame offset when count-in ends inside a block', () => {
  const { seq, core } = setup(); seq.play(48, { countIn: true });
  expect(render(seq, 96000 - 47)).toBe(0);
  const start = vi.spyOn(core, 'audioOn');
  const out = seq.block(128).l.slice();
  expect([...out.subarray(0, 47)].every(v => v === 0)).toBe(true);
  expect(out[47]).toBeGreaterThan(0);
  expect(start).toHaveBeenCalledTimes(1); expect(start.mock.calls[0][4]).toBe(47);
});
it('starts a clip exactly at the playhead once after count-in', () => {
  const { seq, p, compile, core } = setup();
  seq.setSequence(compile({ ...p, clips: [{ ...p.clips[0], start: 48 }] }));
  seq.play(48, { countIn: true }); expect(render(seq, 96000)).toBe(0);
  const start = vi.spyOn(core, 'audioOn');
  expect(render(seq, 2048)).toBeGreaterThan(0.1); expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0][2]).toBe(0); expect(start.mock.calls[0][4]).toBe(0);
});
