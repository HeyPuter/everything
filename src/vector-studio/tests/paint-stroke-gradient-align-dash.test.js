import { describe, it, expect } from 'vitest';
import { rectangle } from '../src/model/shapes.js';
import { strokeGradientShapes } from '../src/features/paint/stroke-gradient.js';

const G = {
  type: 'linear',
  angle: 0,
  stops: [
    { offset: 0, color: '#ff0000', opacity: 1 },
    { offset: 1, color: '#0000ff', opacity: 1 },
  ],
};
const pt = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
const line = (x0, y0, x1, y1) => [pt(x0, y0), pt(x1, y1)];
const box = (shapes) => {
  const ps = shapes.flatMap((s) => s.points);
  const xs = ps.map((p) => p.x);
  const ys = ps.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

describe('Gradients along and across aligned strokes', () => {
  for (const mode of ['along', 'across']) {
    for (const reversed of [false, true]) {
      it(`${mode}: inside and outside strokes keep to their side (${reversed ? 'reversed' : 'drawn'} path)`, () => {
        const anchors = reversed ? rectangle(0, 0, 100, 60).reverse() : rectangle(0, 0, 100, 60);
        const paint = { ...G, strokeApply: mode };
        const sp = [{ anchors, closed: true }];
        const inside = box(
          strokeGradientShapes(sp, paint, { strokeWidth: 10, strokeAlign: 'inside' }),
        );
        expect(inside.x0).toBeCloseTo(0, 6);
        expect(inside.x1).toBeCloseTo(100, 6);
        expect(inside.y0).toBeCloseTo(0, 6);
        expect(inside.y1).toBeCloseTo(60, 6);
        const outside = box(
          strokeGradientShapes(sp, paint, { strokeWidth: 10, strokeAlign: 'outside' }),
        );
        expect(outside.x0).toBeCloseTo(-10, 6);
        expect(outside.y1).toBeCloseTo(70, 6);
        const center = box(strokeGradientShapes(sp, paint, { strokeWidth: 10 }));
        expect(center.x0).toBeCloseTo(-5, 6);
      });
    }
  }

  it('a hole of a compound path takes its inside stroke on the filled side', () => {
    const outer = { anchors: rectangle(0, 0, 100, 100), closed: true };
    const hole = { anchors: rectangle(30, 30, 40, 40).reverse(), closed: true };
    const shapes = strokeGradientShapes(
      [outer, hole],
      { ...G, strokeApply: 'along' },
      { strokeWidth: 4, strokeAlign: 'inside' },
    );
    // No band reaches into the hole.
    for (const s of shapes)
      for (const p of s.points)
        expect(p.x > 30 + 1e-6 && p.x < 70 - 1e-6 && p.y > 30 + 1e-6 && p.y < 70 - 1e-6).toBe(
          false,
        );
  });
});

describe('Gradients along and across dashed strokes', () => {
  for (const mode of ['along', 'across']) {
    it(`${mode}: paints only the dashes, with square ends`, () => {
      const shapes = strokeGradientShapes(
        [{ anchors: line(0, 0, 100, 0), closed: false }],
        { ...G, strokeApply: mode },
        { strokeWidth: 6, dash: [10, 10], dashOffset: 5 },
      );
      expect(shapes.length).toBeGreaterThan(0);
      for (const s of shapes) {
        for (const p of s.points) {
          // Dashes cover 0-5, 15-25, 35-45, ... (the pattern starts 5 units in).
          const k = (p.x + 5) % 20;
          expect(k < 10 + 1e-6 || k > 20 - 1e-6).toBe(true);
          expect(Math.abs(p.y)).toBeLessThanOrEqual(3 + 1e-6);
        }
      }
      const covered = (x) =>
        shapes.some((s) => {
          const xs = s.points.map((p) => p.x);
          return Math.min(...xs) <= x && x <= Math.max(...xs);
        });
      expect(covered(20)).toBe(true);
      expect(covered(10)).toBe(false);
      expect(covered(30)).toBe(false);
    });
  }

  it('dash ends are square to the path between corners', () => {
    const sp = [{ anchors: rectangle(0, 0, 100, 60), closed: true }];
    for (const mode of ['along', 'across']) {
      const shapes = strokeGradientShapes(
        sp,
        { ...G, strokeApply: mode },
        { strokeWidth: 6, dash: [10, 10] },
      );
      const top = shapes.filter((s) =>
        s.points.every((p) => Math.abs(p.y) <= 3 + 1e-6 && p.x > 5 && p.x < 95),
      );
      expect(top.length).toBeGreaterThan(2);
      for (const s of top) expect(new Set(s.points.map((p) => p.x.toFixed(6))).size).toBe(2);
    }
  });

  it('round caps end each dash', () => {
    const shapes = strokeGradientShapes(
      [{ anchors: line(0, 0, 100, 0), closed: false }],
      { ...G, strokeApply: 'along' },
      { strokeWidth: 6, strokeCap: 'round', dash: [10, 20] },
    );
    const xs = shapes.flatMap((s) => s.points.map((p) => p.x));
    // The first dash 0-10 is capped on both ends, the second (30-40) too.
    expect(Math.min(...xs)).toBeCloseTo(-3, 6);
    expect(xs.some((x) => x > 12.9 && x < 13.1)).toBe(true);
    expect(xs.some((x) => x > 26.9 && x < 27.1)).toBe(true);
  });
});
