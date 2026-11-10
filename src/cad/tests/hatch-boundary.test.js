import { describe, it, expect } from 'vitest';
import { findBoundary, toHatchLoops } from '../src/core/hatch/boundary.js';
import { ringArea } from '../src/core/hatch/fill.js';

const seg = (x1, y1, x2, y2) => ({ pts: [x1, y1, x2, y2], closed: false });
const circle = (cx, cy, r, n = 64) => {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return { pts, closed: true };
};
const box = (ring) => {
  const xs = ring.filter((_, i) => i % 2 === 0),
    ys = ring.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

describe('findBoundary', () => {
  it('finds a rectangle made of four separate lines', () => {
    const curves = [seg(0, 0, 10, 0), seg(10, 0, 10, 5), seg(10, 5, 0, 5), seg(0, 5, 0, 0)];
    const r = findBoundary(3, 2, curves);
    expect(r).not.toBeNull();
    expect(r.outer.length).toBe(8);
    expect(ringArea(r.outer)).toBeCloseTo(50);
    expect(r.islands.length).toBe(0);
    const loops = toHatchLoops(r);
    expect(loops.length).toBe(1);
    expect(loops[0].length).toBe(12);
    expect(loops[0][2]).toBe(0);
  });

  it('returns null for a point outside', () => {
    const curves = [seg(0, 0, 10, 0), seg(10, 0, 10, 5), seg(10, 5, 0, 5), seg(0, 5, 0, 0)];
    expect(findBoundary(20, 2, curves)).toBeNull();
    expect(findBoundary(5, 6, [...curves, seg(-5, 8, 15, 8)])).toBeNull();
  });

  it('returns null for an open shape', () => {
    const curves = [seg(0, 0, 10, 0), seg(10, 0, 10, 5), seg(10, 5, 0, 5)];
    expect(findBoundary(3, 2, curves)).toBeNull();
  });

  it('picks one cell of a grid of crossing lines', () => {
    const curves = [];
    for (let i = 0; i <= 5; i++) {
      curves.push(seg(-1, i * 10, 51, i * 10));
      curves.push(seg(i * 10, -1, i * 10, 51));
    }
    const r = findBoundary(23, 37, curves);
    expect(r).not.toBeNull();
    expect(box(r.outer)).toEqual([20, 30, 30, 40]);
    expect(r.outer.length).toBe(8);
    expect(ringArea(r.outer)).toBeCloseTo(100);
  });

  it('returns an inner circle as an island', () => {
    const curves = [{ pts: [0, 0, 100, 0, 100, 60, 0, 60], closed: true }, circle(50, 30, 10)];
    const r = findBoundary(10, 10, curves);
    expect(r).not.toBeNull();
    expect(ringArea(r.outer)).toBeCloseTo(6000);
    expect(r.islands.length).toBe(1);
    expect(ringArea(r.islands[0])).toBeLessThan(0);
    expect(Math.abs(ringArea(r.islands[0]))).toBeGreaterThan(300);
    expect(toHatchLoops(r).length).toBe(2);
    // Inside the circle the circle itself is the boundary.
    const c = findBoundary(50, 30, curves);
    expect(c.islands.length).toBe(0);
    expect(Math.abs(ringArea(c.outer))).toBeLessThan(Math.PI * 100);
  });

  it('only returns direct child islands', () => {
    const curves = [{ pts: [0, 0, 100, 0, 100, 100, 0, 100], closed: true }, circle(50, 50, 30), circle(50, 50, 10)];
    const r = findBoundary(5, 5, curves);
    expect(r.islands.length).toBe(1);
    expect(box(r.islands[0])[0]).toBeCloseTo(20);
    const mid = findBoundary(50, 25, curves);
    expect(box(mid.outer)[0]).toBeCloseTo(20);
    expect(mid.islands.length).toBe(1);
  });

  it('ignores dangling overshoots and stray lines', () => {
    const curves = [
      seg(-3, 0, 12, 0),
      seg(10, -4, 10, 8),
      seg(13, 5, -2, 5),
      seg(0, 7, 0, -2),
      seg(5, 5, 5, 9), // stray spur outside
      seg(2, 1, 4, 3), // loose line inside
    ];
    const r = findBoundary(7, 2, curves);
    expect(r).not.toBeNull();
    expect(box(r.outer)).toEqual([0, 0, 10, 5]);
    expect(r.outer.length).toBe(8);
    expect(r.islands.length).toBe(0);
  });

  it('handles T-junctions and collinear overlapping segments', () => {
    const curves = [
      seg(0, 0, 6, 0),
      seg(4, 0, 10, 0), // overlaps the first
      seg(10, 0, 10, 10),
      seg(10, 10, 0, 10),
      seg(0, 10, 0, 0),
      seg(5, 0, 5, 10), // T at both ends, splits the square
    ];
    const r = findBoundary(7, 5, curves);
    expect(box(r.outer)).toEqual([5, 0, 10, 10]);
    expect(ringArea(r.outer)).toBeCloseTo(50);
  });

  it('closes small gaps with gapTol', () => {
    const curves = [seg(0, 0, 10, 0), seg(10, 0.05, 10, 5), seg(10, 5, 0, 5), seg(0, 5, 0, 0.04)];
    expect(findBoundary(3, 2, curves)).toBeNull();
    const r = findBoundary(3, 2, curves, { gapTol: 0.1 });
    expect(r).not.toBeNull();
    expect(Math.abs(ringArea(r.outer) - 50)).toBeLessThan(0.5);
  });

  it('removes bridges so an attached inner loop becomes an island', () => {
    const curves = [
      { pts: [0, 0, 20, 0, 20, 20, 0, 20], closed: true },
      { pts: [8, 8, 12, 8, 12, 12, 8, 12], closed: true },
      seg(0, 10, 8, 10), // connects the inner square to the outer one
    ];
    const r = findBoundary(3, 3, curves);
    expect(ringArea(r.outer)).toBeCloseTo(400);
    expect(r.islands.length).toBe(1);
    expect(Math.abs(ringArea(r.islands[0]))).toBeCloseTo(16);
  });

  it('copes with many crossing segments quickly', () => {
    const curves = [];
    const n = 300;
    for (let i = 0; i <= n; i++) {
      curves.push(seg(-1, i, n + 1, i + 0.001 * (i % 3)));
      curves.push(seg(i, -1, i + 0.001 * (i % 5), n + 1));
    }
    const t0 = performance.now();
    const r = findBoundary(150.5, 150.5, curves);
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(r).not.toBeNull();
    expect(Math.abs(ringArea(r.outer))).toBeGreaterThan(0.9);
    expect(Math.abs(ringArea(r.outer))).toBeLessThan(1.1);
  });
});

describe('findBoundary far from the origin', () => {
  const O = 1e7;
  const sq = (x, y, s) => ({ pts: [O + x, O + y, O + x + s, O + y, O + x + s, O + y + s, O + x, O + y + s], closed: true });

  it('keeps a 4 mm island and can hatch inside it', () => {
    const curves = [sq(0, 0, 10), sq(5, 5, 0.004)];
    const inside = findBoundary(O + 5.002, O + 5.002, curves);
    expect(ringArea(inside.outer)).toBeCloseTo(1.6e-5, 9);
    const around = findBoundary(O + 2, O + 2, curves);
    expect(ringArea(around.outer)).toBeCloseTo(100, 6);
    expect(around.islands).toHaveLength(1);
    // the corners come back exactly
    expect(box(around.outer)).toEqual([O, O, O + 10, O + 10]);
  });

  it('does not close a 4 mm gap in the outline', () => {
    const open = { pts: [O, O, O + 10, O, O + 10, O + 10, O, O + 10, O, O + 0.004], closed: false };
    const r = findBoundary(O + 5, O + 5, [open, sq(-5, -5, 20)]);
    expect(ringArea(r.outer)).toBeCloseTo(400, 6);
    expect(findBoundary(O + 5, O + 5, [open])).toBeNull();
  });
});

describe('findBoundary vertex merging', () => {
  it('joins ends that differ by less than the tolerance on every side of the pick point', () => {
    // Corners sit in all four quadrants around the pick point (negative and
    // positive grid cells) and each pair of ends is off by a fraction of tol.
    const e = 4e-9;
    const curves = [
      seg(-50, -30, 50 + e, -30 - e),
      seg(50, -30, 50 - e, 30 + e),
      seg(50, 30, -50 - e, 30 - e),
      seg(-50, 30, -50 + e, -30 + e),
    ];
    const r = findBoundary(0.25, -0.5, curves, { tol: 1e-8 });
    expect(r).not.toBeNull();
    expect(r.outer.length).toBe(8);
    expect(ringArea(r.outer)).toBeCloseTo(6000, 5);
    // ends farther apart than the tolerance stay open
    expect(findBoundary(0.25, -0.5, curves, { tol: 1e-9 })).toBeNull();
  });
});
