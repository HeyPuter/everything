import { describe, it, expect } from "vitest";
import { P } from "../src/model.js";
import {
  readOutline,
  rowsFromOutline,
  structureFromRows,
  applyOutline,
  splitRow,
  demoteRow,
  promoteRow,
  mergeWithPrevious,
} from "../src/views/outline-model.js";

function deck() {
  const pres = P.createPresentation();
  P.addContentSlide(pres, { title: "First", body: "One\nTwo" });
  P.addContentSlide(pres, { title: "Second", body: "Three" });
  return pres;
}
const roundTrip = async (pres) =>
  P.loadPresentation(await P.savePresentation(pres));

describe("outline model", () => {
  it("reads titles and body paragraphs with levels", () => {
    const pres = deck();
    const rows = rowsFromOutline(readOutline(pres));
    expect(rows.map((r) => [r.level, r.text])).toEqual([
      [0, "First"],
      [1, "One"],
      [1, "Two"],
      [0, "Second"],
      [1, "Three"],
    ]);
    expect(rows[0].part).toBe(P.getSlidePartName(P.getSlides(pres)[0]));
  });

  it("splits, demotes, promotes and merges rows", () => {
    const rows = rowsFromOutline(readOutline(deck()));
    // Enter in a title starts a new slide after the slide's body.
    const split = splitRow(rows, 0, 3);
    expect(split.rows.map((r) => [r.level, r.text])).toEqual([
      [0, "Fir"],
      [1, "One"],
      [1, "Two"],
      [0, "st"],
      [0, "Second"],
      [1, "Three"],
    ]);
    expect(split.focus).toEqual({ row: 3, offset: 0 });
    expect(split.rows[3].part).toBe(null);
    // Enter in a paragraph adds one at its level.
    expect(splitRow(rows, 1, 3).rows[2]).toEqual({ level: 1, text: "" });
    // Tab on a title folds the slide into the one before.
    const demoted = demoteRow(rows, 3);
    expect(demoted.rows.slice(3).map((r) => [r.level, r.text])).toEqual([
      [1, "Second"],
      [2, "Three"],
    ]);
    expect(demoteRow(rows, 0)).toBe(null);
    expect(demoteRow(rows, 1).rows[1].level).toBe(2);
    // Shift+Tab on a first-level paragraph makes it a slide's title.
    const promoted = promoteRow(rows, 2);
    expect(promoted.rows[2]).toEqual({ level: 0, text: "Two", part: null });
    expect(promoteRow(rows, 0)).toBe(null);
    const merged = mergeWithPrevious(rows, 2);
    expect(merged.rows[1].text).toBe("OneTwo");
    expect(merged.focus).toEqual({ row: 1, offset: 3 });
  });

  it("writes edits back to the slides and survives a save", async () => {
    const pres = deck();
    let rows = rowsFromOutline(readOutline(pres));
    rows[0].text = "First, renamed";
    rows[2].text = "Two, edited";
    rows = splitRow(rows, 2, rows[2].text.length).rows;
    rows[3].text = "Added";
    rows = demoteRow(rows, 3).rows;
    rows = splitRow(rows, 4, "Second".length).rows;
    rows.at(-1).text = "Brand new";
    const { changed } = applyOutline(pres, structureFromRows(rows));
    expect(changed).toBe(true);
    const back = await roundTrip(pres);
    expect(
      rowsFromOutline(readOutline(back)).map((r) => [r.level, r.text]),
    ).toEqual([
      [0, "First, renamed"],
      [1, "One"],
      [1, "Two, edited"],
      [2, "Added"],
      [0, "Second"],
      [1, "Three"],
      [0, "Brand new"],
    ]);
    expect(P.getSlides(back)).toHaveLength(3);
    expect(P.getSlideTitle(P.getSlides(back)[2])).toBe("Brand new");
  });

  it("removes a slide whose title is folded into the slide before", () => {
    const pres = deck();
    const rows = demoteRow(rowsFromOutline(readOutline(pres)), 3).rows;
    applyOutline(pres, structureFromRows(rows));
    expect(P.getSlides(pres)).toHaveLength(1);
    expect(P.getSlideBody(P.getSlides(pres)[0])).toBe(
      "One\nTwo\nSecond\nThree",
    );
  });

  it("drops links to a slide it removes", async () => {
    const pres = deck();
    const [first, second] = P.getSlides(pres);
    const button = P.addSlideShape(first, {
      preset: "rect",
      x: 0,
      y: 0,
      w: P.inches(2),
      h: P.inches(1),
      text: "Go",
    });
    P.setShapeClickAction(button, { kind: "slide", slide: second });
    const rows = demoteRow(rowsFromOutline(readOutline(pres)), 3).rows;
    applyOutline(pres, structureFromRows(rows));
    const back = await roundTrip(pres);
    const [only] = P.getSlides(back);
    expect(P.getSlides(back)).toHaveLength(1);
    expect(P.getSlideXmlString(only)).not.toContain("hlinksldjump");
    expect(
      P._internalPackageOf(back)
        .getRels(P.getSlidePartName(only))
        .items.some((r) => r.type.endsWith("/slide")),
    ).toBe(false);
  });

  it("adds a title placeholder to a slide that had none", async () => {
    const pres = P.createPresentation();
    P.addBlankSlide(pres);
    const rows = rowsFromOutline(readOutline(pres));
    expect(rows).toEqual([
      { level: 0, text: "", part: P.getSlidePartName(P.getSlides(pres)[0]) },
    ]);
    rows[0].text = "Named at last";
    applyOutline(pres, structureFromRows(rows));
    const back = await roundTrip(pres);
    const slide = P.getSlides(back)[0];
    expect(P.getSlideTitle(slide)).toBe("Named at last");
    const title = P.getSlideOutlineShapes(slide).title;
    expect(P.getShapeBounds(title)?.w).toBeGreaterThan(0);
  });

  it("leaves an unchanged outline alone", () => {
    const pres = deck();
    const before = P.getSlides(pres).map(P.getSlideXmlString);
    const result = applyOutline(
      pres,
      structureFromRows(rowsFromOutline(readOutline(pres))),
    );
    expect(result.changed).toBe(false);
    expect(P.getSlides(pres).map(P.getSlideXmlString)).toEqual(before);
  });
});
