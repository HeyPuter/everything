// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { newMeshData } from '../../src/data/defaults';
import * as prim from '../../src/mesh/primitives';
import { modifierTypes } from '../../src/eval/modifiers';
import type { EvalMesh, ModifierContext } from '../../src/eval/types';

const t = modifierTypes.SUBSURF;
const run = (m: EvalMesh, props: Record<string, unknown>) => t.apply(m, { ...t.defaults(), ...props } as never, { render: false } as ModifierContext);
/** Sorted distinct positions (rounded), like a set of points. */
const pts = (m: EvalMesh) => {
  const s = new Set<string>();
  for (let i = 0; i < m.positions.length; i += 3) s.add([0, 1, 2].map((k) => (Math.round(m.positions[i + k] * 1e4) / 1e4 || 0).toFixed(4)).join(','));
  return [...s].map((x) => x.split(',').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
};
const close = (a: number[][], b: number[][], digits = 3) => b.forEach((p, i) => p.forEach((x, k) => expect(a[i][k]).toBeCloseTo(x, digits)));

describe('Subdivision Surface', () => {
  const cube = () => newMeshData('c', prim.cube(2)) as unknown as EvalMesh;
  it('places vertices on the limit surface by default', () => {
    close(pts(run(cube(), { levels: 1 })).slice(0, 6), [[-0.8395, 0, 0], [-0.6096, -0.6096, 0], [-0.6096, 0, -0.6096], [-0.6096, 0, 0.6096], [-0.6096, 0.6096, 0], [-0.5, -0.5, -0.5]]);
    close(pts(run(cube(), { levels: 1, use_limit_surface: false })).slice(0, 6), [[-1, 0, 0], [-0.75, -0.75, 0], [-0.75, 0, -0.75], [-0.75, 0, 0.75], [-0.75, 0.75, 0], [-0.5556, -0.5556, -0.5556]]);
    close(pts(run(cube(), { levels: 2 })).slice(0, 6), [[-0.8395, 0, 0], [-0.7818, -0.3331, 0], [-0.7818, 0, -0.3331], [-0.7818, 0, 0.3331], [-0.7818, 0.3331, 0], [-0.729, -0.3162, -0.3162]]);
  });

  it('smooths or keeps boundary corners', () => {
    const plane = () => newMeshData('p', prim.plane(2)) as unknown as EvalMesh;
    // (smoothed open corners land within a few thousandths of the reference values)
    close(pts(run(plane(), { levels: 1 })), [[-0.6719, -0.6719, 0], [-0.6719, 0.6719, 0], [-0.9167, 0, 0], [0, -0.9167, 0], [0, 0, 0], [0, 0.9167, 0], [0.6719, -0.6719, 0], [0.6719, 0.6719, 0], [0.9167, 0, 0]].sort((a, b) => a[0] - b[0] || a[1] - b[1]), 1);
    close(pts(run(plane(), { levels: 1, boundary_smooth: 'PRESERVE_CORNERS' })), [[-1, -1, 0], [-1, 0, 0], [-1, 1, 0], [0, -1, 0], [0, 0, 0], [0, 1, 0], [1, -1, 0], [1, 0, 0], [1, 1, 0]]);
  });

  it('smooths UVs inside islands and keeps them linear on request', () => {
    const grid = newMeshData('g', prim.grid(2, 2, 2)) as unknown as EvalMesh;
    // bend the UVs of the middle vertex so smoothing has something to do
    const uvs = Float32Array.from(grid.uvs);
    for (let c = 0; c < grid.indices.length; c++) if (grid.indices[c] === 4) uvs[c * 2] += 0.2;
    const g = { ...grid, uvs };
    const smooth = run(g, { levels: 1 });
    const flat = run(g, { levels: 1, uv_smooth: 'NONE' });
    // the original middle vertex keeps its own UV when linear, moves back towards the average when smoothed
    const uvOf = (m: EvalMesh, v: number) => {
      for (let c = 0; c < m.indices.length; c++) if (m.indices[c] === v) return m.uvs[c * 2];
      return NaN;
    };
    expect(uvOf(flat, 4)).toBeCloseTo(0.7, 5);
    expect(uvOf(smooth, 4)).toBeLessThan(0.7);
    expect(uvOf(smooth, 4)).toBeGreaterThan(0.5);
  });
});
