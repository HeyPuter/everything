// Morph by words and characters: tokens and their matching (layout is
// measured in the browser; see e2e/morph-words.spec.js).
import { describe, expect, it } from "vitest";
import { matchTokens, textTokens } from "../src/transitions/morph.js";

const token = (text, x, owner = "s") => ({
  text,
  owner,
  box: { x, y: 0, w: 0.05, h: 0.05 },
});

describe("morph by words and characters", () => {
  it("splits a line into words or characters without spaces", () => {
    expect(textTokens("Hello  big world", "byWord")).toEqual([
      { text: "Hello", start: 0, end: 5 },
      { text: "big", start: 7, end: 10 },
      { text: "world", start: 11, end: 16 },
    ]);
    expect(textTokens("a b😀", "byChar")).toEqual([
      { text: "a", start: 0, end: 1 },
      { text: "b", start: 2, end: 3 },
      { text: "😀", start: 3, end: 5 },
    ]);
  });

  it("matches the same text, nearest first, and lists the rest", () => {
    const before = [
      token("Hello", 0.1),
      token("world", 0.3),
      token("old", 0.5),
    ];
    const after = [token("world", 0.1), token("Hello", 0.4), token("new", 0.6)];
    const { pairs, gone, added } = matchTokens(before, after);
    expect(pairs.map(([a, b]) => [a.text, a.box.x, b.box.x])).toEqual([
      ["world", 0.3, 0.1],
      ["Hello", 0.1, 0.4],
    ]);
    expect(gone.map((t) => t.text)).toEqual(["old"]);
    expect(added.map((t) => t.text)).toEqual(["new"]);
  });

  it("prefers a token from the paired shape over a nearer one", () => {
    const near = token("a", 0.11, "other");
    const far = token("a", 0.9, "mine");
    const b = token("a", 0.1, "target");
    const { pairs } = matchTokens(
      [near, far],
      [b],
      (x, y) => x.owner === "mine" && y.owner === "target",
    );
    expect(pairs[0][0]).toBe(far);
  });
});
