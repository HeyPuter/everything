import { describe, expect, it } from 'vitest';
import type { SkEntity } from '../src/model/types';
import { buildProfiles, inRegion } from '../src/sketch/profiles';
import { circle, polygon, rect } from './helpers';

const area = (r: { outer: { area: number }; holes: { area: number }[] }) => r.outer.area + r.holes.reduce((s, h) => s + h.area, 0);

describe('sketch profiles', () => {
  it('finds a single rectangle region', () => {
    const p = buildProfiles(rect(0, 0, 10, 5));
    expect(p.regions).toHaveLength(1);
    expect(p.regions[0].outer.area).toBeCloseTo(50, 9);
    expect(p.regions[0].outer.segs.every((s) => s.src)).toBe(true);
  });

  it('treats nested loops with even-odd material', () => {
    const p = buildProfiles([...rect(-10, -10, 10, 10), ...circle(0, 0, 5), ...circle(0, 0, 2)]);
    // Square with a hole, plus the inner disc.
    expect(p.regions).toHaveLength(2);
    const total = p.regions.reduce((s, r) => s + area(r), 0);
    expect(total).toBeCloseTo(400 - Math.PI * 25 + Math.PI * 4, 0);
  });

  it('keeps both halves of a rectangle split by a line', () => {
    const ents: SkEntity[] = [
      { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 10, y: 0 }, { id: 'c', t: 'point', x: 10, y: 4 }, { id: 'd', t: 'point', x: 0, y: 4 },
      { id: 'm1', t: 'point', x: 5, y: 0 }, { id: 'm2', t: 'point', x: 5, y: 4 },
      { id: 'l1', t: 'line', a: 'a', b: 'm1' }, { id: 'l2', t: 'line', a: 'm1', b: 'b' }, { id: 'l3', t: 'line', a: 'b', b: 'c' },
      { id: 'l4', t: 'line', a: 'c', b: 'm2' }, { id: 'l5', t: 'line', a: 'm2', b: 'd' }, { id: 'l6', t: 'line', a: 'd', b: 'a' },
      { id: 'mid', t: 'line', a: 'm1', b: 'm2' },
    ];
    const p = buildProfiles(ents);
    expect(p.regions).toHaveLength(2);
    expect(p.regions.map((r) => r.outer.area).sort()).toEqual([20, 20]);
  });

  it('ignores construction geometry and dangling lines', () => {
    const ents: SkEntity[] = [
      ...rect(0, 0, 4, 4),
      { id: 'x1', t: 'point', x: 4, y: 4 }, { id: 'x2', t: 'point', x: 8, y: 8 }, { id: 'tail', t: 'line', a: 'x1', b: 'x2' },
      { id: 'c1', t: 'point', x: -5, y: -5 }, { id: 'c2', t: 'point', x: 9, y: 9 }, { id: 'cl', t: 'line', a: 'c1', b: 'c2', construction: true },
    ];
    const p = buildProfiles(ents);
    expect(p.regions).toHaveLength(1);
    expect(p.regions[0].outer.area).toBeCloseTo(16, 9);
  });

  it('reports open contours', () => {
    const ents: SkEntity[] = [{ id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 3, y: 0 }, { id: 'l', t: 'line', a: 'a', b: 'b' }];
    const p = buildProfiles(ents);
    expect(p.regions).toHaveLength(0);
    expect(p.openEnds.length).toBe(2);
  });

  it('builds regions from arcs and lines (a D shape)', () => {
    const ents: SkEntity[] = [
      { id: 'c', t: 'point', x: 0, y: 0 }, { id: 'a', t: 'point', x: 0, y: -5 }, { id: 'b', t: 'point', x: 0, y: 5 },
      { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'b' }, { id: 'l', t: 'line', a: 'b', b: 'a' },
    ];
    const p = buildProfiles(ents);
    expect(p.regions).toHaveLength(1);
    expect(p.regions[0].outer.area).toBeCloseTo((Math.PI * 25) / 2, 1);
  });

  it('picks regions by sample point', () => {
    const p = buildProfiles([...rect(-10, -10, 10, 10), ...circle(0, 0, 5)], [[0, 0]]);
    expect(p.regions).toHaveLength(1);
    expect(p.regions[0].outer.area).toBeCloseTo(Math.PI * 25, 0);
    expect(inRegion([0, 0], p.regions[0])).toBe(true);
  });

  it('handles a closed polygon with many sides', () => {
    const pts: [number, number][] = Array.from({ length: 12 }, (_, i) => [Math.cos((i / 12) * 2 * Math.PI) * 10, Math.sin((i / 12) * 2 * Math.PI) * 10]);
    const p = buildProfiles(polygon(pts));
    expect(p.regions).toHaveLength(1);
    expect(p.regions[0].outer.area).toBeCloseTo(300, 6);
  });
});


describe('closed spline profiles', () => {
  const loop = (clockwise: boolean): SkEntity[] => {
    const ids = ['a', 'b', 'c', 'd', 'a'];
    return [
      { id: 'a', t: 'point', x: -5, y: -5 },
      { id: 'b', t: 'point', x: 5, y: -5 },
      { id: 'c', t: 'point', x: 5, y: 5 },
      { id: 'd', t: 'point', x: -5, y: 5 },
      { id: 's', t: 'spline', pts: clockwise ? ids.reverse() : ids },
    ];
  };

  it.each([false, true])('keeps an inner circle as a hole regardless of spline direction (clockwise=%s)', (clockwise) => {
    const p = buildProfiles([...loop(clockwise), ...circle(0, 0, 2)]);
    expect(p.regions).toHaveLength(1);
    expect(p.regions[0].outer.area).toBeGreaterThan(100);
    expect(p.regions[0].holes).toHaveLength(1);
    expect(inRegion([0, 0], p.regions[0])).toBe(false);
    expect(inRegion([3, 0], p.regions[0])).toBe(true);
  });

  it.each([false, true])('keeps a spline inside a rectangle as a hole (clockwise=%s)', (clockwise) => {
    const p = buildProfiles([...rect(-10, -10, 10, 10), ...loop(clockwise)]);
    expect(p.regions).toHaveLength(1);
    expect(p.regions[0].holes).toHaveLength(1);
    expect(p.regions[0].holes[0].area).toBeLessThan(-100);
    expect(inRegion([0, 0], p.regions[0])).toBe(false);
  });
});
