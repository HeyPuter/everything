import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { geomFromBytes } from '../src/features/geometry/engine/wasm.js';
import { OP, encode, decode, jobSize } from '../src/features/geometry/engine/codec.js';
import { rectangle, ellipse, star } from '../src/model/shapes.js';
import { flattenPath, anchor } from '../src/model/bezier.js';
import { addMidpoints } from '../src/features/geometry/anchors.js';

let g;
beforeAll(() => {
  g = geomFromBytes(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
});

const sh = (anchors, extra = {}) => ({ subpaths: [{ anchors, closed: true }], filled: true, ...extra });
const line = (pts) => ({ subpaths: [{ anchors: pts.map(([x, y]) => anchor(x, y)), closed: false }], filled: false, string: true });

/** Exact-ish signed area of a subpath (fine flattening). */
function spArea(sp) {
  const pts = flattenPath(sp.anchors, sp.closed, 0.005);
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}
const area = (rec) => Math.abs(rec.subpaths.reduce((s, sp) => s + spArea(sp), 0));
const anchors = (rec) => rec.subpaths.map((sp) => sp.anchors.length);
/** A regular polygon of radius 100 with n corners. */
const regular = (n) =>
  Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return anchor(100 * Math.cos(t), 100 * Math.sin(t));
  });

describe('codec', () => {
  it('round-trips shapes through encode and decode', () => {
    const shapes = [sh(rectangle(0, 0, 10, 20), { key: 3 })];
    const buf = encode(shapes, [1.5, 2]);
    expect(buf[0]).toBe(2);
    expect(buf[1]).toBe(1.5);
    expect(buf[3]).toBe(1); // one shape
    expect(buf[4]).toBe(1); // filled flag
    expect(buf[5]).toBe(3); // key
    expect(jobSize(shapes)).toBe(4);
    // A result buffer in the same layout decodes back into records.
    const res = new Float64Array([1, 2, 1, 2, 0, 1, 1, 1, 1, 1, 2, 3, 4, 5, 6]);
    expect(decode(res)).toEqual([{ owner: 2, unchanged: true, cover: [0, 1], subpaths: [{ closed: true, anchors: [{ x: 1, y: 2, ix: 3, iy: 4, ox: 5, oy: 6 }] }] }]);
  });

  it('rejects malformed input without breaking the instance', () => {
    expect(() => g.runRaw(OP.UNITE, new Float64Array([0, 5, 1]))).toThrow();
    const r = g.run(OP.UNITE, [sh(rectangle(0, 0, 10, 10)), sh(rectangle(5, 5, 10, 10))]);
    expect(r).toHaveLength(1);
  });
});

