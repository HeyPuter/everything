import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { solidsFromMasses } from '../src/core/families.js';
import { Scene } from '../src/core/scene.js';

describe('custom families', () => {
  it('take their solids from masses, around the centre and lowest base', () => {
    const masses = [
      { boundary: [[0, 0], [1000, 0], [1000, 500], [0, 500]], height: 800, base: 0 },
      { boundary: [[200, 100], [800, 100], [800, 400], [200, 400]], height: 300, base: 800 },
    ];
    const f = solidsFromMasses(masses, (m) => m.base);
    expect(f.center).toEqual([500, 250]);
    expect(f.width).toBe(1000);
    expect(f.height).toBe(1100);
    expect(f.solids[1]).toMatchObject({ z0: 800, z1: 1100 });
    expect(f.solids[0].loop[0]).toEqual([-500, -250]);
  });

  it('build as components and stretch with their type', () => {
    const { doc, add, L1 } = project();
    const type = add({ kind: 'componentType', family: 'custom', category: 'genericModels', name: 'Plinth', width: 1000, depth: 500, height: 800, baseWidth: 1000, baseDepth: 500, baseHeight: 800, solids: [{ loop: [[-500, -250], [500, -250], [500, 250], [-500, 250]], z0: 0, z1: 800, materialId: 'mat-concrete' }] });
    const el = add({ kind: 'component', typeId: type.id, levelId: L1.id, at: [0, 0], rotation: 0 });
    const scene = new Scene(doc);
    expect(scene.mesh(doc.get(el.id)).bounds.max[2]).toBeCloseTo(800, 3);
    doc.transact('stretch', () => doc.update(type.id, { width: 2000, height: 400 }));
    const m = scene.mesh(doc.get(el.id));
    expect(m.bounds.max[0] - m.bounds.min[0]).toBeCloseTo(2000, 3);
    expect(m.bounds.max[2]).toBeCloseTo(400, 3);
  });
});
