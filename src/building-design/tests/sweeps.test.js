import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { Scene } from '../src/core/scene.js';
import { sweepGeometry } from '../src/core/sweeps.js';
import { wallAxis } from '../src/core/model.js';
import { deleteElements } from '../src/core/ops.js';

describe('wall sweeps', () => {
  it('run along the chosen face at their height', () => {
    const { doc, add, wall } = project();
    const w = wall([0, 0], [5000, 0]);
    const s = add({ kind: 'wallSweep', wallId: w.id, typeId: 'swt-cornice', side: 'exterior', z: 2750 });
    const g = sweepGeometry(doc, s);
    const ax = wallAxis(doc, doc.get(w.id));
    expect(g.z0).toBe(2750);
    // On the exterior face: half the wall thickness out along the exterior normal.
    expect(g.p0[1]).toBeCloseTo(ax.a[1] + ax.ext[1] * ax.half, 6);
    const inside = sweepGeometry(doc, { ...s, side: 'interior' });
    expect(Math.sign(inside.p0[1] - ax.a[1])).toBe(-Math.sign(g.p0[1] - ax.a[1]));
    const m = new Scene(doc).mesh(doc.get(s.id));
    expect(m.bounds.max[2]).toBeCloseTo(2750 + 250, 3);
    expect(m.bounds.max[0] - m.bounds.min[0]).toBeCloseTo(5000, 0);
  });

  it('show cut in plans when the cut plane passes through them, and go with their wall', () => {
    const { doc, add, wall, L1 } = project();
    const w = wall([0, 0], [5000, 0]);
    const low = add({ kind: 'wallSweep', wallId: w.id, typeId: 'swt-band', side: 'exterior', z: 1150 });
    const high = add({ kind: 'wallSweep', wallId: w.id, typeId: 'swt-cornice', side: 'exterior', z: 2750 });
    const scene = new Scene(doc);
    const plan = doc.all('plan').find((v) => v.levelId === L1.id);
    expect(scene.planOf(plan, doc.get(low.id)).fills.length).toBe(1);
    expect(scene.planOf(plan, doc.get(high.id))).toBeFalsy();
    doc.transact('del', () => deleteElements(doc, [w.id]));
    expect(doc.has(low.id)).toBe(false);
  });
});
