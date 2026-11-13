import { expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Core, BLOCK } from '../src/engine/core.js';
import { Sequencer } from '../src/engine/sequencer.js';
import { compileChannel, compileMixer, compileSequence } from '../src/engine/compile.js';
import { createChannel, createClip, createProject } from '../src/model/project.js';
import { curveShape } from '../src/automation/evaluate.js';

const RATE = 48000;
const module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
const sample = Float32Array.from({ length: RATE }, (_, i) => Math.sin(2 * Math.PI * 400 * i / RATE) * (i < RATE / 2 ? 0.2 : 0.8));

function setup({ tune = 12, pitch = 0, master = 0, reverse = 0, offset = 0, mute = false, tempo = false, automatedTune = null, reverseAutomation = null } = {}) {
  const p = createProject();
  p.bpm = 120;
  p.masterPitch = master;
  const ch = createChannel({ type: 'audio', sample: 's', params: { tune, reverse }, mixer: 1 });
  ch.pitch = pitch;
  p.channels = [ch];
  p.clips = [{ ...createClip({ kind: 'audio', ref: ch.id, start: 0, len: 384, offset }), mute }];
  if (tempo) {
    p.automation = { tempo: { id: 'tempo', target: { kind: 'tempo' }, points: [{ t: 0, v: (60 - 20) / 280 }] } };
    p.clips.push(createClip({ kind: 'auto', ref: 'tempo', start: 0, len: 384 }));
  }
  if (automatedTune !== null) {
    p.automation.tune = { id: 'tune', target: { kind: 'channel', id: ch.id, param: 'tune' }, points: [{ t: 0, v: (automatedTune + 24) / 48 }] };
    p.clips.push(createClip({ kind: 'auto', ref: 'tune', start: 0, len: 384 }));
  }
  if (reverseAutomation) {
    const { start = 0, len = 384, value = 1, points = [{ t: 0, v: value }] } = reverseAutomation;
    p.automation.reverse = { id: 'reverse', target: { kind: 'channel', id: ch.id, param: 'reverse' }, points };
    p.clips.push(createClip({ kind: 'auto', ref: 'reverse', start, len }));
  }
  const core = new Core(new WebAssembly.Instance(module, {}), RATE);
  core.setMixer(compileMixer(p));
  core.loadSample(0, [sample], RATE);
  core.setChannel(compileChannel(p, ch, 0, () => 0));
  core.setMasterPitch(master);
  const seq = new Sequencer(core, RATE, { loop: false });
  const compile = (project) => compileSequence(project, { mode: 'song', slotOf: () => 0 });
  seq.setSequence(compile(p));
  return { p, ch, core, seq, compile };
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

function compareResume(options, action = 'start', tick = 60) {
  const continuous = setup(options);
  continuous.seq.play(0);
  render(continuous.seq, continuous.seq.tempo.duration(0, tick));
  // Skip the brief release/fade-in when seeking, then compare actual audio.
  render(continuous.seq, 0.02);
  const expected = render(continuous.seq, 0.04);
  const resumed = setup({ ...options, mute: action === 'unmute' });
  if (action === 'seek') {
    resumed.seq.play(0);
    render(resumed.seq, 0.05);
    resumed.seq.seek(tick);
  } else {
    resumed.seq.play(tick);
    if (action === 'unmute') {
      resumed.seq.setSequence(resumed.compile({ ...resumed.p, clips: resumed.p.clips.map((c) => c.kind === 'audio' ? { ...c, mute: false } : c) }));
    }
  }
  render(resumed.seq, 0.02);
  expect(render(resumed.seq, 0.04)).toBeCloseTo(expected, 4);
}

for (const reverse of [0, 1]) {
  it.each(['start', 'seek', 'unmute'])(`matches continuous pitched playback after %s (reverse ${reverse})`, (action) => {
    compareResume({ reverse }, action);
  });
  it.each([
    ['channel', { tune: 0, pitch: 1200 }],
    ['master', { tune: 0, master: 1200 }],
    ['combined', { tune: 6, pitch: 300, master: 300 }],
  ])(`includes %s pitch when resuming (reverse ${reverse})`, (_name, options) => {
    compareResume({ ...options, reverse });
  });
  it(`preserves source offset when resuming pitched audio (reverse ${reverse})`, () => {
    compareResume({ reverse, offset: 48 }, 'start', 30);
  });
  it(`does not restart an already exhausted pitched sample (reverse ${reverse})`, () => {
    compareResume({ reverse }, 'start', 120);
  });
  it(`preserves ordinary playback when pitch is unchanged (reverse ${reverse})`, () => {
    compareResume({ tune: 0, reverse }, 'seek');
  });
}

it('resumes lowered-pitch audio at its slower source position', () => {
  compareResume({ tune: -12 }, 'start', 150);
});

for (const reverse of [0, 1]) {
  it.each(['start', 'seek', 'unmute'])(`preserves direction history after %s (initial reverse ${reverse})`, (action) => {
    compareResume({ tune: 0, reverse, reverseAutomation: { start: 48, value: 1 - reverse } }, action, 72);
  });
  it(`uses the automated initial direction instead of configured reverse ${reverse}`, () => {
    compareResume({ tune: 0, reverse, reverseAutomation: { value: 1 - reverse } }, 'start', 60);
  });
}

it('restores the configured direction when a reverse automation clip ends', () => {
  compareResume({ tune: 0, reverseAutomation: { start: 48, len: 24 } }, 'start', 120);
});

it('does not revive a sample exhausted before a later direction change', () => {
  compareResume({ tune: 0, reverseAutomation: { start: 240 } }, 'start', 336);
});

it('combines pitch and direction automation when reconstructing the source position', () => {
  compareResume({ tune: 0, automatedTune: 12, reverseAutomation: { start: 24 } }, 'start', 36);
});

it('preserves a source offset across an automated direction change', () => {
  compareResume({ tune: 0, offset: 96, reverseAutomation: { start: 48 } }, 'start', 72);
});

it.each([0, 0.75])('finds the reverse switching point on a ramp (curve %s)', (curve) => {
  compareResume({ tune: 0, reverseAutomation: { points: [{ t: 0, v: 0, c: curve }, { t: 96, v: 1 }] } }, 'start', curve ? 108 : 72);
});

it.each([0, 1])('schedules an absolute source position at the requested frame (reverse %s)', (reverse) => {
  const s = setup({ tune: 0, reverse });
  s.core.audioAt(0, 12, 0.125, 1, 64);
  const first = s.core.process(BLOCK).l.slice();
  expect(first.subarray(0, 64).every((v) => v === 0)).toBe(true);
  expect(first.subarray(64).some((v) => Math.abs(v) > 0.001)).toBe(true);
  render(s.seq, 0.02);
  const peak = render(s.seq, 0.04);
  expect(peak).toBeGreaterThan(0.05);
  expect(peak).toBeLessThan(0.1); // quiet first half, independent of direction
});

it.each([-1, NaN, Infinity, 1, 2])('ignores invalid/out-of-source absolute position %s', (position) => {
  const s = setup({ tune: 0 });
  s.core.audioAt(0, 12, position);
  expect(render(s.seq, 0.04)).toBe(0);
});

it('refreshes source bounds after a sample unload and replacement', () => {
  const s = setup({ tune: 0, reverse: 1 });
  expect(s.core.audioSampleInfo(0)).toEqual({ duration: 1, last: (RATE - 1) / RATE, reverse: true });
  s.core.unloadSample(0);
  expect(s.core.audioSampleInfo(0)).toBeNull();
  s.core.loadSample(0, [new Float32Array(22050)], 44100);
  expect(s.core.audioSampleInfo(0)).toEqual({ duration: 0.5, last: 22049 / 44100, reverse: true });
});

it.each([0, NaN, Infinity])('uses the DSP sample-rate fallback for source bounds (rate %s)', (rate) => {
  const s = setup({ tune: 0 });
  s.core.loadSample(0, [sample], rate);
  expect(s.core.audioSampleInfo(0)?.duration).toBe(1);
});

it('uses tempo automation when resuming pitched audio', () => {
  compareResume({ tempo: true }, 'seek', 30);
});

it('preserves a pitch automation override that cancels configured tuning', () => {
  compareResume({ tune: 12, automatedTune: 0 });
});

it('includes pitch automation when resuming a clip', () => {
  compareResume({ tune: 0, automatedTune: 12 });
});

function resumedOffset(param, points, tick = 96) {
  const s = setup({ tune: 0 });
  s.p.automation.a = { id: 'a', target: { kind: 'channel', id: s.ch.id, param }, points };
  s.p.clips.push(createClip({ kind: 'auto', ref: 'a', start: 0, len: 384 }));
  s.seq.setSequence(s.compile(s.p));
  const on = vi.spyOn(s.core, 'audioOn');
  s.seq.play(tick);
  return on.mock.calls[0][2];
}

it('integrates the history of a continuous channel pitch ramp', () => {
  expect(resumedOffset('pitch', [{ t: 0, v: 0.5 }, { t: 96, v: 1 }])).toBeCloseTo(0.5 / Math.log(2), 6);
});

it('integrates the stepped tuning history of a full octave ramp', () => {
  let expected = 0.5 * (1 + 2);
  for (let n = 1; n < 12; n++) expected += 2 ** (n / 12);
  expected *= 0.5 / 12;
  expect(resumedOffset('tune', [{ t: 0, v: 0.5 }, { t: 96, v: 0.75 }])).toBeCloseTo(expected, 6);
});

it('retains a short tuning step near the end of an automation ramp', () => {
  const expected = 0.5 * (50 / 51 + 2 ** (1 / 12) / 51);
  expect(resumedOffset('tune', [{ t: 0, v: 0.5 }, { t: 96, v: (24 + 0.51) / 48 }])).toBeCloseTo(expected, 6);
});

it('integrates a curved stepped tuning ramp', () => {
  const count = 100000;
  let expected = 0;
  for (let i = 0; i < count; i++) expected += 2 ** (Math.round(12 * curveShape((i + 0.5) / count, 0.75)) / 12) * 0.5 / count;
  expect(resumedOffset('tune', [{ t: 0, v: 0.5, c: 0.75 }, { t: 96, v: 0.75 }])).toBeCloseTo(expected, 4);
});

it('preserves automation overlap precedence and configured pitch in gaps', () => {
  const s = setup({ tune: 0 });
  for (const [id, tune, start, len] of [['a', 12, 0, 24], ['b', -12, 12, 36]]) {
    s.p.automation[id] = { id, target: { kind: 'channel', id: s.ch.id, param: 'tune' }, points: [{ t: 0, v: (tune + 24) / 48 }] };
    s.p.clips.push(createClip({ kind: 'auto', ref: id, start, len }));
  }
  s.seq.setSequence(s.compile(s.p));
  const on = vi.spyOn(s.core, 'audioOn');
  s.seq.play(96);
  expect(on.mock.calls[0][2]).toBeCloseTo(0.125 * 2 + 0.125 * 0.5 + 0.25, 6);
});

it('integrates an hour-long pitch ramp without replaying audio frames', () => {
  const s = setup({ tune: 0 });
  const tick = 3600 * 192;
  s.p.clips[0].len = tick + 192;
  s.p.automation.a = { id: 'a', target: { kind: 'channel', id: s.ch.id, param: 'pitch' }, points: [{ t: 0, v: 0.5 }, { t: tick, v: 1 }] };
  s.p.clips.push(createClip({ kind: 'auto', ref: 'a', start: 0, len: tick + 192 }));
  s.seq.setSequence(s.compile(s.p));
  const rate = vi.spyOn(s.core, 'audioPlaybackRate');
  const on = vi.spyOn(s.core, 'audioOn');
  s.seq.play(tick);
  expect(on.mock.calls[0][2]).toBeCloseTo(3600 / Math.log(2), 4);
  expect(rate.mock.calls.length).toBeLessThan(2000);
});

it('visits automation segments with linear work when resuming across many clips', () => {
  const s = setup({ tune: 0 });
  const count = 100, tick = count * 4;
  s.p.clips[0].len = tick + 192;
  s.p.automation.a = { id: 'a', target: { kind: 'channel', id: s.ch.id, param: 'tune' }, points: [{ t: 0, v: 0.75 }] };
  s.p.clips.push(...Array.from({ length: count }, (_, i) => createClip({ kind: 'auto', ref: 'a', start: i * 4, len: 4 })));
  const compiled = s.compile(s.p);
  let reads = 0;
  for (const seg of compiled.auto[0].segs) for (const field of ['start', 'end']) {
    const value = seg[field];
    Object.defineProperty(seg, field, { get() { reads++; return value; } });
  }
  s.seq.setSequence(compiled);
  const on = vi.spyOn(s.core, 'audioOn');
  s.seq.play(tick);
  expect(on.mock.calls[0][2]).toBeCloseTo(tick / 192 * 2, 6);
  expect(reads).toBeLessThanOrEqual(count * 30);
});

it('skips expired hidden segments after an earlier overlapping clip ends', () => {
  const s = setup({ tune: 0 });
  for (const [id, tune, start, len] of [['a', 12, 0, 80], ['b', -12, 10, 20], ['c', 0, 40, 56]]) {
    s.p.automation[id] = { id, target: { kind: 'channel', id: s.ch.id, param: 'tune' }, points: [{ t: 0, v: (tune + 24) / 48 }] };
    s.p.clips.push(createClip({ kind: 'auto', ref: id, start, len }));
  }
  s.seq.setSequence(s.compile(s.p));
  const on = vi.spyOn(s.core, 'audioOn');
  s.seq.play(96);
  expect(on.mock.calls[0][2]).toBeCloseTo((80 * 2 + 16) / 192, 6);
});

it('combines independent pitch lanes and uses configured speed before and after them', () => {
  const s = setup({ tune: 12 });
  for (const [id, param, value, start] of [['a', 'tune', 0.5, 24], ['b', 'pitch', 1, 36]]) {
    s.p.automation[id] = { id, target: { kind: 'channel', id: s.ch.id, param }, points: [{ t: 0, v: value }] };
    s.p.clips.push(createClip({ kind: 'auto', ref: id, start, len: 24 }));
  }
  s.seq.setSequence(s.compile(s.p));
  const on = vi.spyOn(s.core, 'audioOn');
  s.seq.play(96);
  expect(on.mock.calls[0][2]).toBeCloseTo((24 * 2 + 12 + 12 * 2 + 12 * 4 + 36 * 2) / 192, 6);
});

it.each(['tune', 'channel', 'master'])('uses updated %s pitch without recompiling the sequence', (control) => {
  const reference = setup();
  reference.seq.play(0);
  render(reference.seq, 60 / 192 + 0.02);
  const expected = render(reference.seq, 0.04);
  const s = setup({ tune: 0 });
  if (control === 'master') s.core.setMasterPitch(1200);
  else {
    const ch = control === 'channel' ? { ...s.ch, pitch: 1200 } : { ...s.ch, params: { ...s.ch.params, tune: 12 } };
    s.core.setChannel(compileChannel(s.p, ch, 0, () => 0));
  }
  s.seq.play(60);
  render(s.seq, 0.02);
  expect(render(s.seq, 0.04)).toBeCloseTo(expected, 4);
});

it.each(['loop', 'count-in'])('resumes pitched audio correctly after %s', (mode) => {
  const reference = setup();
  reference.seq.play(0);
  render(reference.seq, 60 / 192 + 0.02);
  const expected = render(reference.seq, 0.04);
  const s = setup();
  if (mode === 'loop') {
    s.seq.loop = true;
    s.seq.setSequence(s.compile({ ...s.p, loop: { start: 60, end: 96 } }));
    s.seq.play(90);
    render(s.seq, 6 / 192);
  } else {
    s.seq.play(60, { countIn: true });
    render(s.seq, 2);
    expect(s.seq.counting).toBe(false);
  }
  render(s.seq, 0.02);
  expect(render(s.seq, 0.04)).toBeCloseTo(expected, 4);
});
