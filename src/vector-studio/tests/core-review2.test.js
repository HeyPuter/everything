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
