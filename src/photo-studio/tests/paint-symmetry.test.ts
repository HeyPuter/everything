import { describe, expect, it } from 'vitest';
import { StrokeSession } from '../src/engine/paint';
import { TileStore, gridFromImage, readRGBA } from '../src/model/tiles';
import {
  clampSegments,
  symmetryAxes,
  symmetryTransforms,
  transformDab,
  type Affine,
  type SymmetryKind,
} from '../src/imaging/symmetry';

const apply = (t: Affine, x: number, y: number) =>
  transformDab(t, x, y, 0)
    .slice(0, 2)
    .map((v) => Math.round(v * 1000) / 1000 + 0);
const points = (kind: SymmetryKind, n = 6) =>
  symmetryTransforms(kind, n, 50, 40).map((t) => apply(t, 60, 30));

describe('symmetry transforms', () => {
  it('starts with the stroke itself', () => {
    for (const k of ['off', 'vertical', 'radial', 'mandala'] as const)
      expect(points(k)[0]).toEqual([60, 30]);
  });
  it('mirrors across a vertical or horizontal axis through the center', () => {
    expect(points('vertical')).toEqual([
      [60, 30],
      [40, 30],
    ]);
    expect(points('horizontal')).toEqual([
      [60, 30],
      [60, 50],
    ]);
    expect(points('dual')).toEqual([
      [60, 30],
      [40, 30],
      [60, 50],
      [40, 50],
    ]);
  });
  it('mirrors across the diagonal', () => {
    // (10, -10) from the center becomes (-10, 10).
    expect(points('diagonal')[1]).toEqual([40, 50]);
  });
  it('turns radially and adds mirror images for a mandala', () => {
    expect(points('radial', 4)).toEqual([
      [60, 30],
      [60, 50],
      [40, 50],
      [40, 30],
    ]);
    const m = points('mandala', 4);
    expect(m).toHaveLength(8);
    expect(new Set(m.map((p) => p.join())).size).toBe(4);
  });
  it('keeps the segment count in range', () => {
    expect(clampSegments(1)).toBe(2);
    expect(clampSegments(40)).toBe(12);
    expect(clampSegments('x')).toBe(6);
    expect(symmetryTransforms('radial', 99, 0, 0)).toHaveLength(12);
  });
  it('mirrors and turns the tip angle', () => {
    const [mirror] = symmetryTransforms('vertical', 0, 0, 0).slice(1);
    expect(transformDab(mirror, 0, 0, 30)[2]).toBeCloseTo(150);
    const [turn] = symmetryTransforms('radial', 4, 0, 0).slice(1);
    expect(transformDab(turn, 0, 0, 10)[2]).toBeCloseTo(100);
  });
  it('draws one axis line per mirror and one spoke per segment', () => {
    expect(symmetryAxes('off', 6, 0, 0, 10)).toEqual([]);
    expect(symmetryAxes('dual', 6, 0, 0, 10)).toHaveLength(2);
    expect(symmetryAxes('radial', 5, 0, 0, 10)).toHaveLength(5);
  });
});

describe('symmetric strokes', () => {
  it('stamps every dab at its mirrored places in one stroke', () => {
    const store = new TileStore();
    const data = new Uint8ClampedArray(64 * 64 * 4);
    const grid = gridFromImage(store, { width: 64, height: 64, data });
    const s = new StrokeSession(store, grid, {
      tip: { size: 6, hardness: 1, spacing: 0.1, roundness: 1, angle: 0 },
      opacity: 1,
      flow: 1,
      target: { kind: 'color', rgb: [255, 0, 0], mode: 'normal' },
      seed: 3,
      symmetry: symmetryTransforms('dual', 0, 32, 32),
    });
    s.addPoint(10, 12, 1);
    s.addPoint(14, 12, 1);
    const img = readRGBA(store, s.commit(), { x: 0, y: 0, width: 64, height: 64 });
    const alpha = (x: number, y: number) => img.data[(y * 64 + x) * 4 + 3];
    expect(alpha(12, 12)).toBe(255);
    expect(alpha(64 - 12, 12)).toBe(255);
    expect(alpha(12, 64 - 12)).toBe(255);
    expect(alpha(64 - 12, 64 - 12)).toBe(255);
    expect(alpha(32, 32)).toBe(0);
  });
});
