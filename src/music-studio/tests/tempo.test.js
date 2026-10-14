// Tempo automation: the tempo map math (engine/tempo.js), compiling tempo
// clips, sample-accurate scheduling under a ramp, render length, delay sync
// and keeping the musical position when the tempo changes while playing.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TempoMap, tempoPieces, tempoFromNorm, tempoToNorm, TEMPO_MIN, TEMPO_MAX } from '../src/engine/tempo.js';
import { compileChannel, compileMixer, compileSequence, compileTempo, tempoMap } from '../src/engine/compile.js';
import { Sequencer } from '../src/engine/sequencer.js';
import { Core, BLOCK } from '../src/engine/core.js';
import { evaluateAutomation } from '../src/automation/evaluate.js';
import { resolveTarget, listTargets, TEMPO_PARAM } from '../src/automation/targets.js';
import { formatParam } from '../src/lib/params.js';
import { createProject, createChannel, createNote, createSlot } from '../src/model/project.js';
import { formatTime } from '../src/model/time.js';
import { Engine } from '../src/engine/engine.js';
import { Store } from '../src/model/store.js';
import { Prefs } from '../src/lib/prefs.js';

const PPQ = 96;
const BAR = PPQ * 4;
const RATE = 48000;
const n = tempoToNorm;

/** Seconds from 0 to `tick` by numeric integration (midpoint rule) of 60 / (PPQ bpm(t)). */
function integrate(bpmAt, tick, steps = 200000) {
  const dt = tick / steps;
  let s = 0;
  for (let i = 0; i < steps; i++) s += (60 / (PPQ * bpmAt((i + 0.5) * dt))) * dt;
  return s;
}

/** A project with one tempo automation clip. */
function tempoProject(points, clip = {}, bpm = 120) {
  const p = createProject();
  p.bpm = bpm;
  p.automation = { t: { id: 't', name: 'Tempo', target: { kind: 'tempo' }, points } };
  p.clips = [{ id: 'tc', kind: 'auto', track: 0, start: 0, len: BAR * 4, offset: 0, ref: 't', mute: false, ...clip }];
  return p;
}

/** A fake core that records scheduled events with absolute frames. */
function recorder() {
  const ev = [];
  let frame = 0;
  const core = {
    bpm: 0,
    tempos: [],
    setTempo(b) {
      this.bpm = b;
      this.tempos.push(b);
    },
    noteOn: (slot, id, key, vel, pan, off) => ev.push({ type: 'on', key, frame: frame + off }),
    noteOff: (slot, id, off) => ev.push({ type: 'off', frame: frame + off }),
    audioOn: (slot, id, sec, gain, off) => ev.push({ type: 'audio', sec, frame: frame + off }),
    click: (accent, off) => ev.push({ type: 'click', accent, frame: frame + off }),
    process: (frames) => {
      frame += frames;
      return null;
    },
    automateParam() {},
    automateStrip() {},
    automateTrack() {},
    automateFx() {},
    automateMix() {},
    restoreParam() {},
  };
  return { core, ev };
}

