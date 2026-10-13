import { describe, it, expect, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { regularStarInner, skewedSteps } from '../src/model/shapes.js';

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

let app;
beforeEach(() => {
  app = bootApp();
  app.newDocument();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  app.editor.setViewOption('snapToPoint', false);
  app.editor.setViewOption('alignmentGuides', false);
});

/** Start a drag with the active tool and move it to (x, y). */
function dragTo(x0, y0, x, y, mods = {}) {
  const t = app.tool;
  t.onPointerDown(ev(app, x0, y0));
  t.onPointerMove(ev(app, (x0 + x) / 2, (y0 + y) / 2, mods));
  t.onPointerMove(ev(app, x, y, mods));
  return t;
}

describe('tool options dialogs', () => {
  it('double-clicking a shape tool opens its options and keeps them for the next shapes', async () => {
    app.setTool('line');
    let seen = null;
    app.dialogs.form = async (spec) => {
      seen = spec;
      return { len: 50, angle: 90, fill: true };
    };
    await app.tool.openOptions();
    expect(seen.title).toBe('Line Segment Tool Options');
    expect(seen.fields.map((f) => f.key)).toEqual(['len', 'angle', 'fill']);
    expect(app.prefs.get('toolOptions.line')).toMatchObject({ len: 50, angle: 90, fill: true });
    // The next dialog starts from the stored values.
    await app.tool.openOptions();
    expect(seen.fields.find((f) => f.key === 'len').value).toBe(50);
    // A dragged line keeps the fill option.
    const t = dragTo(100, 100, 200, 100);
    t.onPointerUp(ev(app, 200, 100));
    expect(app.editor.selectedNodes()[0].fill).not.toBe(null);
  });

  it('every grid, arc and spiral tool has an options dialog', async () => {
    for (const id of ['arc', 'spiral', 'rect-grid', 'polar-grid']) {
      app.setTool(id);
      let spec = null;
      app.dialogs.form = async (s) => {
        spec = s;
        return null;
      };
      await app.tool.openOptions();
      expect(spec?.fields.length, id).toBeGreaterThan(2);
    }
  });
});

describe('Arc tool', () => {
  it('changes slope, closes and swaps the base axis with keys while dragging', () => {
    app.setTool('arc');
    const t = dragTo(100, 100, 200, 200);
    let n = app.editor.selectedNodes()[0];
    // Convex along x: the start handle points along x.
    expect(n.anchors[0].oy).toBe(100);
    expect(n.anchors[0].ox).toBeGreaterThan(100);
    expect(t.onKeyDown({ key: 'c' })).toBe(true);
    n = app.editor.selectedNodes()[0];
    expect(n.closed).toBe(true);
    expect(n.anchors).toHaveLength(3);
    expect(n.anchors[2]).toMatchObject({ x: 100, y: 200 });
    t.onKeyDown({ key: 'f' });
    n = app.editor.selectedNodes()[0];
    expect(n.anchors[0].ox).toBe(100);
    expect(n.anchors[0].oy).toBeGreaterThan(100);
    t.onKeyDown({ key: 'x' });
    n = app.editor.selectedNodes()[0];
    // Base y with a concave slope leaves along x again.
    expect(n.anchors[0].oy).toBe(100);
    t.onKeyDown({ key: 'ArrowUp' });
    expect(app.tool.options.slope).toBe(-40);
    t.onPointerUp(ev(app, 200, 200));
    expect(app.editor.doc.leaves()).toHaveLength(1);
    // The options persist for the next arc.
    expect(app.prefs.get('toolOptions.arc')).toMatchObject({ closed: true, base: 'y', slope: -40 });
    app.commands.run('edit.undo');
    expect(app.editor.doc.leaves()).toHaveLength(0);
  });

  it('a flat slope draws a straight segment', () => {
    app.prefs.set('toolOptions.arc', { slope: 0 });
    app.setTool('arc');
    const t = dragTo(0, 0, 100, 50);
    t.onPointerUp(ev(app, 100, 50));
    const [a, b] = app.editor.selectedNodes()[0].anchors;
    expect([a.ox, a.oy, b.ix, b.iy]).toEqual([0, 0, 100, 50]);
  });
});

describe('Spiral tool', () => {
  it('R reverses the winding and Command-drag changes the decay', () => {
    app.setTool('spiral');
    const t = dragTo(300, 300, 300, 200);
    const before = app.editor.selectedNodes()[0].anchors[1];
    t.onKeyDown({ key: 'r' });
    const after = app.editor.selectedNodes()[0].anchors[1];
    expect(after.x).toBeCloseTo(600 - before.x);
    const d0 = app.tool.options.decay;
    t.onPointerMove(ev(app, 300, 200, { mod: true }));
    t.onPointerMove(ev(app, 300, 160, { mod: true }));
    expect(app.tool.options.decay).toBeCloseTo(d0 + 10);
    t.onPointerUp(ev(app, 300, 160));
    expect(app.editor.doc.leaves()).toHaveLength(1);
  });
});

describe('grid tools', () => {
  it('skews rectangular grid rows and columns with F/V and X/C', () => {
    app.setTool('rect-grid');
    const t = dragTo(0, 0, 100, 100);
    t.onKeyDown({ key: 'v' });
    t.onKeyDown({ key: 'v' });
    t.onKeyDown({ key: 'x' });
    t.onPointerUp(ev(app, 100, 100));
    const g = app.editor.selectedNodes()[0];
    const kids = g.children.map((c) => app.editor.doc.get(c));
    const horiz = kids.filter((k) => !k.closed && k.anchors[0].y === k.anchors[1].y).map((k) => k.anchors[0].y);
    const vert = kids.filter((k) => !k.closed && k.anchors[0].x === k.anchors[1].x).map((k) => k.anchors[0].x);
    expect(horiz).toEqual(skewedSteps(5, 20).map((f) => f * 100));
    expect(vert).toEqual(skewedSteps(5, -10).map((f) => f * 100));
    // Rows bunch toward the bottom, columns toward the left.
    expect(horiz[0]).toBeGreaterThan(20);
    expect(vert[0]).toBeLessThan(20);
  });

  it('draws the outside as four lines without the frame option', () => {
    app.prefs.set('toolOptions.rect-grid', { frame: false, rows: 1, cols: 1 });
    app.setTool('rect-grid');
    const t = dragTo(0, 0, 100, 100);
    t.onPointerUp(ev(app, 100, 100));
    const g = app.editor.selectedNodes()[0];
    expect(g.children).toHaveLength(4 + 2);
    expect(g.children.every((c) => !app.editor.doc.get(c).closed)).toBe(true);
  });

  it('makes a compound path of the polar grid ellipses', () => {
    app.prefs.set('toolOptions.polar-grid', { compound: true, fill: true, rings: 2, dividers: 4 });
    app.setTool('polar-grid');
    const t = dragTo(0, 0, 100, 100);
    t.onKeyDown({ key: 'ArrowUp' });
    t.onPointerUp(ev(app, 100, 100));
    const g = app.editor.selectedNodes()[0];
    const kids = g.children.map((c) => app.editor.doc.get(c));
    const compound = kids.find((k) => k.type === 'compound');
    expect(compound.children).toHaveLength(4);
    expect(compound.fillRule).toBe('evenodd');
    expect(kids.filter((k) => k.type === 'path')).toHaveLength(4);
  });
});

describe('Star tool modifiers', () => {
  it('Command keeps the inner radius and Option straightens the sides', () => {
    app.setTool('star');
    const t = dragTo(300, 300, 300, 200);
    expect(app.editor.selectedNodes()[0].shape.r2).toBeCloseTo(50);
    t.onPointerMove(ev(app, 300, 150, { mod: true }));
    t.onPointerMove(ev(app, 300, 100, { mod: true }));
    let s = app.editor.selectedNodes()[0].shape;
    expect(s.r1).toBeCloseTo(200);
    expect(s.r2).toBeCloseTo(50);
    t.onPointerMove(ev(app, 300, 100, { alt: true }));
    s = app.editor.selectedNodes()[0].shape;
    expect(s.r2).toBeCloseTo(regularStarInner(200, 5));
    t.onPointerUp(ev(app, 300, 100, { alt: true }));
  });
});

describe('shape keys over command shortcuts', () => {
  it('F flips the arc base while dragging instead of changing the screen mode', () => {
    app.setTool('arc');
    dragTo(100, 100, 200, 200);
    const before = app.prefs.get('screenMode');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true }));
    expect(app.tool.options.base).toBe('y');
    expect(app.prefs.get('screenMode')).toBe(before);
    expect(app.root.className).not.toMatch(/screen-full/);
    app.tool.onPointerUp(ev(app, 200, 200));
  });
});
