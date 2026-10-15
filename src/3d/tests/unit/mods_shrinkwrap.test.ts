// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { buildMesh } from '../../src/mesh/mesh';
import { modifierTypes } from '../../src/eval/modifiers';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

// five points around a unit icosphere (given below) and their expected wrapped positions
const SV: number[][] = [[0.0, 0.0, -1.0], [0.72361, -0.52573, -0.44722], [-0.27639, -0.85065, -0.44722], [-0.89443, 0.0, -0.44722], [-0.27639, 0.85065, -0.44722], [0.72361, 0.52573, -0.44722], [0.27639, -0.85065, 0.44722], [-0.72361, -0.52573, 0.44722], [-0.72361, 0.52573, 0.44722], [0.27639, 0.85065, 0.44722], [0.89443, 0.0, 0.44722], [0.0, 0.0, 1.0], [-0.16246, -0.5, -0.85065], [0.42532, -0.30901, -0.85065], [0.26287, -0.80901, -0.52574], [0.85065, 0.0, -0.52574], [0.42532, 0.30901, -0.85065], [-0.52573, 0.0, -0.85065], [-0.68819, -0.5, -0.52574], [-0.16246, 0.5, -0.85065], [-0.68819, 0.5, -0.52574], [0.26287, 0.80901, -0.52574], [0.95106, -0.30901, 0.0], [0.95106, 0.30901, 0.0], [0.0, -1.0, 0.0], [0.58779, -0.80902, 0.0], [-0.95106, -0.30901, 0.0], [-0.58779, -0.80902, 0.0], [-0.58779, 0.80902, 0.0], [-0.95106, 0.30901, 0.0], [0.58779, 0.80902, 0.0], [0.0, 1.0, 0.0], [0.68819, -0.5, 0.52574], [-0.26287, -0.80901, 0.52574], [-0.85065, 0.0, 0.52574], [-0.26287, 0.80901, 0.52574], [0.68819, 0.5, 0.52574], [0.16246, -0.5, 0.85065], [0.52573, 0.0, 0.85065], [-0.42532, -0.30901, 0.85065], [-0.42532, 0.30901, 0.85065], [0.16246, 0.5, 0.85065]];
const SF: number[][] = [[0, 13, 12], [1, 13, 15], [0, 12, 17], [0, 17, 19], [0, 19, 16], [1, 15, 22], [2, 14, 24], [3, 18, 26], [4, 20, 28], [5, 21, 30], [1, 22, 25], [2, 24, 27], [3, 26, 29], [4, 28, 31], [5, 30, 23], [6, 32, 37], [7, 33, 39], [8, 34, 40], [9, 35, 41], [10, 36, 38], [38, 41, 11], [38, 36, 41], [36, 9, 41], [41, 40, 11], [41, 35, 40], [35, 8, 40], [40, 39, 11], [40, 34, 39], [34, 7, 39], [39, 37, 11], [39, 33, 37], [33, 6, 37], [37, 38, 11], [37, 32, 38], [32, 10, 38], [23, 36, 10], [23, 30, 36], [30, 9, 36], [31, 35, 9], [31, 28, 35], [28, 8, 35], [29, 34, 8], [29, 26, 34], [26, 7, 34], [27, 33, 7], [27, 24, 33], [24, 6, 33], [25, 32, 6], [25, 22, 32], [22, 10, 32], [30, 31, 9], [30, 21, 31], [21, 4, 31], [28, 29, 8], [28, 20, 29], [20, 3, 29], [26, 27, 7], [26, 18, 27], [18, 2, 27], [24, 25, 6], [24, 14, 25], [14, 1, 25], [22, 23, 10], [22, 15, 23], [15, 5, 23], [16, 21, 5], [16, 19, 21], [19, 4, 21], [19, 20, 4], [19, 17, 20], [17, 3, 20], [17, 18, 3], [17, 12, 18], [12, 2, 18], [15, 16, 5], [15, 13, 16], [13, 0, 16], [12, 14, 2], [12, 13, 14], [13, 1, 14]];
const REF: Record<string, number[][]> = {"pts": [[0.3, 0.2, 2.0], [1.5, 0, 0], [0.2, 0.1, 0.3], [-0.5, 0.4, -1.5], [0, 0, 0.5]], "nearest": [[0.0147, 0.0, 0.9958], [0.9511, 0.0, 0.0], [0.4759, 0.3005, 0.7465], [-0.3168, 0.2669, -0.8549], [0.1264, 0.0919, 0.9451]], "nearest_off": [[0.0684, 0.0376, 1.1848], [1.1511, 0.0, 0.0], [0.3777, 0.2291, 0.5876], [-0.3704, 0.3058, -1.0436], [0.0728, 0.0529, 0.7564]], "INSIDE": [[-0.0389, -0.0376, 0.8069], [0.7511, 0.0, 0.0], [0.2, 0.1, 0.3], [-0.2631, 0.2279, -0.6662], [0.0, 0.0, 0.5]], "OUTSIDE": [[0.3, 0.2, 2.0], [1.5, 0.0, 0.0], [0.5742, 0.3719, 0.9054], [-0.5, 0.4, -1.5], [0.1801, 0.1308, 1.1338]], "OUTSIDE_SURFACE": [[0.0684, 0.0376, 1.1848], [1.1511, 0.0, 0.0], [0.5742, 0.3719, 0.9054], [-0.3704, 0.3058, -1.0436], [0.1801, 0.1308, 1.1338]], "ABOVE_SURFACE": [[0.0177, 0.0, 1.1958], [1.1511, 0.0, -0.0], [0.5778, 0.3648, 0.9062], [-0.3834, 0.323, -1.0349], [0.1528, 0.111, 1.1424]], "vertex": [[0.0, 0.0, 1.0], [0.9511, -0.309, 0.0], [0.5257, 0.0, 0.8507], [-0.1625, 0.5, -0.8507], [0.0, 0.0, 1.0]], "projz": [[0.3, 0.2, 0.8735], [1.5, 0.0, 0.0], [0.2, 0.1, 0.9225], [-0.5, 0.4, -0.6869], [0.0, 0.0, 1.0]], "projz_neg": [[0.3, 0.2, 0.8735], [1.5, 0.0, 0.0], [0.2, 0.1, -0.9298], [-0.5, 0.4, -1.5], [0.0, 0.0, -1.0]]};

