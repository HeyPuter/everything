import { describe, it, expect } from 'vitest';
import { icoSphere, torus } from '../../src/mesh/primitives';
import { newMeshData } from '../../src/data/defaults';
import { baseEvalMesh } from '../../src/eval/depsgraph';
import { MeshSampler, planSamples } from '../../src/physics/sampling';
import { triangulate } from '../../src/physics/colliders';

const meshOf = (a: ReturnType<typeof icoSphere>) => baseEvalMesh(newMeshData('M', a));

/** Ray-crossing parity against every triangle (the plain definition of inside). */
function insideBrute(P: Float32Array, T: Uint32Array, x: number, y: number, z: number) {
  let n = 0;
  for (let t = 0; t < T.length; t += 3) {
    const [a, b, c] = [T[t] * 3, T[t + 1] * 3, T[t + 2] * 3];
    const ay = P[a + 1] - y, az = P[a + 2] - z, by = P[b + 1] - y, bz = P[b + 2] - z, cy = P[c + 1] - y, cz = P[c + 2] - z; // prettier-ignore
    const d1 = ay * bz - az * by, d2 = by * cz - bz * cy, d3 = cy * az - cz * ay; // prettier-ignore
    if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;
    const s = d1 + d2 + d3;
    if (Math.abs(s) < 1e-14) continue;
    if ((P[a] * d2 + P[b] * d3 + P[c] * d1) / s > x) n++;
  }
  return (n & 1) === 1;
}

describe('emission sampling on dense meshes', () => {
  it('answers inside tests like a test against every triangle', () => {
    const m = meshOf(torus(48, 16, 1, 0.4));
    const s = new MeshSampler(m);
    const T = triangulate(m.positions, m.offsets, m.indices);
    let inside = 0;
    for (let i = 0; i < 4000; i++) {
      const x = Math.sin(i * 12.9898) * 1.6,
        y = Math.sin(i * 78.233) * 1.6,
        z = Math.sin(i * 37.719) * 0.6;
      const r = s.inside(x, y, z);
      expect(r).toBe(insideBrute(m.positions, T, x, y, z));
      if (r) inside++;
    }
    expect(inside).toBeGreaterThan(200);
    expect(s.inside(NaN, 0, 0)).toBe(false);
  });

  it('places a face grid on a dense mesh quickly, every point on the surface', () => {
    // 20k triangles at resolution 40 meant 1.3 billion triangle tests (minutes) before
    const m = meshOf(icoSphere(5, 1));
    const t = performance.now();
    const pts = planSamples(new MeshSampler(m), { emit_from: 'FACE', distribution: 'GRID', grid_resolution: 40 } as never, 1, 0);
    expect(performance.now() - t).toBeLessThan(10000);
    expect(pts.length).toBeGreaterThan(3000);
    for (const p of pts) expect(Math.abs(Math.hypot(p.px, p.py, p.pz) - 1)).toBeLessThan(0.01);
    // the volume grid keeps to the inside
    const vol = planSamples(new MeshSampler(m), { emit_from: 'VOLUME', distribution: 'GRID', grid_resolution: 30 } as never, 1, 0);
    expect(vol.length).toBeGreaterThan(10000);
    for (const p of vol) expect(Math.hypot(p.px, p.py, p.pz)).toBeLessThan(1);
  });
});
