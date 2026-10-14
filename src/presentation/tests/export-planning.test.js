import { describe, expect, it } from "vitest";
import {
  planPicture,
  collectPictures,
} from "../src/export/compress-pictures.js";
import {
  ease,
  showTimeline,
  transitionDuration,
} from "../src/export/transition-frames.js";
import { P, createDeck } from "../src/model.js";

const INCH = 914400;
const use = (w, h, crop = null, kind = "picture") => ({
  kind,
  w: w * INCH,
  h: h * INCH,
  crop,
});

describe("compress pictures planning", () => {
  it("scales a picture down to what its largest use needs", () => {
    const plan = planPicture(
      { uses: [use(2, 1.5), use(1, 0.75)] },
      { width: 1600, height: 1200 },
      { ppi: 96 },
    );
    expect(plan).toMatchObject({ width: 192, height: 144, trims: false });
  });
  it("never enlarges, and leaves a small enough picture alone", () => {
    expect(
      planPicture(
        { uses: [use(4, 3)] },
        { width: 200, height: 150 },
        { ppi: 220 },
      ),
    ).toBeNull();
  });
  it("deletes cropped areas when every use crops the same way", () => {
    const crop = { left: 0.25, top: 0, right: 0.25, bottom: 0.5 };
    const plan = planPicture(
      { uses: [use(1, 1, crop)] },
      { width: 1000, height: 1000 },
      { ppi: null, deleteCropped: true },
    );
    expect(plan).toMatchObject({
      trims: true,
      keep: { x: 250, y: 0, w: 500, h: 500 },
      width: 500,
      height: 500,
    });
  });
  it("keeps cropped areas a different use or a fill still shows", () => {
    const crop = { left: 0.5 };
    expect(
      planPicture(
        { uses: [use(1, 1, crop), use(1, 1)] },
        { width: 100, height: 100 },
        { ppi: null, deleteCropped: true },
      ),
    ).toBeNull();
    expect(
      planPicture(
        { uses: [use(1, 1, crop), use(13.3, 7.5, null, "other")] },
        { width: 100, height: 100 },
        { ppi: null, deleteCropped: true },
      ),
    ).toBeNull();
  });
  it("finds each picture's uses with their sizes", () => {
    const deck = createDeck("blank");
    const [s] = P.getSlides(deck);
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const picture = P.addSlideImage(s, png, {
      x: 0,
      y: 0,
      w: 2 * INCH,
      h: INCH,
    });
    const [entry] = collectPictures(P, deck, {
      bounds: (shape) => P.getShapeBounds(shape),
      selection: new Set([`${P.getSlidePartName(s)}#${P.getShapeId(picture)}`]),
    });
    expect(entry.contentType).toBe("image/png");
    expect(entry.selected).toBe(true);
    expect(entry.uses).toEqual([
      expect.objectContaining({ kind: "picture", w: 2 * INCH, h: INCH }),
    ]);
  });
});

describe("show timeline", () => {
  it("eases from 0 to 1", () => {
    expect(ease(0)).toBeCloseTo(0, 3);
    expect(ease(1)).toBeCloseTo(1, 3);
    expect(ease(0.5)).toBeGreaterThan(0.5);
  });
  it("times transitions by duration or speed and slides by timings", () => {
    expect(transitionDuration({ effect: "fade", speed: "slow" })).toBe(1000);
    expect(transitionDuration({ effect: "push", durationMs: 1250 })).toBe(1250);
    expect(transitionDuration({ effect: "none" })).toBe(0);
    const timeline = showTimeline(
      [
        { effect: "fade", advanceAfterMs: 3000 },
        { effect: "fade", speed: "med" },
        null,
      ],
      { secondsPerSlide: 2 },
    );
    expect(timeline).toEqual([
      { start: 0, transition: 0, hold: 3000 },
      { start: 3000, transition: 750, hold: 2000 },
      { start: 5750, transition: 0, hold: 2000 },
    ]);
    expect(
      showTimeline([{ effect: "cut", advanceAfterMs: 3000 }], {
        secondsPerSlide: 2,
        useTimings: false,
      })[0].hold,
    ).toBe(2000);
  });
});
