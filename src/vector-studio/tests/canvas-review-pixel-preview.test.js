import { describe, it, expect } from 'vitest';
import { pixelPreviewGrid } from '../src/render/canvas-view.js';
import { Viewport } from '../src/render/viewport.js';

function view(props) {
  const v = new Viewport();
  v.set({ width: 800, height: 600, dpr: 1, ...props });
  return v;
}

describe('Pixel Preview grid', () => {
  it('puts its pixels on document pixel edges, wherever the view is scrolled', () => {
    for (const [zoom, panX, panY, dpr] of [
      [12, 106.3, 100, 1],
      [12.5, 103.1, -57.25, 1],
      [3, 101.2, 7, 2],
      [8, -1234.5, 999.75, 2],
    ]) {
      const v = view({ zoom, panX, panY, dpr });
      const g = pixelPreviewGrid(v, 800 * dpr, 600 * dpr);
      expect(g.s).toBeCloseTo(zoom * dpr, 9);
      // Every block edge is the device position of a whole document coordinate.
      const docX = v.toDoc((g.x0 + 5 * g.s) / dpr, 0).x;
      const docY = v.toDoc(0, (g.y0 + 7 * g.s) / dpr).y;
      expect(Math.abs(docX - Math.round(docX))).toBeLessThan(1e-6);
      expect(Math.abs(docY - Math.round(docY))).toBeLessThan(1e-6);
      // The blocks cover the whole canvas.
      expect(g.x0).toBeLessThanOrEqual(0);
      expect(g.y0).toBeLessThanOrEqual(0);
      expect(g.x0 + g.w * g.s).toBeGreaterThanOrEqual(800 * dpr);
      expect(g.y0 + g.h * g.s).toBeGreaterThanOrEqual(600 * dpr);
    }
  });

  it('shows pixels once a document pixel is larger than a device pixel', () => {
    expect(pixelPreviewGrid(view({ zoom: 1 }), 800, 600)).toBeNull();
    expect(pixelPreviewGrid(view({ zoom: 1, dpr: 2 }), 1600, 1200)?.s).toBe(2);
  });
});
