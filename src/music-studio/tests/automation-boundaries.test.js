import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Core, BLOCK } from '../src/engine/core.js';
import { Sequencer } from '../src/engine/sequencer.js';
import { compileChannel, compileMixer, compileSequence } from '../src/engine/compile.js';
import { createChannel, createClip, createProject } from '../src/model/project.js';

const rate = 48000;
afterEach(() => vi.restoreAllMocks());
const module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
function setup({ start = 48, reverse = 0, autoStart = start, autoLength = 384, value = 1, loop = false, bpm = 120, param = 'reverse', data, points, sampleRate = rate, target } = {}) {
  const p = createProject(); p.bpm = bpm;
  const ch = createChannel({ type: 'audio', sample: 's', params: { reverse }, mixer: 1 }); p.channels = [ch];
  p.clips = [createClip({ kind: 'audio', ref: ch.id, start, len: loop ? 48 : 384 }), createClip({ kind: 'auto', ref: 'a', start: autoStart, len: autoLength })];
  p.automation.a = { id: 'a', target: target || { kind: 'channel', id: ch.id, param }, points: points || [{ t: 0, v: value }] };
  if (loop) p.loop = { start: 0, end: 48 };
  const core = new Core(new WebAssembly.Instance(module, {}), sampleRate);
  core.setMixer(compileMixer(p));
  core.loadSample(0, [data || Float32Array.from({ length: rate }, (_, i) => Math.sin(2 * Math.PI * 400 * i / rate) * (i < rate / 2 ? 0.2 : 0.8))], rate);
  core.setChannel(compileChannel(p, ch, 0, () => 0));
  const seq = new Sequencer(core, sampleRate, { loop });
  seq.setSequence(compileSequence(p, { mode: 'song', slotOf: () => 0 }));
  return { seq, core, p };
}
function render(seq, seconds) {
  const frames = Math.round(seconds * seq.rate); let peak = 0;
  for (let f = 0; f < frames; f += BLOCK) {
    const n = Math.min(BLOCK, frames - f), out = seq.block(n);
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out.l[i]));
  }
  return peak;
}
it.each([
  ['reverse starts', { value: 1 }], ['reverse clears', { reverse: 1, value: 0 }],
  ['reverse clip ends', { autoStart: 0, autoLength: 48 }],
])('uses onset automation when %s inside a render block', (_name, options) => {
  const continuous = setup(options), direct = setup(options);
  continuous.seq.play(0); render(continuous.seq, 0.28);
  direct.seq.play(48); render(direct.seq, 0.03);
  const expected = render(direct.seq, 0.02);
  expect(expected).toBeGreaterThan(0.01);
  expect(render(continuous.seq, 0.02)).toBeCloseTo(expected, 5);
});
it('starts a wrapped audio clip with automation at the loop start', () => {
  const options = { start: 0, autoStart: 0, autoLength: 24, loop: true };
  const first = setup(options), wrapped = setup(options);
  first.seq.play(0); render(first.seq, 0.03);
  const expected = render(first.seq, 0.02);
  wrapped.seq.play(0); render(wrapped.seq, 0.28);
  expect(wrapped.seq.wraps).toBe(1);
  expect(render(wrapped.seq, 0.02)).toBeCloseTo(expected, 5);
});
it('plays a one-tick automation clip that starts and ends within one block', () => {
  const { seq } = setup({ start: 0, autoStart: 1, autoLength: 1, bpm: 522, param: 'gain', value: 0, data: new Float32Array(rate).fill(0.5) });
  seq.play(0); const out = seq.block(BLOCK).l.slice();
  expect(out[50]).toBeGreaterThan(0.1);
  expect(out[114]).toBeLessThan(0.001);
  expect(out[127]).toBeGreaterThan(0.1);
});

