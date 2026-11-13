import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createChannel, createClip, createProject } from '../src/model/project.js';
import { SampleCache } from '../src/audio/samples.js';
import { Core, BLOCK } from '../src/engine/core.js';
import { compileChannel, compileMixer, compileSequence } from '../src/engine/compile.js';
import { Viewport } from '../src/render/timeline.js';
import { drawCanvas, colors, resetColors } from '../src/playlist/render.js';
import { trackLayout } from '../src/playlist/geometry.js';
import { clipsByTrack } from '../src/playlist/clips.js';
import { mix } from '../src/render/gfx.js';
import { parseColor } from '../src/ui/theme.js';

const RATE = 48000;
const module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
afterEach(resetColors);

function setup(reverse = 0, offset = 0) {
  const p = createProject();
  p.bpm = 120;
  const ch = createChannel({ type: 'audio', sample: 's', params: { reverse }, mixer: 1 });
  ch.color = '#ff0000';
  p.channels = [ch];
  p.tracks = p.tracks.slice(0, 1);
  p.clips = [createClip({ kind: 'audio', ref: ch.id, start: 0, len: 240, offset })];
  const data = Float32Array.from({ length: RATE }, (_, i) => Math.sin(2 * Math.PI * 400 * i / RATE) * (i < RATE / 2 ? 0.2 : 0.8));
  const samples = new SampleCache();
  samples.set('s', { channels: [data], rate: RATE });
  return { p, ch, data, samples };
}

function wave({ p, ch, samples }, scroll = 0) {
  const vp = new Viewport({ pxPerTick: 1, scroll });
  vp.width = 240;
  const d = { w: 240, h: 56, clear: vi.fn(), rect: vi.fn(), text: vi.fn() };
  drawCanvas({ store: { project: p }, vp, layout: trackLayout(p.tracks), scrollY: 0,
    byTrack: clipsByTrack(p.clips), selection: new Set(), selectedTrack: -1, app: { samples } }, d);
  const ink = mix(parseColor(ch.color), colors().text, 0.12);
  return d.rect.mock.calls.filter((call) => call[2] === 1 && call[4].every((n, i) => n === ink[i]));
}

function onsetPeak({ p, ch, data }, seconds = 0) {
  const core = new Core(new WebAssembly.Instance(module, {}), RATE);
  core.setMixer(compileMixer(p));
  core.loadSample(0, [data], RATE);
  core.setChannel({ ...compileChannel(p, ch, 0), sample: 0 });
  core.setMasterPitch(p.masterPitch);
  const seq = compileSequence(p, { mode: 'song', slotOf: (id) => id === ch.id ? 0 : -1 });
  core.audioOn(0, 1, seq.notes.offset[0], 1);
  const skip = Math.round(seconds * RATE);
  for (let f = 0; f < skip; f += BLOCK) core.process(Math.min(BLOCK, skip - f));
  let peak = 0;
  for (let i = 0; i < 24; i++) {
    const { l } = core.process(BLOCK);
    for (const value of l) peak = Math.max(peak, Math.abs(value));
  }
  return peak;
}

it('shows the louder tail first when the audio engine plays a reversed sample', () => {
  const forward = setup(), reversed = setup(1);
  expect(onsetPeak(reversed) / onsetPeak(forward)).toBeCloseTo(4, 2);
  const normal = wave(forward), back = wave(reversed);
  const height = (bars, x) => bars.find((bar) => bar[0] === x)[3];
  expect(height(back, 10) / height(normal, 10)).toBeCloseTo(4, 2);
  expect(height(back, 170) / height(normal, 170)).toBeCloseTo(0.25, 2);
});

it('counts a reversed clip offset from the end of the sample', () => {
  const forward = setup(0, 96), reversed = setup(1, 96);
  expect(onsetPeak(reversed) / onsetPeak(forward)).toBeCloseTo(0.25, 2);
  const normal = wave(forward).find((bar) => bar[0] === 10);
  const back = wave(reversed).find((bar) => bar[0] === 10);
  expect(back[3] / normal[3]).toBeCloseTo(0.25, 2);
  expect(wave(reversed).every((bar) => bar[0] < 96)).toBe(true);
});

it('keeps reversed waveform positions stable when horizontally scrolled', () => {
  const s = setup(1);
  const full = wave(s), scrolled = wave(s, 60);
  expect(scrolled).toEqual(full.filter((bar) => bar[0] >= 60).map((bar) => [bar[0] - 60, ...bar.slice(1)]));
});

it.each([0, 1])('does not draw waveform after the sample has ended (reverse %s)', (reverse) => {
  expect(wave(setup(reverse, 193))).toEqual([]);
});

it.each([0, 1])('does not draw waveform at the exact sample end (reverse %s)', (reverse) => {
  const s = setup(reverse, 192);
  expect(onsetPeak(s)).toBe(0);
  expect(wave(s)).toEqual([]);
});

it('includes a final partial peak bin at the start of a reversed sample', () => {
  const s = setup(1);
  const data = new Float32Array(RATE + 120);
  data.fill(0.8, RATE);
  s.samples.set('s', { channels: [data], rate: RATE });
  const bars = wave(s);
  expect(bars.find((bar) => bar[0] === 0)[1]).toBeLessThan(25);
  expect(bars.find((bar) => bar[0] === 10)[3]).toBe(1);
});

