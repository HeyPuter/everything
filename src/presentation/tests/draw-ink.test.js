import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { P, createDeck } from "../src/model.js";
import {
  addInkStroke,
  addRecognizedShape,
  addArrowhead,
  isInk,
  inkShapes,
  strokePoints,
  strokeSamples,
  strokeStyle,
  setStrokeGeometry,
} from "../src/draw/ink-model.js";
import {
  loadPens,
  savePens,
  addPen,
  removePen,
  movePen,
  penLabel,
  normalizePen,
  MAX_PENS,
  DEFAULT_PENS,
} from "../src/draw/pens.js";
import {
  cleanRecognized,
  replyText,
  readInk,
  fittingFontSize,
  inkBounds,
} from "../src/draw/ink-ai.js";
import { replayTimeline, drawnBy } from "../src/draw/ink-replay.js";
import { addShowInk } from "../src/draw/show-ink.js";
import { MM } from "../src/draw/ink-model.js";

const red = { type: "pen", color: "#E81224", width: 1, texture: "solid" };
const line = (n = 20) =>
  Array.from({ length: n }, (_, i) => ({
    x: 1000000 + i * 100000,
    y: 2000000 + Math.sin(i / 3) * 300000,
  }));
async function roundTrip(pres) {
  const bytes = await P.savePresentation(pres);
  return { bytes, pres: await P.loadPresentation(bytes) };
}

describe("ink strokes", () => {
  it("keep their timing through a save and a fresh load", async () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const pts = line();
    const times = pts.map((_, i) => i * 16);
    addInkStroke(P, slide, pts, red, {
      tolerance: 1000,
      times,
      start: 1760000000000,
    });
    const { bytes, pres: again } = await roundTrip(pres);
    const xml = strFromU8(unzipSync(bytes)["ppt/slides/slide1.xml"]);
    expect(xml).toContain("inkTiming");
    expect(xml).toContain('start="1760000000000"');
    const [ink] = inkShapes(P, P.getSlides(again)[0]);
    expect(isInk(P, ink)).toBe(true);
    const timing = P.getShapeInkTiming(ink);
    expect(timing.start).toBe(1760000000000);
    // One time for each point the path keeps, in order.
    expect(timing.times).toHaveLength(strokePoints(P, ink).length);
    expect(timing.times[0]).toBe(0);
    expect(timing.times.at(-1)).toBe(times.at(-1));
    P.setShapeInkTiming(ink, null);
    expect(P.getShapeInkTiming(ink)).toBeNull();
  });
  it("draws a pencil's graphite as two passes and a dotted pen dashed", async () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const pencil = addInkStroke(P, slide, line(), {
      type: "pencil",
      color: "#595959",
      width: 2,
      texture: "graphite",
    });
    expect(P.getShapeCustomGeometry(pencil).paths).toHaveLength(2);
    expect(strokeStyle(P, pencil).opacity).toBeCloseTo(0.62, 2);
    const dotted = addInkStroke(P, slide, line(), {
      ...red,
      texture: "dotted",
    });
    expect(P.getShapeStrokeDash(dotted)).toBe("sysDot");
    const hl = addInkStroke(P, slide, line(), {
      type: "highlighter",
      color: "#FFFF00",
      width: 6,
      texture: "solid",
    });
    expect(strokeStyle(P, hl)).toMatchObject({
      color: "#FFFF00",
      opacity: 0.5,
    });
  });
  it("redraws a stroke through new points and samples its curve", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const ink = addInkStroke(P, slide, line(), red);
    setStrokeGeometry(P, ink, [
      { x: 0, y: 0 },
      { x: 500000, y: 500000 },
    ]);
    expect(P.getShapeBounds(ink)).toMatchObject({ x: 0, y: 0, w: 500000 });
    const samples = strokeSamples(P, ink, 4);
    expect(samples[0]).toMatchObject({ x: 0, y: 0 });
    expect(samples.at(-1).x).toBeCloseTo(500000, -1);
  });
  it("keeps a pencil's grain when a stroke is redrawn", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const pencil = {
      type: "pencil",
      color: "#595959",
      width: 2,
      texture: "graphite",
    };
    const ink = addInkStroke(P, slide, line(), pencil);
    const before = P.getShapeCustomGeometry(ink).paths;
    // What the point eraser leaves of it: the first half.
    setStrokeGeometry(P, ink, line().slice(0, 10));
    const after = P.getShapeCustomGeometry(ink).paths;
    expect(after).toHaveLength(2);
    expect(after[1].commands).not.toEqual(after[0].commands);
    // The same pencil drawn through those points looks the same.
    const fresh = addInkStroke(P, slide, line().slice(0, 10), pencil);
    expect(after).toEqual(P.getShapeCustomGeometry(fresh).paths);
    expect(P.getShapeBounds(ink)).toEqual(P.getShapeBounds(fresh));
    expect(before).toHaveLength(2);
    // A pen keeps its one pass.
    const pen = addInkStroke(P, slide, line(), red);
    setStrokeGeometry(P, pen, line().slice(0, 10));
    expect(P.getShapeCustomGeometry(pen).paths).toHaveLength(1);
  });
  it("lie where a turned or flipped stroke is drawn", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    // Left to right along y = 2 000 000, from x = 1 000 000 to 3 000 000.
    const flat = Array.from({ length: 21 }, (_, i) => ({
      x: 1000000 + i * 100000,
      y: 2000000 + (i % 2) * 1000,
    }));
    const ink = addInkStroke(P, slide, flat, red);
    const b = P.getShapeBounds(ink);
    const cx = b.x + b.w / 2,
      cy = b.y + b.h / 2;
    P.setShapeRotation(ink, 90);
    // Turned a quarter clockwise about its centre: top to bottom.
    for (const pts of [strokePoints(P, ink), strokeSamples(P, ink, 4)]) {
      for (const p of pts) expect(Math.abs(p.x - cx)).toBeLessThan(2000);
      expect(pts[0].y).toBeCloseTo(cy - b.w / 2, -3);
      expect(pts.at(-1).y).toBeCloseTo(cy + b.w / 2, -3);
    }
    const box = inkBounds(P, [ink]);
    expect(box.h).toBeGreaterThan(b.w);
    expect(box.w).toBeLessThan(b.w / 10);
    P.setShapeRotation(ink, 0);
    P.setShapeFlip(ink, { horizontal: true, vertical: false });
    // Flipped: right to left.
    expect(strokePoints(P, ink)[0].x).toBeCloseTo(3000000, -3);
    // A stroke redrawn through slide points is neither turned nor flipped,
    // so it lies on them.
    P.setShapeRotation(ink, 45);
    setStrokeGeometry(P, ink, [
      { x: 0, y: 0 },
      { x: 500000, y: 500000 },
    ]);
    expect(P.getShapeRotation(ink)).toBe(0);
    expect(P.getShapeFlip(ink)?.horizontal).toBeFalsy();
    expect(strokePoints(P, ink)[0]).toMatchObject({ x: 0, y: 0 });
  });
});

