// @vitest-environment happy-dom
// Lattice: Outside mode (inner points follow the outer ones; recorded reference), interpolation per
// axis, and lattice vertex groups scaling the points' influence.
import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import fx from '../fixtures/r4_lattice_outside.json';
import { modifierTypes, latticeEffectivePoints } from '../../src/eval/modifiers';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';
import type { LatticeData } from '../../src/data/types';

function lattice(o: Partial<LatticeData> = {}): LatticeData {
  return { id: 'ld', name: 'L', points_u: 3, points_v: 3, points_w: 3, points: Float32Array.from(fx.points.flat()), interpolation: 'KEY_LINEAR', interpolation_type_u: 'KEY_LINEAR', interpolation_type_v: 'KEY_LINEAR', interpolation_type_w: 'KEY_LINEAR', ...o };
}
const run = (lt: LatticeData, verts: number[][]) => {
  const t = modifierTypes.LATTICE;
  const doc = { lattices: { ld: lt } };
  const graph = { get: (id: string) => (id === 'ob' ? { world: new Matrix4() } : { world: new Matrix4(), ob: { data: 'ld' } }) };
  const m = { positions: Float32Array.from(verts.flat()), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) } as EvalMesh;
  return t.apply(m, { ...t.defaults(), object: 'lt' } as never, { ob: { id: 'ob' }, doc, graph } as unknown as ModifierContext).positions;
};
const close = (a: Float32Array, b: number[][]) => b.flat().forEach((x, i) => expect(a[i]).toBeCloseTo(x, 3));

describe('Lattice deform', () => {
  it('without Outside, all points deform (recorded)', () => close(run(lattice(), fx.verts), fx.inside));
  it('Outside: the inner point follows the outer ones (recorded)', () => {
    const lt = lattice({ use_outside: true });
    const p = latticeEffectivePoints(lt);
    expect([p[39], p[40], p[41]].map((x) => +x.toFixed(4))).toEqual([0, -0.0333, 0.0333]);
    close(run(lt, fx.verts), fx.outside);
  });
  it('interpolation per axis and the vertex group weights', () => {
    const lt = lattice({ interpolation_type_u: 'KEY_BSPLINE' });
    const a = run(lt, fx.verts),
      b = run(lattice(), fx.verts);
    expect(Array.from(a).some((x, i) => Math.abs(x - b[i]) > 1e-3)).toBe(true);
    // a group weighting nothing: no deformation at all
    const g = lattice({ vertex_groups: [{ name: 'G' }], weights: [new Float32Array(27)], vertex_group: 'G' });
    close(run(g, fx.verts), fx.verts);
  });
});
