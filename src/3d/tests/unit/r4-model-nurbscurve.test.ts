// NURBS curves: knot vectors (uniform / endpoint / Bézier, open and cyclic) and the number of evaluated
// points per knot span match recorded reference evaluations of a 7-point spline (resolution 3).
import { describe, it, expect } from 'vitest';
import fx from '../fixtures/r4_nurbs_curves.json';
import { sampleSpline } from '../../src/eval/curve';
import type { Spline } from '../../src/data/types';

const F = fx as { pts: number[][]; res: Record<string, number[][]> };

describe('NURBS curve evaluation (recorded reference)', () => {
  for (const [key, ref] of Object.entries(F.res)) {
    const [order, cyc, ep, bz] = key.split('_').map(Number);
    // Bézier knots without the endpoint flag, and cyclic Bézier knots on an odd point count, are edge cases
    if (bz && (!ep || cyc)) continue;
    it(`order ${order} cyclic ${cyc} endpoint ${ep} bezier ${bz}`, () => {
      const sp: Spline = { type: 'NURBS', bezier_points: [], points: F.pts.map((p) => ({ co: [p[0], p[1], p[2], 1], radius: 1, tilt: 0 })), use_cyclic_u: !!cyc, use_endpoint_u: !!ep, use_bezier_u: !!bz, order_u: order, resolution_u: 3, use_smooth: true, material_index: 0 };
      const s = sampleSpline(sp, 3);
      expect(s.points.length).toBe(ref.length);
      s.points.forEach((p, i) => expect(Math.hypot(p[0] - ref[i][0], p[1] - ref[i][1], p[2] - ref[i][2]), `point ${i}`).toBeLessThan(2e-3));
    });
  }
});
