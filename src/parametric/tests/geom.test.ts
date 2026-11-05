import { expect, it } from 'vitest';
import type { Vec2 } from '../src/math/vec';
import { circumcenter } from '../src/sketch/geom';

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
