import { describe, it, expect } from 'vitest';
import { Matrix4, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { combDab, makeProjector, segmentLengths, falloff } from '../../src/hair/brushmath';

/** Front view (looking down -Y onto the XZ plane), 1 unit = 100 px, centre at (200, 200). */
function frontProjector() {
  const cam = new OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
  cam.position.set(0, -10, 0);
  cam.up.set(0, 0, 1);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const m = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  return makeProjector(m.elements, 400, 400);
}

const strand = (n: number, len: number) => {
  const P = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) P[i * 3 + 2] = (i / (n - 1)) * len;
  return P;
};

describe('hair brush math', () => {
  it('projects and unprojects', () => {
    const p = frontProjector();
    const out = new Float64Array(3);
    p.toScreen(1, 0, 1, out);
    expect(out[0]).toBeCloseTo(300, 3);
    expect(out[1]).toBeCloseTo(100, 3);
    const back = new Float64Array(3);
    p.fromScreen(out[0], out[1], out[2], back);
    expect(Array.from(back).map((x) => +x.toFixed(4))).toEqual([1, 0, 1]);
    const persp = new PerspectiveCamera(50, 1, 0.1, 100);
    persp.position.set(0, -10, 2);
    persp.lookAt(new Vector3(0, 0, 0));
    persp.updateMatrixWorld();
    const pp = makeProjector(new Matrix4().multiplyMatrices(persp.projectionMatrix, persp.matrixWorldInverse).elements, 400, 400);
    pp.toScreen(0.3, 0.2, 0.5, out);
    pp.fromScreen(out[0], out[1], out[2], back);
    expect(Array.from(back).map((x) => +x.toFixed(3))).toEqual([0.3, 0.2, 0.5]);
  });

  it('falloff goes from 1 at the centre to 0 at the rim', () => {
    for (const k of ['SMOOTH', 'SPHERE', 'ROOT', 'SHARP', 'LINEAR'] as const) {
      expect(falloff(0, k)).toBe(1);
      expect(falloff(1, k)).toBe(0);
      expect(falloff(0.5, k)).toBeGreaterThan(0);
    }
    expect(falloff(0.7, 'CONSTANT')).toBe(1);
  });

  it('comb drags points sideways keeping roots and lengths', () => {
    const P = strand(5, 1);
    const s = { positions: P, offsets: [0, 5] };
    const L = segmentLengths(s);
    const ch = combDab(s, frontProjector(), { x: 200, y: 150, radius: 80, strength: 1, falloff: 'CONSTANT' }, 30, 0, L);
    expect(ch).toEqual([0]);
    expect(Array.from(P.subarray(0, 3))).toEqual([0, 0, 0]);
    // the tip moved to +x, segment lengths unchanged
    expect(P[4 * 3]).toBeGreaterThan(0.05);
    const L2 = segmentLengths(s);
    for (let i = 1; i < 5; i++) expect(L2[i]).toBeCloseTo(L[i], 5);
  });
});
