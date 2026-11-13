import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Core } from '../src/engine/core.js';
import { Sequencer } from '../src/engine/sequencer.js';
import { compileChannel, compileMixer, compileSequence } from '../src/engine/compile.js';
import { createChannel, createNote, createProject } from '../src/model/project.js';

const rate = 48000;
const module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
function setup(type = 'audio') {
  const p = createProject(); p.bpm = 522;
  const ch = createChannel({ type, mixer: 1, sample: 's' }); p.channels = [ch];
  const core = new Core(new WebAssembly.Instance(module, {}), rate);
  core.setMixer(compileMixer(p));
  core.loadSample(0, [Float32Array.from({ length: rate }, (_, i) => Math.sin(i * .03) * .1 + i / rate * .1)], rate);
  core.setChannel(compileChannel(p, ch, 0, () => 0));
  return { p, ch, core };
}
function compare(a, b) {
  let peak = 0;
  for (let block = 0; block < 8; block++) {
    const x = a.process(128), y = b.process(128);
    expect([...x.l]).toEqual([...y.l]); expect([...x.r]).toEqual([...y.r]);
    for (const v of x.l) peak = Math.max(peak, Math.abs(v));
  }
  expect(peak).toBeGreaterThan(.001);
}
it.each([16, 17, 31, 32, 33, 65, 257, 4096])('preserves equal-time voice order for %s interleaved audio starts and releases', count => {
  const a = setup().core, b = setup().core;
  for (let i = 0; i < count; i++) { a.audioOn(0, i + 1, (i % 100) / 100); a.noteOff(0, i + 1, 100); }
  for (let i = 0; i < count; i++) b.audioOn(0, i + 1, (i % 100) / 100);
  for (let i = 0; i < count; i++) b.noteOff(0, i + 1, 100);
  compare(a, b);
});
it.each(['synth', 'drum', 'sampler'])('matches sorted reference audio for a dense short %s pattern', type => {
  const { p, ch, core } = setup(type), reference = setup(type).core;
  p.patterns[0].notes = { [ch.id]: Array.from({ length: 4096 }, (_, i) => createNote({ key: 48 + i % 24, pos: 0, len: 1, vel: .5 })) };
  const compiled = compileSequence(p, { mode: 'pattern', slotOf: () => 0 });
  const seq = new Sequencer(core, rate, { loop: false }); seq.setSequence(compiled); seq.play();
  const n = compiled.notes;
  for (let i = 0; i < n.count; i++) reference.noteOn(0, i + 1, n.key[i], n.vel[i], n.pan[i], 0);
  const end = Math.ceil(60 / p.bpm / 96 * rate - 1e-6);
  for (let i = 0; i < n.count; i++) reference.noteOff(0, i + 1, end);
  let peak = 0;
  for (let block = 0; block < 8; block++) {
    const a = seq.block(128), b = reference.process(128);
    expect([...a.l]).toEqual([...b.l]); expect([...a.r]).toEqual([...b.r]);
    for (const v of a.l) peak = Math.max(peak, Math.abs(v));
  }
  expect(peak).toBeGreaterThan(.001);
});
it('reuses WASM memory across repeated dense sorting batches', () => {
  const { core } = setup();
  const batch = () => {
    core.reset();
    for (let i = 0; i < 4096; i++) { core.audioAt(0, i + 1, (i % 100) / 100); core.noteOff(0, i + 1, 100); }
    const out = core.process(128);
    expect([...out.l].every(Number.isFinite)).toBe(true);
  };
  batch(); batch(); const bytes = core.memory.byteLength;
  for (let i = 0; i < 12; i++) batch();
  expect(core.memory.byteLength).toBe(bytes);
});
