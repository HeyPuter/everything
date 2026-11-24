// A connector glued to shapes keeps its ends on their connection sites when
// the shapes move, turn or resize, and comes unglued when it is dragged
// away on its own or a shape it is glued to goes.
import { describe, it, expect } from "vitest";
import {
  P,
  connectorGlue,
  followConnectors,
  setSlideBounds,
  slideBounds,
} from "../src/model.js";

const I = 914400;

// A rectangle and a circle, the line from the rectangle's right side to
// the circle's left side, glued at both ends.
async function deck() {
  const pres = P.createPresentation();
  const slide = P.addBlankSlide(pres);
  const a = P.addSlideShape(slide, {
    preset: "rect",
    name: "A",
    x: 1 * I,
    y: 1 * I,
    w: 2 * I,
    h: 1 * I,
  });
  const b = P.addSlideShape(slide, {
    preset: "ellipse",
    name: "B",
    x: 7 * I,
    y: 4 * I,
    w: 2 * I,
    h: 2 * I,
  });
  const line = P.addSlideLine(slide, {
    name: "Link",
    from: { x: 3 * I, y: 1.5 * I },
    to: { x: 7 * I, y: 5 * I },
  });
  P.setConnectorConnections(line, {
    start: { id: P.getShapeId(a), site: 3 },
    end: { id: P.getShapeId(b), site: 2 },
  });
  const loaded = await P.loadPresentation(await P.savePresentation(pres));
  return { pres: loaded, slide: P.getSlides(loaded)[0] };
}
const named = (slide, name) =>
  P.getSlideShapes(slide).find((s) => P.getShapeName(s) === name);
// The connector's start and end on the slide.
function ends(slide) {
  const line = named(slide, "Link");
  const b = P.getShapeBounds(line);
  const f = P.getShapeFlip(line) || {};
  const round = (v) => Math.round((v / I) * 100) / 100;
  return {
    start: [
      round(f.horizontal ? b.x + b.w : b.x),
      round(f.vertical ? b.y + b.h : b.y),
    ],
    end: [
      round(f.horizontal ? b.x : b.x + b.w),
      round(f.vertical ? b.y : b.y + b.h),
    ],
  };
}
// One edit, as the editor makes it: glue read before, followed after.
function edit(pres, slide, fn) {
  const glue = connectorGlue(pres, slide);
  fn();
  followConnectors(pres, slide, glue);
}

describe("connection sites", () => {
  it("reads and writes a connector's glue, and evaluates a shape's sites", async () => {
    const { slide } = await deck();
    const line = named(slide, "Link");
    expect(P.getConnectorConnections(line)).toEqual({
      start: { id: P.getShapeId(named(slide, "A")), site: 3 },
      end: { id: P.getShapeId(named(slide, "B")), site: 2 },
    });
    expect(P.getShapeConnectionSites(named(slide, "A"), 2 * I, I)).toEqual([
      { x: I, y: 0 },
      { x: 0, y: I / 2 },
      { x: I, y: I },
      { x: 2 * I, y: I / 2 },
    ]);
    P.setConnectorConnections(line, { end: null });
    expect(P.getConnectorConnections(line).end).toBeNull();
    expect(P.getConnectorConnections(line).start).not.toBeNull();
  });
});

describe("followConnectors", () => {
  it("keeps the ends on the sites of shapes that move, past each other too", async () => {
    const { pres, slide } = await deck();
    edit(pres, slide, () =>
      setSlideBounds(pres, named(slide, "B"), {
        ...slideBounds(pres, named(slide, "B")),
        x: 5 * I,
        y: 1 * I,
      }),
    );
    expect(ends(slide)).toEqual({ start: [3, 1.5], end: [5, 2] });
    // The rectangle moves past the circle: the line turns around.
    edit(pres, slide, () =>
      setSlideBounds(pres, named(slide, "A"), {
        ...slideBounds(pres, named(slide, "A")),
        x: 9 * I,
        y: 4 * I,
      }),
    );
    expect(ends(slide)).toEqual({ start: [11, 4.5], end: [5, 2] });
  });

  it("follows a turned shape's site", async () => {
    const { pres, slide } = await deck();
    edit(pres, slide, () => P.setShapeRotation(named(slide, "B"), 90));
    expect(ends(slide)).toEqual({ start: [3, 1.5], end: [8, 4] });
  });

  it("leaves the glue alone for an edit that moves nothing", async () => {
    const { pres, slide } = await deck();
    const before = P.getShapeXmlString(named(slide, "Link"));
    edit(pres, slide, () => P.renameShape(named(slide, "A"), "Renamed"));
    expect(P.getShapeXmlString(named(slide, "Link"))).toBe(before);
  });

  it("lets go of the ends of a connector dragged away, and of a shape that goes", async () => {
    let { pres, slide } = await deck();
    edit(pres, slide, () => {
      const line = named(slide, "Link");
      setSlideBounds(pres, line, {
        ...slideBounds(pres, line),
        y: 3 * I,
      });
    });
    expect(P.getConnectorConnections(named(slide, "Link"))).toEqual({
      start: null,
      end: null,
    });
    ({ pres, slide } = await deck());
    edit(pres, slide, () => P.removeShape(named(slide, "B")));
    const glue = P.getConnectorConnections(named(slide, "Link"));
    expect(glue.start).not.toBeNull();
    expect(glue.end).toBeNull();
  });
});
