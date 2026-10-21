import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { applyScopeBoxes } from '../src/core/scopebox.js';
import { Scene } from '../src/core/scene.js';

describe('scope boxes', () => {
  it('crop plans and set 3D section boxes, and views follow when the box changes', () => {
    const { doc, add, L1 } = project();
    doc.solver = (drivers) => applyScopeBoxes(doc, drivers);
    const box = add({ kind: 'scopeBox', name: 'East Wing', x0: 0, y0: 0, x1: 8000, y1: 6000, z0: -1000, z1: 9000 });
    const plan = doc.all('plan').find((v) => v.levelId === L1.id);
    const v3 = doc.all('view3d')[0];
    doc.transact('assign', () => {
      doc.update(plan.id, { scopeBoxId: box.id });
      doc.update(v3.id, { scopeBoxId: box.id });
    });
    expect(doc.get(plan.id).crop).toEqual({ x0: 0, y0: 0, x1: 8000, y1: 6000 });
    expect(doc.get(plan.id).cropOn).toBe(true);
    expect(doc.get(v3.id).sectionBox).toEqual({ min: [0, 0, -1000], max: [8000, 6000, 9000] });
    doc.transact('grow', () => doc.update(box.id, { x1: 12000 }));
    expect(doc.get(plan.id).crop.x1).toBe(12000);
    expect(doc.get(v3.id).sectionBox.max[0]).toBe(12000);
  });

  it('show in plans of the levels they span, picked by their outline', () => {
    const { doc, add, L1 } = project();
    const box = add({ kind: 'scopeBox', name: 'B', x0: 0, y0: 0, x1: 8000, y1: 6000, z0: 1000, z1: 9000 });
    const scene = new Scene(doc);
    const plan = doc.all('plan').find((v) => v.levelId === L1.id);
    // Level 1 is at 0, below the box.
    expect(scene.planOf(plan, doc.get(box.id))?.lines.length ?? 0).toBe(0);
    doc.transact('lower', () => doc.update(box.id, { z0: -500 }));
    const g = scene.planOf(plan, doc.get(box.id));
    expect(g.lines.length).toBeGreaterThan(0);
    expect(g.picks).toHaveLength(4);
  });
});
