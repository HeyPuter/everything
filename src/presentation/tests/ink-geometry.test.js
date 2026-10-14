import { describe, expect, it } from "vitest";
import {
  recognizeStroke,
  matchArrowHead,
  eraseFromStroke,
  followRuler,
  pointInPolygon,
  simplifyIndices,
  smoothCommands,
  sampleCommands,
  densify,
  boxCorners,
} from "../src/draw/ink-geometry.js";

// A deterministic wobble, as a hand would add.
function wobble(points, amount = 0, seed = 1) {
  let s = seed;
  const rand = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647 - 0.5;
  };
  return points.map((p) => ({
    x: p.x + rand() * amount,
    y: p.y + rand() * amount,
  }));
}
// Points along a polyline, `per` to each edge.
function trace(vertices, per = 20, close = true) {
  const pts = [];
  const vs = close ? [...vertices, vertices[0]] : vertices;
  for (let i = 0; i < vs.length - 1; i++)
    for (let s = 0; s < per; s++) {
      const f = s / per;
      pts.push({
        x: vs[i].x + (vs[i + 1].x - vs[i].x) * f,
        y: vs[i].y + (vs[i + 1].y - vs[i].y) * f,
      });
    }
  pts.push(vs.at(-1));
  return pts;
}
function regular(n, cx, cy, r, start = -Math.PI / 2, step = 1) {
  return Array.from({ length: n }, (_, i) => {
    const a = start + (i * step * 2 * Math.PI) / n;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}
function ellipse(cx, cy, rx, ry, n = 80, overshoot = 0.05) {
  return Array.from({ length: n + Math.round(n * overshoot) }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });
}

describe("recognizeStroke", () => {
  it("reads a straight stroke as a line and squares off a near-level one", () => {
    const r = recognizeStroke(
      wobble(
        trace(
          [
            { x: 0, y: 0 },
            { x: 1000, y: 30 },
          ],
          40,
          false,
        ),
        6,
      ),
    );
    expect(r.kind).toBe("line");
    expect(r.to.y).toBeCloseTo(r.from.y, 5);
  });
  it("reads closed strokes as preset shapes", () => {
    const cases = [
      [
        trace([
          { x: 0, y: 0 },
          { x: 1000, y: 0 },
          { x: 1000, y: 600 },
          { x: 0, y: 600 },
        ]),
        "rect",
      ],
      [
        trace([
          { x: 500, y: 0 },
          { x: 1000, y: 400 },
          { x: 500, y: 800 },
          { x: 0, y: 400 },
        ]),
        "diamond",
      ],
      [
        trace([
          { x: 500, y: 0 },
          { x: 1000, y: 800 },
          { x: 0, y: 800 },
        ]),
        "triangle",
      ],
      [
        trace([
          { x: 0, y: 0 },
          { x: 0, y: 800 },
          { x: 900, y: 800 },
        ]),
        "rtTriangle",
      ],
      [ellipse(500, 500, 500, 300), "ellipse"],
      [ellipse(500, 500, 400, 400), "ellipse"],
      [trace(regular(5, 500, 500, 400)), "pentagon"],
      [trace(regular(6, 500, 500, 400, 0)), "hexagon"],
      [trace(regular(5, 500, 500, 400, -Math.PI / 2, 2)), "star5"],
    ];
    for (const [points, preset] of cases) {
      const r = recognizeStroke(wobble(points, 12));
      expect(r?.preset, preset).toBe(preset);
      expect(r.kind).toBe("shape");
    }
  });
  it("keeps the drawn box and evens up a near-circle", () => {
    const r = recognizeStroke(ellipse(500, 500, 400, 380));
    expect(r.w).toBeCloseTo(r.h, 5);
    expect(r.x + r.w / 2).toBeCloseTo(500, -1);
  });
  it("turns a rectangle drawn at an angle", () => {
    const vs = boxCorners({ x: 0, y: 0, w: 1000, h: 500 }, 30);
    const r = recognizeStroke(trace(vs, 25));
    expect(r.preset).toBe("rect");
    expect(r.rot).toBeCloseTo(30, -1);
    expect(r.w).toBeCloseTo(1000, -2);
  });
  it("reads a shaft with a head as an arrow", () => {
    const r = recognizeStroke(
      trace(
        [
          { x: 0, y: 500 },
          { x: 1000, y: 500 },
          { x: 850, y: 400 },
          { x: 850, y: 600 },
          { x: 1000, y: 500 },
        ],
        20,
        false,
      ),
    );
    expect(r).toMatchObject({ kind: "line", arrow: "end" });
    expect(r.to.x).toBeCloseTo(1000, -1);
  });
  it("leaves handwriting and small marks as ink", () => {
    const s = Array.from({ length: 60 }, (_, i) => ({
      x: 300 * Math.sin((i / 60) * 2 * Math.PI) * (i < 30 ? 1 : -1),
      y: i * 10,
    }));
    expect(recognizeStroke(s)).toBeNull();
    expect(recognizeStroke(ellipse(10, 10, 5, 5), { minSize: 100 })).toBeNull();
  });
});

describe("matchArrowHead", () => {
  const line = { from: { x: 0, y: 500 }, to: { x: 1000, y: 500 } };
  it("finds a V drawn at either end, opening back along the line", () => {
    const atEnd = trace(
      [
        { x: 880, y: 400 },
        { x: 1000, y: 500 },
        { x: 880, y: 600 },
      ],
      10,
      false,
    );
    expect(matchArrowHead(atEnd, line)).toBe("end");
    const atStart = trace(
      [
        { x: 120, y: 400 },
        { x: 0, y: 500 },
        { x: 120, y: 600 },
      ],
      10,
      false,
    );
    expect(matchArrowHead(atStart, line)).toBe("start");
  });
  it("ignores a V that points the wrong way or sits mid-line", () => {
    const wrong = trace(
      [
        { x: 1100, y: 400 },
        { x: 1000, y: 500 },
        { x: 1100, y: 600 },
      ],
      10,
      false,
    );
    expect(matchArrowHead(wrong, line)).toBeNull();
    const middle = trace(
      [
        { x: 380, y: 400 },
        { x: 500, y: 500 },
        { x: 380, y: 600 },
      ],
      10,
      false,
    );
    expect(matchArrowHead(middle, line)).toBeNull();
  });
});

describe("erasing and the ruler", () => {
  it("splits a stroke where the eraser crossed it", () => {
    const stroke = densify(
      [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
      ],
      10,
    );
    const runs = eraseFromStroke(
      stroke,
      [
        { x: 500, y: -100 },
        { x: 500, y: 100 },
      ],
      30,
    );
    expect(runs).toHaveLength(2);
    expect(runs[0].at(-1).x).toBeLessThan(470);
    expect(runs[1][0].x).toBeGreaterThan(530);
    expect(eraseFromStroke(stroke, [{ x: 500, y: 500 }], 30)).toBeNull();
  });
  it("lays a stroke begun on a ruler's edge along that edge", () => {
    const ruler = { cx: 500, cy: 500, angle: 0, length: 800, thickness: 100 };
    const out = followRuler(
      [
        { x: 300, y: 455 },
        { x: 600, y: 470 },
        { x: 2000, y: 400 },
      ],
      ruler,
      20,
    );
    expect(out.map((p) => p.y)).toEqual([450, 450, 450]);
    expect(out[2].x).toBe(900);
    expect(followRuler([{ x: 300, y: 300 }], ruler, 20)).toBeNull();
  });
});

describe("helpers", () => {
  it("tests points against a lasso", () => {
    const lasso = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(pointInPolygon({ x: 50, y: 50 }, lasso)).toBe(true);
    expect(pointInPolygon({ x: 150, y: 50 }, lasso)).toBe(false);
  });
  it("samples a smooth path through each kept point in order", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: 200, y: 0 },
    ];
    const keep = simplifyIndices(pts, 1);
    expect(keep).toEqual([0, 1, 2]);
    const samples = sampleCommands(smoothCommands(pts), 4);
    expect(samples[0]).toMatchObject({ x: 0, y: 0, at: 0 });
    expect(samples.at(-1)).toMatchObject({ x: 200, y: 0, at: 2 });
    expect(samples.find((s) => s.at === 1 && s.f === 0)).toMatchObject({
      x: 100,
      y: 50,
    });
  });
});