it.each([44100, 96000])('applies onset boundaries at engine rate %s', (sampleRate) => {
  const a = setup({ sampleRate }), b = setup({ sampleRate });
  a.seq.play(0); render(a.seq, 0.28);
  b.seq.play(48); render(b.seq, 0.03);
  expect(render(a.seq, 0.02)).toBeCloseTo(render(b.seq, 0.02), 4);
});
it('switches a rounded reverse ramp before an audio onset within the same block', () => {
  const options = { start: 120, autoStart: 0, points: [{ t: 0, v: 0 }, { t: 240, v: 1 }] };
  const a = setup(options), b = setup(options);
  a.seq.play(0); render(a.seq, 120 / 192 + 0.03);
  b.seq.play(120); render(b.seq, 0.03);
  const expected = render(b.seq, 0.02); expect(expected).toBeGreaterThan(0.1);
  expect(render(a.seq, 0.02)).toBeCloseTo(expected, 5);
});
it('applies a duplicate-time point change before an audio onset', () => {
  const options = { autoStart: 0, points: [{ t: 0, v: 0 }, { t: 48, v: 0 }, { t: 48, v: 1 }] };
  const a = setup(options), b = setup(options);
  a.seq.play(0); render(a.seq, 0.28);
  b.seq.play(48); render(b.seq, 0.03);
  expect(render(a.seq, 0.02)).toBeCloseTo(render(b.seq, 0.02), 5);
});
it('keeps boundary scheduling aligned after count-in', () => {
  const options = { bpm: 127 };
  const a = setup(options), b = setup(options);
  a.seq.play(0, { countIn: true });
  render(a.seq, a.seq.framesBetween(0, 384) / a.seq.rate + a.seq.tempo.seconds(48) + 0.03);
  expect(a.seq.counting).toBe(false);
  b.seq.play(48); render(b.seq, 0.03);
  expect(render(a.seq, 0.02)).toBeCloseTo(render(b.seq, 0.02), 4);
});
it('copies split stereo buffers without changing audio when automation holds the configured value', () => {
  const options = { start: 0, autoStart: 1, autoLength: 1, bpm: 522, param: 'gain', value: 0.8 };
  const a = setup(options), b = setup(options);
  b.seq.setSequence(compileSequence({ ...b.p, clips: b.p.clips.filter((c) => c.kind !== 'auto') }, { mode: 'song', slotOf: () => 0 }));
  a.seq.play(); b.seq.play();
  for (const n of [128, 47, 128, 31, 128]) {
    const x = a.seq.block(n), y = b.seq.block(n);
    expect([...x.l.subarray(0, n)]).toEqual([...y.l.subarray(0, n)]);
    expect([...x.r.subarray(0, n)]).toEqual([...y.r.subarray(0, n)]);
  }
});
it('keeps an ordinary block on the zero-copy single-process path', () => {
  const { seq, core } = setup({ start: 0, autoStart: 0 });
  const process = vi.spyOn(core, 'process');
  seq.play(0); const result = seq.block(BLOCK);
  expect(process).toHaveBeenCalledTimes(1);
  expect(result).toBe(process.mock.results[0].value);
});

it.each(['channel', 'mixer'])('applies short %s volume automation to the affected frames', (kind) => {
  const { seq } = setup({ start: 0, autoStart: 1, autoLength: 1, bpm: 522, param: 'volume', value: 0, target: kind === 'mixer' ? { kind, track: 1, param: 'volume' } : undefined, data: new Float32Array(rate).fill(0.5) });
  seq.play(0); const out = seq.block(BLOCK).l.slice();
  expect(out[50]).toBeGreaterThan(0.1);
  expect(out[114]).toBeLessThan(0.001);
  expect(out[127]).toBeGreaterThan(0.1);
});
it('bounds split rendering by the output-frame count even with many sub-frame boundaries', () => {
  const { seq, core, p } = setup({ start: 0, autoStart: 0, param: 'gain', value: 0.8 });
  p.automation.b = { ...p.automation.a, id: 'b', points: [{ t: 0, v: 0.4 }] };
  p.clips = [p.clips[0], ...Array.from({ length: 6000 }, (_, i) => createClip({ kind: 'auto', ref: i % 2 ? 'b' : 'a', start: i / 10000, len: 0.0001 }))];
  seq.setSequence(compileSequence(p, { mode: 'song', slotOf: () => 0 }));
  const process = vi.spyOn(core, 'process');
  seq.play(0); const result = seq.block(BLOCK);
  expect(process.mock.calls.length).toBeGreaterThan(1);
  expect(process.mock.calls.length).toBeLessThanOrEqual(BLOCK);
  expect(process.mock.calls.reduce((sum, [n]) => sum + n, 0)).toBe(BLOCK);
  expect([...result.l.subarray(0, BLOCK)].every(Number.isFinite)).toBe(true);
});
it('does not split a block when adjacent flat automation clips hold the same value', () => {
  const { seq, core, p } = setup({ start: 0, autoStart: 0, param: 'gain', value: 0.8 });
  p.clips = Array.from({ length: 6000 }, (_, i) => createClip({ kind: 'auto', ref: 'a', start: i, len: 1 }));
  seq.setSequence(compileSequence(p, { mode: 'song', slotOf: () => 0 }));
  const process = vi.spyOn(core, 'process');
  seq.play(5500.8); seq.block(BLOCK);
  expect(process).toHaveBeenCalledTimes(1);
});
