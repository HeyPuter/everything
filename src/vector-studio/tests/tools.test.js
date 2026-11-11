import { describe, it, expect, beforeEach } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';

/** A tool event at document point (x, y) for an identity view. */
function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

function drag(app, tool, from, to, mods = {}) {
  tool.onPointerDown(ev(app, from[0], from[1], mods));
  const steps = 4;
  for (let i = 1; i <= steps; i++) tool.onPointerMove(ev(app, from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, mods));
  tool.onPointerUp(ev(app, to[0], to[1], mods));
}

function addRect(app, x, y, w, h, extra = {}) {
  const doc = app.editor.doc;
  const n = createPath(rectangle(x, y, w, h), true, { fill: { type: 'solid', color: '#ff0000' }, ...extra });
  doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
  return doc.get(n.id);
}

describe('tools', () => {
  let app;
  beforeEach(() => {
    app = bootApp();
    app.newDocument();
    const v = app.editor.view;
    v.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  });

  it('Rectangle tool draws a live rectangle; Shift makes a square', () => {
    app.setTool('rectangle');
    drag(app, app.tool, [10, 10], [110, 60]);
    const n = app.editor.selectedNodes()[0];
    expect(n.shape).toMatchObject({ kind: 'rect', w: 100, h: 50 });
    drag(app, app.tool, [200, 200], [260, 220], { shift: true });
    const sq = app.editor.selectedNodes()[0];
    expect(sq.shape.w).toBeCloseTo(sq.shape.h);
  });

  it('Ellipse tool with Alt draws from the center', () => {
    app.setTool('ellipse');
    drag(app, app.tool, [300, 300], [350, 320], { alt: true });
    const b = nodeBounds(app.editor.doc, app.editor.selectedNodes()[0]);
    expect(b.x).toBeCloseTo(250);
    expect(b.w).toBeCloseTo(100);
    expect(b.h).toBeCloseTo(40);
  });

  it('Pen tool builds corner and smooth anchors and closes on the first point', () => {
    app.setTool('pen');
    const pen = app.tool;
    pen.onPointerDown(ev(app, 0, 0));
    pen.onPointerUp(ev(app, 0, 0));
    drag(app, pen, [100, 0], [150, 50]);
    pen.onPointerDown(ev(app, 100, 100));
    pen.onPointerUp(ev(app, 100, 100));
    pen.onPointerDown(ev(app, 0, 0));
    pen.onPointerUp(ev(app, 0, 0));
    const doc = app.editor.doc;
    const path = doc.leaves().find((n) => n.type === 'path');
    expect(path.closed).toBe(true);
    expect(path.anchors).toHaveLength(3);
    const smooth = path.anchors[1];
    expect(smooth.ox).toBeCloseTo(150);
    expect(smooth.ix).toBeCloseTo(50); // mirrored handle
  });

  it('Selection tool moves, and Alt-drag duplicates, as single undo steps', () => {
    const r = addRect(app, 0, 0, 50, 50);
    app.setTool('selection');
    drag(app, app.tool, [25, 25], [125, 25]);
    expect(nodeBounds(app.editor.doc, app.editor.doc.get(r.id)).x).toBeCloseTo(100);
    drag(app, app.tool, [125, 25], [125, 125], { alt: true });
    expect(app.editor.doc.leaves()).toHaveLength(2);
    app.editor.doc.undo();
    expect(app.editor.doc.leaves()).toHaveLength(1);
    app.editor.doc.undo();
    expect(nodeBounds(app.editor.doc, app.editor.doc.get(r.id)).x).toBeCloseTo(0);
  });

  it('Selection tool scales from the opposite handle', () => {
    const r = addRect(app, 0, 0, 100, 100);
    app.setTool('selection');
    app.editor.select([r.id]);
    // Drag the bottom-right handle out to (200, 150).
    drag(app, app.tool, [100, 100], [200, 150]);
    const b = nodeBounds(app.editor.doc, app.editor.doc.get(r.id));
    expect(b).toMatchObject({ x: 0, y: 0 });
    expect(b.w).toBeCloseTo(200);
    expect(b.h).toBeCloseTo(150);
  });

  it('Direct Selection moves one anchor', () => {
    const r = addRect(app, 0, 0, 100, 100);
    app.setTool('direct-selection');
    drag(app, app.tool, [100, 100], [150, 120]);
    const a = app.editor.doc.get(r.id).anchors[2];
    expect([a.x, a.y]).toEqual([150, 120]);
    expect(app.editor.doc.get(r.id).anchors[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('marquee selects objects it touches', () => {
    const a = addRect(app, 0, 0, 50, 50);
    addRect(app, 200, 200, 50, 50);
    app.setTool('selection');
    drag(app, app.tool, [-10, -10], [30, 30]);
    expect([...app.editor.selection]).toEqual([a.id]);
  });
});

describe('object commands', () => {
  let app;
  beforeEach(() => {
    app = bootApp();
    app.newDocument();
  });

  it('groups, ungroups and arranges', async () => {
    const a = addRect(app, 0, 0, 10, 10);
    const b = addRect(app, 20, 0, 10, 10);
    const c = addRect(app, 40, 0, 10, 10);
    const ed = app.editor;
    ed.select([a.id, b.id]);
    await app.commands.run('object.group');
    const g = ed.selectedNodes()[0];
    expect(g.type).toBe('group');
    expect(g.children).toEqual([a.id, b.id]);
    await app.commands.run('object.sendToBack');
    expect(ed.doc.get(ed.targetLayer().id).children[0]).toBe(g.id);
    await app.commands.run('object.ungroup');
    expect(ed.doc.has(g.id)).toBe(false);
    expect(ed.doc.get(ed.targetLayer().id).children).toEqual([a.id, b.id, c.id]);
  });

  it('makes and releases a clipping mask with the top object as the clip', async () => {
    const art = addRect(app, 0, 0, 100, 100);
    const mask = createPath(ellipse(25, 25, 50, 50), true);
    const doc = app.editor.doc;
    doc.transact('m', () => doc.insert(mask, app.editor.targetLayer().id));
    app.editor.select([art.id, mask.id]);
    await app.commands.run('object.clipMake');
    const g = app.editor.selectedNodes()[0];
    expect(g.clip).toBe(true);
    expect(nodeBounds(doc, g)).toMatchObject({ x: 25, y: 25, w: 50, h: 50 });
    await app.commands.run('object.clipRelease');
    expect(doc.has(g.id)).toBe(false);
    expect(doc.undoLabel).toBe('Release Clipping Mask');
    // One Undo brings the clip group back, selected.
    await app.commands.run('edit.undo');
    expect(doc.get(g.id).clip).toBe(true);
    expect(doc.get(g.id).children).toEqual([art.id, mask.id]);
    expect([...app.editor.selection]).toEqual([g.id]);
    await app.commands.run('edit.redo');
    expect(doc.has(g.id)).toBe(false);
    expect(new Set(app.editor.selection)).toEqual(new Set([art.id, mask.id]));
  });

  it('makes a compound path that punches a hole', async () => {
    const outer = addRect(app, 0, 0, 100, 100);
    const inner = addRect(app, 25, 25, 50, 50);
    app.editor.select([outer.id, inner.id]);
    await app.commands.run('object.compoundMake');
    const c = app.editor.selectedNodes()[0];
    expect(c.type).toBe('compound');
    expect(c.children).toHaveLength(2);
    // The inner subpath runs opposite to the outer one so nonzero leaves a hole.
    const { signedArea } = await import('../src/model/bezier.js');
    const [o, i] = c.children.map((id) => app.editor.doc.get(id));
    expect(Math.sign(signedArea(o.anchors))).not.toBe(Math.sign(signedArea(i.anchors)));
  });

  it('aligns to the selection and distributes centers', async () => {
    const a = addRect(app, 0, 0, 10, 10);
    const b = addRect(app, 50, 30, 10, 10);
    const c = addRect(app, 200, 60, 10, 10);
    app.editor.select([a.id, b.id, c.id]);
    await app.commands.run('align.top');
    for (const n of [a, b, c]) expect(nodeBounds(app.editor.doc, app.editor.doc.get(n.id)).y).toBeCloseTo(0);
    app.editor.doc.transact('m', () => app.editor.doc.update(b.id, { anchors: rectangle(150, 0, 10, 10) }));
    await app.commands.run('distribute.hcenter');
    expect(nodeBounds(app.editor.doc, app.editor.doc.get(b.id)).x).toBeCloseTo(100);
  });

  it('copies and pastes in front and in place', async () => {
    const a = addRect(app, 0, 0, 10, 10);
    const ed = app.editor;
    ed.select([a.id]);
    await app.commands.run('edit.copy');
    await app.commands.run('edit.pasteFront');
    const copy = ed.selectedNodes()[0];
    expect(copy.id).not.toBe(a.id);
    expect(nodeBounds(ed.doc, copy)).toMatchObject({ x: 0, y: 0 });
    const kids = ed.doc.get(ed.targetLayer().id).children;
    expect(kids.indexOf(copy.id)).toBe(kids.indexOf(a.id) + 1);
  });

  it('never pastes into a hidden layer', async () => {
    const ed = app.editor;
    const doc = ed.doc;
    const bottom = ed.targetLayer().id;
    const a = addRect(app, 0, 0, 10, 10);
    ed.select([a.id]);
    await app.commands.run('edit.copy');
    let top;
    doc.transact('Layer', () => (top = doc.addLayer('Top').id));
    ed.activeLayerId = top;
    doc.transact('Hide', () => doc.update(top, { hidden: true }));
    for (const cmd of ['edit.paste', 'edit.pasteInPlace']) {
      await app.commands.run(cmd);
      const [id] = ed.selection;
      expect(doc.get(id).parent).toBe(bottom);
      expect(doc.isHidden(id)).toBe(false);
    }
  });

  it('joins two open paths at their nearest ends', async () => {
    const doc = app.editor.doc;
    const p1 = createPath([{ x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 }, { x: 10, y: 0, ix: 10, iy: 0, ox: 10, oy: 0 }], false);
    const p2 = createPath([{ x: 20, y: 0, ix: 20, iy: 0, ox: 20, oy: 0 }, { x: 10, y: 0, ix: 10, iy: 0, ox: 10, oy: 0 }], false);
    doc.transact('p', () => {
      doc.insert(p1, app.editor.targetLayer().id);
      doc.insert(p2, app.editor.targetLayer().id);
    });
    app.editor.select([p1.id, p2.id]);
    await app.commands.run('path.join');
    const joined = app.editor.selectedNodes()[0];
    expect(joined.anchors.map((a) => a.x)).toEqual([0, 10, 20]);
    expect(doc.has(p2.id)).toBe(false);
  });

  it('nudges with arrow keys by the keyboard increment, 10x with Shift', () => {
    const a = addRect(app, 0, 0, 10, 10);
    app.editor.select([a.id]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', shiftKey: true, bubbles: true }));
    expect(nodeBounds(app.editor.doc, app.editor.doc.get(a.id))).toMatchObject({ x: 1, y: 10 });
  });

  it('locks and hides everything except the selection', async () => {
    const a = addRect(app, 0, 0, 10, 10);
    const b = addRect(app, 20, 0, 10, 10);
    const c = addRect(app, 40, 0, 10, 10);
    app.editor.select([a.id]);
    await app.commands.run('object.lockOthers');
    expect([b, c].map((n) => app.editor.doc.get(n.id).locked)).toEqual([true, true]);
    expect(app.editor.doc.get(a.id).locked).toBe(false);
    await app.commands.run('object.hideOthers');
    expect([b, c].map((n) => app.editor.doc.get(n.id).hidden)).toEqual([true, true]);
    expect(app.editor.doc.get(a.id).hidden).toBe(false);
  });

  it('releases guides into lines and switches units', async () => {
    const doc = app.editor.doc;
    doc.transact('g', () => doc.updateRoot({ guides: [{ axis: 'x', pos: 100 }] }));
    await app.commands.run('view.releaseGuides');
    expect(doc.root.guides).toEqual([]);
    const line = app.editor.selectedNodes()[0];
    expect(line.anchors.every((p) => p.x === 100)).toBe(true);
    await app.commands.run('view.switchUnits');
    expect(doc.root.units).toBe('px');
  });
});

describe('General preferences in tools', () => {
  let app;
  beforeEach(() => {
    app = bootApp();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
  });

  it('Rounded Rectangle tool uses the Corner Radius preference and arrow keys change it', () => {
    app.prefs.set('cornerRadius', 20);
    app.setTool('rounded-rectangle');
    drag(app, app.tool, [10, 10], [110, 60]);
    expect(app.editor.selectedNodes()[0].shape.radii).toEqual([20, 20, 20, 20]);
    app.tool.arrow(1);
    expect(app.prefs.get('cornerRadius')).toBe(21);
    app.setTool('rectangle');
    drag(app, app.tool, [200, 10], [260, 60]);
    expect(app.editor.selectedNodes()[0].shape.radii).toEqual([0, 0, 0, 0]);
  });

  it('Shift constrains lines and moves to the Constrain Angle', () => {
    app.prefs.set('constrainAngle', 30);
    app.setTool('line');
    drag(app, app.tool, [0, 0], [100, -50], { shift: true });
    const [a, b] = app.editor.selectedNodes()[0].anchors;
    // 30 degrees counterclockwise (up and to the right on screen).
    expect(Math.atan2(-(b.y - a.y), b.x - a.x) * (180 / Math.PI)).toBeCloseTo(30, 5);
  });
});
