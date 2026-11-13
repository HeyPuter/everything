import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Core, BLOCK } from '../src/engine/core.js';
import { Sequencer } from '../src/engine/sequencer.js';
import { compileMixer, compileSequence } from '../src/engine/compile.js';
import { createClip, createProject } from '../src/model/project.js';
import { fromNorm } from '../src/lib/params.js';

const rate = 48000;
const module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
afterEach(() => vi.restoreAllMocks());
function fixture(entries) {
  const p = createProject(); p.bpm = 120;
  p.clips = entries.map(({ start, len = 1, value = 0.5 }, i) => {
    const id = `a${i}`;
    p.automation[id] = { id, target: { kind: 'mixer', track: 1, param: 'volume' }, points: [{ t: 0, v: value }] };
    return createClip({ kind: 'auto', ref: id, start, len });
  });
  const core = new Core(new WebAssembly.Instance(module, {}), rate);
  core.setMixer(compileMixer(p));
  const apply = vi.spyOn(core, 'automateTrack');
  const seq = new Sequencer(core, rate, { loop: false });
  const compiled = compileSequence(p, { mode: 'song', slotOf: () => -1 });
  return { p, core, apply, seq, compiled };
}

it('does not rescan thousands of ended automation clips on every rendered block', () => {
  const { seq, compiled, apply } = fixture(Array.from({ length: 6000 }, (_, i) => ({ start: i, value: i % 2 ? 0.25 : 0.75 })));
  let reads = 0;
  compiled.auto[0].segs = compiled.auto[0].segs.map((seg) => ({ ...seg, get start() { reads++; return seg.start; }, get end() { reads++; return seg.end; } }));
  seq.setSequence(compiled); seq.play(5500);
  const preparedReads = reads;
  expect(preparedReads).toBeLessThanOrEqual(18000);
  for (let i = 0; i < 64; i++) {
    seq.block(BLOCK);
    const tick = seq.tempo.ticks(seq.tempo.seconds(seq.pos) - 1 / rate);
    expect(apply).toHaveBeenLastCalledWith(1, 'volume', fromNorm(compiled.auto[0].def, Math.floor(tick) % 2 ? 0.25 : 0.75));
  }
  expect(reads - preparedReads).toBeLessThan(256);
});

it('keeps first-overlap priority, restores gaps, and resets lookup after seeks and sequence edits', () => {
  const { seq, compiled, apply } = fixture([
    { start: 0, len: 300, value: 0.25 }, { start: 100, len: 20, value: 0.5 },
    { start: 150, len: 250, value: 0.75 }, { start: 500, len: 50, value: 1 },
  ]);
  seq.setSequence(compiled); seq.play(0);
  const check = (tick, value) => {
    seq.seek(tick); seq.block(BLOCK);
    expect(apply).toHaveBeenLastCalledWith(1, 'volume', value === null ? null : fromNorm(compiled.auto[0].def, value));
  };
  for (const [tick, value] of [[0, 0.25], [100, 0.25], [300, 0.75], [399, 0.75], [400, null], [500, 1], [110, 0.25], [350, 0.75], [450, null]]) check(tick, value);
  const changed = { ...compiled, auto: compiled.auto.map((l) => ({ ...l, segs: [{ start: 0, end: 550, pts: new Float64Array([0, 0.1]), cs: null }] })) };
  seq.setSequence(changed); seq.block(BLOCK);
  expect(apply).toHaveBeenLastCalledWith(1, 'volume', fromNorm(compiled.auto[0].def, 0.1));
  seq.stop(); expect(apply).toHaveBeenLastCalledWith(1, 'volume', null);
});

it('matches a linear first-active reference across dense nested overlaps and backwards scrubbing', () => {
  const entries = Array.from({ length: 128 }, (_, i) => ({ start: i * 5, len: 1 + (i * 37) % 151, value: (i % 11) / 10 }));
  const { seq, compiled, apply } = fixture(entries);
  seq.setSequence(compiled); seq.play(0);
  const segs = compiled.auto[0].segs;
  let priorActive = false;
  for (let i = 0; i < 200; i++) {
    const tick = (i * 233) % 700;
    const active = segs.find((s) => s.start <= tick && tick < s.end);
    apply.mockClear(); seq.seek(tick); seq.block(BLOCK);
    if (active) expect(apply).toHaveBeenLastCalledWith(1, 'volume', fromNorm(compiled.auto[0].def, active.pts[1]));
    else if (priorActive) expect(apply).toHaveBeenLastCalledWith(1, 'volume', null);
    else expect(apply).not.toHaveBeenCalled();
    priorActive = Boolean(active);
  }
});
it('restarts lane lookup when looping back across an automation boundary', () => {
  const { seq, compiled, apply } = fixture([{ start: 0, len: 32, value: 0.25 }, { start: 32, len: 32, value: 0.75 }]);
  seq.loop = true; seq.setSequence({ ...compiled, start: 0, end: 64, outer: 64 }); seq.play(63.8);
  seq.block(BLOCK);
  expect(seq.wraps).toBe(1);
  expect(apply).toHaveBeenLastCalledWith(1, 'volume', fromNorm(compiled.auto[0].def, 0.25));
  seq.block(BLOCK);
  expect(apply).toHaveBeenLastCalledWith(1, 'volume', fromNorm(compiled.auto[0].def, 0.25));
});
