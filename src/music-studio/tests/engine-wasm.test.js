// DSP sanity checks: instantiates src/engine/engine.wasm in Node and renders
// instruments, effects and sequences offline.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Core, BLOCK } from '../src/engine/core.js';
import { Sequencer } from '../src/engine/sequencer.js';
import { compileChannel, compileMixer, compileSequence, instrumentIndex, effectIndex } from '../src/engine/compile.js';
import { INSTRUMENTS, INSTRUMENT_TYPES, paramVector } from '../src/instruments/catalog.js';
import { EFFECTS, EFFECT_TYPES, DIVISION_BEATS, effectParamVector } from '../src/effects/catalog.js';
import { SYNTH_PRESETS, DRUM_PRESETS } from '../src/instruments/presets.js';
import { createProject, createChannel, createNote, createSlot } from '../src/model/project.js';
import { demoProject } from '../src/model/demo.js';

const RATE = 48000;
let module;

beforeAll(() => {
  const bytes = fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm'));
  module = new WebAssembly.Module(bytes);
});

function makeCore(rate = RATE) {
  return new Core(new WebAssembly.Instance(module, {}), rate);
}

/** A core with one channel of `type` on insert 1 and a default mixer. */
function setup(type, params = {}, { fx = [] } = {}) {
  const core = makeCore();
  const p = createProject();
  p.channels = [createChannel({ type, params, mixer: 1 })];
  p.mixer[1] = { ...p.mixer[1], fx: fx.map((s) => (typeof s === 'string' ? createSlot(s) : s)) };
  core.setMixer(compileMixer(p));
  core.setChannel(compileChannel(p, p.channels[0], 0));
  return core;
}

/** Renders `seconds` and returns { l, r, peak, rms, finite }. */
function render(core, seconds, each) {
  const frames = Math.ceil((seconds * RATE) / BLOCK) * BLOCK;
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let f = 0; f < frames; f += BLOCK) {
    each?.(f);
    const out = core.process(BLOCK);
    l.set(out.l, f);
    r.set(out.r, f);
  }
  let peak = 0;
  let sum = 0;
  let finite = true;
  for (let i = 0; i < frames; i++) {
    if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) finite = false;
    peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    sum += l[i] * l[i] + r[i] * r[i];
  }
  return { l, r, peak, rms: Math.sqrt(sum / (2 * frames)), finite };
}

describe('engine contract', () => {
  it('has the same parameter counts and order as the catalogs', () => {
    const x = makeCore().x;
    expect(x.inst_type_count()).toBe(INSTRUMENT_TYPES.length);
    for (const t of INSTRUMENT_TYPES) expect([t, x.inst_param_count(instrumentIndex(t))]).toEqual([t, INSTRUMENTS[t].params.length]);
    expect(x.fx_type_count()).toBe(EFFECT_TYPES.length);
    for (const t of EFFECT_TYPES) expect([t, x.fx_param_count(effectIndex(t))]).toEqual([t, EFFECTS[t].params.length]);
    expect(x.division_count()).toBe(DIVISION_BEATS.length);
    DIVISION_BEATS.forEach((b, i) => expect(x.division_beats(i)).toBeCloseTo(b, 6));
  });
});

