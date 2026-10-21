import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { Scene } from '../src/core/scene.js';
import { stairFlights, SPIRAL_CORE } from '../src/core/stairs.js';

describe('spiral stairs', () => {
  it('wind round a column, one tread per riser, up to the top level', () => {
    const { doc, add, L1, L2 } = project();
    const type = doc.all('stairType')[0];
    const st = add({ kind: 'stair', typeId: type.id, levelId: L1.id, topLevelId: L2.id, a: [0, 0], b: [1000, 0], width: 900, shape: 'spiral', railings: true });
    const g = stairFlights(doc, st);
    expect(g.flights).toEqual([]);
    expect(g.spiral.treads).toBe(g.risers);
    expect(g.spiral.rout).toBe(SPIRAL_CORE + 900);
    const m = new Scene(doc).mesh(doc.get(st.id));
    expect(m.bounds.max[2]).toBeGreaterThanOrEqual(L2.elevation - 1);
    // Everything lies within the outer radius of the centre.
    expect(Math.max(-m.bounds.min[0], m.bounds.max[0], -m.bounds.min[1], m.bounds.max[1])).toBeLessThanOrEqual(SPIRAL_CORE + 900 + 1);
  });

  it('carry a handrail above the treads unless it is turned off', () => {
    const { doc, add, L1, L2 } = project();
    const type = doc.all('stairType')[0];
    const st = add({ kind: 'stair', typeId: type.id, levelId: L1.id, topLevelId: L2.id, a: [0, 0], b: [1000, 0], width: 900, shape: 'spiral' });
    const scene = new Scene(doc);
    const withRail = scene.mesh(doc.get(st.id)).pos.length;
    doc.transact('no rails', () => doc.update(st.id, { railings: false }));
    const without = scene.mesh(doc.get(st.id)).pos.length;
    expect(withRail).toBeGreaterThan(without);
  });

  it('turn the other way when asked', () => {
    const { doc, add, L1, L2 } = project();
    const type = doc.all('stairType')[0];
    const l = stairFlights(doc, add({ kind: 'stair', typeId: type.id, levelId: L1.id, topLevelId: L2.id, a: [0, 0], b: [1000, 0], width: 900, shape: 'spiral' }));
    const r = stairFlights(doc, add({ kind: 'stair', typeId: type.id, levelId: L1.id, topLevelId: L2.id, a: [0, 0], b: [1000, 0], width: 900, shape: 'spiral', turn: 'right' }));
    expect(l.spiral.step).toBeGreaterThan(0);
    expect(r.spiral.step).toBeCloseTo(-l.spiral.step, 9);
  });
});
