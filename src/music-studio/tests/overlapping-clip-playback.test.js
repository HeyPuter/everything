import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Core, BLOCK } from '../src/engine/core.js';
import { Sequencer } from '../src/engine/sequencer.js';
import { compileChannel, compileMixer, compileSequence } from '../src/engine/compile.js';
import { createProject, createChannel, createClip, createNote } from '../src/model/project.js';
import { removeClips } from '../src/model/edits.js';
import { toggleClipMute } from '../src/playlist/clips.js';

const RATE = 48000;
const module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
const sample = Float32Array.from({ length: RATE }, (_, i) => Math.sin(2 * Math.PI * 400 * i / RATE) * (i < RATE / 2 ? 0.1 : 0.4));

function project() {
  const p = createProject();
  p.bpm = 120;
  const ch = createChannel({ type: 'audio', sample: 's', mixer: 1 });
  p.channels = [ch];
  p.clips = [0, 1].map((track) => createClip({ kind: 'audio', ref: ch.id, start: 0, len: 192, offset: track * 96, track }));
  return p;
}

function setup(p) {
  const core = new Core(new WebAssembly.Instance(module, {}), RATE);
  core.setMixer(compileMixer(p));
  core.loadSample(0, [sample], RATE);
  core.setChannel(compileChannel(p, p.channels[0], 0, () => 0));
  const seq = new Sequencer(core, RATE, { loop: false });
  const compile = (next) => compileSequence(next, { mode: 'song', slotOf: () => 0 });
  seq.setSequence(compile(p));
  seq.play(0);
  return { core, seq, compile };
}

function render(seq, seconds) {
  const frames = Math.round(seconds * RATE);
  let peak = 0;
  for (let f = 0; f < frames; f += BLOCK) {
    const n = Math.min(BLOCK, frames - f);
    const { l } = seq.block(n);
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(l[i]));
  }
  return peak;
}

for (const which of [0, 1]) {
  it.each(['delete', 'mute'])(`stops only the affected overlapping audio clip after %s (clip ${which})`, (action) => {
    const p = project(), live = setup(p);
    render(live.seq, 0.1);
    const changed = action === 'delete' ? removeClips(p, [p.clips[which].id]) : toggleClipMute(p, [p.clips[which].id], true);
    live.seq.setSequence(live.compile(changed));
    render(live.seq, 0.02); // release the removed voice
    const expected = setup(changed);
    render(expected.seq, 0.12);
    expect(render(live.seq, 0.04)).toBeCloseTo(render(expected.seq, 0.04), 5);
  });
}

it('starts an unmuted overlapping clip while keeping the existing clip sounding', () => {
  const p = project();
  const live = setup(toggleClipMute(p, [p.clips[1].id], true));
  render(live.seq, 0.1);
  live.seq.setSequence(live.compile(p));
  render(live.seq, 0.02);
  const expected = setup(p);
  render(expected.seq, 0.12);
  expect(render(live.seq, 0.04)).toBeCloseTo(render(expected.seq, 0.04), 4);
});

it('releases the note belonging to a removed overlapping pattern clip', () => {
  const p = project();
  const ch = createChannel({ type: 'synth', mixer: 1 });
  p.channels = [ch];
  p.patterns[0].notes = { [ch.id]: [createNote({ key: 60, pos: 0, len: 384 })] };
  p.clips = [0, 1].map((track) => createClip({ kind: 'pattern', ref: p.patterns[0].id, start: 0, len: 384, track }));
  const live = setup(p);
  render(live.seq, 0.1);
  const off = vi.spyOn(live.core, 'noteOff');
  live.seq.setSequence(live.compile(removeClips(p, [p.clips[1].id])));
  expect(off.mock.calls).toEqual([[0, 2, 0]]);
});

it('keeps surviving voices stable across recompilation and successive deletions', () => {
  const p = project();
  p.clips.push(createClip({ kind: 'audio', ref: p.channels[0].id, start: 0, len: 192, offset: 48, track: 2 }));
  const live = setup(p);
  render(live.seq, 0.1);
  const off = vi.spyOn(live.core, 'noteOff'), on = vi.spyOn(live.core, 'audioOn');
  const changed = { ...p, clips: p.clips.map((c) => ({ ...c, len: 240 })) };
  live.seq.setSequence(structuredClone(live.compile(changed)));
  expect(off).not.toHaveBeenCalled();
  expect(on).not.toHaveBeenCalled();
  const first = removeClips(changed, [p.clips[0].id]);
  live.seq.setSequence(live.compile(first));
  live.seq.setSequence(live.compile(removeClips(first, [p.clips[2].id])));
  expect(off.mock.calls).toEqual([[0, 1, 0], [0, 3, 0]]);
  expect(on).not.toHaveBeenCalled();
});

it('matches a dense set of simultaneous sources without repeatedly scanning the same events', () => {
  const p = project(), count = 100;
  p.clips = Array.from({ length: count }, () => createClip({ kind: 'audio', ref: p.channels[0].id, start: 0, len: 192 }));
  const live = setup(p);
  render(live.seq, 0.1);
  const compiled = live.compile(p);
  let reads = 0;
  compiled.notes.start = new Proxy(compiled.notes.start, { get(target, key) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, target);
  } });
  const off = vi.spyOn(live.core, 'noteOff'), on = vi.spyOn(live.core, 'audioOn');
  live.seq.setSequence(compiled);
  expect(off).not.toHaveBeenCalled();
  expect(on).not.toHaveBeenCalled();
  expect(reads).toBeLessThan(count * 50);
});
