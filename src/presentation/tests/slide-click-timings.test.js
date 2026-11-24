// Rehearsed click timings: each click step of a slide may also start by
// itself a time after the step before it ends, kept in the timing tree.
import { describe, expect, it } from "vitest";
import { P, createDeck, shape } from "../src/model.js";
import { createClickTimes } from "../src/show/click-timings.js";
import { setSlideAdvance } from "../src/show/narration.js";

function animated({ autoFirst = false } = {}) {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  const boxes = [1, 4, 7].map((x) => shape(slide, x, 1, 2, 1.5, "#2266cc"));
  P.setSlideAnimations(
    slide,
    boxes.map((box, i) => ({
      shapeId: String(P.getShapeId(box)),
      presetClass: "entr",
      presetId: 10,
      presetSubtype: 0,
      start: i === 0 && autoFirst ? "after" : "click",
      delayMs: 0,
      durationMs: 300,
    })),
  );
  return pres;
}
const roundTrip = async (pres) =>
  P.loadPresentation(await P.savePresentation(pres));

describe("slide click timings", () => {
  it("are kept per click step and survive saving", async () => {
    const pres = animated();
    const slide = P.getSlides(pres)[0];
    expect(P.getSlideClickTimings(slide)).toEqual([null, null, null]);
    expect(P.setSlideClickTimings(slide, [1200, null, 800])).toBe(true);
    expect(P.setSlideClickTimings(slide, [1200, null, 800])).toBe(false);
    const again = P.getSlides(await roundTrip(pres))[0];
    expect(P.getSlideClickTimings(again)).toEqual([1200, null, 800]);
    // The steps still wait for a click too, and the effects are unchanged.
    expect(P.getSlideAnimations(again).map((e) => e.start)).toEqual([
      "click",
      "click",
      "click",
    ]);
    P.setSlideClickTimings(again, []);
    expect(P.getSlideClickTimings(again)).toEqual([null, null, null]);
  });

  it("stay with the steps while the animations are edited", () => {
    const pres = animated();
    const slide = P.getSlides(pres)[0];
    P.setSlideClickTimings(slide, [1200, null, 800]);
    const effects = P.getSlideAnimations(slide);
    P.setSlideAnimations(
      slide,
      effects.map((e) => ({ ...e, durationMs: 500 })),
    );
    expect(P.getSlideClickTimings(slide)).toEqual([1200, null, 800]);
    // With a step fewer, the old times no longer fit.
    P.setSlideAnimations(slide, effects.slice(1));
    expect(P.getSlideClickTimings(slide)).toEqual([null, null]);
  });

  it("are cleared with the slide's timing", () => {
    const pres = animated();
    const slide = P.getSlides(pres)[0];
    setSlideAdvance(P, slide, 5000);
    P.setSlideClickTimings(slide, [1200, 900, 800]);
    setSlideAdvance(P, slide, 4000);
    expect(P.getSlideClickTimings(slide)).toEqual([1200, 900, 800]);
    setSlideAdvance(P, slide, null);
    expect(P.getSlideClickTimings(slide)).toEqual([null, null, null]);
    expect(P.getEffectiveSlideTransition(slide)?.advanceAfterMs).toBe(
      undefined,
    );
  });

  it("leave out a first group that starts with the slide", () => {
    const pres = animated({ autoFirst: true });
    const slide = P.getSlides(pres)[0];
    expect(P.getSlideClickTimings(slide)).toEqual([null, null]);
    P.setSlideClickTimings(slide, [500, 700]);
    expect(P.getSlideClickTimings(slide)).toEqual([500, 700]);
    expect(P.getSlideAnimations(slide)[0].start).toBe("after");
  });
});

describe("timing clicks in a rehearsal", () => {
  it("times each click from the end of the step before it", async () => {
    let now = 0;
    const clicks = createClickTimes(() => now);
    clicks.opened(Promise.resolve());
    await null;
    now = 1000;
    let end;
    clicks.clicked(0, new Promise((r) => (end = r)));
    now = 1300;
    end();
    await null;
    await null;
    now = 2500;
    clicks.clicked(1, Promise.resolve());
    expect(clicks.times).toEqual([1000, 1200]);
    // A click while the step before still plays comes at once.
    clicks.clicked(2, Promise.resolve());
    expect(clicks.times).toEqual([1000, 1200, 0]);
    // Taking a step back forgets its time.
    clicks.back(2);
    expect(clicks.times).toEqual([1000, 1200]);
    clicks.opened(null);
    expect(clicks.times).toEqual([]);
  });
});
