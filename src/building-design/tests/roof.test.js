import { describe, it, expect } from 'vitest';
import { roofFaces, roofPlanes, roofHeightAt } from '../src/core/roof.js';
import { area } from '../src/core/geom.js';

const rect = [
  [0, 0],
  [10000, 0],
  [10000, 6000],
  [0, 6000],
];

describe('footprint roofs', () => {
  it('builds a hip roof with four faces and a ridge at mid depth', () => {
    const { faces, planes, ridges } = roofFaces(rect, [30, 30, 30, 30]);
    expect(faces).toHaveLength(4);
    const total = faces.reduce((s, f) => s + area(f.poly), 0);
    expect(total).toBeCloseTo(60e6, -3);
    // Ridge height: 3000 inward at 30 degrees.
    expect(roofHeightAt(planes, [5000, 3000])).toBeCloseTo(3000 * Math.tan(Math.PI / 6), 3);
    expect(ridges.length).toBeGreaterThanOrEqual(5);
  });

  it('builds a gable roof when two edges do not define slope', () => {
    const { faces } = roofFaces(rect, [30, null, 30, null]);
    expect(faces).toHaveLength(2);
    for (const f of faces) expect(area(f.poly)).toBeCloseTo(30e6, -3);
  });

  it('is flat without sloped edges', () => {
    const { faces } = roofFaces(rect, [null, null, null, null]);
    expect(faces).toHaveLength(1);
    expect(faces[0].plane).toBeNull();
  });

  it('keeps edge slopes attached when the footprint is clockwise', () => {
    const cw = rect.slice().reverse();
    // Clockwise edge 0 runs from (0,6000) to (10000,6000): the north edge.
    const { planes } = roofPlanes(cw, [45, null, null, null]);
    expect(planes).toHaveLength(1);
    expect(roofHeightAt(planes, [5000, 5000])).toBeCloseTo(1000, 3);
  });
});
