import { describe, it, expect, beforeEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { anchor } from '../src/model/bezier.js';
import { nodeBounds, transformNodes } from '../src/model/geometry.js';
import { liveArtwork } from '../src/model/live.js';
import { radialGeometry, gridLayout } from '../src/features/repeat/repeat-model.js';
import { repeatHandles } from '../src/features/repeat/repeat-widgets.js';
import { repeatValues, applyRepeatValues } from '../src/features/repeat/repeat-ui.js';
import { onPathSampler, onPathPositions, attachToPath } from '../src/features/repeat/on-path.js';
import { translate } from '../src/lib/matrix.js';
import { PropertiesPanel } from '../src/ui/panels/properties.js';

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}
function evScreen(app, sx, sy, extra = {}) {
  const p = app.editor.view.toDoc(sx, sy);
  return { x: p.x, y: p.y, sx, sy, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}
function addRect(app, x, y, w, h, extra = {}) {
  const doc = app.editor.doc;
  const n = createPath(rectangle(x, y, w, h), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: null, ...extra });
  doc.transact('Rect', () => doc.insert(n, app.editor.targetLayer().id));
  return doc.get(n.id);
}
function addPath(app, pts, closed = false) {
  const doc = app.editor.doc;
  const n = createPath(pts.map(([x, y]) => anchor(x, y)), closed, { fill: null, stroke: { type: 'solid', color: '#000000' } });
  doc.transact('Path', () => doc.insert(n, app.editor.targetLayer().id));
  return doc.get(n.id);
}
const handle = (app, id) => repeatHandles(app.editor).handles.find((h) => h.id === id);
function dragScreen(app, from, to, mods = {}) {
  const tool = app.tool;
  tool.onHover(evScreen(app, from.x, from.y, mods));
  tool.onPointerDown(evScreen(app, from.x, from.y, mods));
  for (let i = 1; i <= 4; i++) tool.onPointerMove(evScreen(app, from.x + ((to.x - from.x) * i) / 4, from.y + ((to.y - from.y) * i) / 4, mods));
  tool.onPointerUp(evScreen(app, to.x, to.y, mods));
}

