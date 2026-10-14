import { describe, it, expect } from 'vitest';
import { gainToPos, posToGain, dbToPos, posToDb, formatGain, nudgeDb, parseGain, ticksFor, TICKS, MAX_GAIN, MAX_DB, FLOOR_DB } from '../src/mixer/db.js';
import * as R from '../src/mixer/routing.js';
import * as S from '../src/mixer/slots.js';
import { MeterState, HOLD_S } from '../src/mixer/meters.js';
import * as E from '../src/model/edits.js';
import { createProject, createChannel } from '../src/model/project.js';
import { demoProject } from '../src/model/demo.js';

describe('fader law', () => {
  it('round trips gain, position and dB', () => {
    for (const g of [0.001, 0.05, 0.25, 0.5, 0.8, 1, 1.1, MAX_GAIN]) {
      expect(posToGain(gainToPos(g))).toBeCloseTo(g, 9);
    }
    for (const p of [0, 0.1, 0.33, 0.5, 0.9, 1]) expect(gainToPos(posToGain(p))).toBeCloseTo(p, 9);
    for (const db of [-60, -24, -6, 0, 1.5]) expect(posToDb(dbToPos(db))).toBeCloseTo(db, 9);
  });

  it('maps the ends and unity sensibly', () => {
    expect(gainToPos(0)).toBe(0);
    expect(gainToPos(MAX_GAIN)).toBe(1);
    expect(gainToPos(5)).toBe(1);
    expect(MAX_DB).toBeCloseTo(1.938, 3);
    const unity = gainToPos(1);
    expect(unity).toBeGreaterThan(0.85);
    expect(unity).toBeLessThan(0.97);
    expect(posToDb(0)).toBe(-Infinity);
    // Monotonic.
    let last = -1;
    for (let p = 0; p <= 1; p += 0.01) {
      const g = posToGain(p);
      expect(g).toBeGreaterThanOrEqual(last);
      last = g;
    }
  });

  it('formats and parses dB', () => {
    expect(formatGain(1)).toBe('0.0 dB');
    expect(formatGain(0)).toBe('-inf dB');
    expect(formatGain(0.5)).toBe('-6.0 dB');
    expect(formatGain(MAX_GAIN)).toBe('+1.9 dB');
    expect(formatGain(0.99999)).toBe('0.0 dB');
    expect(parseGain('-6')).toBeCloseTo(0.501, 3);
    expect(parseGain('0 dB')).toBe(1);
    expect(parseGain('-inf')).toBe(0);
    expect(parseGain('+12')).toBe(MAX_GAIN);
    expect(parseGain('loud')).toBeNull();
  });

  it('nudges in dB steps with a floor at silence', () => {
    expect(formatGain(nudgeDb(1, -0.5))).toBe('-0.5 dB');
    expect(nudgeDb(1, 10)).toBeCloseTo(MAX_GAIN, 9);
    expect(nudgeDb(0, 1)).toBeCloseTo(10 ** (FLOOR_DB / 20), 9);
    expect(nudgeDb(10 ** (FLOOR_DB / 20), -1)).toBe(0);
    expect(nudgeDb(0, -1)).toBe(0);
  });

  it('picks scale ticks that fit the fader height', () => {
    const tall = ticksFor(400);
    expect(tall.length).toBe(TICKS.length);
    const short = ticksFor(90);
    expect(short.length).toBeLessThan(tall.length);
    expect(short.map((t) => t.label)).toContain('0');
    expect(short.map((t) => t.label)).toContain('-inf');
    // Sorted top to bottom and never closer than the gap.
    for (let i = 1; i < short.length; i++) {
      expect(short[i - 1].pos).toBeGreaterThan(short[i].pos);
      expect((short[i - 1].pos - short[i].pos) * 90).toBeGreaterThanOrEqual(12);
    }
  });
});

