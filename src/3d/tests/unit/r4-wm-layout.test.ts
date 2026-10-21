import { describe, it, expect } from 'vitest';
import { layoutEdges, edgeNear, edgeRatio, GAP } from '../../src/ui/layout';
import type { LayoutNode } from '../../src/ui/screen';

const A = (id: string): LayoutNode => ({ area: { id, type: 'VIEW_3D' } });

describe('layout edges', () => {
  const root: LayoutNode = { split: 'h', ratio: 0.75, a: { split: 'v', ratio: 0.5, a: A('a'), b: A('b') }, b: A('c') };
  it('lists one edge per split with its position and extent', () => {
    const e = layoutEdges(root, 802, 402);
    expect(e).toHaveLength(2);
    const [h, v] = e;
    expect(h.dir).toBe('h');
    expect(h.pos).toBe(Math.round((802 - GAP) * 0.75) + GAP / 2);
    expect([h.from, h.to]).toEqual([0, 402]);
    expect(v.dir).toBe('v');
    expect(v.to).toBe(Math.round((802 - GAP) * 0.75));
  });
  it('finds the edge near a point', () => {
    const e = layoutEdges(root, 802, 402);
    expect(edgeNear(e, 602, 100)?.dir).toBe('h');
    expect(edgeNear(e, 100, 201)?.dir).toBe('v');
    expect(edgeNear(e, 100, 100)).toBeNull();
    // the horizontal edge stops at the vertical one
    expect(edgeNear(e, 700, 201)).toBeNull();
  });
  it('edge ratio keeps a header height on both sides', () => {
    const [h] = layoutEdges(root, 802, 402);
    expect(edgeRatio(h, h.pos)).toBeCloseTo(0.75, 9);
    expect(edgeRatio(h, 0)).toBeCloseTo(26 / 800, 9);
    expect(edgeRatio(h, 10000)).toBeCloseTo(1 - 26 / 800, 9);
  });
});
