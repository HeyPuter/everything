import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { deleteElements, moveElements, copyElements, transformElements, translation, rotation, mirrorAcross, splitWall, cornerWalls, offsetElement, arrayLinear, nextMark, nextGridName, uniqueName, extendToLine } from '../src/core/ops.js';

describe('deleting', () => {
  it('removes hosted doors and tags with their wall and survives undo', () => {
    const { doc, wall, add } = project();
    const w = wall([0, 0], [5000, 0]);
    const d = add({ kind: 'door', typeId: 'dt-single-36', hostId: w.id, t: 2000 });
    const view = doc.all('plan')[0];
    const tag = add({ kind: 'tag', viewId: view.id, targetId: d.id, at: [2000, 800] });
    doc.transact('Delete', () => deleteElements(doc, [w.id]));
    expect(doc.has(w.id) || doc.has(d.id) || doc.has(tag.id)).toBe(false);
    doc.undo();
    expect(doc.has(w.id) && doc.has(d.id) && doc.has(tag.id)).toBe(true);
  });

  it('detaches dimension references instead of deleting the dimension', () => {
    const { doc, wall, add } = project();
    const a = wall([0, 0], [0, 4000]);
    const b = wall([3000, 0], [3000, 4000]);
    const view = doc.all('plan')[0];
    const dim = add({ kind: 'dimension', viewId: view.id, refs: [{ at: [0, 2000], id: a.id, ref: 'center' }, { at: [3000, 2000], id: b.id, ref: 'center' }], dir: [1, 0], line: [0, 2000] });
    doc.transact('Delete', () => deleteElements(doc, [a.id]));
    expect(doc.get(dim.id).refs[0].id).toBeUndefined();
  });

  it('deleting a level removes its views and elements', () => {
    const { doc, wall, L1 } = project();
    wall([0, 0], [1000, 0]);
    doc.transact('Delete', () => deleteElements(doc, [L1.id]));
    expect(doc.count('wall')).toBe(0);
    expect(doc.all('plan').some((v) => v.levelId === L1.id)).toBe(false);
  });
});

describe('transforms', () => {
  it('moves walls and keeps hosted doors relative', () => {
    const { doc, wall, add } = project();
    const w = wall([0, 0], [5000, 0]);
    const d = add({ kind: 'door', typeId: 'dt-single-36', hostId: w.id, t: 2000 });
    doc.transact('Move', () => moveElements(doc, [w.id, d.id], [100, 200]));
    expect(doc.get(w.id).a).toEqual([100, 200]);
    expect(doc.get(d.id).t).toBe(2000);
  });

  it('slides a door along its wall when moved alone', () => {
    const { doc, wall, add } = project();
    const w = wall([0, 0], [5000, 0]);
    const d = add({ kind: 'door', typeId: 'dt-single-36', hostId: w.id, t: 2000 });
    doc.transact('Move', () => moveElements(doc, [d.id], [500, 900]));
    expect(doc.get(d.id).t).toBeCloseTo(2500);
  });

  it('rotates components about a center', () => {
    const { doc, add, L1 } = project();
    const c = add({ kind: 'component', typeId: 'cpt-chair', levelId: L1.id, at: [1000, 0], rotation: 0 });
    doc.transact('Rotate', () => transformElements(doc, [c.id], rotation([0, 0], Math.PI / 2)));
    const r = doc.get(c.id);
    expect(r.at[0]).toBeCloseTo(0);
    expect(r.at[1]).toBeCloseTo(1000);
    expect(r.rotation).toBeCloseTo(90);
  });

  it('mirrors walls and flips their exterior side', () => {
    const { doc, wall } = project();
    const w = wall([0, 1000], [4000, 1000]);
    doc.transact('Mirror', () => transformElements(doc, [w.id], mirrorAcross([0, 0], [1, 0])));
    expect(doc.get(w.id).a[1]).toBeCloseTo(-1000);
    expect(doc.get(w.id).flipped).toBe(true);
  });

  it('copies walls with their doors and gives the copies new marks', () => {
    const { doc, wall, add } = project();
    const w = wall([0, 0], [5000, 0]);
    add({ kind: 'door', typeId: 'dt-single-36', hostId: w.id, t: 2000, mark: '1' });
    let ids;
    doc.transact('Copy', () => (ids = copyElements(doc, [w.id], translation([0, 3000]))));
    expect(ids).toHaveLength(2);
    const doors = doc.all('door');
    expect(doors).toHaveLength(2);
    expect(new Set(doors.map((x) => x.mark)).size).toBe(2);
    expect(doors.some((x) => x.hostId === ids[0])).toBe(true);
  });

  it('arrays copies at a spacing', () => {
    const { doc, add, L1 } = project();
    const c = add({ kind: 'column', typeId: 'colt-rect-18', levelId: L1.id, at: [0, 0] });
    doc.transact('Array', () => arrayLinear(doc, [c.id], [6000, 0], 4));
    expect(doc.all('column').map((x) => x.at[0]).sort((a, b) => a - b)).toEqual([0, 6000, 12000, 18000]);
  });
});

