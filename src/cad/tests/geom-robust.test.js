import { describe, it, expect } from 'vitest';
import * as G from '../src/core/geom/index.js';

const TWO_PI = G.TWO_PI;

/** Degenerate and edge-case entities of every type. */
const degenerate = [
  { type: 'line', x1: 1, y1: 1, x2: 1, y2: 1 },
  { type: 'xline', x: 0, y: 0, dx: 0, dy: 0 },
  { type: 'ray', x: 0, y: 0, dx: 0, dy: 0 },
  { type: 'circle', cx: 0, cy: 0, r: 0 },
  { type: 'arc', cx: 0, cy: 0, r: 0, start: 0, end: 1 },
  { type: 'arc', cx: 0, cy: 0, r: 1, start: 1, end: 1 },
  { type: 'ellipse', cx: 0, cy: 0, mx: 0, my: 0, ratio: 0.5, start: 0, end: TWO_PI },
  { type: 'ellipse', cx: 0, cy: 0, mx: 1, my: 0, ratio: 1e-15, start: 0, end: TWO_PI },
  { type: 'polyline', pts: [], closed: false, width: 0 },
  { type: 'polyline', pts: [1, 1, 0], closed: true, width: 0 },
  { type: 'polyline', pts: [1, 1, 0, 1, 1, 5, 1, 1, 0], closed: true, width: 0 },
  { type: 'spline', degree: 3, ctrl: [], knots: [], fit: [], closed: false },
  { type: 'spline', degree: 3, ctrl: [2, 2], knots: [], fit: [], closed: false },
  { type: 'spline', degree: 3, ctrl: [0, 0, 1, 1], knots: [0, 1], fit: [], closed: false },
  { type: 'point', x: 0, y: 0 },
  { type: 'text', x: 0, y: 0, h: 1, rot: 0, value: '', halign: 'left', valign: 'baseline' },
  { type: 'mtext', x: 0, y: 0, h: 1, rot: 0, value: '', width: 0, attach: 'tl' },
  { type: 'dimension', dimType: 'linear', x1: 0, y1: 0, x2: 0, y2: 0, lx: 0, ly: 0, rot: 0 },
  { type: 'leader', pts: [0, 0], text: '', h: 1 },
  { type: 'hatch', loops: [[], [0, 0, 0]], pattern: 'SOLID', scale: 1, angle: 0 },
  { type: 'insert', name: 'B', x: 0, y: 0, sx: 0, sy: 0, rot: 0 },
];

const cutters = G.toPrims({ type: 'line', x1: -10, y1: 0.5, x2: 10, y2: 0.5 });

describe('degenerate inputs never throw', () => {
  for (const e of degenerate) {
    it(`${e.type} ${JSON.stringify(e).slice(0, 60)}`, () => {
      expect(() => {
        G.toPrims(e);
        G.tessellate(e, 0.01);
        G.entityBounds(e);
        G.closestPoint(e, 3, 4);
        G.distanceTo(e, 3, 4);
        G.endpoints(e);
        G.midpoints(e);
        G.centers(e);
        G.quadrants(e);
        G.nodes(e);
        G.perpendicularFrom(e, 3, 4);
        G.tangentsFrom(e, 3, 4);
        G.geometricCenter(e);
        G.transformEntity(e, G.mirror(0, 0, 1, 1));
        G.transformEntity(e, G.scale(0));
        G.transformEntity(e, G.scale(2, 0, 0, 3));
        G.offsetEntity(e, 1, 3, 4);
        G.trimEntity(e, cutters, 0, 0);
        G.extendEntity(e, cutters, 0, 0);
        G.breakEntity(e, 0, 0, 1, 1);
        G.breakAtPoint(e, 0, 0);
        G.lengthOf(e);
        G.areaOf(e);
        G.explodeEntity(e);
        G.joinEntities([e, e]);
        for (const p of G.toPrims(e)) for (const q of cutters) G.intersectPrims(p, q);
        G.intersectEntities(e, e);
      }).not.toThrow();
    });
  }
  it('handles empty input and NaN-free results for coincident geometry', () => {
    expect(G.joinEntities([])).toEqual({ result: [], consumedIds: [] });
    const c = { type: 'circle', cx: 0, cy: 0, r: 1 };
    expect(G.intersectEntities(c, c)).toEqual([]);
    const l = { type: 'line', x1: 0, y1: 0, x2: 1, y2: 0 };
    expect(G.intersectEntities(l, l)).toEqual([]);
    expect(G.fillet(l, { x: 0, y: 0 }, l, { x: 1, y: 0 }, 1)).toBe(null);
  });
  it('stays accurate far from the origin', () => {
    const o = 1e7;
    const h = G.intersectPrims(
      { t: 'seg', x1: o, y1: o, x2: o + 10, y2: o + 10 },
      { t: 'arc', cx: o, cy: o, r: 5, a0: 0, a1: TWO_PI, full: true },
    );
    expect(h.length).toBe(1);
    expect(Math.abs(Math.hypot(h[0].x - o, h[0].y - o) - 5)).toBeLessThan(1e-8);
    const rect = { type: 'polyline', pts: [o, o, 0, o + 10, o, 0, o + 10, o + 6, 0, o, o + 6, 0], closed: true, width: 0 };
    expect(Math.abs(G.areaOf(rect) - 60)).toBeLessThan(1e-6);
    const inner = G.offsetEntity(rect, 1, o + 5, o + 3);
    expect(Math.abs(G.areaOf(inner) - 32)).toBeLessThan(1e-6);
  });
  it('keeps distinct hits on small curves far from the origin', () => {
    const o = 5e6;
    const circle = { type: 'circle', cx: o, cy: o, r: 0.4 };
    const line = { type: 'line', x1: o - 2, y1: o, x2: o + 2, y2: o };
    expect(G.intersectEntities(circle, line)).toHaveLength(2);
    expect(G.intersectPrims(G.toPrims(circle)[0], G.toPrims(line)[0])).toHaveLength(2);
    const ell = { type: 'ellipse', cx: o, cy: o, mx: 0.5, my: 0, ratio: 0.5, start: 0, end: TWO_PI };
    expect(G.intersectEntities(ell, line)).toHaveLength(2);
    // Trimming between the two hits keeps both outer pieces.
    const r = G.trimEntity(line, G.toPrims(circle), o, o);
    expect(r.add).toHaveLength(2);
    expect(r.add[0].x2).toBeCloseTo(o - 0.4, 6);
    expect(r.add[1].x1).toBeCloseTo(o + 0.4, 6);
  });
});
