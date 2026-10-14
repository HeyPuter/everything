// Project to audio-thread compilation (src/engine/compile.js) and automation
// evaluation (src/engine/sequencer.js).
import { describe, it, expect } from 'vitest';
import { compileChannel, compileMixer, compileSequence, mixerGains, trackOrder, swingWarp, playRange, resolveTarget, instrumentIndex, effectIndex } from '../src/engine/compile.js';
import { automationValue } from '../src/engine/sequencer.js';
import { createProject, createChannel, createNote, createPattern, createSlot } from '../src/model/project.js';
import { demoProject } from '../src/model/demo.js';
import { PPQ, STEP } from '../src/model/time.js';
import { INSTRUMENTS } from '../src/instruments/catalog.js';
import { fromNorm } from '../src/lib/params.js';

const BAR = PPQ * 4;

function project({ notes = [], type = 'synth' } = {}) {
  const p = createProject();
  const ch = createChannel({ type, mixer: 1 });
  p.channels = [ch];
  p.patterns[0].notes = { [ch.id]: notes.map((n) => createNote(n)) };
  return { p, ch, slotOf: (id) => (id === ch.id ? 3 : -1) };
}

const list = (seq) => Array.from({ length: seq.notes.count }, (_, i) => ({ start: seq.notes.start[i], end: seq.notes.end[i], slot: seq.notes.slot[i], key: seq.notes.key[i], kind: seq.notes.kind[i] }));

describe('channels', () => {
  it('compiles params in engine order with strip and audibility', () => {
    const p = createProject();
    const a = createChannel({ type: 'synth', params: { cutoff: 1234 }, mixer: 2 });
    const b = { ...createChannel({ type: 'drum', mixer: 99 }), solo: true };
    p.channels = [a, b];
    const ca = compileChannel(p, a, 0);
    expect(ca.type).toBe(instrumentIndex('synth'));
    expect(ca.params.length).toBe(INSTRUMENTS.synth.params.length);
    expect(ca.params[INSTRUMENTS.synth.params.findIndex((x) => x.id === 'cutoff')]).toBe(1234);
    expect(ca.gain).toBe(0); // b is soloed
    expect(ca.mixer).toBe(2);
    const cb = compileChannel(p, b, 1);
    expect(cb.gain).toBe(1);
    expect(cb.mixer).toBe(0); // out of range goes to the master
  });
});

describe('mixer', () => {
  it('orders inserts after everything routed into them', () => {
    const p = createProject();
    p.mixer[1] = { ...p.mixer[1], routes: { 3: 1 } };
    p.mixer[3] = { ...p.mixer[3], routes: { 2: 1 } };
    const order = trackOrder(p);
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(3));
    expect(order.indexOf(3)).toBeLessThan(order.indexOf(2));
    expect(order).not.toContain(0);
    expect(order.length).toBe(p.mixer.length - 1);
  });

  it('keeps soloed inserts, what feeds them and what they feed audible', () => {
    const p = createProject();
    p.mixer[1] = { ...p.mixer[1], routes: { 3: 1 } };
    p.mixer[3] = { ...p.mixer[3], routes: { 0: 1 }, solo: true };
    p.mixer[4] = { ...p.mixer[4], routes: { 1: 0 } }; // a zero-gain route still counts
    p.mixer[5] = { ...p.mixer[5], mute: true };
    const g = mixerGains(p);
    expect(g[0]).toBe(1);
    expect(g[1]).toBe(1);
    expect(g[3]).toBe(1);
    expect(g[4]).toBe(1);
    expect(g[2]).toBe(0);
    expect(g[5]).toBe(0);
    p.mixer[3] = { ...p.mixer[3], solo: false };
    expect(mixerGains(p)[2]).toBe(1);
    expect(mixerGains(p)[5]).toBe(0); // mute wins
  });

  it('compiles effect slots in order and isolates an insert for stems', () => {
    const p = createProject();
    p.mixer[1] = { ...p.mixer[1], fx: [createSlot('eq'), { ...createSlot('delay'), on: false, mix: 0.5 }], routes: { 2: 1, 0: 0.5 } };
    const m = compileMixer(p);
    expect(m.tracks[1].fx.map((f) => f.type)).toEqual([effectIndex('eq'), effectIndex('delay')]);
    expect(m.tracks[1].fx[1]).toMatchObject({ on: false, mix: 0.5 });
    expect(m.tracks[1].routes).toEqual([[0, 0.5], [2, 1]]);
    const iso = compileMixer(p, { isolate: 2 });
    // Insert 1 feeds 2, but its direct route to the master bypasses it.
    expect(iso.tracks[1].routes).toEqual([[2, 1]]);
    expect(iso.tracks[1].gain).toBe(1);
    expect(iso.tracks[5].gain).toBe(0);
    expect([...iso.feeds].sort()).toEqual([1, 2]);
    const ch = createChannel({ mixer: 5 });
    expect(compileChannel(p, ch, 0, undefined, { isolate: 2, feeds: iso.feeds }).gain).toBe(0);
  });
});

