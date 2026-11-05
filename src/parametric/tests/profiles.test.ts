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

  it.each([
    ['two circles', circle(0, 0, 10, 'A'), [[12, 0], [-12, 0], [0, 12], [0, -12], [-8, 0], [8, 0]], 5],
    ['a circle over a rectangle', rect(-20, -10, 20, 10, 'r'), [[20, 0], [-20, 0], [0, 10], [0, -10]], 5],
  ] as const)('treats contours that cross (%s) the same wherever they cross', (_, base, centres, r) => {
    for (const [x, y] of centres) {
      const p = buildProfiles([...base, ...circle(x, y, r, 'B')] as SkEntity[]);
      expect(p.crossing).toBe(true);
      // Never a hole crossing its outer boundary; each contour is a region of its own.
      expect(p.regions).toHaveLength(2);
      expect(p.regions.every((g) => g.holes.length === 0)).toBe(true);
    }
  });

  it('keeps holes that only touch their outline, and does not call that crossing', () => {
    for (const ents of [[...circle(0, 0, 1000, 'A'), ...circle(999, 0, 1, 'B')], [...rect(-20, -10, 20, 10, 'r'), ...circle(0, 5, 5, 'B')]]) {
      const p = buildProfiles(ents as SkEntity[]);
      expect(p.crossing).toBe(false);
      expect(p.regions).toHaveLength(1);
      expect(p.regions[0].holes).toHaveLength(1);
    }
    // Faces sharing an edge (a rectangle split by a line) do not cross either.
    const split = buildProfiles([...rect(0, 0, 10, 10, 's'), { id: 'm0', t: 'point', x: 5, y: 0 }, { id: 'm1', t: 'point', x: 5, y: 10 }, { id: 'm', t: 'line', a: 'm0', b: 'm1' }] as SkEntity[]);
    expect(split.crossing).toBe(false);
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

it.each([0.5, 1, 1.1, 1.5, 2, 5])('preserves a %s mm closed profile translated far from the sketch origin', (side) => {
  const p = buildProfiles(rect(100_000_000, 100_000_000, 100_000_000 + side, 100_000_000 + side));
  expect(p.regions).toHaveLength(1);
  expect(p.regions[0].outer.area).toBeCloseTo(side * side, 6);
});

it('keeps nested material and holes when the entire profile is translated', () => {
  for (const origin of [0, -100_000_000, 100_000_000]) {
    const p = buildProfiles([
      ...rect(origin, origin, origin + 5, origin + 5),
      ...rect(origin + 2, origin + 2, origin + 2.5, origin + 2.5),
    ]);
    expect(p.regions).toHaveLength(1);
    expect(p.regions[0].holes).toHaveLength(1);
    expect(area(p.regions[0])).toBeCloseTo(24.75, 8);
  }
});

describe('large sketch profile graphs', () => {
  it('prunes a long centre-out chain attached to a closed profile', () => {
    const count = 6000;
    const entities: SkEntity[] = [...rect(-2, -2, -1, -1, 'box')];
    for (let i = 0; i <= count; i++) entities.push({ id: `p${i}`, t: 'point', x: i, y: 0 });
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => Math.abs(a - count / 2) - Math.abs(b - count / 2));
    for (const i of order) entities.push({ id: `l${i}`, t: 'line', a: `p${i}`, b: `p${i + 1}` });
    entities.push({ id: 'attachment', t: 'line', a: 'boxp2', b: 'p0' });
    const p = buildProfiles(entities);
    expect(p.regions).toHaveLength(1);
    expect(p.regions[0].outer.area).toBe(1);
    expect(p.openEnds).toHaveLength(count + 1);
    expect(new Set(p.openEnds.map((p) => p.join(','))).size).toBe(count + 1);
  });

  it.each([0.5e-6, 5e-6])('welds only endpoints within tolerance across spatial cells (%s)', (gap) => {
    const entities: SkEntity[] = [];
    // Enough unrelated vertices to exercise the spatial index. The whole
    // sketch remains under 100 mm wide, so its merge tolerance is 1e-6 mm.
    for (let i = 0; i < 40; i++) entities.push(
      { id: `a${i}`, t: 'point', x: -50 + i, y: -10 },
      { id: `b${i}`, t: 'point', x: -50 + i, y: -9 },
      { id: `l${i}`, t: 'line', a: `a${i}`, b: `b${i}` },
    );
    entities.push(...rect(-0.1e-6, 0, 2, 2, 'box'));
    entities.push({ id: 'close', t: 'point', x: -0.1e-6 + gap, y: 0 });
    const closing = entities.find((e) => e.id === 'boxl3');
    if (closing?.t !== 'line') throw new Error('Missing closing edge');
    closing.b = 'close';
    const p = buildProfiles(entities);
    expect(p.regions).toHaveLength(gap < 1e-6 ? 1 : 0);
  });
});
