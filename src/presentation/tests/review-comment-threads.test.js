import { describe, it, expect } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { P, createDeck, addDesignedSlide } from "../src/model.js";

const save = async (pres) => P.savePresentation(pres);
const reload = async (pres) => P.loadPresentation(await save(pres));
const files = async (pres) => unzipSync(await save(pres));

describe("threaded comments", () => {
  it("round-trips threads, replies, anchors, positions and status", async () => {
    const pres = createDeck("blank");
    addDesignedSlide(pres, "title");
    const [first, second] = P.getSlides(pres);
    const shape = P.getSlideShapes(second)[0];
    const shapeId = String(P.getShapeId(shape));
    P.setSlideCommentThreads(first, [
      {
        author: { name: "Ada Lovelace", userId: "ada" },
        created: "2026-03-01T10:00:00.000Z",
        text: "First line\nSecond <line> & more",
        pos: { x: 914400, y: 457200 },
        replies: [
          {
            author: { name: "Grace Hopper" },
            created: "2026-03-02T11:30:00.000Z",
            text: "@Ada Lovelace agreed",
          },
        ],
      },
    ]);
    P.setSlideCommentThreads(second, [
      {
        author: { name: "Grace Hopper" },
        text: "About this object",
        status: "resolved",
        shapeId,
      },
    ]);
    const zip = await files(pres);
    const names = Object.keys(zip);
    expect(names).toContain("ppt/authors.xml");
    const parts = names.filter((n) => /^ppt\/comments\/modernComment_/.test(n));
    expect(parts).toHaveLength(2);
    const types = strFromU8(zip["[Content_Types].xml"]);
    expect(types).toContain("application/vnd.ms-powerpoint.comments+xml");
    expect(types).toContain("application/vnd.ms-powerpoint.authors+xml");
    const presRels = strFromU8(zip["ppt/_rels/presentation.xml.rels"]);
    expect(presRels).toContain(
      "http://schemas.microsoft.com/office/2018/10/relationships/authors",
    );
    const slidePart = P.getSlidePartName(first).slice(1);
    const slideXml = strFromU8(zip[slidePart]);
    expect(slideXml).toContain("p188:commentRel");
    const second2 = strFromU8(
      zip[parts.find((n) => strFromU8(zip[n]).includes("About this object"))],
    );
    expect(second2).toContain("<ac:deMkLst");
    expect(second2).toContain(`<ac:spMk id="${shapeId}"`);
    expect(second2).toContain('status="resolved"');

    const back = await P.loadPresentation(await save(pres));
    const [a, b] = P.getSlides(back);
    const threads = P.getSlideCommentThreads(a);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      text: "First line\nSecond <line> & more",
      status: "active",
      shapeId: null,
      pos: { x: 914400, y: 457200 },
      created: "2026-03-01T10:00:00.000Z",
      legacy: false,
    });
    expect(threads[0].author).toMatchObject({
      name: "Ada Lovelace",
      userId: "ada",
      initials: "AL",
    });
    expect(threads[0].replies).toHaveLength(1);
    expect(threads[0].replies[0]).toMatchObject({
      text: "@Ada Lovelace agreed",
      created: "2026-03-02T11:30:00.000Z",
    });
    expect(threads[0].replies[0].author.name).toBe("Grace Hopper");
    const anchored = P.getSlideCommentThreads(b)[0];
    expect(anchored).toMatchObject({ status: "resolved", shapeId });
    // The same person keeps one author entry.
    expect(P.getCommentPeople(back).map((p) => p.name)).toEqual([
      "Ada Lovelace",
      "Grace Hopper",
    ]);
  });

  it("keeps ids when threads are written again, and removes the part when empty", async () => {
    const pres = createDeck("blank");
    const s = P.getSlides(pres)[0];
    P.setSlideCommentThreads(s, [{ author: { name: "A" }, text: "one" }]);
    const [t] = P.getSlideCommentThreads(s);
    P.setSlideCommentThreads(s, [
      { ...t, replies: [{ author: { name: "B" }, text: "two" }] },
    ]);
    const [again] = P.getSlideCommentThreads(s);
    expect(again.id).toBe(t.id);
    expect(again.author.id).toBe(t.author.id);
    expect(again.replies[0].text).toBe("two");
    P.setSlideCommentThreads(s, []);
    const zip = await files(pres);
    expect(
      Object.keys(zip).filter((n) => n.includes("modernComment")),
    ).toHaveLength(0);
    expect(strFromU8(zip[P.getSlidePartName(s).slice(1)])).not.toContain(
      "commentRel",
    );
    expect(P.hasPresentationComments(await reload(pres))).toBe(false);
  });

  it("reads legacy comments and converts them when the slide is written", async () => {
    const pres = createDeck("blank");
    const s = P.getSlides(pres)[0];
    P.addSlideComment(s, {
      author: { name: "Legacy Reviewer", initials: "LR" },
      text: "old style",
      position: { x: 10, y: 20 },
      date: new Date("2025-01-01T00:00:00Z"),
    });
    const back = await reload(pres);
    const s2 = P.getSlides(back)[0];
    const [legacy] = P.getSlideCommentThreads(s2);
    expect(legacy).toMatchObject({
      text: "old style",
      legacy: true,
      pos: { x: 10, y: 20 },
    });
    expect(legacy.author.name).toBe("Legacy Reviewer");
    P.setSlideCommentThreads(
      s2,
      P.getSlideCommentThreads(s2).map((t) => ({
        ...t,
        replies: [{ author: { name: "New" }, text: "reply" }],
      })),
    );
    const zip = await files(back);
    expect(
      Object.keys(zip).some((n) => /comments\/comment\d+\.xml$/.test(n)),
    ).toBe(false);
    const again = P.getSlideCommentThreads(P.getSlides(await reload(back))[0]);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ text: "old style", legacy: false });
    expect(again[0].author.name).toBe("Legacy Reviewer");
  });

  it("does not copy comments onto a duplicated slide", async () => {
    const pres = createDeck("blank");
    const s = P.getSlides(pres)[0];
    P.setSlideCommentThreads(s, [{ author: { name: "A" }, text: "mine" }]);
    const dup = P.duplicateSlide(pres, s);
    expect(P.getSlideCommentThreads(dup)).toHaveLength(0);
    expect(P.getSlideXmlString(dup)).not.toContain("commentRel");
    expect(P.getSlideCommentThreads(P.getSlides(pres)[0])).toHaveLength(1);
  });

  it("reads modern comments written by other editors", async () => {
    const pres = createDeck("blank");
    const s = P.getSlides(pres)[0];
    P.setSlideCommentThreads(s, [{ author: { name: "X" }, text: "seed" }]);
    const zip = await files(pres);
    const name = Object.keys(zip).find((n) => n.includes("modernComment"));
    const authors = strFromU8(zip["ppt/authors.xml"]);
    const authorId = authors.match(/id="([^"]+)"/)[1];
    // A comment anchored inside a text moniker, dated without a zone.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p188:cmLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p188="http://schemas.microsoft.com/office/powerpoint/2018/8/main"><p188:cm id="{11111111-2222-4333-8444-555555555555}" authorId="${authorId}" created="2024-05-06T07:08:09.100"><ac:txMkLst xmlns:ac="http://schemas.microsoft.com/office/drawing/2013/main/command" xmlns:pc="http://schemas.microsoft.com/office/powerpoint/2013/main/command"><pc:docMk/><pc:sldMk cId="1" sldId="256"/><ac:spMk id="7" creationId="{AAAAAAAA-0000-4000-8000-000000000000}"/><ac:txMk cp="0" len="4"/></ac:txMkLst><p188:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Hi </a:t></a:r><a:r><a:t>there</a:t></a:r></a:p></p188:txBody></p188:cm></p188:cmLst>`;
    const pkgPres = await P.loadPresentation(await save(pres));
    const part = P.getSlides(pkgPres)[0];
    // Swap the part's bytes for the other editor's.
    const { INTERNAL_PACKAGE } =
      await import("../lib/pptx/src/api/_internal-symbols.ts");
    pkgPres[INTERNAL_PACKAGE].getPart("/" + name).data =
      new TextEncoder().encode(xml);
    const [t] = P.getSlideCommentThreads(part);
    expect(t).toMatchObject({
      text: "Hi there",
      shapeId: "7",
      created: "2024-05-06T07:08:09.100Z",
    });
    expect(t.author.name).toBe("X");
  });
});

describe("marked as final", () => {
  it("sets and clears the mark, keeping other custom properties", async () => {
    const pres = createDeck("blank");
    expect(P.isMarkedFinal(pres)).toBe(false);
    P.setCustomProperty(pres, "Project", "Apollo");
    P.setMarkedFinal(pres, true);
    let back = await reload(pres);
    expect(P.isMarkedFinal(back)).toBe(true);
    expect(P.getContentStatus(back)).toBe("Final");
    expect(P.getCustomProperties(back)).toEqual({
      Project: "Apollo",
      _MarkAsFinal: true,
    });
    P.setMarkedFinal(back, false);
    back = await reload(back);
    expect(P.isMarkedFinal(back)).toBe(false);
    expect(P.getContentStatus(back)).toBe(null);
    expect(P.getCustomProperties(back)).toEqual({ Project: "Apollo" });
  });
});