describe('repeat commands and widgets', () => {
  let app;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    app.setTool('selection');
  });

  it('makes a radial repeat from the menu command and edits it by dragging widgets', async () => {
    const r = addRect(app, 200, 100, 40, 60);
    app.editor.select([r.id]);
    await app.commands.run('repeat.radial');
    const doc = app.editor.doc;
    const gid = app.editor.topSelection()[0];
    const g = doc.get(gid);
    expect(g.live.mode).toBe('radial');
    expect(g.live.count).toBe(8);
    expect(doc.undoLabel).toBe('Radial Repeat');
    // Radius handle sits on the source; dragging it outward grows the radius.
    const r0 = radialGeometry(doc, g).radius;
    const rh = handle(app, 'radius');
    app.tool.onHover(evScreen(app, rh.x, rh.y));
    expect(app.editor.widgetHover).toBe('repeat:radius');
    dragScreen(app, rh, { x: rh.x, y: rh.y - 30 });
    expect(radialGeometry(doc, doc.get(gid)).radius).toBeCloseTo(r0 + 30, 0);
    expect(doc.undoLabel).toBe('Repeat Radius');
    // The instance slider adds instances when dragged right.
    const ch = handle(app, 'count');
    dragScreen(app, ch, { x: ch.x + 40, y: ch.y });
    expect(doc.get(gid).live.count).toBe(12);
    doc.undo();
    expect(doc.get(gid).live.count).toBe(8);
    doc.undo();
    expect(radialGeometry(doc, doc.get(gid)).radius).toBeCloseTo(r0, 3);
    // The span handle sweeps the instances over part of the circle.
    const sh = handle(app, 'span');
    const c = app.editor.view.toScreen(doc.get(gid).live.cx, doc.get(gid).live.cy);
    dragScreen(app, sh, { x: c.x + 150, y: c.y });
    expect(doc.get(gid).live.span).toBeCloseTo(90, 0);
  });

  it('grid handles add columns and rows and change spacing', async () => {
    const r = addRect(app, 100, 100, 40, 40);
    app.editor.select([r.id]);
    await app.commands.run('repeat.grid');
    const doc = app.editor.doc;
    const gid = app.editor.topSelection()[0];
    expect(doc.get(gid).live.cols).toBe(3);
    const colsH = handle(app, 'cols');
    // One more cell (40 + 10 spacing) to the right adds a column.
    dragScreen(app, colsH, { x: colsH.x + 50, y: colsH.y });
    expect(doc.get(gid).live.cols).toBe(4);
    const rowsH = handle(app, 'rows');
    dragScreen(app, rowsH, { x: rowsH.x, y: rowsH.y - 100 });
    expect(doc.get(gid).live.rows).toBe(1);
    const hs = handle(app, 'hspace');
    dragScreen(app, hs, { x: hs.x + 15, y: hs.y });
    expect(doc.get(gid).live.hSpacing).toBeCloseTo(20);
    expect(gridLayout(doc, doc.get(gid)).box.w).toBeCloseTo(4 * 40 + 3 * 20);
    // Corner handles still scale the whole repeat.
    expect(handle(app, 'cols')).toBeTruthy();
  });

  it('mirror starts in isolation on the source; editing it updates the reflection', async () => {
    const r = addRect(app, 100, 100, 40, 40);
    app.editor.select([r.id]);
    await app.commands.run('repeat.mirror');
    const ed = app.editor;
    const doc = ed.doc;
    const gid = ed.isolation;
    expect(doc.get(gid).live.mode).toBe('mirror');
    expect([...ed.selection]).toEqual([r.id]);
    doc.transact('move', () => doc.update(r.id, { anchors: rectangle(90, 100, 40, 40) }));
    const items = liveArtwork(doc, doc.get(gid)).items;
    expect(nodeBounds(liveArtwork(doc, doc.get(gid)).vdoc, items[1]).x).toBeCloseTo(150);
    // The axis end handle turns the axis; Shift snaps to 15 degrees.
    const b = handle(app, 'axis-b');
    const a = handle(app, 'axis-a');
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    dragScreen(app, b, { x: mid.x + 100, y: mid.y + 3 }, { shift: true });
    const L = doc.get(gid).live;
    expect(L.y1).toBeCloseTo(L.y2);
    expect(repeatValues(doc, doc.get(gid)).axisAngle).toBeCloseTo(0);
    await app.commands.run('object.exitIsolation');
    expect(ed.isolation).toBe(null);
  });

  it('releases, edits the source, and shows a Properties section', async () => {
    const r = addRect(app, 100, 100, 40, 40);
    app.editor.select([r.id]);
    await app.commands.run('repeat.grid');
    const gid = app.editor.topSelection()[0];
    const sec = PropertiesPanel.extraSections.find((s) => s.id === 'repeat');
    expect(sec.when(app.editor)).toBe(true);
    const inst = sec.build(app);
    inst.refresh();
    expect(inst.el.querySelectorAll('[role=radio]').length).toBeGreaterThan(2);
    // Switching the type from the panel keeps the source.
    applyRepeatValues(app.editor.doc, gid, {});
    app.editor.doc.transact('mode', () => applyRepeatValues(app.editor.doc, gid, { mode: 'radial' }));
    expect(app.editor.doc.get(gid).live.mode).toBe('radial');
    await app.commands.run('repeat.edit');
    expect(app.editor.isolation).toBe(gid);
    await app.commands.run('object.exitIsolation');
    app.editor.select([gid]);
    await app.commands.run('repeat.release');
    expect(app.editor.doc.get(gid)).toBeUndefined();
    expect([...app.editor.selection]).toEqual([r.id]);
  });

  it('Repeat Options dialog previews and applies to the selected repeat in one step', async () => {
    const r = addRect(app, 100, 100, 40, 40);
    app.editor.select([r.id]);
    await app.commands.run('repeat.radial');
    const doc = app.editor.doc;
    const gid = app.editor.topSelection()[0];
    const steps = doc.undoStack.length;
    const done = app.commands.run('repeat.options');
    await new Promise((r2) => setTimeout(r2, 0));
    const dlg = document.querySelector('dialog[open]');
    expect(dlg).toBeTruthy();
    const count = dlg.querySelector('input[aria-label="Instances"]');
    count.value = '5';
    count.dispatchEvent(new Event('blur'));
    expect(doc.get(gid).live.count).toBe(5);
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(doc.get(gid).live.count).toBe(5);
    expect(doc.undoStack.length).toBe(steps + 1);
    expect(app.prefs.get('repeatOptions').radial.count).toBe(5);
  });
});

