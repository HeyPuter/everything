import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { bootApp } from './helpers.js';

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

const key = (type, k = '`') => document.dispatchEvent(new KeyboardEvent(type, { key: k, code: 'Backquote', bubbles: true }));

let app;
beforeEach(() => {
  app = bootApp();
  app.newDocument();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  app.editor.setViewOption('snapToPoint', false);
  app.editor.setViewOption('alignmentGuides', false);
});
afterEach(() => key('keyup'));

function drag(tool, pts) {
  app.setTool(tool);
  const t = app.tool;
  t.onPointerDown(ev(app, ...pts[0]));
  for (const p of pts.slice(1)) t.onPointerMove(ev(app, ...p));
  t.onPointerUp(ev(app, ...pts.at(-1)));
}

const layerKids = () => app.editor.doc.get(app.editor.targetLayer().id).children;

describe('trail key while drawing shapes', () => {
  it('draws one rectangle without the key', () => {
    drag('rectangle', [[100, 100], [120, 120], [140, 150], [200, 200]]);
    expect(layerKids()).toHaveLength(1);
  });

  it('holding ~ leaves a rectangle at every move, in one undo step', () => {
    key('keydown', '~');
    drag('rectangle', [[100, 100], [120, 120], [140, 150], [200, 200], [201, 200]]);
    const kids = layerKids();
    // The last move is closer than the trail spacing, so it resizes the last shape.
    expect(kids).toHaveLength(3);
    expect(app.editor.selection.size).toBe(3);
    const widths = kids.map((id) => app.editor.doc.get(id).shape.w);
    expect(widths).toEqual([20, 40, 101]);
    app.editor.doc.undo();
    expect(layerKids()).toHaveLength(0);
  });

  it('releasing the key mid-drag keeps the trail and resizes the last shape', () => {
    app.setTool('ellipse');
    const t = app.tool;
    key('keydown');
    t.onPointerDown(ev(app, 100, 100));
    t.onPointerMove(ev(app, 120, 120));
    t.onPointerMove(ev(app, 140, 140));
    key('keyup');
    t.onPointerMove(ev(app, 180, 160));
    t.onPointerUp(ev(app, 180, 160));
    const kids = layerKids();
    expect(kids).toHaveLength(2);
    expect(app.editor.doc.get(kids[1]).shape.w).toBe(80);
  });

  it('works for the Line Segment and Spiral tools', () => {
    key('keydown');
    drag('line', [[100, 100], [150, 100], [150, 150], [100, 150]]);
    expect(layerKids()).toHaveLength(3);
    for (const id of layerKids()) expect(app.editor.doc.get(id).shape.kind).toBe('line');
    drag('spiral', [[400, 400], [450, 400], [400, 450]]);
    expect(layerKids()).toHaveLength(5);
  });

  it('ignores the key while typing in a field', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote', bubbles: true }));
    drag('rectangle', [[100, 100], [120, 120], [200, 200]]);
    expect(layerKids()).toHaveLength(1);
    input.remove();
  });
});
