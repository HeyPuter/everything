import { expect, it, vi } from "vitest";
import { P, createDeck, parseDeck } from "../src/model.js";
import { renderSlideToSvg } from "../lib/pptx-preview/src/index.ts";
import {
  hyphenLineBreakCases,
  hyphenLineBreakFixture,
} from "./hyphen-line-break-fixture.js";

const signature = (pres, slide) => ({
  texts: P.getSlideShapes(slide).map(P.getShapeText),
  svg: renderSlideToSvg(pres, slide, { textLayout: "svg" }),
});

it("keeps every authored delimiter, joiner and nonbreaking space through save/reload", async () => {
  const source = await hyphenLineBreakFixture(),
    slide = P.getSlides(source)[0];
  expect(P.getSlideShapes(slide).map(P.getShapeText)).toEqual(
    hyphenLineBreakCases.map((c) => c.text),
  );
  // The archive stamps each entry with the time of saving; both saves get
  // the same clock so the bytes can be compared whole.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 0, 2, 3, 4, 6) });
  let before, again;
  try {
    before = await P.savePresentation(source);
    again = await P.savePresentation(source);
  } finally {
    vi.useRealTimers();
  }
  const expected = signature(source, slide);
  expect(again).toEqual(before);
  const loaded = await parseDeck(before);
  expect(signature(loaded, P.getSlides(loaded)[0])).toEqual(expected);
});

it("retains source line-break semantics through forward and return slide imports", async () => {
  const source = await hyphenLineBreakFixture(),
    original = P.getSlides(source)[0],
    target = createDeck("blank");
  const copied = P.importSlide(target, original, P.getSlideLayouts(target)[0], {
    preserveTextFormatting: true,
  });
  const restored = await parseDeck(await P.savePresentation(target));
  const imported = P.getSlides(restored).at(-1);
  expect(signature(restored, imported)).toEqual(signature(source, original));
  const returning = createDeck("blank");
  const returned = P.importSlide(
    returning,
    imported,
    P.getSlideLayouts(returning)[0],
    { preserveTextFormatting: true },
  );
  expect(signature(returning, returned)).toEqual(signature(source, original));
  expect(P.getSlideShapes(copied)).toHaveLength(hyphenLineBreakCases.length);
});
