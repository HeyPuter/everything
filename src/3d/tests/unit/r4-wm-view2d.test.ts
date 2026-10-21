import { describe, it, expect } from 'vitest';
import { stepFactor, borderRect, lerpRect, edgePanSpeed } from '../../src/ui/view2d_math';

describe('view2d math', () => {
  it('step zoom moves each edge in by the factor of the view size', () => {
    expect(stepFactor(0.0375)).toBeCloseTo(1 / 0.925, 9);
    expect(stepFactor(0.25)).toBeCloseTo(2, 9);
    // clamped so the view never collapses
    expect(Number.isFinite(stepFactor(0.5))).toBe(true);
  });
  it('zoom border: in fits the box, out grows the view by view/box around the box centre', () => {
    const cur = { xmin: 0, xmax: 100, ymin: 0, ymax: 50 };
    const box = { xmin: 20, xmax: 70, ymin: 10, ymax: 35 };
    expect(borderRect(cur, box, false)).toEqual(box);
    const out = borderRect(cur, box, true);
    expect(out.xmax - out.xmin).toBeCloseTo(200, 9);
    expect(out.ymax - out.ymin).toBeCloseTo(100, 9);
    expect((out.xmin + out.xmax) / 2).toBeCloseTo(45, 9);
  });
  it('smooth view eases between rects', () => {
    const a = { xmin: 0, xmax: 10, ymin: 0, ymax: 10 };
    const b = { xmin: 10, xmax: 30, ymin: -10, ymax: 0 };
    expect(lerpRect(a, b, 0)).toEqual(a);
    expect(lerpRect(a, b, 1)).toEqual(b);
    expect(lerpRect(a, b, 0.5).xmin).toBeCloseTo(5, 9);
    expect(lerpRect(a, b, 0.25).xmin).toBeLessThan(2.5);
  });
  it('edge pan speed ramps up near the edges and stops far outside', () => {
    const r = { left: 0, top: 0, right: 400, bottom: 300 };
    expect(edgePanSpeed(r, 200, 150)).toEqual([0, 0]);
    const [vx] = edgePanSpeed(r, 395, 150, { inside_padding: 20, speed_ramp: 40, max_speed: 1000 });
    expect(vx).toBeCloseTo(375, 6);
    expect(edgePanSpeed(r, -30, 150, { max_speed: 500 })[0]).toBe(-500);
    expect(edgePanSpeed(r, 200, 290)[1]).toBeGreaterThan(0);
    expect(edgePanSpeed(r, 2000, 150)).toEqual([0, 0]);
  });
});
