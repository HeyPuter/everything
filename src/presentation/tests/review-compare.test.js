import { describe, it, expect } from "vitest";
import { P, createDeck, addDesignedSlide } from "../src/model.js";
import {
  alignLists,
  lcsPairs,
  diffDecks,
  acceptChange,
} from "../src/review/compare.js";

const copy = async (pres) => P.loadPresentation(await P.savePresentation(pres));
const firstText = (slide) =>
  P.getSlideShapes(slide).find((s) => (P.getShapeText(s) || "").trim());

describe("compare matching", () => {
  it("pairs the longest common run of keys", () => {
    expect(lcsPairs(["a", "b", "c", "d"], ["a", "c", "x", "d"])).toEqual([
      [0, 0],
      [2, 1],
      [3, 3],
    ]);
  });
  it("fills gaps with later keys", () => {
    const a = [
      { k: 1, t: "x" },
      { k: 2, t: "y" },
      { k: 3, t: "z" },
    ];
    const b = [
      { k: 1, t: "x" },
      { k: 9, t: "y2" },
      { k: 3, t: "z" },
    ];
    // The middle pair only matches by its second key.
    const pairs = alignLists(
      a.map((x, i) => ({ ...x, n: i === 1 ? "m" : null })),
      b.map((x, i) => ({ ...x, n: i === 1 ? "m" : null })),
      [(x) => x.k, (x) => x.n],
    );
    expect(pairs).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });
});

describe("compare and accept", () => {
  it("lists every kind of change and accepting them all makes the decks match", async () => {
    const mine = createDeck("pitch");
    addDesignedSlide(mine, "title", "studio", { title: "Extra", body: "x" });
    const theirs = await copy(mine);
    const [t0, t1] = P.getSlides(theirs);
    // Text change on slide 1, moved object on slide 2, new notes on slide 2.
    const shape = firstText(t0);
    P.setShapeText(shape, "Changed title");
    const moved = P.getSlideShapes(t1).at(-1);
    const b = P.getShapeBounds(moved);
    P.setShapeBounds(moved, { ...b, x: b.x + 914400 });
    P.setSlideNotes(t1, "Speak slowly");
    // A slide removed and one added.
    P.removeSlide(theirs, P.getSlides(theirs)[2]);
    addDesignedSlide(theirs, "title", "studio", {
      title: "Brand new",
      body: "y",
    });

    const items = diffDecks(mine, theirs);
    const types = items.map((i) => i.type).sort();
    expect(types).toContain("textChanged");
    expect(types).toContain("objectChanged");
    expect(types).toContain("notesChanged");
    expect(types).toContain("slideDeleted");
    expect(types).toContain("slideInserted");
    const text = items.find((i) => i.type === "textChanged");
    expect(text.after).toBe("Changed title");

    // Accept one at a time, recomputing as the app does.
    for (let guard = 0; guard < 20; guard++) {
      const next = diffDecks(mine, theirs)[0];
      if (!next) break;
      expect(acceptChange(mine, theirs, next)).toBe(true);
    }
    expect(diffDecks(mine, theirs)).toEqual([]);
    const titles = P.getSlides(mine).map((s) => P.getSlideTitle(s));
    expect(titles).toEqual(P.getSlides(theirs).map((s) => P.getSlideTitle(s)));
    expect(P.getSlideNotes(P.getSlides(mine)[1])).toBe("Speak slowly");
    // The result still saves and loads.
    const again = await copy(mine);
    expect(P.getSlides(again)).toHaveLength(P.getSlides(theirs).length);
  });

  it("reports nothing for identical decks and removes objects on accept", async () => {
    const mine = createDeck("pitch");
    const theirs = await copy(mine);
    expect(diffDecks(mine, theirs)).toEqual([]);
    const gone = P.getSlideShapes(P.getSlides(theirs)[0]).at(-1);
    P.removeShape(gone);
    const [item] = diffDecks(mine, theirs);
    expect(item.type).toBe("objectDeleted");
    expect(acceptChange(mine, theirs, item)).toBe(true);
    expect(diffDecks(mine, theirs)).toEqual([]);
  });
});
