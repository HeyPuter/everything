import { describe, expect, it } from 'vitest';
import * as L from '../../src/modes/lattice/latticeops';
import { newLattice } from '../../src/data/defaults';

describe('lattice selection', () => {
  const lt = { ...newLattice(), points_u: 3, points_v: 3, points_w: 1, points: new Float32Array(27) };
  const on = (s: Uint8Array) => [...s.keys()].filter((i) => s[i]);

  it('grows along the grid and mirrors by index', () => {
    const sel = new Uint8Array(9);
    sel[0] = 1;
    const more = L.grow(lt, sel, true);
    expect(on(more)).toEqual([0, 1, 3]);
    L.selectMirror(lt, more, 0, false);
    expect(on(more)).toEqual([1, 2, 5]);
    const less = L.grow(lt, new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 1]), false);
    expect(on(less)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const ring = new Uint8Array([1, 1, 0, 1, 1, 0, 0, 0, 0]);
    expect(on(L.grow(lt, ring, false))).toEqual([0]);
  });

  it('random selection is seeded', () => {
    const a = new Uint8Array(100),
      b = new Uint8Array(100);
    L.selectRandom(a, 0.3, 7, true);
    L.selectRandom(b, 0.3, 7, true);
    expect(on(a)).toEqual(on(b));
    expect(on(a).length).toBeGreaterThan(10);
  });
});
