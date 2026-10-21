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

describe('mask spline feather settings', () => {
  it('eases the feather width between points and smooths offsets', async () => {
    const { sampleSpline, featherOutline } = await import('../../src/mask/geom');
    const { squareSpline } = await import('../../src/mask/geom');
    const sp = squareSpline(0.5, 0.5, 0.2, 1);
    sp.points[0].weight = 0;
    sp.points[1].weight = 0.1;
    const lin = sampleSpline(sp, 16);
    sp.weight_interpolation = 'EASE';
    const ease = sampleSpline(sp, 16);
    // a quarter of the way: linear 0.025, eased 0.1 × smoothstep(0.25) = 0.015625
    expect(lin[4].w).toBeCloseTo(0.025, 6);
    expect(ease[4].w).toBeCloseTo(0.015625, 6);
    // smooth offsets round the corners: the corner sample moves less far out along the diagonal
    for (const p of sp.points) p.weight = 0.05;
    const s = sampleSpline(sp, 16);
    const even = featherOutline(s, 1, 1, 'EVEN'),
      smooth = featherOutline(s, 1, 1, 'SMOOTH');
    expect(even.length).toBe(smooth.length);
    expect(even.some((p, i) => Math.hypot(p[0] - smooth[i][0], p[1] - smooth[i][1]) > 1e-4)).toBe(true);
  });
});
