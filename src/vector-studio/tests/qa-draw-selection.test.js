import { describe, it, expect, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}
function drag(app, tool, from, to, mods = {}) {
  tool.onPointerDown(ev(app, from[0], from[1], mods));
  for (let i = 1; i <= 4; i++) tool.onPointerMove(ev(app, from[0] + ((to[0] - from[0]) * i) / 4, from[1] + ((to[1] - from[1]) * i) / 4, mods));
  tool.onPointerUp(ev(app, to[0], to[1], mods));
}
function addRect(app, x, y, w, h, extra = {}) {
  const doc = app.editor.doc;
  const n = createPath(rectangle(x, y, w, h), true, { fill: { type: 'solid', color: '#ff0000' }, ...extra });
  doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
  return doc.get(n.id);
}
const box = (app, id) => {
  const b = nodeBounds(app.editor.doc, app.editor.doc.get(id));
  return [b.x, b.y, b.w, b.h].map((v) => Math.round(v * 100) / 100);
};

describe('Selection tool bounding box', () => {
  let app;
  beforeEach(() => {
    app = bootApp();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    app.setTool('selection');
  });

  it('Shift-dragging a corner handle scales proportionally and keeps the selection', () => {
    const r = addRect(app, 100, 100, 100, 50);
    app.editor.select([r.id]);
    drag(app, app.tool, [200, 150], [300, 160], { shift: true });
    expect(box(app, r.id)).toEqual([100, 100, 200, 100]);
    expect([...app.editor.selection]).toEqual([r.id]);
  });
});

describe('Selection tool Alt mid-drag', () => {
  it('copies when Alt goes down during the drag and moves again when it is released', () => {
    const app = bootApp();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    app.editor.setViewOption('alignmentGuides', false);
    app.setTool('selection');
    const tool = app.tool;
    const r = addRect(app, 100, 100, 100, 50);
    const doc = app.editor.doc;
    tool.onPointerDown(ev(app, 150, 120));
    tool.onPointerMove(ev(app, 170, 120));
    tool.onPointerMove(ev(app, 200, 120, { alt: true }));
    tool.onPointerMove(ev(app, 250, 120, { alt: true }));
    tool.onPointerUp(ev(app, 250, 120, { alt: true }));
    expect(doc.leaves().map((n) => n.anchors[0].x)).toEqual([100, 200]);
    expect(doc.undoLabel).toBe('Duplicate');
    expect(box(app, r.id)).toEqual([100, 100, 100, 50]);
    tool.onPointerDown(ev(app, 250, 120));
    tool.onPointerMove(ev(app, 260, 150, { alt: true }));
    tool.onPointerMove(ev(app, 250, 220));
    tool.onPointerUp(ev(app, 250, 220));
    expect(doc.leaves()).toHaveLength(2);
    expect(doc.undoLabel).toBe('Move');
  });
});

describe('Selection tool Enter', () => {
  it('opens the Move dialog for the selection (and not from other focused controls)', async () => {
    const app = bootApp();
    app.newDocument();
    const r = addRect(app, 0, 0, 10, 10);
    app.setTool('selection');
    const runs = [];
    const run = app.commands.run.bind(app.commands);
    app.commands.run = (id, args) => (runs.push(id), id === 'object.transform.move' ? undefined : run(id, args));
    expect(app.tool.onKeyDown({ key: 'Enter', target: document.body })).toBe(false);
    app.editor.select([r.id]);
    expect(app.tool.onKeyDown({ key: 'Enter', target: document.createElement('button') })).toBe(false);
    expect(app.tool.onKeyDown({ key: 'Enter', target: document.body })).toBe(true);
    expect(runs).toEqual(['object.transform.move']);
  });
});

