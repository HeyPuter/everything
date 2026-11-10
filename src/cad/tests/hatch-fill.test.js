import { describe, it, expect } from 'vitest';
import {
  loopsToRings,
  solidPolygons,
  triangulate,
  patternSegments,
  hatchBounds,
  ringArea,
  pointInRing,
} from '../src/core/hatch/fill.js';

const square = (x, y, s) => [x, y, x + s, y, x + s, y + s, x, y + s];
const cwSquare = (x, y, s) => [x, y, x, y + s, x + s, y + s, x + s, y];
const LINE45 = { name: 'T45', families: [{ angle: 45, x: 0, y: 0, dx: 0, dy: 2, dashes: [] }] };

function triArea(verts) {
  let a = 0;
  for (let i = 0; i < verts.length; i += 6) {
    a += Math.abs((verts[i + 2] - verts[i]) * (verts[i + 5] - verts[i + 1]) - (verts[i + 4] - verts[i]) * (verts[i + 3] - verts[i + 1])) / 2;
  }
  return a;
}

function totalLength(segs) {
  let s = 0;
  for (let i = 0; i < segs.length; i += 4) s += Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]);
  return s;
}

describe('loopsToRings and hatchBounds', () => {
  it('passes straight loops through and drops the closing duplicate', () => {
    const r = loopsToRings([[0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0]], 0.01);
    expect(r).toEqual([[0, 0, 10, 0, 10, 10]]);
  });

  it('tessellates bulges within the chord tolerance', () => {
    // Circle of radius 5 from two half-circle bulges.
    const loop = [5, 0, 1, -5, 0, 1];
    const tol = 0.001;
    const [ring] = loopsToRings([loop], tol);
    expect(ring.length / 2).toBeGreaterThan(20);
    for (let i = 0; i < ring.length; i += 2) expect(Math.hypot(ring[i], ring[i + 1])).toBeCloseTo(5, 9);
    expect(Math.abs(ringArea(ring))).toBeGreaterThan(Math.PI * 25 - 0.1);
    expect(ringArea(ring)).toBeGreaterThan(0);
    expect(hatchBounds([loop]).map((v) => +v.toFixed(9))).toEqual([-5, -5, 5, 5]);
  });

  it('handles clockwise bulges', () => {
    const [ring] = loopsToRings([[5, 0, -1, -5, 0, -1]], 0.01);
    expect(ringArea(ring)).toBeLessThan(0);
  });
});

describe('solidPolygons', () => {
  it('groups by even-odd nesting regardless of orientation', () => {
    const outer = square(0, 0, 100);
    const hole = square(10, 10, 80); // same orientation as outer on purpose
    const island = cwSquare(30, 30, 20);
    const other = cwSquare(200, 0, 10);
    const polys = solidPolygons([island, hole, outer, other]);
    expect(polys.length).toBe(3);
    const big = polys.find((p) => p[0].includes(100));
    expect(big.length).toBe(2);
    expect(ringArea(big[0])).toBeGreaterThan(0);
    expect(ringArea(big[1])).toBeLessThan(0);
    const isl = polys.find((p) => p[0][0] === 30 || p[0].includes(50));
    expect(isl.length).toBe(1);
    expect(ringArea(isl[0])).toBeCloseTo(400);
  });

  it('square with a hole with an island inside it gives two polygons', () => {
    const polys = solidPolygons([square(0, 0, 100), square(10, 10, 80), square(30, 30, 20)]);
    expect(polys.length).toBe(2);
  });
});

describe('triangulate', () => {
  it('triangle area equals polygon area', () => {
    const polys = solidPolygons([square(0, 0, 100), square(10, 10, 80), square(30, 30, 20)]);
    const { verts, count } = triangulate(polys);
    expect(verts).toBeInstanceOf(Float32Array);
    expect(count % 3).toBe(0);
    expect(count * 2).toBe(verts.length);
    expect(triArea(verts)).toBeCloseTo(100 * 100 - 80 * 80 + 20 * 20, 3);
  });

  it('keeps precision far from the origin with an offset', () => {
    const X = 1e7;
    const polys = solidPolygons([square(X, X, 1.5), square(X + 0.5, X + 0.5, 0.5)]);
    const { verts } = triangulate(polys, X, X);
    expect(triArea(verts)).toBeCloseTo(2.25 - 0.25, 5);
  });
});

