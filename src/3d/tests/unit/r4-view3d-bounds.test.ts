import { describe, it, expect } from 'vitest';
import { boundsShape } from '../../src/editors/view3d/objdisplay';

const pts = (seg: number[]) => {
  const out: number[][] = [];
  for (let i = 0; i < seg.length; i += 3) out.push([seg[i], seg[i + 1], seg[i + 2]]);
  return out;
};

describe('bounds shapes', () => {
  it('box has 12 edges on the bounding box corners', () => {
    const s = boundsShape('BOX', [-1, -2, 0], [1, 2, 3]);
    expect(s.length / 6).toBe(12);
    for (const p of pts(s)) {
      expect(Math.abs(p[0])).toBe(1);
      expect(Math.abs(p[1])).toBe(2);
      expect([0, 3]).toContain(p[2]);
    }
  });

  it('sphere radius is the largest half extent around the centre', () => {
    const s = boundsShape('SPHERE', [-1, -1, -3], [1, 1, 3]);
    for (const p of pts(s)) expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(3, 6);
  });

  it('cylinder, cone and capsule stay inside their box height', () => {
    for (const t of ['CYLINDER', 'CONE', 'CAPSULE'] as const) {
      const zs = pts(boundsShape(t, [-1, -1, 0], [1, 1, 4])).map((p) => p[2]);
      expect(Math.min(...zs)).toBeGreaterThanOrEqual(-1e-9);
      expect(Math.max(...zs)).toBeLessThanOrEqual(4 + 1e-9);
    }
  });
});
