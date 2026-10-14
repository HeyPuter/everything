import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { stairFlights } from '../src/core/stairs.js';
import { Scene } from '../src/core/scene.js';
import { planContext, planGraphics } from '../src/core/plan.js';

const stair = (doc, L1, L2, extra) => ({ kind: 'stair', typeId: 'st-concrete', levelId: L1.id, topLevelId: L2.id, baseOffset: 0, topOffset: 0, a: [0, 0], b: [1000, 0], width: 1000, ...extra });

describe('stairs', () => {
  it('splits risers between the flights of U and L stairs', () => {
    const { doc, L1, L2 } = project();
    for (const shape of ['u', 'l']) {
      const g = stairFlights(doc, stair(doc, L1, L2, { shape }));
      expect(g.flights).toHaveLength(2);
      expect(g.landings).toHaveLength(1);
      expect(g.flights[0].risers + g.flights[1].risers).toBe(g.risers);
      expect(g.landings[0].z).toBeCloseTo(g.flights[1].z0);
    }
    const straight = stairFlights(doc, stair(doc, L1, L2, {}));
    expect(straight.flights).toHaveLength(1);
    expect(straight.risers).toBe(Math.ceil(3000 / 180));
  });

  it('U stairs come back parallel, beside the first flight', () => {
    const { doc, L1, L2 } = project();
    const g = stairFlights(doc, stair(doc, L1, L2, { shape: 'u', turn: 'left' }));
    expect(g.flights[1].dir[0]).toBeCloseTo(-1);
    expect(g.flights[1].start[1]).toBeGreaterThan(1000);
    const right = stairFlights(doc, stair(doc, L1, L2, { shape: 'u', turn: 'right' }));
    expect(right.flights[1].start[1]).toBeLessThan(-1000);
  });

  it('builds a mesh and plan graphics for every shape', () => {
    const { doc, add, L1, L2 } = project();
    for (const shape of ['straight', 'l', 'u']) add(stair(doc, L1, L2, { shape }));
    const scene = new Scene(doc);
    const pc = planContext(doc, doc.all('plan')[0], scene.walls, scene.rooms);
    for (const s of doc.all('stair')) {
      expect(scene.mesh(s).pos.length).toBeGreaterThan(0);
      expect(planGraphics(pc, s).lines.length).toBeGreaterThan(10);
    }
  });
});