describe('tempo map math', () => {
  it('converts at a constant tempo', () => {
    const m = new TempoMap(120);
    expect(m.constant).toBe(true);
    expect(m.seconds(PPQ * 2)).toBeCloseTo(1, 12);
    expect(m.ticks(1)).toBeCloseTo(192, 9);
    expect(m.bpmAt(5000)).toBe(120);
    expect(m.seconds(-96)).toBeCloseTo(-0.5, 12);
    // No tempo clips: a single constant piece at project.bpm.
    const data = tempoPieces(97, []);
    expect([...data.tick]).toEqual([0]);
    expect(new TempoMap(data).seconds(97 * PPQ)).toBeCloseTo(60, 9);
  });

  it('integrates a linear ramp exactly', () => {
    // 60 -> 180 BPM over four bars, then the last value holds.
    const p = tempoProject([{ t: 0, v: n(60) }, { t: BAR * 4, v: n(180) }], { len: BAR * 8 });
    const m = tempoMap(p);
    const bpm = (t) => (t < BAR * 4 ? 60 + (120 * t) / (BAR * 4) : 180);
    expect(m.bpmAt(0)).toBeCloseTo(60, 9);
    expect(m.bpmAt(BAR * 2)).toBeCloseTo(120, 9);
    expect(m.bpmAt(BAR * 6)).toBeCloseTo(180, 9);
    // Closed form: 60 / (PPQ k) ln(b1 / b0), k = 120 BPM / 1536 ticks.
    const k = 120 / (BAR * 4);
    expect(m.seconds(BAR * 4)).toBeCloseTo((60 / (PPQ * k)) * Math.log(3), 9);
    for (const t of [100, BAR, BAR * 3.3, BAR * 4, BAR * 5.5]) expect(m.seconds(t)).toBeCloseTo(integrate(bpm, t), 6);
  });

  it('handles step changes', () => {
    // 120 BPM for a bar, then 60 BPM (two points at the same time make a step).
    const p = tempoProject([{ t: 0, v: n(120) }, { t: BAR, v: n(120) }, { t: BAR, v: n(60) }, { t: BAR * 2, v: n(60) }], { len: BAR * 2 }, 90);
    const m = tempoMap(p);
    expect(m.bpmAt(BAR - 1)).toBeCloseTo(120, 9);
    expect(m.bpmAt(BAR)).toBeCloseTo(60, 9);
    expect(m.seconds(BAR)).toBeCloseTo(2, 9);
    expect(m.seconds(BAR * 2)).toBeCloseTo(6, 9);
    // After the clip: project.bpm (90).
    expect(m.bpmAt(BAR * 3)).toBe(90);
    expect(m.seconds(BAR * 3)).toBeCloseTo(6 + 240 / 90, 9);
    expect(m.ticks(2)).toBeCloseTo(BAR, 6);
    expect(m.ticks(4)).toBeCloseTo(BAR * 1.5, 6);
  });

  it('round trips tick -> seconds -> tick on ramps, steps and curves', () => {
    const maps = [
      tempoMap(tempoProject([{ t: 0, v: n(70) }, { t: BAR * 3, v: n(200) }])),
      tempoMap(tempoProject([{ t: 0, v: n(150) }, { t: BAR, v: n(150) }, { t: BAR, v: n(40) }, { t: BAR * 4, v: n(260) }])),
      tempoMap(tempoProject([{ t: 0, v: n(80), c: 0.8 }, { t: BAR * 2, v: n(160), c: -0.6 }, { t: BAR * 4, v: n(90) }])),
    ];
    for (const m of maps) {
      for (let t = 0; t < BAR * 6; t += 37.25) {
        const s = m.seconds(t);
        expect(m.ticks(s)).toBeCloseTo(t, 6);
        // Monotonic.
        expect(m.seconds(t + 1)).toBeGreaterThan(s);
      }
    }
  });

  it('follows curved segments to within a sample', () => {
    const points = [{ t: 0, v: n(60), c: 0.9 }, { t: BAR * 4, v: n(240) }];
    const m = tempoMap(tempoProject(points));
    const bpm = (t) => tempoFromNorm(evaluateAutomation(points, t));
    for (const t of [BAR, BAR * 2, BAR * 4]) {
      expect(Math.abs(m.seconds(t) - integrate(bpm, t))).toBeLessThan(1 / RATE);
      expect(Math.abs(m.bpmAt(t - 1) - bpm(t - 1))).toBeLessThan(0.01);
    }
  });

  it('compiles only audible tempo clips; the earlier clip wins where clips overlap; pattern mode keeps project.bpm', () => {
    const p = tempoProject([{ t: 0, v: n(60) }], { start: BAR, len: BAR * 2 });
    p.automation.u = { id: 'u', name: 'Tempo 2', target: { kind: 'tempo' }, points: [{ t: 0, v: n(200) }] };
    p.clips.push({ id: 'uc', kind: 'auto', track: 1, start: BAR * 2, len: BAR * 2, offset: 0, ref: 'u', mute: false });
    let m = tempoMap(p);
    expect(m.bpmAt(BAR / 2)).toBe(120);
    expect(m.bpmAt(BAR * 1.5)).toBeCloseTo(60, 9);
    expect(m.bpmAt(BAR * 2.5)).toBeCloseTo(60, 9); // overlap: the first clip
    expect(m.bpmAt(BAR * 3.5)).toBeCloseTo(200, 9);
    expect(m.bpmAt(BAR * 5)).toBe(120);
    expect(tempoMap(p, 'pattern').constant).toBe(true);
    expect(compileTempo(p, 'pattern').b0[0]).toBe(120);
    // Muted clips and muted tracks do not change the tempo.
    const q = { ...p, clips: p.clips.map((c) => (c.id === 'tc' ? { ...c, mute: true } : c)), tracks: p.tracks.map((t, i) => (i === 1 ? { ...t, mute: true } : t)) };
    expect(tempoMap(q).constant).toBe(true);
    // Clip offset: the clip reads its automation from `offset`.
    const r = tempoProject([{ t: 0, v: n(60) }, { t: BAR, v: n(60) }, { t: BAR, v: n(180) }], { start: 0, len: BAR, offset: BAR / 2 });
    expect(tempoMap(r).bpmAt(BAR / 4)).toBeCloseTo(60, 9);
    expect(tempoMap(r).bpmAt(BAR * 0.75)).toBeCloseTo(180, 9);
  });

  it('formats song time through the map', () => {
    const p = tempoProject([{ t: 0, v: n(60) }], { len: BAR });
    expect(formatTime(BAR, tempoMap(p))).toBe('0:04:00');
    expect(formatTime(BAR * 2, tempoMap(p))).toBe('0:06:00');
    expect(formatTime(BAR, 120)).toBe('0:02:00');
  });
});

