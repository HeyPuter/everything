import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { P, createDeck, copySlideComments, parseDeck } from "../src/model.js";

const box = (slide, x) =>
  P.addSlideShape(slide, {
    preset: "rect",
    x,
    y: 914400,
    w: 914400,
    h: 914400,
  });

// A deck whose first slide holds legacy comments, as older files do.
async function legacyDeck() {
  const pres = createDeck("blank");
  const slide = P.getSlides(pres)[0];
  box(slide, 914400);
  const files = unzipSync(await P.savePresentation(pres));
  const ns =
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  files["ppt/commentAuthors.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:cmAuthorLst ${ns}><p:cmAuthor id="1" name="Ada Ünï" initials="AU" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`,
  );
  files["ppt/comments/comment1.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:cmLst ${ns}><p:cm authorId="1" dt="2026-01-02T03:04:05.000" idx="1"><p:pos x="10" y="10"/><p:text>Legacy 😀 note</p:text></p:cm></p:cmLst>`,
  );
  const types = strFromU8(files["[Content_Types].xml"]).replace(
    "</Types>",
    '<Override PartName="/ppt/commentAuthors.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"/><Override PartName="/ppt/comments/comment1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.comments+xml"/></Types>',
  );
  files["[Content_Types].xml"] = strToU8(types);
  const add = (name, rel) => {
    files[name] = strToU8(
      strFromU8(files[name]).replace(
        "</Relationships>",
        `${rel}</Relationships>`,
      ),
    );
  };
  add(
    "ppt/_rels/presentation.xml.rels",
    '<Relationship Id="rIdAuthors" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/commentAuthors" Target="commentAuthors.xml"/>',
  );
  add(
    "ppt/slides/_rels/slide1.xml.rels",
    '<Relationship Id="rIdCm" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments/comment1.xml"/>',
  );
  return zipSync(files);
}

describe("duplicated slides", () => {
  it("copy modern threads as new ones, anchored to the copied objects", async () => {
    const pres = createDeck("blank");
    const slide = P.getSlides(pres)[0];
    box(slide, 914400);
    const anchor = box(slide, 914400 * 3);
    P.setSlideCommentThreads(slide, [
      {
        author: { name: "Zoë 😀", userId: "zoe" },
        text: "@Zoë 😀 看看 this",
        shapeId: String(P.getShapeId(anchor)),
        status: "resolved",
        replies: [{ author: { name: "Ünï" }, text: "ok 👍" }],
      },
      { author: { name: "Zoë 😀", userId: "zoe" }, text: "On the slide" },
    ]);
    const copy = P.duplicateSlide(pres, slide);
    copySlideComments(slide, copy);
    const [a, b] = [slide, copy].map((s) => P.getSlideCommentThreads(s));
    expect(
      b.map((t) => [t.text, t.status, t.replies.map((r) => r.text)]),
    ).toEqual(a.map((t) => [t.text, t.status, t.replies.map((r) => r.text)]));
    const anchored = P.getSlideShapes(copy).at(-1);
    expect(b[0].shapeId).toBe(String(P.getShapeId(anchored)));
    expect(b[1].shapeId ?? null).toBeNull();
    // New ids, the same authors.
    const ids = [...a, ...b].flatMap((t) => [
      t.id,
      ...t.replies.map((r) => r.id),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(b[0].author.id).toBe(a[0].author.id);
    // The file opens again with one authors part and both slides' threads.
    const bytes = await P.savePresentation(pres);
    const names = Object.keys(unzipSync(bytes));
    expect(names.filter((n) => /authors\.xml$/i.test(n))).toHaveLength(1);
    expect(
      P.validatePresentation(pres).filter((i) => i.severity === "error"),
    ).toEqual([]);
    const back = await parseDeck(bytes);
    expect(
      P.getSlides(back).map((s) => P.getSlideCommentThreads(s).length),
    ).toEqual([2, 2]);
    // The original's comments are its own still.
    P.setSlideCommentThreads(copy, []);
    expect(P.getSlideCommentThreads(slide)).toHaveLength(2);
  });

  it("copy legacy comments as new threads", async () => {
    const bytes = await legacyDeck();
    const pres = await parseDeck(bytes);
    const slide = P.getSlides(pres)[0];
    expect(P.getSlideCommentThreads(slide)[0].legacy).toBe(true);
    const copy = P.duplicateSlide(pres, slide);
    copySlideComments(slide, copy);
    const [thread] = P.getSlideCommentThreads(copy);
    expect(thread).toMatchObject({ text: "Legacy 😀 note", legacy: false });
    expect(thread.author.name).toBe("Ada Ünï");
    expect(P.getSlideCommentThreads(slide)[0].text).toBe("Legacy 😀 note");
    const saved = await P.savePresentation(pres);
    expect(
      P.validatePresentation(pres).filter((i) => i.severity === "error"),
    ).toEqual([]);
    const back = await parseDeck(saved);
    expect(
      P.getSlides(back).map((s) =>
        P.getSlideCommentThreads(s).map((t) => t.text),
      ),
    ).toEqual([["Legacy 😀 note"], ["Legacy 😀 note"]]);
  });
});
