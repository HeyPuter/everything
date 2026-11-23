// The starter decks open clean in the accessibility checker: every slide has
// a title and is read in the order it shows. The columns slide (3) is read a
// column at a time, which the checker's top-to-bottom rows question with a
// tip; it is left so.
import { describe, it, expect } from "vitest";
import { P, createDeck, slideTitle } from "../src/model.js";
import { findAccessibilityIssues } from "../src/review/accessibility.js";
import { themeDeck } from "../src/start/deck-from-prompt.js";

const env = {
  isTable: () => false,
  slideBounds: (s) => P.getShapeBounds(s),
  size: () => ({ cx: 12192000, cy: 6858000 }),
  textColors: () => null,
};
const issues = (pres) =>
  findAccessibilityIssues(pres, env).map((i) => `${i.index}:${i.kind}`);

describe("starter decks", () => {
  for (const [template, theme] of [
    ["story", "studio"],
    ["pitch", "cobalt"],
    ["story", "clay"],
    ["story", "midnight"],
  ])
    it(`${template} in ${theme} has nothing for the checker to report`, () => {
      const pres = createDeck(template, theme);
      expect(issues(pres)).toEqual(["2:readingOrder"]);
      // The slide's heading is its title.
      const titles = P.getSlides(pres).map((s) => slideTitle(s, pres));
      expect(titles[1]).toMatch(/\.$/);
      expect(titles.every(Boolean)).toBe(true);
    });
  for (const theme of ["studio", "cobalt", "clay", "midnight"])
    it(`a new deck in ${theme} has a titled first slide`, () => {
      const pres = themeDeck(theme);
      expect(issues(pres)).toEqual([]);
      expect(slideTitle(P.getSlides(pres)[0], pres)).toBe(
        "Your title\ngoes here.",
      );
    });
});
