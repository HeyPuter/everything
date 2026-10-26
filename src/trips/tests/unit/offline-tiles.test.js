// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { around, bounds, countTiles, latToY, lngToX, pad, planTiles, rangeCount, ranges, tileURL, tilesOf } from '../../src/lib/offline/tiles.js';

describe('tile coordinates', () => {
  it('maps longitude and latitude to slippy tiles', () => {
    expect([lngToX(-180, 0), latToY(0, 0)]).toEqual([0, 0]);
    expect([lngToX(0, 1), latToY(0, 1)]).toEqual([1, 1]);
    expect([lngToX(179.9999, 2), latToY(-85, 2)]).toEqual([3, 3]);
    // Paris at z14.
    expect([lngToX(2.3522, 14), latToY(48.8566, 14)]).toEqual([8299, 5636]);
    expect(latToY(90, 3)).toBe(0);
    expect(latToY(-90, 3)).toBe(7);
  });
});

describe('bounds', () => {
  it('covers the points on the side of the globe with the largest gap', () => {
    expect(bounds([[2, 48], [3, 49], [2.5, 47]])).toEqual({ west: 2, south: 47, east: 3, north: 49 });
    expect(bounds([[178, -17], [-179, -18]])).toEqual({ west: 178, south: -18, east: -179, north: -17 });
    expect(bounds([[10, 10]])).toEqual({ west: 10, south: 10, east: 10, north: 10 });
    expect(bounds([[Number.NaN, 1], [200, 1], 'x'])).toBeNull();
  });
  it('pads small boxes to a minimum and wraps at the antimeridian', () => {
    expect(pad({ west: 10, south: 10, east: 10, north: 10 }, 0.1, 0.02)).toEqual({ west: 9.98, south: 9.98, east: 10.02, north: 10.02 });
    const wrapped = pad({ west: 179.99, south: 0, east: 179.995, north: 1 }, 0.1, 0.02);
    expect(wrapped.west).toBeCloseTo(179.97);
    expect(wrapped.east).toBeCloseTo(-179.985);
    expect(pad({ west: -170, south: -80, east: 170, north: 80 }, 0.1).west).toBe(-180);
  });
  it('builds a box a given distance around a point', () => {
    const box = around([0, 0], 111.32);
    expect(box.north).toBeCloseTo(1);
    expect(box.east).toBeCloseTo(1);
    expect(around([0, 60], 111.32).east).toBeCloseTo(2);
  });
});

describe('ranges and plans', () => {
  it('splits a box that crosses the antimeridian', () => {
    const split = ranges({ west: 170, south: -20, east: -170, north: -10 }, 3);
    expect(split).toEqual([{ z: 3, x0: 7, x1: 7, y0: 4, y1: 4 }, { z: 3, x0: 0, x1: 0, y0: 4, y1: 4 }]);
    expect(rangeCount({ z: 2, x0: 0, x1: 3, y0: 0, y1: 3 })).toBe(16);
  });
  it('downloads the whole trip at low zooms and only around places at high zooms', () => {
    const places = [[2.35, 48.85], [4.83, 45.76]];
    const plan = planTiles({ overview: places, detail: places, overviewTiles: 400 });
    expect(plan.overviewZoom).toBeGreaterThan(5);
    expect(plan.overviewZoom).toBeLessThan(14);
    const zooms = new Set(plan.ranges.map((range) => range.z));
    expect(Math.max(...zooms)).toBe(14);
    const overview = plan.ranges.filter((range) => range.z <= plan.overviewZoom);
    expect(overview.reduce((sum, range) => sum + rangeCount(range), 0)).toBeLessThanOrEqual(400);
    const deepest = plan.ranges.filter((range) => range.z === 14);
    expect(deepest).toHaveLength(2);
    expect(deepest.every((range) => rangeCount(range) <= 25)).toBe(true);
    expect(countTiles(plan.ranges)).toBeLessThan(2000);
  });
  it('plans nothing without coordinates and respects the maximum zoom', () => {
    expect(planTiles({ overview: [] })).toEqual({ ranges: [], overviewZoom: -1 });
    const plan = planTiles({ overview: [[0, 0]], maxZoom: 10 });
    expect(Math.max(...plan.ranges.map((range) => range.z))).toBe(10);
  });
  it('enumerates unique tiles in plan order up to a limit', () => {
    const planned = [{ z: 1, x0: 0, x1: 1, y0: 0, y1: 0 }, { z: 1, x0: 1, x1: 1, y0: 0, y1: 1 }];
    expect([...tilesOf(planned)].map(({ z, x, y }) => `${z}/${x}/${y}`)).toEqual(['1/0/0', '1/1/0', '1/1/1']);
    expect([...tilesOf(planned, 2)]).toHaveLength(2);
    expect(tileURL('https://tiles.openfreemap.org/planet/v1/{z}/{x}/{y}.pbf', { z: 3, x: 4, y: 5 })).toBe('https://tiles.openfreemap.org/planet/v1/3/4/5.pbf');
  });
});
