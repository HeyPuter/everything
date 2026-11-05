import { describe, it, expect, vi } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { freeTableName } from '../src/core/schema.js';

const line = (x1, y1, x2, y2) => ({ type: 'line', layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1, x1, y1, x2, y2 });

describe('Drawing', () => {
  it('starts with the standard tables', () => {
    const d = new Drawing();
    expect(d.layers.has('0')).toBe(true);
    expect(d.linetypes.has('Continuous')).toBe(true);
    expect(d.textStyles.has('Standard')).toBe(true);
    expect(d.dimStyles.has('Standard')).toBe(true);
    expect(d.modified).toBe(false);
  });

  it('assigns ids and records undo steps per transaction', () => {
    const d = new Drawing();
    const a = d.transaction('Add', () => d.add(line(0, 0, 1, 1)));
    const b = d.transaction('Add', () => d.add(line(1, 1, 2, 2)));
    expect(a.id).not.toBe(b.id);
    expect(d.entities.size).toBe(2);
    expect(d.undoStack).toHaveLength(2);
    expect(d.modified).toBe(true);
  });

  it('refuses edits outside a transaction', () => {
    const d = new Drawing();
    expect(() => d.add(line(0, 0, 1, 1))).toThrow();
  });

  it('undoes and redoes adds, updates and removes', () => {
    const d = new Drawing();
    const e = d.transaction('Add', () => d.add(line(0, 0, 1, 0)));
    d.transaction('Move', () => d.update(e.id, { x2: 5 }));
    d.transaction('Erase', () => d.remove(e.id));
    expect(d.entities.size).toBe(0);
    expect(d.undo()).toBe('Erase');
    expect(d.get(e.id).x2).toBe(5);
    expect(d.undo()).toBe('Move');
    expect(d.get(e.id).x2).toBe(1);
    expect(d.redo()).toBe('Move');
    expect(d.get(e.id).x2).toBe(5);
    expect(d.canRedo).toBe(true);
    // A new edit clears the redo history.
    d.transaction('Add', () => d.add(line(0, 0, 0, 1)));
    expect(d.canRedo).toBe(false);
  });

  it('keeps entities immutable: update creates a new object', () => {
    const d = new Drawing();
    const e = d.transaction('Add', () => d.add(line(0, 0, 1, 0)));
    const before = d.get(e.id);
    d.transaction('Move', () => d.update(e.id, { x1: 3 }));
    expect(before.x1).toBe(0);
    expect(d.get(e.id)).not.toBe(before);
  });

  it('rolls back a transaction that throws', () => {
    const d = new Drawing();
    const listener = vi.fn();
    d.on(listener);
    expect(() =>
      d.transaction('Bad', () => {
        d.add(line(0, 0, 1, 1));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(d.entities.size).toBe(0);
    expect(d.undoStack).toHaveLength(0);
  });

  it('joins nested transactions into the outer step', () => {
    const d = new Drawing();
    d.transaction('Outer', () => {
      d.add(line(0, 0, 1, 1));
      d.transaction('Inner', () => d.add(line(1, 1, 2, 2)));
    });
    expect(d.undoStack).toHaveLength(1);
    d.undo();
    expect(d.entities.size).toBe(0);
  });

  it('merges command steps with mergeSince', () => {
    const d = new Drawing();
    const mark = d.undoStack.length;
    for (let i = 0; i < 3; i++) d.transaction('Line', () => d.add(line(i, 0, i + 1, 0)));
    d.mergeSince(mark, 'Line');
    expect(d.undoStack).toHaveLength(1);
    d.undo();
    expect(d.entities.size).toBe(0);
    d.redo();
    expect(d.entities.size).toBe(3);
  });

  it('reports which ids, tables and header keys changed', () => {
    const d = new Drawing();
    const changes = [];
    d.on((c) => changes.push(c));
    const e = d.transaction('Add', () => d.add(line(0, 0, 1, 1)));
    d.transaction('Layer', () => d.setTable('layers', 'A', { name: 'A', color: 1 }));
    d.transaction('Header', () => d.setHeader({ ltscale: 2 }));
    expect([...changes[0].ids]).toEqual([e.id]);
    expect(changes[1].tables).toBe(true);
    expect([...changes[1].tableNames]).toEqual(['layers']);
    expect([...changes[2].headerKeys]).toEqual(['ltscale']);
  });

  it('reorders draw order and undoes it', () => {
    const d = new Drawing();
    const ids = d.transaction('Add', () => [d.add(line(0, 0, 1, 1)).id, d.add(line(0, 0, 2, 2)).id, d.add(line(0, 0, 3, 3)).id]);
    d.transaction('Order', () => d.reorder([ids[0]], true));
    expect([...d.entities.keys()]).toEqual([ids[1], ids[2], ids[0]]);
    d.undo();
    expect([...d.entities.keys()]).toEqual(ids);
  });

  it('puts an erased object back in its draw-order place on undo', () => {
    const d = new Drawing();
    const ids = d.transaction('Add', () => [d.add(line(0, 0, 1, 1)).id, d.add(line(0, 0, 2, 2)).id, d.add(line(0, 0, 3, 3)).id]);
    d.transaction('Erase', () => d.remove(ids[0]));
    const changes = [];
    d.on((c) => changes.push(c));
    d.undo();
    expect([...d.entities.keys()]).toEqual(ids);
    expect(changes[0].resort).toBe(true);
  });

  it('merges several restored objects back into place, with later additions kept last', () => {
    const d = new Drawing();
    const ids = d.transaction('Add', () => [1, 2, 3, 4, 5, 6].map((i) => d.add(line(0, 0, i, i)).id));
    d.transaction('Erase', () => [ids[4], ids[0], ids[2]].forEach((id) => d.remove(id)));
    d.transaction('Erase', () => d.remove(ids[5]));
    d.undo();
    d.undo();
    expect([...d.entities.keys()]).toEqual(ids);
    d.redo();
    const extra = d.transaction('Add', () => d.add(line(0, 0, 9, 9)).id);
    d.transaction('Erase', () => d.remove(ids[3]));
    d.undo();
    expect([...d.entities.keys()]).toEqual([ids[1], ids[3], ids[5], extra]);
  });

  it('keeps an erased object in place across a later reorder', () => {
    const d = new Drawing();
    const ids = d.transaction('Add', () => [d.add(line(0, 0, 1, 1)).id, d.add(line(0, 0, 2, 2)).id, d.add(line(0, 0, 3, 3)).id]);
    d.transaction('Erase', () => d.remove(ids[2]));
    d.transaction('Order', () => d.reorder([ids[0]], true));
    expect([...d.entities.keys()]).toEqual([ids[1], ids[0]]);
    d.undo();
    d.undo();
    expect([...d.entities.keys()]).toEqual(ids);
    d.redo();
    d.redo();
    expect([...d.entities.keys()]).toEqual([ids[1], ids[0]]);
    d.transaction('Add', () => d.add(line(0, 0, 4, 4)));
    expect([...d.entities.keys()].slice(0, 2)).toEqual([ids[1], ids[0]]);
  });

  it('records which layer table entries changed', () => {
    const d = new Drawing();
    const changes = [];
    d.on((c) => changes.push(c));
    d.transaction('L', () => d.setTable('layers', 'A', { name: 'A' }));
    expect([...changes[0].tableKeys]).toEqual(['layers:A']);
  });

  it('round-trips through toJSON and load', () => {
    const d = new Drawing();
    d.transaction('Add', () => {
      d.add(line(0, 0, 1, 1));
      d.setTable('layers', 'Walls', { name: 'Walls', color: 1 });
      d.setBlock('B', { name: 'B', bx: 0, by: 0, entities: [{ ...line(0, 0, 1, 0), id: 1 }] });
    });
    const copy = new Drawing(JSON.parse(JSON.stringify(d.toJSON())));
    expect(copy.entities.size).toBe(1);
    expect(copy.layers.get('Walls').color).toBe(1);
    expect(copy.layers.get('Walls').on).toBe(true);
    expect(copy.blocks.get('B').entities).toHaveLength(1);
    expect(copy.header.nextId).toBeGreaterThan([...copy.entities.keys()][0]);
    expect(copy.modified).toBe(false);
  });

  it('tracks saved state', () => {
    const d = new Drawing();
    d.transaction('Add', () => d.add(line(0, 0, 1, 1)));
    d.markSaved();
    expect(d.modified).toBe(false);
    d.undo();
    expect(d.modified).toBe(true);
  });

  it('answers layer visibility and editability', () => {
    const d = new Drawing();
    d.transaction('L', () => {
      d.setTable('layers', 'Off', { name: 'Off', on: false, frozen: false, locked: false });
      d.setTable('layers', 'Locked', { name: 'Locked', on: true, frozen: false, locked: true });
    });
    expect(d.layerVisible('Off')).toBe(false);
    expect(d.layerVisible('Locked')).toBe(true);
    expect(d.layerEditable('Locked')).toBe(false);
    expect(d.layerEditable('0')).toBe(true);
  });

  it('picks a free table name in any letter case', () => {
    const t = new Map([['LAYER1', {}], ['layer2', {}]]);
    expect(freeTableName(t, 'Layer')).toBe('Layer3');
    expect(freeTableName(new Map(), 'Style')).toBe('Style1');
  });
});
