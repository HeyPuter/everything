import { describe, it, expect } from 'vitest';
import { bezierAt, curvePolyline, makeCurvePoint, moveCurveElement, pickCurvePoint, resamplePolyline } from '../../src/paint/strokemath';

describe('paint curves', () => {
  const a = makeCurvePoint([0, 0], null, [100, 0]);
  const b = makeCurvePoint([100, 0], [0, 0]);
  it('places handles along the direction to the neighbour', () => {
    expect(b.h1[1]).toBeCloseTo(0);
    expect(b.h1[0]).toBeLessThan(100);
    expect(b.h2[0]).toBeGreaterThan(100);
    expect(a.h2[0]).toBeGreaterThan(0);
  });
  it('evaluates the cubic between two points', () => {
    expect(bezierAt(a, b, 0)).toEqual([0, 0]);
    expect(bezierAt(a, b, 1)).toEqual([100, 0]);
    const m = bezierAt(a, b, 0.5);
    expect(m[0]).toBeCloseTo(50);
    expect(m[1]).toBeCloseTo(0);
  });
  it('flattens and resamples at even steps', () => {
    const line = curvePolyline([a, b], 16);
    expect(line.length).toBe(17);
    const even = resamplePolyline(line, 10);
    expect(even.length).toBe(11);
    for (let i = 1; i < even.length; i++) expect(Math.hypot(even[i][0] - even[i - 1][0], even[i][1] - even[i - 1][1])).toBeCloseTo(10, 1);
  });
  it('picks the point before its handles and moves with aligned handles', () => {
    const p = makeCurvePoint([50, 50], [0, 50]);
    expect(pickCurvePoint([p], 51, 50)).toEqual([0, 1]);
    expect(pickCurvePoint([p], p.h2[0], p.h2[1] + 1)).toEqual([0, 2]);
    expect(pickCurvePoint([p], 500, 500)).toBeNull();
    moveCurveElement(p, 2, 0, 10, true);
    expect(p.h1[0]).toBeCloseTo(2 * 50 - p.h2[0]);
    expect(p.h1[1]).toBeCloseTo(2 * 50 - p.h2[1]);
    const co = [...p.co];
    moveCurveElement(p, 1, 5, 5, false);
    expect(p.co).toEqual([co[0] + 5, co[1] + 5]);
  });
});