describe('shape modes', () => {
  const A = sh(rectangle(0, 0, 100, 100));
  const B = sh(rectangle(50, 50, 100, 100));

  it('unites overlapping rectangles into one 8-anchor path', () => {
    const [r] = g.run(OP.UNITE, [A, B]);
    expect(anchors(r)).toEqual([8]);
    expect(area(r)).toBeCloseTo(17500, 3);
    expect(r.owner).toBe(1); // topmost object's style
  });

  it('intersects, excludes and subtracts with the expected style owners', () => {
    const [i] = g.run(OP.INTERSECT, [A, B]);
    expect(area(i)).toBeCloseTo(2500, 3);
    const [x] = g.run(OP.EXCLUDE, [A, B]);
    expect(area(x)).toBeCloseTo(15000, 3);
    expect(x.subpaths).toHaveLength(2);
    const [mf] = g.run(OP.MINUS_FRONT, [A, B]);
    expect(area(mf)).toBeCloseTo(7500, 3);
    expect(mf.owner).toBe(0); // backmost keeps its style
    const [mb] = g.run(OP.MINUS_BACK, [A, B]);
    expect(area(mb)).toBeCloseTo(7500, 3);
    expect(mb.owner).toBe(1);
  });

  it('keeps curves: a circle cut in half has exact sub-curves', () => {
    const [r] = g.run(OP.INTERSECT, [sh(ellipse(0, 0, 100, 100)), sh(rectangle(50, -10, 100, 120))]);
    expect(anchors(r)).toEqual([3]);
    expect(area(r)).toBeCloseTo((Math.PI * 2500) / 2, -1);
    const right = r.subpaths[0].anchors.find((a) => Math.abs(a.x - 100) < 1e-9);
    // The untouched anchor keeps its original handles.
    expect(right.y).toBe(50);
    expect(Math.abs(right.oy - right.y)).toBeCloseTo(50 * 0.5522847498, 6);
  });

  it('handles coincident edges without extra anchors', () => {
    const [r] = g.run(OP.UNITE, [A, sh(rectangle(100, 0, 100, 100))]);
    expect(anchors(r)).toEqual([4]);
    expect(area(r)).toBeCloseTo(20000, 3);
  });

  it('makes holes with opposite orientation (non-zero compound)', () => {
    const [r] = g.run(OP.MINUS_FRONT, [sh(ellipse(0, 0, 100, 100)), sh(ellipse(25, 25, 50, 50))]);
    expect(r.subpaths).toHaveLength(2);
    const [s0, s1] = r.subpaths.map(spArea);
    expect(Math.sign(s0)).toBe(-Math.sign(s1));
    expect(area(r)).toBeCloseTo(Math.PI * (2500 - 625), -1);
  });

  it('resolves self-intersections and fill rules', () => {
    // A five-point star drawn as a pentagram: even-odd leaves the center empty.
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
      pts.push(anchor(100 * Math.cos(a), 100 * Math.sin(a)));
    }
    const [nz] = g.run(OP.UNITE, [sh(pts)]);
    const [eo] = g.run(OP.UNITE, [sh(pts, { evenodd: true })]);
    expect(area(eo)).toBeLessThan(area(nz));
    expect(eo.subpaths.length).toBeGreaterThan(nz.subpaths.length - 1);
  });

  it('returns nothing for an empty intersection and for identical exclude', () => {
    expect(g.run(OP.INTERSECT, [A, sh(rectangle(500, 500, 10, 10))])).toEqual([]);
    expect(g.run(OP.EXCLUDE, [A, A])).toEqual([]);
  });
});

describe('pathfinders', () => {
  const A = sh(rectangle(0, 0, 100, 100));
  const B = sh(rectangle(50, 50, 100, 100));

  it('divides into faces with coverage and topmost owners', () => {
    const r = g.run(OP.DIVIDE, [A, B]);
    expect(r).toHaveLength(3);
    const overlap = r.find((f) => f.cover.length === 2);
    expect(overlap.owner).toBe(1);
    expect(area(overlap)).toBeCloseTo(2500, 3);
    expect(r.reduce((s, f) => s + area(f), 0)).toBeCloseTo(17500, 2);
  });

  it('divides with an open line as a cutting path', () => {
    const r = g.run(OP.DIVIDE, [A, line([[-10, 30], [110, 30]])]);
    expect(r.map(area).sort((a, b) => a - b)).toEqual([expect.closeTo(3000, 3), expect.closeTo(7000, 3)]);
  });

  it('divides a donut into ring and hole faces', () => {
    const r = g.run(OP.DIVIDE, [sh(ellipse(0, 0, 100, 100)), sh(ellipse(25, 25, 50, 50))]);
    expect(r).toHaveLength(2);
    const ring = r.find((f) => f.cover.length === 1);
    expect(ring.subpaths).toHaveLength(2);
  });

  it('trims hidden parts and merges same-colored fills', () => {
    const trim = g.run(OP.TRIM, [A, B]);
    expect(trim.map(area).sort((a, b) => a - b)).toEqual([expect.closeTo(7500, 2), expect.closeTo(10000, 2)]);
    const merged = g.run(OP.MERGE, [{ ...A, key: 0 }, { ...B, key: 0 }]);
    expect(merged).toHaveLength(1);
    expect(area(merged[0])).toBeCloseTo(17500, 2);
    const unmerged = g.run(OP.MERGE, [{ ...A, key: 0 }, { ...B, key: 1 }]);
    expect(unmerged).toHaveLength(2);
  });

  it('crops to the topmost object', () => {
    const r = g.run(OP.CROP, [A, B]);
    expect(r).toHaveLength(1);
    expect(r[0].owner).toBe(0);
    expect(area(r[0])).toBeCloseTo(2500, 3);
  });

  it('outlines every edge once, split at intersections', () => {
    const r = g.run(OP.OUTLINE, [A, B]);
    // Two outer pieces and two inner pieces, all open.
    expect(r).toHaveLength(4);
    expect(r.every((p) => p.subpaths.every((sp) => !sp.closed))).toBe(true);
    expect(r.map((p) => p.subpaths[0].anchors.length).sort()).toEqual([3, 3, 5, 5]);
  });
});

