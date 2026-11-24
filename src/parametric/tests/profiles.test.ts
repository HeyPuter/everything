import { describe, expect, it } from 'vitest';
import type { SkEntity } from '../src/model/types';
import { buildProfiles, hasOverlappingLines, holesMayTouch, inRegion } from '../src/sketch/profiles';
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

  it('closes a contour whose ends lie on another curve (a T junction)', () => {
    const P = (id: string, x: number, y: number): SkEntity => ({ id, t: 'point', x, y });
    const L = (id: string, a: string, b: string): SkEntity => ({ id, t: 'line', a, b });
    // A U standing on a longer line: its ends were pruned as open.
    const u = buildProfiles([
      P('a', 0, 0), P('b', 30, 0), L('base', 'a', 'b'),
      P('u1', 5, 0), P('u2', 5, 10), P('u3', 15, 10), P('u4', 15, 0),
      L('l1', 'u1', 'u2'), L('l2', 'u2', 'u3'), L('l3', 'u3', 'u4'),
    ]);
    expect(u.regions).toHaveLength(1);
    expect(u.regions[0].outer.area).toBeCloseTo(100, 9);
    expect(u.regions[0].outer.segs.map((s) => s.src).sort()).toEqual(['base', 'l1', 'l2', 'l3']);
    // The base's tails beyond the U stay open.
    expect(u.openEnds).toHaveLength(2);
    // On an arc: a semicircle closed by a line longer than its chord.
    const d = buildProfiles([
      P('c', 0, 0), P('e0', 5, 0), P('e1', -5, 0), { id: 'arc', t: 'arc', c: 'c', a: 'e0', b: 'e1' },
      P('l0', -10, 0), P('l1', 10, 0), L('chord', 'l0', 'l1'),
    ]);
    expect(d.regions).toHaveLength(1);
    expect(d.regions[0].outer.area).toBeCloseTo((Math.PI * 25) / 2, 1);
    // A dangling line ending on an edge does not split the edge.
    const tail = buildProfiles([
      ...rect(0, 0, 20, 20, 't'), P('t1', 10, 0), P('t2', 10, -5), L('tl', 't1', 't2'),
    ]);
    expect(tail.regions).toHaveLength(1);
    expect(tail.regions[0].outer.segs).toHaveLength(4);
  });

  it('counts a curve drawn twice once', () => {
    // Two rectangles sharing a side, and a rectangle drawn over itself.
    for (const [ents, areas] of [
      [[...rect(0, 0, 10, 10), ...rect(10, 0, 20, 10)], [100, 100]],
      [[...rect(0, 0, 10, 10), ...rect(0, 0, 10, 10)], [100]],
    ] as [SkEntity[], number[]][]) {
      const p = buildProfiles(ents);
      const found = p.regions.map((r) => r.outer.area).sort((a, b) => a - b);
      expect(found).toEqual(areas.map((a) => expect.closeTo(a, 9)));
      expect(p.openEnds).toHaveLength(0);
    }
  });

  it('tells lines that lie over each other in part from lines that only meet', () => {
    // A square in the corner of a larger one, untrimmed: no faces can be found.
    const corner = [...rect(0, 0, 20, 20), ...rect(0, 0, 5, 5)];
    expect(buildProfiles(corner).regions).toHaveLength(0);
    expect(hasOverlappingLines(corner)).toBe(true);
    expect(hasOverlappingLines([...rect(0, 0, 10, 10), ...rect(10, 0, 20, 10)])).toBe(true);
    // End to end along one line, or crossing: no overlap.
    expect(hasOverlappingLines([...rect(0, 0, 10, 10), ...rect(10, 0, 20, 10, 'x').filter((e) => e.id !== 'xl3')])).toBe(false);
    expect(hasOverlappingLines(polygon([[0, 0], [10, 0], [10, 10], [0, 10]]).concat(polygon([[5, -5], [15, 5], [5, 15]])))).toBe(false);
  });

  it('tells holes that may touch their outline or each other from holes well inside', () => {
    const touch = (ents: SkEntity[]) => holesMayTouch(buildProfiles(ents).regions[0]);
    expect(touch([...rect(0, 0, 20, 20), ...circle(10, 3, 3)])).toBe(true);
    expect(touch([...rect(-20, -10, 20, 10), ...circle(-3, 0, 3), ...circle(3, 0, 3)])).toBe(true);
    expect(touch([...rect(0, 0, 20, 20), ...circle(10, 10, 3), ...circle(3, 3, 1)])).toBe(false);
    expect(touch(rect(0, 0, 20, 20))).toBe(false);
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
    // Beyond the corner: a point on the bottom edge would close the box as a T junction.
    entities.push({ id: 'close', t: 'point', x: -0.1e-6 - gap, y: 0 });
    const closing = entities.find((e) => e.id === 'boxl3');
    if (closing?.t !== 'line') throw new Error('Missing closing edge');
    closing.b = 'close';
    const p = buildProfiles(entities);
    expect(p.regions).toHaveLength(gap < 1e-6 ? 1 : 0);
  });
});