describe("recognised shapes", () => {
  it("become preset shapes and lines in the pen's colour", async () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const tri = addRecognizedShape(
      P,
      slide,
      {
        kind: "shape",
        preset: "triangle",
        x: 100,
        y: 100,
        w: 1000000,
        h: 800000,
        adj: 30000,
        flipV: true,
      },
      red,
      { triangle: "Triangle" },
    );
    expect(P.getShapeName(tri)).toMatch(/^Triangle /);
    expect(P.getShapeAdjustValues(tri)).toMatchObject({ adj: 30000 });
    const rot = addRecognizedShape(
      P,
      slide,
      {
        kind: "shape",
        preset: "rect",
        x: 0,
        y: 0,
        w: 900000,
        h: 400000,
        rot: 30,
      },
      red,
    );
    expect(P.getShapeRotation(rot)).toBe(30);
    const ln = addRecognizedShape(
      P,
      slide,
      { kind: "line", from: { x: 0, y: 0 }, to: { x: 1000000, y: 0 } },
      red,
    );
    addArrowhead(P, ln, "end");
    expect(P.getShapeName(ln)).toMatch(/^Arrow /);
    const { pres: again } = await roundTrip(pres);
    const shapes = P.getSlideShapes(P.getSlides(again)[0]);
    expect(shapes).toHaveLength(3);
    expect(P.getShapeStrokeArrow(shapes[2], "tail")?.type).toBe("triangle");
    expect(isInk(P, shapes[0])).toBe(false);
  });
});

