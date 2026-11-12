import { describe, it, expect, beforeAll } from 'vitest';
import { bootApp } from './helpers.js';

let clock = 0;
const ptr = (x, y) => ({
  pointerId: 1,
  pointerType: 'mouse',
  button: 0,
  clientX: x,
  clientY: y,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  timeStamp: (clock += 1000),
});
const click = (app, x, y) => {
  app.input.down(ptr(x, y));
  app.input.up(ptr(x, y));
};

describe('Pen alignment guides', () => {
  let app;
  beforeAll(() => {
    app = bootApp();
    app.newDocument();
  });

  it('line a new anchor up with the anchors of the path being drawn', () => {
    const ed = app.editor;
    ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    ed.setViewOption('alignmentGuides', true);
    app.setTool('pen');
    click(app, 100, 100);
    click(app, 300, 100);
    click(app, 300, 300);
    // 3 px right of the first anchor's x: the guide puts it straight below it.
    click(app, 103, 340);
    const p = ed.doc.get(app.tool.pathId);
    expect(p.anchors.map((a) => [a.x, a.y])).toEqual([
      [100, 100],
      [300, 100],
      [300, 300],
      [100, 340],
    ]);
    app.tool.finish();
    app.setTool('selection');
  });
});
