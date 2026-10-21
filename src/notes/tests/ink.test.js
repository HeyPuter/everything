import { describe, it, expect } from 'vitest';
import { strokePath, shapePath, bounds, hitTest, insideLasso, translate, simplify, constrainShape, pointInPolygon, unionBounds } from '../src/editor/ink.js';

const stroke = (points, width = 2) => ({ id: 's', type: 'stroke', color: '#000', width, points });

describe('ink geometry', () => {
  it('builds a closed outline path for a stroke', () => {
    const d = strokePath(stroke([[0, 0, 0.5], [10, 0, 0.5], [20, 5, 0.5]]));
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
  });

  it('draws shape outlines', () => {
    expect(shapePath({ kind: 'rect', x1: 10, y1: 10, x2: 0, y2: 0 })).toBe('M0 0h10v10h-10Z');
    expect(shapePath({ kind: 'line', x1: 0, y1: 0, x2: 5, y2: 5 })).toBe('M0 0L5 5');
    expect(shapePath({ kind: 'arrow', x1: 0, y1: 0, x2: 10, y2: 0, width: 2 })).toMatch(/^M0 0L10 0M/);
  });

  it('hit-tests strokes along their segments', () => {
    const s = stroke([[0, 0], [100, 0]]);
    expect(hitTest(s, 50, 2, 2)).toBe(true);
    expect(hitTest(s, 50, 20, 2)).toBe(false);
  });

  it('hit-tests the path an eraser swept between two pointer events', () => {
    const s = stroke([[50, 0], [50, 100]]);
    // Neither sample is near the stroke, but the swipe between them crosses it.
    expect(hitTest(s, 80, 50, 2)).toBe(false);
    expect(hitTest(s, 80, 50, 2, [20, 50])).toBe(true);
    expect(hitTest(s, 80, 150, 2, [20, 150])).toBe(false);
    const rect = { type: 'shape', kind: 'rect', x1: 0, y1: 0, x2: 100, y2: 100, width: 2 };
    expect(hitTest(rect, 120, 50, 2, [-20, 50])).toBe(true);
    expect(hitTest(rect, 60, 50, 2, [40, 50])).toBe(false);
  });

  it('hit-tests shape outlines, not their insides', () => {
    const rect = { type: 'shape', kind: 'rect', x1: 0, y1: 0, x2: 100, y2: 100, width: 2 };
    expect(hitTest(rect, 0, 50, 2)).toBe(true);
    expect(hitTest(rect, 50, 50, 2)).toBe(false);
  });

  it('selects items mostly inside a lasso', () => {
    const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(15, 5, square)).toBe(false);
    expect(insideLasso(stroke([[2, 2], [4, 4], [6, 6]]), square)).toBe(true);
    expect(insideLasso(stroke([[2, 2], [20, 20], [30, 30]]), square)).toBe(false);
  });

  it('measures and moves items', () => {
    const s = stroke([[0, 0], [10, 20]], 2);
    expect(bounds(s)).toEqual({ x: -2, y: -2, w: 14, h: 24 });
    translate(s, 5, 5);
    expect(s.points[0]).toEqual([5, 5]);
    expect(unionBounds([{ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: 5, w: 1, h: 1 }])).toEqual({ x: 0, y: 0, w: 6, h: 6 });
  });

  it('thins dense input points', () => {
    const pts = Array.from({ length: 50 }, (_, i) => [i * 0.1, 0, 0.5]);
    const out = simplify(pts);
    expect(out.length).toBeLessThan(10);
    expect(out[0]).toEqual([0, 0, 0.5]);
    expect(out.at(-1)[0]).toBeCloseTo(4.9);
  });

  it('constrains lines to 45 degrees and boxes to squares', () => {
    const [x, y] = constrainShape('line', 0, 0, 10, 9);
    expect(Math.abs(x - y)).toBeLessThan(0.001);
    expect(constrainShape('rect', 0, 0, 10, -4)).toEqual([10, -10]);
  });
});

describe('Ink to Shape', async () => {
  const { recognizeShape } = await import('../src/editor/ink.js');
  const jitter = (pts, n = 1.2) => pts.map(([x, y], i) => [x + Math.sin(i * 1.7) * n, y + Math.cos(i * 2.3) * n]);
  const along = (a, b, steps) => Array.from({ length: steps }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps]);

  it('recognizes a straight line', () => {
    expect(recognizeShape(jitter(along([0, 0], [200, 50], 40)))?.kind).toBe('line');
  });

  it('recognizes an ellipse', () => {
    const pts = Array.from({ length: 60 }, (_, i) => [100 + 80 * Math.cos((i / 60) * Math.PI * 2), 100 + 40 * Math.sin((i / 60) * Math.PI * 2)]);
    pts.push(pts[0]);
    const s = recognizeShape(jitter(pts));
    expect(s?.kind).toBe('ellipse');
    expect(Math.round(s.x2 - s.x1)).toBeGreaterThan(150);
  });

  it('recognizes a rectangle', () => {
    const pts = [...along([0, 0], [200, 0], 20), ...along([200, 0], [200, 100], 10), ...along([200, 100], [0, 100], 20), ...along([0, 100], [0, 2], 10)];
    expect(recognizeShape(jitter(pts))?.kind).toBe('rect');
  });

  it('recognizes a triangle', () => {
    const pts = [...along([100, 0], [200, 160], 20), ...along([200, 160], [0, 160], 20), ...along([0, 160], [98, 2], 20)];
    expect(recognizeShape(jitter(pts))?.kind).toBe('triangle');
  });

  it('leaves scribbles alone', () => {
    const pts = Array.from({ length: 50 }, (_, i) => [i * 4, (i % 2) * 30]);
    expect(recognizeShape(pts)).toBeNull();
  });
});
