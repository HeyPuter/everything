import { describe, it, expect } from 'vitest';
import { evaluateAutomation, clipLocalTime, clipValueAt } from '../src/automation/evaluate.js';
import { addPoint, movePoint, removePoint, flatLine, normalizePoints, hitPoint, automationLength } from '../src/automation/points.js';
import { resolveTarget, listTargets, sameTarget, MIXER_PARAMS } from '../src/automation/targets.js';
import { demoProject } from '../src/model/demo.js';
import { PPQ } from '../src/model/time.js';

const pts = [
  { t: 0, v: 0 },
  { t: 100, v: 1 },
  { t: 200, v: 0.5 },
];

describe('evaluateAutomation', () => {
  it('interpolates linearly between points', () => {
    expect(evaluateAutomation(pts, 50)).toBeCloseTo(0.5);
    expect(evaluateAutomation(pts, 150)).toBeCloseTo(0.75);
    expect(evaluateAutomation(pts, 100)).toBe(1);
  });
  it('holds before the first and after the last point', () => {
    const late = [{ t: 50, v: 0.3 }, { t: 60, v: 0.9 }];
    expect(evaluateAutomation(late, 0)).toBe(0.3);
    expect(evaluateAutomation(late, 1000)).toBe(0.9);
  });
  it('handles empty, single and coincident points', () => {
    expect(evaluateAutomation([], 10)).toBeNull();
    expect(evaluateAutomation(undefined, 10)).toBeNull();
    expect(evaluateAutomation([{ t: 10, v: 0.2 }], 0)).toBe(0.2);
    const step = [{ t: 0, v: 0 }, { t: 50, v: 0 }, { t: 50, v: 1 }, { t: 100, v: 1 }];
    expect(evaluateAutomation(step, 49)).toBe(0);
    expect(evaluateAutomation(step, 51)).toBe(1);
  });
  it('finds the right segment in long curves', () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ t: i * 10, v: i % 2 }));
    expect(evaluateAutomation(many, 5)).toBeCloseTo(0.5);
    expect(evaluateAutomation(many, 9995)).toBe(1);
    expect(evaluateAutomation(many, 4322)).toBeCloseTo(0.2);
    expect(evaluateAutomation(many, 4332)).toBeCloseTo(0.8);
  });
  it('maps song time through the clip window', () => {
    const clip = { start: 1000, len: 200, offset: 50, mute: false };
    expect(clipLocalTime(clip, 1000)).toBe(50);
    const auto = { points: pts };
    expect(clipValueAt(clip, auto, 1000)).toBeCloseTo(0.5);
    expect(clipValueAt(clip, auto, 999)).toBeNull();
    expect(clipValueAt(clip, auto, 1200)).toBeNull();
    expect(clipValueAt({ ...clip, mute: true }, auto, 1100)).toBeNull();
  });
});

describe('automation points', () => {
  it('adds points in time order', () => {
    const r = addPoint(pts, { t: 150, v: 2 });
    expect(r.index).toBe(2);
    expect(r.points.map((p) => p.t)).toEqual([0, 100, 150, 200]);
    expect(r.points[2].v).toBe(1);
    expect(pts).toHaveLength(3);
    expect(addPoint([], { t: 5, v: 0.1 }).index).toBe(0);
  });
  it('moves points between their neighbours and clamps values', () => {
    const a = movePoint(pts, 1, { t: 500, v: -1 });
    expect(a[1]).toEqual({ t: 200, v: 0 });
    const b = movePoint(pts, 1, { t: -50 });
    expect(b[1].t).toBe(0);
    expect(movePoint(pts, 1, { t: 100, v: 1 })).toBe(pts);
  });
  it('removes points but keeps the last one', () => {
    expect(removePoint(pts, 1).map((p) => p.t)).toEqual([0, 200]);
    const one = [{ t: 0, v: 0.5 }];
    expect(removePoint(one, 0)).toBe(one);
  });
  it('builds flat lines and normalizes lists', () => {
    expect(flatLine(0.4, 384)).toEqual([{ t: 0, v: 0.4 }, { t: 384, v: 0.4 }]);
    expect(normalizePoints([{ t: 10.4, v: 3 }, { t: -2, v: 0.5 }])).toEqual([{ t: 0, v: 0.5 }, { t: 10, v: 1 }]);
  });
  it('hit-tests points in pixel space', () => {
    const toX = (t) => t;
    const toY = (v) => 100 - v * 100;
    expect(hitPoint(pts, toX, toY, 102, 2)).toBe(1);
    expect(hitPoint(pts, toX, toY, 150, 50)).toBe(-1);
  });
  it('measures automation length in whole bars', () => {
    expect(automationLength({ points: [{ t: 0, v: 0 }] })).toBe(PPQ * 4);
    expect(automationLength({ points: [{ t: 0, v: 0 }, { t: PPQ * 5, v: 1 }] })).toBe(PPQ * 8);
  });
});

describe('automation targets', () => {
  const p = demoProject();
  it('resolves channel, instrument, mixer and effect targets', () => {
    const bass = p.channels.find((c) => c.name === 'Bass');
    const vol = resolveTarget(p, { kind: 'channel', id: bass.id, param: 'volume' });
    expect(vol.value).toBe(bass.volume);
    expect(vol.norm).toBeCloseTo(bass.volume / 1.25);
    const cutoff = resolveTarget(p, { kind: 'channel', id: bass.id, param: 'cutoff' });
    expect(cutoff.def.curve).toBe('log');
    expect(cutoff.norm).toBeGreaterThan(0);
    const mix = resolveTarget(p, { kind: 'mixer', track: 1, param: 'volume' });
    expect(mix.def).toBe(MIXER_PARAMS.volume);
    expect(mix.norm).toBeCloseTo(0.8 / 1.25);
    const slot = p.mixer[5].fx[0];
    const wet = resolveTarget(p, { kind: 'fx', track: 5, slot: slot.id, param: 'wet' });
    expect(wet.value).toBe(0.3);
    expect(resolveTarget(p, { kind: 'fx', track: 5, slot: 0, param: 'wet' }).value).toBe(0.3);
    expect(resolveTarget(p, { kind: 'channel', id: 'gone', param: 'volume' })).toBeNull();
    expect(resolveTarget(p, { kind: 'tempo' }).value).toBe(124);
  });
  it('lists targets for every channel and used insert', () => {
    const groups = listTargets(p);
    expect(groups.filter((g) => g.label.startsWith('Channel:'))).toHaveLength(p.channels.length);
    expect(groups.some((g) => g.label === 'Mixer: Master')).toBe(true);
    for (const g of groups) for (const it of g.items) expect(resolveTarget(p, it.target)).not.toBeNull();
  });
  it('compares targets', () => {
    expect(sameTarget({ kind: 'mixer', track: 1, param: 'pan' }, { kind: 'mixer', track: 1, param: 'pan' })).toBe(true);
    expect(sameTarget({ kind: 'mixer', track: 1, param: 'pan' }, { kind: 'mixer', track: 2, param: 'pan' })).toBe(false);
  });
});