describe('objects on path', () => {
  let app;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    app.setTool('selection');
  });

  it('distributes positions evenly or at a fixed distance', () => {
    expect(onPathPositions({ spacing: 'even', offset: 0 }, 100, false, 3)).toEqual([0, 50, 100]);
    expect(onPathPositions({ spacing: 'even', offset: 0 }, 100, true, 4)).toEqual([0, 25, 50, 75]);
    expect(onPathPositions({ spacing: 'distance', distance: 40, offset: 0.1 }, 100, false, 5)).toEqual([10, 50, 90]);
  });

  it('attaches objects to a path with live preview, follows path edits, and releases in place', async () => {
    const path = addPath(app, [[100, 300], [400, 300]]);
    const a = addRect(app, 10, 10, 20, 20);
    const b = addRect(app, 50, 10, 20, 20);
    const c = addRect(app, 90, 10, 20, 20);
    app.editor.select([path.id, a.id, b.id, c.id]);
    expect(app.commands.isEnabled('objectsOnPath.attach')).toBe(true);
    const done = app.commands.run('objectsOnPath.attach');
    await new Promise((r) => setTimeout(r, 0));
    const dlg = document.querySelector('dialog[open]');
    [...dlg.querySelectorAll('button')].find((x) => x.textContent === 'Attach').click();
    await done;
    const doc = app.editor.doc;
    const gid = app.editor.topSelection()[0];
    expect(doc.get(gid).live.kind).toBe('onPath');
    expect(doc.get(gid).children[0]).toBe(path.id);
    const { items, vdoc } = liveArtwork(doc, doc.get(gid));
    const xs = items.slice(1).map((n) => nodeBounds(vdoc, n).x + 10);
    expect(xs.map(Math.round)).toEqual([100, 250, 400]);
    // Editing the path re-places the objects.
    doc.transact('edit', () => doc.update(path.id, { anchors: [anchor(100, 300), anchor(100, 500)] }));
    const after = liveArtwork(doc, doc.get(gid));
    const last = after.items[after.items.length - 1];
    const lb = nodeBounds(after.vdoc, last);
    expect(lb.y + 10).toBeCloseTo(500);
    expect(onPathSampler(doc, doc.get(gid)).length).toBeCloseTo(200);
    // Above the path: the bottom edge sits on it (rotation off keeps the box upright).
    doc.transact('opt', () => doc.update(gid, { live: { ...doc.get(gid).live, align: 'above', rotate: false } }));
    const above = liveArtwork(doc, doc.get(gid));
    const first = nodeBounds(above.vdoc, above.items[1]);
    expect(first.y + first.h).toBeCloseTo(300);
    await app.commands.run('objectsOnPath.release');
    expect(doc.get(gid)).toBeUndefined();
    expect(nodeBounds(doc, doc.get(a.id)).y + 20).toBeCloseTo(300);
    doc.undo();
    expect(doc.get(gid)).toBeTruthy();
    await app.commands.run('objectsOnPath.expand');
    expect(doc.get(gid)).toBeUndefined();
  });

  it('a pasted or duplicated objects-on-path group follows its own copy of the path', async () => {
    const path = addPath(app, [[100, 300], [400, 300]]);
    const a = addRect(app, 10, 10, 20, 20);
    const b = addRect(app, 50, 10, 20, 20);
    const doc = app.editor.doc;
    let gid;
    doc.transact('Attach', () => (gid = attachToPath(doc, [path.id, a.id, b.id], path.id)));
    const placed = (d, id) => {
      const g = d.get(id);
      expect(g.children).toContain(g.live.path);
      const { items, vdoc } = liveArtwork(d, g);
      return items.map((n) => Math.round(nodeBounds(vdoc, n).x));
    };
    const before = placed(doc, gid);
    app.editor.select([gid]);
    await app.commands.run('edit.copy');
    await app.commands.run('edit.pasteInPlace');
    const pasted = app.editor.topSelection()[0];
    expect(placed(doc, pasted)).toEqual(before);
    // Moving the original's path leaves the copy where it is.
    doc.transact('Move', () => transformNodes(doc, [path.id], translate(0, 100)));
    expect(placed(doc, pasted)).toEqual(before);
    app.editor.select([pasted]);
    await app.commands.run('edit.duplicate');
    expect(placed(doc, app.editor.topSelection()[0])).toEqual(before);
    app.newDocument();
    await app.commands.run('edit.pasteInPlace');
    expect(placed(app.editor.doc, app.editor.topSelection()[0])).toEqual(before);
  });

  it('objects on a path inside a symbol instance follow the instance', async () => {
    const path = addPath(app, [[100, 300], [400, 300]]);
    const a = addRect(app, 10, 10, 20, 20);
    const b = addRect(app, 50, 10, 20, 20);
    const doc = app.editor.doc;
    let gid;
    doc.transact('Attach', () => (gid = attachToPath(doc, [path.id, a.id, b.id], path.id)));
    const boxes = (d, n) => {
      const { items, vdoc } = liveArtwork(d, n);
      return items.map((v) => nodeBounds(vdoc, v)).map((r) => [Math.round(r.x), Math.round(r.y)]);
    };
    const before = boxes(doc, doc.get(gid));
    app.editor.select([gid]);
    await app.commands.run('symbol.new', { direct: true, name: 'Beads' });
    const inst = app.editor.topSelection()[0];
    doc.transact('Move', () => transformNodes(doc, [inst], translate(0, 100)));
    const { items, vdoc } = liveArtwork(doc, doc.get(inst));
    expect(boxes(vdoc, items[0])).toEqual(before.map(([x, y]) => [x, y + 100]));
  });
});
