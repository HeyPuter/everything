import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { solveConstraints, lockAll } from '../src/core/constraints.js';
import { moveElements } from '../src/core/ops.js';

function setup(extra) {
  const p = project();
  const { doc, wall } = p;
  doc.solver = (drivers) => solveConstraints(doc, null, drivers);
  // Three parallel walls running north, at x = 0, 3000 and 9000.
  const w = [0, 3000, 9000].map((x) => wall([x, 0], [x, 6000]));
  const view = doc.all('plan')[0];
  const dim = p.add({ kind: 'dimension', viewId: view.id, dir: [1, 0], line: [0, -2000], refs: w.map((x) => ({ id: x.id, ref: 'center', at: [x.a[0], 1000] })), ...extra });
  return { ...p, w, dim };
}

describe('dimension constraints', () => {
  it('equal spacing moves the middle reference when the dimension gets EQ', () => {
    const { doc, w, dim } = setup();
    doc.transact('eq', () => doc.update(dim.id, { eq: true }));
    expect(doc.get(w[1].id).a[0]).toBeCloseTo(4500, 3);
  });

  it('equal spacing follows an end that moves', () => {
    const { doc, w } = setup({ eq: true });
    doc.transact('fix', () => doc.update(w[1].id, { a: [4500, 0], b: [4500, 6000] }));
    doc.transact('move', () => moveElements(doc, [w[2].id], [3000, 0]));
    expect(doc.get(w[2].id).a[0]).toBeCloseTo(12000, 3);
    expect(doc.get(w[1].id).a[0]).toBeCloseTo(6000, 3);
  });

  it('a locked segment carries the other element along', () => {
    const { doc, w, dim } = setup();
    doc.transact('lock', () => doc.update(dim.id, lockAll(doc, null, doc.get(dim.id), true)));
    doc.transact('move', () => moveElements(doc, [w[0].id], [-1000, 0]));
    // Both locked segments keep 3000 and 6000: everything shifts together.
    expect(doc.get(w[1].id).a[0]).toBeCloseTo(2000, 3);
    expect(doc.get(w[2].id).a[0]).toBeCloseTo(8000, 3);
    // One undo step restores all of it.
    doc.undo();
    expect(doc.get(w[2].id).a[0]).toBeCloseTo(9000, 3);
  });

  it('walls joined to a constrained wall stretch with it', () => {
    const { doc, wall, w, dim } = setup();
    const tie = wall([3000, 6000], [9000, 6000]);
    doc.transact('lock', () => doc.update(dim.id, { locks: [{ i: 1, j: 2, value: 6000 }] }));
    doc.transact('move', () => moveElements(doc, [w[1].id], [500, 0]));
    expect(doc.get(w[2].id).a[0]).toBeCloseTo(9500, 3);
    expect(doc.get(tie.id).a[0]).toBeCloseTo(3000, 3);
    expect(doc.get(tie.id).b[0]).toBeCloseTo(9500, 3);
  });

  it('leaves unconstrained dimensions alone', () => {
    const { doc, w } = setup();
    doc.transact('move', () => moveElements(doc, [w[0].id], [-1000, 0]));
    expect(doc.get(w[1].id).a[0]).toBe(3000);
  });
});
