import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

/** A context that records the outline points it is asked to draw. */
function recordingCtx() {
  const pts = [];
  const rects = [];
  const noop = () => {};
  return {
    pts,
    rects,
    ctx: new Proxy(
      {
        moveTo: (x, y) => pts.push([x, y]),
        lineTo: (x, y) => pts.push([x, y]),
        strokeRect: (x, y, w, h) => rects.push([x, y, w, h]),
      },
      { get: (t, k) => (k in t ? t[k] : noop), set: () => true },
    ),
  };
}

describe('Artboard tool in a rotated view', () => {
  it('outlines the artboards along their turned edges, not as upright screen rectangles', () => {
    const ed = app.newDocument({ name: 'Turned boards', width: 200, height: 100 });
    ed.view.set({ zoom: 1, panX: 300, panY: 300 });
    ed.view.rotateView(30);
    app.setTool('artboard');
    const { ctx, pts, rects } = recordingCtx();
    app.tool.drawOverlay(ctx, ed, { selection: '#00f' });
    const a = ed.doc.artboards[0];
    for (const [x, y] of [
      [a.x, a.y],
      [a.x + a.w, a.y],
      [a.x + a.w, a.y + a.h],
      [a.x, a.y + a.h],
    ]) {
      const s = ed.view.toScreen(x, y);
      expect(
        pts.some(([px, py]) => Math.abs(px - s.x) < 1 && Math.abs(py - s.y) < 1),
        `corner ${x},${y}`,
      ).toBe(true);
    }
    // Only the 7 px handles are drawn as screen rectangles.
    expect(rects.every(([, , w, h]) => w === 7 && h === 7)).toBe(true);
    app.setTool('selection');
  });

  it('shows resize cursors that follow the handles on screen', () => {
    const ed = app.newDocument({ name: 'Quarter turn', width: 200, height: 100 });
    ed.view.set({ zoom: 1, panX: 300, panY: 300 });
    ed.view.rotateView(90);
    app.setTool('artboard');
    const a = ed.doc.artboards[0];
    const cursors = [];
    const set = app.setCanvasCursor;
    app.setCanvasCursor = (c) => cursors.push(c);
    try {
      const s = ed.view.toScreen(a.x + a.w, a.y + a.h / 2); // the east handle, now below the board
      app.tool.onHover({ ...ed.view.toDoc(s.x, s.y), sx: s.x, sy: s.y });
    } finally {
      app.setCanvasCursor = set;
    }
    expect(cursors.at(-1)).toBe('ns-resize');
    app.setTool('selection');
  });
});
