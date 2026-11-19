import { describe, expect, it } from 'vitest';
import { smoothStep } from '../src/features/paint';

const round = (p: [number, number] | undefined) => p && p.map((v) => Math.round(v * 100) / 100);

describe('brush smoothing', () => {
  it('pulls the stroke part of the way to the pointer', () => {
    expect(round(smoothStep([0, 0], [100, 0], { smoothing: 0.25, smoothForZoom: false }))).toEqual([
      75, 0,
    ]);
  });
  it('judges smoothing on screen with Adjust for Zoom', () => {
    // Zoomed in 4x the smoothing halves; zoomed out it grows (up to the limit).
    expect(round(smoothStep([0, 0], [100, 0], { smoothing: 0.5 }, 4))).toEqual([75, 0]);
    expect(round(smoothStep([0, 0], [100, 0], { smoothing: 0.5 }, 1))).toEqual([50, 0]);
    expect(round(smoothStep([0, 0], [100, 0], { smoothing: 0.5 }, 0.25))).toEqual([5, 0]);
  });
  it('moves only once a pulled string tightens, then trails by its length', () => {
    const s = { smoothing: 0.2, pulledString: true, smoothForZoom: false };
    expect(smoothStep([0, 0], [15, 0], s)).toBeUndefined();
    expect(round(smoothStep([0, 0], [50, 0], s))).toEqual([30, 0]);
    expect(round(smoothStep([0, 0], [0, -26], s))).toEqual([0, -6]);
  });
  it('shortens the string in image pixels when zoomed in', () => {
    const s = { smoothing: 0.2, pulledString: true };
    expect(round(smoothStep([0, 0], [50, 0], s, 2))).toEqual([40, 0]);
  });
});