describe('Shift-constrained moves', () => {
  it('follow the pointer along the constrained axis instead of overshooting', () => {
    const app = bootApp();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    const r = addRect(app, 100, 100, 40, 40);
    app.setTool('selection');
    app.editor.select([r.id]);
    const t = app.tool;
    t.onPointerDown(ev(app, 120, 120));
    t.onPointerMove(ev(app, 150, 122));
    t.onPointerMove(ev(app, 180, 130, { shift: true }));
    t.onPointerUp(ev(app, 180, 130, { shift: true }));
    expect(box(app, r.id)).toEqual([160, 100, 40, 40]);
    app.setTool('direct-selection');
    app.editor.selectAnchors(r.id, [0]);
    const ds = app.tool;
    ds.onPointerDown(ev(app, 160, 100));
    ds.onPointerMove(ev(app, 170, 101));
    ds.onPointerMove(ev(app, 160, 140, { shift: true }));
    ds.onPointerUp(ev(app, 160, 140, { shift: true }));
    expect(app.editor.doc.get(r.id).anchors[0]).toMatchObject({ x: 160, y: 140 });
  });
});

describe('Selection tool Shift-drag', () => {
  it('moves a selected object constrained, and Shift+Alt drags a copy; a plain Shift-click still deselects', () => {
    const app = bootApp();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    app.editor.setViewOption('alignmentGuides', false);
    const r = addRect(app, 100, 100, 40, 40);
    app.setTool('selection');
    app.editor.select([r.id]);
    drag(app, app.tool, [120, 120], [180, 125], { shift: true });
    expect(box(app, r.id)).toEqual([160, 100, 40, 40]);
    drag(app, app.tool, [180, 120], [240, 126], { shift: true, alt: true });
    const doc = app.editor.doc;
    expect(doc.leaves().map((n) => n.anchors[0].x)).toEqual([160, 220]);
    const copy = doc.leaves()[1].id;
    expect([...app.editor.selection]).toEqual([copy]);
    app.tool.onPointerDown(ev(app, 240, 120, { shift: true }));
    app.tool.onPointerUp(ev(app, 240, 120, { shift: true }));
    expect(app.editor.selection.size).toBe(0);
  });
});

describe('marquee in a rotated view', () => {
  // Drag between two screen points (the marquee is upright on screen).
  function marquee(app, tool, a, b, mods = {}) {
    const at = (s) => {
      const p = app.editor.view.toDoc(s[0], s[1]);
      return { x: p.x, y: p.y, sx: s[0], sy: s[1], shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...mods };
    };
    tool.onPointerDown(at(a));
    tool.onPointerMove(at([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]));
    tool.onPointerMove(at(b));
    tool.onPointerUp(at(b));
  }

  function setup() {
    const app = bootApp();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    app.editor.view.rotateView(45);
    const inside = addRect(app, 0, 0, 10, 10);
    const outside = addRect(app, 0, 0, 10, 10);
    // Place both: one under the screen marquee, one off it but inside the document box of its corners.
    // Near a corner of the marquee: the document box between its corner points misses it.
    const s = app.editor.view.toDoc(455, 445);
    const doc = app.editor.doc;
    const off = app.editor.view.toDoc(500, 520);
    doc.transact('Move', () => {
      doc.update(inside.id, { anchors: rectangle(s.x - 5, s.y - 5, 10, 10) });
      doc.update(outside.id, { anchors: rectangle(off.x - 5, off.y - 5, 10, 10) });
    });
    return { app, inside, outside };
  }

  it('selects what the marquee covers on screen with the Selection tool', () => {
    const { app, inside, outside } = setup();
    app.setTool('selection');
    // The screen marquee 440..560 x 340..460 covers the first square only.
    marquee(app, app.tool, [440, 340], [560, 460]);
    expect([...app.editor.selection]).toEqual([inside.id]);
    expect(app.editor.selection.has(outside.id)).toBe(false);
  });

  it('selects the anchors the marquee covers on screen with the Direct Selection tool', () => {
    const { app, inside, outside } = setup();
    app.setTool('direct-selection');
    marquee(app, app.tool, [440, 340], [560, 460]);
    expect(app.editor.selection.has(inside.id)).toBe(true);
    expect(app.editor.selection.has(outside.id)).toBe(false);
  });
});
