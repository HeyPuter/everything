// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { transformPoints } from '../../src/mask/maskops';
import { newPoint } from '../../src/mask/types';

const snap = (co: [number, number]) => {
  const p = newPoint(co[0], co[1]);
  return { p, co: [...p.co] as [number, number], hl: [...p.handle_left] as [number, number], hr: [...p.handle_right] as [number, number], w: p.weight };
};

describe('mask point transforms', () => {
  it('shears along x by the height above the pivot', () => {
    const s = [snap([0.5, 0.5]), snap([0.5, 0.7])];
    transformPoints(s, 'SHEAR', [0.5], 1, [0.5, 0.5]);
    expect(s[0].p.co[0]).toBeCloseTo(0.5);
    expect(s[1].p.co[0]).toBeCloseTo(0.6);
    expect(s[1].p.co[1]).toBeCloseTo(0.7);
  });

  it('moves points onto a circle of their mean distance (To Sphere = 1), handles follow', () => {
    const s = [snap([0.6, 0.5]), snap([0.5, 0.8]), snap([0.2, 0.5]), snap([0.5, 0.4])];
    const hl0 = s[0].hl.slice();
    transformPoints(s, 'TOSPHERE', [1], 1, [0.5, 0.5]);
    const d = s.map((o) => Math.hypot(o.p.co[0] - 0.5, o.p.co[1] - 0.5));
    for (const x of d) expect(x).toBeCloseTo(0.2, 6);
    expect(s[0].p.handle_left[0] - hl0[0]).toBeCloseTo(s[0].p.co[0] - 0.6, 6);
    // factor 0 leaves them alone
    transformPoints(s, 'TOSPHERE', [0], 1, [0.5, 0.5]);
    expect(s[1].p.co[1]).toBeCloseTo(0.8);
  });
});
