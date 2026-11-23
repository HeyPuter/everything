import { describe, expect, it } from "vitest";
import {
  addBlankSlide,
  createPresentation,
  editSlideNotes,
  getSlideNotes,
  loadPresentation,
  savePresentation,
  getSlides,
  setSlideNotes,
} from "../index.ts";
import type { SlideData } from "../index.ts";
import { INTERNAL_PACKAGE } from "../_internal-symbols.ts";
import { decode, encode } from "./_helpers.ts";

const notesPart = (slide: SlideData) =>
  slide[INTERNAL_PACKAGE].parts.find((p) =>
    /notesSlide\d+\.xml$/.test(p.name),
  )!;
const body = (slide: SlideData) =>
  decode(notesPart(slide).data).match(/<p:txBody>[\s\S]*?<\/p:txBody>/)![0];
// "Say " plain and "thanks" bold, then a bulleted, italic second line.
const richNotes = () => {
  const pres = createPresentation();
  const slide = addBlankSlide(pres);
  setSlideNotes(slide, "placeholder");
  const part = notesPart(slide);
  part.data = encode(
    decode(part.data).replace(
      /(<p:txBody>[\s\S]*?<a:lstStyle\/>)[\s\S]*?(<\/p:txBody>)/,
      "$1" +
        '<a:p><a:r><a:rPr lang="en-US"/><a:t>Say </a:t></a:r>' +
        '<a:r><a:rPr lang="en-US" b="1"/><a:t>thanks</a:t></a:r></a:p>' +
        '<a:p><a:pPr lvl="1"><a:buChar char="•"/></a:pPr>' +
        '<a:r><a:rPr lang="en-US" i="1"/><a:t>then pause</a:t></a:r></a:p>' +
        "$2",
    ),
  );
  return { pres, slide };
};

describe("editSlideNotes", () => {
  it("changes only the edited text, keeping the notes' formatting", async () => {
    const { pres, slide } = richNotes();
    expect(getSlideNotes(slide)).toBe("Say thanks\nthen pause");
    editSlideNotes(
      slide,
      [{ start: 21, end: 21, text: "!" }],
      "Say thanks\nthen pause!",
    );
    const expected =
      '<a:p><a:r><a:rPr lang="en-US"/><a:t>Say </a:t></a:r>' +
      '<a:r><a:rPr lang="en-US" b="1"/><a:t>thanks</a:t></a:r></a:p>' +
      '<a:p><a:pPr lvl="1"><a:buChar char="•"/></a:pPr>' +
      '<a:r><a:rPr lang="en-US" i="1"/><a:t>then pause</a:t></a:r>' +
      '<a:r><a:rPr lang="en-US" i="1"/><a:t>!</a:t></a:r></a:p>';
    expect(body(slide)).toContain(expected);
    const back = getSlides(
      await loadPresentation(await savePresentation(pres)),
    );
    expect(getSlideNotes(back[0]!)).toBe("Say thanks\nthen pause!");
    expect(body(back[0]!)).toContain(expected);
  });

  it("throws and leaves the notes alone when the edits do not end at the text", () => {
    const { slide } = richNotes();
    const before = body(slide);
    expect(() =>
      editSlideNotes(slide, [{ start: 0, end: 0, text: "x" }], "nope"),
    ).toThrow();
    expect(body(slide)).toBe(before);
  });

  it("throws for a slide without notes", () => {
    const slide = addBlankSlide(createPresentation());
    expect(() =>
      editSlideNotes(slide, [{ start: 0, end: 0, text: "x" }], "x"),
    ).toThrow();
    expect(getSlideNotes(slide)).toBe(null);
  });
});
