import { describe, it, expect, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';
import { boxHandles } from '../src/render/overlay.js';

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

function addRect(x, y, w, h, parent) {
  const doc = app.editor.doc;
  const node = createPath(rectangle(x, y, w, h), true, { fill: { type: 'solid', color: '#cc3333' }, stroke: null });
  doc.transact('Add', () => doc.insert(node, parent || app.editor.targetLayer().id));
  return node.id;
}

const bounds = (id) => nodeBounds(app.editor.doc, app.editor.doc.get(id));

describe('Selection tool', () => {
  it('Shift+Alt on a corner handle scales proportionally from the center', () => {
    const id = addRect(100, 100, 100, 50);
    app.setTool('selection');
    app.editor.select([id]);
    const t = app.tool;
    const h = boxHandles(app.editor, app.editor.selectionFrame());
    const se = app.editor.view.toDoc(h.se.x, h.se.y);
    t.onPointerDown(ev(app, se.x, se.y));
    t.onPointerMove(ev(app, se.x + 20, se.y + 5, { shift: true, alt: true }));
    t.onPointerMove(ev(app, se.x + 50, se.y + 10, { shift: true, alt: true }));
    t.onPointerUp(ev(app, se.x + 50, se.y + 10, { shift: true, alt: true }));
    const b = bounds(id);
    // Center stays at (150, 125); the larger factor (2x across) wins for both axes.
    expect(b.x + b.w / 2).toBeCloseTo(150);
    expect(b.y + b.h / 2).toBeCloseTo(125);
    expect(b.w / b.h).toBeCloseTo(2);
    expect(b.w).toBeCloseTo(200);
  });

  it('rotates from just outside a corner, in 45 degree steps with Shift', () => {
    const id = addRect(100, 100, 100, 100);
    app.setTool('selection');
    app.editor.select([id]);
    const t = app.tool;
    const h = boxHandles(app.editor, app.editor.selectionFrame());
    // 10 px diagonally outside the top-right corner.
    const sx = h.ne.x + 7;
    const sy = h.ne.y - 7;
    expect(t.boxPartAt(sx, sy)).toBe('rotate-ne');
    const p0 = app.editor.view.toDoc(sx, sy);
    t.onPointerDown(ev(app, p0.x, p0.y));
    // About 50 degrees clockwise around the center (150, 150).
    const a = Math.atan2(p0.y - 150, p0.x - 150) + (50 * Math.PI) / 180;
    const r = Math.hypot(p0.x - 150, p0.y - 150);
    t.onPointerMove(ev(app, 150 + Math.cos(a) * r, 150 + Math.sin(a) * r, { shift: true }));
    t.onPointerUp(ev(app, 150 + Math.cos(a) * r, 150 + Math.sin(a) * r, { shift: true }));
    const n = app.editor.doc.get(id);
    // A 45 degree turn of the square: its first corner moved onto the vertical through the center.
    expect(n.anchors[0].x).toBeCloseTo(150, 3);
    expect(Math.min(...n.anchors.map((q) => q.y))).toBeCloseTo(150 - 50 * Math.SQRT2, 3);
  });

  it('highlights the object under the pointer and double-click isolates a group', () => {
    const g = createGroup([]);
    const doc = app.editor.doc;
    doc.transact('Group', () => doc.insert(g, app.editor.targetLayer().id));
    const inner = addRect(300, 300, 50, 50, g.id);
    app.setTool('selection');
    app.tool.onHover(ev(app, 320, 320));
    expect(app.editor.hover).toBe(g.id);
    app.tool.onDoubleClick(ev(app, 320, 320));
    expect(app.editor.isolation).toBe(g.id);
    app.tool.onPointerDown(ev(app, 320, 320));
    app.tool.onPointerUp(ev(app, 320, 320));
    expect([...app.editor.selection]).toEqual([inner]);
    // Double-click outside leaves isolation.
    app.tool.onDoubleClick(ev(app, 700, 700));
    expect(app.editor.isolation).toBeFalsy();
  });
});

describe('Direct Selection tool', () => {
  it('Shift-drag of an anchor follows the Constrain Angle', () => {
    app.prefs.set('constrainAngle', 30);
    const id = addRect(100, 100, 100, 100);
    app.setTool('direct-selection');
    const t = app.tool;
    t.onPointerDown(ev(app, 200, 100));
    // Mostly along 30 degrees (up and to the right on screen).
    const a = (-30 * Math.PI) / 180;
    t.onPointerMove(ev(app, 200 + Math.cos(a) * 100 + 3, 100 + Math.sin(a) * 100 + 4, { shift: true }));
    t.onPointerUp(ev(app, 200 + Math.cos(a) * 100 + 3, 100 + Math.sin(a) * 100 + 4, { shift: true }));
    const p = app.editor.doc.get(id).anchors[1];
    const ang = (-Math.atan2(p.y - 100, p.x - 200) * 180) / Math.PI;
    expect(ang).toBeCloseTo(30, 5);
  });

  it('nudges selected anchors with the arrow keys, 10x with Shift', () => {
    const id = addRect(100, 100, 100, 100);
    app.setTool('direct-selection');
    app.tool.onPointerDown(ev(app, 200, 200));
    app.tool.onPointerUp(ev(app, 200, 200));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true, bubbles: true }));
    const n = app.editor.doc.get(id);
    expect(n.anchors[2]).toMatchObject({ x: 201, y: 210 });
    expect(n.anchors[0]).toMatchObject({ x: 100, y: 100 });
  });
});

