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

  it('stays dirty after undoing past the save and making a different change', () => {
    const { doc, layer } = docWithRect();
    doc.markSaved();
    const saved = doc.revision;
    doc.undo();
    expect(doc.dirty).toBe(true);
    doc.transact('Other', () => doc.insert(createPath(rectangle(5, 5, 10, 10), true), layer.id));
    // Same history depth as the saved state, different content.
    expect(doc.dirty).toBe(true);
    expect(doc.revision).not.toBe(saved);
    doc.undo();
    doc.redo();
    expect(doc.dirty).toBe(true);
  });

  it('gives a coalesced change a new revision (autosave and caches see it)', () => {
    const { doc, rect } = docWithRect();
    doc.transact('Opacity', () => doc.update(rect.id, { opacity: 0.5 }), { coalesce: 'op' });
    const first = doc.revision;
    doc.transact('Opacity', () => doc.update(rect.id, { opacity: 0.4 }), { coalesce: 'op' });
    expect(doc.undoStack).toHaveLength(2);
    expect(doc.revision).not.toBe(first);
    doc.undo();
    doc.redo();
    expect(doc.get(rect.id).opacity).toBe(0.4);
    expect(doc.revision).not.toBe(first);
  });

  it('is clean again after undoing and redoing back to the saved state', () => {
    const { doc, rect } = docWithRect();
    doc.transact('Name', () => doc.update(rect.id, { name: 'A' }));
    doc.markSaved();
    doc.undo();
    doc.undo();
    expect(doc.dirty).toBe(true);
    doc.redo();
    doc.redo();
    expect(doc.dirty).toBe(false);
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

  it('moves and removes thousands of nodes without copying the children lists each time', () => {
    const doc = VDocument.create();
    const layer = doc.layers()[0];
    const ids = [];
    doc.transact('Many', () => {
      for (let i = 0; i < 5000; i++) ids.push(doc.insert(createPath(rectangle(i, 0, 1, 1), true), layer.id).id);
    });
    const g = createGroup([]);
    // A list is copied when a transaction first changes it, then edited in place
    // while nobody reads it (copying it on every call is quadratic).
    const { slice, filter } = Array.prototype;
    let copies = 0;
    Array.prototype.slice = function (...a) {
      if (this.length >= 1000) copies++;
      return slice.apply(this, a);
    };
    Array.prototype.filter = function (...a) {
      if (this.length >= 1000) copies++;
      return filter.apply(this, a);
    };
    try {
      doc.transact('Group', () => {
        doc.insert(g, layer.id);
        for (const id of ids) doc.move(id, g.id);
      });
      doc.transact('Ungroup', () => {
        let at = doc.get(layer.id).children.indexOf(g.id);
        for (const id of ids) doc.move(id, layer.id, at++);
        doc.remove(g.id);
      });
      doc.transact('Delete', () => ids.forEach((id) => doc.remove(id)));
    } finally {
      Object.assign(Array.prototype, { slice, filter });
    }
    expect(copies).toBeLessThan(10);
    expect(doc.get(layer.id).children).toHaveLength(0);
    doc.undo();
    expect(doc.get(layer.id).children).toEqual(ids);
    doc.undo();
    expect(doc.get(layer.id).children).toEqual([g.id]);
    expect(doc.get(g.id).children).toEqual(ids);
    expect(doc.get(ids[5]).parent).toBe(g.id);
    doc.undo();
    expect(doc.get(layer.id).children).toEqual(ids);
    expect(doc.has(g.id)).toBe(false);
    doc.redo();
    doc.redo();
    doc.redo();
    expect(doc.get(layer.id).children).toHaveLength(0);
  });

  it('gives a container a new node object each time a move or removal changes its children', () => {
    const doc = VDocument.create();
    const layer = doc.layers()[0];
    const a = createPath(rectangle(0, 0, 1, 1), true);
    const b = createPath(rectangle(0, 0, 1, 1), true);
    const g = createGroup([]);
    doc.transact('Setup', () => [a, b, g].forEach((n) => doc.insert(n, layer.id)));
    const seen = [];
    const tx = doc.begin('Live');
    doc.move(a.id, g.id);
    seen.push(doc.get(g.id), doc.get(layer.id));
    doc.move(b.id, g.id);
    seen.push(doc.get(g.id), doc.get(layer.id));
    doc.remove(a.id);
    seen.push(doc.get(g.id));
    tx.commit();
    expect(new Set(seen).size).toBe(seen.length);
    expect(doc.get(g.id).children).toEqual([b.id]);
    doc.undo();
    expect(doc.get(g.id).children).toEqual([]);
    expect(doc.get(layer.id).children).toEqual([a.id, b.id, g.id]);
  });

  it('gives callers node objects whose children lists never change under them, within one transaction', () => {
    const doc = VDocument.create();
    const layer = doc.layers()[0].id;
    const g = createGroup([]);
    const h = createGroup([]);
    const kids = () => Array.from({ length: 6 }, (_, i) => createPath(rectangle(i, 0, 1, 1), true));
    const tx = doc.begin('Live');
    doc.insert(g, layer);
    doc.insert(h, layer);
    for (const k of kids()) doc.insert(k, g.id);
    // Removing every child while iterating the list a node object holds.
    const fetched = doc.get(g.id);
    const list = fetched.children;
    const before = list.slice();
    for (const c of fetched.children) doc.remove(c);
    expect(doc.get(g.id).children).toEqual([]);
    expect(list).toEqual(before);
    // Moving every child to another container while iterating.
    for (const k of kids()) doc.insert(k, g.id);
    for (const c of doc.get(g.id).children) doc.move(c, h.id);
    expect(doc.get(g.id).children).toEqual([]);
    expect(doc.get(h.id).children).toHaveLength(6);
    // Inserting into the container being iterated visits only what was there (and ends).
    let visited = 0;
    for (const c of doc.get(h.id).children) {
      visited++;
      doc.insert(createPath(rectangle(0, 0, 1, 1), true), h.id, doc.get(h.id).children.indexOf(c));
    }
    expect(visited).toBe(6);
    expect(doc.get(h.id).children).toHaveLength(12);
    // The same right after inserting into it (bulk inserts edit the list in place until it is read).
    const k = createGroup([]);
    doc.insert(k, layer);
    for (let i = 0; i < 3; i++) doc.insert(createPath(rectangle(i, 0, 1, 1), true), k.id);
    let seen = 0;
    for (const c of doc.get(k.id).children) {
      if (++seen > 50) break;
      doc.insert(createPath(rectangle(0, 0, 1, 1), true), k.id, doc.get(k.id).children.indexOf(c) + 1);
    }
    expect(seen).toBe(3);
    expect(doc.get(k.id).children).toHaveLength(6);
    // A node object fetched mid-transaction is a snapshot.
    const snap = doc.get(h.id);
    const snapKids = snap.children.slice();
    doc.remove(snapKids[0]);
    doc.move(snapKids[1], g.id);
    doc.insert(createPath(rectangle(0, 0, 1, 1), true), h.id);
    expect(snap.children).toEqual(snapKids);
    // Nodes found by going through the whole map are snapshots too.
    const viaValues = [...doc.nodes.values()].find((n) => n.id === h.id);
    const viaValuesKids = viaValues.children.slice();
    doc.insert(createPath(rectangle(0, 0, 1, 1), true), h.id);
    expect(viaValues.children).toEqual(viaValuesKids);
    tx.commit();
    doc.undo();
    expect(doc.has(g.id)).toBe(false);
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
