// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildSkin, defaultSkinData } from '../../src/eval/mods/skin';
import { convexHull } from '../../src/eval/mods/hull';
import type { EvalMesh } from '../../src/eval/types';

/** An edges-only mesh. */
function sticks(verts: number[][], edges: number[][]): EvalMesh {
  return { positions: Float32Array.from(verts.flat()), offsets: new Uint32Array([0]), indices: new Uint32Array(0), uvs: new Float32Array(0), normals: new Float32Array(0), looseEdges: Uint32Array.from(edges.flat()) };
}
function closed(m: EvalMesh) {
  const count = new Map<string, number>();
  for (let f = 0; f < m.offsets.length - 1; f++)
    for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) {
      const a = m.indices[c],
        b = m.indices[c + 1 < m.offsets[f + 1] ? c + 1 : m.offsets[f]];
      const k = `${a}:${b}`;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  // every directed edge appears once and has its reverse: closed and consistently oriented
  for (const [k, n] of count) {
    if (n !== 1) return false;
    const [a, b] = k.split(':');
    if (!count.has(`${b}:${a}`)) return false;
  }
  return true;
}
const skin = (m: EvalMesh) => buildSkin(m, defaultSkinData(m), { smooth: false, branchSmoothing: 0 });

describe('Skin', () => {
  it('turns one edge into a subdivided square tube with caps', () => {
    const out = skin(sticks([[0, 0, 0], [2, 0, 0]], [[0, 1]]));
    expect(out.positions.length / 3).toBe(24);
    expect(out.offsets.length - 1).toBe(22);
    expect(closed(out)).toBe(true);
    // corners at ± the radius around the edge
    for (let i = 0; i < out.positions.length; i += 3) {
      expect(Math.abs(out.positions[i + 1])).toBeCloseTo(0.25, 5);
      expect(Math.abs(out.positions[i + 2])).toBeCloseTo(0.25, 5);
    }
  });

  it('builds closed surfaces for chains and branches', () => {
    const chain = skin(sticks([[0, 0, 0], [1, 0, 0], [2, 0.5, 0]], [[0, 1], [1, 2]]));
    expect(chain.positions.length / 3).toBe(28);
    expect(closed(chain)).toBe(true);
    const tee = skin(sticks([[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0]], [[0, 1], [0, 2], [0, 3]]));
    expect(closed(tee)).toBe(true);
    const star = skin(sticks([[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1]], [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5]]));
    expect(closed(star)).toBe(true);
  });

  it('uses per-vertex radii', () => {
    const m = sticks([[0, 0, 0], [0, 0, 1]], [[0, 1]]);
    const data = defaultSkinData(m);
    data.set([0.5, 0.1], 4);
    const out = buildSkin(m, data, { smooth: true, branchSmoothing: 0 });
    let maxX = 0,
      maxY = 0;
    for (let i = 0; i < out.positions.length; i += 3)
      if (Math.abs(out.positions[i + 2] - 1) < 1e-6) {
        maxX = Math.max(maxX, Math.abs(out.positions[i]));
        maxY = Math.max(maxY, Math.abs(out.positions[i + 1]));
      }
    expect(maxX).toBeCloseTo(0.5, 5);
    expect(maxY).toBeCloseTo(0.1, 5);
    expect(out.smooth!.every((s) => s === 1)).toBe(true);
  });
});

describe('convex hull', () => {
  it('includes coplanar boundary points as vertices', () => {
    // a box with extra points in the middle of two edges and one face
    const pts = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0.5, 0, 0, 0.5, 0.5, 1];
    const tris = convexHull(pts);
    expect(new Set(tris).size).toBe(10);
    expect(tris.length / 3).toBe(2 * 10 - 4);
  });
});
