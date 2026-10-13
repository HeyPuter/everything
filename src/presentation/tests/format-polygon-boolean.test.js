import { describe, expect, it } from "vitest";
import {
  area,
  combine,
  fragment,
  intersect,
  polygonsArea,
  subtract,
  union,
  xor,
} from "../src/format/polygon-boolean.js";

const U = 10_000;
const rect = (x, y, w, h) => [
  { x: x * U, y: y * U },
  { x: (x + w) * U, y: y * U },
  { x: (x + w) * U, y: (y + h) * U },
  { x: x * U, y: (y + h) * U },
];
const circle = (cx, cy, r, n = 128) =>
  Array.from({ length: n }, (_, i) => ({
    x: cx + r * Math.cos((2 * Math.PI * i) / n),
    y: cy + r * Math.sin((2 * Math.PI * i) / n),
  }));
const sq = (n) => n * U * U;

describe("polygon boolean operations", () => {
  const a = [rect(0, 0, 10, 10)],
    b = [rect(5, 5, 10, 10)];

  it("computes signed ring areas", () => {
    expect(area(rect(0, 0, 2, 3))).toBe(sq(6));
    expect(area(rect(0, 0, 2, 3).reverse())).toBe(-sq(6));
  });

  it("handles two overlapping squares", () => {
    const u = union([a, b]);
    expect(u).toHaveLength(1);
    expect(u[0].outer).toHaveLength(8);
    expect(area(u[0].outer)).toBeGreaterThan(0);
    expect(polygonsArea(u)).toBe(sq(175));
    expect(polygonsArea(intersect([a, b]))).toBe(sq(25));
    expect(polygonsArea(subtract([a, b]))).toBe(sq(75));
    expect(polygonsArea(subtract([b, a]))).toBe(sq(75));
    const x = xor([a, b]);
    expect(polygonsArea(x)).toBe(sq(150));
    expect(x).toHaveLength(2);
    expect(combine).toBe(xor);
  });

  it("fragments overlapping squares into three faces", () => {
    const pieces = fragment([a, b]);
    expect(pieces.map((p) => p.membership)).toEqual([
      [true, true],
      [true, false],
      [false, true],
    ]);
    expect(pieces.map((p) => polygonsArea([p.polygon]))).toEqual([
      sq(25),
      sq(75),
      sq(75),
    ]);
  });

  it("keeps disjoint shapes apart and handles containment", () => {
    const far = [rect(20, 0, 5, 5)];
    expect(union([a, far])).toHaveLength(2);
    expect(polygonsArea(intersect([a, far]))).toBe(0);
    const inner = [rect(2, 2, 3, 3)];
    expect(polygonsArea(union([a, inner]))).toBe(sq(100));
    const hole = subtract([a, inner]);
    expect(hole).toHaveLength(1);
    expect(hole[0].holes).toHaveLength(1);
    expect(area(hole[0].holes[0])).toBeLessThan(0);
    expect(polygonsArea(hole)).toBe(sq(91));
    expect(polygonsArea(intersect([a, inner]))).toBe(sq(9));
  });

  it("treats an operand's nested rings as holes (even-odd)", () => {
    const ring = [rect(0, 0, 10, 10), rect(3, 3, 4, 4)];
    expect(polygonsArea(union([ring]))).toBe(sq(84));
    const pieces = fragment([ring, [rect(2, 2, 6, 6)]]);
    expect(
      pieces.map((p) => polygonsArea([p.polygon])).sort((x, y) => x - y),
    ).toEqual([sq(16), sq(20), sq(64)]);
    // Filling the hole with a second shape closes it.
    const filled = union([ring, [rect(3, 3, 4, 4)]]);
    expect(filled).toHaveLength(1);
    expect(filled[0].holes).toHaveLength(0);
  });

  it("merges identical shapes", () => {
    expect(union([a, a])[0].outer).toHaveLength(4);
    expect(polygonsArea(intersect([a, a]))).toBe(sq(100));
    expect(xor([a, a])).toEqual([]);
    expect(fragment([a, a])).toHaveLength(1);
  });

  it("joins shapes sharing an edge into one ring", () => {
    const u = union([a, [rect(10, 0, 10, 10)]]);
    expect(u).toHaveLength(1);
    expect(u[0].outer).toHaveLength(4);
    expect(polygonsArea(u)).toBe(sq(200));
    // Partial shared edge.
    const p = union([a, [rect(10, 4, 5, 2)]]);
    expect(p).toHaveLength(1);
    expect(p[0].outer).toHaveLength(8);
  });

  it("keeps vertex-touching shapes as separate polygons", () => {
    const u = union([a, [rect(10, 10, 5, 5)]]);
    expect(u).toHaveLength(2);
    expect(u.map((p) => p.outer.length)).toEqual([4, 4]);
    expect(polygonsArea(u)).toBe(sq(125));
  });

  it("handles concave shapes", () => {
    const ell = [
      [
        { x: 0, y: 0 },
        { x: 10 * U, y: 0 },
        { x: 10 * U, y: 3 * U },
        { x: 3 * U, y: 3 * U },
        { x: 3 * U, y: 10 * U },
        { x: 0, y: 10 * U },
      ],
    ];
    const bar = [rect(5, -2, 2, 14)];
    expect(polygonsArea(union([ell, bar]))).toBe(sq(51 + 28 - 6));
    expect(polygonsArea(intersect([ell, bar]))).toBe(sq(6));
    expect(subtract([ell, bar])).toHaveLength(2);
  });

  it("handles flattened circles within tolerance", () => {
    const r = 1_000_000,
      c1 = [circle(0, 0, r)],
      c2 = [circle(r, 0, r)],
      exact = Math.PI * r * r,
      lens = 2 * r * r * Math.acos(0.5) - 0.5 * r * Math.sqrt(3) * r;
    expect(polygonsArea(union([c1])) / exact).toBeCloseTo(1, 3);
    expect(polygonsArea(intersect([c1, c2])) / lens).toBeCloseTo(1, 2);
    expect(polygonsArea(union([c1, c2])) / (2 * exact - lens)).toBeCloseTo(
      1,
      2,
    );
    const pieces = fragment([c1, c2]);
    expect(pieces).toHaveLength(3);
    const total = pieces.reduce((s, p) => s + polygonsArea([p.polygon]), 0);
    expect(Math.abs(total - polygonsArea(union([c1, c2])))).toBeLessThan(10);
  });

  it("handles three or more operands", () => {
    const c = [rect(2, -5, 6, 25)];
    const ops = [a, b, c];
    expect(polygonsArea(union(ops))).toBe(sq(175 + 150 - 75));
    expect(polygonsArea(intersect(ops))).toBe(sq(15));
    expect(polygonsArea(subtract(ops))).toBe(sq(100 - 25 - 60 + 15));
    const pieces = fragment(ops);
    const total = pieces.reduce((s, p) => s + polygonsArea([p.polygon]), 0);
    expect(total).toBe(polygonsArea(union(ops)));
    expect(new Set(pieces.map((p) => p.membership.join())).size).toBe(7);
  });

  it("stays fast on many-segment inputs", () => {
    const ops = Array.from({ length: 6 }, (_, i) => [
      circle(i * 300_000, (i % 2) * 200_000, 500_000, 400),
    ]);
    const t = performance.now();
    const u = union(ops);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(u).toHaveLength(1);
    expect(u[0].holes).toHaveLength(0);
  });

  it("accepts results as operands", () => {
    const u = union([a, b]);
    expect(polygonsArea(subtract([u, [rect(0, 0, 15, 5)]]))).toBe(sq(175 - 50));
  });
});
