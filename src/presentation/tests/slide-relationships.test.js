import { describe, expect, it } from "vitest";
import { unzipSync, strToU8, strFromU8 } from "fflate";
import { P, createDeck, parseDeck, preview } from "../src/model.js";
import { createSlideRelationshipDeck } from "./slide-relationship-fixture.js";
import { resolveTarget } from "../lib/pptx/src/internal/opc/index.ts";
const names = (p) => P.getSlides(p).map(P.getSlidePartName);
const saved = async (p) => unzipSync(await P.savePresentation(p));
const shapeText = (p) =>
  P.getSlides(p).map((s) => P.getShapeText(P.getSlideShapes(s)[0]));

describe("presentation slide relationship targets", () => {
  it("removes unused aliases to a deleted part without confusing them with slide order", async () => {
    const p = await parseDeck(await createSlideRelationshipDeck());
    const slide = P.getSlides(p)[0],
      pkg = P._internalPackageOf(p);
    const rels = pkg.getRels("/ppt/presentation.xml");
    const rel = rels.items.find((r) => r.type.endsWith("/slide"));
    rels.items.unshift({
      ...rel,
      id: "unused-alias",
      target: "slides/slide1.xml",
    });
    pkg.setRels("/ppt/presentation.xml", rels);
    P.moveSlide(p, slide, 2);
    expect(shapeText(p)).toEqual(["Page B", "Page C", "Page A"]);
    P.removeSlide(p, slide);
    expect(
      pkg
        .getRels("/ppt/presentation.xml")
        .items.some((r) => [rel.id, "unused-alias"].includes(r.id)),
    ).toBe(false);
    expect(shapeText(await parseDeck(await P.savePresentation(p)))).toEqual([
      "Page B",
      "Page C",
    ]);
  });
  it.each(["relative", "absolute", "dot", "parent", "case"])(
    "loads and edits %s targets without losing slide identity or rewriting targets",
    async (targets) => {
      const bytes = await createSlideRelationshipDeck({ targets });
      const p = await parseDeck(bytes),
        original = names(p),
        [a, b, c] = P.getSlides(p);
      const before = await saved(p);
      preview(p, a);
      expect(await saved(p)).toEqual(before);
      P.moveSlide(p, a, 2);
      expect(names(p)).toEqual([original[1], original[2], original[0]]);
      P.swapSlides(p, 0, 2);
      expect(names(p)).toEqual([original[0], original[2], original[1]]);
      P.reverseSlides(p);
      expect(names(p)).toEqual([original[1], original[2], original[0]]);
      P.sortSlides(p, (a, b) =>
        P.getSlidePartName(a).localeCompare(P.getSlidePartName(b)),
      );
      expect(names(p)).toEqual(original);
      const reordered = await saved(p);
      for (const key of Object.keys(before))
        if (key !== "ppt/presentation.xml")
          expect(reordered[key]).toEqual(before[key]);
      const duplicate = P.duplicateSlideAt(p, 1, c);
      expect(shapeText(p)).toEqual(["Page A", "Page C", "Page B", "Page C"]);
      P.removeSlide(p, b);
      expect(shapeText(p)).toEqual(["Page A", "Page C", "Page C"]);
      const reloaded = await parseDeck(await P.savePresentation(p));
      expect(shapeText(reloaded)).toEqual(shapeText(p));
      expect(P.getSlideNumber(reloaded, P.getSlides(reloaded)[2])).toBe(9);
      expect(P.getSlidePartName(duplicate)).not.toBe(original[2]);
    },
  );
  it("keeps nested encoded part names and rebases duplicate dependencies", async () => {
    const p = await parseDeck(
      await createSlideRelationshipDeck({ relocated: true }),
    );
    const a = P.getSlides(p)[0],
      pkg = P._internalPackageOf(p),
      oldName = P.getSlidePartName(a);
    const rels = pkg.getRels(oldName);
    rels.items.push({
      id: "external",
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
      target: "https://example.com/reference",
      targetMode: "External",
    });
    pkg.setRels(oldName, rels);
    const copy = P.duplicateSlide(p, a),
      newName = P.getSlidePartName(copy);
    for (const rel of rels.items) {
      const duplicate = pkg.getRels(newName).items.find((r) => r.id === rel.id);
      expect(duplicate.targetMode).toBe(rel.targetMode);
      expect(
        rel.targetMode === "External"
          ? duplicate.target
          : resolveTarget(newName, duplicate.target),
      ).toBe(
        rel.targetMode === "External"
          ? rel.target
          : resolveTarget(oldName, rel.target),
      );
    }
    expect(P.getSlideLayout(copy)).not.toBeNull();
    P.moveSlide(p, a, 3);
    P.removeSlide(p, a);
    expect(pkg.getPart(oldName)).toBeNull();
    expect(P.getSlideLayout(copy)).not.toBeNull();
    const loaded = await parseDeck(await P.savePresentation(p));
    expect(shapeText(loaded)).toEqual(["Page B", "Page C", "Page A"]);
  });
  // Two decks parsed, edited and saved: seconds under load.
  it("rejects foreign and removed handles without changing either package", async () => {
    const p = await parseDeck(await createSlideRelationshipDeck()),
      other = await parseDeck(await createSlideRelationshipDeck());
    const foreign = P.getSlides(other)[0],
      removed = P.getSlides(p)[0];
    P.removeSlide(p, removed);
    const before = await saved(p),
      external = await saved(other);
    for (const slide of [foreign, removed])
      for (const mutate of [
        (s) => P.moveSlide(p, s, 0),
        (s) => P.removeSlide(p, s),
        (s) => P.duplicateSlide(p, s),
      ]) {
        expect(() => mutate(slide)).toThrow();
        expect(await saved(p)).toEqual(before);
        expect(await saved(other)).toEqual(external);
      }
  }, 30_000);
  it.each([
    "missing",
    "external",
    "wrong-type",
    "escape",
    "duplicate-part",
    "duplicate-id",
  ])("rejects %s references before a mutator writes anything", async (kind) => {
    const p = await parseDeck(await createSlideRelationshipDeck()),
      slide = P.getSlides(p)[0],
      pkg = P._internalPackageOf(p),
      rels = pkg.getRels("/ppt/presentation.xml"),
      slides = rels.items.filter((r) => r.type.endsWith("/slide"));
    if (kind === "missing")
      rels.items = rels.items.filter((r) => r !== slides[1]);
    if (kind === "external") slides[1].targetMode = "External";
    if (kind === "wrong-type")
      slides[1].type = "https://example.com/not-a-slide";
    if (kind === "escape") slides[1].target = "../../outside.xml";
    if (kind === "duplicate-part") slides[1].target = slides[0].target;
    if (kind === "duplicate-id") rels.items.push({ ...slides[0] });
    pkg.setRels("/ppt/presentation.xml", rels);
    const before = await saved(p);
    for (const mutate of [
      () => P.moveSlide(p, slide, 1),
      () => P.removeSlide(p, slide),
      () => P.sortSlides(p, () => 0),
      () => P.duplicateSlide(p, slide),
    ]) {
      expect(mutate).toThrow();
      expect(await saved(p)).toEqual(before);
    }
  });
  it("preserves non-slide nodes and does not write when the comparator throws", async () => {
    let p = await parseDeck(await createSlideRelationshipDeck());
    const part = P._internalPackageOf(p).getPart("/ppt/presentation.xml");
    part.data = strToU8(
      strFromU8(part.data)
        .replace("<p:sldIdLst>", "<p:sldIdLst><!--before-->")
        .replace("</p:sldIdLst>", "<!--after--></p:sldIdLst>"),
    );
    p = await parseDeck(await P.savePresentation(p));
    const before = await saved(p);
    expect(() =>
      P.sortSlides(p, () => {
        throw Error("comparison failed");
      }),
    ).toThrow("comparison failed");
    expect(await saved(p)).toEqual(before);
    P.reverseSlides(p);
    const xml = strFromU8((await saved(p))["ppt/presentation.xml"]);
    expect(xml).toContain("<p:sldIdLst><!--before-->");
    expect(xml).toContain("<!--after--></p:sldIdLst>");
    expect(shapeText(p)).toEqual(["Page C", "Page B", "Page A"]);
  });
  it("uses the referenced relationship instead of an unreferenced same-filename decoy", async () => {
    const p = await parseDeck(
        await createSlideRelationshipDeck({ relocated: true }),
      ),
      pkg = P._internalPackageOf(p),
      s = P.getSlides(p)[0],
      rels = pkg.getRels("/ppt/presentation.xml");
    rels.items.unshift({
      id: "unused",
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
      target: "slides/slide1.xml",
      targetMode: "Internal",
    });
    pkg.setRels("/ppt/presentation.xml", rels);
    P.moveSlide(p, s, 2);
    expect(shapeText(p)).toEqual(["Page B", "Page C", "Page A"]);
    P.removeSlide(p, s);
    expect(shapeText(p)).toEqual(["Page B", "Page C"]);
  });
  it("retains slide contents through two import legs after absolute-target operations", async () => {
    const p = await parseDeck(await createSlideRelationshipDeck());
    P.reverseSlides(p);
    const clip = createDeck(),
      c = P.importSlide(clip, P.getSlides(p)[0], P.getSlideLayouts(clip)[0]),
      dest = createDeck(),
      d = P.importSlide(dest, c, P.getSlideLayouts(dest)[0]);
    P.moveSlide(dest, d, 0);
    const loaded = await parseDeck(await P.savePresentation(dest));
    expect(P.getShapeText(P.getSlideShapes(P.getSlides(loaded)[0])[0])).toBe(
      "Page C",
    );
    expect(
      decodeURIComponent(preview(loaded, P.getSlides(loaded)[0])),
    ).toContain(">1</tspan>");
  });
});
