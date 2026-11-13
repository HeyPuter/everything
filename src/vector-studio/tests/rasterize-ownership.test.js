import { describe, expect, it } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { Editor } from '../src/editor.js';
import { createPath, createGroup, createLayer } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { rasterizeObjects } from '../src/features/effects/raster.js';

function setup({ group = false, twoLayers = false } = {}) {
  const doc = VDocument.create();
  const ed = new Editor(doc);
  const path = createPath(rectangle(0, 0, 40, 30), true);
  const parent = group ? createGroup([]) : null;
  let other;
  doc.transact('Artwork', () => {
    const layer = doc.root.children[0];
    if (parent) doc.insert(parent, layer);
    doc.insert(path, parent?.id || layer);
    if (twoLayers) {
      const second = doc.insert(createLayer('Second'), 'root');
      other = doc.insert(createPath(rectangle(10, 10, 40, 30), true), second.id);
    }
  });
  const ids = [parent?.id || path.id, ...(other ? [other.id] : [])];
  ed.select(ids);
  let finish;
  const pending = rasterizeObjects(ed, ids, { resolution: 72 }, () => new Promise((resolve) => { finish = resolve; }));
  const complete = () => { finish({ data: 'data:image/png;base64,AAAA', width: 40, height: 30 }); return pending; };
  return { doc, ed, path, parent, ids, complete };
}

function unchanged(doc, nodes, history, assets) {
  expect([...doc.nodes]).toEqual(nodes);
  expect(doc.undoStack).toHaveLength(history);
  expect([...doc.assets]).toEqual(assets);
}

describe('Rasterize asynchronous ownership', () => {
  for (const change of ['edit', 'delete', 'child edit', 'child insert', 'child delete', 'layer order']) {
    it(`discards the rendered result after ${change}`, async () => {
      const { doc, path, parent, complete } = setup({ group: change.startsWith('child'), twoLayers: change === 'layer order' });
      doc.transact('Newer edit', () => {
        if (change === 'edit' || change === 'child edit') doc.update(path.id, { name: 'Keep newer artwork' });
        if (change === 'delete' || change === 'child delete') doc.remove(path.id);
        if (change === 'child insert') doc.insert(createPath(rectangle(5, 5, 20, 20), true), parent.id);
        if (change === 'layer order') doc.move(doc.root.children[0], 'root');
      });
      const nodes = [...doc.nodes], assets = [...doc.assets], history = doc.undoStack.length;
      expect(await complete()).toBeNull();
      unchanged(doc, nodes, history, assets);
    });
  }
  it('does not join a newer transaction or leave an image asset behind', async () => {
    const { doc, complete } = setup();
    const tx = doc.begin('Newer edit');
    doc.updateRoot({ name: 'Newer edit' });
    const nodes = [...doc.nodes], assets = [...doc.assets], history = doc.undoStack.length;
    try {
      expect(await complete()).toBeNull();
      expect(doc.tx).toBe(tx);
      unchanged(doc, nodes, history, assets);
    } finally { tx.cancel(); }
  });
  it('does not leave assets or history behind when editing permission is revoked', async () => {
    const { doc, complete } = setup();
    doc.readOnly = true;
    const nodes = [...doc.nodes], assets = [...doc.assets], history = doc.undoStack.length;
    expect(await complete()).toBeNull();
    unchanged(doc, nodes, history, assets);
  });
  it('keeps unrelated edits and replaces unchanged artwork in one undo step', async () => {
    const { doc, path, complete } = setup();
    let other;
    doc.transact('Other artwork', () => { other = doc.insert(createPath(rectangle(100, 0, 10, 10), true), doc.root.children[0]); });
    const history = doc.undoStack.length;
    const result = await complete();
    expect(doc.get(result).type).toBe('image');
    expect(doc.has(path.id)).toBe(false);
    expect(doc.get(other.id)).toEqual(other);
    expect(doc.undoStack).toHaveLength(history + 1);
    doc.undo();
    expect(doc.has(result)).toBe(false);
    expect(doc.get(path.id).anchors).toEqual(path.anchors);
    expect(doc.get(other.id)).toEqual(other);
    doc.redo();
    expect(doc.get(result).type).toBe('image');
  });
});
