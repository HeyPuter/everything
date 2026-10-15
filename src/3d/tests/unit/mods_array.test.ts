// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { modifierTypes } from '../../src/eval/modifiers';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

const cube = () => newMeshData('c', prim.cube(2)) as unknown as EvalMesh;
const t = modifierTypes.ARRAY;
const run = (props: Record<string, unknown>, ctx: Partial<ModifierContext> = {}) => t.apply(cube(), { ...t.defaults(), ...props } as never, { ob: { id: 'ob' }, ...ctx } as ModifierContext);
const xRange = (m: EvalMesh) => {
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < m.positions.length; i += 3) (lo = Math.min(lo, m.positions[i])), (hi = Math.max(hi, m.positions[i]));
  return [lo, hi];
};

describe('Array', () => {
  it('copies and merges neighbouring copies', () => {
    const a = run({ count: 3 });
    expect([a.positions.length / 3, a.offsets.length - 1]).toEqual([24, 18]);
    expect(xRange(a)).toEqual([-1, 5]);
    expect(run({ count: 3, use_merge_vertices: true }).positions.length / 3).toBe(16);
  });

  it('fits a length and adds caps one step outside the ends', () => {
    expect(xRange(run({ fit_type: 'FIT_LENGTH', fit_length: 7 }))).toEqual([-1, 7]);
    const sphere = newMeshData('s', prim.uvSphere(8, 4, 0.5)) as unknown as EvalMesh;
    const graph = { get: (id: string) => (id === 'cap' ? { world: new Matrix4().makeTranslation(10, 0, 0), mesh: sphere } : undefined) };
    const capped = run({ count: 3, start_cap: 'cap', end_cap: 'cap' }, { graph: graph as never });
    expect(capped.positions.length / 3).toBe(24 + 2 * (sphere.positions.length / 3));
    const [lo, hi] = xRange(capped);
    expect(lo).toBeCloseTo(-2.5, 5);
    expect(hi).toBeCloseTo(6.5, 5);
  });

  it('merges the first and last copies of a closed ring only on request', () => {
    // four copies rotated a quarter turn each around an offset object: copy 4 would land on copy 0
    const ring = (cap: boolean) => {
      const graph = { get: (id: string) => (id === 'ob' ? { world: new Matrix4() } : id === 'e' ? { world: new Matrix4().makeRotationZ(Math.PI / 2) } : undefined) };
      const m = newMeshData('p', prim.grid(1, 1, 1)) as unknown as EvalMesh;
      const moved = { ...m, positions: Float32Array.from(m.positions, (x, i) => (i % 3 === 0 ? x + 0.5 : i % 3 === 1 ? x + 0.5 : x)) };
      return t.apply(moved, { ...t.defaults(), count: 4, use_relative_offset: false, use_object_offset: true, offset_object: 'e', use_merge_vertices: true, use_merge_vertices_cap: cap, merge_threshold: 0.001 } as never, { ob: { id: 'ob' }, graph } as unknown as ModifierContext);
    };
    expect(ring(false).positions.length / 3).toBe(10);
    expect(ring(true).positions.length / 3).toBe(9);
  });
});
