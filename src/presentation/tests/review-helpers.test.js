import { describe, it, expect } from "vitest";
import { P, createDeck } from "../src/model.js";
import {
  mentionQuery,
  filterMentions,
  mentionCandidates,
  splitMentions,
  mentionedNames,
  relativeTime,
  currentReviewer,
  samePerson,
  initialsOf,
} from "../src/review/people.js";
import { checkableWords, orderSuggestions } from "../src/review/speller.js";
import {
  contrastRatio,
  visualOrder,
  findAccessibilityIssues,
} from "../src/review/accessibility.js";
import { normalizeThesaurus } from "../src/review/thesaurus.js";
import { offlineLookup } from "../src/review/thesaurus-data.js";
import { parseJsonReply } from "../src/review/ai.js";

describe("people and mentions", () => {
  it("finds the mention being typed", () => {
    expect(mentionQuery("Hi @Ad", 6)).toEqual({ start: 3, query: "Ad" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("mail me@example", 15)).toBe(null);
    expect(mentionQuery("Hi @Ada\nnext", 12)).toBe(null);
  });
  it("lists people once and filters them by any word of the name", () => {
    const list = mentionCandidates(
      [{ name: "Grace Hopper" }, { name: "Ada Lovelace" }, { name: "Ada Lovelace" }],
      { name: "Zed", initials: "Z" },
    );
    expect(list.map((p) => p.name)).toEqual(["Ada Lovelace", "Grace Hopper", "Zed"]);
    expect(filterMentions(list, "hop").map((p) => p.name)).toEqual(["Grace Hopper"]);
    expect(filterMentions(list, "")).toHaveLength(3);
  });
  it("splits text into mentions of known names, longest first", () => {
    const names = ["Ada", "Ada Lovelace"];
    expect(splitMentions("Ask @Ada Lovelace and @Bob", names)).toEqual([
      { text: "Ask " },
      { text: "@Ada Lovelace", mention: "Ada Lovelace" },
      { text: " and @Bob" },
    ]);
    expect(mentionedNames("@Ada, @Ada Lovelace", names)).toEqual([
      "Ada",
      "Ada Lovelace",
    ]);
  });
  it("knows the reviewer from the account", () => {
    expect(currentReviewer({ username: "ada" })).toMatchObject({
      name: "ada",
      userId: "ada",
      signedIn: true,
    });
    expect(samePerson({ userId: "a", name: "X" }, { userId: "a", name: "Y" })).toBe(true);
    expect(samePerson({ name: "X" }, { name: "Y" })).toBe(false);
    expect(initialsOf("grace brewster hopper")).toBe("GB");
  });
  it("says how long ago, in any time zone", () => {
    const now = Date.parse("2026-05-10T12:00:00Z");
    expect(relativeTime("2026-05-10T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-05-10T11:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-05-10T07:00:00Z", now)).toBe("5 h ago");
    expect(relativeTime("2026-05-01T12:00:00Z", now)).toMatch(/May|5/);
    expect(relativeTime(null, now)).toBe("");
  });
});

describe("spelling helpers", () => {
  it("skips numbers, acronyms and addresses", () => {
    const words = checkableWords(
      "Teh NASA team's 3rd plan at www.example.com and a@b.co isn’t rdy",
    ).map((w) => w.word);
    expect(words).toEqual(["Teh", "team", "plan", "at", "and", "isn't", "rdy"]);
  });
  it("orders suggestions by closeness and keeps capitals", () => {
    expect(orderSuggestions("Teh", ["ten", "the", "tea"])[0]).toBe("The");
    expect(orderSuggestions("BRWN", ["brown", "brawn"])).toEqual(["BROWN", "BRAWN"]);
  });
});

describe("accessibility checks", () => {
  it("measures contrast as WCAG does", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#888888")).toBeLessThan(1.5);
    expect(contrastRatio("nope", "#fff")).toBe(null);
  });
  it("reads boxes in rows, left to right", () => {
    const order = visualOrder(
      [
        { id: 1, x: 500, y: 10 },
        { id: 2, x: 10, y: 15 },
        { id: 3, x: 10, y: 400 },
      ],
      50,
    );
    expect(order.map((b) => b.id)).toEqual([2, 1, 3]);
  });
  it("finds missing titles, low contrast, alt text and reading order", () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    const low = P.addSlideTextBox(slide, {
      x: 914400,
      y: 2743200,
      w: 3657600,
      h: 457200,
      text: "Faint",
    });
    P.addSlideTextBox(slide, {
      x: 914400,
      y: 914400,
      w: 3657600,
      h: 457200,
      text: "Top",
    });
    const env = {
      isTable: () => false,
      slideBounds: (s) => P.getShapeBounds(s),
      size: () => P.getPresentationSlideSize?.(pres) || { cx: 12192000, cy: 6858000 },
      textColors: (s) =>
        P.getShapeId(s) === P.getShapeId(low)
          ? { text: "#EEEEEE", background: "#FFFFFF", size: 12, bold: false }
          : null,
    };
    const kinds = findAccessibilityIssues(pres, env).map((i) => i.kind);
    expect(kinds).toContain("missingTitle");
    expect(kinds).toContain("contrast");
    expect(kinds).toContain("readingOrder");
    // Errors first.
    expect(findAccessibilityIssues(pres, env)[0].severity).toBe("error");
    // A titled, decorated slide comes clean of those.
    P.addSlideTitlePlaceholder(slide, "Overview", { hidden: true });
    expect(
      findAccessibilityIssues(pres, env).map((i) => i.kind),
    ).not.toContain("missingTitle");
  });
  it("finds duplicate titles and treats decorative objects as described", () => {
    const pres = createDeck("blank");
    const [a] = P.getSlides(pres);
    P.addSlideTitlePlaceholder(a, "Same", {});
    const b = P.duplicateSlide(pres, a);
    const env = {
      isTable: () => false,
      slideBounds: (s) => P.getShapeBounds(s),
      size: () => ({ cx: 12192000, cy: 6858000 }),
      textColors: () => null,
    };
    const dup = findAccessibilityIssues(pres, env).filter(
      (i) => i.kind === "duplicateTitle",
    );
    expect(dup.map((i) => i.index)).toEqual([0, 1]);
    const box = P.getSlideShapes(b)[0];
    P.setShapeDecorative(box, true);
    expect(P.isShapeDecorative(P.getSlideShapes(b)[0])).toBe(true);
    P.setShapeDecorative(P.getSlideShapes(b)[0], false);
    expect(P.isShapeDecorative(P.getSlideShapes(b)[0])).toBe(false);
  });
});

