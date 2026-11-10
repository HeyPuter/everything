// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { recordDrawing } from '../src/ui/dialogs.js';
import { Drawing } from '../src/core/drawing.js';
import { SpatialIndex } from '../src/core/spatial.js';

/** Width of the marker recorded for one point in a drawing of the given extent. */
function markerWidth(extent, opts = {}, header = {}) {
  const drawing = new Drawing();
  Object.assign(drawing.header, { pdmode: 3, pdsize: 0 }, header);
  drawing.transaction('t', () => {
    drawing.add({ type: 'point', x: extent * 0.75, y: extent / 4 });
    drawing.add({ type: 'line', x1: 0, y1: 0, x2: extent, y2: extent });
  });
  const app = { doc: { drawing, index: new SpatialIndex(drawing) } };
  const area = [0, 0, extent, extent];
  const items = recordDrawing(app, { area, tol: extent / 20000, ...opts });
  let lo = Infinity,
    hi = -Infinity;
  for (const it of items) {
    // not the diagonal line that gives the drawing its size
    if (it.pts?.length !== 4 || (it.pts[0] === 0 && it.pts[1] === 0 && it.pts[2] === extent)) continue;
    lo = Math.min(lo, it.pts[0], it.pts[2]);
    hi = Math.max(hi, it.pts[0], it.pts[2]);
  }
  return hi - lo;
}

describe('point markers in exported and plotted drawings', () => {
  it('have a size that follows the output, as they follow the screen', () => {
    // One drawing unit across whatever the drawing size: a speck in a building
    // plan in millimetres, a blot over a part drawn in metres.
    for (const extent of [1, 420, 100000]) {
      const w = markerWidth(extent);
      expect(w / extent).toBeGreaterThan(1 / 500);
      expect(w / extent).toBeLessThan(1 / 100);
    }
  });

  it('take the size asked for, and a set point size as it is', () => {
    expect(markerWidth(1000, { pointSize: 7 })).toBeCloseTo(7, 9);
    expect(markerWidth(1000, {}, { pdsize: 25 })).toBeCloseTo(25, 9);
  });
});
