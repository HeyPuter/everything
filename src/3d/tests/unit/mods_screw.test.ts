// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { modifierTypes } from '../../src/eval/modifiers';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

// a two-edge profile (1,0,0)-(1.5,0,0.5)-(1,0,1) turned in 4 steps; expected counts, positions, first faces
const REF: Record<string, { n: number[]; v: number[][]; f: number[][] }> = {"default": {"n": [12, 8], "v": [[1.0, 0.0, 0.0], [1.5, 0.0, 0.5], [1.0, 0.0, 1.0], [-0.0, 1.0, 0.0], [-0.0, 1.5, 0.5], [-0.0, 1.0, 1.0], [-1.0, -0.0, 0.0], [-1.5, -0.0, 0.5], [-1.0, -0.0, 1.0], [0.0, -1.0, 0.0], [0.0, -1.5, 0.5], [0.0, -1.0, 1.0]], "f": [[0, 1, 4, 3], [3, 4, 7, 6], [6, 7, 10, 9], [9, 10, 1, 0]]}, "half": {"n": [15, 8], "v": [[1.0, 0.0, 0.0], [1.5, 0.0, 0.5], [1.0, 0.0, 1.0], [0.7071, 0.7071, 0.0], [1.0607, 1.0607, 0.5], [0.7071, 0.7071, 1.0], [-0.0, 1.0, 0.0], [-0.0, 1.5, 0.5], [-0.0, 1.0, 1.0], [-0.7071, 0.7071, 0.0], [-1.0607, 1.0607, 0.5], [-0.7071, 0.7071, 1.0], [-1.0, -0.0, 0.0], [-1.5, -0.0, 0.5], [-1.0, -0.0, 1.0]], "f": [[0, 1, 4, 3], [3, 4, 7, 6], [6, 7, 10, 9], [9, 10, 13, 12]]}, "screw": {"n": [15, 8], "v": [[1.0, 0.0, 0.0], [1.5, 0.0, 0.5], [1.0, 0.0, 1.0], [-0.0, 1.0, 0.25], [-0.0, 1.5, 0.75], [-0.0, 1.0, 1.25], [-1.0, -0.0, 0.5], [-1.5, -0.0, 1.0], [-1.0, -0.0, 1.5], [0.0, -1.0, 0.75], [0.0, -1.5, 1.25], [0.0, -1.0, 1.75], [1.0, 0.0, 1.0], [1.5, 0.0, 1.5], [1.0, 0.0, 2.0]], "f": [[0, 1, 4, 3], [3, 4, 7, 6], [6, 7, 10, 9], [9, 10, 13, 12]]}, "iter2": {"n": [27, 16], "v": [[1.0, 0.0, 0.0], [1.5, 0.0, 0.5], [1.0, 0.0, 1.0], [-0.0, 1.0, 0.0], [-0.0, 1.5, 0.5], [-0.0, 1.0, 1.0], [-1.0, -0.0, 0.0], [-1.5, -0.0, 0.5], [-1.0, -0.0, 1.0], [0.0, -1.0, 0.0], [0.0, -1.5, 0.5], [0.0, -1.0, 1.0], [1.0, 0.0, 0.0], [1.5, 0.0, 0.5], [1.0, 0.0, 1.0], [-0.0, 1.0, 0.0], [-0.0, 1.5, 0.5], [-0.0, 1.0, 1.0], [-1.0, -0.0, 0.0], [-1.5, -0.0, 0.5], [-1.0, -0.0, 1.0], [0.0, -1.0, 0.0], [0.0, -1.5, 0.5], [0.0, -1.0, 1.0], [1.0, 0.0, 0.0], [1.5, 0.0, 0.5], [1.0, 0.0, 1.0]], "f": [[0, 1, 4, 3], [3, 4, 7, 6], [6, 7, 10, 9], [9, 10, 13, 12]]}, "flip": {"n": [12, 8], "v": [[1.0, 0.0, 0.0], [1.5, 0.0, 0.5], [1.0, 0.0, 1.0], [-0.0, 1.0, 0.0], [-0.0, 1.5, 0.5], [-0.0, 1.0, 1.0], [-1.0, -0.0, 0.0], [-1.5, -0.0, 0.5], [-1.0, -0.0, 1.0], [0.0, -1.0, 0.0], [0.0, -1.5, 0.5], [0.0, -1.0, 1.0]], "f": [[3, 4, 1, 0], [6, 7, 4, 3], [9, 10, 7, 6], [0, 1, 10, 9]]}, "axisx": {"n": [12, 8], "v": [[1.0, 0.0, 0.0], [1.5, 0.0, 0.5], [1.0, 0.0, 1.0], [1.0, 0.0, 0.0], [1.5, -0.5, -0.0], [1.0, -1.0, -0.0], [1.0, 0.0, 0.0], [1.5, 0.0, -0.5], [1.0, 0.0, -1.0], [1.0, 0.0, 0.0], [1.5, 0.5, 0.0], [1.0, 1.0, 0.0]], "f": [[0, 1, 4, 3], [3, 4, 7, 6], [6, 7, 10, 9], [9, 10, 1, 0]]}, "object": {"n": [12, 8], "v": [[1.0, 0.0, 0.0], [1.5, 0.0, 0.5], [1.0, 0.0, 1.0], [0.5, 0.5, 0.0], [0.5, 1.0, 0.5], [0.5, 0.5, 1.0], [0.0, -0.0, 0.0], [-0.5, -0.0, 0.5], [0.0, -0.0, 1.0], [0.5, -0.5, 0.0], [0.5, -1.0, 0.5], [0.5, -0.5, 1.0]], "f": [[0, 1, 4, 3], [3, 4, 7, 6], [6, 7, 10, 9], [9, 10, 1, 0]]}};

const profile = () => ({ positions: Float32Array.from([1, 0, 0, 1.5, 0, 0.5, 1, 0, 1]), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0), looseEdges: Uint32Array.from([0, 1, 1, 2]) }) as EvalMesh;
const t = modifierTypes.SCREW;
const ctx = { ob: { id: 'ob' }, graph: { get: (id: string) => (id === 'ob' ? { world: new Matrix4() } : { world: new Matrix4().makeTranslation(0.5, 0, 0) }) } } as unknown as ModifierContext;
const run = (p: Record<string, unknown>) => t.apply(profile(), { ...t.defaults(), steps: 4, render_steps: 4, ...p } as never, ctx);
function same(out: EvalMesh, r: { n: number[]; v: number[][]; f: number[][] }) {
  expect([out.positions.length / 3, out.offsets.length - 1]).toEqual(r.n);
  r.v.forEach((p, i) => p.forEach((x, k) => expect(out.positions[i * 3 + k]).toBeCloseTo(x, 3)));
  r.f.forEach((f, i) => expect(Array.from(out.indices.subarray(out.offsets[i], out.offsets[i + 1]))).toEqual(f));
}

describe('Screw', () => {
  it('turns the profile around the axis', () => {
    same(run({}), REF.default);
    same(run({ angle: Math.PI }), REF.half);
    same(run({ screw_offset: 1 }), REF.screw);
    same(run({ iterations: 2 }), REF.iter2);
    same(run({ use_normal_flip: true }), REF.flip);
    same(run({ axis: 'X' }), REF.axisx);
    same(run({ object: 'e' }), REF.object);
  });
});
