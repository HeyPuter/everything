import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

function ev(app, x, y) {
  const s = app.editor.view.toScreen(x, y);
  return {
    x,
    y,
    sx: s.x,
    sy: s.y,
    shift: false,
    alt: false,
    mod: false,
    button: 0,
    pointerType: 'mouse',
    pressure: 0.5,
    native: {},
  };
}

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

describe('Perspective Selection marquee in a rotated view', () => {
  it('selects what the drawn (screen-upright) marquee covers', () => {
    const ed = app.newDocument();
    ed.view.set({ zoom: 1, panX: 300, panY: 300, rotation: 0, width: 1000, height: 900 });
    ed.view.rotateView(45);
    const p = createPath(rectangle(45, 15, 10, 10), true, {
      fill: { type: 'solid', color: '#ff0000' },
    });
    ed.doc.transact('Add', () => ed.doc.insert(p, ed.targetLayer().id));
    ed.clearSelection();
    app.setTool('perspective-select');
    const t = app.tool;
    // From doc (0, 0) to (100, 0): on screen a square standing on its corner around the object.
    t.onPointerDown(ev(app, 0, 0));
    t.onPointerMove(ev(app, 50, 0));
    t.onPointerMove(ev(app, 100, 0));
    t.onPointerUp(ev(app, 100, 0));
    expect([...ed.selection]).toEqual([p.id]);
    app.setTool('selection');
  });
});