describe('tempo target', () => {
  it('resolves to a 20..300 BPM linear parameter defaulting to the project tempo', () => {
    const p = createProject();
    p.bpm = 128;
    const r = resolveTarget(p, { kind: 'tempo' });
    expect(r.def).toMatchObject({ min: TEMPO_MIN, max: TEMPO_MAX, def: 128 });
    expect(TEMPO_MIN).toBe(20);
    expect(TEMPO_MAX).toBe(300);
    expect(r.norm).toBeCloseTo((128 - 20) / 280, 12);
    expect(r.label).toBe('Tempo');
    expect(formatParam(TEMPO_PARAM, 128)).toBe('128 BPM');
    expect(formatParam(TEMPO_PARAM, 92.5)).toBe('92.5 BPM');
    expect(formatParam(TEMPO_PARAM, 92.123456)).toBe('92.12 BPM');
    expect(listTargets(p).at(-1).items.map((i) => i.target)).toContainEqual({ kind: 'tempo' });
    expect(tempoFromNorm(tempoToNorm(140))).toBeCloseTo(140, 9);
  });
});

describe('scheduling under tempo automation', () => {
  it('places notes on a ramp at their exact frames', () => {
    const p = tempoProject([{ t: 0, v: n(60) }, { t: BAR * 2, v: n(180) }], { len: BAR * 2 });
    const ch = createChannel({ type: 'drum' });
    p.channels = [ch];
    p.patterns[0].notes = { [ch.id]: Array.from({ length: 16 }, (_, i) => createNote({ key: 60, pos: i * PPQ * 0.5, len: 12 })) };
    p.clips.push({ id: 'pc', kind: 'pattern', track: 1, start: 0, len: BAR * 2, offset: 0, ref: p.patterns[0].id, mute: false });
    const seq = compileSequence(p, { mode: 'song', slotOf: () => 0 });
    const { core, ev } = recorder();
    const s = new Sequencer(core, RATE);
    s.setSequence(seq);
    s.play(0);
    const total = Math.ceil(s.framesBetween(0, BAR * 2) / BLOCK) + 2;
    for (let i = 0; i < total; i++) s.block(BLOCK);
    // The 16 notes of the first pass (playback wraps after two bars).
    const ons = ev.filter((e) => e.type === 'on' && e.frame < s.framesBetween(0, BAR * 2));
    expect(ons.length).toBe(16);
    const bpm = (t) => 60 + (120 * t) / (BAR * 2);
    ons.forEach((e, i) => {
      const exact = integrate(bpm, i * PPQ * 0.5, 20000) * RATE;
      expect(e.frame).toBeGreaterThanOrEqual(Math.floor(exact - 0.01));
      expect(e.frame).toBeLessThanOrEqual(Math.ceil(exact + 0.01));
    });
    // Gaps shrink as the tempo rises.
    expect(ons[15].frame - ons[14].frame).toBeLessThan(ons[1].frame - ons[0].frame);
    // The core follows the tempo for synced effects.
    expect(core.tempos[0]).toBeCloseTo(60, 6);
    expect(Math.max(...core.tempos)).toBeGreaterThan(170);
  });

  it('wraps the loop and clicks the metronome on the ramped beats', () => {
    const p = tempoProject([{ t: 0, v: n(60) }, { t: BAR, v: n(120) }], { len: BAR });
    p.loop = { start: 0, end: BAR };
    const seq = compileSequence(p, { mode: 'song', slotOf: () => 0 });
    const { core, ev } = recorder();
    const s = new Sequencer(core, RATE);
    s.metronome = true;
    s.setSequence(seq);
    s.play(0);
    const len = s.framesBetween(0, BAR);
    const map = new TempoMap(seq.tempo);
    for (let i = 0; i < Math.ceil((len * 1.5) / BLOCK); i++) s.block(BLOCK);
    expect(s.wraps).toBe(1);
    const clicks = ev.filter((e) => e.type === 'click');
    expect(clicks.slice(0, 4).map((c) => c.frame)).toEqual([0, 1, 2, 3].map((b) => Math.ceil(map.seconds(b * PPQ) * RATE - 1e-6) + 0));
    // The second pass starts with an accent right at the wrap frame.
    expect(clicks[4].accent).toBe(true);
    expect(Math.abs(clicks[4].frame - Math.ceil(len))).toBeLessThanOrEqual(1);
  });

  it('starts audio clips mid-way at the tempo-mapped offset', () => {
    const p = tempoProject([{ t: 0, v: n(60) }], { len: BAR * 4 });
    const ch = createChannel({ type: 'audio' });
    p.channels = [ch];
    p.clips.push({ id: 'ac', kind: 'audio', track: 1, start: BAR, len: BAR, offset: PPQ, ref: ch.id, mute: false });
    const seq = compileSequence(p, { mode: 'song', slotOf: () => 0 });
    // One beat of offset at 60 BPM is one second.
    expect(seq.notes.offset[0]).toBeCloseTo(1, 9);
    const { core, ev } = recorder();
    const s = new Sequencer(core, RATE);
    s.setSequence(seq);
    s.play(BAR + PPQ * 2);
    expect(ev[0].type).toBe('audio');
    expect(ev[0].sec).toBeCloseTo(3, 9);
  });

  it('renders a song with a tempo change for the tempo-mapped length', () => {
    // Two bars: the first at 60 BPM (4 s), the second at the project 120 BPM (2 s).
    const p = tempoProject([{ t: 0, v: n(60) }], { len: BAR });
    const seq = compileSequence(p, { mode: 'song', slotOf: () => 0, range: { start: 0, end: BAR * 2 } });
    const { core } = recorder();
    const s = new Sequencer(core, RATE, { loop: false });
    s.setSequence(seq);
    s.play(0);
    expect(s.framesBetween(0, BAR * 2)).toBeCloseTo(6 * RATE, 6);
    let blocks = 0;
    while (s.playing && blocks < 10000) {
      s.block(BLOCK);
      blocks++;
    }
    expect(s.ended).toBe(true);
    // Six seconds of blocks, plus the block that notices the end.
    expect(blocks).toBe(Math.ceil((6 * RATE) / BLOCK) + 1);
  });

  it('keeps the musical position when project.bpm changes while playing', () => {
    const p = createProject();
    p.bpm = 120;
    const { core } = recorder();
    const s = new Sequencer(core, RATE);
    s.setSequence(compileSequence(p, { mode: 'pattern', slotOf: () => 0 }));
    s.play(0);
    for (let i = 0; i < 100; i++) s.block(BLOCK);
    const at = s.pos;
    expect(at).toBeCloseTo((100 * BLOCK * 2 * PPQ) / RATE, 6);
    s.setSequence(compileSequence({ ...p, bpm: 60 }, { mode: 'pattern', slotOf: () => 0 }));
    expect(s.pos).toBe(at);
    s.block(BLOCK);
    expect(s.pos - at).toBeCloseTo((BLOCK * PPQ) / RATE, 9);
    expect(core.bpm).toBe(60);
  });
});

