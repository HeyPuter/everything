import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { P, createDeck } from "../src/model.js";

const part = (bytes, name) => strFromU8(unzipSync(bytes)[name]);

describe("document statistics", () => {
  it("counts words, including one per ideograph", () => {
    expect(P.countWords("Hello, world  — again")).toBe(3);
    expect(P.countWords("日本語 text")).toBe(4);
    expect(P.countWords("  ")).toBe(0);
  });

  it("counts slides, hidden slides, notes and words", () => {
    const pres = createDeck("blank");
    const [first] = P.getSlides(pres);
    const second = P.duplicateSlide(pres, first);
    P.setSlideHidden(second, true);
    P.setSlideNotes(first, "Say three words");
    const stats = P.getDocumentStatistics(pres);
    expect(stats.slides).toBe(2);
    expect(stats.hiddenSlides).toBe(1);
    expect(stats.notes).toBe(1);
    expect(stats.notesWords).toBe(3);
    expect(stats.words).toBeGreaterThanOrEqual(0);
  });

  it("records statistics in app.xml and keeps the rest of the part", async () => {
    const pres = createDeck("blank");
    P.setExtendedProperties(pres, { company: "Example Co" });
    P.updateExtendedStatistics(pres);
    const bytes = await P.savePresentation(pres);
    const xml = part(bytes, "docProps/app.xml");
    expect(xml).toContain("<Slides>1</Slides>");
    expect(xml).toContain("<Company>Example Co</Company>");
    const reopened = await P.loadPresentation(bytes);
    expect(P.getExtendedStatistics(reopened).slides).toBe(1);
    expect(P.getExtendedProperties(reopened).company).toBe("Example Co");
  });

  it("creates app.xml when a package has none", async () => {
    const pres = createDeck("blank");
    const bytes = await P.savePresentation(pres);
    const files = unzipSync(bytes);
    delete files["docProps/app.xml"];
    const { zipSync } = await import("fflate");
    const bare = await P.loadPresentation(zipSync(files));
    P.setExtendedStatistics(bare, { slides: 4, words: 12 });
    const saved = await P.savePresentation(bare);
    const again = await P.loadPresentation(saved);
    expect(P.getExtendedStatistics(again)).toMatchObject({
      slides: 4,
      words: 12,
    });
    expect(part(saved, "_rels/.rels")).toContain("docProps/app.xml");
  });

  it("round-trips core properties edited as a document's properties", async () => {
    const pres = createDeck("blank");
    P.setCoreProperties(pres, {
      title: "Quarterly review",
      subject: "Finance",
      creator: "Ada",
      keywords: "q3; budget",
      description: "Draft for the board",
      category: "Reports",
    });
    const again = await P.loadPresentation(await P.savePresentation(pres));
    expect(P.getCoreProperties(again)).toMatchObject({
      title: "Quarterly review",
      subject: "Finance",
      creator: "Ada",
      keywords: "q3; budget",
      description: "Draft for the board",
      category: "Reports",
    });
  });
});

describe("presentation kind", () => {
  it("saves a template by changing only the main part's content type", async () => {
    const pres = createDeck("blank");
    expect(P.getPresentationKind(pres)).toBe("presentation");
    P.setPresentationKind(pres, "template");
    const bytes = await P.savePresentation(pres);
    const types = part(bytes, "[Content_Types].xml");
    expect(types).toContain("presentationml.template.main+xml");
    expect(types).not.toContain("presentationml.presentation.main+xml");
    const template = await P.loadPresentation(bytes);
    expect(P.getPresentationKind(template)).toBe("template");
    expect(P.getSlides(template)).toHaveLength(1);
    P.setPresentationKind(template, "presentation");
    expect(P.getPresentationKind(template)).toBe("presentation");
    expect(P.PRESENTATION_FILE_TYPES.template).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.template",
    );
  });
});