describe("the pen collection", () => {
  const memory = () => {
    const m = new Map();
    return {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  };
  it("starts with the defaults and keeps changes, order and removals", () => {
    const store = memory();
    const pens = loadPens(store);
    expect(pens.map((p) => p.id)).toEqual(DEFAULT_PENS.map((p) => p.id));
    const made = addPen(pens, "pencil", { color: "#00B050" });
    expect(made).toMatchObject({ type: "pencil", texture: "graphite" });
    expect(movePen(pens, made.id, -1)).toBe(true);
    expect(removePen(pens, "pen1")).toBe(true);
    savePens(pens, store);
    const back = loadPens(store);
    expect(back.map((p) => p.id)).toEqual([
      "pen2",
      "pen3",
      made.id,
      "highlighter",
    ]);
    expect(penLabel(back[2])).toBe("Pencil: Green, 1 mm");
  });
  it("refuses more than the limit, an empty set, and bad values", () => {
    const pens = loadPens(memory());
    while (addPen(pens, "pen"));
    expect(pens).toHaveLength(MAX_PENS);
    const one = [normalizePen({ id: "x" })];
    expect(removePen(one, "x")).toBe(false);
    expect(
      normalizePen({
        type: "brush",
        color: "red",
        width: -1,
        texture: "glitter",
      }),
    ).toMatchObject({
      type: "pen",
      color: "#000000",
      width: 1,
      texture: "solid",
    });
    const store = memory();
    store.setItem("presentation.drawPens.v1", "{not json");
    expect(loadPens(store)).toHaveLength(DEFAULT_PENS.length);
  });
});

describe("reading ink with the AI", () => {
  it("cleans the answer down to the text or LaTeX", () => {
    expect(cleanRecognized("```\nHello\nworld\n```")).toBe("Hello\nworld");
    expect(cleanRecognized('"Hi there"')).toBe("Hi there");
    expect(cleanRecognized("Transcription: Hi")).toBe("Hi");
    expect(cleanRecognized("$$x^2 + 1$$", "math")).toBe("x^2 + 1");
    expect(cleanRecognized("\\[\\frac{a}{b}\\]", "math")).toBe("\\frac{a}{b}");
    expect(replyText({ message: { content: [{ text: "a" }, "b"] } })).toBe(
      "ab",
    );
  });
  it("sends the picture with the prompt and model", async () => {
    const calls = [];
    const chat = async (...args) => {
      calls.push(args);
      return { message: { content: "  E = mc^2 " } };
    };
    const out = await readInk("data:image/png;base64,AAAA", "math", {
      chat,
      model: "m",
    });
    expect(out).toBe("E = mc^2");
    expect(calls[0][0]).toMatch(/LaTeX/);
    expect(calls[0][1]).toBe("data:image/png;base64,AAAA");
    expect(calls[0][3]).toEqual({ model: "m" });
    await expect(
      readInk("x", "text", {
        chat: async () => ({ success: false, error: { message: "nope" } }),
      }),
    ).rejects.toThrow("nope");
  });
  it("sizes text to the writing and measures the ink", () => {
    expect(fittingFontSize(12700 * 50)).toBe(40);
    expect(fittingFontSize(12700 * 50, 2)).toBe(20);
    expect(fittingFontSize(1)).toBe(10);
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    addInkStroke(P, slide, line(), red);
    const box = inkBounds(P, inkShapes(P, slide));
    expect(box.x).toBeLessThan(1000000);
    expect(inkBounds(P, [])).toBeNull();
  });
});

describe("ink replay", () => {
  const pts = (n) =>
    Array.from({ length: n }, (_, i) => ({ x: i * 10, y: 0, at: i, f: 0 }));
  it("orders strokes by when they were drawn and keeps their pace", () => {
    const { strokes, total } = replayTimeline([
      { samples: pts(3), timing: { start: 5000, times: [0, 100, 300] } },
      { samples: pts(2), timing: { start: 1000, times: [0, 50] } },
    ]);
    expect(strokes.map((s) => s.timing.start)).toEqual([1000, 5000]);
    expect(strokes[0].times).toEqual([0, 50]);
    // The four-second pause is cut short.
    expect(strokes[1].begin).toBe(50 + 450);
    expect(strokes[1].times).toEqual([500, 600, 800]);
    expect(total).toBe(800);
  });
  it("draws untimed strokes at an even speed, and part of a stroke by a time", () => {
    const { strokes } = replayTimeline([{ samples: pts(3), timing: null }], {
      speed: 0.1,
    });
    expect(strokes[0].times).toEqual([0, 100, 200]);
    expect(drawnBy(strokes[0], 150)).toEqual([
      { x: 0, y: 0, at: 0, f: 0 },
      { x: 10, y: 0, at: 1, f: 0 },
      { x: 15, y: 0 },
    ]);
    expect(drawnBy(strokes[0], -1)).toEqual([]);
  });
});

describe("ink kept from a slide show", () => {
  it("lands on the slide it was drawn on, with its timing", async () => {
    const pres = createDeck("story");
    const second = P.getSlides(pres)[1];
    const part = P.getSlidePartName(second);
    const before = P.getSlideShapes(second).length;
    const added = addShowInk(
      P,
      pres,
      new Map([
        [
          part,
          [
            {
              color: "#0063B1",
              width: 0.004,
              start: 1760000000000,
              points: [
                { x: 0.1, y: 0.1, t: 0 },
                { x: 0.3, y: 0.2, t: 40 },
                { x: 0.5, y: 0.4, t: 90 },
              ],
            },
          ],
        ],
        [
          "/ppt/slides/missing.xml",
          [{ color: "#000000", width: 0.004, start: 0, points: [] }],
        ],
      ]),
      addInkStroke,
      MM,
    );
    expect(added).toBe(1);
    const shapes = P.getSlideShapes(second);
    expect(shapes).toHaveLength(before + 1);
    const ink = shapes.at(-1);
    expect(isInk(P, ink)).toBe(true);
    expect(strokeStyle(P, ink).color).toBe("#0063B1");
    expect(P.getShapeInkTiming(ink).start).toBe(1760000000000);
    const b = P.getShapeBounds(ink);
    const size = P.getSlideSize(pres);
    expect(b.x).toBeCloseTo(size.width * 0.1, -4);
  });
});
