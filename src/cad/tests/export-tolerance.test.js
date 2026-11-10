// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { exportTolerance } from '../src/ui/dialogs.js';
import { arcSegments } from '../src/core/geom/tessellate.js';

describe('curve tolerance of the Export dialog', () => {
  const a3 = [0, 0, 420, 297];

  it('keeps small circles round in vector files', () => {
    // A 3 mm circle on an A3-sized drawing was a 9-gon in SVG and PDF.
    for (const kind of ['svg', 'pdf']) {
      const tol = exportTolerance(kind, a3);
      expect(arcSegments(1.5, 2 * Math.PI, tol)).toBeGreaterThanOrEqual(18);
      // 0.02 mm on the A3 page, as in a plot
      expect(tol).toBeCloseTo(0.021, 3);
    }
  });

  it('follows the width of a PNG, to half a pixel', () => {
    expect(exportTolerance('png', a3, 2400)).toBeCloseTo(420 / 4800, 9);
    expect(exportTolerance('png', a3, 16000)).toBeCloseTo(420 / 32000, 9);
    // never coarser than before for small images
    expect(exportTolerance('png', a3, 100)).toBeCloseTo(420 / 4000, 9);
    expect(exportTolerance('png', a3, NaN)).toBeCloseTo(420 / 4800, 9);
  });
});
