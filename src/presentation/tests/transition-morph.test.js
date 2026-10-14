// Morph pairing, legacy effect recognition and playback choices that do not
// need a browser.
import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
import { describeShape, pairShapes } from "../src/transitions/morph.js";
import {
  identifyTransition,
  transitionFor,
  withDefaults,
} from "../src/transitions/catalog.js";
import { resolveRandom } from "../src/transitions/player.js";

const item = (name, kind, extra = {}) => ({
  name,
  kind,
  text: "",
  preset: null,
  image: null,
  box: { x: 0, y: 0, w: 0.1, h: 0.1 },
  rotation: 0,
  ...extra,
});

describe("morph pairing", () => {
  it("pairs by name, then text, then geometry nearest first", () => {
    const a = [
      item("Title", "shape", { text: "Hello" }),
      item("Ball", "shape", { preset: "ellipse" }),
      item("Other", "shape", { text: "Same words" }),
      item("Gone", "shape", { preset: "star5" }),
      item("Far", "shape", {
        preset: "rect",
        box: { x: 0.9, y: 0.9, w: 0.1, h: 0.1 },
      }),
      item("Near", "shape", {
        preset: "rect",
        box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
      }),
    ];
    const b = [
      item("Ball", "shape", { preset: "ellipse" }),
      item("Renamed", "shape", { text: "Same words" }),
      item("Title", "shape", { text: "Hello, world" }),
      item("Box", "shape", {
        preset: "rect",
        box: { x: 0.12, y: 0.1, w: 0.1, h: 0.1 },
      }),
      item("New", "picture", { image: "/ppt/media/image1.png" }),
    ];
    const { pairs, gone, added } = pairShapes(a, b);
    expect(pairs.map(([x, y]) => [x.name, y.name])).toEqual([
      ["Ball", "Ball"],
      ["Other", "Renamed"],
      ["Title", "Title"],
      ["Near", "Box"],
    ]);
    expect(gone.map((x) => x.name)).toEqual(["Gone", "Far"]);
    expect(added.map((x) => x.name)).toEqual(["New"]);
  });
  it("pairs names marked with !! only with the same name", () => {
    const a = [
      item("!!logo", "picture", { image: "a" }),
      item("pic", "picture", { image: "a" }),
    ];
    const b = [
      item("pic2", "picture", { image: "a" }),
      item("!!logo", "picture", { image: "b" }),
    ];
    const { pairs } = pairShapes(a, b);
    expect(pairs.map(([x, y]) => [x.name, y.name])).toEqual([
      ["pic", "pic2"],
      ["!!logo", "!!logo"],
    ]);
  });
  it("does not pair different kinds", () => {
    const { pairs } = pairShapes(
      [item("A", "shape", { preset: "rect" })],
      [item("A", "picture", { image: "x" })],
    );
    expect(pairs).toEqual([]);
  });
  it("describes shapes in fractions of the slide with rotation in radians", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const size = P.getSlideSize(pres);
    const shape = P.addSlideShape(slide, {
      preset: "rect",
      x: size.width / 4,
      y: size.height / 2,
      w: size.width / 10,
      h: size.height / 5,
      name: "Box",
      text: "Label",
    });
    P.setShapeRotation(shape, 90);
    const d = describeShape(P, pres, shape, size);
    expect(d).toMatchObject({
      name: "Box",
      kind: "shape",
      text: "Label",
      preset: "rect",
    });
    expect(d.box.x).toBeCloseTo(0.25);
    expect(d.box.y).toBeCloseTo(0.5);
    expect(d.box.w).toBeCloseTo(0.1);
    expect(d.box.h).toBeCloseTo(0.2);
    expect(d.rotation).toBeCloseTo(Math.PI / 2);
  });
});

describe("recognizing transitions from other files", () => {
  it.each([
    [{ effect: "push" }, "push", "l"],
    [{ effect: "wheel" }, "clock", null],
    [{ effect: "wheel", spokes: 1 }, "clock", "cw"],
    [{ effect: "zoom" }, "shape", "out"],
    [{ effect: "strips" }, "wipe", "lu"],
    [{ effect: "split" }, "split", "horz-out"],
    [{ effect: "prism" }, "cube", "l"],
    [{ effect: "pageCurlSingle", invertX: true }, "pageCurl", "single-r"],
    [{ effect: "newsflash" }, "zoom", "rotate"],
    [{ effect: "glitter" }, "glitter", "diamond-l"],
  ])("%o is %s / %s", (t, id, option) => {
    expect(identifyTransition(t)).toEqual({ id, option });
  });
  it("calls an unknown effect other", () => {
    expect(identifyTransition({ effect: "sparkle" }).id).toBe("other");
    expect(identifyTransition(null).id).toBe("none");
  });
});

describe("choosing transitions", () => {
  it("gives a first transition its effect's duration", () => {
    expect(transitionFor("vortex", null, null)).toEqual({
      effect: "vortex",
      direction: "r",
      durationMs: 3000,
      speed: "slow",
    });
  });
  it("keeps timing and sound when the effect changes", () => {
    const sound = { kind: "start", relId: "rId9", name: "Chime.wav" };
    expect(
      transitionFor("cube", "u", {
        effect: "fade",
        thruBlack: true,
        durationMs: 1750,
        speed: "fast",
        advanceAfterMs: 4000,
        sound,
      }),
    ).toEqual({
      effect: "prism",
      direction: "u",
      durationMs: 1750,
      speed: "fast",
      advanceAfterMs: 4000,
      sound,
    });
  });
  it("writes an option's own effect without the entry's other attributes", () => {
    expect(transitionFor("clock", "wedge", null)).toMatchObject({
      effect: "wedge",
    });
    expect(transitionFor("clock", "wedge", null).spokes).toBeUndefined();
    expect(transitionFor("zoom", "rotate", null).direction).toBeUndefined();
  });
  it("keeps None's timing", () => {
    expect(
      transitionFor("none", null, {
        effect: "fade",
        speed: "slow",
        advanceAfterMs: 1000,
      }),
    ).toEqual({ effect: "none", speed: "slow", advanceAfterMs: 1000 });
  });
  it("resolves Random to a concrete effect each show", () => {
    const t = resolveRandom({ effect: "random", durationMs: 1200 }, () => 0.5);
    expect(t.effect).not.toBe("random");
    expect(t.durationMs).toBe(1200);
    expect(identifyTransition(t).id).not.toBe("other");
    expect(withDefaults(resolveRandom({ effect: "fade" }))).toMatchObject({
      effect: "fade",
      thruBlack: false,
    });
  });
});