describe('patternSegments', () => {
  const sq = [square(0, 0, 100)];

  it('fills a square with 45 degree lines inside it, length about area / spacing', () => {
    const r = patternSegments(sq, LINE45, 1, 0);
    expect(r.truncated).toBe(false);
    expect(r.dots.length).toBe(0);
    for (const v of r.segs) {
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(100 + 1e-9);
    }
    const len = totalLength(r.segs);
    expect(Math.abs(len - 10000 / 2) / 5000).toBeLessThan(0.02);
    // Each segment is a chord at 45 degrees.
    for (let i = 0; i < r.segs.length; i += 4) {
      expect(Math.abs(r.segs[i + 2] - r.segs[i] - (r.segs[i + 3] - r.segs[i + 1]))).toBeLessThan(1e-9);
    }
  });

  it('scale and rotation apply to spacing', () => {
    const r = patternSegments(sq, LINE45, 2, Math.PI / 4);
    // Lines now at 90 degrees, 4 apart: x = 0, 4, ..., 100 minus the boundary-collinear ones.
    const len = totalLength(r.segs);
    expect(Math.abs(len - 10000 / 4) / 2500).toBeLessThan(0.05);
    for (let i = 0; i < r.segs.length; i += 4) expect(r.segs[i]).toBeCloseTo(r.segs[i + 2], 9);
  });

  it('respects holes with the even-odd rule', () => {
    const rings = [square(0, 0, 100), square(25, 25, 50)];
    const r = patternSegments(rings, LINE45, 1, 0);
    const len = totalLength(r.segs);
    expect(Math.abs(len - 7500 / 2) / 3750).toBeLessThan(0.02);
    for (let i = 0; i < r.segs.length; i += 4) {
      const mx = (r.segs[i] + r.segs[i + 2]) / 2,
        my = (r.segs[i + 1] + r.segs[i + 3]) / 2;
      expect(pointInRing(mx, my, rings[1])).toBe(0);
    }
  });

  it('clips dashes and keeps the phase continuous along each line', () => {
    const pat = { name: 'D', families: [{ angle: 0, x: 0, y: 0.5, dx: 0, dy: 1, dashes: [3, -2] }] };
    const r = patternSegments([square(0.5, 0, 9)], pat, 1, 0);
    // Rows y = 0.5 .. 8.5; per row dashes [0.5,3], [5,8] clipped by x in [0.5, 9.5], plus [9.5] edge? no.
    const rows = new Map();
    for (let i = 0; i < r.segs.length; i += 4) {
      const y = r.segs[i + 1];
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push([+r.segs[i].toFixed(9), +r.segs[i + 2].toFixed(9)]);
    }
    expect(rows.size).toBe(9);
    for (const list of rows.values()) {
      list.sort((a, b) => a[0] - b[0]);
      expect(list).toEqual([
        [0.5, 3],
        [5, 8],
      ]);
    }
  });

  it('shifts dash phase between lines by dx and emits dots', () => {
    const pat = { name: 'S', families: [{ angle: 0, x: 0, y: 0.5, dx: 1, dy: 1, dashes: [0, -4] }] };
    const r = patternSegments([square(0, 0, 10)], pat, 1, 0);
    expect(r.segs.length).toBe(0);
    for (let i = 0; i < r.dots.length; i += 2) {
      const k = Math.round(r.dots[i + 1] - 0.5);
      const phase = (((r.dots[i] - k) % 4) + 4) % 4;
      expect(Math.min(phase, 4 - phase)).toBeLessThan(1e-9);
    }
    expect(r.dots.length / 2).toBeGreaterThan(20);
  });

  it('sets truncated when the cap is hit', () => {
    const r = patternSegments([square(0, 0, 100)], LINE45, 0.01, 0, { maxSegments: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.segs.length / 4).toBeLessThanOrEqual(1000);
    const ok = patternSegments([square(0, 0, 100)], LINE45, 1, 0, { maxSegments: 1000 });
    expect(ok.truncated).toBe(false);
  });

  it('bails out early on absurdly dense line families', () => {
    const t0 = performance.now();
    const r = patternSegments([square(0, 0, 1e6)], LINE45, 1e-6, 0);
    expect(r.truncated).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('SOLID and unknown patterns produce nothing', () => {
    expect(patternSegments(sq, 'SOLID', 1, 0).segs.length).toBe(0);
    expect(patternSegments(sq, 'NOPE', 1, 0).segs.length).toBe(0);
  });

  it('is fast on a boundary with many vertices', () => {
    const n = 20000;
    const ring = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 500 + 20 * Math.sin(a * 50);
      ring.push(r * Math.cos(a), r * Math.sin(a));
    }
    const t0 = performance.now();
    const res = patternSegments([ring], 'CROSS', 1, 0);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(res.truncated).toBe(false);
    expect(res.segs.length).toBeGreaterThan(0);
  });
});

describe('patternSegments on boundary edges along the lines', () => {
  it('draws nothing outside rectangles whose sides lie on pattern lines', () => {
    const rect = (x0, y0, x1, y1) => [x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0];
    for (const [box, pat, ang] of [
      [[10, 10, 50, 40], 'GRID', 0],
      [[0, 10, 60, 70], 'GRID', 0],
      [[0, 10, 60, 70], 'LINES', Math.PI / 4],
      [[100, 100, 300, 250], 'GRID', 0],
    ]) {
      const [x0, y0, x1, y1] = box;
      const s = patternSegments(loopsToRings([rect(...box)]), pat, 1, ang).segs;
      expect(s.length).toBeGreaterThan(0);
      for (let i = 0; i < s.length; i += 2) {
        expect(s[i]).toBeGreaterThanOrEqual(x0 - 1e-9);
        expect(s[i]).toBeLessThanOrEqual(x1 + 1e-9);
        expect(s[i + 1]).toBeGreaterThanOrEqual(y0 - 1e-9);
        expect(s[i + 1]).toBeLessThanOrEqual(y1 + 1e-9);
      }
    }
  });
});