describe('wall edits', () => {
  it('splits a wall and reassigns hosted elements', () => {
    const { doc, wall, add } = project();
    const w = wall([0, 0], [6000, 0]);
    const d1 = add({ kind: 'door', typeId: 'dt-single-36', hostId: w.id, t: 1000 });
    const d2 = add({ kind: 'door', typeId: 'dt-single-36', hostId: w.id, t: 5000 });
    let second;
    doc.transact('Split', () => (second = splitWall(doc, w, [3000, 40])));
    expect(doc.get(w.id).b).toEqual([3000, 0]);
    expect(second.a).toEqual([3000, 0]);
    expect(doc.get(d1.id).hostId).toBe(w.id);
    expect(doc.get(d2.id)).toMatchObject({ hostId: second.id, t: 2000 });
  });

  it('trims and extends two walls to a corner', () => {
    const { doc, wall } = project();
    const a = wall([0, 0], [3000, 0]);
    const b = wall([4000, 1000], [4000, 5000]);
    doc.transact('Corner', () => cornerWalls(doc, a, [1000, 0], b, [4000, 3000]));
    expect(doc.get(a.id).b).toEqual([4000, 0]);
    expect(doc.get(b.id).a).toEqual([4000, 0]);
  });

  it('extends a wall to a reference line', () => {
    const { doc, wall } = project();
    const a = wall([0, 0], [3000, 0]);
    doc.transact('Extend', () => extendToLine(doc, a, [500, 0], [5000, -100], [5000, 100]));
    expect(doc.get(a.id).b[0]).toBeCloseTo(5000);
  });

  it('offsets a wall toward a side', () => {
    const { doc, wall } = project();
    const a = wall([0, 0], [3000, 0]);
    let c;
    doc.transact('Offset', () => (c = offsetElement(doc, a, 1500, [100, -50])));
    expect(c.a).toEqual([0, -1500]);
  });
});

describe('naming', () => {
  it('continues marks, grid names and unique names', () => {
    const { doc, add, L1 } = project();
    add({ kind: 'door', mark: '7' });
    expect(nextMark(doc, 'door')).toBe('8');
    expect(nextMark(doc, 'window')).toBe('W1');
    add({ kind: 'grid', name: 'A', a: [0, 0], b: [1, 0] });
    expect(nextGridName(doc, 'A')).toBe('B');
    expect(nextGridName(doc, 'Z')).toBe('AA');
    expect(nextGridName(doc, '3')).toBe('4');
    expect(uniqueName(['Level 1', 'Level 2'], 'Level 2')).toBe('Level 3');
    expect(uniqueName(['Plan'], 'Plan')).toBe('Plan 2');
    void L1;
  });
});
