// Editing core, layers and undo: regressions found in the second review.
import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { insertLayer } from '../src/ops/layer-ops.js';

function setup() {
  const app = bootApp();
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
