// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { modifierTypes } from '../../src/eval/modifiers';
import '../../src/eval/mods/index';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

/** 4×2×2 box (a cube stretched along X). */
function box(): EvalMesh {
  const m = newMeshData('b', prim.cube(2)) as unknown as EvalMesh;
  const P = new Float32Array(m.positions);
  for (let i = 0; i < P.length; i += 3) P[i] *= 2;
  return { ...m, positions: P };
}
const ctx = (objs: Record<string, Matrix4> = {}) => ({ ob: { id: 'ob', name: 'ob' }, graph: { get: (id: string) => (id === 'ob' ? { world: new Matrix4() } : objs[id] ? { world: objs[id] } : undefined) } }) as unknown as ModifierContext;
const run = (m: EvalMesh, props: Record<string, unknown>, c = ctx()) => {
  const t = modifierTypes.NORMAL_EDIT;
  return t.apply(m, { ...t.defaults(), type: 'NORMAL_EDIT', name: 'N', id: 'md', ...props } as never, c);
};
/** Custom normal of the corner of vertex `co` in the face whose normal is `fn`. */
function normalAt(m: EvalMesh, co: number[], fn: number[]): number[] {
  const P = m.positions;
  for (let f = 0; f < m.offsets.length - 1; f++) {
    // face normal from the original orientation of a cube face: its centroid direction
    const cs = Array.from({ length: m.offsets[f + 1] - m.offsets[f] }, (_, i) => m.offsets[f] + i);
    const cen = [0, 1, 2].map((k) => cs.reduce((s, c) => s + P[m.indices[c] * 3 + k], 0) / cs.length);
    const dir = cen.map((v, k) => Math.sign(Math.round(v / (k === 0 ? 2 : 1))));
    if (dir.some((v, k) => v !== fn[k])) continue;
    for (const c of cs) {
      const v = m.indices[c];
      if ([0, 1, 2].every((k) => Math.abs(P[v * 3 + k] - co[k]) < 1e-6)) return Array.from(m.custom_normals!.slice(c * 3, c * 3 + 3));
    }
  }
  throw new Error('corner not found');
}
const close = (a: number[], b: number[]) => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 3));

describe('Normal Edit', () => {
  it('radial normals follow an ellipsoid fitted to the bounds', () => {
    close(normalAt(run(box(), {}), [-2, -1, -1], [-1, 0, 0]), [-0.3334, -0.6667, -0.6666]);
    close(normalAt(run(box(), { offset: [1, 0, 0] }), [-2, -1, -1], [-1, 0, 0]), [-0.4685, -0.6247, -0.6246]);
    close(normalAt(run(box(), { offset: [1, 0, 0] }), [2, 1, 1], [0, 0, 1]), [0.1741, 0.6963, 0.6963]);
  });

  it('mixes with the original normals', () => {
    close(normalAt(run(box(), { mix_factor: 0.5 }), [-2, -1, -1], [-1, 0, 0]), [-0.8165, -0.4083, -0.4082]);
    close(normalAt(run(box(), { mix_mode: 'ADD' }), [-2, -1, -1], [-1, 0, 0]), [-0.8165, -0.4083, -0.4082]);
    close(normalAt(run(box(), { mix_mode: 'MUL' }), [-2, -1, -1], [-1, 0, 0]), [1, 0, 0]);
    close(normalAt(run(box(), { mix_limit: Math.PI / 6 }), [-2, -1, -1], [-1, 0, 0]), [-0.866, -0.3536, -0.3535]);
    close(normalAt(run(box(), { mix_limit: Math.PI / 6 }), [-2, 1, -1], [0, 0, -1]), [-0.2236, 0.4472, -0.866]);
  });

  it('points at a target object', () => {
    const c = ctx({ e: new Matrix4().makeTranslation(3, 1, 2) });
    close(normalAt(run(box(), { target: 'e' }, c), [-2, -1, -1], [-1, 0, 0]), [-0.8111, -0.3245, -0.4867]);
    close(normalAt(run(box(), { target: 'e' }, c), [-2, -1, 1], [-1, 0, 0]), [-0.9129, -0.3651, -0.1825]);
    // directional normals face the target; faces turned away from them get flipped
    const dir = run(box(), { target: 'e', mode: 'DIRECTIONAL' }, c);
    close(normalAt(dir, [-2, -1, -1], [-1, 0, 0]), [0.8081, 0.303, 0.5051]);
    close(normalAt(dir, [-2, 1, -1], [-1, 0, 0]), [0.8433, 0.1054, 0.5271]);
    close(normalAt(run(box(), { target: 'e', mode: 'DIRECTIONAL', use_direction_parallel: true }, c), [2, 1, 1], [0, 0, 1]), [0.8018, 0.2673, 0.5345]);
  });
});
