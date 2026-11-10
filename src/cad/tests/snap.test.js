import { describe, it, expect } from 'vitest';
import { findSnap } from '../src/editor/snap.js';

const drawingOf = (ents) => ({
  entities: new Map(ents.map((e, i) => [i + 1, e])),
  layerVisible: () => true,
  blocks: new Map(),
});
const INT = new Set(['int']);

describe('intersection snap', () => {
  it('finds crossings of long polylines only from the segments under the cursor', () => {
    // Two zigzags of 3000 segments with arcs; the crossing near the cursor is
    // the same one the few segments around it give.
    const zig = (n, off, flip) => {
      const pts = [];
      for (let i = 0; i <= n; i++) pts.push(i * 0.5, off + (i % 2 ? 3 : -3) * flip, i % 5 === 0 ? 0.3 : 0);
      return { type: 'polyline', layer: '0', pts, closed: false };
    };
    const a = zig(3000, 0, 1),
      b = zig(3000, 0.7, -1);
    const s = findSnap(drawingOf([a, b]), [1, 2], 24.4, 1.0, 0.4, INT, null);
    expect(s.mode).toBe('int');
    const cut = (p) => ({ ...p, pts: p.pts.slice(40 * 3, 61 * 3) });
    const t = findSnap(drawingOf([cut(a), cut(b)]), [1, 2], 24.4, 1.0, 0.4, INT, null);
    expect(t.mode).toBe('int');
    expect(s.x).toBe(t.x);
    expect(s.y).toBe(t.y);
  });

  it('snaps to exact crossings of lines, arcs and construction lines', () => {
    const d = drawingOf([
      { type: 'line', layer: '0', x1: 0, y1: 10, x2: 20, y2: 10 },
      { type: 'xline', layer: '0', x: 7, y: 0, dx: 0, dy: 1 },
      { type: 'circle', layer: '0', cx: 7, cy: 10, r: 5 },
    ]);
    expect(findSnap(d, [1, 2, 3], 7.1, 10.1, 0.5, INT, null)).toMatchObject({ x: 7, y: 10 });
    expect(findSnap(d, [1, 2, 3], 12.1, 10.1, 0.5, INT, null)).toMatchObject({ x: 12, y: 10 });
    expect(findSnap(d, [1, 2, 3], 7.1, 15.1, 0.5, INT, null)).toMatchObject({ x: 7, y: 15 });
    // an arc passing near the cursor on the far side of its circle does not count
    expect(findSnap(d, [1, 3], 4, 12, 0.5, INT, null)).toBeNull();
  });
});
