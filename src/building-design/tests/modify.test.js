import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { splitLinear, transformElements, scaling } from '../src/core/ops.js';

describe('split with a gap', () => {
  it('leaves the gap between the two parts of a wall, and doors stay put', () => {
    const { doc, wall, add } = project();
    const w = wall([0, 0], [6000, 0]);
    const d = add({ kind: 'door', typeId: 'dt-single-36', hostId: w.id, t: 5000 });
    let second;
    doc.transact('split', () => (second = splitLinear(doc, doc.get(w.id), [3000, 0], 200)));
    expect(doc.get(w.id).b).toEqual([2900, 0]);
    expect(second.a).toEqual([3100, 0]);
    const door = doc.get(d.id);
    expect(door.hostId).toBe(second.id);
    // Same plan position as before: 5000 from the old start.
    expect(second.a[0] + door.t).toBe(5000);
  });

  it('splits lines and refuses gaps that do not fit', () => {
    const { doc, add } = project();
    const view = doc.all('plan')[0];
    const l = add({ kind: 'detailLine', viewId: view.id, a: [0, 0], b: [1000, 0], style: 'thin' });
    expect(splitLinear(doc, l, [10, 0], 0)).toBeNull();
    let b;
    doc.transact('split', () => (b = splitLinear(doc, l, [500, 0], 100)));
    expect(b.a).toEqual([550, 0]);
    expect(doc.get(l.id).b).toEqual([450, 0]);
  });
});

describe('scaling', () => {
  it('scales positions and lengths about a base point', () => {
    const { doc, wall, add } = project();
    const w = wall([1000, 0], [3000, 0]);
    const view = doc.all('plan')[0];
    const arc = add({ kind: 'detailArc', viewId: view.id, c: [2000, 1000], r: 500, a0: 0, a1: Math.PI * 2 });
    doc.transact('scale', () => transformElements(doc, [w.id, arc.id], scaling([0, 0], 2)));
    expect(doc.get(w.id).a).toEqual([2000, 0]);
    expect(doc.get(w.id).b).toEqual([6000, 0]);
    expect(doc.get(arc.id).r).toBe(1000);
  });
});