describe('routing', () => {
  const project = () => demoProject();

  it('lists the channels feeding each insert', () => {
    const p = project();
    expect(R.channelsFeeding(p, 3).map((c) => c.name)).toEqual(['Closed Hat', 'Open Hat']);
    const map = R.channelInputs(p);
    expect(map.get(1).map((c) => c.name)).toEqual(['Kick']);
    expect(map.get(7)).toBeUndefined();
  });

  it('refuses feedback loops with an explanation', () => {
    let p = project();
    p = E.setRoute(p, 1, 7, 1); // 1 -> 7
    p = E.setRoute(p, 7, 8, 1); // 7 -> 8
    const r = R.canRoute(p, 8, 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/feedback loop/);
    expect(R.toggleRoute(p, 8, 1)).toBe(p);
    expect(R.canRoute(p, 0, 3).ok).toBe(false);
    expect(R.canRoute(p, 3, 3).ok).toBe(false);
    expect(R.canRoute(p, 8, 2).ok).toBe(true);
  });

  it('toggles sends and reports sources and sends', () => {
    let p = project();
    p = R.toggleRoute(p, 2, 9);
    expect(p.mixer[2].routes).toEqual({ 0: 1, 9: 1 });
    expect(R.sourcesOf(p, 9)).toEqual([{ index: 2, gain: 1 }]);
    expect(R.sendsOf(p, 2).map((s) => s.index)).toEqual([0, 9]);
    p = R.setRouteGain(p, 2, 9, 0.5);
    expect(p.mixer[2].routes[9]).toBe(0.5);
    p = R.toggleRoute(p, 2, 9);
    expect(p.mixer[2].routes).toEqual({ 0: 1 });
    p = R.toggleRoute(R.toggleRoute(p, 2, 9), 2, 10);
    p = R.routeMasterOnly(p, 2);
    expect(p.mixer[2].routes).toEqual({ 0: 1 });
    expect(R.routeMasterOnly(p, 2)).toBe(p);
  });

  it('moves channel inputs and routes selected channels', () => {
    let p = project();
    p = R.moveChannelInputs(p, 3, 8);
    expect(R.channelsFeeding(p, 3)).toHaveLength(0);
    expect(R.channelsFeeding(p, 8).map((c) => c.name)).toEqual(['Closed Hat', 'Open Hat']);
    const kick = p.channels[0].id;
    p = R.routeChannels(p, [kick], 12);
    expect(p.channels[0].mixer).toBe(12);
  });

  it('solos with routing awareness', () => {
    let p = project();
    p = E.setRoute(p, 1, 9, 1); // kick also feeds a bus on 9
    p = R.soloInsert(p, 9);
    expect(p.mixer[9].solo).toBe(true);
    expect(R.mixerAudible(p, 9)).toBe(true);
    expect(R.mixerAudible(p, 1)).toBe(true); // feeds the soloed bus
    expect(R.mixerAudible(p, 2)).toBe(false);
    expect(R.mixerAudible(p, 0)).toBe(true);
    // Soloing the same insert again clears solo.
    p = R.soloInsert(p, 9);
    expect(p.mixer.some((t) => t.solo)).toBe(false);
    p = R.soloInsert(R.soloInsert(p, 2), 3, { add: true });
    expect([p.mixer[2].solo, p.mixer[3].solo]).toEqual([true, true]);
    p = E.updateMixerTrack(p, 2, { mute: true });
    expect(R.mixerAudible(p, 2)).toBe(false);
  });

  it('labels tracks', () => {
    const p = createProject();
    expect(R.trackLabel(p, 0)).toBe('Master');
    expect(R.trackLabel(p, 4)).toBe('Insert 4');
    expect(R.trackLabel(E.updateMixerTrack(p, 4, { name: 'Bus' }), 4)).toBe('4 Bus');
  });
});

