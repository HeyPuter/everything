import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';

function ev(app, sx, sy, extra = {}) {
  const p = app.editor.view.toDoc(sx, sy);
  return { x: p.x, y: p.y, sx, sy, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

/** Drag the Zoom tool across a screen rectangle. */
function marquee(app, sx0, sy0, sx1, sy1) {
  const t = app.tool;
  t.onPointerDown(ev(app, sx0, sy0));
  t.onPointerMove(ev(app, (sx0 + sx1) / 2, (sy0 + sy1) / 2));
  t.onPointerMove(ev(app, sx1, sy1));
  t.onPointerUp(ev(app, sx1, sy1));
}

describe('Zoom tool marquee', () => {
  it('zooms into the area dragged across', () => {
    const app = bootApp();
    const ed = app.newDocument();
    const v = ed.view;
    v.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    app.setTool('zoom');
    marquee(app, 100, 100, 300, 200);
    expect(v.zoom).toBeCloseTo(5);
    const c = v.toScreen(200, 150);
    expect(c.x).toBeCloseTo(500);
    expect(c.y).toBeCloseTo(400);
  });

  it('keeps the view rotation and zooms into what the marquee covered', () => {
    const app = bootApp();
    const ed = app.newDocument();
    const v = ed.view;
    v.set({ zoom: 2, panX: 300, panY: 100, rotation: 30, width: 1000, height: 800 });
    app.setTool('zoom');
    const corner = v.toDoc(300, 200);
    const center = v.toDoc(400, 250);
    marquee(app, 300, 200, 500, 300);
    expect(v.rotation).toBe(30);
    expect(v.zoom).toBeCloseTo(2 * 5);
    // The marquee's middle is in the middle of the view, and its corner at the view's left edge.
    const c = v.toScreen(center.x, center.y);
    expect(c.x).toBeCloseTo(500);
    expect(c.y).toBeCloseTo(400);
    const k = v.toScreen(corner.x, corner.y);
    expect(k.x).toBeCloseTo(0);
    expect(k.y).toBeCloseTo(150);
  });
});
