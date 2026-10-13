import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { shapeAnchors, isPie, pie } from '../src/model/shapes.js';
import { transformNodes, nodeBounds } from '../src/model/geometry.js';
import { createPath } from '../src/model/nodes.js';
import { rotate, scale } from '../src/lib/matrix.js';
import { widgetAt } from '../src/tools/widgets.js';
import { rimPoint } from '../src/features/live-shapes/index.js';

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

function evScreen(app, sx, sy, extra = {}) {
  const p = app.editor.view.toDoc(sx, sy);
  return { x: p.x, y: p.y, sx, sy, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

let app;
beforeEach(async () => {
  app = await bootAppWithFeatures();
  app.newDocument();
  app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
});

function addShape(shape, style = {}) {
  const doc = app.editor.doc;
  const node = createPath(shapeAnchors(shape), shape.kind !== 'line', { fill: { type: 'solid', color: '#336699' }, stroke: null, ...style }, { shape });
  doc.transact('Add', () => doc.insert(node, app.editor.targetLayer().id));
  app.editor.select([node.id]);
  return node.id;
}

describe('pie ellipses', () => {
  it('generates a closed wedge through the center', () => {
    const a = pie(100, 100, 50, 50, 0, 90);
    // Arc from 3 o'clock up to 12 o'clock (counterclockwise on screen), then the center.
    expect(a[0]).toMatchObject({ x: 150, y: 100 });
    expect(a[a.length - 2].x).toBeCloseTo(100);
    expect(a[a.length - 2].y).toBeCloseTo(50);
    expect(a[a.length - 1]).toMatchObject({ x: 100, y: 100, ix: 100, ox: 100 });
    expect(isPie({ kind: 'ellipse', pieStart: 30, pieEnd: 30 })).toBe(false);
    expect(isPie({ kind: 'ellipse', pieStart: 0, pieEnd: 270 })).toBe(true);
    const anchors = shapeAnchors({ kind: 'ellipse', cx: 0, cy: 0, w: 100, h: 60, angle: 0, pieStart: 45, pieEnd: 315 });
    // 270 degrees: three arc pieces, four rim anchors plus the center.
    expect(anchors).toHaveLength(5);
  });

  it('keeps the pie under rotation, scaling and reflection', () => {
    const shape = { kind: 'ellipse', cx: 200, cy: 200, w: 120, h: 80, angle: 0, pieStart: 30, pieEnd: 200 };
    const id = addShape(shape);
    const doc = app.editor.doc;
    const tip = (s, deg) => rimPoint(s, deg);
    const before = [tip(shape, 30), tip(shape, 200)];
    const check = (m, label) => {
      const n0 = doc.get(id);
      const p = [tip(n0.shape, n0.shape.pieStart), tip(n0.shape, n0.shape.pieEnd)].map((q) => ({ x: m[0] * q.x + m[2] * q.y + m[4], y: m[1] * q.x + m[3] * q.y + m[5] }));
      doc.transact(label, () => transformNodes(doc, [id], m));
      const n = doc.get(id);
      expect(n.shape, label).toBeTruthy();
      expect(isPie(n.shape)).toBe(true);
      const after = [tip(n.shape, n.shape.pieStart), tip(n.shape, n.shape.pieEnd)];
      const flipped = m[0] * m[3] - m[1] * m[2] < 0;
      const want = flipped ? [p[1], p[0]] : p;
      for (let i = 0; i < 2; i++) {
        expect(after[i].x).toBeCloseTo(want[i].x, 4);
        expect(after[i].y).toBeCloseTo(want[i].y, 4);
      }
      // The anchors match the params.
      const regen = shapeAnchors(n.shape);
      const b1 = nodeBounds(doc, n);
      const b2 = nodeBounds(doc, { ...n, anchors: regen });
      expect(b2.x).toBeCloseTo(b1.x, 3);
      expect(b2.w).toBeCloseTo(b1.w, 3);
    };
    expect(before[0].x).toBeGreaterThan(200);
    check(scale(1, 0.5, 0, 0), 'Squash');
    check([1, 0, 0, -1, 0, 500], 'Flip');
    check(rotate(40, 200, 200), 'Rotate');
    check(scale(2, 2, 100, 100), 'Scale');
    check([-1, 0, 0, 1, 400, 0], 'Reflect');
  });
});

describe('live shape widgets', () => {
  it('drags the pie handle of a live ellipse to cut a wedge, in one undo step', () => {
    const id = addShape({ kind: 'ellipse', cx: 300, cy: 300, w: 200, h: 200, angle: 0 });
    app.setTool('selection');
    const t = app.tool;
    // The handle sits just outside the rim at 3 o'clock.
    const w = widgetAt(app.editor, evScreen(app, 412, 300));
    expect(w?.id).toBe(`pie:${id}:start`);
    t.onPointerDown(evScreen(app, 412, 300));
    t.onPointerMove(evScreen(app, 300 + 80, 300 - 80));
    t.onPointerMove(evScreen(app, 300, 180));
    t.onPointerUp(evScreen(app, 300, 180));
    const s = app.editor.doc.get(id).shape;
    expect(s.pieStart).toBeCloseTo(90);
    expect(s.pieEnd).toBe(0);
    expect(app.editor.doc.get(id).anchors.length).toBeGreaterThan(4);
    app.commands.run('edit.undo');
    expect(isPie(app.editor.doc.get(id).shape)).toBe(false);
    app.commands.run('edit.redo');
    // Now there are two handles; Shift snaps the end to 15 degrees.
    const end = rimPoint(app.editor.doc.get(id).shape, 0);
    const sEnd = app.editor.view.toScreen(end.x, end.y);
    t.onPointerDown(evScreen(app, sEnd.x + 12, sEnd.y));
    expect(t.drag.kind).toBe('widget');
    const a = (-(271 * Math.PI) / 180);
    t.onPointerMove(evScreen(app, 300 + Math.cos(a) * 100, 300 + Math.sin(a) * 100, { shift: true }));
    t.onPointerUp(evScreen(app, 300, 400));
    expect(app.editor.doc.get(id).shape.pieEnd).toBeCloseTo(270);
  });

  it('changes a live polygon\'s sides with its side handle', () => {
    const id = addShape({ kind: 'polygon', cx: 300, cy: 300, r: 100, sides: 6, angle: 0 });
    app.setTool('selection');
    const n = app.editor.doc.get(id);
    const m = { x: (n.anchors[0].x + n.anchors[1].x) / 2, y: (n.anchors[0].y + n.anchors[1].y) / 2 };
    const l = Math.hypot(m.x - 300, m.y - 300);
    const hx = m.x + ((m.x - 300) / l) * 12;
    const hy = m.y + ((m.y - 300) / l) * 12;
    expect(widgetAt(app.editor, evScreen(app, hx, hy))?.id).toBe(`sides:${id}`);
    const t = app.tool;
    t.onPointerDown(evScreen(app, hx, hy));
    t.onPointerMove(evScreen(app, hx, hy - 30));
    t.onPointerUp(evScreen(app, hx, hy - 30));
    expect(app.editor.doc.get(id).shape.sides).toBe(9);
    expect(app.editor.doc.get(id).anchors).toHaveLength(9);
    t.onPointerDown(evScreen(app, ...(() => {
      const p = app.editor.doc.get(id);
      const mm = { x: (p.anchors[0].x + p.anchors[1].x) / 2, y: (p.anchors[0].y + p.anchors[1].y) / 2 };
      const ll = Math.hypot(mm.x - 300, mm.y - 300);
      return [mm.x + ((mm.x - 300) / ll) * 12, mm.y + ((mm.y - 300) / ll) * 12];
    })()));
    t.onPointerMove(evScreen(app, 0, 800));
    t.onPointerUp(evScreen(app, 0, 800));
    expect(app.editor.doc.get(id).shape.sides).toBe(3);
  });
});

describe('Properties panel shape fields', () => {
  function field(props, label) {
    return [...props.el.querySelectorAll('.shape-props input')].find((i) => i.getAttribute('aria-label') === label);
  }
  function commit(input, value) {
    input.focus();
    input.value = value;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.blur();
  }

  it('edits rectangle corners linked or one by one', () => {
    const id = addShape({ kind: 'rect', cx: 200, cy: 200, w: 200, h: 100, radii: [0, 0, 0, 0], angle: 0 });
    app.openPanel('properties');
    const props = app.dock.panels.get('properties');
    props.update();
    expect(props.el.querySelector('.shape-props').closest('section').querySelector('.section-title').textContent).toBe('Rectangle Properties');
    commit(field(props, 'Corner radius'), '10');
    expect(app.editor.doc.get(id).shape.radii).toEqual([10, 10, 10, 10]);
    commit(field(props, 'Shape width'), '300');
    expect(app.editor.doc.get(id).shape.w).toBe(300);
    props.el.querySelector('[aria-label="Link corner radius values"]').click();
    commit(field(props, 'Top right corner radius'), '25');
    expect(app.editor.doc.get(id).shape.radii).toEqual([10, 25, 10, 10]);
  });

  it('edits pie angles, inverts and closes a pie', () => {
    const id = addShape({ kind: 'ellipse', cx: 200, cy: 200, w: 100, h: 100, angle: 0 });
    app.openPanel('properties');
    const props = app.dock.panels.get('properties');
    props.update();
    commit(field(props, 'Pie start'), '45');
    expect(app.editor.doc.get(id).shape).toMatchObject({ pieStart: 45, pieEnd: 0 });
    props.update();
    [...props.el.querySelectorAll('.shape-props button')].find((b) => b.textContent === 'Invert Pie').click();
    expect(app.editor.doc.get(id).shape).toMatchObject({ pieStart: 0, pieEnd: 45 });
    props.update();
    [...props.el.querySelectorAll('.shape-props button')].find((b) => b.textContent === 'Close Pie').click();
    expect(isPie(app.editor.doc.get(id).shape)).toBe(false);
    expect(app.editor.doc.get(id).anchors).toHaveLength(4);
  });

  it('edits polygon side length and line length', () => {
    const id = addShape({ kind: 'polygon', cx: 200, cy: 200, r: 50, sides: 6, angle: 0 });
    app.openPanel('properties');
    const props = app.dock.panels.get('properties');
    props.update();
    commit(field(props, 'Side length'), '80');
    expect(app.editor.doc.get(id).shape.r).toBeCloseTo(80);
    const line = addShape({ kind: 'line', x1: 0, y1: 0, x2: 100, y2: 0 }, { fill: null, stroke: { type: 'solid', color: '#000000' } });
    props.update();
    commit(field(props, 'Angle'), '90');
    const s = app.editor.doc.get(line).shape;
    expect(s.x2).toBeCloseTo(0);
    expect(s.y2).toBeCloseTo(-100);
  });
});
