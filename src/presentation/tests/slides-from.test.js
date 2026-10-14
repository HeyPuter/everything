// Slides from an outline (.txt, .md, .rtf) and slides reused from another
// presentation, with or without their own formatting.
import { describe, expect, it } from "vitest";
import { P, createDeck, text } from "../src/model.js";
import {
  insertOutline,
  parseOutline,
  reuseSlides,
  rtfToText,
} from "../src/layouts/slides-from.js";
import { outlineToRtf } from "../src/export/outline-writer.js";
import { readOutline } from "../src/views/outline-model.js";

describe("outlines", () => {
  it("reads plain text: top-level lines are titles, indents bullets", () => {
    expect(
      parseOutline(
        "Plan\n\tGoals\n\t\tShip it\nResults\n  - Up\n    - More\n\n",
        "txt",
      ),
    ).toEqual([
      {
        title: "Plan",
        body: [
          { text: "Goals", level: 0 },
          { text: "Ship it", level: 1 },
        ],
      },
      {
        title: "Results",
        body: [
          { text: "Up", level: 0 },
          { text: "More", level: 1 },
        ],
      },
    ]);
  });
  it("reads Markdown headings, lists and paragraphs", () => {
    const md =
      "# The **plan**\n\nSome `context`\n\n- One\n  - Two\n1. Three\n\n```\n# not a title\n```\n## [Next](http://x)\n* Last";
    expect(parseOutline(md, "md")).toEqual([
      {
        title: "The plan",
        body: [
          { text: "Some context", level: 0 },
          { text: "One", level: 0 },
          { text: "Two", level: 1 },
          { text: "Three", level: 0 },
        ],
      },
      { title: "Next", body: [{ text: "Last", level: 0 }] },
    ]);
  });
  it("reads RTF indents, including the outline this app exports", () => {
    const rtf = outlineToRtf([
      {
        number: 1,
        title: "Café",
        outline: [
          { text: "First", level: 0 },
          { text: "Deeper", level: 1 },
        ],
      },
      { number: 2, title: "Two", outline: [] },
    ]);
    expect(rtfToText(rtf).split("\n")).toEqual([
      "Café",
      "\tFirst",
      "\t\tDeeper",
      "Two",
    ]);
    expect(parseOutline(rtf, "rtf")).toEqual([
      {
        title: "Café",
        body: [
          { text: "First", level: 0 },
          { text: "Deeper", level: 1 },
        ],
      },
      { title: "Two", body: [] },
    ]);
  });
  it("adds titled slides with bulleted bodies after a slide", () => {
    const pres = createDeck("blank");
    const first = P.getSlides(pres)[0];
    P.addBlankSlide(pres);
    const added = insertOutline(
      pres,
      parseOutline("Alpha\n\tA1\n\t\tA2\nBeta", "txt"),
      first,
    );
    expect(added).toHaveLength(2);
    const slides = P.getSlides(pres);
    expect(slides).toHaveLength(4);
    expect(P.getSlidePartName(slides[1])).toBe(added[0]);
    const outline = readOutline(pres);
    expect(outline[1].title).toBe("Alpha");
    expect(outline[1].body).toEqual([
      { text: "A1", level: 1 },
      { text: "A2", level: 2 },
    ]);
    expect(outline[2].title).toBe("Beta");
  });
});

describe("reusing slides", () => {
  const source = () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    text(slide, "From elsewhere", 1, 1, 6, 1);
    P.addBlankSlide(pres);
    return pres;
  };
  it("inserts chosen slides after the current one with this deck's layouts", () => {
    const pres = createDeck("blank");
    const from = source();
    const before = P.getSlideLayouts(pres).length;
    const added = reuseSlides(pres, [P.getSlides(from)[0]], {
      after: P.getSlides(pres)[0],
    });
    expect(added).toHaveLength(1);
    const slides = P.getSlides(pres);
    expect(slides).toHaveLength(2);
    expect(P.getSlideText(slides[1])).toContain("From elsewhere");
    expect(P.getSlideLayouts(pres).length).toBe(before);
  });
  it("brings layouts and masters along when keeping source formatting", async () => {
    const pres = createDeck("blank");
    const from = source();
    const masters = P.getSlideMasterCount(pres);
    reuseSlides(pres, P.getSlides(from), {
      keepSource: true,
      sourcePres: from,
    });
    expect(P.getSlides(pres)).toHaveLength(3);
    expect(P.getSlideMasterCount(pres)).toBeGreaterThan(masters);
    const saved = await P.loadPresentation(await P.savePresentation(pres));
    expect(P.validatePresentation(saved)).toEqual([]);
    expect(P.getSlideText(P.getSlides(saved)[1])).toContain("From elsewhere");
  });
});
