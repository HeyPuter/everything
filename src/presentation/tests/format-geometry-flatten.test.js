import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
import {
  flattenGeometry,
  ringsToFreeformPaths,
  transformRings,
} from "../src/format/geometry-flatten.js";
import { area, polygonsArea, union } from "../src/format/polygon-boolean.js";

const W = P.inches(3),
  H = P.inches(2);

function deckShape(
  preset,
  box = { x: P.inches(1), y: P.inches(1), w: W, h: H },
) {
  const pres = createDeck("blank"),
    slide = P.getSlides(pres)[0],
    shape = P.addSlideShape(slide, { preset, ...box });
  return { pres, slide, shape };
}

const ringArea = (rings) =>
  polygonsArea(union([rings.filter((r) => r.fill).map((r) => r.points)]));

describe("geometry flattening", () => {
  it("flattens a preset ellipse within the chord tolerance", () => {
    const { pres, shape } = deckShape("ellipse"),
      geometry = P.getShapeGeometryResolved(pres, shape).geometry,
      rings = flattenGeometry(geometry, { w: W, h: H }),
      exact = (Math.PI * W * H) / 4;
    expect(rings).toHaveLength(1);
    expect(rings[0]).toMatchObject({ closed: true, fill: true });
    expect(rings[0].points.length).toBeGreaterThan(32);
    for (const p of rings[0].points) {
      const e = ((p.x - W / 2) / (W / 2)) ** 2 + ((p.y - H / 2) / (H / 2)) ** 2;
      expect(Math.abs(e - 1)).toBeLessThan(1e-9);
    }
    // Chords cut inside the curve by at most the tolerance.
    const a = Math.abs(area(rings[0].points));
    expect(a).toBeLessThan(exact);
    expect(exact - a).toBeLessThan(2000 * Math.PI * (W + H));
    const fine = flattenGeometry(geometry, { tolerance: 50, w: W, h: H });
    expect(Math.abs(area(fine[0].points)) / exact).toBeCloseTo(1, 4);
  });

  it("flattens Beziers and path grids scaled to the shape box", () => {
    const geometry = {
      paths: [
        {
          w: 100,
          h: 100,
          fill: "norm",
          stroke: true,
          commands: [
            { kind: "moveTo", pt: { x: 0, y: 100 } },
            {
              kind: "cubicBezTo",
              pts: [
                { x: 0, y: 0 },
                { x: 100, y: 0 },
                { x: 100, y: 100 },
              ],
            },
            {
              kind: "quadBezTo",
              pts: [
                { x: 50, y: 50 },
                { x: 0, y: 100 },
              ],
            },
            { kind: "close" },
          ],
        },
        {
          w: null,
          h: null,
          fill: "none",
          stroke: true,
          commands: [
            { kind: "moveTo", pt: { x: 0, y: 0 } },
            { kind: "lnTo", pt: { x: 1000, y: 0 } },
          ],
        },
      ],
    };
    const rings = flattenGeometry(geometry, {
      tolerance: 100,
      w: 1_000_000,
      h: 500_000,
    });
    expect(rings.map((r) => [r.closed, r.fill])).toEqual([
      [true, true],
      [false, false],
    ]);
    const xs = rings[0].points.map((p) => p.x),
      ys = rings[0].points.map((p) => p.y);
    expect(Math.max(...xs)).toBe(1_000_000);
    expect(Math.min(...ys)).toBeCloseTo(125_000, -2);
    // The cubic bounds 3/5 of the unit grid above its chord; the quad back
    // via (0.5,0.5) removes 2/3 of its 1/4 control triangle.
    const exact = (0.6 - 1 / 6) * 1_000_000 * 500_000;
    expect(Math.abs(area(rings[0].points)) / exact).toBeCloseTo(1, 3);
    expect(rings[1].points).toEqual([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
    ]);
  });

  it("transforms rings by flip, clockwise rotation and offset", () => {
    const rings = [
        {
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 50 },
          ],
          closed: true,
          fill: true,
        },
      ],
      box = { x: 1000, y: 2000, w: 100, h: 50 };
    expect(transformRings(rings, box)[0].points).toEqual([
      { x: 1000, y: 2000 },
      { x: 1100, y: 2000 },
      { x: 1100, y: 2050 },
    ]);
    const flipped = transformRings(rings, {
      ...box,
      flipH: true,
      flipV: true,
    })[0].points;
    expect(flipped).toEqual([
      { x: 1100, y: 2050 },
      { x: 1000, y: 2050 },
      { x: 1000, y: 2000 },
    ]);
    // 90° clockwise: the top-left corner moves to the top-right of the
    // rotated (50×100) footprint centred on the same point.
    const rotated = transformRings(rings, { ...box, rot: 90 })[0].points.map(
      (p) => ({
        x: Math.round(p.x),
        y: Math.round(p.y),
      }),
    );
    expect(rotated).toEqual([
      { x: 1075, y: 1975 },
      { x: 1075, y: 2075 },
      { x: 1025, y: 2075 },
    ]);
    expect(transformRings(rings, { ...box, rot: 90 })[0]).toMatchObject({
      closed: true,
      fill: true,
    });
  });

  it("round-trips boolean results through freeform paths", () => {
    const { pres, slide, shape } = deckShape("ellipse"),
      b = P.getShapeBoundsResolved(pres, shape),
      local = flattenGeometry(
        P.getShapeGeometryResolved(pres, shape).geometry,
        b,
      ),
      slideRings = transformRings(local, { ...b, rot: 30 }),
      hole = [
        { x: b.x + W / 2 - 100_000, y: b.y + H / 2 - 100_000 },
        { x: b.x + W / 2 + 100_000, y: b.y + H / 2 - 100_000 },
        { x: b.x + W / 2 + 100_000, y: b.y + H / 2 + 100_000 },
        { x: b.x + W / 2 - 100_000, y: b.y + H / 2 + 100_000 },
      ],
      result = union([[...slideRings.map((r) => r.points), hole]]);
    expect(result).toHaveLength(1);
    expect(result[0].holes).toHaveLength(1);
    const before = polygonsArea(result);
    expect(before / ((Math.PI * W * H) / 4 - 200_000 ** 2)).toBeCloseTo(1, 2);

    const free = ringsToFreeformPaths(result);
    expect(free.paths).toHaveLength(1);
    expect(
      free.paths[0].commands.filter((c) => c.type === "close"),
    ).toHaveLength(2);
    expect(
      free.paths[0].commands.every(
        (c) =>
          c.type === "close" ||
          (Number.isInteger(c.x) && Number.isInteger(c.y)),
      ),
    ).toBe(true);

    const target = P.addSlideShape(slide, { preset: "rect", ...free.bounds });
    P.setShapeFreeformPaths(target, free.paths);
    const tb = P.getShapeBoundsResolved(pres, target),
      back = transformRings(
        flattenGeometry(P.getShapeGeometryResolved(pres, target).geometry, tb),
        tb,
      );
    expect(back).toHaveLength(2);
    expect(Math.abs(ringArea(back) - before)).toBeLessThan(10);
  });
});
