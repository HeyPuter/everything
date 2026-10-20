import { describe, expect, it, beforeEach } from "vitest";
import { P, slideDescription } from "../src/model.js";
import {
  parseOutline,
  outlineMessages,
  buildDeck,
  generateDeck,
  themeDeck,
} from "../src/start/deck-from-prompt.js";

const outline = {
  title: "Ocean Plastics",
  subtitle: "What we can do",
  notes: "Welcome.",
  slides: [
    {
      layout: "content",
      kicker: "01 / THE PROBLEM",
      title: "Plastic everywhere",
      body: "8 million tonnes a year\nMost from land",
      notes: "Start with scale.",
    },
    {
      layout: "columns",
      title: "Three fixes",
      columns: [
        { heading: "Reduce", body: "Less packaging" },
        { heading: "Reuse", body: "Refill" },
        { heading: "Recover", body: "Collect" },
      ],
      notes: "Explain each.",
    },
    { layout: "section", title: "Thank you", body: "Questions?" },
  ],
};

describe("the outline", () => {
  it("is asked for with the slide count and the description", () => {
    const [system, user] = outlineMessages("A talk on bees", { slides: 8 });
    expect(system.role).toBe("system");
    expect(system.content).toMatch(/JSON/);
    expect(user.content).toMatch(/8 content slides/);
    expect(user.content).toMatch(/A talk on bees/);
  });
  it("is read from an answer with fences or chatter around it", () => {
    const parsed = parseOutline(
      "Here you go:\n```json\n" + JSON.stringify(outline) + "\n```",
    );
    expect(parsed.title).toBe("Ocean Plastics");
    expect(parsed.slides).toHaveLength(3);
    expect(parsed.slides[1].columns).toHaveLength(3);
  });
  it("is tidied: unknown layouts become content, columns without any too", () => {
    const parsed = parseOutline(
      JSON.stringify({
        title: "T",
        slides: [
          { layout: "hologram", title: "A" },
          { layout: "columns", title: "B", columns: [] },
          { layout: "content" },
        ],
      }),
    );
    expect(parsed.slides.map((s) => s.layout)).toEqual(["content", "content"]);
  });
  it("throws a plain message when there is no outline", () => {
    expect(() => parseOutline("Sorry, I can't")).toThrow(/did not return/);
    expect(() => parseOutline("{nope}")).toThrow(/could not be read/);
    expect(() => parseOutline("{}")).toThrow(/empty/);
  });
});

describe("the deck", () => {
  it("has a title slide and one slide per outline entry, with notes", async () => {
    const pres = await buildDeck(parseOutline(JSON.stringify(outline)), {
      theme: "cobalt",
    });
    const slides = P.getSlides(pres);
    expect(slides).toHaveLength(4);
    expect(slideDescription(slides[0], pres)).toMatch(/Ocean Plastics/);
    expect(P.getSlideNotes(slides[0])).toBe("Welcome.");
    expect(P.getSlideNotes(slides[1])).toBe("Start with scale.");
    const text = P.getSlideShapes(slides[2])
      .map((s) => (P.hasShapeText(s) ? P.getShapeText(s) : ""))
      .join("|");
    expect(text).toMatch(/Reduce/);
    expect(text).toMatch(/Recover/);
    // It survives a save and a fresh load.
    const again = await P.loadPresentation(await P.savePresentation(pres));
    expect(P.getSlides(again)).toHaveLength(4);
  });
  it("is written from a streamed answer, reporting slides as they come", async () => {
    const text = JSON.stringify(outline);
    const seen = [];
    const chat = async function* (messages, options) {
      expect(options.model).toBe("m");
      for (let i = 0; i < text.length; i += 25)
        yield { type: "text", text: text.slice(i, i + 25) };
    };
    const { pres, name } = await generateDeck("ocean plastics", {
      slides: 3,
      chat,
      model: "m",
      onProgress: ({ slides }) => seen.push(slides),
    });
    expect(name).toBe("Ocean Plastics");
    expect(P.getSlides(pres)).toHaveLength(4);
    expect(seen).toEqual([1, 2, 3]);
  });
  it("stops when asked and refuses an empty description", async () => {
    const controller = new AbortController();
    const chat = async function* () {
      controller.abort();
      yield { type: "text", text: "{" };
    };
    await expect(
      generateDeck("x", { chat, signal: controller.signal }),
    ).rejects.toMatchObject({ stopped: true });
    await expect(generateDeck("  ", { chat })).rejects.toThrow(/Describe/);
  });
  it("starts a theme's deck on a single title slide", () => {
    const pres = themeDeck("midnight");
    expect(P.getSlides(pres)).toHaveLength(1);
    expect(slideDescription(P.getSlides(pres)[0], pres)).toMatch(/title/i);
  });
});

describe("what the library remembers", () => {
  let store;
  beforeEach(() => {
    store = new Map();
    globalThis.localStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  });
  it("keeps pins and last-opened times per account, following renames", async () => {
    const { libraryMeta } = await import("../src/start/library-meta.js");
    const mine = libraryMeta("me");
    const deck = { path: "/me/Decks/A.pptx" };
    expect(mine.isPinned(deck)).toBe(false);
    expect(mine.togglePin(deck)).toBe(true);
    mine.noteOpened(deck, 1000);
    expect(libraryMeta("someone else").isPinned(deck)).toBe(false);
    mine.rename(deck, { path: "/me/Decks/B.pptx" });
    expect(mine.isPinned({ path: "/me/Decks/B.pptx" })).toBe(true);
    expect(mine.openedAt({ path: "/me/Decks/B.pptx" })).toBe(1000);
    expect(mine.openedAt(deck)).toBeNull();
    mine.forget({ path: "/me/Decks/B.pptx" });
    expect(mine.isPinned({ path: "/me/Decks/B.pptx" })).toBe(false);
    expect(mine.togglePin({ id: "draft-1" })).toBe(true);
    expect(mine.togglePin({ id: "draft-1" })).toBe(false);
  });
  it("keeps a recovery draft's pin apart from its file's", async () => {
    const { libraryMeta } = await import("../src/start/library-meta.js");
    const mine = libraryMeta("me");
    const file = { kind: "cloud", path: "/me/Decks/A.pptx" };
    const draft = { kind: "draft", id: "d1", path: "/me/Decks/A.pptx" };
    mine.togglePin(file);
    mine.noteOpened(file, 1000);
    expect(mine.isPinned(draft)).toBe(false);
    expect(mine.openedAt(draft)).toBeNull();
    mine.togglePin(draft);
    mine.forget(file);
    expect(mine.isPinned(file)).toBe(false);
    expect(mine.isPinned(draft)).toBe(true);
  });
  it("reads a draft pinned under its bare id before", async () => {
    store.set(
      "presentation.library.v1",
      JSON.stringify({ me: { pins: ["d2"], opened: { d2: 500 } } }),
    );
    const { libraryMeta } = await import("../src/start/library-meta.js");
    const mine = libraryMeta("me");
    const draft = { kind: "draft", id: "d2", path: null };
    expect(mine.isPinned(draft)).toBe(true);
    expect(mine.openedAt(draft)).toBe(500);
    expect(mine.togglePin(draft)).toBe(false);
    expect(mine.isPinned(draft)).toBe(false);
  });
});
