// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { modifierTypes } from '../../src/eval/modifiers';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

// counts and (sorted) vertex positions measured with thickness 0.2
const REF: Record<string, { nv: number; nf: number; v: number[][] }> = {"plane": {"nv": 12, "nf": 8, "v": [[-1.0, -1.0, -0.1], [-1.0, -1.0, 0.1], [-1.0, 1.0, -0.1], [-1.0, 1.0, 0.1], [-0.9, -0.9, 0.0], [-0.9, 0.9, 0.0], [0.9, -0.9, 0.0], [0.9, 0.9, 0.0], [1.0, -1.0, -0.1], [1.0, -1.0, 0.1], [1.0, 1.0, -0.1], [1.0, 1.0, 0.1]]}, "plane_boundary": {"nv": 16, "nf": 16, "v": [[-1.1, -1.1, 0.0], [-1.1, 1.1, 0.0], [-1.0, -1.0, -0.1], [-1.0, -1.0, 0.1], [-1.0, 1.0, -0.1], [-1.0, 1.0, 0.1], [-0.9, -0.9, 0.0], [-0.9, 0.9, 0.0], [0.9, -0.9, 0.0], [0.9, 0.9, 0.0], [1.0, -1.0, -0.1], [1.0, -1.0, 0.1], [1.0, 1.0, -0.1], [1.0, 1.0, 0.1], [1.1, -1.1, 0.0], [1.1, 1.1, 0.0]]}, "plane_off1": {"nv": 12, "nf": 8, "v": [[-1.0, -1.0, 0.0], [-1.0, -1.0, 0.2], [-1.0, 1.0, 0.0], [-1.0, 1.0, 0.2], [-0.9, -0.9, 0.1], [-0.9, 0.9, 0.1], [0.9, -0.9, 0.1], [0.9, 0.9, 0.1], [1.0, -1.0, 0.0], [1.0, -1.0, 0.2], [1.0, 1.0, 0.0], [1.0, 1.0, 0.2]]}, "plane_keep": {"nv": 16, "nf": 9, "v": [[-1.0, -1.0, -0.1], [-1.0, -1.0, 0.0], [-1.0, -1.0, 0.1], [-1.0, 1.0, -0.1], [-1.0, 1.0, 0.0], [-1.0, 1.0, 0.1], [-0.9, -0.9, 0.0], [-0.9, 0.9, 0.0], [0.9, -0.9, 0.0], [0.9, 0.9, 0.0], [1.0, -1.0, -0.1], [1.0, -1.0, 0.0], [1.0, -1.0, 0.1], [1.0, 1.0, -0.1], [1.0, 1.0, 0.0], [1.0, 1.0, 0.1]]}, "plane_noeven": {"nv": 12, "nf": 8, "v": [[-1.0, -1.0, -0.1], [-1.0, -1.0, 0.1], [-1.0, 1.0, -0.1], [-1.0, 1.0, 0.1], [-0.9293, -0.9293, 0.0], [-0.9293, 0.9293, 0.0], [0.9293, -0.9293, 0.0], [0.9293, 0.9293, 0.0], [1.0, -1.0, -0.1], [1.0, -1.0, 0.1], [1.0, 1.0, -0.1], [1.0, 1.0, 0.1]]}, "cube": {"nv": 40, "nf": 48, "v": [[-1.0577, -1.0577, -1.0577], [-1.0577, -1.0577, 1.0577], [-1.0577, 1.0577, -1.0577], [-1.0577, 1.0577, 1.0577], [-1.0, -0.9, -0.9], [-1.0, -0.9, 0.9], [-1.0, 0.9, -0.9], [-1.0, 0.9, 0.9], [-0.9423, -0.9423, -0.9423], [-0.9423, -0.9423, 0.9423], [-0.9423, 0.9423, -0.9423], [-0.9423, 0.9423, 0.9423], [-0.9, -1.0, -0.9], [-0.9, -1.0, 0.9], [-0.9, -0.9, -1.0], [-0.9, -0.9, 1.0], [-0.9, 0.9, -1.0], [-0.9, 0.9, 1.0], [-0.9, 1.0, -0.9], [-0.9, 1.0, 0.9], [0.9, -1.0, -0.9], [0.9, -1.0, 0.9], [0.9, -0.9, -1.0], [0.9, -0.9, 1.0], [0.9, 0.9, -1.0], [0.9, 0.9, 1.0], [0.9, 1.0, -0.9], [0.9, 1.0, 0.9], [0.9423, -0.9423, -0.9423], [0.9423, -0.9423, 0.9423], [0.9423, 0.9423, -0.9423], [0.9423, 0.9423, 0.9423], [1.0, -0.9, -0.9], [1.0, -0.9, 0.9], [1.0, 0.9, -0.9], [1.0, 0.9, 0.9], [1.0577, -1.0577, -1.0577], [1.0577, -1.0577, 1.0577], [1.0577, 1.0577, -1.0577], [1.0577, 1.0577, 1.0577]]}};

const t = modifierTypes.WIREFRAME;
const run = (m: EvalMesh, props: Record<string, unknown>) => t.apply(m, { ...t.defaults(), thickness: 0.2, ...props } as never, {} as ModifierContext);
const sorted = (m: EvalMesh) => Array.from({ length: m.positions.length / 3 }, (_, i) => Array.from(m.positions.slice(i * 3, i * 3 + 3))).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
function same(m: EvalMesh, r: { nv: number; nf: number; v: number[][] }) {
  expect([m.positions.length / 3, m.offsets.length - 1]).toEqual([r.nv, r.nf]);
  const a = sorted(m),
    b = [...r.v].sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  a.forEach((p, i) => p.forEach((x, k) => expect(x).toBeCloseTo(b[i][k], 3)));
}

describe('Wireframe', () => {
  const plane = () => newMeshData('p', prim.plane(2)) as unknown as EvalMesh;
  it('matches the expected tubes', () => {
    same(run(plane(), {}), REF.plane);
    same(run(plane(), { offset: 1 }), REF.plane_off1);
    same(run(plane(), { use_boundary: true }), REF.plane_boundary);
    same(run(newMeshData('c', prim.cube(2)) as unknown as EvalMesh, {}), REF.cube);
    const keep = run(plane(), { use_replace: false });
    expect([keep.positions.length / 3, keep.offsets.length - 1]).toEqual([REF.plane_keep.nv, REF.plane_keep.nf]);
  });
});
