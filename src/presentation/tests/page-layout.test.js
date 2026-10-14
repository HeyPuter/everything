import { describe, expect, it } from "vitest";
import {
  handoutGrid,
  layoutPages,
  pageSize,
  parseSlideRange,
  wrapText,
} from "../src/export/page-layout.js";

const WIDE = { slideWidth: 12192000, slideHeight: 6858000 };
const deck = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({
    number: i + 1,
    title: `Slide ${i + 1}`,
    notes: "",
    outline: [],
    ...extra,
  }));
const slidesOn = (page) => page.items.filter((i) => i.kind === "slide");
const inside = (page, item) =>
  item.x >= -0.01 &&
  item.y >= -0.01 &&
  item.x + item.w <= page.width + 0.01 &&
  item.y + item.h <= page.height + 0.01;

describe("page sizes", () => {
  it("prints full-page slides at the slide's own size by default", () => {
    expect(pageSize({ ...WIDE, layout: "slides" })).toEqual({
      width: 960,
      height: 540,
    });
  });
  it("turns paper for the orientation asked for", () => {
    expect(
      pageSize({ ...WIDE, paper: "letter", orientation: "landscape" }),
    ).toEqual({ width: 792, height: 612 });
    expect(pageSize({ ...WIDE, paper: "a4", layout: "notes" }).height).toBe(
      841.89,
    );
  });
});

describe("layouts", () => {
  it("puts one slide on each full page, scaled to fit paper", () => {
    const pages = layoutPages(deck(3), {
      ...WIDE,
      layout: "slides",
      paper: "letter",
      orientation: "landscape",
      scaleToFit: true,
      frame: true,
    });
    expect(pages).toHaveLength(3);
    const [s] = slidesOn(pages[0]);
    expect(s.frame).toBe(true);
    expect(inside(pages[0], s)).toBe(true);
    expect(s.w / s.h).toBeCloseTo(16 / 9, 3);
    expect(s.w).toBeCloseTo(792 - 36, 0);
  });

  it.each([1, 2, 3, 4, 6, 9])(
    "lays out %i slides a handout page in reading order",
    (n) => {
      const pages = layoutPages(deck(10), {
        ...WIDE,
        layout: "handouts",
        perPage: n,
        paper: "letter",
      });
      expect(pages).toHaveLength(Math.ceil(10 / n));
      const first = slidesOn(pages[0]);
      expect(first).toHaveLength(Math.min(n, 10));
      for (const s of first) expect(inside(pages[0], s)).toBe(true);
      // Horizontal order: the second slide is to the right of the first
      // when the grid has more than one column, else below it.
      if (n > 1) {
        const [a, b] = first;
        const [cols] = handoutGrid(n, "portrait");
        if (cols > 1) expect(b.x).toBeGreaterThan(a.x);
        else expect(b.y).toBeGreaterThan(a.y);
      }
      // No two slides overlap.
      for (const a of first)
        for (const b of first)
          if (a !== b)
            expect(
              a.x + a.w <= b.x + 0.01 ||
                b.x + b.w <= a.x + 0.01 ||
                a.y + a.h <= b.y + 0.01 ||
                b.y + b.h <= a.y + 0.01,
            ).toBe(true);
      const lines = pages[0].items.filter((i) => i.kind === "line");
      expect(lines.length > 0).toBe(n === 3);
    },
  );

  it("orders handouts down each column when asked", () => {
    const [page] = layoutPages(deck(6), {
      ...WIDE,
      layout: "handouts",
      perPage: 6,
      order: "vertical",
      paper: "letter",
    });
    const [a, b] = slidesOn(page);
    expect(b.x).toBeCloseTo(a.x, 3);
    expect(b.y).toBeGreaterThan(a.y);
  });

  it("adds header, footer, date and page numbers to handout pages", () => {
    const pages = layoutPages(deck(7), {
      ...WIDE,
      layout: "handouts",
      perPage: 6,
      paper: "letter",
      headerFooter: {
        header: "Team review",
        footer: "Confidential",
        date: "Oct 13, 2026",
        pageNumbers: true,
      },
    });
    const texts = pages[1].items
      .filter((i) => i.kind === "text")
      .map((i) => i.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        "Team review",
        "Confidential",
        "Oct 13, 2026",
        "2",
      ]),
    );
  });

  it("gives each slide a notes page, continuing long notes onto more pages", () => {
    const notes = Array.from({ length: 120 }, (_, i) => `Note line ${i}`).join(
      "\n",
    );
    const pages = layoutPages(
      [
        { number: 1, title: "A", notes: "Short" },
        { number: 2, title: "B", notes },
      ],
      { ...WIDE, layout: "notes", paper: "letter" },
    );
    expect(pages.length).toBeGreaterThan(2);
    expect(slidesOn(pages[0])).toHaveLength(1);
    expect(slidesOn(pages[1])[0].slide).toBe(1);
    expect(slidesOn(pages[2])).toHaveLength(0);
    for (const page of pages)
      for (const item of page.items)
        if (item.kind === "text")
          expect(item.y).toBeLessThanOrEqual(page.height);
  });

  it("writes an outline with numbered titles and indented paragraphs", () => {
    const pages = layoutPages(
      [
        {
          number: 1,
          title: "Plan",
          outline: [
            { text: "Goals", level: 0 },
            { text: "Detail", level: 1 },
          ],
        },
      ],
      { ...WIDE, layout: "outline", paper: "letter" },
    );
    const texts = pages[0].items.filter((i) => i.kind === "text");
    const title = texts.find((t) => t.text === "Plan");
    const goals = texts.find((t) => t.text === "Goals");
    const detail = texts.find((t) => t.text === "Detail");
    expect(title.bold).toBe(true);
    expect(texts.find((t) => t.text === "1").y).toBe(title.y);
    expect(goals.x).toBeGreaterThan(title.x);
    expect(detail.x).toBeGreaterThan(goals.x);
    expect(detail.y).toBeGreaterThan(goals.y);
  });
});

describe("text and ranges", () => {
  const measure = (t) => t.length;
  it("wraps words and breaks words longer than a line", () => {
    expect(wrapText("one two three", 7, measure)).toEqual(["one two", "three"]);
    expect(wrapText("abcdefghij", 4, measure)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("a\n\nb", 4, measure)).toEqual(["a", "", "b"]);
  });
  it("reads slide ranges", () => {
    expect(parseSlideRange("1-3, 5, 8-", 9)).toEqual([0, 1, 2, 4, 7, 8]);
    expect(parseSlideRange("2", 1)).toEqual([]);
    expect(parseSlideRange("x", 4)).toBeNull();
    expect(parseSlideRange("3-1", 4)).toBeNull();
  });
});