describe('instruments', () => {
  it('renders every drum preset: finite, audible, bounded', () => {
    for (const preset of DRUM_PRESETS) {
      const core = setup('drum', preset.params);
      core.noteOn(0, 1, 60, 0.9);
      const res = render(core, 0.6);
      expect(res.finite, preset.name).toBe(true);
      expect(res.peak, preset.name).toBeGreaterThan(0.02);
      expect(res.peak, preset.name).toBeLessThan(1.5);
    }
  });

  it('renders every synth preset with a chord: finite, audible, bounded', () => {
    for (const preset of SYNTH_PRESETS) {
      const core = setup('synth', preset.params);
      [48, 55, 60, 64].forEach((k, i) => core.noteOn(0, i + 1, k, 0.8));
      const res = render(core, 0.5, (f) => {
        if (f === 0.3 * RATE - ((0.3 * RATE) % BLOCK)) [1, 2, 3, 4].forEach((id) => core.noteOff(0, id));
      });
      expect(res.finite, preset.name).toBe(true);
      expect(res.peak, preset.name).toBeGreaterThan(0.01);
      expect(res.peak, preset.name).toBeLessThan(2);
    }
  });

  it('starts a scheduled note at the exact sample offset', () => {
    const core = setup('drum', { kind: 1, noise: 0.8 });
    core.process(BLOCK);
    core.noteOn(0, 1, 60, 1, 0, 37);
    const out = core.process(BLOCK);
    for (let i = 0; i < 37; i++) expect(out.l[i]).toBe(0);
    let first = -1;
    for (let i = 0; i < BLOCK; i++) if (out.l[i] !== 0) {
      first = i;
      break;
    }
    expect(first).toBeGreaterThanOrEqual(37);
    expect(first).toBeLessThanOrEqual(38);
  });

  it('releases synth notes and goes silent', () => {
    const core = setup('synth', { a_release: 50 });
    core.noteOn(0, 7, 60, 1);
    render(core, 0.1);
    core.noteOff(0, 7);
    render(core, 0.5);
    const tail = render(core, 0.05);
    expect(tail.peak).toBe(0);
  });

  it('plays samples with rate conversion and the audio clip player', () => {
    const sr = 22050;
    const sine = new Float32Array(sr).map((_, i) => Math.sin((2 * Math.PI * 441 * i) / sr) * 0.5);
    const core = setup('sampler', {});
    core.loadSample(3, [sine], sr);
    core.setChannel({ ...compileChannel(createProject(), createChannel({ type: 'sampler', mixer: 1 }), 0), sample: 3 });
    core.noteOn(0, 1, 60, 1);
    const res = render(core, 0.25);
    expect(res.finite).toBe(true);
    expect(res.peak).toBeGreaterThan(0.1);
    // Zero crossings: 441 Hz over 0.2 s is about 176 crossings.
    let zc = 0;
    for (let i = RATE * 0.02 + 1; i < RATE * 0.22; i++) if (res.l[i - 1] < 0 !== res.l[i] < 0) zc++;
    expect(Math.abs(zc - 176)).toBeLessThan(6);

    const a = setup('audio', {});
    a.loadSample(0, [sine, sine], sr);
    a.setChannel({ ...compileChannel(createProject(), createChannel({ type: 'audio', mixer: 1 }), 0), sample: 0 });
    a.audioOn(0, 5, 0.5, 1);
    const half = render(a, 0.6);
    expect(half.peak).toBeGreaterThan(0.1);
    // Half a second left in the file: silence after it.
    expect(Math.max(...half.l.subarray(Math.round(RATE * 0.52)).map(Math.abs))).toBe(0);
  });
});