describe('engine transport clock', () => {
  const mem = () => {
    const m = new Map();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  };

  it('converts through the tempo map and keeps the position across tempo changes', async () => {
    const p = tempoProject([{ t: 0, v: n(60) }], { len: BAR });
    const store = new Store(p);
    const engine = new Engine(store, new Prefs(mem()));
    engine.mode = 'song';
    expect(engine.ticksToSeconds(BAR)).toBeCloseTo(4, 9);
    expect(engine.secondsToTicks(5)).toBeCloseTo(BAR * 1.5, 6);
    expect(engine.bpmAt(BAR * 2)).toBe(120);
    expect(engine.seconds(BAR, BAR)).toBeCloseTo(2, 9);
    engine.mode = 'pattern';
    expect(engine.ticksToSeconds(BAR)).toBeCloseTo(2, 9);
    await engine.play(); // no Web Audio here: the fallback clock runs
    await new Promise((r) => setTimeout(r, 60));
    const before = engine.position;
    expect(before).toBeGreaterThan(0);
    store.apply('Change tempo', (q) => ({ ...q, bpm: 30 }));
    const after = engine.position;
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after - before).toBeLessThan(10);
    engine.stop();
  });
});

describe('tempo-synced delay', () => {
  let module;
  beforeAll(() => {
    module = new WebAssembly.Module(fs.readFileSync(path.resolve(import.meta.dirname, '../src/engine/engine.wasm')));
  });

  /** Frame of the echo of a hit at tick 0 through a 1/4-note synced delay. */
  function echoFrame(project) {
    const core = new Core(new WebAssembly.Instance(module, {}), RATE);
    const ch = createChannel({ type: 'drum', params: { kind: 1 }, mixer: 1 });
    const delay = createSlot('delay');
    delay.params = { ...delay.params, sync: 1, division: 9, feedback: 0, wet: 1, dry: 0, pingpong: 0, tone: 20000 };
    project.channels = [ch];
    project.mixer[1] = { ...project.mixer[1], fx: [delay] };
    project.patterns[0].notes = { [ch.id]: [createNote({ key: 60, pos: 0, len: 6 })] };
    project.clips.push({ id: 'pc', kind: 'pattern', track: 1, start: 0, len: BAR, offset: 0, ref: project.patterns[0].id, mute: false });
    core.setMixer(compileMixer(project));
    core.setChannel(compileChannel(project, ch, 0));
    const s = new Sequencer(core, RATE);
    s.setSequence(compileSequence(project, { mode: 'song', slotOf: () => 0 }));
    s.play(0);
    for (let f = 0; f < RATE * 1.5; f += BLOCK) {
      const out = s.block(BLOCK);
      // Skip the dry hit (dry and wet glide to their settings over the first blocks).
      if (f < RATE * 0.25) continue;
      for (let i = 0; i < BLOCK; i++) if (Math.abs(out.l[i]) > 0.01) return f + i;
    }
    return -1;
  }

  it('follows the automated tempo', () => {
    const plain = createProject();
    plain.bpm = 120;
    plain.clips = [];
    const at120 = echoFrame(plain);
    // A beat at 120 BPM is half a second.
    expect(at120).toBeGreaterThan(RATE * 0.5 - 50);
    expect(at120).toBeLessThan(RATE * 0.5 + 400);
    const slow = tempoProject([{ t: 0, v: n(80) }], { len: BAR * 4 });
    const at80 = echoFrame(slow);
    // At 80 BPM the beat lasts 0.75 s.
    expect(at80 - at120).toBeGreaterThan(RATE * 0.25 - 50);
    expect(at80 - at120).toBeLessThan(RATE * 0.25 + 50);
  });
});
