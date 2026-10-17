import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { keysAfter } from '../src/lib/order.js';
import { addPage, childrenOf, movePage, trashPage, restorePage, deletePage, isTrashed, ancestors, trashedPages, updatePage, getPage, wouldCycle } from '../src/data/tree.js';

describe('page tree', () => {
  it('keeps children in order', () => {
    const doc = new Y.Doc();
    const a = addPage(doc, { title: 'A' });
    const c = addPage(doc, { title: 'C' });
    addPage(doc, { title: 'B', after: a });
    addPage(doc, { title: '0', before: a });
    expect(childrenOf(doc).map((p) => p.title)).toEqual(['0', 'A', 'B', 'C']);
    expect(c).toBeTruthy();
  });

  it('moves pages and refuses cycles', () => {
    const doc = new Y.Doc();
    const a = addPage(doc, { title: 'A' });
    const b = addPage(doc, { title: 'B', parent: a });
    const c = addPage(doc, { title: 'C' });
    expect(wouldCycle(doc, a, b)).toBe(true);
    expect(movePage(doc, a, b)).toBe(false);
    expect(movePage(doc, c, a, { before: b })).toBe(true);
    expect(childrenOf(doc, a).map((p) => p.title)).toEqual(['C', 'B']);
    expect(ancestors(doc, b).map((p) => p.title)).toEqual(['A', 'B']);
  });

  it('trashes a subtree and restores it', () => {
    const doc = new Y.Doc();
    const a = addPage(doc, { title: 'A' });
    const b = addPage(doc, { title: 'B', parent: a });
    trashPage(doc, a);
    expect(isTrashed(doc, b)).toBe(true);
    expect(childrenOf(doc)).toEqual([]);
    expect(trashedPages(doc).map((p) => p.id)).toEqual([a]);
    restorePage(doc, a);
    expect(isTrashed(doc, b)).toBe(false);
  });

  it('restores to the top level when the parent is gone', () => {
    const doc = new Y.Doc();
    const a = addPage(doc, { title: 'A' });
    const b = addPage(doc, { title: 'B', parent: a });
    trashPage(doc, b);
    trashPage(doc, a);
    restorePage(doc, b);
    expect(getPage(doc, b).parent).toBe(null);
  });

  it('deletes a page with everything under it', () => {
    const doc = new Y.Doc();
    const a = addPage(doc, { title: 'A' });
    const b = addPage(doc, { title: 'B', parent: a });
    addPage(doc, { title: 'X' });
    expect(deletePage(doc, a).sort()).toEqual([a, b].sort());
    expect(childrenOf(doc).map((p) => p.title)).toEqual(['X']);
  });

  it('hides database rows from children unless asked', () => {
    const doc = new Y.Doc();
    const db = addPage(doc, { title: 'DB', kind: 'database' });
    addPage(doc, { title: 'row', parent: db, row: true });
    expect(childrenOf(doc, db)).toEqual([]);
    expect(childrenOf(doc, db, { rows: true }).length).toBe(1);
  });

  it('merges concurrent renames and moves from two people', () => {
    const one = new Y.Doc();
    const a = addPage(one, { title: 'A' });
    const b = addPage(one, { title: 'B' });
    const two = new Y.Doc();
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    updatePage(one, a, { title: 'Renamed' });
    movePage(two, a, b);
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    expect(getPage(one, a)).toMatchObject({ title: 'Renamed', parent: b });
    expect(getPage(two, a)).toMatchObject({ title: 'Renamed', parent: b });
  });

  it('answers queries from an index that follows every change', () => {
    const doc = new Y.Doc();
    const a = addPage(doc, { title: 'A' });
    expect(childrenOf(doc).map((p) => p.title)).toEqual(['A']);
    // Inside a transaction, reads see the writes made so far.
    doc.transact(() => {
      addPage(doc, { title: 'B' });
      expect(childrenOf(doc).map((p) => p.title)).toEqual(['A', 'B']);
    });
    // Observers run after the transaction and see its result.
    let seen = null;
    doc.getMap('pages').observeDeep(() => {
      seen = childrenOf(doc).map((p) => p.title);
    });
    updatePage(doc, a, { title: 'A2' });
    expect(seen).toEqual(['A2', 'B']);
    // Updates from someone else invalidate it too.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    addPage(other, { title: 'C', parent: a });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
    expect(childrenOf(doc, a).map((p) => p.title)).toEqual(['C']);
    expect(() => {
      childrenOf(doc)[0].title = 'x';
    }).toThrow();
  });

  it('keeps the index right when its first read happens inside a transaction', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      addPage(doc, { title: 'A' });
      addPage(doc, { title: 'B' });
    });
    expect(childrenOf(doc).map((p) => p.title)).toEqual(['A', 'B']);
    expect(new Set(childrenOf(doc).map((p) => p.order)).size).toBe(2);
    // A fresh copy (as after a reset) whose first query is a restore.
    const parent = addPage(doc, { title: 'P' });
    const child = addPage(doc, { title: 'C', parent });
    trashPage(doc, child);
    trashPage(doc, parent);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
    restorePage(fresh, child);
    expect(childrenOf(fresh).map((p) => p.title)).toEqual(['A', 'B', 'C']);
  });

  it('keeps sidebar-style queries cheap in a tree of 10,000 pages', () => {
    const doc = new Y.Doc();
    const db = addPage(doc, { title: 'DB', kind: 'database' });
    doc.transact(() => {
      const keys = keysAfter('', 10000);
      for (let i = 0; i < 10000; i++) {
        const m = new Y.Map();
        for (const [k, v] of Object.entries({ title: `Row ${i}`, parent: db, order: keys[i], kind: 'page', row: true, trashed: null })) m.set(k, v);
        doc.getMap('pages').set(`r${i}`, m);
      }
    });
    const start = performance.now();
    // A change, then a render that asks every visible item for its children.
    addPage(doc, { parent: db, title: 'One more', row: true });
    for (let i = 0; i < 200; i++) childrenOf(doc, i ? `r${i}` : null);
    expect(performance.now() - start).toBeLessThan(500);
    expect(childrenOf(doc, db, { rows: true }).at(-1).title).toBe('One more');
  });
});
