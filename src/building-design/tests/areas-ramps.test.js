import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { rampLayout, rampOutline } from '../src/core/model.js';
import { AreaSolver } from '../src/core/rooms.js';
import { upgradeDoc } from '../src/core/template.js';
import { Doc } from '../src/core/doc.js';
import { build3D } from '../src/core/build3d.js';
import { WallSolver } from '../src/core/walls.js';

describe('ramps', () => {
  it('runs the rise times the slope ratio of the type', () => {
    const { doc, add, L1, L2 } = project();
    const r = add({ kind: 'ramp', typeId: 'rpt-concrete', levelId: L1.id, topLevelId: null, height: 600, a: [0, 0], b: [0, 1] });
    const g = rampLayout(doc, r);
    expect(g.rise).toBe(600);
    expect(g.run).toBe(7200);
    expect(g.end).toEqual([0, 7200]);
    expect(rampOutline(doc, r)).toHaveLength(4);
    const up = add({ kind: 'ramp', typeId: 'rpt-gentle', levelId: L1.id, topLevelId: L2.id, a: [0, 0], b: [1, 0] });
    expect(rampLayout(doc, up).run).toBe(3000 * 20);
  });

  it('builds a solid', () => {
    const { doc, add, L1 } = project();
    const r = add({ kind: 'ramp', typeId: 'rpt-concrete', levelId: L1.id, height: 300, a: [0, 0], b: [0, 1], width: 1200, railings: false });
    const m = build3D({ doc, walls: new WallSolver(doc), material: (id) => doc.get(id) }, r);
    expect(m.pos.length).toBeGreaterThan(0);
    expect(m.bounds.max[2]).toBeCloseTo(300);
  });
});

describe('areas', () => {
  it('measures regions bounded by area boundary lines of one scheme', () => {
    const { doc, add, L1 } = project();
    const line = (a, b, scheme = 'gross') => add({ kind: 'areaBoundary', levelId: L1.id, scheme, a, b });
    line([0, 0], [10000, 0]);
    line([10000, 0], [10000, 5000]);
    line([10000, 5000], [0, 5000]);
    line([0, 5000], [0, 0]);
    line([4000, 0], [4000, 5000], 'rentable');
    const solver = new AreaSolver(doc);
    const a = add({ kind: 'area', levelId: L1.id, scheme: 'gross', at: [2000, 2000], name: 'A' });
    expect(Math.round(solver.area(a).area / 1e6)).toBe(50);
    // The rentable line does not split the gross region.
    expect(solver.regionAt(L1.id, 'rentable', [2000, 2000])).toBeNull();
  });
});

describe('upgrading older projects', () => {
  it('adds type kinds that did not exist when the file was saved', () => {
    const { doc } = project();
    const old = Doc.fromJSON({ format: 'building-design', version: 1, items: doc.toJSON().items.filter((it) => it.kind !== 'rampType') });
    expect(old.count('rampType')).toBe(0);
    upgradeDoc(old);
    expect(old.count('rampType')).toBeGreaterThan(0);
    expect(old.canUndo).toBe(false);
    expect(old.modified).toBe(false);
  });
});