describe('cutting, erasing, strokes and offsets', () => {
  it('slices a shape with a knife line', () => {
    const r = g.run(OP.SLICE_EACH, [sh(rectangle(0, 0, 100, 100)), line([[-10, 50], [110, 60]])]);
    expect(r).toHaveLength(2);
    expect(r[0].owner).toBe(0);
    expect(r.reduce((s, x) => s + area(x), 0)).toBeCloseTo(10000, 2);
  });

  it('erases and reports untouched shapes as unchanged', () => {
    const r = g.run(OP.SUBTRACT_EACH, [sh(rectangle(0, 0, 100, 100)), sh(rectangle(300, 0, 10, 10)), sh(rectangle(40, -10, 20, 120))]);
    expect(r.filter((x) => x.owner === 0)).toHaveLength(2);
    expect(r.find((x) => x.owner === 1).unchanged).toBe(true);
  });

  it('expands a stroke into a ring', () => {
    const [r] = g.run(OP.STROKE, [sh(rectangle(0, 0, 100, 100))], [10, 0, 0, 10, 0, 0]);
    expect(r.subpaths).toHaveLength(2);
    expect(area(r)).toBeCloseTo(110 * 110 - 90 * 90, 1);
  });

  it('aligns strokes inside and outside', () => {
    const [inside] = g.run(OP.STROKE, [sh(rectangle(0, 0, 100, 100))], [10, 0, 0, 10, 1, 0]);
    expect(area(inside)).toBeCloseTo(100 * 100 - 80 * 80, 1);
    const [outside] = g.run(OP.STROKE, [sh(rectangle(0, 0, 100, 100))], [10, 0, 0, 10, 2, 0]);
    expect(area(outside)).toBeCloseTo(120 * 120 - 100 * 100, 1);
  });

  it('offsets with miter and round joins and insets curves', () => {
    const rect = sh(rectangle(0, 0, 100, 100));
    const [m] = g.run(OP.OFFSET, [rect], [10, 0, 4]);
    expect(anchors(m)).toEqual([4]);
    expect(area(m)).toBeCloseTo(14400, 2);
    const [r] = g.run(OP.OFFSET, [rect], [10, 1, 4]);
    expect(area(r)).toBeCloseTo(10000 + 4000 + Math.PI * 100, -1);
    const [inset] = g.run(OP.OFFSET, [sh(ellipse(0, 0, 100, 100))], [-10, 1, 4]);
    expect(area(inset)).toBeCloseTo(Math.PI * 1600, -1);
  });

  it('offsets and outlines strokes wider than the curves they follow', () => {
    // Insetting a circle by more than its radius leaves nothing (it used to come back whole).
    expect(g.run(OP.OFFSET, [sh(ellipse(0, 0, 10, 10))], [-10, 0, 4])[0].subpaths).toHaveLength(0);
    expect(g.run(OP.OFFSET, [sh(ellipse(0, 0, 10, 10))], [-6, 1, 4])[0].subpaths).toHaveLength(0);
    const [small] = g.run(OP.OFFSET, [sh(ellipse(0, 0, 10, 10))], [-4, 1, 4]);
    expect(area(small)).toBeCloseTo(Math.PI, 1);
    // Outsetting past a small round hole fills it.
    const rev = (a) => a.reverse().map((p) => ({ ...p, ix: p.ox, iy: p.oy, ox: p.ix, oy: p.iy }));
    const hole = { anchors: rev(ellipse(45, 45, 10, 10)), closed: true };
    const square = { anchors: rectangle(0, 0, 100, 100), closed: true };
    const holed = { subpaths: [square, hole], filled: true };
    expect(g.run(OP.OFFSET, [holed], [6, 1, 4])[0].subpaths).toHaveLength(1);
    expect(g.run(OP.OFFSET, [holed], [4, 1, 4])[0].subpaths).toHaveLength(2);
    // A stroke wider than the circle's diameter outlines to a solid disk, like it draws.
    const [disk] = g.run(OP.STROKE, [sh(ellipse(0, 0, 10, 10))], [30, 0, 0, 4, 0, 0]);
    expect(disk.subpaths).toHaveLength(1);
    expect(area(disk)).toBeCloseTo(Math.PI * 400, -1);
    // A stroke narrower than the circle keeps the stroker's exact outline (two 4-anchor rings).
    const [ring8] = g.run(OP.STROKE, [sh(ellipse(0, 0, 10, 10))], [8, 0, 0, 4, 0, 0]);
    expect(anchors(ring8)).toEqual([4, 4]);
    // Polygons with round joins too.
    const poly = regular(200);
    expect(g.run(OP.OFFSET, [sh(poly)], [-150, 1, 4])[0].subpaths).toHaveLength(0);
    const [ring] = g.run(OP.OFFSET, [sh(poly)], [-60, 1, 4]);
    expect(ring.subpaths).toHaveLength(1);
  });

  it('insets a dense polygon far past its size without stalling', () => {
    // Miter joins on 500 short segments used to take about 40 seconds.
    const poly = regular(500);
    const t = performance.now();
    expect(g.run(OP.OFFSET, [sh(poly)], [-200, 0, 4])[0].subpaths).toHaveLength(0);
    expect(performance.now() - t).toBeLessThan(20000);
  });

  it('simplifies a smooth dense circle back to few anchors', () => {
    let pts = ellipse(-50, -50, 100, 100);
    for (let k = 0; k < 3; k++) pts = addMidpoints(pts, true);
    expect(pts).toHaveLength(32);
    const [r] = g.run(OP.SIMPLIFY, [sh(pts)], [0.05, 1e-3]);
    expect(r.subpaths[0].anchors.length).toBeLessThanOrEqual(8);
    expect(r.subpaths[0].closed).toBe(true);
    expect(area(r)).toBeCloseTo(Math.PI * 2500, -1);
  });

  it('unites shapes per group key', () => {
    const r = g.run(OP.UNITE_GROUPS, [
      { ...sh(rectangle(0, 0, 10, 10)), key: 0 },
      { ...sh(rectangle(5, 0, 10, 10)), key: 0 },
      { ...sh(rectangle(50, 0, 10, 10)), key: 1 },
    ]);
    expect(r).toHaveLength(2);
    expect(r.map(area).sort((a, b) => a - b)).toEqual([expect.closeTo(100, 3), expect.closeTo(150, 3)]);
  });

  it('stays fast on hundreds of shapes', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const shapes = Array.from({ length: 300 }, () => sh(star(rnd() * 1000, rnd() * 1000, 20 + rnd() * 30, 10, 5)));
    const t = performance.now();
    const [r] = g.run(OP.UNITE, shapes);
    expect(r.subpaths.length).toBeGreaterThan(10);
    expect(performance.now() - t).toBeLessThan(3000);
  });
});
