import { describe, it, expect } from 'vitest';
import { fieldShape } from '../../src/editors/view3d/fielddraw';

describe('force field shapes', () => {
  it('force: three screen-facing rings of radius 1, 1.5 and 2', () => {
    const s = fieldShape({ type: 'FORCE', strength: 1 });
    expect(s.local.length).toBe(0);
    const radii = new Set<number>();
    for (let i = 0; i < s.billboard.length; i += 3) radii.add(Math.round(Math.hypot(s.billboard[i], s.billboard[i + 1]) * 100) / 100);
    expect([...radii].sort()).toEqual([1, 1.5, 2]);
  });

  it('wind: four unit rings stacked along Z by the strength', () => {
    const zs = new Set<number>();
    const s = fieldShape({ type: 'WIND', strength: 2 });
    for (let i = 2; i < s.local.length; i += 3) zs.add(Math.round(s.local[i] * 1000) / 1000);
    expect([...zs].sort((a, b) => a - b)).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it('vortex: a spiral from the centre to radius 1 ending on +Y', () => {
    const s = fieldShape({ type: 'VORTEX', strength: 1 }).local;
    expect(Math.hypot(s[0], s[1])).toBeCloseTo(0, 6);
    const n = s.length;
    expect(s[n - 3]).toBeCloseTo(0, 6);
    expect(s[n - 2]).toBeCloseTo(1, 6);
  });
});
