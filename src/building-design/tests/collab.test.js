import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { Doc } from '../src/core/doc.js';
import { mergeRemote, localChanges } from '../src/core/sync.js';
import { enableWorksharing, worksetOf, hiddenByWorkset, deleteWorkset, worksets } from '../src/core/worksets.js';
import { hiddenByFilters } from '../src/core/graphics.js';

/** Two people's copies of one shared project: `a` and `b`, plus the shared file. */
function twoCopies() {
  const { doc } = project();
  const file = () => Doc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
  const a = file();
  const b = file();
  return { a, b, baseA: new Map(a.items), baseB: new Map(b.items), file };
}

const wallOn = (doc, x) => {
  const L = doc.levels()[0];
  return doc.transact('w', () => doc.add({ kind: 'wall', typeId: 'wt-generic', levelId: L.id, a: [x, 0], b: [x + 1000, 0], height: 3000, baseOffset: 0, topOffset: 0, locationLine: 'center' }));
};

describe('three-way merge of shared projects', () => {
  it('brings in what others added and keeps what this copy added', () => {
    const { a, b, baseB } = twoCopies();
    const wa = wallOn(a, 0);
    const wb = wallOn(b, 5000);
    // A saved first; B merges A's copy.
    const r = mergeRemote(baseB, b, new Map(a.items));
    b.applyRemote(r.incoming);
    expect(b.get(wa.id)).toBeTruthy();
    expect(b.get(wb.id)).toBeTruthy();
    expect(r.conflicts).toHaveLength(0);
    expect(r.pending).toBe(1);
    expect(localChanges(r.nextBase, b)).toEqual([wb.id]);
  });

  it('applies others\' edits and deletions to elements this copy left alone', () => {
    const { doc } = project();
    const w1 = wallOn(doc, 0);
    const w2 = wallOn(doc, 3000);
    const json = JSON.stringify(doc.toJSON());
    const a = Doc.fromJSON(JSON.parse(json));
    const b = Doc.fromJSON(JSON.parse(json));
    const baseB = new Map(b.items);
    a.transact('e', () => {
      a.update(w1.id, { height: 4000 });
      a.remove(w2.id);
    });
    const r = mergeRemote(baseB, b, new Map(a.items));
    b.applyRemote(r.incoming);
    expect(b.get(w1.id).height).toBe(4000);
    expect(b.has(w2.id)).toBe(false);
    expect(r.pending).toBe(0);
    // Nothing left to share, so the copy counts as saved.
    expect(b.modified).toBe(false);
  });

  it('keeps this copy\'s version when both changed the same element, and reports it', () => {
    const { doc } = project();
    const w = wallOn(doc, 0);
    const json = JSON.stringify(doc.toJSON());
    const a = Doc.fromJSON(JSON.parse(json));
    const b = Doc.fromJSON(JSON.parse(json));
    const baseB = new Map(b.items);
    a.transact('e', () => a.update(w.id, { height: 4000 }));
    b.transact('e', () => b.update(w.id, { height: 2500 }));
    const r = mergeRemote(baseB, b, new Map(a.items));
    b.applyRemote(r.incoming);
    expect(r.conflicts).toEqual([w.id]);
    expect(b.get(w.id).height).toBe(2500);
    expect(r.pending).toBe(1);
  });

  it('restores an element deleted here that someone else edited', () => {
    const { doc } = project();
    const w = wallOn(doc, 0);
    const json = JSON.stringify(doc.toJSON());
    const a = Doc.fromJSON(JSON.parse(json));
    const b = Doc.fromJSON(JSON.parse(json));
    const baseB = new Map(b.items);
    a.transact('e', () => a.update(w.id, { height: 4000 }));
    b.transact('d', () => b.remove(w.id));
    const r = mergeRemote(baseB, b, new Map(a.items));
    b.applyRemote(r.incoming);
    expect(b.get(w.id).height).toBe(4000);
  });

  it('does not let undo revert someone else\'s change', () => {
    const { doc } = project();
    const w = wallOn(doc, 0);
    const json = JSON.stringify(doc.toJSON());
    const a = Doc.fromJSON(JSON.parse(json));
    const b = Doc.fromJSON(JSON.parse(json));
    const baseB = new Map(b.items);
    b.transact('e', () => b.update(w.id, { height: 2000 }));
    b.undo();
    b.redo();
    a.transact('e', () => a.update(w.id, { mark: 'A1' }));
    // B's edit is undone again before syncing, so only A's change remains.
    b.undo();
    const r = mergeRemote(baseB, b, new Map(a.items));
    b.applyRemote(r.incoming);
    expect(b.get(w.id).mark).toBe('A1');
    expect(b.canUndo).toBe(false);
  });
});

describe('worksets', () => {
  it('puts datums in the shared workset and model elements in the first one', () => {
    const { doc, wall } = project();
    const w = wall([0, 0], [4000, 0]);
    doc.transact('ws', () => enableWorksharing(doc));
    const [shared, first] = worksets(doc);
    expect(shared.shared).toBe(true);
    expect(worksetOf(doc, doc.levels()[0]).id).toBe(shared.id);
    expect(worksetOf(doc, doc.get(w.id)).id).toBe(first.id);
  });

  it('hides elements of worksets turned off in a view or by default', () => {
    const { doc, wall } = project();
    const w = wall([0, 0], [4000, 0]);
    doc.transact('ws', () => enableWorksharing(doc));
    const view = doc.all('plan')[0];
    const first = worksets(doc)[1];
    expect(hiddenByWorkset(doc, view, doc.get(w.id))).toBe(false);
    doc.transact('v', () => doc.update(view.id, { worksets: { [first.id]: false } }));
    expect(hiddenByFilters(doc, doc.get(view.id), doc.get(w.id))).toBe(true);
    doc.transact('v', () => doc.update(view.id, { worksets: {} }));
    doc.transact('d', () => doc.update(first.id, { visibleByDefault: false }));
    expect(hiddenByWorkset(doc, doc.get(view.id), doc.get(w.id))).toBe(true);
  });

  it('moves elements when their workset is deleted', () => {
    const { doc, wall } = project();
    const w = wall([0, 0], [4000, 0]);
    doc.transact('ws', () => enableWorksharing(doc));
    const second = doc.transact('n', () => doc.add({ kind: 'workset', name: 'Interiors', visibleByDefault: true }));
    doc.transact('m', () => doc.update(w.id, { worksetId: second.id }));
    const first = worksets(doc)[1];
    doc.transact('d', () => deleteWorkset(doc, second.id, first.id));
    expect(doc.get(w.id).worksetId).toBe(first.id);
    expect(doc.has(second.id)).toBe(false);
  });
});
