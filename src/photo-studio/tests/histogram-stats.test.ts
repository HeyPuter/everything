import { describe, expect, it } from 'vitest';
import { clipping, displayMax, histogramStats } from '../src/features/panels/histogram';

const bins = (entries: [number, number][]) => {
  const b = new Uint32Array(256);
  for (const [level, n] of entries) b[level] = n;
  return b;
};

describe('histogram statistics', () => {
  it('measures mean, standard deviation, median and pixel count', () => {
    const s = histogramStats(
      bins([
        [10, 2],
        [20, 2],
      ]),
    );
    expect(s.mean).toBe(15);
    expect(s.stdDev).toBe(5);
    expect(s.median).toBe(10);
    expect(s.count).toBe(4);
    expect(s.percentile).toBe(100);
  });
  it('limits statistics to a level range and reports the percentile at its top', () => {
    const b = bins([
      [0, 1],
      [100, 3],
      [200, 4],
      [255, 2],
    ]);
    const s = histogramStats(b, 150, 50);
    expect(s.count).toBe(3);
    expect(s.mean).toBe(100);
    expect(s.stdDev).toBe(0);
    expect(s.percentile).toBeCloseTo(40);
    expect(histogramStats(b, 0, 0).percentile).toBeCloseTo(10);
  });
  it('is zero for an empty histogram', () => {
    expect(histogramStats(new Uint32Array(256))).toMatchObject({
      mean: 0,
      stdDev: 0,
      median: 0,
      count: 0,
      percentile: 0,
    });
    expect(clipping(new Uint32Array(256))).toEqual({ shadows: 0, highlights: 0 });
  });
  it('reports the share of pure black and pure white pixels', () => {
    expect(
      clipping(
        bins([
          [0, 1],
          [128, 2],
          [255, 1],
        ]),
      ),
    ).toEqual({ shadows: 0.25, highlights: 0.25 });
  });
  it('keeps one isolated spike from flattening the rest', () => {
    const b = new Uint32Array(256).fill(10);
    b[255] = 100000;
    expect(displayMax(b)).toBeLessThan(100);
    expect(displayMax(new Uint32Array(256))).toBe(1);
  });
});
