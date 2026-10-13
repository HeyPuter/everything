import { describe, it, expect } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

function docWithRect() {
  const doc = VDocument.create();
  const layer = doc.layers()[0];
  const rect = createPath(rectangle(0, 0, 100, 50), true);
  doc.transact('Rect', () => doc.insert(rect, layer.id));
  return { doc, layer, rect: doc.get(rect.id) };
}

describe('VDocument', () => {
  it('creates a document with one layer and one artboard', () => {
    const doc = VDocument.create({ width: 200, height: 100, artboards: 3 });
    expect(doc.layers()).toHaveLength(1);
    expect(doc.artboards).toHaveLength(3);
    expect(doc.artboards[0]).toMatchObject({ w: 200, h: 100 });
  });

  it('undoes and redoes inserts as one step', () => {
    const { doc, rect } = docWithRect();
    expect(doc.has(rect.id)).toBe(true);
    expect(doc.dirty).toBe(true);
    doc.undo();
    expect(doc.has(rect.id)).toBe(false);
    expect(doc.dirty).toBe(false);
    doc.redo();
    expect(doc.get(rect.id).anchors).toHaveLength(4);
  });

  it('keeps the old node object as the undo snapshot (immutable updates)', () => {
    const { doc, rect } = docWithRect();
    doc.transact('Move', () => doc.update(rect.id, { name: 'Box' }));
    expect(doc.get(rect.id)).not.toBe(rect);
    doc.undo();
    expect(doc.get(rect.id)).toBe(rect);
  });

  it('rolls back a cancelled transaction', () => {
    const { doc, rect } = docWithRect();
    const tx = doc.begin('Drag');
    doc.update(rect.id, { hidden: true });
    tx.cancel();
    expect(doc.get(rect.id).hidden).toBe(false);
    expect(doc.undoStack).toHaveLength(1);
  });

  it('rolls back when a transaction throws', () => {
    const { doc, rect } = docWithRect();
    expect(() =>
      doc.transact('Bad', () => {
        doc.update(rect.id, { name: 'x' });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(doc.get(rect.id).name).toBe('');
  });

  it('coalesces repeated changes with the same key into one undo step', () => {
    const { doc, rect } = docWithRect();
    for (let i = 1; i <= 5; i++) doc.transact('Opacity', () => doc.update(rect.id, { opacity: 1 - i / 10 }), { coalesce: 'op' });
    expect(doc.undoStack).toHaveLength(2);
    doc.undo();
    expect(doc.get(rect.id).opacity).toBe(1);
  });

  it('moves nodes between parents and refuses cycles', () => {
    const { doc, layer, rect } = docWithRect();
    const g = createGroup([]);
    doc.transact('Group', () => {
      doc.insert(g, layer.id);
      doc.move(rect.id, g.id);
    });
    expect(doc.get(g.id).children).toEqual([rect.id]);
    expect(doc.get(rect.id).parent).toBe(g.id);
    expect(() => doc.transact('Cycle', () => doc.move(g.id, rect.id))).toThrow();
  });

  it('removes a subtree and its references', () => {
    const { doc, layer, rect } = docWithRect();
    doc.transact('Delete', () => doc.remove(rect.id));
    expect(doc.has(rect.id)).toBe(false);
    expect(doc.get(layer.id).children).not.toContain(rect.id);
  });

  it('round-trips through JSON', () => {
    const { doc, rect } = docWithRect();
    const copy = VDocument.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(copy.get(rect.id).anchors).toEqual(rect.anchors);
    expect(copy.layers()).toHaveLength(1);
  });

  it('clones subtrees with fresh ids', () => {
    const { doc, rect } = docWithRect();
    const { node } = doc.cloneSubtree(rect.id);
    expect(node.id).not.toBe(rect.id);
    expect(node.anchors).toEqual(rect.anchors);
  });
});

describe('VDocument bulk edits', () => {
  it('inserts thousands of nodes in linear time and undoes them in one step', () => {
    const timeInsert = (count) => {
      const d = VDocument.create();
      const l = d.layers()[0];
      const t0 = performance.now();
      d.transact('Many', () => {
        for (let i = 0; i < count; i++) d.insert(createPath(rectangle(i, 0, 1, 1), true), l.id);
      });
      return { ms: performance.now() - t0, d, l };
    };
    timeInsert(2000); // warm up
    // The fastest of a few runs, so a GC pause or a busy machine doesn't skew the ratio.
    const fastest = (count, runs) => Array.from({ length: runs }, () => timeInsert(count)).reduce((a, b) => (b.ms < a.ms ? b : a));
    const small = fastest(4000, 3);
    const { ms, d: doc, l: layer } = fastest(16000, 2);
    // 4x the nodes: linear is ~4x the time, quadratic would be ~16x.
    expect(ms / Math.max(small.ms, 1)).toBeLessThan(10);
    expect(doc.get(layer.id).children).toHaveLength(16000);
    doc.undo();
    expect(doc.get(layer.id).children).toHaveLength(0);
    doc.redo();
    expect(doc.get(layer.id).children).toHaveLength(16000);
  });

  it('never mutates the undo snapshot of a container', () => {
    const doc = VDocument.create();
    const layer = doc.layers()[0];
    const before = doc.get(layer.id);
    doc.transact('A', () => doc.insert(createPath(rectangle(0, 0, 1, 1), true), layer.id));
    const afterA = doc.get(layer.id);
    doc.transact('B', () => doc.insert(createPath(rectangle(0, 0, 1, 1), true), layer.id));
    expect(before.children).toHaveLength(0);
    expect(afterA.children).toHaveLength(1);
    doc.undo();
    expect(doc.get(layer.id).children).toHaveLength(1);
  });
});

describe('Editor.topSelection', () => {
  it('drops descendants of selected containers and stays fast for huge selections', async () => {
    const { Editor } = await import('../src/editor.js');
    const { createPath: cp, createGroup: cg } = await import('../src/model/nodes.js');
    const { rectangle: rect } = await import('../src/model/shapes.js');
    const doc = VDocument.create({ name: 'Many' });
    const layer = doc.layers()[0];
    let g;
    let inner;
    const ids = [];
    doc.transact('Many', () => {
      g = cg();
      doc.insert(g, layer.id);
      inner = cp(rect(0, 0, 1, 1), true);
      doc.insert(inner, g.id);
      for (let i = 0; i < 20000; i++) {
        const p = cp(rect(i, 0, 1, 1), true);
        doc.insert(p, layer.id);
        ids.push(p.id);
      }
    });
    const ed = new Editor(doc);
    ed.select([g.id, inner.id, ...ids]);
    const t0 = performance.now();
    const top = ed.topSelection();
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(top).toHaveLength(20001);
    expect(top).not.toContain(inner.id);
    expect(top[0]).toBe(g.id);
  });
});

describe('active artboard follows the selection', () => {
  it('activates the artboard of selected artwork, but not for selections across artboards', async () => {
    const { Editor } = await import('../src/editor.js');
    const doc = VDocument.create({ name: 'Boards', width: 100, height: 100 });
    const layer = doc.layers()[0];
    const a = createPath(rectangle(10, 10, 20, 20), true);
    const b = createPath(rectangle(210, 10, 20, 20), true);
    doc.transact('Build', () => {
      doc.updateRoot({ artboards: [...doc.artboards, { id: 'ab2', name: 'Two', x: 200, y: 0, w: 100, h: 100 }] });
      doc.insert(a, layer.id);
      doc.insert(b, layer.id);
    });
    const ed = new Editor(doc);
    let events = 0;
    ed.on('artboard', () => events++);
    ed.select([b.id]);
    expect(ed.activeArtboard).toBe(1);
    ed.select([a.id, b.id]);
    expect(ed.activeArtboard).toBe(1);
    ed.select([a.id]);
    expect(ed.activeArtboard).toBe(0);
    expect(events).toBe(2);
  });
});
