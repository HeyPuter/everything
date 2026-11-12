import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { addSlice, slicesOf } from '../src/features/slices/model.js';

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

const ev = (ed, x, y) => {
  const s = ed.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0 };
};

describe('Escape during a slice drag', () => {
  it('Slice Selection: puts the slice back and clears the drag feedback at once', () => {
    const ed = app.newDocument({ width: 200, height: 100 });
    ed.view.set({ width: 800, height: 600, zoom: 1, panX: 0, panY: 0 });
    const doc = ed.doc;
    doc.transact('s', () => addSlice(doc, { kind: 'user', x: 10, y: 10, w: 40, h: 20 }));
    app.setTool('slice-select');
    const t = app.tool;
    t.onPointerDown(ev(ed, 20, 20));
    t.onPointerMove(ev(ed, 40, 30));
    expect(ed.feedback).toBeTruthy();
    let redrawn = false;
    const off = ed.on('overlay', () => (redrawn = true));
    t.cancel();
    off();
    expect(slicesOf(doc)[0]).toMatchObject({ x: 10, y: 10 });
    expect(ed.feedback).toBe(null);
    expect(redrawn).toBe(true);
    app.setTool('selection');
  });

  it('Slice: removes the slice outline being drawn at once', () => {
    const ed = app.newDocument({ width: 200, height: 100 });
    ed.view.set({ width: 800, height: 600, zoom: 1, panX: 0, panY: 0 });
    app.setTool('slice');
    const t = app.tool;
    t.onPointerDown(ev(ed, 10, 10));
    t.onPointerMove(ev(ed, 60, 40));
    let redrawn = false;
    const off = ed.on('overlay', () => (redrawn = true));
    t.cancel();
    off();
    expect(ed.feedback).toBe(null);
    expect(redrawn).toBe(true);
    app.setTool('selection');
  });

  it('Slice Selection: resize cursors follow the handles in a rotated view', () => {
    const ed = app.newDocument({ width: 200, height: 100 });
    ed.view.set({ width: 800, height: 600, zoom: 1, panX: 300, panY: 300 });
    ed.view.rotateView(90);
    const doc = ed.doc;
    doc.transact('s', () => addSlice(doc, { kind: 'user', x: 10, y: 10, w: 40, h: 20 }));
    app.setTool('slice-select');
    const t = app.tool;
    t.onPointerDown(ev(ed, 20, 20));
    t.onPointerUp(ev(ed, 20, 20));
    const cursors = [];
    const set = app.setCanvasCursor;
    app.setCanvasCursor = (c) => cursors.push(c);
    try {
      t.onHover(ev(ed, 50, 20)); // the east handle, below the slice on screen
    } finally {
      app.setCanvasCursor = set;
    }
    expect(cursors.at(-1)).toBe('ns-resize');
    app.setTool('selection');
  });
});
