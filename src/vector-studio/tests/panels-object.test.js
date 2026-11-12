import { describe, it, expect } from 'vitest';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { anchor } from '../src/model/bezier.js';
import { nodeBounds, selectionBounds } from '../src/model/geometry.js';
import { bootAppWithFeatures } from './helpers.js';
import { trimMarkPaths, smoothAnchors, artworkAbove, switchOrientation } from '../src/features/panels/object-commands.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument({ width: 400, height: 300 });
  const doc = ed.doc;
  const layer = ed.targetLayer();
  const rect = (x, y, w = 20, h = 20, extra = {}) => {
    const p = createPath(rectangle(x, y, w, h), true, {}, extra);
    doc.transact('Add', () => doc.insert(p, layer.id));
    return p.id;
  };
  return { app, ed, doc, layer, rect };
}

describe('Ungroup All', () => {
  it('releases nested groups in one step and selects their contents', async () => {
    const { app, ed, doc, layer, rect } = await setup();
    const a = rect(0, 0);
    const b = rect(30, 0);
    const c = rect(60, 0);
    const inner = createGroup([]);
    const outer = createGroup([]);
    doc.transact('Group', () => {
      doc.insert(outer, layer.id);
      doc.insert(inner, outer.id);
      doc.move(a, inner.id);
      doc.move(b, inner.id);
      doc.move(c, outer.id);
    });
    ed.select([outer.id]);
    const undo0 = doc.undoStack.length;
    await app.commands.run('object.ungroupAll');
    expect(doc.has(outer.id) || doc.has(inner.id)).toBe(false);
    expect(doc.get(layer.id).children).toEqual([a, b, c]);
    expect([...ed.selection].sort()).toEqual([a, b, c].sort());
    expect(doc.undoStack.length).toBe(undo0 + 1);
    doc.undo();
    expect(doc.get(inner.id).children).toEqual([a, b]);
  });

  it('is disabled without a group selected', async () => {
    const { app, ed, rect } = await setup();
    ed.select([rect(0, 0)]);
    expect(app.commands.isEnabled('object.ungroupAll')).toBe(false);
  });
});

describe('Lock and Hide All Artwork Above', () => {
  it('only affects overlapping objects stacked above the selection', async () => {
    const { app, ed, doc, rect } = await setup();
    const below = rect(0, 0, 50, 50);
    const sel = rect(10, 10, 30, 30);
    const above = rect(20, 20, 30, 30);
    const farAbove = rect(200, 200, 10, 10);
    ed.select([sel]);
    expect(artworkAbove(ed)).toEqual([above]);
    await app.commands.run('object.lockAbove');
    expect(doc.get(above).locked).toBe(true);
    expect(doc.get(below).locked).toBe(false);
    expect(doc.get(farAbove).locked).toBe(false);
    doc.undo();
    await app.commands.run('object.hideAbove');
    expect(doc.get(above).hidden).toBe(true);
  });
});

describe('Create Trim Marks', () => {
  it('makes eight hairline marks around a rectangle, off its corners', () => {
    const marks = trimMarkPaths({ x: 0, y: 0, w: 100, h: 50 }, { offset: 6, length: 18 });
    expect(marks.length).toBe(8);
    for (const m of marks) {
      expect(m.closed).toBe(false);
      expect(m.fill).toBeNull();
      expect(m.strokeWidth).toBeCloseTo(0.3);
      const [p, q] = m.anchors;
      // Every mark is axis-aligned, 18 long, and starts 6 away from a corner.
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeCloseTo(18);
      expect(p.x === q.x || p.y === q.y).toBe(true);
    }
    expect(marks.some((m) => m.anchors[0].x === -6 && m.anchors[1].x === -24 && m.anchors[0].y === 0)).toBe(true);
  });

  it('groups the marks around the selection, or the artboard without one', async () => {
    const { app, ed, doc, rect } = await setup();
    const id = rect(100, 100, 50, 40);
    ed.select([id]);
    // Marks go around the visible art (stroke included).
    const vb = selectionBounds(doc, [id], true);
    await app.commands.run('object.trimMarks');
    const g = doc.get([...ed.selection][0]);
    expect(g.name).toBe('Trim Marks');
    expect(g.children.length).toBe(8);
    const b = nodeBounds(doc, g);
    expect(b.x).toBeCloseTo(vb.x - 24);
    expect(b.w).toBeCloseTo(vb.w + 48);
    ed.clearSelection();
    await app.commands.run('object.trimMarks');
    const b2 = nodeBounds(doc, doc.get([...ed.selection][0]));
    expect(b2.x).toBeCloseTo(-24);
    expect(b2.w).toBeCloseTo(400 + 48);
  });
});