describe('effects', () => {
  it('stay finite with extreme parameters', () => {
    for (const type of EFFECT_TYPES) {
      for (const extreme of ['min', 'max']) {
        const slot = createSlot(type);
        slot.params = Object.fromEntries(EFFECTS[type].params.map((p) => [p.id, p[extreme]]));
        const core = setup('synth', { osc1_wave: 5, a_sustain: 1 }, { fx: [slot] });
        core.noteOn(0, 1, 40, 1);
        const res = render(core, 0.4);
        expect(res.finite, `${type} ${extreme}`).toBe(true);
        expect(res.peak, `${type} ${extreme}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('limits to the ceiling', () => {
    const slot = createSlot('limiter');
    slot.params = { input: 24, ceiling: -6, release: 50 };
    const core = setup('synth', { osc1_wave: 3, a_sustain: 1, gain: 1 }, { fx: [slot] });
    core.noteOn(0, 1, 45, 1);
    const res = render(core, 0.3);
    // Insert and master faders follow the limiter: 0.5 * 0.8 * 0.8.
    expect(res.peak).toBeLessThanOrEqual(0.5012 * 0.64 + 1e-4);
    expect(res.peak).toBeGreaterThan(0.25);
  });

  it('keeps a reverb tail after the input stops', () => {
    const slot = createSlot('reverb');
    slot.params = { ...slot.params, wet: 1, dry: 0, decay: 3 };
    const core = setup('drum', { kind: 0 }, { fx: [slot] });
    core.noteOn(0, 1, 60, 1);
    render(core, 1);
    const tail = render(core, 0.2);
    expect(tail.finite).toBe(true);
    expect(tail.peak).toBeGreaterThan(1e-4);
  });
});

describe('sequencer', () => {
  it('plays the demo song in song mode with meters and loops', () => {
    const p = demoProject();
    const core = makeCore();
    const slots = new Map(p.channels.map((c, i) => [c.id, i]));
    core.setMixer(compileMixer(p));
    p.channels.forEach((c, i) => core.setChannel(compileChannel(p, c, i)));
    const seq = new Sequencer(core, RATE);
    const compiled = compileSequence(p, { mode: 'song', slotOf: (id) => slots.get(id) });
    seq.setSequence(compiled);
    seq.play(compiled.end - 96);
    let peak = 0;
    let finite = true;
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      const out = seq.block(BLOCK);
      for (let k = 0; k < BLOCK; k++) {
        peak = Math.max(peak, Math.abs(out.l[k]), Math.abs(out.r[k]));
        if (!Number.isFinite(out.l[k])) finite = false;
      }
    }
    const ms = performance.now() - start;
    expect(seq.wraps).toBeGreaterThanOrEqual(1);
    expect(finite).toBe(true);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(1.5);
    const meters = core.meters();
    expect(meters[0]).toBeGreaterThan(0);
    expect(meters[2]).toBeGreaterThan(0); // the kick insert
    // 200 blocks are 0.53 s of audio: rendering must be much faster than real time.
    expect(ms).toBeLessThan(400);
  });

  it('places a sequenced note at its exact frame', () => {
    const p = createProject();
    const ch = createChannel({ type: 'drum', params: { kind: 1 }, mixer: 1 });
    p.channels = [ch];
    p.bpm = 120;
    p.patterns[0].notes = { [ch.id]: [createNote({ key: 60, pos: 96, len: 24 })] };
    const core = makeCore();
    core.setMixer(compileMixer(p));
    core.setChannel(compileChannel(p, ch, 0));
    const seq = new Sequencer(core, RATE);
    seq.setSequence(compileSequence(p, { mode: 'pattern', slotOf: () => 0 }));
    seq.play(0);
    // One beat at 120 bpm is 0.5 s = 24000 frames.
    const l = new Float32Array(BLOCK * 200);
    for (let f = 0; f < l.length; f += BLOCK) l.set(seq.block(BLOCK).l, f);
    let first = -1;
    for (let i = 0; i < l.length; i++) if (l[i] !== 0) {
      first = i;
      break;
    }
    expect(first).toBeGreaterThanOrEqual(24000);
    expect(first).toBeLessThanOrEqual(24001);
  });

  it('applies automation and restores the value outside clips', () => {
    const p = createProject();
    const ch = createChannel({ type: 'synth', mixer: 1 });
    p.channels = [ch];
    p.automation = { a: { id: 'a', name: 'Vol', target: { kind: 'mixer', track: 1, param: 'volume' }, points: [{ t: 0, v: 0 }, { t: 384, v: 0 }] } };
    p.clips = [{ id: 'c', kind: 'auto', track: 0, start: 0, len: 384, offset: 0, ref: 'a', mute: false }];
    p.loop = { start: 0, end: 384 * 4 };
    const core = makeCore();
    core.setMixer(compileMixer(p));
    core.setChannel(compileChannel(p, ch, 0));
    const seq = new Sequencer(core, RATE);
    seq.setSequence(compileSequence(p, { mode: 'song', slotOf: () => 0 }));
    core.noteOn(0, 1, 60, 1);
    seq.play(0);
    for (let i = 0; i < 20; i++) seq.block(BLOCK);
    core.meters();
    for (let i = 0; i < 20; i++) seq.block(BLOCK);
    expect(core.meters()[2]).toBe(0);
    seq.seek(500);
    for (let i = 0; i < 20; i++) seq.block(BLOCK);
    core.meters();
    for (let i = 0; i < 4; i++) seq.block(BLOCK);
    expect(core.meters()[2]).toBeGreaterThan(0.01);
  });

  it('counts in one bar before playing', () => {
    const p = createProject();
    const ch = createChannel({ type: 'drum', mixer: 1 });
    p.channels = [ch];
    p.bpm = 120;
    p.patterns[0].notes = { [ch.id]: [createNote({ key: 60, pos: 0, len: 24 })] };
    const core = makeCore();
    core.setMixer(compileMixer(p));
    core.setChannel(compileChannel(p, ch, 0));
    const seq = new Sequencer(core, RATE);
    seq.setSequence(compileSequence(p, { mode: 'pattern', slotOf: () => 0 }));
    seq.play(0, { countIn: true });
    expect(seq.counting).toBe(true);
    // Two seconds of count-in at 120 bpm in 4/4: the kick is not yet playing.
    for (let i = 0; i < Math.floor(1.9 * RATE / BLOCK); i++) seq.block(BLOCK);
    expect(core.meters()[2]).toBe(0);
    expect(seq.pos).toBe(0);
    for (let i = 0; i < 60; i++) seq.block(BLOCK);
    expect(seq.counting).toBe(false);
    expect(core.meters()[2]).toBeGreaterThan(0);
  });

  it('releases sounding audio clips and notes that an edit removes, and starts clips moved under the playhead', () => {
    const p = createProject();
    const ch = createChannel({ type: 'audio', mixer: 1, sample: 's' });
    const pad = createChannel({ type: 'synth', mixer: 2 });
    p.channels = [ch, pad];
    p.bpm = 120;
    p.patterns[0].notes = { [pad.id]: [createNote({ key: 60, pos: 0, len: 384 * 4 })] };
    const clip = { id: 'c', kind: 'audio', track: 0, start: 0, len: 384 * 4, offset: 0, ref: ch.id, mute: false };
    const notes = { id: 'n', kind: 'pattern', track: 1, start: 0, len: 384 * 4, offset: 0, ref: p.patterns[0].id, mute: false };
    p.clips = [clip, notes];
    const sine = new Float32Array(RATE * 10).map((_, i) => Math.sin((2 * Math.PI * 220 * i) / RATE) * 0.5);
    const core = makeCore();
    const slots = new Map([[ch.id, 0], [pad.id, 1]]);
    core.loadSample(0, [sine], RATE);
    core.setMixer(compileMixer(p));
    core.setChannel(compileChannel(p, ch, 0, () => 0));
    core.setChannel(compileChannel(p, pad, 1));
    const seq = new Sequencer(core, RATE);
    const compile = (proj) => compileSequence(proj, { mode: 'song', slotOf: (id) => slots.get(id) });
    seq.setSequence(compile(p));
    seq.play(0);
    const run = (blocks) => {
      for (let i = 0; i < blocks; i++) seq.block(BLOCK);
      return core.meters();
    };
    run(40);
    let m = run(10);
    expect(m[2]).toBeGreaterThan(0.1); // audio insert
    expect(m[4]).toBeGreaterThan(0.01); // synth insert
    // Mute the audio clip and delete the long note while both sound.
    const muted = { ...p, clips: [{ ...clip, mute: true }, notes], patterns: [{ ...p.patterns[0], notes: {} }] };
    seq.setSequence(compile(muted));
    run(400); // the synth release tail
    m = run(10);
    expect(m[2]).toBe(0);
    expect(m[4]).toBeLessThan(1e-4);
    // Unmute: the clip resumes from the middle right away.
    seq.setSequence(compile({ ...muted, clips: [clip, notes] }));
    run(2);
    m = run(10);
    expect(m[2]).toBeGreaterThan(0.1);
  });
});

// Keep helpers referenced for linters.
void paramVector;
void effectParamVector;