describe("thesaurus and AI replies", () => {
  it("reads lenient JSON", () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Sure! {"a":[1,2]} Hope that helps')).toEqual({ a: [1, 2] });
    expect(() => parseJsonReply("no json")).toThrow();
  });
  it("cleans a thesaurus answer", () => {
    const out = normalizeThesaurus(
      {
        word: "big",
        meanings: [
          { sense: " size ", synonyms: ["large", "large", " huge ", 3], antonyms: ["small"] },
          { sense: "empty", synonyms: [], antonyms: [] },
        ],
      },
      "big",
    );
    expect(out).toEqual({
      word: "big",
      meanings: [{ sense: "size", synonyms: ["large", "huge"], antonyms: ["small"] }],
    });
  });
  it("has an offline list", () => {
    expect(offlineLookup("Big").meanings[0].synonyms).toContain("large");
    expect(offlineLookup("zzz")).toBe(null);
  });
});

describe("slide titles from existing text", () => {
  it("picks the largest text and makes it the title placeholder", async () => {
    const { titleCandidate } = await import("../src/review/accessibility.js");
    const pres = createDeck("pitch");
    const slide = P.getSlides(pres)[0];
    expect(P.getSlideTitle(slide)).toBe(null);
    const pick = titleCandidate(pres, slide);
    expect(P.getShapeText(pick)).toMatch(/Small idea/);
    P.setShapeAsTitlePlaceholder(pick);
    const back = await P.loadPresentation(await P.savePresentation(pres));
    expect(P.getSlideTitle(P.getSlides(back)[0])).toMatch(/Small idea/);
  });
});