describe('Smooth', () => {
  const zigzag = () => [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => anchor(i * 20, i % 2 ? 30 : 0));

  it('leaves paths unchanged at 0 and rounds corners at low amounts', () => {
    const a = zigzag();
    expect(smoothAnchors(a, false, 0)).toBe(a);
    const s = smoothAnchors(a, false, 30);
    expect(s.length).toBe(a.length);
    // Interior corners get handles.
    expect(s[3].ox).not.toBe(s[3].x);
    expect(s.every((p, i) => p.x === a[i].x && p.y === a[i].y)).toBe(true);
  });

  it('removes anchors at high amounts', () => {
    const pts = [];
    for (let i = 0; i <= 40; i++) pts.push(anchor(i * 5, Math.sin(i / 3) * 20 + (i % 2) * 0.8));
    const s = smoothAnchors(pts, false, 100);
    expect(s.length).toBeLessThan(pts.length);
    expect(s[0].x).toBeCloseTo(0);
    expect(s[s.length - 1].x).toBeCloseTo(200);
  });

  it('keeps closed paths closed', () => {
    const pts = ellipse(0, 0, 100, 100).flatMap((p, i, arr) => [p, { ...anchor((p.x + arr[(i + 1) % arr.length].x) / 2 + 1, (p.y + arr[(i + 1) % arr.length].y) / 2) }]);
    const s = smoothAnchors(pts, true, 90);
    expect(s.length).toBeGreaterThanOrEqual(3);
    expect(s.length).toBeLessThanOrEqual(pts.length);
  });

  it('the dialog previews, and Cancel restores the path', async () => {
    const { app, ed, doc } = await setup();
    const p = createPath(zigzag(), false);
    doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
    ed.select([p.id]);
    const before = doc.get(p.id);
    const undo0 = doc.undoStack.length;
    let done = app.commands.run('path.smooth');
    await tick();
    let dlg = document.querySelector('dialog[open]');
    const range = dlg.querySelector('input[type=range]');
    range.value = '35';
    range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(doc.get(p.id).anchors).not.toEqual(before.anchors);
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    await done;
    expect(doc.get(p.id).anchors).toEqual(before.anchors);
    expect(doc.undoStack.length).toBe(undo0);
    done = app.commands.run('path.smooth');
    await tick();
    dlg = document.querySelector('dialog[open]');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Auto-Smooth').click();
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(doc.undoStack.length).toBe(undo0 + 1);
    expect(doc.undoLabel).toBe('Smooth');
    expect(doc.tx).toBeNull();
  });

  it('OK with no smoothing changes nothing and adds no undo step', async () => {
    const { app, ed, doc } = await setup();
    const p = createPath(zigzag(), false);
    doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
    ed.select([p.id]);
    const before = doc.get(p.id);
    const undo0 = doc.undoStack.length;
    const done = app.commands.run('path.smooth');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(doc.get(p.id)).toBe(before);
    expect(doc.undoStack.length).toBe(undo0);
    expect(doc.tx).toBeNull();
  });
});

describe('Align commands', () => {
  it('centers on both axes against the artboard', async () => {
    const { app, ed, doc, rect } = await setup();
    const id = rect(10, 10, 40, 20);
    ed.select([id]);
    await app.commands.run('align.toArtboard');
    expect(app.commands.isChecked('align.toArtboard')).toBe(true);
    expect(app.commands.isChecked('align.toSelection')).toBe(false);
    await app.commands.run('align.center');
    const b = nodeBounds(doc, doc.get(id));
    expect(b.x + b.w / 2).toBeCloseTo(200);
    expect(b.y + b.h / 2).toBeCloseTo(150);
    expect(doc.undoLabel).toBe('Align');
    await app.commands.run('align.toSelection');
    expect(app.alignTo).toBe('selection');
  });

  it('Align To Key Object makes the front object the key', async () => {
    const { app, ed, rect } = await setup();
    const a = rect(0, 0);
    const b = rect(100, 50);
    ed.select([a, b]);
    await app.commands.run('align.toKeyObject');
    expect(app.alignKey).toBe(b);
    expect(app.commands.isChecked('align.toKeyObject')).toBe(true);
    await app.commands.run('align.toSelection');
    expect(app.alignKey).toBeNull();
  });
});

describe('Artboards > Switch Orientation', () => {
  it('swaps width and height of the active artboard', async () => {
    const { app, doc } = await setup();
    await app.commands.run('artboards.switchOrientation');
    expect(doc.artboards[0]).toMatchObject({ w: 300, h: 400 });
    doc.undo();
    expect(doc.artboards[0]).toMatchObject({ w: 400, h: 300 });
    expect(switchOrientation(doc, 7)).toBe(false);
  });
});

describe('Clipping Mask > Edit Contents', () => {
  it('selects the clipped contents, then the clipping path', async () => {
    const { app, ed, rect } = await setup();
    const a = rect(0, 0);
    const b = rect(10, 10);
    const mask = rect(0, 0, 15, 15);
    ed.select([a, b, mask]);
    await app.commands.run('object.clipMake');
    const g = [...ed.selection][0];
    expect(ed.doc.get(g).clip).toBe(true);
    expect(app.commands.label('object.clipEdit')).toBe('Edit Contents');
    await app.commands.run('object.clipEdit');
    expect([...ed.selection].sort()).toEqual([a, b].sort());
    expect(app.commands.label('object.clipEdit')).toBe('Edit Clipping Path');
    await app.commands.run('object.clipEdit');
    expect([...ed.selection]).toEqual([mask]);
  });
});
