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

describe('Lock and Hide All Artwork Above with sublayers', () => {
  it('act on the overlapping objects in a sublayer above, not on the sublayer', async () => {
    const { app, ed, doc, add, sublayer } = setup(await bootAppWithFeatures());
    const a = add(0);
    const sub = sublayer();
    const b = add(5, sub);
    const far = add(500, sub);
    ed.select([a]);
    await app.commands.run('object.hideAbove');
    expect(doc.get(sub).hidden).toBe(false);
    expect(doc.isHidden(b)).toBe(true);
    expect(doc.isHidden(far)).toBe(false);
    await app.commands.run('object.showAll');
    expect(doc.isHidden(b)).toBe(false);
  });
});

describe('Layers panel Delete button', () => {
  it('deletes every picked layer, as the panel menu does', async () => {
    const { app, ed, doc, layer } = setup(await bootAppWithFeatures());
    let two;
    let three;
    doc.transact('Layers', () => {
      two = doc.addLayer('Two');
      three = doc.addLayer('Three');
    });
    const panel = app.dock.panels.get('layers');
    panel.ensureBuilt();
    panel.update();
    panel.pickLayer(doc.get(two.id));
    panel.pickLayer(doc.get(three.id), { metaKey: true, ctrlKey: true });
    ed.clearSelection();
    panel.deleteSelected();
    expect(doc.layers().map((l) => l.id)).toEqual([layer.id]);
    expect(doc.undoStack.at(-1).label).toBe('Delete Layers');
    doc.undo();
    expect(doc.layers()).toHaveLength(3);
  });
});

describe('new layer names', () => {
  it('never repeat a name already used by a layer or sublayer', async () => {
    const { app, ed, doc, layer } = setup();
    const panel = app.dock.panels.get('layers');
    panel.ensureBuilt();
    panel.newLayer(true);
    ed.activeLayerId = layer.id;
    panel.newLayer(false);
    ed.activeLayerId = layer.id;
    await app.commands.run('layer.new');
    panel.newLayer(true);
    const names = [];
    doc.walk((n) => {
      if (n.type === 'layer') names.push(n.name);
      return n.type === 'layer';
    });
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
  });
});

describe('Send to Current Layer', () => {
  it('leaves objects already on the layer in place and moves the others to its top', async () => {
    const { app, ed, doc, layer, add } = setup();
    const a = add(0);
    const b = add(20);
    let other;
    doc.transact('Other', () => (other = doc.addLayer('Other')));
    const c = add(40, other.id);
    ed.select([a, c]);
    ed.activeLayerId = layer.id;
    await app.commands.run('object.sendToLayer');
    expect(doc.get(layer.id).children).toEqual([a, b, c]);
    // Nothing to move: no undo step.
    const steps = doc.undoStack.length;
    ed.select([a]);
    ed.activeLayerId = layer.id;
    await app.commands.run('object.sendToLayer');
    expect(doc.get(layer.id).children).toEqual([a, b, c]);
    expect(doc.undoStack.length).toBe(steps);
  });

  it('refuses a locked current layer', async () => {
    const { app, ed, doc, add } = setup();
    const a = add(0);
    let other;
    doc.transact('Other', () => (other = doc.addLayer('Other')));
    doc.transact('Lock', () => doc.update(other.id, { locked: true }));
    ed.select([a]);
    ed.activeLayerId = other.id;
    await app.commands.run('object.sendToLayer');
    expect(doc.get(a).parent).not.toBe(other.id);
    expect(document.querySelector('.toast.error')?.textContent).toMatch(/locked or hidden/);
  });
});

describe('Layers panel drop into a locked layer', () => {
  it('leaves the dropped objects unselected, so they cannot be moved while locked', async () => {
    const { app, ed, doc, add } = setup();
    const a = add(0);
    let other;
    doc.transact('Other', () => (other = doc.addLayer('Other')));
    doc.transact('Lock', () => doc.update(other.id, { locked: true }));
    ed.select([a]);
    const panel = app.dock.panels.get('layers');
    panel.ensureBuilt();
    panel.dropOn([a], doc.get(other.id), 'into');
    expect(doc.get(a).parent).toBe(other.id);
    expect(ed.selection.has(a)).toBe(false);
    // Undo brings the object back where it was, selected again.
    doc.undo();
    expect(ed.selection.has(a)).toBe(true);
  });
});

describe('isolating a layer', () => {
  it('leaves nothing selected on exit, never the layer itself', async () => {
    const { app, ed, doc, layer, add } = setup(await bootAppWithFeatures());
    add(0);
    ed.clearSelection();
    await app.commands.run('layers.isolate');
    expect(ed.isolation).toBe(layer.id);
    await app.commands.run('object.exitIsolation');
    expect(ed.isolation).toBe(null);
    expect([...ed.selection].map((id) => doc.get(id).type)).not.toContain('layer');
  });
});

describe('Paste Remembers Layers in isolation mode', () => {
  it('pastes into the isolated group, not back into the remembered layer', async () => {
    const { createGroup } = await import('../src/model/nodes.js');
    const { app, ed, doc, layer, add } = setup(await bootAppWithFeatures());
    app.prefs.set('pasteRemembersLayers', true);
    const a = add(0);
    const g = createGroup([]);
    doc.transact('G', () => doc.insert(g, layer.id));
    add(30, g.id);
    ed.select([a]);
    await app.commands.run('edit.copy');
    ed.select([g.id]);
    await app.commands.run('object.isolate');
    expect(ed.isolation).toBe(g.id);
    await app.commands.run('edit.paste', { internal: true });
    const pasted = [...ed.selection];
    expect(pasted).toHaveLength(1);
    expect(doc.get(pasted[0]).parent).toBe(g.id);
  });
});

describe('Make Compound Path containment test', () => {
  it('finds the same contained outlines as comparing every pair', async () => {
    const { containedFlags } = await import('../src/ops/object-ops.js');
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const contains = (a, b) =>
      a &&
      b &&
      b.x >= a.x - 1e-6 &&
      b.y >= a.y - 1e-6 &&
      b.x + b.w <= a.x + a.w + 1e-6 &&
      b.y + b.h <= a.y + a.h + 1e-6 &&
      (a.w > b.w || a.h > b.h);
    const brute = (bs) => bs.map((b, i) => bs.some((o, j) => j !== i && contains(o, b)));
    const sets = [
      // Scattered boxes of mixed sizes, some inside others.
      Array.from({ length: 400 }, () => ({
        x: rand() * 1000,
        y: rand() * 1000,
        w: rand() * (rand() < 0.1 ? 600 : 40),
        h: rand() * (rand() < 0.1 ? 600 : 40),
      })),
      // Nested outlines (rings, letters with holes), touching edges, a missing box and a broken one.
      Array.from({ length: 50 }, (_, i) => ({ x: i, y: i, w: 200 - 2 * i, h: 200 - 2 * i })),
      [
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 0, y: 0, w: 10, h: 5 },
        { x: 10, y: 0, w: 10, h: 10 },
        null,
        { x: NaN, y: 0, w: 1, h: 1 },
        { x: 2, y: 2, w: 0, h: 0 },
      ],
    ];
    for (const bs of sets) expect(containedFlags(bs)).toEqual(brute(bs));
  });
});
