import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Core, BLOCK } from '../src/engine/core.js';
import { Sequencer } from '../src/engine/sequencer.js';
import { compileChannel, compileMixer, compileSequence } from '../src/engine/compile.js';
import { createChannel, createClip, createProject } from '../src/model/project.js';

const RATE = 48000;
const module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
const sample = Float32Array.from({ length: RATE }, (_, i) => Math.sin(2 * Math.PI * 400 * i / RATE) * (i < RATE / 2 ? 0.1 : 0.4));
function setup(type = 'audio') {
  const p = createProject(); p.bpm = 120;
  const ch = createChannel({ type, sample: 's', mixer: 1 }); p.channels = [ch];
  p.clips = [createClip({ kind: 'audio', ref: ch.id, len: 192 })];
  const core = new Core(new WebAssembly.Instance(module, {}), RATE);
  core.setMixer(compileMixer(p)); core.loadSample(0, [sample], RATE);
  core.setChannel(compileChannel(p, ch, 0, () => 0));
  const compile = (p) => compileSequence(p, { mode: 'song', slotOf: () => 0 });
  const seq = new Sequencer(core, RATE, { loop: false }); seq.setSequence(compile(p));
  return { p, ch, core, seq, compile };
}
function render(renderer, seconds = 0.03) {
  let peak = 0;
  for (let f = 0; f < Math.round(seconds * RATE); f += BLOCK) {
    const n = Math.min(BLOCK, Math.round(seconds * RATE) - f);
    const out = renderer instanceof Sequencer ? renderer.block(n) : renderer.process(n);
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out.l[i]), Math.abs(out.r[i]));
  }
  return peak;
}
it.each(['stop', 'remove clip'])('cancels a queued mid-clip start on %s before rendering', (action) => {
  const { seq, p, compile } = setup(); seq.play(48);
  if (action === 'stop') seq.stop();
  else seq.setSequence(compile({ ...p, clips: [] }));
  expect(render(seq)).toBe(0);
});
it.each(['seek', 'stop and restart'])('keeps only the latest resumed voice after %s before a block', (action) => {
  const a = setup(), b = setup(); a.seq.play(48);
  if (action === 'seek') a.seq.seek(96);
  else { a.seq.stop(); a.seq.play(96); }
  b.seq.play(96);
  render(a.seq); render(b.seq);
  expect(render(a.seq)).toBeCloseTo(render(b.seq), 5);
});
it.each(['synth', 'drum', 'sampler'])('cancels a queued %s attack released before its first frame', (type) => {
  const { core } = setup(type); core.noteOn(0, 100, 60, 1); core.noteOff(0, 100);
  expect(render(core)).toBe(0);
});
it.each(['audioOn', 'audioAt'])('cancels a queued %s released before its first frame', (method) => {
  const { core } = setup(); core[method](0, 100, 0.25); core.noteOff(0, 100);
  expect(render(core)).toBe(0);
});
it.each([false, true])('cancels queued audio on all-off (hard %s)', (hard) => {
  const { core } = setup(); core.audioOn(0, 100, 0.25); core.allOff(undefined, hard);
  expect(render(core)).toBe(0);
});
it.each([false, true])('preserves a later retrigger with the same ID (prior voice rendered %s)', (started) => {
  const a = setup(), b = setup(); a.core.audioOn(0, 7, 0.25);
  if (started) render(a.core);
  a.core.noteOff(0, 7); a.core.audioOn(0, 7, 0.5);
  b.core.audioOn(0, 7, 0.5);
  render(a.core); render(b.core);
  expect(render(a.core)).toBeCloseTo(render(b.core), 5);
});
it.each(['note', 'channel', 'hard channel'])('isolates %s cancellation from the same ID on another channel', (action) => {
  const a = setup(), b = setup();
  const second = { ...a.ch, id: 'second', mixer: 2 };
  a.core.setChannel(compileChannel(a.p, second, 1, () => 0));
  a.core.audioOn(0, 7, 0.25); a.core.audioOn(1, 7, 0.5);
  if (action === 'note') a.core.noteOff(0, 7);
  else a.core.allOff(0, action === 'hard channel');
  b.core.audioOn(0, 7, 0.5);
  render(a.core); render(b.core);
  expect(render(a.core)).toBeCloseTo(render(b.core), 5);
});
it('preserves another note ID in the same channel', () => {
  const a = setup(), b = setup();
  a.core.audioOn(0, 7, 0.25); a.core.audioOn(0, 8, 0.5); a.core.noteOff(0, 7);
  b.core.audioOn(0, 8, 0.5);
  render(a.core); render(b.core);
  expect(render(a.core)).toBeCloseTo(render(b.core), 5);
});
it.each(['note', 'all'])('cancels a future queued start released earlier in the block (%s)', (action) => {
  const { core } = setup(); core.audioOn(0, 7, 0.25, 1, 90);
  if (action === 'note') core.noteOff(0, 7, 30);
  else core.allOff(undefined, false, 30);
  expect(render(core)).toBe(0);
});
it.each(['note', 'all'])('preserves a scheduled note duration before its later %s release', (action) => {
  const { core } = setup(); core.audioOn(0, 7, 0.25, 1, 10);
  if (action === 'note') core.noteOff(0, 7, 70);
  else core.allOff(undefined, false, 70);
  const out = core.process(BLOCK).l.slice();
  expect(out.subarray(0, 10).every((v) => v === 0)).toBe(true);
  expect(out.subarray(10, 70).some((v) => Math.abs(v) > 0.001)).toBe(true);
  render(core); expect(render(core)).toBe(0);
});
it('uses actual clamped frame offsets when canceling queued starts', () => {
  const { core } = setup(); core.audioOn(0, 7, 0.25, 1, 100); core.noteOff(0, 7, 200);
  expect([...core.process(64).l.subarray(0, 64)].every((v) => v === 0)).toBe(true);
  expect(render(core)).toBe(0);
});
it('does not carry cancellation into a later block', () => {
  const { core } = setup(); core.noteOff(0, 7); core.process(BLOCK);
  core.audioOn(0, 7, 0.25); core.noteOff(0, 8);
  expect(render(core)).toBeGreaterThan(0.01);
});
it.each([false, true])('preserves starts submitted after all-off (hard %s)', (hard) => {
  const { core } = setup(); core.allOff(undefined, hard); core.audioOn(0, 7, 0.25);
  expect(render(core)).toBeGreaterThan(0.01);
});
it('handles dense cancellations without growing WASM memory across repeated batches', () => {
  const { core } = setup();
  const batch = () => {
    for (let i = 0; i < 2000; i++) core.audioOn(0, i, 0.25);
    for (let i = 0; i < 2000; i++) core.noteOff(0, i);
    expect([...core.process(BLOCK).l].every((v) => v === 0)).toBe(true);
  };
  batch(); batch(); const bytes = core.memory.byteLength;
  for (let i = 0; i < 10; i++) batch();
  expect(core.memory.byteLength).toBe(bytes);
});