describe('sequence', () => {
  it('pattern mode: notes sorted, cut at the pattern end', () => {
    const { p, slotOf } = project({ notes: [{ key: 64, pos: STEP * 4, len: STEP }, { key: 60, pos: 0, len: STEP }, { key: 67, pos: BAR - STEP, len: STEP * 3 }] });
    p.patterns[0] = { ...p.patterns[0], length: BAR };
    const seq = compileSequence(p, { mode: 'pattern', slotOf });
    expect(seq.start).toBe(0);
    expect(seq.end).toBe(BAR);
    expect(list(seq)).toEqual([
      { start: 0, end: STEP, slot: 3, key: 60, kind: 0 },
      { start: STEP * 4, end: STEP * 5, slot: 3, key: 64, kind: 0 },
      { start: BAR - STEP, end: BAR, slot: 3, key: 67, kind: 0 },
    ]);
  });

  it('skips channels without a slot and patterns honor an explicit length', () => {
    const { p } = project({ notes: [{ key: 60, pos: 0, len: STEP }] });
    expect(compileSequence(p, { mode: 'pattern', slotOf: () => -1 }).notes.count).toBe(0);
    p.patterns[0] = { ...p.patterns[0], length: BAR * 2 };
    expect(playRange(p, 'pattern', p.patterns[0].id)).toEqual({ start: 0, end: BAR * 2 });
  });

  it('swing delays odd sixteenths and warps note ends', () => {
    expect(swingWarp(0, 1)).toBe(0);
    expect(swingWarp(STEP, 1)).toBe(STEP * 1.5);
    expect(swingWarp(STEP * 2, 1)).toBe(STEP * 2);
    expect(swingWarp(STEP, 0.5)).toBe(STEP * 1.25);
    const { p, slotOf } = project({ notes: [{ key: 60, pos: 0, len: STEP }, { key: 60, pos: STEP, len: STEP }] });
    p.swing = 1;
    const notes = list(compileSequence(p, { mode: 'pattern', slotOf }));
    expect(notes[0]).toMatchObject({ start: 0, end: STEP * 1.5 });
    expect(notes[1]).toMatchObject({ start: STEP * 1.5, end: STEP * 2 });
  });

  it('song mode: clip windows with offsets, cut at the clip end, no repeats', () => {
    const { p, ch, slotOf } = project({ notes: [{ key: 60, pos: 0, len: STEP }, { key: 62, pos: STEP * 4, len: STEP * 8 }, { key: 64, pos: STEP * 12, len: STEP }] });
    const pid = p.patterns[0].id;
    p.clips = [
      { id: 'a', kind: 'pattern', track: 0, start: BAR * 2, len: STEP * 8, offset: STEP * 4, ref: pid, mute: false },
      { id: 'b', kind: 'pattern', track: 1, start: BAR * 4, len: BAR * 2, offset: 0, ref: pid, mute: false },
    ];
    const notes = list(compileSequence(p, { mode: 'song', slotOf }));
    expect(notes).toEqual([
      // Clip a plays steps 4..11: the long note is cut at the clip end; the step-12 note is outside.
      { start: BAR * 2, end: BAR * 2 + STEP * 8, slot: 3, key: 62, kind: 0 },
      { start: BAR * 4, end: BAR * 4 + STEP, slot: 3, key: 60, kind: 0 },
      { start: BAR * 4 + STEP * 4, end: BAR * 4 + STEP * 12, slot: 3, key: 62, kind: 0 },
      { start: BAR * 4 + STEP * 12, end: BAR * 4 + STEP * 13, slot: 3, key: 64, kind: 0 },
    ]);
    void ch;
  });

  it('song mode: track mute and solo, clip mute', () => {
    const { p, slotOf } = project({ notes: [{ key: 60, pos: 0, len: STEP }] });
    const pid = p.patterns[0].id;
    p.clips = [0, 1, 2].map((t) => ({ id: `c${t}`, kind: 'pattern', track: t, start: t * BAR, len: BAR, offset: 0, ref: pid, mute: false }));
    const starts = () => list(compileSequence(p, { mode: 'song', slotOf })).map((n) => n.start);
    expect(starts()).toEqual([0, BAR, BAR * 2]);
    p.tracks[1] = { ...p.tracks[1], mute: true };
    expect(starts()).toEqual([0, BAR * 2]);
    p.tracks[2] = { ...p.tracks[2], solo: true };
    expect(starts()).toEqual([BAR * 2]);
    p.clips[2] = { ...p.clips[2], mute: true };
    expect(starts()).toEqual([]);
  });

  it('song mode: loop range and notes cut at the loop end; audio clips', () => {
    const { p, slotOf } = project({ notes: [{ key: 60, pos: 0, len: BAR }] });
    const pid = p.patterns[0].id;
    p.clips = [{ id: 'a', kind: 'pattern', track: 0, start: 0, len: BAR, offset: 0, ref: pid, mute: false }];
    p.loop = { start: 0, end: PPQ * 2 };
    let seq = compileSequence(p, { mode: 'song', slotOf });
    expect([seq.start, seq.end]).toEqual([0, PPQ * 2]);
    expect(seq.notes.end[0]).toBe(PPQ * 2);
    p.loop = null;
    expect(playRange(p, 'song')).toEqual({ start: 0, end: BAR });
    p.clips.push({ id: 'b', kind: 'pattern', track: 0, start: BAR, len: STEP, offset: 0, ref: pid, mute: false });
    expect(playRange(p, 'song')).toEqual({ start: 0, end: BAR * 2 });

    const audio = createChannel({ type: 'audio', mixer: 2 });
    p.channels.push(audio);
    p.bpm = 120;
    p.clips = [{ id: 'x', kind: 'audio', track: 0, start: BAR, len: BAR, offset: PPQ, ref: audio.id, mute: false }];
    seq = compileSequence(p, { mode: 'song', slotOf: (id) => (id === audio.id ? 7 : -1) });
    expect(list(seq)).toEqual([{ start: BAR, end: BAR * 2, slot: 7, key: 60, kind: 1 }]);
    expect(seq.notes.offset[0]).toBeCloseTo(0.5); // one beat at 120 bpm
    expect(Array.from(seq.audio)).toEqual([0]);
  });

  it('demo song compiles in both modes', () => {
    const p = demoProject();
    const slots = new Map(p.channels.map((c, i) => [c.id, i]));
    const song = compileSequence(p, { mode: 'song', slotOf: (id) => slots.get(id) });
    expect(song.end).toBe(BAR * 8);
    expect(song.notes.count).toBeGreaterThan(100);
    for (let i = 1; i < song.notes.count; i++) expect(song.notes.start[i]).toBeGreaterThanOrEqual(song.notes.start[i - 1]);
    const pat = compileSequence(p, { mode: 'pattern', patternId: p.patterns[0].id, slotOf: (id) => slots.get(id) });
    expect(pat.end).toBe(BAR);
    expect(pat.notes.count).toBe(4 + 2 + 9 + 4);
  });
});