describe('Pen tool', () => {
  it('constrains the rubber band preview with Shift', () => {
    app.setTool('pen');
    const pen = app.tool;
    pen.onPointerDown(ev(app, 100, 100));
    pen.onPointerUp(ev(app, 100, 100));
    pen.onHover(ev(app, 200, 110, { shift: true }));
    expect(pen.cursorPt.y).toBeCloseTo(100);
    pen.onHover(ev(app, 200, 110));
    expect(pen.cursorPt.y).toBe(110);
  });
});

describe('transform tools', () => {
  it('drags the reference point marker, then rotates around the new point', () => {
    const id = addRect(100, 100, 100, 100);
    app.editor.select([id]);
    app.setTool('rotate');
    const t = app.tool;
    t.onPointerDown(ev(app, 150, 150));
    t.onPointerMove(ev(app, 120, 140));
    t.onPointerMove(ev(app, 100, 100));
    t.onPointerUp(ev(app, 100, 100));
    // The object did not move; the reference point did.
    expect(bounds(id)).toMatchObject({ x: 100, y: 100, w: 100, h: 100 });
    expect(t.currentOrigin()).toMatchObject({ x: 100, y: 100 });
    t.onPointerDown(ev(app, 200, 100));
    t.onPointerMove(ev(app, 150, 150));
    t.onPointerMove(ev(app, 100, 200));
    t.onPointerUp(ev(app, 100, 200));
    // A quarter turn clockwise around the top-left corner.
    expect(bounds(id).x).toBeCloseTo(0);
    expect(bounds(id).y).toBeCloseTo(100);
  });

  it('Alt-drag with the Scale tool scales a copy', () => {
    const id = addRect(100, 100, 100, 100);
    app.editor.select([id]);
    app.setTool('scale');
    const t = app.tool;
    t.onPointerDown(ev(app, 200, 200));
    t.onPointerMove(ev(app, 220, 220, { alt: true }));
    t.onPointerMove(ev(app, 250, 250, { alt: true }));
    t.onPointerUp(ev(app, 250, 250, { alt: true }));
    expect(app.editor.doc.leaves()).toHaveLength(2);
    expect(bounds(id)).toMatchObject({ x: 100, y: 100, w: 100, h: 100 });
    const copy = [...app.editor.selection][0];
    expect(copy).not.toBe(id);
    expect(bounds(copy).w).toBeCloseTo(200);
  });
});
