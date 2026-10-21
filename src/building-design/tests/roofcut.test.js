import { describe, it, expect } from 'vitest';
import { subtractConvex, signedArea, segmentInside, segmentOutside, cutFace } from '../src/core/roofcut.js';

const sq = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const area = (pieces) => pieces.reduce((s, p) => s + Math.abs(signedArea(p)), 0);

describe('cutting openings out of roof faces', () => {
  it('subtracts an opening that crosses the face edge', () => {
    const face = sq(0, 0, 10, 10);
    const pieces = subtractConvex(face, sq(8, 4, 12, 6));
    expect(area(pieces)).toBeCloseTo(100 - 4, 6);
  });

  it('leaves a face alone when the opening misses it', () => {
    expect(area(subtractConvex(sq(0, 0, 10, 10), sq(20, 20, 30, 30)))).toBeCloseTo(100, 6);
  });

  it('finds the parts of a segment inside and outside polygons', () => {
    expect(segmentInside([-5, 5], [15, 5], sq(0, 0, 10, 10))).toEqual([[0.25, 0.75]]);
    const out = segmentOutside([0, 0], [10, 0], [sq(2, -1, 4, 1), sq(6, -1, 8, 1)]);
    expect(out.map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)])).toEqual([
      [0, 0.2],
      [0.4, 0.6],
      [0.8, 1],
    ]);
  });

  it('sorts openings into holes and notches', () => {
    const r = cutFace(sq(0, 0, 10, 10), [sq(2, 2, 3, 3), sq(9, 4, 11, 6)]);
    expect(r.inner).toHaveLength(1);
    expect(r.crossing).toHaveLength(1);
    expect(area(r.pieces.map((p) => p.outer))).toBeCloseTo(98, 6);
    expect(r.pieces.reduce((n, p) => n + p.holes.length, 0)).toBe(1);
  });
});
