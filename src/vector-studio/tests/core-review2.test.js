// Editing core, layers and undo: regressions found in the second review.
import { describe, it, expect } from 'vitest';
import { bootApp, bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { insertLayer } from '../src/ops/layer-ops.js';

function setup(app = bootApp()) {
  const ed = app.newDocument();
  const doc = ed.doc;
  const layer = doc.layers()[0];
  const add = (x, parent = layer.id) => {
    const p = createPath(rectangle(x, 0, 10, 10), true);
    doc.transact('Rect', () => doc.insert(p, parent));
    return p.id;
  };
  const sublayer = (parent = layer.id) => {
    let sub;
    doc.transact('Sublayer', () => (sub = insertLayer(doc, parent)));
    return sub.id;
  };
  return { app, ed, doc, layer, add, sublayer };
}

describe('Layers panel layer target', () => {
  it("selects a sublayer's artwork, never the sublayer itself", async () => {
    const { app, ed, doc, layer, add, sublayer } = setup();
    const a = add(0);
    const sub = sublayer();
    const b = add(20, sub);
    const hidden = add(40, sub);
    doc.transact('Hide', () => doc.update(hidden, { hidden: true }));
    const panel = app.dock.panels.get('layers');
    panel.ensureBuilt();
    panel.selectRow(doc.get(layer.id), {});
    expect([...ed.selection].sort()).toEqual([a, b].sort());
    // Grouping that selection never puts a layer inside a group.
    await app.commands.run('object.group');
    const g = doc.get([...ed.selection][0]);
    expect(g.type).toBe('group');
    expect(g.children.map((c) => doc.get(c).type)).toEqual(['path', 'path']);
    expect(doc.get(sub).parent).toBe(layer.id);
  });
});

describe('New Layer', () => {
  it('goes right above the active sublayer, not to the bottom of the stack', async () => {
    const { app, ed, doc, layer, sublayer } = setup();
    let top;
    doc.transact('Top', () => (top = doc.addLayer('Top')));
    const sub = sublayer();
    ed.activeLayerId = sub;
    await app.commands.run('layer.new');
    expect(doc.root.children).toEqual([layer.id, top.id]);
    const kids = doc.get(layer.id).children;
    expect(kids).toHaveLength(2);
    expect(kids[0]).toBe(sub);
    expect(ed.activeLayerId).toBe(kids[1]);
    expect(doc.get(kids[1]).type).toBe('layer');
    // The Layers panel's New Layer button does the same.
    app.dock.panels.get('layers').newLayer(false);
    expect(doc.get(layer.id).children).toHaveLength(3);
    expect(doc.root.children).toEqual([layer.id, top.id]);
  });

  it('goes right above the active top-level layer', async () => {
    const { app, ed, doc, layer } = setup();
    let top;
    doc.transact('Top', () => (top = doc.addLayer('Top')));
    ed.activeLayerId = layer.id;
    await app.commands.run('layer.new');
    expect(doc.root.children).toHaveLength(3);
    expect(doc.root.children[0]).toBe(layer.id);
    expect(doc.root.children[2]).toBe(top.id);
  });
});

describe('Redo selection for commands that select after their step', () => {
  it('Layers panel Duplicate selects the copies again on Redo', async () => {
    const { app, ed, doc, add } = setup(await bootAppWithFeatures());
    const a = add(0);
    ed.select([a]);
    await app.commands.run('layers.duplicate');
    const copies = [...ed.selection];
    expect(copies).toHaveLength(1);
    expect(copies[0]).not.toBe(a);
    doc.undo();
    expect([...ed.selection]).toEqual([a]);
    doc.redo();
    expect([...ed.selection]).toEqual(copies);
  });

  it('Template leaves nothing selected on Redo', async () => {
    const { app, ed, doc, add } = setup(await bootAppWithFeatures());
    const a = add(0);
    ed.select([a]);
    await app.commands.run('layers.template');
    expect(ed.selection.size).toBe(0);
    doc.undo();
    doc.redo();
    expect(ed.selection.size).toBe(0);
  });

  it('a selection made later, in another task, does not change the step', async () => {
    const { ed, doc, add } = setup();
    const a = add(0);
    const b = add(20);
    ed.select([a]);
    doc.transact('Move', () => doc.update(a, { name: 'moved' }));
    ed.select([a, b]); // same task: part of the step
    await Promise.resolve();
    ed.select([b]); // later: just a new selection
    doc.undo();
    doc.redo();
    expect([...ed.selection].sort()).toEqual([a, b].sort());
  });
});

describe('undo history memory', () => {
  it('drops the oldest steps once the history holds too many node versions', async () => {
    const { VDocument } = await import('../src/model/document.js');
    const doc = VDocument.create();
    const L = doc.layers()[0].id;
    const ids = [];
    doc.transact('Build', () => {
      for (let i = 0; i < 100; i++)
        ids.push(doc.insert(createPath(rectangle(i, 0, 1, 1), true), L).id);
    });
    doc.historyNodeBudget = 1000;
    // Each step changes all 100 objects: about 10 such steps fit in the budget.
    for (let k = 0; k < 30; k++)
      doc.transact('Edit', () => ids.forEach((id) => doc.update(id, { opacity: k / 30 })));
    expect(doc.undoStack.length).toBeLessThanOrEqual(10);
    expect(doc.undoStack.length).toBeGreaterThanOrEqual(9);
    // Small steps still keep the usual depth.
    for (let k = 0; k < 50; k++) doc.transact('Small', () => doc.update(ids[0], { name: `n${k}` }));
    expect(doc.undoStack.length).toBeGreaterThan(50);
    // The latest step is always kept, however large.
    doc.historyNodeBudget = 10;
    doc.transact('Edit', () => ids.forEach((id) => doc.update(id, { opacity: 1 })));
    expect(doc.undoStack.map((r) => r.label)).toEqual(['Edit']);
    expect(doc.undo()).toBe(true);
    expect(doc.get(ids[0]).opacity).not.toBe(1);
  });
});

describe('Release to Layers on a large layer', () => {
  it('looks at the document once for the new layer colors, not once per layer', async () => {
    const { releaseToLayers } = await import('../src/ops/layer-ops.js');
    const { doc, layer, add } = setup();
    for (let i = 0; i < 40; i++) add(i * 12);
    let walks = 0;
    const walk = doc.walk.bind(doc);
    // Whole-document walks (the recursion passes a node id).
    doc.walk = (...a) => (a[1] === undefined && walks++, walk(...a));
    let made;
    doc.transact('Release to Layers', () => (made = releaseToLayers(doc, layer.id, 'sequence')));
    expect(made).toHaveLength(40);
    expect(walks).toBeLessThan(3);
    // Colors still go through the palette, then repeat its first color, as before.
    const colors = made.map((id) => doc.get(id).color);
    expect(new Set(colors.slice(0, 8)).size).toBe(8);
    expect(colors.slice(8).every((c) => c === colors[8])).toBe(true);
  });
});

describe('Lock Others and Hide Others with sublayers', () => {
  it('act on the objects in sublayers, so Show All and Unlock All bring them back', async () => {
    const { app, ed, doc, layer, add, sublayer } = setup();
    const a = add(0);
    const sub = sublayer();
    const b = add(20, sub);
    ed.select([a]);
    await app.commands.run('object.hideOthers');
    expect(doc.get(sub).hidden).toBe(false);
    expect(doc.isHidden(b)).toBe(true);
    expect(doc.isHidden(a)).toBe(false);
    await app.commands.run('object.showAll');
    expect(doc.isHidden(b)).toBe(false);
    ed.select([b]);
    await app.commands.run('object.lockOthers');
    expect(doc.isLocked(a)).toBe(true);
    expect(doc.isLocked(b)).toBe(false);
    expect(doc.get(sub).locked).toBe(false);
    ed.select([b]);
    await app.commands.run('object.unlockAll');
    expect(doc.isLocked(a)).toBe(false);
    expect(doc.get(layer.id).locked).toBe(false);
  });
});
