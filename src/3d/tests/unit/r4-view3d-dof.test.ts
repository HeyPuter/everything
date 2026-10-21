import { describe, it, expect } from 'vitest';
import { circleOfConfusion } from '../../src/editors/view3d/viewdof';

describe('circle of confusion', () => {
  it('is zero at the focus distance and grows away from it', () => {
    const f = 0.05,
      a = f / 2.8 / 2;
    expect(circleOfConfusion(10, 10, f, a)).toBeCloseTo(0, 9);
    expect(circleOfConfusion(5, 10, f, a)).toBeGreaterThan(circleOfConfusion(8, 10, f, a));
    expect(circleOfConfusion(100, 10, f, a)).toBeGreaterThan(circleOfConfusion(20, 10, f, a));
  });
  it('matches the thin lens formula', () => {
    // A f |D - S| / (D (S - f)) with A the aperture diameter
    const f = 0.05,
      A = f / 2,
      S = 4,
      D = 2;
    expect(circleOfConfusion(D, S, f, A / 2)).toBeCloseTo((A * f * Math.abs(D - S)) / (D * (S - f)), 12);
  });
});
