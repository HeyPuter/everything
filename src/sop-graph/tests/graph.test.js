import { describe, expect, it } from 'vitest';
import { defaultGraph, evaluate, opGrid, opNoise } from '../src/engine/graph.js';

describe('SOP graph', () => {
  it('grid creates n*n points', () => {
    expect(opGrid({ n: 3, size: 1 })).toHaveLength(9);
  });

  it('noise preserves count', () => {
    const g = opGrid({ n: 4, size: 1 });
    expect(opNoise(g, { amp: 0.2, freq: 2 })).toHaveLength(g.length);
  });

  it('evaluates default graph', () => {
    const pts = evaluate(defaultGraph());
    expect(pts.length).toBe(64);
    expect(pts.some((p) => Math.abs(p.y) > 0.01)).toBe(true);
  });
});