const sphere = buildMesh(SV.flat(), SF.map((verts) => ({ verts }))) as unknown as EvalMesh;
const pts = () => ({ positions: Float32Array.from(REF.pts.flat()), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0) }) as EvalMesh;
const ctx = { ob: { id: 'ob' }, graph: { get: (id: string) => (id === 'ob' ? { world: new Matrix4() } : { world: new Matrix4(), mesh: sphere }) } } as unknown as ModifierContext;
const t = modifierTypes.SHRINKWRAP;
const run = (p: Record<string, unknown>) => t.apply(pts(), { ...t.defaults(), target: 't', ...p } as never, ctx).positions;
// (point 4 sits exactly between facets: either nearest facet is right, so it is not compared)
const close = (a: Float32Array, b: number[][], idx = [0, 1, 2, 3]) => idx.forEach((v) => [0, 1, 2].forEach((k) => expect(Math.abs(a[v * 3 + k] - b[v][k])).toBeLessThan(2e-3)));

describe('Shrinkwrap', () => {
  it('snaps to the nearest surface point with each mode', () => {
    close(run({}), REF.nearest);
    close(run({ wrap_method: 'NEAREST_VERTEX' }), REF.vertex, [0, 2, 3]); // point 1 is equally near two vertices
    close(run({ offset: 0.2 }), REF.nearest_off);
    for (const mode of ['INSIDE', 'OUTSIDE', 'OUTSIDE_SURFACE', 'ABOVE_SURFACE']) close(run({ offset: 0.2, wrap_mode: mode }), REF[mode]);
    // inside points far enough from the surface stay put with INSIDE
    const inside = run({ offset: 0.2, wrap_mode: 'INSIDE' });
    expect(Array.from(inside.slice(6, 9))).toEqual(REF.INSIDE[2].map((x) => Math.fround(x)));
  });
  it('projects along axes in both directions', () => {
    close(run({ wrap_method: 'PROJECT', use_project_z: true, use_negative_direction: true }), REF.projz);
    close(run({ wrap_method: 'PROJECT', use_project_z: true, use_negative_direction: true, use_positive_direction: false }), REF.projz_neg);
  });
});
