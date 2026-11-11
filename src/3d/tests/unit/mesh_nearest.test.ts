import { describe, expect, it } from 'vitest';
import { nearestDistances } from '../../src/mesh/nearest';

describe('nearestDistances', () => {
  it('matches comparing every pair, within the distance limit', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    // clustered and flat point sets, with duplicates
    const pts = Array.from({ length: 300 * 3 }, (_, i) => (i % 3 === 2 && i < 450 ? 0 : rnd()));
    pts.push(pts[0], pts[1], pts[2]);
    const qs = Array.from({ length: 200 * 3 }, () => rnd() * 1.5);
    for (const limit of [Infinity, 0.3, 0.05]) {
      const got = nearestDistances(pts, qs, limit);
      for (let i = 0; i < 200; i++) {
        let best = Infinity;
        for (let j = 0; j < pts.length / 3; j++) best = Math.min(best, Math.hypot(pts[j * 3] - qs[i * 3], pts[j * 3 + 1] - qs[i * 3 + 1], pts[j * 3 + 2] - qs[i * 3 + 2]));
        if (best < limit) expect(got[i]).toBeCloseTo(best, 9);
        else expect(got[i]).toBe(Infinity);
      }
    }
  });

  it('handles no points and no queries', () => {
    expect(Array.from(nearestDistances([], [0, 0, 0]))).toEqual([Infinity]);
    expect(nearestDistances([1, 2, 3], []).length).toBe(0);
  });
});
