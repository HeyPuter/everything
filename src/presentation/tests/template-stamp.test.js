import { describe, it, expect } from "vitest";
import { P, createDeck, templateStamp } from "../src/model.js";

describe("template stamps", () => {
  it("read the same after the deck is loaded afresh, as undo does", async () => {
    const pres = createDeck("story");
    const before = P.getSlides(pres).map((s) => templateStamp(pres, s));
    const again = await P.loadPresentation(await P.savePresentation(pres));
    expect(P.getSlides(again).map((s) => templateStamp(again, s))).toEqual(
      before,
    );
    expect(before[0]).not.toBe("");
  });
  it("differ when the master's theme differs", () => {
    const studio = createDeck("story", "studio");
    const midnight = createDeck("story", "midnight");
    expect(templateStamp(midnight, P.getSlides(midnight)[0])).not.toBe(
      templateStamp(studio, P.getSlides(studio)[0]),
    );
  });
});
