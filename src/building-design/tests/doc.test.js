import { describe, it, expect } from 'vitest';
import { Doc } from '../src/core/doc.js';
import { createProject } from '../src/core/template.js';

describe('Doc transactions', () => {
  it('records one undo step per transaction and redoes it', () => {
    const doc = new Doc();
    const events = [];
    doc.on((e) => events.push(e));
    const w = doc.transact('Add', () => doc.add({ kind: 'wall', a: [0, 0], b: [1000, 0] }));
    expect(doc.get(w.id).b).toEqual([1000, 0]);
    doc.transact('Move', () => doc.update(w.id, { b: [2000, 0] }));
    expect(doc.undoStack.length).toBe(2);
    expect(doc.undo()).toBe('Move');
    expect(doc.get(w.id).b).toEqual([1000, 0]);
    expect(doc.redo()).toBe('Move');
    expect(doc.get(w.id).b).toEqual([2000, 0]);
    expect(events.at(-1).redo).toBe(true);
    expect(events.at(-1).ids.has(w.id)).toBe(true);
  });

  it('replaces items on update so identity changes', () => {
    const doc = new Doc();
    const a = doc.transact('Add', () => doc.add({ kind: 'level', name: 'A', elevation: 0 }));
    const b = doc.transact('Rename', () => doc.update(a.id, { name: 'B' }));
    expect(a).not.toBe(b);
    expect(Object.isFrozen(b)).toBe(true);
    expect(doc.transact('Same', () => doc.update(a.id, { name: 'B' }))).toBe(b);
    expect(doc.undoStack.length).toBe(2);
  });

  it('rolls back a failed transaction', () => {
    const doc = new Doc();
    expect(() =>
      doc.transact('Bad', () => {
        doc.add({ id: 'x', kind: 'level', name: 'X', elevation: 0 });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(doc.has('x')).toBe(false);
    expect(doc.undoStack.length).toBe(0);
  });

  it('supports previews that are committed or rolled back', () => {
    const doc = new Doc();
    const w = doc.transact('Add', () => doc.add({ kind: 'wall', a: [0, 0], b: [1, 0] }));
    doc.begin('Drag');
    doc.update(w.id, { b: [5, 0] });
    doc.flush();
    expect(doc.get(w.id).b).toEqual([5, 0]);
    doc.rollback();
    expect(doc.get(w.id).b).toEqual([1, 0]);
    expect(doc.undoStack.length).toBe(1);
    doc.begin('Drag');
    doc.update(w.id, { b: [7, 0] });
    doc.commit();
    expect(doc.undoStack.length).toBe(2);
  });

  it('indexes items by kind and removes them', () => {
    const doc = new Doc();
    doc.transact('Add', () => {
      doc.add({ id: 'a', kind: 'wall' });
      doc.add({ id: 'b', kind: 'wall' });
      doc.add({ id: 'c', kind: 'door' });
    });
    expect(doc.all('wall').map((x) => x.id)).toEqual(['a', 'b']);
    doc.transact('Remove', () => doc.remove('a'));
    expect(doc.count('wall')).toBe(1);
    doc.undo();
    expect(doc.count('wall')).toBe(2);
  });

  it('tracks the modified state against the saved revision', () => {
    const doc = new Doc();
    expect(doc.modified).toBe(false);
    doc.transact('Add', () => doc.add({ kind: 'level', elevation: 0 }));
    expect(doc.modified).toBe(true);
    doc.markSaved();
    expect(doc.modified).toBe(false);
    doc.undo();
    expect(doc.modified).toBe(true);
  });

  it('round-trips through JSON', () => {
    const doc = createProject({ system: 'imperial', name: 'House' });
    const copy = Doc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(copy.items.size).toBe(doc.items.size);
    expect(copy.project.name).toBe('House');
    expect(copy.units.system).toBe('imperial');
    expect(copy.levels().map((l) => l.name)).toEqual(['Level 1', 'Level 2']);
    expect(() => Doc.fromJSON({ format: 'other' })).toThrow();
  });
});

describe('templates', () => {
  it('creates levels with plan, ceiling, 3D and elevation views', () => {
    const doc = createProject();
    expect(doc.count('level')).toBe(2);
    expect(doc.count('plan')).toBe(2);
    expect(doc.count('ceilingPlan')).toBe(2);
    expect(doc.count('view3d')).toBe(1);
    expect(doc.count('elevation')).toBe(4);
    expect(doc.count('wallType')).toBeGreaterThan(5);
    expect(doc.undoStack.length).toBe(0);
    expect(doc.modified).toBe(false);
  });
});
