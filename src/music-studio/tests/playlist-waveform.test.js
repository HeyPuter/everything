import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createChannel, createClip, createProject } from '../src/model/project.js';
import { SampleCache } from '../src/audio/samples.js';
import { Core, BLOCK } from '../src/engine/core.js';
import { Sequencer } from '../src/engine/sequencer.js';
import { compileChannel, compileMixer, compileSequence } from '../src/engine/compile.js';
import { Viewport } from '../src/render/timeline.js';
import { drawCanvas, colors, resetColors } from '../src/playlist/render.js';
import { trackLayout } from '../src/playlist/geometry.js';
import { clipsByTrack, resizeClips, sliceClips } from '../src/playlist/clips.js';
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

function wave({ p, ch, samples }, scroll = 0, pxPerTick = 1) {
  const vp = new Viewport({ pxPerTick, scroll });
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

it.each(['trim', 'slice'])('keeps the pitched waveform content in place after %s', (action) => {
  const s = setup();
  s.ch.params.tune = 12;
  const before = wave(s);
  const id = s.p.clips[0].id;
  if (action === 'trim') s.p = resizeClips(s.p, [id], 'left', 48);
  else {
    const r = sliceClips(s.p, 48);
    s.p = { ...r.project, clips: r.project.clips.filter((c) => r.ids.includes(c.id)) };
  }
  expect(wave(s)).toEqual(before.filter((bar) => bar[0] >= 48));
});


function automate(s, param, value, { start = 0, len = 384, points } = {}) {
  const id = `auto-${param}`;
  s.p.automation[id] = { id, target: { kind: 'channel', id: s.ch.id, param }, points: points || [{ t: 0, v: value }] };
  s.p.clips.push(createClip({ kind: 'auto', ref: id, start, len, track: 1 }));
}
function sequencedPeak(s, tick) {
  const { p, ch, data } = s;
  const core = new Core(new WebAssembly.Instance(module, {}), RATE);
  core.setMixer(compileMixer(p)); core.loadSample(0, [data], RATE);
  core.setChannel(compileChannel(p, ch, 0, () => 0)); core.setMasterPitch(p.masterPitch);
  const seq = new Sequencer(core, RATE, { loop: false });
  seq.setSequence(compileSequence(p, { mode: 'song', slotOf: (id) => id === ch.id ? 0 : -1 }));
  seq.play(0);
  const skip = Math.round(seq.tempo.seconds(tick) * RATE);
  for (let f = 0; f < skip; f += BLOCK) seq.block(Math.min(BLOCK, skip - f));
  let peak = 0;
  for (let f = 0; f < 1024; f += BLOCK) for (const value of seq.block(BLOCK).l) peak = Math.max(peak, Math.abs(value));
  return peak;
}
const waveHeight = (s, tick) => wave(s).find((bar) => bar[0] === tick)?.[3] || 0;
it.each(['tune', 'pitch', 'reverse'])('follows an automated %s override in both the waveform and actual playback', (param) => {
  const normal = setup(), s = setup();
  automate(s, param, param === 'tune' ? 0.75 : 1);
  const tick = 60;
  expect(sequencedPeak(s, tick) / sequencedPeak(normal, tick)).toBeCloseTo(4, 2);
  expect(waveHeight(s, tick) / waveHeight(normal, tick)).toBeCloseTo(4, 2);
});
it.each([0, 1])('draws direction changes at the current source position (initial reverse %s)', (reverse) => {
  const normal = setup(reverse), s = setup(reverse);
  automate(s, 'reverse', 1 - reverse, { start: 120 });
  const tick = 160;
  const ratio = reverse ? 4 : 0.25;
  expect(sequencedPeak(s, tick) / sequencedPeak(normal, tick)).toBeCloseTo(ratio, 2);
  expect(waveHeight(s, tick) / waveHeight(normal, tick)).toBeCloseTo(ratio, 2);
});
it('does not draw audio after a reverse automation path has exhausted the source', () => {
  const s = setup(); automate(s, 'reverse', 1, { start: 48 });
  expect(sequencedPeak(s, 144)).toBe(0);
  expect(waveHeight(s, 144)).toBe(0);
});


it.each(['pitch', 'tune'].flatMap((param) => [0, -0.7, 0.7].map((curve) => [param, curve])))('follows a curved %s lane in the waveform (curve %s)', (param, curve) => {
  const normal = setup(), s = setup();
  automate(s, param, 1, { points: [{ t: 0, v: 0.5, c: curve }, { t: 96, v: param === 'tune' ? 0.75 : 1 }] });
  const tick = curve > 0 ? 88 : 84;
  const ratio = sequencedPeak(s, tick) / sequencedPeak(normal, tick);
  expect(waveHeight(s, tick) / waveHeight(normal, tick)).toBeCloseTo(ratio, 2);
});
it.each([0, -0.7])('draws a reverse ramp at its rounded switching point (curve %s)', (curve) => {
  const normal = setup(), s = setup();
  automate(s, 'reverse', 0, { points: [{ t: 0, v: 0, c: curve }, { t: 240, v: 1 }] });
  const tick = 160;
  expect(waveHeight(s, tick) / waveHeight(normal, tick)).toBeCloseTo(sequencedPeak(s, tick) / sequencedPeak(normal, tick), 2);
});
it('combines automated tuning, direction and tempo', () => {
  const normal = setup(), s = setup();
  automate(s, 'tune', 0.75); automate(s, 'reverse', 1, { start: 30 });
  s.p.automation.tempo = { id: 'tempo', target: { kind: 'tempo' }, points: [{ t: 0, v: (60 - 20) / 280 }] };
  s.p.clips.push(createClip({ kind: 'auto', ref: 'tempo', len: 384, track: 1 }));
  for (const tick of [26, 56, 90]) expect(waveHeight(s, tick) / waveHeight(normal, tick)).toBeCloseTo(sequencedPeak(s, tick) / sequencedPeak(normal, tick), 2);
});
it.each(['trim', 'slice'])('retains automated source content after %s and scrolling', (action) => {
  const s = setup(1, 12); automate(s, 'pitch', 1, { points: [{ t: 0, v: 0.5, c: -0.3 }, { t: 192, v: 1 }] });
  automate(s, 'reverse', 0, { start: 48 });
  const before = wave(s), id = s.p.clips[0].id;
  if (action === 'trim') s.p = resizeClips(s.p, [id], 'left', 48);
  else {
    const split = sliceClips(s.p, 48, (c) => c.kind === 'audio');
    s.p = { ...split.project, clips: split.project.clips.filter((c) => c.id !== id) };
  }
  expect(wave(s)).toEqual(before.filter((bar) => bar[0] >= 48));
  expect(wave(s, 60)).toEqual(before.filter((bar) => bar[0] >= 60).map((bar) => [bar[0] - 60, ...bar.slice(1)]));
});
it.each(['muted clip', 'muted track', 'outside clip'])('preserves ordinary waveforms with %s automation', (kind) => {
  const s = setup(1), before = wave(s);
  const p = { ...s.p, clips: [...s.p.clips], automation: {} }; s.p = p;
  automate(s, 'reverse', 0, { start: kind === 'outside clip' ? 384 : 0 });
  if (kind === 'muted clip') s.p.clips.at(-1).mute = true;
  if (kind === 'muted track') s.p.tracks = [...s.p.tracks, { ...s.p.tracks[0], mute: true }];
  expect(wave(s)).toEqual(before);
});
it('refreshes automated paths after immutable edits and decoded sample replacement', () => {
  const s = setup(); automate(s, 'tune', 0.75);
  const before = wave(s);
  const old = s.p;
  s.p = { ...old, automation: { ...old.automation, 'auto-tune': { ...old.automation['auto-tune'], points: [{ t: 0, v: 0.5 }] } } };
  expect(waveHeight(s, 60)).toBeLessThan(before.find((b) => b[0] === 60)[3]);
  s.p = old; expect(wave(s)).toEqual(before);
  s.samples.set('s', { channels: [Float32Array.from(s.data, (v) => v / 2)], rate: RATE });
  expect(waveHeight(s, 60)).toBeCloseTo(before.find((b) => b[0] === 60)[3] / 2, 5);
});


it('includes source travel inside a pixel when direction reverses within that pixel', () => {
  const s = setup();
  const data = Float32Array.from({ length: RATE }, (_, i) => Math.sin(2 * Math.PI * 400 * i / RATE) * (i > RATE * 0.57 && i < RATE * 0.65 ? 0.8 : 0.2));
  s.samples.set('s', { channels: [data], rate: RATE });
  automate(s, 'reverse', 1, { start: 120 });
  s.p.clips[0].len = 480;
  const bars = wave(s, 0, 0.01);
  expect(bars.find((b) => b[0] === 1)[3] / bars.find((b) => b[0] === 0)[3]).toBeCloseTo(4, 2);
});
it('does not recompile automation history for each pixel, redraw or scroll', () => {
  const s = setup();
  let reads = 0;
  const count = 6000;
  s.p.clips[0].len = count;
  s.p.automation.pitch = { id: 'pitch', target: { kind: 'channel', id: s.ch.id, param: 'pitch' }, points: [{ get t() { reads++; return 0; }, v: 0.5 }] };
  s.p.clips.push(...Array.from({ length: count }, (_, i) => createClip({ kind: 'auto', ref: 'pitch', start: i, len: 1, track: 1 })));
  const before = wave(s);
  expect(reads).toBeLessThanOrEqual(count * 2);
  const firstReads = reads;
  expect(wave(s)).toEqual(before);
  expect(wave(s, 60)).toEqual(before.filter((bar) => bar[0] >= 60).map((bar) => [bar[0] - 60, ...bar.slice(1)]));
  expect(reads).toBe(firstReads);
});

it('applies automated tuning as an override while retaining channel and master pitch', () => {
  const normal = setup(), s = setup();
  normal.ch.params.tune = s.ch.params.tune = 12;
  s.ch.pitch = 1200; s.p.masterPitch = -1200;
  automate(s, 'tune', 0.5);
  expect(sequencedPeak(s, 60) / sequencedPeak(normal, 60)).toBeCloseTo(0.25, 2);
  expect(waveHeight(s, 60) / waveHeight(normal, 60)).toBeCloseTo(0.25, 2);
});
it('restores configured direction after an automation clip ends', () => {
  const normal = setup(), s = setup();
  automate(s, 'reverse', 1, { start: 48, len: 24 });
  expect(sequencedPeak(s, 120) / sequencedPeak(normal, 120)).toBeCloseTo(0.25, 2);
  expect(waveHeight(s, 120) / waveHeight(normal, 120)).toBeCloseTo(0.25, 2);
});
it('uses the same overlapping-lane priority as playback', () => {
  const s = setup(); automate(s, 'reverse', 0, { len: 144 });
  s.p.automation.second = { id: 'second', target: { kind: 'channel', id: s.ch.id, param: 'reverse' }, points: [{ t: 0, v: 1 }] };
  s.p.clips.push(createClip({ kind: 'auto', ref: 'second', start: 96, len: 144, track: 1 }));
  expect(sequencedPeak(s, 220)).toBeGreaterThan(0.01);
  expect(waveHeight(s, 220)).toBeGreaterThan(1);
});