describe('effect slots', () => {
  const withSlots = () => {
    let p = createProject({ channels: [createChannel()] });
    for (const t of ['eq', 'compressor', 'delay', 'reverb']) p = S.addEffect(p, 1, t).project;
    return p;
  };

  it('reorders with move and nudge', () => {
    let p = withSlots();
    const ids = p.mixer[1].fx.map((s) => s.id);
    p = E.moveSlot(p, 1, ids[0], 3);
    expect(p.mixer[1].fx.map((s) => s.type)).toEqual(['compressor', 'delay', 'reverb', 'eq']);
    p = S.nudgeSlot(p, 1, ids[0], -1);
    expect(p.mixer[1].fx.map((s) => s.type)).toEqual(['compressor', 'delay', 'eq', 'reverb']);
    expect(S.nudgeSlot(p, 1, ids[1], -1)).toBe(p); // already first
  });

  it('computes drop indices from row midpoints', () => {
    const mids = [10, 30, 50, 70];
    expect(S.dropIndex(mids, 0, 2)).toBe(0);
    expect(S.dropIndex(mids, 40, 0)).toBe(1);
    expect(S.dropIndex(mids, 45, 2)).toBe(2);
    expect(S.dropIndex(mids, 100, 0)).toBe(3);
    expect(S.dropIndex(mids, 60, 3)).toBe(3);
    expect(S.dropIndex(mids, 20, 3)).toBe(1);
  });

  it('replaces, duplicates, resets and clears', () => {
    let p = withSlots();
    const first = p.mixer[1].fx[0];
    p = E.updateSlot(p, 1, first.id, { on: false, mix: 0.4 });
    const r = S.replaceEffect(p, 1, first.id, 'filter');
    expect(r.project.mixer[1].fx[0]).toMatchObject({ type: 'filter', on: false, mix: 0.4 });
    p = r.project;
    const d = S.duplicateSlot(p, 1, r.id);
    expect(d.project.mixer[1].fx[1].type).toBe('filter');
    expect(d.project.mixer[1].fx[1].id).not.toBe(r.id);
    p = E.setSlotParam(d.project, 1, r.id, 'cutoff', 500);
    p = S.resetSlot(p, 1, r.id);
    expect(S.slotById(p, 1, r.id).params.cutoff).toBe(2000);
    p = S.clearEffects(p, 1);
    expect(p.mixer[1].fx).toEqual([]);
  });

  it('refuses an eleventh effect', () => {
    let p = withSlots();
    for (let i = 0; i < 6; i++) p = S.addEffect(p, 1, 'chorus').project;
    expect(p.mixer[1].fx).toHaveLength(S.MAX_FX_SLOTS);
    expect(S.addEffect(p, 1, 'eq').id).toBeNull();
    expect(S.addEffect(p, 1, 'nope').id).toBeNull();
  });
});

describe('meter ballistics', () => {
  it('attacks instantly, falls smoothly, holds peaks and latches clips', () => {
    const m = new MeterState(2);
    const input = new Float32Array(4);
    input[2] = 0.5;
    expect(m.update(input, 1 / 60)).toBe(true);
    expect(m.level[2]).toBeCloseTo(-6.02, 1);
    input[2] = 0;
    m.update(input, 0.5);
    expect(m.level[2]).toBeCloseTo(-18.02, 1); // 24 dB/s fall
    expect(m.peak[2]).toBeCloseTo(-6.02, 1); // still held
    m.update(input, HOLD_S);
    m.update(input, 0.1);
    expect(m.peak[2]).toBeLessThan(-6.1);
    input[3] = 1.2;
    m.update(input, 1 / 60);
    expect(m.clip[3]).toBe(1);
    m.resetClip(1);
    expect(m.clip[3]).toBe(0);
  });

  it('drops held peaks at once with reduced motion', () => {
    const m = new MeterState(1);
    const input = new Float32Array([0.5, 0.5]);
    m.update(input, 0.016, true);
    input.fill(0);
    m.update(input, HOLD_S + 0.1, true);
    m.update(input, 0.016, true);
    expect(m.peak[0]).toBeCloseTo(m.level[0], 5);
  });

  it('resizes keeping values and goes idle at silence', () => {
    const m = new MeterState(1);
    expect(m.idle()).toBe(true);
    m.update(new Float32Array([0.3, 0.3]), 0.016);
    m.resize(3);
    expect(m.level.length).toBe(6);
    expect(m.level[0]).toBeGreaterThan(-20);
    expect(m.level[5]).toBeLessThan(-100);
    expect(m.idle()).toBe(false);
  });
});
