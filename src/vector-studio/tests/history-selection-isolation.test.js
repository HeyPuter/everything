import { describe, expect, it } from 'vitest';
import { bootApp, bootAppWithFeatures } from './helpers.js';
import { createGroup, createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

describe.each([false, true])('history selection within isolation (features: %s)', (features) => {
  it('filters outside objects and anchors during undo and redo in a shared window', async () => {
    const app = features ? await bootAppWithFeatures() : bootApp();
    try {
      const first = app.newDocument();
      const doc = first.doc;
      const group = createGroup([]);
      const inside = createPath(rectangle(0, 0, 20, 20), true);
      const outside = createPath(rectangle(50, 0, 20, 20), true);
      doc.transact('Artwork', () => {
        doc.insert(group, first.targetLayer().id);
        doc.insert(inside, group.id);
        doc.insert(outside, first.targetLayer().id);
      });
      first.selectAnchors(inside.id, [0]);
      first.selectAnchors(outside.id, [1], { add: true });
      doc.transact('Opacity', () => doc.update(outside.id, { opacity: 0.5 }));
      // Subsequent selection changes must not amend the command's selectionAfter.
      await Promise.resolve();
      const second = app.addDocument(doc);
      await app.commands.run('object.isolate', { id: group.id });
      for (const direction of ['undo', 'redo']) {
        expect(doc[direction]()).toBe(true);
        expect(second.isolation).toBe(group.id);
        expect([...second.selection]).toEqual([inside.id]);
        expect([...second.anchors.keys()]).toEqual([inside.id]);
        expect([...second.anchors.get(inside.id)]).toEqual([0]);
      }
      await app.commands.run('edit.clear');
      expect(doc.has(outside.id)).toBe(true);
      expect(doc.get(outside.id).anchors).toHaveLength(4);
    } finally {
      for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
    }
  });

  it('restores the surviving isolated leaf when undo removes its drawing container', async () => {
    const app = features ? await bootAppWithFeatures() : bootApp();
    try {
      const ed = app.newDocument();
      const doc = ed.doc;
      const leaf = createPath(rectangle(0, 0, 20, 20), true);
      doc.transact('Leaf', () => doc.insert(leaf, ed.targetLayer().id));
      await app.commands.run('object.isolate', { id: leaf.id });
      ed.select([leaf.id]);
      const added = createPath(rectangle(50, 0, 20, 20), true);
      doc.transact('Draw alongside leaf', () => doc.insert(added, ed.targetLayer().id));
      expect(ed.isolation).not.toBe(leaf.id);
      doc.undo();
      expect(ed.isolation).toBe(leaf.id);
      expect([...ed.selection]).toEqual([leaf.id]);
    } finally {
      for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
    }
  });

  it('restores ordinary selection when undo removes the isolated object itself', async () => {
    const app = features ? await bootAppWithFeatures() : bootApp();
    try {
      const ed = app.newDocument();
      const doc = ed.doc;
      const outside = createPath(rectangle(0, 0, 20, 20), true);
      doc.transact('Outside', () => doc.insert(outside, ed.targetLayer().id));
      ed.select([outside.id]);
      const isolated = createPath(rectangle(50, 0, 20, 20), true);
      doc.transact('Isolated', () => doc.insert(isolated, ed.targetLayer().id));
      await app.commands.run('object.isolate', { id: isolated.id });
      doc.undo();
      expect(ed.isolation).toBeNull();
      expect([...ed.selection]).toEqual([outside.id]);
    } finally {
      for (const ed of [...app.editors]) await app.closeDocument(ed, { force: true });
    }
  });

});