it('uses the tempo map to position the reversed audio offset and waveform', () => {
  const s = setup(1, 48);
  s.p.clips[0].start = 96;
  const constant = { ...s, p: { ...s.p, bpm: 60 } };
  const value = (60 - 20) / 280;
  s.p = { ...s.p, automation: { tempo: { id: 'tempo', target: { kind: 'tempo' }, points: [{ t: 0, v: value }] } },
    clips: [...s.p.clips, createClip({ kind: 'auto', ref: 'tempo', start: 0, len: 384 })] };
  const seq = compileSequence(s.p, { mode: 'song', slotOf: () => 0 });
  expect(seq.notes.offset[0]).toBeCloseTo(0.5, 6);
  expect(wave(s)).toEqual(wave(constant));
  expect(onsetPeak(s)).toBeCloseTo(onsetPeak(constant), 6);
});

it('refreshes after a Reverse edit and when the previous project state is restored', () => {
  const s = setup();
  const normal = wave(s);
  const ch = { ...s.ch, params: { ...s.ch.params, reverse: 1 } };
  const edited = { ...s, ch, p: { ...s.p, channels: [ch] } };
  expect(wave(edited)).not.toEqual(normal);
  expect(wave(s)).toEqual(normal);
});

const octaveUp = [
  ['audio tuning', (s) => { s.ch.params.tune = 12; }],
  ['channel pitch', (s) => { s.ch.pitch = 1200; }],
  ['master pitch', (s) => { s.p.masterPitch = 1200; }],
  ['combined pitch controls', (s) => { s.ch.params.tune = 6; s.ch.pitch = 300; s.p.masterPitch = 300; }],
];
for (const reverse of [0, 1]) {
  it.each(octaveUp)(`follows %s in the waveform and engine (reverse ${reverse})`, (_name, change) => {
    const normal = setup(reverse), pitched = setup(reverse);
    change(pitched);
    const ratio = reverse ? 0.25 : 4;
    expect(onsetPeak(pitched, 60 / 192) / onsetPeak(normal, 60 / 192)).toBeCloseTo(ratio, 2);
    const at = (s) => wave(s).find((bar) => bar[0] === 60)[3];
    expect(at(pitched) / at(normal)).toBeCloseTo(ratio, 2);
    expect(wave(pitched).at(-1)[0]).toBe(95);
  });
}

it('extends a lowered-pitch waveform to match the slower sample playback', () => {
  const normal = setup(), pitched = setup();
  pitched.ch.params.tune = -12;
  expect(onsetPeak(pitched, 170 / 192) / onsetPeak(normal, 170 / 192)).toBeCloseTo(0.25, 2);
  const at = (s) => wave(s).find((bar) => bar[0] === 170)[3];
  expect(at(pitched) / at(normal)).toBeCloseTo(0.25, 2);
  expect(wave(pitched).at(-1)[0]).toBe(239);
});

it.each([0, 1])('keeps source offset unscaled when changing pitch (reverse %s)', (reverse) => {
  const s = setup(reverse, 96);
  s.ch.params.tune = 12;
  expect(onsetPeak(s)).toBeGreaterThan(0.01);
  expect(onsetPeak(s, 0.3)).toBeLessThan(1e-8);
  const bars = wave(s);
  expect(bars[0][0]).toBe(0);
  expect(bars.at(-1)[0]).toBe(47);
});

it('maps pitched playback through tempo automation after the clip offset', () => {
  const s = setup(1, 48);
  s.ch.params.tune = 12;
  s.p.clips[0].start = 96;
  const constant = { ...s, p: { ...s.p, bpm: 60 } };
  const value = (60 - 20) / 280;
  s.p = { ...s.p, automation: { tempo: { id: 'tempo', target: { kind: 'tempo' }, points: [{ t: 0, v: value }] } },
    clips: [...s.p.clips, createClip({ kind: 'auto', ref: 'tempo', start: 0, len: 384 })] };
  expect(wave(s)).toEqual(wave(constant));
  expect(wave(s).at(-1)[0]).toBe(119);
  expect(onsetPeak(s, 0.3)).toBeLessThan(1e-8);
});

it('preserves a pitched waveform while scrolling and restores it after a pitch edit', () => {
  const s = setup();
  const normal = wave(s);
  const ch = { ...s.ch, pitch: 750 };
  const pitched = { ...s, ch, p: { ...s.p, channels: [ch] } };
  expect(onsetPeak(pitched, 75 / 192) / onsetPeak(s, 75 / 192)).toBeCloseTo(4, 2);
  const full = wave(pitched);
  expect(full.find((bar) => bar[0] === 75)[3] / normal.find((bar) => bar[0] === 75)[3]).toBeCloseTo(4, 2);
  expect(wave(pitched, 60)).toEqual(full.filter((bar) => bar[0] >= 60).map((bar) => [bar[0] - 60, ...bar.slice(1)]));
  expect(wave(s)).toEqual(normal);
});

it('preserves the unpitched waveform when pitch controls cancel each other', () => {
  const s = setup(1, 48);
  const normal = wave(s);
  const ch = { ...s.ch, pitch: -750, params: { ...s.ch.params, tune: 12 } };
  const balanced = { ...s, ch, p: { ...s.p, masterPitch: -450, channels: [ch] } };
  expect(wave(balanced)).toEqual(normal);
  expect(onsetPeak(balanced, 0.1)).toBeCloseTo(onsetPeak(s, 0.1), 6);
});
