import { describe, it, expect } from "vitest";
import { autoCorrectAt, DEFAULT_OPTIONS } from "../src/review/autocorrect.js";

// Types `typed` after `before` and applies the correction, as the editor does.
function type(before, typed, options = DEFAULT_OPTIONS) {
  let text = before;
  const marks = [];
  for (const ch of typed) {
    text += ch;
    const fix = autoCorrectAt(text, text.length, options);
    if (fix) {
      text = text.slice(0, fix.start) + fix.replacement + text.slice(fix.end);
      if (fix.list) marks.push(fix.list);
      if (fix.superscript) marks.push(text.slice(...fix.superscript));
    }
  }
  return { text, marks };
}

describe("AutoCorrect", () => {
  it("replaces words from the list, keeping their capitals", () => {
    expect(type("", "teh cat ").text).toBe("The cat ");
    expect(type("so ", "adn then ").text).toBe("so and then ");
    expect(type("x ", "TEH ").text).toBe("x THE ");
    expect(type("and ", "i said").text).toBe("and I said");
  });
  it("turns symbol sequences into characters as they complete", () => {
    expect(type("Acme ", "(c)").text).toBe("Acme ©");
    expect(type("so wait", "...").text).toBe("so wait…");
    expect(type("a ", "-> b").text).toBe("a → b");
    expect(type("a ", "<=> b").text).toBe("a ⇔ b");
  });
  it("capitalizes sentences but not after abbreviations", () => {
    expect(type("", "hello. world ").text).toBe("Hello. World ");
    expect(type("Fruit, e.g. ", "apples ").text).toBe("Fruit, e.g. apples ");
    expect(type("Go! ", "now ").text).toBe("Go! Now ");
    expect(type("see ", "www.example.com ").text).toBe("see www.example.com ");
  });
  it("makes quotes smart", () => {
    expect(type("He said ", '"hi"').text).toBe("He said “hi”");
    expect(type("Don", "'t").text).toBe("Don’t");
    expect(type("", "'yes'").text).toBe("‘yes’");
  });
  it("replaces fractions, dashes and ordinals", () => {
    expect(type("Add ", "1/2 cup").text).toBe("Add ½ cup");
    expect(type("A ", "well--known ").text).toBe("A well—known ");
    expect(type("this ", "-- that ").text).toBe("this – that ");
    const ord = type("the ", "21st time");
    expect(ord.text).toBe("the 21st time");
    expect(ord.marks).toEqual(["st"]);
    expect(type("the ", "11st ").marks).toEqual([]);
  });
  it("starts lists from a typed bullet or number", () => {
    const bullet = type("", "* item");
    expect(bullet.text).toBe("item");
    expect(bullet.marks).toEqual(["bullet"]);
    expect(type("Intro\n", "1. step").marks).toEqual(["number"]);
  });
  it("does nothing with the options off", () => {
    const off = Object.fromEntries(
      Object.keys(DEFAULT_OPTIONS).map((k) => [
        k,
        k === "replacements" ? [] : false,
      ]),
    );
    expect(type("", 'teh "x" 1/2 * ', off).text).toBe('teh "x" 1/2 * ');
    expect(type("", "teh. hello ", off).text).toBe("teh. hello ");
  });
});
