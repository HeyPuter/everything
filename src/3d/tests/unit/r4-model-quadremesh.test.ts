// Quad remesher: all-quad, closed, close to the target face count and on the original surface;
// sharp features and open boundaries stay in place.
import { describe, it, expect } from 'vitest';
import { quadRemesh } from '../../src/modeling/quadremesh';
import { uvSphere, cube, grid, cylinder } from '../../src/mesh/primitives';

function facesOf(a: { offsets: ArrayLike<number>; indices: ArrayLike<number> }) {
  const out: number[][] = [];
  for (let f = 0; f + 1 < a.offsets.length; f++) out.push(Array.from(a.indices).slice(a.offsets[f], a.offsets[f + 1]));
  return out;
}
function edgeUse(quads: Uint32Array) {
  const m = new Map<string, number>();
  for (let q = 0; q < quads.length; q += 4)
    for (let i = 0; i < 4; i++) {
      const a = quads[q + i],
        b = quads[q + ((i + 1) % 4)];
      const k = a < b ? `${a}:${b}` : `${b}:${a}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
  return m;
}

describe('quad remesh', () => {
  it('a sphere: closed quads near the target count, on the sphere', () => {
    const s = uvSphere(32, 16, 1);
    const r = quadRemesh(s.positions, facesOf(s), { targetFaces: 600, sharpAngle: 0 });
    const n = r.quads.length / 4;
    expect(n).toBeGreaterThan(300);
    expect(n).toBeLessThan(1200);
    for (const c of edgeUse(r.quads).values()) expect(c).toBe(2);
    for (let i = 0; i < r.positions.length; i += 3) expect(Math.hypot(r.positions[i], r.positions[i + 1], r.positions[i + 2])).toBeCloseTo(1, 1);
  });
  it('a cube keeps its corners and edges (sharp features)', () => {
    const c = cube(2);
    const r = quadRemesh(c.positions, facesOf(c), { targetFaces: 200, sharpAngle: (30 * Math.PI) / 180 });
    for (const k of edgeUse(r.quads).values()) expect(k).toBe(2);
    // every vertex on the cube's surface: one coordinate at ±1
    for (let i = 0; i < r.positions.length; i += 3) {
      const p = [r.positions[i], r.positions[i + 1], r.positions[i + 2]].map(Math.abs);
      expect(Math.max(...p)).toBeCloseTo(1, 3);
    }
    // the 8 corners are still there
    const corners = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [x, y, z])));
    for (const q of corners) {
      let best = Infinity;
      for (let i = 0; i < r.positions.length; i += 3) best = Math.min(best, Math.hypot(r.positions[i] - q[0], r.positions[i + 1] - q[1], r.positions[i + 2] - q[2]));
      expect(best).toBeLessThan(1e-4);
    }
  });
  it('an open grid keeps its boundary square', () => {
    const g = grid(4, 4, 2);
    const r = quadRemesh(g.positions, facesOf(g), { targetFaces: 100, sharpAngle: 0 });
    const n = r.quads.length / 4;
    expect(n).toBeGreaterThan(40);
    for (let i = 0; i < r.positions.length; i += 3) {
      expect(Math.abs(r.positions[i])).toBeLessThanOrEqual(1 + 1e-5);
      expect(Math.abs(r.positions[i + 1])).toBeLessThanOrEqual(1 + 1e-5);
      expect(Math.abs(r.positions[i + 2])).toBeLessThan(1e-5);
    }
  });
  it('a cylinder with caps stays closed', () => {
    const c = cylinder(24, 1, 2, 'NGON');
    const r = quadRemesh(c.positions, facesOf(c), { targetFaces: 300, sharpAngle: (30 * Math.PI) / 180 });
    for (const k of edgeUse(r.quads).values()) expect(k).toBe(2);
  });
});
