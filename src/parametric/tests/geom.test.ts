import { expect, it } from 'vitest';
import type { Vec2 } from '../src/math/vec';
import { circumcenter, intersectPrims, type Prim } from '../src/sketch/geom';

for (const offset of [[0, 0], [1e6, -2e6], [1e9, 1e9], [1e10, -1e10]] as Vec2[]) {
  it.each([5, 0.01])(`keeps a circle of radius %s accurate around ${offset}`, (r) => {
    const center: Vec2 = [offset[0] + 0.25, offset[1] - 0.75];
    const points: Vec2[] = [[center[0] + r, center[1]], [center[0] - 0.6 * r, center[1] + 0.8 * r], [center[0], center[1] - r]];
    const tolerance = Math.max(1e-12, Math.max(...center.map(Math.abs)) * Number.EPSILON * 8);
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const result = circumcenter(points[order[0]], points[order[1]], points[order[2]]);
      expect(result).not.toBeNull();
      expect(Math.abs(result![0] - center[0])).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(result![1] - center[1])).toBeLessThanOrEqual(tolerance);
      for (const p of points) expect(Math.abs(Math.hypot(p[0] - result![0], p[1] - result![1]) - r)).toBeLessThanOrEqual(tolerance * 2);
    }
  });
}

it.each([0, 1e9])('rejects repeated and collinear points at offset %s', (offset) => {
  const a: Vec2 = [offset, offset];
  const b: Vec2 = [offset + 1, offset + 2];
  const c: Vec2 = [offset + 2, offset + 4];
  expect(circumcenter(a, b, c)).toBeNull();
  expect(circumcenter(a, a, c)).toBeNull();
  expect(circumcenter(a, b, a)).toBeNull();
  expect(circumcenter(a, b, b)).toBeNull();
});

for (const origin of [0, 1e9]) it.each([10, 1e6, 1e9])(`finds circle intersections with a line of half-length %s at origin ${origin}`, (length) => {
  for (const y of [0, 3, 5, 6]) {
    const points = intersectPrims(
      { kind: 'seg', a: [origin - length, origin + y], b: [origin + length, origin + y] },
      { kind: 'circ', c: [origin, origin], r: 5 },
    );
    const xs = y < 5 ? [-Math.sqrt(25 - y * y), Math.sqrt(25 - y * y)] : y === 5 ? [0] : [];
    expect(points).toHaveLength(xs.length);
    for (let i = 0; i < points.length; i++) {
      expect(points[i][0]).toBeCloseTo(origin + xs[i], 7);
      expect(points[i][1]).toBeCloseTo(origin + y, 7);
    }
  }
});

it.each([[0, 1], [0.6, 0.8]])('intersects long lines in direction %s,%s in either order', (ux, uy) => {
  for (const distance of [0, 3, 6]) {
    const center: Vec2 = [-uy * distance, ux * distance];
    const a: Vec2 = [center[0] - ux * 1e9, center[1] - uy * 1e9];
    const b: Vec2 = [center[0] + ux * 1e9, center[1] + uy * 1e9];
    const circle: Prim = { kind: 'circ', c: [0, 0], r: 5 };
    for (const reverse of [false, true]) for (const circleFirst of [false, true]) {
      const line: Prim = { kind: 'seg', a: reverse ? b : a, b: reverse ? a : b };
      const points = circleFirst ? intersectPrims(circle, line) : intersectPrims(line, circle);
      expect(points).toHaveLength(distance < 5 ? 2 : 0);
      for (const point of points) {
        expect(Math.hypot(...point)).toBeCloseTo(5, 6);
        expect(-uy * point[0] + ux * point[1]).toBeCloseTo(distance, 6);
      }
      if (points.length === 2) expect(Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]))
        .toBeCloseTo(2 * Math.sqrt(25 - distance * distance), 6);
    }
  }
});

it('clips segments and arcs while extending only the first primitive', () => {
  const circle: Prim = { kind: 'circ', c: [0, 0], r: 5 };
  const arc: Prim = { ...circle, start: 0, sweep: Math.PI / 2 };
  const short: Prim = { kind: 'seg', a: [0, 3], b: [2, 3] };
  const long: Prim = { kind: 'seg', a: [-1e9, 3], b: [1e9, 3] };
  expect(intersectPrims(short, circle)).toEqual([]);
  expect(intersectPrims(short, circle, true)).toEqual([[-4, 3], [4, 3]]);
  expect(intersectPrims(circle, short, true)).toEqual([]);
  expect(intersectPrims(long, arc)).toEqual([[4, 3]]);
  expect(intersectPrims(long, arc, true)).toEqual([[4, 3]]);
  expect(intersectPrims(arc, long, true)).toEqual([[-4, 3], [4, 3]]);
  expect(intersectPrims({ kind: 'seg', a: [0, 0], b: [0, 0] }, circle, true)).toEqual([]);
});
