import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { drawMode } from '../src/features/draw-modes/index.js';

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

let app;
beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  app.editor.setViewOption('snapToPoint', false);
  app.editor.setViewOption('alignmentGuides', false);
});

function addRect(x, y, w, h) {
  const doc = app.editor.doc;
  const node = createPath(rectangle(x, y, w, h), true, { fill: { type: 'solid', color: '#3366cc' }, stroke: { type: 'solid', color: '#000000' }, strokeWidth: 2 });
  doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
  return node.id;
}

function drawRect(x0, y0, x1, y1) {
  app.setTool('rectangle');
  const t = app.tool;
  t.onPointerDown(ev(app, x0, y0));
  t.onPointerMove(ev(app, (x0 + x1) / 2, (y0 + y1) / 2));
  t.onPointerMove(ev(app, x1, y1));
  t.onPointerUp(ev(app, x1, y1));
  return app.editor.selectedNodes()[0].id;
}

describe('drawing modes', () => {
  it('Draw Behind puts new artwork behind the selection, or at the bottom of the layer', () => {
    const a = addRect(0, 0, 50, 50);
    const b = addRect(100, 0, 50, 50);
    app.editor.select([b]);
    app.commands.run('view.drawMode.behind');
    expect(drawMode(app.editor)).toBe('behind');
    const c = drawRect(200, 200, 260, 260);
    const layer = app.editor.targetLayer();
    expect(app.editor.doc.get(layer.id).children).toEqual([a, c, b]);
    app.editor.clearSelection();
    const d = drawRect(300, 300, 360, 360);
    expect(app.editor.doc.get(layer.id).children[0]).toBe(d);
    app.commands.run('view.drawMode.normal');
    const e = drawRect(400, 400, 460, 460);
    expect(app.editor.doc.get(layer.id).children.at(-1)).toBe(e);
  });

  it('Draw Inside makes the selected path a clipping path for what is drawn next', () => {
    const frame = addRect(0, 0, 100, 100);
    const doc = app.editor.doc;
    app.editor.select([frame]);
    app.commands.run('view.drawMode.inside');
    expect(drawMode(app.editor)).toBe('inside');
    const inner = drawRect(50, 50, 150, 150);
    const g = doc.get(doc.get(frame).parent);
    expect(g.type).toBe('group');
    expect(g.clip).toBe(true);
    // Background copy (fill only), the new artwork, then the clipping path on top.
    expect(g.children).toHaveLength(3);
    expect(g.children[1]).toBe(inner);
    expect(g.children[2]).toBe(frame);
    expect(doc.get(g.children[0]).fill.color).toBe('#3366cc');
    expect(doc.get(g.children[0]).stroke).toBe(null);
    expect(doc.get(frame).fill).toBe(null);
    expect(doc.get(frame).stroke.color).toBe('#000000');
    // The next drawing goes in the same group, above the first.
    const more = drawRect(10, 10, 30, 30);
    expect(doc.get(g.id).children).toEqual([g.children[0], inner, more, frame]);
    // One undo removes the drawing and the clipping group it created.
    app.commands.run('edit.undo');
    app.commands.run('edit.undo');
    expect(doc.get(frame).parent).toBe(app.editor.targetLayer().id);
    expect(doc.get(frame).fill.color).toBe('#3366cc');
  });

  it('Shift+D cycles the modes, skipping Draw Inside without a path selected', () => {
    const key = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', code: 'KeyD', shiftKey: true, bubbles: true }));
    key();
    expect(drawMode(app.editor)).toBe('behind');
    key();
    expect(drawMode(app.editor)).toBe('normal');
    const r = addRect(0, 0, 10, 10);
    app.editor.select([r]);
    key();
    key();
    expect(drawMode(app.editor)).toBe('inside');
    const btn = app.toolbar.el.querySelector('.draw-mode-btn');
    expect(btn.getAttribute('aria-label')).toBe('Drawing Modes: Draw Inside');
    // Deleting the object returns to Draw Normal.
    app.commands.run('edit.clear');
    expect(drawMode(app.editor)).toBe('normal');
  });

  it('Draw Inside needs a path selected', () => {
    app.commands.run('view.drawMode.inside');
    expect(drawMode(app.editor)).toBe('normal');
    expect(app.commands.isEnabled('view.drawMode.inside')).toBe(false);
  });
});
