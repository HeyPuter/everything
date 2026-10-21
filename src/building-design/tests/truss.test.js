import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { trussMembers } from '../src/core/truss.js';
import { Scene } from '../src/core/scene.js';

describe('trusses', () => {
  it('make the members of each pattern', () => {
    const pratt = trussMembers('pratt', 6000, 1500, 4);
    expect(pratt.chords).toHaveLength(4);
    // Three verticals and four diagonals.
    expect(pratt.webs).toHaveLength(7);
    const warren = trussMembers('warren', 6000, 1500, 4);
    expect(warren.webs).toHaveLength(4);
    const king = trussMembers('kingpost', 6000, 1500, 4);
    expect(king.chords).toHaveLength(3);
    expect(king.webs).toEqual([[[3000, 0], [3000, 1500]]]);
    // Pratt diagonals slope down toward the middle: the first one starts at the top.
    const firstDiag = pratt.webs.find(([p, q]) => p[0] !== q[0]);
    expect(firstDiag[0]).toEqual([0, 1500]);
  });

  it('build a 3D frame at the bottom chord height', () => {
    const { doc, add, L1 } = project();
    const t = add({ kind: 'truss', typeId: 'tt-pratt', levelId: L1.id, a: [0, 0], b: [9000, 0], offset: 2800 });
    const m = new Scene(doc).mesh(doc.get(t.id));
    expect(m.bounds.min[2]).toBeLessThan(2800);
    expect(m.bounds.max[2]).toBeGreaterThan(2800 + 1500);
    expect(m.bounds.max[0] - m.bounds.min[0]).toBeGreaterThan(9000);
  });
});
