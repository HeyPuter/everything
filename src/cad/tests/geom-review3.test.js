import { describe, it, expect } from 'vitest';
import * as G from '../src/core/geom/index.js';

describe('spline length far from the origin', () => {
  it('converges at once and matches the same curve at the origin', () => {
    const fit = [-8.5, 9, -1.8, 10.3, -5.2, 1.2, -4.1, 10.6, -8.5, 9];
    const near = { type: 'spline', ...G.splineFromFitPoints(fit) };
    const far = { ...near, ctrl: near.ctrl.map((v) => v + 1e7) };
    expect(G.lengthOf(far)).toBeCloseTo(G.lengthOf(near), 6);
  });
});
