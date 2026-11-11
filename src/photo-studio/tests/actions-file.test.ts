import { describe, expect, it } from 'vitest';
import { readActionSets } from '../src/features/actions';

describe('action sets from stored data and files', () => {
  it('rebuilds sets from checked fields and gives imported ones new identifiers', () => {
    const hostile = '"><img src=x onerror=alert(1)>';
    const data = [
      { id: hostile, name: 'Evil', open: true, actions: [{ id: hostile, name: 'A', steps: [{ command: 'layer.duplicate', arg: { amount: 2 } }, { command: 5 }, null, { command: 'image.trim', enabled: false, dialog: 'yes' }] }, 'junk'] },
      { name: 'No actions' },
      null,
      'text',
    ];
    const sets = readActionSets(data, true);
    expect(sets.map((s) => s.name)).toEqual(['Evil', 'No actions']);
    expect(sets[1].actions).toEqual([]);
    const [a] = sets[0].actions;
    expect(a.name).toBe('A');
    expect(a.steps).toEqual([
      { command: 'layer.duplicate', arg: { amount: 2 }, enabled: true, dialog: false },
      { command: 'image.trim', enabled: false, dialog: false },
    ]);
    for (const id of [sets[0].id, a.id, sets[1].id]) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // Importing the same file twice makes separate copies.
    expect(readActionSets(data, true)[0].actions[0].id).not.toBe(a.id);
  });
  it('keeps the identifiers of stored sets that are safe, so event rules still find them', () => {
    const stored = [{ id: 'defaults', name: 'Default Actions', actions: [{ id: 'a-trim', name: 'Trim', steps: [] }, { id: 'bad:id', name: 'Colon', steps: [] }] }];
    const sets = readActionSets(stored, false);
    expect(sets[0].id).toBe('defaults');
    expect(sets[0].actions[0].id).toBe('a-trim');
    expect(sets[0].actions[1].id).not.toBe('bad:id');
    expect(readActionSets({ not: 'a list' }, false)).toEqual([]);
  });
});