describe('automation', () => {
  function auto(target, points, clip = {}) {
    const { p, ch, slotOf } = project();
    p.mixer[1] = { ...p.mixer[1], fx: [createSlot('filter')] };
    const a = { id: 'a', name: 'A', target: typeof target === 'function' ? target(ch, p) : target, points };
    p.automation = { a };
    p.clips = [{ id: 'c', kind: 'auto', track: 0, start: BAR, len: BAR, offset: 0, ref: 'a', mute: false, ...clip }];
    return { p, ch, slotOf, seq: compileSequence(p, { mode: 'song', slotOf }) };
  }

  it('compiles clips to lanes with absolute point times (clip offset honored)', () => {
    const { seq } = auto({ kind: 'mixer', track: 1, param: 'volume' }, [{ t: 0, v: 0 }, { t: PPQ * 2, v: 1 }], { offset: PPQ });
    expect(seq.auto.length).toBe(1);
    const lane = seq.auto[0];
    expect(lane.target).toEqual({ kind: 'track', track: 1, field: 'volume' });
    expect(lane.segs[0]).toMatchObject({ start: BAR, end: BAR * 2 });
    // Evaluated at songTick - clip.start + offset.
    expect(automationValue(lane.segs[0].pts, BAR)).toBeCloseTo(0.5);
    expect(automationValue(lane.segs[0].pts, BAR + PPQ)).toBe(1);
    expect(automationValue(lane.segs[0].pts, BAR - 1000)).toBe(0);
    expect(fromNorm(lane.def, 1)).toBe(1.25);
  });

  it('resolves channel, strip and effect targets', () => {
    const { seq, p, ch, slotOf } = auto((c) => ({ kind: 'channel', id: c.id, param: 'cutoff' }), [{ t: 0, v: 0.5 }]);
    expect(seq.auto[0].target).toEqual({ kind: 'param', slot: 3, index: INSTRUMENTS.synth.params.findIndex((x) => x.id === 'cutoff') });
    expect(seq.auto[0].def.curve).toBe('log');
    expect(resolveTarget(p, { kind: 'channel', id: ch.id, param: 'pan' }, slotOf).target).toEqual({ kind: 'strip', slot: 3, field: 'pan' });
    const slotId = p.mixer[1].fx[0].id;
    expect(resolveTarget(p, { kind: 'fx', track: 1, slot: slotId, param: 'cutoff' }, slotOf).target).toEqual({ kind: 'fx', track: 1, fx: 0, index: 1 });
    expect(resolveTarget(p, { kind: 'fx', track: 1, slot: slotId, param: 'mix' }, slotOf).target).toEqual({ kind: 'mix', track: 1, fx: 0 });
    expect(resolveTarget(p, { kind: 'fx', track: 1, slot: 'gone', param: 'cutoff' }, slotOf)).toBe(null);
    expect(resolveTarget(p, { kind: 'tempo' }, slotOf)).toBe(null);
  });

  it('skips muted clips and pattern mode', () => {
    expect(auto({ kind: 'mixer', track: 1, param: 'pan' }, [{ t: 0, v: 0 }], { mute: true }).seq.auto).toEqual([]);
    const { p, slotOf } = auto({ kind: 'mixer', track: 1, param: 'pan' }, [{ t: 0, v: 0 }]);
    expect(compileSequence(p, { mode: 'pattern', slotOf }).auto).toEqual([]);
  });

  it('evaluates exactly like the playlist automation helpers', async () => {
    const { evaluateAutomation } = await import('../src/automation/evaluate.js');
    const points = [{ t: 0, v: 0.2 }, { t: 50, v: 0.9 }, { t: 50, v: 0.1 }, { t: 300, v: 0.6 }];
    const pts = Float64Array.from(points.flatMap((p) => [p.t, p.v]));
    for (let t = -20; t < 340; t += 7) expect(automationValue(pts, t)).toBeCloseTo(evaluateAutomation(points, t), 12);
  });

  it('interpolates linearly and holds the ends', () => {
    const pts = Float64Array.from([10, 0, 20, 1, 40, 0]);
    expect(automationValue(pts, 0)).toBe(0);
    expect(automationValue(pts, 15)).toBeCloseTo(0.5);
    expect(automationValue(pts, 30)).toBeCloseTo(0.5);
    expect(automationValue(pts, 99)).toBe(0);
  });
});

void createPattern;
