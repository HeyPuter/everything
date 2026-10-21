import { describe, it, expect } from 'vitest';
import { eraseAt, segmentDistance, type Annotation2DStroke } from '../../src/mask/annotate2dcore';

const S = (points: number[]): Annotation2DStroke => ({ points, color: [1, 0, 0], thickness: 3 });
const id = (u: number, v: number): [number, number] => [u * 100, v * 100];

describe('2D annotation erasing', () => {
  it('measures distances to segments', () => {
    expect(segmentDistance(5, 5, 0, 0, 10, 0)).toBe(5);
    expect(segmentDistance(-3, 4, 0, 0, 10, 0)).toBe(5);
    expect(segmentDistance(1, 1, 2, 2, 2, 2)).toBeCloseTo(Math.SQRT2);
  });

  it('splits a stroke where points are erased and drops short leftovers', () => {
    const strokes = [S([0, 0, 0.1, 0, 0.2, 0, 0.3, 0, 0.4, 0, 0.5, 0])];
    expect(eraseAt(strokes, 20, 0, 5, id)).toBe(true);
    expect(strokes.map((s) => s.points)).toEqual([
      [0, 0, 0.1, 0],
      [0.3, 0, 0.4, 0, 0.5, 0],
    ]);
    // erasing the lone end point of the first piece leaves a single point: it goes
    expect(eraseAt(strokes, 0, 0, 5, id)).toBe(true);
    expect(strokes.length).toBe(1);
    expect(eraseAt(strokes, 90, 90, 5, id)).toBe(false);
  });

  it('erases a straight line crossed in the middle', () => {
    const strokes = [S([0, 0.5, 1, 0.5])];
    expect(eraseAt(strokes, 50, 52, 5, id)).toBe(true);
    expect(strokes).toEqual([]);
  });
});
