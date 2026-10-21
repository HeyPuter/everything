import { describe, it, expect } from 'vitest';
import { cube, grid, uvSphere } from '../../src/mesh/primitives';
import { thresholdEdges, thresholdAngle } from '../../src/editors/view3d/wirethreshold';

describe('wireframe threshold', () => {
  it('maps the threshold to a minimum face angle', () => {
    expect(thresholdAngle(1)).toBe(0);
    expect(thresholdAngle(0)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('keeps all edges at 1 and the 90° cube edges even at 0', () => {
    const c = cube();
    expect(thresholdEdges(c, 1).length / 2).toBe(12);
    expect(thresholdEdges(c, 0).length / 2).toBe(12);
  });

  it('drops flat interior edges but keeps the border of a grid', () => {
    const g = grid(4, 4, 2);
    const all = thresholdEdges(g, 1).length / 2;
    const border = thresholdEdges(g, 0.5).length / 2;
    expect(all).toBeGreaterThan(border);
    // 4×4 quads: 16 border edges
    expect(border).toBe(16);
  });

  it('removes gently curved sphere edges as the threshold falls', () => {
    const s = uvSphere(32, 16);
    const n1 = thresholdEdges(s, 1).length,
      n9 = thresholdEdges(s, 0.9).length,
      n0 = thresholdEdges(s, 0).length;
    expect(n1).toBeGreaterThan(n9);
    expect(n9).toBeGreaterThanOrEqual(n0);
    expect(n0).toBe(0);
  });
});
